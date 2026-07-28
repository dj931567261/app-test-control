#!/usr/bin/env bash
# ios-wda-up.sh — 一键拉起 iOS 真机 UI 自动化所需的 WebDriverAgent。
#
# 干三件事：
#   1. ios runwda   —— 在指定设备上启动 WDA（长驻）
#   2. ios forward  —— 把本机 8100 转发到该设备的 8100（长驻）
#   3. 轮询 /status —— 严格确认 JSON 中 ready === true
#
# 前置条件（详见 docs/IOS.md 第二节）：
#   - libimobiledevice + ideviceinstaller + go-ios 已安装，真机已连接并信任
#   - WDA 已 build-for-testing 并 `ios install` 到设备
#
# 用法：
#   bash scripts/ios-wda-up.sh                 # 自动选唯一连接的设备
#   UDID=00008030-xxxx bash scripts/ios-wda-up.sh
#   WDA_BUNDLE_ID=com.你的前缀.wda.runner.xctrunner bash scripts/ios-wda-up.sh
#
# 环境变量：
#   UDID                目标设备 UDID（不设则自动选唯一一台）
#   WDA_BUNDLE_ID       WDA 的 bundle id（不设则从已安装 app 中可靠探测）
#   WDA_TESTRUNNER_ID   testrunner bundle id（不设则同 WDA_BUNDLE_ID）
#   WDA_XCTESTCONFIG    xctest 配置名（不设则用标准配置名）
#   WDA_PORT            本机转发端口（默认且仅支持 8100；mobile-mcp 固定使用它）
#   WDA_LOG_DIR         日志目录（默认 /tmp/wda）

set -euo pipefail

PORT="${WDA_PORT:-8100}"
DEVICE_WDA_PORT=8100
LOG_DIR="${WDA_LOG_DIR:-/tmp/wda}"

RED=$'\033[31m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; GRAY=$'\033[90m'; BOLD=$'\033[1m'; RESET=$'\033[0m'
info()  { echo "${GREEN}✓${RESET} $*"; }
warn()  { echo "${YELLOW}!${RESET} $*"; }
die()   { echo "${RED}✗${RESET} $*" >&2; exit 1; }

[[ "$PORT" =~ ^[0-9]+$ ]] || die "WDA_PORT 必须是整数。"
if [[ "$PORT" != "8100" ]]; then
  die "本项目的 mobile-mcp 固定连接 localhost:8100，WDA_PORT 目前只能设为 8100。"
fi

mkdir -p "$LOG_DIR"

# --- 依赖检查 ---------------------------------------------------------------
command -v ios >/dev/null 2>&1 || die "go-ios（\`ios\`）未安装 → npm i -g go-ios（见 docs/IOS.md）"
command -v idevice_id >/dev/null 2>&1 || die "idevice_id 未安装 → brew install libimobiledevice"
command -v curl >/dev/null 2>&1 || die "curl 未安装，无法检查 WDA /status。"
command -v node >/dev/null 2>&1 || die "Node.js 未安装，无法严格解析 WDA /status JSON。"
command -v lsof >/dev/null 2>&1 || die "lsof 未安装，无法确认 8100 端口属于目标设备的转发进程。"

# --- 先选设备并验证显式 UDID ------------------------------------------------
_device_output=""
if ! _device_output="$(idevice_id -l 2>&1)"; then
  die "idevice_id -l 执行失败：${_device_output}"
fi

_udids=()
while IFS= read -r _line; do
  _line="${_line//$'\r'/}"
  [[ -n "$_line" ]] && _udids+=("$_line")
done <<<"$_device_output"

if [[ -z "${UDID:-}" ]]; then
  if [[ "${#_udids[@]}" -eq 0 ]]; then
    die "没有检测到已连接的真机。插上并信任设备后重试（idevice_id -l 应打印 UDID）。"
  elif [[ "${#_udids[@]}" -gt 1 ]]; then
    die "检测到多台设备：${_udids[*]}。请用 UDID=<其中一个> 显式指定。"
  fi
  UDID="${_udids[0]}"
else
  _udid_found=0
  # macOS still ships Bash 3.2: with `set -u`, expanding an empty array via
  # "${array[@]}" raises "unbound variable". Guard the loop so the intended
  # actionable error below is preserved when no device is connected.
  if [[ "${#_udids[@]}" -gt 0 ]]; then
    for _candidate_udid in "${_udids[@]}"; do
      if [[ "$_candidate_udid" == "$UDID" ]]; then
        _udid_found=1
        break
      fi
    done
  fi
  if [[ "$_udid_found" -ne 1 ]]; then
    if [[ "${#_udids[@]}" -eq 0 ]]; then
      die "指定的设备 ${UDID} 未连接；当前没有检测到真机。"
    fi
    die "指定的设备 ${UDID} 未连接；当前设备：${_udids[*]}。"
  fi
fi
info "目标设备：${UDID}"

# /status 必须是合法 JSON，且只接受布尔值 true；不能拿 sessionId/state 代替。
wda_ready() {
  local body
  if ! body="$(curl -fsS -m 3 "http://127.0.0.1:${PORT}/status" 2>/dev/null)"; then
    return 1
  fi
  node -e '
    const fs = require("node:fs");
    try {
      const value = JSON.parse(fs.readFileSync(0, "utf8"));
      const ready = value?.value?.ready === true || value?.ready === true;
      process.exit(ready ? 0 : 1);
    } catch {
      process.exit(1);
    }
  ' <<<"$body"
}

target_forward_pids() {
  pgrep -f "ios forward ${PORT} ${DEVICE_WDA_PORT} --udid=${UDID}" 2>/dev/null || true
}

target_runwda_pids() {
  pgrep -f "ios runwda .*--udid=${UDID}" 2>/dev/null || true
}

port_listener_pids() {
  lsof -nP -tiTCP:"${PORT}" -sTCP:LISTEN 2>/dev/null || true
}

port_has_listener() {
  [[ -n "$(port_listener_pids)" ]]
}

# 只有监听 8100 的 PID 本身也是目标 UDID 的 forward，才证明该端口来源可信。
target_forward_owns_port() {
  local listener target
  local listeners targets
  listeners="$(port_listener_pids)"
  targets="$(target_forward_pids)"
  [[ -n "$listeners" && -n "$targets" ]] || return 1
  for listener in $listeners; do
    for target in $targets; do
      [[ "$listener" == "$target" ]] && return 0
    done
  done
  return 1
}

stop_pid() {
  local pid="$1"
  if ! kill -0 "$pid" 2>/dev/null; then
    return 0
  fi
  kill "$pid" 2>/dev/null || true
  local _
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    kill -0 "$pid" 2>/dev/null || return 0
    sleep 0.1
  done
  kill -KILL "$pid" 2>/dev/null || true
}

stop_target_processes() {
  local pid
  for pid in $(target_forward_pids); do stop_pid "$pid"; done
  for pid in $(target_runwda_pids); do stop_pid "$pid"; done
}

# --- 幂等检查：必须先知道目标 UDID，并证明端口转发属于它 -------------------
if wda_ready; then
  if target_forward_owns_port; then
    info "目标设备 ${UDID} 的 WebDriverAgent 已在 :${PORT} 就绪，无需重复拉起。"
    exit 0
  fi
  die ":${PORT}/status 虽返回 ready=true，但监听端口的不是目标设备 ${UDID} 的 go-ios forward。为避免控制错设备，请先停止占用 8100 的进程。"
fi

if port_has_listener && ! target_forward_owns_port; then
  die "本机 :${PORT} 已被未知进程或另一台设备占用。请先停止该进程，再启动目标设备 ${UDID}。"
fi

# 目标设备可能残留半死不活的 runwda/forward；只清理精确匹配该 UDID 的进程。
if [[ -n "$(target_forward_pids)$(target_runwda_pids)" ]]; then
  warn "发现目标设备的失效 WDA 进程，正在清理后重启。"
  stop_target_processes
fi
if port_has_listener; then
  die "清理后 :${PORT} 仍被占用，请检查：lsof -nP -iTCP:${PORT} -sTCP:LISTEN"
fi

# --- iOS 17+ 隧道提醒（go-ios 对 major>=17 要求 tunnel） -------------------
if command -v ideviceinfo >/dev/null 2>&1; then
  OSVER="$(ideviceinfo -u "$UDID" -k ProductVersion 2>/dev/null | tr -d '\r' || true)"
  if [[ -n "$OSVER" ]]; then
    MAJOR="${OSVER%%.*}"
    echo "${GRAY}  iOS 版本：${OSVER}${RESET}"
    if [[ "${MAJOR:-0}" =~ ^[0-9]+$ ]] && [[ "$MAJOR" -ge 17 ]]; then
      warn "iOS ${OSVER} 需要隧道：另开一个终端跑 ${BOLD}sudo ios tunnel start${RESET}（长驻），否则 runwda 会失败。"
    fi
  fi
fi

# --- 预检 / 自动探测 WDA bundle id ----------------------------------------
# 候选必须以 .xctrunner 结尾。优先采用唯一一个含 WebDriverAgent/WDA Runner
# 特征的候选；可靠候选不唯一时拒绝猜测。没有可靠特征时，也只接受唯一候选。
if command -v ideviceinstaller >/dev/null 2>&1; then
  if ! _installed="$(ideviceinstaller -u "$UDID" list 2>&1)"; then
    die "无法读取设备 ${UDID} 的已安装 app 列表：${_installed:-ideviceinstaller 执行失败}。请检查设备是否已解锁、配对并信任此 Mac。"
  fi
  _all_runners=()
  _reliable_runners=()
  while IFS=$'\t' read -r _kind _bundle_id; do
    [[ -n "${_bundle_id:-}" ]] || continue
    _all_runners+=("$_bundle_id")
    [[ "$_kind" == "reliable" ]] && _reliable_runners+=("$_bundle_id")
  done < <(
    awk -F, '
      {
        id=$1
        gsub(/^[ \t]+|[ \t\r]+$/, "", id)
        if (id !~ /\.xctrunner$/) next
        line=tolower($0)
        if (line ~ /webdriveragent|web[ ._-]*driver[ ._-]*agent|wda[ ._-]*runner/)
          print "reliable\t" id
        else
          print "generic\t" id
      }
    ' <<<"$_installed"
  )

  if [[ -n "${WDA_BUNDLE_ID:-}" ]]; then
    _explicit_found=0
    # Same Bash 3.2 nounset edge case as the UDID loop above. An explicitly
    # supplied bundle id must remain usable even when no runner is discoverable.
    if [[ "${#_all_runners[@]}" -gt 0 ]]; then
      for _bundle_id in "${_all_runners[@]}"; do
        [[ "$_bundle_id" == "$WDA_BUNDLE_ID" ]] && _explicit_found=1
      done
    fi
    if [[ -n "$_installed" && "$_explicit_found" -ne 1 ]]; then
      warn "设备已安装列表中找不到你指定的 WDA（${WDA_BUNDLE_ID}）；若确已安装可继续，否则见 docs/IOS.md 第二节。"
    fi
  elif [[ "${#_reliable_runners[@]}" -eq 1 ]]; then
    WDA_BUNDLE_ID="${_reliable_runners[0]}"
    info "自动探测到 WDA：${WDA_BUNDLE_ID}"
  elif [[ "${#_reliable_runners[@]}" -gt 1 ]]; then
    die "检测到多个可靠 WDA runner：${_reliable_runners[*]}。请显式设置 WDA_BUNDLE_ID。"
  elif [[ "${#_all_runners[@]}" -eq 1 ]]; then
    WDA_BUNDLE_ID="${_all_runners[0]}"
    warn "唯一的 *.xctrunner 缺少明确 WDA 特征，暂采用：${WDA_BUNDLE_ID}。如不正确请显式设置 WDA_BUNDLE_ID。"
  elif [[ "${#_all_runners[@]}" -gt 1 ]]; then
    die "检测到多个无法可靠区分的 *.xctrunner：${_all_runners[*]}。请显式设置 WDA_BUNDLE_ID。"
  else
    warn "设备上似乎未安装 WebDriverAgent（没有找到 *.xctrunner）。"
    echo "${GRAY}    先按 docs/IOS.md 第二节 build-for-testing + \`ios install\`，或显式设置 WDA_BUNDLE_ID。${RESET}"
  fi
else
  if [[ -n "${WDA_BUNDLE_ID:-}" ]]; then
    warn "ideviceinstaller 未安装，无法校验指定的 WDA_BUNDLE_ID（${WDA_BUNDLE_ID}）。"
  else
    warn "ideviceinstaller 未安装，无法自动探测 WDA；请安装它或显式设置 WDA_BUNDLE_ID。"
  fi
fi

# go-ios 要求 bundleid / testrunnerbundleid / xctestconfig 要么全给、要么全不
# 给。只要确定了 WDA_BUNDLE_ID，就补齐三件套。
RUNWDA_ARGS=(runwda --udid="$UDID")
if [[ -n "${WDA_BUNDLE_ID:-}" ]]; then
  RUNWDA_ARGS+=(--bundleid="$WDA_BUNDLE_ID")
  RUNWDA_ARGS+=(--testrunnerbundleid="${WDA_TESTRUNNER_ID:-$WDA_BUNDLE_ID}")
  RUNWDA_ARGS+=(--xctestconfig="${WDA_XCTESTCONFIG:-WebDriverAgentRunner.xctest}")
fi

RUNWDA_LOG="${LOG_DIR}/runwda-${UDID}.log"
FORWARD_LOG="${LOG_DIR}/forward-${UDID}.log"
RUNWDA_PID=""
FORWARD_PID=""
KEEP_RUNNING=0

cleanup_started_processes() {
  local pid
  local cleaned=0
  for pid in "${FORWARD_PID:-}" "${RUNWDA_PID:-}"; do
    [[ -n "$pid" ]] || continue
    if kill -0 "$pid" 2>/dev/null; then
      cleaned=1
      stop_pid "$pid"
    fi
  done
  [[ "$cleaned" -eq 0 ]] || warn "启动未完成，已清理本次创建的 runwda/forward 进程。"
}

on_exit() {
  local status=$?
  trap - EXIT INT TERM
  if [[ "$KEEP_RUNNING" -ne 1 ]]; then
    cleanup_started_processes
  fi
  exit "$status"
}

on_interrupt() {
  local signal="$1"
  warn "收到 ${signal}，正在停止本次启动的 WDA 进程。"
  if [[ "$signal" == "INT" ]]; then exit 130; else exit 143; fi
}

trap on_exit EXIT
trap 'on_interrupt INT' INT
trap 'on_interrupt TERM' TERM

# --- 启动 runwda + 本机 8100 → 设备 8100 转发 -----------------------------
echo "${GRAY}  ios ${RUNWDA_ARGS[*]}${RESET}"
nohup ios "${RUNWDA_ARGS[@]}" >"$RUNWDA_LOG" 2>&1 &
RUNWDA_PID=$!
info "runwda 已启动（pid ${RUNWDA_PID}），日志 → ${RUNWDA_LOG}"

nohup ios forward "$PORT" "$DEVICE_WDA_PORT" --udid="$UDID" >"$FORWARD_LOG" 2>&1 &
FORWARD_PID=$!
info "forward 本机 ${PORT} → 设备 ${DEVICE_WDA_PORT} 已启动（pid ${FORWARD_PID}），日志 → ${FORWARD_LOG}"

# --- 轮询 /status（最多约 30 秒），同时监控两个长驻进程 ---------------------
echo -n "  等待 WDA 就绪 "
READY=0
WDA_DEADLINE=$((SECONDS + 30))
while [[ "$SECONDS" -lt "$WDA_DEADLINE" ]]; do
  if ! kill -0 "$RUNWDA_PID" 2>/dev/null; then
    echo
    die "runwda 进程已退出。检查 ${RUNWDA_LOG}（常见：证书过期、bundle id 不对、未信任、iOS 17+ 缺隧道）。"
  fi
  if ! kill -0 "$FORWARD_PID" 2>/dev/null; then
    echo
    die "forward 进程已退出。检查 ${FORWARD_LOG}（常见：8100 被占用、设备断开或隧道不可用）。"
  fi
  if target_forward_owns_port && wda_ready; then
    READY=1
    break
  fi
  echo -n "."
  [[ "$SECONDS" -ge "$WDA_DEADLINE" ]] || sleep 1
done
echo

if [[ "$READY" -ne 1 ]]; then
  die "30 秒内 :${PORT}/status 未返回合法 JSON ready=true。检查 ${RUNWDA_LOG} 与 ${FORWARD_LOG}；iOS 17+ 记得 sudo ios tunnel start。"
fi

# 就绪瞬间再确认两个进程仍存活，避免把刚退出的启动误报为成功。
kill -0 "$RUNWDA_PID" 2>/dev/null || die "WDA 就绪检查后 runwda 意外退出，请检查 ${RUNWDA_LOG}。"
kill -0 "$FORWARD_PID" 2>/dev/null || die "WDA 就绪检查后 forward 意外退出，请检查 ${FORWARD_LOG}。"

KEEP_RUNNING=1
info "${BOLD}WebDriverAgent 就绪${RESET} → http://localhost:${PORT}/status（目标设备 ${UDID}）"
echo "${GRAY}  停止：kill ${RUNWDA_PID} ${FORWARD_PID}${RESET}"
echo "${YELLOW}  提醒：免费开发者证书 7 天过期${RESET}；过期后需重新 build-for-testing + ios install（见 docs/IOS.md）。"
