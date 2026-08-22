import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

const rendererRoot = path.resolve('src/renderer')

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const files: string[] = []

  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      files.push(...(await sourceFiles(entryPath)))
    } else if (/\.(ts|vue|html|css)$/.test(entry.name)) {
      files.push(entryPath)
    }
  }

  return files
}

test('Renderer source has no Node or Electron access', async () => {
  const files = await sourceFiles(rendererRoot)
  assert.ok(files.length > 0)

  for (const file of files) {
    const source = await readFile(file, 'utf8')
    assert.doesNotMatch(source, /from\s+['"](?:node:|electron)/)
    assert.doesNotMatch(source, /\b(?:require|process|__dirname|__filename)\b/)
    assert.doesNotMatch(source, /window\.require/)
  }
})

test('Renderer contains the public QR login surface without credential access', async () => {
  const files = await sourceFiles(rendererRoot)
  const source = (await Promise.all(files.map((file) => readFile(file, 'utf8')))).join('\n')

  for (const text of [
    'Music Bridge for Roon',
    'Music Bridge Core',
    '查看连接状态',
    '网易云',
    '扫码登录',
    '显示二维码',
    '退出登录',
    '我喜欢的音乐',
    '所有歌单',
    '上一页',
    '下一页',
    '同步歌词',
    'Now Playing',
    '歌词只在内存中处理',
  ]) {
    assert.match(source, new RegExp(text))
  }
  assert.match(source, /SEARCH_DEBOUNCE_MS/)
  assert.match(source, /libraryOperation/)
  assert.match(source, /loading="lazy"/)
  assert.doesNotMatch(source, /NETEASE_COOKIE|MUSIC_U|__csrf|Authorization|Bearer|rawProviderResponse/)
  assert.match(source, /lyricsSnapshot/)
  assert.match(source, /lyrics.changed/)
  assert.match(source, /activeWordIndex/)
})

test('Renderer exposes the v2 Music Source Sidebar information architecture', async () => {
  const source = (await sourceFiles(rendererRoot)).map((file) => readFile(file, 'utf8'))
  const combinedSource = (await Promise.all(source)).join('\n')

  for (const text of [
    'MusicSidebar.vue',
    'SidebarSearch.vue',
    'SidebarPlaylistList.vue',
    'ZonePopover.vue',
    'AccountMenu.vue',
    'useLibrarySources',
    'useZoneSelection',
    'useAccountMenu',
    '发现',
    '主页',
    '资料库',
    '我喜欢的音乐',
    '所有歌单',
    '搜索歌曲、歌手或歌单',
    '播放设备',
    '网易云已登录',
    'toolbar-status-popover',
    'global-player',
    'Previous',
    'Next',
    'Stop',
    'aria-current',
    'sourceScrollTop',
    'getUserPlaylists',
    'data-sidebar-playlist-state',
    'diagnosticId',
  ]) {
    assert.match(combinedSource, new RegExp(text))
  }
  assert.doesNotMatch(combinedSource, /const\s+NAV_ITEMS/)
  assert.doesNotMatch(combinedSource, /class=["']nav-item["']/)
  assert.doesNotMatch(combinedSource, /<AppSidebar\b/)
  assert.doesNotMatch(combinedSource, />\s*Pause\s*</)
  assert.doesNotMatch(combinedSource, />\s*Seek\s*</)
})

test('Renderer keeps internal destinations available only through their v2 entry points', async () => {
  const files = await sourceFiles(rendererRoot)
  const combinedSource = (await Promise.all(files.map((file) => readFile(file, 'utf8')))).join('\n')

  assert.match(combinedSource, /currentView === ['"]search['"]|currentView === ['"]liked['"]|currentView === ['"]playlists['"]/)
  assert.match(combinedSource, /action === 'login' \|\| action === 'settings'/)
  assert.match(combinedSource, /action === 'diagnostics'/)
  assert.match(combinedSource, /function openNowPlaying|open-now-playing/)
  assert.match(combinedSource, /function openQueue|open-queue/)
  assert.match(combinedSource, /SidebarPlaylistRow\.vue/)
})

test('Renderer uses the clean-room player landmarks without importing the reference runtime', async () => {
  const files = await sourceFiles(rendererRoot)
  const source = (await Promise.all(files.map((file) => readFile(file, 'utf8')))).join('\n')

  for (const landmark of ['home-hero', 'jump-back-in', 'now-playing-stage', 'lyrics-panel', 'player-progress']) {
    assert.match(source, new RegExp(landmark))
  }
  assert.match(source, /data-ui-reference=["']simple-music-player-2["']/)
  assert.doesNotMatch(source, /flutter|dart|pocketbase|ffmpeg|download-manager/i)
})
