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
pid_file="$base/data/agent.pid"
if [ ! -f "$pid_file" ]; then
  printf "%s\n" AGENT_ALREADY_STOPPED
  exit 0
fi
pid="$(tr -d "[:space:]" < "$pid_file")"
if [ -z "$pid" ] || ! kill -0 "$pid" 2>/dev/null; then
  rm -f "$pid_file"
  printf "%s\n" AGENT_ALREADY_STOPPED
  exit 0
fi
command_line="$(ps -p "$pid" -o command= 2>/dev/null || true)"
case "$command_line" in
  *dist/main.js*) ;;
  *) printf "%s\n" PID_FILE_POINTS_TO_OTHER_PROCESS >&2; exit 40 ;;
esac

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
rm -f "$pid_file"
printf "%s\n" AGENT_STOPPED
'
