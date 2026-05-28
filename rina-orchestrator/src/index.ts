/**
 * Public surface of @siliconcorerina/rina-orchestrator.
 *
 * Stable re-exports — anything not exported from here is internal
 * and may change without a semver bump. The CLI imports from here
 * too, so the same surface is what library users get.
 */

export { runGoal, RunFailedError } from "./core/orchestrator.js";
export type { RunGoalOptions, RunResult } from "./core/orchestrator.js";

export { planGoal } from "./core/planner.js";
export type { PlannerOptions } from "./core/planner.js";

export { Dispatcher } from "./core/dispatcher.js";
export { StateManager } from "./core/state.js";

export { BrowserAgent } from "./agents/browser/browser-agent.js";
export type { BrowserAgentOptions } from "./agents/browser/browser-agent.js";
export { BrowserDriver } from "./agents/browser/playwright.js";
export type { PageSnapshot, InteractiveElement } from "./agents/browser/playwright.js";

export type {
  Plan,
  Step,
  StepKind,
  StepStatus,
  AgentEvent,
  EventListener,
} from "./core/types.js";

export type { SubAgent, SubAgentResult, ProgressCallback } from "./agents/base.js";
