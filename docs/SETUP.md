# 安装与接入指南

完整的端到端流程：装 → 接入 AI 客户端 → 跑通一次冒烟。

> 本文以 Claude Code 为例（默认客户端）。Cursor / Claude Desktop / Codex CLI 等其它客户端的差异见 [CLIENTS.md](./CLIENTS.md)。

## 1. 前置依赖

| 工具 | 版本 | 检查命令 |
|---|---|---|
| Node.js | ≥ 20 | `node -v` |
| npm | ≥ 10 | `npm -v` |
| adb | 任意（建议 ≥ 33） | `adb --version` |
| Android 设备 / 模拟器 | API 21+ | `adb devices` |
| **（iOS 可选）** Xcode 命令行 | 任意 | `xcrun --version` |
| **（iOS 可选）** iOS Simulator 已 boot | 任意运行时 | `xcrun simctl list devices booted` |
| AI 客户端 | 任一 MCP-aware（Claude Code / Cursor / Claude Desktop / Codex CLI） | — |
| **（CrashFix 默认，二选一）** 服务账号 Profile | `firebase-tools@15.24.0` | JSON 绝对路径 + 显式 Project ID + App 目录 |
| **（CrashFix 默认，二选一）** `.firebaserc` Profile | `firebase-tools@15.24.0` | Firebase CLI 已登录 + App 目录已有 `.firebaserc` |
| **（CrashFix production-safe 可选）** Google ADC + Crashlytics Cloud Logging export | 当前 Google Cloud 支持版本 | `gcloud auth application-default login` |
| **（CrashFix snapshot provenance）** POSIX 安全文件原语 | 数字 UID + `O_NOFOLLOW/O_NONBLOCK/O_DIRECTORY` | Windows 当前 fail-closed，不启用 snapshot 路径 |
| **（CrashFix snapshot Android patch 默认）** JDK + Android SDK 工具链 | 当前用户确认的低敏可信项目 | 本机构建不提供强隔离 |
| **（CrashFix Docker 严格模式可选）** 本地 Linux Docker + digest-pinned Android image | Unix socket owner=current user、mode `0600` | 当前宿主 quota 门槛 fail-closed |

## 2. 安装本仓

```bash
cd /Users/mac/mcp/app_test_ctrl
npm install
npm run build
npm run prewarm        # 只预拉 mobile-mcp；Firebase 已由 lockfile 安装
```

应能看到 `mcp-servers/*/dist/index.js` 的 8 个项目内 server 产物。

## 3. 接入 AI 客户端

**Claude Code（默认）**：

```bash
npm run setup                    # 在仓库根生成 .mcp.json，自动展开 ${PROJECT_ROOT}
```

`.mcp.json.example` 只是 `setup-mcp` 的输入模板，**不能直接复制成客户端配置**。setup 还会
写入当前 checkout 的 owner hash，并在配置 CrashFix 时校验、注入所选 Firebase Profile
及目标项目的 `--dir`；跳过 setup 的模板不能通过完整 doctor 校验。

里面声明了 9 个 MCP server：

- `mobile` — 上游 `@mobilenext/mobile-mcp`，npx 自动拉取
- `firebase` — 项目内只读网关；内部调用固定版官方 MCP，是 CrashFix 默认 source
- `log` / `report` / `ui` / `analyzer` / `code-analyzer` / `build-runner` /
  `crashlytics` — 其余 7 个项目内 server

启动 Claude Code 后，在会话里输入 `/mcp` 应能看到 9 个 server；`build-runner` connected
只代表 MCP 进程可启动，不代表工具链、用户信任审批或强隔离可用，必须另跑
`probe_capabilities`。setup 默认选择 `local_trusted`；Docker 严格模式须显式指定：

```bash
npm run setup -- --build-runner-backend docker
```

**其它客户端**（Cursor / Claude Desktop / Codex CLI）：见 [CLIENTS.md](./CLIENTS.md) 各自的安装命令与限制。共同点：

```bash
npm run setup -- --client <name>          # 生成 / 打印该客户端的 MCP 配置
npm run install:skills -- --client <name> # 安装 5 个完整 skill bundle 到对应位置
```

Skill bundle 包含 `SKILL.md` 及其 `agents/references/scripts/assets`。默认模式遇到同名
目标会整项跳过；需要升级时使用 `--force` 精确同步（会清理同名受管目录中的旧/未知
文件）。Claude Desktop 是例外：命令只打印完整手动导入清单，不会自动安装。

Codex 的 Firebase 片段会固定 Node 绝对路径、当前 checkout 内网关入口、仓库根绝对
`cwd`、`startup_timeout_sec = 60` 与 8 项 `enabled_tools`。不要手工改成直接 npx 启动
官方 MCP。setup 若无法解析 Node（或 mobile-mcp 所需 npx）的绝对路径会直接失败。
若 Codex 启用了 `features.network_proxy` 域名白名单，官方 service-account 路径至少要允许
`oauth2.googleapis.com`、`cloudresourcemanager.googleapis.com`、
`firebase.googleapis.com` 与 `firebasecrashlytics.googleapis.com`；否则项目身份 GET 会在
进入 Crashlytics 前 fail-closed。

上表的 POSIX 限制只描述 `snapshot_repro_equivalent` helper。它不承诺 Windows 上的 Git
路径能够进入自动补丁：当前本仓 Runner 暂不支持 Git build path，Git `patch/pr` 会在
首条项目命令前中止；Git analyze 仍可按 release SHA/symbols 门槛执行。
使用 snapshot 路径时，create/verify/export 前必须停止 IDE watcher 和整个构建进程组；
源目录、included 文件及导出 parent 必须属于当前用户且不可 group/other 写入。

## 4. 冒烟测试（手动跑一次）

下面这套指令完整走一遍"操作 → 抓 log → 出报告"。

```text
1. 调用 mobile.mobile_list_available_devices  → 选出 device_id
2. 调用 report.start_session(name="smoke", report_language="zh-CN")
   → 拿到 session_dir
3. 调用 log.clear_logs(device=device_id)
4. 调用 mobile.mobile_launch_app(
     device=device_id, packageName="com.android.settings"
   )
5. 调用 mobile.mobile_save_screenshot(
     device=device_id, saveTo="/tmp/app-test-ctrl-smoke.png"
   )
6. 调用 log.get_recent_crashes(device=device_id)  → 期望返回 count=0
7. 调用 report.record_step(
     session_id=...,
     action="启动系统设置",
     result="ok",
     screenshot_src=<上一步保存的路径>
   )
8. 调用 report.finalize(session_id=..., status="passed", summary="冒烟测试通过")
   → 拿到 report.md 路径
```

报告默认使用 `zh-CN`；只有当前用户明确要求英文报告时才把第 2 步改为
`report_language="en-US"`，并让 action、summary 等人类可读自由文本使用英文。

最后用编辑器打开 `report.md`，应能看到截图嵌入 + 步骤记录。

## 5. 故意触发崩溃的验证（可选）

如果你有一个会崩溃的 demo app，把第 4 步换成启动那个 app 并执行触发动作，
第 6 步会返回结构化 crash 记录。这时多一步：

```text
8.5. 调用 report.record_crash(
       session_id=...,
       signature=<crash 中的 signature>,
       stack=<crash 中的 stack>,
       kind=<crash 中的 kind>,
       step_index=<上一步的 index>,
       repro_path=[1, 2, 3]
     )
9. finalize 时 status="failed"
```

## 6. 路径与环境变量

| 变量 | 默认 | 作用 |
|---|---|---|
| `ADB_BIN` | `adb` | adb 可执行文件路径 |
| `APP_TEST_CTRL_WORKSPACE` | `<cwd>/workspace/sessions` | sessions 根目录 |
| `APP_TEST_CTRL_BUILD_RUNNER_BACKEND` | 新安装为 `local_trusted`；缺失配置保持旧 `docker` 语义 | `local_trusted` 或 `docker`；不会自动 fallback |
| `APP_TEST_CTRL_BUILD_RUNNER_LOCAL_JAVA_HOME` | 有界发现 `JAVA_HOME` / Android Studio JBR | local 的绝对 JDK home；显式值优先并在 probe 中 pin/hash |
| `APP_TEST_CTRL_BUILD_RUNNER_LOCAL_ANDROID_SDK_ROOT` | 有界发现 `ANDROID_SDK_ROOT` / `ANDROID_HOME` / 常见用户 SDK | local 的绝对 Android SDK root |
| `APP_TEST_CTRL_BUILD_RUNNER_LOCAL_APKANALYZER` | SDK 内稳定 cmdline-tools/tools 的有界发现 | local 的绝对 `apkanalyzer`；必须位于 SDK root 内 |
| `APP_TEST_CTRL_BUILD_RUNNER_LOCAL_APKSIGNER` | SDK `build-tools` 内最高稳定数字版本的有界发现 | local 的绝对 `apksigner`；必须位于 SDK root 内 |
| `APP_TEST_CTRL_BUILD_RUNNER_DOCKER_BIN` | 无（fail-closed） | Docker executable 绝对路径 |
| `APP_TEST_CTRL_BUILD_RUNNER_DOCKER_HOST` | macOS：`unix://<OS 用户目录>/.docker/run/docker.sock`；Linux：`unix:///run/user/<uid>/docker.sock` | 仅本地、当前用户拥有且 `0600` 的 Unix socket；不读取 `DOCKER_HOST/DOCKER_CONTEXT`，不 fallback |
| `APP_TEST_CTRL_BUILD_RUNNER_IMAGE` | 无（fail-closed） | 已存在的 `name@sha256:<64-lowercase-hex>` Android 镜像；不自动 pull |
| `APP_TEST_CTRL_BUILD_RUNNER_OCI_RUNTIME` | `runc` | daemon 已注册的固定 OCI runtime；create 显式绑定并在 start 前核验 |
| `NPM_CONFIG_CACHE` | setup 为 `npx` server 指向项目内 `.codex/npm-cache` | 仅用于 mobile-mcp 等 npx 上游；Firebase 网关使用 lockfile 本地依赖 |
| `CRASHLYTICS_PROVIDER` | `cloud_logging` | `cloud_logging` 或仅测试用的 `fixture` |
| `CRASHLYTICS_PROJECT_ALLOWLIST` | 无 | 允许访问的 Firebase/GCP project ID，逗号分隔 |
| `CRASHLYTICS_APP_ALLOWLIST` | 无 | `project_id=firebase_app_id`，逗号分隔 |
| `CRASHLYTICS_MAX_WINDOW_HOURS` | `24` | 单次 Crashlytics 查询允许的最大时间窗 |
| `GOOGLE_APPLICATION_CREDENTIALS` | 按 Profile | official `service-account` 或 Cloud Logging ADC 使用的绝对凭据路径；`firebaserc` Profile 禁止设置；不要读取、回显或提交凭据内容 |
| `CRASHLYTICS_FIXTURE_PATH` | 无 | fixture 模式必填的已脱敏 fixture 绝对路径 |

如果你想把 sessions 放到 git 不管的位置，可在 `.mcp.json` 的 report-mcp 段
覆盖 `APP_TEST_CTRL_WORKSPACE`。

## 6.5 iOS 流程（Simulator + 真机）

Simulator 前置：

```bash
xcrun --version                       # 确认 Xcode 工具链
xcrun simctl list devices booted      # 至少有一台在 Booted 状态；没有的话：
xcrun simctl boot <udid>              # 启动一台
open -a Simulator                     # 或者直接打开 Simulator.app
```

iOS 上 devtest/qa skill 自动走平台分支（见 SKILL.md "平台分支"小节）。
关键差异：
- 元素查询用 `mobile.mobile_list_elements_on_screen`（没装 idb → ui-mcp 在 iOS 上不工作）
- Simulator crash 用 `log.ios_list_ips` + `analyzer.parse_ips_file`；注意
  `ios_list_ips.files[]` 是 summary 对象，实际路径取 `.path`
- 真机 crash 用 `log.ios_pull_device_crashes` 从设备拉取
- Simulator log stream 用 `log.ios_start_capture`；真机用
  `log.ios_device_start_capture`。只有准确解析出 proc name 时才传进程过滤

`.ips` 默认从 `~/Library/Logs/DiagnosticReports/` 读取（系统级 + Simulator 应用崩溃都落这）。
真机还需要 WDA、go-ios 与 libimobiledevice，且 `.ips` 不会自动落到 Mac；完整
安装、端口转发和排障流程见 [`IOS.md`](./IOS.md)。

## 6.6 CrashFix / Firebase Crashlytics（可选）

CrashFix 有两个显式流程档位：测试/个人低敏项目可在当前用户确认后使用
`workflow=quick_test`，只读取一条事件、直接修改最多 3 个源码文件并做一次本机测试（可选
一次需核对安装身份的真机 smoke），不创建 snapshot/worktree、不会自动 commit/push；生产或敏感度未知项目
使用 `workflow=strict`，继续执行完整 snapshot、Runner、候选和真机 3/3 审计。省略档位时
不能根据目录或 Firebase 内容猜测，未明确低敏测试确认就走 strict；两档失败不会自动切换。

### 源码身份：Git 可选

目标 App 项目不要求使用 Git。`provenance=auto|git|snapshot` 中，默认 `auto` 会在有效
Git 时选择 `git_release_exact`，确认无 Git 时选择 `snapshot_repro_equivalent`；显式
`snapshot` 即使存在 `.git` 也不使用 Git。不要自动执行 `git init`。

预检只会产生 `provenance_status=resolved|unavailable`。损坏/不可用 Git 不会被当成
“无 Git”并自动切换；`unavailable + analyze` 只能做 remote-only 分析；`patch/pr` 会先
建立审计 session，再立即中止，不调用任何 Firebase 身份或详情工具。commit、push 和
Draft PR 的契约只支持 `resolved + git_release_exact`；当前 Runner 不支持 Git build，因此
Git `patch/pr` 暂时会在首条项目命令前中止，不能伪装成 snapshot。

snapshot `analyze` 经源码快照审批创建 sealed snapshot 后只做静态定位，不要求 baseline
构建、安装或真机；snapshot `patch` 才要求 baseline 在专用真机复现远端同一
`(signature_version, fingerprint)`，随后才能创建 candidate。
候选获接受后的导出调用必须单独传
`--original-workspace <Phase 0 锁定的绝对原项目目录>`；`--forbid-root` 只设置禁止重叠
边界，不能代替原项目身份参数。完整命令见 [`CRASHLYTICS.md`](./CRASHLYTICS.md)。

### snapshot Android patch：双模式 Build Runner

新安装默认使用 `local_trusted`，Docker 不再是前置条件。它仅适用于当前用户明确确认的
低敏可信项目：使用独立 workspace、最小环境、私有 HOME/TMP/Gradle cache 副本、Gradle
offline flag、超时、进程组清理和前后审计，但没有进程级 sandbox，也不强制阻断网络、
宿主文件/秘密访问或磁盘占用；进程约束只是
`process_containment=process_group_best_effort`。首次本机执行和每条 exact Gradle 命令都需
单独确认。

需要严格隔离时显式选择 `docker`。它只接受本地 Linux Docker、绝对 executable、本地
Unix socket 和已存在的 digest-pinned Android image；不自动 pull。当前宿主 workspace
quota 不可核验时 strict profile 仍 fail-closed，且不会自动换到 local。固定调用边界是：

```text
probe → 独立批准 seal cache → opaque cache_seed_id
      → create → run（仅日志 hash）→ inspect({environment_id})
      → 独立清理批准后 dispose_gradle_cache({cache_seed_id})
```

build create 必须绑定当时不存在的 workspace APK 相对路径与已批准非生产 signer 证书
SHA-256；inspect 消费成功 run 创建的私有 staging，并要求 signer 恰好一个且严格匹配。
Docker 的 CPU/内存/pids/tmpfs 有界，但可写 workspace 是宿主 bind，尚未强制宿主磁盘
quota。严格入口不会信任外部配置或布尔声明，而是返回
`HOST_WORKSPACE_DISK_QUOTA_UNENFORCED`。local 可以执行可信项目，但最终报告必须明确
`strong_isolation=false`、`network_policy=not_enforced`、
`workspace_disk_quota_enforced=false`、文件/秘密隔离未强制及
`process_containment=process_group_best_effort`，不能宣称 Docker 级隔离。
Runner 的 opaque lease 不跨 MCP 重启持久化；异常退出也没有 startup sweep，旧 APK staging、
container 或 retained cache 不能仅凭重启认定已清理。
完整参数和审批规则见
[`build-runner-mcp/README.md`](../mcp-servers/build-runner-mcp/README.md)。

### 默认：官方 Firebase MCP 只读网关（测试/已确认低敏）

默认 acquisition 不要求 Cloud Logging export。**首次接入必须先让用户明确选择以下一个
完整 Profile**；不得根据 JSON、`.firebaserc`、环境变量或旧登录态自动猜测，某个 Profile
失败后也不得自动改走另一个。

#### Profile A：`service-account`

适合已有服务账号的本地或非交互环境。必须同时提供：

1. 服务账号 JSON 的规范绝对路径；
2. 显式 Firebase Project ID；
3. 目标 App 项目目录的绝对路径。

POSIX 上 JSON 必须是当前用户拥有的单链接普通文件，且 group/other 无权访问（通常为
`0600`）。Agent、setup 和 doctor 不得打开、解析或回显 JSON 内容；它们只校验文件元数据
并把路径交给项目内网关。网关会再次核验同一文件身份，把不解析的字节复制到一次性
`0600` 私有文件，再只把私有路径交给固定上游认证库；凭据内容不得进入聊天、日志、报告或 Git。

```bash
npm run setup -- --firebase-project-source service-account \
  --firebase-project-id my-firebase-project \
  --firebase-service-account /absolute/path/to/service-account.json \
  --firebase-dir /absolute/path/to/target-app-project
# 其他客户端追加：--client cursor、--client codex 等
```

该 Profile 不要求 App 项目存在 `.firebaserc`，也不会在那里创建或修改它。网关基于已验证的
真实 App 目录锁定 Profile，再在权限为 `0700/0600` 的私有临时 configstore 中把显式
Project ID 绑定到隔离的私有上游目录；真实 App 目录不会暴露给官方子进程重新扫描。即使 App 目录
碰巧有 `.firebaserc`，它也不是此 Profile 的项目来源；网关仍会有界检查 alias 冲突，文件
异常或发生重映射时 fail-closed。
Codex 客户端必须把该 Profile 合并到当前 checkout 的 `.codex/config.toml`，不能写入全局
`~/.codex/config.toml`，以免凭据路径对无关项目可见。Codex 会按 global → project 合并
MCP server key；doctor 会安全读取两层、执行相同合并，并把全局服务账号 Profile 判为
invalid，即使它已被项目同名项遮蔽。任一已存在层无法解析时整体 fail-closed。

#### Profile B：`firebaserc`

此 Profile 把 **Firebase CLI 登录态**作为认证来源，把 App 目录中**已经存在**的
`.firebaserc` `projects.default` 作为项目来源。`.firebaserc` 本身不包含登录凭据，不能
替代 `firebase login`。执行登录会访问网络、打开浏览器并写入本机登录态，必须先取得用户
确认并由用户选择账号：

```bash
npm run firebase -- login
```

确认目标 App 目录已经有类似以下内容；POSIX 上文件必须属于当前用户且不可被 group/other
写入。setup 只做有界校验，**不会自动创建或修改**：

```json
{
  "projects": {
    "default": "my-firebase-project"
  }
}
```

然后生成配置：

```bash
npm run setup -- --firebase-project-source firebaserc \
  --firebase-dir /absolute/path/to/target-app-project
# 其他客户端追加对应参数，例如：--client cursor 或 --client codex
```

启动时网关根据已验证的真实 App 目录，从宿主 Firebase CLI configstore 中只选择一个登录
账号，复制到一次性私有 configstore，并把已验证的 `projects.default` 写成私有上游目录的
精确 `activeProjects` 绑定；宿主的其他账号、其他项目绑定、旧 `activeProjects` 和真实 App
目录不会传给官方 MCP。

两种 Profile 的 Firebase 私有目录会在正常关闭或启动失败的受控收尾中立即清理。强杀、
崩溃或断电可能留下残留；后续受控启动只会有界清扫同时满足受管命名、当前用户 owner、
私有权限、有效 lease、最小年龄且 PID 已失活等严格条件的旧目录，Windows 默认不清扫。
该机制不覆盖 lease 写入前的极短窗口、未知目录或同 UID 对抗进程，因此不构成宿主/凭据
强隔离，也不能把重启当作所有历史残留都已删除的证明。

#### 两个 Profile 的共同收尾

不要把 `--firebase-dir` 指向本控制器仓库，也不要手工拼接未经校验的网关参数。若此前
普通 `setup` 已写入配置，先审查覆盖范围并取得确认，再给命令增加 `--force`。任何 Profile
或客户端配置改变后都必须**完整重启客户端**，然后运行：

```bash
npm run doctor -- --client <name>
```

doctor 只检查本地 Profile、路径、文件元数据和固定运行时，不读取服务账号 JSON、不登录、
不访问 Firebase，也不会授予 IAM。真实 App 目录由本地受管客户端配置和 doctor 元数据核验；
重启后再依次用 `firebase_get_environment` 核对运行身份和私有上下文、
`firebase_get_project` 机械核对锁定的 Project ID/Number、`firebase_list_apps` 核对目标
Firebase App ID。environment 的 Project Directory 是一次性私有路径，Detected App IDs
可能为空，不得拿它们与真实 App 路径/App ID 比较。服务账号或 CLI 用户还必须在目标项目
拥有所需 Firebase/Crashlytics 只读 IAM 权限；Project ID 正确不代表权限足够。

网关内部仍使用固定的 `firebase-tools@15.24.0 mcp --only crashlytics`，但客户端不直连
官方进程。网关在 `tools/list` 与 `tools/call` 两层只允许下面 8 个读取工具；官方
create/update/delete/note 工具对下游不可见。

> `firebase-tools@15.24.0` 在枚举工具时可能探测 Billing 并隐式尝试启用 Google API。
> 网关会先加载项目内固定 preload，保守返回 Billing 不可用、拒绝 API enablement；仅把
> `firebase_get_project` 固定的 Resource Manager 只读 GET 前置调用无副作用短路，其他
> `bestEffortEnsure` 调用形状仍拒绝。它同时禁用 GA4，并跳过
> `--only crashlytics` 之外的 feature discovery；宿主 `PATH` 上的
> `firebase --version` 也不会被执行。仅在 `tools/list` 期间还会抑制无必要的认证发现，
> 枚举结束后立即恢复；真实工具调用仍走官方认证。preload 与官方 CLI 被绑定到同一个精确
> package root。
> `npm run build` 必须同时生成 `dist/index.js` 与 `dist/readonly-preload.js`。doctor 对这些
> 构建产物只核验存在且为普通文件，不核验内容或是否过期；它另行核验 `package.json` 的
> 精确版本、已安装 manifest 的版本及 CLI 入口。preload/版本/内部导出契约漂移会在运行时
> fail-closed。环境输出中的 Billing `false` 是抑制值，并非真实计费状态；该机制也不是网络
> 或宿主强隔离。

这不是宿主或凭据隔离：上游仍使用用户配置的 Firebase 身份，官方 event 文本也不会在
Agent 看到之前由网关做服务端脱敏。因此 official 路径只允许当前用户明确授权的测试/
已确认低敏项目；生产项目或敏感度未知时必须 fail-closed，不读取详情，并显式选择下节
Cloud Logging 路径。

官方正向 allowlist 共八个只读工具：三个环境/项目/App 核对工具、
无参数 `firebase_get_crashlytics_report_guide`，以及四个 `crashlytics_*` 读取工具。该别名
只允许读取 report 前置指南；网关内部唯一调用上游 `firebase_read_resources`，URI 硬编码为
`firebase://guides/crashlytics/reports`，客户端不能列举、提供或改变 URI。每个需要
`topIssues` 或 `topVersions` 的 report session 都必须在 session 建立后、首次相应 report 前调用别名恰好
一次；进程缓存或其他 session 的成功结果不能证明当前 session 的顺序。别名读取失败或
返回内容不符合固定 guide 契约时必须 fail-closed，不得继续调用这两类 report。

### 显式 production-safe：本仓 Cloud Logging MCP

生产环境先把 Crashlytics 事件导出到 Cloud Logging，为运行 MCP 的身份配置最小只读
ADC，再在实际客户端的 `crashlytics` MCP 子进程环境中填写精确 allowlist。Claude Code
使用 `.mcp.json` 的 `mcpServers.crashlytics.env`；其他客户端字段见
[`CRASHLYTICS.md`](./CRASHLYTICS.md)：

```json
{
  "CRASHLYTICS_PROVIDER": "cloud_logging",
  "CRASHLYTICS_PROJECT_ALLOWLIST": "my-firebase-project",
  "CRASHLYTICS_APP_ALLOWLIST": "my-firebase-project=1:1234567890:android:abcdef"
}
```

不要把 access token 或 service-account JSON 写入 `.mcp.json`、仓库、报告或命令参数。
重启 MCP 客户端后先调用 `crashlytics.get_context`，确认服务端脱敏与 project/app
allowlist，再用 `/crashfix --mode analyze source=cloud_logging` 对单个 issue 做只读
验证。本仓路径默认不
返回用户 ID、custom key、breadcrumb 或原始 Crashlytics 日志。

本地契约测试可把 provider 改成 `fixture`，并配置已脱敏文件的绝对路径；fixture 仍需
project/app allowlist，但不需要 ADC，也不会访问网络。
`npm run doctor -- --client <name>` 会读取所选客户端的实际配置，但不会读取登录凭据或
调用 Firebase；跨客户端配置、doctor 校验方式及符号
产物身份限制详见 [`CRASHLYTICS.md`](./CRASHLYTICS.md)。

## 7. 故障排查

| 现象 | 排查 |
|---|---|
| `/mcp` 显示 log/report/ui/analyzer/code-analyzer 是 failed | 看客户端日志；通常是 `dist/index.js` 路径错或未 build；跑 `npm run doctor` 复核 |
| `firebase` 未连接或 CrashFix 找不到项目 | 先 `npm install && npm run build`，确认配置指向 `firebase-readonly-mcp/dist/index.js` 并锁定了一个 Profile。`service-account` 核对受保护 JSON 路径、显式 Project ID、App 目录及独立 IAM；`firebaserc` 核对 CLI 登录态和 App 目录已有的 `projects.default`。不得自动换 Profile。Codex 另核对绝对 Node/`cwd`、8 项 `enabled_tools` 与 60 秒启动超时；跑 doctor 后完整重启并调用三项身份工具复核 |
| Firebase 工具返回 `gateway_rejected` | 只使用返回的固定 `stage` 定位；`cleanup`/`gateway_unavailable` 说明实例已不可继续。不要读取 upstream debug 日志正文或改走另一 Profile/source；完整重启 MCP 后新建 CrashFix session 再试 |
| `build-runner` connected 但 probe unavailable | 先看 profile：local 核对 JDK/Android SDK/apkanalyzer/apksigner；docker 核对绝对 Docker binary、当前用户 `0600` socket、Linux daemon、digest-pinned image 与 quota。不得自动切 profile |
| 别的客户端不识别 server | 确认走了 `--client <name>` 分支生成了正确的配置文件（见 [CLIENTS.md](./CLIENTS.md)） |
| `adb devices` 列表为空 | 模拟器没起 / USB 调试没开 / `adb kill-server && adb start-server` |
| `get_recent_crashes` 总是 0 | logcat 缓冲被清得太早；改用 `start_capture` 持续抓 |
| `pull_anr_traces` 报权限 | 已用 `bugreport` 兜底，无需 root；耗时 1-3 分钟正常 |
