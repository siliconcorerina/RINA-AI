/**
 * Tests for the CLI argument parser.
 *
 * Pure functions — no IO, no env mutation needed. The parser must be
 * defensive against bad input (we get arbitrary user shell input)
 * without freezing or producing confusing TypeScript types.
 */

import { describe, expect, test } from "vitest";
import { CliArgError, guessLanguage, parseArgs } from "../src/args.js";

describe("parseArgs — verbs", () => {
  test("empty argv → help", () => {
    expect(parseArgs([]).command).toBe("help");
  });

  test("-h short flag → help", () => {
    expect(parseArgs(["-h"]).command).toBe("help");
  });

  test("--help wins over a verb that follows", () => {
    // The user wanted help — don't accidentally fire `ask` instead.
    expect(parseArgs(["--help", "ask", "stuff"]).command).toBe("help");
  });

  test("--version short circuits like --help", () => {
    expect(parseArgs(["--version"]).command).toBe("version");
    expect(parseArgs(["-v"]).command).toBe("version");
  });

  test.each(["ask", "explain", "refactor", "tests"] as const)("recognises `%s`", (verb) => {
    expect(parseArgs([verb]).command).toBe(verb);
  });

  test("unknown verb throws CliArgError", () => {
    expect(() => parseArgs(["frobnicate"])).toThrow(CliArgError);
    expect(() => parseArgs(["frobnicate"])).toThrow(/Unknown command 'frobnicate'/);
  });
});

describe("parseArgs — positional vs flag interleaving", () => {
  test("flags before verb still work", () => {
    const a = parseArgs(["--backend", "anthropic:claude-3-5-haiku-latest", "ask", "hello"]);
    expect(a.command).toBe("ask");
    expect(a.backend).toBe("anthropic:claude-3-5-haiku-latest");
    expect(a.positional).toEqual(["hello"]);
  });

  test("flags after verb still work", () => {
    const a = parseArgs(["explain", "foo.py", "--backend", "mistral:codestral-latest"]);
    expect(a.command).toBe("explain");
    expect(a.backend).toBe("mistral:codestral-latest");
    expect(a.positional).toEqual(["foo.py"]);
  });

  test("multi-word ask question keeps all positionals", () => {
    const a = parseArgs(["ask", "what", "is", "rust"]);
    expect(a.positional).toEqual(["what", "is", "rust"]);
  });
});

describe("parseArgs — options", () => {
  test("--lang fr / en", () => {
    expect(parseArgs(["--lang", "fr", "ask"]).language).toBe("fr");
    expect(parseArgs(["--language", "en", "ask"]).language).toBe("en");
  });

  test("--lang with bogus value throws", () => {
    expect(() => parseArgs(["--lang", "klingon", "ask"])).toThrow(/--lang must be 'en' or 'fr'/);
  });

  test("-o / --output capture the value", () => {
    expect(parseArgs(["refactor", "x.py", "-o", "y.py"]).output).toBe("y.py");
    expect(parseArgs(["refactor", "x.py", "--output", "y.py"]).output).toBe("y.py");
  });

  test("--stdin sets the flag", () => {
    expect(parseArgs(["explain", "--stdin"]).fromStdin).toBe(true);
  });

  test("flag missing a required value throws", () => {
    expect(() => parseArgs(["--backend"])).toThrow(/--backend requires a value/);
    expect(() => parseArgs(["explain", "--output"])).toThrow(/--output requires a value/);
  });

  test("--max-tokens rejects non-positive integers", () => {
    expect(() => parseArgs(["ask", "--max-tokens", "0"])).toThrow(/positive integer/);
    expect(() => parseArgs(["ask", "--max-tokens", "abc"])).toThrow(/positive integer/);
  });

  test("--temperature rejects negative or NaN values", () => {
    expect(() => parseArgs(["ask", "--temperature", "-1"])).toThrow(/non-negative/);
    expect(() => parseArgs(["ask", "--temperature", "warm"])).toThrow(/non-negative/);
    // 0 should be allowed — it's a valid sampling temperature.
    expect(parseArgs(["ask", "--temperature", "0"]).temperature).toBe(0);
  });
});

describe("parseArgs — env-driven defaults", () => {
  test("RINA_BACKEND env overrides the built-in default", () => {
    const a = parseArgs(["ask"], { RINA_BACKEND: "anthropic:claude-3-5-haiku-latest" });
    expect(a.backend).toBe("anthropic:claude-3-5-haiku-latest");
  });

  test("explicit --backend wins over env", () => {
    const a = parseArgs(["--backend", "mistral:codestral-latest", "ask"], {
      RINA_BACKEND: "openai:gpt-4o",
    });
    expect(a.backend).toBe("mistral:codestral-latest");
  });

  test("RINA_LANG=fr sets default language", () => {
    expect(parseArgs(["ask"], { RINA_LANG: "fr" }).language).toBe("fr");
  });

  test("RINA_LANG with non-fr value falls back to en", () => {
    // We don't want a typo'd env var to silently break the prompt
    // lookup — defaulting to 'en' is the safe behaviour.
    expect(parseArgs(["ask"], { RINA_LANG: "fre" }).language).toBe("en");
  });
});

describe("guessLanguage", () => {
  test.each([
    ["foo.py", "python"],
    ["foo.ts", "typescript"],
    ["foo.tsx", "typescript"],
    ["foo.rs", "rust"],
    ["foo.go", "go"],
    ["foo.java", "java"],
    ["foo.kt", "kotlin"],
    ["src/util/helper.cpp", "cpp"],
    ["script.SH", "shellscript"], // case-insensitive
  ])("maps %s → %s", (path, expected) => {
    expect(guessLanguage(path)).toBe(expected);
  });

  test("unknown extension falls back to text", () => {
    expect(guessLanguage("foo.xyz")).toBe("text");
    expect(guessLanguage("Makefile")).toBe("text");
  });

  test("undefined path returns text", () => {
    expect(guessLanguage(undefined)).toBe("text");
  });

  test("strip-able .gz / .bak surface their underlying extension", () => {
    // We don't try to handle compound extensions — `endsWith` would
    // see `.gz` and fall back to text. That's the documented behaviour;
    // this test pins it so a future "smart" tweak doesn't break callers.
    expect(guessLanguage("data.py.bak")).toBe("text");
  });
});
