/**
 * Pricing tests.
 *
 * These check the public surface — model lookup, env override, cost
 * arithmetic, formatting. They do not assert specific dollar amounts
 * for known models because list prices change; that's the kind of
 * detail you want to update silently with the latest reality.
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { estimateCost, formatCost, pricingFor } from "../src/pricing.js";

let saved: string | undefined;
beforeEach(() => {
  saved = process.env.RINA_PRICING_OVERRIDE;
  delete process.env.RINA_PRICING_OVERRIDE;
});
afterEach(() => {
  if (saved === undefined) {
    delete process.env.RINA_PRICING_OVERRIDE;
  } else {
    process.env.RINA_PRICING_OVERRIDE = saved;
  }
});

describe("pricingFor", () => {
  test("returns known prices for DeepSeek chat", () => {
    const p = pricingFor("deepseek:deepseek-chat");
    expect(p.input).toBeGreaterThan(0);
    expect(p.output).toBeGreaterThan(p.input); // output always pricier than input
  });

  test("returns known prices for OpenAI gpt-4o-mini", () => {
    const p = pricingFor("openai:gpt-4o-mini");
    expect(p.input).toBeGreaterThan(0);
    expect(p.output).toBeGreaterThanOrEqual(p.input);
  });

  test("returns conservative fallback for unknown spec", () => {
    const p = pricingFor("noprovider:nomodel");
    expect(p.input).toBeGreaterThan(0);
    expect(p.output).toBeGreaterThan(0);
  });

  test("env override wins over the static table", () => {
    process.env.RINA_PRICING_OVERRIDE = JSON.stringify({
      "deepseek:deepseek-chat": { input: 99, output: 999 },
    });
    const p = pricingFor("deepseek:deepseek-chat");
    expect(p.input).toBe(99);
    expect(p.output).toBe(999);
  });

  test("malformed env override is ignored, falls back to known", () => {
    process.env.RINA_PRICING_OVERRIDE = "not-json";
    const p = pricingFor("deepseek:deepseek-chat");
    expect(p.input).not.toBe(99);
  });
});

describe("estimateCost", () => {
  test("returns 0 for zero tokens", () => {
    expect(estimateCost("deepseek:deepseek-chat", 0)).toBe(0);
  });

  test("scales linearly with tokens", () => {
    const a = estimateCost("deepseek:deepseek-chat", 1_000);
    const b = estimateCost("deepseek:deepseek-chat", 10_000);
    // Allow tiny floating-point drift on the ratio.
    expect(b).toBeCloseTo(a * 10, 6);
  });

  test("more expensive model produces a higher cost than cheaper one", () => {
    const cheap = estimateCost("openai:gpt-4o-mini", 100_000);
    const pricey = estimateCost("openai:gpt-4o", 100_000);
    expect(pricey).toBeGreaterThan(cheap);
  });
});

describe("formatCost", () => {
  test("returns $0 for non-positive", () => {
    expect(formatCost(0)).toBe("$0");
    expect(formatCost(-1)).toBe("$0");
    expect(formatCost(Number.NaN)).toBe("$0");
  });

  test("uses 4 decimals under one cent", () => {
    expect(formatCost(0.0001234)).toBe("$0.0001");
  });

  test("uses 3 decimals between 1 cent and 1 dollar", () => {
    expect(formatCost(0.012)).toBe("$0.012");
    expect(formatCost(0.5)).toBe("$0.500");
  });

  test("uses 2 decimals at or above 1 dollar", () => {
    expect(formatCost(1.45)).toBe("$1.45");
    expect(formatCost(12.3)).toBe("$12.30");
  });
});
