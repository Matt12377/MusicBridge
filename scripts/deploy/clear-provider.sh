#!/usr/bin/env bash

set -euo pipefail

: "${CORE_SSH_TARGET:?请设置 CORE_SSH_TARGET，例如 roonstation@<verified-core-endpoint>}"

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

bash "$SCRIPT_DIR/stop-agent.sh"

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
set -eu
data_dir="$HOME/Library/Application Support/MusicBridgeAgent/data"
cookie_file="$data_dir/netease.cookie"

if [ -L "$cookie_file" ] || [ -f "$cookie_file" ]; then
  rm -f "$cookie_file"
elif [ -e "$cookie_file" ]; then
  printf '%s\n' PROVIDER_CLEAR_TARGET_INVALID >&2
  exit 50
fi

if [ -e "$cookie_file" ] || [ -L "$cookie_file" ]; then
  printf '%s\n' PROVIDER_CLEAR_VERIFY_FAILED >&2
  exit 51
fi

printf '%s\n' PROVIDER_CLEARED
REMOTE
)"

ssh "${SSH_ARGS[@]}" "$CORE_SSH_TARGET" "$remote_script"
