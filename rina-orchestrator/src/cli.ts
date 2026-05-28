#!/usr/bin/env node
/**
 * `rina-orchestrator <goal>` — runs the agentic loop end-to-end and
 * prints a live trace to the terminal.
 *
 * Flags:
 *   --backend <spec>   provider:model (default deepseek:deepseek-chat)
 *   --headed           Open a visible Chromium window (useful for
 *                      development; default is headless).
 *   --max-steps <N>    Cap on planner step count (default 6).
 *   --json             Emit JSON events on stdout instead of the
 *                      pretty trace. One event per line (NDJSON) so
 *                      pipes/scripts can consume it.
 *
 * Env:
 *   <PROVIDER>_API_KEY — DEEPSEEK_API_KEY, OPENAI_API_KEY, etc.
 *
 * Exit codes:
 *   0  run completed successfully
 *   1  planner failed (couldn't decompose the goal)
 *   2  a step failed during execution
 *   3  invalid CLI arguments
 */

import { backendFromSpec } from "@siliconcorerina/rina-agent/out/backend.js";

import { runGoal, RunFailedError } from "./core/orchestrator.js";
import type { AgentEvent } from "./core/types.js";

interface CliArgs {
  goal: string;
  backendSpec: string;
  headed: boolean;
  maxSteps: number;
  json: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    goal: "",
    backendSpec: "deepseek:deepseek-chat",
    headed: false,
    maxSteps: 6,
    json: false,
  };
  const positional: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--backend") {
      const v = argv[++i];
      if (!v) usage("Missing value for --backend");
      args.backendSpec = v!;
    } else if (a === "--headed") {
      args.headed = true;
    } else if (a === "--max-steps") {
      const v = argv[++i];
      if (!v) usage("Missing value for --max-steps");
      const n = Number(v);
      if (!Number.isFinite(n) || n < 1 || n > 12) {
        usage("--max-steps must be 1..12");
      }
      args.maxSteps = n;
    } else if (a === "--json") {
      args.json = true;
    } else if (a === "--help" || a === "-h") {
      usage(null);
    } else if (a && a.startsWith("--")) {
      usage(`Unknown flag '${a}'`);
    } else if (a !== undefined) {
      positional.push(a);
    }
  }

  if (positional.length === 0) usage("Missing goal argument");
  args.goal = positional.join(" ");
  return args;
}

function usage(reason: string | null): never {
  const text = `
rina-orchestrator <goal> [options]

Run a multi-agent task: a planner decomposes the goal into atomic
steps, then specialised sub-agents (currently: browser) execute them.

Options:
  --backend <spec>     Provider:model. Default: deepseek:deepseek-chat
                       Supported: openai, anthropic, mistral, deepseek, rina
  --headed             Open a visible browser window (default headless)
  --max-steps <N>      Cap on planner step count (1..12, default 6)
  --json               Emit NDJSON events on stdout (for piping)
  -h, --help           Show this help

Env:
  <PROVIDER>_API_KEY   e.g. DEEPSEEK_API_KEY, OPENAI_API_KEY

Example:
  rina-orchestrator "Cherche les 3 derniers communiqués de presse de RINA AI"
  rina-orchestrator --headed --backend anthropic:claude-3-5-sonnet-latest \\
    "Trouve le prix du Bitcoin sur coingecko.com et donne-le-moi"
`.trim();

  if (reason) {
    process.stderr.write(`Error: ${reason}\n\n${text}\n`);
    process.exit(3);
  }
  process.stdout.write(`${text}\n`);
  process.exit(0);
}

function renderEvent(e: AgentEvent): string {
  switch (e.type) {
    case "plan_created": {
      const lines = e.plan.steps.map(
        (s, i) => `  ${i + 1}. [${s.kind}] ${s.description}`
      );
      return `\n📋 Plan (${e.plan.steps.length} étapes):\n${lines.join("\n")}\n`;
    }
    case "step_started":
      return `\n▶ Étape ${e.stepId}…`;
    case "step_progress":
      return `   ${e.message}`;
    case "step_completed":
      return `✓ Étape ${e.stepId} (${e.rounds} tour${e.rounds > 1 ? "s" : ""}): ${truncate(e.result, 200)}`;
    case "step_failed":
      return `✗ Étape ${e.stepId} a échoué: ${e.error}`;
    case "run_completed":
      return `\n🎉 Terminé.\n\nRésultat:\n${e.summary}\n`;
    case "run_failed":
      return `\n💥 Run échoué: ${e.error}\n`;
  }
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n) + "…";
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  let backend;
  try {
    backend = backendFromSpec(args.backendSpec);
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    process.exit(3);
  }

  const onEvent = (e: AgentEvent) => {
    if (args.json) {
      process.stdout.write(JSON.stringify(e) + "\n");
    } else {
      process.stdout.write(renderEvent(e) + "\n");
    }
  };

  try {
    await runGoal(backend, args.goal, {
      onEvent,
      browser: { headless: !args.headed },
      maxSteps: args.maxSteps,
    });
    process.exit(0);
  } catch (err) {
    if (err instanceof RunFailedError) {
      // Event log already streamed the failure — exit with the
      // appropriate code. step_failed → 2, planner failed → 1.
      const lastFail = err.events.reverse().find((e) => e.type === "step_failed");
      process.exit(lastFail ? 2 : 1);
    }
    process.stderr.write(`Fatal: ${(err as Error).message}\n`);
    process.exit(1);
  }
}

main().catch((err) => {
  process.stderr.write(`Unhandled: ${(err as Error).stack ?? err}\n`);
  process.exit(1);
});
