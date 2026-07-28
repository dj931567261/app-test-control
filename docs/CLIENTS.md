# 支持的 AI 客户端

`app-test-ctrl` 的 5 个 MCP server 和 4 个 Skill 与具体客户端解耦：
- **MCP 协议**通用，差异只在配置文件位置 / 格式（JSON vs TOML）
- **Skill 内容**用 MCP tool 名称 + 中立自然语言写成，~95% 跨客户端可移植

下表覆盖首批支持的 5 个客户端：

## 客户端支持矩阵

| 客户端 | MCP 自动写文件 | Skill 自动安装 | 文件位置 |
|---|:-:|:-:|---|
| **Claude Code** | ✅ | ✅ | `.mcp.json` + `.claude/skills/<name>/SKILL.md` |
| **Cursor** | ✅ | ✅ | `.cursor/mcp.json` + `.cursor/rules/<name>.mdc` |
| **Claude Desktop** | ❌ paste-snippet | ❌ 手动 | global JSON file |
| **Codex CLI** | ✅ AI 自动追加 | ✅ 双安装 | `~/.codex/config.toml` + `~/.codex/skills/<name>/SKILL.md` + `AGENTS.md` |
| **opencode** | ✅ | ✅ 复用 | `opencode.json` + `.claude/skills/<name>/SKILL.md`（natively 兼容）|

> "paste-snippet" = 脚本打印片段到 stdout，你手动拷到客户端的全局配置；"AI 自动追加" = AI 助手在 INSTALL_FOR_AI 流程里做冲突检测后 append。这样做是为了避免误改用户的全局环境又不让用户自己复制。

---

## Claude Code

**官方 IDE / CLI**：项目级 `.mcp.json` + `.claude/skills/`。

```bash
npm install
npm run build
npm run setup                  # 写 .mcp.json
npm run install:skills         # 写 .claude/skills/（已被 git 跟踪，clone 后开箱即用，此命令是 force-sync 用）
npm run doctor
# 重启 Claude Code，/mcp 应看到 5 个本仓 server
```

**触发 skill**：直接说 "测一下我刚改的" / "/devtest"，或 "找一下 bug" / "/smart-qa"，Claude Code 会按 `description` 字段匹配。

---

## Cursor

**Cursor IDE**：项目级 `.cursor/mcp.json` + `.cursor/rules/*.mdc`。schema 和 Claude Code 一致；rules 是 Cursor 的"提示词注入"机制。

```bash
npm install
npm run build
npm run setup -- --client cursor          # 写 .cursor/mcp.json
npm run install:skills -- --client cursor # 写 .cursor/rules/*.mdc
# Cursor → Settings → MCP，应看到 5 个 server
# Cursor → Settings → Rules，应看到 4 个 rule (devtest/qa/minimize/smart-qa)
```

**触发 skill**：在 Cursor 的 Composer/Chat 里说 "/devtest" 或自然语言，Cursor 会按 rule 的 description 匹配并自动注入。

**已知限制**：
- Cursor rule 的 frontmatter schema 和 Claude Code 不同。我们的转换只映射 `description`，没把 `argument-hint` 带过去（Cursor 没这概念）。
- `globs: ['**/*']` 表示 rule 对所有文件触发；后续可按需收窄。

---

## Claude Desktop

**Anthropic 桌面 App**：没有"项目"或"项目级 skill"概念。MCP 配置是 global，skill 必须粘进 Projects 的 Custom Instructions。

```bash
npm install
npm run build
npm run setup -- --client claude-desktop   # 打印 JSON 片段
# 把片段 merge 到:
#   macOS:   ~/Library/Application Support/Claude/claude_desktop_config.json
#   Windows: %APPDATA%/Claude/claude_desktop_config.json
#   Linux:   ~/.config/Claude/claude_desktop_config.json
# 重启 Claude Desktop

npm run install:skills -- --client claude-desktop  # 打印 skill 文件路径
# 在 Claude Desktop 里建一个 Project，把 skills/<name>/SKILL.md 的内容粘进 Custom Instructions
```

**已知限制**：
- Skill 没法切换，只能放一个进 Custom Instructions（多个会冲突上下文）。建议每个项目挑 1-2 个最常用的（一般是 smart-qa + devtest）。
- 重启 Claude Desktop 才能识别新 MCP server。
- **PATH 兜底**：Claude Desktop 是 GUI app，spawn 子进程时**不继承 shell PATH**。`setup` 脚本会自动把 mobile-mcp 配置里的 `"npx"` 改写成 `which npx` 探测到的绝对路径（例如 `/Users/xxx/.nvm/.../bin/npx` 或 `/opt/homebrew/bin/npx`）。如果脚本探测失败，stdout 会给警告并提示你手动跑 `which npx` 替换。

---

## Codex CLI

**OpenAI Codex CLI**：MCP 配置在 `~/.codex/config.toml`（TOML 格式）；skill 有两种安装方式，脚本会同时帮你做：

1. **用户级**：复制到 `~/.codex/skills/<name>/SKILL.md`（所有项目可见，跟 Claude Code 的全局 skill 等价）
2. **项目级**：在仓库根写 `AGENTS.md`（Codex 进入此目录时自动读，聚合所有 skill 成一个 prompt 注入文件）

```bash
npm install
npm run build
npm run setup -- --client codex            # 打印 TOML 片段（AI 助手会自动追加，见 INSTALL_FOR_AI.md §4-C）
# 也可以重定向到文件后手动 append：npm run setup -- --client codex >> ~/.codex/config.toml

npm run install:skills -- --client codex   # 同时安装：
                                            #   ~/.codex/skills/{devtest,qa,minimize,smart-qa}/SKILL.md
                                            #   ./AGENTS.md（含 4 个 skill 章节）
# 只更新项目聚合文件、不改用户目录：
npm run install:skills -- --client codex --project --force
codex                                      # 在仓库根目录跑 codex
```

> 当 AI 按 `docs/INSTALL_FOR_AI.md` 接力安装时，§4-C 流程会做 **冲突检测 + 自动追加** 到 `~/.codex/config.toml`，不需要用户手动复制。

**已知限制**：
- 用户级 `~/.codex/skills/` 用 `--force` 才覆盖已存在的旧版本（避免误伤手动修改）
- `AGENTS.md` 同样需要 `--force` 才覆盖
- Codex 可用互斥的 `--global` / `--project` 只安装对应 scope；不传时保持同时安装，
  其他 client 传 scope 参数会直接报错，不会静默写错位置
- 安装器拒绝覆盖符号链接、硬链接及越界目录；`--force` 也不会绕过这些检查
- TOML 不支持 JSON 那种内嵌结构，所以 `env` 是 `{ KEY = "val" }` 单行写法

---

## opencode

**[opencode](https://opencode.ai/)**：SST 团队的开源终端 AI agent。MCP 配置在项目根的 `opencode.json`（opencode 启动时从 `cwd` 向上查找直到 git 根）；skill 直接复用 `.claude/skills/`（opencode 文档明确说 "Claude 兼容"，会读 `.claude/skills/`、`.opencode/skills/`、`~/.config/opencode/skills/`、`.agents/skills/`）。

```bash
npm install
npm run build
npm run setup -- --client opencode            # 写 opencode.json
npm run install:skills -- --client opencode   # 验证 .claude/skills/ 在位（natively 兼容）
opencode                                      # 在仓库根目录跑 opencode
```

**触发 skill**：自然语言（"帮我测一下" / "找 bug"），opencode 按 SKILL.md 的 `description` 字段匹配。

**已知限制**：
- opencode 的 MCP schema 跟 Claude Code/Cursor 略有差异：`command` 字段是 `[bin, ...args]` 单数组（不是分开的 command + args），`env` 字段名叫 `environment`。`setup` 脚本帮你转好。
- opencode 文档要求 "技能名在所有搜索路径中保持唯一"，所以本仓**不**写 `.opencode/skills/`，避免和 `.claude/skills/` 同名冲突 —— 直接复用一份就够。
- 如果你的项目根没有 `.claude/skills/`（其它客户端用户克隆时可能漏掉），先跑一次 `npm run install:skills`（默认 claude-code 分支）把它生成出来。

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
2. 把 `skills/<name>/SKILL.md` 的正文塞进客户端的 prompt-injection / rule 机制
3. 用户对话时按 description 关键词触发

欢迎 PR 加新客户端到 `scripts/install-skills.mjs` 和 `scripts/setup-mcp.mjs`。
