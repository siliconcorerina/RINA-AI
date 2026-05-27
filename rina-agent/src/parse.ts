/**
 * Extract tool calls from raw model output.
 *
 * The model is taught (via the system prompt) to wrap each tool call in
 * `<tool>...</tool>` with a single JSON object inside. This is the
 * laziest format that survives all four backends we support — neither
 * `openai:`, `anthropic:`, `mistral:` nor `deepseek:` ever clobbers angle
 * brackets in normal generation, and the regex is forgiving enough to
 * tolerate the small formatting drifts each provider exhibits.
 *
 * Native function-calling APIs would be more robust, but they each have
 * a slightly different shape, so deferring that to a future v1 keeps the
 * MVP universal.
 */

import type { ToolCall, ToolName } from "./types.js";

const VALID_TOOLS: ReadonlySet<ToolName> = new Set([
  "read_file",
  "write_file",
  "list_files",
  "shell",
  "finish",
]);

/**
 * Pull the first <tool>{...}</tool> block out of `text`.
 *
 * Returns `null` if the model didn't emit any tool call — the caller
 * treats that as "the model gave up or wanted to chat", which becomes a
 * polite nudge on the next turn.
 *
 * `multiline: true` on the regex lets the JSON span lines, which the
 * model often does for write_file payloads with embedded newlines.
 */
export function extractFirstToolCall(text: string): ToolCall | null {
  const match = text.match(/<tool>\s*(\{[\s\S]*?\})\s*<\/tool>/);
  if (!match) {
    return null;
  }
  const raw = match[1];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Tolerate the most common mistake: trailing commas. Try once more
    // with a single-pass strip before giving up. Anything more elaborate
    // and we're reimplementing JSON5.
    try {
      parsed = JSON.parse(raw.replace(/,(\s*[}\]])/g, "$1"));
    } catch {
      return null;
    }
  }

  if (!isToolCall(parsed)) {
    return null;
  }
  return parsed;
}

function isToolCall(value: unknown): value is ToolCall {
  if (!value || typeof value !== "object") {
    return false;
  }
  const obj = value as { tool?: unknown; args?: unknown };
  if (typeof obj.tool !== "string" || !VALID_TOOLS.has(obj.tool as ToolName)) {
    return false;
  }
  // `args` may legitimately be undefined for tools that take no args
  // (none today, but keep the door open). Normalize to {} downstream.
  if (obj.args !== undefined && (typeof obj.args !== "object" || obj.args === null)) {
    return false;
  }
  return true;
}

/**
 * Best-effort token estimate.
 *
 * We don't pull a tokenizer dependency for what is essentially a budget
 * indicator. The 4-chars-per-token approximation is wrong for non-ASCII
 * but consistently wrong in the same direction, which is what a budget
 * actually needs.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
