/**
 * Pluggable backend layer — kept in sync with `lsp-server/src/backend.ts`.
 *
 * The CLI and LSP server share the same provider abstraction; copying
 * the file rather than introducing a workspace dependency keeps each
 * package independently publishable. If you change one, change both —
 * the test suites in either package will catch divergence quickly.
 *
 * Same spec syntax as the Python side (`provider:model`) so users carry one
 * mental model across the Python eval tooling and the TS LSP server:
 *
 *   - openai:<model>     → OpenAI Chat Completions API
 *   - anthropic:<model>  → Anthropic Messages API
 *   - mistral:<model>    → Mistral Chat Completions API
 *   - rina:<url>         → future RINA AI inference endpoint (OpenAI-compat)
 *
 * Each backend reads its key from the corresponding env var
 * (OPENAI_API_KEY, ANTHROPIC_API_KEY, MISTRAL_API_KEY, RINA_API_KEY) —
 * we don't accept keys via initializationOptions to avoid having them
 * sit in the LSP client's config file.
 *
 * Network calls use Node's built-in fetch (Node 18+) so we pull zero
 * runtime deps beyond vscode-languageserver. Retry-with-backoff is
 * shared across providers, mirroring the Python `generate()` wrapper.
 */

export interface GenerationConfig {
  maxTokens?: number;
  temperature?: number;
  stop?: string[];
}

export interface Backend {
  spec: string;
  generate(messages: ChatMessage[], config?: GenerationConfig): Promise<string>;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

const DEFAULT_CONFIG: Required<GenerationConfig> = {
  maxTokens: 1024,
  temperature: 0.2,
  stop: [],
};

/**
 * Parse a backend spec string and instantiate the matching backend.
 * Bare strings (no `:` prefix) are an error — unlike the Python eval
 * code, the LSP layer has no concept of "default to HF local model"
 * because we don't run HF inference in-process here.
 */
export function backendFromSpec(spec: string): Backend {
  const sep = spec.indexOf(":");
  if (sep === -1) {
    throw new Error(
      `Invalid backend spec '${spec}'. Expected '<provider>:<model>' — ` +
        `e.g. 'openai:gpt-4o-mini', 'anthropic:claude-3-5-haiku-latest', ` +
        `'mistral:codestral-latest', 'rina:https://api.plateforme-rina.com/v1'.`
    );
  }
  const provider = spec.slice(0, sep).toLowerCase();
  const model = spec.slice(sep + 1);

  switch (provider) {
    case "openai":
      return new OpenAIBackend(model);
    case "anthropic":
      return new AnthropicBackend(model);
    case "mistral":
      return new MistralBackend(model);
    case "rina":
      return new RinaBackend(model);
    default:
      throw new Error(
        `Unknown backend provider '${provider}'. ` +
          `Supported: openai, anthropic, mistral, rina.`
      );
  }
}

/**
 * Shared retry wrapper. Transient errors (HTTP 5xx, network glitches) are
 * worth a couple of attempts; auth/validation errors should fail fast so
 * the user sees the underlying message immediately.
 */
async function withRetry<T>(
  fn: () => Promise<T>,
  retries = 2,
  baseDelayMs = 600
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isTransient(err) || attempt === retries) {
        throw err;
      }
      // Exponential backoff with a tiny jitter.
      const delay = baseDelayMs * Math.pow(2, attempt) + Math.random() * 100;
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

function isTransient(err: unknown): boolean {
  if (!err || typeof err !== "object") {
    return false;
  }
  const e = err as { status?: number; code?: string };
  if (typeof e.status === "number" && e.status >= 500 && e.status < 600) {
    return true;
  }
  if (typeof e.status === "number" && e.status === 429) {
    return true; // rate limit — usually clears within a few seconds
  }
  // Node fetch surfaces these as `code` on AbortError / NetworkError.
  if (typeof e.code === "string" && /ETIMEDOUT|ECONNRESET|ENOTFOUND/i.test(e.code)) {
    return true;
  }
  return false;
}

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = "HttpError";
  }
}

async function postJson<T>(url: string, body: unknown, headers: Record<string, string>): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new HttpError(res.status, `${res.status} ${res.statusText}: ${text.slice(0, 500)}`);
  }
  return (await res.json()) as T;
}

function requireEnv(name: string, hint: string): string {
  const v = process.env[name];
  if (!v) {
    throw new Error(`${name} environment variable is required. ${hint}`);
  }
  return v;
}

// ────────────────────────────────────────────────────────────────────
// OpenAI
// ────────────────────────────────────────────────────────────────────

class OpenAIBackend implements Backend {
  readonly spec: string;
  private readonly apiKey: string;

  constructor(private readonly model: string) {
    this.spec = `openai:${model}`;
    this.apiKey = requireEnv(
      "OPENAI_API_KEY",
      "Set it in your shell, e.g. `export OPENAI_API_KEY=sk-...`."
    );
  }

  async generate(messages: ChatMessage[], config?: GenerationConfig): Promise<string> {
    const c = { ...DEFAULT_CONFIG, ...config };
    return withRetry(async () => {
      const data = await postJson<{ choices: { message: { content: string } }[] }>(
        "https://api.openai.com/v1/chat/completions",
        {
          model: this.model,
          messages,
          max_tokens: c.maxTokens,
          temperature: c.temperature,
          stop: c.stop.length ? c.stop : undefined,
        },
        { Authorization: `Bearer ${this.apiKey}` }
      );
      return data.choices?.[0]?.message?.content ?? "";
    });
  }
}

// ────────────────────────────────────────────────────────────────────
// Anthropic
// ────────────────────────────────────────────────────────────────────

class AnthropicBackend implements Backend {
  readonly spec: string;
  private readonly apiKey: string;

  constructor(private readonly model: string) {
    this.spec = `anthropic:${model}`;
    this.apiKey = requireEnv(
      "ANTHROPIC_API_KEY",
      "Set it in your shell, e.g. `export ANTHROPIC_API_KEY=sk-ant-...`."
    );
  }

  async generate(messages: ChatMessage[], config?: GenerationConfig): Promise<string> {
    const c = { ...DEFAULT_CONFIG, ...config };
    // Anthropic separates `system` from `messages` — extract it.
    const systemMsgs = messages.filter((m) => m.role === "system").map((m) => m.content);
    const userMsgs = messages.filter((m) => m.role !== "system");

    return withRetry(async () => {
      const data = await postJson<{ content: { type: string; text?: string }[] }>(
        "https://api.anthropic.com/v1/messages",
        {
          model: this.model,
          system: systemMsgs.join("\n\n") || undefined,
          messages: userMsgs.map((m) => ({ role: m.role, content: m.content })),
          max_tokens: c.maxTokens,
          temperature: c.temperature,
          stop_sequences: c.stop.length ? c.stop : undefined,
        },
        {
          "x-api-key": this.apiKey,
          "anthropic-version": "2023-06-01",
        }
      );
      return (data.content ?? [])
        .filter((b) => b.type === "text")
        .map((b) => b.text ?? "")
        .join("");
    });
  }
}

// ────────────────────────────────────────────────────────────────────
// Mistral
// ────────────────────────────────────────────────────────────────────

class MistralBackend implements Backend {
  readonly spec: string;
  private readonly apiKey: string;

  constructor(private readonly model: string) {
    this.spec = `mistral:${model}`;
    this.apiKey = requireEnv(
      "MISTRAL_API_KEY",
      "Set it in your shell, e.g. `export MISTRAL_API_KEY=...`."
    );
  }

  async generate(messages: ChatMessage[], config?: GenerationConfig): Promise<string> {
    const c = { ...DEFAULT_CONFIG, ...config };
    return withRetry(async () => {
      const data = await postJson<{ choices: { message: { content: string } }[] }>(
        "https://api.mistral.ai/v1/chat/completions",
        {
          model: this.model,
          messages,
          max_tokens: c.maxTokens,
          temperature: c.temperature,
          stop: c.stop.length ? c.stop : undefined,
        },
        { Authorization: `Bearer ${this.apiKey}` }
      );
      return data.choices?.[0]?.message?.content ?? "";
    });
  }
}

// ────────────────────────────────────────────────────────────────────
// RINA AI — future OpenAI-compatible inference endpoint hosted at
// plateforme-rina.com. The URL is the *base* (e.g. `https://api.plateforme-rina.com/v1`)
// so we just append `/chat/completions`.
// ────────────────────────────────────────────────────────────────────

class RinaBackend implements Backend {
  readonly spec: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(baseUrl: string) {
    this.spec = `rina:${baseUrl}`;
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.apiKey = requireEnv(
      "RINA_API_KEY",
      "Set it in your shell, e.g. `export RINA_API_KEY=rina_...`. " +
        "Get a key from https://plateforme-rina.com once the API is public."
    );
  }

  async generate(messages: ChatMessage[], config?: GenerationConfig): Promise<string> {
    const c = { ...DEFAULT_CONFIG, ...config };
    return withRetry(async () => {
      const data = await postJson<{ choices: { message: { content: string } }[] }>(
        `${this.baseUrl}/chat/completions`,
        {
          // We don't pin a specific model name here — the server picks
          // its default RINA Coder checkpoint. Users can override with
          // a future `model` field once we publish multiple variants.
          messages,
          max_tokens: c.maxTokens,
          temperature: c.temperature,
          stop: c.stop.length ? c.stop : undefined,
        },
        { Authorization: `Bearer ${this.apiKey}` }
      );
      return data.choices?.[0]?.message?.content ?? "";
    });
  }
}

// Re-export the error type so consumers can disambiguate auth/quota
// failures from "real" network errors when reporting back to the editor.
export { HttpError };
