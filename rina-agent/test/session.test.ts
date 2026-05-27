/**
 * Tests for session persistence (--continue).
 *
 * We exercise the on-disk format and the round-trip — the agent loop
 * itself (which calls saveSession after every step) is a longer
 * integration story that lives in the smoke tests.
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildSnapshot, loadSession, saveSession } from "../src/session.js";

let workdir: string;

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), "rina-agent-session-"));
});
afterEach(() => {
  rmSync(workdir, { recursive: true, force: true });
});

describe("loadSession", () => {
  test("returns null when no session exists", () => {
    expect(loadSession(workdir)).toBeNull();
  });

  test("throws with helpful hint on corrupted JSON", () => {
    mkdirSync(join(workdir, ".rina-agent"));
    writeFileSync(join(workdir, ".rina-agent", "last.json"), "not json");
    expect(() => loadSession(workdir)).toThrow(/Could not parse|Delete it/);
  });

  test("throws on version mismatch (forward-compat protection)", () => {
    mkdirSync(join(workdir, ".rina-agent"));
    writeFileSync(
      join(workdir, ".rina-agent", "last.json"),
      JSON.stringify({ version: 9999, messages: [], steps: 0, tokens: 0 })
    );
    expect(() => loadSession(workdir)).toThrow(/version|Delete it/);
  });
});

describe("saveSession + loadSession round-trip", () => {
  test("loads exactly what was saved", async () => {
    const snap = buildSnapshot({
      workdir,
      backendSpec: "deepseek:deepseek-chat",
      task: "do the thing",
      messages: [
        { role: "system", content: "be a good agent" },
        { role: "user", content: "do the thing" },
        { role: "assistant", content: "okay, listing files…" },
      ],
      steps: 3,
      tokens: 420,
    });
    await saveSession(workdir, snap);

    const reloaded = loadSession(workdir);
    expect(reloaded).not.toBeNull();
    expect(reloaded?.task).toBe("do the thing");
    expect(reloaded?.steps).toBe(3);
    expect(reloaded?.tokens).toBe(420);
    expect(reloaded?.messages.length).toBe(3);
    expect(reloaded?.backendSpec).toBe("deepseek:deepseek-chat");
  });

  test("creates the .rina-agent directory if missing", async () => {
    const snap = buildSnapshot({
      workdir,
      backendSpec: "openai:gpt-4o-mini",
      task: "x",
      messages: [],
      steps: 0,
      tokens: 0,
    });
    await saveSession(workdir, snap);
    expect(existsSync(join(workdir, ".rina-agent", "last.json"))).toBe(true);
  });

  test("overwrites previous session without leaving the temp file behind", async () => {
    const first = buildSnapshot({
      workdir,
      backendSpec: "deepseek:deepseek-chat",
      task: "first",
      messages: [{ role: "user", content: "first" }],
      steps: 1,
      tokens: 10,
    });
    const second = buildSnapshot({
      workdir,
      backendSpec: "deepseek:deepseek-chat",
      task: "second",
      messages: [{ role: "user", content: "second" }],
      steps: 2,
      tokens: 20,
    });
    await saveSession(workdir, first);
    await saveSession(workdir, second);

    const reloaded = loadSession(workdir);
    expect(reloaded?.task).toBe("second");
    // The atomic rename should never leave a `last.json.tmp` behind.
    expect(existsSync(join(workdir, ".rina-agent", "last.json.tmp"))).toBe(false);
  });

  test("preserves tool-call metadata in serialised messages", async () => {
    const snap = buildSnapshot({
      workdir,
      backendSpec: "anthropic:claude-3-5-haiku-latest",
      task: "fix the bug",
      messages: [
        { role: "system", content: "agent" },
        { role: "user", content: "fix the bug" },
        {
          role: "assistant",
          content: "calling read_file",
          toolCall: { id: "call_123", name: "read_file", argsJson: '{"path":"src/x.ts"}' },
        },
        { role: "user", content: "file contents…", toolCallId: "call_123" },
      ],
      steps: 1,
      tokens: 50,
    });
    await saveSession(workdir, snap);
    const reloaded = loadSession(workdir);
    expect(reloaded?.messages[2].toolCall?.name).toBe("read_file");
    expect(reloaded?.messages[3].toolCallId).toBe("call_123");
  });
});

describe("buildSnapshot", () => {
  test("stamps a current ISO timestamp", () => {
    const before = Date.now();
    const snap = buildSnapshot({
      workdir,
      backendSpec: "openai:gpt-4o-mini",
      task: "x",
      messages: [],
      steps: 0,
      tokens: 0,
    });
    const after = Date.now();
    const t = new Date(snap.savedAt).getTime();
    expect(t).toBeGreaterThanOrEqual(before);
    expect(t).toBeLessThanOrEqual(after);
  });
});
