/**
 * State Manager — owns the live Plan + emits AgentEvents.
 *
 * Why not just an EventEmitter? Because we want a single source of
 * truth for "what is the current state of this run". Listeners that
 * subscribe LATE (e.g. a future web UI that reconnects mid-run) need
 * to be able to ask "what's the plan, where are we?" rather than
 * relying on having heard every event from t=0.
 *
 * The contract: every mutation goes through a method on this class,
 * which (a) updates the plan, (b) emits the corresponding event.
 * Direct mutation of plan.steps from the outside is a bug.
 */

import { EventEmitter } from "node:events";

import type { AgentEvent, EventListener, Plan, Step, StepStatus } from "./types.js";

export class StateManager {
  private plan: Plan | null = null;
  private readonly bus = new EventEmitter();
  /** Replay log — every event ever emitted on this run, in order.
   *  Late subscribers can ask for it via `events()` and rebuild the
   *  UI state without missing anything. */
  private readonly log: AgentEvent[] = [];

  /** Set the initial plan + emit plan_created. Must be called exactly
   *  once per run; calling again is a programmer error and we throw
   *  rather than silently overwriting. */
  setPlan(plan: Plan): void {
    if (this.plan) {
      throw new Error("StateManager.setPlan called twice on the same run.");
    }
    this.plan = plan;
    this.emit({ type: "plan_created", plan });
  }

  getPlan(): Plan {
    if (!this.plan) throw new Error("Plan not set yet.");
    return this.plan;
  }

  getStep(stepId: string): Step {
    const step = this.getPlan().steps.find((s) => s.id === stepId);
    if (!step) throw new Error(`Unknown step id: ${stepId}`);
    return step;
  }

  markStepStarted(stepId: string): void {
    this.updateStep(stepId, { status: "running" });
    this.emit({ type: "step_started", stepId });
  }

  emitStepProgress(stepId: string, message: string): void {
    // Progress messages are pure observability — no plan mutation,
    // just push to the bus so the CLI can show "navigating to X…"
    // while the underlying step is still mid-flight.
    this.emit({ type: "step_progress", stepId, message });
  }

  emitStepScreenshot(stepId: string, dataUrl: string): void {
    // Same pure-observability semantics as progress: no plan
    // mutation, just push the latest viewport image so the UI can
    // render the agent's browser inline. Skipped on the CLI; the
    // mobile + web UIs are the consumers.
    this.emit({ type: "step_screenshot", stepId, dataUrl });
  }

  markStepCompleted(stepId: string, result: string, rounds: number): void {
    this.updateStep(stepId, { status: "completed", result, rounds });
    this.emit({ type: "step_completed", stepId, result, rounds });
  }

  markStepFailed(stepId: string, error: string): void {
    this.updateStep(stepId, { status: "failed", error });
    this.emit({ type: "step_failed", stepId, error });
  }

  markRunCompleted(summary: string): void {
    this.emit({ type: "run_completed", summary });
  }

  markRunFailed(error: string): void {
    this.emit({ type: "run_failed", error });
  }

  /** Subscribe to the live event stream. Returns an unsubscribe fn. */
  subscribe(listener: EventListener): () => void {
    this.bus.on("event", listener);
    return () => {
      this.bus.off("event", listener);
    };
  }

  /** Snapshot the full event log so far. Cheap (it's an array
   *  reference, but we return a copy to keep callers honest). */
  events(): AgentEvent[] {
    return [...this.log];
  }

  // ── private ────────────────────────────────────────────────────────

  private updateStep(stepId: string, patch: Partial<Step>): void {
    const step = this.getStep(stepId);
    Object.assign(step, patch);
  }

  private emit(event: AgentEvent): void {
    this.log.push(event);
    // setImmediate would be more correct for "fire-and-forget"
    // semantics, but EventEmitter is synchronous by design and the
    // CLI relies on that ordering (the planner returns BEFORE the
    // dispatcher starts dispatching). Keep it synchronous.
    this.bus.emit("event", event);
  }
}

/**
 * Convenience helper: a no-op StateManager for places where one is
 * required but we don't actually care about events (tests, debug
 * snippets). Saves callers from having to thread a stub through.
 */
export function silentState(): StateManager {
  return new StateManager();
}
