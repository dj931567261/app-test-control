#!/usr/bin/env node
// scripts/setup-mcp.mjs
// 为目标 AI 客户端生成 MCP 配置。
//
// 用法：
//   node scripts/setup-mcp.mjs [--client <name>] [--force]
//     [--firebase-dir <absolute-directory>]
//     [--firebase-project-source <service-account|firebaserc>]
//     [--firebase-project-id <project-id>]
//     [--firebase-service-account <absolute-json-file>]
//     [--build-runner-backend <local_trusted|docker>]
//
// 支持的 client：
//   claude-code    (默认) → 写 .mcp.json
//   cursor                → 写 .cursor/mcp.json
//   claude-desktop        → 打印 JSON 片段（粘贴到 ~/Library/Application Support/Claude/claude_desktop_config.json）
//   codex                 → 打印 TOML 片段（默认合并到当前 checkout 的 .codex/config.toml）
//   opencode              → 写 opencode.json（项目根，opencode 自动从 cwd 向上找）

import {
  access,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path, { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import {
  bindOfficialFirebaseServerOwner,
  buildCodexOfficialFirebaseServer,
  buildOfficialFirebaseServer,
  FIREBASE_PROJECT_SOURCES,
  OFFICIAL_FIREBASE_READ_TOOLS,
} from "./firebase-mcp-config.mjs";

const here = dirname(fileURLToPath(import.meta.url));
// Configuration ownership and executable paths must use one canonical checkout
// identity. This also avoids /var vs /private/var aliases on macOS.
const projectRoot = realpathSync(resolve(here, ".."));
const examplePath = resolve(projectRoot, ".mcp.json.example");

const SUPPORTED_CLIENTS = ["claude-code", "cursor", "claude-desktop", "codex", "opencode", "antigravity"];
const SUPPORTED_BUILD_RUNNER_BACKENDS = ["local_trusted", "docker"];

class CliUsageError extends Error {}

function safeErrorMessage(error) {
  return String(error instanceof Error ? error.message : error)
    .replace(/\x1b/gu, "\\x1b")
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, "?")
    .slice(0, 1000);
}

function parseArgs(argv) {
  const out = {
    client: "claude-code",
    force: false,
    firebaseDir: null,
    firebaseProjectSource: null,
    firebaseProjectId: null,
    firebaseServiceAccount: null,
    buildRunnerBackend: "local_trusted",
    help: false,
  };
  const seen = new Set();
  const mark = (name) => {
    if (seen.has(name)) throw new CliUsageError(`${name} may be supplied only once`);
    seen.add(name);
  };
  const valueAfter = (index, name) => {
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new CliUsageError(`${name} requires a value`);
    }
    return value;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--client") {
      mark("--client");
      out.client = valueAfter(i, a);
      i += 1;
    }
    else if (a === "--force" || a === "-f") {
      mark("--force");
      out.force = true;
    }
    else if (a === "--global" || a === "--project") {
      throw new CliUsageError(`${a} is only supported by install-skills, not setup-mcp`);
    }
    else if (a === "--firebase-dir") {
      mark("--firebase-dir");
      out.firebaseDir = valueAfter(i, a);
      i += 1;
    }
    else if (a === "--firebase-project-source") {
      mark("--firebase-project-source");
      const value = valueAfter(i, a);
      i += 1;
      if (!FIREBASE_PROJECT_SOURCES.includes(value)) {
        throw new CliUsageError(
          `--firebase-project-source must be one of: ${FIREBASE_PROJECT_SOURCES.join(", ")}`,
        );
      }
      out.firebaseProjectSource = value;
    }
    else if (a === "--firebase-project-id") {
      mark("--firebase-project-id");
      out.firebaseProjectId = valueAfter(i, a);
      i += 1;
      if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/u.test(out.firebaseProjectId)) {
        throw new CliUsageError("--firebase-project-id is not a valid Firebase project id");
      }
    }
    else if (a === "--firebase-service-account") {
      mark("--firebase-service-account");
      out.firebaseServiceAccount = valueAfter(i, a);
      i += 1;
    }
    else if (a === "--build-runner-backend") {
      mark("--build-runner-backend");
      const value = valueAfter(i, a);
      i += 1;
      if (!SUPPORTED_BUILD_RUNNER_BACKENDS.includes(value)) {
        throw new CliUsageError(
          `--build-runner-backend must be one of: ${SUPPORTED_BUILD_RUNNER_BACKENDS.join(", ")}`,
        );
      }
      out.buildRunnerBackend = value;
    }
    else if (a === "--help" || a === "-h") {
      mark("--help");
      out.help = true;
    }
    else {
      throw new CliUsageError(`unknown or positional argument: ${a}`);
    }
  }
  if (out.help && argv.length !== 1) {
    throw new CliUsageError("--help cannot be combined with other arguments");
  }
  const firebaseOptionSupplied = out.firebaseDir !== null
    || out.firebaseProjectSource !== null
    || out.firebaseProjectId !== null
    || out.firebaseServiceAccount !== null;
  if (firebaseOptionSupplied && out.firebaseProjectSource === null) {
    throw new CliUsageError(
      "Firebase configuration requires --firebase-project-source service-account or firebaserc",
    );
  }
  if (out.firebaseProjectSource !== null && out.firebaseDir === null) {
    throw new CliUsageError("--firebase-project-source requires --firebase-dir");
  }
  if (out.firebaseProjectSource === "service-account") {
    if (out.firebaseProjectId === null || out.firebaseServiceAccount === null) {
      throw new CliUsageError(
        "service-account source requires --firebase-project-id and --firebase-service-account",
      );
    }
  } else if (out.firebaseProjectId !== null || out.firebaseServiceAccount !== null) {
    throw new CliUsageError(
      "--firebase-project-id and --firebase-service-account are only valid with service-account source",
    );
  }
  return out;
}

function printHelp() {
  console.log(`Usage: setup-mcp.mjs [--client <name>] [--force] [--firebase-dir <absolute-directory>] [--firebase-project-source <service-account|firebaserc>] [--firebase-project-id <project-id>] [--firebase-service-account <absolute-json-file>] [--build-runner-backend <local_trusted|docker>]`);
  console.log(`  --client one of: ${SUPPORTED_CLIENTS.join(", ")} (default claude-code)`);
  console.log(`  --force    overwrite existing file`);
  console.log(`  --firebase-project-source  choose service-account or firebaserc before supplying Firebase options`);
  console.log(`  --firebase-dir  absolute app directory required by either Firebase profile`);
  console.log(`  --firebase-project-id  explicit project id required by service-account source`);
  console.log(`  --firebase-service-account  absolute service-account JSON path required by that profile`);
  console.log(`  --build-runner-backend  local_trusted (default) or docker`);
  console.log(`  MCP setup has no scope flag; --global/--project belong to install-skills.`);
}

async function exists(p) {
  try { await access(p); return true; } catch { return false; }
}

// 模板只约定替换 JSON 值中的占位符；JSON key 不属于路径模板。先解析再递归
// 展开，最后交给 JSON.stringify 转义，避免 Windows 反斜杠、空格或引号破坏 JSON。
export function expandTemplateValue(value, replacement) {
  if (typeof value === "string") {
    // 回调替换可把 `$&`、`$$`、`$\``、`$'` 等合法路径字符按字面量保留。
    return value.replaceAll("${PROJECT_ROOT}", () => replacement);
  }
  if (Array.isArray(value)) {
    return value.map((item) => expandTemplateValue(item, replacement));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        expandTemplateValue(item, replacement),
      ]),
    );
  }
  return value;
}

function configureBuildRunnerBackend(expanded, backend) {
  const buildRunner = expanded.mcpServers?.["build-runner"];
  if (!buildRunner || typeof buildRunner !== "object" || Array.isArray(buildRunner)) {
    throw new Error(".mcp.json.example must contain a build-runner MCP server object");
  }
  if (backend === "local_trusted") {
    // Do not emit empty local-toolchain or Docker placeholders. Empty child
    // values override a GUI/CLI client's inherited environment and would make
    // a valid local JAVA_HOME / Android SDK look absent.
    buildRunner.env = {
      APP_TEST_CTRL_BUILD_RUNNER_BACKEND: "local_trusted",
    };
    return;
  }
  if (backend === "docker") {
    // Docker remains an explicit, fail-closed opt-in. Setup never discovers,
    // starts or pulls Docker on the user's behalf.
    buildRunner.env = {
      APP_TEST_CTRL_BUILD_RUNNER_BACKEND: "docker",
      APP_TEST_CTRL_BUILD_RUNNER_DOCKER_BIN: "",
      APP_TEST_CTRL_BUILD_RUNNER_DOCKER_HOST: "",
      APP_TEST_CTRL_BUILD_RUNNER_IMAGE: "",
      APP_TEST_CTRL_BUILD_RUNNER_OCI_RUNTIME: "runc",
    };
    return;
  }
  throw new Error(`unsupported Build Runner backend: ${backend}`);
}

async function loadExpanded({
  firebaseDir = null,
  firebaseProjectSource = null,
  firebaseProjectId = null,
  firebaseServiceAccount = null,
  buildRunnerBackend = "local_trusted",
} = {}) {
  const raw = await readFile(examplePath, "utf8");
  const template = JSON.parse(raw);
  const expanded = expandTemplateValue(template, projectRoot);
  if (
    !expanded.mcpServers
    || typeof expanded.mcpServers !== "object"
    || Array.isArray(expanded.mcpServers)
  ) {
    throw new Error(".mcp.json.example must contain an mcpServers object");
  }
  configureBuildRunnerBackend(expanded, buildRunnerBackend);
  expanded.mcpServers.firebase = bindOfficialFirebaseServerOwner(
    buildOfficialFirebaseServer(firebaseDir, {
      projectRoot,
      projectSource: firebaseProjectSource,
      firebaseProjectId,
      serviceAccountPath: firebaseServiceAccount,
    }),
    projectRoot,
  );
  const projectNpmCache = path.join(projectRoot, ".codex", "npm-cache");
  for (const server of Object.values(expanded.mcpServers)) {
    if (server?.command !== "npx") continue;
    server.env = {
      ...(server.env && typeof server.env === "object" && !Array.isArray(server.env)
        ? server.env
        : {}),
      NPM_CONFIG_CACHE: projectNpmCache,
    };
  }
  return JSON.stringify(expanded, null, 2);
}

async function validateFirebaseServiceAccount(candidate) {
  if (
    typeof candidate !== "string"
    || !candidate
    || candidate.includes("\0")
    || !path.isAbsolute(candidate)
  ) {
    throw new Error("--firebase-service-account must be an absolute protected regular file");
  }
  let before;
  let canonical;
  try {
    before = await lstat(candidate);
    canonical = await realpath(candidate);
  } catch {
    throw new Error("--firebase-service-account must be an absolute protected regular file");
  }
  if (
    !before.isFile()
    || before.isSymbolicLink()
    || before.nlink !== 1
    || before.size < 1
    || before.size > 64 * 1024
    || canonical !== path.normalize(candidate)
  ) {
    throw new Error("--firebase-service-account must be an absolute protected regular file");
  }
  if (process.platform !== "win32") {
    if (
      typeof process.getuid !== "function"
      || before.uid !== process.getuid()
      || (before.mode & 0o077) !== 0
    ) {
      throw new Error(
        "--firebase-service-account must belong to the current user and deny group/other access",
      );
    }
  }
  return canonical;
}

async function validateFirebaserc(firebaseDir) {
  const candidate = path.join(firebaseDir, ".firebaserc");
  let metadata;
  let text;
  try {
    metadata = await lstat(candidate);
    if (
      !metadata.isFile()
      || metadata.isSymbolicLink()
      || metadata.nlink !== 1
      || metadata.size < 1
      || metadata.size > 64 * 1024
      || (
        process.platform !== "win32"
        && (
          typeof process.getuid !== "function"
          || metadata.uid !== process.getuid()
          || (metadata.mode & 0o022) !== 0
        )
      )
    ) {
      throw new Error("invalid metadata");
    }
    text = await readFile(candidate, "utf8");
  } catch {
    throw new Error(
      "firebaserc project source requires an existing current-user .firebaserc that is not group/other writable",
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(".firebaserc must contain valid JSON with projects.default");
  }
  if (
    !parsed
    || typeof parsed !== "object"
    || Array.isArray(parsed)
    || !parsed.projects
    || typeof parsed.projects !== "object"
    || Array.isArray(parsed.projects)
    || typeof parsed.projects.default !== "string"
    || !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/u.test(parsed.projects.default)
  ) {
    throw new Error(".firebaserc must contain a valid projects.default Firebase project id");
  }
}

async function validateFirebaseDirectory(firebaseDir) {
  if (
    typeof firebaseDir !== "string"
    || firebaseDir.length === 0
    || firebaseDir.includes("\0")
    || !path.isAbsolute(firebaseDir)
  ) {
    throw new Error("--firebase-dir must be an absolute existing directory");
  }
  let canonical;
  try {
    canonical = await realpath(firebaseDir);
  } catch {
    throw new Error("--firebase-dir must be an absolute existing directory");
  }
  const metadata = await stat(canonical);
  if (!metadata.isDirectory()) {
    throw new Error("--firebase-dir must be an absolute existing directory");
  }
  return canonical;
}

function pathApi(platform) {
  return platform === "win32" ? path.win32 : path.posix;
}

// where.exe 可能返回多个匹配项；只接受第一条绝对路径。路径作为 JSON 字符串值
// 传递，不添加 shell 引号，因此带空格的路径也能被 exec/spawn 正确使用。
export function firstAbsoluteCommandPath(output, platform = process.platform) {
  const api = pathApi(platform);
  const lines = String(output ?? "").replace(/^\uFEFF/, "").split(/\r?\n/);
  for (const rawLine of lines) {
    let candidate = rawLine.trim();
    if (
      candidate.length >= 2
      && candidate.startsWith('"')
      && candidate.endsWith('"')
    ) {
      candidate = candidate.slice(1, -1);
    }
    if (candidate && api.isAbsolute(candidate)) {
      return api.normalize(candidate);
    }
  }
  return null;
}

export function findCommandAbsPath(
  command,
  {
    platform = process.platform,
    execFileSyncFn = execFileSync,
  } = {},
) {
  try {
    const locator = platform === "win32" ? "where.exe" : "which";
    const output = execFileSyncFn(locator, [command], {
      encoding: "utf8",
      timeout: 3000,
      windowsHide: true,
    });
    return firstAbsoluteCommandPath(output, platform);
  } catch {
    return null;
  }
}

// 当前脚本已经由 Node 启动，process.execPath 比 PATH lookup 更可靠，尤其是在
// Windows 和 GUI 客户端环境中。仅在异常的相对 execPath 情况下才查 PATH。
export function findNodeAbsPath(
  {
    platform = process.platform,
    execPath = process.execPath,
    execFileSyncFn = execFileSync,
  } = {},
) {
  const api = pathApi(platform);
  if (typeof execPath === "string" && api.isAbsolute(execPath)) {
    return api.normalize(execPath);
  }
  return findCommandAbsPath("node", { platform, execFileSyncFn });
}

// 探测 npx 绝对路径（用于 Claude Desktop 这类 GUI app — 它 spawn 子进程时
// 不继承 shell PATH）。优先使用当前 Node 同目录的启动器；Windows 的 npm 分发
// 默认提供 npx.cmd。失败时再使用 where.exe/which，并正确处理多行输出。
export function findNpxAbsPath(
  {
    platform = process.platform,
    execPath = process.execPath,
    pathExists = existsSync,
    execFileSyncFn = execFileSync,
  } = {},
) {
  const api = pathApi(platform);
  if (typeof execPath === "string" && api.isAbsolute(execPath)) {
    const directory = api.dirname(execPath);
    const names = platform === "win32" ? ["npx.cmd", "npx.exe", "npx"] : ["npx"];
    for (const name of names) {
      const candidate = api.join(directory, name);
      try {
        if (pathExists(candidate)) return api.normalize(candidate);
      } catch {
        // 继续使用 PATH locator；自定义/受限文件系统探测可能抛错。
      }
    }
  }
  return findCommandAbsPath("npx", { platform, execFileSyncFn });
}

// 把 mcpServers 里所有 command === "npx" 的项改写成 absPath。
// 用在 claude-desktop 分支。
function rewriteNpxToAbsPath(mcpJson, absPath) {
  const servers = mcpJson.mcpServers ?? {};
  for (const cfg of Object.values(servers)) {
    if (cfg.command === "npx") cfg.command = absPath;
  }
  return mcpJson;
}

function rewriteNodeToAbsPath(mcpJson, absPath) {
  const servers = mcpJson.mcpServers ?? {};
  for (const cfg of Object.values(servers)) {
    if (cfg.command === "node") cfg.command = absPath;
  }
  return mcpJson;
}

async function ensureConfigParent(targetPath, allowedRoot) {
  const absoluteTarget = path.resolve(targetPath);
  const absoluteAllowedRoot = path.resolve(allowedRoot);
  const relativeTarget = path.relative(absoluteAllowedRoot, absoluteTarget);
  if (
    relativeTarget === ""
    || relativeTarget === ".."
    || relativeTarget.startsWith(`..${path.sep}`)
    || path.isAbsolute(relativeTarget)
  ) {
    throw new Error("refusing to write configuration outside its allowed root");
  }

  const canonicalAllowedRoot = await realpath(absoluteAllowedRoot);
  const allowedMetadata = await lstat(canonicalAllowedRoot);
  if (!allowedMetadata.isDirectory() || allowedMetadata.isSymbolicLink()) {
    throw new Error("configuration allowed root must be a canonical directory");
  }

  // Create one component at a time under the already-canonical allowed root.
  // recursive mkdir before validation could otherwise follow an attacker-made
  // parent symlink and create directories outside the intended root.
  let canonicalParent = canonicalAllowedRoot;
  const relativeParent = path.dirname(relativeTarget);
  const components = relativeParent === "." ? [] : relativeParent.split(path.sep);
  for (const component of components) {
    if (!component || component === "." || component === "..") {
      throw new Error("invalid configuration parent path");
    }
    const next = path.join(canonicalParent, component);
    let metadata;
    try {
      metadata = await lstat(next);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      await mkdir(next, { mode: 0o700 });
      metadata = await lstat(next);
    }
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error("refusing to traverse a linked or non-directory config parent");
    }
    const canonicalNext = await realpath(next);
    if (canonicalNext !== next) {
      throw new Error("refusing to traverse a non-canonical config parent");
    }
    canonicalParent = canonicalNext;
  }

  return {
    canonicalParent,
    canonicalTarget: path.join(canonicalParent, path.basename(relativeTarget)),
  };
}

async function writeJsonConfig(targetPath, content, force, allowedRoot) {
  const { canonicalParent, canonicalTarget } = await ensureConfigParent(
    targetPath,
    allowedRoot,
  );
  let existingMetadata;
  try {
    existingMetadata = await lstat(canonicalTarget);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  if (existingMetadata && !force) {
    console.error(`[setup-mcp] target configuration already exists`);
    console.error(`[setup-mcp] re-run with --force to overwrite`);
    process.exit(1);
  }
  if (
    existingMetadata
    && (existingMetadata.isSymbolicLink()
      || !existingMetadata.isFile()
      || existingMetadata.nlink !== 1)
  ) {
    throw new Error("refusing to overwrite a linked or non-regular configuration file");
  }

  const tempPath = path.join(
    canonicalParent,
    `.app-test-ctrl-${process.pid}-${randomBytes(8).toString("hex")}.tmp`,
  );
  let handle;
  let tempIdentity;
  try {
    handle = await open(tempPath, "wx", 0o600);
    await handle.writeFile(content, "utf8");
    await handle.sync();
    tempIdentity = await handle.stat({ bigint: true });
    await handle.close();
    handle = undefined;
    await rename(tempPath, canonicalTarget);
    const writtenMetadata = await lstat(canonicalTarget, { bigint: true });
    if (
      !writtenMetadata.isFile()
      || writtenMetadata.isSymbolicLink()
      || writtenMetadata.nlink !== 1n
      || writtenMetadata.dev !== tempIdentity.dev
      || writtenMetadata.ino !== tempIdentity.ino
      || writtenMetadata.size !== tempIdentity.size
    ) {
      throw new Error("configuration target identity changed after atomic rename");
    }
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
  console.log(`[setup-mcp] wrote ${targetPath}`);
  console.log(`[setup-mcp] PROJECT_ROOT = ${projectRoot}`);
}

function toToml(mcpJson) {
  // Emit Codex-CLI-compatible TOML: [mcp_servers.<name>] sections.
  // Supports the bounded stdio/runtime fields generated by this installer.
  const lines = [];
  const servers = mcpJson.mcpServers ?? {};
  for (const [name, cfg] of Object.entries(servers)) {
    lines.push(`[mcp_servers.${name}]`);
    if (typeof cfg.enabled === "boolean") {
      lines.push(`enabled = ${cfg.enabled}`);
    }
    if (cfg.command) lines.push(`command = ${JSON.stringify(cfg.command)}`);
    if (Array.isArray(cfg.args)) {
      const arr = cfg.args.map((a) => JSON.stringify(a)).join(", ");
      lines.push(`args = [${arr}]`);
    }
    if (typeof cfg.cwd === "string") {
      lines.push(`cwd = ${JSON.stringify(cfg.cwd)}`);
    }
    if (Number.isFinite(cfg.startup_timeout_sec)) {
      lines.push(`startup_timeout_sec = ${cfg.startup_timeout_sec}`);
    }
    if (Array.isArray(cfg.env_vars)) {
      const envVars = cfg.env_vars.map((name) => JSON.stringify(name)).join(", ");
      lines.push(`env_vars = [${envVars}]`);
    }
    if (cfg.env && typeof cfg.env === "object") {
      const pairs = Object.entries(cfg.env)
        .map(([k, v]) => `${k} = ${JSON.stringify(v)}`)
        .join(", ");
      if (pairs) lines.push(`env = { ${pairs} }`);
    }
    const enabledToolNames = Array.isArray(cfg.enabled_tools)
      ? cfg.enabled_tools
      : name === "firebase"
        ? OFFICIAL_FIREBASE_READ_TOOLS
        : null;
    if (enabledToolNames !== null) {
      // 用正向 allowlist 而不是枚举已知写工具：固定版本未来即使暴露额外工具，
      // Codex 也不会自动启用它们。
      const enabledTools = enabledToolNames
        .map((tool) => JSON.stringify(tool))
        .join(", ");
      lines.push(`enabled_tools = [${enabledTools}]`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

function toOpencode(mcpJson) {
  // opencode 配置 schema:
  //   { "$schema": "https://opencode.ai/config.json",
  //     "mcp": { "<name>": {
  //         "type": "local",
  //         "command": ["<bin>", ...args],   // 注意:opencode 把 cmd+args 合并成一个数组
  //         "environment": { ... },          // 字段名是 environment 不是 env
  //         "enabled": true
  //       }, ... } }
  const out = {
    $schema: "https://opencode.ai/config.json",
    mcp: {},
  };
  const servers = mcpJson.mcpServers ?? {};
  for (const [name, cfg] of Object.entries(servers)) {
    const entry = {
      type: "local",
      command: [cfg.command, ...(Array.isArray(cfg.args) ? cfg.args : [])],
      enabled: true,
    };
    if (cfg.env && typeof cfg.env === "object" && Object.keys(cfg.env).length > 0) {
      entry.environment = { ...cfg.env };
    }
    out.mcp[name] = entry;
  }
  return JSON.stringify(out, null, 2);
}

async function main() {
  const {
    client,
    force,
    firebaseDir,
    firebaseProjectSource,
    firebaseProjectId,
    firebaseServiceAccount,
    buildRunnerBackend,
    help,
  } = parseArgs(process.argv.slice(2));
  if (help) {
    printHelp();
    return;
  }
  if (!SUPPORTED_CLIENTS.includes(client)) {
    throw new CliUsageError(
      `unknown --client; supported values: ${SUPPORTED_CLIENTS.join(", ")}`,
    );
  }

  const canonicalFirebaseDir = firebaseDir === null
    ? null
    : await validateFirebaseDirectory(firebaseDir);
  const canonicalServiceAccount = firebaseServiceAccount === null
    ? null
    : await validateFirebaseServiceAccount(firebaseServiceAccount);
  if (firebaseProjectSource === "firebaserc") {
    await validateFirebaserc(canonicalFirebaseDir);
  }
  const expanded = await loadExpanded({
    firebaseDir: canonicalFirebaseDir,
    firebaseProjectSource,
    firebaseProjectId,
    firebaseServiceAccount: canonicalServiceAccount,
    buildRunnerBackend,
  });

  if (client === "claude-code") {
    await writeJsonConfig(resolve(projectRoot, ".mcp.json"), expanded, force, projectRoot);
    return;
  }

  if (client === "cursor") {
    await writeJsonConfig(resolve(projectRoot, ".cursor/mcp.json"), expanded, force, projectRoot);
    return;
  }

  if (client === "claude-desktop") {
    // Claude Desktop 是 GUI app，spawn 子进程时不继承 shell PATH。
    // 把 npx 改写成绝对路径，避免 mobile-mcp 启不起来。
    const mcpJson = JSON.parse(expanded);
    const npxAbs = findNpxAbsPath();
    const nodeAbs = findNodeAbsPath();
    if (!npxAbs) throw new Error("could not resolve an absolute npx launcher");
    if (!nodeAbs) throw new Error("could not resolve an absolute Node launcher");
    rewriteNpxToAbsPath(mcpJson, npxAbs);
    rewriteNodeToAbsPath(mcpJson, nodeAbs);
    const rendered = JSON.stringify(mcpJson, null, 2);
    console.log(`# Claude Desktop MCP config snippet`);
    console.log(`# Paste the "mcpServers" block below into your Claude Desktop config file:`);
    console.log(`#   macOS:   ~/Library/Application Support/Claude/claude_desktop_config.json`);
    console.log(`#   Windows: %APPDATA%/Claude/claude_desktop_config.json`);
    console.log(`#   Linux:   ~/.config/Claude/claude_desktop_config.json`);
    console.log(`#`);
    console.log(`# (Merge with any existing "mcpServers" keys; do not replace the whole file.)`);
    console.log(`# Desktop GUI apps may not inherit shell PATH.`);
    console.log(`# Resolved node and npx to absolute launchers.`);
    console.log(``);
    console.log(rendered);
    return;
  }

  if (client === "codex") {
    const mcpJson = JSON.parse(expanded);
    const npxAbs = findNpxAbsPath();
    const nodeAbs = findNodeAbsPath();
    if (!npxAbs) {
      throw new Error(
        "could not resolve an absolute npx launcher; fix PATH/npx before generating Codex config",
      );
    }
    if (!nodeAbs) {
      throw new Error(
        "could not resolve an absolute Node launcher; fix Node before generating Codex config",
      );
    }
    rewriteNpxToAbsPath(mcpJson, npxAbs);
    rewriteNodeToAbsPath(mcpJson, nodeAbs);
    const firebase = mcpJson.mcpServers?.firebase;
    if (!firebase) throw new Error("official Firebase MCP entry is missing");
    mcpJson.mcpServers.firebase = buildCodexOfficialFirebaseServer(
      firebase,
      realpathSync(projectRoot),
      { nodeCommand: nodeAbs },
    );
    const toml = toToml(mcpJson);
    console.log(`# Codex CLI MCP config snippet`);
    console.log(`# Paste the [mcp_servers.*] sections below into this checkout's .codex/config.toml`);
    console.log(`# Keep service-account profiles project-local; do not copy them to global config.`);
    console.log(`# Resolved npx to an absolute launcher for GUI/CLI parity.`);
    console.log(``);
    console.log(toml);
    return;
  }

  if (client === "opencode") {
    const mcpJson = JSON.parse(expanded);
    const rendered = toOpencode(mcpJson);

    const globalOpencodePath = process.platform === "win32"
      ? resolve(process.env.APPDATA || resolve(homedir(), "AppData/Roaming"), "opencode/opencode.json")
      : resolve(homedir(), ".config/opencode/opencode.json");

    let existingConfig = { $schema: "https://opencode.ai/config.json", mcp: {} };
    if (await exists(globalOpencodePath)) {
      try {
        const raw = await readFile(globalOpencodePath, "utf8");
        existingConfig = JSON.parse(raw);
        if (!existingConfig || typeof existingConfig !== "object" || Array.isArray(existingConfig)) {
          throw new Error("existing config root must be an object");
        }
        if (existingConfig.mcp === undefined) existingConfig.mcp = {};
        if (!existingConfig.mcp || typeof existingConfig.mcp !== "object" || Array.isArray(existingConfig.mcp)) {
          throw new Error("existing mcp field must be an object");
        }
      } catch (e) {
        throw new Error(`refusing to overwrite invalid existing OpenCode config: ${e.message}`);
      }
    }
    
    const newConfig = JSON.parse(rendered);
    const collisions = Object.keys(newConfig.mcp).filter((key) =>
      Object.prototype.hasOwnProperty.call(existingConfig.mcp, key)
    );
    if (collisions.length > 0 && !force) {
      throw new Error(
        `OpenCode MCP entries already exist: ${collisions.join(", ")}; use --force to replace only these keys`,
      );
    }
    existingConfig.mcp = { ...existingConfig.mcp, ...newConfig.mcp };
    await writeJsonConfig(
      globalOpencodePath,
      JSON.stringify(existingConfig, null, 2),
      true,
      homedir(),
    );
    console.log(`[setup-mcp] Merged MCP servers into global opencode configuration: ${globalOpencodePath}`);
    return;
  }

  if (client === "antigravity") {
    const mcpJson = JSON.parse(expanded);
    const npxAbs = findNpxAbsPath();
    const nodeAbs = findNodeAbsPath();
    const adbAbs = findCommandAbsPath("adb");

    if (!npxAbs) throw new Error("could not resolve an absolute npx launcher");
    if (!nodeAbs) throw new Error("could not resolve an absolute Node launcher");

    for (const cfg of Object.values(mcpJson.mcpServers ?? {})) {
      if (cfg.command === "npx") {
        cfg.command = npxAbs;
      } else if (cfg.command === "node") {
        cfg.command = nodeAbs;
      }
      if (!cfg.env) cfg.env = {};
      if (process.env.PATH) {
        cfg.env.PATH = process.env.PATH;
      }
      if (cfg.env.ADB_BIN === "adb" && adbAbs) {
        cfg.env.ADB_BIN = adbAbs;
      }
    }

    const targetPath = resolve(homedir(), ".gemini/config/mcp_config.json");
    const rendered = JSON.stringify(mcpJson, null, 2);
    await writeJsonConfig(targetPath, rendered, force, homedir());
    return;
  }
}

function isDirectExecutionPath(argvPath) {
  if (!argvPath) return false;
  const modulePath = fileURLToPath(import.meta.url);
  try {
    // macOS 的 /var → /private/var 等路径别名不应让直接执行被误判成 import。
    return realpathSync(argvPath) === realpathSync(modulePath);
  } catch {
    return resolve(argvPath) === modulePath;
  }
}

const isDirectExecution = isDirectExecutionPath(process.argv[1]);

if (isDirectExecution) {
  main().catch((err) => {
    console.error(`[setup-mcp] failed: ${safeErrorMessage(err)}`);
    process.exit(err instanceof CliUsageError ? 2 : 1);
  });
}
