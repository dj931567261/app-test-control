---
name: minimize
description: This skill should be used when the user asks to "minimize the repro path", "/minimize", "shrink the crash steps", "精简复现路径", "找最小复现", "把 12 步压成 3 步", or wants to compress a recorded crash repro_path into the shortest sequence that still reproduces the same crash signature. Drives live replay via mobile-mcp + ui-mcp + log-mcp, validates each candidate subset with analyzer-mcp's signature, and updates the session's crash record with the verified minimal path.
version: 0.1.0
argument-hint: "<session_id> [--crash <id>] [--max-replays <N>]"
---

# Minimize — 复现路径精简 (Delta-Debugging)

把"12 步触发的崩溃"变成"3 步触发的崩溃"。

输入是一个**已经记录过 crash 的 session**，输出是验证过能复现同一签名的最小步骤子集。

依赖 5 个 MCP：
- `report` — 读 steps.jsonl / crashes.jsonl
- `analyzer` — compute_signature 验证"同一个崩溃"
- `mobile` — terminate / launch / 截图
- `ui` — 层级查询 + 点击（按原 element_key 复现）
- `log` — clear / get_recent_crashes

## When to invoke

- "/minimize 2026-05-14_160354_qa-sdk805"
- "把那次崩溃的复现路径压一压"、"找最小复现路径"
- "12 步太长了，精简一下"

不要在这些场景里 invoke：
- 没有 crashes.jsonl 的 session（没东西可压）
- 用户只是想看 dedup（→ analyzer.analyze_session 即可）
- repro_path 已经是 1-2 步（没必要）

## 核心算法 · ddmin（变体）

```
target_signature = analyzer.compute_signature(crash.stack).fingerprint
original = repro_path  // [s1, s2, ..., sN]
current = original

while |current| >= 2:
    # 二分尝试
    half_a = current[:len/2]
    half_b = current[len/2:]
    if replay(half_a).signature == target_signature:
        current = half_a; continue
    if replay(half_b).signature == target_signature:
        current = half_b; continue
    # 二分不行，尝试逐个删
    progress = false
    for i in 0..len(current):
        candidate = current[:i] + current[i+1:]
        if replay(candidate).signature == target_signature:
            current = candidate
            progress = true
            break
    if not progress: break  # 不能再压了

return current
```

**复杂度**：最坏 `O(N²)` 次 replay，平均 `O(N·log N)`。每次 replay = "重启 app → 走 K 步 → 截图 → 抓 log → 算 sig"，约 5-15 秒。
**预算**：默认 `--max-replays 30`，N=12 步通常 8-15 次 replay 收敛。

## 工作流

### Phase 0 · 输入校验

```
1. 必须提供 session_id（或绝对 session_dir）
2. report.get_session_path / list_sessions 拿到目录
3. analyzer.analyze_session(session_dir) →
     - 如果 unique=0：告诉用户没 crash，结束
     - 如果 unique>1 且没指定 --crash：列出 groups 让用户选
     - 否则选指定的或第一个 group
4. 拿到 target_crash:
     - target_fingerprint
     - original_repro_path
     - target_step_index (trigger)
5. 读 steps.jsonl 拿每步的 action / notes / element_key
```

### Phase 1 · 提取 element_key 列表

QA / DevTest skill 应当在每个 step 的 `notes` 里写了 `element_key=...`。读出来：

```
replayable_steps = []
for idx in original_repro_path:
    s = steps[idx-1]
    key = parse_element_key(s.notes)  # 找 "element_key=XXX" 子串
    action_type = parse_action_type(s.action)  # tap / input_text / press_button
    if key or action_type == "press_button":
        replayable_steps.append({idx, key, action_type, raw_action})
    else:
        warn("step idx has no replayable info")
```

**如果 < 50% 的步骤可 replay**，告诉用户：
> 这个 session 的 step 元数据不足，无法准确 replay。改用 `analyzer.suggest_minimal_path` 拿一个静态建议吧。

### Phase 2 · 设定新 session 跑 replay

为避免污染原 session，建一个 "minimize" 子 session：

```
report.start_session(
  name="minimize-<original_session_short>",
  extra={ original_session: <id>, target_fingerprint: <fp>, target_label: <label> }
)
log.start_capture(...)
```

### Phase 3 · ddmin 主循环

```
current = replayable_steps
attempts = 0

while len(current) >= 2 and attempts < max_replays:
    attempts += 1

    # 二分
    mid = len(current) // 2
    candidates = [current[:mid], current[mid:]]

    matched = null
    for cand in candidates:
        if attempts > max_replays: break
        result = replay(cand)
        attempts += 1
        if result.signature == target_fingerprint:
            matched = cand; break

    if matched:
        current = matched
        continue

    # 二分不行，逐个删
    progress = false
    for i in range(len(current)):
        cand = current[:i] + current[i+1:]
        result = replay(cand)
        attempts += 1
        if result.signature == target_fingerprint:
            current = cand
            progress = true
            break

    if not progress: break

minimal = [s.idx for s in current]
```

### Phase 4 · replay(subset) 子例程

```
function replay(subset):
    # 1. 确保干净启动
    mobile.terminate_app(package)
    mobile.launch_app(package)
    ui.wait_for_element(<launch_anchor>, timeout=5s)  # 主页特征元素
    log.clear_logs

    # 2. 复现 subset 内每一步
    for s in subset:
        if s.action_type == "press_button":
            mobile.press_button(s.raw_action_param)  # BACK / HOME / etc.
        elif s.action_type == "tap":
            ui.tap_element(
              strategies=[{by:"identifier", value:s.element_key}],
              settle_ms=1000
            )
            if !result.tapped:
                # element_key 不在当前页 → 中断这次 replay
                return { reproduced: false, reason: "element_not_found", step: s.idx }
        elif s.action_type == "input_text":
            ui.input_text({...})
        # 等 0.5-1 秒
    # 3. 等 settle + 检查 crash
    sleep(2000)
    crashes = log.get_recent_crashes(package=...)
    if crashes.count == 0:
        return { reproduced: false, reason: "no_crash" }

    sig = analyzer.compute_signature(crashes[0].stack)
    return {
      reproduced: sig.fingerprint == target_fingerprint,
      signature: sig.fingerprint,
      label: sig.label
    }
```

每次 replay 后**别忘 record_step + 截图**入 minimize session，可追溯。

### Phase 5 · 写回 + 报告

```
1. 把 minimal 路径回写到原 session：
   读 crashes.jsonl 找到 target_crash，加字段：
     minimized_repro_path: minimal
     minimized_attempts: attempts
     minimized_confidence: "high"   # ← 已 replay 验证
   原子写覆盖（或追加 .minimized.json sidecar）

2. report.finalize(minimize session, status="passed",
     summary="<original> 的 c1 从 N 步压到 M 步，<attempts> 次 replay")

3. 终端打印：
   ✅ 复现路径精简 (jko.dns.qwn.dfgt c1)
     原始: [1,2,3,4,5,6,7,8,9,10,11,12]  (12 步)
     最小: [3, 7, 12]                    (3 步)
     验证: 8 次 replay 均触发同一签名 a3f2b89c1d0e
     报告: workspace/sessions/2026-05-14_xxx_minimize-yyy/report.md
```

## 失败 / 边界情况

| 现象 | 处理 |
|---|---|
| replay 时元素找不到（页面状态对不上） | 视为 "不复现"，子集太小或顺序不对，继续 ddmin |
| crash 偶发（不是每次都出） | 警告用户，记录"X 次 replay 中 Y 次复现"，输出最稳定的子集 |
| element_key 缺失太多 | 终止 ddmin，告诉用户用 `analyzer.suggest_minimal_path` 拿静态建议 |
| max_replays 用尽 | 输出当前最小子集 + "未达不动点，可加大 --max-replays" |
| target 是 ANR / native crash | ddmin 仍可用，但 signature 比较改用 kind+process 维度 |

## Do / Don't

✅ Do
- 每次 replay 之前都 `terminate + launch` 干净启动
- 用 analyzer.compute_signature 比较签名，**不要**用字符串相等比 stack（行号会变）
- 每次 replay 都记 step + 截图，可复盘
- minimize session 的 extra 字段写 `original_session` + `target_fingerprint`

❌ Don't
- 不要直接修改原 session 的 crashes.jsonl 里的 repro_path（保留原始）
- 不要 ddmin 单步 case（len=1 无意义）
- 不要忽略"虽然崩了但 signature 不同"的情况——那不是我们要找的 bug
- 不要让 max_replays 无上限（成本爆炸）

## 例

用户："/minimize 2026-05-14_qa-sdk805"

```
[Phase 0] analyze_session →
  unique: 1, target: c1 (NullPointerException @ LoginActivity.onClick, fp=a3f2..)
  original repro_path: [1,2,3,4,5,6,7,8] (8 步)

[Phase 1] 提取 element_key:
  step 1: tap btn (key=jko.dns.qwn.dfgt:id/btn) ✓
  step 2: tap tvText (key=jko.dns.qwn.dfgt:id/tvText) ✓
  step 3: tap btn ✓
  step 4: tap rv item ⚠ (no key, 用截图坐标 - 跳过)
  ...
  覆盖率 6/8 = 75% ✓

[Phase 2] 建 minimize session: 2026-05-14_165500_minimize-qa-sdk805
[Phase 3] ddmin:
  attempt 1: [1,2,3,4]  → fp=a3f2.. ✓ 缩短
  attempt 2: [1,2]      → fp=null   ✗
  attempt 3: [3,4]      → fp=a3f2.. ✓ 缩短
  attempt 4: [3]        → fp=null   ✗
  attempt 5: [4]        → fp=a3f2.. ✓ 缩短到单步！
  attempt 6: 长度=1，结束

[Phase 5] ✅ c1 复现路径: [1..8] → [4] (8→1 步)
  6 次 replay 验证；signature a3f2.. 稳定
  报告: workspace/sessions/2026-05-14_165500_minimize-qa-sdk805/report.md
```
