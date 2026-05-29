/**
 * ConnectorAgent — runs an inner LLM loop over the tools exposed by
 * external MCP servers (Gmail, Slack, Notion, a database, your own
 * server…). This is the orchestrator's half of the "connecteurs à la
 * Manus" capability: rina-agent does the actual MCP plumbing (spawning
 * servers, the JSON-RPC handshake, namespacing tools as
 * `mcp__<server>__<tool>`), and this sub-agent lets a *planned step*
 * drive those tools the same way the BrowserAgent drives Playwright.
 *
 * The loop is the BrowserAgent pattern, verbatim in spirit:
 *   1. Present the catalog (every connected MCP tool + done()) to the
 *      backend via native function-calling.
 *   2. The model calls exactly one tool per turn.
 *   3. We dispatch it to the hub, feed the textual result back, repeat.
 *   4. Terminate when the model calls done(summary) or maxRounds hits.
 *
 * The hub is owned by the orchestrator (runGoal), not this agent —
 * runGoal builds it once, hands it to both the planner (so the planner
 * knows which tools exist) and this agent, and tears it down in its
 * finally. So shutdown() here is a no-op: closing the hub from a
 * sub-agent would yank the connection out from under a sibling step.
 */

import type {
  Backend,
  ChatMessage,
  ToolDefinition,
} from "@siliconcorerina/rina-agent/out/backend.js";
import { describeMcpToolsForPrompt } from "@siliconcorerina/rina-agent/out/mcp.js";

import type {
  ProgressCallback,
  SubAgent,
  SubAgentResult,
} from "../base.js";
import type { StepKind } from "../../core/types.js";

const MAX_ROUNDS = 12;

/**
 * The slice of McpHub this agent needs. Declaring it structurally
 * (rather than importing the concrete McpHub) keeps the agent unit-
 * testable with a fake and avoids a hard construction-time dependency
 * on a live hub. The real McpHub from rina-agent satisfies this.
 */
export interface McpToolProvider {
  /** Native-function-calling definitions for every connected tool. */
  getToolDefinitions(): ToolDefinition[];
  /** True if `name` is a connected MCP tool. */
  isMcpTool(name: string): boolean;
  /** Dispatch a namespaced call; resolves (never rejects) to a result. */
  callTool(name: string, args: Record<string, unknown>): Promise<{ ok: boolean; output: string }>;
}

const DONE_TOOL: ToolDefinition = {
  name: "done",
  description:
    "Terminate the step. `summary` is the final result for the orchestrator — " +
    "it must contain the concrete fact/data the brief asked for, not a description " +
    "of the actions you took.",
  parameters: {
    type: "object",
    properties: { summary: { type: "string", minLength: 1, maxLength: 2000 } },
    required: ["summary"],
    additionalProperties: false,
  },
};

export interface ConnectorAgentOptions {
  /** Override the max LLM rounds (default 12). */
  maxRounds?: number;
}

export class ConnectorAgent implements SubAgent {
  readonly kind: StepKind = "connector";

  private readonly tools: ToolDefinition[];
  private readonly maxRounds: number;

  constructor(
    private readonly backend: Backend,
    private readonly hub: McpToolProvider,
    options: ConnectorAgentOptions = {}
  ) {
    if (!backend.generateWithTools) {
      throw new Error(
        `ConnectorAgent requires a backend with native function-calling. ` +
          `Got '${backend.spec}'.`
      );
    }
    // Snapshot the catalog once — the set of tools is fixed for the run.
    this.tools = [...hub.getToolDefinitions(), DONE_TOOL];
    this.maxRounds = options.maxRounds ?? MAX_ROUNDS;
  }

  async run(input: {
    description: string;
    previousResults: string[];
    onProgress: ProgressCallback;
  }): Promise<SubAgentResult> {
    const messages: ChatMessage[] = [
      { role: "system", content: this.systemPrompt() },
      ...this.priorContext(input.previousResults),
      { role: "user", content: `Brief :\n${input.description}` },
    ];

    for (let round = 1; round <= this.maxRounds; round++) {
      const response = await this.backend.generateWithTools!(
        messages,
        this.tools,
        { temperature: 0.2, maxTokens: 900 }
      );

      if (!response.toolCall) {
        // Off-script: produced prose instead of a tool call. Nudge it
        // back onto the rails; bail if it keeps doing it.
        messages.push({ role: "assistant", content: response.text });
        messages.push({
          role: "user",
          content:
            "Tu DOIS appeler un outil. Si tu as le résultat demandé, appelle done(summary). " +
            "Sinon, appelle l'outil de connecteur approprié.",
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
      const args = safeJsonObject(argsJson);

      // done() ends the loop.
      if (name === "done") {
        const summary =
          typeof (args as { summary?: unknown }).summary === "string"
            ? (args as { summary: string }).summary
            : "(no summary)";
        return { result: summary, rounds: round };
      }

      input.onProgress(formatProgress(name, args));

      // Dispatch to the hub. Unknown names (a hallucinated tool) come
      // back as an error result rather than throwing — the model gets
      // the feedback and can correct on the next round.
      let toolResult: string;
      if (!this.hub.isMcpTool(name)) {
        toolResult =
          `ERROR: '${name}' is not an available tool. ` +
          `Call one of the listed connector tools, or done(summary).`;
      } else {
        const r = await this.hub.callTool(name, args);
        toolResult = r.ok ? r.output : `ERROR: ${r.output}`;
      }

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

    return {
      result:
        "Connector agent did not call done() within the round budget. " +
        "Last tool result kept above.",
      rounds: this.maxRounds,
    };
  }

  /** No-op: the hub's lifecycle is owned by the orchestrator (runGoal). */
  async shutdown(): Promise<void> {
    /* intentionally empty */
  }

  private systemPrompt(): string {
    const catalog = describeMcpToolsForPrompt(
      this.tools.filter((t) => t.name !== "done")
    );
    return `Tu es l'AGENT CONNECTEUR de RINA AI. Tu pilotes des outils externes (serveurs MCP : email, messagerie, documents, base de données, etc.) pour accomplir UN brief atomique.

Tu reçois un brief précis (par exemple "Récupère les 3 derniers emails non lus et donne leur objet"). Tu dois l'accomplir avec le minimum d'appels d'outils, puis appeler done(summary) avec le résultat exact demandé.

Outils connecteurs disponibles (TU DOIS appeler exactement UN outil par tour) :
${catalog || "(aucun outil connecteur — appelle directement done() en expliquant qu'aucun connecteur n'est disponible)"}

Plus l'outil de fin :
- done(summary) : termine l'étape. summary est la réponse finale destinée à l'orchestrateur.

Règles dures :
1. Réponds UNIQUEMENT par un appel d'outil. Pas de texte libre.
2. N'invente JAMAIS de nom d'outil : utilise EXACTEMENT les noms listés ci-dessus (préfixés par mcp__).
3. Fournis les arguments au format JSON attendu par l'outil.
4. Si un outil renvoie une erreur, lis-la et adapte ton prochain appel — ne répète pas le même appel à l'identique.
5. Dès que tu as l'information demandée, appelle done(summary). Le summary doit contenir le FAIT/RÉSULTAT, pas une description de tes actions.
6. Si après 3 tours tu n'as pas progressé, appelle done() avec ce que tu as obtenu.`;
  }

  private priorContext(previous: string[]): ChatMessage[] {
    if (previous.length === 0) return [];
    const summary = previous
      .map((r, i) => `Étape ${i + 1}: ${truncate(r, 500)}`)
      .join("\n");
    return [
      { role: "user", content: `Contexte des étapes précédentes :\n${summary}` },
    ];
  }
}

// ─────────────────────────────────────────────────────────────────────
// helpers
// ─────────────────────────────────────────────────────────────────────

function safeJsonObject(s: string): Record<string, unknown> {
  try {
    const v = JSON.parse(s);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max) + "\n…(tronqué)";
}

function formatProgress(name: string, args: Record<string, unknown>): string {
  const keys = Object.keys(args);
  if (keys.length === 0) return `→ ${name}`;
  const preview = keys
    .slice(0, 3)
    .map((k) => `${k}=${truncate(String(args[k] ?? ""), 40)}`)
    .join(", ");
  return `→ ${name} (${preview})`;
}
