#!/usr/bin/env node
// scripts/prewarm.mjs
// 把 mobile-mcp 预拉到 npx / npm exec 的本地缓存，避免首次启动 MCP client 时
// 现场下载导致连接超时。
//
// 用法：node scripts/prewarm.mjs  或  npm run prewarm

import { spawn } from "node:child_process";

const PKG = "@mobilenext/mobile-mcp@latest";

const RESET = "\x1b[0m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const GRAY = "\x1b[90m";

console.log(`\n${GRAY}预热 mobile-mcp（${PKG}）...${RESET}`);
console.log(`${GRAY}这会触发 npm exec 把包下载到本地缓存，之后 MCP client 启动时就不会卡。${RESET}\n`);

// `npm exec --yes <pkg> -- --version` 强制下载到 cache 后立刻退出。
// 这里不强制 --offline；让它该下就下。
const child = spawn("npm", ["exec", "--yes", PKG, "--", "--version"], {
  stdio: "inherit",
  shell: false,
});

child.on("exit", (code) => {
  if (code === 0) {
    console.log(`\n${GREEN}✓${RESET} mobile-mcp 已预热到 npx 缓存`);
    console.log(`${GRAY}  跑 \`npm run doctor\` 验证。${RESET}`);
  } else {
    console.log(`\n${RED}✗${RESET} mobile-mcp 预热失败（exit ${code}）`);
    console.log(`${YELLOW}  常见原因：网络无法访问 npm registry、代理未配置、版本下架。${RESET}`);
    console.log(`${YELLOW}  你也可以手动跑：${RESET}`);
    console.log(`${YELLOW}    npm exec --yes ${PKG} -- --version${RESET}`);
    process.exit(code ?? 1);
  }
});

child.on("error", (err) => {
  console.error(`${RED}✗${RESET} 启动 npm exec 失败：${err.message}`);
  process.exit(1);
});
