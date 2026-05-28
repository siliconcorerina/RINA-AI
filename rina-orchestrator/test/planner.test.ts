/**
 * Unit tests for the Planner.
 *
 * We mock the Backend so the tests don't hit the network. The
 * assertions focus on:
 *   - Schema-correct submit_plan output is accepted.
 *   - Empty / wrong-shape output throws with a clear message.
 *   - Backends without function-calling are rejected upfront.
 */

import { describe, expect, it } from "vitest";

import type { Backend, NativeAssistantResponse } from "@siliconcorerina/rina-agent/out/backend.js";

import { planGoal, __test } from "../src/core/planner.js";

function backend(stub: NativeAssistantResponse | (() => Promise<NativeAssistantResponse>)): Backend {
  const fn = typeof stub === "function" ? stub : () => Promise.resolve(stub);
  return {
    spec: "fake:fake",
    generate: async () => "",
    generateWithTools: fn,
  };
}

describe("planner", () => {
  it("returns a Plan when the model calls submit_plan", async () => {
    const plan = await planGoal(
      backend({
        text: "",
        toolCall: {
          id: "1",
          name: "submit_plan",
          argsJson: JSON.stringify({
            steps: [
              { kind: "browser", description: "Ouvre google.com" },
              { kind: "browser", description: "Tape 'météo paris' dans la barre de recherche" },
            ],
          }),
        },
      }),
      "Trouve la météo à Paris aujourd'hui"
    );

    expect(plan.goal).toBe("Trouve la météo à Paris aujourd'hui");
    expect(plan.steps).toHaveLength(2);
    expect(plan.steps[0]?.id).toBe("s1");
    expect(plan.steps[0]?.kind).toBe("browser");
    expect(plan.steps[1]?.status).toBe("pending");
  });

  it("throws when the backend has no function-calling", async () => {
    const noFc: Backend = {
      spec: "fake:fake",
      generate: async () => "",
      // generateWithTools intentionally omitted
    };
    await expect(planGoal(noFc, "anything")).rejects.toThrow(
      /native function-calling/i
    );
  });

  it("throws when the model returns text instead of a tool call", async () => {
    await expect(
      planGoal(
        backend({ text: "Sure, here's a plan…", toolCall: null }),
        "anything"
      )
    ).rejects.toThrow(/did not call submit_plan/i);
  });

  it("throws when the step list is empty", async () => {
    await expect(
      planGoal(
        backend({
          text: "",
          toolCall: {
            id: "1",
            name: "submit_plan",
            argsJson: JSON.stringify({ steps: [] }),
          },
        }),
        "anything"
      )
    ).rejects.toThrow(/empty/i);
  });

  it("caps the plan at maxSteps", async () => {
    const tenSteps = Array.from({ length: 10 }, (_, i) => ({
      kind: "browser",
      description: `Step ${i + 1}`,
    }));
    const plan = await planGoal(
      backend({
        text: "",
        toolCall: {
          id: "1",
          name: "submit_plan",
          argsJson: JSON.stringify({ steps: tenSteps }),
        },
      }),
      "do many things",
      { maxSteps: 4 }
    );
    expect(plan.steps).toHaveLength(4);
  });

  it("falls back to 'browser' for unknown step kinds", async () => {
    const plan = await planGoal(
      backend({
        text: "",
        toolCall: {
          id: "1",
          name: "submit_plan",
          argsJson: JSON.stringify({
            steps: [{ kind: "lolwhat", description: "Try something" }],
          }),
        },
      }),
      "anything"
    );
    expect(plan.steps[0]?.kind).toBe("browser");
  });

  it("the submit_plan tool schema declares all required fields", () => {
    const tool = __test.SUBMIT_PLAN_TOOL;
    expect(tool.name).toBe("submit_plan");
    // Sanity: parameters is a JSON Schema with `steps` as an array.
    const params = tool.parameters as { properties: { steps?: { type?: string } } };
    expect(params.properties.steps?.type).toBe("array");
  });
});
