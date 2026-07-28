#!/usr/bin/env bash
# ios-wda-up.sh — 安全地拉起 iOS 真机 UI 自动化所需的 WebDriverAgent。
#
# 流程：
#   1. 选择并验证唯一目标设备；
#   2. 可靠识别设备上已安装的 WDA runner；
#   3. 启动本脚本持有的 runwda / forward，并严格验证 ready === true；
#   4. 将 PID 状态写入当前用户的私有运行目录，供幂等重跑验证。
#
# 用法：
#   bash scripts/ios-wda-up.sh
#   bash scripts/ios-wda-up.sh --stop
#   UDID=00008030-xxxx bash scripts/ios-wda-up.sh
#   WDA_BUNDLE_ID=com.example.wda.runner.xctrunner bash scripts/ios-wda-up.sh
#
# 环境变量：
#   UDID                目标设备 UDID（不设则自动选唯一一台）
#   WDA_BUNDLE_ID       WDA bundle id（不设则从已安装 app 中可靠探测）
#   WDA_TESTRUNNER_ID   testrunner bundle id（不设则同 WDA_BUNDLE_ID）
#   WDA_XCTESTCONFIG    xctest 配置名（默认 WebDriverAgentRunner.xctest）
#   WDA_PORT            本机端口（当前仅支持 8100）
#   WDA_LOG_DIR         私有单次日志目录的父目录（默认 $TMPDIR 或 /tmp）

set -euo pipefail

# WDA/XCTest 日志可能包含设备和应用信息。目录、状态与日志文件默认均只允许
# 当前用户访问；不要依赖调用者恰好设置了安全 umask。
umask 077

PORT="${WDA_PORT:-8100}"
DEVICE_WDA_PORT=8100

RED=$'\033[31m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; GRAY=$'\033[90m'; BOLD=$'\033[1m'; RESET=$'\033[0m'
info()  { echo "${GREEN}✓${RESET} $*"; }
warn()  { echo "${YELLOW}!${RESET} $*"; }
die()   { echo "${RED}✗${RESET} $*" >&2; exit 1; }

usage() {
  cat <<'EOF'
Usage:
  bash scripts/ios-wda-up.sh          启动或复用本脚本托管的 WDA
  bash scripts/ios-wda-up.sh --stop   按私有状态中的进程身份安全停止 WDA

可通过 UDID=<device-udid> 限定目标；--stop 不要求设备仍连接。
EOF
}

ACTION="start"
case "${1:-}" in
  "") ;;
  --stop) ACTION="stop"; shift ;;
  --help|-h) usage; exit 0 ;;
  *) die "未知参数：${1}。仅支持 --stop / --help。" ;;
esac
[[ "$#" -eq 0 ]] || die "不接受多余参数。"

[[ "$PORT" =~ ^[0-9]+$ ]] || die "WDA_PORT 必须是整数。"
[[ "$PORT" == "8100" ]] || die "mobile-mcp 固定连接 localhost:8100，WDA_PORT 目前只能设为 8100。"

# --- 依赖 ------------------------------------------------------------------
command -v node >/dev/null 2>&1 || die "Node.js 未安装，无法解析 JSON 和校验私有状态目录。"
command -v lsof >/dev/null 2>&1 || die "lsof 未安装，无法确认 8100 监听进程。"
command -v ps >/dev/null 2>&1 || die "ps 未安装，无法验证已托管进程身份。"
if [[ "$ACTION" == "start" ]]; then
  command -v ios >/dev/null 2>&1 || die "go-ios（\`ios\`）未安装 → npm i -g go-ios（见 docs/IOS.md）"
  command -v idevice_id >/dev/null 2>&1 || die "idevice_id 未安装 → brew install libimobiledevice"
  command -v curl >/dev/null 2>&1 || die "curl 未安装，无法检查 WDA /status。"
  command -v mktemp >/dev/null 2>&1 || die "mktemp 未安装，无法安全创建私有日志。"
fi

CURRENT_UID="$(id -u)"

# Apple 真机 UDID 是十六进制串，现代设备通常含一个连字符。严格限制字符集，
# 避免把命令诊断文本带入文件名、进程匹配或 go-ios 参数。
is_valid_udid() {
  [[ "$1" =~ ^[[:xdigit:]]{8,64}(-[[:xdigit:]]{4,64})*$ ]]
}

is_valid_bundle_id() {
  [[ "$1" =~ ^[A-Za-z0-9][A-Za-z0-9.-]*\.xctrunner$ ]]
}

array_contains() {
  local needle="$1"
  shift
  local existing
  for existing in "$@"; do
    [[ "$existing" == "$needle" ]] && return 0
  done
  return 1
}

# --- 选择设备：stdout 是数据，stderr 保持为诊断，绝不能混入 UDID 列表 -------
UDID="${UDID:-}"
if [[ "$ACTION" == "start" ]]; then
  _device_output=""
  if ! _device_output="$(idevice_id -l)"; then
    die "idevice_id -l 执行失败；请检查设备是否已解锁、配对并信任此 Mac。"
  fi

  _udids=()
  while IFS= read -r _line; do
    _line="${_line//$'\r'/}"
    [[ -n "$_line" ]] || continue
    is_valid_udid "$_line" || die "idevice_id -l 返回了非法 UDID（为避免终端控制字符注入，不回显原内容）。"
    if [[ "${#_udids[@]}" -eq 0 ]] || ! array_contains "$_line" "${_udids[@]}"; then
      _udids+=("$_line")
    fi
  done <<<"$_device_output"

  if [[ -z "$UDID" ]]; then
    if [[ "${#_udids[@]}" -eq 0 ]]; then
      die "没有检测到已连接的真机。插上并信任设备后重试。"
    elif [[ "${#_udids[@]}" -gt 1 ]]; then
      die "检测到多台设备：${_udids[*]}。请用 UDID=<其中一个> 显式指定。"
    fi
    UDID="${_udids[0]}"
  else
    is_valid_udid "$UDID" || die "UDID 格式非法；只接受真实 Apple 设备的十六进制 UDID。"
    _udid_found=0
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
elif [[ -n "$UDID" ]]; then
  is_valid_udid "$UDID" || die "UDID 格式非法；只接受真实 Apple 设备的十六进制 UDID。"
fi

# --- 私有运行状态与锁 ------------------------------------------------------
validate_private_directory() {
  local dir="$1"
  local expected_mode="$2"
  node -e '
    const fs = require("node:fs");
    const [dir, expectedModeText] = process.argv.slice(1);
    try {
      const st = fs.lstatSync(dir);
      const expectedMode = Number.parseInt(expectedModeText, 8);
      if (st.isSymbolicLink() || !st.isDirectory()) throw new Error("not a real directory");
      if (typeof process.getuid === "function" && st.uid !== process.getuid())
        throw new Error("owner mismatch");
      if ((st.mode & 0o777) !== expectedMode)
        throw new Error(`permissions must be exactly 0${expectedMode.toString(8)}`);
    } catch (error) {
      process.stderr.write(error.message);
      process.exit(1);
    }
  ' "$dir" "$expected_mode"
}

validate_safe_parent_directory() {
  local dir="$1"
  node -e '
    const fs = require("node:fs");
    const dir = process.argv[1];
    try {
      const st = fs.lstatSync(dir);
      if (st.isSymbolicLink() || !st.isDirectory()) throw new Error("not a real directory");
      const sticky = (st.mode & 0o1000) !== 0;
      const writableByOthers = (st.mode & 0o022) !== 0;
      if (writableByOthers && !sticky)
        throw new Error("group/world-writable directory must have the sticky bit");
    } catch (error) {
      process.stderr.write(error.message);
      process.exit(1);
    }
  ' "$dir"
}

RUNTIME_ROOT="${TMPDIR:-/tmp}"
[[ -d "$RUNTIME_ROOT" ]] || die "临时目录不可用：${RUNTIME_ROOT}"
RUNTIME_ROOT="$(cd "$RUNTIME_ROOT" && pwd -P)" || die "无法解析临时目录：${RUNTIME_ROOT}"
_runtime_validation="$(validate_safe_parent_directory "$RUNTIME_ROOT" 2>&1)" \
  || die "临时目录不安全（${RUNTIME_ROOT}）：${_runtime_validation}"
STATE_DIR="${RUNTIME_ROOT%/}/app-test-ctrl-wda-state-${CURRENT_UID}"
mkdir "$STATE_DIR" 2>/dev/null || true

_state_validation="$(validate_private_directory "$STATE_DIR" 700 2>&1)" \
  || die "WDA 私有状态目录不安全（${STATE_DIR}）：${_state_validation}"

LOCK_DIR="${STATE_DIR}/port-${PORT}.lock"
STATE_FILE="${STATE_DIR}/port-${PORT}.state"
LOCK_HELD=0
RUNWDA_PID=""
FORWARD_PID=""
RUNWDA_IDENTITY=""
FORWARD_IDENTITY=""
KEEP_RUNNING=0
STATE_LOADED=0
STATE_UDID=""
STATE_RUNWDA_PID=""
STATE_FORWARD_PID=""
STATE_RUNWDA_IDENTITY=""
STATE_FORWARD_IDENTITY=""

release_lock() {
  if [[ "$LOCK_HELD" -eq 1 ]]; then
    rmdir "$LOCK_DIR" 2>/dev/null || warn "无法释放启动锁：${LOCK_DIR}"
    LOCK_HELD=0
  fi
}

stop_pid() {
  local pid="$1"
  local role="$2"
  local target_udid="$3"
  local expected_identity="$4"
  local actual_identity descendants descendant identity member_role
  local tracked_pids=()
  local tracked_identities=()
  local any_alive i
  [[ "$pid" =~ ^[0-9]+$ ]] || return 0
  kill -0 "$pid" 2>/dev/null || return 0

  actual_identity="$(process_identity "$pid" "$role" "$target_udid")" || return 1
  [[ "$actual_identity" == "$expected_identity" ]] || return 1

  # npm 的 `ios` 入口可能是等待 Go 子进程的 Node wrapper。先快照这个由本脚本
  # 启动的进程树，并为每个成员锁存 UID/executable/lstart/argv 身份。每次发信号前
  # 都重新比对，避免等待期间 PID 被复用后误杀无关进程。
  descendants="$(list_descendants "$pid")"
  tracked_pids+=("$pid")
  tracked_identities+=("$actual_identity")
  for descendant in $descendants; do
    [[ "$descendant" =~ ^[0-9]+$ ]] || continue
    identity="$(process_identity "$descendant" "${role}-descendant" "$target_udid")" || continue
    tracked_pids+=("$descendant")
    tracked_identities+=("$identity")
  done

  for ((i = 0; i < ${#tracked_pids[@]}; i++)); do
    member_role="${role}-descendant"
    [[ "$i" -ne 0 ]] || member_role="$role"
    actual_identity="$(process_identity "${tracked_pids[$i]}" \
      "$member_role" "$target_udid")" || continue
    [[ "$actual_identity" == "${tracked_identities[$i]}" ]] || continue
    kill "${tracked_pids[$i]}" 2>/dev/null || true
  done

  local _
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    any_alive=0
    for ((i = 0; i < ${#tracked_pids[@]}; i++)); do
      member_role="${role}-descendant"
      [[ "$i" -ne 0 ]] || member_role="$role"
      actual_identity="$(process_identity "${tracked_pids[$i]}" \
        "$member_role" "$target_udid")" || continue
      [[ "$actual_identity" == "${tracked_identities[$i]}" ]] && any_alive=1
    done
    if [[ "$any_alive" -eq 0 ]]; then
      return 0
    fi
    sleep 0.1
  done

  for ((i = 0; i < ${#tracked_pids[@]}; i++)); do
    member_role="${role}-descendant"
    [[ "$i" -ne 0 ]] || member_role="$role"
    actual_identity="$(process_identity "${tracked_pids[$i]}" \
      "$member_role" "$target_udid")" || continue
    [[ "$actual_identity" == "${tracked_identities[$i]}" ]] || continue
    kill -KILL "${tracked_pids[$i]}" 2>/dev/null || true
  done

  # SIGKILL 发出后只对仍保持同一身份的进程报失败；已退出或 PID 已复用都不再碰。
  sleep 0.1
  for ((i = 0; i < ${#tracked_pids[@]}; i++)); do
    member_role="${role}-descendant"
    [[ "$i" -ne 0 ]] || member_role="$role"
    actual_identity="$(process_identity "${tracked_pids[$i]}" \
      "$member_role" "$target_udid")" || continue
    [[ "$actual_identity" != "${tracked_identities[$i]}" ]] || return 1
  done
  return 0
}

cleanup_started_processes() {
  local cleaned=0
  # 这里只处理本次 `$!` 直接返回的 PID，不扫描或 pkill 其他进程。
  if [[ -n "${FORWARD_PID:-}" && -n "${FORWARD_IDENTITY:-}" ]] \
    && kill -0 "$FORWARD_PID" 2>/dev/null; then
    cleaned=1
    stop_pid "$FORWARD_PID" forward "$UDID" "$FORWARD_IDENTITY" \
      || warn "forward 身份已变化或无法完全停止；未对未知 PID 发信号。"
  fi
  if [[ -n "${RUNWDA_PID:-}" && -n "${RUNWDA_IDENTITY:-}" ]] \
    && kill -0 "$RUNWDA_PID" 2>/dev/null; then
    cleaned=1
    stop_pid "$RUNWDA_PID" runwda "$UDID" "$RUNWDA_IDENTITY" \
      || warn "runwda 身份已变化或无法完全停止；未对未知 PID 发信号。"
  fi
  [[ "$cleaned" -eq 0 ]] || warn "启动未完成，已清理本次创建的 runwda/forward 进程。"
}

on_exit() {
  local status=$?
  trap - EXIT INT TERM
  if [[ "$KEEP_RUNNING" -ne 1 ]]; then
    cleanup_started_processes
  fi
  release_lock
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

if mkdir "$LOCK_DIR" 2>/dev/null; then
  LOCK_HELD=1
  _lock_validation="$(validate_private_directory "$LOCK_DIR" 700 2>&1)" \
    || die "WDA 启动锁目录不安全（${LOCK_DIR}）：${_lock_validation}"
else
  die "已有另一个 WDA 启动流程占用端口 ${PORT} 的锁：${LOCK_DIR}。请等待其完成；若进程曾被 SIGKILL，再人工确认后移除空锁目录。"
fi

validate_private_regular_file() {
  local file="$1"
  local expected_mode="$2"
  local max_bytes="$3"
  node -e '
    const fs = require("node:fs");
    const [file, expectedModeText, maxBytesText] = process.argv.slice(1);
    try {
      const st = fs.lstatSync(file);
      const expectedMode = Number.parseInt(expectedModeText, 8);
      const maxBytes = Number(maxBytesText);
      if (st.isSymbolicLink() || !st.isFile()) throw new Error("not a real regular file");
      if (st.nlink !== 1) throw new Error("hard links are not allowed");
      if (typeof process.getuid === "function" && st.uid !== process.getuid())
        throw new Error("owner mismatch");
      if ((st.mode & 0o777) !== expectedMode)
        throw new Error(`permissions must be exactly 0${expectedMode.toString(8)}`);
      if (!Number.isSafeInteger(maxBytes) || st.size > maxBytes)
        throw new Error("file is unexpectedly large");
    } catch (error) {
      process.stderr.write(error.message);
      process.exit(1);
    }
  ' "$file" "$expected_mode" "$max_bytes"
}

load_managed_state() {
  [[ -e "$STATE_FILE" || -L "$STATE_FILE" ]] || return 0
  local validation=""
  validation="$(validate_private_regular_file "$STATE_FILE" 600 2048 2>&1)" \
    || die "托管状态文件不安全（${STATE_FILE}）：${validation}"
  local extra=""
  {
    IFS= read -r STATE_UDID || true
    IFS= read -r STATE_RUNWDA_PID || true
    IFS= read -r STATE_FORWARD_PID || true
    IFS= read -r STATE_RUNWDA_IDENTITY || true
    IFS= read -r STATE_FORWARD_IDENTITY || true
    IFS= read -r extra || true
  } <"$STATE_FILE"
  is_valid_udid "$STATE_UDID" || die "托管状态中的 UDID 非法：${STATE_FILE}"
  [[ "$STATE_RUNWDA_PID" =~ ^[0-9]+$ ]] || die "托管状态中的 runwda PID 非法：${STATE_FILE}"
  [[ "$STATE_FORWARD_PID" =~ ^[0-9]+$ ]] || die "托管状态中的 forward PID 非法：${STATE_FILE}"
  [[ "$STATE_RUNWDA_IDENTITY" =~ ^[0-9a-f]{64}$ ]] || die "托管状态中的 runwda 身份非法：${STATE_FILE}"
  [[ "$STATE_FORWARD_IDENTITY" =~ ^[0-9a-f]{64}$ ]] || die "托管状态中的 forward 身份非法：${STATE_FILE}"
  [[ -z "$extra" ]] || die "托管状态文件包含多余内容：${STATE_FILE}"
  STATE_LOADED=1
}

remove_managed_state() {
  if [[ -e "$STATE_FILE" || -L "$STATE_FILE" ]]; then
    local validation=""
    validation="$(validate_private_regular_file "$STATE_FILE" 600 2048 2>&1)" \
      || die "拒绝删除不安全的托管状态文件（${STATE_FILE}）：${validation}"
    rm -f "$STATE_FILE"
  fi
  STATE_LOADED=0
}

write_managed_state() {
  local tmp actual_identity validation
  actual_identity="$(process_identity "$RUNWDA_PID" runwda "$UDID")" || die "无法记录 runwda 进程身份。"
  [[ "$actual_identity" == "$RUNWDA_IDENTITY" ]] || die "runwda 进程身份在启动期间发生变化。"
  actual_identity="$(process_identity "$FORWARD_PID" forward "$UDID")" || die "无法记录 forward 进程身份。"
  [[ "$actual_identity" == "$FORWARD_IDENTITY" ]] || die "forward 进程身份在启动期间发生变化。"
  tmp="$(mktemp "${STATE_DIR}/port-${PORT}.state.XXXXXX")" || die "无法创建临时托管状态文件。"
  chmod 600 "$tmp"
  printf '%s\n%s\n%s\n%s\n%s\n' \
    "$UDID" "$RUNWDA_PID" "$FORWARD_PID" "$RUNWDA_IDENTITY" "$FORWARD_IDENTITY" >"$tmp"
  validation="$(validate_private_regular_file "$tmp" 600 2048 2>&1)" \
    || die "新建托管状态文件不安全：${validation}"
  mv -f "$tmp" "$STATE_FILE"
  validation="$(validate_private_regular_file "$STATE_FILE" 600 2048 2>&1)" \
    || die "托管状态文件落盘后校验失败：${validation}"
}

load_managed_state

# --- WDA / 端口 / 托管 PID 身份验证 ---------------------------------------
wda_ready() {
  local body
  if ! body="$(curl -fsS -m 3 "http://127.0.0.1:${PORT}/status" 2>/dev/null)"; then
    return 1
  fi
  node -e '
    const fs = require("node:fs");
    try {
      const value = JSON.parse(fs.readFileSync(0, "utf8"));
      process.exit(value?.value?.ready === true || value?.ready === true ? 0 : 1);
    } catch { process.exit(1); }
  ' <<<"$body"
}

port_listener_pids() {
  lsof -nP -tiTCP:"${PORT}" -sTCP:LISTEN 2>/dev/null || true
}

port_has_listener() {
  [[ -n "$(port_listener_pids)" ]]
}

child_pids() {
  local parent="$1"
  ps -axo pid=,ppid= 2>/dev/null \
    | awk -v wanted="$parent" '$2 == wanted { print $1 }' || true
}

list_descendants() {
  local parent="$1"
  local child
  for child in $(child_pids "$parent"); do
    list_descendants "$child"
    printf '%s\n' "$child"
  done
}

pid_is_same_or_descendant() {
  local candidate="$1"
  local ancestor="$2"
  local parent
  local _
  [[ "$candidate" =~ ^[0-9]+$ && "$ancestor" =~ ^[0-9]+$ ]] || return 1
  for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16; do
    [[ "$candidate" == "$ancestor" ]] && return 0
    parent="$(ps -p "$candidate" -o ppid= 2>/dev/null | tr -d '[:space:]')" || return 1
    [[ "$parent" =~ ^[0-9]+$ && "$parent" -gt 1 ]] || return 1
    candidate="$parent"
  done
  return 1
}

process_identity() {
  local pid="$1"
  local role="$2"
  local target_udid="$3"
  local owner executable resolved started command_line

  [[ "$pid" =~ ^[0-9]+$ ]] || return 1
  kill -0 "$pid" 2>/dev/null || return 1
  owner="$(ps -p "$pid" -o uid= 2>/dev/null | tr -d '[:space:]')" || return 1
  [[ "$owner" == "$CURRENT_UID" ]] || return 1

  executable="$(lsof -a -p "$pid" -d txt -Fn 2>/dev/null | sed -n 's/^n//p')" || return 1
  executable="${executable%%$'\n'*}"
  [[ -n "$executable" ]] || return 1
  resolved="$(node -e '
    const fs = require("node:fs");
    try { process.stdout.write(fs.realpathSync(process.argv[1])); }
    catch { process.exit(1); }
  ' "$executable" 2>/dev/null)" || return 1
  started="$(ps -p "$pid" -o lstart= 2>/dev/null | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')" || return 1
  command_line="$(ps -ww -p "$pid" -o command= 2>/dev/null | sed 's/^[[:space:]]*//')" || return 1
  [[ -n "$started" && -n "$command_line" ]] || return 1

  # 记录首次成功启动时的 UID、真实 executable、启动时刻和完整 argv。直接 Go
  # 二进制与 npm 的 node wrapper 都能得到稳定身份；PID 复用也会因 lstart 改变而失配。
  node -e '
    const crypto = require("node:crypto");
    const value = process.argv.slice(1).join("\0");
    process.stdout.write(crypto.createHash("sha256").update(value).digest("hex"));
  ' "$pid" "$role" "$target_udid" "$owner" "$resolved" "$started" "$command_line"
}

stable_process_identity() {
  local pid="$1"
  local role="$2"
  local target_udid="$3"
  local previous="" current="" _
  # `$!` 可能短暂仍处在 nohup → ios 的 exec 交界。只有两个间隔采样一致后才
  # 锁存，避免把瞬时 nohup 身份写入状态导致后续误判或无法清理。
  for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
    current="$(process_identity "$pid" "$role" "$target_udid")" || return 1
    if [[ -n "$previous" && "$current" == "$previous" ]]; then
      printf '%s' "$current"
      return 0
    fi
    previous="$current"
    sleep 0.05
  done
  return 1
}

pid_matches_managed_role() {
  local pid="$1"
  local role="$2"
  local target_udid="$3"
  local expected_identity="$4"
  local actual_identity
  actual_identity="$(process_identity "$pid" "$role" "$target_udid")" || return 1
  [[ "$actual_identity" == "$expected_identity" ]]
}

managed_forward_owns_port() {
  local listener
  [[ "$STATE_LOADED" -eq 1 ]] || return 1
  pid_matches_managed_role \
    "$STATE_FORWARD_PID" forward "$STATE_UDID" "$STATE_FORWARD_IDENTITY" || return 1
  for listener in $(port_listener_pids); do
    pid_is_same_or_descendant "$listener" "$STATE_FORWARD_PID" && return 0
  done
  return 1
}

managed_target_is_ready() {
  [[ "$STATE_LOADED" -eq 1 && "$STATE_UDID" == "$UDID" ]] || return 1
  managed_forward_owns_port || return 1
  pid_matches_managed_role \
    "$STATE_RUNWDA_PID" runwda "$STATE_UDID" "$STATE_RUNWDA_IDENTITY"
}

current_forward_owns_port() {
  local listener
  [[ -n "$FORWARD_PID" ]] || return 1
  kill -0 "$FORWARD_PID" 2>/dev/null || return 1
  for listener in $(port_listener_pids); do
    pid_is_same_or_descendant "$listener" "$FORWARD_PID" && return 0
  done
  return 1
}

stop_managed_pid() {
  local pid="$1"
  local role="$2"
  local target_udid="$3"
  local expected_identity="$4"
  pid_matches_managed_role "$pid" "$role" "$target_udid" "$expected_identity" || return 0
  stop_pid "$pid" "$role" "$target_udid" "$expected_identity"
}

if [[ "$ACTION" == "stop" ]]; then
  if [[ "$STATE_LOADED" -ne 1 ]]; then
    if port_has_listener; then
      die "没有本脚本的托管状态，但 :${PORT} 仍被占用；为避免误杀，本脚本不会停止未知进程。"
    fi
    info "没有正在运行的本脚本托管 WDA，无需停止。"
    exit 0
  fi

  if [[ -n "$UDID" && "$UDID" != "$STATE_UDID" ]]; then
    die "托管状态属于设备 ${STATE_UDID}，与显式指定的 ${UDID} 不一致；未停止任何进程。"
  fi
  UDID="$STATE_UDID"

  _stop_unsafe=0
  _stop_failed=0
  _stop_forward=0
  _stop_runwda=0
  if kill -0 "$STATE_FORWARD_PID" 2>/dev/null; then
    if pid_matches_managed_role \
      "$STATE_FORWARD_PID" forward "$STATE_UDID" "$STATE_FORWARD_IDENTITY"; then
      _stop_forward=1
    else
      warn "状态中的 forward PID ${STATE_FORWARD_PID} 仍存在但身份不匹配；拒绝发信号。"
      _stop_unsafe=1
    fi
  fi
  if kill -0 "$STATE_RUNWDA_PID" 2>/dev/null; then
    if pid_matches_managed_role \
      "$STATE_RUNWDA_PID" runwda "$STATE_UDID" "$STATE_RUNWDA_IDENTITY"; then
      _stop_runwda=1
    else
      warn "状态中的 runwda PID ${STATE_RUNWDA_PID} 仍存在但身份不匹配；拒绝发信号。"
      _stop_unsafe=1
    fi
  fi

  if [[ "$_stop_unsafe" -eq 1 ]]; then
    die "托管 PID 可能已复用，状态文件已保留供人工核查；未触碰身份不匹配的进程。"
  fi

  # 先完成所有身份预检，再发出任何信号，避免一个 PID 已复用时只停止另一半。
  [[ "$_stop_forward" -eq 0 ]] || stop_pid \
    "$STATE_FORWARD_PID" forward "$STATE_UDID" "$STATE_FORWARD_IDENTITY" \
    || _stop_failed=1
  [[ "$_stop_runwda" -eq 0 ]] || stop_pid \
    "$STATE_RUNWDA_PID" runwda "$STATE_UDID" "$STATE_RUNWDA_IDENTITY" \
    || _stop_failed=1
  [[ "$_stop_failed" -eq 0 ]] || die "已验证的 WDA 进程未能完全停止；状态文件已保留。"

  remove_managed_state
  port_has_listener \
    && die "已停止可验证的托管 launcher，但 :${PORT} 仍有未知监听者；未对它发信号。"
  info "已安全停止设备 ${UDID} 的托管 WebDriverAgent 与端口转发。"
  exit 0
fi

# ready 响应只有同时命中本脚本私有状态、首次启动身份哈希和 launcher 的监听
# 后代时才可复用。它兼容直接 Go 二进制及 npm/node wrapper；单靠 /status 或
# 可伪造的 pgrep 文本不构成身份。
if wda_ready; then
  if managed_target_is_ready; then
    KEEP_RUNNING=1
    info "目标设备 ${UDID} 的 WebDriverAgent 已在 :${PORT} 就绪，无需重复拉起。"
    exit 0
  fi
  die ":${PORT}/status 返回 ready=true，但没有可验证的本脚本托管状态。为避免控制错设备，请先停止占用者。"
fi

if port_has_listener && ! managed_forward_owns_port; then
  die "本机 :${PORT} 已被未知进程或另一台设备占用；本脚本不会扫描或终止它。"
fi

if [[ "$STATE_LOADED" -eq 1 ]]; then
  _managed_forward_alive=0
  _managed_runwda_alive=0
  pid_matches_managed_role \
    "$STATE_FORWARD_PID" forward "$STATE_UDID" "$STATE_FORWARD_IDENTITY" && _managed_forward_alive=1
  pid_matches_managed_role \
    "$STATE_RUNWDA_PID" runwda "$STATE_UDID" "$STATE_RUNWDA_IDENTITY" && _managed_runwda_alive=1

  if [[ "$STATE_UDID" != "$UDID" && ( "$_managed_forward_alive" -eq 1 || "$_managed_runwda_alive" -eq 1 ) ]]; then
    die "端口 ${PORT} 的托管进程属于另一台设备 ${STATE_UDID}；请显式停止它后再切换设备。"
  fi

  if [[ "$STATE_UDID" == "$UDID" ]]; then
    if [[ "$_managed_forward_alive" -eq 1 || "$_managed_runwda_alive" -eq 1 ]]; then
      warn "发现目标设备由本脚本记录但未就绪的 WDA 进程，正在安全清理后重启。"
    fi
    [[ "$_managed_forward_alive" -eq 0 ]] || stop_managed_pid \
      "$STATE_FORWARD_PID" forward "$STATE_UDID" "$STATE_FORWARD_IDENTITY"
    [[ "$_managed_runwda_alive" -eq 0 ]] || stop_managed_pid \
      "$STATE_RUNWDA_PID" runwda "$STATE_UDID" "$STATE_RUNWDA_IDENTITY"
  fi
  remove_managed_state
fi

port_has_listener && die "清理托管状态后 :${PORT} 仍被占用；请检查 lsof -nP -iTCP:${PORT} -sTCP:LISTEN。"

# --- iOS 17+ 隧道提醒 ------------------------------------------------------
if command -v ideviceinfo >/dev/null 2>&1; then
  OSVER="$(ideviceinfo -u "$UDID" -k ProductVersion 2>/dev/null | tr -d '\r' || true)"
  if [[ -n "$OSVER" ]]; then
    [[ "$OSVER" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){0,3}$ ]] \
      || die "ideviceinfo 返回了非法 ProductVersion（原内容不回显）。"
    MAJOR="${OSVER%%.*}"
    echo "${GRAY}  iOS 版本：${OSVER}${RESET}"
    if [[ "${MAJOR:-0}" =~ ^[0-9]+$ ]] && [[ "$MAJOR" -ge 17 ]]; then
      warn "iOS ${OSVER} 需要隧道：另开终端运行 ${BOLD}sudo ios tunnel start${RESET}（长驻）。"
    fi
  fi
fi

# --- 可靠识别 WDA runner ---------------------------------------------------
_all_runners=()
_reliable_runners=()
if command -v ideviceinstaller >/dev/null 2>&1; then
  _installed=""
  if ! _installed="$(ideviceinstaller -u "$UDID" list)"; then
    die "无法读取设备 ${UDID} 的已安装 app 列表；请检查设备是否已解锁、配对并信任。"
  fi
  while IFS=$'\t' read -r _kind _bundle_id; do
    [[ -n "${_bundle_id:-}" ]] || continue
    is_valid_bundle_id "$_bundle_id" || continue
    if [[ "${#_all_runners[@]}" -eq 0 ]] || ! array_contains "$_bundle_id" "${_all_runners[@]}"; then
      _all_runners+=("$_bundle_id")
    fi
    if [[ "$_kind" == "reliable" ]]; then
      if [[ "${#_reliable_runners[@]}" -eq 0 ]] || ! array_contains "$_bundle_id" "${_reliable_runners[@]}"; then
        _reliable_runners+=("$_bundle_id")
      fi
    fi
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
    is_valid_bundle_id "$WDA_BUNDLE_ID" || die "WDA_BUNDLE_ID 必须是合法且以 .xctrunner 结尾的 bundle id。"
    _explicit_found=0
    if [[ "${#_all_runners[@]}" -gt 0 ]]; then
      for _bundle_id in "${_all_runners[@]}"; do
        [[ "$_bundle_id" != "$WDA_BUNDLE_ID" ]] || _explicit_found=1
      done
    fi
    [[ "$_explicit_found" -eq 1 ]] || die "设备已安装列表中找不到指定 WDA：${WDA_BUNDLE_ID}。"
  elif [[ "${#_reliable_runners[@]}" -eq 1 ]]; then
    WDA_BUNDLE_ID="${_reliable_runners[0]}"
    info "自动探测到 WDA：${WDA_BUNDLE_ID}"
  elif [[ "${#_reliable_runners[@]}" -gt 1 ]]; then
    die "检测到多个可靠 WDA runner：${_reliable_runners[*]}。请显式设置 WDA_BUNDLE_ID。"
  elif [[ "${#_all_runners[@]}" -gt 0 ]]; then
    die "检测到 *.xctrunner，但没有任何候选具备可靠 WDA 身份：${_all_runners[*]}。请核实后显式设置 WDA_BUNDLE_ID。"
  else
    die "设备上没有检测到 WebDriverAgent *.xctrunner；请先安装 WDA。"
  fi
else
  [[ -n "${WDA_BUNDLE_ID:-}" ]] || die "ideviceinstaller 未安装，无法可靠探测 WDA；请安装它或显式设置 WDA_BUNDLE_ID。"
  is_valid_bundle_id "$WDA_BUNDLE_ID" || die "WDA_BUNDLE_ID 必须是合法且以 .xctrunner 结尾的 bundle id。"
  warn "ideviceinstaller 未安装；将使用用户显式确认的 WDA_BUNDLE_ID：${WDA_BUNDLE_ID}。"
fi

WDA_TESTRUNNER_ID="${WDA_TESTRUNNER_ID:-$WDA_BUNDLE_ID}"
is_valid_bundle_id "$WDA_TESTRUNNER_ID" || die "WDA_TESTRUNNER_ID 必须是合法且以 .xctrunner 结尾的 bundle id。"
WDA_XCTESTCONFIG="${WDA_XCTESTCONFIG:-WebDriverAgentRunner.xctest}"
[[ "$WDA_XCTESTCONFIG" =~ ^[A-Za-z0-9._-]+\.xctest$ ]] || die "WDA_XCTESTCONFIG 格式非法。"

RUNWDA_ARGS=(runwda --udid="$UDID")
RUNWDA_ARGS+=(--bundleid="$WDA_BUNDLE_ID")
RUNWDA_ARGS+=(--testrunnerbundleid="$WDA_TESTRUNNER_ID")
RUNWDA_ARGS+=(--xctestconfig="$WDA_XCTESTCONFIG")

# --- 私有、唯一且不可复用的日志文件 ---------------------------------------
LOG_BASE="${WDA_LOG_DIR:-${TMPDIR:-/tmp}}"
if [[ -n "${WDA_LOG_DIR:-}" && -L "$LOG_BASE" ]]; then
  die "WDA_LOG_DIR 不能是符号链接：${LOG_BASE}"
fi
mkdir -p "$LOG_BASE" || die "无法创建日志父目录：${LOG_BASE}"
[[ -d "$LOG_BASE" ]] || die "日志父路径不是目录：${LOG_BASE}"
LOG_BASE="$(cd "$LOG_BASE" && pwd -P)" || die "无法解析日志父目录：${LOG_BASE}"
_log_base_validation="$(validate_safe_parent_directory "$LOG_BASE" 2>&1)" \
  || die "日志父目录不安全（${LOG_BASE}）：${_log_base_validation}"
LOG_DIR="$(mktemp -d "${LOG_BASE%/}/app-test-ctrl-wda.XXXXXX")" || die "无法创建私有 WDA 日志目录。"
chmod 700 "$LOG_DIR"
_log_dir_validation="$(validate_private_directory "$LOG_DIR" 700 2>&1)" \
  || die "创建出的 WDA 日志目录不安全（${LOG_DIR}）：${_log_dir_validation}"

RUNWDA_LOG="$(mktemp "${LOG_DIR}/runwda-${UDID}.XXXXXX")" || die "无法安全创建 runwda 日志。"
FORWARD_LOG="$(mktemp "${LOG_DIR}/forward-${UDID}.XXXXXX")" || die "无法安全创建 forward 日志。"
chmod 600 "$RUNWDA_LOG" "$FORWARD_LOG"
_runwda_log_validation="$(validate_private_regular_file "$RUNWDA_LOG" 600 0 2>&1)" \
  || die "runwda 日志文件不安全（${RUNWDA_LOG}）：${_runwda_log_validation}"
_forward_log_validation="$(validate_private_regular_file "$FORWARD_LOG" 600 0 2>&1)" \
  || die "forward 日志文件不安全（${FORWARD_LOG}）：${_forward_log_validation}"

# --- 启动与严格轮询 --------------------------------------------------------
echo "${GRAY}  ios ${RUNWDA_ARGS[*]}${RESET}"
nohup ios "${RUNWDA_ARGS[@]}" >>"$RUNWDA_LOG" 2>&1 &
RUNWDA_PID=$!
if ! RUNWDA_IDENTITY="$(stable_process_identity "$RUNWDA_PID" runwda "$UDID")"; then
  RUNWDA_IDENTITY="$(process_identity "$RUNWDA_PID" runwda "$UDID" 2>/dev/null || true)"
  die "runwda 启动后无法锁存稳定进程身份；已中止并尝试清理。"
fi
info "runwda 已启动（pid ${RUNWDA_PID}），日志 → ${RUNWDA_LOG}"

nohup ios forward "$PORT" "$DEVICE_WDA_PORT" --udid="$UDID" >>"$FORWARD_LOG" 2>&1 &
FORWARD_PID=$!
if ! FORWARD_IDENTITY="$(stable_process_identity "$FORWARD_PID" forward "$UDID")"; then
  FORWARD_IDENTITY="$(process_identity "$FORWARD_PID" forward "$UDID" 2>/dev/null || true)"
  die "forward 启动后无法锁存稳定进程身份；已中止并尝试清理。"
fi
info "forward 本机 ${PORT} → 设备 ${DEVICE_WDA_PORT} 已启动（pid ${FORWARD_PID}），日志 → ${FORWARD_LOG}"

echo -n "  等待 WDA 就绪 "
READY=0
WDA_DEADLINE=$((SECONDS + 30))
while [[ "$SECONDS" -lt "$WDA_DEADLINE" ]]; do
  if ! kill -0 "$RUNWDA_PID" 2>/dev/null; then
    echo
    die "runwda 进程已退出。检查 ${RUNWDA_LOG}。"
  fi
  if ! kill -0 "$FORWARD_PID" 2>/dev/null; then
    echo
    die "forward 进程已退出。检查 ${FORWARD_LOG}。"
  fi
  if current_forward_owns_port && wda_ready; then
    READY=1
    break
  fi
  echo -n "."
  [[ "$SECONDS" -ge "$WDA_DEADLINE" ]] || sleep 1
done
echo

[[ "$READY" -eq 1 ]] || die "30 秒内 :${PORT}/status 未返回合法 JSON ready=true。检查 ${RUNWDA_LOG} 与 ${FORWARD_LOG}。"
kill -0 "$RUNWDA_PID" 2>/dev/null || die "WDA 就绪后 runwda 意外退出，请检查 ${RUNWDA_LOG}。"
kill -0 "$FORWARD_PID" 2>/dev/null || die "WDA 就绪后 forward 意外退出，请检查 ${FORWARD_LOG}。"

write_managed_state
KEEP_RUNNING=1
info "${BOLD}WebDriverAgent 就绪${RESET} → http://127.0.0.1:${PORT}/status（目标设备 ${UDID}）"
echo "${GRAY}  日志目录：${LOG_DIR}${RESET}"
echo "${GRAY}  停止：bash scripts/ios-wda-up.sh --stop${RESET}"
echo "${YELLOW}  提醒：免费开发者证书 7 天过期${RESET}；过期后需重新 build-for-testing + ios install。"
