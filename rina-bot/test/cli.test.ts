/**
 * CLI smoke tests for the helpers we expose for testing.
 *
 * The actual bot loop touches the network and isn't unit-tested here —
 * it gets exercised by manual smoke runs against a real token.
 */

import { describe, expect, test } from "vitest";
import { parseAllowlist } from "../src/cli.js";

describe("parseAllowlist", () => {
  test("returns an empty set for empty string", () => {
    expect(parseAllowlist("").size).toBe(0);
  });

  test("splits on commas and trims whitespace", () => {
    const s = parseAllowlist("123, 456 ,789");
    expect(s.has("123")).toBe(true);
    expect(s.has("456")).toBe(true);
    expect(s.has("789")).toBe(true);
    expect(s.size).toBe(3);
  });

  test("drops empty entries from trailing commas", () => {
    expect(parseAllowlist("1,,2,").size).toBe(2);
  });
});
