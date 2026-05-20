#!/usr/bin/env node
// scripts/uninstall.mjs
// 卸载指定 AI 客户端的 MCP 配置与 Skills。
//
// 用法：
//   node scripts/uninstall.mjs [--client <name>]
//

import { readFile, writeFile, rm, access } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, "..");

const SUPPORTED_CLIENTS = ["claude-code", "cursor", "codex", "claude-desktop", "opencode", "antigravity"];
const SERVERS_TO_REMOVE = ["log-mcp", "report-mcp", "ui-mcp", "analyzer-mcp", "code-analyzer-mcp", "mobile", "log", "report", "ui", "analyzer", "code-analyzer"];
const SKILLS_TO_REMOVE = ["devtest", "qa", "minimize", "smart-qa"];

function parseArgs(argv) {
  const out = { client: "claude-code" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--client") out.client = argv[++i];
    else if (a === "--help" || a === "-h") {
      console.log(`Usage: uninstall.mjs [--client <name>]`);
      console.log(`  --client one of: ${SUPPORTED_CLIENTS.join(", ")} (default claude-code)`);
      process.exit(0);
    }
  }
  return out;
}

async function exists(p) {
  try { await access(p); return true; } catch { return false; }
}

async function safeRemove(p, recursive = false) {
  if (await exists(p)) {
    await rm(p, { recursive, force: true });
    console.log(`[uninstall] Removed: ${p}`);
  }
}

async function main() {
  const { client } = parseArgs(process.argv.slice(2));
  if (!SUPPORTED_CLIENTS.includes(client)) {
    console.error(`[uninstall] unknown --client "${client}". Supported: ${SUPPORTED_CLIENTS.join(", ")}`);
    process.exit(2);
  }

  console.log(`[uninstall] Uninstalling MCP servers and skills for client: ${client}`);

  if (client === "claude-code") {
    // 1) MCP
    await safeRemove(resolve(projectRoot, ".mcp.json"));
    // 2) Skills (project-level)
    await safeRemove(resolve(projectRoot, ".claude/skills"), true);
  }

  else if (client === "cursor") {
    // 1) MCP
    await safeRemove(resolve(projectRoot, ".cursor/mcp.json"));
    // 2) Skills (Rules)
    for (const s of SKILLS_TO_REMOVE) {
      await safeRemove(resolve(projectRoot, `.cursor/rules/${s}.mdc`));
    }
  }

  else if (client === "codex") {
    // 1) MCP
    const configPath = resolve(homedir(), ".codex/config.toml");
    if (await exists(configPath)) {
      try {
        let content = await readFile(configPath, "utf8");
        // Remove [mcp_servers.<name>] blocks
        // A block starts with [mcp_servers.xxx] and goes until the next [mcp_servers.*] or end of file
        const lines = content.split("\n");
        const newLines = [];
        let insideTargetServer = false;
        
        for (const line of lines) {
          const m = line.match(/^\[mcp_servers\.([\w-]+)\]/);
          if (m) {
            const name = m[1];
            if (SERVERS_TO_REMOVE.includes(name)) {
              insideTargetServer = true;
              continue;
            } else {
              insideTargetServer = false;
            }
          } else if (line.trim().startsWith("[")) {
            insideTargetServer = false;
          }
          
          if (!insideTargetServer) {
            newLines.push(line);
          }
        }
        
        await writeFile(configPath, newLines.join("\n"), "utf8");
        console.log(`[uninstall] Cleaned MCP servers from ${configPath}`);
      } catch (e) {
        console.error(`[uninstall] Failed to clean ${configPath}: ${e.message}`);
      }
    }

    // 2) Skills
    for (const s of SKILLS_TO_REMOVE) {
      await safeRemove(resolve(homedir(), `.codex/skills/${s}`), true);
    }
    await safeRemove(resolve(projectRoot, "AGENTS.md"));
  }

  else if (client === "claude-desktop") {
    const configPath = process.platform === "win32"
      ? resolve(process.env.APPDATA || resolve(homedir(), "AppData/Roaming"), "Claude/claude_desktop_config.json")
      : resolve(homedir(), "Library/Application Support/Claude/claude_desktop_config.json");

    console.log(`\n[uninstall] For Claude Desktop:`);
    console.log(`  1. Open your Claude Desktop configuration file:`);
    console.log(`     ${configPath}`);
    console.log(`  2. Manually delete the following keys under "mcpServers":`);
    SERVERS_TO_REMOVE.forEach((s) => console.log(`     - "${s}"`));
    console.log(`  3. Manually remove the Custom Instructions for skills in your Claude Projects.`);
  }

  else if (client === "opencode") {
    // 1) MCP (Global config)
    const configPath = process.platform === "win32"
      ? resolve(process.env.APPDATA || resolve(homedir(), "AppData/Roaming"), "opencode/opencode.json")
      : resolve(homedir(), ".config/opencode/opencode.json");

    if (await exists(configPath)) {
      try {
        const raw = await readFile(configPath, "utf8");
        const json = JSON.parse(raw);
        if (json.mcp) {
          let count = 0;
          for (const s of SERVERS_TO_REMOVE) {
            if (json.mcp[s]) {
              delete json.mcp[s];
              count++;
            }
          }
          if (count > 0) {
            await writeFile(configPath, JSON.stringify(json, null, 2), "utf8");
            console.log(`[uninstall] Removed ${count} MCP server(s) from global OpenCode configuration: ${configPath}`);
          }
        }
      } catch (e) {
        console.error(`[uninstall] Failed to clean global OpenCode configuration: ${e.message}`);
      }
    }

    // 2) Skills (Global skills directory)
    const globalSkillsDir = process.platform === "win32"
      ? resolve(process.env.APPDATA || resolve(homedir(), "AppData/Roaming"), "opencode/skills")
      : resolve(homedir(), ".config/opencode/skills");

    for (const s of SKILLS_TO_REMOVE) {
      await safeRemove(resolve(globalSkillsDir, s), true);
    }
  }

  else if (client === "antigravity") {
    // 1) MCP
    await safeRemove(resolve(homedir(), ".gemini/config/mcp_config.json"));
    // 2) Skills
    const globalSkillsDir = resolve(homedir(), ".gemini/config/skills");
    for (const s of SKILLS_TO_REMOVE) {
      await safeRemove(resolve(globalSkillsDir, s), true);
    }
  }
}

main().catch((err) => {
  console.error("[uninstall] failed:", err);
  process.exit(1);
});
