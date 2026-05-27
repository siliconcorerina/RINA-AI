#!/usr/bin/env node
/**
 * `rina-bot` command-line entry point.
 *
 * Tiny argv parser (no commander/yargs) — see the rina-cli rationale.
 *
 * Usage:
 *
 *   rina-bot start                    # foreground; Ctrl-C to stop
 *   rina-bot --help                   # this message
 *   rina-bot --version                # 0.1.0
 *
 * Environment:
 *
 *   TELEGRAM_BOT_TOKEN          (required) Bot token from @BotFather
 *   TELEGRAM_ALLOWED_USER_IDS   (recommended) comma-separated user ids
 *
 *   DEEPSEEK_API_KEY            (or OPENAI_/ANTHROPIC_/MISTRAL_) — model auth
 *   RINA_BACKEND                Default backend spec, e.g. deepseek:deepseek-chat
 *   RINA_LANG                   `en` or `fr`
 */

import { readFileSync } from "node:fs";
import { resolve, join } from "node:path";

import { TelegramAdapter } from "./channels/telegram.js";
import { BotBrain } from "./bot.js";
import type { BotConfig } from "./types.js";

const DEFAULTS = {
  backend: process.env.RINA_BACKEND ?? "deepseek:deepseek-chat",
  language: (process.env.RINA_LANG === "fr" ? "fr" : "en") as "en" | "fr",
  maxSteps: 10,
  tokenBudget: 50_000,
};

interface ParsedArgs {
  command: "start" | "help" | "version" | "";
  backend: string;
  workdir: string;
  language: "en" | "fr";
  allowWrites: boolean;
}

class CliArgError extends Error {}

function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = {
    command: "",
    backend: DEFAULTS.backend,
    workdir: process.cwd(),
    language: DEFAULTS.language,
    allowWrites: false,
  };
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
      case "start":
        out.command = "start";
        break;
      case "help":
      case "-h":
      case "--help":
        out.command = "help";
        break;
      case "version":
      case "-v":
      case "--version":
        out.command = "version";
        break;
      case "--backend":
        out.backend = nextValue();
        break;
      case "--workdir":
      case "-C":
        out.workdir = resolve(nextValue());
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
      case "--allow-writes":
        out.allowWrites = true;
        break;
      default:
        if (a.startsWith("-")) {
          throw new CliArgError(`Unknown option: ${a}`);
        }
        if (!out.command) {
          out.command = "help";
        }
    }
  }
  return out;
}

function printHelp(): void {
  process.stdout.write(
    `rina-bot — RINA AI as a chat bot.\n\n` +
      `USAGE\n` +
      `  rina-bot start [options]      Run the bot in the foreground until Ctrl-C.\n` +
      `  rina-bot --help               Show this message.\n` +
      `  rina-bot --version            Print version + Node version.\n\n` +
      `OPTIONS\n` +
      `  --backend SPEC                Provider:model (default: ${DEFAULTS.backend}).\n` +
      `                                openai: / anthropic: / mistral: / deepseek: / rina:\n` +
      `  --workdir, -C DIR             Working directory the agent is scoped to.\n` +
      `  --lang en|fr                  Reply language (default: ${DEFAULTS.language}).\n` +
      `  --allow-writes                Enable write_file / edit_file / shell tools (dangerous).\n\n` +
      `ENVIRONMENT\n` +
      `  TELEGRAM_BOT_TOKEN            (required) Get one from @BotFather on Telegram.\n` +
      `  TELEGRAM_ALLOWED_USER_IDS     Comma-separated user ids that may DM the bot.\n` +
      `                                Get your id from @userinfobot. Empty = anyone (unsafe).\n\n` +
      `  OPENAI_API_KEY, ANTHROPIC_API_KEY, MISTRAL_API_KEY, DEEPSEEK_API_KEY, RINA_API_KEY\n` +
      `  RINA_BACKEND                  Default backend spec.\n` +
      `  RINA_LANG                     Default language.\n\n` +
      `QUICK START\n` +
      `  # 1. Talk to @BotFather on Telegram, /newbot, get the token.\n` +
      `  # 2. Talk to @userinfobot on Telegram, get YOUR user id.\n` +
      `  # 3. Set env vars and run:\n` +
      `  export TELEGRAM_BOT_TOKEN=123456:ABC...\n` +
      `  export TELEGRAM_ALLOWED_USER_IDS=12345678\n` +
      `  export DEEPSEEK_API_KEY=sk-...\n` +
      `  rina-bot start\n\n` +
      `  # 4. DM your bot on Telegram. It will answer.\n`
  );
}

function printVersion(): void {
  const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8")) as {
    version: string;
  };
  process.stdout.write(`rina-bot ${pkg.version} (node ${process.versions.node})\n`);
}

async function startBot(args: ParsedArgs): Promise<number> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    process.stderr.write(
      `rina-bot: TELEGRAM_BOT_TOKEN env var is required. Get one from @BotFather, then:\n` +
        `  $env:TELEGRAM_BOT_TOKEN = "123456:ABC..."   # PowerShell\n` +
        `  export TELEGRAM_BOT_TOKEN=123456:ABC...     # bash/zsh\n`
    );
    return 2;
  }

  const allowed = parseAllowlist(process.env.TELEGRAM_ALLOWED_USER_IDS ?? "");

  const config: BotConfig = {
    backendSpec: args.backend,
    workdir: args.workdir,
    maxSteps: DEFAULTS.maxSteps,
    tokenBudget: DEFAULTS.tokenBudget,
    language: args.language,
    allowedUserIds: allowed,
    allowWrites: args.allowWrites,
  };

  const channel = new TelegramAdapter(token);
  const bot = new BotBrain(channel, config);

  // Graceful shutdown — Ctrl-C / SIGTERM stop the poll loop and exit
  // cleanly so the user doesn't get a stack trace just because they
  // wanted to stop the bot.
  const shutdown = (signal: string) => {
    process.stderr.write(`\n[rina-bot] received ${signal}, stopping…\n`);
    channel.stop();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  await bot.run();
  return 0;
}

export function parseAllowlist(raw: string): Set<string> {
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
  );
}

export async function main(argv: string[]): Promise<number> {
  let args: ParsedArgs;
  try {
    args = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`rina-bot: ${(err as Error).message}\n`);
    return 2;
  }

  switch (args.command) {
    case "help":
    case "":
      printHelp();
      return 0;
    case "version":
      printVersion();
      return 0;
    case "start":
      return startBot(args);
  }
}

// Only run main() when this file is the entry point.
if (typeof require !== "undefined" && require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`rina-bot: ${(err as Error).message}\n`);
      process.exit(1);
    }
  );
}
