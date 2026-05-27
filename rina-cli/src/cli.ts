#!/usr/bin/env node
/**
 * RINA AI command-line tool.
 *
 * Pipe-friendly companion to the LSP server: same backends, same
 * prompts, but driven from the shell so it composes with the rest of
 * the Unix toolchain. Useful for:
 *
 *   - one-off questions that don't justify opening an editor:
 *       cat foo.py | rina explain --stdin
 *       rina ask "what does `np.einsum('ij,jk', a, b)` do?"
 *
 *   - scripted batch work:
 *       for f in **\/*.py; do rina tests "$f" -o "test_$(basename $f)"; done
 *
 * The CLI is deliberately small — no subcommand framework, no plugin
 * system. Each verb is ~30 lines of glue around the shared backend
 * abstraction. Pure parsing lives in `args.ts` so tests can exercise
 * it without spawning a subprocess.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { CliArgError, ParsedArgs, guessLanguage, parseArgs } from "./args.js";
import { backendFromSpec, ChatMessage, GenerationConfig } from "./backend.js";
import {
  buildExplainPrompt,
  buildGenerateTestsPrompt,
  buildRefactorPrompt,
  extractCode,
} from "./prompts.js";

// ─────────────────────────────────────────────────────────────────────
// IO helpers
// ─────────────────────────────────────────────────────────────────────

async function readStdin(): Promise<string> {
  // Node hangs on `await process.stdin` if stdin is a TTY (no input).
  // Detecting `isTTY` lets us bail with a useful error instead of
  // freezing the user's terminal.
  if (process.stdin.isTTY) {
    throw new Error(
      "--stdin was passed but nothing is piped in. Try `cat file | rina explain --stdin`."
    );
  }
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Read either a file path or stdin, depending on flags. If a positional
 * argument exists, treat it as a file; otherwise (or with --stdin) read
 * piped input.
 */
async function readInput(args: ParsedArgs): Promise<{ code: string; language: string }> {
  if (args.fromStdin || args.positional.length === 0) {
    const code = await readStdin();
    return { code, language: guessLanguage(undefined) };
  }
  const path = args.positional[0];
  const code = readFileSync(path, "utf8");
  return { code, language: guessLanguage(path) };
}

function writeOutput(args: ParsedArgs, content: string): void {
  if (args.output) {
    writeFileSync(args.output, content, "utf8");
    process.stderr.write(`Wrote ${content.length} bytes to ${args.output}\n`);
  } else {
    process.stdout.write(content);
    if (!content.endsWith("\n")) {
      process.stdout.write("\n");
    }
  }
}

// ─────────────────────────────────────────────────────────────────────
// Command handlers
// ─────────────────────────────────────────────────────────────────────

async function cmdAsk(args: ParsedArgs): Promise<number> {
  const question = args.positional.join(" ").trim();
  if (!question) {
    throw new CliArgError('usage: rina ask "<question>"');
  }
  const backend = backendFromSpec(args.backend);
  const messages: ChatMessage[] = [
    {
      role: "system",
      content:
        args.language === "fr"
          ? "Tu es RINA Coder, un assistant de programmation open-source. Réponds en français, de façon concise et factuelle."
          : "You are RINA Coder, an open-source code assistant. Answer concisely and factually.",
    },
    { role: "user", content: question },
  ];
  const cfg: GenerationConfig = { maxTokens: args.maxTokens, temperature: args.temperature };
  const reply = await backend.generate(messages, cfg);
  writeOutput(args, reply);
  return 0;
}

async function cmdExplain(args: ParsedArgs): Promise<number> {
  const { code, language } = await readInput(args);
  if (!code.trim()) {
    throw new Error("nothing to explain — input was empty.");
  }
  const backend = backendFromSpec(args.backend);
  const messages = buildExplainPrompt({ code, language }, args.language);
  const cfg: GenerationConfig = { maxTokens: args.maxTokens, temperature: args.temperature };
  const reply = await backend.generate(messages, cfg);
  writeOutput(args, reply);
  return 0;
}

async function cmdRefactor(args: ParsedArgs): Promise<number> {
  const { code, language } = await readInput(args);
  if (!code.trim()) {
    throw new Error("nothing to refactor — input was empty.");
  }
  const backend = backendFromSpec(args.backend);
  const messages = buildRefactorPrompt({ code, language }, args.language);
  const cfg: GenerationConfig = { maxTokens: args.maxTokens, temperature: args.temperature };
  const reply = await backend.generate(messages, cfg);
  // The refactor prompt asks for fenced code only; pull the block out
  // so the caller gets pasteable code, not Markdown.
  writeOutput(args, extractCode(reply));
  return 0;
}

async function cmdTests(args: ParsedArgs): Promise<number> {
  const { code, language } = await readInput(args);
  if (!code.trim()) {
    throw new Error("nothing to test — input was empty.");
  }
  const backend = backendFromSpec(args.backend);
  const messages = buildGenerateTestsPrompt({ code, language }, args.language);
  const cfg: GenerationConfig = { maxTokens: args.maxTokens, temperature: args.temperature };
  const reply = await backend.generate(messages, cfg);
  writeOutput(args, extractCode(reply));
  return 0;
}

function cmdHelp(): number {
  process.stdout.write(
    `rina — RINA AI from the shell.\n\n` +
      `USAGE\n` +
      `  rina <command> [options] [arguments]\n\n` +
      `COMMANDS\n` +
      `  ask "<question>"        One-shot chat with the model.\n` +
      `  explain <file>          Explain a file.   --stdin to pipe in.\n` +
      `  refactor <file>         Refactor a file.  --stdin / -o supported.\n` +
      `  tests <file>            Generate tests.   --stdin / -o supported.\n` +
      `  help                    Show this message.\n` +
      `  version                 Print version + Node version.\n\n` +
      `OPTIONS\n` +
      `  --backend SPEC          Provider:model (default: openai:gpt-4o-mini).\n` +
      `                          openai: / anthropic: / mistral: / deepseek: / rina:\n` +
      `  --lang en|fr            System-prompt language (default: en).\n` +
      `  -o, --output FILE       Write to FILE instead of stdout.\n` +
      `  --stdin                 Read input from stdin even when a file path is given.\n` +
      `  --max-tokens N          Response cap (default: 2048).\n` +
      `  --temperature F         Sampling temperature (default: 0.2).\n\n` +
      `ENV\n` +
      `  OPENAI_API_KEY, ANTHROPIC_API_KEY, MISTRAL_API_KEY, DEEPSEEK_API_KEY, RINA_API_KEY\n` +
      `  RINA_BACKEND            Default --backend value.\n` +
      `  RINA_LANG               Default --lang value.\n\n` +
      `EXAMPLES\n` +
      `  rina ask "what's the difference between map and flatMap?"\n` +
      `  cat foo.py | rina explain --stdin\n` +
      `  rina refactor src/legacy.py -o src/legacy.refactored.py\n` +
      `  rina tests src/util.ts --lang fr -o src/util.test.ts\n` +
      `  RINA_BACKEND=anthropic:claude-3-5-haiku-latest rina ask "explain async/await"\n`
  );
  return 0;
}

function cmdVersion(): number {
  // Read version from package.json at runtime. Bundling it would be
  // marginally faster but adds build complexity for no real win.
  //
  // We're compiled to CommonJS (Node16 + no "type": "module" in
  // package.json), so __dirname is available. After `tsc`, this file
  // lives at out/cli.js, so package.json is one directory up.
  let version = "0.0.0";
  try {
    const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8"));
    version = pkg.version ?? version;
  } catch {
    // Best-effort — if anything goes wrong we still print something.
  }
  process.stdout.write(`rina ${version} (node ${process.versions.node})\n`);
  return 0;
}

// ─────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────

async function main(): Promise<number> {
  let args: ParsedArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`rina: ${(err as Error).message}\n`);
    return 2;
  }

  try {
    switch (args.command) {
      case "help":
        return cmdHelp();
      case "version":
        return cmdVersion();
      case "ask":
        return await cmdAsk(args);
      case "explain":
        return await cmdExplain(args);
      case "refactor":
        return await cmdRefactor(args);
      case "tests":
        return await cmdTests(args);
    }
  } catch (err) {
    process.stderr.write(`rina: ${(err as Error).message}\n`);
    return err instanceof CliArgError ? 2 : 1;
  }
}

// Only invoke main() when this file is the entrypoint. Without this
// guard, importing cli.ts from tests would fire the network calls.
//
// With `tsconfig.module = "Node16"` + no `"type": "module"` in
// package.json, this file compiles to CommonJS — so `require.main`
// and `module` are both available. We compare them to detect direct
// execution. The (module as any) keeps TS happy in strict mode.
if (typeof require !== "undefined" && require.main === module) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`rina: ${(err as Error).message}\n`);
      process.exit(1);
    }
  );
}
