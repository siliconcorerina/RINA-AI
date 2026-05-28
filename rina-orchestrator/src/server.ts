#!/usr/bin/env node
/**
 * HTTP worker that exposes the orchestrator over a single POST
 * endpoint streaming AgentEvents as Server-Sent Events.
 *
 * Why this exists: Vercel serverless can't run Playwright + Chromium
 * (binary too large, 60s timeout, no persistent connection). The
 * mobile app's /api/agent on Vercel proxies through to this worker —
 * which runs anywhere with Node 18+, an internet connection, and
 * room to install ~300 MB of Chromium. Locally during dev that's a
 * laptop + cloudflared tunnel; in prod that's a Fly.io / Hetzner /
 * Railway VM.
 *
 * Endpoints:
 *   GET  /health   → 200 { ok: true, version }
 *   POST /run      → SSE stream of AgentEvents for the given goal
 *
 * Auth: optional shared secret. When the env var
 *   ORCHESTRATOR_WORKER_TOKEN is set, /run requires
 *   Authorization: Bearer <token>. Vercel's /api/agent forwards the
 *   same secret. Stops anyone who finds the tunnel URL from running
 *   browser tasks on your bandwidth.
 *
 * Backend: reuses the rina-agent Backend abstraction. Defaults to
 *   deepseek:deepseek-chat. Override via the BACKEND env var
 *   (e.g. BACKEND=anthropic:claude-3-5-haiku-latest).
 */

import http from "node:http";

import { backendFromSpec } from "@siliconcorerina/rina-agent/out/backend.js";

import { runGoal, RunFailedError } from "./core/orchestrator.js";
import type { AgentEvent } from "./core/types.js";

const VERSION = "0.1.0";

interface ServerOptions {
  port: number;
  backendSpec: string;
  headless: boolean;
  maxSteps: number;
  token: string | null;
}

function parseEnv(): ServerOptions {
  const port = parseIntEnv(process.env.PORT, 8787);
  const backendSpec = process.env.BACKEND?.trim() || "deepseek:deepseek-chat";
  const headless = process.env.HEADLESS !== "false"; // default headless
  const maxSteps = parseIntEnv(process.env.MAX_STEPS, 6);
  const token = process.env.ORCHESTRATOR_WORKER_TOKEN?.trim() || null;
  return { port, backendSpec, headless, maxSteps, token };
}

function parseIntEnv(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

async function main() {
  const opts = parseEnv();

  // Fail fast: try instantiating the backend so a bad BACKEND spec
  // crashes BEFORE the server starts accepting requests.
  try {
    backendFromSpec(opts.backendSpec);
  } catch (err) {
    console.error(`[rina-orchestrator-serve] ${(err as Error).message}`);
    process.exit(2);
  }

  const server = http.createServer((req, res) => handle(req, res, opts));

  // Long-lived requests (the SSE stream) on Node's default 2-minute
  // timeout get killed mid-flight. Raise to 10 minutes — enough for
  // a 6-step browser task with retries.
  server.requestTimeout = 10 * 60 * 1000;
  server.headersTimeout = 10 * 60 * 1000;

  server.listen(opts.port, () => {
    process.stdout.write(
      `🤖 rina-orchestrator-serve v${VERSION} listening on http://localhost:${opts.port}\n` +
        `   backend: ${opts.backendSpec}\n` +
        `   headless: ${opts.headless}\n` +
        `   maxSteps: ${opts.maxSteps}\n` +
        `   auth: ${opts.token ? "Bearer token required" : "OPEN (no token set)"}\n\n` +
        `   Test: curl -N -X POST http://localhost:${opts.port}/run \\\n` +
        `         -H "Content-Type: application/json" \\\n` +
        `         -d '{"goal":"What is on example.com today"}'\n`
    );
  });

  const shutdown = (signal: string) => {
    process.stdout.write(`\n[${signal}] shutting down…\n`);
    server.close(() => process.exit(0));
    // Hard kill if connections refuse to drain in 5s.
    setTimeout(() => process.exit(1), 5_000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

function handle(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  opts: ServerOptions
): void {
  // CORS — open. Same posture as /api/agent on Vercel: the secret
  // (if set) is what protects the worker, not the origin allowlist.
  const origin = req.headers.origin;
  if (origin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  } else {
    res.setHeader("Access-Control-Allow-Origin", "*");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, Accept"
  );
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return;
  }

  if (req.method === "GET" && req.url === "/health") {
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ ok: true, version: VERSION }));
    return;
  }

  if (req.method !== "POST" || req.url !== "/run") {
    res.statusCode = 404;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "Not found." }));
    return;
  }

  // Auth check.
  if (opts.token) {
    const auth = req.headers.authorization ?? "";
    const expected = `Bearer ${opts.token}`;
    if (auth !== expected) {
      res.statusCode = 401;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "Unauthorized." }));
      return;
    }
  }

  // Read body.
  let body = "";
  req.setEncoding("utf8");
  req.on("data", (chunk) => {
    body += chunk;
    if (body.length > 8 * 1024) {
      // Goal payloads are tiny. >8KB is either abuse or a bug;
      // either way no point letting it grow.
      req.destroy();
    }
  });
  req.on("end", () => {
    void executeRun(body, req, res, opts);
  });
}

async function executeRun(
  body: string,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  opts: ServerOptions
): Promise<void> {
  let goal: string;
  try {
    const parsed = JSON.parse(body) as { goal?: unknown };
    if (typeof parsed.goal !== "string" || parsed.goal.trim().length === 0) {
      throw new Error("`goal` (non-empty string) required.");
    }
    goal = parsed.goal.trim();
  } catch (err) {
    res.statusCode = 400;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: (err as Error).message }));
    return;
  }

  // SSE headers.
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();

  // Heartbeat so intermediaries (Cloudflare, Vercel) don't kill the
  // idle connection between an LLM call and the next event. 15s is
  // shorter than most reverse-proxy idle timeouts.
  const heartbeat = setInterval(() => {
    try {
      res.write(": heartbeat\n\n");
    } catch {
      /* socket closed — clearInterval below handles cleanup */
    }
  }, 15_000);

  let clientClosed = false;
  req.on("close", () => {
    clientClosed = true;
  });

  const backend = backendFromSpec(opts.backendSpec);

  try {
    await runGoal(backend, goal, {
      browser: { headless: opts.headless },
      maxSteps: opts.maxSteps,
      onEvent: (event: AgentEvent) => {
        if (clientClosed) return;
        try {
          res.write(`event: ${event.type}\n`);
          res.write(`data: ${JSON.stringify(event)}\n\n`);
        } catch {
          // Socket died between the close listener firing and now —
          // mark as closed so subsequent events bail.
          clientClosed = true;
        }
      },
    });
  } catch (err) {
    if (!clientClosed) {
      const message =
        err instanceof RunFailedError || err instanceof Error
          ? err.message
          : String(err);
      try {
        res.write(`event: run_failed\n`);
        res.write(`data: ${JSON.stringify({ type: "run_failed", error: message })}\n\n`);
      } catch {
        /* nothing to do */
      }
    }
  } finally {
    clearInterval(heartbeat);
    try {
      res.end();
    } catch {
      /* already ended */
    }
  }
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${(err as Error).stack ?? err}\n`);
  process.exit(1);
});
