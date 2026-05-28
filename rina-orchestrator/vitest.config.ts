import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // 20s — long enough for a real Playwright launch in the smoke
    // test we'll add later, well under what Vitest considers a
    // hung test.
    testTimeout: 20_000,
  },
});
