/**
 * Gitignore matcher tests.
 *
 * We don't claim full git-compat — these tests pin the subset we
 * actually need (anchored, bare, directory-only, simple globs, negation).
 */

import { describe, expect, test } from "vitest";
import { compileGitignore } from "../src/gitignore.js";

describe("compileGitignore — bare patterns", () => {
  test("bare directory name ignores at any depth", () => {
    const m = compileGitignore("node_modules\n");
    expect(m.ignores("node_modules", true)).toBe(true);
    expect(m.ignores("node_modules/foo", false)).toBe(true);
    expect(m.ignores("pkg/node_modules/foo", false)).toBe(true);
  });

  test("bare file name", () => {
    const m = compileGitignore(".env\n");
    expect(m.ignores(".env", false)).toBe(true);
    expect(m.ignores("sub/.env", false)).toBe(true);
    expect(m.ignores("envoy.conf", false)).toBe(false);
  });
});

describe("compileGitignore — anchored patterns", () => {
  test("leading slash anchors to root", () => {
    const m = compileGitignore("/dist\n");
    expect(m.ignores("dist", true)).toBe(true);
    expect(m.ignores("dist/index.js", false)).toBe(true);
    expect(m.ignores("packages/x/dist", true)).toBe(false);
  });
});

describe("compileGitignore — directory-only patterns", () => {
  test("trailing slash only matches directories", () => {
    const m = compileGitignore("build/\n");
    expect(m.ignores("build", true)).toBe(true);
    expect(m.ignores("build", false)).toBe(false); // a file named "build" is NOT ignored
  });
});

describe("compileGitignore — globs", () => {
  test("* matches anything except slash", () => {
    const m = compileGitignore("*.log\n");
    expect(m.ignores("foo.log", false)).toBe(true);
    expect(m.ignores("dir/foo.log", false)).toBe(true);
    // The bare-pattern rule matches at any depth, so this passes too.
  });

  test("** is greedy across slashes", () => {
    const m = compileGitignore("**/secrets.json\n");
    expect(m.ignores("secrets.json", false)).toBe(true);
    expect(m.ignores("a/b/secrets.json", false)).toBe(true);
  });
});

describe("compileGitignore — negation", () => {
  test("! re-includes a previously ignored path", () => {
    const m = compileGitignore("*.log\n!keep.log\n");
    expect(m.ignores("debug.log", false)).toBe(true);
    expect(m.ignores("keep.log", false)).toBe(false);
  });

  test("last match wins", () => {
    const m = compileGitignore("!*.tmp\n*.tmp\n");
    expect(m.ignores("foo.tmp", false)).toBe(true); // ignore rule came last
  });
});

describe("compileGitignore — quirks", () => {
  test("blank lines and comments are ignored", () => {
    const m = compileGitignore("\n# a comment\n  \nfoo\n");
    expect(m.ignores("foo", false)).toBe(true);
    expect(m.ignores("bar", false)).toBe(false);
  });

  test("an empty file ignores nothing", () => {
    const m = compileGitignore("");
    expect(m.ignores("anything", false)).toBe(false);
    expect(m.ignores("anything/with/slashes", true)).toBe(false);
  });
});
