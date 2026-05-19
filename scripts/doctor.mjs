#!/usr/bin/env node
// app_test_ctrl 环境自检。
// 用法：node scripts/doctor.mjs  或  npm run doctor

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const RESET = "\x1b[0m";
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const GRAY = "\x1b[90m";
const BOLD = "\x1b[1m";

const checks = [];

/** kind: "ok" | "warn" | "fail" */
function add(kind, label, detail = "") {
  checks.push({ kind, label, detail });
}

async function run(cmd, args = [], opts = {}) {
  try {
    const { stdout } = await execFileAsync(cmd, args, { timeout: opts.timeoutMs ?? 5000, ...opts });
    return { ok: true, out: stdout.toString().trim() };
  } catch (err) {
    return { ok: false, out: "", err: err?.message ?? String(err) };
  }
}

async function exists(p) {
  try { await access(p); return true; } catch { return false; }
}

// 1. Node
{
  const major = parseInt(process.versions.node.split(".")[0], 10);
  if (major >= 20) {
    add("ok", `Node ${process.versions.node}`);
  } else {
    add("fail", `Node ${process.versions.node}`, "need ≥ 20");
  }
}

// 2. npm
{
  const r = await run("npm", ["--version"]);
  if (r.ok) {
    const major = parseInt(r.out.split(".")[0], 10);
    if (major >= 10) add("ok", `npm ${r.out}`);
    else add("warn", `npm ${r.out}`, "recommend ≥ 10 (workspaces)");
  } else {
    add("fail", "npm not found");
  }
}

// 3. adb (Android)
{
  const r = await run("adb", ["--version"]);
  if (r.ok) {
    const version = r.out.split("\n")[0]?.replace(/^Android Debug Bridge version /, "") ?? "?";
    add("ok", `adb ${version}`);
    const devs = await run("adb", ["devices"], { timeoutMs: 8000 });
    if (devs.ok) {
      const lines = devs.out.split("\n").slice(1).map(l => l.trim()).filter(Boolean);
      const online = lines.filter(l => l.endsWith("device"));
      if (online.length > 0) {
        add("ok", `Android devices: ${online.length} ready`, online.map(l => l.split(/\s+/)[0]).join(", "));
      } else {
        add("warn", "No Android devices ready", "start an emulator or plug a device (USB debug on)");
      }
    }
  } else {
    add("warn", "adb not found", "needed for Android; install Android SDK Platform Tools");
  }
}

// 4. xcrun simctl (iOS)
{
  const r = await run("xcrun", ["--version"]);
  if (r.ok) {
    add("ok", r.out);
    const sims = await run("xcrun", ["simctl", "list", "devices", "booted"]);
    if (sims.ok) {
      const booted = sims.out.split("\n").filter(l => l.includes("(Booted)"));
      if (booted.length > 0) {
        add("ok", `iOS simulators booted: ${booted.length}`, booted.map(l => l.trim().split(" (Booted)")[0]).join(" / "));
      } else {
        add("warn", "No iOS simulators booted", "iOS flows need a Booted simulator (xcrun simctl boot ...)");
      }
    }
  } else {
    add("warn", "xcrun not found", "needed for iOS support; install Xcode command line tools");
  }
}

// 5. MCP server builds
const SERVERS = ["log-mcp", "report-mcp", "ui-mcp", "analyzer-mcp"];
for (const s of SERVERS) {
  const distEntry = path.join(ROOT, "mcp-servers", s, "dist", "index.js");
  if (await exists(distEntry)) {
    const st = await stat(distEntry);
    add("ok", `mcp-servers/${s}/dist/index.js`, `${(st.size / 1024).toFixed(1)} KB`);
  } else {
    add("fail", `mcp-servers/${s}/dist/index.js missing`, "run `npm run build`");
  }
}

// 6. node_modules
if (await exists(path.join(ROOT, "node_modules"))) {
  add("ok", "node_modules present");
} else {
  add("fail", "node_modules missing", "run `npm install`");
}

// 7. .mcp.json
if (await exists(path.join(ROOT, ".mcp.json"))) {
  try {
    const j = JSON.parse(await readFile(path.join(ROOT, ".mcp.json"), "utf8"));
    const servers = Object.keys(j.mcpServers || {});
    add("ok", `.mcp.json present`, `${servers.length} servers: ${servers.join(", ")}`);
  } catch (e) {
    add("warn", ".mcp.json present but invalid JSON", String(e));
  }
} else {
  add("warn", ".mcp.json not present", "run `cp .mcp.json.example .mcp.json` to register with Claude Code");
}

// 8. Skills
{
  const skillsDir = path.join(ROOT, ".claude", "skills");
  const expected = ["devtest", "qa", "minimize"];
  const found = [];
  for (const s of expected) {
    if (await exists(path.join(skillsDir, s, "SKILL.md"))) found.push(s);
  }
  if (found.length === expected.length) {
    add("ok", `Skills: ${found.join(", ")}`);
  } else {
    const missing = expected.filter(e => !found.includes(e));
    add("warn", `Skills missing: ${missing.join(", ")}`, `found: ${found.join(", ") || "(none)"}`);
  }
}

// ---- Report ----
const icon = { ok: `${GREEN}✓${RESET}`, warn: `${YELLOW}!${RESET}`, fail: `${RED}✗${RESET}` };
const counts = { ok: 0, warn: 0, fail: 0 };

console.log(`\n${BOLD}app_test_ctrl 环境自检${RESET}  (${ROOT})\n`);
for (const c of checks) {
  counts[c.kind]++;
  const detail = c.detail ? `  ${GRAY}${c.detail}${RESET}` : "";
  console.log(`  ${icon[c.kind]}  ${c.label}${detail}`);
}

console.log();
const sum = `${GREEN}${counts.ok} ok${RESET}  ${YELLOW}${counts.warn} warnings${RESET}  ${RED}${counts.fail} failed${RESET}`;
if (counts.fail === 0 && counts.warn === 0) {
  console.log(`${GREEN}${BOLD}全部就绪${RESET}  ·  ${sum}`);
} else if (counts.fail === 0) {
  console.log(`${YELLOW}${BOLD}可用但有警告${RESET}  ·  ${sum}`);
} else {
  console.log(`${RED}${BOLD}存在阻断项${RESET}  ·  ${sum}`);
  process.exit(1);
}
