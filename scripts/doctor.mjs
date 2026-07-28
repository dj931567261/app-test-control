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
  const { timeoutMs = 5000, ...execOpts } = opts;
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, {
      timeout: timeoutMs,
      ...execOpts,
    });
    return {
      ok: true,
      out: stdout.toString().trim(),
      stderr: stderr.toString().trim(),
      code: 0,
    };
  } catch (err) {
    return {
      ok: false,
      out: err?.stdout?.toString().trim() ?? "",
      stderr: err?.stderr?.toString().trim() ?? "",
      err: err?.message ?? String(err),
      code: err?.code,
      signal: err?.signal,
    };
  }
}

function isEnoent(result) {
  return !result.ok && result.code === "ENOENT";
}

function failureDetail(result) {
  const source = result.stderr || result.err || result.out || "unknown error";
  return source.split("\n").map((line) => line.trim()).find(Boolean) ?? "unknown error";
}

function isWdaReadyJson(text) {
  try {
    const value = JSON.parse(text);
    return value?.value?.ready === true || value?.ready === true;
  } catch {
    return false;
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
    if (isEnoent(r)) add("fail", "npm not found");
    else add("fail", "npm version check failed", failureDetail(r));
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
  } else if (isEnoent(r)) {
    add("warn", "adb not found", "needed for Android; install Android SDK Platform Tools");
  } else {
    add("warn", "adb check failed", failureDetail(r));
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
  } else if (isEnoent(r)) {
    add("warn", "xcrun not found", "needed for iOS support; install Xcode command line tools");
  } else {
    add("warn", "xcrun check failed", failureDetail(r));
  }
}

// 4.5 iOS real device (libimobiledevice + go-ios + WDA) — all OPTIONAL.
// “未安装”只由 execFile 的 ENOENT 判定。命令存在但超时、权限不足或执行失败时，
// 必须展示真实错误，不能误导用户重新安装。
{
  const ideviceId = await run("idevice_id", ["-l"], { timeoutMs: 6000 });
  let udids = [];
  if (isEnoent(ideviceId)) {
    add(
      "warn",
      "libimobiledevice not found (idevice_id)",
      "only needed for iOS REAL devices; `brew install libimobiledevice ideviceinstaller`",
    );
  } else if (!ideviceId.ok) {
    add("warn", "idevice_id failed", failureDetail(ideviceId));
  } else {
    udids = ideviceId.out.split("\n").map((l) => l.trim()).filter(Boolean);
    if (udids.length === 0) {
      add("ok", "libimobiledevice present", "no real device connected (fine unless you test on-device)");
    } else {
      add("ok", `iOS real devices: ${udids.length} connected`, udids.join(", "));
    }
  }

  // idevice_id 存在时继续检查真机日志、崩溃、应用枚举所需的每个二进制。
  if (!isEnoent(ideviceId)) {
    const required = [
      ["ideviceinfo", ["-h"], "device metadata / iOS version"],
      ["idevicesyslog", ["-h"], "ios_device_start_capture"],
      ["idevicecrashreport", ["-h"], "ios_pull_device_crashes"],
      ["ideviceinstaller", ["-h"], "app listing and WDA detection"],
    ];
    for (const [cmd, args, purpose] of required) {
      const result = await run(cmd, args, { timeoutMs: 5000 });
      if (result.ok) {
        add("ok", `${cmd} present`);
      } else if (isEnoent(result)) {
        add("warn", `${cmd} missing`, `${purpose} needs it; install/reinstall libimobiledevice + ideviceinstaller`);
      } else {
        add("warn", `${cmd} check failed`, failureDetail(result));
      }
    }
  }

  // go-ios drives mobile-mcp's real-device discovery, WDA launch and forwarding.
  const goios = await run("ios", ["version"], { timeoutMs: 6000 });
  if (goios.ok) {
    add("ok", `go-ios ${goios.out.replace(/[{}"]/g, "").trim()}`);
  } else if (isEnoent(goios)) {
    add("warn", "go-ios (`ios`) not found", "real-device UI needs it; `npm i -g go-ios`");
  } else {
    add("warn", "go-ios (`ios`) check failed", failureDetail(goios));
  }

  // 仅连接真机时探测 WDA。响应必须是合法 JSON 且 ready 严格等于布尔 true；
  // sessionId/state 或字符串 "true" 都不能代表就绪。
  if (udids.length > 0) {
    const wda = await run(
      "curl",
      ["-fsS", "-m", "3", "http://127.0.0.1:8100/status"],
      { timeoutMs: 5000 },
    );
    if (wda.ok && isWdaReadyJson(wda.out)) {
      add("ok", "WebDriverAgent ready on :8100");
    } else if (isEnoent(wda)) {
      add("warn", "curl not found", "needed to verify WebDriverAgent /status");
    } else if (!wda.ok) {
      add(
        "warn",
        "WebDriverAgent not reachable on :8100",
        `${failureDetail(wda)}; run \`bash scripts/ios-wda-up.sh\``,
      );
    } else {
      add(
        "warn",
        "WebDriverAgent is not ready on :8100",
        "status must be valid JSON with ready === true; run `bash scripts/ios-wda-up.sh`",
      );
    }
  }
}

// 5. MCP server builds
const SERVERS = ["log-mcp", "report-mcp", "ui-mcp", "analyzer-mcp", "code-analyzer-mcp"];
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

// 6.5 mobile-mcp（npx 缓存预热检测）
// `.mcp.json` 里 mobile server 用 `npx -y @mobilenext/mobile-mcp@latest`，
// 首次启动 MCP client 时 npx 会现拉。预热过的话本地 npx 缓存能命中。
{
  // 用 `npm exec --offline` 探缓存：命中 → 0；未命中 → 非 0（且不会下载）
  const r = await run("npm", ["exec", "--offline", "--yes", "@mobilenext/mobile-mcp@latest", "--", "--version"], { timeoutMs: 10000 });
  if (r.ok) {
    add("ok", `mobile-mcp ready (npx cache hit)`);
  } else {
    add("warn", "mobile-mcp not in npx cache", "run `npm run prewarm` to pre-download (or it'll download on first MCP client start)");
  }
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
  add("warn", ".mcp.json not present", "run `npm run setup` (or `npm run setup -- --client cursor` etc.)");
}

// 8. Skills — 源在 skills/<name>/SKILL.md，Claude Code 用副本 .claude/skills/<name>/SKILL.md
{
  const fs = await import("node:fs/promises");
  const srcDir = path.join(ROOT, "skills");
  const cloneDir = path.join(ROOT, ".claude", "skills");
  let names = [];
  try {
    const entries = await fs.readdir(srcDir, { withFileTypes: true });
    for (const e of entries) {
      if (e.isDirectory() && await exists(path.join(srcDir, e.name, "SKILL.md"))) {
        names.push(e.name);
      }
    }
  } catch {}
  if (names.length === 0) {
    add("warn", "no skills found under skills/", "");
  } else {
    add("ok", `Skills (source): ${names.sort().join(", ")}`);
    // Check .claude/skills/ clones — Claude Code users care; other clients don't
    const stale = [];
    const missing = [];
    for (const n of names) {
      const src = path.join(srcDir, n, "SKILL.md");
      const dst = path.join(cloneDir, n, "SKILL.md");
      if (!(await exists(dst))) { missing.push(n); continue; }
      try {
        const [a, b] = await Promise.all([fs.stat(src), fs.stat(dst)]);
        if (a.mtimeMs > b.mtimeMs + 1000) stale.push(n);
      } catch {}
    }
    if (missing.length) add("warn", `.claude/skills/ missing: ${missing.join(", ")}`, "run `npm run install:skills` for Claude Code");
    if (stale.length) add("warn", `.claude/skills/ outdated vs skills/: ${stale.join(", ")}`, "run `npm run install:skills -- --force`");
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
