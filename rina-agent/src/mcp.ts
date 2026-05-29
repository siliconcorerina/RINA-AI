/**
 * MCP (Model Context Protocol) connector support.
 *
 * Lets the agent connect to external MCP servers — Gmail, Slack, Notion,
 * Drive, a database, your own internal tools — discover the tools they
 * expose, and call them inside the same agent loop as the built-ins.
 * This is the "connecteurs à la Manus" capability: RINA *consumes* MCP.
 *
 * Design constraints, same as the rest of this package:
 *   - Zero runtime dependencies. We hand-roll the JSON-RPC framing over
 *     a spawned child process rather than pulling @modelcontextprotocol/sdk.
 *     The stdio transport is just newline-delimited JSON-RPC 2.0 — ~200
 *     lines, fully auditable, and it keeps `npm i` instant.
 *   - CommonJS / Node16. Only node built-ins (child_process, fs, path).
 *
 * Transport scope: stdio only for v0.4. That's the dominant connector
 * shape — virtually every published server is launched via
 * `npx -y @scope/mcp-server …` or a local binary. Remote HTTP/SSE
 * transports can slot in later behind the same McpClient surface
 * (listTools / callTool / close).
 *
 * Tool namespacing: a server's tool `send_email` becomes
 * `mcp__<server>__send_email` so it can never collide with a built-in
 * (read_file, shell, …) and the loop can tell at dispatch time whether a
 * call should be routed to a built-in or to an MCP server. The reverse
 * lookup (namespaced name → which client + original tool name) lives in
 * the hub.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

import type { ToolDefinition } from "./backend.js";
import type { ToolResult } from "./types.js";

// ─────────────────────────────────────────────────────────────────────
// Config (.mcp.json)
// ─────────────────────────────────────────────────────────────────────

export interface McpServerConfig {
  /** Executable to spawn, e.g. "npx" or "node" or an absolute path. */
  command: string;
  /** Arguments, e.g. ["-y", "@modelcontextprotocol/server-filesystem", "."]. */
  args?: string[];
  /** Extra env vars merged over process.env for the child (secrets, etc.). */
  env?: Record<string, string>;
}

export interface McpConfig {
  /** Keyed by a short server name the user picks; becomes the namespace. */
  mcpServers: Record<string, McpServerConfig>;
}

/**
 * Locate + parse the MCP config.
 *
 *   - `explicitPath` given (via --mcp-config): must exist, else throw.
 *   - otherwise: auto-detect `<workdir>/.mcp.json`. Absent → null (no MCP).
 *
 * `${VAR}` references inside `args` and `env` values are expanded from
 * the parent process env, so secrets can live in the shell rather than
 * checked into `.mcp.json`.
 */
export function loadMcpConfig(
  explicitPath: string | undefined,
  workdir: string
): { config: McpConfig; path: string } | null {
  let path: string | null = null;
  if (explicitPath && explicitPath.length > 0) {
    path = isAbsolute(explicitPath) ? explicitPath : resolve(workdir, explicitPath);
    if (!existsSync(path)) {
      throw new Error(`--mcp-config: no file at ${path}`);
    }
  } else {
    const candidate = join(workdir, ".mcp.json");
    if (existsSync(candidate)) {
      path = candidate;
    }
  }
  if (!path) {
    return null;
  }

  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    throw new Error(`Could not read MCP config ${path}: ${(err as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Invalid JSON in MCP config ${path}: ${(err as Error).message}`);
  }
  return { config: normalizeConfig(parsed, path), path };
}

function normalizeConfig(parsed: unknown, path: string): McpConfig {
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`MCP config ${path} must be a JSON object.`);
  }
  const servers = (parsed as { mcpServers?: unknown }).mcpServers;
  if (!servers || typeof servers !== "object") {
    throw new Error(`MCP config ${path} must contain an "mcpServers" object.`);
  }
  const out: Record<string, McpServerConfig> = {};
  for (const name of Object.keys(servers as Record<string, unknown>)) {
    const s = (servers as Record<string, unknown>)[name] as {
      command?: unknown;
      args?: unknown;
      env?: unknown;
    };
    if (!s || typeof s !== "object" || typeof s.command !== "string" || s.command.length === 0) {
      throw new Error(`MCP server '${name}' in ${path} needs a non-empty "command" string.`);
    }
    const args = Array.isArray(s.args) ? s.args.map((a) => expandEnv(String(a))) : undefined;
    let env: Record<string, string> | undefined;
    if (s.env && typeof s.env === "object") {
      env = {};
      for (const k of Object.keys(s.env as Record<string, unknown>)) {
        env[k] = expandEnv(String((s.env as Record<string, unknown>)[k]));
      }
    }
    out[name] = { command: s.command, args, env };
  }
  if (Object.keys(out).length === 0) {
    throw new Error(`MCP config ${path} declares no servers.`);
  }
  return { mcpServers: out };
}

function expandEnv(value: string): string {
  return value.replace(/\$\{([A-Za-z0-9_]+)\}/g, (_m, name: string) => process.env[name] ?? "");
}

// ─────────────────────────────────────────────────────────────────────
// JSON-RPC 2.0 shapes (the subset MCP uses)
// ─────────────────────────────────────────────────────────────────────

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface McpToolSpec {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

interface McpContentBlock {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
  resource?: { uri?: string; text?: string };
}

export interface McpCallResult {
  content?: McpContentBlock[];
  isError?: boolean;
}

const PROTOCOL_VERSION = "2024-11-05";
const REQUEST_TIMEOUT_MS = 30_000;
const INIT_TIMEOUT_MS = 20_000;
const STDERR_TAIL_LIMIT = 4096;

// ─────────────────────────────────────────────────────────────────────
// McpStdioClient — one spawned server, framed JSON-RPC over stdio
// ─────────────────────────────────────────────────────────────────────

export class McpStdioClient {
  private proc: ChildProcess | null = null;
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
  >();
  private stdoutBuf = "";
  private stderrTail = "";
  private closed = false;
  private spawnError: Error | null = null;

  constructor(
    public readonly name: string,
    private readonly cfg: McpServerConfig
  ) {}

  /** Spawn the server and perform the MCP initialize handshake. */
  async start(): Promise<void> {
    const isWin = process.platform === "win32";
    // npx / npm / yarn are .cmd shims on Windows and can't be spawned
    // directly — they need the shell. Real binaries (node.exe, an .exe
    // path) are spawned without a shell to avoid quoting surprises.
    const useShell = isWin && !/\.exe"?$/i.test(this.cfg.command);
    const rawArgs = this.cfg.args ?? [];
    const args = useShell ? rawArgs.map((a) => quoteForShell(a)) : rawArgs;

    const child = spawn(this.cfg.command, args, {
      env: { ...process.env, ...(this.cfg.env ?? {}) },
      stdio: ["pipe", "pipe", "pipe"],
      shell: useShell,
      windowsHide: true,
    });
    this.proc = child;

    child.on("error", (err) => {
      this.spawnError = err;
      this.closed = true;
      this.failAllPending(err);
    });
    child.on("exit", (code, signal) => {
      this.closed = true;
      const tail = this.stderrTail.trim();
      this.failAllPending(
        new Error(
          `MCP server '${this.name}' exited (code ${code ?? "null"}, signal ${signal ?? "null"})` +
            (tail ? `: ${tail.slice(-500)}` : "")
        )
      );
    });

    if (child.stdout) {
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => this.onStdout(chunk));
    }
    if (child.stderr) {
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        this.stderrTail = (this.stderrTail + chunk).slice(-STDERR_TAIL_LIMIT);
      });
    }

    // Handshake: initialize → (result) → notifications/initialized.
    await this.request(
      "initialize",
      {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "rina-agent", version: "0.4.0" },
      },
      INIT_TIMEOUT_MS
    );
    this.notify("notifications/initialized");
  }

  /** Ask the server for the tools it exposes. */
  async listTools(): Promise<McpToolSpec[]> {
    const result = (await this.request("tools/list", {})) as { tools?: McpToolSpec[] };
    return Array.isArray(result?.tools) ? result.tools : [];
  }

  /** Invoke a tool by its server-native name. */
  async callTool(name: string, args: Record<string, unknown>): Promise<McpCallResult> {
    return (await this.request("tools/call", {
      name,
      arguments: args ?? {},
    })) as McpCallResult;
  }

  /** Terminate the child and reject anything still in flight. */
  async close(): Promise<void> {
    if (this.closed && !this.proc) {
      return;
    }
    this.closed = true;
    this.failAllPending(new Error(`MCP server '${this.name}' closed`));
    const child = this.proc;
    this.proc = null;
    if (!child) {
      return;
    }
    try {
      child.stdin?.end();
    } catch {
      /* already gone */
    }
    child.kill();
  }

  // ── internals ──────────────────────────────────────────────────────

  private onStdout(chunk: string): void {
    this.stdoutBuf += chunk;
    let idx: number;
    // Messages are newline-delimited. A server that misbehaves and logs
    // plain text to stdout (it should use stderr) just produces lines we
    // can't parse — we skip those rather than crash.
    while ((idx = this.stdoutBuf.indexOf("\n")) !== -1) {
      const line = this.stdoutBuf.slice(0, idx).trim();
      this.stdoutBuf = this.stdoutBuf.slice(idx + 1);
      if (!line) {
        continue;
      }
      let msg: unknown;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      this.onMessage(msg as JsonRpcResponse & { method?: string });
    }
  }

  private onMessage(msg: JsonRpcResponse & { method?: string }): void {
    // Response to one of our requests.
    if (msg && typeof msg.id === "number" && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id)!;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) {
        p.reject(
          new Error(`MCP '${this.name}': ${msg.error.message} (code ${msg.error.code})`)
        );
      } else {
        p.resolve(msg.result);
      }
      return;
    }
    // A request *from* the server (sampling, roots/list, …). We don't
    // implement those capabilities; reply with "method not found" so the
    // server doesn't hang waiting. Notifications (no id) are ignored.
    if (msg && typeof msg.id === "number" && typeof msg.method === "string") {
      this.write({
        jsonrpc: "2.0",
        id: msg.id,
        error: { code: -32601, message: "Method not found" },
      });
    }
  }

  private request(method: string, params: unknown, timeoutMs = REQUEST_TIMEOUT_MS): Promise<unknown> {
    const id = this.nextId++;
    return new Promise<unknown>((resolveP, rejectP) => {
      if (this.spawnError) {
        rejectP(this.spawnError);
        return;
      }
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectP(new Error(`MCP '${this.name}': '${method}' timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      if (typeof timer.unref === "function") {
        timer.unref();
      }
      this.pending.set(id, { resolve: resolveP, reject: rejectP, timer });
      try {
        this.write({ jsonrpc: "2.0", id, method, params });
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        rejectP(err as Error);
      }
    });
  }

  private notify(method: string, params?: unknown): void {
    try {
      this.write({ jsonrpc: "2.0", method, params });
    } catch {
      /* best-effort; a dead pipe will surface on the next request */
    }
  }

  private write(obj: unknown): void {
    const proc = this.proc;
    if (!proc || !proc.stdin || this.closed) {
      throw new Error(`MCP server '${this.name}' is not running`);
    }
    proc.stdin.write(JSON.stringify(obj) + "\n");
  }

  private failAllPending(err: Error): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }
}

/** Quote an arg for a Windows `cmd.exe` shell spawn when it needs it. */
function quoteForShell(arg: string): string {
  if (!/[\s"^&|<>()%!]/.test(arg)) {
    return arg;
  }
  return `"${arg.replace(/"/g, '""')}"`;
}

// ─────────────────────────────────────────────────────────────────────
// McpHub — many servers, one namespaced tool surface
// ─────────────────────────────────────────────────────────────────────

interface RegisteredTool {
  client: McpStdioClient;
  toolName: string;
  def: ToolDefinition;
}

export class McpHub {
  private readonly clients: McpStdioClient[] = [];
  private readonly tools = new Map<string, RegisteredTool>();

  private constructor() {}

  /**
   * Spawn + initialize every configured server and collect their tools.
   * A server that fails to start is logged and skipped — one broken
   * connector must not take the whole agent down.
   */
  static async create(
    config: McpConfig,
    log: (msg: string) => void = () => {}
  ): Promise<McpHub> {
    const hub = new McpHub();
    for (const serverName of Object.keys(config.mcpServers)) {
      const client = new McpStdioClient(serverName, config.mcpServers[serverName]);
      try {
        await client.start();
        const specs = await client.listTools();
        hub.clients.push(client);
        for (const spec of specs) {
          if (!spec || typeof spec.name !== "string" || spec.name.length === 0) {
            continue;
          }
          const namespaced = hub.uniqueName(serverName, spec.name);
          hub.tools.set(namespaced, {
            client,
            toolName: spec.name,
            def: {
              name: namespaced,
              description: `[MCP:${serverName}] ${spec.description ?? spec.name}`,
              parameters: normalizeSchema(spec.inputSchema),
            },
          });
        }
        log(`[rina-agent] mcp: connected '${serverName}' (${specs.length} tool(s))`);
      } catch (err) {
        log(`[rina-agent] mcp: server '${serverName}' failed — ${(err as Error).message}`);
        await client.close();
      }
    }
    return hub;
  }

  /** Tool defs to merge alongside the built-ins for native function-calling. */
  getToolDefinitions(): ToolDefinition[] {
    return [...this.tools.values()].map((t) => t.def);
  }

  /** True if `name` is a connected MCP tool (i.e. should bypass runTool). */
  isMcpTool(name: string): boolean {
    return this.tools.has(name);
  }

  serverCount(): number {
    return this.clients.length;
  }

  toolCount(): number {
    return this.tools.size;
  }

  /** Route a namespaced call to its server and flatten the result to text. */
  async callTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    const reg = this.tools.get(name);
    if (!reg) {
      return { ok: false, output: `Unknown MCP tool '${name}'.` };
    }
    try {
      const result = await reg.client.callTool(reg.toolName, args ?? {});
      const text = flattenMcpContent(result);
      return { ok: result?.isError !== true, output: text.length > 0 ? text : "(no content)" };
    } catch (err) {
      return { ok: false, output: `MCP tool '${name}' failed: ${(err as Error).message}` };
    }
  }

  /** Kill every server. Always called from the agent loop's finally. */
  async closeAll(): Promise<void> {
    await Promise.all(this.clients.map((c) => c.close()));
    this.clients.length = 0;
    this.tools.clear();
  }

  private uniqueName(server: string, tool: string): string {
    const base = sanitizeToolName(`mcp__${server}__${tool}`);
    if (!this.tools.has(base)) {
      return base;
    }
    // Collision after sanitising/truncation — append a counter.
    let i = 2;
    let candidate = `${base.slice(0, 61)}_${i}`;
    while (this.tools.has(candidate)) {
      i += 1;
      candidate = `${base.slice(0, 61)}_${i}`;
    }
    return candidate;
  }
}

/**
 * Make a namespaced tool name safe for the provider function-call APIs,
 * which require names matching `^[A-Za-z0-9_-]{1,64}$`. Anything else in
 * a server's tool name (dots, slashes, spaces) becomes `_`.
 */
export function sanitizeToolName(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9_-]/g, "_");
  return cleaned.length <= 64 ? cleaned : cleaned.slice(0, 64);
}

function normalizeSchema(schema: unknown): Record<string, unknown> {
  if (schema && typeof schema === "object") {
    return schema as Record<string, unknown>;
  }
  // A tool with no declared schema still needs a valid object schema.
  return { type: "object", properties: {} };
}

/**
 * Collapse an MCP tool result's content blocks into the single string the
 * agent loop feeds back to the model. Text passes through; images and
 * embedded resources become a short placeholder (the model can't see
 * binary, and dumping base64 into the context is never useful).
 */
export function flattenMcpContent(result: McpCallResult | null | undefined): string {
  const blocks = result?.content ?? [];
  const parts: string[] = [];
  for (const b of blocks) {
    if (!b || typeof b !== "object") {
      continue;
    }
    if (b.type === "text") {
      parts.push(typeof b.text === "string" ? b.text : "");
    } else if (b.type === "image") {
      const bytes = typeof b.data === "string" ? Math.floor((b.data.length * 3) / 4) : 0;
      parts.push(`[image ${b.mimeType ?? "?"}, ~${bytes} bytes — not shown]`);
    } else if (b.type === "resource") {
      parts.push(`[resource ${b.resource?.uri ?? ""}]\n${b.resource?.text ?? ""}`.trim());
    } else {
      parts.push(`[${b.type}]`);
    }
  }
  return parts.join("\n").trim();
}

/**
 * Build a compact, human-readable tool catalogue for the prompt-based
 * path (the `<tool>{...}</tool>` flow). Native function-calling backends
 * get the JSON Schemas directly via getToolDefinitions() and don't need
 * this; this is the fallback so MCP tools are usable without
 * --native-tools too.
 */
export function describeMcpToolsForPrompt(defs: ToolDefinition[]): string {
  if (defs.length === 0) {
    return "";
  }
  return defs
    .map((d) => {
      const props =
        d.parameters && typeof d.parameters === "object"
          ? ((d.parameters as { properties?: Record<string, { type?: string }> }).properties ?? {})
          : {};
      const argList = Object.keys(props)
        .map((k) => `"${k}": ${props[k]?.type ?? "any"}`)
        .join(", ");
      return `- ${d.name}({ ${argList} })\n    ${d.description}`;
    })
    .join("\n");
}
