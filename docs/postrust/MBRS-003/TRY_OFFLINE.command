#!/bin/zsh
set -eu
umask 077

if ! /sbin/mount | /usr/bin/grep -Fq ' on /Volumes/LifeWeave ('; then
  print -u2 'LifeWeave外置卷未挂载，不能启动试用。'
  exit 1
fi
desktop='/Volumes/LifeWeave/Developer/CommandLine/tmp/mb-postrust-v12-j0tjux6s/mbrs003-root-selected18-package-cli-37-01/workspace/apps/desktop'
electron='/Volumes/LifeWeave/VSCode/MusicBridge/worktree/mbrs-002-local-source-contracts/node_modules/.pnpm/electron@43.4.0/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'
runs='/Volumes/LifeWeave/Developer/CommandLine/tmp/mb-postrust-v12-j0tjux6s/mbrs003-offline-trial-155-01/runs'
if [[ ! -x "$electron" || ! -f "$desktop/dist/main/index.js" || ! -d "$runs" || ! -w "$runs" ]]; then
  print -u2 '试用运行时或外置目录不可用，请检查交接说明中的路径。'
  exit 1
fi
trial=$(/usr/bin/mktemp -d "$runs/trial-XXXXXX")
/bin/mkdir "$trial/tmp" "$trial/tmp/musicbridge-ui-e2e-trial" "$trial/config" "$trial/cache"
print '离线试用已启动。从菜单栏托盘选择 Open Music Bridge 显示窗口，选择 Quit Music Bridge 退出。'
print '本次使用独立目录、合成服务和模拟钥匙串。真实曲库和实际播放留待最终验收。'
cd "$desktop"
exec /usr/bin/env -i   PATH='/usr/bin:/bin:/usr/sbin:/sbin'   LANG='en_US.UTF-8'   TMPDIR="$trial/tmp"   XDG_CONFIG_HOME="$trial/config"   XDG_CACHE_HOME="$trial/cache"   MUSIC_BRIDGE_UI_E2E=1   MUSIC_BRIDGE_UI_E2E_OFFLINE=1   MUSIC_BRIDGE_CORE_TEST_MODE=1   MUSIC_BRIDGE_TEST_KEYCHAIN_MODE=mock   MUSIC_BRIDGE_UI_E2E_USER_DATA_DIR="$trial/tmp/musicbridge-ui-e2e-trial"   "$electron" "$desktop/dist/main/index.js" --use-mock-keychain   >>"$trial/app.stdout.log" 2>>"$trial/app.stderr.log"
