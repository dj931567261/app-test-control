# 支持的 AI 客户端

`app-test-ctrl` 默认注册 9 个 MCP server（8 个项目内、上游 mobile-mcp；Firebase 网关
内部受控调用固定版官方 MCP），5 个 Skill 与具体客户端解耦：
- **MCP 协议**通用，差异只在配置文件位置 / 格式（JSON vs TOML）
- **Skill 内容**用 MCP tool 名称 + 中立自然语言写成，~95% 跨客户端可移植

下表覆盖首批支持的 5 个客户端：

## 客户端支持矩阵

| 客户端 | MCP 自动写文件 | Skill 自动安装 | 文件位置 |
|---|:-:|:-:|---|
| **Claude Code** | ✅ | ✅ | `.mcp.json` + `.claude/skills/<name>/`（完整 bundle） |
| **Cursor** | ✅ | ✅ | `.cursor/mcp.json` + `.cursor/rules/<name>.mdc` + `<name>/` supporting files |
| **Claude Desktop** | ❌ paste-snippet | ❌ 手动 | global JSON file |
| **Codex CLI** | ✅ AI 检查后合并 | ✅ 双安装 | 当前 checkout 的 `.codex/config.toml`（默认）+ `~/.codex/skills/<name>/` + `AGENTS.md`；非服务账号配置才可由用户显式改选全局 TOML |
| **OpenCode** | ✅ | ✅ 复用 | 全局 `~/.config/opencode/opencode.json` + `.claude/skills/<name>/` |

> "paste-snippet" = 脚本打印片段到 stdout，你手动拷到客户端的全局配置；"AI 自动追加" = AI 助手在 INSTALL_FOR_AI 流程里做冲突检测后 append。这样做是为了避免误改用户的全局环境又不让用户自己复制。

CrashFix 的 `workflow` 在所有客户端一致：低敏测试项目可由用户明确选择
`quick_test`（一条事件、最多 3 个文件、一次本机验证、直接工作树且不自动 commit/push；真机 smoke
需先核对安装后的 package/version/build），
生产或敏感度未知项目选择 `strict`（完整快照/候选/真机 3/3）。省略时不能由客户端或
目录内容猜测；两档不会自动 fallback。

目标 App 项目不必使用 Git。CrashFix 支持 `provenance=auto|git|snapshot`：`auto` 在有效
Git 时锁定 `git_release_exact`，确认无 Git 时锁定 `snapshot_repro_equivalent`；显式
`snapshot` 即使项目存在 `.git` 也完全不使用 Git。损坏/不可用 Git 会得到
`provenance_status=unavailable`，不会静默转为 snapshot：`analyze` 只能做 remote-only
分析，`patch/pr` 会在建立审计 session 后立即中止，不调用任何 Firebase 身份或详情
工具。commit、push 和 Draft PR 的契约只属于 `provenance_status=resolved` 的
`git_release_exact`；当前本仓 Build Runner 暂不支持 Git build path，因此 Git
`patch/pr` 会在首条项目命令前中止，不能伪装成 snapshot。

客户端可安装不等于所有 CrashFix provenance 都具备平台能力。当前
`snapshot_repro_equivalent` helper 依赖 POSIX 数字 UID 和安全文件打开原语，在 Windows
上会 fail-closed；Windows 仍可安装客户端配置并使用符合门槛的其他只读能力，但这**不
保证** Git patch 可用。Git patch 仍须独立通过 release-exact、symbols、所选构建 profile、
测试签名和真机复现检查。
snapshot helper 运行前还要求项目与同 UID 构建/watcher 进程静止；源文件和候选导出
parent 不得被 group/other 写入。候选导出时必须独立传入 Phase 0 锁定的
`--original-workspace`；`--forbid-root` 不能替代该身份参数。客户端配置成功不会绕过
这些运行时门槛。

snapshot `analyze` 经审批创建 sealed snapshot 后可只做静态源码定位，不要求 baseline
构建、安装或真机；只有 snapshot `patch` 才要求 baseline 在专用真机复现远端同一
`(signature_version, fingerprint)`。

### Build Runner 的跨客户端环境

新安装的 `setup` 显式注册 `APP_TEST_CTRL_BUILD_RUNNER_BACKEND=local_trusted`，不要求 Docker。
它只适用于当前用户明确确认的低敏可信项目；probe 就绪仍不等于已批准运行，首次宿主执行
和每条 exact Gradle 命令都要单独确认。local 使用最小 ENV、私有 HOME/TMP/Gradle cache
副本、offline flag、超时和进程组清理，但**不提供强隔离**：网络、文件、宿主秘密和磁盘
quota 均未强制，`process_containment=process_group_best_effort`，不能宣称
sandbox/hermetic。

需要 Docker 严格隔离（`docker_strict`）时，用
`setup -- --build-runner-backend docker` 或在实际客户端 MCP 环境显式
选择 `backend=docker`，再配置绝对 Docker executable 和已存在的
`name@sha256:<64-lowercase-hex>` 镜像。Runner 不登录、不 pull、不接受远程 TCP daemon；
Unix socket 必须由当前用户拥有、非 symlink 且权限恰为 `0600`。当前 strict profile 还会因
宿主 workspace quota 不可核验而 fail-closed。两种 profile 不会自动 fallback，改选后需
重启客户端并新建 CrashFix session。

Runner 当前只支持 snapshot Android/Gradle；Git build、iOS/Xcode、npm 与任意 shell 都不
支持。server connected 也不代表 probe、用户信任审批和项目命令审批已完成。详细配置见
[`build-runner-mcp/README.md`](../mcp-servers/build-runner-mcp/README.md)。

Runner 的 cache/environment opaque ID 只在当前 MCP 进程有效。客户端被强杀或崩溃后，
当前版本没有 startup sweep，也不能恢复旧 ID 来 inspect APK 或 dispose retained seed；
不要通过反复重启客户端假定残留已清理。

### Crashlytics 的跨客户端环境

CrashFix 默认通过名为 `firebase` 的项目内只读网关读取测试/已确认低敏项目，不需要
Cloud Logging export。网关内部固定启动
`firebase-tools@15.24.0 mcp --only crashlytics`；客户端不会直接连接官方进程。首次配置时
必须先选择且只选择一个完整连接 Profile，不能靠现有文件猜测，也不能失败后自动回退。

**`service-account` Profile** 需要服务账号 JSON 规范绝对路径、显式 Project ID 和 App
目录。JSON 内容不得由 Agent、setup 或 doctor 读取、回显或提交；网关在稳定身份核验后
创建一次性 `0600` 私有凭据副本，并把 Project ID 写入私有临时 configstore。它不要求、
不会创建 `.firebaserc`，也不把该文件作为项目来源；若 App 目录已经存在该文件，网关仍会
有界检查 alias 冲突并在异常或重映射时 fail-closed：

```bash
npm run setup -- --firebase-project-source service-account \
  --firebase-project-id my-firebase-project \
  --firebase-service-account /absolute/path/to/service-account.json \
  --firebase-dir /absolute/path/to/target-app-project
# 其他客户端追加：--client cursor、--client codex 等
```

**`firebaserc` Profile** 需要 Firebase CLI 已登录，并要求 App 目录已存在含有效
`projects.default` 的 `.firebaserc`，且该文件属于当前用户、不可被 group/other 写入。登录
必须由用户确认并选择账号；setup 不创建该文件。网关根据已验证的真实 App 目录，在启动前从
宿主登录态中只选择一个账号复制到私有 configstore，再把精确 Project ID 绑定到隔离的私有
上游目录；宿主 `activeProjects` 和真实 App 目录都不进入子进程：

```bash
npm run firebase -- login
npm run setup -- --firebase-project-source firebaserc \
  --firebase-dir /absolute/path/to/target-app-project
# 其他客户端追加对应参数，例如：--client cursor 或 --client codex
```

`.firebaserc` 只选择项目，不提供认证；服务账号只提供认证，所以 `service-account` Profile
还必须显式传 Project ID。两套 Profile 都不会授予 IAM；对应身份仍需单独具备目标
Firebase/Crashlytics 只读权限。若配置已经存在，审查并确认后再使用 `--force`。

两套 Profile 的 Firebase 私有目录会在正常关闭或启动失败的受控收尾中立即清理。进程被
强杀、崩溃或断电时可能残留；后续受控启动只对严格满足受管命名、当前用户 owner、私有
权限、有效 lease、最小年龄和失活 PID 等条件的旧目录做有界清扫，Windows 默认不清扫。
这不是宿主/凭据强隔离，也不保证重启会删除未知目录或同 UID 对抗进程留下的内容。

若必须手工维护配置，JSON 客户端的 `mcpServers.firebase`、Codex 的
`[mcp_servers.firebase]`、OpenCode 的 `mcp.firebase.command` 都必须指向当前 checkout 的
`firebase-readonly-mcp/dist/index.js`，而不是直接写 `npx firebase-tools mcp`。服务账号路径
只作为 `GOOGLE_APPLICATION_CREDENTIALS` 的本地绝对路径写入对应 `env`/`environment`，
绝不能内嵌 JSON。`firebaserc` Profile 禁止同时配置显式 ADC。修改后必须完整重启客户端：
`firebase_get_environment` 只核对运行身份和私有上下文，`firebase_get_project` 机械核对锁定的
Project ID/Number，`firebase_list_apps` 核对目标 Firebase App ID。environment 的 Project
Directory 是一次性私有路径，Detected App IDs 可能为空，不得拿它们与真实 App 路径/App ID
比较；真实 App 目录由本地受管客户端配置和 doctor 元数据核验。
Codex 的 `service-account` Profile 只能写进当前 checkout 的 `.codex/config.toml`，不得放进
全局 `~/.codex/config.toml`；Codex 会按 global → project 合并 MCP server key，doctor 采用
相同规则并单独审计全局层，因此被项目同名项遮蔽的全局服务账号 Profile 仍会报告 invalid。

网关在 `tools/list` 和 `tools/call` 两层只允许八个固定读取工具；官方
create/update/delete/note 工具对所有客户端都不可见。Codex 生成片段还会用
`enabled_tools` 重复固定同一集合。无参数 `firebase_get_crashlytics_report_guide` 仅用于
读取 Crashlytics Reports 指南，未知或未来新增工具默认不可用。网关内部唯一调用上游
`firebase_read_resources`，URI 硬编码为 `firebase://guides/crashlytics/reports`，客户端
不能列举、提供或改变 URI。每个需要 `topIssues` 或 `topVersions` 的 report session 都必须
在 session 建立后、首次相应 report 前调用别名恰好一次；进程缓存或其他 session 的成功结果不能充当当前
session 的顺序证明。别名读取失败或内容不符合固定 guide 契约时 fail-closed，不得继续
请求这两类 report。
该网关只限制工具、参数和响应边界，**不提供宿主/凭据隔离**，也不对官方 event 文本做
Agent 前服务端脱敏。生产环境或敏感度未知时必须 fail-closed，显式改用本仓
`crashlytics` Cloud Logging MCP。

`setup` 会为自研 `crashlytics` 生成空的 project/app allowlist。请在目标客户端实际
启动的 MCP 子进程配置中填写，而不是只在当前 shell 中 `export`：

- JSON 客户端（Claude Code、Cursor、Claude Desktop）：
  `mcpServers.crashlytics.env`。
- Codex TOML：`[mcp_servers.crashlytics]` 的 `env = { ... }`。
- OpenCode：全局配置中 `mcp.crashlytics.environment`。

该 production-safe `cloud_logging` 路径需要 Crashlytics export、
`CRASHLYTICS_PROVIDER`、project/app allowlist 和 ADC；fixture 需要同样的 allowlist 及
绝对 `CRASHLYTICS_FIXTURE_PATH`，但**不需要 ADC**。GUI 客户端通常不继承 shell 临时
环境，编辑后必须完整重启。完整示例和安全边界见
[`CRASHLYTICS.md`](./CRASHLYTICS.md)。

---

## Claude Code

**官方 IDE / CLI**：项目级 `.mcp.json` + `.claude/skills/`。

```bash
npm install
npm run build
npm run setup                  # 写 .mcp.json
npm run install:skills -- --force # 精确同步 .claude/skills/（仓库已跟踪，clone 后开箱即用）
npm run doctor
# 重启 Claude Code，/mcp 应看到 8 个项目内 server + mobile（共 9 个）
```

**触发 skill**：直接说 "测一下我刚改的" / "/devtest"、"找一下 bug" / "/smart-qa"，或 "分析 Firebase 上这个崩溃" / "/crashfix"，Claude Code 会按 `description` 字段匹配。

---

## Cursor

**Cursor IDE**：项目级 `.cursor/mcp.json` + `.cursor/rules/*.mdc`。schema 和 Claude Code 一致；rules 是 Cursor 的"提示词注入"机制。

```bash
npm install
npm run build
npm run setup -- --client cursor          # 写 .cursor/mcp.json
npm run install:skills -- --client cursor # 写 .mdc + .cursor/rules/<name>/ supporting files
# Cursor → Settings → MCP，应看到 9 个 server（含 mobile 与 firebase）
# Cursor → Settings → Rules，应看到 5 个 rule (devtest/qa/minimize/smart-qa/crashfix)
```

**触发 skill**：在 Cursor 的 Composer/Chat 里说 "/devtest" 或自然语言，Cursor 会按 rule 的 description 匹配并自动注入。

安装器会把 `references/scripts/assets/agents` supporting files 同步到
`.cursor/rules/<name>/`，并把 rule 内的相对 Markdown 链接改写到该目录。因此
CrashFix 的 `references/evidence-contract.md` 等依赖在 Cursor 中不是断链。

**已知限制**：
- Cursor rule 的 frontmatter schema 和 Claude Code 不同。我们的转换只映射 `description`，没把 `argument-hint` 带过去（Cursor 没这概念）。
- `globs: ['**/*']` 表示 rule 对所有文件触发；后续可按需收窄。

---

## Claude Desktop

**Anthropic 桌面 App**：没有本脚本可写入的项目级 skill 目录。MCP 配置是 global；
skill bundle 只能手动导入 Project，运行安装命令**不会自动安装，也不能据此声称 skill
已经可直接运行**。

```bash
npm install
npm run build
npm run setup -- --client claude-desktop   # 打印 JSON 片段
# 把片段 merge 到:
#   macOS:   ~/Library/Application Support/Claude/claude_desktop_config.json
#   Windows: %APPDATA%/Claude/claude_desktop_config.json
#   Linux:   ~/.config/Claude/claude_desktop_config.json
# 重启 Claude Desktop

npm run install:skills -- --client claude-desktop  # 打印完整 bundle 手动导入清单
# 在 Project 的 Custom Instructions 粘贴所选 SKILL.md；把命令列出的 supporting
# files 上传到同一 Project Knowledge，并保留文件名
```

**已知限制**：
- 对含 `references/` 的 skill（例如 CrashFix），只粘 `SKILL.md` 是不完整安装。若当前
  Desktop 版本不能按相对路径读取 Project Knowledge，必须把被引用 Markdown 全文追加
  到 Custom Instructions；做不到就不要在 Desktop 上启用该 skill。
- Custom Instructions 上下文有限。建议每个 Project 只导入当前需要的 1 个完整 bundle。
- 重启 Claude Desktop 才能识别新 MCP server。
- **PATH 兜底**：Claude Desktop 是 GUI app，spawn 子进程时**不继承 shell PATH**。
  `setup` 会把所有本仓 server 的 `"node"` 和两个上游 server 的 `"npx"` 分别改写成
  `which node` / `which npx` 探测到的绝对路径。如果任一探测失败，stdout 会给出警告；
  按提示手动替换对应的裸命令后再合并配置。

---

## Codex CLI

**OpenAI Codex CLI**：MCP 配置使用 TOML，setup 输出会建议合并到当前 checkout 的
`.codex/config.toml`。Codex 实际按 global → project 对 MCP server key 合并：项目同名项
覆盖全局项，项目未声明的 server 继续继承全局项。`doctor --client codex` 会安全读取并
规范化两层后执行相同合并；任一已存在文件无法安全解析都 fail-closed。全局层出现
`service-account` Profile/凭据路径时，即使已被项目同名项遮蔽仍判 invalid。只有用户明确
要求且全局配置不含这些内容时，才可使用 `~/.codex/config.toml`。skill 有两种安装方式，
脚本会同时帮你做：

1. **用户级**：复制完整 bundle 到 `~/.codex/skills/<name>/`（所有项目可见）
2. **项目级**：在仓库根写 `AGENTS.md`（其中 bundle 相对链接会改写到
   `skills/<name>/...`，不会从仓库根错误寻找 `references/`）

```bash
npm install
npm run build
npm run setup -- --client codex > /tmp/codex-mcp-snippet.txt
# 按 setup 提示，检查同名节后合并到当前 checkout 的 .codex/config.toml；
# 不要把整段直接 >> 到已有配置，否则可能产生重复 TOML section。

npm run install:skills -- --client codex   # 同时安装：
                                            #   ~/.codex/skills/{devtest,qa,minimize,smart-qa,crashfix}/ 完整 bundle
                                            #   ./AGENTS.md（含 5 个 skill 章节）
# 只更新项目聚合文件、不改用户目录：
npm run install:skills -- --client codex --project --force
codex                                      # 在仓库根目录跑 codex
```

> setup 当前打印 TOML 片段并建议当前 checkout 的 `.codex/config.toml`。AI 必须先做冲突
> 检测并只合并受管节，不得同时写两处或覆盖其他配置。Codex 仍会加载另一层：全局 server
> 会被项目同名项覆盖，未被覆盖的项继续生效。只有用户主动选择、且全局层不含
> `service-account` Profile/凭据路径时，才可改用 `~/.codex/config.toml`；服务账号 Profile
> 禁止全局配置，不能靠项目同名项遮蔽。

Codex 的 `firebase` 项目片段不是普通的可漂移全局命令。setup 会固定：

- `command`：当前 Node 的**绝对路径**；
- `args[0]`：当前 checkout 内 `firebase-readonly-mcp/dist/index.js` 的绝对路径；
- `cwd`：当前 `app-test-ctrl` 仓库根的绝对路径；
- `startup_timeout_sec = 60`；
- `enabled_tools`：包含无参数 `firebase_get_crashlytics_report_guide` 的八个只读工具。

这几项用于避免从其他目录启动 Codex 时发生 checkout 漂移，并形成重复的正向工具边界。
setup 无法解析 Node 或 mobile-mcp 所需 npx 的绝对路径时会直接失败；应先修复 PATH，再重新
生成、追加配置并完整重启 Codex。

**已知限制**：
- 用户级 `~/.codex/skills/` 用 `--force` 才覆盖已存在的旧版本；force 会把每个受管
  skill 目录精确同步到源并清理旧/未知文件，运行前应确认不需要保留同名目录内的手改
- `AGENTS.md` 同样需要 `--force` 才覆盖
- Codex 可用互斥的 `--global` / `--project` 只安装对应 scope；不传时保持同时安装，
  其他 client 传 scope 参数会直接报错，不会静默写错位置
- 安装器拒绝覆盖符号链接、硬链接及越界目录；`--force` 也不会绕过这些检查
- TOML 不支持 JSON 那种内嵌结构，所以 `env` 是 `{ KEY = "val" }` 单行写法

---

## OpenCode

**[OpenCode](https://opencode.ai/)**：SST 团队的开源终端 AI agent。安装器把 MCP
配置合并到全局 `~/.config/opencode/opencode.json`（Windows 为
`%APPDATA%/opencode/opencode.json`），不会写项目根 `opencode.json`；skill 直接复用
项目的 `.claude/skills/`（OpenCode 也会读取 `.opencode/skills/`、
`~/.config/opencode/skills/`、`.agents/skills/`）。

```bash
npm install
npm run build
npm run setup -- --client opencode            # 合并到 OpenCode 全局配置
npm run install:skills -- --client opencode   # 验证 .claude/skills/ 在位（natively 兼容）
opencode                                      # 在仓库根目录跑 opencode
```

**触发 skill**：自然语言（"帮我测一下" / "找 bug"），opencode 按 SKILL.md 的 `description` 字段匹配。

**已知限制**：
- OpenCode 的 MCP schema 跟 Claude Code/Cursor 略有差异：`command` 字段是
  `[bin, ...args]` 单数组（不是分开的 command + args），`env` 字段名叫
  `environment`。`setup` 脚本会转换并保留全局配置中的其他键；现有同名 MCP 键默认
  拒绝覆盖，只有显式 `--force` 才替换这些同名键。
- OpenCode 文档要求“技能名在所有搜索路径中保持唯一”，所以本仓**不**写
  `.opencode/skills/`，避免和 `.claude/skills/` 同名冲突——直接复用一份即可。
- OpenCode 只复用与 `skills/` 完整一致的 `.claude/skills/<name>/` bundle；发现缺失、
  过期或额外文件会拒绝复用。此时先跑
  `npm run install:skills -- --force` 精确同步，再重试 OpenCode 安装。

---

## 自己加一个客户端

源在 `skills/<name>/SKILL.md`。每个文件结构：

```markdown
---
name: <skill-id>
description: <一段触发说明，关键词 + 用途>
---

# 标题
... 用 MCP tool 名称（`ui.tap_element` / `log.start_capture` 等）和自然语言描述工作流 ...
```

任意 MCP-aware 客户端都可以：
1. 先运行 `npm run setup -- --client <name>`，把生成配置转换成客户端格式；不要直接复制
   `.mcp.json.example`，因为模板不包含 setup 注入的 checkout owner 与 Firebase 目标目录绑定
2. 把 `skills/<name>/SKILL.md` 的正文塞进客户端的 prompt-injection / rule 机制，并让
   `agents/references/scripts/assets` 中被引用的 supporting files 可按原相对路径读取
3. 用户对话时按 description 关键词触发

欢迎 PR 加新客户端到 `scripts/install-skills.mjs` 和 `scripts/setup-mcp.mjs`。
