/**
 * The agent loop.
 *
 * High level:
 *
 *   while not done:
 *     ask backend for next move (system prompt + conversation history)
 *     parse a <tool>...</tool> block from the response
 *     run the tool through the safety layer
 *     append result to history
 *     check budget / step limit
 *
 * Deliberately kept linear and readable. Streaming, parallel tool calls,
 * sub-agents, search-then-act planners — all valuable, all out of scope
 * for the v0 MVP. The point here is to nail the safety/UX basics and
 * publish something reproducible.
 *
 * Nothing in this file knows about specific providers — backend.ts owns
 * that. Anything provider-shaped that leaks here should be pushed back
 * down to the shared Backend abstraction.
 */

import { backendFromSpec, ChatMessage } from "./backend.js";
import { extractFirstToolCall, estimateTokens } from "./parse.js";
import { buildSystemPrompt } from "./prompt.js";
import { runTool, getToolDefinitions } from "./tools.js";
import { Budget } from "./safety.js";
import { estimateCost, formatCost } from "./pricing.js";
import { buildSnapshot, loadSession, saveSession } from "./session.js";
import type { AgentConfig, AgentResult, ToolCall, ToolResult, ToolName } from "./types.js";

/**
 * Run the agent on a single task description until it finishes or runs
 * out of budget. Returns a structured `AgentResult` rather than throwing
 * so the CLI can render a clean end-of-run summary.
 */
export async function runAgent(task: string, config: AgentConfig): Promise<AgentResult> {
  const backend = backendFromSpec(config.backendSpec);
  const budget = new Budget(config.maxSteps, config.tokenBudget);

  // Either continue from the last snapshot or start a fresh conversation.
  // The cumulative budget counters carry over too — `--continue` should
  // honour the total step/token caps across the whole logical session,
  // not silently reset them on each invocation.
  let messages: ChatMessage[];
  let resumedTask = task;
  if (config.resume) {
    const snap = loadSession(config.workdir);
    if (snap === null) {
      process.stderr.write(
        `[rina-agent] --continue: no previous session at ${config.workdir}/.rina-agent/last.json, starting fresh\n`
      );
      messages = [
        { role: "system", content: buildSystemPrompt(config.language) },
        { role: "user", content: task },
      ];
    } else {
      messages = snap.messages;
      budget.steps = snap.steps;
      budget.tokens = snap.tokens;
      resumedTask = snap.task;
      // New instruction appended as the next user turn so the agent
      // sees both the resumed history *and* the fresh ask.
      if (task.trim().length > 0) {
        messages.push({ role: "user", content: task });
      }
      process.stderr.write(
        `[rina-agent] resumed: ${snap.steps} prior steps, ${snap.tokens} prior tokens (saved ${snap.savedAt})\n`
      );
    }
  } else {
    messages = [
      { role: "system", content: buildSystemPrompt(config.language) },
      { role: "user", content: task },
    ];
  }

  // We print a small banner so the user sees what's happening in real
  // time — the agent loop is otherwise silent until tools fire.
  process.stderr.write(
    `\n[rina-agent] backend=${config.backendSpec} workdir=${config.workdir} ` +
      `max-steps=${config.maxSteps} ${config.yolo ? "yolo " : ""}` +
      `${config.readOnly ? "read-only " : ""}\n\n`
  );

  // If native function-calling is requested AND the backend supports it,
  // we use a different message-flow shape: tool calls carry provider ids
  // that round-trip back as tool_result/tool messages. The prompt-based
  // path stays available as a universal fallback.
  const useNative = config.nativeTools && typeof backend.generateWithTools === "function";
  const toolDefs = useNative ? getToolDefinitions() : [];
  if (config.nativeTools && !useNative) {
    process.stderr.write(
      `[rina-agent] warn: --native-tools requested but ${config.backendSpec} doesn't implement it; falling back to prompt-based.\n`
    );
  }

  while (true) {
    let displayText: string;
    let call: ToolCall | null;
    let toolCallId: string | undefined;
    let addedTokens: number;

    if (useNative) {
      const resp = await backend.generateWithTools!(messages, toolDefs, {
        maxTokens: config.maxTokens,
        temperature: config.temperature,
      });
      displayText = resp.text;
      addedTokens = estimateTokens(resp.text) + (resp.toolCall ? estimateTokens(resp.toolCall.argsJson) : 0);
      if (resp.toolCall) {
        call = {
          tool: resp.toolCall.name as ToolName,
          args: parseToolArgs(resp.toolCall.argsJson),
        };
        toolCallId = resp.toolCall.id;
        // Record the assistant turn with toolCall metadata so subsequent
        // generateWithTools calls can stitch the tool result back through.
        messages.push({
          role: "assistant",
          content: resp.text,
          toolCall: { id: resp.toolCall.id, name: resp.toolCall.name, argsJson: resp.toolCall.argsJson },
        });
      } else {
        call = null;
        messages.push({ role: "assistant", content: resp.text });
      }
    } else {
      const reply = await backend.generate(messages, {
        maxTokens: config.maxTokens,
        temperature: config.temperature,
      });
      displayText = reply;
      addedTokens = estimateTokens(reply);
      messages.push({ role: "assistant", content: reply });
      call = extractFirstToolCall(reply);
    }

    // Record the assistant turn against the budget before doing anything
    // else so the counter reflects what the API just billed, even if
    // the tool execution below fails later.
    const stillUnderBudget = budget.record(addedTokens);

    // Show the model's thinking + tool call to the user. This is
    // critical for trust: the human sees what the agent intends
    // before any confirmation prompt appears.
    if (displayText.trim().length > 0) {
      process.stderr.write(displayText.trim() + "\n");
    }

    if (!call) {
      // The model declined to call a tool. Politely nudge it once,
      // then bail if it keeps refusing — looping forever on a chatty
      // model wastes the user's quota.
      messages.push({
        role: "user",
        content: useNative
          ? "Please call a tool. If the task is complete, call `finish`."
          : "Please respond with exactly one <tool>...</tool> JSON block. " +
            "If the task is complete, call `finish` with a summary.",
      });
      if (!stillUnderBudget) {
        return summarize("exhausted", "Budget exhausted while the model refused to emit a tool call.", budget);
      }
      continue;
    }

    if (call.tool === "finish") {
      const summary = typeof call.args.summary === "string" ? call.args.summary : "Done.";
      process.stderr.write(`\n[rina-agent] finished: ${summary}\n[rina-agent] ${budget.describe()}\n`);
      return summarize("finished", summary, budget);
    }

    const result = await runTool(call, config);
    appendToolResult(messages, call, result, toolCallId);

    const costStr = formatCost(estimateCost(config.backendSpec, budget.tokens));
    process.stderr.write(
      `[rina-agent] step ${budget.steps}/${config.maxSteps} · ` +
        `${budget.tokens} tok · ${costStr} · ${call.tool} ${result.ok ? "ok" : "ERR"}\n`
    );

    // Snapshot the session after every step so Ctrl-C / crash leaves a
    // usable file for --continue. Saved before we check exhaustion so
    // even the "ran out of budget" state is resumable (raise the cap
    // and pick up where we left off).
    try {
      await saveSession(
        config.workdir,
        buildSnapshot({
          workdir: config.workdir,
          backendSpec: config.backendSpec,
          task: resumedTask,
          messages,
          steps: budget.steps,
          tokens: budget.tokens,
        })
      );
    } catch (saveErr) {
      // Don't kill the agent if the session can't be written (e.g.
      // workdir is read-only). Warn once and continue.
      process.stderr.write(
        `[rina-agent] warn: could not save session — ${(saveErr as Error).message}\n`
      );
    }

    if (!stillUnderBudget) {
      return summarize(
        "exhausted",
        `Budget cap reached (${budget.describe()}). Last tool: ${call.tool}.`,
        budget
      );
    }
  }
}

/**
 * Append the tool result back into the conversation history.
 *
 * Two flavours:
 *  - Prompt-based: a plain `user` message with a `[tool X → ok|error]`
 *    header. Works on every backend regardless of tool-use support.
 *  - Native FC: a `user` message carrying `toolCallId` so the backend
 *    adapter (in backend.ts) can rewrite it to the provider-specific
 *    shape (OpenAI `role: "tool"`, Anthropic `tool_result` block).
 */
function appendToolResult(
  messages: ChatMessage[],
  call: ToolCall,
  result: ToolResult,
  toolCallId?: string
): void {
  const status = result.ok ? "ok" : "error";
  const body =
    result.output.length > 0 ? result.output : result.ok ? "(no output)" : "(empty error)";
  if (toolCallId) {
    messages.push({
      role: "user",
      content: body,
      toolCallId,
    });
  } else {
    messages.push({
      role: "user",
      content: `[tool ${call.tool} → ${status}]\n${body}`,
    });
  }
}

/**
 * Parse the JSON arguments string a native-FC backend returned.
 * Falls back to `{}` on parse failure so the tool dispatcher gets a
 * predictable shape; the tool itself surfaces the "missing required
 * arg" error on the next turn.
 */
function parseToolArgs(json: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function summarize(
  status: AgentResult["status"],
  summary: string,
  budget: Budget
): AgentResult {
  return { status, summary, steps: budget.steps, tokensUsed: budget.tokens };
}
