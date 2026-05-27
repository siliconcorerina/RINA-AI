/**
 * Shared types for the agent loop.
 *
 * Kept tiny on purpose — the agent's contract with the model is just
 * "emit a JSON tool call, get a string result back, iterate". Anything
 * more elaborate (streaming, multi-tool parallel calls, native function-
 * calling) is intentionally out of scope for the v0 MVP.
 */

export type ToolName = "read_file" | "write_file" | "list_files" | "shell" | "finish";

export interface ToolCall {
  tool: ToolName;
  args: Record<string, unknown>;
}

export interface ToolResult {
  /**
   * Whether the tool ran without throwing. A `false` here is shown to the
   * model as an error so it can self-correct on the next turn — we
   * deliberately don't abort the whole agent on a single failed tool.
   */
  ok: boolean;
  /**
   * String content surfaced back to the model. Big outputs are truncated
   * upstream so a stray `cat huge_file.log` doesn't blow the context.
   */
  output: string;
}

/**
 * The full agent configuration. Everything is required at the type level
 * so the CLI has to provide defaults explicitly rather than relying on
 * scattered `?? defaultX` calls deep in the loop.
 */
export interface AgentConfig {
  /** Backend spec, e.g. `deepseek:deepseek-chat`. */
  backendSpec: string;
  /** Working directory the agent is scoped to. Reads/writes outside this
   *  path are rejected by the safety layer. */
  workdir: string;
  /** Hard cap on tool-use iterations. Default 25. */
  maxSteps: number;
  /** Soft cap on total response tokens across the session. Default 100_000. */
  tokenBudget: number;
  /** Skip interactive shell-command confirmation. Use with extreme care. */
  yolo: boolean;
  /** Reject any write_file / shell tool call up-front. */
  readOnly: boolean;
  /** System-prompt language, "en" or "fr". */
  language: "en" | "fr";
  /** Per-call generation knobs forwarded to the backend. */
  maxTokens: number;
  temperature: number;
}

export interface AgentResult {
  /** "finished" if the model called `finish`, "exhausted" if step/budget cap hit. */
  status: "finished" | "exhausted" | "aborted";
  /** The summary the model passed to `finish`, or a reason string otherwise. */
  summary: string;
  /** Number of tool-use steps the agent ran. */
  steps: number;
  /** Best-effort estimate of response tokens consumed. */
  tokensUsed: number;
}
