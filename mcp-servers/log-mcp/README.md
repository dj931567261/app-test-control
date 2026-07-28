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
| `start_capture` | 起后台抓 log 到文件；`max_bytes` 按文件累计总大小限制，默认 256 MiB、硬上限 2 GiB |
| `stop_capture` | 停后台抓 log；若进程已异常退出，返回保留的失败原因而不是普通 `stopped:false` |
| `list_captures` | 列 `running/stopping` 抓取及最近 64 条 `failed` 终态（退出码、信号、错误） |
| `get_recent_crashes` | dump logcat 并解析 FATAL/ANR/Native；过滤在解析条数上限之前执行，响应最多 64 条，每条 stack 64 KiB、总 stack 512 KiB，截断会显式标记 |
| `pull_anr_traces` | `adb bugreport` → zip（含 `/data/anr/`） |
| `pull_tombstones` | `adb bugreport` → zip（含 `/data/tombstones/`） |
| `get_memory_info` | `dumpsys meminfo <pkg>` (Android) |
| `save_log_snippet` | 流式读取普通单硬链接 capture 文件，按 `grep`/`last_lines` 选取；输出最多 4 MiB，并以 `0600` 原子落盘，拒绝 FIFO/软链接/硬链接别名 |
| `ios_list_simulators` | `xcrun simctl list devices`（可只列 booted） |
| `ios_start_capture` | 起 `simctl spawn log stream` 到 `<session>/logs/ios-log.txt`；同样支持累计总大小 `max_bytes` |
| `ios_list_ips` | 有界扫描 `~/Library/Logs/DiagnosticReports/`，仅以已验证 fd 读取最多 64 KiB 首行；拒绝软链接/FIFO/硬链接/超大文件，最多返回 64 条并显式给出 `total_detected/results_truncated`；`files[]` 路径取 `.path` |
| `ios_pull_ips` | 每次最多安全复制 100 个、总计 512 MiB 的已验证 `.ips`；源 inode 会二次校验，目标经私有临时文件原子替换并固定为 `0600` |

### iOS 真机（libimobiledevice，需连真机）

> 真机崩溃**不落** Mac 本地 `~/Library/Logs/DiagnosticReports`，所以 `ios_list_ips` 对真机永远为空，必须用 `ios_pull_device_crashes` 从设备拉。完整接入见 `docs/IOS.md`。

| 工具 | 说明 |
|---|---|
| `ios_list_devices` | 列 USB 连接的真机（UDID / 名称 / 型号 / 系统版本），底层 `idevice_id`+`ideviceinfo` |
| `ios_device_start_capture` | 后台 `idevicesyslog` 抓真机日志到 `<session>/logs/ios-device-syslog.txt`，`process_match` 按进程名过滤；`max_bytes` 是该日志文件的总大小上限，默认 256 MiB、硬上限 2 GiB，达到后自动停止并记录 `limit_reached`；用 `stop_capture` 手动停 |
| `ios_pull_device_crashes` | 以只读方式执行 `idevicecrashreport -k`，最多接受 128 个去重后的 `Link:` / `Copy:` / `Move:` 路径。外部 helper 只写每次随机的私有 staging；运行中轮询 2000 entry / 512 MiB 逻辑大小配额，超限会 TERM→KILL。全部公告文件和 inode/size 校验通过后，才以稳定哈希文件名发布 `since_minutes` 保留项；旧证据不覆盖，批量失败回滚本次新文件。`filter` 不是删除边界，`remove_from_device=true` 始终拒绝 |
| `ios_device_list_apps` | `ideviceinstaller` 列已装 app（user / system / all） |

后台 capture manager 最多允许 8 路 active/starting capture，并拒绝两个 session
通过父目录软链接别名同时写同一个 real path/inode。三种 capture 都以已打开并
完成 `fstat` 的常规文件描述符写入，拒绝末端软链接、FIFO、设备文件、非当前
用户文件及已有多个硬链接的文件；输出权限统一收紧为 `0600`。同时统一使用默认
256 MiB、硬上限 2 GiB 的累计文件大小限制；达到上限会停止并留下
`limit_reached`。调用方仍应在收尾调用 `stop_capture`；若 capture 尚在 starting，
该调用会取消设备查询并回收 provisional child，避免稍后注册成孤儿 writer。MCP
stdin 结束或关闭时，server 也会在有界 shutdown 中完成相同清理，并停止/flush
已登记 capture。

所有一次性外部命令统一使用硬 deadline、合计 32 MiB stdout/stderr 上限和独立
进程组回收：timeout、Abort、输出超限都会先 TERM，500 ms 后 KILL，并等待 stdio
关闭；成功主进程若遗留后台子进程也会拒绝。MCP 文本响应另有 4 MiB 总上限，
列表工具优先返回结构化的 `total_detected/results_truncated`，不会截坏 JSON。
capture、snippet、IPS 与真机 crash 输出目录会校验 owner/0700、末端软链接、
祖先可写性和操作期间 inode，目录被 rename/swap 时失败关闭而不返回伪证据。

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
- `XCRUN_BIN` — xcrun 路径，默认 `xcrun`（主要用于受控测试环境）
- iOS 路径：`~/Library/Logs/DiagnosticReports/`（不可改，可在 `ios_*` 工具参数里临时 override）

## 测试

```bash
node --import tsx --test mcp-servers/log-mcp/src/*.test.ts
```
