/**
 * Safety layer for the autonomous agent.
 *
 * An LLM that can run shell commands and edit files is one hallucination
 * away from `rm -rf ~`. This module exists to make that impossible by
 * default and merely awkward when the user opts in.
 *
 * Three concerns, kept separate so they're individually testable:
 *
 *   1. Path scoping — every read/write/list is anchored to `workdir`;
 *      attempts to escape via `..`, absolute paths, or symlinks return
 *      a hard error instead of touching the filesystem.
 *
 *   2. Command blacklist — a small set of shell invocations are *always*
 *      rejected, even with --yolo. These are commands no agent should
 *      ever need (rm -rf /, sudo, mkfs, dd, fork bombs, curl|sh, etc.).
 *
 *   3. Interactive confirmation — shell commands and writes require a
 *      single-keystroke Y/n from the user. `--yolo` skips this but
 *      still respects the blacklist.
 *
 * Budget tracking lives here too because it's the same shape of
 * cross-cutting concern: stop the agent before it does damage.
 */

import { resolve, relative, isAbsolute } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

import type { AgentConfig } from "./types.js";

// ─────────────────────────────────────────────────────────────────────
// Path scoping
// ─────────────────────────────────────────────────────────────────────

export class UnsafePathError extends Error {
  constructor(path: string, workdir: string) {
    super(`Refusing to access '${path}' — outside workdir '${workdir}'.`);
    this.name = "UnsafePathError";
  }
}

/**
 * Resolve `userPath` against `workdir` and verify it doesn't escape.
 *
 * Returns the absolute path on success. Throws `UnsafePathError` for
 * anything that resolves outside `workdir`, including:
 *   - absolute paths              ("/etc/passwd")
 *   - parent traversal            ("../../../something")
 *   - sneaky combinations         ("subdir/../../outside")
 *
 * NOTE: this does NOT resolve symlinks. A determined adversary with
 * write access to the workdir could plant a symlink. Defense in depth
 * lives at the OS/container level — this module's job is to stop the
 * common accidents, not the targeted attack.
 */
export function safePath(userPath: string, workdir: string): string {
  if (typeof userPath !== "string" || userPath.length === 0) {
    throw new UnsafePathError(String(userPath), workdir);
  }
  const root = resolve(workdir);
  const target = isAbsolute(userPath) ? resolve(userPath) : resolve(root, userPath);
  const rel = relative(root, target);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new UnsafePathError(userPath, workdir);
  }
  return target;
}

// ─────────────────────────────────────────────────────────────────────
// Command blacklist
// ─────────────────────────────────────────────────────────────────────

/**
 * Always-reject patterns, regardless of --yolo.
 *
 * Each entry is matched against the trimmed command after whitespace
 * normalisation. We deliberately err on the side of caution — if a
 * legitimate use case is blocked, the user can carve it out, but a
 * silent `rm -rf /` is unrecoverable.
 */
const ALWAYS_BLOCKED: ReadonlyArray<RegExp> = [
  // Destructive filesystem operations on root or home
  /\brm\s+(-[a-z]*r[a-z]*f[a-z]*|-[a-z]*f[a-z]*r[a-z]*)\s+\/(\s|$)/,
  /\brm\s+(-[a-z]*r[a-z]*f[a-z]*|-[a-z]*f[a-z]*r[a-z]*)\s+~(\s|$|\/)/,
  /\brm\s+(-[a-z]*r[a-z]*f[a-z]*|-[a-z]*f[a-z]*r[a-z]*)\s+\$HOME(\s|$|\/)/,
  // Filesystem reformat / raw device writes
  /\bmkfs\b/,
  /\bdd\s+.*\bof=\/dev\//,
  /\b(format|diskpart)\b/i,
  // Privilege escalation
  /\bsudo\b/,
  /\bsu\s+-\b/,
  // Network → shell pipe (curl|sh, wget|bash) — too easy to MITM
  /\b(curl|wget|fetch)\b[^|]*\|\s*(sh|bash|zsh|fish|sudo)\b/,
  // Fork bombs and known-evil one-liners
  /:\s*\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/,
  // Encryption / wipe utilities
  /\b(shred|wipe|srm)\b/,
];

export class BlockedCommandError extends Error {
  constructor(cmd: string) {
    super(`Refusing to run dangerous command: ${cmd.slice(0, 200)}`);
    this.name = "BlockedCommandError";
  }
}

/**
 * Throw if `cmd` matches any always-blocked pattern.
 *
 * The blacklist is intentionally short — we'd rather pass a marginally
 * suspicious command to the human (who sees a confirmation prompt) than
 * train the user to ignore over-eager warnings.
 */
export function assertCommandAllowed(cmd: string): void {
  const normalized = cmd.trim();
  for (const pattern of ALWAYS_BLOCKED) {
    if (pattern.test(normalized)) {
      throw new BlockedCommandError(normalized);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────
// Interactive confirmation
// ─────────────────────────────────────────────────────────────────────

/**
 * Ask the user to confirm an action. Returns true on Y/y/Enter, false otherwise.
 *
 * Honors `config.yolo` (always true) and `config.readOnly` (always false
 * for write/shell paths — the caller is expected to reject those before
 * even reaching this function, but we double-check defensively).
 */
export async function confirm(question: string, config: AgentConfig): Promise<boolean> {
  if (config.readOnly) {
    return false;
  }
  if (config.yolo) {
    return true;
  }
  // readline.promises is happy reading from a TTY; if stdin is piped
  // (CI, scripts), we treat that as "no confirmation possible" and
  // refuse — the user must opt in with --yolo for non-interactive use.
  if (!stdin.isTTY) {
    return false;
  }
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    const answer = await rl.question(`${question} [Y/n] `);
    const t = answer.trim().toLowerCase();
    return t === "" || t === "y" || t === "yes" || t === "o" || t === "oui";
  } finally {
    rl.close();
  }
}

// ─────────────────────────────────────────────────────────────────────
// Budget tracking
// ─────────────────────────────────────────────────────────────────────

/**
 * Cumulative usage across the session. Mutated by the agent loop after
 * each model response. The agent compares against `config.tokenBudget`
 * and `config.maxSteps` to decide when to bail.
 */
export class Budget {
  steps = 0;
  tokens = 0;

  constructor(
    public readonly maxSteps: number,
    public readonly maxTokens: number
  ) {}

  /** Increment step + tokens; return true if both still under budget. */
  record(addedTokens: number): boolean {
    this.steps += 1;
    this.tokens += addedTokens;
    return this.steps < this.maxSteps && this.tokens < this.maxTokens;
  }

  /** Human-readable status for the end-of-run summary. */
  describe(): string {
    return `steps=${this.steps}/${this.maxSteps} tokens=${this.tokens}/${this.maxTokens}`;
  }
}
