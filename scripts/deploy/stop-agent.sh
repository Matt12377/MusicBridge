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
pid_file="$base/data/agent.pid"
release_file="$base/data/agent.release"

extract_release_sha() {
  printf '%s\n' "$1" | sed -nE 's#.*releases/([0-9a-f]{40})/dist/main\.js.*#\1#p' | head -n 1
}

if [ ! -e "$pid_file" ] && [ ! -L "$pid_file" ]; then
  if [ -e "$release_file" ] || [ -L "$release_file" ]; then
    rm -f "$release_file"
  fi
  printf "%s\n" AGENT_ALREADY_STOPPED
  exit 0
fi
if [ -L "$pid_file" ] || [ ! -f "$pid_file" ]; then
  printf "%s\n" PID_FILE_INVALID >&2
  exit 40
fi

pid="$(tr -d "[:space:]" < "$pid_file")"
if [ -z "$pid" ] || ! printf '%s\n' "$pid" | grep -Eq '^[0-9]+$'; then
  printf "%s\n" PID_FILE_INVALID >&2
  exit 40
fi
if ! kill -0 "$pid" 2>/dev/null; then
  rm -f "$pid_file" "$release_file"
  printf "%s\n" AGENT_ALREADY_STOPPED
  exit 0
fi

command_line="$(ps -p "$pid" -o command= 2>/dev/null || true)"
running_sha="$(extract_release_sha "$command_line")"
case "$command_line" in
  *dist/main.js*) ;;
  *) printf "%s\n" PID_FILE_POINTS_TO_OTHER_PROCESS >&2; exit 40 ;;
esac
if [ -n "$running_sha" ] && [ -f "$release_file" ]; then
  recorded_sha="$(tr -d "[:space:]" < "$release_file")"
  if [ "$recorded_sha" != "$running_sha" ]; then
    printf "%s\n" RELEASE_IDENTITY_MISMATCH >&2
    exit 40
  fi
fi

kill -TERM "$pid"
process_alive() {
  if ! kill -0 "$1" 2>/dev/null; then
    return 1
  fi
  state="$(ps -p "$1" -o stat= 2>/dev/null | tr -d "[:space:]")"
  case "$state" in
    ''|Z*) return 1 ;;
    *) return 0 ;;
  esac
}
i=0
while process_alive "$pid"; do
  i=$((i + 1))
  if [ "$i" -ge 60 ]; then
    printf "%s\n" AGENT_DID_NOT_EXIT_AFTER_TERM >&2
    exit 41
  fi
  sleep 1
done
rm -f "$pid_file" "$release_file"
printf "%s\n" AGENT_STOPPED
REMOTE
)"

ssh "${SSH_ARGS[@]}" "$CORE_SSH_TARGET" "$remote_script"
