# iOS 测试接入指南（模拟器 + 真机）

本项目的 iOS 支持分两条独立路径，工具和依赖完全不同，**先判断你在哪条路上**：

| | 模拟器 (simulator) | 真机 (real device) |
|---|---|---|
| UI 驱动 | mobile-mcp（开箱即用） | mobile-mcp + **WebDriverAgent + go-ios** |
| 日志 | `log.ios_start_capture`（simctl log stream） | `log.ios_device_start_capture`（idevicesyslog） |
| 崩溃 | `log.ios_list_ips`（扫 Mac 本地 DiagnosticReports） | `log.ios_pull_device_crashes`（从设备拉） |
| 列设备 | `log.ios_list_simulators` | `log.ios_list_devices` |

判断方法：`mobile.mobile_list_available_devices` 返回里看 `type` 字段（`simulator` / `real`）。

> **核心区别**：真机崩溃 **不会** 落到 Mac 的 `~/Library/Logs/DiagnosticReports`，所以 `ios_list_ips` 对真机永远是空的，必须用 `ios_pull_device_crashes` 从设备拉。

## 一、模拟器路径（最简单）

1. 启动一个模拟器：`xcrun simctl boot <udid>`，或开 Simulator.app。
2. `mobile.mobile_list_available_devices` 应能看到它（`type=simulator`）。
3. UI / 日志 / 崩溃直接用上表左列的工具，无需任何额外安装。

`log.ios_list_simulators` 可列出所有模拟器及启动状态。

## 二、真机路径（需要一次性搭建）

真机 UI 自动化依赖链：**go-ios**（发现设备 + 装 WDA + 端口转发）→ **WebDriverAgent** 跑在设备上（监听 8100）→ mobile-mcp 连 `localhost:8100`。

### 依赖检查

```bash
# 1. libimobiledevice（日志/崩溃/装卸，brew）
brew install libimobiledevice ideviceinstaller

# 2. go-ios（mobile-mcp 发现真机全靠它；npm 装）
npm install -g go-ios
ios version          # {"version":"v1.x.x"} 即 OK

# 3. 真机已连接并信任
idevice_id -l        # 打印出 UDID 即已连上

# 4. 项目自检（会逐项检查 ideviceinfo / idevicesyslog /
#    idevicecrashreport / ideviceinstaller / go-ios）
node scripts/doctor.mjs
```

> **iOS 17+ 需要隧道**：`ios tunnel start`（要 sudo）。iOS 16 及以下免隧道（go-ios `isTunnelRequired()` 判断 major>=17）。

### 编译并签名 WebDriverAgent

WDA 是个要装到设备上的 app，必须用你的 Apple 开发者身份签名。

```bash
# 1. 拿源码（appium 维护的版本最活跃）
git clone --depth 1 https://github.com/appium/WebDriverAgent.git
cd WebDriverAgent

# 2. 查签名身份和 Team ID
security find-identity -v -p codesigning
#   → "Apple Development: you@example.com (XXXX)"
# Team ID 是证书 subject 里的 OU 字段：
#   security find-certificate -c "Apple Development: you@..." -p | openssl x509 -noout -subject

# 3. 编译（自动签名 + 唯一 bundle id）
xcodebuild \
  -project WebDriverAgent.xcodeproj \
  -scheme WebDriverAgentRunner \
  -destination 'id=<设备UDID>' \
  -derivedDataPath /tmp/wda-build \
  DEVELOPMENT_TEAM=<TeamID> \
  PRODUCT_BUNDLE_IDENTIFIER=com.你的前缀.wda.runner \
  CODE_SIGN_STYLE=Automatic \
  -allowProvisioningUpdates \
  build-for-testing
```

**产物**：`/tmp/wda-build/Build/Products/Debug-iphoneos/WebDriverAgentRunner-Runner.app`

```bash
# 4. 装到设备
ios install --path=".../WebDriverAgentRunner-Runner.app" --udid=<UDID>
```

⚠️ **免费开发者账号限制**：
- 同一设备最多同时装 **3 个** 自签 app。装 WDA 前可能要 `ios uninstall <某个bundleid>` 腾名额。
- 证书 **7 天过期**，过期后要重新 `build-for-testing` + `install`。
- 付费账号（$99/年）无此限制。

首次运行前，设备上可能要手动信任证书：**设置 → 通用 → VPN与设备管理 → 信任**。如果设备之前已信任过同一开发者证书，则无需再操作。

### 启动 WDA + 端口转发

推荐使用仓库脚本。它会先选择并验证 UDID，再启动 WDA，且不会把另一台设备
或来源未知的 8100 端口误判为当前目标：

```bash
# 只连接一台真机时自动选择
bash scripts/ios-wda-up.sh

# 连接多台真机时必须显式指定
UDID=<目标UDID> bash scripts/ios-wda-up.sh

# 设备装有多个 WDA / *.xctrunner，无法可靠唯一识别时必须显式指定
UDID=<目标UDID> \
WDA_BUNDLE_ID=com.你的前缀.wda.runner.xctrunner \
bash scripts/ios-wda-up.sh
```

脚本只会自动选择**唯一的可靠 WDA 候选**（bundle id 或显示名称带
WebDriverAgent / WDA Runner 特征）。没有可靠特征时只接受唯一的
`*.xctrunner`；多个候选绝不会任取第一条。

脚本会同时监控 `runwda` 与 `forward`。任一进程提前退出、30 秒超时，或收到
`INT` / `TERM` 时，都会清理本次创建的后台进程；成功后则保持两个进程长驻。

如需手动排查，等价命令如下：

```bash
# 后台启动 WDA（长驻）
ios runwda --bundleid=com.你的前缀.wda.runner.xctrunner \
           --testrunnerbundleid=com.你的前缀.wda.runner.xctrunner \
           --xctestconfig=WebDriverAgentRunner.xctest \
           --udid=<UDID> &

# 把本机 8100 转发到设备 WDA 的 8100（参数顺序：本地端口、设备端口）
ios forward 8100 8100 --udid=<UDID> &

# 验证：响应必须是合法 JSON，且 ready 是布尔值 true
curl -fsS http://127.0.0.1:8100/status
```

之后 `mobile.mobile_list_available_devices` 就能看到真机（`type=real`），UI 操作全部可用。

> ⚠️ **端口限制**：设备端 WDA 固定监听 8100，当前 mobile-mcp 也固定连接本机
> `localhost:8100`。因此 `WDA_PORT` 目前只能是 8100；脚本会拒绝其他值，避免
> “脚本显示成功但 mobile-mcp 连不上”的假成功。

> ⚠️ `runwda` 和 `forward` 都是长驻会话，**设备重启或拔线后要重跑**。
> 幂等重跑脚本时，只有“8100 确实由目标 UDID 的 forward 监听”且 `/status`
> 是合法 JSON、`ready === true` 才会直接复用。只有 `sessionId` / `state`，或
> `ready: false` / `"true"`，都不算就绪。

## 三、点击坐标陷阱（务必注意）

`mobile.mobile_list_elements_on_screen` 在 iOS 上返回的每个元素 `coordinates` 是：

```json
{ "x": 316, "y": 798, "width": 68, "height": 68 }
```

这是元素的**左上角 + 宽高**，**没有 `.center` 字段**（Android 的 `ui.tap_element` 才有 `.center`，别照搬）。

`mobile.mobile_click_on_screen_at_coordinates` 需要的是**要点的那个像素点**。直接传左上角 `(x, y)` 会点在元素边缘/外面——**WDA 返回成功，但界面无反应**。必须自己算中心：

```
cx = x + width  / 2
cy = y + height / 2
mobile.mobile_click_on_screen_at_coordinates({ device: "<device-id>", x: cx, y: cy })
```

实测佐证：点相机图标左上角 `(316,798)` 无反应；点中心 `(350,832)` 才打开相机。

## 四、log-mcp 真机工具速查

| 工具 | 作用 | 底层 |
|---|---|---|
| `ios_list_devices` | 列真机（UDID/名称/型号/系统版本） | `idevice_id` + `ideviceinfo` |
| `ios_device_start_capture` | 后台抓 syslog 到 `<session>/logs/ios-device-syslog.txt`；`process_match` 过滤进程；`max_bytes` 默认 256 MiB、最大 2 GiB，达到后自动停止并留下 `limit_reached` 终态；`stop_capture` 手动停止 | `idevicesyslog` |
| `ios_pull_device_crashes` | 从设备拉崩溃报告到目录，返回 `files[]`；`filter` 按进程名筛，`since_minutes` 仅裁剪返回列表（历史报告仍会落盘）；默认保留设备副本。`remove_from_device=true` 必须提供非空准确 `filter`，并禁止与 `since_minutes` 组合 | `idevicecrashreport` |
| `ios_device_list_apps` | 列已装 app（user/system/all） | `ideviceinstaller` |

`since_minutes` 的截止时间在请求开始时冻结，优先按设备报告的 IANA 时区解释
文件名；设备时区不可用时使用最多 14 小时的保守容差，宁可多返回历史报告，
也不漏掉刚发生的崩溃。删除模式会解析 `Move:` 并返回实际落盘文件。

`filter` 区分大小写，目标是 app 的**可执行进程名**，不能直接拿 bundle id
代替。优先从已展开的 `CFBundleExecutable` / `EXECUTABLE_NAME`，或 bundle id
精确相等的已有 `.ips` 的 `proc_name` 获取；不能单独使用 `PRODUCT_NAME` 或设备
显示名。无法可靠确定时省略 `filter`，拉取后用
`analyzer.parse_ips_file` 返回的 `bundle_id` 做归因（会更慢，但不会静默漏报）。

无 `process_match` 的真机 syslog 可能非常大。默认容量限制保护磁盘，但测试流程仍应
优先传准确的 `CFBundleExecutable`。调用方应检查 `list_captures` 或
`stop_capture`：若返回 `status="failed"`，根据 `reason/error` 终止或降级，不能把
“日志进程已经中途退出”当作正常完成。最近失败终态最多保留 64 条，且不会阻塞同一
`session_id` 重新启动。

这些工具在没连真机 / 没装 libimobiledevice 时返回可读的错误提示，不会静默失败。

## 五、故障排查

| 症状 | 原因 / 解法 |
|---|---|
| `mobile_list_available_devices` 空 | go-ios 没装 → `npm i -g go-ios`；或真机没信任 |
| `ios install` 报 "maximum number of installed apps" | 免费账号 3 app 上限 → `ios uninstall` 腾名额 |
| `curl localhost:8100/status` 连不上 | `ios runwda` 没跑 / `ios forward 8100` 没跑 / WDA 崩了 |
| 脚本提示 8100 属于未知进程或另一台设备 | 先用 `lsof -nP -iTCP:8100 -sTCP:LISTEN` 找占用者并停止；不要绕过检查，否则可能控制错设备 |
| `/status` 有响应但仍判未就绪 | 响应必须是合法 JSON，且 `ready` 必须严格为布尔值 `true`；`sessionId`、`state` 或字符串 `"true"` 均不够 |
| 自动探测提示多个 `*.xctrunner` | 不会猜测；设置 `WDA_BUNDLE_ID=<准确bundle id>` 后重跑 |
| 点击无反应但 WDA 报成功 | 点了左上角，没算中心（见第三节） |
| `ios_list_ips` 真机崩溃为空 | 真机崩溃不落 Mac 本地，改用 `ios_pull_device_crashes` |
| WDA 装完几天后失效 | 免费证书 7 天过期，重新 `build-for-testing` + `install` |
