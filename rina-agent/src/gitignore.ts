/**
 * Minimal .gitignore matcher.
 *
 * We implement just enough of the gitignore spec to be useful for an
 * agent walking a project tree — full git semantics involve negation
 * chains, multiple cascading .gitignore files per subdirectory, and
 * edge cases around symlinks. We support:
 *
 *   - blank lines and `#` comments
 *   - directory-only patterns ending in `/`
 *   - patterns anchored to the workdir via leading `/`
 *   - bare patterns matching at any depth (`node_modules`)
 *   - simple `*` and `**` globs (no character classes)
 *   - negation with `!` (last-match-wins, like real git)
 *
 * We deliberately don't support:
 *   - per-subdirectory .gitignore files (only the workdir root)
 *   - .gitignore_global from git config
 *   - character classes like `[abc]`
 *
 * Good enough that `list_files({recursive: true, respect_gitignore: true})`
 * doesn't dump the entire `node_modules/` of a Node project into the
 * model's context. That's the only consumer we care about right now.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

interface Rule {
  /** Original pattern after stripping `!` / leading `/`. */
  pattern: string;
  /** Regex compiled from the pattern. */
  regex: RegExp;
  /** True if this is a `!negate` rule (re-include after a prior ignore). */
  negate: boolean;
  /** True if the pattern only matches directories (trailing `/`). */
  dirOnly: boolean;
  /** True if the pattern is anchored to the workdir (leading `/`). */
  anchored: boolean;
}

export interface IgnoreMatcher {
  /**
   * Decide whether `relativePath` (POSIX-style, relative to workdir)
   * should be ignored. `isDir` is needed because some patterns only
   * match directories.
   */
  ignores(relativePath: string, isDir: boolean): boolean;
}

/**
 * Build a matcher that always returns `false` — used when there's no
 * .gitignore in the workdir or the user opted out.
 */
export const ALWAYS_INCLUDE: IgnoreMatcher = {
  ignores: () => false,
};

/**
 * Load `.gitignore` from `workdir` and compile it into a matcher.
 * Returns `ALWAYS_INCLUDE` if the file is missing or empty.
 */
export function loadGitignore(workdir: string): IgnoreMatcher {
  let content: string;
  try {
    content = readFileSync(join(workdir, ".gitignore"), "utf8");
  } catch {
    return ALWAYS_INCLUDE;
  }
  return compileGitignore(content);
}

/**
 * Compile a .gitignore text into a matcher. Exposed for testing —
 * callers normally use `loadGitignore`.
 */
export function compileGitignore(content: string): IgnoreMatcher {
  const rules: Rule[] = [];
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith("#")) {
      continue;
    }
    rules.push(parseRule(line));
  }

  return {
    ignores(relativePath: string, isDir: boolean): boolean {
      // Normalise to POSIX separators; the patterns assume `/`.
      const path = relativePath.replace(/\\/g, "/").replace(/^\/+/, "");
      let ignored = false;
      // "Last match wins" — iterate every rule, flip the flag on each hit.
      for (const rule of rules) {
        if (rule.dirOnly && !isDir) {
          continue;
        }
        if (rule.regex.test(path)) {
          ignored = !rule.negate;
        }
      }
      return ignored;
    },
  };
}

function parseRule(raw: string): Rule {
  let line = raw;
  const negate = line.startsWith("!");
  if (negate) {
    line = line.slice(1);
  }
  const dirOnly = line.endsWith("/");
  if (dirOnly) {
    line = line.slice(0, -1);
  }
  const anchored = line.startsWith("/");
  if (anchored) {
    line = line.slice(1);
  }
  // Git semantics: `**/foo` matches `foo` at any depth including the
  // root itself. Strip the leading `**/` and treat the remainder as a
  // bare (non-anchored) pattern — that's exactly the same matching
  // behaviour for the depth-including-zero case.
  if (line.startsWith("**/")) {
    line = line.slice(3);
  }
  return {
    pattern: raw,
    regex: globToRegex(line, anchored),
    negate,
    dirOnly,
    anchored,
  };
}

/**
 * Translate a gitignore-style glob into a JavaScript RegExp.
 *
 * Rules:
 *   - `*`  matches anything except `/`
 *   - `**` matches anything including `/`
 *   - `?`  matches one char except `/`
 *   - other special chars are escaped literally
 *
 * Anchored patterns (leading `/`) match only from the workdir root.
 * Bare patterns match at any depth — i.e. `node_modules` matches both
 * `node_modules/foo` and `pkg/node_modules/foo`.
 */
function globToRegex(glob: string, anchored: boolean): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        re += ".*";
        i++; // consume second '*'
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if (c === ".") {
      re += "\\.";
    } else if ("+()|^$[]{}\\".includes(c)) {
      re += "\\" + c;
    } else {
      re += c;
    }
  }
  const body = anchored
    ? `^${re}(?:/.*)?$`
    : `(?:^|.*/)${re}(?:/.*)?$`;
  return new RegExp(body);
}
