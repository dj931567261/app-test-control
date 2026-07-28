---
name: minimize
description: This skill should be used when the user asks to "minimize the repro path", "/minimize", "shrink the crash steps", "精简复现路径", "找最小复现", "把 12 步压成 3 步", or wants to compress a recorded crash repro_path into the shortest sequence that still reproduces the same crash signature. Drives live Android replay via mobile-mcp + ui-mcp + log-mcp, validates each candidate subset with analyzer-mcp's signature, and updates the session's crash record with the verified minimal path; iOS sessions use the static fallback because ui-mcp replay is Android-only.
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
- `ui` — Android 层级查询 + 点击（按原 element_key 复现）
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
target_signature = analyzer.compute_signature(stack=crash.stack).fingerprint
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
2. `max_replays` 默认 30，必须是 `>= 1` 的整数。非法值在建 session、
   启 app 或起 log capture 之前直接拒绝；不得让零预算落入
   `baseline=null` 后却生成伪结果。
3. report.get_session_path / list_sessions 拿到目录
4. analyzer.analyze_session(session_dir) →
     - 如果 unique=0：告诉用户没 crash，结束
     - 如果 unique>1 且没指定 --crash：列出 groups 让用户选
     - 否则选指定的或第一个 group
5. 拿到 target_crash:
     - target_fingerprint
     - original_repro_path
     - target_step_index (trigger)
6. 读 session meta/extra 和 steps.jsonl，解析 package、device_id、platform
   以及每步的 action/notes。package 缺失时让用户提供；device_id
   缺失时用 mobile.mobile_list_available_devices 选择 Android 设备。
7. 若原 session 不是 Android，不要调用 Android-only ui/log replay；改用
   analyzer.suggest_minimal_path 输出静态建议，标记 confidence="low"，
   且不得写 minimized_confidence="high"。
```

### Phase 1 · 提取 element_key 列表

QA / DevTest 的新格式把可回放信息放在 `notes` 的 JSON
`replay` 对象中。**必须先读 JSON**，旧的 action 文本或
`element_key=...` 只能作兼容兜底：

```
setup_step_indexes = []
replayable_steps = []
for idx in original_repro_path:
    s = steps[idx-1]
    notes_obj = try_json_parse(s.notes)
    replay = is_object(notes_obj.replay) ? notes_obj.replay : null

    action_type = replay?.action_type
                  ?? legacy_parse_action_type(s.action)
    key = replay?.element_key
          ?? legacy_parse_element_key(s.notes)
    input_value = replay?.input_value
                  ?? legacy_parse_input_value(s.action, s.notes)
    button = replay?.button
             ?? legacy_parse_button(s.action, s.notes)

    # replay() 每次都会干净启动 app；launch 是必需 setup，不参与删减。
    if action_type == "launch":
        setup_step_indexes.append(idx)
        continue

    strategy = null
    if key startsWith "text:": strategy={by:"text", value:key after prefix}
    else if key startsWith "label:": strategy={by:"label", value:key after prefix}
    else if key startsWith "class:" or key startsWith "bounds:":
        strategy = null  # 没有稳定唯一信息，不能伪装成 identifier
    else if key: strategy={by:"identifier", value:key}
    can_replay = (
      action_type == "press_button" and non_empty_string(button)
    ) or (
      action_type == "tap" and strategy != null
    ) or (
      action_type == "input_text" and strategy != null
        and typeof input_value == "string"
    )
    if can_replay:
        replayable_steps.append({idx, strategy, action_type, input_value, button})
    else:
        warn("step idx 缺少完整 replay 元数据，不能可靠回放")
```

`action_type` 优先取 `notes.replay.action_type`；输入值和按键参数也分别必须取
`replay.input_value` / `replay.button`。不要从新格式的人类描述反推参数。

**如果除 launch 外不足 50% 的原始步骤可 replay**，告诉用户：
> 这个 session 的 step 元数据不足，无法准确 replay。改用 `analyzer.suggest_minimal_path` 拿一个静态建议吧。

### Phase 2 · 设定新 session 跑 replay

为避免污染原 session，建一个 "minimize" 子 session：

```
minimize_session = report.start_session(
  name="minimize-<original_session_short>",
  extra={ original_session: <id>, target_fingerprint: <fp>,
          target_label: <label>, package, device_id, platform:"android",
          max_replays }
)
capture_failed = false
capture_failure = null
log.start_capture(session_id=minimize_session.session_id,
                  session_dir=minimize_session.session_dir,
                  device=device_id)
```

### Phase 3 · ddmin 主循环

```
current = replayable_steps
attempts = 0
budget_exhausted = false
fixed_point_reached = false
flaky_observed = false
outcome_history = Map<candidate_key, boolean[]>()
HIGH_CONFIDENCE_RUNS = 3

function try_candidate(candidate):
    if attempts >= max_replays:
        budget_exhausted = true
        return null
    attempts += 1                    # 只在真正 replay 时计一次
    result = replay(candidate)
    key = candidate.map(s => s.idx).join(",")
    outcome_history.getOrCreate(key, []).append(result.reproduced)
    保存截图并 record_step(
      action="replay " + candidate.map(s => s.idx),
      result=result.reproduced ? "ok" : "fail",
      notes=JSON.stringify({attempt:attempts, candidate:<indexes>, result})
    )
    return result

# 先现场验证完整可回放路径，不能只信任历史记录。
baseline = try_candidate(current)
if baseline == null or !baseline.reproduced:
    停止 ddmin；输出“原路径未在本轮复现”，不写已验证的 minimal 结果

while baseline.reproduced and len(current) >= 2 and !budget_exhausted:

    # 二分
    mid = len(current) // 2
    candidates = [current[:mid], current[mid:]]

    matched = null
    for cand in candidates:
        result = try_candidate(cand)
        if result == null: break
        if result.reproduced:
            matched = cand; break

    if matched:
        current = matched
        continue

    # 二分不行，逐个删
    progress = false
    for i in range(len(current)):
        if attempts >= max_replays:
            budget_exhausted = true
            break
        cand = current[:i] + current[i+1:]
        result = try_candidate(cand)
        if result != null and result.reproduced:
            current = cand
            progress = true
            break

    if budget_exhausted: break
    if not progress:
        fixed_point_reached = true
        break

if len(current) <= 1 and baseline.reproduced and !budget_exhausted:
    fixed_point_reached = true

# 偶发问题不能凭单次命中宣称 high。收敛后对最终 candidate 做重复采样，
# 已在 ddmin 中跑过的同 key 结果也算入，所有 replay 仍受同一预算限制。
final_key = current.map(s => s.idx).join(",")
while len(outcome_history[final_key]) < HIGH_CONFIDENCE_RUNS:
    confirmation = try_candidate(current)
    if confirmation == null: break
final_outcomes = outcome_history.getOrCreate(final_key, [])
flaky_observed = final_outcomes 同时包含 true 和 false
final_confirmed = len(final_outcomes) >= HIGH_CONFIDENCE_RUNS
                  and final_outcomes.every(value => value == true)
if !final_confirmed and attempts >= max_replays:
    budget_exhausted = true

# launch 是 replay 隐式执行的必需 setup，回写时保留它的原 step index。
minimal = original_repro_path 中属于
          (setup_step_indexes union current.map(s => s.idx)) 的项
```

### Phase 4 · replay(subset) 子例程

```
function replay(subset):
    # 1. 确保干净启动
    mobile.mobile_terminate_app(device=device_id, packageName=package)
    log.clear_logs(device=device_id)
    mobile.mobile_launch_app(device=device_id, packageName=package)
    if launch_anchor 可从 launch step/page 元数据可靠获取:
        ui.wait_for_element(device=device_id, strategies=<launch_anchor>,
                            timeout_ms=5000)

    # 2. 复现 subset 内每一步
    for s in subset:
        if s.action_type == "press_button":
            result = mobile.mobile_press_button(device=device_id,
                                                button=s.button)  # BACK / HOME / etc.
        elif s.action_type == "tap":
            result = ui.tap_element(
              device=device_id,
              strategies=[s.strategy],
              settle_ms=1000
            )
            if !result.tapped:
                # element_key 不在当前页 → 中断这次 replay
                return { reproduced: false, reason: "element_not_found", step: s.idx }
        elif s.action_type == "input_text":
            result = ui.input_text(device=device_id, strategies=[s.strategy],
                                   text=s.input_value)
        if result 表示操作失败:
            return {reproduced:false, reason:"action_failed", step:s.idx}
        # 等 0.5-1 秒
    # 3. 等 settle + 检查 crash
    sleep(2000)
    crashes = log.get_recent_crashes(device=device_id, package=package)
    if crashes.count == 0:
        return { reproduced: false, reason: "no_crash" }

    # 必须遍历所有 crash；目标不一定是 files/crashes[0]。
    observed = []
    for crash in crashes.crashes:
        sig = analyzer.compute_signature(stack=crash.stack)
        observed.push({fingerprint:sig.fingerprint, label:sig.label,
                       kind:crash.kind, process:crash.process})
        if sig.fingerprint == target_fingerprint:
            return {reproduced:true, signature:sig.fingerprint,
                    label:sig.label, observed}
        if target 是 ANR/native 且选定的 kind+process matcher 命中:
            return {reproduced:true, signature:target_fingerprint,
                    label:target_label, observed}

    return {reproduced:false, reason:"different_crash", observed}
```

每次 `try_candidate` 都要用
`mobile.mobile_save_screenshot(device=device_id, saveTo=...)` 存证，无论复现、
不复现还是操作失败，都写入 minimize session。对同一 candidate
如果观察到时好时坏，设 `flaky_observed=true`。

### Phase 5 · 写回 + 报告

```
1. 只有 baseline 已复现时才把 minimal 路径回写到原 session：
   读 crashes.jsonl 找到 target_crash，加字段：
     minimized_repro_path: minimal
     minimized_attempts: attempts
     minimized_confidence:
       "high"   if fixed_point_reached and final_confirmed
                   and !budget_exhausted and !flaky_observed
       "medium" if 当前路径已复现，但预算耗尽或观察到偶发
       "low"    only for 未做 live replay 的静态建议
     minimized_complete: fixed_point_reached
   原子写覆盖（或追加 .minimized.json sidecar）
   保留原 repro_path，不要用 minimal 覆盖它。baseline 未复现时，
   只在 minimize session 中记录失败，不伪造“已验证”字段。

2. 在 finally 中调
   `capture_stop = log.stop_capture(session_id=minimize_session.session_id)`，
   包括预算用尽、操作异常和 baseline 不复现的路径。若
   `capture_stop.status == "failed"` 或 `capture_stop.stopped != true`，锁存
   `capture_failed=true`，并把 `reason/error` 写入 `capture_failure`；只有
   `stopped=true` 才算日志正常收尾。日志基础设施失败时不得输出成功结论。

3. report.finalize(
     minimize session,
     status=(baseline.reproduced && !capture_failed ? "passed" : "failed"),
     summary="<original> 的 c1 从 N 步压到 M 步，<attempts> 次 replay；"
             + <是否收敛/预算耗尽/偶发警告>
             + <capture_failure（若有）>
   )

4. 终端打印：
   ✅ 复现路径精简 (jko.dns.qwn.dfgt c1)
     原始: [1,2,3,4,5,6,7,8,9,10,11,12]  (12 步)
     最小: [3, 7, 12]                    (3 步)
     验证: 共 8 次 replay，最终路径 3/3 命中 a3f2b89c1d0e，已收敛
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
  step 1: launch setup（每次 replay 隐式执行并在结果中保留）✓
  step 2: tap tvText (key=jko.dns.qwn.dfgt:id/tvText) ✓
  step 3: tap btn ✓
  step 4: tap rv item ⚠ (no key, 用截图坐标 - 跳过)
  ...
  覆盖率 6/8 = 75% ✓

[Phase 2] 建 minimize session: 2026-05-14_165500_minimize-qa-sdk805
[Phase 3] ddmin:
  attempt 1: [2,3,5,6,7,8] → fp=a3f2.. ✓ baseline
  attempt 2: [2,3,5]       → fp=null   ✗
  attempt 3: [6,7,8]       → fp=a3f2.. ✓ 缩短
  attempt 4: [6]           → fp=null   ✗
  attempt 5: [7,8]         → fp=a3f2.. ✓ 缩短
  attempt 6: [7]           → fp=a3f2.. ✓ 缩短到单操作
  attempt 7: [7]           → fp=a3f2.. ✓ 稳定性采样 2/3
  attempt 8: [7]           → fp=a3f2.. ✓ 稳定性采样 3/3

[Phase 5] ✅ c1 复现路径: [1..8] → [1,7] (8→2 步，含 launch)
  8 次 replay；最终路径 3/3 命中 signature a3f2..；已收敛
  报告: workspace/sessions/2026-05-14_165500_minimize-qa-sdk805/report.md
```
