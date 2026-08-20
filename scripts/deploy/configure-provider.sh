#!/usr/bin/env bash

set -euo pipefail

: "${CORE_SSH_TARGET:?请设置 CORE_SSH_TARGET，例如 roonstation@<verified-core-endpoint>}"

MAX_COOKIE_LENGTH=8192

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

if [[ ! -r /dev/tty ]]; then
  printf '%s\n' PROVIDER_CONFIGURE_REQUIRES_TTY >&2
  exit 2
fi

cookie=''
cleanup_local() {
  unset cookie cookie_length
}
trap cleanup_local EXIT

printf '%s' '请输入 Core Mac Provider 凭据（明文显示；请使用 ⌘V 粘贴后按 Return）： ' > /dev/tty
if ! IFS= read -r cookie < /dev/tty; then
  printf '\n%s\n' PROVIDER_CONFIGURE_INPUT_FAILED > /dev/tty
  exit 3
fi
printf '\n' > /dev/tty

export LC_ALL=C
if [[ -z "$cookie" ]]; then
  printf '%s\n' PROVIDER_CONFIGURE_EMPTY >&2
  exit 4
fi
cookie_length=${#cookie}
if (( cookie_length > MAX_COOKIE_LENGTH )); then
  printf '%s\n' PROVIDER_CONFIGURE_TOO_LONG >&2
  exit 5
fi

remote_script="$(cat <<'REMOTE'
set -eu
base="$HOME/Library/Application Support/MusicBridgeAgent"
data_dir="$base/data"
cookie_file="$data_dir/netease.cookie"
max_cookie_length=8192
tmp_file=''

cleanup_remote() {
  if [ -n "$tmp_file" ]; then
    case "$tmp_file" in
      "$data_dir"/.netease.cookie.??????)
        if [ -e "$tmp_file" ] || [ -L "$tmp_file" ]; then
          rm -f "$tmp_file"
        fi
        ;;
    esac
  fi
}
trap cleanup_remote EXIT

umask 077
mkdir -p "$data_dir"
chmod 700 "$base" "$data_dir"
tmp_file="$(mktemp "$data_dir/.netease.cookie.XXXXXX")"
[ -f "$tmp_file" ] && [ ! -L "$tmp_file" ] || { printf '%s\n' PROVIDER_CONFIGURE_TEMP_INVALID >&2; exit 10; }

cat > "$tmp_file"
chmod 600 "$tmp_file"
mode="$(stat -f '%Lp' "$tmp_file" 2>/dev/null || true)"
[ "$mode" = 600 ] || { printf '%s\n' PROVIDER_CONFIGURE_MODE_INVALID >&2; exit 11; }

size="$(wc -c < "$tmp_file" | tr -d '[:space:]')"
case "$size" in
  ''|*[!0-9]*) printf '%s\n' PROVIDER_CONFIGURE_SIZE_INVALID >&2; exit 12 ;;
esac
if [ "$size" -lt 1 ] || [ "$size" -gt "$max_cookie_length" ]; then
  printf '%s\n' PROVIDER_CONFIGURE_SIZE_INVALID >&2
  exit 12
fi
if LC_ALL=C grep -q '[[:cntrl:]]' "$tmp_file"; then
  printf '%s\n' PROVIDER_CONFIGURE_CONTENT_INVALID >&2
  exit 13
fi

if [ -e "$cookie_file" ] || [ -L "$cookie_file" ]; then
  if [ -L "$cookie_file" ] || [ ! -f "$cookie_file" ]; then
    printf '%s\n' PROVIDER_CONFIGURE_TARGET_INVALID >&2
    exit 14
  fi
fi

mv -f "$tmp_file" "$cookie_file"
tmp_file=''
[ -f "$cookie_file" ] && [ ! -L "$cookie_file" ] || { printf '%s\n' PROVIDER_CONFIGURE_TARGET_INVALID >&2; exit 15; }
[ "$(stat -f '%Lp' "$cookie_file" 2>/dev/null || true)" = 600 ] || { printf '%s\n' PROVIDER_CONFIGURE_MODE_INVALID >&2; exit 16; }
final_size="$(wc -c < "$cookie_file" | tr -d '[:space:]')"
case "$final_size" in
  ''|*[!0-9]*) printf '%s\n' PROVIDER_CONFIGURE_SIZE_INVALID >&2; exit 17 ;;
esac
if [ "$final_size" -lt 1 ] || [ "$final_size" -gt "$max_cookie_length" ]; then
  printf '%s\n' PROVIDER_CONFIGURE_SIZE_INVALID >&2
  exit 17
fi
if LC_ALL=C grep -q '[[:cntrl:]]' "$cookie_file"; then
  printf '%s\n' PROVIDER_CONFIGURE_CONTENT_INVALID >&2
  exit 18
fi

printf '%s\n' PROVIDER_CONFIGURED
REMOTE
)"

set +e
printf '%s' "$cookie" | ssh "${SSH_ARGS[@]}" "$CORE_SSH_TARGET" "$remote_script"
ssh_status=${PIPESTATUS[1]}
set -e
unset cookie
exit "$ssh_status"
