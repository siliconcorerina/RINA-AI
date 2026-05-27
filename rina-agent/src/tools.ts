/**
 * The five tools the agent can call.
 *
 * Surface kept deliberately small — anything the model needs beyond
 * these can be expressed as a shell command. Adding more tools is the
 * wrong default: every new tool is a new prompt-injection surface and
 * a new place for hallucinated arguments to do damage.
 *
 *   - read_file(path)           – return file contents, truncated at 64 KB
 *   - write_file(path, content) – overwrite/create, with diff preview
 *   - list_files(dir)           – non-recursive listing, sorted
 *   - shell(cmd)                – run command after explicit confirmation
 *   - finish(summary)           – signal the loop to terminate cleanly
 *
 * All paths are funnelled through `safePath` so the model can never
 * touch anything outside its workdir.
 */

import { promises as fs, existsSync, readFileSync } from "node:fs";
import { exec } from "node:child_process";
import { dirname } from "node:path";
import { promisify } from "node:util";

import type { AgentConfig, ToolCall, ToolResult } from "./types.js";
import {
  assertCommandAllowed,
  BlockedCommandError,
  confirm,
  safePath,
  UnsafePathError,
} from "./safety.js";

const execP = promisify(exec);

/** Cap on file content surfaced to the model. 64 KB ≈ ~16k tokens. */
const FILE_READ_LIMIT = 64 * 1024;
/** Cap on shell stdout returned to the model. Longer outputs get truncated. */
const SHELL_OUTPUT_LIMIT = 16 * 1024;
/** Shell command timeout. Long-running tasks should be backgrounded by the user. */
const SHELL_TIMEOUT_MS = 60_000;

/**
 * Dispatch a single tool call to its implementation.
 *
 * Tool errors are caught here and surfaced as `{ ok: false, output: msg }`
 * so the agent loop sees them as "this turn's result" rather than as a
 * fatal exception. That lets the model self-correct on the next step.
 *
 * The one exception is `finish` — it returns `ok: true` with `output: ""`
 * and the loop checks the tool name separately. We don't smuggle the
 * termination signal through `ok`.
 */
export async function runTool(call: ToolCall, config: AgentConfig): Promise<ToolResult> {
  try {
    switch (call.tool) {
      case "read_file":
        return await runReadFile(call.args, config);
      case "write_file":
        return await runWriteFile(call.args, config);
      case "list_files":
        return await runListFiles(call.args, config);
      case "shell":
        return await runShell(call.args, config);
      case "finish":
        // The loop handles `finish` specially; we still return a result
        // so the contract stays uniform.
        return { ok: true, output: "" };
    }
  } catch (err) {
    if (err instanceof UnsafePathError || err instanceof BlockedCommandError) {
      return { ok: false, output: err.message };
    }
    return { ok: false, output: `Tool error: ${(err as Error).message}` };
  }
}

// ─────────────────────────────────────────────────────────────────────
// read_file
// ─────────────────────────────────────────────────────────────────────

async function runReadFile(
  args: Record<string, unknown>,
  config: AgentConfig
): Promise<ToolResult> {
  const path = requireString(args, "path");
  const abs = safePath(path, config.workdir);
  const content = await fs.readFile(abs, "utf8");
  if (content.length > FILE_READ_LIMIT) {
    return {
      ok: true,
      output:
        content.slice(0, FILE_READ_LIMIT) +
        `\n\n[truncated: file is ${content.length} bytes, showed first ${FILE_READ_LIMIT}]`,
    };
  }
  return { ok: true, output: content };
}

// ─────────────────────────────────────────────────────────────────────
// write_file
// ─────────────────────────────────────────────────────────────────────

async function runWriteFile(
  args: Record<string, unknown>,
  config: AgentConfig
): Promise<ToolResult> {
  if (config.readOnly) {
    return { ok: false, output: "Refusing to write — agent is in --read-only mode." };
  }
  const path = requireString(args, "path");
  const content = requireString(args, "content");
  const abs = safePath(path, config.workdir);

  // Show the user what the model wants to write before doing it. This
  // is the single biggest safety win — most "the model went off the
  // rails" stories die on the diff preview.
  const preview = previewWrite(abs, content);
  process.stderr.write(preview);
  const okToWrite = await confirm(`Write to ${path}?`, config);
  if (!okToWrite) {
    return { ok: false, output: `User declined the write to ${path}.` };
  }

  await fs.mkdir(dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, "utf8");
  return { ok: true, output: `Wrote ${content.length} bytes to ${path}.` };
}

/**
 * Build a terminal-friendly preview of the upcoming write.
 *
 * For new files we show the full content (capped at 4 KB). For overwrites
 * we show the current size, the new size, and the first few lines of the
 * new content — full unified diffs would require a diff library and the
 * benefit/dep tradeoff isn't there for v0.
 */
function previewWrite(absPath: string, newContent: string): string {
  const existed = existsSync(absPath);
  if (!existed) {
    const head = newContent.length > 4096 ? newContent.slice(0, 4096) + "\n…" : newContent;
    return `\n── CREATE ${absPath} (${newContent.length} bytes) ──\n${head}\n── end ──\n`;
  }
  let oldSize = 0;
  try {
    oldSize = readFileSync(absPath, "utf8").length;
  } catch {
    /* ignore */
  }
  const head = newContent.split("\n").slice(0, 20).join("\n");
  return (
    `\n── OVERWRITE ${absPath} ` +
    `(${oldSize} → ${newContent.length} bytes) ──\n` +
    `${head}${newContent.split("\n").length > 20 ? "\n…" : ""}\n── end ──\n`
  );
}

// ─────────────────────────────────────────────────────────────────────
// list_files
// ─────────────────────────────────────────────────────────────────────

async function runListFiles(
  args: Record<string, unknown>,
  config: AgentConfig
): Promise<ToolResult> {
  // `dir` defaults to "." so the model can scan the workdir root without
  // having to hard-code its path.
  const dir = typeof args.dir === "string" && args.dir.length > 0 ? args.dir : ".";
  const abs = safePath(dir, config.workdir);
  const entries = await fs.readdir(abs, { withFileTypes: true });
  const lines = entries
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
  return { ok: true, output: lines.join("\n") };
}

// ─────────────────────────────────────────────────────────────────────
// shell
// ─────────────────────────────────────────────────────────────────────

async function runShell(
  args: Record<string, unknown>,
  config: AgentConfig
): Promise<ToolResult> {
  if (config.readOnly) {
    return { ok: false, output: "Refusing to run shell — agent is in --read-only mode." };
  }
  const cmd = requireString(args, "cmd");
  // Blacklist runs FIRST so even --yolo can't bypass it.
  assertCommandAllowed(cmd);

  const ok = await confirm(`Run shell: \`${cmd}\``, config);
  if (!ok) {
    return { ok: false, output: `User declined to run: ${cmd}` };
  }

  try {
    const { stdout, stderr } = await execP(cmd, {
      cwd: config.workdir,
      timeout: SHELL_TIMEOUT_MS,
      maxBuffer: 10 * 1024 * 1024,
    });
    return { ok: true, output: truncate(stdout + (stderr ? `\n[stderr]\n${stderr}` : "")) };
  } catch (err) {
    // exec rejects on non-zero exit too — surface that to the model
    // along with whatever stdout/stderr came through.
    const e = err as { stdout?: string; stderr?: string; code?: number; message: string };
    const body = [
      e.stdout ? `[stdout]\n${e.stdout}` : "",
      e.stderr ? `[stderr]\n${e.stderr}` : "",
      `[exit ${e.code ?? "?"}] ${e.message}`,
    ]
      .filter(Boolean)
      .join("\n");
    return { ok: false, output: truncate(body) };
  }
}

function truncate(s: string): string {
  if (s.length <= SHELL_OUTPUT_LIMIT) {
    return s;
  }
  return s.slice(0, SHELL_OUTPUT_LIMIT) + `\n[truncated: ${s.length} bytes total]`;
}

// ─────────────────────────────────────────────────────────────────────
// Argument helpers
// ─────────────────────────────────────────────────────────────────────

function requireString(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== "string" || v.length === 0) {
    throw new Error(`Missing or invalid '${key}' argument (expected a non-empty string).`);
  }
  return v;
}
