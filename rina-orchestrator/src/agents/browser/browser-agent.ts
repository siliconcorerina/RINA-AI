/**
 * BrowserAgent — runs an inner LLM loop that drives Playwright via
 * a fixed tool surface (navigate / read_page / click / type / etc.).
 *
 * The loop is bounded by maxRounds — 20 is enough for any realistic
 * web task while still bailing if the model gets stuck in a "click
 * something → page changes → click same thing" cycle. The agent
 * terminates voluntarily by calling done(summary), or runs out of
 * rounds (in which case we surface the last partial state).
 *
 * Tool catalog kept intentionally small: 7 verbs cover ~all browser
 * agent benchmarks. Adding more (e.g. screenshot, hover, drag)
 * widens the LLM's action space without obviously expanding what it
 * can accomplish — Pareto-bad tradeoff in v0.1.
 */

import type {
  Backend,
  ChatMessage,
  ToolDefinition,
} from "@siliconcorerina/rina-agent/out/backend.js";

import type {
  ProgressCallback,
  ScreenshotCallback,
  SubAgent,
  SubAgentResult,
} from "../base.js";
import type { StepKind } from "../../core/types.js";

import { BrowserDriver, type PageSnapshot } from "./playwright.js";

const MAX_ROUNDS = 20;

const SYSTEM_PROMPT = `Tu es l'AGENT NAVIGATEUR de RINA AI. Tu pilotes un navigateur Chromium réel via une suite d'outils.

Tu reçois UN brief atomique (par exemple "Cherche 'best Chinese restaurants Paris' sur Google et note le titre du premier résultat"). Tu dois l'accomplir avec le minimum d'actions, puis appeler done(summary) avec le résultat exact demandé.

Outils disponibles (TU DOIS appeler exactement UN outil par tour) :
- navigate(url) : ouvre l'URL, retourne le contenu visible + la liste des éléments interactifs.
- read_page() : relit la page actuelle (utile après un click/type qui aurait pu changer la page).
- click(ref) : clique sur un élément identifié par sa référence [N] retournée par read_page().
- type(ref, text) : remplit un champ texte identifié par [N].
- press(key) : presse une touche (Enter, Escape, Tab, ArrowDown…).
- scroll(direction) : "down" ou "up" pour défiler la page.
- back() : revient à la page précédente.
- wait(ms) : attend N millisecondes (max 10000) — utilise PARCIMONIE.
- done(summary) : termine l'étape. summary est la réponse finale destinée à l'orchestrateur.

Règles dures :
1. Réponds UNIQUEMENT par un appel d'outil. Pas de texte libre.
2. APPELLE read_page après chaque action qui modifie la page (click, type, navigate) — les références [N] deviennent obsolètes.
3. Si tu vois un cookie banner / "accepter tout", clique dessus pour pouvoir continuer.
4. Si tu fais 3 tours sans progrès tangible, appelle done() avec ce que tu as trouvé jusqu'ici.
5. Le summary final doit contenir le FAIT extrait, pas une description de ce que tu as fait.`;

const BROWSER_TOOLS: ToolDefinition[] = [
  {
    name: "navigate",
    description: "Open a URL in the browser and return the page content.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "Absolute URL to open (with https://)." },
      },
      required: ["url"],
      additionalProperties: false,
    },
  },
  {
    name: "read_page",
    description: "Re-read the current page. Use after any interaction that may have changed it.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "click",
    description: "Click on an interactive element identified by its [N] reference.",
    parameters: {
      type: "object",
      properties: {
        ref: { type: "string", description: 'Reference like "[3]" from read_page.' },
      },
      required: ["ref"],
      additionalProperties: false,
    },
  },
  {
    name: "type",
    description: "Type text into a textbox identified by its [N] reference.",
    parameters: {
      type: "object",
      properties: {
        ref: { type: "string", description: 'Reference like "[2]" from read_page.' },
        text: { type: "string", description: "Text to type." },
      },
      required: ["ref", "text"],
      additionalProperties: false,
    },
  },
  {
    name: "press",
    description: "Press a single key on the keyboard (Enter, Escape, Tab, ArrowDown, etc.).",
    parameters: {
      type: "object",
      properties: { key: { type: "string" } },
      required: ["key"],
      additionalProperties: false,
    },
  },
  {
    name: "scroll",
    description: "Scroll the page up or down by ~800px.",
    parameters: {
      type: "object",
      properties: {
        direction: { type: "string", enum: ["down", "up"] },
      },
      required: ["direction"],
      additionalProperties: false,
    },
  },
  {
    name: "back",
    description: "Navigate to the previous page in history.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "wait",
    description: "Pause for N milliseconds (max 10000). Use sparingly.",
    parameters: {
      type: "object",
      properties: { ms: { type: "integer", minimum: 0, maximum: 10000 } },
      required: ["ms"],
      additionalProperties: false,
    },
  },
  {
    name: "done",
    description:
      "Terminate the step. `summary` is the final result for the orchestrator.",
    parameters: {
      type: "object",
      properties: { summary: { type: "string", minLength: 1, maxLength: 2000 } },
      required: ["summary"],
      additionalProperties: false,
    },
  },
];

export interface BrowserAgentOptions {
  /** When true, Playwright opens a visible window — useful for
   *  development. Defaults to headless. */
  headless?: boolean;
  /** Override the max LLM rounds. */
  maxRounds?: number;
}

export class BrowserAgent implements SubAgent {
  readonly kind: StepKind = "browser";

  private readonly driver: BrowserDriver;
  private readonly maxRounds: number;
  /** Set on each run() call so dispatchTool can fire shots without
   *  carrying the callback through every method signature. */
  private onScreenshot: ScreenshotCallback | null = null;

  constructor(
    private readonly backend: Backend,
    options: BrowserAgentOptions = {}
  ) {
    if (!backend.generateWithTools) {
      throw new Error(
        `BrowserAgent requires a backend with native function-calling. ` +
          `Got '${backend.spec}'.`
      );
    }
    this.driver = new BrowserDriver({ headless: options.headless ?? true });
    this.maxRounds = options.maxRounds ?? MAX_ROUNDS;
  }

  async run(input: {
    description: string;
    previousResults: string[];
    onProgress: ProgressCallback;
    onScreenshot?: ScreenshotCallback;
  }): Promise<SubAgentResult> {
    // Stashed for the inner dispatchTool helper so it can fire shots
    // without threading the callback through every method signature.
    this.onScreenshot = input.onScreenshot ?? null;

    const messages: ChatMessage[] = [
      { role: "system", content: SYSTEM_PROMPT },
      ...this.priorContext(input.previousResults),
      { role: "user", content: `Brief :\n${input.description}` },
    ];

    for (let round = 1; round <= this.maxRounds; round++) {
      const response = await this.backend.generateWithTools!(
        messages,
        BROWSER_TOOLS,
        { temperature: 0.2, maxTokens: 800 }
      );

      if (!response.toolCall) {
        // The model went off-script and produced text instead of a
        // tool call. Push it as the assistant turn and nudge it
        // back; if it happens twice we bail.
        messages.push({ role: "assistant", content: response.text });
        messages.push({
          role: "user",
          content:
            "Tu DOIS appeler un outil. Si tu as terminé, appelle done(summary). Sinon, appelle l'outil approprié.",
        });
        if (round > 2) {
          return {
            result: response.text || "Agent produced no tool call.",
            rounds: round,
          };
        }
        continue;
      }

      const { id, name, argsJson } = response.toolCall;
      const args = safeJson(argsJson);

      // Done is special — it ends the loop.
      if (name === "done") {
        const summary =
          typeof (args as { summary?: unknown }).summary === "string"
            ? ((args as { summary: string }).summary as string)
            : "(no summary)";
        return { result: summary, rounds: round };
      }

      // Run the tool, capture its result, thread it back into the
      // conversation as a tool-call response for the next turn.
      input.onProgress(formatProgress(name, args));
      let toolResult: string;
      try {
        toolResult = await this.dispatchTool(name, args);
      } catch (err) {
        toolResult = `ERROR: ${(err as Error).message}`;
      }

      // Persist the assistant turn (with its tool call) AND the
      // tool result — both are needed for the next round so the
      // model can see what happened.
      messages.push({
        role: "assistant",
        content: response.text,
        toolCall: { id, name, argsJson },
      });
      messages.push({
        role: "user",
        content: truncate(toolResult, 12_000),
        toolCallId: id,
      });
    }

    // Out of rounds.
    return {
      result:
        "Agent did not call done() within the round budget. " +
        "Last observation kept above.",
      rounds: this.maxRounds,
    };
  }

  async shutdown(): Promise<void> {
    await this.driver.shutdown();
  }

  // ── Tool dispatch ─────────────────────────────────────────────────

  private async dispatchTool(name: string, args: unknown): Promise<string> {
    const a = (args ?? {}) as Record<string, unknown>;
    switch (name) {
      case "navigate": {
        const snap = await this.driver.navigate(requireString(a, "url"));
        await this.captureAndEmit();
        return this.renderSnapshot(snap);
      }
      case "read_page":
        // No screenshot here — read_page doesn't change visible
        // state. The frame from the most recent action is still
        // accurate.
        return this.renderSnapshot(await this.driver.readPage());
      case "click":
        await this.driver.click(requireString(a, "ref"));
        await this.captureAndEmit();
        return "OK. Call read_page to see the result.";
      case "type":
        await this.driver.type(requireString(a, "ref"), requireString(a, "text"));
        await this.captureAndEmit();
        return "OK. Call read_page to see the result.";
      case "press":
        await this.driver.press(requireString(a, "key"));
        await this.captureAndEmit();
        return "OK. Call read_page to see the result.";
      case "scroll": {
        const dir = a.direction;
        if (dir !== "down" && dir !== "up") {
          throw new Error("direction must be 'down' or 'up'");
        }
        await this.driver.scroll(dir);
        await this.captureAndEmit();
        return "OK. Call read_page to see the result.";
      }
      case "back":
        await this.driver.back();
        await this.captureAndEmit();
        return "OK. Call read_page to see the result.";
      case "wait": {
        const ms = Number(a.ms);
        if (!Number.isFinite(ms)) throw new Error("ms must be a number");
        await this.driver.waitMs(ms);
        return `Waited ${ms}ms.`;
      }
      default:
        throw new Error(`Unknown tool '${name}'.`);
    }
  }

  /**
   * Take a fresh viewport screenshot and push it to the listener.
   * Fire-and-forget — a missed shot (5s timeout, page closed, etc.)
   * never fails the step. Skips entirely when no listener is wired.
   */
  private async captureAndEmit(): Promise<void> {
    if (!this.onScreenshot) return;
    const dataUrl = await this.driver.screenshot();
    if (dataUrl) this.onScreenshot(dataUrl);
  }

  private renderSnapshot(s: PageSnapshot): string {
    const interactiveLines = s.interactive.map(
      (e) => `${e.ref} ${e.role}: ${e.text}`
    );
    return [
      `# ${s.title}`,
      `URL: ${s.url}`,
      "",
      "## Texte visible" + (s.truncated ? " (tronqué)" : ""),
      s.text || "(page vide)",
      "",
      "## Éléments interactifs",
      ...(interactiveLines.length > 0
        ? interactiveLines
        : ["(aucun élément interactif détecté)"]),
    ].join("\n");
  }

  private priorContext(previous: string[]): ChatMessage[] {
    if (previous.length === 0) return [];
    const summary = previous
      .map((r, i) => `Étape ${i + 1}: ${truncate(r, 500)}`)
      .join("\n");
    return [
      {
        role: "user",
        content: `Contexte des étapes précédentes :\n${summary}`,
      },
    ];
  }
}

// ─────────────────────────────────────────────────────────────────────
// helpers
// ─────────────────────────────────────────────────────────────────────

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}

function requireString(obj: Record<string, unknown>, key: string): string {
  const v = obj[key];
  if (typeof v !== "string" || v.length === 0) {
    throw new Error(`Missing or empty string parameter '${key}'`);
  }
  return v;
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max) + "\n…(tronqué)";
}

function formatProgress(name: string, args: unknown): string {
  const a = (args ?? {}) as Record<string, unknown>;
  switch (name) {
    case "navigate":
      return `→ navigate ${a.url}`;
    case "read_page":
      return "→ read_page";
    case "click":
      return `→ click ${a.ref}`;
    case "type":
      return `→ type ${a.ref} "${String(a.text ?? "").slice(0, 40)}"`;
    case "press":
      return `→ press ${a.key}`;
    case "scroll":
      return `→ scroll ${a.direction}`;
    case "back":
      return "→ back";
    case "wait":
      return `→ wait ${a.ms}ms`;
    default:
      return `→ ${name}`;
  }
}
