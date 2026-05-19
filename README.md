# app_test_ctrl

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A520-brightgreen)](https://nodejs.org/)

AI 驱动的移动 App 自动化测试平台（MCP-native）。

让 Claude Code 在你的 Android / iOS Simulator 上：
- **DevTest**：读 `git diff` → 推断改了哪个页面 → 跑一遍 → 出报告（"我刚改的登录能用吗"）
- **QA**：自由探索 → 用状态图避免死循环 → 抓 crash → 出 bug 列表
- **Minimize**：12 步触发的崩溃 → 用 delta-debug 压成 3 步并验证
- **Smart-QA**：一句 "帮我看下有没有 bug" → 读 PRD / 静态推断业务流 → 自动跑 + 比对预期

通过 **5 个 MCP**（log + report + ui + analyzer + code-analyzer）+ **4 个 Skill**（devtest / qa / minimize / smart-qa）+ 上游 mobile-mcp 组合实现。

- **方案与决策**：[PLAN.md](./PLAN.md)
- **实施进度**：[PROGRESS.md](./PROGRESS.md)
- **安装与接入**：[docs/SETUP.md](./docs/SETUP.md)
- **架构总览**：[docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md)

## 组件

| 路径 | 角色 | 状态 |
|---|---|---|
| `mcp-servers/log-mcp/` | Android logcat / ANR / tombstone + iOS log stream / .ips | 14 工具 |
| `mcp-servers/report-mcp/` | Session + Markdown/HTML 报告 + QA 状态图 | 12 工具 |
| `mcp-servers/ui-mcp/` | uiautomator 层级查询 + 智能点击（Android） | 7 工具 |
| `mcp-servers/analyzer-mcp/` | crash signature / dedup / 路径精简 / .ips 解析 | 6 工具 |
| `mcp-servers/code-analyzer-mcp/` | 静态扫码：平台识别 + PRD 发现 + 页面/路由/API 抽取 | 4 工具 |
| `.claude/skills/devtest/` | 开发自测 Agent（git diff → 验证） | Skill |
| `.claude/skills/qa/` | QA 自动探索 Agent（状态图 + dedup） | Skill |
| `.claude/skills/minimize/` | 复现路径精简（delta-debug + replay） | Skill |
| `.claude/skills/smart-qa/` | 一句话 → 自动跑业务流（PRD + 静态推断） | Skill |

`mobile-mcp` 直接使用上游 `@mobilenext/mobile-mcp`，不 fork。

## 快速开始

```bash
npm install
npm run build
npm run setup         # 生成 .mcp.json（把 ${PROJECT_ROOT} 展开成本机绝对路径）
npm run doctor        # 检查环境（Node/adb/xcrun/构建/.mcp.json/skills）
# 重启 Claude Code，/mcp 检查 5 个本仓 server 都已连接
```

跑一次冒烟见 [docs/SETUP.md §4](./docs/SETUP.md)。

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
- Claude Code

## 仓库结构

```
.
├── PLAN.md / PROGRESS.md / README.md
├── .mcp.json.example         # Claude Code MCP 注册样板
├── config.yaml               # 设备/包名/阈值
├── docs/                     # 详细文档
├── mcp-servers/              # 三个自研 MCP（TypeScript workspace）
├── skills/                   # Claude Code Skill 提示词
├── test-plans/               # 用户测试用例 (markdown)
└── workspace/sessions/       # 运行时数据（每次跑一个目录）
```

## License

[MIT](./LICENSE) — 自由使用、修改、分发；保留版权与免责声明即可。
