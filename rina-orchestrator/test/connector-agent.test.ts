/**
 * Unit tests for the ConnectorAgent.
 *
 * No network, no live MCP server: we drive the agent with a scripted
 * fake Backend (returns a queue of NativeAssistantResponse) and a fake
 * hub implementing the structural McpToolProvider interface. Coverage:
 *   - Happy path: call an MCP tool, then done() → summary returned.
 *   - done() on the first round → rounds = 1.
 *   - Unknown tool name → error fed back, hub.callTool not invoked.
 *   - Failed tool result is prefixed with ERROR.
 *   - Off-script prose is nudged, then bails after round 2.
 *   - Round budget exhausted → fallback result.
 *   - Backend without function-calling → constructor throws.
 *   - previousResults are injected as prior context.
 */

import { describe, expect, it, vi } from "vitest";

import type {
  Backend,
  ChatMessage,
  NativeAssistantResponse,
  ToolDefinition,
} from "@siliconcorerina/rina-agent/out/backend.js";

import { ConnectorAgent } from "../src/agents/connector/connector-agent.js";
import type { McpToolProvider } from "../src/agents/connector/connector-agent.js";

interface RecordedCall {
  messages: ChatMessage[];
  tools: ToolDefinition[];
}

/**
 * A Backend whose generateWithTools replays `responses` in order
 * (repeating the last entry if the agent loops longer than the script).
 * Records each call's messages (snapshotted) + tools for assertions.
 */
function scriptedBackend(responses: NativeAssistantResponse[]): {
  backend: Backend;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  let i = 0;
  const backend: Backend = {
    spec: "fake:fake",
    generate: async () => "",
    generateWithTools: async (messages, tools) => {
      calls.push({ messages: messages.map((m) => ({ ...m })), tools });
      const r = responses[Math.min(i, responses.length - 1)]!;
      i++;
      return r;
    },
  };
  return { backend, calls };
}

function fakeHub(opts: {
  defs?: ToolDefinition[];
  call?: (
    name: string,
    args: Record<string, unknown>
  ) => { ok: boolean; output: string };
  /** Names treated as MCP tools. Defaults to the def names. */
  mcpNames?: string[];
}): McpToolProvider & { calls: Array<{ name: string; args: Record<string, unknown> }> } {
  const defs = opts.defs ?? [];
  const names = new Set(opts.mcpNames ?? defs.map((d) => d.name));
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  return {
    calls,
    getToolDefinitions: () => defs,
    isMcpTool: (name) => names.has(name),
    callTool: async (name, args) => {
      calls.push({ name, args });
      return opts.call ? opts.call(name, args) : { ok: true, output: "OK" };
    },
  };
}

const sampleTool: ToolDefinition = {
  name: "mcp__gmail__send",
  description: "Send an email",
  parameters: {
    type: "object",
    properties: { to: { type: "string" } },
    required: ["to"],
    additionalProperties: false,
  },
};

function toolCall(name: string, args: unknown, id = "t1"): NativeAssistantResponse {
  return { text: "", toolCall: { id, name, argsJson: JSON.stringify(args) } };
}

describe("ConnectorAgent", () => {
  it("calls an MCP tool then done(), returning the summary", async () => {
    const { backend, calls } = scriptedBackend([
      toolCall("mcp__gmail__send", { to: "x@y.z" }, "t1"),
      toolCall("done", { summary: "Email envoyé." }, "t2"),
    ]);
    const hub = fakeHub({ defs: [sampleTool], call: () => ({ ok: true, output: "sent id=42" }) });
    const agent = new ConnectorAgent(backend, hub);
    const onProgress = vi.fn();

    const res = await agent.run({
      description: "Envoie un email à x@y.z",
      previousResults: [],
      onProgress,
    });

    expect(res.result).toBe("Email envoyé.");
    expect(res.rounds).toBe(2);
    expect(hub.calls).toEqual([{ name: "mcp__gmail__send", args: { to: "x@y.z" } }]);
    expect(onProgress).toHaveBeenCalledTimes(1);
    // The catalog handed to the backend includes both the MCP tool and done().
    const offered = calls[0]!.tools.map((t) => t.name);
    expect(offered).toContain("mcp__gmail__send");
    expect(offered).toContain("done");
  });

  it("returns rounds=1 when done() is called immediately", async () => {
    const { backend } = scriptedBackend([toolCall("done", { summary: "Rien à faire." })]);
    const agent = new ConnectorAgent(backend, fakeHub({ defs: [sampleTool] }));

    const res = await agent.run({ description: "x", previousResults: [], onProgress: () => {} });

    expect(res).toEqual({ result: "Rien à faire.", rounds: 1 });
  });

  it("feeds an error back when the model calls an unknown tool", async () => {
    const { backend, calls } = scriptedBackend([
      toolCall("mcp__nope__do", {}, "t1"),
      toolCall("done", { summary: "fini" }, "t2"),
    ]);
    const hub = fakeHub({ defs: [sampleTool] }); // mcp__nope__do is NOT an MCP tool
    const agent = new ConnectorAgent(backend, hub);

    const res = await agent.run({ description: "x", previousResults: [], onProgress: () => {} });

    expect(res.result).toBe("fini");
    // The bogus name never reached the hub.
    expect(hub.calls).toEqual([]);
    // The second backend call saw the error as the tool result.
    const toolResult = calls[1]!.messages.find((m) => m.toolCallId === "t1");
    expect(toolResult?.content).toMatch(/not an available tool/i);
  });

  it("prefixes a failed tool result with ERROR", async () => {
    const { backend, calls } = scriptedBackend([
      toolCall("mcp__gmail__send", {}, "t1"),
      toolCall("done", { summary: "ok" }, "t2"),
    ]);
    const hub = fakeHub({ defs: [sampleTool], call: () => ({ ok: false, output: "rate limited" }) });
    const agent = new ConnectorAgent(backend, hub);

    await agent.run({ description: "x", previousResults: [], onProgress: () => {} });

    const toolResult = calls[1]!.messages.find((m) => m.toolCallId === "t1");
    expect(toolResult?.content).toBe("ERROR: rate limited");
  });

  it("nudges on prose and bails after round 2", async () => {
    const { backend } = scriptedBackend([{ text: "je réfléchis…", toolCall: null }]);
    const agent = new ConnectorAgent(backend, fakeHub({ defs: [sampleTool] }));

    const res = await agent.run({ description: "x", previousResults: [], onProgress: () => {} });

    expect(res.rounds).toBe(3);
    expect(res.result).toBe("je réfléchis…");
  });

  it("returns a fallback when done() is never called within the budget", async () => {
    const { backend } = scriptedBackend([toolCall("mcp__gmail__send", {})]);
    const hub = fakeHub({ defs: [sampleTool], call: () => ({ ok: true, output: "ok" }) });
    const agent = new ConnectorAgent(backend, hub, { maxRounds: 2 });

    const res = await agent.run({ description: "x", previousResults: [], onProgress: () => {} });

    expect(res.rounds).toBe(2);
    expect(res.result).toMatch(/did not call done/i);
  });

  it("throws if the backend lacks function-calling", () => {
    const noFc: Backend = { spec: "fake:fake", generate: async () => "" };
    expect(() => new ConnectorAgent(noFc, fakeHub({}))).toThrow(/function-calling/i);
  });

  it("injects previous step results as prior context", async () => {
    const { backend, calls } = scriptedBackend([toolCall("done", { summary: "ok" })]);
    const agent = new ConnectorAgent(backend, fakeHub({ defs: [sampleTool] }));

    await agent.run({
      description: "x",
      previousResults: ["résultat A", "résultat B"],
      onProgress: () => {},
    });

    const ctx = calls[0]!.messages.find(
      (m) => m.role === "user" && /Contexte des étapes précédentes/.test(m.content)
    );
    expect(ctx).toBeTruthy();
    expect(ctx?.content).toContain("résultat A");
    expect(ctx?.content).toContain("résultat B");
  });
});
