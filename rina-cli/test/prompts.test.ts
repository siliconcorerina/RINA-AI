/**
 * Tests for the pure prompt-building + code-extraction layer.
 *
 * The backend layer (HTTP to OpenAI/Anthropic/Mistral/RINA) is exercised
 * by integration tests run outside CI — pointless to mock providers we
 * don't control. These tests guarantee the prompts we *send* are the
 * shape we expect, in both supported languages.
 */

import { describe, expect, test } from "vitest";
import {
  buildCompletionPrompt,
  buildExplainPrompt,
  buildGenerateTestsPrompt,
  buildRefactorPrompt,
  extractCode,
} from "../src/prompts.js";

describe("buildExplainPrompt", () => {
  test("returns a system + user pair", () => {
    const msgs = buildExplainPrompt({ code: "x = 1", language: "python" });
    expect(msgs).toHaveLength(2);
    expect(msgs[0].role).toBe("system");
    expect(msgs[1].role).toBe("user");
  });

  test("system prompt mentions RINA Coder", () => {
    const msgs = buildExplainPrompt({ code: "x = 1", language: "python" });
    expect(msgs[0].content).toMatch(/RINA Coder/);
  });

  test("user prompt embeds language + code in a fenced block", () => {
    const msgs = buildExplainPrompt({ code: "def foo():\n    pass", language: "python" });
    expect(msgs[1].content).toMatch(/Language: python/);
    expect(msgs[1].content).toMatch(/```python\ndef foo\(\):/);
  });

  test("french system prompt when language=fr", () => {
    const msgs = buildExplainPrompt({ code: "x", language: "python" }, "fr");
    expect(msgs[0].content).toMatch(/Explique le code/);
  });
});

describe("buildRefactorPrompt", () => {
  test("instructs the model to return ONLY code in a fenced block", () => {
    const msgs = buildRefactorPrompt({ code: "x = 1", language: "python" });
    // We rely on the model returning a fenced block — the system prompt
    // must explicitly demand it, otherwise extractCode falls back to
    // raw text which can include prose.
    expect(msgs[0].content).toMatch(/single fenced code block/i);
  });
});

describe("buildGenerateTestsPrompt", () => {
  test("asks for happy path + edge cases", () => {
    const msgs = buildGenerateTestsPrompt({ code: "def add(a, b): return a + b", language: "python" });
    expect(msgs[0].content).toMatch(/edge case/i);
  });
});

describe("buildCompletionPrompt", () => {
  test("uses fill-in-the-middle framing with explicit CURSOR marker", () => {
    const msgs = buildCompletionPrompt({
      prefix: "def foo():\n    return ",
      suffix: "\n\ndef bar():",
      language: "python",
    });
    expect(msgs[1].content).toContain("<CURSOR>");
    expect(msgs[1].content).toContain("def foo():");
    expect(msgs[1].content).toContain("def bar():");
  });

  test("system prompt forbids prose / fences / repetition", () => {
    const msgs = buildCompletionPrompt({ prefix: "x", suffix: "", language: "python" });
    expect(msgs[0].content).toMatch(/no prose/i);
    expect(msgs[0].content).toMatch(/no fences/i);
  });
});

describe("extractCode", () => {
  test("pulls the contents of a single fenced block", () => {
    const reply = "Here you go:\n\n```python\ndef foo():\n    return 1\n```\n\nDone.";
    expect(extractCode(reply)).toBe("def foo():\n    return 1");
  });

  test("picks the largest block when multiple are present", () => {
    const small = "```python\nx = 1\n```";
    const big = "```python\ndef foo():\n    return 1 + 2 + 3 + 4\n```";
    const reply = `Example:\n${small}\n\nReal answer:\n${big}`;
    expect(extractCode(reply)).toContain("def foo()");
  });

  test("falls back to raw trimmed text when no fence is present", () => {
    // Small models often forget the fence — better to return *something*
    // than nothing.
    expect(extractCode("  x = 1\n")).toBe("x = 1");
  });

  test("strips leading/trailing whitespace inside the block", () => {
    const reply = "```\n\n  hello\n\n```";
    expect(extractCode(reply)).toBe("hello");
  });

  test("handles fences with no language tag", () => {
    const reply = "```\nbare = true\n```";
    expect(extractCode(reply)).toBe("bare = true");
  });

  test("handles fences with arbitrary language tags including digits/underscores", () => {
    const reply = "```typescript-react_5\nconst x = 1;\n```";
    expect(extractCode(reply)).toBe("const x = 1;");
  });
});
