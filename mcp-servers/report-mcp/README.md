# report-mcp

MCP server for test session and Markdown report generation.

## 安装

```bash
npm install
npm run build -w mcp-servers/report-mcp
```

## 注册到 Claude Code

```json
{
  "mcpServers": {
    "report-mcp": {
      "command": "node",
      "args": ["/Users/mac/mcp/app_test_ctrl/mcp-servers/report-mcp/dist/index.js"],
      "env": {
        "APP_TEST_CTRL_WORKSPACE": "/Users/mac/mcp/app_test_ctrl/workspace/sessions"
      }
    }
  }
}
```

## 工具列表

| 工具 | 说明 |
|---|---|
| `start_session` | 建 session 目录，锁定报告语言，返回 id + 绝对路径 |
| `record_crashfix_target` | 在任何 CrashFix crash 归档前，一次性绑定用户选定的 Firebase project/app/issue 与 platform/app/version/build；仅持久化域分离哈希，同值重试幂等 |
| `record_crashfix_analysis` | 在 target 与同一 Analyzer 身份的 Firebase 证据归档后，原子绑定一份有界根因分析；顶层持久化、同值重试幂等、异值冲突拒绝 |
| `record_snapshot_provenance` | 为 running 的 CrashFix snapshot session 原子绑定 sealed source hash、批准测试 fixture 集摘要与有界计数；同值重试幂等 |
| `record_candidate_provenance` | 按 candidate → verification → export 三阶段原子绑定无 Git 修复候选身份；candidate 同时绑定诚实的 Build Runner execution profile，verification 由三个真机 child session 证据派生，严格顺序且同值重试幂等 |
| `record_step` | 追加一步（支持 screenshot/log 导入） |
| `record_crash` | 仅在 running 状态追加 crash；新 CrashFix Firebase source 强制结构化 `signature_version`、`signature_degraded`、`cross_source_comparable` 并支持严格幂等 |
| `finalize` | 设状态 + 生成 `report.md`；验证 child 的 passed 终态必须同时封存结构化完成证据 |
| `regenerate_report` | 不改状态、重新渲染 `report.md` |
| `get_session_path` | 由 id 解析 session 目录 |
| `list_sessions` | 列工作区内所有 session（按时间倒序） |
| `graph_record_page` | 记录 QA 页面节点 |
| `graph_record_edge` | 记录 QA 页面跳转边 |
| `graph_mark_element_seen` | 标记页面元素已探索 |
| `graph_pick_next_unseen` | 选择下一未探索元素 |
| `graph_summary` | 汇总 QA 状态图覆盖情况 |

## 目录约定

```
workspace/sessions/<YYYY-MM-DD_HHmmss>_<name>_<random>/
├── meta.json
├── steps.jsonl          # 每行一个 step
├── crashes.jsonl        # 每行一个 crash
├── steps/
│   ├── 001.png          # screenshot
│   └── 001.log          # log snippet
├── crashes/
│   ├── c1.stack.txt
│   └── c1.log
├── logs/                # 由 log-mcp.start_capture 写入
│   └── logcat.txt
└── report.md
```

新建 workspace/session/证据目录使用 `0700`，JSONL、stack、日志与报告使用 `0600`；
导入证据拒绝最终 symlink 并有大小上限；`meta.json` 与 JSONL 都采用有界、nofollow、
严格 UTF-8/schema 读取，step 证据路径必须与其三位补零 index 一致。
所有按 session 定位的工具都要求恰好提供 `session_id` 或绝对 `session_dir`；
`session_id` 只允许单个安全路径段，禁止 `../` 越界，`workspace_root` 仅能与
`session_id` 搭配。
带 `provenance_status` 的 CrashFix `start_session.extra` 使用闭合白名单，只允许
有界控制枚举、安全 alias、`raw_evidence_archived=false` 与 Git 路径的完整初始
object id；token、凭据路径、原始事件、任意嵌套字段和所有派生候选字段都会在建
session 前拒绝。普通 devtest 的通用 `extra` 保持兼容。
其中 `requested_workflow` 为 `quick_test|strict`。兼容旧客户端时，若 CrashFix 已提供
`requested_mode` 但尚未提供该字段，Report 只会安全地补为 `strict`；它绝不会自行推断
`quick_test`。`quick_test` 仅接受
`requested_mode=analyze`、`provenance_status=unavailable`、
`requested_execution_profile=local_trusted` 和 `workspace_project_classification=test`；
父 CrashFix session 只做远端分析，并且服务端最多归档一个不同的 Firebase 事件（同一
`external_key` 重试仍幂等）。它不会进入 snapshot candidate 生命周期。直接工作树编辑和
一次本机验证应记录在**独立**普通 devtest 子 session；Report 不做父子机械绑定或结果聚合，
最终回复并列父 CrashFix 与 devtest 两份报告；`strict` 不改变既有 candidate/verification/export 约束。
`record_crashfix_target`、`record_crashfix_analysis`、`record_snapshot_provenance`、
`record_candidate_provenance`、`record_step`、`record_crash` 与 `finalize`
共享跨进程 session 锁，终态 session 不可再追加步骤或崩溃。

## 报告语言

`start_session.report_language` 是顶层、不可变的展示控制，只允许：

- `zh-CN`：简体中文，也是未传参数时的默认值；
- `en-US`：仅在当前用户明确要求英文时选择。

调用方必须在读取 Firebase、源码、日志、设备 UI 或其他不可信内容前，根据当前用户的
明确要求锁定语言；这些内容以及宿主系统 locale 都不能改变选择。语言不会放入 CrashFix
的 `extra`，`finalize` 与 `regenerate_report` 也不接受语言覆盖，因此同一 Session
重渲染时不会漂移。旧 Session 缺少该字段时按 `zh-CN` 渲染。Markdown、HTML 标题和
状态等人类可读文案会本地化；action code、JSON key、provider、路径、hash、fingerprint
和 signature version 等审计技术字段保持原值。

渲染器不会猜测或机器翻译调用方传入的自由文本，避免把日志、设备 UI 或远端内容误当成
可信文案。调用方必须让 `summary`、普通测试步骤的 `action/notes`、测试计划和最终回复使用
Session 已锁定的语言；JSON key、枚举、状态码、包名、路径、ID 与各类身份摘要保持规范原值。
CrashFix parent 仍必须省略 caller-supplied `summary`，其闭合 action code 与 JSON notes 也
保持规范原值；中文报告只在展示层为已知 action code 增加中文名称，并保留原 code 供审计。

## CrashFix 根因分析记录

`record_crashfix_analysis` 只接受 `schema_version="crashfix-analysis/v1"`，并要求 Session
仍为 `running`、属于 CrashFix、未命中 preflight abort、已绑定唯一 target，且已归档至少一条
与输入 `target_signature_version + target_fingerprint` 完全一致的规范 Firebase 事件。
服务端会重新读取私有 stack 并重算 Analyzer 身份。分析写入顶层
`meta.crashfix_analysis`，不进入通用 `extra`；同值重试返回 `deduplicated=true`，任一异值
重试均拒绝。分析绑定后，既有 `external_key` 的精确 crash 重试仍幂等，但新事件会被拒绝，
避免证据集继续漂移。
服务端还会按事件 `external_key + 完整 canonical stack SHA-256` 的规范排序集合派生一个私有
`evidence_set_sha256`，并在 finalize、regenerate 与 candidate 生命周期中重算核对；该完整
摘要不进入工具响应或报告展示。
新的 running CrashFix Session 在 `finalize(passed)` 前必须已经绑定分析；已终态旧 Session 的
同状态重试仍按其不可变终态处理。进入 candidate 阶段还要求分析 `confidence=high`，后续
verification/export 与 patch passed 收尾会重新核验该门槛。

分析结构包含：有界纯文本根因、`low|medium|high` 置信度、闭合 category、最多 3 个按字节序
排列且唯一的相对源码位置、有界修复建议和最多 5 条限制。`provenance_status=unavailable`
（包括 quick parent）必须使用空 locations；snapshot 位置要求 sealed snapshot provenance，
Git 位置要求已有完整 commit identity。自由文本和路径会保守拒绝控制字符、URL、绝对路径、
完整 SHA-256、明显凭据/个人标识、原始 Firebase target/event 标识及 credential-like 路径。
这些规则是闭合、启发式的最小公开面约束，不应描述为通用数据防泄漏证明。

该结构没有任何 caller 可声明的“已构建”“已验证”或“已修复”字段；候选和三轮验证状态仍只
能由既有 candidate/child evidence 状态机派生。Markdown/HTML 仅对 CrashFix Session 增加
“根因分析”和“修复状态”区块，展示修复建议、限制、位置，以及从公开 provenance 机械派生
的 candidate、3/3 verification、export 和 changed files 状态；缺证据时明确显示尚未完成，
不会把父子关联误称为验证通过。标题服从不可变 `report_language`，category、
confidence、路径、fingerprint 和 signature version 保持规范技术值。`finalize`、
`regenerate_report` 与两个 renderer 都会再次核对分析所属 Session、target 和归档 Analyzer
身份；普通 QA/devtest 报告不增加该区块。

`record_snapshot_provenance` 的九字段证据组严格全有或全无：
`manifest_sha256`、`source_snapshot_sha256`、`exclusion_policy_sha256`、
`dynamic_exclusions_sha256`、`approved_test_fixtures_sha256`、
`approved_test_fixture_count`、`files`、`directories`、`bytes`。
其中批准 fixture 数量必须是 `0..8`；路径、entry 与内容都不属于接口，也不会持久化。
服务端必须按
`sha256("crashfix-workspace-source-snapshot/v2\0" + manifest + "\0" + exclusion
+ "\0" + dynamic + "\0" + approved_digest + "\0" + canonical_fixture_context_json
+ "\0" + decimal_count + "\0")`
机械重算并核对 source identity。完整 hash 与 count 只原子写入私有 `meta.extra`，同值重试
幂等，任一字段缺失、损坏、
冲突、终态写入或并发异值写入均 fail-closed。公开 MCP 返回、Markdown/HTML 与 Viewer
只展示允许公开的 hash 的 12 位前缀以及计数；`manifest_sha256` 完全保持私有。

批准 fixture 数量大于零时，session 初始控制必须同时锁定
`requested_execution_profile=local_trusted` 与
`workspace_project_classification=test`；`docker_strict`、缺失控制或其他分类均拒绝。
数量为零时不强制这两个控制。`workspace_project_classification` 只允许 CrashFix
`start_session.extra` 中的闭合字面值 `test`；安全公开投影最多显示这个规范值，不接受或
透传任意字符串。canonical fixture context 固定为
`{"schema_version":"crashfix-test-fixture-context/v1","enabled":false,
"execution_profile":"none","project_classification":"none"}`（count=0），或
`{"schema_version":"crashfix-test-fixture-context/v1","enabled":true,
"execution_profile":"local_trusted","project_classification":"test"}`（count>0）。

`firebase-crashlytics` source 必须包含 project/app/issue/event，且 `external_key` 必须等于
`sha256(provider\0project\0app\0issue\0event\0signature_version\0signature)`；读取缺少版本
的旧 session 时才兼容历史六元 key。CrashFix session 还必须先调用
`record_crashfix_target`，随后每条 source 的 project/app/issue 与
`app_build={platform,app_id,version,build}`、candidate artifact 和 finalize 重检必须共同匹配
该不可变 target；target 原值不会写入 `meta.json`。CrashFix candidate/finalize 还要求目标组
每条证据都明确满足 `signature_degraded=false` 且 `cross_source_comparable=true`；普通
devtest 的旧记录无需这两个字段。公开 Markdown/HTML 与 Viewer 不返回原始
`meta.extra`，只生成闭合的安全投影；CrashFix provenance 哈希仅显示 12 位前缀，原始
device ID 只在非 CrashFix 兼容路径中转换为哈希引用。

CrashFix 可在 `start_session.extra` 中写入可选初始锁
`requested_execution_profile=local_trusted|docker_strict`。新调用方应始终写入；为兼容旧
session，该字段也可缺省。字段一旦存在，candidate 的 `execution_profile` 必须严格相等；
verification 与 export 不重复接收或覆盖它，但每次仍会重新核对已绑定 candidate 与初始锁。
合法枚举会进入安全公开投影，非法值或与 candidate 冲突的损坏元数据会隐藏候选证据组。
该字段是初始控制值，不属于 candidate 派生的 Build Runner 证据字段。

candidate 阶段的原子证据组还必须完整绑定以下 Build Runner 字段，缺少任一字段或组合
矛盾都会拒绝整组写入：

- `execution_profile=local_trusted` 必须对应
  `strong_isolation=false`、`workspace_disk_quota_enforced=false`、
  `network_policy=not_enforced`、
  `filesystem_write_isolation=not_enforced`、
  `secret_filesystem_isolation=not_enforced`、
  `process_containment=process_group_best_effort`。公开 Markdown/HTML 会明确提示本地执行
  **没有强隔离、没有强制 workspace 磁盘配额，且进程约束只是 best-effort**。
- `execution_profile=docker_strict` 必须对应
  `strong_isolation=true`、`workspace_disk_quota_enforced=true`、
  `network_policy=denied`、
  `filesystem_write_isolation=enforced`、
  `secret_filesystem_isolation=enforced`、
  `process_containment=container+process_group`。
- `workspace_role` 必须为 `candidate`；完整
  `workspace_manifest_sha256/workspace_canonical_diff_sha256` 必须分别等于同组的
  `candidate_manifest_sha256/canonical_diff_sha256`。它们绑定创建 Runner environment 前紧邻
  audit 的候选 workspace 身份，并由 create/run 原样返回；不能使用旧 audit、短前缀或模型
  推断值。

这些字段随 candidate 私有持久化并参与幂等/冲突比较；它们不是秘密，因此在安全公开
投影中完整显示。verification 与 export 继续锚定已绑定 candidate，不重复接收或覆盖
execution profile，也不改变既有三阶段顺序与 provenance 哈希前缀规则。三个
workspace-specific 字段不会进入公共 `build_environment_sha256`；相同命令的
baseline/candidate 应保持公共环境 hash 一致，同时分别核对各自 workspace identity。

CrashFix 验证 child 通过 `start_session.extra` 的
`crashfix-child-verification/v1` 上下文固定父 session、run 1/2/3、真机、artifact、
device、plan、platform 与 analyzer `(signature_version, fingerprint)`。`finalize(passed)` 还必须传
闭合的 `verification_evidence`；服务端会重新核对所有 step 为 `ok` 且 crash 记录为 0。
父 session 的 verification stage 只接受三个不同的 sibling child id，并逐个加锁检查终态、
链接与身份；`verification_runs=3` 和 `verified=true` 均由服务端派生，客户端不能声明。

这里的 “3/3” 是**结构化会话证据**，不是硬件或密码学证明。Report MCP 能独立重算 step
数量、结果和已归档 crash 数，并核对三个 child 的身份字段一致；但 child 启动时的
`type="real"`，以及 finalize 时的 capture、artifact identity、analyzer 与 assertion 完成布尔值，
仍由调用方提交。Report MCP 不直接查询设备、校验 APK/IPA 安装回执或验证硬件签名，因此
调用方必须先通过受信任的 mobile/log/analyzer/安装适配器建立这些事实，不能把 Report 的
`verified=true` 单独描述为“已密码学证明在真机运行了目标二进制”。

## 环境变量

- `APP_TEST_CTRL_WORKSPACE` — sessions 根目录（绝对路径）。
  不设则用 `<cwd>/workspace/sessions`。

## 测试

```bash
npm test -w mcp-servers/report-mcp
```
