#!/usr/bin/env node
// scripts/setup-mcp.mjs
// 生成项目根目录下的 .mcp.json：读取 .mcp.json.example，把 ${PROJECT_ROOT} 占位符替换成当前项目绝对路径。
// 用法：node scripts/setup-mcp.mjs  或  npm run setup

import { readFile, writeFile, access } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, "..");
const examplePath = resolve(projectRoot, ".mcp.json.example");
const targetPath = resolve(projectRoot, ".mcp.json");

async function exists(p) {
  try { await access(p); return true; } catch { return false; }
}

async function main() {
  const force = process.argv.includes("--force");
  if (await exists(targetPath) && !force) {
    console.error(`[setup-mcp] .mcp.json already exists at ${targetPath}`);
    console.error(`[setup-mcp] re-run with --force to overwrite`);
    process.exit(1);
  }
  const raw = await readFile(examplePath, "utf8");
  const expanded = raw.replaceAll("${PROJECT_ROOT}", projectRoot);
  await writeFile(targetPath, expanded, "utf8");
  console.log(`[setup-mcp] wrote ${targetPath}`);
  console.log(`[setup-mcp] PROJECT_ROOT = ${projectRoot}`);
}

main().catch((err) => {
  console.error("[setup-mcp] failed:", err);
  process.exit(1);
});
