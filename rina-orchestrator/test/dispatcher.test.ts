/**
 * Dispatcher tests. We use a fake SubAgent so the test doesn't need
 * Playwright + a real browser. Coverage focuses on:
 *   - Steps are run in order, each receives prior results.
 *   - Failure in one step halts the rest of the plan.
 *   - Unknown step kind throws upfront.
 *   - Shutdown is best-effort + idempotent.
 */

import { describe, expect, it, vi } from "vitest";

import { Dispatcher } from "../src/core/dispatcher.js";
import { StateManager } from "../src/core/state.js";
import type { SubAgent, SubAgentResult } from "../src/agents/base.js";
import type { AgentEvent, Plan, StepKind } from "../src/core/types.js";

function fakeAgent(
  kind: StepKind,
  impl: (input: { description: string; previousResults: string[] }) => Promise<SubAgentResult> | SubAgentResult,
  shutdown?: () => Promise<void>
): SubAgent {
  return {
    kind,
    run: async ({ description, previousResults, onProgress }) => {
      onProgress("starting…");
      return impl({ description, previousResults });
    },
    shutdown,
  };
}

function plan(steps: Array<{ id: string; kind: StepKind; description: string }>): Plan {
  return {
    goal: "test goal",
    steps: steps.map((s) => ({ ...s, status: "pending" })),
  };
}

describe("Dispatcher", () => {
  it("runs steps in order and forwards previousResults", async () => {
    const state = new StateManager();
    const seen: string[][] = [];
    const dispatcher = new Dispatcher();
    dispatcher.register(
      fakeAgent("browser", async ({ previousResults }) => {
        seen.push([...previousResults]);
        return { result: `done#${seen.length}`, rounds: 1 };
      })
    );

    const p = plan([
      { id: "s1", kind: "browser", description: "do A" },
      { id: "s2", kind: "browser", description: "do B" },
      { id: "s3", kind: "browser", description: "do C" },
    ]);
    state.setPlan(p);
    const results = await dispatcher.runPlan(state, p);

    expect(results).toEqual(["done#1", "done#2", "done#3"]);
    expect(seen).toEqual([[], ["done#1"], ["done#1", "done#2"]]);
  });

  it("emits step_started / step_completed events for each step", async () => {
    const state = new StateManager();
    const events: AgentEvent[] = [];
    state.subscribe((e) => events.push(e));
    const dispatcher = new Dispatcher();
    dispatcher.register(
      fakeAgent("browser", async () => ({ result: "ok", rounds: 1 }))
    );

    const p = plan([{ id: "s1", kind: "browser", description: "x" }]);
    state.setPlan(p);
    await dispatcher.runPlan(state, p);

    const types = events.map((e) => e.type);
    expect(types).toEqual([
      "plan_created",
      "step_started",
      "step_progress",
      "step_completed",
    ]);
  });

  it("halts the plan and emits step_failed on agent error", async () => {
    const state = new StateManager();
    const events: AgentEvent[] = [];
    state.subscribe((e) => events.push(e));
    const dispatcher = new Dispatcher();
    dispatcher.register(
      fakeAgent("browser", async ({ description }) => {
        if (description === "fail") throw new Error("boom");
        return { result: description, rounds: 1 };
      })
    );

    const p = plan([
      { id: "s1", kind: "browser", description: "ok" },
      { id: "s2", kind: "browser", description: "fail" },
      { id: "s3", kind: "browser", description: "never" },
    ]);
    state.setPlan(p);

    await expect(dispatcher.runPlan(state, p)).rejects.toThrow(/boom/);

    expect(events.some((e) => e.type === "step_failed" && e.stepId === "s2")).toBe(true);
    // s3 never started.
    expect(events.some((e) => e.type === "step_started" && e.stepId === "s3")).toBe(false);
  });

  it("throws when a step has no registered handler", async () => {
    const state = new StateManager();
    const dispatcher = new Dispatcher(); // nothing registered
    const p = plan([{ id: "s1", kind: "browser", description: "x" }]);
    state.setPlan(p);
    await expect(dispatcher.runPlan(state, p)).rejects.toThrow(
      /No sub-agent registered/i
    );
  });

  it("refuses two agents for the same kind", () => {
    const dispatcher = new Dispatcher();
    const a = fakeAgent("browser", async () => ({ result: "a", rounds: 1 }));
    const b = fakeAgent("browser", async () => ({ result: "b", rounds: 1 }));
    dispatcher.register(a);
    expect(() => dispatcher.register(b)).toThrow(/Two sub-agents/i);
  });

  it("shutdown is idempotent and best-effort", async () => {
    const dispatcher = new Dispatcher();
    const shutdownSpy = vi.fn(async () => {});
    dispatcher.register(
      fakeAgent("browser", async () => ({ result: "x", rounds: 1 }), shutdownSpy)
    );

    await dispatcher.shutdown();
    await dispatcher.shutdown();
    expect(shutdownSpy).toHaveBeenCalledTimes(1);
  });
});
