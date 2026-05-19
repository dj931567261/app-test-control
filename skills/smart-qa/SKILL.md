---
name: smart-qa
description: This skill should be used when the user says "找 bug" / "看一下有没有 bug" / "smart-qa" / "/smart-qa" / "帮我测一下这个项目" / "智能 QA" / "推断业务流程测一下"，or asks for an autonomous bug-hunt where they DON'T already know what to test. Distinct from `qa` (blind exploration) and `devtest` (verifies a specific change). smart-qa READS the project source — prefers PRD/requirements docs, falls back to code (activities, routes, click handlers, API calls) — then proposes a focused test plan for confirmation before driving the app. v1 stops after the user confirms the plan and hands off to the existing `qa` skill for execution. v2 (planned) adds per-step assertions.
version: 0.1.0
argument-hint: "[--project <path>] [--package <pkg>] [--device <serial>]"
---

# smart-qa — 业务感知的自动找 Bug Agent

把"用户说一句话 → 工具读懂项目 → 提测试计划 → 跑起来"的链路接起来。和 `qa`（盲点）/ `devtest`（验证特定改动）的根本差别：**smart-qa 知道这个 app 在干啥**。

依赖五个 MCP：
- `code-analyzer`（本仓 code-analyzer-mcp）— 找文档、推平台、抽 pages/routes/handlers/apis
- `mobile`、`ui`、`log`、`report` — 执行阶段的标准四件套

v1 范围：Phase 1-3。Phase 4（断言）放第二版做。

## When to invoke

用户原话命中下面任何一条：
- "找一下 bug"、"看看有没有问题"、"测一下这个项目"、"帮我跑一下 app"
- "/smart-qa"、"smart-qa --project /path/to/app"
- "我没改什么具体的，就是想验整体"
- "推断一下业务流测测看"

不要在这些场景里 invoke：
- 用户已经说了具体改动 → 走 `devtest`
- 用户说"猴子测一下" / "随便点点" → 走 `qa`
- 用户已经有 PRD 让你按文档跑 → 直接读文档不用 smart-qa 的推断

## 输入与默认

| 参数 | 默认 | 说明 |
|---|---|---|
| `--project` | 当前 cwd | 项目根目录绝对路径 |
| `--package` | 从代码推 | Android applicationId / iOS bundle id；推不出来要问用户 |
| `--device` | 自动 | 单设备时省 |

## 工作流（v1：3 个 Phase）

### Phase 1 · 读项目

调一次 `code_analyzer.analyze_project(project_dir)`。返回结构：

```
{
  "project_dir": "...",
  "platform": "flutter" | "android-native" | ...,
  "platform_signals": ["pubspec.yaml:flutter", ...],
  "app_name": "...",
  "package_or_bundle": "...",
  "docs": [{path, kind, head, signal}, ...],   // 已按 prd > requirements > spec > test-plan > readme > other 排序
  "signals": {
    "pages": [{name, kind, file, line, is_launcher}, ...],
    "routes": [{name, kind, file, line, target_page?}, ...],
    "apis": [{method, path, source, file, line}, ...],
    "handlers": [{page, target_id, target_widget, text, action_snippet, file, line}, ...]
  }
}
```

**优先消费的文档**：取 `docs[0]` 如果是 prd / requirements / spec / test-plan。Read 文档全文，那是用户的真实意图来源。如果只有 readme，把它当业务说明的一部分读，但不能当 PRD 用。

### Phase 2 · 推业务流（核心环节）

读完 `analyze_project` 输出和（如有）PRD/requirements 后，由 Claude 自己综合出 **3-7 条业务流**。每条流的结构：

```yaml
- name: "登录"
  description: "用户输入手机号/密码进入首页"
  start_page: "LoginPage"
  steps:
    - action: "tap '手机号' 输入框 + 输 13800138000"
      expected: "焦点切到输入框，字段显示完整"
    - action: "tap '密码' 输入框 + 输 testpass"
      expected: "密码以圆点显示"
    - action: "tap '登录' 按钮"
      expected: "跳转到 /home（首页 page_hash 应不同）"
  api_calls_likely: ["/api/login", "/api/me"]
  risk_signals: ["LoginPage 文件最近一次修改 / 强密码校验 / 第三方登录入口"]
```

**推断规则**（按优先级使用）：
1. **PRD/requirements 优先**：里面写了什么流程就照搬，pages/handlers 只用来做"映射到实际 UI 控件文案"
2. **没文档时**靠以下信号：
   - **`is_launcher=true` 的 Activity / "Splash"/"Login"/"Onboarding" 命名页**：启动路径，必须有一条流
   - **每个被 routes 引用次数最多的 page**：高频页面，至少一条流
   - **handlers 里 text 带有动词或 CTA 关键词**（"Submit"、"Confirm"、"Next Step"、"Login"、"购买"、"提交"）：核心交互
   - **apis 路径含 `/login` `/order` `/pay` `/submit` `/verify` 等业务动词**：关键写操作必须覆盖
3. **避免冗余**：相同业务的不同入口合并成一条流（"用户中心进入 → 设置页"和"长按头像 → 设置页"是同一条）

**报给用户的形态**：把 3-7 条流的概要列成编号清单，然后问用户要跑哪几条（可多选）：

```
基于代码推断，发现这几条主要业务流，你想跑哪些？（回 'all' 或编号列表，例如 1,3,5）
1. F1 - 启动 → Splash → 同意隐私 → 首页 (信号: SplashPage, /splash route, GoRouter)
2. F2 - 登录 → 输入手机/密码 → 首页 (信号: LoginPage, /login, '登录' 按钮)
3. F3 - KYC 全流程 → 7 步表单 (信号: 7 个 KycXxxPage)
4. F4 - 查看订单 → OrdersPage (信号: OrdersPage, /orders route)
all - 全部
```

用户回复后按选中编号固化为本次的"测试计划"。如果用户说"还有别的吗"或要改 → 重新推断 + 二次确认（最多 2 轮，避免 ping-pong）。

> 实现提示：客户端若提供原生选择 UI（例如 Claude Code 的 AskUserQuestion 弹窗），agent 可以自由用；纯文本编号方案保证在 Cursor / Codex / Cline 等任意 MCP 客户端里都能跑。

### Phase 3 · 交给 qa skill 执行

v1 不自己做断言闭环。我们把"已确认的测试计划"翻译成 qa skill 能消费的格式：

1. **建 session**：`report.start_session(name="smart-qa-<app_name>", extra={confirmed_flows: [...], plan_source: "PRD" | "code-inference"})`
2. **写入 `<session>/plan.md`**：固化用户确认过的流，便于复盘
3. **打 logcat**：`log.start_capture`
4. **逐条跑流**：对每条 flow：
   - `mobile.terminate_app + launch_app`（每条流独立起点）
   - 按 `steps` 序列执行：
     - 输入 → `ui.input_text` 或 `mobile.mobile_type_keys`
     - 点击 → `ui.tap_element(by: identifier 优先, by: label/text fallback)`
     - 等跳转 → `ui.wait_for_element` 或 `page_fingerprint` 变化
   - 每步 `log.clear_logs` + 截图 + `get_recent_crashes`（沿用 devtest 的 happy path）
   - 完成 / 失败 → `record_step` 写结果
5. **结束**：`log.stop_capture` + `report.finalize(status, summary)`

执行细节**复用** `devtest` skill 的 §Phase 4，**不要重写**。如果某步层级查不到目标控件且没有截图兜底逻辑命中，则将该流标 `partial` 而不是 `failed`，继续下一条流。

### Phase 3.5 · 收尾给用户

```
✅ smart-qa 完成 (lend_pal Flutter)
  📋 计划来源: 代码推断（未提供 PRD）
  ✓ F1 启动 → Splash → 同意隐私 → 首页 (4 步, 0 crash)
  ✓ F2 登录 (3 步, 0 crash)
  ⚠ F3 KYC 全流程 (15 步, 第 12 步层级未命中→ via_screenshot=true, 0 crash)
  ✗ F4 订单页 (1 步, FATAL @ OrdersPage.onCreate:42)
  
  发现:
  - 1 个 crash: F4 OrdersPage 启动崩 → 报告 + 复现路径已归档
  - 2 个 partial: F3 第 12 步层级不在层级里（Flutter dropdown，已截图兜底）
  
  报告: workspace/sessions/.../report.{md,html}
  
  下一步建议:
  - 修 F4 crash 后跑 /devtest 验证
  - 若需精简 F4 复现路径: /minimize
```

## 关键设计决策

1. **不在 Phase 1 就做 LLM 总结**：`code-analyzer-mcp` 只返结构化数据，Claude 在 skill 里现场综合。原因是 (a) 我们已经在对话里有 LLM，没必要给 MCP 加调用 LLM 的依赖；(b) 用户可以在终端看到原始 signals，方便核对。
2. **强制用户确认**：v1 必经一次用户选择（编号清单 / 客户端原生多选 UI 都可）。原因：自动推断必有偏差，让用户改一次比错跑 10 步成本低。
3. **复用 qa/devtest 不重写**：smart-qa 只做"把意图变成计划"，执行还是老流程。
4. **不在 v1 做断言**：每步的 `expected` 字段 v1 阶段只写报告里给人看，不机器验证。v2 才接 assertion-mcp。

## 失败兜底

| 现象 | 应对 |
|---|---|
| `analyze_project` 报 platform=unknown | 让用户手动指定 `--package` + `--platform`；走纯 `qa` 探索 |
| 推断出来 0 条业务流（pages 全空） | 提示用户："没找到能识别的页面，是不是用了 RN / iOS 这类暂不支持的栈？需要的话用 `qa` 盲探" |
| 文档非常长（>50K）/ PRD 是 Word | 只读 docs[0].head（前 30 行）；提示用户"如果文档很关键，请贴关键段落到对话里" |
| 用户对推断的流全否定 | 二次让用户写一条最简单的流（"我就想测登录"），翻译成步骤后再确认 |
| 跑 flow 中 app 持续崩 / 弹权限 | 沿用 qa skill 的处理：重启 + 权限弹窗自动同意 |

## Do / Don't

✅ Do
- 永远先 `analyze_project`，再综合，再问
- PRD 存在时 PRD 优先于代码推断
- 每条 flow 给出 `信号`（哪几个 file:line 推出来的）让用户能核对
- 用户没说就默认不跑全部流（避免 30 分钟空转）

❌ Don't
- 不要跳过用户确认直接开跑（即便信心很高）
- 不要在推断时 dump 整个 signals 到对话（太长；只总结 3-7 条流）
- 不要"代码推断+PRD 都要"——以 PRD 为准，代码推断只用来补 PRD 没说的部分
- 不要尝试做断言（v1 范围外）
- 不要绕过 `qa/devtest` 自己写一套执行循环

## 实战例

用户："帮我看下 /Users/mac/mcp/loan_app_all_process 有没有什么 bug"

```
[Phase 1] analyze_project 跑完: flutter, 12 pages, 22 routes, 21 handlers, 0 apis
         docs: requirements.md (kind=requirements, 3187 B) ← 主路径！
         
[Phase 1.5] 读了 requirements.md 全文，是 lend_pal 的标准业务说明
         （Privacy/Permission → Home/Apply → KYC 7 步 → Under Review）

[Phase 2] 推 4 条流: F1 启动+授权 / F2 申请贷款 / F3 KYC / F4 查看订单+审核状态
         → 让用户从编号清单里选（或用客户端原生多选 UI）

[用户选 F1+F3]

[Phase 3] 起 session → 起 logcat → terminate+launch
         F1: 4 步 ✓
         F3: 15 步，第 12 步 dropdown 截图兜底 → ⚠ partial
         finalize: passed, 1 partial, 0 crash
         报告 + HTML 生成
         
[Phase 3.5] 5 行总结打到终端
```

## 现状（v0.1.0）

- code-analyzer-mcp: ✅ android-native + flutter 覆盖；RN/iOS 仅 doc 发现
- Phase 1-3 v1: ✅ 本 skill
- Phase 4 断言: ⛔ 不在 v1 范围
