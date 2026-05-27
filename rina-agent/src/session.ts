/**
 * Session persistence for --continue.
 *
 * The agent saves its conversation history (system + user + assistant
 * + tool-result messages) plus the budget counters to a small JSON
 * file in the workdir after every step. `--continue` reads it back and
 * resumes from exactly where the last run stopped.
 *
 * Why save after every step rather than only at clean exit?
 *   - Ctrl-C is the common exit; we want it to be safe.
 *   - The agent burning budget mid-loop is exactly when you want to
 *     resume and tweak the task, not when you want to lose it.
 *
 * File layout: `<workdir>/.rina-agent/last.json`
 *   - Per-workdir, not per-user. A session belongs to the repo it ran
 *     against, which is also the most likely place the user would look
 *     for it.
 *   - Suggest adding `.rina-agent/` to `.gitignore` (the README does).
 *
 * The format is intentionally a flat snapshot, not an event log —
 * smaller, easier to inspect, no replay logic to maintain.
 */

import { promises as fs, mkdirSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { ChatMessage } from "./backend.js";

/** Bumped if the on-disk schema ever changes incompatibly. */
const SESSION_FORMAT_VERSION = 1;

export interface SessionSnapshot {
  /** Schema version. Old snapshots are refused rather than auto-migrated. */
  version: number;
  /** Workdir at the time the session was saved — sanity check on resume. */
  workdir: string;
  /** Backend the previous session was using. Logged on resume; not enforced. */
  backendSpec: string;
  /** The original user task description. */
  task: string;
  /** Full conversation history including tool results. */
  messages: ChatMessage[];
  /** Cumulative step count from the previous run. */
  steps: number;
  /** Cumulative token estimate from the previous run. */
  tokens: number;
  /** ISO timestamp of the last save. */
  savedAt: string;
}

const SESSION_DIR = ".rina-agent";
const SESSION_FILE = "last.json";

function pathFor(workdir: string): string {
  return join(workdir, SESSION_DIR, SESSION_FILE);
}

/**
 * Atomic-ish save: write to a sibling temp file then rename. Eliminates
 * the "agent crashed mid-write" failure mode that would leave the file
 * in a partial-JSON state and break the next --continue.
 */
export async function saveSession(workdir: string, snap: SessionSnapshot): Promise<void> {
  const dir = join(workdir, SESSION_DIR);
  // mkdirSync is fine here — we're already inside an async function so
  // the cost of sync is irrelevant, but the recursive option matches
  // node's behaviour for "create only if missing".
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const finalPath = pathFor(workdir);
  const tmpPath = finalPath + ".tmp";
  await fs.writeFile(tmpPath, JSON.stringify(snap, null, 2), "utf8");
  await fs.rename(tmpPath, finalPath);
}

/**
 * Load a previously-saved session, or return `null` if there isn't one.
 * Returns `null` (not throws) for missing files because the very first
 * --continue on a fresh workdir is a legitimate no-op situation; the
 * agent loop logs a notice and starts a new session in that case.
 *
 * Throws on parse failure / version mismatch — those *should* surface
 * loudly because they mean the file exists but isn't usable.
 */
export function loadSession(workdir: string): SessionSnapshot | null {
  const path = pathFor(workdir);
  if (!existsSync(path)) {
    return null;
  }
  const raw = readFileSync(path, "utf8");
  let parsed: SessionSnapshot;
  try {
    parsed = JSON.parse(raw) as SessionSnapshot;
  } catch (err) {
    throw new Error(
      `Could not parse session at ${path}: ${(err as Error).message}. ` +
        `Delete it to start fresh.`
    );
  }
  if (parsed.version !== SESSION_FORMAT_VERSION) {
    throw new Error(
      `Session at ${path} is version ${parsed.version}, this build expects ${SESSION_FORMAT_VERSION}. ` +
        `Delete it to start fresh.`
    );
  }
  return parsed;
}

/**
 * Build a new snapshot from the agent's live state. Just a tiny
 * constructor helper so the agent loop doesn't have to remember to
 * stamp version / savedAt every time.
 */
export function buildSnapshot(args: {
  workdir: string;
  backendSpec: string;
  task: string;
  messages: ChatMessage[];
  steps: number;
  tokens: number;
}): SessionSnapshot {
  return {
    version: SESSION_FORMAT_VERSION,
    workdir: args.workdir,
    backendSpec: args.backendSpec,
    task: args.task,
    messages: args.messages,
    steps: args.steps,
    tokens: args.tokens,
    savedAt: new Date().toISOString(),
  };
}
