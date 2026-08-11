# app_test_ctrl

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A520-brightgreen)](https://nodejs.org/)

AI 驱动的移动 App 自动化测试平台（MCP-native）。

让 **任意 MCP-aware AI 编程客户端**（Claude Code / Cursor / Claude Desktop / Codex CLI / opencode…）在你的 Android / iOS Simulator/真机 上：
- **DevTest**：读 `git diff` → 推断改了哪个页面 → 跑一遍 → 出报告（"我刚改的登录能用吗"）
- **QA**：自由探索 → 用状态图避免死循环 → 抓 crash → 出 bug 列表
- **Minimize**：12 步触发的崩溃 → 用 delta-debug 压成 3 步并验证
- **Smart-QA**：一句 "帮我看下有没有 bug" → 读 PRD / 静态推断业务流 → 自动跑 + 比对预期
- **CrashFix**：读取 Firebase Crashlytics 线上崩溃 → 脱敏、定位源码、生成最小修复候选；
  提供 `quick_test`（测试项目快速读取、最小修改、一次本机验证）和 `strict`（完整审计、
  快照/候选、真机 3/3）两档流程。默认本机可信构建，Docker 强隔离按需启用。

默认注册 **9 个 MCP server**：8 个项目内 MCP（log + report + ui + analyzer +
code-analyzer + build-runner + crashlytics + firebase-readonly）以及上游 mobile-mcp。
`firebase-readonly` 内部启动固定版官方 Firebase MCP，但客户端不会直接连接官方进程；再由
**5 个 Skill**（devtest / qa / minimize / smart-qa / crashfix）完成编排。MCP 协议本身
跨客户端通用，Skill 以 MCP tool 调用和自然语言工作流为核心，跨客户端复用。

- **方案与决策**：[PLAN.md](./PLAN.md)
- **实施进度**：[PROGRESS.md](./PROGRESS.md)
- **🤖 让 AI 帮你装**：[docs/INSTALL_FOR_AI.md](./docs/INSTALL_FOR_AI.md)（整段粘进你的 AI 聊天框，AI 接力跑完安装）
- **安装与接入**：[docs/SETUP.md](./docs/SETUP.md)
- **跨客户端支持**：[docs/CLIENTS.md](./docs/CLIENTS.md)（Claude Code / Cursor / Claude Desktop / Codex CLI / opencode）
- **架构总览**：[docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md)
- **Crashlytics / CrashFix**：[docs/CRASHLYTICS.md](./docs/CRASHLYTICS.md)

## 组件

| 路径 | 角色 | 状态 |
|---|---|---|
| `mcp-servers/log-mcp/` | Android logcat / ANR / tombstone + iOS log stream / .ips | 18 工具 |
| `mcp-servers/report-mcp/` | Session + Markdown/HTML 报告 + QA 状态图 + CrashFix 结构化根因 | 16 工具 |
| `mcp-servers/ui-mcp/` | uiautomator 层级查询 + 智能点击（Android） | 7 工具 |
| `mcp-servers/analyzer-mcp/` | crash signature / dedup / 路径精简 / .ips 与远端事件解析 | 7 工具 |
| `mcp-servers/code-analyzer-mcp/` | 静态扫码 + 堆栈 frame 到源码候选定位 + quick 有界源码读取 | 6 工具 |
| `mcp-servers/build-runner-mcp/` | snapshot Android/Gradle 双模式 Runner：默认本机可信，可选 Docker 强隔离 | 6 工具 |
| `mcp-servers/crashlytics-mcp/` | 可选的 production-safe Cloud Logging 只读查询、allowlist、脱敏与规范化 | 7 工具 |
| `mcp-servers/firebase-readonly-mcp/` | 固定版官方 Firebase MCP 的项目内只读网关；仅暴露 8 个有界读取工具 | 8 工具 |
| `skills/devtest/` | 开发自测 Agent（git diff → 验证） | Skill 源 |
| `skills/qa/` | QA 自动探索 Agent（状态图 + dedup） | Skill 源 |
| `skills/minimize/` | 复现路径精简（delta-debug + replay） | Skill 源 |
| `skills/smart-qa/` | 一句话 → 自动跑业务流（PRD + 静态推断） | Skill 源 |
| `skills/crashfix/` | 单条线上 Crashlytics issue → 分析 / 补丁 / Draft PR | Skill 源 |

`mobile-mcp` 直接使用上游 `@mobilenext/mobile-mcp`。

### Agent Skills 介绍

- **devtest (开发自测)**：
  - **场景**：“我刚改的登录能跑通吗？”
  - **流程**：读取 `git diff` 识别修改的文件 -> 静态分析受影响的 UI 页面 -> 自动生成 Happy Path 和 Edge Case 测试计划 -> 执行测试（截图+防崩溃监控） -> 生成测试报告。
- **qa (自动探索测试)**：
  - **场景**：“自由探索一下这个 app，看看有没有崩的地方。”
  - **流程**：冷启动 App -> 自动获取页面元素并依据状态图策略（优先点击未探索元素）进行深度探索 -> 遇到崩溃自动记录、重启并继续探索 -> 探索结束后对 Crash 进行去重分析。
- **minimize (复现路径精简)**：
  - **场景**：“这个崩溃步骤有 12 步，帮我精简一下。”
  - **流程**：基于 Delta-Debugging (ddmin) 二分算法，通过自动重启 App 并 Replay 部分步骤组合，找到复现该崩溃特征指纹的最短路径（例如将 12 步压缩至 3 步）。
- **smart-qa (智能需求对齐测试)**：
  - **场景**：“对照 PRD 帮我看看这个项目有没有 bug。”
  - **流程**：通过 `code-analyzer` 静态推断业务流并读取 PRD -> 列出测试流供用户确认 -> 执行测试并比对实际 UI 表现与 PRD 预期是否一致（如邮箱格式未校验、功能未实现等）。
- **crashfix (线上崩溃修复候选)**：
  - **场景**：“分析并修复 Crashlytics 上这个 issue。”
  - **流程**：默认通过项目内只读网关调用官方 Firebase MCP，拉取测试/已确认低敏项目中的代表事件；生产项目
    改用本仓 Cloud Logging 脱敏 MCP -> 计算稳定的
    `signature_version + fingerprint` -> 锁定 Git release SHA 或 sealed source snapshot ->
    在独立 candidate workspace 生成最小补丁 -> 单测、构建和
    真机三次验证。目标项目的 Git 是可选能力：`provenance=auto|git|snapshot`；`auto` 在
    有效 Git 时走 `git_release_exact`，确认无 Git 时走 `snapshot_repro_equivalent`，显式
    `snapshot` 即使存在 `.git` 也不使用 Git；这些有效选择会得到
    `provenance_status=resolved`。损坏/不可用 Git 得到 `unavailable`，不会静默切换：
    `analyze` 只能做 remote-only 分析；`patch/pr` 建立审计 session 后立即中止，不调用
    任何 Firebase 身份或详情工具。snapshot `analyze` 只需经审批创建 sealed snapshot
    做静态定位，不强制真机；
    snapshot `patch` 才要求 baseline 在真机复现同一
    `(signature_version, fingerprint)`。commit、push 和 Draft PR 的契约仅属于
    `resolved + git_release_exact`，但当前 Build Runner 暂不支持 Git worktree 构建，
    所以 Git `patch/pr` 会在首条项目命令前中止。Runner 当前只定义 snapshot Android：
    默认 `local_trusted` 可在用户明确确认的低敏可信项目上运行，但不提供文件、秘密、网络
    或磁盘配额强隔离，进程组 containment 也只是 best-effort；可选 `docker_strict` 保留完整容器门槛，当前仍会因宿主 workspace
    quota 不可核验而 fail-closed。两种模式不会自动切换。需要快速处理个人/测试项目时显式选择
    `workflow=quick_test`：父 CrashFix 只归档一条脱敏事件，普通 devtest 子 session 在当前
    工作树完成最多 3 个文件的最小修改和一次测试/可选真机 smoke；不创建 snapshot/worktree、
    不 commit/push。生产或敏感项目使用 `workflow=strict`。snapshot 候选通过 3/3 并获候选接受审批后，仍须
    单独批准导出到用户选择的全新私有目录，绝不自动回写原项目。网关不注册官方写工具，
    也不自动 merge、发布或关闭线上 issue。
- **测试报告与可视化看板**：
  - **结果呈现**：每次自测或自动探索完成后，不仅会保存步骤截图与崩溃日志，还会自动生成单文件交互式的 HTML 报告。
  - **报告语言**：新 Session 默认生成简体中文 Markdown/HTML；只有当前用户明确要求英文时
    才锁定为 `en-US`。同一 Session 的 finalize、重渲染和严格验证 child 都不能切换语言，
    provider、路径、hash、fingerprint 等技术字段保持规范原值。
  - **本地看板网页**：通过 `npm run sessions` 启动仅监听
    `http://127.0.0.1:7321` 的脱敏看板，可查阅、过滤和对比历史 session；API 不公开
    原始设备 ID、原始 `meta.extra` 或 Firebase 标识，只返回闭合安全投影；静态文件仅允许
    报告实际引用的证据。
  - **Firebase 修复视图**：CrashFix 与 QA 共用同一个看板，不另起服务。列表可按
    `Firebase 修复/严格验证/QA/DevTest/Minimize` 和状态筛选；CrashFix 详情展示锁定的数据源、
    workflow/mode、当前阶段、根因、最多 3 个相对源码位置、修复建议、候选/验证/导出状态及
    限制。strict 的 3 次验证子报告只在服务端身份核验通过后关联；浏览器不会直连 Firebase。

## 快速开始

**🤖 懒人路径**：直接把下面整段粘进你的 AI 聊天框（Claude Code / Cursor / Codex / Claude Desktop 都可以），说"按这个指引帮我装好 app-test-ctrl"，AI 会一步步带你跑完。

```
帮我根据https://github.com/dj931567261/app-test-control/blob/main/docs/INSTALL_FOR_AI.md 文档安装app-test-ctrl
```

**手动路径**：

```bash
npm install
npm run build
npm run prewarm                                # 仅预拉 mobile-mcp；Firebase 已由 lockfile 安装
```

然后按你的客户端选一条分支（详见 [docs/CLIENTS.md](./docs/CLIENTS.md)）：

```bash
# Claude Code（默认）
npm run setup                                  # 写 .mcp.json
# .claude/skills/ 已随仓库分发，开箱即用

# Cursor
npm run setup -- --client cursor               # 写 .cursor/mcp.json
npm run install:skills -- --client cursor      # 写 rules/*.mdc，并复制其 references 等 supporting files

# Codex CLI
npm run setup -- --client codex                # 打印 TOML 片段 → 审查后合并到当前 checkout 的 .codex/config.toml
npm run install:skills -- --client codex       # 复制完整 bundle 到 ~/.codex/skills/ + 项目根 AGENTS.md
npm run install:skills -- --client codex --project --force  # 只刷新项目 AGENTS.md

# Claude Desktop
npm run setup -- --client claude-desktop       # 打印 JSON 片段 → 粘到全局 config
npm run install:skills -- --client claude-desktop  # 打印完整 bundle 的手动导入清单（不会自动安装）

# opencode
npm run setup -- --client opencode             # 合并配置到全局 ~/.config/opencode/opencode.json
npm run install:skills -- --client opencode    # 安装技能（检测并复用项目内 .claude/skills/，若缺失则自动写入全局）

# 卸载清理（以 opencode 为例，支持各客户端）
npm run uninstall -- --client opencode         # 清除对应客户端的 MCP 节点和 Skill 文件

# 最后统一自检
npm run doctor                                 # 检查 Node/adb/xcrun/构建/配置/skills

# 查看历史 session（本地浏览面板）
npm run sessions                               # 固定 http://127.0.0.1:7321/
npm run sessions -- --open                     # 启动后自动打开浏览器
npm run sessions -- --port 7400 --workspace ./other/sessions
```

Skill 安装以**整项 bundle**为单位（`SKILL.md` 加 `agents/references/scripts/assets`）。
默认模式只要目标中任一文件已存在就整项跳过，避免半安装；`--force` 会把该 skill
目标目录精确同步为当前源，包含清理源中已删除的旧文件。符号链接、硬链接和越界路径
在两种模式下都会被拒绝。

冒烟测试和故障排查见 [docs/SETUP.md](./docs/SETUP.md)。

CrashFix 默认使用名为 `firebase` 的项目内只读网关，不要求把 Crashlytics 导出到
Cloud Logging。网关内部固定调用 `firebase-tools@15.24.0 mcp --only crashlytics`，并在
`tools/list` 与 `tools/call` 两层只允许 8 个有界读取工具。首次配置前必须先选择一个完整
接入 Profile，不能根据本机文件自动猜测，也不能在失败后自动切换：

固定版 Firebase CLI 在 `tools/list` 阶段可能探测 Billing 并尝试启用 Google API。网关因此
在启动官方进程前加载项目内固定 preload：把 Billing 能力保守视为不可用、始终拒绝
`ensure`，并仅对 `firebase_get_project` 固定的 Cloud Resource Manager 只读 GET 前置调用
无副作用短路 `bestEffortEnsure`；其他调用形状仍拒绝。它不会检查或启用 API，并禁用
GA4 遥测；同时固定
`--only crashlytics` 的 feature discovery，禁止从宿主 `PATH` 执行额外的
`firebase --version` 探针，并仅在回答 `tools/list` 时抑制不必要的认证发现；真实工具调用
会立即恢复官方认证流程。preload 缺失、版本或内部导出契约漂移时一律 fail-closed；
环境工具中显示的 Billing `false` 是安全抑制值，不代表项目的真实计费状态。该 guard
只阻止已知隐式写入、无关探测与遥测，不构成宿主或网络强隔离。

其中无参数 `firebase_get_crashlytics_report_guide` 是唯一公开的 Reports guide 入口；网关
内部才以硬编码 URI 调用一次上游 `firebase_read_resources`，客户端不能提供或改变 URI。
每个需要 `topIssues`/`topVersions` 的 report session 都必须在 session 建立后、首次相应
report 前调用该别名恰好一次；进程缓存或其他 session 的成功结果不能证明当前 session
满足顺序前置。

- **`service-account`**：提供服务账号 JSON 的绝对路径、显式 Firebase Project ID 和目标
  App 项目目录。网关稳定核验源文件后使用一次性 `0600` 私有凭据副本，并在私有
  configstore 中绑定 Project ID；不要求或创建 `.firebaserc`，也不把它作为项目来源。
  若 App 目录已经存在该文件，网关会有界检查 alias 冲突并在异常或重映射时 fail-closed。
- **`firebaserc`**：先由用户完成 Firebase CLI 登录，并保证目标 App 项目目录已经存在
  `.firebaserc`（含有效的 `projects.default`，且不可被 group/other 写入）。网关只复制目标
  目录选中的一个登录账号到一次性私有 configstore，并以已验证的 Project ID 绑定；宿主
  `activeProjects` 不会传给上游。setup 只校验现有文件，不会代为创建。

```bash
# Profile A：服务账号；POSIX 上凭据文件需由当前用户持有且禁止 group/other 访问
npm run setup -- --firebase-project-source service-account \
  --firebase-project-id my-firebase-project \
  --firebase-service-account /absolute/path/to/service-account.json \
  --firebase-dir /absolute/path/to/target-app-project

# Profile B：Firebase CLI + 已有 .firebaserc
npm run firebase -- login
npm run setup -- --firebase-project-source firebaserc \
  --firebase-dir /absolute/path/to/target-app-project
```

若普通 `setup` 已生成配置，审查覆盖范围并取得确认后再给上述命令加 `--force`；其他客户端
再加 `--client <name>`。配置改变后必须完整重启客户端：用
`firebase_get_environment` 核对运行身份和网关私有上下文，用 `firebase_get_project` 机械核对
锁定的 Project ID/Number，再用 `firebase_list_apps` 核对目标 Firebase App ID。前者返回的
Project Directory 是一次性私有路径，Detected App IDs 也可能为空，不能与真实 App 目录或
App ID 比较；真实 App 目录由本地受管客户端配置和 doctor 元数据核验。
服务账号 JSON 内容不得由 Agent、setup 或 doctor 读取/回显，也不得提交；网关只做不解析
内容的一次性私有复制，上游认证库仅使用该私有副本。正常关闭或启动失败的受控收尾会立即
清理 Firebase 私有目录；强杀、崩溃或断电残留只会在后续受控启动中按 owner、权限、lease、
年龄和失活 PID 等严格条件有界清扫，Windows 默认不清扫。这种残留收敛不是强隔离，也不保证
重启后清空未知目录。认证成功也不等于 IAM 足够，所需只读权限仍须在 Firebase/Google Cloud
中单独配置和验证。Codex 的 `service-account` Profile 必须放在当前 checkout 的
`.codex/config.toml`，不得把凭据路径写进全局 `~/.codex/config.toml`；doctor 会把全局
服务账号 Profile 明确判为 invalid，即使同名 `firebase` 已被项目配置覆盖。Codex 会按
global → project 对 MCP server key 做合并，doctor 也会安全解析两层并执行相同合并；任一
已存在配置无法解析都 fail-closed。

网关**只限制工具、参数和响应边界**，不提供宿主/凭据隔离，也不会在 Agent 看到官方
event 文本前完成服务端脱敏。因此 official 路径只允许测试/已确认低敏项目；生产项目或
敏感度未知时必须 fail-closed，改用
本仓 `crashlytics-mcp` 的 Cloud Logging export + ADC + project/app allowlist 脱敏路径。
完整边界见 [docs/CRASHLYTICS.md](./docs/CRASHLYTICS.md)。

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
   3. 综合 PRD + 代码 → 列出 5 个业务流，让用户回编号（如 "1,3,5" 或 "all"）
   4. 用户选 3 条 → 走 devtest skill 逐条执行
   5. 0 crash，但发现 6 个 PRD 不一致（邮箱无校验 / Face mock / 等）
   ↓
🔎 lend_pal: 0 crash, 6 UX/PRD 不一致
报告: workspace/sessions/.../report.md
```

## 报告示例截图

![smart-qa-lendpal 报告示例1](./docs/images/report-main.png)

![smart-qa-lendpal 报告示例](./docs/images/report-example.png)

> 来源：`workspace/sessions/2026-05-15_181035_smart-qa-lendpal/report.html`（smart-qa 一句话探索 lend_pal Flutter app，4 flows × 0 crash × 34m55s）

## 依赖

- Node.js ≥ 20
- npm ≥ 10
- **Android**：SDK Platform Tools（提供 `adb`）
- **iOS（Simulator）**：Xcode 命令行工具（提供 `xcrun simctl`）
- 任一 MCP-aware AI 编程客户端：Claude Code / Cursor / Claude Desktop / Codex CLI / opencode 等
- **CrashFix（默认 acquisition）**：首次明确选择 `service-account`（JSON 绝对路径 +
  显式 Project ID + App 目录）或 `firebaserc`（Firebase CLI 已登录 + App 目录已有
  `.firebaserc`）Profile。两者不自动回退；只读网关仅用于测试/已确认低敏项目，不需要
  Cloud Logging export
- **CrashFix（production-safe 可选）**：Crashlytics Cloud Logging export、Google ADC
  只读凭据和精确 project/app allowlist（本地 fixture 模式不需要 ADC）
- **CrashFix（snapshot provenance）**：当前要求 POSIX 数字 UID 与安全文件打开原语；
  Windows 会 fail-closed。Git 路径仍须独立满足 release、sandbox、签名和真机门槛，不能
  视为 Windows 自动补丁兜底。创建/验证/导出 snapshot 前还必须停止同 UID 的项目
  watcher 与构建进程；源文件和导出 parent 不可被 group/other 写入
- **CrashFix（snapshot Android patch，默认）**：macOS/Linux、JDK、Android SDK、
  `apkanalyzer` 与 `apksigner`；`local_trusted` 仅用于用户确认的低敏可信项目，采用私有
  HOME/TMP/Gradle cache 副本、offline flag、超时和前后审计，但**不提供强隔离**
- **CrashFix（Docker 严格模式，可选）**：本地 Linux Docker daemon、当前用户拥有且
  `0600` 的 Unix socket、预先存在的 digest-pinned Android 镜像；不自动 pull。当前宿主
  workspace quota 不可核验时严格模式 fail-closed，且不会自动回退到本机模式

## 仓库结构

```
.
├── PLAN.md / PROGRESS.md / README.md
├── .mcp.json.example         # setup 专用输入模板（不可直接复制为客户端配置）
├── config.yaml               # 设备/包名/阈值
├── docs/                     # 详细文档（含 CLIENTS.md 跨客户端指南）
├── mcp-servers/              # 八个项目内 MCP（TypeScript workspace）
├── skills/                   # Skill 源文件（canonical，跨客户端通用）
├── scripts/                  # setup-mcp / install-skills / prewarm / doctor
├── test-plans/               # 用户测试用例 (markdown)
└── workspace/sessions/       # 运行时数据（每次跑一个目录）
```

## 致谢

[![LINUXDO](https://img.shields.io/badge/%E7%A4%BE%E5%8C%BA-LINUXDO-0086c9?style=for-the-badge&labelColor=555555)](https://linux.do)

感谢 **`linux.do`** 社区的讨论、分享与支持。这个项目在方法论整理、实践思路和持续迭代上，都受益于社区氛围与成员交流。

[mobile-mcp](https://github.com/mobile-next/mobile-mcp)  — 感谢mobile-mcp，就是受到这个mcp的启发才开始做的，并提供了很多思路。

## License

[MIT](./LICENSE) — 自由使用、修改、分发；保留版权与免责声明即可。
