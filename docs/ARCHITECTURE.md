# 架构总览

## 角色与数据流

```
┌────────────────────────────────────────────────────────────────────┐
│                           Claude Code                              │
│                                                                    │
│   ┌──────────────┐   ┌──────────────┐   ┌──────────────────────┐   │
│   │ /devtest     │   │ /qa          │   │ /minimize            │   │
│   │ skill        │   │ skill        │   │ skill                │   │
│   └─────┬────────┘   └─────┬────────┘   └─────┬────────────────┘   │
│         └──────────────────┼──────────────────┘                    │
│                            ▼                                       │
│                   stdio (JSON-RPC over MCP)                        │
└────────────────────────────┬───────────────────────────────────────┘
                             │
        ┌────────────────────┼────────────────────┬────────────────┐
        ▼                    ▼                    ▼                ▼
┌──────────────┐    ┌──────────────┐    ┌──────────────┐  ┌──────────────┐
│  mobile-mcp  │    │   ui-mcp     │    │   log-mcp    │  │ analyzer-mcp │
│  (upstream)  │    │              │    │              │  │              │
│              │    │ uiautomator  │    │ logcat /     │  │ sig/dedup/   │
│ list/launch  │    │ dump + tap   │    │ ANR / .ips   │  │ .ips parse   │
│ /screenshot  │    │ (Android)    │    │              │  │              │
└──────┬───────┘    └──────┬───────┘    └──────┬───────┘  └──────┬───────┘
       │ adb / simctl      │ adb              │ adb /             │ (pure)
       ▼                   ▼                  ▼ simctl            ▼
┌──────────────────────────────────────────────────────┐  ┌──────────────┐
│            Android device / iOS simulator             │  │  report-mcp  │
│  (subject under test)                                 │  │              │
└──────────────────────────────────────────────────────┘  │  sessions +  │
                                                          │ state graph +│
                                                          │ md/html      │
                                                          └──────┬───────┘
                                                                 ▼
                                              workspace/sessions/<id>/
                                                ├─ meta.json
                                                ├─ steps.jsonl
                                                ├─ crashes.jsonl
                                                ├─ state-graph.json
                                                ├─ steps/  *.png + *.log
                                                ├─ crashes/  c1.stack.txt + c1.log
                                                ├─ logs/  logcat.txt or ios-log.txt
                                                ├─ report.md
                                                └─ report.html
```

线上崩溃修复链路独立于设备实时采集链路：

```text
首次选择唯一 Firebase Connection Profile
        ├─ service-account
        │    服务账号 JSON 绝对路径 + 显式 Project ID + App 项目绝对目录
        │    → 稳定核验后创建一次性 0600 凭据副本
        │    → 网关用私有 configstore 绑定项目
        │    → 不要求/不创建 .firebaserc，也不把它作为项目来源
        │    → 已存在时仅有界检查 alias 冲突
        │
        └─ firebaserc
             Firebase CLI 已登录 + App 项目目录已有 .firebaserc
             → setup 只校验，不自动创建
             → 私有复制一个登录账号并覆盖精确项目绑定
             → 不继承宿主 activeProjects
        ↓
Firebase Crashlytics
        ├─ 默认（测试/已确认低敏）→ firebase-readonly-mcp
        │    → 固定上游 firebase-tools@15.24.0 mcp --only crashlytics
        │    → tools/list + tools/call 双层 8 工具 allowlist
        │    不要求 Cloud Logging export
        │
        └─ production-safe（显式）→ Cloud Logging export
             → crashlytics-mcp（只读、allowlist、脱敏、规范化）
        ↓
analyzer-mcp（远端事件 signature_version + fingerprint）
        ↓
code-analyzer-mcp（app-owned frame → sealed source snapshot）
        ↓
build-runner-mcp（snapshot Android 双模式构建/APK pin：默认 local_trusted，可选 docker_strict）
        ↓
crashfix Skill → 分析/独立 candidate → devtest/minimize → report-mcp
        ↓
同一 Sessions Viewer（Firebase 修复卡片、根因/建议、strict 3 次验证关联）
```

两个 Connection Profile 都是完整且互斥的接入路径。Agent 必须先询问用户选择，选定后
单路由执行；任一路径失败都不会自动回退到另一条。配置发生变化后，客户端必须完整重启
才能加载新进程环境。`service-account` 路径下，Agent、setup 与 doctor 只处理凭据文件的
绝对路径和必要元数据，不读取、回显、归档或提交 JSON 内容；Project ID 也必须由用户显式
提供，不能从凭据内容推断；网关只为消除校验到使用的路径漂移而做不解析内容的私有快照。
`firebaserc` 路径也不把宿主 `activeProjects` 带入上游。网关基于已验证的真实 App 目录选择并
锁定 Profile，随后把 Project ID 绑定到隔离的私有上游目录；真实目录不会暴露给官方子进程
重新扫描。两条路径都只完成认证和项目绑定，Crashlytics 所需 IAM 权限仍须独立配置。重启后
用 `firebase_get_environment` 核对运行身份和私有上下文、`firebase_get_project` 机械核对
Project ID/Number、`firebase_list_apps` 核对目标 App ID；不能把 environment 返回的私有目录
或可能为空的 Detected App IDs 与真实 App 信息比较。Codex 的服务账号
Profile 只允许项目级 `.codex/config.toml`，不能进入全局配置；doctor 保留实际选中的
project/global 两层，按 global → project 对 MCP server key 做有效配置合并，并把全局服务
账号 Profile 判为 invalid，即使它已被项目同名项遮蔽。任一已存在层无法安全解析时整体
fail-closed，不使用另一层给出假绿。

Firebase 网关的私有凭据/configstore 在正常关闭或启动失败的受控收尾中立即清理。强杀、
崩溃或断电可能留下残留；后续受控启动只会清扫严格满足受管命名、当前用户 owner、私有
权限、有效 lease、最小年龄且 PID 已失活等全部条件的旧目录，Windows 默认不清扫。该机制
不能覆盖 lease 写入前的极短窗口、未知目录或同 UID 对抗进程，因此只是有界残留收敛，不是
宿主/凭据强隔离，也不能把“重启”解释为所有历史残留均已删除。

客户端不直连官方进程。项目内 `firebase-readonly-mcp` 只注册 8 个固定读取工具，且在
转发前再次校验工具名、参数范围和响应类型/大小；官方 create/update/delete/note 工具
对下游不可见。但该网关不是宿主或凭据隔离层，也不会在 Agent 看到官方 event 文本前做
服务端脱敏。因此 official 路径仅允许测试/已确认低敏项目；生产或敏感度未知时必须显式
选择本仓 Cloud Logging MCP，不能绕过其服务端脱敏边界。

官方 `firebase-tools@15.24.0` 的 `tools/list` 会执行 Billing 探测，并可能进入
`services:enable` 轮询。网关以 `node --import` 预加载项目内固定 guard，在模块加载前将
Billing 能力保守钳制为 `false`、拒绝 API enablement；仅对
`firebase_get_project` 固定的 Resource Manager 只读 GET 前置调用无副作用短路
`bestEffortEnsure`，其他形状仍 fail-closed。guard 同时禁用 GA4；还把
`--only crashlytics` 下的 active feature discovery 固定为唯一目标，替换会经宿主 `PATH`
执行 `firebase --version` 的命令发现，并只在 `tools/list` 的动态范围内把认证发现固定为
`null`；退出枚举后立即恢复原方法，实际工具调用仍必须完成官方认证。guard 与官方 CLI
使用同一个精确 package root；其
规范文件身份、固定版本和内部导出形状都在启动时核验，任何漂移均 fail-closed。这里的
Billing `false` 只是能力抑制，不是项目真实计费状态；preload 也不等价于网络、宿主或凭据隔离。
无参数 `firebase_get_crashlytics_report_guide` 是唯一公开的 Reports guide 工具；网关内部
才以硬编码 URI 调用一次上游 `firebase_read_resources`，客户端不能列举、提供或改变 URI。
每个需要 `topIssues`/`topVersions` 的 report session 必须在 session 建立后、首次相应 report
前调用别名恰好一次，且不能用进程缓存或其他 session 的成功结果作为顺序证明。
CrashFix 还会在 report session 顶层写入严格 `source_lock`，每次远端 crash 归档都要
提供同一路由；report-mcp 在原子锁内拒绝缺失或不一致的 acquisition route。
用户选定唯一 project/app/issue/build 后，必须先调用 `record_crashfix_target` 绑定不可变目标，
再归档 crash，并用 `record_crashfix_analysis` 原子绑定同一 analyzer identity 的脱敏根因、
修复建议、最多 3 个规范相对源码位置与限制；每条 source、analysis、candidate 和 finalize
都会重检该目标。Analyzer 的
`signature_version/fingerprint/signature_degraded/cross_source_comparable` 以结构化字段归档，
缺字段、降级签名或不可跨源比较的证据不能进入候选或成功终态。

本地源码身份由 `provenance=auto|git|snapshot` 独立选择，并在预检闭合为
`provenance_status=resolved|unavailable`：

```text
auto      + 有效 Git  → resolved / git_release_exact
auto      + 确认无 Git → resolved / snapshot_repro_equivalent
auto      + 损坏 Git  → unavailable（不自动切换）
git       + 无效 Git  → unavailable
snapshot  + 任意 Git 状态 → resolved / snapshot_repro_equivalent
```

`unavailable` 不伪造 provenance mode：原请求为 `analyze` 时只能做 remote-only 分析；
`patch/pr` 在审计 session 建立后立即 preflight abort，不调用任何 Firebase 身份或详情
工具。所有 `pr` 的契约都只允许 `resolved + git_release_exact`，但当前 Build Runner 不接受
Git worktree/release snapshot，Git `patch/pr` 会在首条项目命令前中止。snapshot `analyze` 经审批创建
sealed snapshot 后只做静态定位，不创建 baseline、不构建/安装产物，也不要求真机；
snapshot `patch` 才要求独立 baseline/candidate，并在专用真机复现同一
`(signature_version, fingerprint)`。snapshot 路径不能宣称与历史发布源码逐字节一致，
也永久放弃 commit、push 和 PR 能力。
已接受的 snapshot 候选只能按独立审批导出到全新目录；导出 helper 用独立的
`--original-workspace` 绑定原项目身份，不能把禁止重叠用的 `--forbid-root` 当作替代。

Build Runner 的 execution profile 在 session 内锁定：默认 `local_trusted` 适合用户明确确认
的低敏可信项目，但 `strong_isolation=false`、网络/文件/宿主秘密/磁盘 quota 隔离均未强制，
`process_containment=process_group_best_effort`；可选
`docker_strict` 才提供强容器隔离。profile 失败不会自动切换，改变选择需新建 session。
cache seal 必须在 probe 通过后另行批准，只返回进程内 opaque
`cache_seed_id`；create 用该 ID，并在 build phase 绑定当时不存在的 APK path 与已批准
非生产 signer hash。每次 create 前必须紧邻 audit，并绑定完整
`expected_workspace_manifest_sha256/expected_workspace_canonical_diff_sha256`；create/run 都返回
与该次 audit 一致的 role、workspace manifest 与 canonical diff 三字段。workspace identity
独立于公共 `build_environment_sha256`，因此相同命令可比较公共执行环境，同时分别约束
baseline/candidate 源码状态。run 只返回有界 hash；inspect 只接收 environment ID、消费私有
staging 并严格核对 signer。local 使用最小 ENV、私有 HOME/TMP/Gradle cache 副本、offline
flag、超时和进程组清理，但不能声明 sandbox/hermetic。Docker 的 tmpfs/CPU/内存/pids
有界，但可写 workspace 是宿主 bind；尚未强制宿主磁盘 quota，所以 strict probe 仍返回
`HOST_WORKSPACE_DISK_QUOTA_UNENFORCED`。
Runner 的 opaque lease 仅存在于进程内；异常退出没有 startup sweep，不能跨重启恢复待
inspect APK 或 retained cache 的清理 ID，也不能把重启当成容器/staging 已清理证明。

## 9 个默认注册 MCP 的分工

其中 8 个由本仓实现；`mobile-mcp` 是直接注册的上游 server，`firebase-readonly-mcp`
则在内部受控启动固定版官方 Firebase MCP：

| MCP | 工具数 | 角色 | 平台 |
|---|---|---|---|
| **log-mcp** | 18 | 抓 logcat / ANR / tombstone / iOS log stream / `.ips` 文件 | Android + iOS Simulator / 真机 |
| **report-mcp** | 16 | session、CrashFix target/analysis/snapshot/candidate provenance、Markdown/HTML 报告、QA 状态图 | 平台无关 |
| **ui-mcp** | 7 | uiautomator dump + 智能点击 + page_fingerprint | Android only（无 idb） |
| **analyzer-mcp** | 7 | crash signature / dedup / 路径精简启发 / `.ips` 与规范远端事件解析 | 平台无关 |
| **code-analyzer-mcp** | 6 | 项目静态信号提取 + 崩溃 frame 定位 + quick 有界源码读取 | 平台无关 |
| **build-runner-mcp** | 6 | snapshot Android/Gradle 双模式构建、cache lease 与 APK pin；本机可信默认、Docker 严格可选 | Android |
| **crashlytics-mcp** | 7 | 可选的 production-safe Cloud Logging 只读查询、allowlist、脱敏和规范化 | Firebase Android/iOS |
| **mobile-mcp（上游）** | 上游工具集 | 设备发现、启动、交互与截图 | Android + iOS |
| **firebase-readonly-mcp** | 8 | CrashFix 默认 acquisition 网关；内部调用固定版官方 MCP，仅限测试/已确认低敏项目 | Firebase Android/iOS |

**为什么 ui-mcp 不在 iOS 上工作**：用户机器没装 idb，没有稳定的层级查询通道。
Skills 在 iOS 时自动回退到 `mobile-mcp.mobile_list_elements_on_screen`（mobile-mcp 自己用 WebDriverAgent / accessibility）。

## 5 个 Skill 的分工

| Skill | 输入 | 输出 | 典型耗时 |
|---|---|---|---|
| **devtest** | git diff（或 --scope） | "刚改的功能能不能跑" 短结论 + 报告 | < 1 分钟 |
| **qa** | --package | 自动探索 → bug 列表 + 覆盖统计 | 10–60 分钟 |
| **minimize** | session_id + crash_id | 验证过的最小复现路径 | 1–10 分钟 |
| **smart-qa** | PRD / 项目静态信号 | 聚焦业务测试计划并交给 QA 执行 | 1–60 分钟 |
| **crashfix** | 单个 Firebase app/build/issue + Git SHA 或源码快照 | 根因分析；snapshot Android 可生成独立候选并本地验证，Git 可选 Draft PR 契约 | 数分钟–数十分钟 |

## 关键数据结构

### Session 目录（report-mcp 拥有）

```
workspace/sessions/<YYYY-MM-DD_HHmmss>_<name>/
├── meta.json           { id, name, status, report_language?, crashfix_analysis?, source_lock?, extra? }
├── steps.jsonl         每行一个 step：{ index, ts, action, result, screenshot?, log_excerpt?, notes? }
├── crashes.jsonl       每行一个 crash：{ id, ts, step_index?, signature, kind?, stack_path, log_path?, repro_path }
├── state-graph.json    QA 状态图：{ pages: { hash → page_data }, edges: [...] }
├── steps/              001.png + 001.log
├── crashes/            c1.stack.txt + c1.log
├── logs/               logcat.txt (Android) 或 ios-log.txt (iOS)
├── report.md           Markdown 报告
└── report.html         HTML 报告（自包含，可直接浏览器打开）
```

`npm run sessions` 不复制原始 Firebase 数据，也不让浏览器连接 Firebase。服务端读取上述
Session 文件后先做 schema/身份重检，再生成闭合公开投影：CrashFix 列表项带
`session_type/workflow/mode/acquisition_route/current_stage`；详情额外显示结构化根因、修复
建议、相对源码位置和从既有 provenance 派生的候选/验证/导出状态。原始
project/app/issue/event、凭据路径、设备 serial、绝对路径、完整私有 hash、日志正文和源码
正文都不会进入 API。strict 验证子 Session 只有在父子 identity、artifact、run 号、语言与
时间关系全部闭合核验后才显示关联。

### Crash signature（analyzer-mcp）

```
fingerprint = sha1(
  kind +                    # java | anr | native | ios
  signature_version_domain + # java-v2 / ios-v2；v1 为空
  exception_class +         # "java.lang.NPE" 或 "EXC_BAD_ACCESS"
  primary_frames_normalized + # Java 最多 3 帧，iOS 最多 4 帧
  root_cause_class +        # 嵌套 Caused-by 最内层
  signal +                  # SIGSEGV (iOS/native)
  process                   # 包名/bundle id (ANR/iOS)
).slice(0, 12)
```

Crash 身份为 `(signature_version, fingerprint)`，不能只比较 12 位 fingerprint。
行号变化、空白变化 → 同一身份。类名/方法名变化、异常类型变化 → 不同身份。

### State graph（report-mcp，QA 用）

```jsonc
{
  "pages": {
    "<page_hash>": {
      "hash": "...",
      "first_seen": "ISO",
      "last_seen": "ISO",
      "visit_count": 3,
      "elements_seen": ["jko.dns.qwn.dfgt:id/btn", "text:登录"]
    }
  },
  "edges": [
    { "from": "<hash_a>", "action": "click 登录", "to": "<hash_b>", "ts": "ISO" }
  ]
}
```

`pick_next_unseen` 用这份数据决定下一步点哪。`elements_seen` 跨 app 重启持久化，
重启后回到相同 page_hash 不会重复点已点过的元素。

## 工作流编排（Skill = LLM 解释执行）

每个 Skill 是一份 Markdown 提示词，描述：
1. 何时被触发（description 里写关键词）
2. 工具调用顺序（Phase 0 → Phase N）
3. 失败兜底逻辑
4. 输出格式

Claude 加载 SKILL.md 后**逐条 MCP 工具调用**完成工作流。这种"提示词即编排"的好处：
- 调整流程不用改代码，只改 SKILL.md
- 同一套底座工具能服务多种工作流
- 工作流的可读性 = 代码评审难度

## 测试金字塔

```
                ▲   smoke/config handshake             9 个注册 MCP（8 个项目内 + mobile 上游）
               ▲ ▲  unit (parsing / hashing / graph)   ~50 个
              ▲ ▲ ▲ integration (real device)          1 次/skill
             ▲ ▲ ▲ ▲ e2e (skill 在真机跑完整流程)        手动
```

CI 跑 unit + smoke（不需要设备）。integration / e2e 用户在本机跑。
