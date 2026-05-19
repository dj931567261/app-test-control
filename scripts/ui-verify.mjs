#!/usr/bin/env node
// One-shot real-device verifier for ui-mcp: dumps hierarchy and runs a couple
// of find_element / find_elements queries against the live device.
//
// Usage:  node scripts/ui-verify.mjs [device-serial]

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.resolve(__dirname, "..", "mcp-servers", "ui-mcp", "dist", "index.js");
const device = process.argv[2];

const proc = spawn("node", [SERVER], { stdio: ["pipe", "pipe", "pipe"] });
let buf = "";
let stderr = "";
const pending = new Map();
let nextId = 1;

proc.stderr.on("data", (b) => { stderr += b.toString(); });
proc.stdout.on("data", (chunk) => {
  buf += chunk.toString();
  let i;
  while ((i = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.id !== undefined && pending.has(msg.id)) {
        const { resolve } = pending.get(msg.id);
        pending.delete(msg.id);
        resolve(msg);
      }
    } catch { /* ignore */ }
  }
});

function rpc(method, params) {
  const id = nextId++;
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve });
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`timeout: ${method}`));
      }
    }, 30_000);
  });
}

function notify(method, params) {
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
}

function call(tool, args) {
  return rpc("tools/call", { name: tool, arguments: args });
}

function parseToolResult(r) {
  if (r.error) throw new Error(`tool error: ${JSON.stringify(r.error)}`);
  const text = r.result?.content?.[0]?.text;
  if (!text) throw new Error("no text content");
  return JSON.parse(text);
}

try {
  await rpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "ui-verify", version: "0.1.0" },
  });
  notify("notifications/initialized", {});

  console.log("1. dump_hierarchy");
  const dump = parseToolResult(
    await call("dump_hierarchy", device ? { device, include_xml: false } : { include_xml: false }),
  );
  console.log(`   device=${dump.device}  rotation=${dump.rotation}  count=${dump.count}`);
  console.log(`   first 3 elements with text:`);
  const withText = dump.elements.filter((e) => e.text || e.content_desc).slice(0, 3);
  for (const e of withText) {
    console.log(`     - ${e.class}  text="${e.text}" id="${e.resource_id ?? ""}" center=${JSON.stringify(e.center)}`);
  }

  console.log("\n2. find_element by text='WLAN'");
  const find = parseToolResult(
    await call("find_element", {
      ...(device ? { device } : {}),
      strategies: [{ by: "text", value: "WLAN" }],
    }),
  );
  if (find.matched) {
    console.log(`   ✓ matched id=${find.element.resource_id ?? "(none)"} center=${JSON.stringify(find.element.center)}`);
  } else {
    console.log("   ✗ not found");
  }

  console.log("\n3. find_elements by class='android.widget.TextView'");
  const all = parseToolResult(
    await call("find_elements", {
      ...(device ? { device } : {}),
      strategy: { by: "class", value: "android.widget.TextView" },
    }),
  );
  console.log(`   ${all.count} TextViews on screen`);

  console.log("\n4. page_fingerprint");
  const fp = parseToolResult(
    await call("page_fingerprint", device ? { device } : {}),
  );
  console.log(`   hash=${fp.hash}  visible=${fp.visible_count}`);

  console.log("\n✅ ui-mcp real-device verification passed");
} catch (err) {
  console.error("✗", err.message);
  if (stderr) console.error("--- server stderr ---\n" + stderr);
  process.exitCode = 1;
} finally {
  proc.kill("SIGTERM");
}
