/**
 * Pure argument-parsing helpers for the CLI.
 *
 * Lives in its own module (no side effects, no IO at import time) so
 * unit tests can exercise `parseArgs` and `guessLanguage` without
 * running `main()`. Same pattern as `config.ts` in the LSP server.
 */

import type { Language } from "./prompts.js";

export type CliCommand = "ask" | "explain" | "refactor" | "tests" | "help" | "version";

export interface ParsedArgs {
  command: CliCommand;
  positional: string[];
  backend: string;
  language: Language;
  output?: string;
  fromStdin: boolean;
  maxTokens: number;
  temperature: number;
}

export interface DefaultsOverride {
  backend?: string;
  language?: Language;
  maxTokens?: number;
  temperature?: number;
}

/**
 * Build the defaults block. Reads from process.env at *call time*
 * (not at module load) so tests can mutate env in `beforeEach` and
 * see the change.
 */
export function defaults(env: NodeJS.ProcessEnv = process.env): DefaultsOverride {
  return {
    backend: env.RINA_BACKEND || "openai:gpt-4o-mini",
    language: (env.RINA_LANG === "fr" ? "fr" : "en") as Language,
    maxTokens: 2048,
    temperature: 0.2,
  };
}

/**
 * Argv parser. Accepts the argv tail (everything past `node ./cli.js`).
 *
 * Throws on bad input — callers turn that into a `process.exit(2)`
 * with a friendly message. Tests catch the throw and inspect it.
 */
export function parseArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): ParsedArgs {
  const d = defaults(env);
  const positional: string[] = [];
  const args: ParsedArgs = {
    command: "help",
    positional,
    backend: d.backend!,
    language: d.language!,
    fromStdin: false,
    maxTokens: d.maxTokens!,
    temperature: d.temperature!,
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "-h":
      case "--help":
        args.command = "help";
        return args;
      case "-v":
      case "--version":
        args.command = "version";
        return args;
      case "--backend":
        args.backend = requireValue(argv, ++i, "--backend");
        break;
      case "--lang":
      case "--language": {
        const v = requireValue(argv, ++i, "--lang");
        if (v !== "en" && v !== "fr") {
          throw new CliArgError(`--lang must be 'en' or 'fr' (got '${v}')`);
        }
        args.language = v;
        break;
      }
      case "-o":
      case "--output":
        args.output = requireValue(argv, ++i, "--output");
        break;
      case "--stdin":
        args.fromStdin = true;
        break;
      case "--max-tokens": {
        const v = parseInt(requireValue(argv, ++i, "--max-tokens"), 10);
        if (!Number.isFinite(v) || v <= 0) {
          throw new CliArgError(`--max-tokens must be a positive integer`);
        }
        args.maxTokens = v;
        break;
      }
      case "--temperature": {
        const v = parseFloat(requireValue(argv, ++i, "--temperature"));
        if (!Number.isFinite(v) || v < 0) {
          throw new CliArgError(`--temperature must be a non-negative number`);
        }
        args.temperature = v;
        break;
      }
      default:
        positional.push(a);
    }
  }

  const verb = positional.shift();
  switch (verb) {
    case undefined:
      args.command = "help";
      break;
    case "ask":
    case "explain":
    case "refactor":
    case "tests":
    case "help":
    case "version":
      args.command = verb;
      break;
    default:
      throw new CliArgError(`Unknown command '${verb}'. Run 'rina --help' for usage.`);
  }
  return args;
}

function requireValue(argv: string[], i: number, flag: string): string {
  if (i >= argv.length) {
    throw new CliArgError(`${flag} requires a value.`);
  }
  return argv[i];
}

export class CliArgError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliArgError";
  }
}

/**
 * Map a file extension to an LSP-style language identifier so prompts
 * carry meaningful context to the model.
 */
export function guessLanguage(path: string | undefined): string {
  if (!path) {
    return "text";
  }
  const lower = path.toLowerCase();
  for (const [ext, lang] of LANGUAGE_MAP) {
    if (lower.endsWith(ext)) {
      return lang;
    }
  }
  return "text";
}

const LANGUAGE_MAP: ReadonlyArray<[string, string]> = [
  [".py", "python"],
  [".ts", "typescript"],
  [".tsx", "typescript"],
  [".js", "javascript"],
  [".jsx", "javascript"],
  [".rs", "rust"],
  [".go", "go"],
  [".java", "java"],
  [".kt", "kotlin"],
  [".cpp", "cpp"],
  [".cc", "cpp"],
  [".c", "c"],
  [".h", "c"],
  [".rb", "ruby"],
  [".php", "php"],
  [".lua", "lua"],
  [".sh", "shellscript"],
  [".sql", "sql"],
];
