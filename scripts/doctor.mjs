#!/usr/bin/env node
// app_test_ctrl 环境自检。
// 用法：node scripts/doctor.mjs  或  npm run doctor

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { realpathSync } from "node:fs";
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

export function sanitizeDiagnostic(value, maxLength = 1000) {
  const text = String(value ?? "")
    .replace(/\x1b/g, "\\x1b")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "?")
    .replace(/[\u0080-\u009f\u202a-\u202e\u2066-\u2069]/g, "?")
    .replace(/[\r\n\t]+/g, " ")
    .trim();
  return text.length <= maxLength ? text : `${text.slice(0, maxLength)}…`;
}

/** kind: "ok" | "warn" | "fail" */
function add(kind, label, detail = "") {
  checks.push({
    kind,
    label: sanitizeDiagnostic(label),
    detail: sanitizeDiagnostic(detail),
  });
}

export async function run(cmd, args = [], opts = {}) {
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

export function isEnoent(result) {
  return !result.ok && result.code === "ENOENT";
}

export function failureDetail(result) {
  const source = result.stderr || result.err || result.out || "unknown error";
  return source.split("\n").map((line) => line.trim()).find(Boolean) ?? "unknown error";
}

export function isWdaReadyJson(text) {
  try {
    const value = JSON.parse(text);
    return value?.value?.ready === true || value?.ready === true;
  } catch {
    return false;
  }
}

export function isValidDeviceUdid(value) {
  return /^[A-Fa-f0-9]{8,64}(?:-[A-Fa-f0-9]{4,64})*$/.test(value);
}

// 部分 libimobiledevice 版本会正常打印帮助后以非零状态退出。此时二进制已经
// 成功解析并执行，不能误报为损坏；真正的 ENOENT/EACCES/崩溃仍单独处理。
export function looksLikeCliHelp(result) {
  if (result.ok) return true;
  if (isEnoent(result) || result.signal) return false;
  const output = [result.out, result.stderr].filter(Boolean).join("\n");
  return /(^|\n)\s*(usage\s*:|options\s*:|commands\s*:)/i.test(output)
    || /(^|\s)--help(?:\s|,|$)/i.test(output);
}

async function exists(p) {
  try { await access(p); return true; } catch { return false; }
}

const CRASHLYTICS_PROJECT_PATTERN = /^[a-z][a-z0-9.-]{3,62}$/;
const CRASHLYTICS_APP_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

function isObjectRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseRequiredCsv(raw, name) {
  if (typeof raw !== "string" || !raw.trim()) {
    throw new Error(`${name} is required`);
  }
  const values = raw.split(",").map((value) => value.trim());
  if (values.some((value) => value.length === 0)) {
    throw new Error(`${name} contains an empty entry`);
  }
  return [...new Set(values)];
}

// 与 crashlytics-mcp 的启动校验保持一致，避免 doctor 只检查“非空”而假绿。
function validateCrashlyticsAllowlists(env) {
  try {
    const projects = parseRequiredCsv(
      env.CRASHLYTICS_PROJECT_ALLOWLIST,
      "CRASHLYTICS_PROJECT_ALLOWLIST",
    );
    if (projects.some((projectId) => !CRASHLYTICS_PROJECT_PATTERN.test(projectId))) {
      throw new Error("CRASHLYTICS_PROJECT_ALLOWLIST contains an invalid project id");
    }

    const apps = parseRequiredCsv(
      env.CRASHLYTICS_APP_ALLOWLIST,
      "CRASHLYTICS_APP_ALLOWLIST",
    );
    for (const entry of apps) {
      const separator = entry.indexOf("=");
      if (separator <= 0 || separator === entry.length - 1) {
        throw new Error("CRASHLYTICS_APP_ALLOWLIST entries must use project_id=app_id");
      }
      const projectId = entry.slice(0, separator);
      const appId = entry.slice(separator + 1);
      if (!projects.includes(projectId) || !CRASHLYTICS_APP_PATTERN.test(appId)) {
        throw new Error(
          "CRASHLYTICS_APP_ALLOWLIST contains an invalid or unapproved project/app pair",
        );
      }
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function parseCrashlyticsChildEnv(mcpConfigText) {
  let config;
  try {
    config = JSON.parse(mcpConfigText);
  } catch (error) {
    throw new Error(`invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isObjectRecord(config)) {
    throw new Error("config root must be an object");
  }
  if (!isObjectRecord(config.mcpServers)) {
    throw new Error("mcpServers must be an object");
  }
  const crashlytics = config.mcpServers.crashlytics;
  if (!isObjectRecord(crashlytics)) {
    throw new Error("mcpServers.crashlytics must be an object");
  }
  const childEnv = crashlytics.env === undefined ? {} : crashlytics.env;
  if (!isObjectRecord(childEnv)) {
    throw new Error("mcpServers.crashlytics.env must be an object");
  }
  for (const [name, value] of Object.entries(childEnv)) {
    if (typeof value !== "string") {
      throw new Error(`mcpServers.crashlytics.env.${name} must be a string`);
    }
  }
  return childEnv;
}

async function safeExists(fileExists, candidate) {
  try {
    return await fileExists(candidate);
  } catch {
    return false;
  }
}

/**
 * 只检查本地元数据，不读取凭据/fixture 内容，也不 mint token 或联网。
 * 配置中的 env 按 MCP 子进程语义覆盖 shell；空字符串同样是显式覆盖。
 */
export async function inspectCrashlyticsConfiguration({
  shellEnv = process.env,
  mcpConfigText,
  mcpConfigReadError,
  fileExists = exists,
  platform = process.platform,
} = {}) {
  const result = { status: "valid", provider: null, checks: [] };
  let childEnv = {};
  let sourceDetail = ".mcp.json child env over inherited process env";

  if (mcpConfigReadError) {
    result.status = "invalid";
    result.checks.push({
      kind: "warn",
      label: "Crashlytics MCP configuration unreadable",
      detail: String(mcpConfigReadError),
    });
    return result;
  }

  if (mcpConfigText === undefined) {
    result.status = "missing";
    sourceDetail = "doctor process environment only; no .mcp.json child config was found";
    result.checks.push({
      kind: "warn",
      label: "Crashlytics MCP project configuration not found",
      detail: "run setup-mcp before relying on this shell-only check",
    });
  } else {
    try {
      childEnv = parseCrashlyticsChildEnv(mcpConfigText);
    } catch (error) {
      result.status = "invalid";
      result.checks.push({
        kind: "warn",
        label: "Crashlytics MCP configuration invalid",
        detail: error instanceof Error ? error.message : String(error),
      });
      // Fail closed: an invalid client configuration must never fall back to the
      // shell and claim that the actual MCP child is correctly configured.
      return result;
    }
  }

  const effectiveEnv = { ...shellEnv, ...childEnv };
  const providerRaw = typeof effectiveEnv.CRASHLYTICS_PROVIDER === "string"
    ? effectiveEnv.CRASHLYTICS_PROVIDER.trim()
    : "";
  const provider = providerRaw || "cloud_logging";
  if (provider !== "cloud_logging" && provider !== "fixture") {
    result.checks.push({
      kind: "warn",
      label: "Crashlytics provider invalid",
      detail: "CRASHLYTICS_PROVIDER must be cloud_logging or fixture",
    });
  } else {
    result.provider = provider;
    result.checks.push({
      kind: "ok",
      label: `Crashlytics provider: ${provider}`,
      detail: sourceDetail,
    });
  }

  const allowlists = validateCrashlyticsAllowlists(effectiveEnv);
  if (allowlists.ok) {
    result.checks.push({
      kind: "ok",
      label: "Crashlytics project/app allowlists configured",
      detail: sourceDetail,
    });
  } else {
    result.checks.push({
      kind: "warn",
      label: "Crashlytics project/app allowlists invalid or missing",
      detail: allowlists.error,
    });
  }

  if (provider === "fixture") {
    const rawFixturePath = typeof effectiveEnv.CRASHLYTICS_FIXTURE_PATH === "string"
      ? effectiveEnv.CRASHLYTICS_FIXTURE_PATH.trim()
      : "";
    const platformPath = platform === "win32" ? path.win32 : path.posix;
    if (
      !rawFixturePath
      || rawFixturePath.includes("\0")
      || !platformPath.isAbsolute(rawFixturePath)
    ) {
      result.checks.push({
        kind: "warn",
        label: "Crashlytics fixture path invalid or missing",
        detail: "CRASHLYTICS_FIXTURE_PATH must be an absolute existing path",
      });
    } else if (await safeExists(fileExists, rawFixturePath)) {
      result.checks.push({
        kind: "ok",
        label: "Crashlytics fixture path present",
        detail: "contents were not read",
      });
    } else {
      result.checks.push({
        kind: "warn",
        label: "Crashlytics fixture file not found",
        detail: "check CRASHLYTICS_FIXTURE_PATH",
      });
    }
    result.checks.push({
      kind: "ok",
      label: "Google ADC not required for Crashlytics fixture provider",
    });
    return result;
  }

  if (provider === "cloud_logging") {
    const explicitAdc = typeof effectiveEnv.GOOGLE_APPLICATION_CREDENTIALS === "string"
      ? effectiveEnv.GOOGLE_APPLICATION_CREDENTIALS.trim()
      : "";
    if (explicitAdc) {
      if (await safeExists(fileExists, explicitAdc)) {
        result.checks.push({
          kind: "ok",
          label: "Google ADC credential file configured",
          detail: "contents were not read",
        });
      } else {
        // Google Auth treats a non-empty explicit path as authoritative; do not
        // fall back to a default ADC file and hide a broken child configuration.
        result.checks.push({
          kind: "warn",
          label: "Configured Google ADC credential file not found",
          detail: "check GOOGLE_APPLICATION_CREDENTIALS",
        });
      }
      return result;
    }

    const defaultAdc = platform === "win32"
      ? (effectiveEnv.APPDATA
        ? path.win32.join(effectiveEnv.APPDATA, "gcloud", "application_default_credentials.json")
        : null)
      : (effectiveEnv.HOME
        ? path.posix.join(effectiveEnv.HOME, ".config", "gcloud", "application_default_credentials.json")
        : null);
    if (defaultAdc && await safeExists(fileExists, defaultAdc)) {
      result.checks.push({
        kind: "ok",
        label: "Google ADC default credential present",
        detail: "contents were not read",
      });
    } else {
      result.checks.push({
        kind: "warn",
        label: "Google ADC not detected",
        detail: "needed only for crashlytics-mcp cloud_logging provider",
      });
    }
  }

  return result;
}

function isDirectExecutionPath(argvPath) {
  if (!argvPath) return false;
  const modulePath = fileURLToPath(import.meta.url);
  try {
    return realpathSync(argvPath) === realpathSync(modulePath);
  } catch {
    return path.resolve(argvPath) === modulePath;
  }
}

const isDirectExecution = isDirectExecutionPath(process.argv[1]);

if (isDirectExecution) {

const projectMcpPath = path.join(ROOT, ".mcp.json");
let projectMcpText;
let projectMcpReadError;
try {
  projectMcpText = await readFile(projectMcpPath, "utf8");
} catch (error) {
  if (error?.code !== "ENOENT") projectMcpReadError = error;
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
    const rawUdids = ideviceId.out.split("\n").map((l) => l.trim()).filter(Boolean);
    const invalidUdids = rawUdids.filter((value) => !isValidDeviceUdid(value));
    udids = [...new Set(rawUdids.filter(isValidDeviceUdid))];
    if (invalidUdids.length > 0) {
      add(
        "warn",
        "idevice_id returned malformed device identifiers",
        invalidUdids.join(", "),
      );
    }
    if (udids.length === 0) {
      add("ok", "libimobiledevice present", "no real device connected (fine unless you test on-device)");
    } else {
      add("ok", `iOS real devices: ${udids.length} connected`, udids.join(", "));
    }
  }

  // idevice_id 存在时继续检查真机日志、崩溃、应用枚举所需的每个二进制。
  if (!isEnoent(ideviceId)) {
    const required = [
      ["ideviceinfo", ["-h"], "device metadata / iOS version", "install/reinstall libimobiledevice"],
      ["idevicesyslog", ["-h"], "ios_device_start_capture", "install/reinstall libimobiledevice"],
      ["idevicecrashreport", ["-h"], "ios_pull_device_crashes", "install/reinstall libimobiledevice"],
      ["ideviceinstaller", ["-h"], "app listing and WDA detection", "install/reinstall ideviceinstaller"],
      ["lsof", ["-v"], "safe WDA port ownership checks", "install lsof or restore the macOS system tool"],
    ];
    for (const [cmd, args, purpose, installHint] of required) {
      const result = await run(cmd, args, { timeoutMs: 5000 });
      if (result.ok || looksLikeCliHelp(result)) {
        add("ok", `${cmd} present`);
      } else if (isEnoent(result)) {
        add("warn", `${cmd} missing`, `${purpose} needs it; ${installHint}`);
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
const SERVERS = [
  "log-mcp",
  "report-mcp",
  "ui-mcp",
  "analyzer-mcp",
  "code-analyzer-mcp",
  "crashlytics-mcp",
];
for (const s of SERVERS) {
  const distEntry = path.join(ROOT, "mcp-servers", s, "dist", "index.js");
  if (await exists(distEntry)) {
    const st = await stat(distEntry);
    add("ok", `mcp-servers/${s}/dist/index.js`, `${(st.size / 1024).toFixed(1)} KB`);
  } else {
    add("fail", `mcp-servers/${s}/dist/index.js missing`, "run `npm run build`");
  }
}

// 5.5 Crashlytics remote access is optional. Only inspect local configuration
// metadata here; doctor must never mint a token or contact Firebase/Google APIs.
{
  const inspection = await inspectCrashlyticsConfiguration({
    shellEnv: process.env,
    mcpConfigText: projectMcpText,
    mcpConfigReadError: projectMcpReadError,
    fileExists: exists,
  });
  for (const check of inspection.checks) {
    add(check.kind, check.label, check.detail);
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
if (projectMcpText !== undefined) {
  try {
    const j = JSON.parse(projectMcpText);
    if (!isObjectRecord(j)) throw new Error("config root must be an object");
    if (!isObjectRecord(j.mcpServers)) throw new Error("mcpServers must be an object");
    const servers = Object.keys(j.mcpServers);
    add("ok", `.mcp.json present`, `${servers.length} servers: ${servers.join(", ")}`);
  } catch (e) {
    add("warn", ".mcp.json present but invalid", String(e));
  }
} else if (projectMcpReadError) {
  add("warn", ".mcp.json could not be read", String(projectMcpReadError));
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
    // Checked-in Claude/OpenCode bundles are executable distribution artifacts.
    // Compare the complete tree, not mtimes or SKILL.md alone, and fail closed
    // when references/scripts/agents are missing or stale.
    async function bundlesEqual(left, right) {
      let leftEntries;
      let rightEntries;
      try {
        [leftEntries, rightEntries] = await Promise.all([
          fs.readdir(left, { withFileTypes: true }),
          fs.readdir(right, { withFileTypes: true }),
        ]);
      } catch {
        return false;
      }
      const describe = (entry) => `${entry.name}:${entry.isDirectory() ? "d" : entry.isFile() ? "f" : "x"}`;
      const leftShape = leftEntries.map(describe).sort();
      const rightShape = rightEntries.map(describe).sort();
      if (JSON.stringify(leftShape) !== JSON.stringify(rightShape)) return false;
      for (const entry of leftEntries) {
        const leftPath = path.join(left, entry.name);
        const rightPath = path.join(right, entry.name);
        if (entry.isDirectory()) {
          if (!(await bundlesEqual(leftPath, rightPath))) return false;
        } else if (entry.isFile()) {
          const [a, b] = await Promise.all([fs.readFile(leftPath), fs.readFile(rightPath)]);
          if (!a.equals(b)) return false;
        } else {
          return false;
        }
      }
      return true;
    }
    const stale = [];
    const missing = [];
    for (const n of names) {
      const src = path.join(srcDir, n);
      const dst = path.join(cloneDir, n);
      if (!(await exists(dst))) { missing.push(n); continue; }
      if (!(await bundlesEqual(src, dst))) stale.push(n);
    }
    if (missing.length) add("fail", `.claude/skills/ missing: ${missing.join(", ")}`, "run `npm run install:skills -- --force` for Claude/OpenCode");
    if (stale.length) add("fail", `.claude/skills/ outdated vs skills/: ${stale.join(", ")}`, "run `npm run install:skills -- --force`");
  }
}

// ---- Report ----
const icon = { ok: `${GREEN}✓${RESET}`, warn: `${YELLOW}!${RESET}`, fail: `${RED}✗${RESET}` };
const counts = { ok: 0, warn: 0, fail: 0 };

console.log(`\n${BOLD}app_test_ctrl 环境自检${RESET}  (${sanitizeDiagnostic(ROOT)})\n`);
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

}
