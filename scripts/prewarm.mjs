#!/usr/bin/env node
// 预拉默认使用的上游 MCP/CLI 到 npm exec 缓存，避免 MCP 客户端首次启动超时。
// 用法：node scripts/prewarm.mjs  或  npm run prewarm

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_NPM_CACHE = path.resolve(HERE, "..", ".codex", "npm-cache");
export const PREWARM_TIMEOUT_MS = 60_000;

const RESET = "\x1b[0m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const GRAY = "\x1b[90m";

export const PACKAGES = Object.freeze([
  {
    label: "mobile-mcp",
    packageName: "@mobilenext/mobile-mcp@latest",
  },
]);

export function buildPrewarmSpawnOptions({
  baseEnv = process.env,
  cacheDir = PROJECT_NPM_CACHE,
  timeoutMs = PREWARM_TIMEOUT_MS,
} = {}) {
  if (!path.isAbsolute(cacheDir) || cacheDir.includes("\0")) {
    throw new Error("prewarm cacheDir must be an absolute path without NUL");
  }
  return {
    stdio: "inherit",
    shell: false,
    env: { ...baseEnv, NPM_CONFIG_CACHE: cacheDir },
    timeout: timeoutMs,
    killSignal: "SIGTERM",
  };
}

export function prewarm({ label, packageName }, options = {}) {
  console.log(`\n${GRAY}预热 ${label}（${packageName}）...${RESET}`);
  return new Promise((resolve, reject) => {
    const child = spawn(
      "npm",
      ["exec", "--yes", packageName, "--", "--version"],
      buildPrewarmSpawnOptions(options),
    );
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${label} prewarm failed (exit=${code ?? "null"}, signal=${signal ?? "none"})`));
    });
  });
}

export async function main() {
  console.log(`${GRAY}这只预热 mobile-mcp 的 npm exec 缓存；Firebase 使用 lockfile 中的项目本地依赖。${RESET}`);
  for (const item of PACKAGES) {
    try {
      await prewarm(item);
      console.log(`${GREEN}✓${RESET} ${item.label} 已预热`);
    } catch (error) {
      console.error(`${RED}✗${RESET} ${error instanceof Error ? error.message : String(error)}`);
      console.error(`${YELLOW}常见原因：npm registry/代理不可用或固定版本不存在。${RESET}`);
      console.error(`${YELLOW}可单独重试：npm exec --yes ${item.packageName} -- --version${RESET}`);
      process.exitCode = 1;
      return;
    }
  }
  console.log(`\n${GREEN}✓${RESET} mobile-mcp 运行包已预热`);
  console.log(`${GRAY}  跑 \`npm run doctor\` 验证本地配置与缓存。${RESET}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`${RED}✗${RESET} 预热失败：${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
