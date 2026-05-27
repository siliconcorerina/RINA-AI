#!/usr/bin/env node
/**
 * `rina-agent` command-line entry point.
 *
 * Minimal argument parser — no commander/yargs because the surface is
 * tiny and we'd rather have one file the user can `cat` to understand
 * everything the binary does.
 *
 * Usage:
 *
 *   rina-agent "add a /health route to my Express server"
 *   rina-agent --workdir ./my-project --max-steps 40 "refactor utils.ts to use async/await"
 *   echo "find and fix the bug in handler.py" | rina-agent --stdin
 *   rina-agent --read-only "explain the architecture of this codebase"
 *
 * Defaults are tuned for "first-time user, smallest possible blast
 * radius": interactive confirmation on, read access only outside the
 * workdir denied, 25-step ceiling, 100k-token budget.
 */

import { resolve, join } from "node:path";
import { readFileSync } from "node:fs";

import { runAgent } from "./agent.js";
import type { AgentConfig } from "./types.js";

interface ParsedArgs {
  task: string;
  backend: string;
  workdir: string;
  maxSteps: number;
  tokenBudget: number;
  yolo: boolean;
  readOnly: boolean;
  language: "en" | "fr";
  maxTokens: number;
  temperature: number;
  fromStdin: boolean;
  showHelp: boolean;
  showVersion: boolean;
}

const DEFAULTS = {
  backend: process.env.RINA_BACKEND ?? "openai:gpt-4o-mini",
  language: (process.env.RINA_LANG === "fr" ? "fr" : "en") as "en" | "fr",
  maxSteps: 25,
  tokenBudget: 100_000,
  maxTokens: 2048,
  temperature: 0.2,
};

class CliArgError extends Error {}

function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = {
    task: "",
    backend: DEFAULTS.backend,
    workdir: process.cwd(),
    maxSteps: DEFAULTS.maxSteps,
    tokenBudget: DEFAULTS.tokenBudget,
    yolo: false,
    readOnly: false,
    language: DEFAULTS.language,
    maxTokens: DEFAULTS.maxTokens,
    temperature: DEFAULTS.temperature,
    fromStdin: false,
    showHelp: false,
    showVersion: false,
  };

  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const nextValue = (): string => {
      const v = argv[++i];
      if (v === undefined) {
        throw new CliArgError(`Missing value for ${a}`);
      }
      return v;
    };
    switch (a) {
      case "-h":
      case "--help":
        out.showHelp = true;
        break;
      case "-v":
      case "--version":
        out.showVersion = true;
        break;
      case "--backend":
        out.backend = nextValue();
        break;
      case "--lang":
      case "--language": {
        const v = nextValue();
        if (v !== "en" && v !== "fr") {
          throw new CliArgError(`--lang must be 'en' or 'fr' (got '${v}')`);
        }
        out.language = v;
        break;
      }
      case "--workdir":
      case "-C":
        out.workdir = resolve(nextValue());
        break;
      case "--max-steps":
        out.maxSteps = parsePositiveInt(nextValue(), "--max-steps");
        break;
      case "--budget":
      case "--token-budget":
        out.tokenBudget = parsePositiveInt(nextValue(), "--budget");
        break;
      case "--max-tokens":
        out.maxTokens = parsePositiveInt(nextValue(), "--max-tokens");
        break;
      case "--temperature":
        out.temperature = parseFloatArg(nextValue(), "--temperature");
        break;
      case "--yolo":
        out.yolo = true;
        break;
      case "--read-only":
        out.readOnly = true;
        break;
      case "--stdin":
        out.fromStdin = true;
        break;
      default:
        if (a.startsWith("-")) {
          throw new CliArgError(`Unknown option: ${a}`);
        }
        positional.push(a);
    }
  }
  out.task = positional.join(" ").trim();
  return out;
}

function parsePositiveInt(raw: string, name: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new CliArgError(`${name} must be a positive integer (got '${raw}')`);
  }
  return n;
}

function parseFloatArg(raw: string, name: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    throw new CliArgError(`${name} must be a number (got '${raw}')`);
  }
  return n;
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) {
    throw new CliArgError("--stdin was passed but nothing is piped in.");
  }
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function printHelp(): void {
  process.stdout.write(
    `rina-agent — Autonomous shell agent for RINA AI.\n\n` +
      `USAGE\n` +
      `  rina-agent [options] "<task description>"\n` +
      `  echo "<task>" | rina-agent --stdin [options]\n\n` +
      `OPTIONS\n` +
      `  --backend SPEC          Provider:model (default: ${DEFAULTS.backend}).\n` +
      `                          openai: / anthropic: / mistral: / deepseek: / rina:\n` +
      `  --workdir, -C DIR       Working directory the agent is scoped to (default: cwd).\n` +
      `  --lang en|fr            System-prompt language (default: ${DEFAULTS.language}).\n` +
      `  --max-steps N           Stop after N tool calls (default: ${DEFAULTS.maxSteps}).\n` +
      `  --budget N              Stop once N response tokens consumed (default: ${DEFAULTS.tokenBudget}).\n` +
      `  --max-tokens N          Per-call response cap (default: ${DEFAULTS.maxTokens}).\n` +
      `  --temperature F         Sampling temperature (default: ${DEFAULTS.temperature}).\n` +
      `  --yolo                  Skip interactive confirmation. Use with care.\n` +
      `  --read-only             Reject every write_file / shell tool call.\n` +
      `  --stdin                 Read the task description from stdin.\n` +
      `  --help, -h              Show this message.\n` +
      `  --version, -v           Print version + Node version.\n\n` +
      `ENV\n` +
      `  OPENAI_API_KEY, ANTHROPIC_API_KEY, MISTRAL_API_KEY, DEEPSEEK_API_KEY, RINA_API_KEY\n` +
      `  RINA_BACKEND            Default --backend value.\n` +
      `  RINA_LANG               Default --lang value.\n\n` +
      `SAFETY\n` +
      `  Every shell command and file write asks for your confirmation by default.\n` +
      `  A blacklist of always-blocked commands (rm -rf /, sudo, dd, mkfs, ...) is\n` +
      `  enforced even with --yolo. The agent cannot read or write outside --workdir.\n\n` +
      `EXAMPLES\n` +
      `  rina-agent "add a /health endpoint to server.ts that returns 200 OK"\n` +
      `  rina-agent --workdir ./my-repo --lang fr "ajoute des tests unitaires pour utils.py"\n` +
      `  rina-agent --read-only "explain the architecture of this codebase"\n` +
      `  rina-agent --backend deepseek:deepseek-reasoner --max-steps 40 "fix the failing test"\n`
  );
}

function printVersion(): void {
  // CommonJS build → __dirname is available. out/cli.js → out/../package.json
  const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8")) as {
    version: string;
  };
  process.stdout.write(`rina-agent ${pkg.version} (node ${process.versions.node})\n`);
}

export async function main(argv: string[]): Promise<number> {
  let args: ParsedArgs;
  try {
    args = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`rina-agent: ${(err as Error).message}\n`);
    return 2;
  }

  if (args.showHelp) {
    printHelp();
    return 0;
  }
  if (args.showVersion) {
    printVersion();
    return 0;
  }

  let task = args.task;
  if (args.fromStdin) {
    task = (await readStdin()).trim();
  }
  if (!task) {
    process.stderr.write(`rina-agent: missing task. Try --help.\n`);
    return 2;
  }

  const config: AgentConfig = {
    backendSpec: args.backend,
    workdir: args.workdir,
    maxSteps: args.maxSteps,
    tokenBudget: args.tokenBudget,
    yolo: args.yolo,
    readOnly: args.readOnly,
    language: args.language,
    maxTokens: args.maxTokens,
    temperature: args.temperature,
  };

  try {
    const result = await runAgent(task, config);
    return result.status === "finished" ? 0 : 1;
  } catch (err) {
    process.stderr.write(`rina-agent: ${(err as Error).message}\n`);
    return 1;
  }
}

// Only invoke main() when this file is the entry point. Without this
// guard, importing cli.ts from tests would fire the agent loop.
// With tsconfig.module = "Node16" + no "type": "module" in package.json,
// this compiles to CommonJS — so `require.main` and `module` are both
// available and detect direct execution.
if (typeof require !== "undefined" && require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`rina-agent: ${(err as Error).message}\n`);
      process.exit(1);
    }
  );
}
