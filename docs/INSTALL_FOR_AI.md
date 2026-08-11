# 给 AI 看的安装指引

> **怎么用**：把这份文档**整段**粘进你的 AI 聊天框（Claude Code / Cursor / Codex CLI / Claude Desktop 任一），然后说"按这个 INSTALL 指引帮我装好 app-test-ctrl"。AI 会按下面的章节接力完成。
>
> 用户也可以自己读着照做——每一步都给了可直接执行的命令。

---

## AI 角色与目标

你是用户的编码助手。本任务是帮用户在他的开发机上把 `app-test-ctrl`（一个跨客户端 MCP-native 移动 App 测试平台）装好并跑通最小冒烟。

**完成标准**：
1. 9 个 MCP server（8 个项目内 server、上游 mobile-mcp；其中 firebase 网关内部调用
   固定版官方 MCP）在用户的 AI
   客户端里都 `connected`
2. 5 个 Skill（devtest / qa / minimize / smart-qa / crashfix）在用户的客户端里可被触发
3. `npm run doctor` 输出 0 fail（warning 关于设备未连可忽略）

**全程原则**：
- 每一步先告诉用户"现在要做 X"，再跑命令
- 命令失败时**不要硬来**——把错误念给用户看，问怎么办（比如缺 `adb` 就让他装 Android Platform Tools，不要 brew install 不询问就跑）
- 修改客户端配置时分两种处理：
  - **Codex `.codex/config.toml` / `~/.codex/config.toml`**：按 setup 提示默认使用当前
    checkout 的项目配置。Codex 仍会按 global → project 合并 MCP server key，因此修改前
    必须分别审查两层，不能同时写两处或覆盖未知配置；只有用户主动要求且全局层不含
    `service-account` Profile/凭据路径时才可改用全局配置，服务账号 Profile 禁止写入全局，
    也不能靠项目同名项遮蔽
  - **Claude Desktop `claude_desktop_config.json`**：JSON 合并风险大，**只打印片段让用户自己粘贴**，绝不 sed/cat 改全局文件
- 用户已有的 `~/.codex/skills/` 下面的其他 skill 不要动；本仓只装 5 个独立子目录（devtest/qa/minimize/smart-qa/crashfix）

---

## 步骤 0：确认环境

跑这几条并把结果念给用户：

```bash
node -v                # 需 ≥ v20
npm -v                 # 需 ≥ 10
adb --version          # Android 测试需要；没装就告诉用户去装 Android SDK Platform Tools
xcrun --version        # iOS 测试需要（macOS only）；其他系统可跳
git --version          # clone 需要
```

如果 `node` 或 `npm` 缺/过低 → **停下来问用户**怎么处理（推荐用 nvm/fnm/volta，不要默认 `brew install node`）。

`adb` / `xcrun` 任缺一个可以继续——它们只影响后面跑测试，不影响安装本身。把缺的告诉用户。

---

## 步骤 1：确认 AI 客户端

问用户（或从上下文推断）他**当前在哪个 AI 客户端里跟你对话**：

| 选项 | 客户端 | 后续分支 |
|---|---|---|
| 1 | Claude Code | §4-A |
| 2 | Cursor | §4-B |
| 3 | Codex CLI | §4-C |
| 4 | Claude Desktop | §4-D |
| 5 | opencode | §4-E |
| 6 | Antigravity | §4-G |
| 7 | 其它 MCP-aware 客户端 | §4-F |

后面按用户选的分支走。**只跑那一个分支的命令**，不要把所有命令都跑一遍。

---

## 步骤 2：Clone 仓库

问用户希望 clone 到哪个目录。默认建议 `~/code/app-test-ctrl` 或当前工作目录的子目录。**不要**直接往 `/` 或 `~` 下面克隆。

```bash
# 替换 <DEST> 为用户选的绝对路径
git clone https://github.com/dj931567261/app-test-control.git <DEST>
cd <DEST>
```

确认 clone 成功后再继续。

这里的 Git 只用于取得 `app-test-ctrl` 控制器仓库，**不是** CrashFix 对目标 App 项目的
前置要求。目标项目可以没有 Git；不要为使用 CrashFix 自动执行 `git init`。

---

## 步骤 3：装依赖 + 构建

```bash
npm install        # 装 workspaces，会带上 8 个 mcp-servers 子包
npm run build      # tsc 编译 8 个 server 到 dist/
```

预期产物：

```
mcp-servers/log-mcp/dist/index.js
mcp-servers/report-mcp/dist/index.js
mcp-servers/ui-mcp/dist/index.js
mcp-servers/analyzer-mcp/dist/index.js
mcp-servers/code-analyzer-mcp/dist/index.js
mcp-servers/build-runner-mcp/dist/index.js
mcp-servers/crashlytics-mcp/dist/index.js
mcp-servers/firebase-readonly-mcp/dist/index.js
mcp-servers/firebase-readonly-mcp/dist/readonly-preload.js
```

8 个 `dist/index.js` 和 Firebase 只读 preload 缺任何一个 → build 失败，把
`npm run build` 的完整输出念给用户。

---

## 步骤 3.5：预热上游 MCP 依赖

`.mcp.json` 里的 `mobile` 使用 `@mobilenext/mobile-mcp@latest`，首次启动时 npx 可能
现场下载；这一步只把 mobile-mcp 预拉到本地缓存。Firebase 已由 lockfile 作为项目本地
`firebase-tools@15.24.0` 安装，不走 prewarm：

**执行前必须单独获得用户明确确认**：该命令会访问 npm registry，并向本机 npm 缓存
写入外部包。不能把前面对安装依赖的确认当作本步骤确认。

```bash
npm run prewarm
```

预期看到 mobile-mcp 已预热。

**失败时**：常见原因是 npm registry 不通（公司代理 / 国内镜像问题）。让用户：
1. 检查 `npm config get registry`，必要时切到 `https://registry.npmjs.org/` 或国内镜像
2. 或按提示单独预热 mobile-mcp；不要借此改动 lockfile 中固定的 Firebase CLI 版本

预热不强制成功也可以继续——只是首次跑测试时 MCP client 启动会慢 5-30 秒。把这条告诉用户由他决定。

---

## 步骤 4：按客户端分支注册 MCP + 装 Skill

### §4-A · Claude Code

```bash
npm run setup                          # 写 .mcp.json
# .claude/skills/ 已随仓库分发，不需要额外装
```

完成后告诉用户：
> 重启 Claude Code（或 `/exit` 后重进），在新会话输 `/mcp`，应看到 9 个 server
>（mobile / firebase / log / report / ui / analyzer / code-analyzer / build-runner /
> crashlytics）全部
> `connected`。

### §4-B · Cursor

```bash
npm run setup -- --client cursor          # 写 .cursor/mcp.json
npm run install:skills -- --client cursor # 写 rules/*.mdc + 每个 rule 的 references 等 supporting files
```

完成后告诉用户：
> Cursor → Settings → MCP，应看到 9 个 server；Cursor → Settings → Rules，应看到 5 个 rule。

安装器会把 rule 中的 `references/...` 链接改写到
`.cursor/rules/<name>/references/...` 并复制文件。不要只手工复制 `.mdc`，否则 CrashFix
等带引用的 rule 会是不完整安装。

### §4-C · Codex CLI

**a) MCP 配置（默认写当前 checkout，先做有界合并）**：

第一步，跑 setup 拿到 TOML 片段：

```bash
npm run setup -- --client codex > /tmp/codex-mcp-snippet.txt
```

追加前必须检查生成的 `[mcp_servers.firebase]`：`command` 是 Node 绝对路径，`args[0]`
是当前 checkout 内 `firebase-readonly-mcp/dist/index.js` 的绝对路径，`cwd` 是仓库根绝对
路径，并且存在 `startup_timeout_sec = 60`。这些值禁止改成相对路径或直接 npx 官方 MCP。
setup 若提示无法解析 Node（或 mobile-mcp 所需 npx），不得追加；先修复 PATH 后重新生成。

同一节的 `enabled_tools` 必须恰好包含以下八个只读工具：

```text
firebase_get_environment
firebase_get_project
firebase_list_apps
firebase_get_crashlytics_report_guide
crashlytics_get_issue
crashlytics_list_events
crashlytics_batch_get_events
crashlytics_get_report
```

第二步，按 setup 输出提示，把当前 checkout 的 `.codex/config.toml` 作为默认目标。只有
用户主动要求、且配置不含也不会接入 `service-account` Profile/凭据路径时，才可以改用
`~/.codex/config.toml`；不要向服务账号用户提供全局分支。Codex 会按 global → project 对
MCP server key 合并，因此写入目标仍只能有一个，但冲突审查必须覆盖两层：项目同名项覆盖
全局项，项目未声明项继续继承全局项。任一已存在文件损坏都必须停止，不能靠另一层给出
假绿；全局服务账号 Profile 即使被项目同名项覆盖也必须移除。然后对**两层文件**检查是否
已有这 9 节中的任一，实际写入仍只选择一个目标：

```bash
# 项目级（在 app-test-ctrl 根目录）
mkdir -p .codex && touch .codex/config.toml
grep -E '^\[mcp_servers\.(log|report|ui|analyzer|code-analyzer|build-runner|crashlytics|mobile|firebase)\]' .codex/config.toml || echo "no-conflict"

# 还要只读检查 ~/.codex/config.toml 的同名节；不要同时写两处
if [ -f "$HOME/.codex/config.toml" ]; then
  grep -E '^\[mcp_servers\.(log|report|ui|analyzer|code-analyzer|build-runner|crashlytics|mobile|firebase)\]' \
    "$HOME/.codex/config.toml" || echo "global-no-conflict"
else
  echo "global-not-present"
fi
# 仅非服务账号配置且用户主动选择全局时，才把它作为唯一写入目标
```

- **输出 `no-conflict`**（即没有任何冲突）→ 只向选定文件追加：
  ```bash
  # 从 snippet 里只取 [mcp_servers.*] 开始的内容（跳过开头的 # 注释行）
  awk '/^\[mcp_servers\./{p=1} p' /tmp/codex-mcp-snippet.txt >> .codex/config.toml
  # 仅满足上述非服务账号全局条件时，才把目标替换为 ~/.codex/config.toml
  ```
- **输出了某个节名**（有冲突）→ **停下来问用户**：
  > 你选择的 Codex 配置已经有 `[mcp_servers.xxx]` 节。要覆盖这些受管节（保留其他内容）、
  > 跳过冲突节，还是终止？

  用户选覆盖时：先用 awk 把已有的冲突节删掉，再 append 新节；选跳过时：从 snippet 里 awk 掉冲突节再 append；选终止：放弃这步，让用户自己处理后告诉你继续。

第三步，追加完毕后念给用户：
> 已写入你选择的 Codex 配置。请完整重启 Codex（如果在跑中先 Ctrl-C 退出再起）让新 MCP 生效。

⚠️ 不要用 `sed -i` 改文件中间内容；只在末尾 append。如果你不确定 awk 行为，**先 `cat` 出 snippet 让用户确认**再追加。

**b) Skill 安装（脚本自动完成）**：

```bash
npm run install:skills -- --client codex
```

这会同时做两件事：
- 复制完整 bundle 到 `~/.codex/skills/{devtest,qa,minimize,smart-qa,crashfix}/`
  （包含 `SKILL.md` 及 `agents/references/scripts/assets`）
- 写仓库根的 `AGENTS.md`（项目级 prompt 注入，其中相对引用改写到
  `skills/<name>/...`，不会产生根目录下的 `references/` 断链）

若只需刷新仓库内 `AGENTS.md`、不应改动用户目录，使用：

```bash
npm run install:skills -- --client codex --project --force
```

`--project` 与 `--global` 互斥且仅适用于 Codex；安装器即使在 `--force` 下也会
拒绝覆盖符号链接、硬链接或经过越界/符号链接目录的目标，遇到这类错误应先人工
核查路径，不能改用 `cp -L` 绕过。

如果用户的 `~/.codex/skills/` 已有同名 skill → 脚本默认**整项 skip**，把那行
`skipped` 念给用户问要不要 `--force` 精确同步。`--force` 会删除该同名受管 skill
目录中源已移除或未知的文件，不保留手改；符号链接、硬链接和越界路径仍会被拒绝。

### §4-D · Claude Desktop

Claude Desktop 没有本脚本可写入的项目级 skill 目录，只能手动导入完整 bundle。
`install:skills -- --client claude-desktop` **只打印清单，不会自动安装**；没有完成下述
导入时，不得告诉用户 skill 已可直接运行。

**a) MCP 配置（粘 JSON 片段）**：

```bash
npm run setup -- --client claude-desktop
```

把 stdout 的 `mcpServers` 块念给用户，告诉他粘贴位置：

| 系统 | 路径 |
|---|---|
| macOS | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Windows | `%APPDATA%/Claude/claude_desktop_config.json` |
| Linux | `~/.config/Claude/claude_desktop_config.json` |

**重要**：是 merge 进已有的 `mcpServers` 键，不是覆盖整个文件。

**PATH 兜底**：Desktop GUI 通常不继承 shell PATH。脚本会分别用 `which node` 和
`which npx`，把本仓 MCP 的 `node` 与 mobile/Firebase 两个上游 server 的 `npx` 改写
成绝对路径。如果
stdout 出现任一 `WARNING: couldn't resolve absolute ... path`，让用户手动运行对应的
`which node` / `which npx`，只替换片段中的同名裸 `command` 后再合并。

**b) Skill 安装（手动）**：

```bash
npm run install:skills -- --client claude-desktop
```

对用户选中的一个 skill：

1. 把清单里的 `SKILL.md` 全文粘到 Project 的 Custom Instructions。
2. 把该 skill 清单下的所有 supporting files
   （`agents/references/scripts/assets`）上传到同一 Project Knowledge，并保留文件名。
3. 确认 Desktop 能按 `references/...` 相对名称读取它们；若不能，就把被引用的
   Markdown 全文追加到 Custom Instructions。无法提供引用时不要启用该 skill。

受 Custom Instructions 上下文限制，建议一个 Project 只导入当前需要的一个完整
bundle；线上崩溃场景选 `crashfix` 时，两份 `references/*.md` 都是必需内容。

**c)** 重启 Claude Desktop。

### §4-E · opencode

[opencode](https://opencode.ai/) 是 SST 团队的开源终端 AI agent。

**a) MCP 配置（全局安装）**：

```bash
npm run setup -- --client opencode
```

这会自动将本仓所有的 MCP 服务器配置合并到 OpenCode 的**全局**配置文件中：
- **macOS/Linux**：`~/.config/opencode/opencode.json`
- **Windows**：`%APPDATA%/opencode/opencode.json`

这确保了无论您在哪个项目目录下运行 `opencode`，这 9 个 MCP 服务器都能全局可用。

**b) Skill 安装（智能检测并安装）**：

```bash
npm run install:skills -- --client opencode
```

OpenCode 原生支持读取项目级的 `.claude/skills/` 技能目录。因此，脚本会先校验项目根
`.claude/skills/<name>/` 是否与 `skills/<name>/` 完整一致（含 supporting files，且
没有额外旧文件）：
- 如果项目级已经存在该技能，则直接跳过，避免发生技能同名冲突。
- 如果当前项目没有安装该技能，脚本会自动将其安装到 OpenCode 的**全局技能目录**：
  - **macOS/Linux**：`~/.config/opencode/skills/<name>/`（完整 bundle）
  - **Windows**：`%APPDATA%/opencode/skills/<name>/`（完整 bundle）

**c)** 完成后告诉用户：
> 在仓库根目录跑 `opencode`（或重启 opencode 会话）。MCP server 应自动连上，问 "找一下 bug" / "测我刚改的功能" 就能触发对应 skill。

### §4-G · Antigravity

Antigravity 是基于双通道（MCP + Skills）的智能开发自测与 QA 探索客户端。

**a) MCP 配置**：

```bash
npm run setup -- --client antigravity
```

这会自动将本仓所有 MCP server 的 command 和 args 转换成绝对路径（以确保后台 language_server 守护进程运行时能够准确找到 `node`/`npx`），并注入完整的 shell PATH 及 `ADB_BIN` 路径，最终写入 `~/.gemini/config/mcp_config.json`。

**b) Skill 安装**：

```bash
npm run install:skills -- --client antigravity
```

这会自动将 5 个 Skill bundle 复制到 `~/.gemini/config/skills/<name>/`，它们会被 Antigravity 自主读取作为 Agent 的专业自测、探索与线上崩溃分析技能。

**c) 重启客户端**：

完成后告诉用户：
> 已配置完毕。请重启 Antigravity 的 AI 客户端会话，在聊天中发送 `/mcp` 或直接询问 `测一下我刚改的` / `找一下 bug`，客户端即可自动连上所有 MCP 服务并激活自测/探索能力！

### §4-F · 其它 MCP-aware 客户端

跟用户确认他客户端的 MCP 配置文件位置 + skill / system-prompt 注入机制。然后：

1. 先运行 `npm run setup -- --client <name>`；若脚本尚不支持该客户端，只把生成结果作为
   转换输入，再按客户端要求改写 JSON / TOML / YAML。不要直接复制 `.mcp.json.example`：
   它没有 setup 生成的 checkout owner hash，也不会自行校验或注入 Firebase 目标 `--dir`
2. 跑 `ls skills/` 拿到 5 个 skill 名；入口在 `skills/<name>/SKILL.md`，并同时分发
   `agents/references/scripts/assets`。只有不引用 supporting files 的 skill 才能只复用
   SKILL.md；否则必须保持完整 bundle 和相对路径。
3. 引用 `docs/CLIENTS.md` 看已支持客户端的实现细节作为参考

---

## 步骤 4.5：配置 CrashFix 默认数据源（需要 CrashFix 时）

项目内 Firebase 只读网关是默认 acquisition 入口，内部调用固定版官方 MCP，不需要
Cloud Logging export。先让用户确认目标是测试/已确认低敏项目，然后在执行任何登录、
配置变更或 Firebase 调用前，必须先问：

> 请选择 Firebase MCP 接入 Profile：
> 1. `service-account`：服务账号 JSON 绝对路径 + 显式 Project ID + App 项目目录，不需要
>    `.firebaserc`；
> 2. `firebaserc`：Firebase CLI 已登录 + App 项目目录已有 `.firebaserc`。

只能按用户明确选择执行一个分支。不得根据文件是否存在、JSON 文件名、当前登录态或环境
变量替用户选择；一个 Profile 失败后不得自动回退到另一个。

### 分支 A：`service-account`

向用户索取以下三个**路径/标识**，不要索取或读取 JSON 内容：

1. 服务账号 JSON 的规范绝对路径；
2. 显式 Firebase Project ID；
3. 目标 App 项目目录绝对路径。

不得由 Agent 执行 `cat`、`jq`、打印、手工复制或上传服务账号 JSON，也不得把 private key、
token 或 JSON 内容写进聊天、命令、配置、报告或 Git。setup/doctor 只检查路径、owner、权限、文件
类型与大小；网关稳定核验同一身份后做不解析内容的一次性 `0600` 私有快照，固定上游认证库
只通过该私有路径使用凭据。POSIX 上文件必须属于当前用户且拒绝
group/other 访问（通常先由用户设置 `chmod 600`）。

```bash
npm run setup -- --firebase-project-source service-account \
  --firebase-project-id <FIREBASE_PROJECT_ID> \
  --firebase-service-account <ABSOLUTE_SERVICE_ACCOUNT_JSON> \
  --firebase-dir <ABSOLUTE_APP_PROJECT_DIR>
# 非 Claude Code 客户端再追加 --client <name>
```

该分支不要求 App 项目中存在 `.firebaserc`，也不得创建或修改它；该文件不是项目来源。
若 App 目录已经存在 `.firebaserc`，网关仍会有界解析并检查 alias 冲突，文件异常或重映射
时 fail-closed。网关基于已验证的真实 App 目录锁定 Profile，再在私有临时 configstore 中
把显式 Project ID 绑定到隔离的私有上游目录；真实目录不会暴露给官方子进程。即使服务账号文件
本身含 project 字段，也不能读出后替代用户显式输入的 `--firebase-project-id`。
若客户端是 Codex，必须把生成片段合并到当前 checkout 的 `.codex/config.toml`，不能写入
全局 `~/.codex/config.toml`；doctor 会把全局服务账号 Profile 明确判为 invalid。

### 分支 B：`firebaserc`

要求目标 App 项目目录**已经存在** `.firebaserc`，并包含有效的 `projects.default`；POSIX
上它必须属于当前用户且不可被 group/other 写入。
setup 只校验现有文件，不得替用户创建、覆盖或切换 active project。`.firebaserc` 只负责
项目选择，不能替代认证。

**执行登录命令前必须单独获得用户明确确认**：它会访问 Firebase、打开浏览器，并在
本机写入 Firebase CLI 登录态。不得代替用户选择账号，也不得回显登录信息。

```bash
npm run firebase -- login
npm run setup -- --firebase-project-source firebaserc \
  --firebase-dir <ABSOLUTE_APP_PROJECT_DIR>
# 非 Claude Code 客户端再追加 --client <name>
```

网关随后根据已验证的真实 App 目录，只选择一个 CLI 登录账号复制到一次性私有 configstore，
并把已验证的 Project ID 绑定到私有上游目录；不得把宿主其他账号、旧 `activeProjects` 或
真实 App 目录传给上游。

两条分支的 Firebase 私有目录会在正常关闭或启动失败的受控收尾中立即清理。强杀、崩溃或
断电可能留下残留；后续受控启动仅对同时满足严格受管命名、当前用户 owner、私有权限、
有效 lease、最小年龄和失活 PID 等条件的旧目录做有界清扫，Windows 默认不清扫。不满足
任一条件都必须跳过；该机制不覆盖 lease 写入前的极短窗口或同 UID 对抗进程，不是强隔离，
也不能承诺重启后清空所有未知目录。

### 两个分支的共同收尾

已存在配置时先审查冲突，只有用户确认可覆盖才加 `--force`。生成的 `firebase` 节必须
指向当前 checkout 的 `firebase-readonly-mcp/dist/index.js`：`service-account` args 包含
`--project-source service-account --project-id <id> --dir <app-dir>`，env 只保存凭据绝对路径；
`firebaserc` args 包含 `--project-source firebaserc --dir <app-dir>`，不得含显式 ADC。网关
内部固定使用 `firebase-tools@15.24.0 mcp --only crashlytics`。不要把控制器仓库当成目标
App 项目目录。

任何 Profile/客户端配置变更后必须**完整重启客户端**。先运行
`npm run doctor -- --client <name>` 核验本地受管配置中的真实 App 目录，再依次调用：
`firebase_get_environment` 核对运行身份和私有上下文，`firebase_get_project` 机械核对锁定的
Project ID/Number，`firebase_list_apps` 核对目标 Firebase App ID。environment 返回的一次性
私有 Project Directory 和可能为空的 Detected App IDs 都不能与真实 App 信息比较。doctor
不读取服务账号 JSON、不验证 CLI 登录态、不访问 Firebase，也不会配置 IAM；服务账号或 CLI
用户仍须由项目管理员单独授予目标 Firebase/Crashlytics 所需的最小只读权限。身份、项目和
App 任一不匹配都停止，不读取详情、不切换 Profile。

同时确认目标项目希望使用的源码身份方式：

- `provenance=auto`（默认）：有效 Git → `git_release_exact`；确认无 Git →
  `snapshot_repro_equivalent`。
- `provenance=git`：只接受有效 Git，不可用时不回退 snapshot。
- `provenance=snapshot`：即使存在有效或损坏的 `.git` 也不使用 Git。

预检结果只有 `provenance_status=resolved|unavailable`。损坏/不可读 Git 在 `auto` 下，或
无效 Git 在显式 `git` 下，都属于 `unavailable`：`analyze` 仅允许 remote-only；
`patch/pr` 必须先建立审计 session，再立即中止，不调用任何 Firebase 身份或详情工具。
所有 `pr`，以及 commit/push，契约上都只支持 `resolved + git_release_exact`，不得自动
`git init` 或静默换路。当前本仓 Build Runner 暂不支持 Git build path，Git `patch/pr`
会在首条项目命令前中止；不得把 worktree 伪装成 snapshot。
snapshot `analyze` 只需经审批创建 sealed snapshot 做静态定位，不强制 baseline、构建、
安装或真机；snapshot `patch` 才要求 baseline 在专用真机复现远端同一
`(signature_version, fingerprint)`。
若后续导出已接受的 snapshot 候选，helper 命令必须独立传入
`--original-workspace <Phase 0 锁定的绝对原项目目录>`；`--forbid-root` 不能替代它。
完整导出命令以 `docs/CRASHLYTICS.md` 为准。

提醒用户：官方进程本身仍有写能力，但网关在 `tools/list` 与 `tools/call` 两层只暴露/
转发 8 个固定读取工具，写工具对客户端不可见。网关只限制工具、参数和响应，不提供
宿主/凭据隔离，也不会在 Agent 前服务端脱敏官方 event 文本。若目标是生产项目、包含
个人数据或敏感度未知，必须 fail-closed，不读取详情，改按
`docs/CRASHLYTICS.md` 配置本仓 `crashlytics` Cloud Logging MCP、ADC 和精确 allowlist。

官方只读 allowlist 共八项；无参数 `firebase_get_crashlytics_report_guide` 只能用于当前
report session 的 guide 前置。网关内部唯一调用上游 `firebase_read_resources`，并把 URI
硬编码为 `firebase://guides/crashlytics/reports`，客户端不能列举、提供或改变 URI。
每个需要 `topIssues` 或 `topVersions` 的 session 都必须在 report session 建立后、首次相应 report 前调用别名
恰好一次；不得用进程缓存或其他 session 的成功结果证明顺序。别名不可用或失败时必须
fail-closed，不调用这两类 report，也不能凭记忆构造 report 参数。

snapshot Android `patch` 的新安装默认配置 `build-runner=local_trusted`，不需要 Docker。
先调用 `probe_capabilities` 核对本机 JDK/Android SDK/apkanalyzer/apksigner；即使 ready，首次
项目命令前仍要展示并确认：精确可信项目/源码身份、`strong_isolation=false`、网络/文件/
宿主秘密/磁盘 quota 隔离未强制、`process_containment=process_group_best_effort`、最小环境、
私有 HOME/TMP/Gradle cache、超时与进程组清理。每条 exact Gradle 命令继续单独确认。
不得把 offline flag 或独立 workspace 说成 sandbox。

用户明确要求严格隔离时，重新生成配置：

```bash
npm run setup -- --build-runner-backend docker
```

再让用户提供绝对 Docker executable 和已存在的 digest-pinned Android image；Unix socket
必须本地、当前用户拥有、非 symlink 且权限恰为 `0600`。不要替用户猜镜像、自动 pull 或
启动 Docker。严格 profile 失败不自动转 local；改变选择需新建 CrashFix session。

Runner 固定为 `probe → 独立批准 seal cache → opaque cache_seed_id → create → run →
inspect({environment_id})`。build create 绑定当时不存在的 APK path 与已批准非生产 signer
hash；run 不返回日志原文；inspect 消费私有 staging 并严格匹配 signer。retained seed 的
`dispose_gradle_cache` 还需另一项清理确认。当前只支持 snapshot Android。local 可在审批后
执行可信项目但必须记录未强隔离；Docker 的可写 workspace 是宿主 bind 且磁盘 quota 尚未
由 Runner 强制，所以 strict profile 仍 fail-closed。不能把 connected 夸大为构建能力。
opaque cache/environment ID 仅在本次 MCP 进程有效；异常退出没有 startup sweep，重启
不能证明旧 container、APK staging 或 retained seed 已清理。

---

## 步骤 5：自检

```bash
npm run doctor -- --client <当前客户端名>
```

预期输出至少这几个 ✓：
- `Node ≥ 20` / `npm ≥ 10`
- 8 个 `mcp-servers/*/dist/index.js`
- mobile-mcp 的 npx 缓存状态，以及项目本地 Firebase 固定版本/网关构建状态
- 所选客户端的实际配置文件
- `Skills (source): crashfix, devtest, minimize, qa, smart-qa`

**warning 要理解后再决定是否继续的**：
- `No Android devices ready`（没插手机/没起模拟器，跑测试时再说）
- `No iOS simulators booted`（同上）
- `Official Firebase MCP connection profile not selected`（尚未选择接入方式；先让用户明确选择
  `service-account` 或 `firebaserc`，再用步骤 4.5 的对应命令配置，不能自行推断）
- `Service-account credential path is unsafe or unavailable`（所选 `service-account` 路径不可用；
  要求当前用户拥有、非符号链接、仅当前用户可访问的规范绝对路径，修正后重新 setup）
- `Firebase CLI project binding missing or invalid`（所选 `firebaserc` 路径缺少有效的
  `projects.default`；让用户先准备现有 `.firebaserc`，setup 不会替他创建）
- `Firebase authentication/project identity not verified by doctor`（doctor 不访问 Firebase；
  完整重启后还要用 environment 核对运行身份/私有上下文、project 核对 Project ID/Number、
  apps 核对目标 App ID，并独立验证 IAM；不要拿 environment 的私有目录/空 App 列表核对真实 App）
- `local_trusted ready but not strongly isolated`（默认模式的诚实提示；禁止无人值守自动资格，
  但明确可信、低敏项目完成运行时审批后仍可执行 patch）
- `docker_strict unavailable`（严格模式当前可能因宿主 quota 门槛不可用；不能靠配置布尔值
  绕过，也不会自动切换 local）

**fail 必须处理**：
- `dist/index.js missing` → 重跑 `npm run build`
- `node_modules missing` → 重跑 `npm install`
- `.claude/skills/ missing/outdated` → 运行 `npm run install:skills -- --force`；Claude Code
  与 OpenCode 会直接执行该镜像，任何 bundle 漂移都是安全阻断项

---

## 步骤 6：跑通最小冒烟（可选但推荐）

如果用户接入的是 Claude Code / Cursor / Antigravity，重启客户端后让他在新会话里说一句：

> 起 session，列一下当前设备

预期 AI 会调 `report.start_session(report_language="zh-CN")` +
`mobile.mobile_list_available_devices`，并返回 session 路径 + 设备列表。这就证明 MCP
接通了。报告默认简体中文；只有用户明确要求英文时才使用 `en-US`。

更完整的端到端冒烟（启 app + 抓 log + 出报告）见 `docs/SETUP.md §4`。

---

## 卸载与清理

如果需要卸载对应 AI 客户端中注册的 MCP 服务和安装的 Skills，可以运行：

```bash
# 替换 <CLIENT_NAME> 为具体客户端（如 claude-code, cursor, codex, opencode, antigravity）
npm run uninstall -- --client <CLIENT_NAME>
```

该命令会安全地从目标 AI 客户端的配置文件中移除这 9 个受管 MCP 节点，并删除拷贝到
全局或规则文件夹中的 5 个 Skill bundle。

---

## 故障排查

| 现象 | 处理 |
|---|---|
| `/mcp` 显示 `log/report/...` failed | 看客户端日志；通常是 `dist/index.js` 路径不对（`.mcp.json` 里的绝对路径错了）→ `npm run setup --force` 重写 |
| `npm install` 卡在 `mobile-mcp` | 那是 npx 自动拉的上游包，看用户网络；可以让他先 `npm install -g @mobilenext/mobile-mcp` 预热 |
| `firebase` MCP failed | 先确认已选定的唯一 Profile，不得自动换路：`service-account` 核对 JSON 规范绝对路径、文件权限、显式 Project ID 与 App 目录；`firebaserc` 核对 Firebase CLI 登录态、App 目录和已有 `.firebaserc`。再运行 `npm install && npm run build`、复核项目内网关配置并完整重启。Codex 还要核对绝对 Node、网关入口、绝对 `cwd`、8 项 `enabled_tools` 与 `startup_timeout_sec = 60`；最后用 doctor 复核本地真实 App 目录 |
| CrashFix 找错 Firebase 项目 | 先检查网关 `--dir` 是否为目标 App 目录；`service-account` 再核对 `--project-id`，不要查找或创建 `.firebaserc`；`firebaserc` 则核对现有 `.firebaserc` 的 `projects.default`。完整重启后用 environment 核对运行身份/私有上下文、project 核对 Project ID/Number、apps 核对目标 App ID；environment 的私有目录和可能为空的 Detected App IDs 不是实际 App 身份，仍不得自动切换 Profile |
| `build-runner` connected 但 probe unavailable | 先确认 profile：local 核对 JDK/Android SDK 工具；docker 核对绝对 Docker executable、本地当前用户 `0600` socket、Linux daemon、digest-pinned image 与 quota。不得自动切换 |
| Codex 找不到 skill | 确认 `~/.codex/skills/<name>/SKILL.md` 存在；如果只装了 `AGENTS.md`，要在仓库根目录启动 codex 才生效 |
| Cursor rule 不触发 | Cursor → Settings → Rules，看 5 个 rule 是否 enabled；CrashFix 还要确认 `.cursor/rules/crashfix/references/` 完整 |
| Claude Desktop `/mcp` 还是旧的 | Claude Desktop 必须完全退出（菜单栏 Quit，不是关窗口）才能重读 config |
| opencode 没识别 MCP | 确认全局配置文件 ~/.config/opencode/opencode.json 中已成功并入了 mcp 节。如果缺少，可以重新运行 npm run setup -- --client opencode 再次写入。 |
| opencode 没识别 skill | 确认项目级 `.claude/skills/<name>/SKILL.md` 或全局 `~/.config/opencode/skills/<name>/SKILL.md` 是否在位 |
| Antigravity 找不到 MCP 或 Skill | 确保写在 `~/.gemini/config/mcp_config.json`；若运行环境为 GUI/LSP 守护进程没有继承 Shell 环境变量，运行 `npm run setup -- --client antigravity` 会自动检测并填入 Node/Npx 绝对路径与完整的 PATH 环境变量 |

---

## 完成检查清单（AI 跑完一定要确认）

- [ ] 用户的 AI 客户端已识别（§1）
- [ ] 仓库 clone 到用户指定的绝对路径（§2）
- [ ] `npm run build` 的 8 个 `dist/index.js` 与 Firebase 只读 preload 均齐全（§3）
- [ ] `npm run prewarm` 跑过（§3.5，失败也行，告知用户即可）
- [ ] 当前客户端的 MCP 配置已注册（§4-A/B/C/D/E/F/G）
- [ ] 如需 CrashFix，已由用户明确选择 `service-account` 或 `firebaserc`，且没有自动回退
- [ ] 所选 Profile 输入已核对：前者为 JSON 绝对路径、显式 Project ID、App 绝对目录；不
      要求/创建 `.firebaserc`，也不把它作为项目来源，但已有文件会做 alias 冲突检查；后者
      为 Firebase CLI 已登录、App 目录已有 `.firebaserc` 且未自动创建
- [ ] 已确认测试/已确认低敏边界、只读网关和固定 Firebase CLI 版本；服务账号 JSON 内容
      未被 Agent/setup/doctor 读取或回显，也未进入聊天、报告或 Git；网关只做不解析字节的
      一次性私有复制，固定上游认证库仅通过副本使用凭据
- [ ] 当前客户端的 Skill 已就位（§4-A/B/C/D/E/F/G）
- [ ] `npm run doctor` 0 fail（§5）
- [ ] 配置变更后已让用户完整重启客户端；已用 environment 核对运行身份/私有上下文、
      project 核对 Project ID/Number、apps 核对目标 App ID，且未把 environment 的私有目录或
      可能为空的 Detected App IDs 与真实 App 信息比较
- [ ] Crashlytics 所需 IAM 已独立配置/验证；setup 与 doctor 不会自动授予权限
- [ ] 把"重启客户端"和"`/mcp` 检查"念给用户了

跑完最后说一句给用户：
> 装好了。重启 <客户端名> 后，可以试着说"测一下我刚改的功能"（触发 devtest）、"找一下 bug"（触发 smart-qa），或"分析 Firebase 上这个崩溃"（触发 crashfix）。完整文档见 `docs/SETUP.md` 和 `docs/CLIENTS.md`。
