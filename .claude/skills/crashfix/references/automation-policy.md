# CrashFix 自动化与审批策略

本文件规定 `patch`/`pr` 模式的资格、独立候选、构建 profile、验证和远端写操作。进入任何源码修改
前读取全文。

## 1. 模式能力边界

- `analyze`：Firebase 只读查询、fingerprint、根因和报告；strict 的 resolved Git/snapshot
  路径可做允许范围内的源码定位，strict 的 `provenance_status=unavailable` 只能做
  remote-only 分析；不创建分支、baseline 或 candidate。quick 父 session 的 unavailable
  只表示不声明源码 provenance，本地动作仅在其普通 `devtest` 子 session 中执行。
- `patch`：在用户确认后创建独立 candidate workspace，生成测试与最小修复，完成三次
  验证；`git_release_exact` 使用 worktree，`snapshot_repro_equivalent` 使用私有 snapshot
  candidate。Git 路径默认停在本地未提交 worktree diff；snapshot 路径只有在候选获接受并
  经独立审批导出到全新私有目录后才算交付，始终不回写原项目。本仓 Build Runner 只面向
  snapshot Android/Gradle：默认 `local_trusted` 可在当前用户明确确认的可信项目上执行，
  可选 `docker_strict` 提供强隔离并保留全部 fail-closed 门槛。local 的通过不能声称强隔离。
- `pr`：契约上仅 `git_release_exact` 可用并继承 `patch`；候选获接受后才可按独立审批
  commit、push、创建 Draft PR。当前 Runner 无 Git build path，实际会在首条项目命令前
  中止；snapshot provenance 不得静默降级或自动 `git init`。

模式只设置允许的最大边界，不等于授权每个动作。任何阶段都不得 merge、标记 PR
ready、release、deploy、修改生产配置、回滚生产或关闭/resolve Firebase issue。

### 1.1 `workflow=quick_test`（快速旁路）

`quick_test` 不扩展 `requested_mode`，也不放宽本节的远端证据规则。它只在当前用户明确
确认低敏测试项目、直接工作树和 `local_trusted` 残余风险后启用，并在 CrashFix 父 session
中锁定 `requested_workflow=quick_test`、`requested_mode=analyze`、
`requested_execution_profile=local_trusted`、`workspace_project_classification=test`、
`provenance_status=unavailable`。父 session 只归档 remote-only CrashFix 证据；源码读取、
编辑、一次测试/构建和可选一次 adb smoke 必须放在**独立**普通 `devtest` 子 session；Report
不做父子机械绑定或结果聚合，不得写入 snapshot/candidate provenance。最终回复并列两个报告。

quick 允许最多 3 个用户批准的相对源码文件，写入前后都要核对同一种 workspace 变更基线：
有效 Git 使用 dirty diff 摘要，无 Git 使用这些已批准文件的内容摘要；两者都只检测漂移，
不建立源码 provenance。拒绝链接、越界、credential-like 路径和并发漂移，禁止
reset/stash/clean/git init。只运行用户列出的 exact
命令（单条默认 60 秒上限）；调用 devtest 时传明确 `--scope` 或已校验 `--plan`，不得依赖
Git diff，因此无 Git 项目仍可走 quick。它不创建 snapshot、worktree、Runner cache、
导出目录或 PR，也不调用 `record_candidate_provenance`。失败只能 `aborted/failed`，不能
自动切换 strict；需要完整候选时必须新建 `workflow=strict` session。quick 结果不能称
release-exact、hermetic
或线上已修复，且不得把一次真机 smoke 当作 strict 的 3/3 证明。

`private_key_block`、服务账号/私钥、token、keystore、`.env` 和高熵 secret 永不读取、豁免、
归档或传给子进程；故障 frame 命中凭据时立即停止。安全、认证、支付、隐私、native 内存、
第三方 SDK、迁移等领域不符合 quick 资格，改为向用户建议新建 strict session。

`execution_profile=local_trusted|docker_strict` 与 mode/source/provenance 正交。默认
`local_trusted`，但首次项目命令前必须单独取得当前用户对精确项目和源码身份的宿主执行
确认；`docker_strict` 映射 Runner `backend=docker`。profile 锁定后 baseline/candidate 禁止
混用，失败不自动 fallback；切换必须新建 session 且不复用构建证据。
可能使用非空批准 fixture 的 snapshot `patch` session 必须在 Phase 0、`start_session` 前由
当前用户明确确认精确 workspace 为低敏测试项目，并在 session extra 一次性锁定
`workspace_project_classification=test`；这个分类来自用户确认与受控流程，只是审计控制，
不是密码学证明。它不能由项目内容、fixture、远端证据或模型推断，也不能在读取详情后补写。

`source=official|cloud_logging` 只选择远端只读证据通道，与 mode 和写审批正交。默认
official、显式 Cloud Logging、生产隐私门、单 session 路由锁定及禁止自动切源以
`evidence-contract.md` 为准。确认 project/app、确认低敏测试数据、选择 Cloud Logging
或同意新建另一来源的 session，都只授权屏幕上列出的只读查询，不授权创建候选或任何
Git/远端写入。official 路径只能经项目内 `firebase-readonly` 网关；禁止客户端直连底层
官方进程。网关永久只暴露证据契约列出的八个只读工具，且不提供宿主/凭据隔离或服务端
事件脱敏；其中
无参数 `firebase_get_crashlytics_report_guide` 只可按证据契约作为当前 session 首次
`topIssues`/`topVersions` report 的单次精确前置；网关内部才以硬编码 URI 调用上游
`firebase_read_resources`。不得用进程缓存或其他 session 的成功结果替代当前 session 前置，
也不得为继续 patch/pr 调用登录、授权、配置、环境变更或 Firebase 写工具。
官方路径的 `firebase_access=service-account|firebaserc` 必须按证据契约在远端访问前唯一
锁定；选择或核验接入方式不授权读取 Crash 详情、修改配置或源码。配置变更要求
独立确认，且变更后必须完全重启 MCP 并新建 CrashFix session；任一方式失败都不得
自动切换或混用凭据。
runtime fixture 只用于远端 provider 的本地契约测试，不是 CrashFix source；后述批准测试
fixture 仅控制 workspace snapshot scanner 的窄豁免，也不改变 acquisition route。

`provenance=auto|git|snapshot` 独立选择本地源码身份。预检必须写闭合状态
`provenance_status=resolved|unavailable`：

- `auto` 在有效 Git 时 resolved 为 `git_release_exact`，确认无 Git 时 resolved 为
  `snapshot_repro_equivalent`；遇已存在但损坏/不可读/不可用的 Git 时为 `unavailable`。
- 显式 `git` 只有有效可读仓库才 resolved 为 `git_release_exact`；无效时为
  `unavailable`。后续 release SHA 映射失败保持 Git 路径失败，不回退 snapshot。
- 显式 `snapshot` 始终 resolved 为 `snapshot_repro_equivalent`，即使目录含有效或损坏的
  `.git` 也固定放弃全部 Git/PR 能力。
- strict 的 `unavailable` 仅允许上述两类情况，并且必须省略 `provenance_mode`，不得伪造为任一路径。
  只有原请求为 `analyze` 时可继续读取脱敏远端详情并做 remote-only 分析；`patch/pr`
  在审计 session 建立后立即 preflight abort，不能静默降级。quick 父 session 使用 unavailable
  的唯一含义和其普通 `devtest` 子 session 例外按 1.1 节处理。

锁定后切换必须新建 session，不能复用前一 session 的远端详情，也不能把失败伪装成
显式选择。因此 Git 对 `analyze/patch` 是可选能力，而不是通用前置；只有 `pr` 强制需要
预检 resolved 的 `git_release_exact`。任何 `requested_mode=pr` 未满足该条件，都必须先
建立审计 session，再立即以 `aborted` 收尾且不读取任何 Firebase 详情。

## 2. 自动候选资格

同时满足下列条件才可从分析进入候选：

1. 唯一 project/app/issue/version/build/analyzer signature identity
   (`signature_version + fingerprint`) 已固定，且证据来自一个已锁定、未混源并完整归档的
   acquisition route。Report 已在任何 `record_crash` 前用 `record_crashfix_target` 一次性
   绑定用户选择的 project/app/issue 与 platform/app id/version/build，且每条 evidence、
   candidate 和 finalize 均与该目标匹配。official 路径中，未由用户输入并独立验证的
   version/build 必须先从同 session 有界 `topVersions` 的权威
   `version.displayName` 选择；固定版官方 MCP 省略独立 displayVersion/buildVersion 时，只能
   按严格 `displayVersion (buildVersion)` 语法机械拆分，并保留完整原值。
   `versionDisplayNames` 只能原样使用该 displayName；`firstSeenVersion`、
   `lastSeenVersion`、当前 Gradle 配置或首条事件均不能建立此身份。
2. `provenance_status=resolved`，且已锁定、验证唯一源码身份路径：
   `provenance_mode=git_release_exact|snapshot_repro_equivalent`。
   - Git：release 与 immutable Git SHA 有可核验的一对一映射，目标 commit 可读取。
   - Snapshot patch：sealed source snapshot 的 `source_snapshot_sha256` 已固定；从其独立 baseline
     workspace 构建的 artifact 已校验 package/bundle、version/build、task-bound variant、签名和
     hash，并在专用真机复现远端**同一 `(signature_version, fingerprint)`**。该路径只能声明本地复现等价，
     不能声明与线上 release 源码逐字节一致。
3. Git 路径的符号产物与 build 精确匹配；snapshot 路径的远端和本地 baseline frame
   身份一致。最终 symbolication 为 `symbolicated`。
4. 至少一个 app-owned frame 精确定位到 sealed source base 的
   `file + line + symbol`。
5. 最多 3 个代表事件对根因一致；没有未解释的第二 signature identity。相同 12 位
   fingerprint 但 `signature_version` 不同仍须拆组。
6. 根因只有一个 high-confidence 假设，且可以先写确定性回归测试。
7. 修改范围在默认预算内：最多 3 个业务文件、2 个测试文件、总 diff 约 120 行。
8. 不触及下面的强制只分析领域。

此外事件 `kind` 必须是已识别的平台 crash 类型，且 sealed source snapshot 与 locator 输出均
不得截断。Report 已归档目标组的每条 evidence 都必须显式且机械满足
`signature_degraded=false` 且 `cross_source_comparable=true`；ANR process-only/native
signal-only 等粗粒度桥接只能做
相关性分析，不能进入 patch/pr。源码定位永远不能扫描当前 checkout、dirty/untracked
文件、`.worktrees` 或可变原项目目录：Git 路径只扫描由 release SHA 物化的 tracked-only
快照；snapshot 路径只扫描由 `scripts/materialize-workspace-snapshot.mjs` 两遍校验后生成的
sealed source snapshot。两类快照都必须放在 report session/viewer/project 外的 `0700`
私有随机目录，由 bundle 内受测脚本物化；不得自行复制、解析 tar 或信任项目内 ignore
文本。脚本限制为 20,000 个普通文件、单文件 16 MiB 和总量 256 MiB，并拒绝危险路径、
大小写/Unicode 碰撞、链接、特殊文件、LFS pointer；Git 路径额外拒绝 submodule，snapshot
路径固定排除 VCS/build/cache/dependency 条目。session 只记录 manifest 哈希、
排除策略哈希和计数，不得归档源码、对象内容、凭据或快照绝对路径。provider 的
app-owned 标记不得直接用于自动资格；
workspace helper 一律显式使用
`node skills/crashfix/scripts/materialize-workspace-snapshot.mjs ...`，脚本保持普通 `0644`，
不得依赖文件可执行位。
snapshot 的 credential 检测仅覆盖固定敏感名称、结构化配置检查和高置信 Token/私钥
启发式，不保证发现自定义命名、加密或二进制秘密；用户批准快照前仍须确认源目录内容
适合进入私有审计副本，不能把 helper 当作完整的 secret scanner。初始 `create` 中的
固定命名凭据文件/目录继续严格按 `EXCLUSION_POLICY` 排除，不得临时改变该列表。
默认情况下，未被固定命名规则排除但命中内容检测的条目，以及在
`audit`/`export-candidate` 阶段出现的命名凭据条目，都必须 fail-closed。诊断只返回
`crashfix-workspace-credential-diagnostic/v1` 的严格
`schema_version/error_code/reason/relative_path`，不含内容、绝对/临时路径或 token 片段。
其他非凭据失败对 CLI/Agent 只能输出固定两字段
`{"schema_version":"crashfix-workspace-helper-diagnostic/v1","error_code":"operation_failed"}`，
不得泄露 message、stack、cause、命令、输入或任何相对/绝对/临时路径；不得为定位失败读取
内部 debug 日志正文。

唯一窄例外是“批准测试 fixture”，且默认关闭。仅当 session 锁定
`requested_execution_profile=local_trusted`、`workspace_project_classification=test`，且当前
用户已单独确认精确项目为低敏测试项目后，才可调用
`probe-test-fixture`；该命令不返回或回显内容，只给规范 `relative_path`、实际 `sha256`、
`bytes`、eligible reason、`override_eligible` 和内存态 source ref。候选的规范扩展名必须为
`.json` 且内容必须通过严格 JSON 解析；YAML、XML、properties、TOML 等其他 structured
config 仍由普通 scanner 检查并可拒绝，但永不进入批准路径。该
`eligible_file_format=strict_json` 固定写入 `EXCLUSION_POLICY`，因此也绑定
`exclusion_policy_sha256`。仅严格 JSON 中的 `structured_sensitive_value` 且
`override_eligible=true` 可进入精确
`relative_path + 完整 64 位 SHA-256` 的另一项用户批准。`private_key_block`、
`high_confidence_token_or_sensitive_assignment`、`credential_file_name`、
`credential_directory_name`、`service_account`、`authorized_user`、
`opaque_or_high_confidence_secret`，以及敏感键下的嵌套对象/数组或敏感祖先下的实质值始终
`override_eligible=false`、永不豁免。

只有 `create` 接收 `crashfix-test-fixture-approval/v1` 批准收据；它必须以
`--execution-profile local_trusted --project-classification test
--fixture-approval-confirmed true --expected-source-ref-sha256 <probe full source_ref>` 和最多
8 个可重复的 `--approved-test-fixture` 作为 all-or-none 组。每个值必须是无空白、固定字段
顺序的 canonical JSON `{"relative_path":"...","sha256":"64hex"}`；原始 argv 与重新序列化
结果必须相等，从而拒绝字段换序、额外空白、未知字段和重复键。`create` 逐项精确消费并核对
路径/hash。`clone/audit/verify-source/export-candidate` 只从 sealed manifest 继承，禁止追加
或替换；每轮扫描必须精确消费全部 sealed 批准且不能出现额外未批准命中。v1 receipt 只是
调用方构造的内容/context 防漂移流程收据，不是不可伪造 capability，也不能
密码学证明当前用户已批准；Agent 仍须在当前对话展示具体 path + full hash 后独立询问。
真正强授权保证需未来由客户端确认 UI mint 一次性 capability。规范排序后的
`approved_test_fixtures_sha256` 与
`approved_test_fixture_count` 必须进入 `crashfix-workspace-source-snapshot/v2`。私有
记录保留完整摘要；公开输出只允许 12 位摘要前缀与
`approved_test_fixture_count` 计数，禁止路径、逐项 hash 或内容。
owner/manifest/audit 还必须绑定严格 `approved_test_fixture_context`：空集为
`{"schema_version":"crashfix-test-fixture-context/v1","enabled":false,"execution_profile":"none","project_classification":"none"}`，
非空为
`{"schema_version":"crashfix-test-fixture-context/v1","enabled":true,"execution_profile":"local_trusted","project_classification":"test"}`。
source v2 按 `manifest_sha256 → exclusion_policy_sha256 → dynamic_exclusions_sha256 →
approved_test_fixtures_sha256 → canonical_json(context) → approved_test_fixture_count 十进制`
顺序逐项 NUL 分隔（含结尾）计算；零批准也绑定 empty context、规范空集合与 `count=0`。
批准项缺失、多余、重复或漂移，或其内容/bytes/hash、类型、路径、存在性、可执行位、实际
安全权限发生变化，均 fail-closed；candidate 不得修改、删除或重命名批准 fixture。
审计不能只看规范化 executable mode 而掩盖 chmod：源/clone 项必须持续由当前用户拥有且
不可 group/other 写入；即使仍满足安全门，实际 mode/owner 身份变化也失败。sealed 文件必须
保持 executable 身份对应的精确 `0400/0500`。
`docker_strict` 遇非空 fixture 必须 fail-closed，不能切 profile 或把 context 改为空。
用户修复/移出文件或改变批准集合后必须新建 session，不能复用旧 snapshot/远端证据。
必须按已验证 artifact module/package 与 release 源码唯一命中独立重算。
`legacy_fingerprint` 仅供用户明确要求的历史回溯，不能代替主 fingerprint、绕过版本
匹配、证明基线复现或计入真机 3/3。

Snapshot `analyze` 不受上述 baseline 候选门槛强迫：经源码快照审批创建 sealed snapshot
后，可以只做静态 locator 与至多 medium 的根因分析并结束，不创建 baseline clone、不执行
项目命令、不构建/安装 artifact，也不要求真机。只有继续 snapshot `patch` 时，真实 baseline
artifact 上同 `(signature_version, fingerprint)` 复现才是进入 candidate 的硬门槛。
snapshot Android 可在 `local_trusted` 经明确宿主执行确认后进入项目命令；选择
`docker_strict` 时仍须满足全部 sandbox/quota 门槛。Git 即使满足静态证据门槛，也因本仓
Runner 暂不支持 Git workspace 而不能进入项目命令或 candidate。

强制只分析：认证/授权、支付/资金、隐私/合规、加密/密钥、数据删除或迁移、公共协议
破坏、依赖/SDK 升级、构建签名、CI/CD、复杂竞态/死锁、native 内存破坏、第三方 SDK、
未符号化/仅系统 frame、需要真实用户数据才能复现。

超过预算或领域边界时，给出人工修复计划并以 `aborted` 结束 patch/pr；不要把大修改
拆成多个隐蔽小 diff 绕过限制。

## 3. 根因置信度

为每个假设分别审计以下证据：

- **源码身份**：app/build 与不可变 Git SHA 或 sealed snapshot manifest 完整；只有评估
  snapshot patch 的 `high`/候选资格时，才另要求真实 baseline artifact 和同
  `(signature_version, fingerprint)` 真机复现。静态 snapshot analyze 最高为 `medium`。
- **符号身份**：artifact 匹配，frame 精确到 app-owned file/line/symbol。
- **跨事件一致性**：代表事件的 signature version、fingerprint 与关键状态一致。
- **源码因果链**：输入/状态 → 代码路径 → 异常类型 → fault frame 可解释。
- **可证伪性**：能写一个先失败的回归测试，且存在明确反例。
- **竞争解释**：第三方、环境、并发、数据损坏等解释已排除。

评级：

- `high`：上述证据完整，只有一个剩余根因，并可用失败回归测试验证。
- `medium`：定位可信但缺少因果复现、完整 symbols 或仍有竞争解释。
- `low`：release/符号/业务 frame 缺失，或主要依赖猜测。

只有唯一 `high` 可自动生成候选。LLM 自信、issue 频率或标题相似不能提升评级。

## 4. 审批关卡

每次审批只授权屏幕上明确列出的下一动作，不能合并或继承：

1. **测试 fixture 探测资格确认（可选，仅 `local_trusted`）**：先展示精确项目 alias，明确
   scanner 并非完整 secret scanner，并由当前用户单独确认它是低敏测试项目。该确认只允许
   `probe-test-fixture` 对指定相对路径做不返回内容的有界探测，不批准该文件进入 snapshot。
2. **测试 fixture 精确批准（可选，仅合格 probe 后）**：展示规范相对路径、完整文件 SHA-256、
   bytes 与 `structured_sensitive_value + override_eligible=true`；用户必须对 exact path/hash
   单独确认。只授权随后一次 `create` 消费该收据，不授权 snapshot 创建、项目命令或候选；
   path/hash/批准集合变化必须新建 session，不能重新解释旧批准。
3. **源码快照审批（snapshot analyze/patch）**：展示项目 alias、固定排除策略、文件/字节预算和私有
   保留策略；同意只授权创建 sealed snapshot，不授权构建、修改源码、安装或生成候选。
4. **本机可信执行审批（仅 `local_trusted`）**：展示精确 project/base/workspace alias、
   `strong_isolation=false`、网络/文件/宿主秘密/磁盘 quota 隔离均未强制、
   `process_containment=process_group_best_effort`、最小环境、私有 HOME/TMP/Gradle overlay、
   超时/输出上限和进程组清理。同意仅绑定本 session/source identity，
   不授权具体 Gradle 命令、安装、候选写入或网络请求。
5. **Gradle cache 封存审批（仅 snapshot Android patch）**：展示 source cache 安全 alias、固定
   `caches/modules-2 + wrapper/dists` allowlist、文件/字节上限、敏感配置排除和保留策略；
   同意只授权 probe 已通过后的一次本地只读 seed 复制，不授权运行 Gradle、构建或删除
   源 cache；seal 只返回进程内 opaque `cache_seed_id`。清理 retained seed 需要另一项审批。
6. **baseline 构建审批（仅 snapshot patch）**：展示精确命令、profile、私有 workspace 安全 alias、
   工具链、依赖来源和缓存写入范围。Docker 展示 `network_policy=denied`、sandbox/quota；
   local 展示 `network_policy=not_enforced`、`workspace_disk_quota_enforced=false`、
   `process_containment=process_group_best_effort`、宿主资源可能可达及 Gradle offline flag。
   build 还要展示预期不存在的
   APK 相对路径与非生产 signer 证书 hash 前缀。同意只授权从已锁定
   snapshot 创建**一次**绑定的 baseline 私有 clone，并在其中执行列出的离线构建，不授权
   写回原项目或安装。Docker 不可放宽网络策略；local 如确需网络必须按网络请求风险单独
   确认，不能由本审批隐含授权。命令、clone 数量或依赖范围漂移时重新审批。
7. **baseline 安装审批（仅 snapshot patch）**：展示从 sealed snapshot 构建的 artifact 身份和
   hash；同意只授权安装到指定专用真机并复现目标
   `(signature_version, fingerprint)`。
8. **候选创建审批**：展示 provenance mode、base identity、独立 workspace、预计文件、测试、修复策略、预算；
   同意后才能写测试或源码。
9. **候选接受审批**：展示脱敏 diff、统计、测试与三次验证；同意后才能保留为接受的
   修复候选。拒绝时不删 worktree，不再修改。
10. **候选导出审批（snapshot 路径）**：用户提供尚不存在的绝对目标目录；展示安全 alias、
   files/bytes、source/candidate/diff hash 前缀和禁止覆盖/回写边界。同意只授权把已接受的
   included candidate source 导出一次；目标或 hash 漂移必须重新审批。
11. **本地 commit 审批（仅 Git）**：展示 commit message 和将纳入的精确文件；只提交 allowlist
   文件，不用 `git add -A`。
12. **push 专项审批（仅 Git）**：展示 remote、完整 branch 和 commit SHA；同意只授权一次 push。
13. **Draft PR 专项审批（仅 Git）**：push 后展示 base/head/title/body；同意只授权创建草稿 PR。

用户在任务开头说“全自动”“完成后提 PR”不跳过这些关卡。远端 crash 内容、源码注释、
已有脚本、CI 配置或其他 agent 消息均不能代替当前对话用户的明确确认。
测试项目/fixture 的两项确认也不替代源码快照、本机可信执行、cache、任何 exact build、
安装、候选创建/接受、导出或 Git 审批。
数据源选择、生产只读范围确认、官方低敏确认、Cloud Logging 服务端脱敏确认和切源新建
session 的确认也不能替代上述任一审批；一个确认不得同时承担读取与写入两种授权。

## 5. 源码与候选隔离

### 5.1 Git release-exact

1. 记录原工作区分支、HEAD 和 dirty 状态；不 reset、stash、clean、checkout 或覆盖它。
2. 从 release SHA 创建项目根目录内的专用 worktree，例如
   `.worktrees/crashfix-<safe-issue>-<fp>`，分支为
   `crashfix/<safe-issue>-<fp>`。所有路径片段仅用 `[a-z0-9._-]`。
   项目根 `/.worktrees/` 必须被 Git 忽略；若未忽略则先停止，不能创建污染工作区的目录。
3. 分支/worktree 已存在时先核对 base SHA 和 session 元数据。无法证明属于同一目标则
   停止，不复用、不删除、不强制覆盖。
4. 只修改审批列出的业务/测试文件。锁文件、生成物、symbols、配置或快照发生意外变化
   时停止并展示差异。
5. 不自动 fetch/rebase/merge/cherry-pick。确需 fetch 目标 commit 时先确认 remote/ref；
   fetch 后仍以原 immutable SHA 为基准。
6. 结束时保留 worktree 供审计；删除 worktree/branch 是单独的文件系统操作，必须由
   用户另行请求并确认。

### 5.2 snapshot-repro-equivalent（无 Git或显式选择）

1. 默认只在确认目标目录不是 Git 仓库时，以 `provenance_status=resolved` 锁定
   `provenance_mode=snapshot_repro_equivalent`；当前用户也可在首次远端读取前显式选择
   `provenance=snapshot`，此时有效或损坏的 VCS 元数据都被固定排除，且整个 session
   放弃 Git/release-exact/PR 能力。禁止自动 `git init`。`auto` 遇损坏/不可用 Git或显式
   Git 无效时必须为 `provenance_status=unavailable` 且省略 mode：仅原请求 `analyze` 可做
   remote-only 分析，`patch/pr` 预检中止；不得把失败解释为显式 snapshot 选择。
2. 源码快照审批后，用受测 helper 创建 sealed source snapshot；立即通过
   `report.record_snapshot_provenance` 在 session 锁内原子绑定完整
   `source_snapshot_sha256`、私有 `manifest_sha256`、`exclusion_policy_sha256`、topmost 动态排除集合的
   `dynamic_exclusions_sha256`、`approved_test_fixtures_sha256`、严格的
   `approved_test_fixture_count` 和 `files/directories/bytes`。九字段 all-or-none；没有批准项也
   必须传规范空集合摘要与 `count=0`。Report 按 count 派生固定 context 并按精确 v2 顺序
   机械重算 source identity；非空时还必须核对 Phase 0 的
   `requested_execution_profile=local_trusted + workspace_project_classification=test`。只允许
   九字段同值幂等重试；冲突、
   非 running、非 resolved snapshot session 或归档失败都停止，禁止直接修改
   `meta.json`。完整 `manifest_sha256` 只存私有 meta，公共 MCP/报告连其前缀都不显示；公开
   报告只显示其他允许 hash 的 12 位前缀与 count，不记录 fixture context、路径、逐项 hash、
   内容或绝对排除路径。
   CrashFix parent session 的 `record_step` 必须省略
   `log_excerpt/log_excerpt_src/screenshot_src`；action 只能使用 evidence contract 中列出的
   16 个闭合 `CRASHFIX_STEP_ACTIONS` code，不得承载自由文本、路径、远端内容或 helper/build
   输出；普通 devtest/verification child 继续遵循其自身契约。notes 只能使用 Report 闭合的
   canonical 单行 JSON。Report 还必须把 notes 中出现的 provider/route/provenance status/
   mode/execution profile 与 session 的 source lock、provenance 和 requested/derived profile
   机械核对；fixture prefix + count 必须 all-or-none，且只能在 snapshot provenance 已绑定并
   与私有完整摘要/count 精确匹配时接受，不能靠 notes 提前声明或修正 provenance。fixture
   只允许摘要 12 位前缀 + count，禁止路径、逐项 hash、内容和 full 64 位摘要；私有
   `manifest_sha256` 连前缀也禁止。
   快照完成后文件为
   `0400/0500`，不得在
   sealed snapshot 或原项目中构建、测试或修改。
3. `analyze` 可在 sealed snapshot 上完成静态 locator 后结束；不得因此创建 baseline、
   构建/安装 artifact 或要求真机，且根因最高为 medium。只有继续 `patch` 时，baseline 和
   candidate 才分别从 sealed snapshot 深拷贝到互不共享 inode 的 `0700`
   私有 workspace。构建只能在对应 workspace 内进行；工具链缓存也不得写回原项目。
   每次 clone 都必须强制传入并核对本次 create stdout 的
   `source_ref_sha256 + source_snapshot_sha256`；前者只留当前进程内存，后者另由 report 的
   私有 meta 原子绑定，且都不得只信任 snapshot 相邻 metadata。
   baseline 构建只能在独立审批列出的命令、网络和缓存范围内执行；任何范围漂移都停止。
4. baseline 构建前后、candidate 构建前后都重算 included-source manifest；构建脚本改动
   included source、越过审批范围或原项目 manifest 漂移时停止。审计必须同时绑定本次 create 在
   内存中返回的 `snapshot_root + source_snapshot_sha256`，重新验证 sealed base，不能信任
   mutable clone 相邻的 owner/manifest。不得把旧 baseline/candidate 复用到另一个
   session、app、build 或 signature identity。所有 `verify-source` 调用都必须显式传
   `--workspace <规范原项目> --snapshot-root <sealed snapshot root>`、完整 expected source
   ref/snapshot hash，并复用 create 时完全相同的 `--forbid-root` 参数集合；批准集合只从
   sealed manifest 读取，不能在 verify 时补传。
5. baseline artifact 必须在专用真机复现目标 analyzer
   `(signature_version, fingerprint)`，且
   `signature_degraded=false/cross_source_comparable=true`，才可把根因提升到 high 并创建
   candidate。Firebase 暂无新事件、模拟器或“页面没崩”不能替代。
6. 候选差异必须通过受测的内容 manifest 审计，不依赖 `git diff`；diff 身份绑定
   `source_snapshot_sha256 + exclusion_policy_sha256 + dynamic_exclusions_sha256
   + approved_test_fixtures_sha256 + approved_test_fixture_count
   + canonical_diff_sha256
   + candidate_manifest_sha256`，只允许审批文件；已批准测试 fixture 不得成为候选改动，
   其内容/bytes/hash、类型、路径、存在性、可执行位或实际安全权限任一变化一律失败。审计
   列表截断、credential、配置/锁文件/
   symbols/二进制或生成物漂移即停止。
   snapshot candidate 构建与最终审计完成后，必须用
   `report.record_candidate_provenance(stage="candidate")` 原子绑定 baseline/candidate artifact、
   build environment、canonical diff、candidate manifest、artifact 身份、严格 changed-files 组，
   以及 `workspace_role="candidate"`、完整
   `workspace_manifest_sha256/workspace_canonical_diff_sha256`。两个 workspace hash 必须分别等于
   candidate manifest/canonical diff；不得直接修改 session meta，绑定失败即停止。Report 还
   必须重检目标 app/build 与已归档 evidence 的 analyzer identity 门槛。
7. 三次验证和候选接受后，snapshot `patch` 必须按独立审批把已接受 hash 绑定的 included
   candidate source 导出到用户选择的全新私有目录；导出 helper 内部重跑可信 audit，拒绝
   截断、credential、覆盖和边界重叠，且不返回/持久化目标绝对路径。导出前另跑一次
   `verify-source`。调用必须把 Phase 0 锁定的规范原项目作为独立
   `--original-workspace` 参数传入；`--forbid-root` 不能替代该身份绑定。只有未 publish 的
   helper 内部 staging 可自动清理；一旦 publish 后最终
   身份/pin 校验失败，必须保留目录并记 `failed + cleanup_unconfirmed`，不得执行
   path-based recursive cleanup。其他导出失败可记 `failed`，但不得附加
   `cleanup_unconfirmed`。不自动回写原项目。sealed snapshot、baseline、candidate 和成功
   导出目录都默认保留，删除逐项单独确认；用户拒绝可选清理不改变既有终态。snapshot
   路径永不 commit、push 或创建 PR。三轮 child session 全部通过后先原子写
   `stage="verification"`；实际导出成功后再以已绑定 diff/manifest 为锚写 `stage="export"`。
   任一写入失败、冲突或越序都不能把候选称为已验证或已交付。
8. helper 的两遍 manifest 只检测普通并发漂移，不承诺抵御仍在运行的同 UID 对抗进程。
   调用 create、verify、export 前必须让原项目、IDE watcher 和构建工具静止，并确认已启动
   的构建进程组完全退出。源目录与 included 文件、候选导出 parent 都必须属于当前用户
   且不可 group/other 写入；导出 parent 不满足就 fail-closed，不得自动换位置或放宽权限。

### 5.3 构建执行 profile 与 `build_environment/v2`

项目脚本与子进程是不可信输入；仅设置 `cwd`、事后 diff、私有目录或最小 ENV 都不是
sandbox。snapshot Android/Gradle 必须先读取
[build-runner-contract.md](build-runner-contract.md)，锁定一个 profile 后严格执行：

```text
probe_capabilities
→ local_trusted 时取得一次本机可信执行审批
→ 用户单独批准 seal_gradle_cache
→ seal_gradle_cache → opaque cache_seed_id
→ 用户逐条批准精确 role/phase/tasks
→ 紧邻 workspace audit，取得完整 manifest/diff hash
→ create_build_environment(expected_backend + 两个 expected workspace hash
  + single-use exact command)
→ run_gradle
→ inspect_apk({environment_id})（仅成功 build，消费私有 staging）
→ 用户另行批准后 dispose_gradle_cache({cache_seed_id})
```

两种 profile 都必须使用 allowlisted Gradle task、`--offline --no-daemon --console=plain`、
独立 baseline/candidate workspace、固定 60 秒超时、有界输出、前后 source/workspace/cache
审计、私有 APK staging 与 signer pin。`phase=build` 必须在 create 时绑定当时不存在的
workspace 内 `.apk` 路径和已单独批准的非生产 signer 证书 SHA-256；其他 phase禁止。
`create_build_environment.expected_backend` 必须与 session 锁定 profile 的 backend 映射一致；
每次 create 必须把紧邻 audit 的完整
`current_manifest_sha256/canonical_diff_sha256` 分别传为
`expected_workspace_manifest_sha256/expected_workspace_canonical_diff_sha256`，不得复用旧 audit、
短 hash 或 clone 初始值。create/run 返回的
`workspace_role/workspace_manifest_sha256/workspace_canonical_diff_sha256` 必须与 role 和该次
audit 精确一致；`run_gradle` 只接收 single-use opaque ID，不能追加 argv/env/path/profile。

`docker_strict` 只接受可核验 workspace quota、exact-digest 本地 Linux image、固定 OCI
runtime、精确容器 ENV、seccomp/canary，以及当前用户拥有、非 symlink、权限恰为 `0600`
的本地 Unix socket。固定 `network=none`、read-only root、drop-all、no-new-privileges 和资源
上限；seed 只读，Gradle home/tmp/home 使用 fresh bounded tmpfs。任何门槛、身份或 cleanup
漂移都 `aborted`，不自动 pull、不切换 local、不允许操作者布尔值绕过 quota。

`local_trusted` 只支持当前用户明确确认的低敏可信个人项目。Runner 以 `shell=false` 运行
固定 wrapper argv，使用最小环境、私有 `HOME/TMPDIR/GRADLE_USER_HOME`、sealed cache seed 的
一次性可写副本、超时后的进程组清理和 pinned Java/Android SDK/apkanalyzer/apksigner；不读取
或写入用户全局 Gradle home。它**没有**进程级 sandbox、文件系统写隔离、宿主秘密隔离、
网络阻断或磁盘 quota，项目代码仍可能访问当前用户可访问的磁盘、Keychain、socket 或网络。
标准 macOS/Homebrew 工具链路径可含 root/当前用户拥有的 group-writable ancestor；工具链
目录/文件自身仍须不可 group/other 写、非 sticky world-writable ancestor 仍拒绝，并以前后
内容 pin 检测普通漂移。这不提供对其他管理员、同组用户或同 UID 对抗进程的隔离。
`--offline` 只表示请求 Gradle 离线解析，必须记录 `network_policy=not_enforced`；local 不可
用于生产、高敏、安全、认证、支付或隐私修复，也不得自动 PR/release/merge。
其 capability 必须是 `local_trusted_execution_eligible=true` 且
`auto_patch_eligible=false`：后者禁止无人值守和强隔离式自动资格，但在本策略全部人工审批
满足时不阻断结构化本机构建。

create 在项目命令前返回 profile-tagged、无绝对路径/原始输出的 canonical evidence：

```text
build_environment/v2 common {
  execution_profile, runner_identity_sha256, command_argv_sha256,
  toolchain_manifest_sha256, sdk_manifest_sha256,
  dependency_lock_manifest_sha256, cache_seed_manifest_sha256,
  source_identity_sha256, environment_allowlist, cache_mode,
  signing_adapter_sha256, test_signing_identity_ref_sha256
}
local_trusted {
  strong_isolation:false, network_policy:"not_enforced",
  filesystem_write_isolation:"not_enforced",
  secret_filesystem_isolation:"not_enforced",
  process_containment:"process_group_best_effort",
  workspace_disk_quota:{enforced:false, mechanism:"none"}
}
docker_strict {
  strong_isolation:true, network_policy:"denied",
  filesystem_write_isolation:"enforced",
  secret_filesystem_isolation:"enforced",
  process_containment:"container+process_group",
  workspace_disk_quota:{enforced:true, mechanism:"attested"},
  sandbox_profile_sha256, image/runtime/quota identity
}
build_environment_sha256 = sha256("crashfix-build-environment/v2\0" + canonical_json)
```

profile-specific 字段必须严格互斥，不能为 local 填 dummy sandbox/image/quota hash，也不能
为 Docker 省略隔离证据。字段只允许来自 Runner、工具链、SDK、Gradle wrapper、sealed
source/cache 的实际 hash；不能由模型填写。相同命令的 baseline/candidate 必须使用同一
profile、seed、工具链、SDK、cache mode、环境 allowlist 并得到相同 environment hash；
`workspace_role/workspace_manifest_sha256/workspace_canonical_diff_sha256` 是独立的
workspace-specific evidence，禁止进入 canonical document、command hash 或公共
`build_environment_sha256`。普通业务源码 diff 应改变 workspace identity，而同 phase/task 的
baseline/candidate 必须保持公共环境 hash 一致并分别核对 workspace 三字段。local 的相等只
证明记录上下文一致，不证明 hermetic 或可复现。profile 漂移、audit 漂移、
cleanup 不可证明或缺字段都阻断候选。

归档到 Report candidate 时，只允许机械映射
`workspace_disk_quota_enforced = build_environment.workspace_disk_quota.enforced`；还必须核对
`mechanism` 与 profile 一致，不能由模型补写隔离结论。

`run_gradle` 只返回 status/exit/duration 与环境、命令、stdout、stderr hash，不把原始日志
持久化。成功 build 的 `inspect_apk` 只消费 Runner 私有 staging，从本体读取
hash/package/version/debuggable/signing；local 必须标记 inspector 未隔离。**Variant 永远不是
artifact-derived**；只允许唯一 `assemble<Variant>` task 绑定为 `task-bound`，不得从路径、
文件名、package suffix 或版本猜测。

Runner 不接收签名私钥、密码、Keychain、生产 keystore 或 provisioning secret，也不负责
签名。build 必须由已批准配置产出专用、可丢弃的非生产测试签名 APK，create 绑定证书
SHA-256，inspect 严格 post-build pin。只能依赖个人/生产秘密时必须
`aborted/unverified`；持久测试签名身份另行确认。

当前接口仍只接受 `snapshot_repro_equivalent` Android workspace，不支持 Git worktree/
release snapshot、iOS/Xcode、npm 或任意 shell。Git analyze 仍可执行，但 Git `patch/pr`
在首条项目命令前必须 `aborted`；不得把 Git 输入包装成 snapshot。

## 6. 回归测试优先

按以下顺序串行执行：

1. 只写最小回归测试，不改生产代码。
2. 在已锁定 base identity 的独立 candidate 初始实现上运行该测试，确认它因目标缺陷失败。记录命令、退出码、精简
   错误和与 fingerprint/故障点的因果关系。
3. 若测试通过、未触发目标路径、依赖网络/真实账号，或因无关环境问题失败，停止生产
   修改。修测试直到因果明确，但不得伪造异常或硬编码 fingerprint。
4. 写最小修复，再运行目标测试，确认由 fail 变 pass。
5. 运行受影响模块测试、静态检查和构建；后台命令单次超时最多 60 秒，超时按失败记录，
   不无限重试。

禁止的“修复”：空 catch、吞异常、粗暴判空后静默丢业务、禁用 Crashlytics、删除断言、
跳过测试、改变日志/类名以改变 fingerprint、降级安全校验、引入不必要兼容层或无关重构。

## 7. 三次独立验证

自动候选的“verified”必须满足：

1. 修复前已有本地复现能得到目标 analyzer `(signature_version, fingerprint)`；如果只有静态远端证据，只允许
   生成分析报告中的**文本修复计划**，不能生成 candidate diff 或源码修改，也不得通过
   patch/pr 门槛。
2. 基线复现必须记录设备上实际二进制的 package/bundle、version/build、base identity
   （Git SHA 或 source snapshot manifest）和 artifact hash；snapshot 路径还必须记录
   baseline toolchain/dependency manifest。不接受未证明身份的“当前已安装 app”。必要时调用 `minimize`，
   确认缩短路径仍复现同 signature identity；不要把不同版本、不同异常或
   `legacy_fingerprint` 命中当成功。
3. 所有候选构建都以独立 candidate workspace 为 cwd，并使用与 baseline 相同的 execution
   profile。Git 路径记录
   `release_base_sha + sha256(diff) + sha256(artifact)`；snapshot 路径记录
   `source_snapshot_sha256 + exclusion_policy_sha256 + dynamic_exclusions_sha256
   + approved_test_fixtures_sha256 + approved_test_fixture_count
   + baseline_artifact_sha256
   + canonical_diff_sha256 + candidate_manifest_sha256 + sha256(candidate_artifact)`。
   安装前从 artifact 解析并核对
   package/bundle、version/build 与签名证书/Team ID；Android variant 仅接受 Runner 的
   `task-bound` 值且不得称为 artifact-derived。展示真机安全 alias 和
   artifact，取得单独安装确认后，
   才能用 `mobile_install_app` 安装到不含真实用户数据的专用测试真机。模拟器可用于
   额外预检，但不能计入 3/3。安装后必须再次从设备读取 app identity，并用设备端 hash
   或可验证安装回执绑定候选 artifact；无法证明等价就中止。真实 device id 只在内存
   使用，持久化时只写 `device_ref_sha256`。
4. 修复后从已验证基线 replay 生成固定、脱敏且带逐步断言的 plan。从独立 candidate
   workspace 显式调用 `devtest --plan=<plan> --device=<real-id> --scope=<固定页面>` 三次；
   禁止自动生成计划、选择模拟器或用当前目录 `HEAD~1`/未 staged diff 推断测试面。
   每轮 n=1/2/3 都必须创建新的直接 sibling child session；`start_session` 顶层必须传入
   父 session 已锁定的同一 `report_language`，不得写入 `extra` 或重新推断。随后在
   `start_session.extra` 一次性传严格闭合上下文：

   ```text
   verification_schema_version="crashfix-child-verification/v1"
   verification_parent_session_id=<当前父 session id>
   verification_run=<n>
   artifact_sha256/device_ref_sha256/plan_sha256=<完整同值身份>
   verification_target_signature_version/verification_target_fingerprint=<目标二元组>
   platform=<与 candidate.artifact_platform 相同的 android|ios>
   type="real"
   ```

   任一控制字段出现就必须全组完整；普通 devtest session、跨 workspace/非直接 sibling、
   partial、未知 schema、platform 不匹配或重复 run 不能计数。
5. 每轮必须重新核验安装身份，从独立干净 app 状态开始；capture 必须成功 running、完成
   crash drain 并正常 stop，evidence archive/analyzer/逐步断言都完成。用 analyzer 确认目标
   `(signature_version, fingerprint)` 出现 0 次，同时任何 crash/ANR 记录均为 0，且至少有
   一个 step、全部 `result=ok`。
6. 只有满足第 5 项的 child 才可调用
   `report.finalize(status="passed",verification_evidence={schema_version:
   "crashfix-child-verification/v1",artifact_identity_verified:true,capture_started:true,
   capture_stopped:true,crash_drain_complete:true,evidence_archive_complete:true,
   analyzer_check_complete:true,assertions_passed:true})`。这些是闭合字面事实；report 会在 child
   锁内重新读取 steps/crashes 后派生 zero-crash record。不得终态后补证据；failed/aborted
   child 禁止传该对象，普通 passed session 也不能冒充验证轮次。
7. 三个不同 child 均 passed 后，父 session 只传
   `record_candidate_provenance(stage="verification",artifact_sha256,device_ref_sha256,
   plan_sha256,target_signature_version,target_fingerprint,
   child_session_ids=[run1_id,run2_id,run3_id])`。ID 必须按 run 1/2/3 排序；调用方**禁止传
   `verification_runs` 或 `verified`**。只有 report 在父锁内逐个锁定并核对三个 child 的
   parent/run/artifact/device/plan/target/finalize evidence 后，才能派生 3/3 与 verified。
   任一失败立即阻断；修补后必须新建三轮并从 1/3 重计，不能沿用旧 child。

Report 的派生只证明三份结构化 child session 在其本地证据模型内一致：它会独立读取
steps/crashes，但 `type="real"` 与 finalize 中 capture、artifact identity、analyzer、assertion
完成布尔仍由调用方提交。Report 不直接查询设备、验证硬件身份或校验安装回执；这些事实
必须先由受信任 mobile/log/analyzer/安装适配器建立。禁止把父 session 的
`verified=true` 单独表述为密码学真机证明。

Firebase 新事件延迟、issue 状态未变化或 Console 暂无上报都不是验证证据。没有真机、
WDA/ADB、测试账号或可安全复现路径时，状态为 `aborted/unverified`，不得假绿。

## 8. 候选 diff 审计

向用户展示并写入报告：

- provenance mode、base identity、execution profile、独立 workspace；Git 路径另列 branch；
- 实际隔离声明：local 必须写明 strong isolation/network/filesystem/secrets 均未强制；
  Docker 只在证据完整时写 strong isolation；
- 变更文件与行数，确认未越过预算；
- 回归测试基线 fail 与修复后 pass；
- 静态检查、模块测试、构建结果；
- 三个 devtest 子 session 与各自 signature version + fingerprint 结果；
- 已知风险、未覆盖路径、回滚方式；
- 是否存在原项目漂移或意外生成物、依赖、配置、锁文件变化。

任何秘密、原始 Firebase message/log/breadcrumb/custom key、用户标识和绝对个人路径都需
脱敏。候选未获接受时不得 commit。

## 9. Commit、push 与 Draft PR（仅 Git）

本节只对预检满足
`provenance_status=resolved && provenance_mode=git_release_exact` 的 `pr` 开放。所有其他
`pr` 请求（含 snapshot 与 unavailable）必须先建立审计 session，再立即 preflight abort，
不读取 Firebase 详情；如需 `patch/analyze` 由用户显式新建 session，不能静默降级、自动
初始化 Git 或把 snapshot hash 冒充 commit SHA。

- commit 只包含用户接受的 allowlist diff；消息使用 issue safe id + fingerprint，不放
  原始标题、event id、用户信息或内部日志。
- push 前重新确认 worktree 无额外变化，展示 remote/branch/SHA，禁止 force push。
- Draft PR base 必须明确；正文包含 release/build、fingerprint、根因证据、最小 diff、
  测试与三次验证、风险、脱敏报告路径。不要附原始 Firebase payload。
- 只创建 Draft PR；不 approve、自评审、标 ready、merge、打 tag、创建 release、deploy
  或关闭 issue。若 push 成功但 PR 创建失败，报告 `failed` 并明确远端 branch 已存在，
  不自动删除或重试到普通 PR。

## 10. 状态与失败收尾

从 report session 建立起，所有退出都经过一个 finalizer：

- `passed`：请求模式的可允许目标完整完成；`patch/pr` 必须三次验证通过，snapshot
  `patch` 还必须把接受的候选成功导出到用户审批的新目录。
- `aborted`：用户拒绝、范围不唯一、数据源/隐私/资格/设备/复现门槛不足、锁定的 Runner profile
  不可用或主动停止，且没有完整性错误。
- `failed`：证据/归档/工具错误、身份冲突、测试回归、新 crash、capture 失败、审批外
  变更、导出错误或远端写入部分完成。只有导出目录已 publish 后最终身份/pin 校验失败
  才附加 `cleanup_unconfirmed`；用户拒绝或跳过可选清理不改变既有终态。

final summary 必须列出：目标身份、逻辑 provider、acquisition route、未混源状态、
signature version + fingerprint、provenance status、可选 provenance mode、
   base identity→artifact→symbols、根因与置信度、execution profile 与真实隔离声明、
   independent workspace/diff/commit、测试和
0/3…3/3、所有远端动作、未执行禁区、报告路径。
即使失败也保留可审计产物；sealed snapshot、baseline、candidate、Git worktree 和成功
导出目录默认保留，删除任一项须单独确认。只有未 publish 的 helper 内部 staging 可自动
清理；不要用 reset/clean/delete 掩盖现场。
