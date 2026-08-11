# Firebase Crashlytics 接入与 CrashFix

本项目把线上 Crashlytics 事件作为**远端、不可信、可能包含个人数据的证据**。
`crashfix` Skill 负责把单个 issue 编排为分析，并在可信 Runner 全部门槛满足时进入独立
候选、验证或 Draft PR。默认本机可信构建不要求 Docker；严格容器隔离按需启用。
它不会自动 merge、发布或关闭 issue，也永不调用远端写工具。

## 数据边界

Crashlytics 事件包含异常、线程、frame、版本、设备以及可选的 custom keys、日志和
breadcrumb。它不是完整的 Android logcat 或 iOS unified log；设备实时证据仍由
`log-mcp` 获取。

## 两档修复流程

CrashFix 现在提供两个显式 `workflow`，它们不是 `execution_profile` 的别名：

- **`quick_test`**：仅用于当前用户确认的个人/测试低敏项目。读取唯一 issue 的一条事件
  （`pageSize=1`），根据脱敏 frame 在当前工作树做最多 3 个文件的最小修改，运行一次目标
  测试/必要的 debug build，可选一次 adb 真机 smoke。它不创建 snapshot、worktree、候选
  cache，不 commit/push/PR；`local_trusted` 不提供宿主或秘密隔离，结果只能称“本机快速
  验证”。远端父 session 以 `analyze` 归档，编辑和验证由独立普通 `devtest` session 记录；
  两者不做机械父子绑定，最终并列两份报告。真机 smoke 只有安装后 package/version/build
  身份核验成功才可标记通过，否则为 `unverified`。
- **`strict`**：保留完整的 snapshot/Git 身份、baseline、candidate、Runner、真机 3/3、
  导出和逐级审批；生产或敏感度未知项目必须使用这一档。

省略 `workflow` 时，只有当前用户已经确认低敏测试项目并接受直接工作树风险，才可默认
`quick_test`；否则使用 `strict`。两档不自动 fallback，也不共享远端、源码或构建证据。
quick 遇到私钥、服务账号、token、keystore、`.env`、安全/认证/支付/隐私/native/第三方
SDK 等内容时立即停止，不读取或豁免敏感文件；需要严格候选时由用户显式新建 strict session。

CrashFix 有两条互斥的 acquisition 路径：

1. **默认：项目内 Firebase 只读网关**。网关内部调用固定版官方 Firebase MCP，直接读取
   Crashlytics，不要求 Cloud Logging export；只允许当前用户明确授权的测试/已确认低敏项目。
2. **显式 production-safe：本仓 `crashlytics-mcp`**。从 Cloud Logging export 读取，
   在服务端执行 project/app allowlist、字段裁剪、脱敏和规范化。

生产项目或数据敏感度未知时，official 路径必须 **fail-closed**：不要读取事件详情，
改为配置本仓 MCP。Cloud Logging 路径固定查询：

```text
logName="projects/<project>/logs/firebasecrashlytics.googleapis.com%2Fevents"
```

两条路径都只能把**一个 app、一个 issue、一个 build、一个 analyzer signature identity
（`signature_version + fingerprint`）**送入
同一 CrashFix session，不得混源。CrashFix 创建 session 时写入严格 `source_lock`，
每次归档事件还要传相同的 `acquisition_route`；report-mcp 会在原子锁内拒绝缺失或
不一致的路由。Git 不是读取、分析或生成本地候选的通用前置。CrashFix 会再锁定一条
互斥的源码身份路径：

```text
git_release_exact:
  Firebase App ID + version/build → immutable Git SHA
  → exact artifact/symbols → tracked-only snapshot

snapshot_repro_equivalent（无 Git 或显式选择）:
  analyze → sealed source manifest → 静态源码定位
  patch   → baseline artifact identity
          → 专用真机复现远端同一 signature identity → independent candidate
```

Git 路径没有准确 SHA/符号产物/app-owned frame 时只能分析。snapshot 路径不自动初始化
Git，也不直接修改项目目录。snapshot `analyze` 经源码快照审批创建内容寻址的 sealed
snapshot 后，可只做静态 locator 与最高 `medium` 置信度的分析；它不创建 baseline clone、
不运行项目命令、不构建或安装 artifact，也不要求真机。只有继续 snapshot `patch` 时，
才必须从 sealed snapshot 的独立 baseline 构建产物，并在专用真机复现远端同一
`(signature_version, fingerprint)`。该路径只能声明“本地复现等价候选”，不能证明当前
目录就是历史线上 release 源码。源码快照、baseline 构建、baseline 安装分别审批；构建
审批会固定 profile、命令、独立 cwd 和缓存写入范围。Docker 固定
`network_policy=denied`；local 必须记录 `network_policy=not_enforced`，不能把 offline flag
或用户信任确认说成技术网络阻断。

源码身份参数为 `provenance=auto|git|snapshot`，预检状态严格闭合为
`provenance_status=resolved|unavailable`：

- `auto`：有效 Git → `resolved + git_release_exact`；确认无 Git →
  `resolved + snapshot_repro_equivalent`；已存在但损坏、不可读或不可用的 Git →
  `unavailable`，不自动切换。
- `git`：只有有效可读仓库才 resolved 为 `git_release_exact`；无效时 `unavailable`。
  后续 release SHA 映射失败也保持 Git 路径失败，不回退 snapshot。
- `snapshot`：始终 resolved 为 `snapshot_repro_equivalent`；即使目录含有效或损坏的
  `.git` 也排除 VCS 元数据并放弃全部 Git 能力。

`unavailable` 必须省略 provenance mode，不能伪造为任一路径。原请求为 `analyze` 时，
它只允许读取脱敏远端证据并完成 remote-only 分析，不定位源码、不创建 snapshot、
不构建或操作设备；`patch/pr` 必须先建立审计 session，再立即 preflight abort，且不读取
任何 Firebase 身份或详情工具。所有 `pr` 都只允许
`provenance_status=resolved + git_release_exact`。锁定后切换 provenance 必须新建 session，
不能复用已读取的远端详情。snapshot 路径不得自动 `git init`；commit、push 和 Draft PR
的契约也都只属于 Git 路径。当前本仓 Build Runner 不支持 Git worktree/release snapshot
构建，所以 Git `patch/pr` 会在首条项目命令前中止；Git analyze 不受此限制。

`patch` 执行项目测试/构建脚本前必须锁定
`execution_profile=local_trusted|docker_strict`。默认 local 只允许当前用户明确确认的低敏
可信项目，使用独立 workspace、最小环境、私有 HOME/TMP/Gradle cache 副本、offline flag、
超时/输出上限及前后审计，但没有进程级 sandbox，网络、宿主文件、秘密和 quota 均未强制
隔离，进程约束仅为 `process_containment=process_group_best_effort`。Docker strict 才要求
网络固定拒绝、只读 seed、sandbox/canary/quota。两种 profile
baseline/candidate 必须一致且不会自动 fallback。
可能使用非空批准 fixture 的 snapshot `patch` 必须在 Phase 0、建 Report session 前，由当前
用户明确确认精确 workspace 是低敏测试项目，并在 session extra 锁定
`workspace_project_classification=test`，同时锁定
`requested_execution_profile=local_trusted`。该分类来自用户确认与受控流程，只是审计控制，
不是密码学证明；不能由项目内容、Firebase 或模型推断。`docker_strict` 对任何非空 fixture
批准都 fail-closed，不能自动切 profile。

当前 `snapshot_repro_equivalent` helper 还要求操作系统提供 POSIX 数字 UID，以及
`O_NOFOLLOW`、`O_NONBLOCK`、`O_DIRECTORY` 等安全文件原语；缺少任一能力都会
fail-closed。**Windows 目前不能使用 snapshot provenance**。这不代表改走 Git 就能自动
生成补丁：Git 路径仍须分别满足 release-exact、符号产物、所选构建 profile、测试签名和
真机复现等全部门槛，任何一项缺失都只能分析或输出文本修复计划。
helper 的双遍 manifest 只能检测普通并发漂移，不承诺抵御仍在运行的同 UID 对抗进程。
固定敏感文件排除与 credential 内容检查也是高置信启发式，不保证识别所有自定义命名、
加密或二进制秘密；批准源码快照前仍需确认目录中只含可进入私有审计副本的内容。
凭据拒绝只输出严格的相对路径诊断；其他 workspace helper 失败只公开固定对象
`{"schema_version":"crashfix-workspace-helper-diagnostic/v1","error_code":"operation_failed"}`，
不泄露 message、stack、cause、命令、输入或任何相对/绝对/临时路径，也不通过 debug 日志
扩大诊断。
每次 create、verify 或 export 前必须停止 IDE watcher、项目生成任务和整个构建进程组；
源目录及 included 文件必须由当前用户拥有且不可 group/other 写入。候选导出的 parent
同样必须由当前用户拥有且不可 group/other 写入，否则 fail-closed。
项目构建也不能读取个人/生产签名私钥。当前 Runner 不接收密钥或密码、不负责签名；
Android build 必须直接产出用户已批准证书的专用非生产测试 APK，并在 create 时绑定证书
SHA-256，inspect 时严格核验。做不到就以 `aborted/unverified` 停止。持久测试签名身份的
使用仍需单独确认。

## MCP 配置

### snapshot Android patch：双模式 Build Runner

`npm run setup` 新安装默认注册 `backend=local_trusted`，不要求 Docker。probe 会 pin 本机
Java、Android SDK、`apkanalyzer` 与 `apksigner`；ready 仍需本机可信执行审批和逐命令审批。
最终结果只能称“本机可信项目测试通过”，不能称强隔离或 hermetic。

需要严格隔离时使用 `npm run setup -- --build-runner-backend docker`。该 profile 只接受
本地 Linux Docker、当前用户拥有且权限恰为 `0600` 的非 symlink Unix socket，以及已存在
的 digest-pinned Android image；不自动 pull、不允许 TCP daemon。strict 失败不自动换 local。

固定调用顺序为：先 `probe_capabilities`，再经独立审批 `seal_gradle_cache`；seal 只返回
同 Runner 进程有效的 opaque `cache_seed_id`，create 只能使用该 ID。build create 还必须
绑定当时不存在的 workspace APK 相对路径与已批准非生产 signer hash。`run_gradle` 只返回
stdout/stderr hash，不返回日志原文；`inspect_apk` 只接收 environment ID、消费并清理私有
staging，且 signer 必须恰好一个并严格匹配。retained seed 默认保留，只有用户另行确认后
才能调用 `dispose_gradle_cache({cache_seed_id})`。

当前只支持 `snapshot_repro_equivalent` Android/Gradle。local 可在审批后执行可信项目；
Docker 的 CPU/内存/pids 与 tmpfs 有界，但可写 workspace 是宿主 bind，尚未强制磁盘 quota，
所以 strict 仍返回 `HOST_WORKSPACE_DISK_QUOTA_UNENFORCED`。完整契约见
[`build-runner-contract.md`](../skills/crashfix/references/build-runner-contract.md)。
Runner 的 opaque ID 仅在当前 MCP 进程有效；异常退出没有 startup sweep，不能跨重启恢复
待 inspect APK、container 或 retained cache 的清理能力。

### 默认 acquisition：官方 Firebase MCP 只读网关

`npm run setup` 默认把名为 `firebase` 的客户端节点指向本仓
`firebase-readonly-mcp`。该网关内部固定启动项目本地
`firebase-tools@15.24.0 mcp --only crashlytics`，但客户端不会直接连接官方进程。
启动官方进程前，网关还会核验并加载项目内固定 preload，阻止 `tools/list` 的隐式 API
enablement，并禁用 GA4；它还锁定唯一 Crashlytics feature discovery，禁止从宿主 `PATH`
运行额外 Firebase CLI 探针，只在 `tools/list` 动态范围内抑制认证发现，并与官方入口绑定
同一精确 package root；真实工具调用仍恢复并执行官方认证。Billing 能力固定按
`false` 参与工具发现，该值只是安全抑制值，不能作为项目真实计费状态。preload 缺失、
固定版本或内部模块契约漂移时启动失败，且这项保护不构成宿主、凭据或网络强隔离。
普通 setup 只完成网关注册；CrashFix 读取远端前必须先让用户明确选择以下一个完整
Connection Profile。不得通过扫描 JSON、`.firebaserc`、环境变量或旧登录态替用户选择，
也不得在选定 Profile 失败后自动切换。

#### `service-account` Profile：显式凭据与 Project ID

此 Profile 必须同时提供服务账号 JSON 的规范绝对路径、显式 Firebase Project ID 和目标
App 项目目录：

```bash
npm run setup -- --firebase-project-source service-account \
  --firebase-project-id my-firebase-project \
  --firebase-service-account /absolute/path/to/service-account.json \
  --firebase-dir /absolute/path/to/target-app-project
# 其他客户端追加对应参数，例如：--client cursor 或 --client codex
```

POSIX 上凭据必须是当前用户拥有的规范、单链接普通文件，大小有界且不能被 group/other
访问。Agent、setup 与 doctor 只检查文件元数据，禁止打开、解析或回显 JSON 内容；网关
再次绑定同一文件身份后，只为消除校验到使用的路径漂移而创建不解析内容的一次性 `0600`
私有副本，固定上游认证库仅通过该私有路径使用凭据。不要把 JSON 内容放进命令、客户端配置、
聊天、报告或 Git。

该模式不要求或创建 App 目录的 `.firebaserc`，也不把它作为项目来源。网关基于已验证的真实
App 目录锁定 Profile，再在每个进程的私有 HOME/configstore 中把显式 Project ID 绑定到
隔离的私有上游目录；真实 App 目录不会暴露给官方子进程重新扫描。若目录中碰巧已有
`.firebaserc`，网关仍会有界解析它以检查 alias；文件异常或存在会重映射显式 Project ID
的冲突配置时 fail-closed。

生成后的核心配置形状如下（仅示意，必须由 setup 生成）：

```json
{
  "firebase": {
    "command": "node",
    "args": [
      "/absolute/path/to/app-test-ctrl/mcp-servers/firebase-readonly-mcp/dist/index.js",
      "--project-source",
      "service-account",
      "--project-id",
      "my-firebase-project",
      "--dir",
      "/absolute/path/to/target-app-project"
    ],
    "env": {
      "APP_TEST_CTRL_MANAGED_FIREBASE_MCP": "official-readonly-proxy-v2",
      "APP_TEST_CTRL_FIREBASE_OWNER_SHA256": "<setup 生成的 checkout owner hash>",
      "GOOGLE_APPLICATION_CREDENTIALS": "/absolute/path/to/service-account.json"
    }
  }
}
```

配置中只有凭据**路径**，绝不能出现 JSON 对象、private key 或 access token。
Codex 必须把此 `service-account` Profile 放在当前 checkout 的 `.codex/config.toml`；不得
把凭据路径写入全局 `~/.codex/config.toml`。doctor 会保留实际选中的 project/global
两层并按 global → project 合并 MCP server key；全局服务账号 Profile 即使被项目同名项
遮蔽也会判为 invalid，任一已存在层无法安全解析时整体 fail-closed。

#### `firebaserc` Profile：Firebase CLI 登录与现有项目绑定

此 Profile 要求用户已经通过固定版项目本地 Firebase CLI 登录，并且目标 App 目录已经
存在一个有界、当前用户拥有且不可被 group/other 写入的普通 `.firebaserc`，其
`projects.default` 是有效 Firebase Project ID。
`.firebaserc` 只选择项目，不提供认证；setup 和网关只校验/读取现有项目映射，绝不创建或
修改该文件。

执行登录会访问网络、打开浏览器并写入用户登录态，必须先取得用户明确确认，不能替用户
选择账号：

```bash
npm run firebase -- login
npm run setup -- --firebase-project-source firebaserc \
  --firebase-dir /absolute/path/to/target-app-project
# 其他客户端追加对应参数，例如：--client cursor 或 --client codex
```

此 Profile 禁止同时配置 `GOOGLE_APPLICATION_CREDENTIALS`；否则认证来源会变得含糊并被
网关拒绝。缺少或损坏 `.firebaserc` 时停止并让用户修复现有项目配置，不得自动生成一个，
也不得改走 `service-account`。

网关不会把宿主 configstore 直接暴露给官方 MCP：它根据已验证的真实 App 目录，在启动前只
选择一个 Firebase CLI 登录账号复制到一次性私有 configstore，并把已验证的
`projects.default` 绑定到隔离的私有上游目录。宿主的其他账号、其他项目、旧
`activeProjects` 和真实 App 目录均不会进入官方子进程。

两种 Profile 的私有凭据/configstore 会在正常关闭或启动失败的受控收尾中立即清理。若进程
被强杀、崩溃或断电，可能留下残留；后续受控启动只会有界清扫同时满足严格受管前缀/后缀、
当前用户 owner、私有权限、有效 lease、最小年龄且 marker PID 已失活的旧目录。不满足任一
条件即跳过，Windows 因无法同等核验 owner/mode 默认不清扫。首次创建到 lease 写入仍有极短
窗口，同 UID 对抗进程也不在保护范围内；因此它不是宿主/凭据强隔离，不能把重启描述成
必然清空所有历史或未知目录。

#### Profile 锁定、重启与 IAM

Codex 片段还固定 `command` 为 Node 绝对路径、`args[0]` 为当前 checkout 的网关入口、
`cwd` 为仓库根绝对路径，并设置 `startup_timeout_sec = 60` 与精确 8 项
`enabled_tools`。不能改回直接 npx 官方 MCP 或相对路径。setup 无法解析 Node（或
mobile-mcp 所需 npx）时会直接失败。

不要把 `--dir` 指向 `app-test-ctrl`，除非它本身就是目标 Firebase App 项目。若客户端
配置已存在，先审查覆盖范围并取得确认，再给 setup 增加 `--force`。任何 Profile 或配置
变更后必须完整重启客户端；同一运行中 Profile 失败即停止，不读取 Crashlytics 详情，也
不复用证据自动尝试另一 Profile。重启后依次调用：`firebase_get_environment` 核对运行身份
和网关私有上下文，`firebase_get_project` 机械核对锁定的 Project ID/Number，
`firebase_list_apps` 核对目标 Firebase App ID。environment 返回的 Project Directory 是
一次性私有路径，Detected App IDs 也可能为空，不得与真实 App 目录或 App ID 比较；真实 App
目录由本地受管客户端配置和 doctor 元数据核验。official 路径不需要 Cloud Logging export，
也不使用本仓 Cloud Logging MCP 的 ADC/allowlist。

Project ID、凭据路径和登录成功都不等于授权成功。setup、doctor 和网关不会创建 IAM
绑定；服务账号或 CLI 用户仍须在目标项目中单独具备 Firebase/Crashlytics 所需的最小只读
权限。最终权限与项目身份只能由重启后的只读工具调用验证，失败时应由项目管理员修复
IAM，而不是扩大工具 allowlist、读取凭据内容或切换 Profile。

固定版官方 server 本身仍包含写能力；网关在 `tools/list` 与 `tools/call` 两层只注册/
转发 8 个固定读取工具，并对参数、响应类型和响应大小 fail-closed。因此官方写工具对
所有下游客户端不可见，未来新增工具也不会自动暴露；Codex 的 `enabled_tools` 只是重复
同一正向边界。

该网关**不是宿主/凭据隔离层**：上游只获得所选 Profile 的 Firebase CLI 登录态或服务账号
私有副本，以及隔离的私有项目目录；真实 App 目录不会暴露给它。它不对官方 event 文本做
Agent 前服务端脱敏；响应只经过类型和大小约束。因此只允许用户明确授权的测试/已确认低敏项目。生产、可能含个人数据或敏感度
无法确认时必须停止 official 路径，不能用“只读网关”绕过数据边界。

### 显式 production-safe：本仓 Cloud Logging MCP

生产环境使用本仓 `crashlytics-mcp`。前置条件是：

1. Firebase 项目已启用 Crashlytics，并把事件导出到 Cloud Logging。
2. 运行 MCP 的身份通过 ADC 获得最小只读日志权限。
3. 明确配置允许访问的 project 与 Firebase App ID。

生成的自研 MCP 配置故意保留空 allowlist；必须在**实际启动该子进程的客户端配置**中
填写，不能只在另一个终端里 `export`：

```json
{
  "CRASHLYTICS_PROVIDER": "cloud_logging",
  "CRASHLYTICS_PROJECT_ALLOWLIST": "my-project",
  "CRASHLYTICS_APP_ALLOWLIST": "my-project=1:1234567890:android:abcdef",
  "CRASHLYTICS_MAX_WINDOW_HOURS": "24"
}
```

多值用逗号分隔。每个 app 条目必须写成 `project_id=firebase_app_id`，不能只填显示名、
package name 或 bundle ID。不同客户端的字段位置如下：

- Claude Code：`.mcp.json` 的 `mcpServers.crashlytics.env`。
- Cursor：`.cursor/mcp.json` 的 `mcpServers.crashlytics.env`。
- Claude Desktop：全局 JSON 的 `mcpServers.crashlytics.env`。
- Codex CLI：默认使用当前 checkout 的 `.codex/config.toml`；只有用户明确选择且配置不含
  服务账号凭据路径时才可使用 `~/.codex/config.toml`。字段为
  `[mcp_servers.crashlytics]` 的 `env`。
- OpenCode：全局 `~/.config/opencode/opencode.json`（Windows 为
  `%APPDATA%/opencode/opencode.json`）中 `mcp.crashlytics.environment`。

GUI 客户端和后台 Agent 通常不会继承当前 shell 的临时环境。修改后要完整重启客户端，
再调用 `crashlytics.get_context` 确认 provider、只读能力、服务端脱敏和 allowlist。
不要在任何配置中内嵌 access token、private key 或 service-account JSON 内容。

### Cloud Logging 与 ADC

`cloud_logging` 使用 Google Application Default Credentials（ADC）。推荐给运行 MCP
的本机身份授予最小只读权限后执行：

```bash
gcloud auth application-default login
```

也可以把 `GOOGLE_APPLICATION_CREDENTIALS` 作为上述 crashlytics MCP 子进程的环境变量，
值仅指向本机凭据文件。凭据文件应放在仓库外；若确需放在本地仓库目录，常见 ADC、
service-account 与 Firebase Admin SDK key 文件名已被 `.gitignore` 忽略。不要提交或在
聊天、日志、报告中粘贴凭据内容。

### Fixture（仅本地测试）

fixture 不访问 Firebase/Google API，**不需要 ADC**，但仍必须配置精确的 project/app
allowlist，且必须使用已脱敏的本地文件：

```json
{
  "CRASHLYTICS_PROVIDER": "fixture",
  "CRASHLYTICS_PROJECT_ALLOWLIST": "demo-project",
  "CRASHLYTICS_APP_ALLOWLIST": "demo-project=demo-app",
  "CRASHLYTICS_FIXTURE_PATH": "/absolute/path/to/sanitized-fixture.json"
}
```

同样把这四项写入对应客户端的 `env` / `environment`，不要只写在 shell 中。

### `doctor` 的环境来源

`npm run doctor -- --client <name>` 是独立进程，不会联系 Firebase。它检查所选客户端的
实际配置、项目内网关构建产物，以及 lockfile 安装的固定版 `firebase-tools` 元数据；
`service-account` Profile 只检查凭据路径的规范性、普通文件身份、大小、owner 和权限，
不会打开 JSON；`firebaserc` Profile 只对现有 `.firebaserc` 做有界解析。doctor 不读取
Firebase CLI 登录凭据、不 mint token，也不能证明身份拥有远端 IAM。真实 App 目录以本地
受管客户端配置和 doctor 元数据为准；远端身份则在重启后分别用
`firebase_get_environment`、`firebase_get_project`、`firebase_list_apps` 核对运行身份与
私有上下文、Project ID/Number 和目标 Firebase App ID。

doctor 会把 Claude Code、Cursor、Claude Desktop、Codex、OpenCode 或 Antigravity 的
所选配置归一后检查。Codex 会同时加载全局与项目 TOML，并按 global → project 对 MCP
server key 合并；doctor 安全读取两层并执行相同合并。任一已存在层无法解析都 fail-closed；
全局 Firebase 服务账号 Profile 即使被项目同名项覆盖也仍判 invalid。Codex 只接受 setup
生成的有界单行 TOML 形状，歧义时 fail-closed。doctor 不执行登录、授权或远端查询。
需要核对同一组值时，可只在本次命令前传入非敏感配置：

```bash
CRASHLYTICS_PROVIDER=fixture \
CRASHLYTICS_PROJECT_ALLOWLIST=demo-project \
CRASHLYTICS_APP_ALLOWLIST=demo-project=demo-app \
CRASHLYTICS_FIXTURE_PATH=/absolute/path/to/sanitized-fixture.json \
npm run doctor
```

fixture 模式不需要 ADC，doctor 不应为此要求 Google 凭据。自研路径最终仍以重启
客户端后 `crashlytics.get_context` 的子进程上下文为准。

## CrashFix 允许调用的远端工具

官方 `firebase` acquisition 路径只允许：

- `firebase_get_environment`、`firebase_get_project`、`firebase_list_apps`
- `firebase_get_crashlytics_report_guide`
- `crashlytics_get_issue`、`crashlytics_list_events`
- `crashlytics_batch_get_events`、`crashlytics_get_report`

CrashFix 用 `firebase_get_environment` 核对运行身份和网关私有上下文；其 Project Directory
应是一次性私有路径，Detected App IDs 可能为空，二者都不能用于核对真实 App。随后用
`firebase_get_project` 机械核对锁定的 Project ID/Number，并用 `firebase_list_apps` 核对目标
Firebase App ID。返回的账号与绝对私有路径只在内存核对，不持久化或回显。CrashFix 不调用官方 server 暴露的
create/update/delete/note/login/logout 等写或身份变更工具。

网关失败只返回固定脱敏诊断
`app-test-ctrl/firebase-readonly-diagnostic/v1`。其 `structuredContent` 与单行 JSON 文本
都严格为同一组 `schema_version/error_code/stage` 三字段，以兼容会丢弃错误结果
`structuredContent` 的客户端；其中 `error_code=gateway_rejected`。`stage` 只表示
`preflight`、私有上下文/连接/工具清单/工具契约启动阶段、`tool_call`、
`response_sanitize`、`identity_validation`、`cleanup`、`gateway_unavailable` 或
`gateway_busy`。它不包含原始异常、响应、账号、凭据或路径，也不能作为远端证据。
CrashFix 必须记录该 stage 后收尾；不得读取 upstream debug 日志正文、绕过网关或自动切换
Profile/source。再次尝试前应完全重启 MCP，并新建 session。

选择 issue 后如尚无已独立验证的精确 version/build，CrashFix 先在同一 guide 前置下调用
最小有界 `topVersions`，让用户从权威 `version.displayName` 中选择唯一 build。固定版官方
MCP 会省略独立 displayVersion/buildVersion；只有原值严格匹配
`displayVersion (buildVersion)` 时才机械拆分 target 字段，并保留完整原值用于过滤。
`versionDisplayNames` 只能原样使用该 displayName；禁止用 `firstSeenVersion`、
`lastSeenVersion` 或首条 event 猜测、拼接。绑定 target 后才按该精确 displayName 读取最多
3 个事件，并逐条核对 app/version/build。

无参数 `firebase_get_crashlytics_report_guide` 只允许作为 `topIssues`/`topVersions` report
的前置指南读取。网关内部唯一调用上游 `firebase_read_resources`，URI 硬编码为
`firebase://guides/crashlytics/reports`；客户端不能列举、提供或改变 URI。每个需要这两类
report 的 session 都必须在 report session 建立后、首次相应 `crashlytics_get_report` 前
调用别名恰好一次。进程缓存、其他 session 的成功调用或工具进程存活都不能证明当前
session 已满足顺序前置。别名不可用、读取失败或内容不符合固定 guide 契约时必须
fail-closed：不得调用这两类 report，也不得根据记忆猜测 report schema 或过滤条件。

本仓 `crashlytics` production-safe 路径全部为只读：

- `get_context`：能力、provider 和脱敏配置状态。
- `list_apps`：返回部署者 allowlist 中的 app。
- `list_issues` / `get_issue`：有界 issue 摘要和代表事件。
- `list_events` / `get_event`：分页事件摘要与单个脱敏规范事件。
- `get_symbolication_status`：只汇总目标事件 frame 的符号覆盖率提示。

`get_symbolication_status` 返回的 `evidence_kind=frame_symbolication_coverage` 只说明当前
事件有多少 frame 看起来具备 symbol/file/line；它**不能**证明 `mapping.txt`、dSYM UUID、
native/Flutter symbols 或 sourcemap 与目标 build 匹配，
`artifact_identity.verified` 固定为 `false`。进入自动补丁前，Git 路径仍必须从已签名
artifact manifest 或 CI 元数据独立核对 release → Git SHA → symbols；snapshot 路径必须
从 sealed snapshot 的独立 baseline workspace 构建 artifact，核对 package/version/
variant/signing/hash，并在专用真机复现同一 analyzer
`(signature_version, fingerprint)`。

Java `exceptions[]` 按外层到内层归一化：`exception.class` 保留外层类型，
`exception.root_cause_class` 保留最后一个根因类型（即使与外层同类也保留），使远端
fingerprint 与本地 `Caused by` 栈保持一致。frame index 必须严格为 `0..n-1`。

Analyzer crash 身份不是单独的 12 位 fingerprint，而是
`(signature_version, fingerprint)`。远端分组、baseline 复现和真机 3/3 都必须同时匹配
两者；`legacy_fingerprint` 仅供用户明确要求的历史回溯，不能替代主 fingerprint、合并
不同版本的组或证明已修复。新的 Firebase report crash record 会结构化保存
`signature_version`，并与 fingerprint 一起绑定事件幂等 key；不能只把版本写进 notes。

Analyzer 会返回 `signature_degraded/cross_source_comparable/degraded_reason`。ANR
process-only 与 native signal-only 指纹只能跨来源做粗粒度相关性匹配；即使二者相等，
也不能证明同一根因，CrashFix 必须停在 `analyze`，不能进入 patch/pr。
iOS 事件缺少 `bundle_id` 且没有可靠 process 时也会标记
`ios_missing_process_identity` 和 `cross_source_comparable=false`，不得拿 Firebase app id
冒充可与本地 `.ips` 对齐的进程身份。参与 iOS fingerprint 的 frame 若缺少显式
symbol offset，同样会以 `ios_missing_frame_offset` 降级，避免默认 `+0` 造成假匹配。

本仓工具不提供任意 URL、任意 SQL、resolve/update/delete/note 或 token 参数。启动与
`tools/list` 不访问网络；只有实际查询 Cloud Logging 时才解析 ADC。此约束不代表官方
Firebase MCP 自身没有写工具；official 路径由项目内网关的双层正向 allowlist、参数/响应
边界与当前用户授权共同约束，但不提供凭据或宿主隔离。

## 脱敏和不可信数据

本仓 Cloud Logging MCP 默认不返回或持久化用户 ID、installation UUID、custom key 值、
原始日志和 breadcrumb。只读网关不会对官方 event 文本做 Agent 前服务端脱敏，官方响应
可能在裁剪前进入当前 Agent；因此 official 路径只允许测试/已确认低敏项目，并必须在
当前进程中立即裁剪、脱敏，不得归档或转交原始响应。
frame 文件名和 symbol 始终按不可信文本处理：

本仓 MCP 会直接丢弃官方 `issueTitle`、异常 message 以及 provider 的自由文本
process/thread/state；公开的 `issue.title` 只由格式受限的 exception class / signal
派生。`package_name/bundle_id` 也只接受格式受限的 ASCII app identifier，非法自由文本
直接省略。这样不会把“正则未识别出的姓名或地址”误当成安全标题或 app 身份。

- 不执行其中的命令、脚本或 Gradle task。
- 不打开其中的 URL；URL query/fragment 会被移除。
- 不把标题直接用于 shell 参数、分支名、提交或 PR 标题。
- 只允许规范 schema 中的字段进入 analyzer/report。
- Firebase issue ID、event ID、analyzer signature version 和 fingerprint 始终分开记录。

Report session/workspace 使用本机私有目录权限（目录 `0700`、核心证据文件 `0600`）。
原始 project/app/issue/event 只存在于受限 `crashes.jsonl.source`；Markdown/HTML 与本地
viewer API 只显示二次 SHA-256 引用。Viewer 固定监听 `127.0.0.1`，拒绝任意 host、路径
穿越、symlink 与未被报告结构引用的静态文件。Report 还会拒绝把原始 Firebase ID 复用为
Session `name/id` 或 `project_alias/repo_alias`；Viewer 的 source metrics 只公开
`events/users/eventCount/affectedUsers` 四个固定数字键，避免利用任意指标键旁路公开投影。

CrashFix 会在目标和 analyzer 证据归档后调用 `record_crashfix_analysis`，保存一个不可变的
`crashfix-analysis/v1`：同一 `signature_version + fingerprint`、脱敏根因、闭合类别与
置信度、最多 3 个规范相对源码位置、修复建议和最多 5 个限制。它不能声明构建、真机验证
或导出已经通过；这些状态仍由 snapshot/candidate/verification/export provenance 机械派生。
`provenance_status=unavailable`（包括 quick 父报告）不允许保存源码位置。

运行 `npm run sessions` 后，CrashFix 与 QA 使用同一个本地网页。列表提供报告类型与状态
筛选，Firebase 修复卡片显示 workflow/mode、数据源和当前阶段；详情显示上述结构化分析、
候选与验证状态。strict 的 3 个验证 child 只在服务端完成父子身份核验后建立链接。浏览器
只读取 Report 的公开投影，绝不直连 Firebase，也不会获得原始 Firebase ID、服务账号路径、
设备 serial、绝对路径、完整私有 hash、日志正文或源码正文。

## 使用流程

首次接入先只读验证。未写 source 时使用官方 MCP；选择 Cloud Logging 时必须显式写出
source：

```text
/crashfix --mode analyze --issue <issue-id>
/crashfix --mode analyze source=cloud_logging --issue <issue-id>
/crashfix --mode patch provenance=snapshot --issue <issue-id>
```

确认源码身份、artifact、符号和本地复现门槛后，再显式请求 `patch`。构建接口的正路径
仅定义 snapshot Android：无 Git 或显式选择的 snapshot 路径走 sealed snapshot +
baseline/candidate 私有副本，原项目保持不变。默认 local 经宿主信任与逐命令审批后可运行；
Docker strict 仍受 quota 门槛限制。`pr` 契约仅支持
Git release-exact，并分别等待候选 diff、commit、push 和 Draft PR 审批，但当前 Runner 也
没有 Git build path。snapshot 请求不得
静默降级或自动 `git init`。修复后必须使用本地可复现路径做静态测试及三次独立设备
验证；Firebase 暂时没有新事件不能作为即时修复证明。

snapshot `patch` 即使完成真机 3/3 并通过候选接受，也**不会**直接写回原项目。用户还要
选择一个尚不存在、且与原项目/report/viewer/snapshot/candidate 均不重叠的全新私有目录，
再单独批准一次候选导出。在上述同 UID writer 已静止的运行前提下，导出只复制已接受
hash 绑定的 included source，并拒绝预先存在的目标目录；拒绝导出时本次 `patch` 以
`aborted` 收尾。导出 publish 后若最终身份校验失败，
helper 会保留目录并报告 `cleanup_unconfirmed`，不会用路径递归删除冒险清理替换树；本次
`patch` 记为 `failed`。

Report MCP 用四个原子工具封闭审计链：用户选定唯一目标后，先用
`record_crashfix_target` 绑定 project/app/issue 与 platform/app id/version/build，且必须发生在
任何 `record_crash` 之前；目标组归档并完成根因分析后，用 `record_crashfix_analysis`
绑定同一 analyzer identity 的公开安全分析；`record_snapshot_provenance` 再绑定 sealed source；最后由
`record_candidate_provenance` 严格按 `candidate → verification → export` 三阶段写入候选构建
身份、真机 3/3 身份和最终导出引用。每条 crash、candidate 与 finalize 都会重检不可变目标；
每阶段必须字段完整、顺序正确且与前一阶段哈希一致。同值重试幂等，冲突、partial、终态或
路径字段均拒绝，Agent 不得直接编辑 `meta.json`。
CrashFix session 的步骤归档必须省略 `log_excerpt/log_excerpt_src/screenshot_src`；notes 只能是
Report 闭合 schema 接受的单行 JSON。fixture 只允许写批准集合摘要的 12 位前缀与 count，
禁止路径、逐项 hash、内容或 full 64 位摘要；私有 `manifest_sha256` 连前缀也禁止。未知
key、非 JSON 或换行会被拒绝。

每条新 Firebase crash 还必须归档 Analyzer 原值 `signature_version`、
`signature_degraded` 与 `cross_source_comparable`。缺少任一字段即 fail-closed；只有目标组所有
证据都明确满足 `signature_degraded=false && cross_source_comparable=true`，Report 才允许
绑定 candidate 或完成成功终态，不能靠 Agent 的自然语言判断绕过。

导出调用必须显式、独立传入 Phase 0 锁定的规范原项目目录：

```bash
node skills/crashfix/scripts/materialize-workspace-snapshot.mjs export-candidate \
  --workspace-root <candidate-root> \
  --snapshot-root <snapshot-root> \
  --original-workspace <absolute-original-project> \
  --expected-source-sha256 <source-snapshot-sha256> \
  --expected-candidate-manifest-sha256 <accepted-candidate-manifest-sha256> \
  --expected-canonical-diff-sha256 <accepted-canonical-diff-sha256> \
  --destination <absolute-new-private-directory> \
  --forbid-root <absolute-original-project> \
  --forbid-root <absolute-report-or-viewer-root>
```

`--original-workspace` 用于绑定原项目身份；`--forbid-root` 只表达禁止重叠的边界，不能
猜测或替代 `--original-workspace`。绝对路径与 `source_ref_sha256` 完整值只在当前进程和
helper 私有 owner/manifest 中核对；source/candidate/diff/artifact/device/export 的完整身份
哈希只通过 Report MCP 原子写入受限私有 meta，公开报告只显示 12 位前缀且不公开路径。

snapshot 身份还绑定固定排除策略与 topmost 动态排除集合的摘要；报告只记录
`dynamic_exclusions_sha256` 前缀，不记录 session/report 等绝对排除路径。若低敏测试项目中
确有运行必需、但被结构化敏感值规则命中的严格 JSON 测试 fixture，可先执行只返回相对
路径、实际 SHA-256、字节数与资格的命令。候选的规范扩展名必须为 `.json` 且内容必须能按
严格 JSON 解析；其他 structured config 仍可能被普通 scanner 拒绝，但永不豁免：

```bash
node skills/crashfix/scripts/materialize-workspace-snapshot.mjs probe-test-fixture \
  --workspace <absolute-project> --relative-path <repo-relative-path>
```

再由当前用户对**精确路径 + 完整 hash**单独批准。所有 helper 都必须这样显式经 `node`
执行；脚本保持普通 `0644`，不依赖可执行位。该例外默认关闭、仅支持 Phase 0 已锁定的
`requested_execution_profile=local_trusted + workspace_project_classification=test`，且只有
严格 JSON 中内部判定可覆盖的 `structured_sensitive_value` 能使用。
`eligible_file_format=strict_json` 固定进入 `EXCLUSION_POLICY` 与其身份哈希。私钥、
高熵/opaque secret、高置信
token、服务账号/authorized-user、credential 名称/目录、敏感键下的嵌套对象/数组及敏感
祖先下的实质值都永久拒绝。

批准只由 snapshot `create` 消费。每个 `--approved-test-fixture` argv 必须是无空白、固定
字段顺序的 canonical JSON `{"relative_path":"...","sha256":"64hex"}`；helper 会拒绝字段
换序、空白、未知字段或重复键。`crashfix-test-fixture-approval/v1` 只是调用方构造的内容/
context 防漂移流程收据，不是不可伪造 capability，也不能密码学证明用户批准；Agent 仍要
在当前对话展示具体 path + full hash 后单独询问。真正强保证需要未来由客户端确认 UI mint
的一次性 capability。

owner/manifest/audit 都绑定严格 `approved_test_fixture_context`。空集为
`{"schema_version":"crashfix-test-fixture-context/v1","enabled":false,"execution_profile":"none","project_classification":"none"}`；
非空为
`{"schema_version":"crashfix-test-fixture-context/v1","enabled":true,"execution_profile":"local_trusted","project_classification":"test"}`。
后续命令只从 sealed manifest 继承，不能追加/替换。每轮必须精确消费批准；fixture 的内容、
bytes/hash、普通文件类型、规范路径、存在性、可执行位或实际安全权限任一变化都失败，
candidate 不能修改、删除或重命名。源/clone 项必须持续由当前用户拥有且不可 group/other
写入；即使仍满足安全门，实际 mode/owner 身份变化也失败。sealed 文件保持 executable
身份对应的精确 `0400/0500`。

`source_snapshot_sha256` 的 v2 输入顺序严格为：

```text
"crashfix-workspace-source-snapshot/v2\0"
+ manifest_sha256 + "\0"
+ exclusion_policy_sha256 + "\0"
+ dynamic_exclusions_sha256 + "\0"
+ approved_test_fixtures_sha256 + "\0"
+ canonical_json(approved_test_fixture_context) + "\0"
+ decimal(approved_test_fixture_count) + "\0"
```

`record_snapshot_provenance` 使用九字段原子组：上述 source/manifest/exclusion/dynamic/
approved digest/count 加 `files/directories/bytes`。Report 不接收 context，而按 count 派生它，
机械重算 source v2；非空时同时核对 Phase 0 的 `local_trusted + test` 控制。完整
`manifest_sha256` 仅存私有 meta，公共层连前缀都不显示；fixture 只公开批准集合摘要的 12 位
前缀与 count，不保存 context、路径、逐项 hash、内容或 full 64 位摘要。零批准也绑定 empty
context、规范空集合与 `count=0`。这里的 workspace fixture 不是 Crashlytics runtime source，
也不替代源码快照、构建、安装、候选或导出审批。

所有 `verify-source` 调用必须显式传 `--snapshot-root`，并复用 create 时相同的
forbidden-root 参数集合；baseline/candidate
clone 也必须同时核对 create stdout 的两项完整哈希：source-ref 只留当前进程内存，
source-snapshot 另由 `record_snapshot_provenance` 保存到受限私有 meta。

每条 baseline/candidate Gradle 命令前还必须紧邻执行独立 workspace audit，并将完整
`current_manifest_sha256/canonical_diff_sha256` 分别传给 Runner 的
`expected_workspace_manifest_sha256/expected_workspace_canonical_diff_sha256`。create 与 run
返回的 `workspace_role/workspace_manifest_sha256/workspace_canonical_diff_sha256` 必须与该次
audit 精确一致；run 后再次 audit，任何漂移都停止。三个 workspace-specific 字段不会混入
公共 `build_environment_sha256`：相同命令的 baseline/candidate 应保持公共环境 hash 一致，
但各自独立核对 workspace identity。

## 自动触发

Skill 本身不是常驻调度器。若要在新 fatal、ANR 或 regression 到来时自动启动分析，
需要额外部署：

```text
Firebase Alerts → Cloud Functions / Eventarc → 受控 Agent runner → CrashFix
```

告警只用于触发。测试/已确认低敏项目默认从项目内只读网关调用官方 Firebase MCP；生产或敏感度未知
的项目只允许从本仓 Cloud Logging MCP 读取。
无人值守 Runner 最多自动完成只读 `analyze`，并按 issue/app/build 建立幂等键；候选、
commit、push 与 Draft PR 必须由当前对话用户逐级审批后人工接管。Runner 不得把告警
授权解释为创建分支、修改源码或写远端。

## 官方资料

- Firebase MCP：<https://firebase.google.com/docs/ai-assistance/mcp-server>
- Crashlytics MCP：<https://firebase.google.com/docs/crashlytics/ai-assistance-mcp>
- 导出到 Google Cloud：<https://firebase.google.com/docs/crashlytics/export-data-to-cloud>
- Cloud Logging schema：<https://firebase.google.com/docs/crashlytics/cloud-logging-schema>
- Firebase Alerts：<https://firebase.google.com/docs/functions/alert-events>
