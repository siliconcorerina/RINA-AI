/**
 * Tests for the <tool>...</tool> extractor.
 *
 * These are the most important deterministic tests in the agent — every
 * tool call the model emits has to survive this parser. Regressions
 * here cause silent infinite loops in production.
 */

import { describe, expect, test } from "vitest";
import { extractFirstToolCall, estimateTokens } from "../src/parse.js";

describe("extractFirstToolCall — happy path", () => {
  test("parses a basic list_files call", () => {
    const r = extractFirstToolCall('<tool>{"tool":"list_files","args":{"dir":"."}}</tool>');
    expect(r).toEqual({ tool: "list_files", args: { dir: "." } });
  });

  test("parses across multiple lines", () => {
    const r = extractFirstToolCall(`I should look at the file first.

<tool>
{
  "tool": "read_file",
  "args": { "path": "src/index.ts" }
}
</tool>`);
    expect(r?.tool).toBe("read_file");
    expect(r?.args.path).toBe("src/index.ts");
  });

  test("accepts a finish call with summary", () => {
    const r = extractFirstToolCall(
      '<tool>{"tool":"finish","args":{"summary":"Added the /health route."}}</tool>'
    );
    expect(r).toEqual({ tool: "finish", args: { summary: "Added the /health route." } });
  });

  test("returns only the FIRST tool block when several are emitted", () => {
    const r = extractFirstToolCall(
      '<tool>{"tool":"list_files","args":{"dir":"src"}}</tool>\n' +
        '<tool>{"tool":"finish","args":{"summary":"hi"}}</tool>'
    );
    expect(r?.tool).toBe("list_files");
  });
});

describe("extractFirstToolCall — tolerance", () => {
  test("recovers from a trailing-comma JSON typo", () => {
    const r = extractFirstToolCall(
      '<tool>{"tool":"read_file","args":{"path":"a.py",}}</tool>'
    );
    expect(r?.tool).toBe("read_file");
  });

  test("ignores stray text around the tool block", () => {
    const r = extractFirstToolCall(
      'Thinking out loud here... <tool>{"tool":"list_files","args":{}}</tool> done.'
    );
    expect(r?.tool).toBe("list_files");
  });
});

describe("extractFirstToolCall — rejection", () => {
  test("returns null on plain prose", () => {
    expect(extractFirstToolCall("I would call list_files but I forgot the tags.")).toBeNull();
  });

  test("returns null on unknown tool name", () => {
    expect(
      extractFirstToolCall('<tool>{"tool":"hack_planet","args":{}}</tool>')
    ).toBeNull();
  });

  test("returns null when args is a string instead of object", () => {
    expect(
      extractFirstToolCall('<tool>{"tool":"shell","args":"ls"}</tool>')
    ).toBeNull();
  });

  test("returns null when JSON is unrecoverable", () => {
    expect(
      extractFirstToolCall("<tool>{tool: list_files, args: {}}</tool>")
    ).toBeNull();
  });
});

describe("estimateTokens", () => {
  test("returns 0 for empty string", () => {
    expect(estimateTokens("")).toBe(0);
  });

  test("scales roughly with text length", () => {
    const short = estimateTokens("hello");
    const long = estimateTokens("hello world ".repeat(100));
    expect(long).toBeGreaterThan(short * 10);
  });
});
