# ui-mcp

MCP server for Android UI hierarchy query and coordinate-based interaction.

**核心定位**：层级（uiautomator dump）优先，截图视觉兜底。

## 何时用 ui-mcp vs mobile-mcp

| 场景 | 用 | 原因 |
|---|---|---|
| 点已知文本/id 的按钮 | **ui-mcp.tap_element** | 稳定可复现，命中率高 |
| 等元素出现 | **ui-mcp.wait_for_element** | 主动 poll，比固定 sleep 准 |
| 给输入框打字 | **ui-mcp.input_text** | 自动点中输入框 + adb input text |
| 页面状态指纹 | **ui-mcp.page_fingerprint** | 跨运行稳定（QA 状态图用） |
| 元素在层级里找不到（Flutter/WebView/Canvas） | **mobile-mcp.take_screenshot** + 视觉识别 | 兜底 |
| 启动 app / 截图保存 / 安装 apk | mobile-mcp | mobile-mcp 的强项 |

## 安装

```bash
npm install
npm run build -w mcp-servers/ui-mcp
```

## 注册到 Claude Code

参见仓库根 `.mcp.json.example` 的 `ui` 段。

## 工具列表

| 工具 | 说明 |
|---|---|
| `dump_hierarchy` | 一份 uiautomator XML，返回元素列表（默认过滤零尺寸） |
| `find_element` | 单匹配。`strategies` 支持单个或数组；normalized label 多候选时返回结构化 `ambiguous`，不按层级顺序误选 |
| `find_elements` | 多匹配。返回符合条件的全部元素 |
| `tap_element` | 找到 → 点击中心；返回实际坐标与命中策略 |
| `wait_for_element` | 轮询直到出现/消失或超时 |
| `input_text` | 先点中输入框（可选）再 `adb input text` |
| `page_fingerprint` | 返回 12 位 hash，QA 状态图用 |

## Strategy 语法

```jsonc
{
  "by": "identifier" | "text" | "label" | "text_contains" | "label_contains" | "class",
  "value": "...",             // 必须是非空字符串
  "only_enabled": true,        // 默认 true，过滤 enabled=false 的元素
  "only_clickable": false,     // 默认 false
  "index": 0                   // 多匹配时选第几个
}
```

**优先级建议**：identifier（resource-id 跨版本最稳）> text > label > 模糊匹配。
传 strategy 数组让 ui-mcp 按顺序尝试：

```jsonc
{
  "strategies": [
    {"by": "identifier", "value": "com.example.app:id/login_btn"},
    {"by": "text", "value": "登录"}
  ]
}
```

`by:label` 先做 `content-desc` 全等匹配；仅当干净的单行查询全等失配时，
才用首行归一化兼容 Flutter/TalkBack 后缀。若归一化后出现多个候选，工具会
返回 `reason: "ambiguous"`。策略链仍可用后续**唯一候选**或显式 `index`
去歧义，但不会让后续隐式多候选策略静默选择第一个。

## 典型 Skill 调用流程

```text
1. ui.tap_element({strategies: [{by:"identifier", value:"..."},
                                  {by:"text", value:"登录"}]})
2. if (response.tapped === false):
     mobile.mobile_take_screenshot
     → 视觉识别坐标
     → mobile.mobile_click_on_screen_at_coordinates
     → 标记 via_screenshot=true 写入 report-mcp step
```

## 已知限制

| 场景 | 现象 | 解决 |
|---|---|---|
| Flutter / Compose Canvas | dump 出来的元素稀疏（一两个根容器） | 检测元素数 < 阈值 → 走截图 |
| WebView | 网页 DOM 不在 native tree | 同上 |
| Unity / 游戏 | 整屏是 SurfaceView | 同上 |
| 动画/转场中 dump | 抓到中间态可能找不到目标 | `wait_for_element` 加 settle |
| 中文输入 | `adb input text` 部分 IME 行为差 | 改 `adb shell ime set ...` 切到 AOSP 输入法 |

## 测试

```bash
./node_modules/.bin/tsx --test mcp-servers/ui-mcp/src/finder.test.ts
```
