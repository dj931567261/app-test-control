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

import { readFile, writeFile, access, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, "..");
const examplePath = resolve(projectRoot, ".mcp.json.example");

const SUPPORTED_CLIENTS = ["claude-code", "cursor", "claude-desktop", "codex"];

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
    console.log(`# Claude Desktop MCP config snippet`);
    console.log(`# Paste the "mcpServers" block below into your Claude Desktop config file:`);
    console.log(`#   macOS:   ~/Library/Application Support/Claude/claude_desktop_config.json`);
    console.log(`#   Windows: %APPDATA%/Claude/claude_desktop_config.json`);
    console.log(`#   Linux:   ~/.config/Claude/claude_desktop_config.json`);
    console.log(`#`);
    console.log(`# (Merge with any existing "mcpServers" keys; do not replace the whole file.)`);
    console.log(``);
    console.log(expanded);
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
}

main().catch((err) => {
  console.error("[setup-mcp] failed:", err);
  process.exit(1);
});
