#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/../.." && pwd)"

cd "$REPO_ROOT"

node_version="$(node --version)"
case "$node_version" in
  v22.*) ;;
  *)
    printf '%s\n' "需要 Node.js 22.x，当前为 $node_version" >&2
    exit 2
    ;;
esac

# 构建和生产依赖安装不得继承本地凭据环境变量。
unset NETEASE_COOKIE

printf '%s\n' "[bundle] npm ci"
npm ci
printf '%s\n' "[bundle] npm run verify"
npm run verify
printf '%s\n' "[bundle] npm run build"
npm run build

commit_sha="$(git rev-parse HEAD)"
if [[ ! "$commit_sha" =~ ^[0-9a-f]{40}$ ]]; then
  printf '%s\n' "无法取得完整 Git commit SHA" >&2
  exit 3
fi

printf '%s\n' "BUNDLE_COMMIT_SHA=$commit_sha"

tmp_root="${TMPDIR:-/tmp}"
if [[ "$tmp_root" != "/" ]]; then
  tmp_root="${tmp_root%/}"
fi
stage_parent="$(mktemp -d "$tmp_root/musicbridge-agent-stage.XXXXXX")"
stage_dir="$stage_parent/staging"
printf '%s\n' "BUNDLE_STAGE_PARENT=$stage_parent"
mkdir "$stage_dir"

cp -R dist "$stage_dir/dist"
cp -p package.json package-lock.json "$stage_dir/"

printf '%s\n' "[bundle] production npm ci --omit=dev"
(
  cd "$stage_dir"
  unset NETEASE_COOKIE
  npm ci --omit=dev --ignore-scripts
)

# 个别上游包会带入开发用 lint.log；只从临时 staging 移除，不改本地依赖目录。
find "$stage_dir" -type f -name '*.log' -delete
# 生产依赖也可能带入 .env.example；运行时不需要任何环境文件。
find "$stage_dir" -type f \( -name '.env' -o -name '.env.*' \) -delete

allowed_top_level='dist node_modules package.json package-lock.json'
for entry in "$stage_dir"/*; do
  name="$(basename "$entry")"
  case " $allowed_top_level " in
    *" $name "*) ;;
    *)
      printf '%s\n' "bundle 含未允许的顶层路径: $name" >&2
      exit 4
      ;;
  esac
done

forbidden_path="$(find "$stage_dir" -type f \( \
  -name '.env' -o -name '.env.*' -o -name '*.log' -o -name '*.mp3' -o \
  -name '*.flac' -o -name '*.wav' -o -name '*.m4a' -o -name '*.aac' -o \
  -name '*.ogg' -o -name '*.opus' -o -name '*.dsf' -o -name '*.dff' \
\) -print -quit)"
if [[ -n "$forbidden_path" ]]; then
  printf '%s\n' "bundle 含禁止文件类型" >&2
  exit 5
fi

project_scan_paths=(dist package.json package-lock.json)
if rg -n --hidden \
  -e '(^|[[:space:]])(NETEASE_COOKIE|MUSIC_U|__csrf)[[:space:]]*=[[:space:]]*[^[:space:]]+' \
  "${project_scan_paths[@]/#/$stage_dir/}" >/dev/null; then
  printf '%s\n' "bundle 含疑似凭据赋值" >&2
  exit 6
fi

if rg -n --hidden \
  -e 'https?://[^[:space:]]+[?&](token|auth|signature|sign|key|expires)=' \
  "${project_scan_paths[@]/#/$stage_dir/}" >/dev/null; then
  printf '%s\n' "bundle 含疑似带签名参数的完整 URL" >&2
  exit 7
fi

native_modules="$(find "$stage_dir/node_modules" -type f -name '*.node' -print | wc -l | tr -d ' ')"
archive="$stage_parent/music-bridge-agent-$commit_sha.tar.gz"
COPYFILE_DISABLE=1 tar -czf "$archive" -C "$stage_dir" \
  dist node_modules package.json package-lock.json
bundle_sha256="$(shasum -a 256 "$archive" | awk '{print $1}')"

printf '%s\n' "BUNDLE_ARCHIVE=$archive"
printf '%s\n' "BUNDLE_SHA256=$bundle_sha256"
printf '%s\n' "BUNDLE_NODE_VERSION=$node_version"
printf '%s\n' "BUNDLE_CPU_ARCH=$(uname -m)"
printf '%s\n' "BUNDLE_NATIVE_MODULES=$native_modules"
