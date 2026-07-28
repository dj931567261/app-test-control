# analyzer-mcp

MCP server for crash signature, dedup, and lightweight repro-path heuristics.

## 何时用

- 一次 QA 探索后，5 次 crash 是不是同一个 bug？ → `dedup_crashes` / `analyze_session`
- 单条 crash 想拿 stable id 入 issue 系统 → `compute_signature`
- 12 步触发的崩溃能不能压短？快速看建议 → `suggest_minimal_path`
- **真正的最短复现**（验证过的）→ 用 `minimize` skill，它会驱动 replay 做 delta-debug

## 安装与接入

仓库根 `npm install && npm run build`。`.mcp.json.example` 里的 `analyzer` 段已配置好，复制到 `.mcp.json`。

## 工具列表

| 工具 | 说明 |
|---|---|
| `compute_signature` | 解析 Android stack 文本 → 12 位 fingerprint + 异常类 + top frames |
| `dedup_crashes` | 给一组 crashes，按 signature 分组（occurrences + instance_ids） |
| `analyze_session` | 读 session 目录，自动 hydrate crashes.jsonl 并 dedup |
| `suggest_minimal_path` | 静态启发：基于 `result` + `notes` 中 page 转移线索压短 repro_path |
| `parse_ips_file` | 解析 Apple `.ips` 文件 → exception_type/signal/top_frames/fingerprint，并返回可直接传给 `report.record_crash` 的规范 `stack` |
| `parse_ips_content` | 同上，但输入是 raw text（适合内联 fixture），同样返回规范 `stack` |

## Signature 算法

```
fingerprint = sha1(
  kind                  +   # java | anr | native
  exception_class       +   # "java.lang.NullPointerException"
  top_3_frames_normalized + # 去掉 (file.java:42)
  root_cause_class      +   # innermost Caused-by
  signal                +   # SIGSEGV (native)
  process                   # com.x.y (ANR)
).slice(0, 12)
```

**稳定性保证**：
- 行号变化不影响（`onClick(File.java:42)` 和 `onClick(File.java:88)` 同 hash）
- 空白/制表符差异不影响
- 类名 + 方法名变化影响
- 异常类型变化影响（NPE vs ISE 不同）

## 典型组合

### QA 探索后做一次去重

```text
analyzer.analyze_session(session_dir="workspace/sessions/xxx_qa-sdk805")
→ {
    total: 7,
    unique: 3,
    groups: [
      { label: "NullPointerException @ LoginActivity.onClick",
        occurrences: 5, instance_ids: ["c1","c2","c3","c5","c7"],
        repro_paths: [[1,2,3,4,5], ...] },
      { label: "ANR in com.x.y", occurrences: 1, ... },
      { label: "Native crash SIGSEGV @ ...", occurrences: 1, ... }
    ]
  }
```

### 拿建议的最短路径

```text
analyzer.suggest_minimal_path(
  session_dir="...",
  repro_path=[1,2,3,4,5,6,7,8],
  target_step_index=8
)
→ {
    original_path: [1..8],
    suggested_path: [3, 5, 8],     ← 压成 3 步
    reasoning: {3: "page transition", 5: "page transition", 8: "trigger"},
    confidence: "medium"           ← 静态推断；需要 replay 验证才升级到 high
  }
```

## 测试

```bash
./node_modules/.bin/tsx --test mcp-servers/analyzer-mcp/src/signature.test.ts mcp-servers/analyzer-mcp/src/dedup.test.ts
```
