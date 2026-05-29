/**
 * Orchestrator — the top-level entry point that ties everything
 * together. One call: `runGoal(backend, "do X")`, returns the final
 * summary + the full event log (for downstream rendering).
 *
 * Flow:
 *   1. Planner.planGoal()      → Plan
 *   2. StateManager.setPlan()  → plan_created event
 *   3. Dispatcher.runPlan()    → step_* events
 *   4. Summarise final results → run_completed
 *
 * The orchestrator is the ONLY place that knows about the full set
 * of sub-agents. Higher-level integrations (CLI, future HTTP API,
 * future mobile bridge) call orchestrator.run() and consume the
 * event stream — they don't need to know the planner exists.
 */

import type { Backend, ToolDefinition } from "@siliconcorerina/rina-agent/out/backend.js";
import { McpHub, loadMcpConfig, type McpConfig } from "@siliconcorerina/rina-agent/out/mcp.js";

import { BrowserAgent, type BrowserAgentOptions } from "../agents/browser/browser-agent.js";
import { ConnectorAgent } from "../agents/connector/connector-agent.js";
import { Dispatcher } from "./dispatcher.js";
import { planGoal } from "./planner.js";
import { StateManager } from "./state.js";
import type { AgentEvent, EventListener, Plan } from "./types.js";

export interface RunGoalOptions {
  /** Optional listener for the live event stream. Same as subscribing
   *  via `state.subscribe()` but more convenient for one-shot calls. */
  onEvent?: EventListener;
  /** Forwarded to the browser sub-agent. */
  browser?: BrowserAgentOptions;
  /** Cap on planner step count. Defaults to 6. */
  maxSteps?: number;
  /**
   * Optional path to an MCP connector config (`.mcp.json`). When given
   * (or when one is auto-detected at `<workdir>/.mcp.json`), the
   * orchestrator connects to the declared servers, registers a
   * ConnectorAgent, and lets the planner route steps to it. Absent /
   * no servers connected → behaves exactly as before.
   */
  mcpConfigPath?: string;
  /**
   * Inline MCP config built per-request — e.g. an HTTP server assembling
   * a config from the calling user's connected connectors. Takes
   * precedence over `mcpConfigPath` and `.mcp.json` auto-detection. When
   * it declares no servers it's ignored (falls back to path/auto-detect).
   *
   * Security note: the caller is trusted to construct `command`/`args`
   * from a curated server-side registry — never from raw end-user input,
   * since each server is spawned as a child process on the worker.
   */
  mcpConfig?: McpConfig;
  /** Base dir for auto-detecting `.mcp.json` + resolving relative
   *  `mcpConfigPath`. Defaults to `process.cwd()`. */
  workdir?: string;
  /** Diagnostic sink for MCP connect/skip lines. Defaults to no-op. */
  onLog?: (message: string) => void;
}

export interface RunResult {
  plan: Plan;
  /** The final summary (last step's result or a synthesised wrap-up). */
  summary: string;
  /** Full event log for later rendering / archival. */
  events: AgentEvent[];
}

/**
 * Run a goal end-to-end. Always tears down the browser sub-agent on
 * exit, even on failure — Playwright holding a Chromium process
 * open is exactly the kind of leak that bites you in production.
 */
export async function runGoal(
  backend: Backend,
  goal: string,
  options: RunGoalOptions = {}
): Promise<RunResult> {
  const state = new StateManager();
  if (options.onEvent) state.subscribe(options.onEvent);

  // Connect MCP servers (if any configured). Resolution order:
  //   1. inline `mcpConfig` (per-request, e.g. from the HTTP server) — but
  //      only when it actually declares ≥1 server;
  //   2. otherwise `mcpConfigPath` / auto-detected `.mcp.json`.
  // loadMcpConfig throws on a bad/missing EXPLICIT path — and it runs
  // before anything is spawned, so a config error aborts cleanly with
  // nothing to tear down. The inline path bypasses that file lookup.
  const inlineConfig =
    options.mcpConfig && Object.keys(options.mcpConfig.mcpServers ?? {}).length > 0
      ? options.mcpConfig
      : null;
  const loaded = inlineConfig
    ? null
    : loadMcpConfig(options.mcpConfigPath, options.workdir ?? process.cwd());
  const config = inlineConfig ?? loaded?.config ?? null;
  const hub = config ? await McpHub.create(config, options.onLog ?? (() => {})) : null;

  const dispatcher = new Dispatcher();
  dispatcher.register(new BrowserAgent(backend, options.browser));

  // Register the connector sub-agent + expose its tools to the planner
  // only when at least one MCP tool actually connected. With none, the
  // planner is never told "connector" exists → identical to before.
  let connectorTools: ToolDefinition[] = [];
  if (hub && hub.toolCount() > 0) {
    dispatcher.register(new ConnectorAgent(backend, hub));
    connectorTools = hub.getToolDefinitions();
    options.onLog?.(
      `[rina-orchestrator] mcp: ${hub.toolCount()} tool(s) from ` +
        `${hub.serverCount()} server(s) available to the planner`
    );
  }

  try {
    // Phase 1 — planning.
    const plan = await planGoal(backend, goal, {
      maxSteps: options.maxSteps,
      connectorTools,
    });
    state.setPlan(plan);

    // Phase 2 — dispatch.
    const results = await dispatcher.runPlan(state, plan);

    // Phase 3 — summary. v0.1 just returns the last step's result as
    // the run summary. A future version can ask the LLM to
    // synthesise across step results.
    const summary = results[results.length - 1] ?? "(no results)";
    state.markRunCompleted(summary);

    return { plan, summary, events: state.events() };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    state.markRunFailed(message);
    // Re-throw so callers can decide how loud to fail. Events log
    // still contains the partial trace via state.events() — but we
    // also re-package it in the error for convenience.
    const wrapped = new RunFailedError(message, state.events());
    throw wrapped;
  } finally {
    await dispatcher.shutdown();
    if (hub) await hub.closeAll();
  }
}

export class RunFailedError extends Error {
  constructor(message: string, public events: AgentEvent[]) {
    super(message);
    this.name = "RunFailedError";
  }
}
