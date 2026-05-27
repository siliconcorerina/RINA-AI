/**
 * Tests for the v0.3 tool additions that don't require the network or
 * a real git repo.
 *
 * Most of v0.3 (web_fetch, git_*, native function-calling against
 * provider APIs) is intentionally exercised by smoke tests rather than
 * vitest — mocking fetch and `git` here would test the mocks more than
 * the real code paths. What we DO check here is everything
 * deterministic: parser acceptance, tool definitions surface, safety
 * checks that run before any side effect.
 */

import { describe, expect, test } from "vitest";

import { extractFirstToolCall } from "../src/parse.js";
import { getToolDefinitions } from "../src/tools.js";
import { runTool } from "../src/tools.js";
import type { AgentConfig } from "../src/types.js";

function makeConfig(): AgentConfig {
  return {
    backendSpec: "deepseek:deepseek-chat",
    workdir: process.cwd(),
    maxSteps: 10,
    tokenBudget: 10_000,
    yolo: true,
    readOnly: false,
    language: "en",
    maxTokens: 1024,
    temperature: 0.2,
    resume: false,
    nativeTools: false,
  };
}

describe("parse — accepts v0.3 tool names", () => {
  test("web_fetch", () => {
    const r = extractFirstToolCall('<tool>{"tool":"web_fetch","args":{"url":"https://x.com"}}</tool>');
    expect(r?.tool).toBe("web_fetch");
  });

  test("git_status / git_diff / git_log", () => {
    expect(extractFirstToolCall('<tool>{"tool":"git_status","args":{}}</tool>')?.tool).toBe("git_status");
    expect(extractFirstToolCall('<tool>{"tool":"git_diff","args":{"path":"x.ts"}}</tool>')?.tool).toBe("git_diff");
    expect(extractFirstToolCall('<tool>{"tool":"git_log","args":{"limit":10}}</tool>')?.tool).toBe("git_log");
  });
});

describe("getToolDefinitions", () => {
  test("returns one entry per tool name", () => {
    const defs = getToolDefinitions();
    const names = defs.map((d) => d.name).sort();
    expect(names).toEqual(
      [
        "edit_file",
        "finish",
        "git_diff",
        "git_log",
        "git_status",
        "list_files",
        "read_file",
        "search_files",
        "shell",
        "web_fetch",
        "write_file",
      ].sort()
    );
  });

  test("every definition has a description and a JSON-Schema-shaped parameters object", () => {
    for (const def of getToolDefinitions()) {
      expect(def.description.length).toBeGreaterThan(0);
      expect(def.parameters).toEqual(expect.objectContaining({ type: "object" }));
    }
  });
});

describe("web_fetch — safety", () => {
  test("rejects non-http(s) schemes", async () => {
    const r = await runTool({ tool: "web_fetch", args: { url: "file:///etc/passwd" } }, makeConfig());
    expect(r.ok).toBe(false);
    expect(r.output).toMatch(/scheme/i);
  });

  test("rejects localhost / loopback", async () => {
    const r = await runTool({ tool: "web_fetch", args: { url: "http://127.0.0.1:8080" } }, makeConfig());
    expect(r.ok).toBe(false);
    expect(r.output).toMatch(/private|loopback/i);
  });

  test("rejects private network ranges", async () => {
    for (const host of ["10.0.0.1", "192.168.1.1", "172.16.0.1", "169.254.169.254"]) {
      const r = await runTool({ tool: "web_fetch", args: { url: `http://${host}` } }, makeConfig());
      expect(r.ok).toBe(false);
    }
  });

  test("rejects malformed URL", async () => {
    const r = await runTool({ tool: "web_fetch", args: { url: "not a url" } }, makeConfig());
    expect(r.ok).toBe(false);
    expect(r.output).toMatch(/Invalid URL/);
  });
});

describe("git_* — safety", () => {
  test("git_diff path arg is path-scoped (rejects /etc/passwd)", async () => {
    const r = await runTool(
      { tool: "git_diff", args: { path: "/etc/passwd" } },
      makeConfig()
    );
    expect(r.ok).toBe(false);
    expect(r.output).toMatch(/Refusing|outside/);
  });

  test("git_log path arg is path-scoped", async () => {
    const r = await runTool(
      { tool: "git_log", args: { path: "/etc" } },
      makeConfig()
    );
    expect(r.ok).toBe(false);
  });
});
