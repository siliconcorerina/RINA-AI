/**
 * Shared types for the orchestrator core.
 *
 * The data model is intentionally small: a Goal becomes a Plan (a
 * list of Steps), each Step is dispatched to a SubAgent, and the
 * StateManager records the result + emits events to the bus. There's
 * no DAG, no parallel execution in v0.1 — steps run sequentially.
 * That's deliberate: the simplest thing that lets us validate the
 * planner + dispatcher + browser-agent triangle is also what we want
 * to ship first.
 */

/**
 * What kind of work a step requires. The dispatcher uses this to
 * pick which SubAgent runs it.
 *
 *   - "browser" — interact with a real browser (Playwright)
 *   - "code"    — file ops, shell, git (delegated to rina-agent)
 *   - "answer"  — pure-LLM synthesis, no tool calls
 *
 * v0.1 only ships the "browser" path end-to-end. The others are
 * recognised so the planner can produce mixed plans; the dispatcher
 * surfaces a clear "not implemented yet" error if a non-browser
 * step lands.
 */
export type StepKind = "browser" | "code" | "answer";

export type StepStatus = "pending" | "running" | "completed" | "failed";

export interface Step {
  /** Stable id within the plan. Used in events + final summaries. */
  id: string;
  /** Which sub-agent should run this step. */
  kind: StepKind;
  /** Natural-language description the sub-agent gets as its goal. */
  description: string;
  status: StepStatus;
  /** Free-form result body returned by the sub-agent on success. */
  result?: string;
  /** Error message if status === "failed". */
  error?: string;
  /** Number of LLM rounds the sub-agent used to complete the step.
   *  Useful for cost analysis + spotting runaway loops. */
  rounds?: number;
}

export interface Plan {
  /** The original user goal — preserved verbatim so prompts down the
   *  chain can still anchor on the user's exact wording. */
  goal: string;
  steps: Step[];
}

// ─────────────────────────────────────────────────────────────────────
// Event bus
// ─────────────────────────────────────────────────────────────────────

/**
 * Discriminated union of every event the orchestrator emits during a
 * run. Consumers (CLI, future web UI) subscribe to the bus and render
 * the events into a live trace. Events are append-only — no
 * mutation, no overwrite — so a transcript can be reconstructed by
 * replaying the log.
 */
export type AgentEvent =
  | { type: "plan_created"; plan: Plan }
  | { type: "step_started"; stepId: string }
  | { type: "step_progress"; stepId: string; message: string }
  /** A fresh viewport screenshot after a visible browser action.
   *  `dataUrl` is a base64-encoded JPEG (data:image/jpeg;base64,…)
   *  capped at ~80 KB by the driver's quality setting. Emitted by
   *  the browser sub-agent after navigate/click/type/press/scroll/
   *  back — i.e. anything that visibly changes what the user would
   *  see — but NOT after read_page (no visual change). The mobile
   *  UI shows the latest one inline so the user experiences the
   *  agent's browser without exposing a local window. */
  | { type: "step_screenshot"; stepId: string; dataUrl: string }
  | { type: "step_completed"; stepId: string; result: string; rounds: number }
  | { type: "step_failed"; stepId: string; error: string }
  | { type: "run_completed"; summary: string }
  | { type: "run_failed"; error: string };

export type EventListener = (event: AgentEvent) => void;
