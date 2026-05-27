/**
 * Runtime configuration handling for the RINA LSP server.
 *
 * Kept in its own module (no side-effects, no `createConnection` calls)
 * so unit tests can import `mergeConfig` without booting the LSP
 * transport machinery.
 */

import type { Language } from "./prompts.js";

export interface RinaConfig {
  /** Backend spec — e.g. "openai:gpt-4o-mini", "anthropic:claude-3-5-haiku-latest". */
  backend: string;
  /** Prompt language for the assistant. */
  language: Language;
  completion: {
    /** Whether the server advertises completion at all. */
    enabled: boolean;
    /** "manual" = no trigger characters (user invokes Ctrl+Space); "auto" = trigger on `.`. */
    trigger: "manual" | "auto";
  };
  /** Cap on tokens per response. Tighter is cheaper + faster. */
  maxTokens: number;
  /** Sampling temperature. 0.2 is a sensible code-gen default. */
  temperature: number;
}

export const DEFAULT_CONFIG: RinaConfig = {
  backend: "openai:gpt-4o-mini",
  language: "en",
  completion: { enabled: true, trigger: "manual" },
  maxTokens: 1024,
  temperature: 0.2,
};

/**
 * Merge user-supplied initializationOptions over the defaults.
 *
 * Defensive against malformed input — a bad config in the editor must
 * not crash the server during the LSP handshake, otherwise the user
 * is left with a dead server and no on-screen error.
 *
 * Sub-objects (currently just `completion`) are merged rather than
 * replaced — flipping `completion.enabled` shouldn't reset the trigger
 * mode to undefined.
 */
export function mergeConfig(base: RinaConfig, opts: unknown): RinaConfig {
  if (!opts || typeof opts !== "object") {
    return { ...base, completion: { ...base.completion } };
  }
  const o = opts as Partial<RinaConfig>;
  return {
    backend: typeof o.backend === "string" ? o.backend : base.backend,
    language: o.language === "fr" || o.language === "en" ? o.language : base.language,
    completion: { ...base.completion, ...(o.completion ?? {}) },
    maxTokens: typeof o.maxTokens === "number" ? o.maxTokens : base.maxTokens,
    temperature: typeof o.temperature === "number" ? o.temperature : base.temperature,
  };
}
