# Firebase Crashlytics 接入与 CrashFix

本项目把线上 Crashlytics 事件作为**远端、不可信、可能包含个人数据的证据**。
`crashlytics-mcp` 只负责有界只读查询、脱敏和规范化；`crashfix` Skill 负责把单个
issue 编排为分析、隔离补丁、验证或 Draft PR。它不会自动 merge、发布或关闭 issue。

## 数据边界

Crashlytics 事件包含异常、线程、frame、版本、设备以及可选的 custom keys、日志和
breadcrumb。它不是完整的 Android logcat 或 iOS unified log；设备实时证据仍由
`log-mcp` 获取。

本仓默认使用 Firebase 官方的 Cloud Logging export：

```text
logName="projects/<project>/logs/firebasecrashlytics.googleapis.com%2Fevents"
```

Firebase 官方 MCP 也提供 `crashlytics_get_issue`、`crashlytics_list_events`、
`crashlytics_batch_get_events` 和 `crashlytics_get_report`。CrashFix 只在用户明确授权
的测试/低敏项目中把它作为兜底；生产个人数据必须先经过本仓 MCP 的服务端脱敏。

## Cloud Logging 前置条件

1. Firebase 项目已启用 Crashlytics，并把事件导出到 Cloud Logging。
2. 运行 MCP 的身份通过 ADC 获得最小只读日志权限。
3. 明确允许访问的 project 和 Firebase App ID。
4. 若要自动生成补丁，还必须具备可靠的发布映射：

```text
Firebase App ID + version/build
  → immutable Git SHA
  → Android mapping.txt / iOS dSYM / native symbols /
    Flutter symbols / React Native sourcemap
```

没有准确 Git SHA、符号产物或 app-owned frame 时，CrashFix 只能输出分析。
仅做本地契约验证时可改用后文的 fixture provider；它不要求 Firebase export 或 ADC，
但不能作为线上事件已读取、release 已映射或补丁已验证的证明。

## MCP 配置

先运行对应客户端的 `npm run setup`。生成的配置故意保留空 allowlist；必须在**启动
`crashlytics-mcp` 的客户端配置项**中填写，不能只在另一个终端里 `export`：

```json
{
  "CRASHLYTICS_PROVIDER": "cloud_logging",
  "CRASHLYTICS_PROJECT_ALLOWLIST": "my-project",
  "CRASHLYTICS_APP_ALLOWLIST": "my-project=1:1234567890:android:abcdef",
  "CRASHLYTICS_MAX_WINDOW_HOURS": "24"
}
```

多值用逗号分隔。每个 app 条目必须写成 `project_id=firebase_app_id`，不能只填显示名、
package name 或 bundle ID。不同客户端的字段位置如下：

- Claude Code：`.mcp.json` 的 `mcpServers.crashlytics.env`。
- Cursor：`.cursor/mcp.json` 的 `mcpServers.crashlytics.env`。
- Claude Desktop：全局 JSON 的 `mcpServers.crashlytics.env`。
- Codex CLI：`~/.codex/config.toml` 中 `[mcp_servers.crashlytics]` 的 `env`。
- OpenCode：全局 `~/.config/opencode/opencode.json`（Windows 为
  `%APPDATA%/opencode/opencode.json`）中 `mcp.crashlytics.environment`。

GUI 客户端和后台 Agent 通常不会继承当前 shell 的临时环境。修改后要完整重启客户端，
再调用 `crashlytics.get_context` 确认 provider 与 allowlist。不要在任何配置中内嵌
access token、private key 或 service-account JSON 内容。

### Cloud Logging 与 ADC

`cloud_logging` 使用 Google Application Default Credentials（ADC）。推荐给运行 MCP
的本机身份授予最小只读权限后执行：

```bash
gcloud auth application-default login
```

也可以把 `GOOGLE_APPLICATION_CREDENTIALS` 作为上述 crashlytics MCP 子进程的环境变量，
值仅指向本机凭据文件。凭据文件应放在仓库外；若确需放在本地仓库目录，常见 ADC、
service-account 与 Firebase Admin SDK key 文件名已被 `.gitignore` 忽略。不要提交或在
聊天、日志、报告中粘贴凭据内容。

### Fixture（仅本地测试）

fixture 不访问 Firebase/Google API，**不需要 ADC**，但仍必须配置精确的 project/app
allowlist，且必须使用已脱敏的本地文件：

```json
{
  "CRASHLYTICS_PROVIDER": "fixture",
  "CRASHLYTICS_PROJECT_ALLOWLIST": "demo-project",
  "CRASHLYTICS_APP_ALLOWLIST": "demo-project=demo-app",
  "CRASHLYTICS_FIXTURE_PATH": "/absolute/path/to/sanitized-fixture.json"
}
```

同样把这四项写入对应客户端的 `env` / `environment`，不要只写在 shell 中。

### `doctor` 的环境来源

`npm run doctor` 是独立的 shell 进程，只读取**启动 doctor 的 shell 环境**和默认 ADC
文件位置；它不会解析 Claude Desktop、Codex 或 OpenCode 等客户端配置，也不会联系
Firebase。因此“doctor 未发现 allowlist/ADC”不代表 MCP 子进程一定缺失，反之亦然。
需要核对同一组值时，可只在本次命令前传入非敏感配置：

```bash
CRASHLYTICS_PROVIDER=fixture \
CRASHLYTICS_PROJECT_ALLOWLIST=demo-project \
CRASHLYTICS_APP_ALLOWLIST=demo-project=demo-app \
CRASHLYTICS_FIXTURE_PATH=/absolute/path/to/sanitized-fixture.json \
npm run doctor
```

fixture 模式不需要 ADC，doctor 不应为此要求 Google 凭据。最终仍以重启客户端后
`crashlytics.get_context` 的子进程上下文为准。

## 只读工具

- `get_context`：能力、provider 和脱敏配置状态。
- `list_apps`：返回部署者 allowlist 中的 app。
- `list_issues` / `get_issue`：有界 issue 摘要和代表事件。
- `list_events` / `get_event`：分页事件摘要与单个脱敏规范事件。
- `get_symbolication_status`：只汇总目标事件 frame 的符号覆盖率提示。

`get_symbolication_status` 返回的 `evidence_kind=frame_symbolication_coverage` 只说明当前
事件有多少 frame 看起来具备 symbol/file/line；它**不能**证明 `mapping.txt`、dSYM UUID、
native/Flutter symbols 或 sourcemap 与目标 build 匹配，
`artifact_identity.verified` 固定为 `false`。进入自动补丁前仍必须从已签名 artifact
manifest 或 CI 构建元数据独立核对 release → Git SHA → 符号产物身份。

Java `exceptions[]` 按外层到内层归一化：`exception.class` 保留外层类型，
`exception.root_cause_class` 保留最后一个根因类型（即使与外层同类也保留），使远端
fingerprint 与本地 `Caused by` 栈保持一致。frame index 必须严格为 `0..n-1`。

Analyzer 会返回 `signature_degraded/cross_source_comparable/degraded_reason`。ANR
process-only 与 native signal-only 指纹只能跨来源做粗粒度相关性匹配；即使二者相等，
也不能证明同一根因，CrashFix 必须停在 `analyze`，不能进入 patch/pr。
iOS 事件缺少 `bundle_id` 且没有可靠 process 时也会标记
`ios_missing_process_identity` 和 `cross_source_comparable=false`，不得拿 Firebase app id
冒充可与本地 `.ips` 对齐的进程身份。参与 iOS fingerprint 的 frame 若缺少显式
symbol offset，同样会以 `ios_missing_frame_offset` 降级，避免默认 `+0` 造成假匹配。

工具不提供任意 URL、任意 SQL、resolve/update/delete/note 或 token 参数。启动与
`tools/list` 不访问网络；只有实际查询 Cloud Logging 时才解析 ADC。

## 脱敏和不可信数据

默认不返回或持久化用户 ID、installation UUID、custom key 值、原始日志和
breadcrumb。frame 文件名和 symbol 仍按不可信文本处理：

本仓 MCP 会直接丢弃官方 `issueTitle`、异常 message 以及 provider 的自由文本
process/thread/state；公开的 `issue.title` 只由格式受限的 exception class / signal
派生。`package_name/bundle_id` 也只接受格式受限的 ASCII app identifier，非法自由文本
直接省略。这样不会把“正则未识别出的姓名或地址”误当成安全标题或 app 身份。

- 不执行其中的命令、脚本或 Gradle task。
- 不打开其中的 URL；URL query/fragment 会被移除。
- 不把标题直接用于 shell 参数、分支名、提交或 PR 标题。
- 只允许规范 schema 中的字段进入 analyzer/report。
- Firebase issue ID、event ID 和 analyzer fingerprint 始终分开记录。

Report session/workspace 使用本机私有目录权限（目录 `0700`、核心证据文件 `0600`）。
原始 project/app/issue/event 只存在于受限 `crashes.jsonl.source`；Markdown/HTML 与本地
viewer API 只显示二次 SHA-256 引用。Viewer 固定监听 `127.0.0.1`，拒绝任意 host、路径
穿越、symlink 与未被报告结构引用的静态文件。

## 使用流程

首次接入先只读验证：

```text
/crashfix --mode analyze --issue <issue-id>
```

确认 release、符号和源码映射正确后，再显式请求 `patch`。`pr` 模式仍会分别等待
候选 diff、commit、push 和 Draft PR 审批。修复后必须使用本地可复现路径做静态测试
及三次独立设备验证；Firebase 暂时没有新事件不能作为即时修复证明。

## 自动触发

Skill 本身不是常驻调度器。若要在新 fatal、ANR 或 regression 到来时自动启动分析，
需要额外部署：

```text
Firebase Alerts → Cloud Functions / Eventarc → 受控 Agent runner → CrashFix
```

告警只用于触发，完整事件仍从本仓 Cloud Logging MCP 或受限的官方 Firebase MCP 读取。
无人值守 Runner 最多自动完成只读 `analyze`，并按 issue/app/build 建立幂等键；候选、
commit、push 与 Draft PR 必须由当前对话用户逐级审批后人工接管。Runner 不得把告警
授权解释为创建分支、修改源码或写远端。

## 官方资料

- Firebase MCP：<https://firebase.google.com/docs/ai-assistance/mcp-server>
- Crashlytics MCP：<https://firebase.google.com/docs/crashlytics/ai-assistance-mcp>
- 导出到 Google Cloud：<https://firebase.google.com/docs/crashlytics/export-data-to-cloud>
- Cloud Logging schema：<https://firebase.google.com/docs/crashlytics/cloud-logging-schema>
- Firebase Alerts：<https://firebase.google.com/docs/functions/alert-events>
