#!/usr/bin/env bash

set -euo pipefail

: "${CORE_SSH_TARGET:?请设置 CORE_SSH_TARGET，例如 roonstation@<verified-core-endpoint>}"
expected_input="${EXPECTED_RELEASE_SHA:-${1:-}}"

SSH_ARGS=(
  -o BatchMode=yes
  -o StrictHostKeyChecking=yes
  -o ConnectTimeout=10
  -o ServerAliveInterval=15
  -o ServerAliveCountMax=3
)
if [[ -n "${SSH_CONTROL_PATH:-}" ]]; then
  SSH_ARGS+=( -o ControlMaster=auto -o ControlPath="$SSH_CONTROL_PATH" )
fi

remote_script="$(cat <<'REMOTE'
set -u
base="$HOME/Library/Application Support/MusicBridgeAgent"
current="$base/current"
data_dir="$base/data"
log_file="$base/logs/agent.log"
pid_file="$data_dir/agent.pid"
release_file="$data_dir/agent.release"

valid_sha() {
  printf '%s\n' "$1" | grep -Eq '^[0-9a-f]{40}$'
}

extract_release_sha() {
  printf '%s\n' "$1" | sed -nE 's#.*releases/([0-9a-f]{40})/dist/main\.js.*#\1#p' | head -n 1
}

current_sha=missing
current_target=""
if [ -L "$current" ]; then
  current_target="$(readlink "$current")"
  candidate="$(basename "$current_target")"
  if valid_sha "$candidate"; then
    current_sha="$candidate"
  else
    current_sha=invalid
  fi
fi

agent_release_sha=missing
agent_release_mode=missing
if [ -e "$release_file" ] || [ -L "$release_file" ]; then
  if [ -L "$release_file" ] || [ ! -f "$release_file" ]; then
    agent_release_sha=invalid
    agent_release_mode=invalid
  else
    candidate="$(tr -d "[:space:]" < "$release_file")"
    if valid_sha "$candidate"; then
      agent_release_sha="$candidate"
    else
      agent_release_sha=invalid
    fi
    agent_release_mode="$(stat -f "%Lp" "$release_file" 2>/dev/null || printf '%s' invalid)"
  fi
fi

agent_state=stopped
running_sha=missing
if [ -e "$pid_file" ] || [ -L "$pid_file" ]; then
  if [ -L "$pid_file" ] || [ ! -f "$pid_file" ]; then
    agent_state=unknown
  else
    pid="$(tr -d "[:space:]" < "$pid_file")"
    if [ -n "$pid" ] && printf '%s\n' "$pid" | grep -Eq '^[0-9]+$' && kill -0 "$pid" 2>/dev/null; then
      command_line="$(ps -p "$pid" -o command= 2>/dev/null || true)"
      running_sha="$(extract_release_sha "$command_line")"
      case "$command_line" in
        *dist/main.js*) agent_state=running ;;
        *) agent_state=unknown ;;
      esac
    else
      agent_state=stale
    fi
  fi
fi

printf "%s\n" "CURRENT_RELEASE_SHA=$current_sha"
printf "%s\n" "RUNNING_RELEASE_SHA=$running_sha"
printf "%s\n" "AGENT_RELEASE_SHA=$agent_release_sha"

expected_sha="__EXPECTED__"
if [ -z "$expected_sha" ]; then
  expected_sha="$current_sha"
fi
printf "%s\n" "EXPECTED_RELEASE_SHA=$expected_sha"
printf "%s\n" "AGENT_PID_STATUS=$agent_state"

listener_scope() {
  port="$1"
  addresses="$(lsof -nP -iTCP:"$port" -sTCP:LISTEN -F n 2>/dev/null | awk '/^n/ {print substr($0, 2)}')"
  if [ -z "$addresses" ]; then
    printf "%s\n" none
    return
  fi
  if printf "%s\n" "$addresses" | awk '!/^127\.0\.0\.1:/ && !/^\[::1\]:/ {found=1} END {print found + 0}' | grep -q 1; then
    printf "%s\n" non-loopback
  else
    printf "%s\n" loopback
  fi
}
control_listen="$(listener_scope 38501)"
stream_listen="$(listener_scope 38502)"
printf "%s\n" "CONTROL_LISTEN=$control_listen"
printf "%s\n" "STREAM_LISTEN=$stream_listen"

export NVM_DIR="$HOME/.nvm"
if [ -s "$NVM_DIR/nvm.sh" ]; then . "$NVM_DIR/nvm.sh"; nvm use 22 >/dev/null 2>&1 || true; fi
node_bin="$(command -v node || true)"
if [ -n "$node_bin" ]; then
  printf "%s\n" "NODE_VERSION=$($node_bin --version)"
else
  printf "%s\n" NODE_VERSION=missing
fi

health=""
if command -v curl >/dev/null 2>&1; then
  health="$(curl --fail --silent --show-error --max-time 5 http://127.0.0.1:38501/health 2>/dev/null || true)"
fi
health_ok=false
netease_configured=unknown
active_stream_count=unknown
active_playback_present=unknown
if [ -n "$health" ] && [ -n "$node_bin" ]; then
  parsed="$($node_bin --input-type=module -e "const body=JSON.parse(process.argv[1]); const state=body.state || {}; console.log(\"HEALTH_OK=\" + Boolean(body.ok)); console.log(\"NETEASE_CONFIGURED=\" + Boolean(state.neteaseConfigured)); console.log(\"ACTIVE_STREAM_COUNT=\" + state.activeStreamCount); console.log(\"ACTIVE_PLAYBACK_PRESENT=\" + Object.prototype.hasOwnProperty.call(state, \"activePlayback\"));" "$health" 2>/dev/null || true)"
  while IFS= read -r line; do
    case "$line" in
      HEALTH_OK=true) health_ok=true ;;
      NETEASE_CONFIGURED=*) netease_configured="${line#NETEASE_CONFIGURED=}" ;;
      ACTIVE_STREAM_COUNT=*) active_stream_count="${line#ACTIVE_STREAM_COUNT=}" ;;
      ACTIVE_PLAYBACK_PRESENT=*) active_playback_present="${line#ACTIVE_PLAYBACK_PRESENT=}" ;;
    esac
  done <<EOF
$parsed
EOF
fi
printf "%s\n" "HEALTH_OK=$health_ok"
printf "%s\n" "NETEASE_CONFIGURED=$netease_configured"
printf "%s\n" "ACTIVE_STREAM_COUNT=$active_stream_count"
printf "%s\n" "ACTIVE_PLAYBACK_PRESENT=$active_playback_present"

log_scan=missing
if [ -f "$log_file" ] && [ ! -L "$log_file" ]; then
  if LC_ALL=C grep -Eiq 'NETEASE_COOKIE|Cookie:|cookie=|MUSIC_U|__csrf|Authorization|Bearer|token|https?://|[?&][^[:space:]]+=|query[[:space:]]*[:=]' "$log_file"; then
    log_scan=fail
  else
    log_scan=pass
  fi
fi
printf "%s\n" "LOG_SECRET_SCAN=$log_scan"

identity_consistent=false
if valid_sha "$expected_sha" && valid_sha "$current_sha" && valid_sha "$running_sha" && valid_sha "$agent_release_sha"; then
  if [ "$expected_sha" = "$current_sha" ] && [ "$current_sha" = "$running_sha" ] && [ "$running_sha" = "$agent_release_sha" ] && [ "$agent_release_mode" = 600 ]; then
    identity_consistent=true
  fi
fi
printf "%s\n" "RELEASE_IDENTITY_CONSISTENT=$identity_consistent"

fail=0
[ "$agent_state" = running ] || fail=1
[ "$identity_consistent" = true ] || fail=1
[ "$health_ok" = true ] || fail=1
[ "$control_listen" = loopback ] || fail=1
[ "$stream_listen" = loopback ] || fail=1
[ "$netease_configured" = false ] || fail=1
[ "$active_stream_count" = 0 ] || fail=1
[ "$active_playback_present" = false ] || fail=1
[ "$log_scan" = pass ] || fail=1
if [ "$fail" -eq 0 ]; then
  printf "%s\n" STATUS_RESULT=PASS
else
  printf "%s\n" STATUS_RESULT=FAIL
fi
exit "$fail"
REMOTE
)"
remote_script="${remote_script//__EXPECTED__/$expected_input}"

ssh "${SSH_ARGS[@]}" "$CORE_SSH_TARGET" "$remote_script"
