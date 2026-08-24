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
    '重新读取',
    '退出登录',
    '每日推荐',
    '打开网易云账户设置',
    '登录仍然有效',
    '登录已过期',
    '重新扫码',
    '我喜欢的音乐',
    '所有歌单',
    '加载更多歌曲',
    '同步歌词',
    '正在播放',
    '歌词只在内存中处理',
  ]) {
    assert.match(source, new RegExp(text))
  }
  assert.match(source, /SEARCH_DEBOUNCE_MS/)
  assert.match(source, /searchRequestGeneration/)
  assert.match(source, /likedRequestGeneration/)
  assert.match(source, /playlistRequestGeneration/)
  assert.match(source, /loading="lazy"/)
  assert.doesNotMatch(source, /NETEASE_COOKIE|MUSIC_U|__csrf|Authorization|Bearer|rawProviderResponse/)
  assert.match(source, /lyricsSnapshot/)
  assert.match(source, /lyrics.changed/)
  assert.match(source, /activeLineIndex/)
})

test('Renderer exposes the v2 Music Source Sidebar information architecture', async () => {
  const source = (await sourceFiles(rendererRoot)).map((file) => readFile(file, 'utf8'))
  const combinedSource = (await Promise.all(source)).join('\n')

  for (const text of [
    'MusicSidebar.vue',
    'SidebarSearch.vue',
    'SidebarPlaylistList.vue',
    'ZonePopover.vue',
    'useLibrarySources',
    'useZoneSelection',
    '发现',
    '主页',
    '资料库',
    '我喜欢的音乐',
    '所有歌单',
    '搜索歌曲或歌手',
    '播放设备',
    'SidebarAccountFooter.vue',
    'sidebar-account-footer',
    'getAccountState',
    'account.changed',
    'toolbar-status-popover',
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
  assert.match(combinedSource, /SidebarAccountFooter|sidebar-account-footer/)
  assert.doesNotMatch(combinedSource, />\s*Pause\s*</)
  assert.doesNotMatch(combinedSource, />\s*Seek\s*</)
})

test('Renderer keeps internal destinations available only through their v2 entry points', async () => {
  const files = await sourceFiles(rendererRoot)
  const combinedSource = (await Promise.all(files.map((file) => readFile(file, 'utf8')))).join('\n')

  assert.match(combinedSource, /currentView === ['"]search['"]|currentView === ['"]liked['"]|currentView === ['"]playlists['"]/)
  assert.match(combinedSource, /handleSidebarAccount/)
  assert.match(combinedSource, /account-settings-hero/)
  assert.match(combinedSource, /refreshAccountProfile/)
  assert.match(combinedSource, /beginQrLogin/)
  assert.match(combinedSource, /navigate\('diagnostics'\)/)
  assert.match(combinedSource, /function openNowPlaying|open-now-playing/)
  assert.match(combinedSource, /function openQueue|open-queue/)
  assert.match(combinedSource, /SidebarPlaylistRow\.vue/)
})

test('Playlist detail exposes loading and retry states instead of retaining stale content', async () => {
  const source = await readFile(path.resolve('src/renderer/src/App.vue'), 'utf8')
  const detailStart = source.indexOf("currentView === 'playlist-detail'")
  const nextViewStart = source.indexOf("currentView === 'now-playing'")
  assert.ok(detailStart >= 0)
  assert.ok(nextViewStart > detailStart)

  const detailTemplate = source.slice(detailStart, nextViewStart)
  assert.match(detailTemplate, /playlistInitialLoading/)
  assert.match(detailTemplate, /playlistDetailError/)
  assert.match(detailTemplate, /重试/)
})

test('Playlist detail renders artworkUrl covers with a music-note fallback', async () => {
  const source = await readFile(path.resolve('src/renderer/src/App.vue'), 'utf8')
  const detailStart = source.indexOf("currentView === 'playlist-detail'")
  const nextViewStart = source.indexOf("currentView === 'now-playing'")
  assert.ok(detailStart >= 0)
  assert.ok(nextViewStart > detailStart)

  const rendererSource = (await Promise.all((await sourceFiles(rendererRoot)).map((file) => readFile(file, 'utf8')))).join('\n')
  assert.match(rendererSource, /TrackTable\.vue/)
  assert.match(rendererSource, /artworkUrl/)
  assert.match(rendererSource, /music-note fallback|♪/)
})

test('Renderer uses the clean-room player landmarks without importing the reference runtime', async () => {
  const files = await sourceFiles(rendererRoot)
  const source = (await Promise.all(files.map((file) => readFile(file, 'utf8')))).join('\n')

  for (const landmark of ['home-browse-header', 'home-cover-wall', 'now-playing-immersive', 'lyrics-panel', 'global-player', 'player-controls']) {
    assert.match(source, new RegExp(landmark))
  }
  assert.match(source, /data-ui-reference=["']simple-music-player-2["']/)
  assert.doesNotMatch(source, /flutter|dart|pocketbase|ffmpeg|download-manager/i)
})

test('Homepage renders random playlist covers with a refresh action', async () => {
  const homeSource = await readFile(path.resolve('src/renderer/src/components/HomeView.vue'), 'utf8')
  const appSource = await readFile(path.resolve('src/renderer/src/App.vue'), 'utf8')

  assert.match(homeSource, /playlistTracks/)
  assert.match(homeSource, /home-cover-wall/)
  assert.match(homeSource, /refreshPlaylists/)
  assert.match(appSource, /selectRandomPlaylistPages/)
  assert.match(appSource, /getPlaylist\(selection\.playlistId, selection\.page\)/)
  assert.match(appSource, /@refresh-playlists="refreshHomeRecommendations"/)
  assert.match(homeSource, /DailyRecommendationsSection/)
  assert.match(homeSource, /dailyTracks/)
  assert.match(appSource, /getDailyRecommendations/)
})

test('Homepage is cover-first and keeps playback controls out of the content layer', async () => {
  const homeSource = await readFile(path.resolve('src/renderer/src/components/HomeView.vue'), 'utf8')
  const appSource = await readFile(path.resolve('src/renderer/src/App.vue'), 'utf8')

  assert.match(homeSource, /home-browse-header/)
  assert.match(homeSource, /home-cover-wall/)
  assert.doesNotMatch(homeSource, /hero-zone|overview-grid|selectedZone|Now Playing/)
  assert.match(appSource, /<BottomPlayer\b/)
  assert.doesNotMatch(appSource, /<SidebarZoneButton\b|<footer class="app-footer"|playback-zone-dock/)
})

test('Liquid Glass v3 keeps content lists continuous and the global player owns Zone', async () => {
  const files = await sourceFiles(rendererRoot)
  const combinedSource = (await Promise.all(files.map((file) => readFile(file, 'utf8')))).join('\n')
  const appSource = await readFile(path.resolve('src/renderer/src/App.vue'), 'utf8')

  assert.match(combinedSource, /TrackTable\.vue/)
  assert.match(appSource, /<TrackTable\b/)
  assert.match(combinedSource, /contextmenu|Context Menu|右键菜单/)
  assert.match(combinedSource, /dblclick|双击播放/)
  assert.match(combinedSource, /ZoneControl\.vue/)
  assert.match(combinedSource, /<ZoneControl\b/)
  assert.doesNotMatch(appSource, /<SidebarZoneButton\b|playback-zone-dock/)
})

test('Liquid Glass v4 uses one neutral graphite theme and never rotates the album ambient', async () => {
  const css = await readFile(path.resolve('src/renderer/src/style.css'), 'utf8')

  assert.equal((css.match(/:root\s*\{/g) ?? []).length, 1)
  assert.match(css, /--mb-bg-deep:\s*#0e1217/)
  assert.match(css, /--mb-accent:\s*#64d2ff/)
  assert.doesNotMatch(css, /radial-gradient\(/)
  assert.doesNotMatch(css, /album-ambient-rotate|rotate\(/)
  assert.doesNotMatch(css, /#a9bcff|#c5d2ff|#6e8fff|#8aa8ff/)
})

test('V1 Bottom Player stays compact, semantic, and free of transient lyric or state copy', async () => {
  const player = await readFile(path.resolve('src/renderer/src/components/BottomPlayer.vue'), 'utf8')
  const icon = await readFile(path.resolve('src/renderer/src/components/sidebar/SidebarIcon.vue'), 'utf8')
  const css = await readFile(path.resolve('src/renderer/src/style.css'), 'utf8')

  assert.doesNotMatch(player, /player-label|currentLyricLine|音质切换/)
  assert.match(player, /下次音质/)
  assert.match(player, /name="previous"/)
  assert.match(player, /name="next"/)
  assert.match(player, /name="list"/)
  assert.match(player, /visually-hidden/)
  assert.match(icon, /name === 'previous'/)
  assert.match(icon, /name === 'next'/)
  assert.match(css, /\.global-player\s*\{[^}]*height:\s*74px/)
  assert.match(css, /\.player-art\s*\{[^}]*width:\s*46px[^}]*height:\s*46px/)
})

test('V1 Home and content pages use page-level width tiers and avoid a duplicate Home title', async () => {
  const app = await readFile(path.resolve('src/renderer/src/App.vue'), 'utf8')
  const settings = await readFile(path.resolve('src/renderer/src/components/settings/SettingsView.vue'), 'utf8')
  const css = await readFile(path.resolve('src/renderer/src/style.css'), 'utf8')

  assert.match(app, /<h1 v-if="currentView !== 'home'">\{\{ viewTitle \}\}<\/h1>/)
  assert.match(app, /class="view view-search"/)
  assert.match(app, /class="view view-library"/)
  assert.match(app, /class="view view-diagnostics"/)
  assert.match(settings, /view-settings/)
  assert.match(css, /\.home-view\s*\{[^}]*max-width:\s*1600px/)
  assert.match(css, /\.view-search\s*,\s*\.view-library\s*,\s*\.view-playlist\s*\{[^}]*max-width:\s*1520px/)
  assert.match(css, /\.view-settings\s*\{[^}]*max-width:\s*1280px/)
  assert.match(css, /\.view-diagnostics\s*\{[^}]*max-width:\s*1100px/)
})

test('V1 Settings exposes focused Chinese category panes and hides development details in production', async () => {
  const settings = await readFile(path.resolve('src/renderer/src/components/settings/SettingsView.vue'), 'utf8')

  for (const label of ['账户', '播放', 'Roon', '应用', '高级']) {
    assert.match(settings, new RegExp(label))
  }
  assert.match(settings, /settings-category-tabs/)
  assert.match(settings, /role="tablist"/)
  assert.match(settings, /role="tab"/)
  assert.match(settings, /aria-selected/)
  assert.match(settings, /settings-pane-account/)
  assert.match(settings, /settings-pane-playback/)
  assert.match(settings, /settings-pane-roon/)
  assert.match(settings, /settings-pane-application/)
  assert.match(settings, /settings-pane-advanced/)
  assert.doesNotMatch(settings, /Apple Liquid Glass/)
  assert.match(settings, /buildMode === 'development'/)
})

test('V1 Search is an artist, track and album flow without playlist results', async () => {
  const app = await readFile(path.resolve('src/renderer/src/App.vue'), 'utf8')
  const search = await readFile(path.resolve('src/renderer/src/composables/search.ts'), 'utf8')
  const contracts = await readFile(path.resolve('../../packages/contracts/src/library.ts'), 'utf8')

  for (const label of ['艺人', '单曲', '专辑', 'openSearchDetail', 'searchSnapshotLoader']) {
    assert.match(app, new RegExp(label))
  }
  assert.match(app, /searchArtists|search-albums/)
  assert.match(search, /Promise\.allSettled/)
  assert.match(search, /stale/)
  assert.match(contracts, /ArtistSummary/)
  assert.match(contracts, /AlbumSummary/)
  assert.match(contracts, /SearchSnapshot/)
  assert.doesNotMatch(app, /搜索结果.*歌单|search-playlist|搜索歌单/)
})

test('V1 search shows album results before artwork-backed single rows', async () => {
  const app = await readFile(path.resolve('src/renderer/src/App.vue'), 'utf8')
  const trackTable = await readFile(path.resolve('src/renderer/src/components/media/TrackTable.vue'), 'utf8')

  assert.match(app, /class="search-track-results"/)
  assert.match(app, /:show-artwork="true"/)
  const albumIndex = app.indexOf('aria-labelledby="search-albums-heading"')
  const trackIndex = app.indexOf('aria-labelledby="search-tracks-heading"')
  assert.ok(albumIndex >= 0 && albumIndex < trackIndex)
  assert.match(trackTable, /showArtwork/)
  assert.match(trackTable, /v-if="props\.showArtwork"/)
})

test('V1 Now Playing centers a real-quality disclosure without a quality switcher', async () => {
  const app = await readFile(path.resolve('src/renderer/src/App.vue'), 'utf8')
  const nowPlaying = await readFile(path.resolve('src/renderer/src/components/NowPlayingView.vue'), 'utf8')
  const css = await readFile(path.resolve('src/renderer/src/style.css'), 'utf8')
  const nowPlayingUsage = app.match(/<NowPlayingView[\s\S]*?\/>/)?.[0] ?? ''

  assert.doesNotMatch(nowPlaying, /下次播放音质|now-playing-quality-next/)
  assert.doesNotMatch(nowPlaying, /PLAYBACK_QUALITY_PREFERENCES/)
  assert.doesNotMatch(nowPlaying, /role="menuitemradio"|now-playing-quality-menu/)
  assert.doesNotMatch(nowPlaying, /update:selected-quality|selectedQuality: PlaybackQualityPreference/)
  assert.match(nowPlaying, /props\.playbackState\?\.actualQuality/)
  assert.match(nowPlaying, /props\.playbackState\?\.bitrate/)
  assert.match(nowPlaying, /formatBitrate|kbps/)
  assert.doesNotMatch(nowPlayingUsage, /:selected-quality="selectedQuality"/)
  assert.doesNotMatch(nowPlayingUsage, /@update:selected-quality=/)
  assert.match(css, /\.now-playing-quality-row\s*\{[^}]*justify-content:\s*center/)
})

test('V1 large track and queue lists use a bounded virtual window', async () => {
  const files = await sourceFiles(rendererRoot)
  const source = (await Promise.all(files.map((file) => readFile(file, 'utf8')))).join('\n')
  assert.match(source, /calculateVirtualWindow/)
  assert.match(source, /VIRTUALIZATION_THRESHOLD/)
  assert.match(source, /QUEUE_VIRTUALIZATION_THRESHOLD/)
  assert.match(source, /is-virtualized/)
})
