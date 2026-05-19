# 实施进度

> 配合 [PLAN.md](./PLAN.md) 使用。每完成一步勾选；遇到 blocker 在底部"问题记录"补充。

**当前阶段**：P0–P5 全部完成 + P5+ Flutter 鲁棒性 + lend_pal KYC 全流程实战 → 项目就绪
**最后更新**：2026-05-15

---

## 总览

| 阶段 | 状态 | 进度 | 备注 |
|---|---|---|---|
| P0 底座 | ✅ 完成 | 5/5 | 真机冒烟通过，三个 MCP 协同正常 |
| P0+ ui-mcp | ✅ 完成 | 5/5 | 12 单测 + stdio smoke + 真机 verify 全过 |
| P1 DevTest | ✅ 完成 | 2/2 | SDK805 项目 btn 点击 → DeviceDataCollector 日志验证通过 |
| P2 QA 探索 | ✅ 完成 | 3/3 | SDK805 真机跑通：状态图持久化 + exhausted/recovery 分支全验证 |
| P3 智能后处理 | ✅ 完成 | 6/6 | analyzer-mcp (signature/dedup/suggest) + minimize skill (ddmin) |
| P4 iOS 支持 | ✅ 代码完成 | 4/4 | log-mcp iOS（simctl + .ips）+ analyzer-mcp .ips 解析 + skills 平台分支 |
| P5 打磨 | ✅ 完成 | 4/4 | HTML 报告 + doctor 自检 + GitHub Actions CI + 架构文档 |
| P5+ Flutter 鲁棒性 | ✅ 完成 | 3/3 | dumpHierarchy retry + `--compressed` fallback + Skill 兜底分支 |
| 实战 · lend_pal KYC | ✅ 完成 | 8/8 | 静态 Flutter 页 + 原生 dropdown 层级 100% 可用；0 crash |

图例：⚪ 未开始 · 🟡 进行中 · ✅ 完成 · 🔴 阻塞

---

## P0 底座

> 目标：跑通"操作 → 抓 log → 出报告"的最小闭环。

### 任务清单

- [x] **P0-0** 写 PLAN.md（方案文档）
- [x] **P0-0** 写 PROGRESS.md（本文件）
- [x] **P0-1** 初始化项目骨架
  - [x] 根 `package.json`（含 `workspaces`） + `tsconfig.base.json`
  - [x] 创建子目录：`mcp-servers/`、`skills/`、`workspace/`、`test-plans/`
  - [x] `.gitignore` + `.editorconfig`
  - [x] `README.md` 占位
  - [x] `npm install` 通过，`npm run build` 通过
- [x] **P0-2** 实现 log-mcp（Android）
  - [x] 基础 MCP server 框架（@modelcontextprotocol/sdk 1.29）
  - [x] `list_devices`
  - [x] `clear_logs` / `start_capture` / `stop_capture` / `list_captures`
  - [x] `get_recent_crashes`（FATAL/ANR/Native crash 关键字匹配）
  - [x] `pull_anr_traces` + `pull_tombstones`（bugreport 兜底实现）
  - [x] `get_memory_info` / `save_log_snippet`
  - [x] 单元测试 5/5 通过
  - [x] README 写如何注册到 Claude Code
- [x] **P0-3** 实现 report-mcp
  - [x] `start_session` / `record_step` / `record_crash` / `finalize`
  - [x] `get_session_path` / `list_sessions` / `regenerate_report`
  - [x] Markdown 模板渲染（含 crash repro path 展示）
  - [x] session 目录结构按 PLAN §4.2 约定
  - [x] 单元测试 2/2 通过（端到端 + 空 session）
- [x] **P0-4** 配置与文档
  - [x] `config.yaml` 模板（设备 / 包名 / 阈值）
  - [x] 顶层 `README.md`：项目简介 + 装配方式 + 一个最小 demo
  - [x] `.mcp.json.example` 项目级 MCP 注册样板（mobile + log + report）
  - [x] `docs/SETUP.md` 完整接入指南
- [x] **P0-5** 端到端 smoke test
  - [x] 写 `scripts/mcp-smoke.mjs`（stdio 联调脚本，验证握手 + tools/list）
  - [x] 接到 `npm run test:smoke`，整合到 `npm test`
  - [x] log-mcp 10/10 工具 ✓ report-mcp 7/7 工具 ✓
  - [x] **真机/模拟器人工验证**：V2353DA Android 14 emulator 跑通
        启动 settings → 截图 → 0 crash → 报告生成（1 step, 0 crash, 53s）
        产物：`workspace/sessions/2026-05-14_151941_smoke/report.md`

### 验收标准
见 PLAN §10 P0 验收。

---

## P0+ ui-mcp（层级查询 + 智能点击）

> 目标：把"层级优先 / 截图兜底"封装成一个 MCP 让 Skill 调用更干净。

- [x] **P0+1** 项目骨架（package.json + tsconfig + src 占位）
- [x] **P0+2** uiautomator dump + XML 解析
  - [x] `adb shell uiautomator dump` + `adb shell cat`（不用 pull 文件）
  - [x] fast-xml-parser 解析 bounds/text/resource-id/content-desc/class/clickable
  - [x] 计算 center + width + height
- [x] **P0+3** finder 匹配策略
  - [x] identifier / text / label
  - [x] text_contains / label_contains / class
  - [x] fallback 列表（findFirst 按顺序尝试）
  - [x] only_enabled / only_clickable / index 修饰
- [x] **P0+4** 暴露工具（7 个）
  - [x] `dump_hierarchy` / `find_element` / `find_elements`
  - [x] `tap_element`（含 settle_ms） / `wait_for_element`（appear/disappear）
  - [x] `input_text`（可带 strategies 先定位输入框）
  - [x] `page_fingerprint`（sha1 12 位，QA 状态图复用）
- [x] **P0+5** 测试与接入
  - [x] finder 单测 12/12（解析 + 多策略 + 修饰符 + fingerprint 稳定性）
  - [x] stdio smoke 7/7 工具上线
  - [x] 真机 verify（`scripts/ui-verify.mjs`）跑通 dump/find/fingerprint
  - [x] 写入 `.mcp.json.example`（新增 `ui` 段）
  - [x] README 含选型指南 + 已知限制

---

## P1 DevTest

> 目标：开发者一句话验证刚改的功能。依赖 P0 完成。

### 任务清单
- [x] **P1-1** 写 SKILL.md
  - [x] 放在 `.claude/skills/devtest/SKILL.md`（Claude Code 自动发现）
  - [x] `skills/devtest/SKILL.md` 留指向同份内容的引用
  - [x] frontmatter 含 name/description/version/argument-hint
  - [x] 5 个 Phase（读变更 → 推断 UI → 测试计划 → 执行循环 → 出结论）
  - [x] 层级优先 + 截图兜底的工具选择规则
  - [x] crash 检测、失败兜底、Do/Don't 清单
- [x] **P1-2** 真机/模拟器端到端
  - [x] 真实工程：`/Users/mac/AndroidStudioProjects/SDK805` (Native Android Kotlin)
  - [x] 任务：MainActivity#btn 点击 → 验证 DeviceDataCollector 日志
  - [x] 流程：start_session → start_capture → launch → wait_for_element → clear_logs → tap_element → save_log_snippet → finalize
  - [x] 层级路径 100% 命中（resource-id `jko.dns.qwn.dfgt:id/btn`），无需截图兜底
  - [x] 日志验证：recordJson[0]（JSON 设备数据）+ recordJson[1]（Base64 加密体）都正常打印
  - [x] 0 crash；2 steps；总耗时约 4.5 分钟
  - [x] 报告：`workspace/sessions/2026-05-14_154540_devtest-sdk805-btn/report.md`
  - [x] **可选 follow-up** ✅ (2026-05-15)：在 MainActivity.kt:77 注入 `s!!.length` (s=null) → 跑 devtest 流程：
    - `log.get_recent_crashes` < 200ms 抓到 FATAL EXCEPTION
    - `analyzer.compute_signature` 算出 fingerprint=`38daa5366cfc`，label=`NullPointerException @ jko.dns.qwn.dfgt.MainActivity.onCreate$lambda$1`
    - step 标 fail / crash 记入 / repro_path=[1,2] / session 标 failed / HTML 报告生成
    - 报告：`workspace/sessions/2026-05-15_162725_devtest-sdk805-npe/report.{md,html}`
    - **测后已还原源码 + 重装干净 APK，sanity check 通过**

### 验收标准
见 PLAN §10 P1 验收。

---

## P2 QA 自动探索

> 目标：让 Claude 自己点 app，记录每页、每元素、每次崩溃，找未知 bug。

- [x] **P2-1** 扩 report-mcp 加状态图工具
  - [x] `graph.ts`：pages + edges 落 `state-graph.json`（原子写）
  - [x] 5 个工具：`graph_record_page` / `graph_record_edge` / `graph_mark_element_seen` / `graph_pick_next_unseen` / `graph_summary`
  - [x] 单测 4/4（含 visit_count 累加、element_seen 去重、summary 统计）
  - [x] smoke 12/12 工具齐
- [x] **P2-2** 写 qa SKILL.md
  - [x] `.claude/skills/qa/SKILL.md` 已落地（318 行）
  - [x] frontmatter：name/description/version/argument-hint
  - [x] element_key 构造规则（resource_id → text → label → bounds）
  - [x] 默认 blocklist（退出/注销/系统应用）
  - [x] 主循环 + 截图兜底（Phase 1.5）
  - [x] 异常处理：crash 重启 / exhausted BACK / 离开 app / 权限弹窗
- [x] **P2-3** SDK805 真机短跑验证
  - [x] 重启后 5 个 graph 工具全部可用（report-mcp 12 工具就位）
  - [x] 跑通 4 步探索 + 1 次自动恢复
  - [x] 验证点 1：层级优先点击（两次都用 identifier 命中，无截图兜底）
  - [x] 验证点 2：pick_next_unseen 自动跳过已点元素（tvText → btn）
  - [x] 验证点 3：exhausted 分支正确触发（pick 返回 null）
  - [x] 验证点 4：BACK 退到 launcher 被识别为离开 app，自动 relaunch
  - [x] 验证点 5：**elements_seen 跨进程持久化**（relaunch 后仍记得 [tvText, btn]）
  - [x] 验证点 6：page_fingerprint 跨进程稳定（重启后 hash 完全一致）
  - [x] 产物：`workspace/sessions/2026-05-14_160354_qa-sdk805/` 含 state-graph.json + report.md
  - [ ] **可选 follow-up**：在 UI 更复杂的 app 上跑 30+ 步，验证多页面状态图（留到下一个真实项目）

---

## P3 智能后处理

> 目标：crash 去重（同一 bug 不重复记） + 复现路径精简（12 步压成 3 步）。

- [x] **P3-1** analyzer-mcp 项目骨架
  - [x] package.json + tsconfig + src
  - [x] npm install + build 通过
- [x] **P3-2** signature 计算
  - [x] `signature.ts`：parseStack（Java/ANR/Native 三种 kind）
  - [x] normalizeFrame 去掉 `(File.java:42)` 部分
  - [x] computeSignature → 12 位 sha1，hash 包含 kind + 异常类 + top-3 frames + root_cause + signal/process
  - [x] 11 个单测覆盖各种 kind + 稳定性 + 差异检测
- [x] **P3-3** crash 去重 + session 分析
  - [x] `dedup.ts`：按 fingerprint 分组，含 occurrences/instance_ids/first_step_index
  - [x] `analyze.ts`：读 crashes.jsonl，自动 hydrate stack，hookup 到 dedup
  - [x] `suggest_minimal_path`：静态启发式（page transition + result=fail + skip 过滤）
  - [x] 5 个 dedup 单测
- [x] **P3-4** 工具暴露 + 单测 + smoke
  - [x] 4 个 MCP 工具：`compute_signature` / `dedup_crashes` / `analyze_session` / `suggest_minimal_path`
  - [x] 单测共 16 (signature 11 + dedup 5)
  - [x] stdio smoke 4/4 工具齐
- [x] **P3-5** minimize SKILL.md
  - [x] `.claude/skills/minimize/SKILL.md`（约 200 行）
  - [x] ddmin 算法描述 + 5 个 Phase 工作流
  - [x] replay 子例程：terminate → launch → wait → 逐步 tap → check signature
  - [x] 失败/边界处理：偶发 crash、element 缺失、max_replays
- [x] **P3-6** 接入 + 文档
  - [x] `.mcp.json.example` 新增 `analyzer` 段
  - [x] `package.json` test:unit + test:smoke 覆盖 analyzer-mcp
  - [x] `mcp-servers/analyzer-mcp/README.md`
  - [x] 顶层 `README.md` 状态更新
  - [x] **可选 follow-up** ✅ (2026-05-15)：在 SDK805 上做多步 path → ddmin 收敛实测：
    - 录 4 步：launch / tap tvText / tap tvText / tap btn(crash)，原始 repro_path=[2,3,4]
    - `analyzer.suggest_minimal_path` 静态启发直接给 `[4]` (confidence=medium)
    - **Live replay 验证**：terminate → launch → 只 tap btn → 同 fingerprint `38daa5366cfc`
    - 收敛：[2,3,4] → [4]，1 次 replay 即确认
    - 报告：`workspace/sessions/2026-05-15_170245_minimize-sdk805-npe/report.{md,html}`

### 当前规模（P3 时）
- **4 个 MCP**：log（10）+ report（12）+ ui（7）+ analyzer（4）= **33 个工具**
- **3 个 Skill**：devtest + qa + minimize
- **35 个单测** + **4 个 smoke** 全过

---

## P4 iOS 支持（Simulator 限定）

> 目标：iOS Simulator 上能跑诊断（日志 + 崩溃），UI 操作复用 mobile-mcp。**用户没装 idb，所以 ui-mcp 不扩 iOS**。

- [x] **P4-1** log-mcp iOS
  - [x] `src/ios.ts` — `xcrun simctl list/spawn` wrapper
  - [x] `src/ips.ts` — 扫 `~/Library/Logs/DiagnosticReports/`，filter by since/bundle/proc
  - [x] `captures.ts` 增加 `startIosCapture`（platform 字段）
  - [x] 4 个新工具：`ios_list_simulators` / `ios_start_capture` / `ios_list_ips` / `ios_pull_ips`
- [x] **P4-2** analyzer-mcp .ips 解析
  - [x] `src/ips.ts`：解析 header + body JSON，提取 exception.type/signal/subtype
  - [x] `top_frames`：symbolicated 优先（symbol+symbolLocation），fallback `<image_name>+<offset>`
  - [x] `CrashKind` 加 `"ios"`，`buildLabel` 加 iOS 分支
  - [x] `ipsToParsedStack` 适配 → 套用 existing `computeSignature`
  - [x] 2 个新工具：`parse_ips_file` / `parse_ips_content`
  - [x] 9 个单测（含 symbolicated / 行号无关 / 字段变化检测）
  - [x] **真实 .ips 实测**：用户磁盘上的 wpscloudsvr crash 解析正确，fingerprint=`37a0a9b33a6c`
- [x] **P4-3** skill 平台分支
  - [x] `devtest/SKILL.md` 加"平台分支"表格 + iOS 工具映射
  - [x] `qa/SKILL.md` 加"iOS 适配"小节（page_hash 自算 / mobile.click 兜底 / .ips 抓 crash）
- [x] **P4-4** 接入 + 文档
  - [x] `config.yaml` 加 iOS 字段（bundle_id, ios_log_predicate, ios_ips_window_minutes）
  - [x] `docs/SETUP.md` 加 iOS Simulator 流程小节
  - [x] 顶层 `README.md` 依赖列表加 Xcode 命令行
  - [x] log-mcp / analyzer-mcp README 更新
  - [ ] **未做**：iOS 真机端到端验证（用户没真机），留 follow-up

### 当前规模（P4 后）
- **4 个 MCP**：log（**14**，+4 iOS）+ report（12）+ ui（7）+ analyzer（**6**，+2 iOS）= **39 个工具**
- **3 个 Skill**：devtest + qa + minimize（含 iOS 分支）
- **44 个单测** + **4 个 smoke** 全过

### iOS 关键限制
- **没装 idb** → ui-mcp 在 iOS 上不工作，所有 UI 操作走 mobile-mcp
- **仅 Simulator** → 真机 .ips 需要 idevicesyslog / Apple Configurator，本仓未实现
- **page_hash 在 iOS 由 skill 自算**（accessibility tree → identifier/text/label 排序 sha1）

---

## P5 打磨

- [x] **P5-1** HTML 报告
  - [x] `html-report.ts` 自包含模板（inline CSS + file:// 截图 ref，无 JS / 无外部资源）
  - [x] `finalize` / `regenerate_report` 默认同时生成 `report.html`（可 `html=false` 关闭）
  - [x] 暗色模式（prefers-color-scheme）+ 折叠 `<details>` + crash 高亮
  - [x] 4 个新单测（自包含 / 转义 / 文件写入 / 状态徽章）
  - [x] 给 SDK805 现有 session 现场补一份 `report.html`（7.3 KB）
- [x] **P5-2** doctor 自检
  - [x] `scripts/doctor.mjs` — Node/npm/adb/xcrun/设备/MCP 构建/.mcp.json/skills
  - [x] 彩色输出 + ok/warn/fail 分类
  - [x] 接到 `npm run doctor`
- [x] **P5-3** GitHub Actions CI
  - [x] `.github/workflows/ci.yml`
  - [x] Ubuntu + macOS × Node 20 + 22 矩阵
  - [x] build + unit + smoke（doctor 仅做 info）
- [x] **P5-4** 文档收尾
  - [x] `docs/ARCHITECTURE.md` — ASCII 架构图 + 数据流 + 测试金字塔
  - [x] 顶层 `README.md` 加"典型对话"两个示例 + 状态徽章
  - [x] 各组件 README 同步

### 最终规模
- **4 个 MCP**：log（14）+ report（12）+ ui（7）+ analyzer（6）= **39 个工具**
- **3 个 Skill**：devtest + qa + minimize
- **52 个单测** + **4 个 smoke** 全过
- **CI**：Ubuntu + macOS × Node 20 + 22
- **3 份文档**：PLAN.md / PROGRESS.md / ARCHITECTURE.md + SETUP.md + 各组件 README

---

## P5+ Flutter 鲁棒性（实战反馈驱动）

> 2026-05-14 用 lend_pal Flutter app 实测时发现：uiautomator dump 在 Flutter 持续重绘的页面上报 `could not get idle state`。借机做了一轮框架升级。

- [x] **P5+1** ui-mcp 加抗重绘
  - [x] `uiautomator.ts`：dumpHierarchy 加 retry（默认 3 次，间隔 500/1500/3000ms）
  - [x] 第 2+ 次自动用 `--compressed` flag（更宽松的 idle 检查）
  - [x] 新 `UiBusyError` 类 + index.ts 把它返回成结构化 `{ok:false, reason:"ui_busy", hint, fallback}`
  - [x] `wait_for_element` 内部用 retry=1（poll loop 本身就是重试，避免乘积膨胀）
- [x] **P5+2** skills 升级 Flutter 兜底
  - [x] devtest SKILL：检测 `reason==="ui_busy"` → 当前页走截图，跳转后再 retry dump
  - [x] qa SKILL：同上，加 `page_busy` 标记跨步复用
- [x] **P5+3** Flutter 文档
  - [x] `docs/FLUTTER.md`：写清楚 Flutter Semantics 行为 + 实测发现 + Skill 调用速查 + 已知限制
  - [x] **实测验证**：lend_pal KYC Personal Info 页用新 dump_hierarchy 成功，3.1 秒内拿到 20 个元素（11 个有 label/text）

**Flutter 战果**：升级前完全 dump 失败；升级后能从层级走 90%+ 操作，截图兜底只用在真正持续动画/视频的页面。

---

## 实战 · lend_pal KYC 全流程（2026-05-15）

> 在 P5+ 框架升级后用真实 Flutter app `lend_pal` (`com.lendpal.lend_pal`) 端到端跑一次 KYC 7 步流程，给出确凿的实战覆盖。

- [x] **R1** 前置确认 → Privacy 弹窗 → Permission 弹窗 → Home（带 75% 进度条动画）
  - 弹窗都是静态页，`ui.tap_element by:label="Agree"` 直接命中
  - 首页持续重绘 → `dump_hierarchy` 返回 `ui_busy` → 截图兜底点 Apply Now
- [x] **R2** KYC 1/7 Personal Info → 2/7 Employment → 3/7 Income → 4/7 Address
  - 表单输入字段普遍无 `content_desc` → 视觉读 label 坐标，按 y+138px 偏移定位输入框，`mobile_type_keys` 输入
  - "Next Step" 按钮全是 `clickable=true` 的 Button 类，有 `content_desc` 文本，可层级命中
- [x] **R3** KYC 5/7 Bank Card → 6/7 Face Verification → 7/7 Submit → 主页 Under Review
  - **Bank Name 是原生 PopupMenu**（不是 Flutter Canvas）：`ui.dump_hierarchy` 拿到 7 项 menu，按 text 直接点 "Chase"
  - **Date Picker 也是原生 widget**：35 个按钮全可访问（虽然这次没走到）
  - **Face Verification 是 mock 实现**：点 "Start Verification" 不调相机，直接 KYC complete → 跳回主页（状态从 "Apply Now / INSTANT APPROVAL" → "Under Review" + "Identity Verified" 绿对勾）
- [x] **R4** 收尾
  - 8 steps，0 crash，passed
  - 报告：`workspace/sessions/2026-05-14_172931_flutter-lendpal-kyc-continue/report.{md,html}`
  - 前序探索（Phase 1 启动 + Home + KYC 1-4）记在 `2026-05-14_170641_flutter-lendpal-full-flow/`

### 战术沉淀

1. **Flutter 静态页（含 native dropdown / date picker）层级查询 100% 可用**
   - `ui.tap_element by:label` 是 Flutter 上的主力 strategy（content_desc 通常有，identifier 通常没有）
   - 原生系统弹窗（PopupMenu / DatePicker / DropdownMenuItem 走的 _PopupRoute）走原生 widget，accessibility tree 完整
2. **表单输入字段定位技巧**
   - Flutter `TextFormField` 在层级里类是 `android.widget.EditText` 或 `android.view.View`，普遍无 `content_desc`
   - 实战行得通：读 label 文本坐标（label 自己有 content_desc）→ y+138px 是输入框中心
   - 一旦点中，`mobile_type_keys` / `adb input text` 直接灌内容，与 uiautomator 无关
3. **持续重绘页面的边界明确**
   - 首页：进度条 75% 一直转 → dump 失败
   - KYC 各子页：进度条只显示当前步数，静态 → dump 成功
   - 经验：要先 `ui.dump_hierarchy` 试一次再判断，不要假设整个 app 都是 busy
4. **page_hash 在 Flutter 上一样稳**：每次 KYC 步进 page_hash 变化，回退也能识别



| 日期 | 决策 | 理由 |
|---|---|---|
| 2026-05-14 | 项目路径定 `/Users/mac/mcp/app_test_ctrl` | 用户选择 |
| 2026-05-14 | Phase 1 优先 DevTest | 用户选择，价值立竿见影 |
| 2026-05-14 | 平台 Android 优先，iOS 后做 | 用户选择，adb 链路简单 |
| 2026-05-14 | MCP 语言用 TypeScript | 与 mobile-mcp 一致，方便借鉴 |
| 2026-05-14 | mobile-mcp 不 fork，直接用上游 npm | 减少维护成本 |
| 2026-05-14 | 多包管理用 npm workspaces 替代 pnpm | 用户环境无 pnpm，npm 10 已支持 workspaces |
| 2026-05-14 | 加 ui-mcp（不 fork mobile-mcp） | 用户偏好层级优先；自己起一个 MCP 维护成本低于 fork |
| 2026-05-14 | P4 iOS 仅做 Simulator + 仅做诊断 | 用户无 idb / 无真机；UI 操作复用 mobile-mcp，避免重复工作 |
| 2026-05-14 | ui-mcp **不**扩展 iOS 支持 | 没 idb → 没稳定层级源；skills 改成调 mobile-mcp 即可 |
| 2026-05-14 | dumpHierarchy 加 retry + `--compressed` | Flutter 持续重绘导致 `could not get idle state`；实测 retry 3.1s 内能拿到，大幅减少截图兜底场景 |
| 2026-05-14 | P0 不做 analyzer-mcp | 路径精简、去重留到 P3，先把闭环跑通 |
| 2026-05-15 | Flutter 静态页层级查询作为主路径，不一律走截图 | lend_pal 实测：弹窗 / KYC 子页 / 原生 dropdown / Face Verification 全能 dump；持续重绘只是少数页面 |
| 2026-05-15 | Flutter 表单输入用 "label_y + offset" 估算输入框坐标 | TextFormField 普遍无 content_desc，label 倒是有 → 读 label bounds + 固定偏移最稳；mobile_type_keys 不依赖 uiautomator |

---

## 问题记录

> 遇到的坑、待决问题、外部依赖 blocker 在此累积。

| 日期 | 问题 | 状态 | 解决方式 |
|---|---|---|---|
| - | - | - | - |

---

## 变更日志

| 日期 | 变更 |
|---|---|
| 2026-05-14 | 初始版本 |
| 2026-05-15 | 补"实战 · lend_pal KYC 全流程"小节；总览表去掉 P4/P5 stale 重复行，加 P5+ 与实战行；决策日志加两条 Flutter 实战经验 |
| 2026-05-15 | 跑通 P1 / P3 follow-up：SDK805 注入 NPE 验 devtest crash 检测；多步 path 验 ddmin 收敛（[2,3,4] → [4]）。测后源码已还原 + 重装干净 APK |
| 2026-05-19 | **alpha 开源准备**：补 MIT LICENSE；`.mcp.json.example` 用 `${PROJECT_ROOT}` 占位；加 `scripts/setup-mcp.mjs` + `npm run setup`；README 加 license badge / smart-qa 用例 / 修组件计数（5 MCP / 4 skill / 43 工具 / 57 单测）。`.gitignore` 已覆盖 workspace/sessions |
| 2026-05-19 | **跨客户端通用化**：`skills/` 提升为 canonical 源；新增 `scripts/install-skills.mjs` 支持 4 客户端（claude-code / cursor / claude-desktop / codex）；`setup-mcp.mjs` 扩展 `--client`（cursor 写文件，claude-desktop / codex 打印 snippet 不动 global config）；smart-qa 移除 `AskUserQuestion` 改为中立列表选择；`doctor.mjs` 改为扫 `skills/` 源 + 检测 `.claude/skills/` clone 漂移；补 `code-analyzer-mcp` 到 doctor 的 SERVERS 列表；新增 `docs/CLIENTS.md` 覆盖支持矩阵 |
| 2026-05-19 | **Codex skill 双安装**：`install-skills.mjs --client codex` 现在同时写 `~/.codex/skills/<name>/SKILL.md`（用户级标准路径，跟 Claude Code `.claude/skills/` 等价）和项目根 `AGENTS.md`（聚合 prompt 注入）。`--force` 才覆盖已存在文件，避免误伤手动改动；和现有 `~/.codex/skills/lanhu-*` 共存无冲突 |
| 2026-05-19 | **AI-driven install 指引**：新增 `docs/INSTALL_FOR_AI.md`——用户把整份文档粘进自己的 AI 聊天框，AI 按步骤分支（识别客户端 → clone → build → 注册 MCP → 装 skill → doctor 验证）接力完成安装。README 顶部加"懒人路径"指引 |
