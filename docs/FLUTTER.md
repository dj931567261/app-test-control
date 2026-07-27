# Flutter App 测试适配

> 本文档基于 2026-05-14 用 `app_test_ctrl` 跑 lend_pal Flutter app 时的实测发现。

## TL;DR

| 页面类型 | 怎么操作 |
|---|---|
| **静态弹窗** (Privacy / Permission / 确认框) | ✅ `ui.tap_element by:label="文本"` 走层级，**和原生一样稳** |
| **动画/loading 页** (首页含进度条、KYC 含进度条 + 卡片) | ⚠️ uiautomator 报 `could not get idle state` → **走截图兜底** |
| **静态表单** (无动画的简单 form) | ✅ 层级优先；输入用 `adb input text`（不依赖 uiautomator） |
| **WebView / 视频 / 自绘** | ❌ 完全走截图 + 视觉 |
| **带 content-desc 的常规页** (admin 面板 / 列表 / tab 导航) | ✅ `ui.tap_element by:label="文本"` 直接命中，**无需截图** |

> **2026-07-24 重要修正（sub2api Flutter admin 面板实测）**：此前默认"看到 Flutter 就整页走截图"过于保守。实测 sub2api 的 Semantics 树完整暴露，底部 5 个 tab、按钮全有 `content-desc`，`uiautomator dump` 连续 5 次全成功。绝大多数点击**根本不用截图**。被迫走截图的真实原因是**匹配层面**的两个坑，现已在 ui-mcp 修掉，见下节。

## 两个"被迫走截图"的真实坑（已修）

### 坑 1：content-desc 带无障碍噪声，精确匹配必失配

Flutter 把 TalkBack 模板文本塞进了 `content-desc`。实测 sub2api 底部 tab 的原始值不是干净的 `概览`，而是：

```
概览\n第 1 个标签，共 5 个      # dump 里写作 概览&#10;第 1 个标签，共 5 个
监控\n第 2 个标签，共 5 个
```

指标卡更夸张，一个 View 塞了整块多行数据：`RPM(每分钟请求)\n12\nTPM\n111.4k\n...`。

而 `finder.ts` 的 `label` 策略原本是**全等匹配**。所以 `by:label="概览"` 直接失配 → skill 误判"层级没这个元素" → 退化截图。

**修复**（`finder.ts`）：`label` 策略改成 **exact 优先、normalized 兜底**——全等失配时，用"取 content-desc 首行 + trim"的归一化值再比一次。这样 `by:label="概览"` 能直接命中真实 tab，**无需改任何 skill 调用**，且 exact 永远排在 normalized 前面（对已有原生 app 零副作用）。

### 坑 2：`&#10;` 未解码，label 里是字面量而非换行

`fast-xml-parser` 默认不解码数字字符引用，`content_desc` 里留着字面量 `&#10;`（不是真 `\n`）。这不仅让归一化拿不到首行，也让报告/指纹显示乱码。

**修复**（`uiautomator.ts`）：解析时对 `text` / `content_desc` 统一 `decodeEntities`（`&#10;` → `\n`、`&#xNN;`、`&amp;/&lt;/&gt;/&quot;/&apos;`）。下游匹配、fingerprint、报告展示全部受益。

> 实测收益：sub2api 从"每步截图"变为 5 个 tab 全部 `by:label` 层级命中（点击 `监控` 后 `selected=true` 验证通过），稳定性和速度都大幅提升。

## 为什么 Flutter 在层级查询上"半通"

Flutter 默认渲染到 Canvas，但提供 **Semantics tree** 给无障碍服务。当 Android accessibility 系统查询时：

1. **静态页面**：Flutter 把 Semantics tree 暴露给 accessibility，`uiautomator dump` 能拿到每个 widget（class=`android.view.View` 或 `android.widget.Button`，文本走 `content_desc`）。
2. **持续重绘**：Flutter 的 `BuildOwner` 在每帧 vsync 触发，Android 的 `WaitForIdleTimeout` 等不到稳定状态，`uiautomator dump` 直接报错：

```
ERROR: could not get idle state.
```

`--compressed` flag 也救不了（同一个内部 idle 检查）。

### lend_pal 实测 v1（升级前一两小时）

- Privacy Agreement 弹窗（静态）：17 个元素全拿到，9 个有意义的 Flutter widget（`L` logo、`LendPal`、`Agree` button 等）
- 首页（含进度条 75% 动画 + Apply Now 圆形按钮）：dump 失败
- KYC Personal Info（含进度条 1/7）：dump 失败
- 文本输入：`adb shell input text "Test%sUser"` 正常工作（与 uiautomator 无关）

### lend_pal 实测 v2（升级后，KYC 全流程跑完）

> 2026-05-15 用 P5+ 升级后的 `ui.dump_hierarchy` 跑完了 KYC 7 步 + 主页 Under Review，0 crash，8 steps。结论：**Flutter 静态页层级查询比想象的稳得多**。

| 页面 | dump 结果 | 主要操作 strategy |
|---|---|---|
| Privacy 弹窗 | ✅ 静态，3.1s 内拿 20 个元素 | `by:label="Agree"` |
| Permission 弹窗 | ✅ 静态 | `by:label="Allow"` |
| 首页（进度条 75% 动画） | ❌ `ui_busy` 三次 retry 都失败 | 截图视觉 → `mobile_click_on_screen_at_coordinates` |
| KYC 1/7–5/7 表单页 | ✅ label / "Next Step" 按钮可层级命中 | 输入框走"label_y + 138px 偏移"截图兜底 |
| Bank Name 下拉（原生 PopupMenu） | ✅ **完整拿到 7 项** | `by:text="Chase"` |
| Date Picker（原生 widget，没走到但 dump 过） | ✅ 35 个按钮可访问 | （未触发） |
| KYC 6/7 Face Verification（静态） | ✅ 静态页 + "Start Verification" 按钮 | `by:label="Start Verification"` |
| 主页 Under Review | ❌（仍然有进度条动画） | 截图兜底 |

#### 升级后能撤回的悲观判断

升级前怀疑"Flutter 大部分页面都得截图"。升级后 lend_pal 8 步里：
- **3 步**用了 `ui.tap_element` 层级命中（弹窗 / 下拉 / Face Verification 按钮）
- **5 步**用截图兜底（首页 + KYC 表单输入字段）

**关键修正**：之前以为 Flutter 的下拉、日期选择器都得截图——**完全错**。
Flutter 的 `showMenu` / `showDatePicker` / `DropdownButtonFormField` 调的是 `PlatformDispatcher`，最终落到原生 Android widget 上（`android.widget.Button` / `RadioButton` 等），accessibility tree **完整暴露**，uiautomator dump 100% 可用。

只有这两种页面真的需要截图：
1. **持续动画的主屏**（进度条、shimmer、loop animation）
2. **TextFormField 输入框本体**（无 content_desc，label 有但偏移 90~140px）

## 工程上做了什么改造

### ui-mcp 的两层处理

1. **`dump_hierarchy` 自动重试**（默认 3 次，间隔 500ms / 1500ms / 3000ms）
   - 第 2+ 次自动加 `--compressed` flag（idle 检查更宽松）
   - 给 Flutter 一个真正进入间隙的机会
2. **失败时返回结构化信号**：
   ```json
   { "ok": false, "reason": "ui_busy", "hint": "...", "fallback": "..." }
   ```
   skill 可以一眼识别，不用 parse 错误字符串

### Skills 的自动分支

`qa` 和 `devtest` skill 收到 `reason: "ui_busy"` 后：
- 当前页**所有**后续操作走截图（不要每步重试 dump，浪费时间）
- 等 page_hash 变化（即明确跳转到新页面）再重试一次 dump

### `wait_for_element` 内部 retry=1

否则 poll-loop × retry 会变成"重试套重试"，超时膨胀。

## Skill 调用速查

### 静态页面（含静态弹窗）

```
1. ui.dump_hierarchy            ← 拿元素列表
2. ui.tap_element({
     strategies: [
       { by: "label", value: "Agree" }      ← Flutter 主要用 label/content_desc
       // 极少有 identifier (Flutter 默认不设 resource-id)
     ]
   })
```

### 动画/loading 页面

```
1. ui.dump_hierarchy            ← 第一次试，如果回 ui_busy 标记本页
2. mobile.mobile_take_screenshot
3. （让 Claude 看截图说目标坐标）
4. mobile.mobile_click_on_screen_at_coordinates(x, y)
5. record_step 标 via_screenshot=true
```

### 文本输入（不论页面状态）

```
1. tap 输入框（层级 or 坐标）
2. mobile.mobile_type_keys({ text: "..." })  ← 内部用 adb input text，与 uiautomator 无关
```

## Flutter widget 在层级里的特征

层级能拿到时，Flutter widget 的典型样子：

| Widget 类型 | class | 关键字段 |
|---|---|---|
| 文本 / Text | `android.view.View` | `content_desc=<可见文本>` |
| 按钮 / ElevatedButton / TextButton | `android.widget.Button` | `content_desc=<按钮文字>`, `clickable=true` |
| TextField / TextFormField | `android.widget.EditText` 或 `View` | `content_desc` 不一定有，多数靠位置 |
| Image / Icon | `android.view.View` | 可能有 `content_desc`（如果 Image 设了 `semanticLabel`） |
| Checkbox / Switch | `android.widget.CheckBox` | `checked` 字段 |
| Tab | `android.view.View` | `content_desc=<tab 名>`, `selected=true/false` |

**没有 `resource-id`**！Flutter 不会自动给 widget 加 Android resource-id。所以 strategy 优先级在 Flutter 上是：

```
label (content_desc, 归一化匹配) > label_contains > text > class
```

而不是原生 Android 的 `identifier > text > label`。**Flutter 上 `identifier` 策略注定失配，别放进策略链**（浪费一次匹配）。推荐写法：

```
ui.tap_element({
  strategies: [
    { by: "label", value: "监控", only_clickable: true },  // 归一化后命中带 TalkBack 后缀的 tab
    { by: "label_contains", value: "监控" },                // 再兜底
    { by: "text", value: "监控" }
  ]
})
```

`by:label` 现在自带归一化：传干净的可见文本（`概览` / `Agree`）即可，无需自己拼 `\n第 N 个标签` 后缀。多个元素归一化后同名时，加 `only_clickable: true` 去歧义（如同名的纯文本 View 会被过滤，只留可点击的 tab Button）。

## 表单输入字段的定位技巧（lend_pal 实测）

Flutter 的 `TextFormField` 在 Android 层级里是 `EditText` 或 `android.view.View`，几乎都没有 `content_desc`。但页面上的 **label 文字本身**通常是有 `content_desc` 的 `android.view.View`。

```
[label]  ← content_desc="Card Number" bounds y=474..540 (center y=507)
   ↓ 约 138 px
[input] ← 无 content_desc，但 center 在 y=612
```

经验偏移：

| label 字号 | input 中心相对 label 中心的 Y 偏移 |
|---|---|
| 大号 label（h2 style） | +138 px |
| 中号 label | +105 px |
| 小号 label（h4 / caption） | +88 px |

实操：

```
1. ui.dump_hierarchy → 找到 label 的 bounds.center.y
2. 估算 input center: input_y = label_center_y + 138
3. mobile.mobile_click_on_screen_at_coordinates(540, input_y)   ← 540 = 设备宽度中点（适用 portrait）
4. mobile.mobile_type_keys(...)  ← 直接 adb input text，与 uiautomator 无关
```

如果输入框真的有 `content_desc`（少数 app 自己加了 `Semantics`），优先 `ui.input_text({strategies: [...], text: ...})`。

## Mock 实现注意事项

lend_pal 的 Face Verification 是 **mock**：点 `Start Verification` 不调相机，直接走完 KYC。emulator 上测起来很顺，但**生产 app 务必在真机上跑一次真相机的 happy path**——mock 路径覆盖不了：
- 相机权限弹窗（首次）
- 相机 preview 黑屏 / 长尾延迟
- 人脸识别 SDK 抛异常 / 超时
- mock 在 Debug build 下、relase build 是真路径的情况

测试时如果发现某步意外顺滑（不要权限、不要等待），先看下是不是 mock。

## 已知限制

1. **日期选择器 / 时间选择器**：Flutter 的 showDatePicker 可能完全在 Canvas 渲染，accessibility 暴露不全。走截图 + 视觉判断当前月份 + 多次点击导航。
2. **图片选择器 / 相机调用**：跳到系统应用（package 变），需要根据 package 切换处理逻辑（原生 picker UI 通常能 dump）。
3. **WebView (flutter_inappwebview / webview_flutter)**：嵌入式 WebView 内容不在 Semantics tree。完全靠截图。
4. **下拉刷新 / 无限滚动列表**：滚动期间持续重绘，dump 一直失败。需要等滚动停 1-2 秒。

## 如何让 Flutter app 对测试更友好

如果你自己是 Flutter app 作者，下面这些改动能让 testing 体验大幅提升：

1. **给每个交互 widget 加 `Semantics(identifier: "login_btn", ...)`**
   - 这样 uiautomator dump 出来的元素有 resource-id 风格的稳定 key
   - 测试不再依赖文本（多语言友好）
2. **避免不必要的持续动画**
   - 把 progress bar / shimmer effect 改成"只在 loading 时显示"
   - app 进入稳定态后让 vsync 静止
3. **测试模式开关**
   - 通过 `--dart-define=TEST_MODE=true` 关闭动画 / 缩短超时
   - 在 main.dart 检测后用 `timeDilation = 0.01`

## 参考

- [Flutter Semantics 官方文档](https://api.flutter.dev/flutter/semantics/Semantics-class.html)
- [Android uiautomator wait_for_idle 行为](https://developer.android.com/reference/androidx/test/uiautomator/Configurator)
