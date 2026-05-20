# 给 AI 看的安装指引

> **怎么用**：把这份文档**整段**粘进你的 AI 聊天框（Claude Code / Cursor / Codex CLI / Claude Desktop 任一），然后说"按这个 INSTALL 指引帮我装好 app-test-ctrl"。AI 会按下面的章节接力完成。
>
> 用户也可以自己读着照做——每一步都给了可直接执行的命令。

---

## AI 角色与目标

你是用户的编码助手。本任务是帮用户在他的开发机上把 `app-test-ctrl`（一个跨客户端 MCP-native 移动 App 测试平台）装好并跑通最小冒烟。

**完成标准**：
1. 5 个本仓 MCP server 在用户的 AI 客户端里都 `connected`
2. 4 个 Skill（devtest / qa / minimize / smart-qa）在用户的客户端里可被触发
3. `npm run doctor` 输出 0 fail（warning 关于设备未连可忽略）

**全程原则**：
- 每一步先告诉用户"现在要做 X"，再跑命令
- 命令失败时**不要硬来**——把错误念给用户看，问怎么办（比如缺 `adb` 就让他装 Android Platform Tools，不要 brew install 不询问就跑）
- 修改用户全局配置时分两种处理：
  - **Codex `~/.codex/config.toml`**：你**可以**自己用 `cat >>` 追加新节（详见 §4-C），但**必须先做冲突检测**——已存在的同名 `[mcp_servers.xxx]` 节不要覆盖，发现冲突就停下来问用户
  - **Claude Desktop `claude_desktop_config.json`**：JSON 合并风险大，**只打印片段让用户自己粘贴**，绝不 sed/cat 改全局文件
- 用户已有的 `~/.codex/skills/` 下面的其他 skill 不要动；本仓只装 4 个独立子目录（devtest/qa/minimize/smart-qa）

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
npm install        # 装 workspaces，会带上 5 个 mcp-servers 子包
npm run build      # tsc 编译 5 个 server 到 dist/
```

预期产物：

```
mcp-servers/log-mcp/dist/index.js
mcp-servers/report-mcp/dist/index.js
mcp-servers/ui-mcp/dist/index.js
mcp-servers/analyzer-mcp/dist/index.js
mcp-servers/code-analyzer-mcp/dist/index.js
```

5 个 `dist/index.js` 缺任何一个 → build 失败，把 `npm run build` 的完整输出念给用户。

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
> 重启 Claude Code（或 `/exit` 后重进），在新会话输 `/mcp`，应看到 6 个 server（mobile / log / report / ui / analyzer / code-analyzer）全部 `connected`。

### §4-B · Cursor

```bash
npm run setup -- --client cursor          # 写 .cursor/mcp.json
npm run install:skills -- --client cursor # 写 .cursor/rules/{devtest,qa,minimize,smart-qa}.mdc
```

完成后告诉用户：
> Cursor → Settings → MCP，应看到 6 个 server；Cursor → Settings → Rules，应看到 4 个 rule。

### §4-C · Codex CLI

**a) MCP 配置（AI 自动追加到 `~/.codex/config.toml`，不要让用户手动粘）**：

第一步，跑 setup 拿到 TOML 片段：

```bash
npm run setup -- --client codex > /tmp/codex-mcp-snippet.txt
```

第二步，**冲突检测**——读 `~/.codex/config.toml`（如果存在），看是否已有这 6 节中的任一：

```bash
mkdir -p ~/.codex
touch ~/.codex/config.toml
grep -E '^\[mcp_servers\.(log|report|ui|analyzer|code-analyzer|mobile)\]' ~/.codex/config.toml || echo "no-conflict"
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
- 复制到 `~/.codex/skills/{devtest,qa,minimize,smart-qa}/SKILL.md`（用户级，所有项目可见）
- 写仓库根的 `AGENTS.md`（项目级 prompt 注入）

如果用户的 `~/.codex/skills/` 已有同名 skill → 脚本默认 skip，把那行 `skipped` 念给用户问要不要 `--force` 覆盖。

### §4-D · Claude Desktop

Claude Desktop 没有项目级 skill 概念，只能手动粘到 Custom Instructions。

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

**PATH 兜底**：脚本会自动用 `which npx` 把 mobile-mcp 的 `command` 改写成绝对路径（Desktop GUI 不读 shell PATH）。如果 stdout 出现 `WARNING: couldn't resolve absolute npx path`，让用户手动跑 `which npx` 把输出粘进 mobile.command。

**b) Skill 安装（手动）**：

```bash
npm run install:skills -- --client claude-desktop
```

输出 4 个 skill 文件路径。Claude Desktop 一次只能放一个 skill 进 Custom Instructions，让用户挑 1-2 个最常用的（通常是 `smart-qa` + `devtest`），把那个 SKILL.md 全文粘到 Project 的 Custom Instructions。

**c)** 重启 Claude Desktop。

### §4-E · opencode

[opencode](https://opencode.ai/) 是 SST 团队的开源终端 AI agent。MCP 配置写到项目根的 `opencode.json`（opencode 启动时从 cwd 向上查找直到 git 根）；skill 直接复用 `.claude/skills/`（opencode 文档明确说 "Claude 兼容"，会读 `.claude/skills/` 等 4 个搜索路径）。

整个流程都不需要用户手动复制——脚本直接写文件。

**a) MCP 配置**：

```bash
npm run setup -- --client opencode
```

预期输出：`[setup-mcp] wrote /path/to/opencode.json`。如果 `opencode.json` 已存在，会拒写并提示加 `--force` 才能覆盖——这时让用户决定。

**b) Skill 安装（验证 + 提示，不写新文件）**：

```bash
npm run install:skills -- --client opencode
```

opencode 会 natively 读 `.claude/skills/<name>/SKILL.md`，本仓 clone 后这个目录已经在位（被 git 跟踪）。脚本只做检测：
- 4 个 SKILL.md 都在 → 输出 `Already in place: ...` 列表
- 缺任何一个 → 让用户先跑 `npm run install:skills`（默认 claude-code 分支）从 `skills/` 源生成

为什么不写 `.opencode/skills/`？opencode 文档要求"技能名在所有搜索路径中保持唯一"，写到 `.opencode/skills/` 会和 `.claude/skills/` 同名冲突。

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

这会自动将 4 个 Skill 文件复制到 `~/.gemini/config/skills/<name>/SKILL.md`，它们会被 Antigravity 自主读取作为 Agent 的专业自测与探索技能。

**c) 重启客户端**：

完成后告诉用户：
> 已配置完毕。请重启 Antigravity 的 AI 客户端会话，在聊天中发送 `/mcp` 或直接询问 `测一下我刚改的` / `找一下 bug`，客户端即可自动连上所有 MCP 服务并激活自测/探索能力！

### §4-F · 其它 MCP-aware 客户端

跟用户确认他客户端的 MCP 配置文件位置 + skill / system-prompt 注入机制。然后：

1. 跑 `cat .mcp.json.example` 拿 MCP 配置模板，把 `${PROJECT_ROOT}` 全替换成 clone 的绝对路径，按客户端要求的格式（JSON / TOML / YAML）改写
2. 跑 `ls skills/` 拿到 4 个 skill 名；每个 skill 的源在 `skills/<name>/SKILL.md`，正文是中立的 MCP tool 调用，可直接复用
3. 引用 `docs/CLIENTS.md` 看已支持客户端的实现细节作为参考

---

## 步骤 5：自检

```bash
npm run doctor
```

预期输出至少这几个 ✓：
- `Node ≥ 20` / `npm ≥ 10`
- 5 个 `mcp-servers/*/dist/index.js`
- `.mcp.json present`（Claude Code 分支）或对应客户端的配置文件
- `Skills (source): devtest, minimize, qa, smart-qa`

**warning 可以忽略的**：
- `No Android devices ready`（没插手机/没起模拟器，跑测试时再说）
- `No iOS simulators booted`（同上）
- `.claude/skills/ outdated`（只是说源更新了——跑 `npm run install:skills -- --force` 同步即可，但不是阻断项）

**fail 必须处理**：
- `dist/index.js missing` → 重跑 `npm run build`
- `node_modules missing` → 重跑 `npm install`

---

## 步骤 6：跑通最小冒烟（可选但推荐）

如果用户接入的是 Claude Code / Cursor / Antigravity，重启客户端后让他在新会话里说一句：

> 起 session，列一下当前设备

预期 AI 会调 `report.start_session` + `mobile.mobile_list_available_devices`，并返回 session 路径 + 设备列表。这就证明 MCP 接通了。

更完整的端到端冒烟（启 app + 抓 log + 出报告）见 `docs/SETUP.md §4`。

---

## 故障排查

| 现象 | 处理 |
|---|---|
| `/mcp` 显示 `log/report/...` failed | 看客户端日志；通常是 `dist/index.js` 路径不对（`.mcp.json` 里的绝对路径错了）→ `npm run setup --force` 重写 |
| `npm install` 卡在 `mobile-mcp` | 那是 npx 自动拉的上游包，看用户网络；可以让他先 `npm install -g @mobilenext/mobile-mcp` 预热 |
| Codex 找不到 skill | 确认 `~/.codex/skills/<name>/SKILL.md` 存在；如果只装了 `AGENTS.md`，要在仓库根目录启动 codex 才生效 |
| Cursor rule 不触发 | Cursor → Settings → Rules，看 4 个 rule 是不是 enabled |
| Claude Desktop `/mcp` 还是旧的 | Claude Desktop 必须完全退出（菜单栏 Quit，不是关窗口）才能重读 config |
| opencode 没识别 MCP | 确认 `opencode.json` 在仓库根；opencode 是从 cwd 向上找直到 git 根，所以必须在仓库内跑 `opencode` |
| opencode 没识别 skill | 确认 `.claude/skills/<name>/SKILL.md` 存在；缺就跑 `npm run install:skills` 生成 |
| Antigravity 找不到 MCP 或 Skill | 确保写在 `~/.gemini/config/mcp_config.json`；若运行环境为 GUI/LSP 守护进程没有继承 Shell 环境变量，运行 `npm run setup -- --client antigravity` 会自动检测并填入 Node/Npx 绝对路径与完整的 PATH 环境变量 |

---

## 完成检查清单（AI 跑完一定要确认）

- [ ] 用户的 AI 客户端已识别（§1）
- [ ] 仓库 clone 到用户指定的绝对路径（§2）
- [ ] `npm run build` 5 个 dist 产物齐全（§3）
- [ ] `npm run prewarm` 跑过（§3.5，失败也行，告知用户即可）
- [ ] 当前客户端的 MCP 配置已注册（§4-A/B/C/D/E/F/G）
- [ ] 当前客户端的 Skill 已就位（§4-A/B/C/D/E/F/G）
- [ ] `npm run doctor` 0 fail（§5）
- [ ] 把"重启客户端"和"`/mcp` 检查"念给用户了

跑完最后说一句给用户：
> 装好了。重启 <客户端名> 后，可以试着说"测一下我刚改的功能"（触发 devtest）或"找一下 bug"（触发 smart-qa）。完整文档见 `docs/SETUP.md` 和 `docs/CLIENTS.md`。
