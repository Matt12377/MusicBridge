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

remote_script="$(cat <<'REMOTE'
set -e
base="$HOME/Library/Application Support/MusicBridgeAgent"
current="$base/current"
data_dir="$base/data"
logs_dir="$base/logs"
pid_file="$data_dir/agent.pid"
release_file="$data_dir/agent.release"
log_file="$logs_dir/agent.log"
credential_file="$data_dir/netease.cookie"
max_cookie_length=8192
netease_cookie=''

unset NETEASE_COOKIE

valid_sha() {
  printf '%s\n' "$1" | grep -Eq '^[0-9a-f]{40}$'
}

extract_release_sha() {
  printf '%s\n' "$1" | sed -nE 's#.*releases/([0-9a-f]{40})/dist/main\.js.*#\1#p' | head -n 1
}

if [ ! -L "$current" ]; then
  printf "%s\n" CURRENT_RELEASE_NOT_SYMLINK >&2
  exit 30
fi
current_target="$(readlink "$current")"
current_sha="$(basename "$current_target")"
if ! valid_sha "$current_sha"; then
  printf "%s\n" CURRENT_RELEASE_SHA_INVALID >&2
  exit 30
fi
case "$current_target" in
  "$base/releases/$current_sha") release_dir="$current_target" ;;
  "releases/$current_sha") release_dir="$base/$current_target" ;;
  *) printf "%s\n" CURRENT_RELEASE_TARGET_INVALID >&2; exit 30 ;;
esac

[ -d "$release_dir" ] && [ ! -L "$release_dir" ] || { printf "%s\n" CURRENT_RELEASE_NOT_READY >&2; exit 30; }
[ -f "$release_dir/dist/main.js" ] && [ ! -L "$release_dir/dist/main.js" ] || { printf "%s\n" CURRENT_RELEASE_NOT_READY >&2; exit 30; }
[ -d "$release_dir/node_modules" ] && [ ! -L "$release_dir/node_modules" ] || { printf "%s\n" CURRENT_RELEASE_NOT_READY >&2; exit 30; }
[ -f "$release_dir/package.json" ] && [ -f "$release_dir/package-lock.json" ] || { printf "%s\n" CURRENT_RELEASE_NOT_READY >&2; exit 30; }

if [ -e "$pid_file" ] || [ -L "$pid_file" ] || [ -e "$release_file" ] || [ -L "$release_file" ]; then
  if [ ! -f "$pid_file" ] || [ -L "$pid_file" ] || [ ! -f "$release_file" ] || [ -L "$release_file" ]; then
    printf "%s\n" RELEASE_IDENTITY_INCOMPLETE >&2
    exit 31
  fi
  pid="$(tr -d "[:space:]" < "$pid_file")"
  recorded_sha="$(tr -d "[:space:]" < "$release_file")"
  if kill -0 "$pid" 2>/dev/null; then
    command_line="$(ps -p "$pid" -o command= 2>/dev/null || true)"
    running_sha="$(extract_release_sha "$command_line")"
    if ! valid_sha "$recorded_sha" || [ "$recorded_sha" != "$current_sha" ] || [ "$running_sha" != "$current_sha" ]; then
      printf "%s\n" RELEASE_IDENTITY_MISMATCH >&2
      exit 31
    fi
    [ "$(stat -f "%Lp" "$release_file" 2>/dev/null)" = 600 ] || { printf "%s\n" RELEASE_IDENTITY_MODE_INVALID >&2; exit 31; }
    printf "%s\n" AGENT_ALREADY_RUNNING
    exit 0
  fi
  rm -f "$pid_file" "$release_file"
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

if [ -e "$credential_file" ] || [ -L "$credential_file" ]; then
  if [ -L "$credential_file" ] || [ ! -f "$credential_file" ]; then
    printf "%s\n" PROVIDER_CREDENTIAL_INVALID >&2
    exit 35
  fi
  credential_mode="$(stat -f "%Lp" "$credential_file" 2>/dev/null || true)"
  if [ "$credential_mode" != 600 ]; then
    printf "%s\n" PROVIDER_CREDENTIAL_INVALID >&2
    exit 35
  fi
  credential_size="$(wc -c < "$credential_file" | tr -d "[:space:]")"
  case "$credential_size" in
    ''|*[!0-9]*) printf "%s\n" PROVIDER_CREDENTIAL_INVALID >&2; exit 35 ;;
  esac
  if [ "$credential_size" -lt 1 ] || [ "$credential_size" -gt "$max_cookie_length" ]; then
    printf "%s\n" PROVIDER_CREDENTIAL_INVALID >&2
    exit 35
  fi
  if LC_ALL=C grep -q '[[:cntrl:]]' "$credential_file"; then
    printf "%s\n" PROVIDER_CREDENTIAL_INVALID >&2
    exit 35
  fi
  netease_cookie="$(cat "$credential_file")"
  if [ -z "$netease_cookie" ]; then
    printf "%s\n" PROVIDER_CREDENTIAL_INVALID >&2
    exit 35
  fi
  export NETEASE_COOKIE="$netease_cookie"
fi

umask 077
mkdir -p "$data_dir" "$logs_dir"
touch "$log_file"
chmod 600 "$log_file"

release_tmp="$data_dir/.agent.release.$$"
pid_tmp="$data_dir/.agent.pid.$$"
cleanup_temps() {
  rm -f "$release_tmp" "$pid_tmp"
  unset NETEASE_COOKIE netease_cookie
}
trap cleanup_temps EXIT
printf "%s\n" "$current_sha" > "$release_tmp"
chmod 600 "$release_tmp"

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
    "$node_bin" "$release_dir/dist/main.js"
) >> "$log_file" 2>&1 < /dev/null &
pid="$!"
printf "%s\n" "$pid" > "$pid_tmp"
chmod 600 "$pid_tmp"
mv -f "$release_tmp" "$release_file"
mv -f "$pid_tmp" "$pid_file"

sleep 1
if ! kill -0 "$pid" 2>/dev/null; then
  printf "%s\n" AGENT_EXITED_ON_START >&2
  rm -f "$pid_file" "$release_file"
  exit 34
fi
command_line="$(ps -p "$pid" -o command= 2>/dev/null || true)"
running_sha="$(extract_release_sha "$command_line")"
if [ "$running_sha" != "$current_sha" ]; then
  printf "%s\n" AGENT_RELEASE_IDENTITY_NOT_RUNNING >&2
  kill -TERM "$pid" 2>/dev/null || true
  rm -f "$pid_file" "$release_file"
  exit 34
fi
unset NETEASE_COOKIE netease_cookie
trap - EXIT
printf "%s\n" "AGENT_STARTED_PID=$pid"
printf "%s\n" "CURRENT_RELEASE_SHA=$current_sha"
printf "%s\n" "AGENT_RELEASE_SHA=$current_sha"
printf "%s\n" "NODE_VERSION=$($node_bin --version)"
REMOTE
)"

ssh "${SSH_ARGS[@]}" "$CORE_SSH_TARGET" "$remote_script"
