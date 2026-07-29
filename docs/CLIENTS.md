# 支持的 AI 客户端

`app-test-ctrl` 的 6 个自研 MCP server、上游 mobile-mcp 和 5 个 Skill 与具体客户端解耦：
- **MCP 协议**通用，差异只在配置文件位置 / 格式（JSON vs TOML）
- **Skill 内容**用 MCP tool 名称 + 中立自然语言写成，~95% 跨客户端可移植

下表覆盖首批支持的 5 个客户端：

## 客户端支持矩阵

| 客户端 | MCP 自动写文件 | Skill 自动安装 | 文件位置 |
|---|:-:|:-:|---|
| **Claude Code** | ✅ | ✅ | `.mcp.json` + `.claude/skills/<name>/`（完整 bundle） |
| **Cursor** | ✅ | ✅ | `.cursor/mcp.json` + `.cursor/rules/<name>.mdc` + `<name>/` supporting files |
| **Claude Desktop** | ❌ paste-snippet | ❌ 手动 | global JSON file |
| **Codex CLI** | ✅ AI 自动追加 | ✅ 双安装 | `~/.codex/config.toml` + `~/.codex/skills/<name>/` + `AGENTS.md` |
| **OpenCode** | ✅ | ✅ 复用 | 全局 `~/.config/opencode/opencode.json` + `.claude/skills/<name>/` |

> "paste-snippet" = 脚本打印片段到 stdout，你手动拷到客户端的全局配置；"AI 自动追加" = AI 助手在 INSTALL_FOR_AI 流程里做冲突检测后 append。这样做是为了避免误改用户的全局环境又不让用户自己复制。

### Crashlytics 的跨客户端环境

`setup` 会为 `crashlytics` 生成空的 project/app allowlist。请在目标客户端实际启动的
MCP 子进程配置中填写，而不是只在当前 shell 中 `export`：

- JSON 客户端（Claude Code、Cursor、Claude Desktop）：
  `mcpServers.crashlytics.env`。
- Codex TOML：`[mcp_servers.crashlytics]` 的 `env = { ... }`。
- OpenCode：全局配置中 `mcp.crashlytics.environment`。

`cloud_logging` 需要 `CRASHLYTICS_PROVIDER`、project/app allowlist 和 ADC；fixture 需要
同样的 allowlist 及绝对 `CRASHLYTICS_FIXTURE_PATH`，但**不需要 ADC**。GUI 客户端通常
不继承 shell 临时环境，编辑后必须完整重启。完整示例、安全边界与 doctor 环境来源见
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
# 重启 Claude Code，/mcp 应看到 6 个本仓 server + mobile
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
# Cursor → Settings → MCP，应看到 7 个 server（含 mobile）
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
  `setup` 会把所有本仓 server 的 `"node"` 和 mobile-mcp 的 `"npx"` 分别改写成
  `which node` / `which npx` 探测到的绝对路径。如果任一探测失败，stdout 会给出警告；
  按提示手动替换对应的裸命令后再合并配置。

---

## Codex CLI

**OpenAI Codex CLI**：MCP 配置在 `~/.codex/config.toml`（TOML 格式）；skill 有两种安装方式，脚本会同时帮你做：

1. **用户级**：复制完整 bundle 到 `~/.codex/skills/<name>/`（所有项目可见）
2. **项目级**：在仓库根写 `AGENTS.md`（其中 bundle 相对链接会改写到
   `skills/<name>/...`，不会从仓库根错误寻找 `references/`）

```bash
npm install
npm run build
npm run setup -- --client codex            # 打印 TOML 片段（AI 助手会自动追加，见 INSTALL_FOR_AI.md §4-C）
# 也可以重定向到文件后手动 append：npm run setup -- --client codex >> ~/.codex/config.toml

npm run install:skills -- --client codex   # 同时安装：
                                            #   ~/.codex/skills/{devtest,qa,minimize,smart-qa,crashfix}/ 完整 bundle
                                            #   ./AGENTS.md（含 5 个 skill 章节）
# 只更新项目聚合文件、不改用户目录：
npm run install:skills -- --client codex --project --force
codex                                      # 在仓库根目录跑 codex
```

> 当 AI 按 `docs/INSTALL_FOR_AI.md` 接力安装时，§4-C 流程会做 **冲突检测 + 自动追加** 到 `~/.codex/config.toml`，不需要用户手动复制。

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
version: 0.1.0
---

# 标题
... 用 MCP tool 名称（`ui.tap_element` / `log.start_capture` 等）和自然语言描述工作流 ...
```

任意 MCP-aware 客户端都可以：
1. 装好 MCP server（参考 `.mcp.json.example` schema，把 `${PROJECT_ROOT}` 换成绝对路径）
2. 把 `skills/<name>/SKILL.md` 的正文塞进客户端的 prompt-injection / rule 机制，并让
   `agents/references/scripts/assets` 中被引用的 supporting files 可按原相对路径读取
3. 用户对话时按 description 关键词触发

欢迎 PR 加新客户端到 `scripts/install-skills.mjs` 和 `scripts/setup-mcp.mjs`。
