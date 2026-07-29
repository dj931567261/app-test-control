# 给 AI 看的安装指引

> **怎么用**：把这份文档**整段**粘进你的 AI 聊天框（Claude Code / Cursor / Codex CLI / Claude Desktop 任一），然后说"按这个 INSTALL 指引帮我装好 app-test-ctrl"。AI 会按下面的章节接力完成。
>
> 用户也可以自己读着照做——每一步都给了可直接执行的命令。

---

## AI 角色与目标

你是用户的编码助手。本任务是帮用户在他的开发机上把 `app-test-ctrl`（一个跨客户端 MCP-native 移动 App 测试平台）装好并跑通最小冒烟。

**完成标准**：
1. 6 个本仓 MCP server 和上游 mobile-mcp 在用户的 AI 客户端里都 `connected`
2. 5 个 Skill（devtest / qa / minimize / smart-qa / crashfix）在用户的客户端里可被触发
3. `npm run doctor` 输出 0 fail（warning 关于设备未连可忽略）

**全程原则**：
- 每一步先告诉用户"现在要做 X"，再跑命令
- 命令失败时**不要硬来**——把错误念给用户看，问怎么办（比如缺 `adb` 就让他装 Android Platform Tools，不要 brew install 不询问就跑）
- 修改用户全局配置时分两种处理：
  - **Codex `~/.codex/config.toml`**：你**可以**自己用 `cat >>` 追加新节（详见 §4-C），但**必须先做冲突检测**——已存在的同名 `[mcp_servers.xxx]` 节不要覆盖，发现冲突就停下来问用户
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

---

## 步骤 3：装依赖 + 构建

```bash
npm install        # 装 workspaces，会带上 6 个 mcp-servers 子包
npm run build      # tsc 编译 6 个 server 到 dist/
```

预期产物：

```
mcp-servers/log-mcp/dist/index.js
mcp-servers/report-mcp/dist/index.js
mcp-servers/ui-mcp/dist/index.js
mcp-servers/analyzer-mcp/dist/index.js
mcp-servers/code-analyzer-mcp/dist/index.js
mcp-servers/crashlytics-mcp/dist/index.js
```

6 个 `dist/index.js` 缺任何一个 → build 失败，把 `npm run build` 的完整输出念给用户。

---

## 步骤 3.5：预热 mobile-mcp（上游依赖）

`.mcp.json` 里的 `mobile` server 用 `npx -y @mobilenext/mobile-mcp@latest` 拉上游包。**首次**启动 MCP client 时 npx 会现场下载——慢且依赖网络。这一步把它预拉到 npx 本地缓存：

```bash
npm run prewarm
```

预期看到 `✓ mobile-mcp 已预热到 npx 缓存` 和 mobile-mcp 的版本号（如 `0.0.56`）。

**失败时**：常见原因是 npm registry 不通（公司代理 / 国内镜像问题）。让用户：
1. 检查 `npm config get registry`，必要时切到 `https://registry.npmjs.org/` 或国内镜像
2. 或者直接全局装：`npm install -g @mobilenext/mobile-mcp@latest`（绕过 npx，但需要保证 PATH 能找到）

预热不强制成功也可以继续——只是首次跑测试时 MCP client 启动会慢 5-30 秒。把这条告诉用户由他决定。

---

## 步骤 4：按客户端分支注册 MCP + 装 Skill

### §4-A · Claude Code

```bash
npm run setup                          # 写 .mcp.json
# .claude/skills/ 已随仓库分发，不需要额外装
```

完成后告诉用户：
> 重启 Claude Code（或 `/exit` 后重进），在新会话输 `/mcp`，应看到 7 个 server（mobile / log / report / ui / analyzer / code-analyzer / crashlytics）全部 `connected`。

### §4-B · Cursor

```bash
npm run setup -- --client cursor          # 写 .cursor/mcp.json
npm run install:skills -- --client cursor # 写 rules/*.mdc + 每个 rule 的 references 等 supporting files
```

完成后告诉用户：
> Cursor → Settings → MCP，应看到 7 个 server；Cursor → Settings → Rules，应看到 5 个 rule。

安装器会把 rule 中的 `references/...` 链接改写到
`.cursor/rules/<name>/references/...` 并复制文件。不要只手工复制 `.mdc`，否则 CrashFix
等带引用的 rule 会是不完整安装。

### §4-C · Codex CLI

**a) MCP 配置（AI 自动追加到 `~/.codex/config.toml`，不要让用户手动粘）**：

第一步，跑 setup 拿到 TOML 片段：

```bash
npm run setup -- --client codex > /tmp/codex-mcp-snippet.txt
```

第二步，**冲突检测**——读 `~/.codex/config.toml`（如果存在），看是否已有这 7 节中的任一：

```bash
mkdir -p ~/.codex
touch ~/.codex/config.toml
grep -E '^\[mcp_servers\.(log|report|ui|analyzer|code-analyzer|crashlytics|mobile)\]' ~/.codex/config.toml || echo "no-conflict"
```

- **输出 `no-conflict`**（即没有任何冲突）→ 直接追加：
  ```bash
  # 从 snippet 里只取 [mcp_servers.*] 开始的内容（跳过开头的 # 注释行）
  awk '/^\[mcp_servers\./{p=1} p' /tmp/codex-mcp-snippet.txt >> ~/.codex/config.toml
  ```
- **输出了某个节名**（有冲突）→ **停下来问用户**：
  > 你的 `~/.codex/config.toml` 已经有 `[mcp_servers.xxx]` 节。要覆盖（保留你已有的其它内容）、跳过这几节、还是终止？

  用户选覆盖时：先用 awk 把已有的冲突节删掉，再 append 新节；选跳过时：从 snippet 里 awk 掉冲突节再 append；选终止：放弃这步，让用户自己处理后告诉你继续。

第三步，追加完毕后念给用户：
> 已写入 `~/.codex/config.toml`。请重启 codex（如果在跑中先 Ctrl-C 退出再起）让新 MCP 生效。

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
`which npx`，把本仓 MCP 的 `node` 与 mobile-mcp 的 `npx` 改写成绝对路径。如果
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

这确保了无论您在哪个项目目录下运行 `opencode`，这 7 个 MCP 服务器都能全局可用。

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

1. 跑 `cat .mcp.json.example` 拿 MCP 配置模板，把 `${PROJECT_ROOT}` 全替换成 clone 的绝对路径，按客户端要求的格式（JSON / TOML / YAML）改写
2. 跑 `ls skills/` 拿到 5 个 skill 名；入口在 `skills/<name>/SKILL.md`，并同时分发
   `agents/references/scripts/assets`。只有不引用 supporting files 的 skill 才能只复用
   SKILL.md；否则必须保持完整 bundle 和相对路径。
3. 引用 `docs/CLIENTS.md` 看已支持客户端的实现细节作为参考

---

## 步骤 5：自检

```bash
npm run doctor
```

预期输出至少这几个 ✓：
- `Node ≥ 20` / `npm ≥ 10`
- 6 个 `mcp-servers/*/dist/index.js`
- `.mcp.json present`（Claude Code 分支）或对应客户端的配置文件
- `Skills (source): crashfix, devtest, minimize, qa, smart-qa`

**warning 可以忽略的**：
- `No Android devices ready`（没插手机/没起模拟器，跑测试时再说）
- `No iOS simulators booted`（同上）

**fail 必须处理**：
- `dist/index.js missing` → 重跑 `npm run build`
- `node_modules missing` → 重跑 `npm install`
- `.claude/skills/ missing/outdated` → 运行 `npm run install:skills -- --force`；Claude Code
  与 OpenCode 会直接执行该镜像，任何 bundle 漂移都是安全阻断项

---

## 步骤 6：跑通最小冒烟（可选但推荐）

如果用户接入的是 Claude Code / Cursor / Antigravity，重启客户端后让他在新会话里说一句：

> 起 session，列一下当前设备

预期 AI 会调 `report.start_session` + `mobile.mobile_list_available_devices`，并返回 session 路径 + 设备列表。这就证明 MCP 接通了。

更完整的端到端冒烟（启 app + 抓 log + 出报告）见 `docs/SETUP.md §4`。

---

## 卸载与清理

如果需要卸载对应 AI 客户端中注册的 MCP 服务和安装的 Skills，可以运行：

```bash
# 替换 <CLIENT_NAME> 为具体客户端（如 claude-code, cursor, codex, opencode, antigravity）
npm run uninstall -- --client <CLIENT_NAME>
```

该命令会安全地从目标 AI 客户端的配置文件中移除这 7 个 MCP 节点，并删除拷贝到全局或规则文件夹中的 5 个 Skill bundle。

---

## 故障排查

| 现象 | 处理 |
|---|---|
| `/mcp` 显示 `log/report/...` failed | 看客户端日志；通常是 `dist/index.js` 路径不对（`.mcp.json` 里的绝对路径错了）→ `npm run setup --force` 重写 |
| `npm install` 卡在 `mobile-mcp` | 那是 npx 自动拉的上游包，看用户网络；可以让他先 `npm install -g @mobilenext/mobile-mcp` 预热 |
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
- [ ] `npm run build` 6 个 dist 产物齐全（§3）
- [ ] `npm run prewarm` 跑过（§3.5，失败也行，告知用户即可）
- [ ] 当前客户端的 MCP 配置已注册（§4-A/B/C/D/E/F/G）
- [ ] 当前客户端的 Skill 已就位（§4-A/B/C/D/E/F/G）
- [ ] `npm run doctor` 0 fail（§5）
- [ ] 把"重启客户端"和"`/mcp` 检查"念给用户了

跑完最后说一句给用户：
> 装好了。重启 <客户端名> 后，可以试着说"测一下我刚改的功能"（触发 devtest）、"找一下 bug"（触发 smart-qa），或"分析 Firebase 上这个崩溃"（触发 crashfix）。完整文档见 `docs/SETUP.md` 和 `docs/CLIENTS.md`。
