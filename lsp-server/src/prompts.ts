/**
 * Prompt builders for each LSP action.
 *
 * Kept pure (no IO, no globals) so they can be unit-tested in isolation
 * and so users who fork the LSP to point at a different model can tweak
 * one file and re-build.
 *
 * Bilingual: system prompts adapt to the user's preferred language
 * (`config.language === "fr"` or `"en"`). The user-facing assistant
 * UI on plateforme-rina.com is French; the editor surface is mostly
 * English by industry convention. Default to English, override to FR
 * if requested.
 */

import type { ChatMessage } from "./backend.js";

export type Action = "explain" | "refactor" | "generateTests" | "completion";
export type Language = "en" | "fr";

const SYSTEM_PROMPTS: Record<Action, Record<Language, string>> = {
  explain: {
    en:
      "You are RINA Coder, an open-source code-assist model. Explain the provided " +
      "code clearly and concisely. Highlight subtle behaviour, possible bugs, and " +
      "improvement opportunities. Use Markdown.",
    fr:
      "Tu es RINA Coder, un modèle open-source d'assistance au code. Explique le " +
      "code fourni clairement et de façon concise. Souligne les comportements " +
      "subtils, les bugs potentiels, et les pistes d'amélioration. Utilise le Markdown.",
  },
  refactor: {
    en:
      "You are RINA Coder. Refactor the provided code while preserving behaviour. " +
      "Favour readability, fix obvious bugs, and explain in ONE line what changed. " +
      "Return ONLY the refactored code, wrapped in a single fenced code block.",
    fr:
      "Tu es RINA Coder. Refactore le code fourni en préservant son comportement. " +
      "Privilégie la lisibilité, corrige les bugs évidents, et explique en UNE ligne " +
      "ce que tu as changé. Retourne UNIQUEMENT le code refactoré, dans un bloc " +
      "de code unique.",
  },
  generateTests: {
    en:
      "You are RINA Coder. Generate a focused unit-test suite for the provided code. " +
      "Cover the happy path plus 2-3 edge cases (empty/null inputs, boundary " +
      "values, error paths). Use the most idiomatic test framework for the " +
      "language. Return ONLY the test file, wrapped in a single fenced code block.",
    fr:
      "Tu es RINA Coder. Génère une suite de tests unitaires ciblée pour le code " +
      "fourni. Couvre le cas nominal plus 2-3 cas limites (entrées vides/null, " +
      "valeurs aux bornes, chemins d'erreur). Utilise le framework de test le plus " +
      "idiomatique pour le langage. Retourne UNIQUEMENT le fichier de test, dans " +
      "un bloc de code unique.",
  },
  completion: {
    en:
      "You are RINA Coder. Complete the code at the cursor position. Return ONLY " +
      "the continuation — no prose, no fences, no repetition of what's already there. " +
      "Stop at a natural boundary (end of function, end of statement, blank line).",
    fr:
      "Tu es RINA Coder. Complète le code à la position du curseur. Retourne " +
      "UNIQUEMENT la suite — pas de prose, pas de blocs de code, pas de répétition " +
      "de ce qui est déjà là. Arrête-toi à une borne naturelle (fin de fonction, " +
      "fin d'instruction, ligne vide).",
  },
};

export interface ExplainInput {
  code: string;
  language: string;
}

export interface RefactorInput {
  code: string;
  language: string;
}

export interface GenerateTestsInput {
  code: string;
  language: string;
}

export interface CompletionInput {
  /** Text immediately before the cursor — kept short to control token usage. */
  prefix: string;
  /** Text immediately after the cursor (suffix-aware completion). */
  suffix: string;
  /** Editor language id, e.g. "python", "typescript". */
  language: string;
}

export function buildExplainPrompt(input: ExplainInput, lang: Language = "en"): ChatMessage[] {
  return [
    { role: "system", content: SYSTEM_PROMPTS.explain[lang] },
    {
      role: "user",
      content: `Language: ${input.language}\n\nCode:\n\`\`\`${input.language}\n${input.code}\n\`\`\``,
    },
  ];
}

export function buildRefactorPrompt(input: RefactorInput, lang: Language = "en"): ChatMessage[] {
  return [
    { role: "system", content: SYSTEM_PROMPTS.refactor[lang] },
    {
      role: "user",
      content: `Language: ${input.language}\n\nCode to refactor:\n\`\`\`${input.language}\n${input.code}\n\`\`\``,
    },
  ];
}

export function buildGenerateTestsPrompt(
  input: GenerateTestsInput,
  lang: Language = "en"
): ChatMessage[] {
  return [
    { role: "system", content: SYSTEM_PROMPTS.generateTests[lang] },
    {
      role: "user",
      content: `Language: ${input.language}\n\nCode under test:\n\`\`\`${input.language}\n${input.code}\n\`\`\``,
    },
  ];
}

export function buildCompletionPrompt(
  input: CompletionInput,
  lang: Language = "en"
): ChatMessage[] {
  // Fill-in-the-middle framing: tell the model exactly where the cursor
  // is so it can pay attention to the suffix as well as the prefix. This
  // beats naive "complete the file" prompting on multi-line completions.
  const user =
    `Language: ${input.language}\n\n` +
    `Complete the code at <CURSOR>. The full surrounding context follows.\n\n` +
    "```" +
    input.language +
    `\n${input.prefix}<CURSOR>${input.suffix}\n` +
    "```";
  return [
    { role: "system", content: SYSTEM_PROMPTS.completion[lang] },
    { role: "user", content: user },
  ];
}

/**
 * Extract a fenced code block from a model response. Falls back to the
 * raw response trimmed — better to return *something* than nothing when
 * the model forgets the fence (common with small models).
 */
export function extractCode(reply: string): string {
  const fence = /```(?:[a-zA-Z0-9_+\-]*)\s*\n([\s\S]*?)```/g;
  const blocks: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = fence.exec(reply)) !== null) {
    blocks.push(m[1]);
  }
  if (blocks.length === 0) {
    return reply.trim();
  }
  // When multiple blocks come back, the largest one is usually the
  // actual answer (the others are short examples or signatures).
  return blocks.reduce((a, b) => (b.length > a.length ? b : a)).trim();
}
