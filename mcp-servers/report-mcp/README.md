# report-mcp

MCP server for test session and Markdown report generation.

## 安装

```bash
npm install
npm run build -w mcp-servers/report-mcp
```

## 注册到 Claude Code

```json
{
  "mcpServers": {
    "report-mcp": {
      "command": "node",
      "args": ["/Users/mac/mcp/app_test_ctrl/mcp-servers/report-mcp/dist/index.js"],
      "env": {
        "APP_TEST_CTRL_WORKSPACE": "/Users/mac/mcp/app_test_ctrl/workspace/sessions"
      }
    }
  }
}
```

## 工具列表

| 工具 | 说明 |
|---|---|
| `start_session` | 建 session 目录，返回 id + 绝对路径 |
| `record_step` | 追加一步（支持 screenshot/log 导入） |
| `record_crash` | 仅在 running 状态追加 crash；远端 source 支持严格幂等 |
| `finalize` | 设状态 + 生成 `report.md` |
| `regenerate_report` | 不改状态、重新渲染 `report.md` |
| `get_session_path` | 由 id 解析 session 目录 |
| `list_sessions` | 列工作区内所有 session（按时间倒序） |

## 目录约定

```
workspace/sessions/<YYYY-MM-DD_HHmmss>_<name>_<random>/
├── meta.json
├── steps.jsonl          # 每行一个 step
├── crashes.jsonl        # 每行一个 crash
├── steps/
│   ├── 001.png          # screenshot
│   └── 001.log          # log snippet
├── crashes/
│   ├── c1.stack.txt
│   └── c1.log
├── logs/                # 由 log-mcp.start_capture 写入
│   └── logcat.txt
└── report.md
```

新建 workspace/session/证据目录使用 `0700`，JSONL、stack、日志与报告使用 `0600`；
导入证据拒绝最终 symlink 并有大小上限。`record_step`、`record_crash` 与 `finalize`
共享跨进程 session 锁，终态 session 不可再追加步骤或崩溃。

`firebase-crashlytics` source 必须包含 project/app/issue/event，且 `external_key` 必须等于
`sha256(provider\0project\0app\0issue\0event\0signature)`。公开 Markdown/HTML 只显示
二次哈希引用；`meta.extra` 只渲染固定安全字段，原始 device ID 会转换为哈希引用。

## 环境变量

- `APP_TEST_CTRL_WORKSPACE` — sessions 根目录（绝对路径）。
  不设则用 `<cwd>/workspace/sessions`。

## 测试

```bash
./node_modules/.bin/tsx --test mcp-servers/report-mcp/src/report.test.ts
```
