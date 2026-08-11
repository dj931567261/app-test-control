#!/usr/bin/env node
// app_test_ctrl 环境自检。
// 用法：node scripts/doctor.mjs  或  npm run doctor

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { realpathSync } from "node:fs";
import { access, lstat, readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  FIREBASE_PROXY_RELATIVE_ENTRY,
  FIREBASE_READONLY_PRELOAD_RELATIVE_ENTRY,
  FIREBASE_TOOLS_PACKAGE,
  FIREBASE_TOOLS_VERSION,
  inspectOfficialFirebaseServer,
  parseGeneratedCodexMcpServer,
} from "./firebase-mcp-config.mjs";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = realpathSync(path.resolve(__dirname, ".."));
const PROJECT_NPM_CACHE = path.join(ROOT, ".codex", "npm-cache");

const RESET = "\x1b[0m";
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const GRAY = "\x1b[90m";
const BOLD = "\x1b[1m";

const checks = [];

export const SUPPORTED_DOCTOR_CLIENTS = Object.freeze([
  "claude-code",
  "cursor",
  "codex",
  "claude-desktop",
  "opencode",
  "antigravity",
]);

class CliUsageError extends Error {}

function safeErrorMessage(error) {
  return sanitizeDiagnostic(error instanceof Error ? error.message : error);
}

export function parseDoctorArgs(argv) {
  const result = { client: "claude-code", help: false };
  const seen = new Set();
  const mark = (name) => {
    if (seen.has(name)) throw new CliUsageError(`${name} may be supplied only once`);
    seen.add(name);
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--client") {
      mark("--client");
      const value = argv[++index];
      if (!value || value.startsWith("--")) {
        throw new CliUsageError("--client requires a value");
      }
      if (!SUPPORTED_DOCTOR_CLIENTS.includes(value)) {
        throw new CliUsageError(
          `--client must be one of: ${SUPPORTED_DOCTOR_CLIENTS.join(", ")}`,
        );
      }
      result.client = value;
    } else if (argument === "--help" || argument === "-h") {
      mark("--help");
      result.help = true;
    } else {
      throw new CliUsageError(`unknown or positional argument: ${argument}`);
    }
  }
  if (result.help && argv.length !== 1) {
    throw new CliUsageError("--help cannot be combined with other arguments");
  }
  return result;
}

function printDoctorHelp() {
  console.log("Usage: doctor.mjs [--client <name>]");
  console.log(`  --client one of: ${SUPPORTED_DOCTOR_CLIENTS.join(", ")} (default claude-code)`);
}

export function doctorClientConfigPath(client, {
  root = ROOT,
  home = homedir(),
  platform = process.platform,
  env = process.env,
} = {}) {
  if (!SUPPORTED_DOCTOR_CLIENTS.includes(client)) {
    throw new Error("unsupported doctor client");
  }
  const api = platform === "win32" ? path.win32 : path.posix;
  if (client === "claude-code") return api.resolve(root, ".mcp.json");
  if (client === "cursor") return api.resolve(root, ".cursor", "mcp.json");
  if (client === "codex") return api.resolve(home, ".codex", "config.toml");
  if (client === "claude-desktop") {
    if (platform === "win32") {
      return path.win32.resolve(
        env.APPDATA || path.win32.resolve(home, "AppData", "Roaming"),
        "Claude",
        "claude_desktop_config.json",
      );
    }
    return platform === "darwin"
      ? api.resolve(home, "Library", "Application Support", "Claude", "claude_desktop_config.json")
      : api.resolve(home, ".config", "Claude", "claude_desktop_config.json");
  }
  if (client === "opencode") {
    return platform === "win32"
      ? path.win32.resolve(
        env.APPDATA || path.win32.resolve(home, "AppData", "Roaming"),
        "opencode",
        "opencode.json",
      )
      : api.resolve(home, ".config", "opencode", "opencode.json");
  }
  return api.resolve(home, ".gemini", "config", "mcp_config.json");
}

export function doctorClientConfigPaths(client, options = {}) {
  return doctorClientConfigCandidates(client, options).map(({ configPath }) => configPath);
}

/**
 * 为每个候选配置保留实际作用域。Codex 同时支持 project/global 优先级；若丢失该信息，
 * doctor 将无法区分禁止的全局服务账号 Profile 与要求的项目级配置。
 */
export function doctorClientConfigCandidates(client, options = {}) {
  if (client !== "codex") {
    const scope = ["claude-code", "cursor"].includes(client) ? "project" : "global";
    return [{ configPath: doctorClientConfigPath(client, options), scope }];
  }
  const root = options.root ?? ROOT;
  const home = options.home ?? homedir();
  const platform = options.platform ?? process.platform;
  const api = platform === "win32" ? path.win32 : path.posix;
  // Codex 先加载全局配置，再按 server key 用项目配置覆盖。两个文件只要存在就都必须安全
  // 解析；任一层异常都 fail-closed，不能用另一层制造假绿。
  return [
    {
      configPath: api.resolve(home, ".codex", "config.toml"),
      scope: "global",
    },
    {
      configPath: api.resolve(root, ".codex", "config.toml"),
      scope: "project",
    },
  ];
}

function mergeNormalizedMcpLayers(layers) {
  const merged = {};
  for (const { normalizedText } of layers) {
    const servers = parseMcpServers(normalizedText);
    for (const [name, entry] of Object.entries(servers)) merged[name] = entry;
  }
  return JSON.stringify({ mcpServers: merged });
}

/**
 * 按客户端真实加载规则读取配置。Codex 会同时审计 global/project 两层，并以
 * global → project 的顺序按 MCP server key 合并；任何已存在层无法安全读取或规范化时，
 * 整体返回不可用，且错误中不包含配置路径。
 */
export async function loadDoctorMcpConfiguration(client, {
  fileStat = stat,
  fileRead = readFile,
  ...pathOptions
} = {}) {
  const layers = [];
  for (const { configPath, scope } of doctorClientConfigCandidates(client, pathOptions)) {
    let metadata;
    try {
      metadata = await fileStat(configPath);
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      return {
        mcpConfigText: undefined,
        mcpConfigReadError: new Error(
          "selected client MCP configuration is unreadable or invalid",
        ),
        configScope: undefined,
        codexGlobalMcpConfigText: undefined,
      };
    }
    try {
      if (!metadata.isFile() || metadata.size > 4 * 1024 * 1024) {
        throw new Error("selected client MCP configuration is not a bounded regular file");
      }
      const normalizedText = normalizeDoctorMcpConfig(
        await fileRead(configPath, "utf8"),
        client,
      );
      // 强制验证规范化投影的闭合 JSON 形状，再允许进入合并。
      parseMcpServers(normalizedText);
      layers.push({ scope, normalizedText });
    } catch {
      return {
        mcpConfigText: undefined,
        mcpConfigReadError: new Error(
          "selected client MCP configuration is unreadable or invalid",
        ),
        configScope: undefined,
        codexGlobalMcpConfigText: undefined,
      };
    }
  }

  if (layers.length === 0) {
    return {
      mcpConfigText: undefined,
      mcpConfigReadError: undefined,
      configScope: undefined,
      codexGlobalMcpConfigText: undefined,
    };
  }
  if (client !== "codex") {
    return {
      mcpConfigText: layers[0].normalizedText,
      mcpConfigReadError: undefined,
      configScope: layers[0].scope,
      codexGlobalMcpConfigText: undefined,
    };
  }

  const globalLayer = layers.find(({ scope }) => scope === "global");
  const projectLayer = layers.find(({ scope }) => scope === "project");
  return {
    mcpConfigText: mergeNormalizedMcpLayers(layers),
    mcpConfigReadError: undefined,
    configScope: globalLayer && projectLayer
      ? "merged(global→project)"
      : globalLayer
        ? "global"
        : "project",
    codexGlobalMcpConfigText: globalLayer?.normalizedText,
  };
}

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

const GENERATED_MCP_SERVER_NAMES = Object.freeze([
  "mobile",
  "log",
  "ui",
  "analyzer",
  "code-analyzer",
  "build-runner",
  "crashlytics",
  "firebase",
  "report",
]);

/**
 * Normalize each supported client's real on-disk configuration to the bounded
 * `mcpServers` JSON shape consumed by the local inspectors. Codex parsing only
 * accepts the single-line TOML emitted by setup-mcp; unsupported/ambiguous
 * syntax fails closed instead of guessing.
 */
export function normalizeDoctorMcpConfig(configText, client) {
  if (typeof configText !== "string" || configText.length > 4 * 1024 * 1024) {
    throw new Error("MCP configuration exceeds the 4 MiB inspection limit");
  }
  if (client === "codex") {
    const mcpServers = {};
    for (const name of GENERATED_MCP_SERVER_NAMES) {
      const entry = parseGeneratedCodexMcpServer(configText, name);
      if (entry !== null) {
        mcpServers[name] = entry;
        continue;
      }
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
      const declared = new RegExp(
        `^\\s*\\[\\s*mcp_servers\\.(?:${escaped}|"${escaped}")\\s*\\]`,
        "mu",
      ).test(configText);
      if (declared) {
        throw new Error("Codex MCP section is ambiguous or not in the bounded generated format");
      }
    }
    return JSON.stringify({ mcpServers });
  }

  let config;
  try {
    config = JSON.parse(configText);
  } catch {
    throw new Error("MCP configuration is not valid JSON");
  }
  if (!isObjectRecord(config)) throw new Error("MCP configuration root must be an object");
  if (client === "opencode") {
    if (!isObjectRecord(config.mcp)) throw new Error("OpenCode mcp must be an object");
    const mcpServers = {};
    for (const [name, source] of Object.entries(config.mcp)) {
      if (!isObjectRecord(source) || !Array.isArray(source.command)) continue;
      const [command, ...args] = source.command;
      mcpServers[name] = {
        command,
        args,
        env: source.environment,
      };
    }
    return JSON.stringify({ mcpServers });
  }
  if (!isObjectRecord(config.mcpServers)) {
    throw new Error("mcpServers must be an object");
  }
  return JSON.stringify({ mcpServers: config.mcpServers });
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

function parseMcpServers(mcpConfigText) {
  let config;
  try {
    config = JSON.parse(mcpConfigText);
  } catch (error) {
    throw new Error(`invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isObjectRecord(config)) throw new Error("config root must be an object");
  if (!isObjectRecord(config.mcpServers)) throw new Error("mcpServers must be an object");
  return config.mcpServers;
}

const BUILD_RUNNER_ENV_KEYS = Object.freeze({
  backend: "APP_TEST_CTRL_BUILD_RUNNER_BACKEND",
  dockerBin: "APP_TEST_CTRL_BUILD_RUNNER_DOCKER_BIN",
  dockerHost: "APP_TEST_CTRL_BUILD_RUNNER_DOCKER_HOST",
  image: "APP_TEST_CTRL_BUILD_RUNNER_IMAGE",
});

const BUILD_RUNNER_BACKENDS = new Set(["local_trusted", "docker"]);

function isStrictDockerCapability(capability) {
  return capability?.schema_version === "build-runner-capabilities/v2"
    && capability.available === true
    && capability.backend === "docker"
    && capability.execution_profile === "docker_strict"
    && capability.local_trusted_execution_eligible === false
    && capability.auto_patch_eligible === true
    && capability.strong_isolation === true
    && capability.network_policy === "denied"
    && isObjectRecord(capability.workspace_disk_quota)
    && capability.workspace_disk_quota.enforced === true
    && capability.workspace_disk_quota.mechanism === "attested"
    && capability.filesystem_write_isolation === "enforced"
    && capability.secret_environment_isolation === "allowlist"
    && capability.secret_filesystem_isolation === "enforced"
    && capability.process_containment === "container+process_group"
    && capability.project_trust_required === false
    && capability.requires_explicit_trust === false
    && capability.requires_per_run_approval === true
    && capability.cache_mode === "sealed_seed_readonly_overlay"
    && capability.verification_level === "strong_isolation"
    && capability.max_command_seconds === 60;
}

function isStrictLocalTrustedCapability(capability) {
  return capability?.schema_version === "build-runner-capabilities/v2"
    && capability.available === true
    && capability.backend === "local_trusted"
    && capability.execution_profile === "local_trusted"
    && capability.local_trusted_execution_eligible === true
    && capability.auto_patch_eligible === false
    && capability.strong_isolation === false
    && capability.network_policy === "not_enforced"
    && isObjectRecord(capability.workspace_disk_quota)
    && capability.workspace_disk_quota.enforced === false
    && capability.workspace_disk_quota.mechanism === "none"
    && capability.filesystem_write_isolation === "not_enforced"
    && capability.secret_environment_isolation === "allowlist"
    && capability.secret_filesystem_isolation === "not_enforced"
    && capability.process_containment === "process_group_best_effort"
    && capability.project_trust_required === true
    && capability.requires_explicit_trust === true
    && capability.requires_per_run_approval === true
    && capability.cache_mode === "sealed_seed_disposable_copy"
    && capability.verification_level === "trusted_local"
    && capability.max_command_seconds === 60;
}

/**
 * Inspect only the local Build Runner configuration and its authoritative
 * capability probe. local_trusted is an explicit trusted-host mode and must
 * never be reported as strong isolation; Docker remains an optional strict
 * backend and is never discovered, started or pulled by doctor.
 */
export async function inspectBuildRunnerConfiguration({
  shellEnv = process.env,
  mcpConfigText,
  mcpConfigReadError,
  expectedServerEntry = path.join(
    ROOT,
    "mcp-servers",
    "build-runner-mcp",
    "dist",
    "index.js",
  ),
  probeCapabilities,
} = {}) {
  const result = { status: "missing", configured: false, backend: null, checks: [] };
  if (mcpConfigReadError) {
    result.status = "invalid";
    result.checks.push({
      kind: "warn",
      label: "Build Runner configuration unreadable",
      detail: String(mcpConfigReadError),
    });
    return result;
  }
  if (mcpConfigText === undefined) {
    result.checks.push({
      kind: "warn",
      label: "Trusted Build Runner not configured",
      detail: "run setup; new installations explicitly select the local_trusted backend",
    });
    return result;
  }

  let servers;
  try {
    servers = parseMcpServers(mcpConfigText);
  } catch (error) {
    result.status = "invalid";
    result.checks.push({
      kind: "warn",
      label: "Build Runner configuration invalid",
      detail: error instanceof Error ? error.message : String(error),
    });
    return result;
  }

  const entry = servers["build-runner"];
  if (!isObjectRecord(entry)) {
    result.checks.push({
      kind: "warn",
      label: "Trusted Build Runner server is not configured",
      detail: "rerun setup after building this checkout",
    });
    return result;
  }
  const args = Array.isArray(entry.args) ? entry.args : [];
  const configuredEntry = args.length === 1
    && typeof args[0] === "string"
    && path.isAbsolute(args[0])
    && path.normalize(args[0]) === path.normalize(expectedServerEntry);
  if (!configuredEntry) {
    result.status = "invalid";
    result.checks.push({
      kind: "warn",
      label: "Build Runner invocation is not owned by this checkout",
      detail: "expected the local build-runner-mcp dist entry; regenerate the client configuration",
    });
    return result;
  }

  const childEnv = entry.env === undefined ? {} : entry.env;
  if (!isObjectRecord(childEnv)) {
    result.status = "invalid";
    result.checks.push({
      kind: "warn",
      label: "Build Runner environment is invalid",
      detail: "mcpServers.build-runner.env must be an object of strings",
    });
    return result;
  }
  for (const [name, value] of Object.entries(childEnv)) {
    if (typeof value !== "string") {
      result.status = "invalid";
      result.checks.push({
        kind: "warn",
        label: "Build Runner environment is invalid",
        detail: `mcpServers.build-runner.env.${name} must be a string`,
      });
      return result;
    }
  }

  // MCP child env values override the launching shell, including deliberate
  // empty fail-closed placeholders in an explicit Docker configuration.
  const effectiveEnv = { ...shellEnv, ...childEnv };
  const rawBackend = effectiveEnv[BUILD_RUNNER_ENV_KEYS.backend];
  // Preserve older explicit Docker configurations which predate the backend
  // key. New setup output always writes the selected backend.
  const backend = rawBackend === undefined ? "docker" : String(rawBackend).trim();
  if (!BUILD_RUNNER_BACKENDS.has(backend)) {
    result.status = "invalid";
    result.checks.push({
      kind: "warn",
      label: "Build Runner backend is invalid",
      detail: `${BUILD_RUNNER_ENV_KEYS.backend} must be local_trusted or docker`,
    });
    return result;
  }
  result.backend = backend;

  if (backend === "local_trusted") {
    result.configured = true;
    result.status = "configured";
  }

  const dockerBin = String(effectiveEnv[BUILD_RUNNER_ENV_KEYS.dockerBin] ?? "").trim();
  const image = String(effectiveEnv[BUILD_RUNNER_ENV_KEYS.image] ?? "").trim();
  if (backend === "docker" && (!dockerBin || !image)) {
    result.status = "unconfigured";
    const missing = [
      ...(dockerBin ? [] : [BUILD_RUNNER_ENV_KEYS.dockerBin]),
      ...(image ? [] : [BUILD_RUNNER_ENV_KEYS.image]),
    ];
    result.checks.push({
      kind: "warn",
      label: "Trusted Build Runner disabled (fail-closed defaults)",
      detail: `configure ${missing.join(" and ")} explicitly; images are never pulled automatically`,
    });
    return result;
  }

  if (backend === "docker") {
    result.configured = true;
    result.status = "configured";
  }
  if (typeof probeCapabilities !== "function") {
    result.checks.push({
      kind: "warn",
      label: "Trusted Build Runner capability not verified",
      detail: backend === "docker"
        ? "the authoritative local Docker isolation probe was not available"
        : "the authoritative local trusted-host probe was not available",
    });
    return result;
  }
  try {
    const capability = await probeCapabilities(effectiveEnv);
    const ready = backend === "docker"
      ? isStrictDockerCapability(capability)
      : isStrictLocalTrustedCapability(capability);
    if (ready) {
      result.status = "ready";
      if (backend === "docker") {
        result.checks.push({
          kind: "ok",
          label: "Trusted Build Runner isolation probe passed",
          detail: "local digest-pinned image; network denied; no image pull was performed",
        });
      } else {
        result.checks.push({
          kind: "ok",
          label: "Trusted local Build Runner probe passed",
          detail: "local Gradle is available for an explicitly trusted project with per-run approval",
        });
        result.checks.push({
          kind: "warn",
          label: "Trusted local mode is not strong isolation",
          detail: "host filesystem, secrets, network and hard resource limits are not isolated; unattended strong-isolation eligibility is disabled, while an explicitly approved local_trusted patch may proceed",
        });
      }
    } else {
      result.status = "unavailable";
      const reasons = Array.isArray(capability?.reasons)
        ? capability.reasons.filter((value) => typeof value === "string").slice(0, 4)
        : [];
      result.checks.push({
        kind: "warn",
        label: "Trusted Build Runner unavailable",
        detail: reasons.length > 0
          ? reasons.join("; ")
          : backend === "docker"
            ? "Docker daemon, pinned local image, or isolation guarantees are unavailable"
            : "local Java/Android toolchain is unavailable or the trusted-host capability contract is incomplete",
      });
    }
  } catch (error) {
    result.status = "unavailable";
    result.checks.push({
      kind: "warn",
      label: "Trusted Build Runner probe failed",
      detail: error instanceof Error ? error.message : String(error),
    });
  }
  return result;
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
  cloudLoggingOptional = false,
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

  const projectAllowlist = typeof effectiveEnv.CRASHLYTICS_PROJECT_ALLOWLIST === "string"
    ? effectiveEnv.CRASHLYTICS_PROJECT_ALLOWLIST.trim()
    : "";
  const appAllowlist = typeof effectiveEnv.CRASHLYTICS_APP_ALLOWLIST === "string"
    ? effectiveEnv.CRASHLYTICS_APP_ALLOWLIST.trim()
    : "";
  if (
    cloudLoggingOptional
    && provider === "cloud_logging"
    && projectAllowlist === ""
    && appAllowlist === ""
  ) {
    result.checks.push({
      kind: "ok",
      label: "Optional Cloud Logging Crashlytics route not configured",
      detail: "configure exact allowlists + ADC only when using source=cloud_logging",
    });
    return result;
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

/**
 * 只检查本项目生成的官方 Firebase MCP 启动边界；不读取 Firebase CLI 登录态，
 * 不启动 npx，也不访问任何远端项目。
 */
function codexGlobalFirebaseUsesServiceAccount(entry) {
  if (!isObjectRecord(entry)) return false;
  const args = Array.isArray(entry.args) ? entry.args : [];
  const hasServiceAccountArg = args.some((value, index) => (
    value === "--project-source" && args[index + 1] === "service-account"
  ));
  const environment = isObjectRecord(entry.env)
    ? entry.env
    : isObjectRecord(entry.environment)
      ? entry.environment
      : {};
  return hasServiceAccountArg
    || Object.prototype.hasOwnProperty.call(environment, "GOOGLE_APPLICATION_CREDENTIALS");
}

export async function inspectOfficialFirebaseConfiguration({
  mcpConfigText,
  mcpConfigReadError,
  codexGlobalMcpConfigText,
  fileStat = stat,
  fileLstat = lstat,
  fileRealpath = realpath,
  fileRead = readFile,
  platform = process.platform,
  expectedProjectRoot = realpathSync(ROOT),
  client = "claude-code",
  configScope = "project",
} = {}) {
  const result = {
    status: "valid",
    configured: false,
    firebaseDir: null,
    projectSource: null,
    checks: [],
  };
  if (mcpConfigReadError) {
    result.status = "invalid";
    result.checks.push({
      kind: "warn",
      label: "Official Firebase MCP configuration unreadable",
      detail: "selected client configuration could not be read safely",
    });
    return result;
  }
  const globalAuditText = client === "codex"
    ? codexGlobalMcpConfigText
      ?? (configScope === "global" ? mcpConfigText : undefined)
    : undefined;
  if (globalAuditText !== undefined) {
    let globalServers;
    try {
      globalServers = parseMcpServers(globalAuditText);
    } catch {
      result.status = "invalid";
      result.checks.push({
        kind: "warn",
        label: "Codex global MCP configuration is invalid",
        detail: "the global configuration could not be audited safely",
      });
      return result;
    }
    if (codexGlobalFirebaseUsesServiceAccount(globalServers.firebase)) {
      result.status = "invalid";
      result.projectSource = "service-account";
      result.checks.push({
        kind: "warn",
        label: "Codex global service-account Profile is invalid",
        detail:
          "move the generated Firebase section to this checkout's .codex/config.toml; credential paths must not be placed in global Codex configuration",
      });
      return result;
    }
  }
  if (mcpConfigText === undefined) {
    result.status = "missing";
    result.checks.push({
      kind: "warn",
      label: "Official Firebase MCP project configuration not found",
      detail: "run setup-mcp; CrashFix official route is unavailable until configured",
    });
    return result;
  }

  let servers;
  try {
    servers = parseMcpServers(mcpConfigText);
  } catch (error) {
    result.status = "invalid";
    result.checks.push({
      kind: "warn",
      label: "Official Firebase MCP configuration invalid",
      detail: error instanceof Error ? error.message : String(error),
    });
    return result;
  }

  if (!Object.prototype.hasOwnProperty.call(servers, "firebase")) {
    result.status = "missing";
    result.checks.push({
      kind: "warn",
      label: "Official Firebase MCP server is not configured",
      detail: "CrashFix defaults to source=official; rerun setup-mcp after updating this checkout",
    });
    return result;
  }

  const inspected = inspectOfficialFirebaseServer(servers.firebase, {
    platform,
    expectedProjectRoot,
    client,
  });
  if (!inspected.valid) {
    result.status = "invalid";
    result.checks.push({
      kind: "warn",
      label: "Official Firebase MCP invocation is not safely pinned",
      detail: inspected.issues.join("; "),
    });
    return result;
  }

  result.projectSource = inspected.projectSource;
  if (inspected.projectSource === null) {
    result.status = "unconfigured";
    result.checks.push({
      kind: "warn",
      label: "Official Firebase MCP connection profile not selected",
      detail:
        "choose service-account + explicit project id, or Firebase CLI + existing .firebaserc; do not infer from files",
    });
  } else {
    result.configured = true;
  }
  result.firebaseDir = inspected.firebaseDir;
  result.checks.push({
    kind: "ok",
    label: "Official Firebase MCP routed through the project read-only gateway",
    detail:
      "the fixed eight-tool allowlist exposes firebase_get_crashlytics_report_guide instead of raw resource reads",
  });

  const gatewayEntry = path.join(
    expectedProjectRoot,
    ...FIREBASE_PROXY_RELATIVE_ENTRY.split("/"),
  );
  let gatewayReady = false;
  try {
    gatewayReady = (await fileStat(gatewayEntry)).isFile();
  } catch {
    // Missing, unreadable, or non-regular build output is a local blocker.
  }
  if (gatewayReady) {
    result.checks.push({
      kind: "ok",
      label: "Firebase read-only gateway build present",
      detail: "local dist entry verified as a file",
    });
  } else {
    result.status = "invalid";
    result.configured = false;
    result.checks.push({
      kind: "warn",
      label: "Firebase read-only gateway build missing",
      detail: "run npm run build before restarting the MCP client",
    });
  }

  const preloadEntry = path.join(
    expectedProjectRoot,
    ...FIREBASE_READONLY_PRELOAD_RELATIVE_ENTRY.split("/"),
  );
  let preloadReady = false;
  try {
    preloadReady = (await fileStat(preloadEntry)).isFile();
  } catch {
    // Runtime will perform the stronger canonical identity and permission check.
  }
  if (preloadReady) {
    result.checks.push({
      kind: "ok",
      label: "Firebase read-only preload guard present",
      detail:
        "project-local dist preload exists as a regular file; doctor does not verify its contents or freshness",
    });
  } else {
    result.status = "invalid";
    result.configured = false;
    result.checks.push({
      kind: "warn",
      label: "Firebase read-only preload guard missing",
      detail: "run npm run build before restarting the MCP client",
    });
  }

  const rootPackagePath = path.join(expectedProjectRoot, "package.json");
  const installedManifestPath = path.join(
    expectedProjectRoot,
    "node_modules",
    "firebase-tools",
    "package.json",
  );
  const installedCliPath = path.join(
    expectedProjectRoot,
    "node_modules",
    "firebase-tools",
    "lib",
    "bin",
    "firebase.js",
  );
  let firebaseRuntimeReady = false;
  try {
    const [rootManifestText, installedManifestText, cliMetadata] = await Promise.all([
      fileRead(rootPackagePath, "utf8"),
      fileRead(installedManifestPath, "utf8"),
      fileStat(installedCliPath),
    ]);
    const rootManifest = JSON.parse(rootManifestText);
    const installedManifest = JSON.parse(installedManifestText);
    firebaseRuntimeReady = rootManifest?.devDependencies?.["firebase-tools"]
        === FIREBASE_TOOLS_VERSION
      && installedManifest?.version === FIREBASE_TOOLS_VERSION
      && cliMetadata.isFile();
  } catch {
    // Never execute npm or Firebase from doctor. Local metadata mismatch fails closed.
  }
  if (firebaseRuntimeReady) {
    result.checks.push({
      kind: "ok",
      label: `Project-local Firebase runtime pinned: ${FIREBASE_TOOLS_PACKAGE}`,
      detail:
        "package.json exact pin, installed manifest version, and CLI entry are present; no lockfile or remote call was checked",
    });
  } else {
    result.status = "invalid";
    result.configured = false;
    result.checks.push({
      kind: "warn",
      label: "Project-local Firebase runtime is missing or version-mismatched",
      detail: "run npm install; firebase-tools must match the exact package.json pin",
    });
  }

  if (inspected.firebaseDir === null) {
    result.checks.push({
      kind: "warn",
      label: "Official Firebase MCP target directory is not pinned",
      detail: "rerun setup with --firebase-dir <absolute Firebase app directory>",
    });
  } else {
    let directoryPresent = false;
    try {
      const metadata = await fileStat(inspected.firebaseDir);
      directoryPresent = metadata.isDirectory();
    } catch {
      // 目录不存在、无权限或 stat 失败都按无效配置处理，不能只凭路径存在假绿。
    }
    if (directoryPresent) {
      result.checks.push({
        kind: "ok",
        label: "Official Firebase MCP target directory present",
        detail: "verified as a directory; contents were not read",
      });
    } else {
      result.status = "invalid";
      result.configured = false;
      result.checks.push({
        kind: "warn",
        label: "Official Firebase MCP target directory invalid",
        detail: "--firebase-dir must reference an existing directory; regenerate the client configuration",
      });
    }
  }

  const firebaseEntry = servers.firebase;
  const childEnv = isObjectRecord(firebaseEntry?.env)
    ? firebaseEntry.env
    : isObjectRecord(firebaseEntry?.environment)
      ? firebaseEntry.environment
      : {};
  if (inspected.projectSource === "service-account") {
    const credential = childEnv.GOOGLE_APPLICATION_CREDENTIALS;
    let credentialReady = false;
    try {
      if (
        typeof credential === "string"
        && credential.length > 0
        && credential.length <= 4096
        && !credential.includes("\0")
        && (platform === "win32" ? path.win32 : path.posix).isAbsolute(credential)
      ) {
        const metadata = await fileLstat(credential);
        const canonical = await fileRealpath(credential);
        credentialReady = metadata.isFile()
          && !metadata.isSymbolicLink()
          && metadata.nlink === 1
          && metadata.size > 0
          && metadata.size <= 64 * 1024
          && canonical === (platform === "win32" ? path.win32 : path.posix).normalize(credential);
        if (credentialReady && platform !== "win32") {
          credentialReady = typeof process.getuid === "function"
            && metadata.uid === process.getuid()
            && (metadata.mode & 0o077) === 0;
        }
      }
    } catch {
      credentialReady = false;
    }
    if (credentialReady) {
      result.checks.push({
        kind: "ok",
        label: "Service-account credential path is protected and present",
        detail: "metadata only; credential contents were not read by doctor",
      });
    } else {
      result.status = "invalid";
      result.configured = false;
      result.checks.push({
        kind: "warn",
        label: "Service-account credential path is unsafe or unavailable",
        detail: "require a canonical current-user regular file with no group/other access",
      });
    }
    result.checks.push({
      kind: "ok",
      label: "Firebase project binding uses an explicit project id",
      detail:
        "the gateway injects it through a private configstore; .firebaserc is not required, created, or used as the project source, but an existing file is checked for alias conflicts",
    });
  } else if (inspected.projectSource === "firebaserc" && inspected.firebaseDir !== null) {
    const rcPath = path.join(inspected.firebaseDir, ".firebaserc");
    let rcReady = false;
    try {
      const metadata = await fileLstat(rcPath);
      if (
        metadata.isFile()
        && !metadata.isSymbolicLink()
        && metadata.nlink === 1
        && metadata.size > 0
        && metadata.size <= 64 * 1024
        && (
          platform === "win32"
          || (
            typeof process.getuid === "function"
            && metadata.uid === process.getuid()
            && (metadata.mode & 0o022) === 0
          )
        )
      ) {
        const parsed = JSON.parse(await fileRead(rcPath, "utf8"));
        rcReady = typeof parsed?.projects?.default === "string"
          && /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/u.test(parsed.projects.default);
      }
    } catch {
      rcReady = false;
    }
    if (rcReady) {
      result.checks.push({
        kind: "ok",
        label: "Firebase CLI project binding present",
        detail: "current-user .firebaserc has one valid non-writable default project binding",
      });
    } else {
      result.status = "invalid";
      result.configured = false;
      result.checks.push({
        kind: "warn",
        label: "Firebase CLI project binding missing or invalid",
        detail: "firebaserc profile requires a current-user .firebaserc with projects.default and no group/other write access",
      });
    }
  }

  result.checks.push({
    kind: "warn",
    label: "Firebase authentication/project identity not verified by doctor",
    detail: "after restart, use the gateway to verify environment → project → app; IAM is never auto-granted",
  });
  result.checks.push({
    kind: "warn",
    label: "Official route is only suitable for test or confirmed low-sensitivity projects",
    detail: "the gateway bounds tools/arguments/responses but does not isolate host credentials or pre-redact event text; use explicit Cloud Logging for production or unknown sensitivity",
  });
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

let doctorCli;
try {
  doctorCli = parseDoctorArgs(process.argv.slice(2));
} catch (error) {
  console.error(`[doctor] failed: ${safeErrorMessage(error)}`);
  process.exit(2);
}
if (doctorCli.help) {
  printDoctorHelp();
  process.exit(0);
}

const loadedMcpConfiguration = await loadDoctorMcpConfiguration(doctorCli.client);
const projectMcpText = loadedMcpConfiguration.mcpConfigText;
const projectMcpReadError = loadedMcpConfiguration.mcpConfigReadError;
const projectMcpScope = loadedMcpConfiguration.configScope;
const codexGlobalMcpConfigText = loadedMcpConfiguration.codexGlobalMcpConfigText;

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
  "build-runner-mcp",
  "crashlytics-mcp",
  "firebase-readonly-mcp",
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

// 5.4 The Build Runner is optional for read-only analysis. New installations
// explicitly select local_trusted; it is usable only for projects the user
// trusts and never counts as strong isolation. Docker remains an explicit
// opt-in and doctor never discovers, starts or pulls it.
{
  const runnerModule = path.join(
    ROOT,
    "mcp-servers",
    "build-runner-mcp",
    "dist",
    "runner.js",
  );
  const inspection = await inspectBuildRunnerConfiguration({
    shellEnv: process.env,
    mcpConfigText: projectMcpText,
    mcpConfigReadError: projectMcpReadError,
    probeCapabilities: await exists(runnerModule)
      ? async (effectiveEnv) => {
          const { TrustedBuildRunner } = await import(pathToFileURL(runnerModule).href);
          const runner = new TrustedBuildRunner({ env: effectiveEnv });
          try {
            return await runner.probeCapabilities();
          } finally {
            await runner.close().catch(() => undefined);
          }
        }
      : undefined,
  });
  for (const check of inspection.checks) {
    add(check.kind, check.label, check.detail);
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
    cloudLoggingOptional: true,
  });
  for (const check of inspection.checks) {
    add(check.kind, check.label, check.detail);
  }
}

// 5.6 Official Firebase MCP is CrashFix's default acquisition route. Validate
// only the pinned local invocation and optional project directory; authentication
// and project identity are verified through read-only MCP tools after restart.
let officialFirebaseInspection;
{
  officialFirebaseInspection = await inspectOfficialFirebaseConfiguration({
    mcpConfigText: projectMcpText,
    mcpConfigReadError: projectMcpReadError,
    fileStat: stat,
    fileRead: readFile,
    client: doctorCli.client,
    configScope: projectMcpScope,
    codexGlobalMcpConfigText,
  });
  for (const check of officialFirebaseInspection.checks) {
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
  const r = await run(
    "npm",
    ["exec", "--offline", "--yes", "@mobilenext/mobile-mcp@latest", "--", "--version"],
    {
      timeoutMs: 10000,
      env: { ...process.env, NPM_CONFIG_CACHE: PROJECT_NPM_CACHE },
    },
  );
  if (r.ok) {
    add("ok", `mobile-mcp ready (npx cache hit)`);
  } else {
    add("warn", "mobile-mcp not in npx cache", "run `npm run prewarm` to pre-download (or it'll download on first MCP client start)");
  }
}

// 7. Selected client's actual MCP configuration
if (projectMcpText !== undefined) {
  try {
    const j = JSON.parse(projectMcpText);
    if (!isObjectRecord(j)) throw new Error("config root must be an object");
    if (!isObjectRecord(j.mcpServers)) throw new Error("mcpServers must be an object");
    const servers = Object.keys(j.mcpServers);
    add(
      "ok",
      `${doctorCli.client} MCP configuration present`,
      `${projectMcpScope ?? "unknown"} scope; ${servers.length} normalized servers: ${servers.join(", ")}`,
    );
  } catch (e) {
    add("warn", `${doctorCli.client} MCP configuration invalid`, safeErrorMessage(e));
  }
} else if (projectMcpReadError) {
  add("warn", `${doctorCli.client} MCP configuration could not be read`, "check the selected client config");
} else {
  add(
    "warn",
    `${doctorCli.client} MCP configuration not present`,
    `run npm run setup -- --client ${doctorCli.client}`,
  );
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

console.log(
  `\n${BOLD}app_test_ctrl 环境自检${RESET}  (${sanitizeDiagnostic(ROOT)}, client=${doctorCli.client})\n`,
);
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
