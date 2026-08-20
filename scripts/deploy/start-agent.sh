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

ssh "${SSH_ARGS[@]}" "$CORE_SSH_TARGET" 'set -e
base="$HOME/Library/Application Support/MusicBridgeAgent"
current="$base/current"
data_dir="$base/data"
logs_dir="$base/logs"
pid_file="$data_dir/agent.pid"
log_file="$logs_dir/agent.log"

if [ ! -L "$current" ] || [ ! -f "$current/dist/main.js" ]; then
  printf "%s\n" CURRENT_RELEASE_NOT_READY >&2
  exit 30
fi

if [ -f "$pid_file" ]; then
  pid="$(tr -d "[:space:]" < "$pid_file")"
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    command_line="$(ps -p "$pid" -o command= 2>/dev/null || true)"
    case "$command_line" in
      *dist/main.js*) printf "%s\n" AGENT_ALREADY_RUNNING; exit 0 ;;
      *) printf "%s\n" PID_FILE_POINTS_TO_OTHER_PROCESS >&2; exit 31 ;;
    esac
  fi
  rm -f "$pid_file"
fi

export NVM_DIR="$HOME/.nvm"
if [ -s "$NVM_DIR/nvm.sh" ]; then
  . "$NVM_DIR/nvm.sh"
  nvm use 22 >/dev/null
fi
node_bin="$(command -v node || true)"
if [ -z "$node_bin" ]; then
  printf "%s\n" NODE_NOT_FOUND >&2
  exit 32
fi
case "$($node_bin --version)" in
  v22.*) ;;
  *) printf "%s\n" NODE_NOT_V22 >&2; exit 33 ;;
esac

unset NETEASE_COOKIE
umask 077
mkdir -p "$data_dir" "$logs_dir"
touch "$log_file"
chmod 600 "$log_file"

(
  cd "$data_dir"
  exec nohup env \
    BRIDGE_CONTROL_HOST=127.0.0.1 \
    BRIDGE_CONTROL_PORT=38501 \
    BRIDGE_STREAM_HOST=127.0.0.1 \
    BRIDGE_STREAM_PORT=38502 \
    BRIDGE_PUBLIC_STREAM_BASE_URL=http://127.0.0.1:38502 \
    ENABLE_GENERAL_UNBLOCK=false \
    ENABLE_PROXY=false \
    ENABLE_RANDOM_CN_IP=false \
    LOG_LEVEL=info \
    "$node_bin" "$current/dist/main.js"
) >> "$log_file" 2>&1 < /dev/null &
pid="$!"
printf "%s\n" "$pid" > "$pid_file"
chmod 600 "$pid_file"
sleep 1
if ! kill -0 "$pid" 2>/dev/null; then
  printf "%s\n" AGENT_EXITED_ON_START >&2
  exit 34
fi
printf "%s\n" "AGENT_STARTED_PID=$pid"
printf "%s\n" "NODE_VERSION=$($node_bin --version)"
'
