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
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, "..");
const examplePath = resolve(projectRoot, ".mcp.json.example");

const SUPPORTED_CLIENTS = ["claude-code", "cursor", "claude-desktop", "codex", "opencode"];

function parseArgs(argv) {
  const out = { client: "claude-code", force: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--client") out.client = argv[++i];
    else if (a === "--force" || a === "-f") out.force = true;
    else if (a === "--help" || a === "-h") {
      console.log(`Usage: setup-mcp.mjs [--client <name>] [--force]`);
      console.log(`  --client one of: ${SUPPORTED_CLIENTS.join(", ")} (default claude-code)`);
      console.log(`  --force    overwrite existing file`);
      process.exit(0);
    }
  }
  return out;
}

async function exists(p) {
  try { await access(p); return true; } catch { return false; }
}

async function loadExpanded() {
  const raw = await readFile(examplePath, "utf8");
  return raw.replaceAll("${PROJECT_ROOT}", projectRoot);
}

// 探测 npx 绝对路径（用于 Claude Desktop 这类 GUI app — 它 spawn 子进程时不继承 shell PATH）。
// 失败时返回 null，由调用方决定是否兜底成裸 "npx"。
function findNpxAbsPath() {
  try {
    const out = execFileSync("which", ["npx"], { encoding: "utf8", timeout: 3000 }).trim();
    return out || null;
  } catch {
    return null;
  }
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
  const { client, force } = parseArgs(process.argv.slice(2));
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
    let pathNote = "";
    if (npxAbs) {
      rewriteNpxToAbsPath(mcpJson, npxAbs);
      pathNote = `# (Resolved \`npx\` to absolute path: ${npxAbs} — Desktop GUI doesn't see shell PATH)`;
    } else {
      pathNote = `# WARNING: couldn't resolve absolute npx path. Claude Desktop may fail to start mobile-mcp.\n# Fix: run \`which npx\` in your shell and replace "npx" below with the output.`;
    }
    const rendered = JSON.stringify(mcpJson, null, 2);
    console.log(`# Claude Desktop MCP config snippet`);
    console.log(`# Paste the "mcpServers" block below into your Claude Desktop config file:`);
    console.log(`#   macOS:   ~/Library/Application Support/Claude/claude_desktop_config.json`);
    console.log(`#   Windows: %APPDATA%/Claude/claude_desktop_config.json`);
    console.log(`#   Linux:   ~/.config/Claude/claude_desktop_config.json`);
    console.log(`#`);
    console.log(`# (Merge with any existing "mcpServers" keys; do not replace the whole file.)`);
    console.log(pathNote);
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
    // opencode 项目级配置:仓库根的 opencode.json,opencode 启动时会从 cwd 向上查找直到 git 根。
    // 直接写文件,跟 claude-code 体感一致。
    const mcpJson = JSON.parse(expanded);
    const rendered = toOpencode(mcpJson);
    await writeJsonConfig(resolve(projectRoot, "opencode.json"), rendered, force);
    return;
  }
}

main().catch((err) => {
  console.error("[setup-mcp] failed:", err);
  process.exit(1);
});
