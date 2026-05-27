/**
 * Tests for the `mergeConfig` helper exported from server.ts.
 *
 * `mergeConfig` is the entry point for initializationOptions sent by
 * any LSP client — it has to be defensive against partial / malformed
 * input without crashing the server during the LSP handshake (which
 * would leave the editor in a broken state with no error surfaced).
 */

import { describe, expect, test } from "vitest";
import { mergeConfig } from "../src/config.js";

const BASE = {
  backend: "openai:gpt-4o-mini",
  language: "en" as const,
  completion: { enabled: true, trigger: "manual" as const },
  maxTokens: 1024,
  temperature: 0.2,
};

describe("mergeConfig", () => {
  test("returns a fresh copy of base when input is null/undefined", () => {
    expect(mergeConfig(BASE, null)).toEqual(BASE);
    expect(mergeConfig(BASE, undefined)).toEqual(BASE);
  });

  test("returns a fresh copy when input is a non-object", () => {
    expect(mergeConfig(BASE, "garbage")).toEqual(BASE);
    expect(mergeConfig(BASE, 42)).toEqual(BASE);
  });

  test("overrides individual scalar fields", () => {
    const m = mergeConfig(BASE, { backend: "anthropic:claude-3-5-haiku-latest" });
    expect(m.backend).toBe("anthropic:claude-3-5-haiku-latest");
    expect(m.maxTokens).toBe(1024); // untouched
  });

  test("normalises invalid language to base", () => {
    // Defensive: someone types "english" instead of "en" — we don't
    // want to silently break the prompt lookup.
    const m = mergeConfig(BASE, { language: "english" as unknown as "en" });
    expect(m.language).toBe("en");
  });

  test("rejects non-numeric maxTokens/temperature", () => {
    const m = mergeConfig(BASE, {
      maxTokens: "lots" as unknown as number,
      temperature: "hot" as unknown as number,
    });
    expect(m.maxTokens).toBe(1024);
    expect(m.temperature).toBe(0.2);
  });

  test("merges the completion sub-object instead of replacing it", () => {
    // The user flipped only `enabled`; trigger should keep its base
    // value rather than going undefined.
    const m = mergeConfig(BASE, { completion: { enabled: false } as Partial<typeof BASE.completion> });
    expect(m.completion).toEqual({ enabled: false, trigger: "manual" });
  });

  test("accepts a fully populated completion override", () => {
    const m = mergeConfig(BASE, { completion: { enabled: true, trigger: "auto" } });
    expect(m.completion).toEqual({ enabled: true, trigger: "auto" });
  });
});
