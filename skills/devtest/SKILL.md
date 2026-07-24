---
name: devtest
description: This skill should be used when the user asks to "test what I just changed", "/devtest", "smoke test my change", "verify my latest commit", "测一下我刚改的", "看看刚改的功能能不能跑", "跑一下登录看看", or similar requests to verify a recent code change against a running Android device. The skill reads the git diff, infers the affected UI surface, generates a focused test plan, drives the app via ui-mcp + mobile-mcp, captures logs via log-mcp, and produces a Markdown report via report-mcp.
version: 0.1.0
argument-hint: "[--scope <feature>] [--device <serial>]"
---

# DevTest — 开发自测 Agent

把"我刚改的代码"和"app 上还能跑通吗"接起来。30 秒到几分钟内给出结论 + 报告。

依赖四个 MCP：
- `mobile`（@mobilenext/mobile-mcp）— 启停 app、截图、**iOS 层级查询兜底**
- `ui`（本仓 ui-mcp）— uiautomator 层级 + 智能点击（**Android 默认**）
- `log`（本仓 log-mcp）— logcat / ANR / tombstone / **iOS log stream + .ips**
- `report`（本仓 report-mcp）— session 与 Markdown 报告
- `analyzer`（本仓 analyzer-mcp，可选）— iOS .ips 解析 + signature

## 平台分支（Android vs iOS）

第一件事：`mobile.mobile_list_available_devices` 拿设备列表，看 `platform` 字段：

iOS 再看 `type` 字段：`simulator` 还是 `real`（真机）。log/crash 两者工具不同，见下表。

| 步骤 | Android | iOS Simulator | iOS 真机 (type=real) |
|---|---|---|---|
| 找元素 | `ui.tap_element` / `ui.dump_hierarchy` (层级首选) | `mobile.mobile_list_elements_on_screen` | 同左 |
| 点击 | `ui.tap_element` | `mobile.mobile_click_on_screen_at_coordinates`（见下方坐标注意） | 同左 |
| 输入文本 | `ui.input_text` | `mobile.mobile_type_keys` | 同左 |
| 起 log 抓取 | `log.start_capture` | `log.ios_start_capture`（predicate 过滤包名） | `log.ios_device_start_capture`（process_match 过滤） |
| 清 log 缓冲 | `log.clear_logs` (adb logcat -c) | iOS 无对应；用 `since_minutes` 时间窗口 | 同左 |
| 抓 crash | `log.get_recent_crashes` | `log.ios_list_ips` → `analyzer.parse_ips_file` | `log.ios_pull_device_crashes(filter=<proc>, since_minutes=N)` → 只看返回的 `files[]` |
| 拉 crash 文件 | `log.pull_tombstones` / `pull_anr_traces` | `log.ios_pull_ips` → `<session>/crashes/` | `log.ios_pull_device_crashes(filter=<proc>, since_minutes=N)` → `<session>/crashes/` |
| 列设备 | `log.list_devices` | `log.ios_list_simulators` | `log.ios_list_devices` |

⚠️ **iOS 点击坐标陷阱**：`mobile_list_elements_on_screen` 的 `coordinates` 是元素**左上角 x,y + width,height，没有 `.center`**。必须自己算中心 `(x+width/2, y+height/2)` 再点，否则点在边缘 WDA 报成功但无反应。

iOS 限制：
- **没有稳定的层级查询接口**给 ui-mcp 用。所有 iOS UI 操作走 mobile-mcp。
- mobile-mcp 在 iOS 上靠 accessibility tree（`mobile_list_elements_on_screen`），多数 native UIKit/SwiftUI 元素能拿到，自绘视图同 Android 一样失效。
- 真机需先装 WDA + go-ios（见 `docs/IOS.md`）；崩溃不落 Mac 本地，必须 `ios_pull_device_crashes` 从设备拉。

## When to invoke

用户说下列任意一句：
- "测一下我刚改的 XX"、"跑一下登录看看"、"看看刚改的能不能用"
- `/devtest`、`devtest --scope login`
- "smoke test my change"、"verify my latest commit"
- "我刚提交了 ××，能不能验一下"

不要在这些场景里 invoke：
- 用户问"这段代码是啥意思"（解释代码 ≠ 测试）
- 没有改动也要跑（直接告诉用户没有 diff，问要不要指定 scope）
- 用户要求批量回归（让用户走 P2 QA skill，或导出 Maestro 脚本）

## 工作流（5 个阶段）

### Phase 1 · 读变更

按优先级取一份 diff：

1. `git diff --staged --stat` → 暂存区有改动？用这个
2. `git diff HEAD~1 --stat` → 否则用上一个 commit 的改动
3. 如果用户给了 `--scope`，跳过 diff，直接按 scope 走 Phase 2

提取信息：
- 改动文件列表
- 最近一条 commit message（`git log -1 --pretty=%s%n%b`）
- 改动行数（用来判断风险面）

> 只关心移动端代码：`.kt`/`.java`/`.xml`（Android）、`.dart`（Flutter）、`.tsx`/`.ts`（RN）、`.vue`（uni-app）、`.swift`（iOS - Phase 4 后才支持）。其它文件警告但不阻断。

### Phase 2 · 推断 UI 影响面

读改动文件，识别这些信号映射到 UI 页面：

| 信号 | 类型 | 例子 |
|---|---|---|
| `class XxxActivity` / `XxxFragment` | Android | LoginActivity → 登录页 |
| `@Composable fun XxxScreen` | Compose | LoginScreen |
| `class XxxViewController` | iOS | LoginVC |
| `class XxxPage extends StatelessWidget` | Flutter | LoginPage |
| layout xml 文件名 | Android xml | activity_login.xml |
| route 配置 | RN/Flutter | `routes: { '/login': ... }` |
| `R.id.xxx` 或 `findViewById` 的 id | Android | `R.id.btn_login` → 登录按钮 |

**输出**："本次改动可能影响：登录页、验证码页。**重点测试**：手机号登录、获取验证码、错误手机号提示。"

不确定时**问用户**："改动看起来涉及 X 和 Y，要先测哪个？"

### Phase 3 · 生成测试计划

通常包含：
- **1 条 happy path**（最常见的成功路径）
- **1-2 条 edge case**（错误输入 / 网络异常 / 空状态）
- 步骤上限：默认 30 步（防失控），需要更多时显式告知用户

把计划写到 `session/plan.md`（用 `report.record_step` 的 `notes` 或单独写文件均可）。

如果用户给了 `test-plans/*.md`，跳过自动生成，按文件走。

### Phase 4 · 执行（关键循环）

**前置一次**：
```
1. mobile.mobile_list_available_devices   → 选设备
2. report.start_session(name=<feature>)   → 拿 session_id 和 session_dir
3. log.start_capture(session_id, session_dir)  → 后台抓 logcat
4. mobile.mobile_launch_app(packageName=<pkg>)
```

**每一步循环**（执行 N 次直到测试计划走完）：

```
A. log.clear_logs   ← 干净起点
B. 执行操作（按下面的工具选择规则）
C. （可选）等待 0.5–2 秒让 UI 稳定
D. mobile.mobile_save_screenshot → /tmp/devtest_<idx>.png
E. log.get_recent_crashes   ← 检查这一步引入的崩溃
F. report.record_step(
     session_id=...,
     action=<本步描述>,
     result=<ok|fail|skip>,
     screenshot_src=/tmp/devtest_<idx>.png,
     notes=<观察或 via_screenshot=true>
   )
G. 若 step 5 返回 count>0:
     report.record_crash(
       session_id=...,
       signature=<crashes[0].signature>,
       kind=<crashes[0].kind>,
       stack=<crashes[0].stack>,
       step_index=<本步 index>,
       repro_path=<目前为止所有步骤的 index 列表>
     )
   决策：致命 crash → 中止；非致命 ANR → 警告并继续。
```

**收尾**：
```
N. log.stop_capture(session_id)
N+1. report.finalize(
       session_id=...,
       status=<passed|failed>,
       summary=<一段话总结>
     )
```

### Phase 5 · 出结论

终端 / 对话里给出**短结论**（不要 dump 整个报告）：

```
✅ 登录功能测试 (6/6 通过, 18s)
   ✓ 启动 → 登录页
   ✓ 输入手机号 13800138000
   ✓ 点击「获取验证码」
   ✓ 输入验证码
   ✓ 跳转首页
   ✓ 无崩溃 / 无 ANR
报告: workspace/sessions/2026-05-14_xxx/report.md
```

或失败时：
```
❌ 登录功能 (3/5 步, 失败于 Step 4)
   ✗ 点击「获取验证码」→ NullPointerException @ LoginActivity.onClick:42
   ▶ 复现路径: launch → 输手机号 → 点验证码
报告: workspace/sessions/2026-05-14_xxx/report.md
```

## 工具选择规则（最重要）

### 点击 / 输入：层级优先 → 截图兜底

```
1. ui.tap_element({
     strategies: [
       { by: "identifier", value: "<resource-id>" },
       { by: "text", value: "<可见文本>" },
       { by: "label", value: "<content-desc>" }
     ],
     settle_ms: 500
   })

2. 若 response.tapped === false 或 isError + reason === "ui_busy":
     a. mobile.mobile_take_screenshot
     b. 视觉识别目标坐标
     c. mobile.mobile_click_on_screen_at_coordinates(x, y)
     d. 在 record_step 的 notes 写 "via_screenshot=true"
```

**永远不要**先截图再让 vision 识别，除非层级路径失败。原因：可复现性。

### Flutter / 动画页面（关键）

如果调 `ui.dump_hierarchy` 或 `ui.tap_element` 返回如下结构化错误：
```json
{ "ok": false, "reason": "ui_busy", "hint": "...", "fallback": "..." }
```
说明 app 在持续重绘（典型 Flutter / 视频播放 / 进度动画），uiautomator 拿不到 idle 状态。**当前页面所有后续操作都走截图模式**（不要每次都试 dump，浪费 5 秒/次）：

- 截图驱动：`mobile.mobile_take_screenshot` → 视觉识别 → `mobile.mobile_click_on_screen_at_coordinates`
- 文本输入：仍可用 `adb shell input text` 等价物（mobile-mcp 的 `mobile_type_keys`）—— 不依赖 uiautomator
- 在页面发生明显跳转后（点了 Next / Back / Submit）重新探一次 `dump_hierarchy`，新页面可能是静态的

### 输入文本

```
ui.input_text({
  strategies: [{ by: "identifier", value: "..." }],
  text: "13800138000"
})
```

中文/特殊字符若打不进去（部分 IME 不兼容 `adb input text`），降级用 `mobile_type_keys`。

### 等元素出现

页面跳转后**不要硬 sleep**：

```
ui.wait_for_element({
  strategies: [{ by: "text", value: "首页" }],
  timeout_ms: 5000
})
```

### 看页面长啥样

优先 `ui.dump_hierarchy({ only_visible: true })`，截图只在以下场景用：
- 层级元素数 < 5（疑似 Flutter / Compose Canvas / WebView）
- 需要给用户/报告留视觉证据
- 视觉兜底定位

## Crash 检测策略

每步操作后必调 `log.get_recent_crashes`。关键字命中（FATAL EXCEPTION / ANR / Native）即视为失败。

复现路径计算：
- DevTest 阶段简化：**所有已执行步骤的 index 列表**就是 repro_path，不做 delta-debug 精简（那是 P3 QA skill 的活）。

崩溃后默认中止本次测试，写入 report.record_crash 并 finalize 为 `failed`。
如果用户加了 `--continue-on-crash`，重启 app 接着跑剩余步骤。

## 失败兜底

| 现象 | 应对 |
|---|---|
| 找不到任何设备 | 让用户检查 `adb devices`，中止 |
| ui.tap 找不到目标且截图兜底也识别不出 | record_step(result=fail, notes="目标未找到"), 给用户报告并中止 |
| logcat 抓出大量噪音但无 FATAL | 视为通过，但在报告里附 "logcat 异常多" 的警告 |
| app 启动后立刻崩 | record_crash, finalize(failed), 显示 stack |
| Phase 1 没找到 git diff | 提示用户："没检测到改动，想测哪个功能？请用 --scope 指定" |

## 报告内容约定

调 `report.finalize` 时 `summary` 字段写一段简洁文字，包含：
1. 本次测什么（"验证刚改的登录流程"）
2. 改动定位（提到的文件 / commit）
3. 结果概览（通过/失败步数）
4. 失败时：根因（NPE / ANR）+ 复现步骤摘要

## Example session（理想形态）

用户："测一下我刚改的登录"

```
[Phase 1] git diff HEAD~1 →
  - app/src/main/java/com/example/LoginActivity.kt (12 行)
  - app/src/main/res/layout/activity_login.xml (3 行)
  commit: "fix: 修复手机号校验逻辑"

[Phase 2] 影响面：登录页（LoginActivity）。
  重点：手机号校验、获取验证码按钮可用性。

[Phase 3] 测试计划:
  1. 启动 app → 进登录页
  2. 输入合法手机号 → 验证码按钮亮起
  3. 输入非法手机号（10 位）→ 提示错误
  4. 点击「获取验证码」→ 进入验证码页

[Phase 4] 执行中...
  Step 1/4: launch app ✓
  Step 2/4: input phone "13800138000" via identifier ✓
  Step 3/4: input phone "1380013800" → 期望错误提示 ✓
  Step 4/4: clear & retype + click button ✓

[Phase 5] ✅ 4/4 通过, 14s, 0 crash
报告: workspace/sessions/2026-05-14_153022_login/report.md
```

## Do / Don't

✅ Do
- 操作前清 log
- 优先 ui-mcp 层级
- 每步截图 + crash 检查
- 失败立刻归档 + finalize
- 给用户**简短**结论 + 报告路径

❌ Don't
- 不要直接调 `mobile.click_on_screen_at_coordinates` 跳过层级查询
- 不要忘记 finalize（session 会卡在 running 状态）
- 不要 dump 整个报告到对话里（长，噪音大）
- 不要在崩溃后继续点击直到 step 上限
- 不要在没 diff 也没 scope 时瞎猜要测啥
