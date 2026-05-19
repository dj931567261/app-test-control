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
| `record_crash` | 追加一个 crash（含 repro_path） |
| `finalize` | 设状态 + 生成 `report.md` |
| `regenerate_report` | 不改状态、重新渲染 `report.md` |
| `get_session_path` | 由 id 解析 session 目录 |
| `list_sessions` | 列工作区内所有 session（按时间倒序） |

## 目录约定

```
workspace/sessions/<YYYY-MM-DD_HHmmss>_<name>/
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

## 环境变量

- `APP_TEST_CTRL_WORKSPACE` — sessions 根目录（绝对路径）。
  不设则用 `<cwd>/workspace/sessions`。

## 测试

```bash
./node_modules/.bin/tsx --test mcp-servers/report-mcp/src/report.test.ts
```
