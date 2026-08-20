#!/usr/bin/env bash

set -euo pipefail

: "${CORE_SSH_TARGET:?请设置 CORE_SSH_TARGET，例如 roonstation@<verified-core-endpoint>}"

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

ssh "${SSH_ARGS[@]}" "$CORE_SSH_TARGET" 'set -u
base="$HOME/Library/Application Support/MusicBridgeAgent"
current="$base/current"
data_dir="$base/data"
log_file="$base/logs/agent.log"
pid_file="$data_dir/agent.pid"

if [ -L "$current" ]; then
  current_target="$(readlink "$current")"
  current_sha="$(basename "$current_target")"
  printf "%s\n" "CURRENT_RELEASE_SHA=$current_sha"
else
  printf "%s\n" CURRENT_RELEASE_SHA=missing
fi

agent_state=stopped
if [ -f "$pid_file" ]; then
  pid="$(tr -d "[:space:]" < "$pid_file")"
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    command_line="$(ps -p "$pid" -o command= 2>/dev/null || true)"
    case "$command_line" in
      *dist/main.js*) agent_state=running; printf "%s\n" AGENT_PID_STATUS=running ;;
      *) agent_state=unknown; printf "%s\n" AGENT_PID_STATUS=unknown ;;
    esac
  else
    agent_state=stale
    printf "%s\n" AGENT_PID_STATUS=stale
  fi
else
  printf "%s\n" AGENT_PID_STATUS=stopped
fi

listener_scope() {
  port="$1"
  addresses="$(lsof -nP -iTCP:"$port" -sTCP:LISTEN -F n 2>/dev/null | awk '\''/^n/ {print substr($0, 2)}'\'')"
  if [ -z "$addresses" ]; then
    printf "%s\n" none
    return
  fi
  if printf "%s\n" "$addresses" | awk '\''!/^127\.0\.0\.1:/ && !/^\[::1\]:/ {found=1} END {print found + 0}'\'' | grep -q 1; then
    printf "%s\n" non-loopback
  else
    printf "%s\n" loopback
  fi
}
printf "%s\n" "CONTROL_LISTEN=$(listener_scope 38501)"
printf "%s\n" "STREAM_LISTEN=$(listener_scope 38502)"

export NVM_DIR="$HOME/.nvm"
if [ -s "$NVM_DIR/nvm.sh" ]; then . "$NVM_DIR/nvm.sh"; nvm use 22 >/dev/null 2>&1 || true; fi
node_bin="$(command -v node || true)"
if [ -n "$node_bin" ]; then printf "%s\n" "NODE_VERSION=$($node_bin --version)"; else printf "%s\n" NODE_VERSION=missing; fi

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
  done <<< "$parsed"
fi
printf "%s\n" "HEALTH_OK=$health_ok"
printf "%s\n" "NETEASE_CONFIGURED=$netease_configured"
printf "%s\n" "ACTIVE_STREAM_COUNT=$active_stream_count"
printf "%s\n" "ACTIVE_PLAYBACK_PRESENT=$active_playback_present"

log_scan=missing
if [ -f "$log_file" ]; then
  if LC_ALL=C grep -Eiq '\''MUSIC_U=|__csrf=|Authorization:|Bearer[[:space:]]|token[[:space:]]*[:=]|https?://|[?&][A-Za-z0-9_]+='\'' "$log_file"; then
    log_scan=fail
  else
    log_scan=pass
  fi
fi
printf "%s\n" "LOG_SECRET_SCAN=$log_scan"

fail=0
[ "$agent_state" = running ] || fail=1
[ "$health_ok" = true ] || fail=1
[ "$(listener_scope 38501)" = loopback ] || fail=1
[ "$(listener_scope 38502)" = loopback ] || fail=1
[ "$netease_configured" = false ] || fail=1
[ "$active_stream_count" = 0 ] || fail=1
[ "$active_playback_present" = false ] || fail=1
[ "$log_scan" = pass ] || fail=1
if [ "$fail" -eq 0 ]; then printf "%s\n" STATUS_RESULT=PASS; else printf "%s\n" STATUS_RESULT=FAIL; fi
exit "$fail"
'
