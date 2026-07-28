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
| `find_element` | 单匹配。`strategies` 支持单个或数组；任何策略多候选时返回结构化 `ambiguous`，不按层级顺序误选 |
| `find_elements` | 多匹配。返回符合条件的全部元素 |
| `tap_element` | 找到 → 点击中心；返回实际坐标与命中策略 |
| `wait_for_element` | 轮询直到出现/消失或超时 |
| `input_text` | 先点中输入框（可选）再 `adb input text`；`clear=true` 要求目标策略，并在清空后重新验证为空 |
| `page_fingerprint` | 返回 12 位 hash，QA 状态图用 |

## Strategy 语法

```jsonc
{
  "by": "identifier" | "text" | "label" | "text_contains" | "label_contains" | "class",
  "value": "...",             // 必须是非空字符串
  "only_enabled": true,        // 默认 true，过滤 enabled=false 的元素
  "only_clickable": false,     // 默认 false
  "index": 0                   // 多匹配时选第几个，仅允许 0..19
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
才用首行归一化兼容 Flutter/TalkBack 后缀。**所有策略**（包括 exact
identifier/text/label）只要出现多个候选且没有显式 `index`，都会返回
`reason: "ambiguous"`。每个返回样本都有候选数组专用的
`candidate_index`；把它作为策略的 `index` 回传，不能使用层级全局的元素
`index`。响应最多给出 20 个候选样本；显式 `index` 也只允许选择已返回的
`0..19`，不能操作被截断隐藏的候选，更多时应收窄过滤条件。策略链仍可用
后续**唯一候选**去歧义，但该元素必须属于先前的歧义候选集合；无关的唯一
fallback 不会覆盖歧义。策略链最多 20 项，单个 `value` 最多 4096 字符。

`tap_element.settle_ms` 最大 30 秒，`wait_for_element.timeout_ms` 最大 120 秒、
`poll_ms` 最大 10 秒；wait 的一个绝对 deadline 会覆盖设备发现、每次层级抓取和
轮询等待，单个慢 ADB 命令不能让总等待反复超时。所有工具都会把 MCP 取消信号
传到 ADB 进程组和等待阶段，取消后不会继续后台点击或输入。`input_text` 的敏感正文
通过 `adb shell` 的 stdin 发送，不暴露在宿主进程 argv；设备端 shell 参数仍做完整
单引号转义，输入中的 `;`、`&`、`|`、换行不会成为额外命令；
`clear=true` 只接受具备稳定 resource-id/精确 label 且当前值可观察的目标；
最多逐个发送 16 次 `KEYCODE_DEL`，每次都重新读取同一目标，空值后立即停止，
总清空流程使用同一个 30 秒硬 deadline，设备查询、每次 ADB、层级 dump、退避和
重新聚焦不会各自重置超时；ADB 或其继承输出管道的子进程忽略 `SIGTERM` 时会在
短暂宽限后按进程组升级为 `SIGKILL`。清空后会重新聚焦，输入后再读取最终值；空字段/
replace 场景若受 `maxLength`、IME 或字符兼容影响而不等于请求值，会返回
`input_verification_failed`，无法精确观察（如 password）则显式返回
`verified:false`。失败诊断会隐藏完整输入文本，避免密码/token 落入 MCP transcript。
若 deadline 在替换输入开始后才到达，响应会携带
`input_may_have_applied`、`input_sent` 和 `verification`，调用方必须先检查字段，
不能盲目重试并造成重复输入。取消或 timeout 恰好发生在 DEL/输入命令期间时，
还会返回 `delete_may_have_applied` / `field_may_have_changed`，同样必须先检查字段。
所有 MCP 元素输出都会省略 `password=true` 节点的 `text/content_desc`，页面指纹
只使用稳定 id 与固定脱敏占位；`dump_hierarchy(include_xml=true)` 返回的 XML 也会
脱敏密码节点，同时保留内部原始层级用于定位，不影响查找和输入。

为避免异常设备层级或高基数页面放大内存和 MCP 响应，ui-mcp 还执行以下硬预算：

- 原始层级 XML 最大 3 MiB，内部最多遍历 5000 个元素、256 层深度；超限直接失败。
- `dump_hierarchy` / `find_elements` 最多返回 256 个元素；页面指纹也最多返回
  256 个调试 signal。工具会显式标记结果或字段是否截断，hash 仍覆盖全部内部信号。
- 元素的单个文本字段最多输出 512 UTF-8 字节；任何一条 MCP 文本响应最大 4 MiB。
- `device` 参数拒绝控制字符和超长值，避免把异常标识传入底层 ADB。

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
| Windows 上异常 ADB 派生孙进程 | Windows 无 POSIX 进程组，取消只能保证终止直接子进程 | 使用可信官方 ADB；需要强隔离时在 Job Object/容器内运行 MCP |

## 测试

```bash
./node_modules/.bin/tsx --test mcp-servers/ui-mcp/src/finder.test.ts
```
