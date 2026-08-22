#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "$0")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/../.." && pwd)"

: "${CORE_SSH_TARGET:?请设置 CORE_SSH_TARGET，例如 macmini 或 roonstation@<verified-core-endpoint>}"

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
run_rollback() {
  local rollback_sha="$1"
  local rollback_run_id
  rollback_run_id="$(date +%Y%m%d%H%M%S)-$$"

  remote_ssh env ROLLBACK_SHA="$rollback_sha" RUN_ID="$rollback_run_id" /bin/bash -s <<'REMOTE_ROLLBACK'
set -euo pipefail

rollback_sha="${ROLLBACK_SHA:?}"
run_id="${RUN_ID:?}"
base="$HOME/Library/Application Support/Music Bridge for Roon"
releases="$base/releases"
current="$base/current"
target="$releases/$rollback_sha"
target_app="$target/Music Bridge for Roon.app"
metadata="$target/.musicbridge-desktop-release"
old_target=""
old_was_running=0
current_mutated=0
next_current=""
switched=0

release_pids() {
  local release_dir="$1"
  ps -axo pid=,command= | awk -v prefix="$release_dir/Music Bridge for Roon.app/" '$0 !~ /awk/ && index($0, prefix) {print $1}'
}

start_release() {
  local release_dir="$1"
  open "$release_dir/Music Bridge for Roon.app" >/dev/null 2>&1
}

stop_release() {
  local release_dir="$1"
  local pids
  local remaining
  pids="$(release_pids "$release_dir")"
  [[ -n "$pids" ]] || return 0
  for pid in $pids; do kill -TERM "$pid" 2>/dev/null || true; done
  for _ in $(jot 40 1); do
    remaining="$(release_pids "$release_dir")"
    [[ -z "$remaining" ]] && return 0
    sleep 0.5
  done
  remaining="$(release_pids "$release_dir")"
  for pid in $remaining; do kill -KILL "$pid" 2>/dev/null || true; done
  [[ -z "$(release_pids "$release_dir")" ]]
}

restore_on_failure() {
  local rc="$1"
  [[ "$rc" -eq 0 ]] && return 0
  if [[ "$current_mutated" -eq 1 && -n "$old_target" ]]; then
    if [[ "$switched" -eq 1 ]]; then
      stop_release "$target" || true
    fi
    if [[ -L "$current" ]]; then unlink "$current" || true; fi
    [[ ! -e "$current" && ! -L "$current" ]]
    ln -s "$old_target" "$current"
    switched=0
    current_mutated=0
  fi
  if [[ "$old_was_running" -eq 1 && -n "$old_target" ]]; then
    start_release "$old_target"
  fi
}

cleanup_rollback() {
  local rc=$?
  restore_on_failure "$rc" || rc=43
  if [[ -n "$next_current" && ( -e "$next_current" || -L "$next_current" ) ]]; then
    if [[ -L "$next_current" ]]; then unlink "$next_current" || rc=43; else rc=43; fi
  fi
  trap - EXIT HUP INT TERM
  exit "$rc"
}

trap cleanup_rollback EXIT
trap 'exit 130' INT TERM HUP

[[ "$rollback_sha" =~ ^[0-9a-f]{40}$ ]] || { printf '%s\n' ROLLBACK_SHA_INVALID >&2; exit 44; }
[[ -d "$target" && ! -L "$target" ]] || { printf '%s\n' ROLLBACK_RELEASE_MISSING >&2; exit 45; }
[[ -d "$target_app" && ! -L "$target_app" ]] || { printf '%s\n' ROLLBACK_APP_MISSING >&2; exit 46; }
[[ -f "$target_app/Contents/Resources/app.asar" && ! -L "$target_app/Contents/Resources/app.asar" ]] || { printf '%s\n' ROLLBACK_ASAR_MISSING >&2; exit 47; }
[[ -f "$metadata" && ! -L "$metadata" ]] || { printf '%s\n' ROLLBACK_METADATA_MISSING >&2; exit 48; }
[[ "$(stat -f '%Lp' "$metadata")" == 600 ]] || { printf '%s\n' ROLLBACK_METADATA_MODE_INVALID >&2; exit 49; }
recorded_commit="$(awk -F= '$1 == "commit_sha" {print $2}' "$metadata")"
[[ "$recorded_commit" == "$rollback_sha" ]] || { printf '%s\n' ROLLBACK_METADATA_MISMATCH >&2; exit 50; }

if [[ -L "$current" ]]; then
  old_target="$(readlink "$current")"
elif [[ -e "$current" ]]; then
  printf '%s\n' CURRENT_NOT_SYMLINK >&2
  exit 51
fi

if [[ -n "$old_target" ]]; then
  [[ -d "$old_target/Music Bridge for Roon.app" ]] || { printf '%s\n' OLD_RELEASE_MISSING >&2; exit 52; }
  old_pids="$(release_pids "$old_target")"
  if [[ -n "$old_pids" ]]; then
    old_was_running=1
    stop_release "$old_target"
  fi
fi

next_current="$base/.current-rollback-$run_id"
[[ ! -e "$next_current" && ! -L "$next_current" ]]
ln -s "$target" "$next_current"
current_mutated=1
if [[ -L "$current" ]]; then
  unlink "$current"
elif [[ -e "$current" ]]; then
  exit 53
fi
mv "$next_current" "$current"
switched=1
[[ "$(readlink "$current")" == "$target" ]]
start_release "$target"

new_pids=""
for _ in $(jot 40 1); do
  new_pids="$(release_pids "$target")"
  [[ -n "$new_pids" ]] && break
  sleep 0.5
done
[[ -n "$new_pids" ]] || { printf '%s\n' ROLLBACK_APP_NOT_RUNNING >&2; exit 54; }

health='FAIL'
for _ in $(jot 20 1); do
  if curl -fsS --max-time 5 http://127.0.0.1:38501/health >/dev/null 2>&1; then
    health='PASS'
    break
  fi
  sleep 1
done
[[ "$health" == PASS ]] || { printf '%s\n' ROLLBACK_HEALTH_FAIL >&2; exit 55; }

for port in 38501 38502; do
  loopback_count="$(lsof -nP -iTCP:"$port" -sTCP:LISTEN 2>/dev/null | awk 'NR > 1 {if ($9 ~ /^127[.]0[.]0[.]1:/) count++} END {print count+0}')"
  non_loopback_count="$(lsof -nP -iTCP:"$port" -sTCP:LISTEN 2>/dev/null | awk 'NR > 1 {if ($9 !~ /^127[.]0[.]0[.]1:/) count++} END {print count+0}')"
  [[ "$loopback_count" -gt 0 && "$non_loopback_count" -eq 0 ]] || { printf '%s\n' ROLLBACK_LOOPBACK_FAIL >&2; exit 56; }
  printf 'ROLLBACK_PORT_%s_LOOPBACK=%s\n' "$port" "$loopback_count"
  printf 'ROLLBACK_PORT_%s_NON_LOOPBACK=%s\n' "$port" "$non_loopback_count"
done

roon_process_count="$(ps -axo command= | awk '/[R]oon/ {count++} END {print count+0}')"
[[ "$roon_process_count" -gt 0 ]] || { printf '%s\n' ROLLBACK_ROON_NOT_RUNNING >&2; exit 57; }
printf 'ROLLBACK_TARGET_SHA=%s\n' "$rollback_sha"
printf 'ROLLBACK_CURRENT_RELEASE_SHA=%s\n' "$(basename "$(readlink "$current")")"
printf 'ROLLBACK_HEALTH_HTTP=PASS\n'
printf 'ROLLBACK_ROON_PROCESS_COUNT=%s\n' "$roon_process_count"
switched=0
current_mutated=0
REMOTE_ROLLBACK
}

if [[ "${1:-}" == "--rollback" ]]; then
  if [[ "$#" -ne 2 || ! "${2:-}" =~ ^[0-9a-f]{40}$ ]]; then
    printf '%s\n' "用法：$0 --rollback <40位 commit SHA>" >&2
    exit 2
  fi
  run_rollback "$2"
  exit 0
fi
if [[ "$#" -ne 0 ]]; then
  printf '%s\n' "用法：$0 [--rollback <40位 commit SHA>]" >&2
  exit 2
fi

APP_PATH="${DESKTOP_APP_PATH:-$REPO_ROOT/apps/desktop/release/mac-arm64/Music Bridge for Roon.app}"
if [[ "$APP_PATH" != /* ]]; then
  APP_PATH="$REPO_ROOT/$APP_PATH"
fi

codesign_auto_discovery="${DESKTOP_CSC_IDENTITY_AUTO_DISCOVERY:-false}"
case "$codesign_auto_discovery" in
  true|false) ;;
  *)
    printf '%s\n' "DESKTOP_CSC_IDENTITY_AUTO_DISCOVERY 必须是 true 或 false" >&2
    exit 2
    ;;
esac

TMP_ROOT="${TMPDIR:-/tmp}"
if [[ "$TMP_ROOT" == "/" ]]; then
  printf '%s\n' "拒绝使用根目录作为临时目录" >&2
  exit 2
fi
TMP_ROOT="${TMP_ROOT%/}"

commit_sha="$(git -C "$REPO_ROOT" rev-parse HEAD)"
if [[ ! "$commit_sha" =~ ^[0-9a-f]{40}$ ]]; then
  printf '%s\n' "当前 Git commit SHA 无效" >&2
  exit 3
fi
if [[ -n "$(git -C "$REPO_ROOT" status --porcelain)" ]]; then
  printf '%s\n' "工作区不干净，停止部署" >&2
  exit 4
fi

run_id="$(date +%Y%m%d%H%M%S)-$$"
stage_parent="$(mktemp -d "$TMP_ROOT/musicbridge-desktop-stage.XXXXXX")"
archive="$stage_parent/music-bridge-desktop-$commit_sha.zip"
remote_archive="/tmp/musicbridge-desktop-$commit_sha-$run_id.zip"
remote_archive_reserved=0
local_asar_sha=""
bundle_sha256=""

cleanup_remote_archive() {
  if [[ "$remote_archive_reserved" -ne 1 ]]; then
    return 0
  fi
  remote_ssh env REMOTE_ARCHIVE="$remote_archive" /bin/bash -s >/dev/null 2>&1 <<'REMOTE_CLEANUP' || true
set -e
remote_archive="${REMOTE_ARCHIVE:?}"
if [[ -e "$remote_archive" || -L "$remote_archive" ]]; then
  [[ -f "$remote_archive" && ! -L "$remote_archive" ]]
  unlink "$remote_archive"
fi
REMOTE_CLEANUP
}

cleanup_local() {
  local rc=$?

  cleanup_remote_archive

  if [[ -e "$archive" || -L "$archive" ]]; then
    if [[ -L "$archive" || ! -f "$archive" ]]; then
      printf '%s\n' "本地 archive 类型不安全，拒绝清理" >&2
      rc=40
    else
      unlink "$archive" || rc=40
    fi
  fi

  if [[ -e "$stage_parent" || -L "$stage_parent" ]]; then
    if [[ -L "$stage_parent" || ! -d "$stage_parent" ]]; then
      printf '%s\n' "本地 staging 路径类型不安全，拒绝清理" >&2
      rc=40
    elif [[ -n "$(find "$stage_parent" -mindepth 1 -print -prune)" ]]; then
      printf '%s\n' "本地 staging 仍有未预期内容，拒绝清理" >&2
      rc=40
    else
      rmdir "$stage_parent" || rc=40
    fi
  fi

  trap - EXIT HUP INT TERM
  if [[ "$rc" -eq 0 ]]; then
    printf '%s\n' DEPLOY_TEMP_CLEANUP=PASS
  else
    printf '%s\n' DEPLOY_TEMP_CLEANUP=FAIL >&2
  fi
  exit "$rc"
}

on_signal() {
  exit 130
}

trap cleanup_local EXIT
trap on_signal INT TERM HUP

printf '开始构建 Electron App（签名发现=%s）\n' "$codesign_auto_discovery"
corepack pnpm@10.17.1 run verify
CSC_IDENTITY_AUTO_DISCOVERY="$codesign_auto_discovery" corepack pnpm@10.17.1 --filter @music-bridge/desktop run pack

if [[ -n "$(git -C "$REPO_ROOT" status --porcelain)" ]]; then
  printf '%s\n' "构建后工作区出现未预期变更，停止部署" >&2
  exit 5
fi
if ! git -C "$REPO_ROOT" diff --quiet -- package.json pnpm-lock.yaml; then
  printf '%s\n' "构建修改了 package.json 或 pnpm-lock.yaml，停止部署" >&2
  exit 6
fi

if [[ ! -d "$APP_PATH" || -L "$APP_PATH" ]]; then
  printf '%s\n' "未找到普通 Electron App 目录：$APP_PATH" >&2
  exit 7
fi
if [[ ! -f "$APP_PATH/Contents/Resources/app.asar" || -L "$APP_PATH/Contents/Resources/app.asar" ]]; then
  printf '%s\n' "Electron App 缺少普通 app.asar" >&2
  exit 8
fi

local_asar_sha="$(shasum -a 256 "$APP_PATH/Contents/Resources/app.asar" | awk '{print $1}')"
ditto -c -k --sequesterRsrc --keepParent "$APP_PATH" "$archive"
bundle_sha256="$(shasum -a 256 "$archive" | awk '{print $1}')"

if [[ ! "$local_asar_sha" =~ ^[0-9a-f]{64}$ || ! "$bundle_sha256" =~ ^[0-9a-f]{64}$ ]]; then
  printf '%s\n' "本地 bundle SHA-256 无效" >&2
  exit 9
fi

printf 'DEPLOY_COMMIT_SHA=%s\n' "$commit_sha"
printf 'DEPLOY_BUNDLE_SHA256=%s\n' "$bundle_sha256"
printf 'DEPLOY_APP_ASAR_SHA256=%s\n' "$local_asar_sha"

remote_ssh env REMOTE_ARCHIVE="$remote_archive" /bin/bash -s <<'REMOTE_PREFLIGHT'
set -e
remote_archive="${REMOTE_ARCHIVE:?}"
if [[ -e "$remote_archive" || -L "$remote_archive" ]]; then
  printf '%s\n' REMOTE_ARCHIVE_ALREADY_EXISTS >&2
  exit 20
fi
REMOTE_PREFLIGHT
remote_archive_reserved=1

scp -q "${SSH_ARGS[@]}" "$archive" "$CORE_SSH_TARGET:$remote_archive"

remote_ssh env \
  COMMIT_SHA="$commit_sha" \
  BUNDLE_SHA256="$bundle_sha256" \
  APP_ASAR_SHA256="$local_asar_sha" \
  REMOTE_ARCHIVE="$remote_archive" \
  RUN_ID="$run_id" \
  /bin/bash -s <<'REMOTE'
set -euo pipefail

commit_sha="${COMMIT_SHA:?}"
bundle_sha256="${BUNDLE_SHA256:?}"
app_asar_sha256="${APP_ASAR_SHA256:?}"
remote_archive="${REMOTE_ARCHIVE:?}"
run_id="${RUN_ID:?}"

base="$HOME/Library/Application Support/Music Bridge for Roon"
releases="$base/releases"
current="$base/current"
release_dir="$releases/$commit_sha"
release_app="$release_dir/Music Bridge for Roon.app"
metadata="$release_dir/.musicbridge-desktop-release"
incoming="$base/.incoming-desktop-$commit_sha-$run_id"

incoming_created=0
release_created=0
current_switched=0
old_target=""
old_was_running=0
current_mutated=0
next_current=""

remove_exact_tree() {
  local target="$1"
  case "$target" in
    "$base/.incoming-desktop-$commit_sha-$run_id") ;;
    "$releases/$commit_sha") ;;
    *)
      printf '%s\n' "拒绝清理未验证的远端目录" >&2
      return 1
      ;;
  esac
  if [[ -L "$target" || ( -e "$target" && ! -d "$target" ) ]]; then
    printf '%s\n' "远端清理目标类型不安全" >&2
    return 1
  fi
  [[ -d "$target" ]] || return 0
  find "$target" -type f -print | while IFS= read -r path; do
    unlink "$path"
  done
  find "$target" -type l -print | while IFS= read -r path; do
    unlink "$path"
  done
  find "$target" -depth -type d -print | while IFS= read -r path; do
    rmdir "$path"
  done
}

release_pids() {
  local target="$1"
  ps -axo pid=,command= | awk -v prefix="$target/Music Bridge for Roon.app/" '$0 !~ /awk/ && index($0, prefix) {print $1}'
}

start_release() {
  local target="$1"
  open "$target/Music Bridge for Roon.app" >/dev/null 2>&1
}

stop_release() {
  local target="$1"
  local pids
  local remaining
  pids="$(release_pids "$target")"
  [[ -n "$pids" ]] || return 0
  for pid in $pids; do
    kill -TERM "$pid" 2>/dev/null || true
  done
  for _ in $(jot 40 1); do
    remaining="$(release_pids "$target")"
    [[ -z "$remaining" ]] && return 0
    sleep 0.5
  done
  remaining="$(release_pids "$target")"
  for pid in $remaining; do
    kill -KILL "$pid" 2>/dev/null || true
  done
  [[ -z "$(release_pids "$target")" ]]
}

restore_old_on_failure() {
  local rc="$1"
  [[ "$rc" -eq 0 ]] && return 0

  if [[ "$current_mutated" -eq 1 ]]; then
    if [[ "$current_switched" -eq 1 ]]; then
      stop_release "$release_dir" || true
    fi
    if [[ -n "$old_target" ]]; then
      if [[ -L "$current" ]]; then
        unlink "$current" || true
      elif [[ -e "$current" ]]; then
        printf '%s\n' "恢复 current 时发现非符号链接，停止自动恢复" >&2
        return 1
      fi
      ln -s "$old_target" "$current"
      current_switched=0
      current_mutated=0
    fi
  fi

  if [[ "$old_was_running" -eq 1 && -n "$old_target" ]]; then
    start_release "$old_target"
  fi
}

cleanup_remote() {
  local rc=$?
  local cleanup_rc=0

  restore_old_on_failure "$rc" || cleanup_rc=1

  if [[ "$incoming_created" -eq 1 ]]; then
    remove_exact_tree "$incoming" || cleanup_rc=1
  fi
  if [[ "$release_created" -eq 1 && "$current_switched" -eq 0 ]]; then
    remove_exact_tree "$release_dir" || cleanup_rc=1
  fi
  if [[ -n "$next_current" && ( -e "$next_current" || -L "$next_current" ) ]]; then
    if [[ -L "$next_current" ]]; then unlink "$next_current" || cleanup_rc=1; else cleanup_rc=1; fi
  fi
  if [[ -e "$remote_archive" || -L "$remote_archive" ]]; then
    if [[ -L "$remote_archive" || ! -f "$remote_archive" ]]; then
      printf '%s\n' "远端 archive 类型不安全，拒绝清理" >&2
      cleanup_rc=1
    else
      unlink "$remote_archive" || cleanup_rc=1
    fi
  fi

  trap - EXIT HUP INT TERM
  if [[ "$cleanup_rc" -ne 0 && "$rc" -eq 0 ]]; then
    rc=41
  fi
  if [[ "$rc" -eq 0 ]]; then
    printf '%s\n' DEPLOY_REMOTE_TEMP_CLEANUP=PASS
  else
    printf '%s\n' DEPLOY_REMOTE_TEMP_CLEANUP=FAIL >&2
  fi
  exit "$rc"
}

trap cleanup_remote EXIT
trap 'exit 130' INT TERM HUP

mkdir -p "$releases" "$base/data" "$base/logs"
chmod 700 "$base" "$releases" "$base/data" "$base/logs"

if [[ -L "$current" ]]; then
  old_target="$(readlink "$current")"
elif [[ -e "$current" ]]; then
  printf '%s\n' CURRENT_NOT_SYMLINK >&2
  exit 22
fi

remote_bundle_sha="$(shasum -a 256 "$remote_archive" | awk '{print $1}')"
[[ "$remote_bundle_sha" == "$bundle_sha256" ]] || { printf '%s\n' REMOTE_BUNDLE_SHA_MISMATCH >&2; exit 23; }

if [[ -e "$release_dir" || -L "$release_dir" ]]; then
  [[ -d "$release_dir" && ! -L "$release_dir" ]] || { printf '%s\n' RELEASE_TYPE_INVALID >&2; exit 24; }
  [[ -d "$release_app" && ! -L "$release_app" ]] || { printf '%s\n' RELEASE_APP_MISSING >&2; exit 25; }
  [[ -f "$release_app/Contents/Resources/app.asar" && ! -L "$release_app/Contents/Resources/app.asar" ]] || { printf '%s\n' RELEASE_ASAR_MISSING >&2; exit 26; }
  [[ -f "$metadata" && ! -L "$metadata" ]] || { printf '%s\n' RELEASE_METADATA_MISSING >&2; exit 27; }
  [[ "$(stat -f '%Lp' "$metadata")" == 600 ]] || { printf '%s\n' RELEASE_METADATA_MODE_INVALID >&2; exit 28; }
  recorded_commit="$(awk -F= '$1 == "commit_sha" {print $2}' "$metadata")"
  recorded_bundle="$(awk -F= '$1 == "bundle_sha256" {print $2}' "$metadata")"
  recorded_asar="$(awk -F= '$1 == "asar_sha256" {print $2}' "$metadata")"
  [[ "$recorded_commit" == "$commit_sha" ]] || { printf '%s\n' RELEASE_COMMIT_MISMATCH >&2; exit 29; }
  [[ "$recorded_bundle" == "$bundle_sha256" ]] || { printf '%s\n' RELEASE_BUNDLE_SHA_MISMATCH >&2; exit 30; }
  [[ "$recorded_asar" == "$app_asar_sha256" ]] || { printf '%s\n' RELEASE_ASAR_SHA_MISMATCH >&2; exit 31; }
  remote_asar_sha="$(shasum -a 256 "$release_app/Contents/Resources/app.asar" | awk '{print $1}')"
  [[ "$remote_asar_sha" == "$app_asar_sha256" ]] || { printf '%s\n' RELEASE_ASAR_CONTENT_MISMATCH >&2; exit 32; }
  printf '%s\n' RELEASE_REUSED_AFTER_METADATA_VERIFICATION
else
  [[ ! -e "$incoming" && ! -L "$incoming" ]] || { printf '%s\n' INCOMING_EXISTS >&2; exit 33; }
  mkdir "$incoming"
  incoming_created=1
  ditto -x -k "$remote_archive" "$incoming"
  candidate="$incoming/Music Bridge for Roon.app"
  [[ -d "$candidate" && ! -L "$candidate" ]] || { printf '%s\n' BUNDLE_APP_MISSING >&2; exit 34; }
  [[ -f "$candidate/Contents/Resources/app.asar" && ! -L "$candidate/Contents/Resources/app.asar" ]] || { printf '%s\n' BUNDLE_ASAR_MISSING >&2; exit 35; }
  remote_asar_sha="$(shasum -a 256 "$candidate/Contents/Resources/app.asar" | awk '{print $1}')"
  [[ "$remote_asar_sha" == "$app_asar_sha256" ]] || { printf '%s\n' BUNDLE_ASAR_SHA_MISMATCH >&2; exit 36; }
  mkdir "$release_dir"
  release_created=1
  mv "$candidate" "$release_app"
  umask 077
  printf 'commit_sha=%s\nbundle_sha256=%s\nasar_sha256=%s\n' "$commit_sha" "$bundle_sha256" "$app_asar_sha256" > "$metadata"
  chmod 600 "$metadata"
  rmdir "$incoming"
  incoming_created=0
  printf '%s\n' RELEASE_CREATED
fi

if [[ -n "$old_target" ]]; then
  [[ -d "$old_target/Music Bridge for Roon.app" ]] || { printf '%s\n' OLD_RELEASE_MISSING >&2; exit 37; }
  old_pids="$(release_pids "$old_target")"
  if [[ -n "$old_pids" ]]; then
    old_was_running=1
    stop_release "$old_target"
  fi
fi
printf '%s\n' OLD_APP_STOPPED=1

next_current="$base/.current-$run_id"
[[ ! -e "$next_current" && ! -L "$next_current" ]]
ln -s "$release_dir" "$next_current"
if [[ -L "$current" ]]; then
  current_mutated=1
  unlink "$current"
elif [[ -e "$current" ]]; then
  printf '%s\n' CURRENT_NOT_SYMLINK >&2
  exit 38
fi
mv "$next_current" "$current"
current_switched=1
[[ "$(readlink "$current")" == "$release_dir" ]]

start_release "$release_dir"
new_process_count=""
for _ in $(jot 40 1); do
  new_process_count="$(release_pids "$release_dir")"
  [[ -n "$new_process_count" ]] && break
  sleep 0.5
done
[[ -n "$new_process_count" ]] || { printf '%s\n' NEW_APP_NOT_RUNNING >&2; exit 39; }

health='FAIL'
for _ in $(jot 20 1); do
  if curl -fsS --max-time 5 http://127.0.0.1:38501/health >/dev/null 2>&1; then
    health='PASS'
    break
  fi
  sleep 1
done
[[ "$health" == PASS ]] || { printf '%s\n' HEALTH_HTTP_FAIL >&2; exit 40; }

for port in 38501 38502; do
  loopback_count="$(lsof -nP -iTCP:"$port" -sTCP:LISTEN 2>/dev/null | awk 'NR > 1 {if ($9 ~ /^127[.]0[.]0[.]1:/) count++} END {print count+0}')"
  non_loopback_count="$(lsof -nP -iTCP:"$port" -sTCP:LISTEN 2>/dev/null | awk 'NR > 1 {if ($9 !~ /^127[.]0[.]0[.]1:/) count++} END {print count+0}')"
  [[ "$loopback_count" -gt 0 && "$non_loopback_count" -eq 0 ]] || { printf '%s\n' LOOPBACK_CHECK_FAIL >&2; exit 41; }
  printf 'PORT_%s_LOOPBACK=%s\n' "$port" "$loopback_count"
  printf 'PORT_%s_NON_LOOPBACK=%s\n' "$port" "$non_loopback_count"
done

roon_process_count="$(ps -axo command= | awk '/[R]oon/ {count++} END {print count+0}')"
[[ "$roon_process_count" -gt 0 ]] || { printf '%s\n' ROON_NOT_RUNNING >&2; exit 42; }

printf 'DEPLOY_COMMIT_SHA=%s\n' "$commit_sha"
printf 'DEPLOY_BUNDLE_SHA256=%s\n' "$bundle_sha256"
printf 'REMOTE_BUNDLE_SHA_MATCH=1\n'
printf 'REMOTE_ASAR_SHA_MATCH=1\n'
printf 'CURRENT_RELEASE_SHA=%s\n' "$(basename "$(readlink "$current")")"
printf 'NEW_APP_PROCESS_COUNT=%s\n' "$(printf '%s\n' "$new_process_count" | wc -l | tr -d ' ')"
printf 'ROON_PROCESS_COUNT=%s\n' "$roon_process_count"
printf 'HEALTH_HTTP=PASS\n'
release_created=0
current_switched=0
current_mutated=0
REMOTE
