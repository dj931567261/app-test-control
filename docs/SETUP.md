# 安装与接入指南

完整的端到端流程：装 → 接 Claude Code → 跑通一次冒烟。

## 1. 前置依赖

| 工具 | 版本 | 检查命令 |
|---|---|---|
| Node.js | ≥ 20 | `node -v` |
| npm | ≥ 10 | `npm -v` |
| adb | 任意（建议 ≥ 33） | `adb --version` |
| Android 设备 / 模拟器 | API 21+ | `adb devices` |
| **（iOS 可选）** Xcode 命令行 | 任意 | `xcrun --version` |
| **（iOS 可选）** iOS Simulator 已 boot | 任意运行时 | `xcrun simctl list devices booted` |
| Claude Code | 最新 | — |

## 2. 安装本仓

```bash
cd /Users/mac/mcp/app_test_ctrl
npm install
npm run build
```

应能看到 `mcp-servers/log-mcp/dist/index.js` 和 `mcp-servers/report-mcp/dist/index.js` 两个产物。

## 3. 接入 Claude Code

把 `.mcp.json.example` 复制为 `.mcp.json`（仓库根，Claude Code 会自动加载项目级配置）：

```bash
cp .mcp.json.example .mcp.json
```

里面已经声明了三个 MCP server：

- `mobile` — 上游 `@mobilenext/mobile-mcp`，npx 自动拉取
- `log` — 本仓 log-mcp，本地构建产物
- `report` — 本仓 report-mcp，本地构建产物

启动 Claude Code 后，在会话里输入 `/mcp` 应能看到三个 server 全部为 `connected` 状态。

## 4. 冒烟测试（手动跑一次）

下面这套指令完整走一遍"操作 → 抓 log → 出报告"。

```text
1. 调用 mobile.mobile_list_available_devices  → 确认有设备
2. 调用 report.start_session(name="smoke")
   → 拿到 session_dir
3. 调用 log.clear_logs
4. 调用 mobile.mobile_launch_app(packageName="com.android.settings")
5. 调用 mobile.mobile_take_screenshot
6. 调用 log.get_recent_crashes  → 期望返回 count=0
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

如果你想把 sessions 放到 git 不管的位置，可在 `.mcp.json` 的 report-mcp 段
覆盖 `APP_TEST_CTRL_WORKSPACE`。

## 6.5 iOS Simulator 流程（P4）

iOS 工具链只覆盖 **Simulator**（没有真机要求）。前置：

```bash
xcrun --version                       # 确认 Xcode 工具链
xcrun simctl list devices booted      # 至少有一台在 Booted 状态；没有的话：
xcrun simctl boot <udid>              # 启动一台
open -a Simulator                     # 或者直接打开 Simulator.app
```

iOS 上 devtest/qa skill 自动走平台分支（见 SKILL.md "平台分支"小节）。
关键差异：
- 元素查询用 `mobile.mobile_list_elements_on_screen`（没装 idb → ui-mcp 在 iOS 上不工作）
- crash 抓取用 `log.ios_list_ips` + `analyzer.parse_ips_file`
- log stream 用 `log.ios_start_capture`（推荐传 predicate `process == "<proc>"` 减少噪音）

`.ips` 默认从 `~/Library/Logs/DiagnosticReports/` 读取（系统级 + Simulator 应用崩溃都落这）。

## 7. 故障排查

| 现象 | 排查 |
|---|---|
| `/mcp` 显示 log/report 是 failed | 看 Claude Code 日志；通常是 `dist/index.js` 路径错或未 build |
| `adb devices` 列表为空 | 模拟器没起 / USB 调试没开 / `adb kill-server && adb start-server` |
| `get_recent_crashes` 总是 0 | logcat 缓冲被清得太早；改用 `start_capture` 持续抓 |
| `pull_anr_traces` 报权限 | 已用 `bugreport` 兜底，无需 root；耗时 1-3 分钟正常 |
