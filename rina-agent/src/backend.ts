/**
 * Pluggable backend layer — kept in sync with `lsp-server/src/backend.ts`
 * and `rina-cli/src/backend.ts`.
 *
 * The three TypeScript packages (LSP server, CLI, agent) share the same
 * provider abstraction; copying the file rather than introducing a
 * workspace dependency keeps each package independently publishable.
 * If you change one, change all three — the test suites will catch
 * divergence quickly.
 *
 * Same spec syntax as the Python side (`provider:model`) so users carry one
 * mental model across the Python eval tooling and the TS LSP server:
 *
 *   - openai:<model>     → OpenAI Chat Completions API
 *   - anthropic:<model>  → Anthropic Messages API
 *   - mistral:<model>    → Mistral Chat Completions API
 *   - deepseek:<model>   → DeepSeek Chat Completions API (OpenAI-compat)
 *   - rina:<url>         → future RINA AI inference endpoint (OpenAI-compat)
 *
 * Each backend reads its key from the corresponding env var
 * (OPENAI_API_KEY, ANTHROPIC_API_KEY, MISTRAL_API_KEY, DEEPSEEK_API_KEY,
 * RINA_API_KEY) — we don't accept keys via initializationOptions to avoid
 * having them sit in the LSP client's config file.
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
  /**
   * Optional native function-calling. Backends that don't implement it
   * leave this undefined; the agent falls back to prompt-based parsing
   * of `<tool>{...}</tool>` blocks.
   *
   * The contract is intentionally simple: send messages + tool defs,
   * get back either a plain text answer or a single tool call. We
   * don't support parallel tool calls in this version — keeping the
   * agent loop linear matches our prompt-based flow.
   */
  generateWithTools?(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    config?: GenerationConfig
  ): Promise<NativeAssistantResponse>;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
  /**
   * When `role === "assistant"` and the model made a native tool call:
   * the call details. The provider-specific id is needed on the next
   * turn to thread the result back through the conversation.
   */
  toolCall?: { id: string; name: string; argsJson: string };
  /**
   * When `role === "user"` and this message is the result of a tool
   * call: the id of the call this response answers. Required by the
   * OpenAI Chat Completions and Anthropic Messages tool protocols.
   */
  toolCallId?: string;
}

/**
 * Provider-agnostic tool description fed to a native function-calling
 * backend. The shape mirrors OpenAI's `tools` schema (the JSON Schema
 * subset that every provider seems to converge on) — Anthropic's
 * `input_schema` is the same JSON Schema body, just nested under a
 * differently-named field, so the adapter does that rename at send time.
 */
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema
}

export interface NativeAssistantResponse {
  /** Free-form text the model produced. Often empty when it makes a tool call. */
  text: string;
  /** The single tool call the model made this turn, if any. */
  toolCall: { id: string; name: string; argsJson: string } | null;
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
        `'mistral:codestral-latest', 'deepseek:deepseek-chat', ` +
        `'rina:https://api.plateforme-rina.com/v1'.`
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
    case "deepseek":
      return new DeepSeekBackend(model);
    case "rina":
      return new RinaBackend(model);
    default:
      throw new Error(
        `Unknown backend provider '${provider}'. ` +
          `Supported: openai, anthropic, mistral, deepseek, rina.`
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
// Shared adapters for native function-calling
// ────────────────────────────────────────────────────────────────────

/**
 * Translate our internal ChatMessage[] into OpenAI's Chat Completions
 * message format. The non-trivial bits are:
 *   - assistant turns that called a tool become role=assistant with a
 *     `tool_calls` array (and content may be null/empty).
 *   - user turns that carry a tool result become role=tool with a
 *     `tool_call_id` keyed to the matching assistant turn.
 *
 * Everything else passes through with just `{role, content}`.
 */
function toOpenAIMessages(messages: ChatMessage[]): unknown[] {
  return messages.map((m) => {
    if (m.role === "assistant" && m.toolCall) {
      return {
        role: "assistant",
        content: m.content || null,
        tool_calls: [
          {
            id: m.toolCall.id,
            type: "function",
            function: { name: m.toolCall.name, arguments: m.toolCall.argsJson },
          },
        ],
      };
    }
    if (m.role === "user" && m.toolCallId) {
      return {
        role: "tool",
        tool_call_id: m.toolCallId,
        content: m.content,
      };
    }
    return { role: m.role, content: m.content };
  });
}

function toOpenAITools(tools: ToolDefinition[]): unknown[] {
  return tools.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

interface OpenAIChatToolResponse {
  choices?: {
    message?: {
      content?: string | null;
      tool_calls?: {
        id: string;
        function: { name: string; arguments?: string };
      }[];
    };
  }[];
}

/**
 * Generate-with-tools helper shared by every OpenAI-compatible
 * provider (OpenAI itself, Mistral, DeepSeek, and the future RINA
 * endpoint). Each provider just supplies its own base URL and auth.
 */
async function openAICompatGenerateWithTools(
  baseUrl: string,
  apiKey: string,
  model: string,
  messages: ChatMessage[],
  tools: ToolDefinition[],
  config?: GenerationConfig
): Promise<NativeAssistantResponse> {
  const c = { ...DEFAULT_CONFIG, ...config };
  return withRetry(async () => {
    const data = await postJson<OpenAIChatToolResponse>(
      `${baseUrl}/chat/completions`,
      {
        model,
        messages: toOpenAIMessages(messages),
        tools: toOpenAITools(tools),
        // We don't pass `tool_choice: "required"` — letting the model
        // answer in plain text when the task is conversational is a
        // useful escape hatch, and the agent loop handles "no tool
        // call this turn" cleanly.
        max_tokens: c.maxTokens,
        temperature: c.temperature,
      },
      { Authorization: `Bearer ${apiKey}` }
    );
    const choice = data.choices?.[0];
    const msg = choice?.message;
    const tc = msg?.tool_calls?.[0];
    return {
      text: msg?.content ?? "",
      toolCall: tc
        ? { id: tc.id, name: tc.function.name, argsJson: tc.function.arguments ?? "{}" }
        : null,
    };
  });
}

/**
 * Anthropic's Messages API takes the same JSON Schema body for tools
 * but nests it under `input_schema`, and uses content-block messages
 * (text + tool_use + tool_result) rather than the flat OpenAI shape.
 */
interface AnthropicToolBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
}

async function anthropicGenerateWithTools(
  apiKey: string,
  model: string,
  messages: ChatMessage[],
  tools: ToolDefinition[],
  config?: GenerationConfig
): Promise<NativeAssistantResponse> {
  const c = { ...DEFAULT_CONFIG, ...config };
  const systemMsgs = messages.filter((m) => m.role === "system").map((m) => m.content);
  const nonSystem = messages.filter((m) => m.role !== "system");

  const anthropicMessages = nonSystem.map((m) => {
    if (m.role === "assistant" && m.toolCall) {
      const blocks: unknown[] = [];
      if (m.content && m.content.length > 0) {
        blocks.push({ type: "text", text: m.content });
      }
      blocks.push({
        type: "tool_use",
        id: m.toolCall.id,
        name: m.toolCall.name,
        input: safeParseJson(m.toolCall.argsJson),
      });
      return { role: "assistant", content: blocks };
    }
    if (m.role === "user" && m.toolCallId) {
      return {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: m.toolCallId, content: m.content },
        ],
      };
    }
    return { role: m.role, content: m.content };
  });

  return withRetry(async () => {
    const data = await postJson<{ content?: AnthropicToolBlock[] }>(
      "https://api.anthropic.com/v1/messages",
      {
        model,
        system: systemMsgs.join("\n\n") || undefined,
        messages: anthropicMessages,
        tools: tools.map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: t.parameters,
        })),
        max_tokens: c.maxTokens,
        temperature: c.temperature,
      },
      {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      }
    );

    let text = "";
    let toolCall: NativeAssistantResponse["toolCall"] = null;
    for (const block of data.content ?? []) {
      if (block.type === "text") {
        text += block.text ?? "";
      } else if (block.type === "tool_use" && block.id && block.name) {
        toolCall = {
          id: block.id,
          name: block.name,
          argsJson: JSON.stringify(block.input ?? {}),
        };
      }
    }
    return { text, toolCall };
  });
}

function safeParseJson(s: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(s);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
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

  generateWithTools(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    config?: GenerationConfig
  ): Promise<NativeAssistantResponse> {
    return openAICompatGenerateWithTools(
      "https://api.openai.com/v1",
      this.apiKey,
      this.model,
      messages,
      tools,
      config
    );
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

  generateWithTools(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    config?: GenerationConfig
  ): Promise<NativeAssistantResponse> {
    return anthropicGenerateWithTools(this.apiKey, this.model, messages, tools, config);
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

  generateWithTools(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    config?: GenerationConfig
  ): Promise<NativeAssistantResponse> {
    return openAICompatGenerateWithTools(
      "https://api.mistral.ai/v1",
      this.apiKey,
      this.model,
      messages,
      tools,
      config
    );
  }
}

// ────────────────────────────────────────────────────────────────────
// DeepSeek — OpenAI-compatible API hosted at api.deepseek.com.
// Common models: `deepseek-chat` (V3), `deepseek-coder` (legacy code
// specialist), `deepseek-reasoner` (R1, with chain-of-thought).
// ────────────────────────────────────────────────────────────────────

class DeepSeekBackend implements Backend {
  readonly spec: string;
  private readonly apiKey: string;

  constructor(private readonly model: string) {
    this.spec = `deepseek:${model}`;
    this.apiKey = requireEnv(
      "DEEPSEEK_API_KEY",
      "Set it in your shell, e.g. `export DEEPSEEK_API_KEY=sk-...`. " +
        "Get a key from https://platform.deepseek.com/api_keys."
    );
  }

  async generate(messages: ChatMessage[], config?: GenerationConfig): Promise<string> {
    const c = { ...DEFAULT_CONFIG, ...config };
    return withRetry(async () => {
      const data = await postJson<{ choices: { message: { content: string } }[] }>(
        "https://api.deepseek.com/v1/chat/completions",
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

  generateWithTools(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    config?: GenerationConfig
  ): Promise<NativeAssistantResponse> {
    return openAICompatGenerateWithTools(
      "https://api.deepseek.com/v1",
      this.apiKey,
      this.model,
      messages,
      tools,
      config
    );
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
