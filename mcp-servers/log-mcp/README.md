# log-mcp

MCP server for Android logcat / ANR / tombstone capture.

## 安装

```bash
# 在 monorepo 根
npm install
npm run build -w mcp-servers/log-mcp
```

## 注册到 Claude Code

编辑 `~/.claude.json` 或项目内 `.mcp.json`，加：

```json
{
  "mcpServers": {
    "log-mcp": {
      "command": "node",
      "args": ["/Users/mac/mcp/app_test_ctrl/mcp-servers/log-mcp/dist/index.js"],
      "env": {
        "ADB_BIN": "adb"
      }
    }
  }
}
```

开发模式可直接 tsx：

```json
"log-mcp": {
  "command": "npx",
  "args": ["tsx", "/Users/mac/mcp/app_test_ctrl/mcp-servers/log-mcp/src/index.ts"]
}
```

## 工具列表

| 工具 | 说明 |
|---|---|
| `list_devices` | 列出 adb 设备 |
| `clear_logs` | 清 logcat 缓冲 |
| `start_capture` | 起后台抓 log 到文件 |
| `stop_capture` | 停后台抓 log |
| `list_captures` | 列当前在跑的抓取 |
| `get_recent_crashes` | dump logcat 并解析 FATAL/ANR/Native |
| `pull_anr_traces` | `adb bugreport` → zip（含 `/data/anr/`） |
| `pull_tombstones` | `adb bugreport` → zip（含 `/data/tombstones/`） |
| `get_memory_info` | `dumpsys meminfo <pkg>` (Android) |
| `save_log_snippet` | 把 logcat dump 或抓取文件切片落盘 (Android) |
| `ios_list_simulators` | `xcrun simctl list devices`（可只列 booted） |
| `ios_start_capture` | 起 `simctl spawn log stream` 到 `<session>/logs/ios-log.txt` |
| `ios_list_ips` | 扫 `~/Library/Logs/DiagnosticReports/`，支持 since_minutes / bundle_id 过滤 |
| `ios_pull_ips` | 把匹配的 `.ips` 拷贝到指定目录 |

### iOS 真机（libimobiledevice，需连真机）

> 真机崩溃**不落** Mac 本地 `~/Library/Logs/DiagnosticReports`，所以 `ios_list_ips` 对真机永远为空，必须用 `ios_pull_device_crashes` 从设备拉。完整接入见 `docs/IOS.md`。

| 工具 | 说明 |
|---|---|
| `ios_list_devices` | 列 USB 连接的真机（UDID / 名称 / 型号 / 系统版本），底层 `idevice_id`+`ideviceinfo` |
| `ios_device_start_capture` | 后台 `idevicesyslog` 抓真机日志到 `<session>/logs/ios-device-syslog.txt`，`process_match` 按进程名过滤；用 `stop_capture` 停 |
| `ios_pull_device_crashes` | `idevicecrashreport` 从设备拉崩溃报告，返回 `files[]`（拷贝路径列表）；`filter` 按进程名减少落盘，`since_minutes` 按文件名时间戳裁剪返回列表（设备无时间过滤，历史崩溃仍会落盘）；默认保留设备副本 |
| `ios_device_list_apps` | `ideviceinstaller` 列已装 app（user / system / all） |

## 典型流程

```
clear_logs                 ← 操作前
[在 mobile-mcp 里点击]
get_recent_crashes         ← 操作后立刻查
  └── 如果有结果 → save_log_snippet 落盘
  └── 如果是 native → pull_tombstones 拿 bugreport
```

## 环境变量

- `ADB_BIN` — adb 路径，默认 `adb`（依赖 $PATH）
- iOS 路径：`~/Library/Logs/DiagnosticReports/`（不可改，可在 `ios_*` 工具参数里临时 override）

## 测试

```bash
./node_modules/.bin/tsx --test mcp-servers/log-mcp/src/crash-parser.test.ts
```
