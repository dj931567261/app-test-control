#!/usr/bin/env bash
# ios-wda-up.sh — 一键拉起 iOS 真机 UI 自动化所需的 WebDriverAgent。
#
# 干三件事：
#   1. ios runwda   —— 在设备上启动 WDA(长驻)
#   2. ios forward  —— 把设备 8100 转发到 localhost:8100(长驻)
#   3. 轮询 /status —— 确认 WDA 真的起来了
#
# 前置条件(详见 docs/IOS.md 第二节)：
#   - libimobiledevice + go-ios 已装，真机已连接并信任
#   - WDA 已 build-for-testing 并 `ios install` 到设备
#
# 用法：
#   bash scripts/ios-wda-up.sh                 # 自动选唯一连接的设备
#   UDID=00008030-xxxx bash scripts/ios-wda-up.sh
#   WDA_BUNDLE_ID=com.你的前缀.wda.runner.xctrunner bash scripts/ios-wda-up.sh
#
# 环境变量：
#   UDID                目标设备 UDID(不设则自动选唯一一台)
#   WDA_BUNDLE_ID       WDA 的 bundle id(不设则用 go-ios 默认
#                       com.facebook.WebDriverAgentRunner.xctrunner)
#   WDA_TESTRUNNER_ID   testrunner bundle id(不设则同 WDA_BUNDLE_ID)
#   WDA_XCTESTCONFIG    xctest 配置名(不设则用 go-ios 默认)
#   WDA_PORT            转发端口(默认 8100)
#   WDA_LOG_DIR         日志目录(默认 /tmp/wda)

set -euo pipefail

PORT="${WDA_PORT:-8100}"
LOG_DIR="${WDA_LOG_DIR:-/tmp/wda}"
mkdir -p "$LOG_DIR"

RED=$'\033[31m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; GRAY=$'\033[90m'; BOLD=$'\033[1m'; RESET=$'\033[0m'
info()  { echo "${GREEN}✓${RESET} $*"; }
warn()  { echo "${YELLOW}!${RESET} $*"; }
die()   { echo "${RED}✗${RESET} $*" >&2; exit 1; }

# --- 依赖检查 ---------------------------------------------------------------
command -v ios >/dev/null 2>&1 || die "go-ios(\`ios\`) 未安装 → npm i -g go-ios(见 docs/IOS.md)"
command -v idevice_id >/dev/null 2>&1 || warn "idevice_id 未找到；无法自动列设备，请显式传 UDID="

# --- 已经在跑就直接退出(幂等) ----------------------------------------------
if curl -s -m 3 "http://localhost:${PORT}/status" 2>/dev/null | grep -qE '"ready"[[:space:]]*:[[:space:]]*true|sessionId|state'; then
  info "WebDriverAgent 已在 :${PORT} 运行，无需重复拉起。"
  exit 0
fi

# --- 选设备 -----------------------------------------------------------------
if [[ -z "${UDID:-}" ]]; then
  if command -v idevice_id >/dev/null 2>&1; then
    # 用 while-read 收集，兼容 macOS 自带 bash 3.2(无 mapfile)
    _udids=()
    while IFS= read -r _line; do
      [[ -n "$_line" ]] && _udids+=("$_line")
    done < <(idevice_id -l 2>/dev/null | tr -d '\r')
    if [[ "${#_udids[@]}" -eq 0 ]]; then
      die "没有检测到已连接的真机。插上并信任设备后重试(idevice_id -l 应打印 UDID)。"
    elif [[ "${#_udids[@]}" -gt 1 ]]; then
      die "检测到多台设备：${_udids[*]}。请用 UDID=<其中一个> 显式指定。"
    fi
    UDID="${_udids[0]}"
  else
    die "未设置 UDID 且无 idevice_id 可用。请 UDID=<设备UDID> bash scripts/ios-wda-up.sh"
  fi
fi
info "目标设备：${UDID}"

# --- iOS 17+ 隧道提醒(go-ios 对 major>=17 要求 tunnel，且要 sudo) ---------
OSVER="$(ideviceinfo -u "$UDID" -k ProductVersion 2>/dev/null | tr -d '\r' || true)"
if [[ -n "$OSVER" ]]; then
  MAJOR="${OSVER%%.*}"
  echo "${GRAY}  iOS 版本：${OSVER}${RESET}"
  if [[ "${MAJOR:-0}" =~ ^[0-9]+$ ]] && [[ "$MAJOR" -ge 17 ]]; then
    warn "iOS ${OSVER} 需要隧道：另开一个终端跑 ${BOLD}sudo ios tunnel start${RESET}(长驻)，否则 runwda 会失败。"
  fi
fi

# --- 预检 / 自动探测 WDA bundle id ------------------------------------------
# 本脚本只「拉起」已装好的 WDA,不负责编译/签名/安装(那步要你的开发者身份,见
# docs/IOS.md 第二节)。这里提前用 ideviceinstaller 探一下设备上装了哪个 WDA:
#   1. 用户显式设了 WDA_BUNDLE_ID   → 尊重用户,不动;
#   2. 没设 → 自动从已装列表里揪出 WDA runner 的 bundle id 并采用
#      (自签 WDA 的 id 几乎都带自己前缀,如 com.你的前缀.wda.runner.xctrunner,
#       facebook 默认值基本对不上,所以自动探测能省掉手动设 env 这一步);
#   3. 探不到 → 告警提示去装,但不 die —— 探测/解析可能不准,不因误判拦下能跑的流程。
# WDA runner 的可靠特征:bundle id(每行第一个逗号前那列)以 .xctrunner 结尾 ——
# 这是 go-ios test runner 的标志,不能靠 id 里含 "webdriveragent"(自签的 id 常带
# 自己的前缀如 com.dj.wda.runner.xctrunner,里面压根没有 webdriveragent 字样)。
# 注意:管道里不能用 `head` 提前关闭上游 —— 在 pipefail 下会给 grep 送 SIGPIPE、
# 整条管道非零、set -e 直接杀脚本。改用 awk 一趟取首个匹配的 bundle id。
# 只在 ideviceinstaller 可用时做。
if command -v ideviceinstaller >/dev/null 2>&1; then
  _installed="$(ideviceinstaller -u "$UDID" list 2>/dev/null || true)"
  if [[ -n "${WDA_BUNDLE_ID:-}" ]]; then
    # 用户指定了:只校验在不在,不覆盖。base id 去掉尾部 .xctrunner 再 grep。
    _wda_base="${WDA_BUNDLE_ID%.xctrunner}"
    if [[ -n "$_installed" ]] && ! grep -qiF "$_wda_base" <<<"$_installed"; then
      warn "设备上找不到你指定的 WDA(${WDA_BUNDLE_ID});若确已安装可忽略,否则见 docs/IOS.md 第二节。"
    fi
  elif [[ -n "$_installed" ]]; then
    # 没指定:揪出第一列以 .xctrunner 结尾的 bundle id。awk 取到即 exit,不触发 SIGPIPE。
    _detected="$(awk -F, 'NR>0{gsub(/^[ \t]+|[ \t\r]+$/,"",$1); if($1 ~ /\.xctrunner$/){print $1; exit}}' <<<"$_installed")"
    if [[ -n "$_detected" ]]; then
      WDA_BUNDLE_ID="$_detected"
      info "自动探测到 WDA:${WDA_BUNDLE_ID}"
    else
      warn "设备上似乎未安装 WebDriverAgent(没找到 *.xctrunner 的 test runner)。"
      echo "${GRAY}    先按 docs/IOS.md 第二节 build-for-testing + \`ios install\` 装好 WDA 再跑本脚本。${RESET}"
      echo "${GRAY}    (若确已装但 id 特殊,可显式 WDA_BUNDLE_ID=... 绕过探测)${RESET}"
    fi
  fi
fi

# --- 组装 runwda 参数 -------------------------------------------------------
# go-ios 要求 --bundleid / --testrunnerbundleid / --xctestconfig 三个「要么全给、
# 要么全不给」(给了部分它直接报 "specify either NONE ... or ALL" 退出)。所以只
# 要设了 WDA_BUNDLE_ID,就把三件套凑齐:testrunner 默认同 bundleid,xctestconfig
# 默认用 WDA 的标准值 WebDriverAgentRunner.xctest(见 docs/IOS.md)。完全不设
# WDA_BUNDLE_ID 时则一个都不传,交给 go-ios 自己的默认。
RUNWDA_ARGS=(runwda --udid="$UDID")
if [[ -n "${WDA_BUNDLE_ID:-}" ]]; then
  RUNWDA_ARGS+=(--bundleid="$WDA_BUNDLE_ID")
  RUNWDA_ARGS+=(--testrunnerbundleid="${WDA_TESTRUNNER_ID:-$WDA_BUNDLE_ID}")
  RUNWDA_ARGS+=(--xctestconfig="${WDA_XCTESTCONFIG:-WebDriverAgentRunner.xctest}")
fi

RUNWDA_LOG="${LOG_DIR}/runwda-${UDID}.log"
FORWARD_LOG="${LOG_DIR}/forward-${UDID}.log"

# --- 前置清理：杀掉本 UDID 上遗留的 runwda/forward ---------------------------
# 走到这里说明 :8100 探测没通过(上面幂等检查已 return),但上一次运行可能
# 半死不活地残留了后台进程 —— 若不清理,再 spawn 一份会和旧的抢 8100 端口
# 转发,forward 静默失败、status 一直不 ready。按 UDID 精确匹配,不误伤其他设备。
# pkill 没命中会返回非零,set -e 下用 `|| true` 兜住。
pkill -f "ios runwda .*${UDID}" 2>/dev/null || true
pkill -f "ios forward ${PORT} ${PORT} --udid=${UDID}" 2>/dev/null || true

# --- 启动 runwda(后台长驻) --------------------------------------------------
echo "${GRAY}  ios ${RUNWDA_ARGS[*]}${RESET}"
nohup ios "${RUNWDA_ARGS[@]}" >"$RUNWDA_LOG" 2>&1 &
RUNWDA_PID=$!
info "runwda 已启动(pid ${RUNWDA_PID})，日志 → ${RUNWDA_LOG}"

# --- 端口转发(后台长驻) -----------------------------------------------------
nohup ios forward "$PORT" "$PORT" --udid="$UDID" >"$FORWARD_LOG" 2>&1 &
FORWARD_PID=$!
info "forward ${PORT}→${PORT} 已启动(pid ${FORWARD_PID})，日志 → ${FORWARD_LOG}"

# --- 轮询 /status(最多 ~30s) -----------------------------------------------
echo -n "  等待 WDA 就绪 "
READY=0
for _ in $(seq 1 30); do
  if curl -s -m 2 "http://localhost:${PORT}/status" 2>/dev/null | grep -qE '"ready"[[:space:]]*:[[:space:]]*true|sessionId|state'; then
    READY=1; break
  fi
  # runwda 提前挂掉就别白等
  if ! kill -0 "$RUNWDA_PID" 2>/dev/null; then
    echo
    die "runwda 进程已退出，看日志：${RUNWDA_LOG}(常见：证书过期 / bundle id 不对 / 未信任 / iOS17+ 缺隧道)"
  fi
  echo -n "."
  sleep 1
done
echo

if [[ "$READY" -eq 1 ]]; then
  info "${BOLD}WebDriverAgent 就绪${RESET} → http://localhost:${PORT}/status"
  echo "${GRAY}  停止：kill ${RUNWDA_PID} ${FORWARD_PID}${RESET}"
  echo "${YELLOW}  提醒：免费开发者证书 7 天过期${RESET}；过期后 WDA 会启动失败，需重新 build-for-testing + ios install(见 docs/IOS.md)。"
else
  die "30s 内 :${PORT}/status 仍无响应。检查 ${RUNWDA_LOG} 与 ${FORWARD_LOG};iOS17+ 记得 sudo ios tunnel start。"
fi
