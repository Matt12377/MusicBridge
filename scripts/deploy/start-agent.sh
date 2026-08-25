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
[ -f "$release_dir/package.json" ] || { printf "%s\n" CURRENT_RELEASE_NOT_READY >&2; exit 30; }

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

if [ -n "$netease_cookie" ]; then
  MUSICBRIDGE_RELEASE_DIR="$release_dir" \
    MUSICBRIDGE_CREDENTIAL_FILE="$credential_file" \
    ENABLE_GENERAL_UNBLOCK=false \
    ENABLE_PROXY=false \
    ENABLE_RANDOM_CN_IP=false \
    "$node_bin" <<'NODE'
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createRequire } = require('node:module')

const releaseDir = process.env.MUSICBRIDGE_RELEASE_DIR
const credentialFile = process.env.MUSICBRIDGE_CREDENTIAL_FILE
const targetPath = path.join(os.tmpdir(), 'xeapi_public_key')
const safeWrite = (line) => process.stdout.write(`${line}\n`)

function readValidKey(filePath, expectedDeviceId) {
  try {
    const stat = fs.lstatSync(filePath)
    if (!stat.isFile() || stat.isSymbolicLink()) return undefined
    if ((stat.mode & 0o777) !== 0o600) return undefined
    const raw = fs.readFileSync(filePath, 'utf8')
    if (raw.length < 1 || raw.length > 64 * 1024) return undefined
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return undefined
    if (typeof parsed.sk !== 'string' || parsed.sk.length === 0) return undefined
    if (parsed.deviceId !== expectedDeviceId) return undefined
    return parsed
  } catch {
    return undefined
  }
}

async function main() {
  if (!releaseDir) throw new Error('XEAPI_RELEASE_DIR_MISSING')
  if (!credentialFile) throw new Error('XEAPI_CREDENTIAL_FILE_MISSING')
  const requireFromRelease = createRequire(path.join(releaseDir, 'package.json'))
  const { cookieToJson } = requireFromRelease(
    '@neteasecloudmusicapienhanced/api/util/index.js',
  )
  const credential = cookieToJson(fs.readFileSync(credentialFile, 'utf8'))
  const deviceId =
    credential.deviceId || credential.sDeviceId || credential._ntes_nuid || ''
  if (typeof deviceId !== 'string' || deviceId.length === 0) {
    throw new Error('XEAPI_DEVICE_ID_MISSING')
  }

  const existing = readValidKey(targetPath, deviceId)
  if (existing) {
    safeWrite('XEAPI_PUBLIC_KEY_STATUS=ready')
    return
  }

  if (fs.existsSync(targetPath)) {
    const stat = fs.lstatSync(targetPath)
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error('XEAPI_PUBLIC_KEY_TARGET_INVALID')
    }
  }

  const { getXeapiPublicKey } = requireFromRelease(
    '@neteasecloudmusicapienhanced/api/util/xeapiKey.js',
  )
  if (typeof getXeapiPublicKey !== 'function') {
    throw new Error('XEAPI_KEY_PROVIDER_MISSING')
  }

  console.log = () => {}
  console.error = () => {}
  const timeout = setTimeout(() => {
    process.stderr.write('XEAPI_PUBLIC_KEY_BOOTSTRAP_TIMEOUT\n')
    process.exit(73)
  }, 15_000)
  let publicKey
  try {
    publicKey = await getXeapiPublicKey({}, deviceId)
  } finally {
    clearTimeout(timeout)
  }
  if (!publicKey || typeof publicKey !== 'object') {
    throw new Error('XEAPI_PUBLIC_KEY_RESPONSE_INVALID')
  }
  if (typeof publicKey.sk !== 'string' || publicKey.sk.length === 0) {
    throw new Error('XEAPI_PUBLIC_KEY_RESPONSE_INVALID')
  }

  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'musicbridge-xeapi-key.'),
  )
  try {
    const tempPath = path.join(tempDir, 'xeapi_public_key')
    fs.writeFileSync(tempPath, JSON.stringify(publicKey), {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    })
    fs.chmodSync(tempPath, 0o600)
    if (!readValidKey(tempPath, deviceId)) {
      throw new Error('XEAPI_PUBLIC_KEY_TEMP_INVALID')
    }
    fs.renameSync(tempPath, targetPath)
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }

  if (!readValidKey(targetPath, deviceId)) {
    throw new Error('XEAPI_PUBLIC_KEY_TARGET_INVALID')
  }
  safeWrite('XEAPI_PUBLIC_KEY_STATUS=ready')
}

main().catch((error) => {
  const code =
    error instanceof Error && /^XEAPI_[A-Z_]+$/.test(error.message)
      ? error.message
      : 'XEAPI_PUBLIC_KEY_BOOTSTRAP_FAILED'
  process.stderr.write(`${code}\n`)
  process.exitCode = 72
})
NODE
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
    ROON_CORE_HOST=127.0.0.1 \
    ROON_CORE_PORT=9330 \
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
