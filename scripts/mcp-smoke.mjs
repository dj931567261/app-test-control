#!/usr/bin/env node
// Boots a built MCP server over stdio and exchanges initialize + tools/list.
// Verifies the server starts, completes handshake, and lists expected tools.
//
// Usage:
//   node scripts/mcp-smoke.mjs <path-to-dist-index.js> [expectedTool1,expectedTool2,...]

import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const [, , serverPath, expectedToolsCsv] = process.argv;
if (!serverPath) {
  console.error("Usage: mcp-smoke.mjs <path-to-dist-index.js> [tool1,tool2,...]");
  process.exit(2);
}

const expectedTools = (expectedToolsCsv ?? "").split(",").map((s) => s.trim()).filter(Boolean);

const proc = spawn("node", [serverPath], {
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env, APP_TEST_CTRL_WORKSPACE: process.env.APP_TEST_CTRL_WORKSPACE ?? "/tmp/atc-smoke" },
});

let stderr = "";
proc.stderr.on("data", (b) => { stderr += b.toString(); });
proc.on("error", (e) => {
  console.error("spawn error:", e);
  process.exit(1);
});

let buf = "";
const pending = new Map();
let nextId = 1;

proc.stdout.on("data", (chunk) => {
  buf += chunk.toString();
  // MCP over stdio uses LSP-style framing: Content-Length: N\r\n\r\n<json>
  // OR plain newline-delimited JSON depending on transport. The SDK uses
  // newline-delimited JSON for StdioServerTransport. Parse line-by-line.
  let idx;
  while ((idx = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.id !== undefined && pending.has(msg.id)) {
        const { resolve } = pending.get(msg.id);
        pending.delete(msg.id);
        resolve(msg);
      }
    } catch {
      // not JSON, ignore (could be log noise)
    }
  }
});

function send(method, params) {
  const id = nextId++;
  const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
  proc.stdin.write(payload);
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve });
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`Timeout waiting for response to ${method} (id=${id})`));
      }
    }, 5_000);
  });
}

function notify(method, params) {
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
}

try {
  // 1. initialize handshake
  const init = await send("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "mcp-smoke", version: "0.1.0" },
  });
  if (!init.result) throw new Error("initialize returned no result");

  notify("notifications/initialized", {});
  await delay(50);

  // 2. tools/list
  const list = await send("tools/list", {});
  const tools = list.result?.tools ?? [];
  const names = tools.map((t) => t.name).sort();
  console.log(`✓ Server booted: ${serverPath}`);
  console.log(`  protocol=${init.result.protocolVersion ?? "?"}  server=${init.result.serverInfo?.name ?? "?"}@${init.result.serverInfo?.version ?? "?"}`);
  console.log(`  tools (${names.length}): ${names.join(", ")}`);

  if (expectedTools.length > 0) {
    const missing = expectedTools.filter((t) => !names.includes(t));
    if (missing.length > 0) {
      console.error(`✗ Missing expected tools: ${missing.join(", ")}`);
      process.exitCode = 1;
    } else {
      console.log(`✓ All ${expectedTools.length} expected tools present`);
    }
  }
} catch (err) {
  console.error("✗ Smoke test failed:", err.message);
  if (stderr) console.error("--- server stderr ---\n" + stderr);
  process.exitCode = 1;
} finally {
  proc.kill("SIGTERM");
}
