/**
 * MCP connector tests.
 *
 * The config parsing + pure helpers are unit-tested directly. The client
 * and hub are exercised end-to-end against a tiny real MCP server
 * (test/fixtures/mock-mcp-server.cjs) spawned via `node` — that covers
 * the JSON-RPC framing and handshake for real, with zero network and
 * fully deterministic output. Spawning a fake server beats mocking
 * child_process: the framing bugs live in the framing, not the mock.
 */

import { describe, expect, test } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  McpStdioClient,
  McpHub,
  loadMcpConfig,
  flattenMcpContent,
  describeMcpToolsForPrompt,
  sanitizeToolName,
} from "../src/mcp.js";

const FIXTURE = join(process.cwd(), "test", "fixtures", "mock-mcp-server.cjs");
const NODE = process.execPath;

function mockConfig() {
  return { mcpServers: { mock: { command: NODE, args: [FIXTURE] } } };
}

function tmpWorkdir(): string {
  return mkdtempSync(join(tmpdir(), "rina-mcp-"));
}

// ─────────────────────────────────────────────────────────────────────
// loadMcpConfig
// ─────────────────────────────────────────────────────────────────────

describe("loadMcpConfig", () => {
  test("returns null when no .mcp.json and no explicit path", () => {
    expect(loadMcpConfig(undefined, tmpWorkdir())).toBeNull();
  });

  test("auto-detects <workdir>/.mcp.json", () => {
    const dir = tmpWorkdir();
    writeFileSync(
      join(dir, ".mcp.json"),
      JSON.stringify({ mcpServers: { fs: { command: "npx", args: ["-y", "pkg"] } } })
    );
    const loaded = loadMcpConfig(undefined, dir);
    expect(loaded).not.toBeNull();
    expect(loaded!.config.mcpServers.fs.command).toBe("npx");
    expect(loaded!.config.mcpServers.fs.args).toEqual(["-y", "pkg"]);
    expect(loaded!.path.endsWith(".mcp.json")).toBe(true);
  });

  test("throws when an explicit --mcp-config path is missing", () => {
    const dir = tmpWorkdir();
    expect(() => loadMcpConfig(join(dir, "nope.json"), dir)).toThrow(/no file/i);
  });

  test("expands ${VAR} in args and env from process.env", () => {
    const dir = tmpWorkdir();
    process.env.RINA_TEST_MCP_SECRET = "s3cr3t";
    writeFileSync(
      join(dir, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          x: {
            command: "node",
            args: ["--token=${RINA_TEST_MCP_SECRET}"],
            env: { TOKEN: "${RINA_TEST_MCP_SECRET}" },
          },
        },
      })
    );
    const loaded = loadMcpConfig(undefined, dir);
    expect(loaded!.config.mcpServers.x.args).toEqual(["--token=s3cr3t"]);
    expect(loaded!.config.mcpServers.x.env).toEqual({ TOKEN: "s3cr3t" });
    delete process.env.RINA_TEST_MCP_SECRET;
  });

  test("throws on invalid JSON", () => {
    const dir = tmpWorkdir();
    writeFileSync(join(dir, ".mcp.json"), "{ not json");
    expect(() => loadMcpConfig(undefined, dir)).toThrow(/Invalid JSON/i);
  });

  test("throws when mcpServers is missing or a server has no command", () => {
    const noServers = tmpWorkdir();
    writeFileSync(join(noServers, ".mcp.json"), JSON.stringify({ foo: 1 }));
    expect(() => loadMcpConfig(undefined, noServers)).toThrow(/mcpServers/i);

    const noCommand = tmpWorkdir();
    writeFileSync(join(noCommand, ".mcp.json"), JSON.stringify({ mcpServers: { a: { args: [] } } }));
    expect(() => loadMcpConfig(undefined, noCommand)).toThrow(/command/i);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Pure helpers
// ─────────────────────────────────────────────────────────────────────

describe("sanitizeToolName", () => {
  test("replaces characters invalid for provider function names", () => {
    expect(sanitizeToolName("mcp__mock__ns.weird/name")).toBe("mcp__mock__ns_weird_name");
  });

  test("caps length at 64", () => {
    const long = "mcp__server__" + "x".repeat(200);
    expect(sanitizeToolName(long).length).toBe(64);
  });
});

describe("flattenMcpContent", () => {
  test("joins text blocks", () => {
    expect(
      flattenMcpContent({ content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] })
    ).toBe("a\nb");
  });

  test("renders images as a placeholder, never raw base64", () => {
    const out = flattenMcpContent({ content: [{ type: "image", mimeType: "image/png", data: "AAAA" }] });
    expect(out).toMatch(/\[image image\/png/);
    expect(out).not.toContain("AAAA");
  });

  test("empty / missing content is the empty string", () => {
    expect(flattenMcpContent({})).toBe("");
    expect(flattenMcpContent(null)).toBe("");
  });
});

describe("describeMcpToolsForPrompt", () => {
  test("lists each tool name and its argument names", () => {
    const text = describeMcpToolsForPrompt([
      {
        name: "mcp__mock__echo",
        description: "Echo it",
        parameters: { type: "object", properties: { text: { type: "string" } } },
      },
    ]);
    expect(text).toContain("mcp__mock__echo");
    expect(text).toContain('"text": string');
    expect(text).toContain("Echo it");
  });

  test("empty list yields empty string", () => {
    expect(describeMcpToolsForPrompt([])).toBe("");
  });
});

// ─────────────────────────────────────────────────────────────────────
// McpStdioClient — end-to-end against the fixture server
// ─────────────────────────────────────────────────────────────────────

describe("McpStdioClient (live stdio handshake)", () => {
  test("initialize → list → call → close", async () => {
    const client = new McpStdioClient("mock", { command: NODE, args: [FIXTURE] });
    await client.start();
    try {
      const tools = await client.listTools();
      const names = tools.map((t) => t.name);
      expect(names).toContain("echo");
      expect(names).toContain("add");

      const echo = await client.callTool("echo", { text: "hello mcp" });
      expect(flattenMcpContent(echo)).toBe("hello mcp");

      const sum = await client.callTool("add", { a: 2, b: 40 });
      expect(flattenMcpContent(sum)).toBe("42");
    } finally {
      await client.close();
    }
  }, 15000);

  test("a missing command surfaces as a start() rejection", async () => {
    const client = new McpStdioClient("bad", {
      command: join(process.cwd(), "definitely", "not", "a", "real", "binary-xyz"),
      args: [],
    });
    await expect(client.start()).rejects.toBeTruthy();
    await client.close();
  }, 15000);
});

// ─────────────────────────────────────────────────────────────────────
// McpHub — namespacing, dispatch, error flag
// ─────────────────────────────────────────────────────────────────────

describe("McpHub (live)", () => {
  test("connects, namespaces tools, dispatches, flags isError, tears down", async () => {
    const hub = await McpHub.create(mockConfig());
    try {
      expect(hub.serverCount()).toBe(1);
      expect(hub.toolCount()).toBeGreaterThanOrEqual(4);

      // Namespacing + sanitising.
      expect(hub.isMcpTool("mcp__mock__echo")).toBe(true);
      expect(hub.isMcpTool("mcp__mock__ns_weird_name")).toBe(true);
      expect(hub.isMcpTool("echo")).toBe(false);

      const defs = hub.getToolDefinitions();
      expect(defs.every((d) => d.name.startsWith("mcp__mock__"))).toBe(true);
      expect(defs.find((d) => d.name === "mcp__mock__echo")?.description).toMatch(/\[MCP:mock\]/);

      // Dispatch returns a ToolResult shaped for the agent loop.
      const ok = await hub.callTool("mcp__mock__echo", { text: "yo" });
      expect(ok.ok).toBe(true);
      expect(ok.output).toBe("yo");

      // isError from the server maps to ok:false.
      const bad = await hub.callTool("mcp__mock__boom", {});
      expect(bad.ok).toBe(false);
      expect(bad.output).toBe("this tool failed");

      // Unknown namespaced tool is handled, not thrown.
      const missing = await hub.callTool("mcp__mock__does_not_exist", {});
      expect(missing.ok).toBe(false);
    } finally {
      await hub.closeAll();
    }
    expect(hub.toolCount()).toBe(0);
  }, 15000);

  test("a server that fails to start is skipped, not fatal", async () => {
    const hub = await McpHub.create({
      mcpServers: {
        good: { command: NODE, args: [FIXTURE] },
        broken: { command: "this-binary-does-not-exist-xyz", args: [] },
      },
    });
    try {
      // The good server still connected; the broken one was skipped.
      expect(hub.serverCount()).toBe(1);
      expect(hub.isMcpTool("mcp__good__echo")).toBe(true);
    } finally {
      await hub.closeAll();
    }
  }, 15000);
});
