# 安装与接入指南

完整的端到端流程：装 → 接入 AI 客户端 → 跑通一次冒烟。

> 本文以 Claude Code 为例（默认客户端）。Cursor / Claude Desktop / Codex CLI 等其它客户端的差异见 [CLIENTS.md](./CLIENTS.md)。

## 1. 前置依赖

| 工具 | 版本 | 检查命令 |
|---|---|---|
| Node.js | ≥ 20 | `node -v` |
| npm | ≥ 10 | `npm -v` |
| adb | 任意（建议 ≥ 33） | `adb --version` |
| Android 设备 / 模拟器 | API 21+ | `adb devices` |
| **（iOS 可选）** Xcode 命令行 | 任意 | `xcrun --version` |
| **（iOS 可选）** iOS Simulator 已 boot | 任意运行时 | `xcrun simctl list devices booted` |
| AI 客户端 | 任一 MCP-aware（Claude Code / Cursor / Claude Desktop / Codex CLI） | — |
| **（CrashFix/Cloud Logging 可选）** Google ADC + Crashlytics Cloud Logging export | 当前 Google Cloud 支持版本 | `gcloud auth application-default login` |

## 2. 安装本仓

```bash
cd /Users/mac/mcp/app_test_ctrl
npm install
npm run build
npm run prewarm        # 预拉 @mobilenext/mobile-mcp 到 npx 本地缓存（首次启动 MCP client 不卡）
```

应能看到 `mcp-servers/log-mcp/dist/index.js` 和 `mcp-servers/report-mcp/dist/index.js` 两个产物。

## 3. 接入 AI 客户端

**Claude Code（默认）**：

```bash
npm run setup                    # 在仓库根生成 .mcp.json，自动展开 ${PROJECT_ROOT}
```

里面声明了 7 个 MCP server：

- `mobile` — 上游 `@mobilenext/mobile-mcp`，npx 自动拉取
- `log` / `report` / `ui` / `analyzer` / `code-analyzer` / `crashlytics` — 本仓 6 个自研 server

启动 Claude Code 后，在会话里输入 `/mcp` 应能看到 7 个 server 全部为 `connected` 状态。

**其它客户端**（Cursor / Claude Desktop / Codex CLI）：见 [CLIENTS.md](./CLIENTS.md) 各自的安装命令与限制。共同点：

```bash
npm run setup -- --client <name>          # 生成 / 打印该客户端的 MCP 配置
npm run install:skills -- --client <name> # 安装 5 个完整 skill bundle 到对应位置
```

Skill bundle 包含 `SKILL.md` 及其 `agents/references/scripts/assets`。默认模式遇到同名
目标会整项跳过；需要升级时使用 `--force` 精确同步（会清理同名受管目录中的旧/未知
文件）。Claude Desktop 是例外：命令只打印完整手动导入清单，不会自动安装。

## 4. 冒烟测试（手动跑一次）

下面这套指令完整走一遍"操作 → 抓 log → 出报告"。

```text
1. 调用 mobile.mobile_list_available_devices  → 选出 device_id
2. 调用 report.start_session(name="smoke")
   → 拿到 session_dir
3. 调用 log.clear_logs(device=device_id)
4. 调用 mobile.mobile_launch_app(
     device=device_id, packageName="com.android.settings"
   )
5. 调用 mobile.mobile_save_screenshot(
     device=device_id, saveTo="/tmp/app-test-ctrl-smoke.png"
   )
6. 调用 log.get_recent_crashes(device=device_id)  → 期望返回 count=0
7. 调用 report.record_step(
     session_id=...,
     action="launch settings",
     result="ok",
     screenshot_src=<上一步保存的路径>
   )
8. 调用 report.finalize(session_id=..., status="passed", summary="smoke ok")
   → 拿到 report.md 路径
```

最后用编辑器打开 `report.md`，应能看到截图嵌入 + 步骤记录。

## 5. 故意触发崩溃的验证（可选）

如果你有一个会崩溃的 demo app，把第 4 步换成启动那个 app 并执行触发动作，
第 6 步会返回结构化 crash 记录。这时多一步：

```text
8.5. 调用 report.record_crash(
       session_id=...,
       signature=<crash 中的 signature>,
       stack=<crash 中的 stack>,
       kind=<crash 中的 kind>,
       step_index=<上一步的 index>,
       repro_path=[1, 2, 3]
     )
9. finalize 时 status="failed"
```

## 6. 路径与环境变量

| 变量 | 默认 | 作用 |
|---|---|---|
| `ADB_BIN` | `adb` | adb 可执行文件路径 |
| `APP_TEST_CTRL_WORKSPACE` | `<cwd>/workspace/sessions` | sessions 根目录 |
| `CRASHLYTICS_PROVIDER` | `cloud_logging` | `cloud_logging` 或仅测试用的 `fixture` |
| `CRASHLYTICS_PROJECT_ALLOWLIST` | 无 | 允许访问的 Firebase/GCP project ID，逗号分隔 |
| `CRASHLYTICS_APP_ALLOWLIST` | 无 | `project_id=firebase_app_id`，逗号分隔 |
| `CRASHLYTICS_MAX_WINDOW_HOURS` | `24` | 单次 Crashlytics 查询允许的最大时间窗 |
| `GOOGLE_APPLICATION_CREDENTIALS` | ADC 默认解析 | 可选凭据文件路径；不要提交凭据文件 |
| `CRASHLYTICS_FIXTURE_PATH` | 无 | fixture 模式必填的已脱敏 fixture 绝对路径 |

如果你想把 sessions 放到 git 不管的位置，可在 `.mcp.json` 的 report-mcp 段
覆盖 `APP_TEST_CTRL_WORKSPACE`。

## 6.5 iOS 流程（Simulator + 真机）

Simulator 前置：

```bash
xcrun --version                       # 确认 Xcode 工具链
xcrun simctl list devices booted      # 至少有一台在 Booted 状态；没有的话：
xcrun simctl boot <udid>              # 启动一台
open -a Simulator                     # 或者直接打开 Simulator.app
```

iOS 上 devtest/qa skill 自动走平台分支（见 SKILL.md "平台分支"小节）。
关键差异：
- 元素查询用 `mobile.mobile_list_elements_on_screen`（没装 idb → ui-mcp 在 iOS 上不工作）
- Simulator crash 用 `log.ios_list_ips` + `analyzer.parse_ips_file`；注意
  `ios_list_ips.files[]` 是 summary 对象，实际路径取 `.path`
- 真机 crash 用 `log.ios_pull_device_crashes` 从设备拉取
- Simulator log stream 用 `log.ios_start_capture`；真机用
  `log.ios_device_start_capture`。只有准确解析出 proc name 时才传进程过滤

`.ips` 默认从 `~/Library/Logs/DiagnosticReports/` 读取（系统级 + Simulator 应用崩溃都落这）。
真机还需要 WDA、go-ios 与 libimobiledevice，且 `.ips` 不会自动落到 Mac；完整
安装、端口转发和排障流程见 [`IOS.md`](./IOS.md)。

## 6.6 CrashFix / Firebase Crashlytics（可选）

1. 在 Firebase 中把 Crashlytics 原始事件导出到 Cloud Logging。
2. 为运行 MCP 的身份授予最小只读日志权限，并配置 ADC；不要把 access token 或
   service-account JSON 写入 `.mcp.json`、仓库、报告或命令参数。
3. 在实际客户端的 crashlytics MCP 子进程环境中填写精确 allowlist。Claude Code 使用
   `.mcp.json` 的 `mcpServers.crashlytics.env`；其他客户端的字段位置见
   [`CRASHLYTICS.md`](./CRASHLYTICS.md)：

```json
{
  "CRASHLYTICS_PROVIDER": "cloud_logging",
  "CRASHLYTICS_PROJECT_ALLOWLIST": "my-firebase-project",
  "CRASHLYTICS_APP_ALLOWLIST": "my-firebase-project=1:1234567890:android:abcdef"
}
```

然后重启 MCP 客户端，先调用 `crashlytics.get_context`，再用
`/crashfix --mode analyze` 对单个测试 issue 做只读验证。默认不会返回用户 ID、
custom key、breadcrumb 或原始 Crashlytics 日志，也不会修改/关闭线上 issue。

本地契约测试可把 provider 改成 `fixture`，并配置已脱敏文件的绝对路径；fixture 仍需
project/app allowlist，但不需要 ADC，也不会访问网络。`npm run doctor` 只读取启动它的
shell 环境，不会读取各客户端 MCP 子进程配置；跨客户端配置、doctor 校验方式及符号
产物身份限制详见 [`CRASHLYTICS.md`](./CRASHLYTICS.md)。

## 7. 故障排查

| 现象 | 排查 |
|---|---|
| `/mcp` 显示 log/report/ui/analyzer/code-analyzer 是 failed | 看客户端日志；通常是 `dist/index.js` 路径错或未 build；跑 `npm run doctor` 复核 |
| 别的客户端不识别 server | 确认走了 `--client <name>` 分支生成了正确的配置文件（见 [CLIENTS.md](./CLIENTS.md)） |
| `adb devices` 列表为空 | 模拟器没起 / USB 调试没开 / `adb kill-server && adb start-server` |
| `get_recent_crashes` 总是 0 | logcat 缓冲被清得太早；改用 `start_capture` 持续抓 |
| `pull_anr_traces` 报权限 | 已用 `bugreport` 兜底，无需 root；耗时 1-3 分钟正常 |
