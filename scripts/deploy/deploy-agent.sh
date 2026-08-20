#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "$0")" && pwd)"
BUILD_SCRIPT="$SCRIPT_DIR/build-agent-bundle.sh"

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

remote_ssh() {
  ssh "${SSH_ARGS[@]}" "$CORE_SSH_TARGET" "$@"
}

build_log="$(mktemp "${TMPDIR:-/tmp}/musicbridge-deploy-build.XXXXXX")"
trap 'rm -f "$build_log"' EXIT
"$BUILD_SCRIPT" | tee "$build_log"

archive="$(awk -F= '$1 == "BUNDLE_ARCHIVE" {print substr($0, index($0, "=") + 1)}' "$build_log" | tail -n 1)"
commit_sha="$(awk -F= '$1 == "BUNDLE_COMMIT_SHA" {print $2}' "$build_log" | tail -n 1)"
bundle_sha256="$(awk -F= '$1 == "BUNDLE_SHA256" {print $2}' "$build_log" | tail -n 1)"
native_modules="$(awk -F= '$1 == "BUNDLE_NATIVE_MODULES" {print $2}' "$build_log" | tail -n 1)"

if [[ ! -f "$archive" || ! "$commit_sha" =~ ^[0-9a-f]{40}$ || ! "$bundle_sha256" =~ ^[0-9a-f]{64}$ ]]; then
  printf '%s\n' "bundle 元数据不完整" >&2
  exit 10
fi

actual_sha256="$(shasum -a 256 "$archive" | awk '{print $1}')"
if [[ "$actual_sha256" != "$bundle_sha256" ]]; then
  printf '%s\n' "bundle 本地 SHA-256 复核失败" >&2
  exit 11
fi

dev_arch="$(uname -m)"
remote_arch="$(remote_ssh 'uname -m' | tr -d '\r\n')"
printf '%s\n' "REMOTE_CPU_ARCH=$remote_arch"
if [[ "$native_modules" != "0" && "$dev_arch" != "$remote_arch" ]]; then
  printf '%s\n' "存在原生 .node 模块且两端 CPU 架构不一致" >&2
  exit 12
fi

agent_running="$(remote_ssh 'set -u
base="$HOME/Library/Application Support/MusicBridgeAgent"
pid_file="$base/data/agent.pid"
if [ -f "$pid_file" ]; then
  pid="$(tr -d "[:space:]" < "$pid_file")"
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    command_line="$(ps -p "$pid" -o command= 2>/dev/null || true)"
    case "$command_line" in
      *dist/main.js*) printf "%s\n" running ;;
      *) printf "%s\n" unknown ;;
    esac
    exit 0
  fi
fi
printf "%s\n" stopped
')"
if [[ "$agent_running" == "running" ]]; then
  printf '%s\n' "远程 Agent 正在运行，请先执行 stop-agent.sh" >&2
  exit 13
fi
if [[ "$agent_running" == "unknown" ]]; then
  printf '%s\n' "远程 pid 文件指向非本任务进程，拒绝继续" >&2
  exit 14
fi

prepare_command='set -e
base="$HOME/Library/Application Support/MusicBridgeAgent"
commit="__COMMIT__"
release="$base/releases/$commit"
incoming="$base/releases/.incoming-$commit"
mkdir -p "$base/releases" "$base/data" "$base/logs"
chmod 700 "$base" "$base/releases" "$base/data" "$base/logs"
if [ -e "$release" ] || [ -L "$release" ]; then
  printf "%s\n" RELEASE_EXISTS
  exit 0
fi
if [ -e "$incoming" ]; then
  printf "%s\n" INCOMING_EXISTS >&2
  exit 20
fi
mkdir "$incoming"
printf "%s\n" INCOMING_READY
'
prepare_command="${prepare_command//__COMMIT__/$commit_sha}"
prepare_output="$(remote_ssh "$prepare_command")"

if [[ "$prepare_output" == "INCOMING_EXISTS" ]]; then
  printf '%s\n' "远程存在未完成的 incoming 部署，未删除，停止处理" >&2
  exit 15
fi

if [[ "$prepare_output" != "RELEASE_EXISTS" ]]; then
  receive_command='set -e
base="$HOME/Library/Application Support/MusicBridgeAgent"
commit="__COMMIT__"
expected="__EXPECTED__"
incoming="$base/releases/.incoming-$commit"
printf "%s\n" RECEIVE_BUNDLE
cat > "$incoming/bundle.tar.gz"
actual="$(shasum -a 256 "$incoming/bundle.tar.gz" | awk "{print \$1}")"
if [ "$actual" != "$expected" ]; then
  printf "%s\n" BUNDLE_SHA256_MISMATCH >&2
  exit 21
fi
mkdir "$incoming/payload"
tar -xzf "$incoming/bundle.tar.gz" -C "$incoming/payload"
for item in dist node_modules package.json package-lock.json; do
  [ -e "$incoming/payload/$item" ] || { printf "%s\n" MISSING_BUNDLE_ITEM >&2; exit 22; }
done
for item in src test docs tasks reports .git .env; do
  [ ! -e "$incoming/payload/$item" ] || { printf "%s\n" FORBIDDEN_BUNDLE_ITEM >&2; exit 23; }
done
rm -f "$incoming/bundle.tar.gz"
release="$base/releases/$commit"
mv "$incoming/payload" "$release"
rmdir "$incoming"
printf "%s\n" RELEASE_EXTRACTED
'
receive_command="${receive_command//__COMMIT__/$commit_sha}"
receive_command="${receive_command//__EXPECTED__/$bundle_sha256}"
cat "$archive" | remote_ssh "$receive_command"
fi

switch_command='set -e
base="$HOME/Library/Application Support/MusicBridgeAgent"
commit="__COMMIT__"
release="$base/releases/$commit"
[ -d "$release/dist" ] && [ -d "$release/node_modules" ]
if [ -e "$base/current" ] && [ ! -L "$base/current" ]; then
  printf "%s\n" CURRENT_IS_NOT_SYMLINK >&2
  exit 24
fi
previous="$(readlink "$base/current" 2>/dev/null || true)"
switch_path="$base/.current-$commit-$$"
ln -s "$release" "$switch_path"
mv -h -f "$switch_path" "$base/current"
printf "%s\n" "CURRENT_RELEASE_SHA=$commit"
printf "%s\n" "PREVIOUS_CURRENT=$previous"
printf "%s\n" CURRENT_SWITCHED
'
switch_command="${switch_command//__COMMIT__/$commit_sha}"
remote_ssh "$switch_command"

printf '%s\n' "DEPLOY_COMMIT_SHA=$commit_sha"
printf '%s\n' "DEPLOY_BUNDLE_SHA256=$bundle_sha256"
printf '%s\n' "DEPLOY_RESULT=PASS"
