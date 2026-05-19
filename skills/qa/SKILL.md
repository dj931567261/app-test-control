---
name: qa
description: This skill should be used when the user asks to "explore the app", "/qa", "auto-test the app", "find bugs in my app", "猴子测试", "自动探索", "随便点一下看看", "测一下全 app 看有没有崩", "smoke explore", or wants autonomous exploration of an Android app to surface crashes / ANRs / unexpected states. Drives the app via ui-mcp + mobile-mcp, tracks visited pages and clicked elements via report-mcp's state graph, captures crashes via log-mcp, and produces a Markdown report with bug list + coverage stats.
version: 0.1.0
argument-hint: "[--package <pkg>] [--max-steps <N>] [--duration-min <N>] [--device <serial>]"
---

# QA — 自动探索 Agent

让 app **自己被点**，记录每一步、每一页、每一次崩溃。和 DevTest 不同，QA 不读 git diff，**目标是找未知的 bug**。

依赖五个 MCP：
- `mobile` — 启停 app、截图、iOS 层级查询、点击坐标（兜底）
- `ui` — uiautomator 层级查询、`tap_element`、`page_fingerprint`（**Android 专用**）
- `log` — `clear_logs`、`get_recent_crashes`、ANR/tombstone、**iOS log stream + .ips**
- `report` — sessions、报告、**状态图**（`graph_*` 一组工具）
- `analyzer`（可选）— 探索结束后做 crash dedup + .ips 解析

## 平台分支

先 `mobile.mobile_list_available_devices` 看 `platform`。下面默认 **Android**，iOS 差异见末尾"iOS 适配"小节。

## When to invoke

- "/qa"、"qa --package jko.dns.qwn.dfgt --max-steps 30"
- "自动探索一下"、"猴子测试"、"随便点点看会不会崩"
- "测一下 X app 整体有没有问题"

不要在这些场景里 invoke：
- 用户只想验证某个改动（→ devtest skill）
- 用户已经有具体 bug 复现路径（→ devtest 或直接手动复现）

## 关键概念

| 名词 | 含义 |
|---|---|
| **page_hash** | `ui.page_fingerprint` 给出的 12 位 sha1，作为"这是哪个页面"的唯一 ID |
| **element_key** | 元素的稳定标识，构造规则见下 |
| **状态图** | `pages: { hash → {visit_count, elements_seen} }` + `edges: [{from, action, to}]`，落到 `<session>/state-graph.json` |
| **覆盖** | 不同 page_hash 数量 + 总 edges 数 |
| **repro_path** | 出 crash 时记录的 step index 列表（QA 不做精简，留给 P3） |

### element_key 构造规则

按优先级取第一个非空的：
```
resource_id                    例: "jko.dns.qwn.dfgt:id/btn"
"text:" + text                 例: "text:点我"
"label:" + content_desc        例: "label:返回"
"class:" + class + ":" + bounds  例: "class:android.widget.ImageView:[120,200][240,320]"
```

## 输入与默认

| 参数 | 默认 | 说明 |
|---|---|---|
| `--package` | （必需） | 被测 app 包名；如未提供，用 `mobile_list_apps` 让用户选 |
| `--max-steps` | 30 | 硬上限，防失控 |
| `--duration-min` | 10 | 软上限（分钟） |
| `--device` | 自动 | 单设备时省略，多设备必填 |
| `--blocklist` | 见下 | 不要点击的元素 text/id 子串 |

**默认 blocklist**（永远不点）：
- 含 "退出"、"注销"、"删除账户"、"卸载"、"恢复出厂" 的元素
- 含 "Logout"、"Delete Account"、"Sign Out"、"Uninstall" 的元素
- 系统通知栏、Home 按钮（避免离开 app）
- 任何 `package` ≠ 被测包名 的元素（除非是必要的权限弹窗）

## 工作流

### Phase 0 · 准备

```
1. mobile.mobile_list_available_devices → 选设备
2. mobile.mobile_terminate_app(package=<pkg>)  ← 确保干净启动
3. report.start_session(name="qa-<pkg-suffix>", extra={package, max_steps, ...})
4. log.start_capture(session_id, session_dir)
5. mobile.mobile_launch_app(package=<pkg>)
6. （等 2 秒）
```

### Phase 1 · 主循环（每一步）

```
step = 1
loop:
  if step > max_steps: break
  if elapsed_min > duration_min: break

  # A. 观察当前页
  hierarchy = ui.dump_hierarchy(only_visible=true)
  if hierarchy.isError && hierarchy.reason === "ui_busy":
      # Flutter 重绘 / 视频 / 持续动画 — 当前页本步走截图（见 Phase 1.5）
      # 注意：不要每步都试 dump，浪费时间。这一页接下来都走截图，直到 page_hash 变
      page_busy = true
  elif hierarchy.count < 5:
      # 元素稀疏（疑似 WebView / 自绘） — 同走截图
      page_busy = true

  fp = ui.page_fingerprint
  current_hash = fp.hash

  # B. 截图存证
  mobile.mobile_save_screenshot(saveTo=/tmp/qa_<step>.png)

  # C. 记录页面
  report.graph_record_page(
    session_id, page_hash=current_hash,
    summary=<最 obvious 的 text / 1-2 个 resource_id 拼成的人类描述>,
    screenshot=relative path
  )

  # D. 检查刚才有没有崩（先于点击）
  crashes = log.get_recent_crashes(package=<pkg>)
  if crashes.count > 0:
      handle_crash(crashes, step, repro_path_so_far)
      restart_app()
      continue

  # E. 从层级里选可点元素
  clickable = hierarchy.elements
    .filter(e => e.clickable === true)
    .filter(e => e.package === <pkg> || e.package === "")  # 排除系统 UI
    .filter(e => 不在 blocklist 里)
    .map(e => ({
       key: element_key(e),
       strategy: 优先 identifier，否则 text，否则 label,
       desc: <text> or <resource_id 末段> or "(no label)"
    }))

  candidate_keys = clickable.map(c => c.key)

  # F. 让状态图挑一个没点过的
  picked = report.graph_pick_next_unseen(session_id, current_hash, candidate_keys)
  if picked === null:
      # 当前页所有元素都点过 → 退一步或重启
      handle_exhausted(current_hash)
      continue

  target = clickable.find(c => c.key === picked)

  # G. 执行点击
  log.clear_logs
  step_record_index = step
  tap_result = ui.tap_element(strategies=[target.strategy], settle_ms=1500)
  if !tap_result.tapped:
      # 兜底：截图 + vision + mobile.click_on_screen_at_coordinates
      [fallback path]
      via_screenshot = true

  # H. 标记已点
  report.graph_mark_element_seen(session_id, page_hash=current_hash, element_key=picked)

  # I. 观察新页
  next_hash = ui.page_fingerprint.hash
  if next_hash !== current_hash:
      report.graph_record_edge(
        session_id,
        from_hash=current_hash,
        action="click " + target.desc,
        to_hash=next_hash
      )

  # J. 抓 crash
  crashes = log.get_recent_crashes(package=<pkg>)
  if crashes.count > 0:
      report.record_crash(...)
      handle_crash → restart_app
      continue

  # K. 记 step
  mobile.mobile_save_screenshot(saveTo=/tmp/qa_<step>_after.png)
  report.record_step(
    session_id, action="click " + target.desc + " on " + current_hash,
    result="ok", screenshot_src=/tmp/qa_<step>_after.png,
    notes="page " + current_hash + " → " + next_hash + (via_screenshot ? " [via_screenshot]" : "")
  )

  step++
```

### Phase 1.5 · 截图兜底（层级失效）

触发条件之一即可：
- `ui.dump_hierarchy` 返回 `{ok:false, reason:"ui_busy"}`（Flutter 持续重绘）
- `ui.dump_hierarchy` 返回的有意义元素 < 5（疑似 Flutter Canvas / WebView）
- `ui.tap_element` 返回 `tapped:false`（目标元素不在层级里）

**重要**：一旦切到截图模式，**本页剩余的操作都走截图**——不要每步都重试 dump。等 page_hash 变化（已知跳转到新页面）后，再试一次 dump 看新页是否静态。

```
1. mobile.mobile_take_screenshot
2. 视觉识别可点位置（按钮、卡片、链接），给出 3-5 个候选坐标
3. 用 graph_pick_next_unseen 让状态图筛掉点过的（用 element_key = "bounds:x,y,..." 作为 key）
4. mobile.mobile_click_on_screen_at_coordinates(x, y)
5. step record 里标 via_screenshot=true
```

注意：截图兜底**不可复现性高**，要在报告里显式警告。

### Phase 2 · 异常处理

#### Crash / ANR
```
on crash:
  1. 取 crashes[0]，提取 signature/kind/stack
  2. log.save_log_snippet → <session>/crashes/c<n>.log
  3. report.record_crash(
       signature, kind, stack,
       step_index=本步, repro_path=[1..本步]
     )
  4. mobile.mobile_terminate_app + mobile.mobile_launch_app
  5. （等 3 秒）
  6. 继续主循环（让探索摆脱崩溃路径）
```

#### 元素都点过了（exhausted）
```
on exhausted:
  1. mobile.mobile_press_button("BACK")
  2. 等 1 秒，再 fingerprint
  3. 如果回到了访问过的页面，循环继续
  4. 如果连续 3 次 exhausted/back 仍困住，结束探索
```

#### 离开了被测 app
```
if hierarchy.package !== <pkg>:
  mobile.mobile_press_button("BACK")
  或 mobile.mobile_launch_app(<pkg>)
  step 计数 +1 但不算覆盖
```

#### 权限弹窗
```
检测 resource_id 含 "permission" 或 text 含 "允许 / 始终允许 / Allow"：
  点击 "允许" 一次 → 记到 elements_seen，下次自然不会再点
```

### Phase 3 · 收尾

```
1. log.stop_capture(session_id)
2. report.graph_summary(session_id) → 拿覆盖数据
3. report.finalize(
     session_id,
     status = (crashes > 0 ? "failed" : "passed"),
     summary = <一段话>
   )
4. 终端打印简短总结
```

## 工具选择规则（与 devtest 一致）

1. **点击 / 输入：层级优先 → 截图兜底**
   - `ui.tap_element(strategies=[{by: "identifier"}, {by: "text"}])` 是默认
   - 失败才走 `mobile.mobile_click_on_screen_at_coordinates`
2. **页面状态**：永远用 `ui.page_fingerprint`，不依赖截图哈希
3. **每步必清 log**：保证 `get_recent_crashes` 拿到的只是本步影响

## 输出格式

终端打印**短结论**，类似：

```
🔍 QA 探索完成 (jko.dns.qwn.dfgt)
  - 步数: 24/30
  - 页面: 5 个独立（fingerprint 不同）
  - 转移: 18 条 edge
  - 时长: 6m 12s
  - 🐛 发现 2 次 crash
    - c1: NullPointerException @ LoginActivity (在 step 11)
    - c2: ANR after rotation (在 step 19)
  - 报告: workspace/sessions/2026-05-14_qa_xxxxx/report.md
```

或全绿：
```
✅ QA 探索完成，无 crash
  - 步数: 30/30
  - 页面: 7 个独立
  - 转移: 24 条
  - 报告: ...
```

## Crash 详情归档

每个 crash 在 finalize 后位于 session 目录：
```
<session>/
├── state-graph.json      ← 完整状态图，可用于后续 P3 复现路径精简
├── crashes/
│   ├── c1.stack.txt
│   └── c1.log
├── steps/
│   ├── 001.png + 001_after.png + 001.log
│   ├── 002.png + 002_after.png + 002.log
│   └── ...
└── report.md
```

## iOS 适配（Simulator 限定）

如果 `mobile_list_available_devices` 返回 `platform === "ios"`：

**Phase 0 改造**：
- 用 `mobile.mobile_launch_app(packageName=<bundle_id>)` 启动（注意是 bundle_id，不是包名）
- 用 `log.ios_start_capture(session_id, session_dir, predicate='process == "<proc_name>"')` 抓 log
  - 不能 `clear_logs`；改用"记下起始时间戳"+ `since_minutes`

**Phase 1 主循环改造**：
- 用 `mobile.mobile_list_elements_on_screen` 拿元素（**没有 ui.dump_hierarchy**）
- **page_hash 也得自己算**：把 elements 里的 `identifier`+`text`+`label` 排序拼起来 sha1 取前 12 位
- 点击：`mobile.mobile_click_on_screen_at_coordinates(element.center.x, element.center.y)`
- 输入：`mobile.mobile_type_keys`
- crash 检测：
  ```
  log.ios_list_ips(since_minutes=2, bundle_id=<bundle_id>)
  for each new ips:
     analyzer.parse_ips_file(file_path) → {fingerprint, label, top_frames, signal, exception_type}
     report.record_crash(signature=label, kind="ios", stack=raw text, repro_path=[...])
  ```

**element_key 构造（iOS）**：
- 优先 `identifier`（accessibility identifier）
- 否则 `"text:" + element.text`
- 否则 `"label:" + element.label`
- 最差兜底 `"bounds:" + bbox`

**Phase 3 收尾**：
- `log.ios_pull_ips(out_dir=<session>/crashes/, since_minutes=<本次时长>)` 把这次的 .ips 都拉过来
- 之后 `analyzer.analyze_session` 仍可用，但需要 stack 字段——iOS 走的话用 `parse_ips_file` 得到的 raw text 写入 `record_crash` 的 `stack` 字段，dedup 才能工作

iOS 限制：
- 没有 idb → 层级里"没暴露 accessibility 的元素"完全摸不到
- Simulator 启动慢、重启 app 比 Android 慢 2-3 倍

## Do / Don't

✅ Do
- 严格按 `element_key` 规则生成 key（不要直接用 bounds 当 key，bounds 会随版本变）
- 每点完一个就 `mark_element_seen`
- crash 后立即重启 app，不要在崩溃路径上继续摸
- 报告里写清楚 "via_screenshot" 步骤的不可复现性

❌ Don't
- 不要无脑 tap 同一个元素直到 max_steps（要相信状态图说"没新东西可点"了）
- 不要点 blocklist 里的元素（退出/卸载/通知栏）
- 不要忘 stop_capture，logcat 会一直跑
- 不要在每步 dump 整个层级到对话里（输出会爆炸）—— `dump_hierarchy` 返回值只取需要的字段
- 不要尝试输入文本除非显式触发了输入框流程（QA 阶段保守，主要点）

## 例：理想形态

用户："/qa --package jko.dns.qwn.dfgt --max-steps 15"

```
[Phase 0] 设备 V2353DA，包 jko.dns.qwn.dfgt 启动 ✓
[Phase 1] 探索中...
  Step 1: page=a3f2 (主页) → 点 "点我" → page=a3f2 (没换页，记 elements_seen)
  Step 2: page=a3f2 → 点 "tvText" → page=a3f2
  Step 3: page=a3f2 所有元素探完 → BACK → 退出 app → relaunch
  Step 4: page=a3f2 → 点 RecyclerView item 1 → ...
  ...
  Step 9: 检测到 FATAL EXCEPTION → c1 归档 → 重启
  Step 10: page=a3f2 → ...
  Step 15: 上限，结束

🔍 jko.dns.qwn.dfgt 探索完成
  - 15 步 / 3 页 / 8 edges / 1 crash
  - c1: NullPointerException at MainActivity$onCreate$3.invoke:79
  - 报告: workspace/sessions/2026-05-14_xxxx_qa-dfgt/report.md
```
