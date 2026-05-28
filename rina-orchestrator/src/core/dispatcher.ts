/**
 * Dispatcher — routes each Step to the SubAgent matching its kind.
 *
 * Why a Dispatcher class and not just a Map? Because we want a single
 * place to:
 *   - Emit step_started / step_completed / step_failed on the bus.
 *   - Pass the previousResults list (sub-agents are stateless w.r.t.
 *     each other — orchestration carries the context).
 *   - Catch sub-agent errors and turn them into step_failed events
 *     rather than letting them blow up the whole run.
 *
 * Shutdown semantics: dispatcher.shutdown() calls every registered
 * agent's optional shutdown() exactly once, even if mid-run failures
 * left things in a weird state. Best-effort — we never throw out of
 * shutdown.
 */

import type { SubAgent } from "../agents/base.js";
import type { StateManager } from "./state.js";
import type { Plan, StepKind } from "./types.js";

export class Dispatcher {
  private readonly agents = new Map<StepKind, SubAgent>();
  private shutdownCalled = false;

  register(agent: SubAgent): void {
    if (this.agents.has(agent.kind)) {
      throw new Error(
        `Two sub-agents registered for kind '${agent.kind}'. ` +
          `Only one per kind in v0.1.`
      );
    }
    this.agents.set(agent.kind, agent);
  }

  /**
   * Run every step in the plan, sequentially. Returns the list of
   * step results (in step order). Throws only if a step kind has no
   * registered handler — sub-agent errors are caught and emitted as
   * step_failed, then we stop dispatching further steps (no point
   * continuing if step 2 depended on step 1's result).
   */
  async runPlan(state: StateManager, plan: Plan): Promise<string[]> {
    const results: string[] = [];

    for (const step of plan.steps) {
      const agent = this.agents.get(step.kind);
      if (!agent) {
        const msg = `No sub-agent registered for step kind '${step.kind}'.`;
        state.markStepFailed(step.id, msg);
        throw new Error(msg);
      }

      state.markStepStarted(step.id);
      try {
        const out = await agent.run({
          description: step.description,
          previousResults: [...results],
          onProgress: (message) => state.emitStepProgress(step.id, message),
          onScreenshot: (dataUrl) => state.emitStepScreenshot(step.id, dataUrl),
        });
        state.markStepCompleted(step.id, out.result, out.rounds);
        results.push(out.result);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        state.markStepFailed(step.id, message);
        // Halt the rest of the plan — later steps probably depended
        // on this one's result. The orchestrator surfaces this as
        // run_failed.
        throw err;
      }
    }

    return results;
  }

  async shutdown(): Promise<void> {
    if (this.shutdownCalled) return;
    this.shutdownCalled = true;
    await Promise.allSettled(
      Array.from(this.agents.values()).map((a) => a.shutdown?.() ?? Promise.resolve())
    );
  }
}
