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
| `compute_signature` | 解析 Android/ANR/native 或 canonical iOS stack → 12 位 fingerprint + `signature_version`；Java/iOS v2 另返 `legacy_fingerprint` |
| `dedup_crashes` | 给一组 crashes，严格按 `(signature_version, fingerprint)` 分组（`kind` 仅为展示元数据；返回 occurrences + instance_ids） |
| `analyze_session` | 读 session 目录，自动 hydrate crashes.jsonl 并 dedup |
| `suggest_minimal_path` | 静态启发：基于 `result` + `notes` 中 page 转移线索压短 repro_path |
| `analyze_crash_event` | 严格校验 `crash-event/v1`，从结构化 frames 重建 canonical stack、签名与跨来源可比性门槛 |
| `parse_ips_file` | 解析 Apple `.ips` 文件 → exception_type/signal/top_frames/identity_frame/fingerprint，并返回可直接传给 `report.record_crash` 的规范 `stack`；仅接受绝对路径指向的常规文件（安全软链接可用），上限 64 MiB |
| `parse_ips_content` | 解析 raw `.ips` 文本（适合内联 fixture），同样返回规范 `stack`，UTF-8 内容上限 64 MiB |

## Signature 算法

```
fingerprint = sha1(
  kind                  +   # java | anr | native | ios
  signature_version_domain + # java-v2 / ios-v2，保证不与 legacy v1 复用主 fingerprint
  exception_class       +   # "java.lang.NullPointerException"
  primary_frames_normalized + # Java/ANR/native 最多 3 帧；iOS 最多 4 帧
  root_cause_class      +   # innermost Caused-by
  signal                +   # SIGSEGV (native)
  process               +   # com.x.y (ANR) / iOS bundle id
  ios_identity_frame        # iOS 首个 app-owned 帧；无法识别时使用第 4 帧
).slice(0, 12)
```

**稳定性保证**：
- 行号变化不影响（`onClick(File.java:42)` 和 `onClick(File.java:88)` 同 hash）
- 空白/制表符差异不影响
- 类名 + 方法名变化影响
- 异常类型变化影响（NPE vs ISE 不同）
- iOS faulting thread 最多保留 32 帧；前三个系统异常跳板相同但第 4 个或
  首个 app-owned 业务帧不同的报告不会再被合并
- canonical iOS stack 可整体缩进后重新解析；缺少异常类型/信号、进程或
  faulting frame 时直接拒绝，不生成通用碰撞签名

**历史兼容**：增强 Java logcat 解析结果标为 `java-v2`；包含第 4 帧或 app-owned
identity frame 的 iOS 结果标为 `ios-v2`。主 fingerprint 与 v1 做 domain separation，
同时返回 `legacy_fingerprint` 供用户明确发起的历史检索。`dedup_crashes` 和
`analyze_session` 永远不会用 legacy key 自动跨版本合并；相同 12 位 fingerprint 但
`signature_version` 不同仍是不同组。

输入也有资源边界：单条 stack 最多 4 MiB，`dedup_crashes` 最多 1000 条且
stack 总量最多 64 MiB；`.ips` 文件/内联内容最多 64 MiB，集合扫描、保留帧数
和单个身份字段均有上限。`.ips` header 只回传白名单内的有界字符串，不会把
任意对象/数组原样带入 MCP 响应。

`analyze_session` 同样限制为 1000 条 crash、单 stack 4 MiB、stack 总量
64 MiB；`crashes.jsonl`/`steps.jsonl` 各自最多 16 MiB，并逐条做运行时类型、
长度和数组上限校验。对应操作所需的 JSONL 索引缺失时会 fail-closed，不会误报为空结果。
同一分组的 `signature_degraded` / `cross_source_comparable` 只有在全部实例有明确证据时
才会给出肯定资格；任一 degraded 或 non-comparable 实例仍会立即使整组不合格。
`session_dir` 必须是绝对目录；session 内被读取的 stack
必须是目录内的普通文件，路径越界、软链接、FIFO 和读取期间发生的 inode 替换
都会被拒绝。MCP 错误输出会移除终端控制符并截断本地路径/URL，且总长不超过 512 字符。
`crash-event/v1.frames[].file` 必须在采集层先归一为使用 `/` 的仓库相对路径；Analyzer
拒绝绝对路径、URI、反斜杠、重复分隔符以及 `.` / `..` 段，不会静默折叠不可信路径。

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
./node_modules/.bin/tsx --test mcp-servers/analyzer-mcp/src/*.test.ts
```
