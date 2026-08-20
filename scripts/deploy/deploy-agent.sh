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
archive=""
commit_sha=""
bundle_sha256=""
native_modules=""
stage_parent=""
tmp_root="${TMPDIR:-/tmp}"
if [[ "$tmp_root" != "/" ]]; then
  tmp_root="${tmp_root%/}"
fi

read_build_outputs() {
  [[ -f "$build_log" ]] || return 0

  local value
  value="$(awk -F= '$1 == "BUNDLE_ARCHIVE" {print substr($0, index($0, "=") + 1)}' "$build_log" | tail -n 1)"
  if [[ -n "$value" ]]; then archive="$value"; fi
  value="$(awk -F= '$1 == "BUNDLE_COMMIT_SHA" {print $2}' "$build_log" | tail -n 1)"
  if [[ -n "$value" ]]; then commit_sha="$value"; fi
  value="$(awk -F= '$1 == "BUNDLE_SHA256" {print $2}' "$build_log" | tail -n 1)"
  if [[ -n "$value" ]]; then bundle_sha256="$value"; fi
  value="$(awk -F= '$1 == "BUNDLE_NATIVE_MODULES" {print $2}' "$build_log" | tail -n 1)"
  if [[ -n "$value" ]]; then native_modules="$value"; fi
  value="$(awk -F= '$1 == "BUNDLE_STAGE_PARENT" {print substr($0, index($0, "=") + 1)}' "$build_log" | tail -n 1)"
  if [[ -n "$value" ]]; then stage_parent="$value"; fi
  return 0
}

cleanup_build_outputs() {
  read_build_outputs
  if [[ -z "$stage_parent" ]]; then
    return 0
  fi

  case "$stage_parent" in
    "$tmp_root"/musicbridge-agent-stage.??????) ;;
    *)
      printf '%s\n' "拒绝清理未验证的 staging 路径" >&2
      return 1
      ;;
  esac

  if [[ ! -e "$stage_parent" && ! -L "$stage_parent" ]]; then
    return 0
  fi
  if [[ -L "$stage_parent" || ! -d "$stage_parent" ]]; then
    printf '%s\n' "staging 路径不是本次创建的普通目录" >&2
    return 1
  fi

  if [[ -z "$archive" && "$commit_sha" =~ ^[0-9a-f]{40}$ ]]; then
    archive="$stage_parent/music-bridge-agent-$commit_sha.tar.gz"
  fi
  if [[ -n "$archive" ]]; then
    case "$archive" in
      "$stage_parent"/music-bridge-agent-*.tar.gz) ;;
      *)
        printf '%s\n' "拒绝清理未验证的 archive 路径" >&2
        return 1
        ;;
    esac
    if [[ -L "$archive" ]]; then
      printf '%s\n' "archive 路径是符号链接，拒绝清理" >&2
      return 1
    fi
    if [[ -e "$archive" ]]; then
      [[ -f "$archive" ]] || return 1
      rm -f "$archive"
    fi
  fi

  stage_dir="$stage_parent/staging"
  if [[ -L "$stage_dir" || ( -e "$stage_dir" && ! -d "$stage_dir" ) ]]; then
    printf '%s\n' "staging 子目录类型不安全，拒绝清理" >&2
    return 1
  fi
  if [[ -d "$stage_dir" ]]; then
    find "$stage_dir" -depth -mindepth 1 -delete
    rmdir "$stage_dir"
  fi
  rmdir "$stage_parent"
}

cleanup_on_exit() {
  local rc=$?
  local cleanup_rc=0

  if ! cleanup_build_outputs; then
    cleanup_rc=1
  fi
  if [[ -L "$build_log" ]]; then
    cleanup_rc=1
  elif [[ -e "$build_log" ]]; then
    rm -f "$build_log" || cleanup_rc=1
  fi

  if [[ "$cleanup_rc" -eq 0 ]]; then
    printf '%s\n' DEPLOY_TEMP_CLEANUP=PASS
  else
    printf '%s\n' DEPLOY_TEMP_CLEANUP=FAIL >&2
    [[ "$rc" -eq 0 ]] && rc=42
  fi
  trap - EXIT
  exit "$rc"
}

on_signal() {
  exit 130
}

trap cleanup_on_exit EXIT
trap on_signal INT TERM HUP

set +e
"$BUILD_SCRIPT" | tee "$build_log"
build_status="${PIPESTATUS[0]}"
set -e
read_build_outputs
if [[ "$build_status" -ne 0 ]]; then
  printf '%s\n' "bundle 构建失败，退出码=$build_status" >&2
  exit "$build_status"
fi

if [[ -z "$archive" && "$commit_sha" =~ ^[0-9a-f]{40}$ ]]; then
  archive="$stage_parent/music-bridge-agent-$commit_sha.tar.gz"
fi
if [[ ! "$commit_sha" =~ ^[0-9a-f]{40}$ || ! "$bundle_sha256" =~ ^[0-9a-f]{64}$ || \
      -z "$stage_parent" || ! -f "$archive" || -L "$archive" ]]; then
  printf '%s\n' "bundle 元数据不完整" >&2
  exit 10
fi
expected_archive="$stage_parent/music-bridge-agent-$commit_sha.tar.gz"
if [[ "$archive" != "$expected_archive" ]]; then
  printf '%s\n' "bundle archive 不属于本次 staging" >&2
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

prepare_command="$(cat <<'REMOTE'
set -e
base="$HOME/Library/Application Support/MusicBridgeAgent"
commit="__COMMIT__"
expected="__EXPECTED__"
release="$base/releases/$commit"
incoming="$base/releases/.incoming-$commit"
metadata="$release/.musicbridge-release"

verify_payload() {
  [ -d "$release" ] && [ ! -L "$release" ] || exit 25
  [ -f "$release/dist/main.js" ] && [ ! -L "$release/dist/main.js" ] || exit 25
  [ -d "$release/node_modules" ] && [ ! -L "$release/node_modules" ] || exit 25
  [ -f "$release/package.json" ] && [ ! -L "$release/package.json" ] || exit 25
  [ -f "$release/package-lock.json" ] && [ ! -L "$release/package-lock.json" ] || exit 25
}

if [ -e "$release" ] || [ -L "$release" ]; then
  verify_payload
  [ -f "$metadata" ] && [ ! -L "$metadata" ] || { printf "%s\n" RELEASE_METADATA_MISSING >&2; exit 26; }
  recorded_commit="$(awk -F= '$1 == "commit_sha" {print $2}' "$metadata")"
  recorded_bundle="$(awk -F= '$1 == "bundle_sha256" {print $2}' "$metadata")"
  [ "$recorded_commit" = "$commit" ] || { printf "%s\n" RELEASE_COMMIT_MISMATCH >&2; exit 27; }
  [ "$recorded_bundle" = "$expected" ] || { printf "%s\n" RELEASE_BUNDLE_SHA256_MISMATCH >&2; exit 28; }
  [ "$(stat -f "%Lp" "$metadata" 2>/dev/null)" = 600 ] || { printf "%s\n" RELEASE_METADATA_MODE_INVALID >&2; exit 29; }
  printf "%s\n" RELEASE_EXISTS
  exit 0
fi

if [ -e "$incoming" ] || [ -L "$incoming" ]; then
  printf "%s\n" INCOMING_EXISTS
  exit 0
fi

mkdir -p "$base/releases" "$base/data" "$base/logs"
chmod 700 "$base" "$base/releases" "$base/data" "$base/logs"
mkdir "$incoming"
chmod 700 "$incoming"
printf "%s\n" INCOMING_READY
REMOTE
)"
prepare_command="${prepare_command//__COMMIT__/$commit_sha}"
prepare_command="${prepare_command//__EXPECTED__/$bundle_sha256}"

set +e
prepare_output="$(remote_ssh "$prepare_command")"
prepare_status="$?"
set -e
if [[ "$prepare_status" -ne 0 ]]; then
  printf '%s\n' "远程 prepare 失败，退出码=$prepare_status" >&2
  exit 15
fi

case "$prepare_output" in
  RELEASE_EXISTS)
    printf '%s\n' RELEASE_REUSED_AFTER_METADATA_VERIFICATION
    ;;
  INCOMING_EXISTS)
    printf '%s\n' "远程存在未完成的 incoming 部署，未删除，停止处理" >&2
    exit 16
    ;;
  INCOMING_READY)
    receive_command="$(cat <<'REMOTE'
set -e
base="$HOME/Library/Application Support/MusicBridgeAgent"
commit="__COMMIT__"
expected="__EXPECTED__"
incoming="$base/releases/.incoming-$commit"
release="$base/releases/$commit"
printf "%s\n" RECEIVE_BUNDLE
cat > "$incoming/bundle.tar.gz"
actual="$(shasum -a 256 "$incoming/bundle.tar.gz" | awk "{print \$1}")"
[ "$actual" = "$expected" ] || { printf "%s\n" BUNDLE_SHA256_MISMATCH >&2; exit 21; }
mkdir "$incoming/payload"
tar -xzf "$incoming/bundle.tar.gz" -C "$incoming/payload"
for item in dist node_modules package.json package-lock.json; do
  [ -e "$incoming/payload/$item" ] || { printf "%s\n" MISSING_BUNDLE_ITEM >&2; exit 22; }
done
[ -f "$incoming/payload/dist/main.js" ] || { printf "%s\n" MISSING_MAIN_ENTRY >&2; exit 22; }
for item in src test docs tasks reports .git .env; do
  [ ! -e "$incoming/payload/$item" ] || { printf "%s\n" FORBIDDEN_BUNDLE_ITEM >&2; exit 23; }
done
printf "format=1\ncommit_sha=%s\nbundle_sha256=%s\n" "$commit" "$expected" > "$incoming/payload/.musicbridge-release"
chmod 600 "$incoming/payload/.musicbridge-release"
if [ -e "$release" ] || [ -L "$release" ]; then
  printf "%s\n" RELEASE_APPEARED_DURING_RECEIVE >&2
  exit 24
fi
rm -f "$incoming/bundle.tar.gz"
mv "$incoming/payload" "$release"
rmdir "$incoming"
printf "%s\n" RELEASE_EXTRACTED
REMOTE
    )"
    receive_command="${receive_command//__COMMIT__/$commit_sha}"
    receive_command="${receive_command//__EXPECTED__/$bundle_sha256}"
    cat "$archive" | remote_ssh "$receive_command"
    ;;
  *)
    printf '%s\n' "远程 prepare 返回未知状态" >&2
    exit 17
    ;;
esac

switch_command="$(cat <<'REMOTE'
set -e
base="$HOME/Library/Application Support/MusicBridgeAgent"
commit="__COMMIT__"
expected="__EXPECTED__"
release="$base/releases/$commit"
metadata="$release/.musicbridge-release"
[ -d "$release" ] && [ ! -L "$release" ] || exit 30
[ -f "$release/dist/main.js" ] && [ -d "$release/node_modules" ] || exit 30
[ -f "$metadata" ] && [ "$(awk -F= '$1 == "commit_sha" {print $2}' "$metadata")" = "$commit" ] || exit 31
[ "$(awk -F= '$1 == "bundle_sha256" {print $2}' "$metadata")" = "$expected" ] || exit 32
if [ -e "$base/current" ] && [ ! -L "$base/current" ]; then
  printf "%s\n" CURRENT_IS_NOT_SYMLINK >&2
  exit 33
fi
previous="$(readlink "$base/current" 2>/dev/null || true)"
switch_path="$base/.current-$commit-$$"
if [ -e "$switch_path" ] || [ -L "$switch_path" ]; then
  printf "%s\n" CURRENT_SWITCH_PATH_EXISTS >&2
  exit 34
fi
ln -s "$release" "$switch_path"
mv -h -f "$switch_path" "$base/current"
printf "%s\n" "CURRENT_RELEASE_SHA=$commit"
printf "%s\n" "PREVIOUS_CURRENT=$previous"
printf "%s\n" CURRENT_SWITCHED
REMOTE
)"
switch_command="${switch_command//__COMMIT__/$commit_sha}"
switch_command="${switch_command//__EXPECTED__/$bundle_sha256}"
remote_ssh "$switch_command"

printf '%s\n' "DEPLOY_COMMIT_SHA=$commit_sha"
printf '%s\n' "DEPLOY_BUNDLE_SHA256=$bundle_sha256"
printf '%s\n' DEPLOY_RESULT=PASS
