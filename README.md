# app_test_ctrl

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A520-brightgreen)](https://nodejs.org/)

AI 驱动的移动 App 自动化测试平台（MCP-native）。

让 **任意 MCP-aware AI 编程客户端**（Claude Code / Cursor / Claude Desktop / Codex CLI…）在你的 Android / iOS Simulator 上：
- **DevTest**：读 `git diff` → 推断改了哪个页面 → 跑一遍 → 出报告（"我刚改的登录能用吗"）
- **QA**：自由探索 → 用状态图避免死循环 → 抓 crash → 出 bug 列表
- **Minimize**：12 步触发的崩溃 → 用 delta-debug 压成 3 步并验证
- **Smart-QA**：一句 "帮我看下有没有 bug" → 读 PRD / 静态推断业务流 → 自动跑 + 比对预期

通过 **5 个 MCP**（log + report + ui + analyzer + code-analyzer）+ **4 个 Skill**（devtest / qa / minimize / smart-qa）+ 上游 mobile-mcp 组合实现。MCP 协议本身跨客户端通用，4 个 Skill 文件 ~95% 中立（核心是 MCP tool 调用 + 自然语言指令）。

- **方案与决策**：[PLAN.md](./PLAN.md)
- **实施进度**：[PROGRESS.md](./PROGRESS.md)
- **安装与接入**：[docs/SETUP.md](./docs/SETUP.md)
- **跨客户端支持**：[docs/CLIENTS.md](./docs/CLIENTS.md)（Claude Code / Cursor / Claude Desktop / Codex CLI）
- **架构总览**：[docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md)

## 组件

| 路径 | 角色 | 状态 |
|---|---|---|
| `mcp-servers/log-mcp/` | Android logcat / ANR / tombstone + iOS log stream / .ips | 14 工具 |
| `mcp-servers/report-mcp/` | Session + Markdown/HTML 报告 + QA 状态图 | 12 工具 |
| `mcp-servers/ui-mcp/` | uiautomator 层级查询 + 智能点击（Android） | 7 工具 |
| `mcp-servers/analyzer-mcp/` | crash signature / dedup / 路径精简 / .ips 解析 | 6 工具 |
| `mcp-servers/code-analyzer-mcp/` | 静态扫码：平台识别 + PRD 发现 + 页面/路由/API 抽取 | 4 工具 |
| `skills/devtest/` | 开发自测 Agent（git diff → 验证） | Skill 源 |
| `skills/qa/` | QA 自动探索 Agent（状态图 + dedup） | Skill 源 |
| `skills/minimize/` | 复现路径精简（delta-debug + replay） | Skill 源 |
| `skills/smart-qa/` | 一句话 → 自动跑业务流（PRD + 静态推断） | Skill 源 |

`mobile-mcp` 直接使用上游 `@mobilenext/mobile-mcp`，不 fork。

## 快速开始

```bash
npm install
npm run build
```

然后按你的客户端选一条分支（详见 [docs/CLIENTS.md](./docs/CLIENTS.md)）：

```bash
# Claude Code（默认）
npm run setup                                  # 写 .mcp.json
# .claude/skills/ 已随仓库分发，开箱即用

# Cursor
npm run setup -- --client cursor               # 写 .cursor/mcp.json
npm run install:skills -- --client cursor      # 写 .cursor/rules/*.mdc

# Codex CLI
npm run setup -- --client codex                # 打印 TOML 片段 → 粘到 ~/.codex/config.toml
npm run install:skills -- --client codex       # 复制到 ~/.codex/skills/ + 项目根 AGENTS.md

# Claude Desktop
npm run setup -- --client claude-desktop       # 打印 JSON 片段 → 粘到全局 config
npm run install:skills -- --client claude-desktop  # 列出 skill 文件路径供手动粘贴

# 最后统一自检
npm run doctor                                 # 检查 Node/adb/xcrun/构建/配置/skills
```

冒烟测试和故障排查见 [docs/SETUP.md](./docs/SETUP.md)。

## 怎么用（典型对话）

```
用户：测一下我刚改的登录功能
   ↓
Claude 触发 devtest skill：
   1. 读 git diff → 看到 LoginActivity.kt 改了
   2. 推断影响：登录页面
   3. 列测试计划：手机号正常 / 错误 / 网络异常
   4. 起 session → 抓 logcat → 启动 app
   5. ui.tap_element(identifier=btn) → 走完每一步
   6. 抓不到 crash → finalize(passed)
   ↓
✅ 登录功能测试 (8/8, 23s, 0 crash)
报告: workspace/sessions/.../report.md  +  report.html
```

```
用户：自动探索一下 jko.dns.qwn.dfgt
   ↓
Claude 触发 qa skill：
   1. dump_hierarchy → page_fingerprint → graph_record_page
   2. graph_pick_next_unseen → 挑没点过的元素
   3. tap → 重抓 → graph_record_edge
   4. 检测到 crash → record_crash + relaunch + 继续
   5. analyzer.dedup → 7 次 crash → 3 个独立 bug
   ↓
🐛 #1 NullPointerException @ LoginActivity.onClick (触发 5 次)
🐛 #2 ANR after rotation (1 次)
🐛 #3 Crash on empty payment (1 次)
报告: workspace/sessions/.../report.md
```

```
用户：帮我看下 lend_pal 有没有 bug
   ↓
Claude 触发 smart-qa skill：
   1. code-analyzer.analyze_project → 识别 Flutter + 12 页 + 22 路由
   2. 找到 requirements.md（PRD）→ 读
   3. 综合 PRD + 代码 → 列出 5 个业务流 → AskUserQuestion
   4. 用户选 3 条 → 走 devtest skill 逐条执行
   5. 0 crash，但发现 6 个 PRD 不一致（邮箱无校验 / Face mock / 等）
   ↓
🔎 lend_pal: 0 crash, 6 UX/PRD 不一致
报告: workspace/sessions/.../report.md
```

## 依赖

- Node.js ≥ 20
- npm ≥ 10
- **Android**：SDK Platform Tools（提供 `adb`）
- **iOS（Simulator）**：Xcode 命令行工具（提供 `xcrun simctl`）
- 任一 MCP-aware AI 编程客户端：Claude Code / Cursor / Claude Desktop / Codex CLI 等

## 仓库结构

```
.
├── PLAN.md / PROGRESS.md / README.md
├── .mcp.json.example         # MCP 注册样板（用 ${PROJECT_ROOT} 模板，被 setup 脚本展开）
├── config.yaml               # 设备/包名/阈值
├── docs/                     # 详细文档（含 CLIENTS.md 跨客户端指南）
├── mcp-servers/              # 五个自研 MCP（TypeScript workspace）
├── skills/                   # Skill 源文件（canonical，跨客户端通用）
├── scripts/                  # setup-mcp / install-skills / doctor
├── test-plans/               # 用户测试用例 (markdown)
└── workspace/sessions/       # 运行时数据（每次跑一个目录）
```

## License

[MIT](./LICENSE) — 自由使用、修改、分发；保留版权与免责声明即可。
