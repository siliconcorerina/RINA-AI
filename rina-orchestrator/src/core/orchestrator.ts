/**
 * Orchestrator — the top-level entry point that ties everything
 * together. One call: `runGoal(backend, "do X")`, returns the final
 * summary + the full event log (for downstream rendering).
 *
 * Flow:
 *   1. Planner.planGoal()      → Plan
 *   2. StateManager.setPlan()  → plan_created event
 *   3. Dispatcher.runPlan()    → step_* events
 *   4. Summarise final results → run_completed
 *
 * The orchestrator is the ONLY place that knows about the full set
 * of sub-agents. Higher-level integrations (CLI, future HTTP API,
 * future mobile bridge) call orchestrator.run() and consume the
 * event stream — they don't need to know the planner exists.
 */

import type { Backend } from "@siliconcorerina/rina-agent/out/backend.js";

import { BrowserAgent, type BrowserAgentOptions } from "../agents/browser/browser-agent.js";
import { Dispatcher } from "./dispatcher.js";
import { planGoal } from "./planner.js";
import { StateManager } from "./state.js";
import type { AgentEvent, EventListener, Plan } from "./types.js";

export interface RunGoalOptions {
  /** Optional listener for the live event stream. Same as subscribing
   *  via `state.subscribe()` but more convenient for one-shot calls. */
  onEvent?: EventListener;
  /** Forwarded to the browser sub-agent. */
  browser?: BrowserAgentOptions;
  /** Cap on planner step count. Defaults to 6. */
  maxSteps?: number;
}

export interface RunResult {
  plan: Plan;
  /** The final summary (last step's result or a synthesised wrap-up). */
  summary: string;
  /** Full event log for later rendering / archival. */
  events: AgentEvent[];
}

/**
 * Run a goal end-to-end. Always tears down the browser sub-agent on
 * exit, even on failure — Playwright holding a Chromium process
 * open is exactly the kind of leak that bites you in production.
 */
export async function runGoal(
  backend: Backend,
  goal: string,
  options: RunGoalOptions = {}
): Promise<RunResult> {
  const state = new StateManager();
  if (options.onEvent) state.subscribe(options.onEvent);

  const dispatcher = new Dispatcher();
  const browserAgent = new BrowserAgent(backend, options.browser);
  dispatcher.register(browserAgent);

  try {
    // Phase 1 — planning.
    const plan = await planGoal(backend, goal, { maxSteps: options.maxSteps });
    state.setPlan(plan);

    // Phase 2 — dispatch.
    const results = await dispatcher.runPlan(state, plan);

    // Phase 3 — summary. v0.1 just returns the last step's result as
    // the run summary. A future version can ask the LLM to
    // synthesise across step results.
    const summary = results[results.length - 1] ?? "(no results)";
    state.markRunCompleted(summary);

    return { plan, summary, events: state.events() };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    state.markRunFailed(message);
    // Re-throw so callers can decide how loud to fail. Events log
    // still contains the partial trace via state.events() — but we
    // also re-package it in the error for convenience.
    const wrapped = new RunFailedError(message, state.events());
    throw wrapped;
  } finally {
    await dispatcher.shutdown();
  }
}

export class RunFailedError extends Error {
  constructor(message: string, public events: AgentEvent[]) {
    super(message);
    this.name = "RunFailedError";
  }
}
