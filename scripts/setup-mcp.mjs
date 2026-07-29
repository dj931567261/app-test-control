#!/usr/bin/env node
// scripts/setup-mcp.mjs
// 为目标 AI 客户端生成 MCP 配置。
//
// 用法：
//   node scripts/setup-mcp.mjs [--client <name>] [--force]
//
// 支持的 client：
//   claude-code    (默认) → 写 .mcp.json
//   cursor                → 写 .cursor/mcp.json
//   claude-desktop        → 打印 JSON 片段（粘贴到 ~/Library/Application Support/Claude/claude_desktop_config.json）
//   codex                 → 打印 TOML 片段（粘贴到 ~/.codex/config.toml）
//   opencode              → 写 opencode.json（项目根，opencode 自动从 cwd 向上找）

import { readFile, writeFile, access, mkdir } from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import path, { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import readline from "node:readline";

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, "..");
const examplePath = resolve(projectRoot, ".mcp.json.example");

const SUPPORTED_CLIENTS = ["claude-code", "cursor", "claude-desktop", "codex", "opencode", "antigravity"];

function parseArgs(argv) {
  const out = { client: "claude-code", force: false, global: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--client") out.client = argv[++i];
    else if (a === "--force" || a === "-f") out.force = true;
    else if (a === "--global") out.global = true;
    else if (a === "--project") out.global = false;
    else if (a === "--help" || a === "-h") {
      console.log(`Usage: setup-mcp.mjs [--client <name>] [--force] [--global|--project]`);
      console.log(`  --client one of: ${SUPPORTED_CLIENTS.join(", ")} (default claude-code)`);
      console.log(`  --force    overwrite existing file`);
      console.log(`  --global   install configuration globally`);
      console.log(`  --project  install configuration as project-level`);
      process.exit(0);
    }
  }
  return out;
}

function askQuestion(query) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });
    rl.question(query, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
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

async function loadExpanded() {
  const raw = await readFile(examplePath, "utf8");
  const template = JSON.parse(raw);
  return JSON.stringify(expandTemplateValue(template, projectRoot), null, 2);
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

async function writeJsonConfig(targetPath, content, force) {
  if (await exists(targetPath) && !force) {
    console.error(`[setup-mcp] ${targetPath} already exists`);
    console.error(`[setup-mcp] re-run with --force to overwrite`);
    process.exit(1);
  }
  await mkdir(dirname(targetPath), { recursive: true });
  await writeFile(targetPath, content, "utf8");
  console.log(`[setup-mcp] wrote ${targetPath}`);
  console.log(`[setup-mcp] PROJECT_ROOT = ${projectRoot}`);
}

function toToml(mcpJson) {
  // Emit Codex-CLI-compatible TOML: [mcp_servers.<name>] sections.
  // Supports: command (string), args (array of strings), env (object of strings).
  const lines = [];
  const servers = mcpJson.mcpServers ?? {};
  for (const [name, cfg] of Object.entries(servers)) {
    lines.push(`[mcp_servers.${name}]`);
    if (cfg.command) lines.push(`command = ${JSON.stringify(cfg.command)}`);
    if (Array.isArray(cfg.args)) {
      const arr = cfg.args.map((a) => JSON.stringify(a)).join(", ");
      lines.push(`args = [${arr}]`);
    }
    if (cfg.env && typeof cfg.env === "object") {
      const pairs = Object.entries(cfg.env)
        .map(([k, v]) => `${k} = ${JSON.stringify(v)}`)
        .join(", ");
      if (pairs) lines.push(`env = { ${pairs} }`);
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
  const { client, force, global } = parseArgs(process.argv.slice(2));
  if (!SUPPORTED_CLIENTS.includes(client)) {
    console.error(`[setup-mcp] unknown --client "${client}". Supported: ${SUPPORTED_CLIENTS.join(", ")}`);
    process.exit(2);
  }

  const expanded = await loadExpanded();

  if (client === "claude-code") {
    await writeJsonConfig(resolve(projectRoot, ".mcp.json"), expanded, force);
    return;
  }

  if (client === "cursor") {
    await writeJsonConfig(resolve(projectRoot, ".cursor/mcp.json"), expanded, force);
    return;
  }

  if (client === "claude-desktop") {
    // Claude Desktop 是 GUI app，spawn 子进程时不继承 shell PATH。
    // 把 npx 改写成绝对路径，避免 mobile-mcp 启不起来。
    const mcpJson = JSON.parse(expanded);
    const npxAbs = findNpxAbsPath();
    const nodeAbs = findNodeAbsPath();
    const pathNotes = [];
    if (npxAbs) {
      rewriteNpxToAbsPath(mcpJson, npxAbs);
      pathNotes.push(`# (Resolved \`npx\` to absolute path: ${npxAbs})`);
    } else {
      pathNotes.push(`# WARNING: couldn't resolve absolute npx path. Locate npx with \`where.exe npx\` (Windows) or \`which npx\`, then replace bare "npx" below.`);
    }
    if (nodeAbs) {
      rewriteNodeToAbsPath(mcpJson, nodeAbs);
      pathNotes.push(`# (Resolved \`node\` to absolute path: ${nodeAbs})`);
    } else {
      pathNotes.push(`# WARNING: couldn't resolve absolute node path. Locate node with \`where.exe node\` (Windows) or \`which node\`, then replace bare "node" below.`);
    }
    const rendered = JSON.stringify(mcpJson, null, 2);
    console.log(`# Claude Desktop MCP config snippet`);
    console.log(`# Paste the "mcpServers" block below into your Claude Desktop config file:`);
    console.log(`#   macOS:   ~/Library/Application Support/Claude/claude_desktop_config.json`);
    console.log(`#   Windows: %APPDATA%/Claude/claude_desktop_config.json`);
    console.log(`#   Linux:   ~/.config/Claude/claude_desktop_config.json`);
    console.log(`#`);
    console.log(`# (Merge with any existing "mcpServers" keys; do not replace the whole file.)`);
    console.log(`# Desktop GUI apps may not inherit shell PATH.`);
    pathNotes.forEach((note) => console.log(note));
    console.log(``);
    console.log(rendered);
    return;
  }

  if (client === "codex") {
    const mcpJson = JSON.parse(expanded);
    const toml = toToml(mcpJson);
    console.log(`# Codex CLI MCP config snippet`);
    console.log(`# Paste the [mcp_servers.*] sections below into ~/.codex/config.toml`);
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
    await writeJsonConfig(globalOpencodePath, JSON.stringify(existingConfig, null, 2), true);
    console.log(`[setup-mcp] Merged MCP servers into global opencode configuration: ${globalOpencodePath}`);
    return;
  }

  if (client === "antigravity") {
    const mcpJson = JSON.parse(expanded);
    const npxAbs = findNpxAbsPath();
    const nodeAbs = findNodeAbsPath();
    const adbAbs = findCommandAbsPath("adb");

    for (const cfg of Object.values(mcpJson.mcpServers ?? {})) {
      if (cfg.command === "npx" && npxAbs) {
        cfg.command = npxAbs;
      } else if (cfg.command === "node" && nodeAbs) {
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
    await writeJsonConfig(targetPath, rendered, force);
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
    console.error("[setup-mcp] failed:", err);
    process.exit(1);
  });
}
