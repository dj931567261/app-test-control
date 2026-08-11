# build-runner-mcp

面向 CrashFix 的 Android/Gradle 可信构建执行器。它只接受结构化任务，支持两个必须
显式锁定且**绝不自动互相回退**的 backend：

- `docker` / `execution_profile=docker_strict`：目标是强隔离的离线容器构建。当前尚未实现
  宿主 workspace 的可证明磁盘配额，因此生产 probe 固定 fail-closed；容器正路径只用于
  契约测试和后续配额实现。
- `local_trusted` / `execution_profile=local_trusted`：在 macOS/Linux 非 root 主机上运行
  用户明确信任并逐次批准的项目。它使用固定 Gradle argv、最小环境、私有 cache 副本、
  进程组清理和持续哈希的 Java/Android 工具链，但**不提供强隔离**，网络、宿主文件写入、
  secret 文件隔离和 workspace 磁盘配额均不强制，且固定
  `auto_patch_eligible=false`。

两种 backend 都会从 APK 私有副本读取可核验身份。Runner 不支持任意 shell、iOS/Xcode、
npm，也不负责签名、安装、上传或发布。

## 为什么需要

Gradle wrapper 和项目构建脚本都可能执行任意项目代码。仅切换 `cwd` 不能阻止它们读取
主机凭据、写回原项目、污染全局缓存、联网或留下后台进程。`docker_strict` 的目标限制为：

- 精确 digest 固定且已存在于本机的 Linux Docker image；
- `--network none`、只读容器根文件系统、drop-all capabilities、
  `no-new-privileges`、seccomp、进程/内存/CPU 上限；
- 一个可写的 CrashFix 私有 workspace；
- 一个只读、内容寻址的 Gradle dependency cache seed；
- 每次容器全新的有界 `/gradle-home`、`/tmp`、`/home/build` tmpfs；
- 固定 60 秒超时、输出上限和可证明的强制容器清理。

Docker daemon、固定镜像和宿主机管理员仍在信任边界内。Runner 还会锁定 Docker CLI、
本地 Unix socket、显式 OCI runtime 和工具链身份；socket 必须由当前用户拥有、最终项
非 symlink 且权限恰为 `0600`。容器 inspect 必须与计划的 ENV **精确相等**，多一个变量
也会在 start 前拒绝。Docker、socket、runtime、固定镜像、工具链、隔离探针或磁盘配额
任一不可用时都 fail closed；Runner 不会自动改走 `local_trusted`。

`local_trusted` 是一个诚实标注的可信本机模式，而不是 Docker 的降级实现。它仅允许：

- 项目私有 workspace 中的 `./gradlew`；
- 1–16 个经过白名单校验的 Gradle task；
- 固定 `--offline --no-daemon --console=plain` 参数，`shell=false`；
- 固定最小环境、私有 `HOME/TMPDIR/GRADLE_USER_HOME` 和 sealed cache 的一次性深拷贝；
- 固定且持续复核内容身份的 Java runtime、`apkanalyzer` 与 `apksigner`；
- 有界输出、60 秒超时、进程组 best-effort containment，以及私有目录清理失败后阻断后续运行。

它无法阻止已信任项目访问同 UID 可见的宿主资源，因此只适合用户理解风险后的本地验证，
不能用于满足无人值守或强隔离式自动资格；但在 CrashFix 的项目信任审批和逐命令审批
全部完成后，可以执行显式获批的 `local_trusted` patch 流程。

为兼容标准 macOS `/Applications` 和 Homebrew 布局，local 允许工具链路径上由 root 或
当前用户拥有的 **group-writable ancestor**；工具链目录/文件自身仍不得 group/other
writable，非 sticky 的 world-writable ancestor 仍拒绝，并在执行前后复核内容哈希。
这只是可信本机兼容策略，不能证明其他管理员或同组用户无法替换工具链。

## 前置条件

1. Node.js 20+，依赖已在项目目录安装，Runner 已构建。
2. 选择一个 backend。未设置时固定为 `docker`；选择 `local_trusted` 必须显式配置
   `APP_TEST_CTRL_BUILD_RUNNER_BACKEND=local_trusted`。
3. Docker 模式需要本地可用的 Linux Docker daemon；只接受本机 Unix socket，不接受
   远程 TCP daemon。
4. Docker 模式需要一个已在本机存在的 Android/Java 构建镜像，配置必须使用精确
   `name@sha256:<64 lowercase hex>`，不能使用 tag 代替 digest。
5. Docker 镜像中需存在 Java、Android SDK、`apkanalyzer`、`apksigner` 和配置的 OCI runtime；
   `apkanalyzer` 身份从其 canonical cmdline-tools 包内唯一 `Pkg.Revision` 读取，`--help`
   只验证命令契约，不冒充版本。
6. local 模式需要 macOS/Linux 非 root 用户，以及可信、不可被 group/other 写入的 Java home
   和 Android SDK。可有界自动发现，也可通过下文变量显式指定。
7. 用 CrashFix snapshot helper 创建的 sealed snapshot 及独立 baseline/candidate clone。
8. Gradle 进程、IDE 构建和 watcher 已停止后，才可封存依赖缓存。

最小配置示例：

```json
{
  "mcpServers": {
    "build-runner": {
      "command": "node",
      "args": ["<repo>/mcp-servers/build-runner-mcp/dist/index.js"],
      "env": {
        "APP_TEST_CTRL_BUILD_RUNNER_BACKEND": "docker",
        "APP_TEST_CTRL_BUILD_RUNNER_DOCKER_BIN": "/absolute/path/to/docker",
        "APP_TEST_CTRL_BUILD_RUNNER_IMAGE": "example/android-build@sha256:<64-lowercase-hex>",
        "APP_TEST_CTRL_BUILD_RUNNER_OCI_RUNTIME": "runc"
      }
    }
  }
}
```

可信本机配置示例：

```json
{
  "mcpServers": {
    "build-runner": {
      "command": "node",
      "args": ["<repo>/mcp-servers/build-runner-mcp/dist/index.js"],
      "env": {
        "APP_TEST_CTRL_BUILD_RUNNER_BACKEND": "local_trusted",
        "APP_TEST_CTRL_BUILD_RUNNER_LOCAL_JAVA_HOME": "/absolute/path/to/java-home",
        "APP_TEST_CTRL_BUILD_RUNNER_LOCAL_ANDROID_SDK_ROOT": "/absolute/path/to/android-sdk",
        "APP_TEST_CTRL_BUILD_RUNNER_LOCAL_APKANALYZER": "/absolute/path/to/android-sdk/cmdline-tools/latest/bin/apkanalyzer",
        "APP_TEST_CTRL_BUILD_RUNNER_LOCAL_APKSIGNER": "/absolute/path/to/android-sdk/build-tools/36.0.0/apksigner"
      }
    }
  }
}
```

可选配置：

- `APP_TEST_CTRL_BUILD_RUNNER_BACKEND`：`docker|local_trusted`，默认 `docker`。无效值不会
  伪装成任一 backend，也不会 fallback。
- `APP_TEST_CTRL_BUILD_RUNNER_DOCKER_HOST`：默认 macOS
  `unix://<OS 用户目录>/.docker/run/docker.sock`，Linux
  `unix:///run/user/<uid>/docker.sock`；只允许绝对本地 Unix socket URL。Runner 不读取
  `DOCKER_HOST`、`DOCKER_CONTEXT`，也不自动 fallback。
- `APP_TEST_CTRL_BUILD_RUNNER_OCI_RUNTIME`：默认 `runc`；必须是 daemon 已注册的固定名称，
  create 会显式传 `--runtime` 并在 start 前核对 inspect descriptor。
- `APP_TEST_CTRL_BUILD_RUNNER_JAVA_HOME`：容器内 Java 路径，默认
  `/opt/java/openjdk`。
- `APP_TEST_CTRL_BUILD_RUNNER_ANDROID_SDK_ROOT`：默认 `/opt/android-sdk`。
- `APP_TEST_CTRL_BUILD_RUNNER_APKANALYZER`、
  `APP_TEST_CTRL_BUILD_RUNNER_APKSIGNER`：容器内工具绝对路径。
- `APP_TEST_CTRL_BUILD_RUNNER_MEMORY_MB`：512–16384，默认 4096。
- `APP_TEST_CTRL_BUILD_RUNNER_CPUS`：1–16，默认 2。
- `APP_TEST_CTRL_BUILD_RUNNER_PIDS`：32–1024，默认 256。
- `APP_TEST_CTRL_BUILD_RUNNER_GRADLE_HOME_MB`：512–16384，默认 4096。
- `APP_TEST_CTRL_BUILD_RUNNER_TMP_MB`：64–4096，默认 512。
- `APP_TEST_CTRL_BUILD_RUNNER_MAX_OUTPUT_BYTES`：4096–4194304，默认 1 MiB。
- `APP_TEST_CTRL_BUILD_RUNNER_LOCAL_JAVA_HOME`：local 模式的 Java home。未设置时先读取
  `JAVA_HOME`，再在 Android Studio 标准位置做有界发现。
- `APP_TEST_CTRL_BUILD_RUNNER_LOCAL_ANDROID_SDK_ROOT`：local 模式的 Android SDK root。
  未设置时读取 `ANDROID_SDK_ROOT/ANDROID_HOME`，再检查标准位置。
- `APP_TEST_CTRL_BUILD_RUNNER_LOCAL_APKANALYZER`、
  `APP_TEST_CTRL_BUILD_RUNNER_LOCAL_APKSIGNER`：local 固定工具路径；未设置时只在 SDK
  的 `cmdline-tools/latest`、最多 128 个数字版本目录、legacy tools 和最多 128 个数字
  build-tools 目录中有界发现。

Runner 启动不会登录、下载镜像或解析云凭据。配置和镜像需由用户在 CrashFix 流程外准备。

## 固定调用顺序

```text
probe_capabilities
  → 用户单独批准封存 Gradle cache
  → seal_gradle_cache（返回进程内 opaque cache_seed_id）
  → snapshot helper 独立 audit workspace（返回完整 manifest/diff hash）
  → create_build_environment（绑定一次性精确命令）
  → run_gradle（消费 environment_id）
  → inspect_apk({environment_id})（仅成功的 build phase，消费私有 APK staging）
  → 用户另行确认清理后 dispose_gradle_cache({cache_seed_id})
```

当前生产 `docker` probe 会在第一步返回 `HOST_WORKSPACE_DISK_QUOTA_UNENFORCED`，所以
Docker 后续工具均被阻断。`local_trusted` probe 可在工具链校验成功后返回
`available=true`，同时固定公开所有未强制的隔离能力和 `auto_patch_eligible=false`。
这里的 `false` 禁止无人值守/强隔离式自动资格，不会覆盖用户对可信低敏项目的显式
本机执行与逐命令审批。
每一步仍必须失败即停；禁止跳过 probe、复用已消费/过期的 environment、在
`run_gradle` 时增加参数，或因 offline 依赖缺失而开放网络。切换 backend 必须修改配置并
重启 Runner、重新 probe 和创建新 session，不能复用旧环境。

MCP `tools/list` 会诚实发布副作用 hints：只有 `probe_capabilities` 是 read-only；
`seal_gradle_cache/create_build_environment` 会新增本地状态但不删除已有状态；
`dispose_gradle_cache/run_gradle/inspect_apk` 会消费或删除状态，因此标记 destructive。
`run_gradle` 还固定 `openWorldHint=true`，因为 backend 可能是网络未强制阻断的
`local_trusted`；`--offline` 不得被客户端解释为强制断网。

### `probe_capabilities`

无参数。生产 `docker` 路径先要求可核验的宿主 workspace quota；当前尚无实现，因此返回
`available=false`、`auto_patch_eligible=false`、
`workspace_disk_quota.enforced=false` 和
`HOST_WORKSPACE_DISK_QUOTA_UNENFORCED`。不能用环境变量、`df` 或构建前后大小统计伪造
通过。契约测试的正路径还会核验 Docker daemon、Linux/seccomp、精确 image digest、
注册的 OCI runtime、精确容器 ENV、工具链与隔离 canary。

显式 `local_trusted` 返回同一 v2 schema，但会诚实标记
`verification_level=trusted_local`、`strong_isolation=false`、
`network_policy=not_enforced`、`workspace_disk_quota.enforced=false`、
`filesystem_write_isolation=not_enforced`、
`secret_filesystem_isolation=not_enforced`、
`process_containment=process_group_best_effort`、`requires_explicit_trust=true` 和
`auto_patch_eligible=false`。它不会伪造 Docker 能力。

### `seal_gradle_cache`

输入 `source_gradle_home` 绝对路径。调用前必须取得用户对这次本地复制的独立确认，并
停止所有可能修改该目录的 Gradle 进程。

只复制：

- `caches/modules-2`
- `wrapper/dists`

拒绝 symlink、hard link、特殊文件、group/other 可写条目和 credential-like 路径；忽略
`.lock/.lck/.part/.partial/.tmp` 与 `gc.properties`，不复制 `gradle.properties`、init scripts
或 keystore。Wrapper dist 只接受标准的 0-byte `<dist>.zip.ok` 与非空的标准
`gradle-<version>/bin/gradle` launcher；
zip-only、仅 lock/临时文件或其他 0-byte cache 文件都 fail-closed。
上限为 250,000 个文件、16 GiB 总量、单文件 2 GiB。两遍源清单与目标清单必须一致。

结果位于随机 `0700` 私有目录，cache 内容封为 `0500/0400`。工具只返回当前 Runner
进程内有效的 opaque `cache_seed_id`、短 `cache_seed_ref` 和非敏感计数；不返回 seed
绝对路径或完整 manifest hash。该 seed 默认保留，删除必须另行确认后调用
`dispose_gradle_cache({cache_seed_id})`。MCP 重启会丢失 opaque ID，但不会暗中删除 seed。

### `create_build_environment`

输入：

- `expected_backend=docker|local_trusted`，必须与本 session 锁定且当前实际配置的 backend
  完全一致；不匹配立即拒绝；
- `role=baseline|candidate`
- `phase=regression|affected|static_analysis|build`
- snapshot helper 返回的 `workspace_root`、`snapshot_root` 与
  `expected_source_snapshot_sha256`
- 调用方在**紧邻 create 前**对同一 role/workspace 执行独立 snapshot audit 后得到的完整
  `expected_workspace_manifest_sha256` 与
  `expected_workspace_canonical_diff_sha256`；不得使用旧 audit、短 hash 或模型推断值
- 上一步返回的 opaque `cache_seed_id`
- 可选规范化 `project_relative_dir`
- 1–16 个唯一 Gradle task

`phase=build` 还必须在 create 时同时绑定：

- workspace 内规范化、当前**不存在**且以 `.apk` 结尾的 `artifact_relative_path`；
- 用户另行批准的非生产测试证书
  `expected_signer_certificate_sha256`（64 位小写 hex）。

非 build phase 禁止传这两个字段。Runner 不接收签名私钥或密码，也不负责签名；若构建
无法在不使用个人/生产签名秘密的前提下产出匹配证书的 APK，就必须中止。

允许的 task leaf：

- `regression/affected`：`test*` 或 `check*`
- `static_analysis`：`lint*` 或 `check*`
- `build`：仅 `assemble*`（APK-only）

工具重新 probe、核对三棵目录互不重叠、重做 snapshot audit，并把当前
`current_manifest_sha256/canonical_diff_sha256` 与调用方批准的两个完整期望值逐字节精确
比较；任一不一致都 fail-closed。之后才验证 cache seed 并绑定唯一命令：

```text
./gradlew --offline --no-daemon --console=plain <tasks...>
```

它只返回 15 分钟有效、single-use 的 opaque `environment_id`，公共执行环境身份
`build_environment_sha256`，以及 workspace 专属证据
`workspace_role/workspace_manifest_sha256/workspace_canonical_diff_sha256`，不会运行 Gradle。

`build_environment/v2` 及其 hash **故意不纳入** role、workspace manifest 或 canonical diff；
它只表示两次运行应共享的 profile、命令、工具链、SDK、依赖锁、cache seed、source snapshot
和签名上下文。这样 baseline/candidate 才能机械核对公共环境 hash 相同，同时用上述三个独立
workspace 字段证明各自实际受测内容。普通业务源码补丁会改变 workspace identity，但不应
改变公共环境 hash；构建逻辑、task、seed、工具链等公共执行输入改变则必须改变后者。
命令、workspace、seed、image 或 sandbox 身份发生变化时必须重新创建；baseline/candidate
公平对比必须使用相同 task 和同一 seed。

### `run_gradle`

只接受 `environment_id`，不能再传 command、环境变量、路径或 Gradle 参数。调用会先消费
lease，再重新 probe 和 audit；失败后不能复用同一 ID。容器只挂载 workspace 为可写、
cache seed 与 entrypoint 为只读，并使用 fresh bounded tmpfs overlay。`local_trusted` 则以
私有 cache 深拷贝和最小环境直接执行同一固定 argv，不继承代理、Firebase token 等环境，
但无法强制网络或宿主文件隔离。两种模式都会在执行前后重新验证 cache/source/toolchain；
源码/cache/runner 身份漂移、超时、进程组或私有目录清理不可证明都会失败并阻断后续运行。

输出只包含状态、退出码、时长、公共环境/命令 hash、create 时锁定的
`workspace_role/workspace_manifest_sha256/workspace_canonical_diff_sha256`，以及
stdout/stderr 的 domain-separated SHA-256；**不返回日志原文或 tail**。run 返回的三个
workspace 字段必须与 create 完全相同，不能由 post-run 内容替换。因此 Runner 结果只能
证明命令、已批准 workspace 和输出身份，不能提供可持久化的构建日志。非零退出码是否构成
有效“先失败回归测试”，由 CrashFix 根据目标故障点和另行取得的受控证据判断。

### `inspect_apk`

只接受 `environment_id` 一个参数。APK 相对路径与预期 signer 已在 create 时绑定；成功
run 会把该路径的 APK 复制到 Runner 私有只读 staging，inspect 只消费这份 staging，
不会重新接受 workspace 路径。调用无论成功失败都会先消费 environment，再在 `finally`
清理未 publish staging；清理不能证明时整次 inspection 失败，且不能重试同一 ID。
Docker 使用同一固定镜像的只读 inspector，local 使用初始化时锁定且运行前后持续复核的
宿主 SDK 工具；两者都返回：

- APK SHA-256 与字节数；
- package、version name/code、debuggable；
- 是否签名及 signer certificate SHA-256；
- `variant` 及其来源。

只有 signer certificate **恰好一个**且与 create 时批准的非生产 SHA-256 严格相等，
inspection 才成功；缺失、多 signer 或不匹配一律 fail closed。

**variant 不从 APK 本体推断。** 只有构建 task 能唯一推出一个
`assemble<Variant>` 后缀时才返回 `variant_source="task-bound"`；否则为 `unavailable`，且始终
`variant_artifact_derived=false`。CrashFix 不得把 task-bound hint 描述成 artifact-derived
证据；需要精确 variant 而结果不可用时应中止自动验证。

## 安全边界与限制

- Runner 的结构化接口只面向 Android Gradle 与 CrashFix
  `snapshot_repro_equivalent` sealed workspace；Git release/worktree 构建路径暂不支持。
  **当前生产 Docker backend 连 snapshot 项目命令也不会执行**，只能分析/输出文本计划；
  local 模式只能用于明确接受风险的 trusted-local 执行，不能声明 strong isolation 或
  `auto_patch_eligible=true`。
- 不接受任意 shell、额外 argv、任意环境变量、网络放宽或动态 Docker 参数。
- 不读取生产 keystore、Keychain 或签名秘密；当前环境 manifest 的 signing adapter 为
  `none`。APK 必须由项目内非生产测试签名或另一个经批准的受信任离线适配器处理。
- Docker 使用只读 seed + fresh bounded tmpfs overlay；local 使用 seed 的一次性私有深拷贝。
  两者都不写回全局 Gradle home；依赖缺失时应在 CrashFix 外预热，再经新审批封存新 seed。
- 项目命令可读 sealed clone，并可写该 clone 的排除构建目录；因此用户仍须确认 snapshot
  不含自定义命名或二进制秘密。local 项目还可能访问其他同 UID 宿主路径。
- `/gradle-home`、`/tmp`、`/home/build` 有 tmpfs 上限，但 `/workspace` 仍是无限制宿主
  bind mount。当前 Runner **没有可核验的宿主 workspace 磁盘 quota**，且不接受用户配置
  的布尔“已启用”声明，所以生产 Docker probe 必须 fail-closed。只有后续实现 bounded tmpfs、
  受限磁盘镜像或可独立核验的文件系统 quota，才能重新开放项目命令。
- Runner 不抵御恶意 Docker daemon、宿主 root 或仍在运行的同 UID 对抗进程。
- `local_trusted` 额外信任项目代码、当前非 root 用户、Java/Android SDK 和宿主 OS；项目
  仍可能读写该 UID 可访问的其他路径或联网。最小环境与进程组清理是减损措施，不是 sandbox。
- 单个 MCP 进程最多保留一个 cache seed、八个未消费 environment lease 和一个待 inspect
  APK；所有 backend 执行工作流全局 fail-fast 串行，忙时不消费 ID。
  过期 APK staging 清理失败时保留记录并允许同进程重试。
- 容器、local 私有目录和未 publish 的内部 staging 只在**正常进程生命周期**中自动清理。
  MCP 被强杀或崩溃时没有 startup sweep/持久 ownership registry，可能遗留 container、
  local 临时根、entrypoint 或 APK staging；opaque `environment_id/cache_seed_id` 也会丢失，
  retained seed 因而无法在重启后
  通过 MCP 恢复清理。不要猜测临时路径手工删除，也不要声称“重启即已清理”。
- sealed cache、snapshot、baseline、candidate 与导出目录默认保留，删除需单独确认。

CrashFix 的编排、审批和持久化规则以
`skills/crashfix/references/build-runner-contract.md` 为准。
