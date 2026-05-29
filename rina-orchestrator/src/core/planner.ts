/**
 * Task Planner — turns a free-form user goal into an executable Plan.
 *
 * Implementation: a single LLM call with a `submit_plan` native
 * function-call. The model is forced (via the system prompt + the
 * single-tool tool list) to respond by calling submit_plan with the
 * structured step list — text-only replies aren't useful here.
 *
 * Why not multi-turn planning? At v0.1 we want the simplest thing
 * that produces a coherent step list. Plans rarely have more than
 * 4-6 steps for browser-first goals, and the model gets one chance
 * to think them through. We can add a "review your plan" loop later
 * if benchmarks show it helps.
 *
 * The Planner is deterministic w.r.t. the spec: same goal + same
 * backend should produce nearly the same plan (temperature 0.1).
 */

import type { Backend, ToolDefinition } from "@siliconcorerina/rina-agent/out/backend.js";
import { describeMcpToolsForPrompt } from "@siliconcorerina/rina-agent/out/mcp.js";

import type { Plan, Step, StepKind } from "./types.js";

const PLAN_SYSTEM_PROMPT = `Tu es le PLANIFICATEUR d'un système agentique RINA AI.

Ton seul rôle : transformer un objectif en une liste courte d'étapes atomiques exécutables par des sous-agents spécialisés.

Sous-agents disponibles :
- "browser" : ouvre un navigateur réel (Playwright headless Chromium), navigue, clique, remplit des formulaires, lit le contenu d'une page. Utilise-le pour tout ce qui demande d'interagir avec un site web.
- "code"    : (pas encore implémenté en v0.1) — manipule des fichiers locaux, exécute du shell. Ne planifie PAS d'étape "code" tant que l'objectif ne le demande pas explicitement.
- "answer"  : (pas encore implémenté en v0.1) — synthétise une réponse finale uniquement à partir du contexte connu. Ne planifie PAS d'étape "answer".

Règles dures :
1. Réponds UNIQUEMENT en appelant la fonction submit_plan. Pas de texte libre.
2. Chaque étape doit être ATOMIQUE et VÉRIFIABLE — "ouvrir google.com et chercher X" est OK ; "trouver l'info sur le web" est trop vague.
3. Maximum 6 étapes. Si l'objectif demande plus, regroupe.
4. Décris chaque étape à la 2e personne ("Ouvre …", "Clique sur …", "Note le titre …") — c'est le brief direct envoyé au sous-agent.
5. Privilégie le sous-agent "browser" pour cette version 0.1.
6. Termine toujours par une étape qui produit le RÉSULTAT attendu (un fait, un nombre, un texte extrait).`;

const SUBMIT_PLAN_TOOL: ToolDefinition = makeSubmitPlanTool(["browser", "code", "answer"]);

export interface PlannerOptions {
  /** Hard ceiling on plan size. Defaults to 6. */
  maxSteps?: number;
  /**
   * Tool definitions for the connected MCP servers (from
   * McpHub.getToolDefinitions()). When non-empty, the planner is told
   * the "connector" sub-agent exists, shown the available tools, and
   * allowed to emit "connector" steps. When empty/undefined the planner
   * behaves exactly as before — no "connector" kind is offered.
   */
  connectorTools?: ToolDefinition[];
}

/**
 * Plan a user goal. Returns a Plan with steps ready to dispatch.
 *
 * Throws when:
 *   - The backend doesn't expose native function-calling (we need it
 *     to force the structured response shape; falling back to plain-
 *     text parsing is fragile and out of scope for v0.1).
 *   - The model didn't call submit_plan at all (returned text).
 *   - The returned plan is empty or schema-violating after a single
 *     retry.
 */
export async function planGoal(
  backend: Backend,
  goal: string,
  options: PlannerOptions = {}
): Promise<Plan> {
  if (!backend.generateWithTools) {
    throw new Error(
      `Backend '${backend.spec}' does not support native function-calling. ` +
        `The planner requires it to return a structured step list. ` +
        `Use a backend like openai:gpt-4o-mini, anthropic:claude-3-5-haiku-latest, ` +
        `mistral:codestral-latest, or deepseek:deepseek-chat.`
    );
  }
  const maxSteps = options.maxSteps ?? 6;
  const connectorTools = options.connectorTools ?? [];
  const hasConnector = connectorTools.length > 0;

  const response = await backend.generateWithTools(
    [
      { role: "system", content: buildSystemPrompt(connectorTools) },
      { role: "user", content: `Objectif :\n${goal.trim()}` },
    ],
    [buildSubmitPlanTool(hasConnector)],
    { temperature: 0.1, maxTokens: 800 }
  );

  if (!response.toolCall || response.toolCall.name !== "submit_plan") {
    throw new Error(
      "Planner did not call submit_plan. Got text instead: " +
        (response.text.slice(0, 200) || "<empty>")
    );
  }

  const args = safeJson(response.toolCall.argsJson);
  const rawSteps = (args as { steps?: unknown }).steps;
  if (!Array.isArray(rawSteps) || rawSteps.length === 0) {
    throw new Error("Planner returned an empty step list.");
  }

  const allowed = allowedKinds(hasConnector);
  const steps: Step[] = rawSteps.slice(0, maxSteps).map((raw, i) => {
    const r = raw as { kind?: unknown; description?: unknown };
    // Unknown kinds — and "connector" when no MCP server is connected —
    // fall back to "browser" so a stray kind can never reach the
    // dispatcher with no registered handler.
    const kind =
      typeof r.kind === "string" && allowed.has(r.kind as StepKind)
        ? (r.kind as StepKind)
        : "browser";
    const description =
      typeof r.description === "string" && r.description.trim().length > 0
        ? r.description.trim()
        : `Step ${i + 1}`;
    return {
      id: `s${i + 1}`,
      kind,
      description,
      status: "pending",
    };
  });

  return { goal: goal.trim(), steps };
}

function allowedKinds(hasConnector: boolean): Set<StepKind> {
  const kinds: StepKind[] = ["browser", "code", "answer"];
  if (hasConnector) {
    kinds.push("connector");
  }
  return new Set(kinds);
}

/**
 * The planner system prompt. When MCP connector tools are available we
 * append a section describing the "connector" sub-agent and listing the
 * tools, so the planner knows it can route a step there. With no tools
 * we return the base prompt unchanged.
 */
function buildSystemPrompt(connectorTools: ToolDefinition[]): string {
  if (connectorTools.length === 0) {
    return PLAN_SYSTEM_PROMPT;
  }
  const catalog = describeMcpToolsForPrompt(connectorTools);
  return (
    PLAN_SYSTEM_PROMPT +
    `\n\nSous-agent supplémentaire DISPONIBLE pour ce run :\n` +
    `- "connector" : appelle des outils externes connectés via MCP (email, messagerie, ` +
    `documents, base de données, etc.). Planifie une étape "connector" quand l'objectif ` +
    `nécessite l'un de ces outils plutôt qu'un navigateur web.\n\n` +
    `Outils connecteurs disponibles :\n${catalog}\n\n` +
    `Pour une étape "connector", décris précisément l'action attendue ` +
    `(ex. "Envoie un email à X avec l'objet Y"). Le sous-agent connecteur ` +
    `choisira lui-même le bon outil mcp__….`
  );
}

/**
 * The submit_plan tool. Identical to the base schema except the `kind`
 * enum gains "connector" when at least one MCP server is connected.
 */
function buildSubmitPlanTool(hasConnector: boolean): ToolDefinition {
  return hasConnector
    ? makeSubmitPlanTool(["browser", "code", "answer", "connector"])
    : SUBMIT_PLAN_TOOL;
}

function makeSubmitPlanTool(kinds: StepKind[]): ToolDefinition {
  return {
    name: "submit_plan",
    description:
      "Submit the decomposed plan for the user goal. Call this exactly once.",
    parameters: {
      type: "object",
      properties: {
        steps: {
          type: "array",
          minItems: 1,
          maxItems: 6,
          items: {
            type: "object",
            properties: {
              kind: {
                type: "string",
                enum: kinds,
                description: "Which specialised sub-agent runs this step.",
              },
              description: {
                type: "string",
                description:
                  "Natural-language brief for the sub-agent. Imperative voice, atomic, verifiable.",
                minLength: 6,
                maxLength: 400,
              },
            },
            required: ["kind", "description"],
            additionalProperties: false,
          },
        },
      },
      required: ["steps"],
      additionalProperties: false,
    },
  };
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}

// Exported for tests — lets us verify the prompt + tool schema didn't
// silently regress without instantiating a backend.
export const __test = {
  PLAN_SYSTEM_PROMPT,
  SUBMIT_PLAN_TOOL,
  buildSystemPrompt,
  buildSubmitPlanTool,
};
