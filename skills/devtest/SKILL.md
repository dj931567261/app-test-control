---
name: devtest
description: This skill should be used when the user asks to "test what I just changed", "/devtest", "smoke test my change", "verify my latest commit", "测一下我刚改的", "看看刚改的功能能不能跑", "跑一下登录看看", or similar requests to verify a recent code change against a running Android or iOS device. The skill reads the git diff, infers the affected UI surface, generates a focused test plan, drives the app via ui-mcp + mobile-mcp, captures logs via log-mcp, and produces a Markdown report via report-mcp.
version: 0.1.0
argument-hint: "[--scope <feature>] [--device <serial>] [--proc-name <name>]"
---

# DevTest — 开发自测 Agent

把"我刚改的代码"和"app 上还能跑通吗"接起来。30 秒到几分钟内给出结论 + 报告。

依赖五个 MCP：
- `mobile`（@mobilenext/mobile-mcp）— 启停 app、截图、**iOS 层级查询兜底**
- `ui`（本仓 ui-mcp）— uiautomator 层级 + 智能点击（**Android 默认**）
- `log`（本仓 log-mcp）— logcat / ANR / tombstone / **iOS log stream + .ips**
- `report`（本仓 report-mcp）— session 与 Markdown 报告
- `analyzer`（本仓 analyzer-mcp）— iOS `.ips` 解析必需；其他平台可用于 crash 去重

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
| 抓 crash | `log.get_recent_crashes` | `log.ios_list_ips` → `analyzer.parse_ips_file` | `log.ios_pull_device_crashes(filter=<可靠 proc 才传>, since_minutes=N)` → 只看返回的 `files[]` |
| 拉 crash 文件 | `log.pull_tombstones` / `pull_anr_traces` | `log.ios_pull_ips` → `<session>/crashes/` | `log.ios_pull_device_crashes(filter=<可靠 proc 才传>, since_minutes=N)` → `<session>/crashes/` |
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
1. mobile.mobile_list_available_devices → 选出 device_id、platform、type
2. iOS 解析 bundle_id 与大小写准确的 proc_name：
   --proc-name 显式参数
   → 已展开的 Info.plist CFBundleExecutable / Xcode EXECUTABLE_NAME
   → Simulator 的 ios_list_ips 结果中 `entry.bundle_id === target_bundle_id`
     且 `entry.proc_name !== "unknown"` 的最近 summary.proc_name
   只接受可靠结果。设备 app 的显示名只能作提示，不能默认等同可执行进程名。
   PRODUCT_NAME 也可能与 executable 分离，不能单独作为真机 filter。
   若仍未知，令 proc_name=null，并在报告中警告会使用无进程过滤的降级路径。
3. report.start_session(
     name=<feature>,
     extra={package:<pkg_or_bundle_id>, device_id, platform, type,
            proc_name, commit:<commit>, changed_files:<files>}
   ) → 拿 session_id 和 session_dir
4. 按平台启动日志抓取：
   Android:
     log.start_capture(session_id, session_dir, device=device_id)
   iOS Simulator:
     log.ios_start_capture(session_id, session_dir,
                           simulator_udid=device_id,
                           predicate=<proc_name ? 'process == "<proc_name>"' : 省略>)
   iOS 真机:
     log.ios_device_start_capture(session_id, session_dir,
                                  device=device_id,
                                  process_match=<proc_name ? [proc_name] : 省略>)
     # 返回 max_bytes（默认 256 MiB）；达到上限会自动停止并留下
     # status=failed, reason=limit_reached，不能继续假装日志仍在抓。
   启动后立即调 log.list_captures()，确认该 session_id 的 status="running"；
   否则 finalize(failed) 并中止。
5. 创建平台 crash 去重状态：
   - iOS 记录 session_started_at，并建立 seen_ips_paths：
     Simulator 调 ios_list_ips(bundle_id=<bundle_id>, since_minutes=5)；其
     `files` 是对象数组，把 `files.map(entry => entry.path)` 加入 baseline。
     真机调 ios_pull_device_crashes(device=device_id,
                                      out_dir=<session>/crashes/raw,
                                      filter=<proc_name 已知才传，否则省略>,
                                      since_minutes=5)，把 files 加入 baseline。
     baseline 只标记“已存在”，不要记成这次测试产生的 crash。
   - Android 创建 handled_android_crashes=Set()，key 取 kind+signature+stack；
     用于区分“上一轮 E 已处理”与“随后延迟出现”的记录。
6. Android 先调 log.clear_logs(device=device_id)，然后：
   mobile.mobile_launch_app(device=device_id, packageName=<pkg_or_bundle_id>)
7. 把 launch 作为第一个正式 step：立即截图并执行下方 E 的平台 crash 检查，
   然后 record_step（notes 写 action_type=launch），明确设
   last_completed_step=1，后续操作从 step_index=2 开始。若启动即崩，先
   record_crash + finalize(failed) 并中止；
   不要在下一次循环开头清掉 launch crash，也不要把它归因给后续点击。
```

**每一步循环**（执行 N 次直到测试计划走完）：

```
A. 操作前先执行一次与 E 相同的平台 crash 查询：
   先调 log.list_captures() 检查本 session：只接受 status="running"；若是
   failed/stopping 或记录不存在，把 reason/error（stopping 写“日志抓取正在停止”）
   写入报告并中止，不能继续产生无日志证据的步骤。
   - iOS 依靠 seen_ips_paths，只处理新路径；
   - Android 忽略 handled_android_crashes 中上一轮 E 已处理的记录。
   若出现新 crash，归因 last_completed_step 并先处理/恢复，不能继续操作后再误归因。
   查询完成后仅 Android 调 log.clear_logs(device=device_id)，并清空
   handled_android_crashes；iOS 不清系统日志。
B. 执行操作（按下面的工具选择规则，所有 mobile 调用都传 device=device_id）
C. （可选）等待 0.5–2 秒让 UI 稳定
D. mobile.mobile_save_screenshot(device=device_id, saveTo=/tmp/devtest_<idx>.png)
E. 按平台检查本步 crash：
   Android:
     crashes = log.get_recent_crashes(device=device_id, package=<pkg>)
     处理前把每条 kind+signature+stack 加入 handled_android_crashes
   iOS Simulator:
     window = max(1, ceil((now-session_started_at)/60s) + 2)
     summaries = log.ios_list_ips(bundle_id=<bundle_id>, since_minutes=window).files
     ips_paths = summaries.map(entry => entry.path)
   iOS 真机:
     window = max(1, ceil((now-session_started_at)/60s) + 2)
     ips_paths = log.ios_pull_device_crashes(
       device=device_id, out_dir=<session>/crashes/raw,
       filter=<proc_name 已知才传，否则省略>, since_minutes=window
     ).files
   iOS 只处理 ips_paths 中不在 seen_ips_paths 的字符串路径；处理前先加入 Set，
   避免下步重复。不要把 Simulator 的 summary 对象直接传给 parse_ips_file。
   对每个新文件调 analyzer.parse_ips_file(file_path)，使用其
   {fingerprint,label,kind,stack,bundle_id,proc_name}。若 parsed.bundle_id 存在且不等于
   目标 bundle_id，跳过该报告；proc_name 未知且报告也没有 bundle_id 时只归档并警告，
   不把它静默算成目标 app crash。stack 是可供 session dedup 的规范文本。
F. report.record_step(
     session_id=...,
     action=<本步描述>,
     result=<ok|fail|skip>,
     screenshot_src=/tmp/devtest_<idx>.png,
     notes=JSON.stringify({
       replay: {
         action_type: <tap|input_text|press_button|launch>,
         element_key: <本步稳定 key（launch 可省略）>,
         input_value: <仅 input_text>,
         button: <仅 press_button>
       },
       observation: <观察>,
       via_screenshot: <boolean>
     })
   )
   record_step 成功后立即设 last_completed_step=<本步 index>；不要在操作前预先更新。
G. 若 E 检出 crash：
     report.record_crash(
       session_id=...,
       signature=<Android signature 或 iOS parsed.label>,
       kind=<crash.kind>,
       stack=<crash.stack>,
       step_index=<本步 index>,
       repro_path=<目前为止所有步骤的 index 列表>,
       log_full_src=<iOS 原始 file_path；Android 可省略>
     )
   决策：致命 crash → 中止；非致命 ANR → 警告并继续。
```

**收尾**：
```
N. 再执行一次 Phase 4-E 的平台 crash 查询，只处理尚未处理的结果，
   并归因到 last_completed_step。这一步用于接住最后一个操作后延迟
   落盘的 Android crash / iOS `.ips`。
N+1. capture_stop = log.stop_capture(session_id)
     若 capture_stop.status == "failed"，把 reason/error 写入 summary 并将
     本次结果设为 failed；只有 stopped=true 才算正常收尾。
N+2. report.finalize(
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

每个 step 的 `record_step.notes` 必须是单行 JSON，并把机器可读字段放进
`replay` 对象；不要用空格分隔的 `key=value`（文本本身可能含空格或 `=`）：

```json
{
  "replay": {
    "action_type": "tap",
    "element_key": "text:Sign in"
  },
  "observation": "跳转登录页",
  "via_screenshot": false
}
```

identifier 的 key 直接用 resource-id；text 用 `text:<文本>`；label 用
`label:<accessibility label>`。输入动作在 replay 中增加 `input_value`，按键动作
增加 `button`。不要只写人类描述，否则 minimize 无法无损恢复原操作。

### 点击 / 输入：层级优先 → 截图兜底

```
1. ui.tap_element({
     device: device_id,
     strategies: [
       { by: "identifier", value: "<resource-id>" },
       { by: "text", value: "<可见文本>" },
       { by: "label", value: "<content-desc>" }
     ],
     settle_ms: 500
   })

2. 若 response.tapped === false 或 isError + reason === "ui_busy":
     a. mobile.mobile_take_screenshot(device=device_id)
     b. 视觉识别目标坐标
     c. mobile.mobile_click_on_screen_at_coordinates(device=device_id, x, y)
     d. 在 record_step 的 notes JSON 写 `via_screenshot:true`
```

**永远不要**先截图再让 vision 识别，除非层级路径失败。原因：可复现性。

### Flutter / 动画页面（关键）

如果调 `ui.dump_hierarchy` 或 `ui.tap_element` 返回如下结构化错误：
```json
{ "ok": false, "reason": "ui_busy", "hint": "...", "fallback": "..." }
```
说明 app 在持续重绘（典型 Flutter / 视频播放 / 进度动画），uiautomator 拿不到 idle 状态。**当前页面所有后续操作都走截图模式**（不要每次都试 dump，浪费 5 秒/次）：

- 截图驱动：`mobile.mobile_take_screenshot(device=...)` → 视觉识别 → `mobile.mobile_click_on_screen_at_coordinates(device=..., x, y)`
- 文本输入：仍可用 `adb shell input text` 等价物（`mobile.mobile_type_keys({device, text, submit:false})`）—— 不依赖 uiautomator
- 在页面发生明显跳转后（点了 Next / Back / Submit）重新探一次 `dump_hierarchy`，新页面可能是静态的

### 输入文本

```
ui.input_text({
  device: device_id,
  strategies: [{ by: "identifier", value: "..." }],
  text: "13800138000"
})
```

中文/特殊字符若打不进去（部分 IME 不兼容 `adb input text`），降级用 `mobile.mobile_type_keys({device:device_id, text, submit:false})`。

### 等元素出现

页面跳转后**不要硬 sleep**：

```
ui.wait_for_element({
  device: device_id,
  strategies: [{ by: "text", value: "首页" }],
  timeout_ms: 5000
})
```

### 看页面长啥样

优先 `ui.dump_hierarchy({ device: device_id, only_visible: true })`，截图只在以下场景用：
- 层级元素数 < 5（疑似 Flutter / Compose Canvas / WebView）
- 需要给用户/报告留视觉证据
- 视觉兜底定位

## Crash 检测策略

每步操作后必须走 Phase 4-E 的平台分支：Android 调 `get_recent_crashes`；iOS 只处理不在 `seen_ips_paths` 的新 `.ips`。Android 命中 FATAL/ANR/Native，或 iOS 成功解析出新报告，都视为失败。

复现路径计算：
- DevTest 阶段简化：**所有已执行步骤的 index 列表**就是 repro_path，不做 delta-debug 精简（那是 P3 QA skill 的活）。

崩溃后默认中止本次测试，写入 report.record_crash 并 finalize 为 `failed`。
如果用户加了 `--continue-on-crash`，重启 app 接着跑剩余步骤。

## 失败兜底

| 现象 | 应对 |
|---|---|
| 找不到任何设备 | Android 检查 `adb devices`；iOS 检查 Simulator 或 go-ios/WDA，随后中止 |
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
- Android 操作前清 log；iOS 使用 baseline + `seen_ips_paths`
- 优先 ui-mcp 层级
- 每步截图 + crash 检查
- 失败立刻归档 + finalize
- 给用户**简短**结论 + 报告路径

❌ Don't
- 不要直接调 `mobile.mobile_click_on_screen_at_coordinates` 跳过层级查询
- 不要忘记 finalize（session 会卡在 running 状态）
- 不要 dump 整个报告到对话里（长，噪音大）
- 不要在崩溃后继续点击直到 step 上限
- 不要在没 diff 也没 scope 时瞎猜要测啥
