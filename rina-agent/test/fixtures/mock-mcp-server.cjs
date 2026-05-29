#!/usr/bin/env node
/**
 * Minimal MCP server used by test/mcp.test.ts.
 *
 * Speaks the stdio transport (newline-delimited JSON-RPC 2.0) just well
 * enough to exercise McpStdioClient / McpHub end-to-end without any
 * network or third-party server. Plain CommonJS so it runs under `node`
 * regardless of the package's module type.
 *
 * Tools exposed:
 *   - echo({ text })       → returns text
 *   - add({ a, b })        → returns a + b
 *   - "ns.weird/name"()    → returns "weird-ok" (tests name sanitising)
 *   - boom()               → returns an isError result
 */

"use strict";

const TOOLS = [
  {
    name: "echo",
    description: "Echo the given text back.",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    },
  },
  {
    name: "add",
    description: "Add two numbers.",
    inputSchema: {
      type: "object",
      properties: { a: { type: "number" }, b: { type: "number" } },
      required: ["a", "b"],
    },
  },
  {
    name: "ns.weird/name",
    description: "Tool whose name needs sanitising.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "boom",
    description: "Always returns an error result.",
    inputSchema: { type: "object", properties: {} },
  },
];

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function handle(msg) {
  // Notifications carry no id and need no response.
  if (typeof msg.id !== "number") {
    return;
  }
  const reply = (result) => send({ jsonrpc: "2.0", id: msg.id, result });
  const fail = (code, message) => send({ jsonrpc: "2.0", id: msg.id, error: { code, message } });

  switch (msg.method) {
    case "initialize":
      reply({
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "mock-mcp-server", version: "0.0.0" },
      });
      return;
    case "tools/list":
      reply({ tools: TOOLS });
      return;
    case "tools/call": {
      const params = msg.params || {};
      const name = params.name;
      const args = params.arguments || {};
      if (name === "echo") {
        reply({ content: [{ type: "text", text: String(args.text) }] });
      } else if (name === "add") {
        reply({ content: [{ type: "text", text: String(Number(args.a) + Number(args.b)) }] });
      } else if (name === "ns.weird/name") {
        reply({ content: [{ type: "text", text: "weird-ok" }] });
      } else if (name === "boom") {
        reply({ content: [{ type: "text", text: "this tool failed" }], isError: true });
      } else {
        fail(-32602, `unknown tool '${name}'`);
      }
      return;
    }
    default:
      fail(-32601, `method not found: ${msg.method}`);
  }
}

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let idx;
  while ((idx = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) {
      continue;
    }
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    handle(msg);
  }
});
process.stdin.on("end", () => process.exit(0));
