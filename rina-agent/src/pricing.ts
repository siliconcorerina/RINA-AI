/**
 * Per-model token pricing — best-effort, last updated 2026-05.
 *
 * Pricing is a moving target. We hardcode the *most common* models we
 * recommend in docs (DeepSeek, GPT-4o-mini, Claude Haiku, Codestral)
 * with public list-price numbers, and fall back to a conservative
 * "unknown" estimate for everything else. That estimate is intentionally
 * a bit high so the cost display never under-reports.
 *
 * The user can override via the `RINA_PRICING_OVERRIDE` env var (JSON of
 * the same shape as `KNOWN_PRICES`). The agent doesn't pretend to be a
 * billing dashboard — this is here so the live step display can show
 * roughly how much a run is costing.
 *
 * Prices are in USD per 1 million tokens.
 */

export interface ModelPricing {
  /** USD per 1 million input tokens. */
  input: number;
  /** USD per 1 million output tokens. */
  output: number;
}

const KNOWN_PRICES: Record<string, ModelPricing> = {
  // OpenAI
  "openai:gpt-4o-mini": { input: 0.15, output: 0.6 },
  "openai:gpt-4o": { input: 2.5, output: 10.0 },
  "openai:gpt-4-turbo": { input: 10.0, output: 30.0 },
  // Anthropic
  "anthropic:claude-3-5-haiku-latest": { input: 0.8, output: 4.0 },
  "anthropic:claude-3-5-sonnet-latest": { input: 3.0, output: 15.0 },
  "anthropic:claude-3-7-sonnet-latest": { input: 3.0, output: 15.0 },
  "anthropic:claude-3-opus-latest": { input: 15.0, output: 75.0 },
  // Mistral
  "mistral:codestral-latest": { input: 0.2, output: 0.6 },
  "mistral:mistral-large-latest": { input: 2.0, output: 6.0 },
  "mistral:mistral-small-latest": { input: 0.2, output: 0.6 },
  // DeepSeek
  "deepseek:deepseek-chat": { input: 0.27, output: 1.1 },
  "deepseek:deepseek-coder": { input: 0.27, output: 1.1 },
  "deepseek:deepseek-reasoner": { input: 0.55, output: 2.19 },
};

/**
 * Conservative fallback when we don't have list prices for the exact
 * spec the user is running. Picked to roughly approximate "mid-range
 * frontier model" so the agent doesn't massively under-report cost on
 * an unknown backend.
 */
const UNKNOWN_FALLBACK: ModelPricing = { input: 1.0, output: 3.0 };

/**
 * Look up pricing for a backend spec. Returns the override from
 * `RINA_PRICING_OVERRIDE` env var if set, then the static table, then
 * the conservative fallback.
 *
 * Spec lookup is case-insensitive on the provider half because that's
 * how `backendFromSpec` normalises it, but the model half is matched
 * verbatim (`gpt-4o-mini` ≠ `gpt-4o`).
 */
export function pricingFor(spec: string): ModelPricing {
  const override = readOverride(spec);
  if (override) {
    return override;
  }
  return KNOWN_PRICES[spec.toLowerCase()] ?? KNOWN_PRICES[spec] ?? UNKNOWN_FALLBACK;
}

function readOverride(spec: string): ModelPricing | null {
  const raw = process.env.RINA_PRICING_OVERRIDE;
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, ModelPricing>;
    return parsed[spec] ?? parsed[spec.toLowerCase()] ?? null;
  } catch {
    // Malformed env var — ignore silently rather than crash the agent.
    return null;
  }
}

/**
 * Best-effort cost estimate for the session so far.
 *
 * The agent doesn't separately track input vs output tokens (the
 * `Budget` only counts response tokens). To produce a single $ figure
 * we treat input and output as roughly equal in volume — a deliberate
 * over-estimate for chatty models, accurate enough for a live display.
 *
 * Returns USD as a number, e.g. 0.0042 means 0.42 cents.
 */
export function estimateCost(spec: string, totalTokens: number): number {
  const p = pricingFor(spec);
  // Half input, half output is a passable middle-of-the-road assumption.
  // Users who care about precise accounting should look at their
  // provider's dashboard, not the agent's status line.
  const halfM = totalTokens / 2 / 1_000_000;
  return halfM * p.input + halfM * p.output;
}

/**
 * Render a cost as a short human-readable string.
 *   $0.0001234  → "$0.0001"
 *   $0.012      → "$0.012"
 *   $1.45       → "$1.45"
 */
export function formatCost(usd: number): string {
  if (!Number.isFinite(usd) || usd <= 0) {
    return "$0";
  }
  if (usd < 0.01) {
    return `$${usd.toFixed(4)}`;
  }
  if (usd < 1) {
    return `$${usd.toFixed(3)}`;
  }
  return `$${usd.toFixed(2)}`;
}
