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
import { runTool } from "./tools.js";
import { Budget } from "./safety.js";
import { estimateCost, formatCost } from "./pricing.js";
import type { AgentConfig, AgentResult, ToolCall, ToolResult } from "./types.js";

/**
 * Run the agent on a single task description until it finishes or runs
 * out of budget. Returns a structured `AgentResult` rather than throwing
 * so the CLI can render a clean end-of-run summary.
 */
export async function runAgent(task: string, config: AgentConfig): Promise<AgentResult> {
  const backend = backendFromSpec(config.backendSpec);
  const budget = new Budget(config.maxSteps, config.tokenBudget);

  const messages: ChatMessage[] = [
    { role: "system", content: buildSystemPrompt(config.language) },
    { role: "user", content: task },
  ];

  // We print a small banner so the user sees what's happening in real
  // time — the agent loop is otherwise silent until tools fire.
  process.stderr.write(
    `\n[rina-agent] backend=${config.backendSpec} workdir=${config.workdir} ` +
      `max-steps=${config.maxSteps} ${config.yolo ? "yolo " : ""}` +
      `${config.readOnly ? "read-only " : ""}\n\n`
  );

  while (true) {
    // Ask the model what to do next.
    const reply = await backend.generate(messages, {
      maxTokens: config.maxTokens,
      temperature: config.temperature,
    });
    const addedTokens = estimateTokens(reply);

    // Record the assistant turn before doing anything else so the
    // budget reflects what the API just billed us for, even if the
    // tool execution below fails later.
    const stillUnderBudget = budget.record(addedTokens);
    messages.push({ role: "assistant", content: reply });

    // Show the model's thinking + tool call to the user. This is
    // critical for trust: the human sees what the agent intends
    // before any confirmation prompt appears.
    process.stderr.write(reply.trim() + "\n");

    const call = extractFirstToolCall(reply);
    if (!call) {
      // The model declined to call a tool. Politely nudge it once,
      // then bail if it keeps refusing — looping forever on a chatty
      // model wastes the user's quota.
      messages.push({
        role: "user",
        content:
          "Please respond with exactly one <tool>...</tool> JSON block. " +
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
    appendToolResult(messages, call, result);

    const costStr = formatCost(estimateCost(config.backendSpec, budget.tokens));
    process.stderr.write(
      `[rina-agent] step ${budget.steps}/${config.maxSteps} · ` +
        `${budget.tokens} tok · ${costStr} · ${call.tool} ${result.ok ? "ok" : "ERR"}\n`
    );

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
 * We send it as a `user` message rather than the more semantically
 * correct `tool` role because not every backend supports the latter
 * (Anthropic does, OpenAI does, Mistral's older endpoint doesn't).
 * A `user` message with a clear header works across all four.
 */
function appendToolResult(messages: ChatMessage[], call: ToolCall, result: ToolResult): void {
  const status = result.ok ? "ok" : "error";
  const body =
    result.output.length > 0 ? result.output : result.ok ? "(no output)" : "(empty error)";
  messages.push({
    role: "user",
    content: `[tool ${call.tool} → ${status}]\n${body}`,
  });
}

function summarize(
  status: AgentResult["status"],
  summary: string,
  budget: Budget
): AgentResult {
  return { status, summary, steps: budget.steps, tokensUsed: budget.tokens };
}
