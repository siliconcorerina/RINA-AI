/**
 * Tool dispatcher tests.
 *
 * We exercise read_file, list_files, and finish against a real temp
 * directory because mocking the entire `node:fs` surface would be more
 * code than the tools themselves. write_file and shell aren't tested
 * here — they require interactive confirmation and are covered by the
 * safety tests for their non-interactive concerns (blacklist, path
 * scoping).
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runTool } from "../src/tools.js";
import type { AgentConfig } from "../src/types.js";

let workdir: string;

function makeConfig(): AgentConfig {
  return {
    backendSpec: "openai:gpt-4o-mini",
    workdir,
    maxSteps: 10,
    tokenBudget: 10_000,
    yolo: true, // tests don't have a TTY
    readOnly: false,
    language: "en",
    maxTokens: 1024,
    temperature: 0.2,
  };
}

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), "rina-agent-test-"));
});

afterEach(() => {
  rmSync(workdir, { recursive: true, force: true });
});

describe("read_file", () => {
  test("returns file contents", async () => {
    writeFileSync(join(workdir, "hello.txt"), "hi there");
    const r = await runTool({ tool: "read_file", args: { path: "hello.txt" } }, makeConfig());
    expect(r.ok).toBe(true);
    expect(r.output).toBe("hi there");
  });

  test("errors on missing file but does not throw", async () => {
    const r = await runTool({ tool: "read_file", args: { path: "nope.txt" } }, makeConfig());
    expect(r.ok).toBe(false);
    expect(r.output).toMatch(/Tool error/);
  });

  test("rejects path outside workdir", async () => {
    const r = await runTool({ tool: "read_file", args: { path: "/etc/passwd" } }, makeConfig());
    expect(r.ok).toBe(false);
    expect(r.output).toMatch(/Refusing/);
  });

  test("rejects missing path argument", async () => {
    const r = await runTool({ tool: "read_file", args: {} }, makeConfig());
    expect(r.ok).toBe(false);
  });
});

describe("list_files", () => {
  test("lists files and marks directories with a trailing slash", async () => {
    writeFileSync(join(workdir, "a.txt"), "a");
    writeFileSync(join(workdir, "b.txt"), "b");
    mkdirSync(join(workdir, "sub"));
    const r = await runTool({ tool: "list_files", args: { dir: "." } }, makeConfig());
    expect(r.ok).toBe(true);
    const lines = r.output.split("\n").sort();
    expect(lines).toEqual(["a.txt", "b.txt", "sub/"]);
  });

  test("defaults to workdir root when dir is empty", async () => {
    writeFileSync(join(workdir, "only.txt"), "x");
    const r = await runTool({ tool: "list_files", args: {} }, makeConfig());
    expect(r.ok).toBe(true);
    expect(r.output).toContain("only.txt");
  });

  test("rejects dir outside workdir", async () => {
    const r = await runTool({ tool: "list_files", args: { dir: "/etc" } }, makeConfig());
    expect(r.ok).toBe(false);
  });
});

describe("finish", () => {
  test("returns ok with empty output (loop owns the termination semantics)", async () => {
    const r = await runTool(
      { tool: "finish", args: { summary: "done" } },
      makeConfig()
    );
    expect(r.ok).toBe(true);
    expect(r.output).toBe("");
  });
});

describe("read-only mode", () => {
  test("write_file is rejected without touching disk", async () => {
    const config = { ...makeConfig(), readOnly: true };
    const r = await runTool(
      { tool: "write_file", args: { path: "x.txt", content: "x" } },
      config
    );
    expect(r.ok).toBe(false);
    expect(r.output).toMatch(/read-only/i);
  });

  test("shell is rejected without confirmation prompt", async () => {
    const config = { ...makeConfig(), readOnly: true };
    const r = await runTool({ tool: "shell", args: { cmd: "echo hi" } }, config);
    expect(r.ok).toBe(false);
    expect(r.output).toMatch(/read-only/i);
  });
});
