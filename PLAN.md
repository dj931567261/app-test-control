# AI 移动端自动化测试平台 · 方案文档

> 版本：v1.0 · 创建于 2026-05-14
> 当前阶段：P0 底座（详见 [PROGRESS.md](./PROGRESS.md)）

## 1. 项目目标

构建基于 MCP + LLM 的移动端自动化测试平台，服务两类用户。

| 角色 | 触发场景 | 核心价值 | 期望延迟 |
|---|---|---|---|
| 开发者 | 写完代码 / 提交前 | 30 秒内验证改的功能不崩、走得通 | < 1 分钟 |
| 测试人员 | 日常 / 发版前 | 自动探索找 bug，出可复现的报告 | 10–60 分钟 |

**核心差异**：DevTest "窄而深"（只测改动相关），QA "宽而广"（覆盖找未知 bug）。两者共用底座，编排不同。

## 2. 已确认的决策

| 项目 | 决定 | 备注 |
|---|---|---|
| 项目路径 | `/Users/mac/mcp/app_test_ctrl` | |
| 优先 Agent | DevTest（场景 1） | QA 在 Phase 2 |
| 优先平台 | Android | iOS 在 Phase 4 |
| MCP 语言 | TypeScript | 与上游 mobile-mcp 对齐 |
| 多包管理 | npm workspaces | npm ≥ 7 原生支持 |
| 报告格式 | Markdown 主 + HTML 附 | LLM 友好、可分享 |
| Agent 编排 | Claude Code Skill | 复用现有 SKILL.md 机制 |

## 3. 整体架构

```
app_test_ctrl/
├── PLAN.md                       # 本文档
├── PROGRESS.md                   # 进度跟踪
├── README.md                     # 用户文档
├── package.json                  # 根，含 workspaces 配置
├── config.yaml                   # 设备 / 包名 / 阈值
│
├── mcp-servers/                  # MCP 工具层（被 Claude 调用）
│   ├── log-mcp/         ⭐自研   # logcat/ANR/tombstone/.ips
│   ├── report-mcp/      ⭐自研   # markdown/HTML 报告
│   ├── ui-mcp/          ⭐自研   # uiautomator 层级查询 + 智能点击
│   └── analyzer-mcp/    ⭐自研   # 路径精简 + crash 去重（Phase 3）
│   └── (mobile-mcp 用上游 npm 包，不 fork)
│
├── skills/                       # Claude Code Skill（Agent 编排）
│   ├── devtest/SKILL.md
│   └── qa/SKILL.md               # Phase 2
│
├── workspace/                    # 运行时数据
│   └── sessions/<timestamp>/
│       ├── steps/                # 每步截图 + log 切片
│       ├── crashes/              # 崩溃归档
│       ├── state-graph.json      # QA 状态图（Phase 2）
│       └── report.md
│
└── test-plans/                   # 用户编写的用例 (可选)
```

## 4. 核心 MCP 工具设计

### 4.1 log-mcp（关键路径）

| 工具 | 作用 | 实现要点 |
|---|---|---|
| `clear_logs()` | 清当前 logcat 缓冲 | `adb logcat -c` |
| `start_capture(session_id, package?)` | 后台抓 log 落盘到 session 目录 | `adb logcat *:V > file &` |
| `stop_capture()` | 停止抓取 | kill bg pid |
| `get_recent_crashes(seconds=30, package?)` | 拿最近 N 秒 FATAL/ANR/Native crash | grep 关键字 |
| `pull_tombstones(package)` | Android `/data/tombstones/` | `adb pull` |
| `pull_anr_traces()` | Android `/data/anr/traces.txt` | `adb pull`（需 root 或 bugreport 兜底） |
| `pull_ips_files(bundle_id)` | iOS 崩溃日志（Phase 4） | `~/Library/Logs/DiagnosticReports/` |
| `get_memory_info(package)` | 内存快照（可选） | `dumpsys meminfo` |
| `list_devices()` | 列出连接的设备 | `adb devices` |

**Crash 关键字**（用于 `get_recent_crashes`）：
- `FATAL EXCEPTION`
- `AndroidRuntime`
- `ANR in `
- `*** *** *** *** *** ***`（Native crash 标志）
- `Tombstone written to`

**实现规模**：约 250 行 TypeScript，本质是 `adb` 的薄包装。

### 4.2 report-mcp

| 工具 | 作用 |
|---|---|
| `start_session(name, meta?)` | 创建 session 目录，返回 id |
| `record_step(session_id, action, screenshot_path, log_excerpt?, result?)` | 记录一步操作 |
| `record_crash(session_id, stack, repro_path, log_full_path)` | 记录一次崩溃 |
| `finalize(session_id, status, summary?)` | 出 markdown 报告 |
| `get_session_path(session_id)` | 返回 session 根目录路径 |

**目录约定**：
```
workspace/sessions/<YYYY-MM-DD_HHmmss>_<name>/
├── meta.json
├── steps/
│   ├── 001_launch_app.png
│   ├── 001_launch_app.log
│   └── 001_launch_app.json   # {action, result, timestamp}
├── crashes/
│   ├── 1/
│   │   ├── stack.txt
│   │   ├── full.log
│   │   └── repro.json        # 复现路径
├── report.md
└── report.html (可选)
```

**报告样板**：见 [`docs/report-template.md`](./docs/report-template.md)（运行时生成）。

### 4.3 ui-mcp（层级查询 + 智能点击）

> 策略：**view hierarchy 优先，截图视觉兜底**。直接调 `uiautomator dump`，绕开 mobile-mcp 的 JSON 接口，保证字段稳定。

| 工具 | 作用 |
|---|---|
| `dump_hierarchy(device?)` | 拉一份 uiautomator XML，返回元素列表 + 原始 XML |
| `find_element(by, value, device?)` | 单个查询，by ∈ identifier/text/label/text_contains/label_contains/class |
| `find_elements(by, value, device?)` | 多匹配 |
| `tap_element(strategies[], device?)` | 按 strategies 顺序找，第一个命中即点击中心；失败返回 fallback 提示 |
| `wait_for_element(strategies[], timeout_ms=5000, device?)` | 轮询直到出现或超时 |
| `input_text(strategies[], text, device?)` | 先点中目标输入框，再 input text |
| `page_fingerprint(device?)` | 取 identifier+text 算 hash，用于 QA 状态图 |

**匹配优先级**：`identifier`（resource-id）> `text` > `label`（content-desc）> 模糊。`identifier` 跨版本最稳，是默认优先项。

**坐标计算**：bounds `[x1,y1][x2,y2]` → center `((x1+x2)/2, (y1+y2)/2)`。

**Skill 调用约定（DevTest/QA 都遵守）**：
1. 先 `tap_element(strategies=[{by:"identifier"}, {by:"text"}])`
2. 命中 → 直接结束
3. 都不中 → `take_screenshot` + 视觉识别 + `mobile_click_on_screen_at_coordinates`
4. 走兜底时在 step record 里标记 `via_screenshot: true`，警告本步可能不可复现

### 4.4 analyzer-mcp（Phase 3 实现）

| 工具 | 作用 | 算法 |
|---|---|---|
| `minimize_repro_path(session_id, crash_id, repro_fn)` | N 步精简到最少 | Delta-Debugging 二分 |
| `dedup_crashes(crashes[])` | 同一 bug 合并 | top-3 帧 + 异常类 hash |
| `extract_signature(crash)` | 生成 crash 指纹 | 同上 |

## 5. Agent A：DevTest（开发自测）· Phase 1

### 触发方式
```
# Claude Code 里直接说
"测一下我刚才改的登录功能"

# 或 skill
/devtest [--scope login] [--device emulator-5554]
```

### 工作流（每步必做）

```
┌─ 1. 读变更
│   git diff HEAD~1 / git diff --staged
│   git log -1 --stat
│   → 列出改动文件 + commit message
│
├─ 2. 推断 UI 影响面
│   读改动文件 → 找类名 / Activity / Composable / Component
│   → 输出："本次改动可能影响：登录页、验证码页"
│
├─ 3. 生成测试计划（写入 session）
│   - happy path: 正常登录
│   - edge case 1: 错误手机号
│   - edge case 2: 网络断开
│
├─ 4. 执行循环（每步）
│   log-mcp.clear_logs
│   mobile-mcp.操作（点击 / 输入 / 滑动）
│   mobile-mcp.take_screenshot
│   log-mcp.get_recent_crashes(seconds=5)
│   report-mcp.record_step(...)
│   if crash: record_crash + 决策（继续/中止）
│
└─ 5. 出结论
    report-mcp.finalize
    终端打印：通过率 + 报告路径
```

### 输出示例
```
✅ 登录功能测试 (8/8 通过, 23s)
   ✓ 启动 app
   ✓ 点击「登录」
   ✓ 输入手机号 13800138000
   ✓ 点击「获取验证码」
   ✓ 输入验证码 123456
   ✓ 点击「确认」
   ✓ 跳转首页成功
   ✓ 无崩溃 / 无 ANR
报告: workspace/sessions/2026-05-14_103022_login/report.md
```

## 6. Agent B：QA（自动探索）· Phase 2

### 触发方式
```
/qa --scope all                  # 全 app 探索（默认上限 60 分钟）
/qa --scope payment              # 限定模块
/qa --plan test-plans/v2.md      # 跟用例走
```

### 工作流
1. **冷启动**：app 初始页 → 截图 → 哈希成 `page_id`，写入状态图
2. **探索循环**：
   - `mobile-mcp.list_elements_on_screen` 拿可交互元素
   - 选择策略（优先级）：
     - 未访问过的元素 ⭐
     - 通往新页面的元素
     - 概率性回退到老路径（避免局部困死）
   - 执行 + 截图 + 日志快照
   - 更新状态图：`(page_id, action) → next_page_id`
3. **崩溃处理**：
   - 检测到 FATAL → 完整路径入 `crashes/`
   - 自动重启 app → 继续探索
4. **后处理**：
   - `analyzer.minimize_repro_path` 每个 crash 路径压最短
   - `analyzer.dedup_crashes` 合并相同 bug
   - 生成报告 + bug 列表

### 输出示例
```
🔍 探索完成 (62 min, 487 步, 31 个页面)
📊 7 次崩溃 → 去重后 3 个独立 bug
🐛 #1 NPE in LoginActivity   触发 5 次  最短 3 步
🐛 #2 ANR after rotation     触发 1 次  最短 4 步
🐛 #3 Crash on empty payment 触发 1 次  最短 5 步
报告: workspace/sessions/2026-05-14_qa/report.md
```

## 7. 关键算法

### 7.1 Delta-Debugging（路径精简）
```
输入: 崩溃路径 [s1, s2, ..., sN]
策略: 二分删除步骤，重跑验证仍崩溃
输出: 最小子集
代价: 平均 log(N) × 单次执行时间
```
DevTest 用不到（路径本来就短），QA 必须用。

### 7.2 Crash 去重指纹
```ts
signature = sha1(
  exception_class,          // "NullPointerException"
  top_3_frames_normalized,  // 去掉行号，保留类名+方法名
  root_cause_class          // 嵌套异常的最深一层
)
```

### 7.3 状态图（QA 用）
```json
{
  "pages": {
    "page_a3f2": { "elements": [...], "screenshot": "...", "visit_count": 3 },
    "page_b91c": { ... }
  },
  "edges": [
    { "from": "page_a3f2", "action": "click(login_btn)", "to": "page_b91c", "count": 1 }
  ]
}
```
作用：避免无限绕圈、识别覆盖死角、生成探索热力图。

## 8. 技术选型详情

| 模块 | 选择 | 备选 | 理由 |
|---|---|---|---|
| MCP 语言 | TypeScript | Python | 与 mobile-mcp 一致 |
| MCP SDK | `@modelcontextprotocol/sdk` | - | 官方 |
| 包管理 | npm workspaces | pnpm/yarn | 用户环境已有 npm，无需额外装 |
| 构建 | tsx (dev) + tsc (prod) | esbuild | 简洁 |
| 平台 | Android（adb） | iOS（idb/simctl） | adb 链路最稳 |
| 测试 | vitest | jest | 快 |
| 报告 | Markdown | HTML 模板引擎 | Phase 1 只输出 markdown，HTML 留 Phase 5 |
| 配置 | YAML | TOML/JSON | 人类可读 |

## 9. 分阶段交付

| 阶段 | 时长 | 关键产出 | 可演示场景 |
|---|---|---|---|
| **P0 底座** | 3–5 天 | log-mcp + report-mcp 跑通 | 手动调用抓 crash 出报告 |
| **P1 DevTest** | 1 周 | 开发自测 skill 完整 | "测一下我改的登录" 一句话验证 |
| **P2 QA 探索** | 2 周 | QA skill + 状态图 | 跑 30 分钟挖出 crash |
| **P3 智能后处理** | 1 周 | analyzer-mcp + 复现精简 | 12 步压到 3 步 |
| **P4 iOS** | 1 周 | log-mcp 扩展 iOS | iOS 模拟器走通 |
| **P5 打磨** | 持续 | HTML 报告 / CI / 文档 | 开源就绪 |

**MVP（P0+P1）约 2 周可用，月内可给 QA 团队试用 P2。**

## 10. 验收标准

### P0 验收
- [ ] 在 Claude Code 里挂上 log-mcp + report-mcp
- [ ] 能手动调用：`start_session → record_step → record_crash → finalize`
- [ ] 能从 logcat 抓出真实 crash 并写入报告
- [ ] 报告 markdown 在编辑器里可读

### P1 验收
- [ ] 在 Claude Code 里说"测一下登录"，能自动跑完
- [ ] 报告内包含：git diff 摘要 + 测试计划 + 每步截图 + 结论
- [ ] 故意改个 bug 让它崩，报告里能定位到崩溃步骤 + stack

### P2 验收
- [ ] `/qa --scope all` 跑 30 分钟，自动探索 ≥ 20 个页面
- [ ] 状态图正确（无重复探索同一页 > 5 次）
- [ ] 至少能在已知 buggy app 上挖出预埋的 crash

## 11. 已知风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| LLM 选错元素导致测试不可重复 | 误报率高 | 关键步骤记录 element resourceId，下次优先用 ID 而非 LLM 决策 |
| logcat 噪音大，crash 检出误判 | 假报告 | 严格关键字 + 进程匹配 + 时间窗口 |
| ANR traces.txt 需要 root | 无法获取 | 兜底用 `adb bugreport` 提取 |
| iOS 崩溃日志获取慢 | 用户体验差 | Phase 4 再做，先专注 Android |
| token 消耗大 | 成本不可控 | Skill 模板压缩 + 截图只保留最近 N 张到上下文 |

## 12. 未来扩展（暂不实现）

- HTML 可视化报告（含步骤动图）
- CI 集成（GitHub Actions runner）
- 多设备并行测试
- Web 控制台
- 测试用例自动生成（从 PRD → markdown）
- 翻译 AI 跑通的 case 到 Maestro/Appium 脚本，进 CI 跑回归

---

**下一步**：见 [PROGRESS.md](./PROGRESS.md) 当前阶段。
