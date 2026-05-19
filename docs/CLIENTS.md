# 支持的 AI 客户端

`app-test-ctrl` 的 5 个 MCP server 和 4 个 Skill 与具体客户端解耦：
- **MCP 协议**通用，差异只在配置文件位置 / 格式（JSON vs TOML）
- **Skill 内容**用 MCP tool 名称 + 中立自然语言写成，~95% 跨客户端可移植

下表覆盖首批支持的 4 个客户端：

## 客户端支持矩阵

| 客户端 | MCP 自动写文件 | Skill 自动安装 | 文件位置 |
|---|:-:|:-:|---|
| **Claude Code** | ✅ | ✅ | `.mcp.json` + `.claude/skills/<name>/SKILL.md` |
| **Cursor** | ✅ | ✅ | `.cursor/mcp.json` + `.cursor/rules/<name>.mdc` |
| **Claude Desktop** | ❌ paste-snippet | ❌ 手动 | global JSON file |
| **Codex CLI** | ❌ paste-snippet | ✅ AGENTS.md | `~/.codex/config.toml` + `AGENTS.md` |

> "paste-snippet" = 脚本打印片段到 stdout，你手动拷到客户端的全局配置。这样做是为了避免误改你的全局环境。

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

---

## Codex CLI

**OpenAI Codex CLI**：MCP 配置在 `~/.codex/config.toml`（TOML 格式），skill 用项目根的 `AGENTS.md`。

```bash
npm install
npm run build
npm run setup -- --client codex            # 打印 TOML 片段
# 把 [mcp_servers.*] 节追加到 ~/.codex/config.toml

npm run install:skills -- --client codex   # 在项目根生成 AGENTS.md（含 4 个 skill）
codex                                      # 在仓库根目录跑 codex
```

**已知限制**：
- `AGENTS.md` 是 Codex 的项目级 prompt 注入文件；4 个 skill 全部聚合在一个文件里（用 `## <name>` 标题分节）。Codex 会按用户意图自己挑用哪节。
- TOML 不支持 JSON 那种内嵌结构，所以 `env` 是 `{ KEY = "val" }` 单行写法。

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
