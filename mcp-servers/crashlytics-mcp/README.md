# crashlytics-mcp

只读 Firebase Crashlytics MCP。它把 Cloud Logging 中的 Crashlytics 事件转换成
有界、脱敏的 `crash-event/v1`，也提供一个延迟加载的 fixture provider 供本地测试。

## 安全模型

- 只使用 `logging.entries.list` 语义，不提供 resolve、delete、note 或任意写操作。
- Cloud provider 只访问固定地址
  `https://logging.googleapis.com/v2/entries:list`，工具参数不能覆盖 URL、scope 或凭据。
- 通过 `google-auth-library` 的 Application Default Credentials（ADC）认证；建议只授予
  `roles/logging.viewer`，凭据、token 不会进入 MCP 参数和响应。
- project 与 app 必须同时命中启动环境中的固定 allowlist；app 授权按 project 隔离。
- 时间窗、页大小、page token、frame 数、上游响应、fixture 和 MCP 响应均有硬上限。
- 429/5xx 与超时只做有界重试；错误返回稳定 `error.code`，不会回显上游响应正文。
- 采用字段 allowlist 构造输出。`customKeys`、user、installation id、原始 logs 和
  breadcrumbs 永不返回；URL、邮箱、电话、token、JWT、密码、IP 和用户目录会脱敏。
- 官方 `issueTitle`、异常 message、provider process/thread/state 属于自由文本，服务端
  直接丢弃；`issue.title` 只由受限 exception class / signal 派生，避免正则漏掉未知 PII。
- 服务启动时不读取 fixture、不解析 ADC，也不发起网络请求。第一次相关工具调用才加载。

## 配置

```bash
export CRASHLYTICS_PROVIDER=cloud_logging
export CRASHLYTICS_PROJECT_ALLOWLIST='demo-project'
export CRASHLYTICS_APP_ALLOWLIST='demo-project=1:1234567890:android:abc123,demo-project=1:1234567890:ios:def456'
export CRASHLYTICS_MAX_WINDOW_HOURS=24       # 1..720，默认 24
export CRASHLYTICS_REQUEST_TIMEOUT_MS=8000   # 250..30000
export CRASHLYTICS_MAX_RETRIES=2             # 0..4，首次请求之外的重试次数
```

`CRASHLYTICS_APP_ALLOWLIST` 的每一项必须是
`project_id=firebase_app_id`，不能用全局 app 通配符。

Cloud provider 只查询官方事件日志
`projects/PROJECT_ID/logs/firebasecrashlytics.googleapis.com%2Fevents`，并在 resource
label、label 或 `jsonPayload` 中匹配 `firebase_app_id`、`issue_id`、`event_id`；时间
可以来自条目 `timestamp`。解析器仅提取公开规范字段，其余字段会被丢弃。

### Fixture provider

```bash
export CRASHLYTICS_PROVIDER=fixture
export CRASHLYTICS_PROJECT_ALLOWLIST=demo-project
export CRASHLYTICS_APP_ALLOWLIST='demo-project=demo-app'
export CRASHLYTICS_FIXTURE_PATH='/absolute/path/crashlytics.fixture.json'
```

fixture 只在第一次 `list_apps`/事件查询时读取，最大 8 MiB：

```json
{
  "schema_version": "crashlytics-fixture/v1",
  "apps": [
    {
      "project_id": "demo-project",
      "firebase_app_id": "demo-app",
      "platform": "android",
      "package_name": "com.example.demo"
    }
  ],
  "events": [
    {
      "project_id": "demo-project",
      "firebase_app_id": "demo-app",
      "issue_id": "issue-1",
      "event_id": "event-1",
      "timestamp": "2026-07-29T00:00:00Z",
      "fatal": true,
      "kind": "crash",
      "exception": { "class": "java.lang.NullPointerException" },
      "frames": [
        {
          "symbol": "com.example.demo.MainActivity.onCreate",
          "file": "MainActivity.kt",
          "line": 42,
          "app_owned": true
        }
      ]
    }
  ]
}
```

fixture 文件仍受 project/app allowlist 约束，不能扩大访问范围。

## MCP 工具

- `get_context`：返回 provider、allowlist、上限和隐私策略；不访问网络/fixture。
- `list_apps`：列出指定 project 内允许的 app。
- `list_issues`：从单个有界事件页聚合 issue；明确返回
  `aggregation_scope=current_event_page`。
- `get_issue`：返回 issue 摘要和最近的代表事件。
- `list_events`：按时间、issue、fatal/kind 查询规范化事件。
- `get_event`：按 event id 返回一个规范化事件。
- `get_symbolication_status`：对一个 issue 或 event 汇总 frame 符号覆盖率。返回的
  `evidence_kind=frame_symbolication_coverage` 不是符号产物身份证明；
  `artifact_identity.verified=false`，不能据此断定 mapping/dSYM/native symbols 与
  release build 匹配。

所有输入 schema 都是 strict；未知参数会被拒绝。除 `get_context` 外，所有数据工具都
必须显式传 `project_id`，事件工具还必须传 `firebase_app_id`。默认查询最近 24 小时，
`start_time`/`end_time` 必须是带时区的 ISO 8601。

核心事件输出：

```text
schema_version, provider, project_id, firebase_app_id,
app{platform,package_name?,bundle_id?,version_name?,build_version?},
issue{id,title,type,state?}, event{id,occurred_at}, fatal, kind,
process?, thread?, exception{class?,root_cause_class?,signal?}, frames[], canonical_stack,
symbolication, aggregate?, truncated, fetched_at
```

## 开发

依赖由仓库 workspace 统一安装。该目录自身的验证命令：

```bash
npm run build -w mcp-servers/crashlytics-mcp
npm test -w mcp-servers/crashlytics-mcp
node scripts/mcp-smoke.mjs \
  mcp-servers/crashlytics-mcp/dist/index.js \
  get_context,list_apps,list_issues,get_issue,list_events,get_event,get_symbolication_status
```
