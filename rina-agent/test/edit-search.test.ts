/**
 * Tests for the v0.2 tools: edit_file, search_files, recursive list_files.
 *
 * Each test sets up a fresh temp dir so the agent has a real-ish workdir
 * to operate on, then asserts the tool produced the right result against
 * the actual filesystem. The dispatcher catches thrown errors and turns
 * them into ok=false, so we test the structured result, not exceptions.
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runTool } from "../src/tools.js";
import type { AgentConfig } from "../src/types.js";

let workdir: string;

function makeConfig(): AgentConfig {
  return {
    backendSpec: "deepseek:deepseek-chat",
    workdir,
    maxSteps: 10,
    tokenBudget: 10_000,
    yolo: true, // skip interactive prompt
    readOnly: false,
    language: "en",
    maxTokens: 1024,
    temperature: 0.2,
  };
}

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), "rina-agent-v02-"));
});
afterEach(() => {
  rmSync(workdir, { recursive: true, force: true });
});

// ─────────────────────────────────────────────────────────────────────
// edit_file
// ─────────────────────────────────────────────────────────────────────

describe("edit_file", () => {
  test("performs a unique search/replace", async () => {
    writeFileSync(join(workdir, "a.ts"), "const x = 1;\nconst y = 2;\n");
    const r = await runTool(
      {
        tool: "edit_file",
        args: { path: "a.ts", old_text: "const x = 1;", new_text: "const x = 42;" },
      },
      makeConfig()
    );
    expect(r.ok).toBe(true);
    expect(readFileSync(join(workdir, "a.ts"), "utf8")).toBe("const x = 42;\nconst y = 2;\n");
  });

  test("fails clearly when old_text is missing", async () => {
    writeFileSync(join(workdir, "a.ts"), "const x = 1;\n");
    const r = await runTool(
      { tool: "edit_file", args: { path: "a.ts", old_text: "nothing-here", new_text: "x" } },
      makeConfig()
    );
    expect(r.ok).toBe(false);
    expect(r.output).toMatch(/not found/i);
  });

  test("fails when old_text appears more than once", async () => {
    writeFileSync(join(workdir, "a.ts"), "x = 1;\nx = 2;\n");
    const r = await runTool(
      { tool: "edit_file", args: { path: "a.ts", old_text: "x", new_text: "y" } },
      makeConfig()
    );
    expect(r.ok).toBe(false);
    expect(r.output).toMatch(/appears \d+ times/);
  });

  test("read-only mode refuses without touching disk", async () => {
    writeFileSync(join(workdir, "a.ts"), "x");
    const cfg = { ...makeConfig(), readOnly: true };
    const r = await runTool(
      { tool: "edit_file", args: { path: "a.ts", old_text: "x", new_text: "y" } },
      cfg
    );
    expect(r.ok).toBe(false);
    expect(readFileSync(join(workdir, "a.ts"), "utf8")).toBe("x");
  });

  test("refuses path outside workdir", async () => {
    const r = await runTool(
      {
        tool: "edit_file",
        args: { path: "/etc/passwd", old_text: "root", new_text: "x" },
      },
      makeConfig()
    );
    expect(r.ok).toBe(false);
    expect(r.output).toMatch(/Refusing|outside/);
  });

  test("missing file errors politely", async () => {
    const r = await runTool(
      { tool: "edit_file", args: { path: "nope.ts", old_text: "x", new_text: "y" } },
      makeConfig()
    );
    expect(r.ok).toBe(false);
    expect(r.output).toMatch(/Could not read|write_file/);
  });
});

// ─────────────────────────────────────────────────────────────────────
// search_files
// ─────────────────────────────────────────────────────────────────────

describe("search_files", () => {
  test("finds a literal pattern across files", async () => {
    writeFileSync(join(workdir, "a.ts"), "export const userId = 1;\n");
    writeFileSync(join(workdir, "b.ts"), "function getUser() {}\n");
    const r = await runTool(
      { tool: "search_files", args: { pattern: "[Uu]ser" } },
      makeConfig()
    );
    expect(r.ok).toBe(true);
    expect(r.output).toMatch(/a\.ts:1.*userId/);
    expect(r.output).toMatch(/b\.ts:1.*getUser/);
  });

  test("respects the glob filter", async () => {
    writeFileSync(join(workdir, "a.ts"), "match\n");
    writeFileSync(join(workdir, "a.py"), "match\n");
    const r = await runTool(
      { tool: "search_files", args: { pattern: "match", glob: "*.ts" } },
      makeConfig()
    );
    expect(r.output).toContain("a.ts");
    expect(r.output).not.toContain("a.py");
  });

  test("returns a 'no matches' message when nothing matches", async () => {
    writeFileSync(join(workdir, "a.ts"), "hello\n");
    const r = await runTool(
      { tool: "search_files", args: { pattern: "absent_token" } },
      makeConfig()
    );
    expect(r.ok).toBe(true);
    expect(r.output).toMatch(/no matches/i);
  });

  test("respects .gitignore by default", async () => {
    writeFileSync(join(workdir, ".gitignore"), "ignored.txt\n");
    writeFileSync(join(workdir, "ignored.txt"), "match\n");
    writeFileSync(join(workdir, "kept.txt"), "match\n");
    const r = await runTool(
      { tool: "search_files", args: { pattern: "match" } },
      makeConfig()
    );
    expect(r.output).toContain("kept.txt");
    expect(r.output).not.toContain("ignored.txt");
  });

  test("rejects an invalid regex with a helpful error", async () => {
    const r = await runTool(
      { tool: "search_files", args: { pattern: "[unclosed" } },
      makeConfig()
    );
    expect(r.ok).toBe(false);
    expect(r.output).toMatch(/Invalid regex/);
  });
});

// ─────────────────────────────────────────────────────────────────────
// list_files (recursive + gitignore)
// ─────────────────────────────────────────────────────────────────────

describe("list_files — recursive + gitignore", () => {
  test("non-recursive default unchanged", async () => {
    writeFileSync(join(workdir, "top.txt"), "");
    mkdirSync(join(workdir, "sub"));
    writeFileSync(join(workdir, "sub", "deep.txt"), "");
    const r = await runTool({ tool: "list_files", args: { dir: "." } }, makeConfig());
    expect(r.output).toContain("top.txt");
    expect(r.output).toContain("sub/");
    expect(r.output).not.toContain("deep.txt"); // not walked
  });

  test("recursive walks every subdirectory", async () => {
    writeFileSync(join(workdir, "a.txt"), "");
    mkdirSync(join(workdir, "sub"));
    writeFileSync(join(workdir, "sub", "b.txt"), "");
    const r = await runTool(
      { tool: "list_files", args: { dir: ".", recursive: true } },
      makeConfig()
    );
    expect(r.output).toContain("a.txt");
    expect(r.output).toContain("sub/b.txt");
  });

  test("recursive respects .gitignore by default", async () => {
    writeFileSync(join(workdir, ".gitignore"), "ignored/\n");
    mkdirSync(join(workdir, "ignored"));
    writeFileSync(join(workdir, "ignored", "x.txt"), "");
    writeFileSync(join(workdir, "kept.txt"), "");
    const r = await runTool(
      { tool: "list_files", args: { dir: ".", recursive: true } },
      makeConfig()
    );
    expect(r.output).toContain("kept.txt");
    expect(r.output).not.toContain("ignored");
  });

  test("respect_gitignore=false includes the ignored entries", async () => {
    writeFileSync(join(workdir, ".gitignore"), "ignored/\n");
    mkdirSync(join(workdir, "ignored"));
    writeFileSync(join(workdir, "ignored", "x.txt"), "");
    const r = await runTool(
      {
        tool: "list_files",
        args: { dir: ".", recursive: true, respect_gitignore: false },
      },
      makeConfig()
    );
    expect(r.output).toContain("ignored/x.txt");
  });

  test(".git is always skipped on recursive walks", async () => {
    mkdirSync(join(workdir, ".git"));
    writeFileSync(join(workdir, ".git", "HEAD"), "ref: refs/heads/main");
    writeFileSync(join(workdir, "real.txt"), "");
    const r = await runTool(
      { tool: "list_files", args: { dir: ".", recursive: true } },
      makeConfig()
    );
    expect(r.output).toContain("real.txt");
    expect(r.output).not.toContain(".git");
  });
});
