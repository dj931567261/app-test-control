# 架构总览

## 角色与数据流

```
┌────────────────────────────────────────────────────────────────────┐
│                           Claude Code                              │
│                                                                    │
│   ┌──────────────┐   ┌──────────────┐   ┌──────────────────────┐   │
│   │ /devtest     │   │ /qa          │   │ /minimize            │   │
│   │ skill        │   │ skill        │   │ skill                │   │
│   └─────┬────────┘   └─────┬────────┘   └─────┬────────────────┘   │
│         └──────────────────┼──────────────────┘                    │
│                            ▼                                       │
│                   stdio (JSON-RPC over MCP)                        │
└────────────────────────────┬───────────────────────────────────────┘
                             │
        ┌────────────────────┼────────────────────┬────────────────┐
        ▼                    ▼                    ▼                ▼
┌──────────────┐    ┌──────────────┐    ┌──────────────┐  ┌──────────────┐
│  mobile-mcp  │    │   ui-mcp     │    │   log-mcp    │  │ analyzer-mcp │
│  (upstream)  │    │              │    │              │  │              │
│              │    │ uiautomator  │    │ logcat /     │  │ sig/dedup/   │
│ list/launch  │    │ dump + tap   │    │ ANR / .ips   │  │ .ips parse   │
│ /screenshot  │    │ (Android)    │    │              │  │              │
└──────┬───────┘    └──────┬───────┘    └──────┬───────┘  └──────┬───────┘
       │ adb / simctl      │ adb              │ adb /             │ (pure)
       ▼                   ▼                  ▼ simctl            ▼
┌──────────────────────────────────────────────────────┐  ┌──────────────┐
│            Android device / iOS simulator             │  │  report-mcp  │
│  (subject under test)                                 │  │              │
└──────────────────────────────────────────────────────┘  │  sessions +  │
                                                          │ state graph +│
                                                          │ md/html      │
                                                          └──────┬───────┘
                                                                 ▼
                                              workspace/sessions/<id>/
                                                ├─ meta.json
                                                ├─ steps.jsonl
                                                ├─ crashes.jsonl
                                                ├─ state-graph.json
                                                ├─ steps/  *.png + *.log
                                                ├─ crashes/  c1.stack.txt + c1.log
                                                ├─ logs/  logcat.txt or ios-log.txt
                                                ├─ report.md
                                                └─ report.html
```

## 4 个 MCP 的分工

| MCP | 工具数 | 角色 | 平台 |
|---|---|---|---|
| **log-mcp** | 14 | 抓 logcat / ANR / tombstone / iOS log stream / `.ips` 文件 | Android + iOS Simulator |
| **report-mcp** | 12 | session 与文件、Markdown/HTML 报告、QA 状态图 | 平台无关 |
| **ui-mcp** | 7 | uiautomator dump + 智能点击 + page_fingerprint | Android only（无 idb） |
| **analyzer-mcp** | 6 | crash signature / dedup / 路径精简启发 / `.ips` 解析 | 平台无关 |

**为什么 ui-mcp 不在 iOS 上工作**：用户机器没装 idb，没有稳定的层级查询通道。
Skills 在 iOS 时自动回退到 `mobile-mcp.mobile_list_elements_on_screen`（mobile-mcp 自己用 WebDriverAgent / accessibility）。

## 3 个 Skill 的分工

| Skill | 输入 | 输出 | 典型耗时 |
|---|---|---|---|
| **devtest** | git diff（或 --scope） | "刚改的功能能不能跑" 短结论 + 报告 | < 1 分钟 |
| **qa** | --package | 自动探索 → bug 列表 + 覆盖统计 | 10–60 分钟 |
| **minimize** | session_id + crash_id | 验证过的最小复现路径 | 1–10 分钟 |

## 关键数据结构

### Session 目录（report-mcp 拥有）

```
workspace/sessions/<YYYY-MM-DD_HHmmss>_<name>/
├── meta.json           { id, name, started_at, ended_at, status, extra? }
├── steps.jsonl         每行一个 step：{ index, ts, action, result, screenshot?, log_excerpt?, notes? }
├── crashes.jsonl       每行一个 crash：{ id, ts, step_index?, signature, kind?, stack_path, log_path?, repro_path }
├── state-graph.json    QA 状态图：{ pages: { hash → page_data }, edges: [...] }
├── steps/              001.png + 001.log
├── crashes/            c1.stack.txt + c1.log
├── logs/               logcat.txt (Android) 或 ios-log.txt (iOS)
├── report.md           Markdown 报告
└── report.html         HTML 报告（自包含，可直接浏览器打开）
```

### Crash signature（analyzer-mcp）

```
fingerprint = sha1(
  kind +                    # java | anr | native | ios
  exception_class +         # "java.lang.NPE" 或 "EXC_BAD_ACCESS"
  top_3_frames_normalized + # 去掉行号/symbolicate
  root_cause_class +        # 嵌套 Caused-by 最内层
  signal +                  # SIGSEGV (iOS/native)
  process                   # 包名/bundle id (ANR/iOS)
).slice(0, 12)
```

行号变化、空白变化 → 同一指纹。类名/方法名变化、异常类型变化 → 不同指纹。

### State graph（report-mcp，QA 用）

```jsonc
{
  "pages": {
    "<page_hash>": {
      "hash": "...",
      "first_seen": "ISO",
      "last_seen": "ISO",
      "visit_count": 3,
      "elements_seen": ["jko.dns.qwn.dfgt:id/btn", "text:登录"]
    }
  },
  "edges": [
    { "from": "<hash_a>", "action": "click 登录", "to": "<hash_b>", "ts": "ISO" }
  ]
}
```

`pick_next_unseen` 用这份数据决定下一步点哪。`elements_seen` 跨 app 重启持久化，
重启后回到相同 page_hash 不会重复点已点过的元素。

## 工作流编排（Skill = LLM 解释执行）

每个 Skill 是一份 Markdown 提示词，描述：
1. 何时被触发（description 里写关键词）
2. 工具调用顺序（Phase 0 → Phase N）
3. 失败兜底逻辑
4. 输出格式

Claude 加载 SKILL.md 后**逐条 MCP 工具调用**完成工作流。这种"提示词即编排"的好处：
- 调整流程不用改代码，只改 SKILL.md
- 同一套底座工具能服务多种工作流
- 工作流的可读性 = 代码评审难度

## 测试金字塔

```
                ▲   smoke (stdio handshake)            4 个 MCP
               ▲ ▲  unit (parsing / hashing / graph)   ~50 个
              ▲ ▲ ▲ integration (real device)          1 次/skill
             ▲ ▲ ▲ ▲ e2e (skill 在真机跑完整流程)        手动
```

CI 跑 unit + smoke（不需要设备）。integration / e2e 用户在本机跑。
