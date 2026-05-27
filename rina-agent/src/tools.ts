/**
 * The seven tools the agent can call.
 *
 * Surface kept deliberately small — anything the model needs beyond
 * these can be expressed as a shell command. Adding more tools is the
 * wrong default: every new tool is a new prompt-injection surface and
 * a new place for hallucinated arguments to do damage.
 *
 *   - read_file(path)                      – return file contents (≤ 64 KB)
 *   - write_file(path, content)            – overwrite/create, diff preview
 *   - edit_file(path, old_text, new_text)  – targeted search/replace, diff preview
 *   - list_files(dir, recursive?, respect_gitignore?) – directory listing
 *   - search_files(pattern, glob?, max_results?)      – grep across workdir
 *   - shell(cmd)                           – run command after confirmation
 *   - finish(summary)                      – signal the loop to terminate
 *
 * All paths are funnelled through `safePath` so the model can never
 * touch anything outside its workdir.
 */

import { promises as fs, existsSync, readFileSync } from "node:fs";
import { exec } from "node:child_process";
import { dirname, relative, join } from "node:path";
import { promisify } from "node:util";

import type { AgentConfig, ToolCall, ToolResult } from "./types.js";
import {
  assertCommandAllowed,
  BlockedCommandError,
  confirm,
  safePath,
  UnsafePathError,
} from "./safety.js";
import { loadGitignore, ALWAYS_INCLUDE } from "./gitignore.js";

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
      case "edit_file":
        return await runEditFile(call.args, config);
      case "list_files":
        return await runListFiles(call.args, config);
      case "search_files":
        return await runSearchFiles(call.args, config);
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
// edit_file — targeted search/replace
// ─────────────────────────────────────────────────────────────────────

async function runEditFile(
  args: Record<string, unknown>,
  config: AgentConfig
): Promise<ToolResult> {
  if (config.readOnly) {
    return { ok: false, output: "Refusing to edit — agent is in --read-only mode." };
  }
  const path = requireString(args, "path");
  const oldText = requireString(args, "old_text");
  const newText = requireString(args, "new_text");
  const abs = safePath(path, config.workdir);

  // The whole point of edit_file vs write_file is: don't rewrite the
  // whole file, just patch one specific occurrence. So `old_text` MUST
  // appear exactly once — zero hits and one hit are very different
  // failures and the model needs distinct feedback to self-correct.
  let original: string;
  try {
    original = await fs.readFile(abs, "utf8");
  } catch (err) {
    return {
      ok: false,
      output: `Could not read ${path}: ${(err as Error).message}. Use write_file to create a new file.`,
    };
  }

  const matches = countOccurrences(original, oldText);
  if (matches === 0) {
    return {
      ok: false,
      output:
        `old_text not found in ${path}. ` +
        `Re-read the file and supply old_text exactly as it appears (whitespace + newlines included).`,
    };
  }
  if (matches > 1) {
    return {
      ok: false,
      output:
        `old_text appears ${matches} times in ${path}. ` +
        `Make old_text more specific by including surrounding context until it's unique.`,
    };
  }

  const updated = original.replace(oldText, newText);

  // Compact diff preview (just the changed lines plus a couple of
  // anchors) — full unified diff would be nicer but isn't worth a deps.
  const preview = previewEdit(abs, oldText, newText);
  process.stderr.write(preview);
  const okToWrite = await confirm(`Edit ${path}?`, config);
  if (!okToWrite) {
    return { ok: false, output: `User declined the edit to ${path}.` };
  }

  await fs.writeFile(abs, updated, "utf8");
  return {
    ok: true,
    output:
      `Edited ${path}: ${oldText.length} → ${newText.length} bytes ` +
      `(file now ${updated.length} bytes).`,
  };
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) {
    return 0;
  }
  let count = 0;
  let idx = 0;
  while ((idx = haystack.indexOf(needle, idx)) !== -1) {
    count += 1;
    idx += needle.length;
  }
  return count;
}

function previewEdit(absPath: string, oldText: string, newText: string): string {
  const oldHead = oldText.split("\n").slice(0, 8).join("\n");
  const newHead = newText.split("\n").slice(0, 8).join("\n");
  const oldOverflow = oldText.split("\n").length > 8 ? "\n…" : "";
  const newOverflow = newText.split("\n").length > 8 ? "\n…" : "";
  return (
    `\n── EDIT ${absPath} ──\n` +
    `--- old (${oldText.length} bytes)\n${oldHead}${oldOverflow}\n` +
    `+++ new (${newText.length} bytes)\n${newHead}${newOverflow}\n` +
    `── end ──\n`
  );
}

// ─────────────────────────────────────────────────────────────────────
// list_files (recursive + gitignore support)
// ─────────────────────────────────────────────────────────────────────

/** Hard cap on entries returned in one list_files call. */
const LIST_FILES_LIMIT = 500;

async function runListFiles(
  args: Record<string, unknown>,
  config: AgentConfig
): Promise<ToolResult> {
  // `dir` defaults to "." so the model can scan the workdir root without
  // having to hard-code its path.
  const dir = typeof args.dir === "string" && args.dir.length > 0 ? args.dir : ".";
  const recursive = args.recursive === true;
  // .gitignore respected by default when recursive (otherwise a recursive
  // listing of a Node project = node_modules dump = context explosion).
  const respectGitignore = args.respect_gitignore !== false;
  const maxEntries =
    typeof args.max_entries === "number" && args.max_entries > 0
      ? Math.min(args.max_entries, LIST_FILES_LIMIT)
      : LIST_FILES_LIMIT;

  const absRoot = safePath(dir, config.workdir);

  if (!recursive) {
    const entries = await fs.readdir(absRoot, { withFileTypes: true });
    const lines = entries
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
    return { ok: true, output: lines.join("\n") };
  }

  const ignore = respectGitignore ? loadGitignore(config.workdir) : ALWAYS_INCLUDE;
  const collected: string[] = [];
  let truncated = false;

  async function walk(currentAbs: string): Promise<void> {
    if (collected.length >= maxEntries) {
      truncated = true;
      return;
    }
    const entries = await fs.readdir(currentAbs, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (collected.length >= maxEntries) {
        truncated = true;
        return;
      }
      const entryAbs = join(currentAbs, entry.name);
      const rel = relative(config.workdir, entryAbs).replace(/\\/g, "/");
      const isDir = entry.isDirectory();
      // Always skip .git — never useful to the agent, always huge.
      if (isDir && entry.name === ".git") {
        continue;
      }
      if (ignore.ignores(rel, isDir)) {
        continue;
      }
      collected.push(isDir ? `${rel}/` : rel);
      if (isDir) {
        await walk(entryAbs);
      }
    }
  }

  await walk(absRoot);

  let output = collected.join("\n");
  if (truncated) {
    output += `\n[truncated at ${maxEntries} entries — pass max_entries to raise]`;
  }
  return { ok: true, output };
}

// ─────────────────────────────────────────────────────────────────────
// search_files — grep across the workdir
// ─────────────────────────────────────────────────────────────────────

/** Hard cap on match lines returned in one search_files call. */
const SEARCH_DEFAULT_MAX = 100;
const SEARCH_HARD_MAX = 500;
/** Skip files larger than this when scanning — usually binaries / minified bundles. */
const SEARCH_FILE_SIZE_LIMIT = 1 * 1024 * 1024; // 1 MB

async function runSearchFiles(
  args: Record<string, unknown>,
  config: AgentConfig
): Promise<ToolResult> {
  const patternStr = requireString(args, "pattern");
  const glob = typeof args.glob === "string" && args.glob.length > 0 ? args.glob : undefined;
  const maxResults =
    typeof args.max_results === "number" && args.max_results > 0
      ? Math.min(args.max_results, SEARCH_HARD_MAX)
      : SEARCH_DEFAULT_MAX;

  let regex: RegExp;
  try {
    regex = new RegExp(patternStr);
  } catch (err) {
    return {
      ok: false,
      output: `Invalid regex '${patternStr}': ${(err as Error).message}`,
    };
  }

  const globRegex = glob ? globToRegex(glob) : null;
  const ignore = loadGitignore(config.workdir);
  const matches: string[] = [];
  let truncated = false;

  async function walk(currentAbs: string): Promise<void> {
    if (matches.length >= maxResults) {
      truncated = true;
      return;
    }
    const entries = await fs.readdir(currentAbs, { withFileTypes: true });
    for (const entry of entries) {
      if (matches.length >= maxResults) {
        truncated = true;
        return;
      }
      const entryAbs = join(currentAbs, entry.name);
      const rel = relative(config.workdir, entryAbs).replace(/\\/g, "/");
      if (entry.isDirectory()) {
        if (entry.name === ".git") {
          continue;
        }
        if (ignore.ignores(rel, true)) {
          continue;
        }
        await walk(entryAbs);
        continue;
      }
      if (ignore.ignores(rel, false)) {
        continue;
      }
      if (globRegex && !globRegex.test(rel)) {
        continue;
      }
      let stat;
      try {
        stat = await fs.stat(entryAbs);
      } catch {
        continue;
      }
      if (stat.size > SEARCH_FILE_SIZE_LIMIT) {
        continue;
      }
      let content: string;
      try {
        content = await fs.readFile(entryAbs, "utf8");
      } catch {
        continue;
      }
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (regex.test(lines[i])) {
          matches.push(`${rel}:${i + 1}: ${lines[i].slice(0, 200)}`);
          if (matches.length >= maxResults) {
            truncated = true;
            break;
          }
        }
      }
    }
  }

  await walk(config.workdir);

  if (matches.length === 0) {
    return { ok: true, output: `(no matches for /${patternStr}/${glob ? ` in ${glob}` : ""})` };
  }
  let output = matches.join("\n");
  if (truncated) {
    output += `\n[truncated at ${maxResults} matches — refine pattern or pass max_results to raise]`;
  }
  return { ok: true, output };
}

/**
 * Simple glob-to-regex helper used only by `search_files`. Reuses the
 * same rules as `gitignore.globToRegex` but without anchoring options.
 *   - `*` matches anything except `/`
 *   - `**` matches anything including `/`
 *   - `?` matches one non-`/` char
 */
function globToRegex(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        re += ".*";
        i++;
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if (c === ".") {
      re += "\\.";
    } else if ("+()|^$[]{}\\".includes(c)) {
      re += "\\" + c;
    } else {
      re += c;
    }
  }
  return new RegExp(`^${re}$`);
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
