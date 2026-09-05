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
    '打开设置',
    '登录仍然有效',
    '登录已过期',
    '重新扫码',
    '我喜欢的音乐',
    '所有歌单',
    '加载更多歌曲',
    '同步歌词',
    '正在播放',
    'now-playing-like',
    'toggleTrackLike',
    'getTrackLikeStatus',
    'setTrackLiked',
    'searchRoonLibrary',
    'matchLibraryTrack',
    'Roon 本地结果',
    'Roon 已匹配',
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

test('Lyrics follow uses explicit programmatic and user scroll states', async () => {
  const source = await readFile(
    path.resolve('src/renderer/src/components/LyricsLines.vue'),
    'utf8',
  )

  for (const state of [
    'following',
    'programmatic-scrolling',
    'user-scrolling',
    'settling',
  ]) {
    assert.match(source, new RegExp(`['"]${state}['"]`))
  }
  assert.match(source, /@scrollend="onScrollEnd"/)
  assert.match(source, /@wheel="beginUserScroll"/)
  assert.match(source, /@touchstart="beginUserScroll"/)
  assert.match(source, /@pointerdown="beginUserScroll"/)
})

test('Local lyrics manual matching uses an accessible project-native drawer without exposing engineering data', async () => {
  const panel = await readFile(path.resolve('src/renderer/src/components/LyricsPanel.vue'), 'utf8')
  const nowPlaying = await readFile(path.resolve('src/renderer/src/components/NowPlayingView.vue'), 'utf8')
  const drawer = await readFile(path.resolve('src/renderer/src/components/LocalLyricsMatchDrawer.vue'), 'utf8')
  const combined = `${panel}\n${nowPlaying}\n${drawer}`

  assert.match(combined, /歌词来源：网易云/u)
  assert.match(combined, /选择匹配歌词/u)
  assert.match(drawer, /role="dialog"/u)
  assert.match(drawer, /aria-modal="true"/u)
  assert.match(drawer, /@keydown\.esc/u)
  assert.match(drawer, /focus\(/u)
  assert.match(drawer, /候选歌曲/u)
  assert.match(drawer, /取消匹配/u)
  assert.match(drawer, /暂无匹配歌曲|没有找到可用候选/u)
  assert.match(drawer, /网易云尚未登录|网易云暂时不可用/u)
  assert.match(drawer, /@media\s*\(max-width:/u)
  assert.doesNotMatch(combined, /score|confidence|evidence|algorithmVersion|LocalTrackSignature|roonReference|searchQuery/iu)
  assert.doesNotMatch(drawer, /<select\b/iu)
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
    '资料库',
    '主页',
    '资料库',
    '我喜欢的音乐',
    '所有歌单',
    '艺术家',
    '流派',
    'RoonEntityGrid.vue',
    'FavoriteEntityGrid.vue',
    'roon-favorites',
    'listFavorites',
    '喜欢的歌曲',
    '喜欢的专辑',
    '喜欢的艺术家',
    'listRoonArtists',
    'listRoonGenres',
    'listRoonPlaylists',
    'getRoonArtistAlbums',
    '搜索歌曲或歌手',
    '播放设备',
    'SidebarSettingsFooter.vue',
    'sidebar-settings-footer',
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
  assert.match(combinedSource, /SidebarSettingsFooter|sidebar-settings-footer/)
  assert.doesNotMatch(combinedSource, />\s*Pause\s*</)
  assert.doesNotMatch(combinedSource, />\s*Seek\s*</)
})

test('Renderer keeps internal destinations available only through their v2 entry points', async () => {
  const files = await sourceFiles(rendererRoot)
  const combinedSource = (await Promise.all(files.map((file) => readFile(file, 'utf8')))).join('\n')

  assert.match(combinedSource, /currentView === ['"]search['"]|currentView === ['"]liked['"]|currentView === ['"]playlists['"]/)
  assert.match(combinedSource, /@settings="navigate\('settings'\)"/)
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
  assert.doesNotMatch(source, /flutter|dart|pocketbase|download-manager/i)
  // V3 可以说明 Core 的转换器身份，但 Renderer 不得引入转换器运行时。
  const converterImport = /(?:\bfrom\s*|\bimport\s*(?:\(\s*)?|\brequire\s*\(\s*)['"][^'"]*ffmpeg[^'"]*['"]/i
  for (const forbidden of ["import '@ffmpeg/ffmpeg'", "import('@ffmpeg/core')", "export { FFmpeg } from '@ffmpeg/ffmpeg'", "require('fluent-ffmpeg')"]) assert.match(forbidden, converterImport)
  assert.doesNotMatch(source, converterImport)
  const manifest = JSON.parse(await readFile(path.resolve('package.json'), 'utf8'))
  assert.ok(!Object.keys({ ...manifest.dependencies, ...manifest.devDependencies }).some(name => /ffmpeg/i.test(name)))
})

test('Roon artwork is lazy, bounded, failure-safe, and reused by every playback surface', async () => {
  const artwork = await readFile(path.resolve('src/renderer/src/components/RoonArtwork.vue'), 'utf8')
  const detail = await readFile(path.resolve('src/renderer/src/components/RoonAlbumDetail.vue'), 'utf8')
  const bottom = await readFile(path.resolve('src/renderer/src/components/BottomPlayer.vue'), 'utf8')
  const nowPlaying = await readFile(path.resolve('src/renderer/src/components/NowPlayingView.vue'), 'utf8')
  const queue = await readFile(path.resolve('src/renderer/src/components/inspector/PlaybackInspector.vue'), 'utf8')

  assert.match(artwork, /IntersectionObserver/)
  assert.match(artwork, /width:\s*256/)
  assert.match(artwork, /@error=/)
  assert.match(artwork, /alt=""/)
  assert.match(artwork, /acquireRoonArtwork|roonArtworkCache/)
  assert.match(detail, /:width="768"/)
  assert.match(detail, /eager/)
  for (const source of [bottom, nowPlaying, queue]) {
    assert.match(source, /TrackArtwork/)
  }
  assert.doesNotMatch(artwork, /width:\s*512/)
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
  assert.doesNotMatch(homeSource, /home-continue|继续聆听|currentTrack/)
  assert.doesNotMatch(homeSource, /hero-zone|overview-grid|selectedZone|Now Playing/)
  assert.match(appSource, /<BottomPlayer\b/)
  assert.doesNotMatch(appSource, /<SidebarZoneButton\b|<footer class="app-footer"|playback-zone-dock/)
})

test('主页去掉大容器气泡，桌面封面固定五列且每日推荐预览五张', async () => {
  const theme = await readFile(path.resolve('src/renderer/src/sakura-theme.css'), 'utf8')
  const daily = await readFile(path.resolve('src/renderer/src/components/home/DailyRecommendationsSection.vue'), 'utf8')
  assert.match(theme, /\.home-view \.home-media-section, \.home-view \.home-recent-section\s*\{[^}]*background:\s*transparent[^}]*box-shadow:\s*none/)
  assert.match(theme, /\.home-view \.home-cover-wall, \.home-view \.daily-recommendation-grid\s*\{[^}]*grid-template-columns:\s*repeat\(5, minmax\(0, 1fr\)\)/)
  assert.match(daily, /props\.tracks\.slice\(0, 5\)/)
  assert.match(daily, /v-for="index in 5"/)
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

test('樱花玻璃使用统一浅色主题，并保留不旋转的封面氛围层', async () => {
  const css = await readFile(path.resolve('src/renderer/src/style.css'), 'utf8')

  assert.equal((css.match(/:root\s*\{/g) ?? []).length, 1)
  assert.match(css, /color-scheme:\s*light/)
  assert.match(css, /--mb-bg-deep:\s*#f2edf1/)
  assert.match(css, /--mb-accent:\s*#a84c72/)
  assert.doesNotMatch(css, /album-ambient-rotate|rotate\(/)
  assert.doesNotMatch(css, /#a9bcff|#c5d2ff|#6e8fff|#8aa8ff/)
})

test('V1 Bottom Player stays compact, semantic, and free of transient lyric or state copy', async () => {
  const player = await readFile(path.resolve('src/renderer/src/components/BottomPlayer.vue'), 'utf8')
  const qualityControl = await readFile(path.resolve('src/renderer/src/components/player/QualityControl.vue'), 'utf8')
  const icon = await readFile(path.resolve('src/renderer/src/components/sidebar/SidebarIcon.vue'), 'utf8')
  const css = await readFile(path.resolve('src/renderer/src/style.css'), 'utf8') + '\n' + await readFile(path.resolve('src/renderer/src/sakura-theme.css'), 'utf8')

  assert.doesNotMatch(player, /player-label|currentLyricLine|音质切换/)
  assert.match(player, /QualityControl/)
  assert.match(qualityControl, /下次音质/)
  assert.match(player, /name="previous"/)
  assert.match(player, /name="next"/)
  assert.match(player, /name="list"/)
  assert.match(player, /visually-hidden/)
  assert.match(icon, /previous: 'skip-start-fill'/)
  assert.match(icon, /next: 'skip-end-fill'/)
  assert.match(css, /\.global-player\s*\{[^}]*height:\s*88px/)
  assert.match(css, /\.player-art\s*\{[^}]*width:\s*53px[^}]*height:\s*53px/)
})

test('V1 Home and content pages use page-level width tiers and avoid a duplicate Home title', async () => {
  const app = await readFile(path.resolve('src/renderer/src/App.vue'), 'utf8')
  const settings = await readFile(path.resolve('src/renderer/src/components/settings/SettingsView.vue'), 'utf8')
  const css = await readFile(path.resolve('src/renderer/src/style.css'), 'utf8') + '\n' + await readFile(path.resolve('src/renderer/src/sakura-theme.css'), 'utf8')

  assert.doesNotMatch(app, /class="topbar"|<ToolbarStatusPopover/)
  assert.match(app, /class="view view-search"/)
  assert.match(app, /class="view view-library"/)
  assert.match(app, /class="view view-diagnostics"/)
  assert.match(settings, /view-settings/)
  assert.match(css, /\.home-view\s*\{[^}]*max-width:\s*1380px/)
  assert.match(css, /\.view-search\s*,\s*\.view-library\s*,\s*\.view-playlist\s*\{[^}]*max-width:\s*1520px/)
  assert.match(css, /\.view-settings\s*\{[^}]*max-width:\s*1280px/)
  assert.match(css, /\.view-diagnostics\s*\{[^}]*max-width:\s*1100px/)
})

test('居中悬浮播放器保留完整内容，顶部横栏移除后未确认操作仍可从设置访问', async () => {
  const app = await readFile(path.resolve('src/renderer/src/App.vue'), 'utf8')
  const css = await readFile(path.resolve('src/renderer/src/style.css'), 'utf8') + '\n' + await readFile(path.resolve('src/renderer/src/sakura-theme.css'), 'utf8')
  const settings = await readFile(path.resolve('src/renderer/src/components/settings/SettingsView.vue'), 'utf8')
  assert.match(css, /\.global-player\s*\{[^}]*width:\s*min\(1060px, calc\(100% - 64px\)\)/)
  assert.match(css, /\.global-player\s*\{[^}]*position:\s*absolute/)
  assert.match(css, /\.global-player\s*\{[^}]*inset-inline:\s*0/)
  assert.match(css, /\.global-player\s*\{[^}]*margin:\s*0 auto/)
  assert.match(css, /\.global-player\s*\{[^}]*border-radius:\s*23px/)
  assert.doesNotMatch(app, /class="topbar"|<ToolbarStatusPopover/)
  assert.match(app, /<template #application-tools>[\s\S]*?commandOutboxTrigger[\s\S]*?未确认操作/)
  assert.match(settings, /<slot name="application-tools"\s*\/>/)
})

test('悬浮播放器不再占用底部整行，内容与侧栏具备可滚动避让', async () => {
  const theme = await readFile(path.resolve('src/renderer/src/sakura-theme.css'), 'utf8')
  assert.match(theme, /\.app-shell:not\(\.is-now-playing\) \.content-scroll\s*\{[^}]*padding-bottom:\s*var\(--mb-player-clearance\)/)
  assert.match(theme, /\.music-sidebar:not\(\.is-collapsed\)\s*\{[^}]*padding-bottom:\s*var\(--mb-player-clearance\)/)
  assert.match(theme, /--mb-player-clearance:\s*140px/)
})

test('V1 Settings在生产候选保留受控Remote Core入口和显式SSH目标', async () => {
  const settings = await readFile(path.resolve('src/renderer/src/components/settings/SettingsView.vue'), 'utf8')
  const app = await readFile(path.resolve('src/renderer/src/App.vue'), 'utf8')
  const main = await readFile(path.resolve('src/main/index.ts'), 'utf8')

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
  assert.match(settings, /remote-ssh-target/)
  assert.match(settings, /仅允许已配置的SSH别名或user@host/)
  assert.doesNotMatch(settings, /activeCategory === 'advanced'[^\n]*buildMode === 'development'/)
  assert.doesNotMatch(app, /appInfo\.value\.buildMode === 'development'/)
  assert.doesNotMatch(main, /Remote Core development mode is disabled in packaged builds/)
  assert.match(main, /isSafeSshTarget/)
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

test('Provider and native Roon progress seek only through an explicitly seekable Roon Zone', async () => {
  const app = await readFile(path.resolve('src/renderer/src/App.vue'), 'utf8')
  const nowPlaying = await readFile(path.resolve('src/renderer/src/components/NowPlayingView.vue'), 'utf8')

  assert.match(app, /:seek-allowed="selectedZone\?\.seekAllowed === true"/)
  assert.match(nowPlaying, /seekAllowed: boolean/)
  assert.match(nowPlaying, /:disabled="!props\.seekAllowed \|\| !props\.currentTrack \|\| durationMs <= 0"/)
  assert.doesNotMatch(app, /playbackState\.value\s*=\s*\{\s*\.\.\.snapshot,\s*positionMs:\s*result\.positionMs\s*\}/)
  const seekStart = app.indexOf('async function seekPlayback')
  const seekEnd = app.indexOf('\n}', seekStart)
  assert.match(app.slice(seekStart, seekEnd), /await refreshPlayback\(\)/)
})

test('P0-D transport UI keeps transitional controls disabled and reuses the Core-selected Zone while the list refreshes', async () => {
  const app = await readFile(path.resolve('src/renderer/src/App.vue'), 'utf8')
  const bottomPlayer = await readFile(path.resolve('src/renderer/src/components/BottomPlayer.vue'), 'utf8')
  const nowPlaying = await readFile(path.resolve('src/renderer/src/components/NowPlayingView.vue'), 'utf8')

  assert.match(app, /selectedZone\.value\?\.zoneId\s*\?\?\s*playbackState\.value\?\.selectedZoneId/)
  assert.match(app, /zoneLifecycleStatus\.value === 'loading'[\s\S]*正在读取播放设备/)
  assert.match(bottomPlayer, /'pausing',\s*'resuming'/)
  assert.match(nowPlaying, /'pausing',\s*'resuming'/)
  assert.match(bottomPlayer, /state === 'pausing'[\s\S]*正在暂停/)
  assert.match(bottomPlayer, /state === 'resuming'[\s\S]*正在恢复/)
  assert.match(nowPlaying, /state === 'pausing'[\s\S]*正在暂停/)
  assert.match(nowPlaying, /state === 'resuming'[\s\S]*正在恢复/)
})

test('Roon reconnect invalidates session-scoped collection references before they can be reused', async () => {
  const app = await readFile(path.resolve('src/renderer/src/App.vue'), 'utf8')

  for (const reset of [
    'resetRoonAlbums',
    'resetRoonArtists',
    'resetRoonGenres',
    'resetRoonPlaylists',
  ]) {
    assert.match(app, new RegExp(`reset: ${reset}`))
  }
  assert.match(app, /function resetRoonRuntimeReferences\(\): void[\s\S]*resetRoonAlbums\(\)[\s\S]*resetRoonPlaylists\(\)/)
  assert.match(app, /previousStatus === 'ready' && state\.status !== 'ready'[\s\S]*resetRoonRuntimeReferences\(\)/)
  assert.match(app, /event\.event === 'core\.ready'[\s\S]*resetRoonRuntimeReferences\(\)/)
  assert.match(app, /shouldRefreshVisibleRoonCollection\([\s\S]*previousRoonStatus,[\s\S]*event\.payload\.state\.roon,[\s\S]*\)[\s\S]*refreshVisibleRoonCollection\(\)/)
})

test('V2 native Roon playback clears only stale local favorite identity when the current descriptor is unavailable', async () => {
  const app = await readFile(path.resolve('src/renderer/src/App.vue'), 'utf8')

  assert.doesNotMatch(app, /else if \(sourceChanged\) \{\s*nativeRoonHasNeteaseMatch\.value = false/)
  assert.match(app, /const rememberedNeteaseMatch = roonQueueNeteaseMatches\.has\(trackId\)/)
  assert.match(app, /nativeRoonHasNeteaseMatch\.value = nativeRoonQueueItemHasNeteaseIdentity\([\s\S]*?rememberedNeteaseMatch,[\s\S]*?\)/)
  assert.match(app, /if \(localItem\) \{[\s\S]*?localTrackFavoriteDescriptor\.value = favoriteDescriptorForRoonItem\(localItem\)[\s\S]*?\} else \{\s*resetLocalTrackFavorite\(\)/)
  assert.match(app, /:track-like-available="playbackSource === 'netease' \|\| nativeRoonHasNeteaseMatch \|\| localTrackFavoriteDescriptor !== null"/)
})

test('confirmed matching keeps the V1 track identity inside the unified Smart queue', async () => {
  const app = await readFile(path.resolve('src/renderer/src/App.vue'), 'utf8')
  const playTrackStart = app.indexOf('async function playTrack(track: TrackSummary)')
  const roonPlayStart = app.indexOf('async function playRoonLibraryTrack', playTrackStart)
  const playTrack = app.slice(playTrackStart, roonPlayStart)

  assert.match(playTrack, /rememberRoonQueueDescriptor\(track\.id, selection\.candidate, true\)/)
  assert.match(playTrack, /replaceQueue\(\[\{[\s\S]*trackId: track\.id[\s\S]*preferredSource: 'smart'/)
  assert.doesNotMatch(playTrack, /playRoonTrack\(/)
  assert.match(app, /rememberRoonQueueDescriptor\(track\.id, candidate, true\)/)
  assert.match(app, /nativeRoonQueueItemHasNeteaseIdentity\(\s*queueItem,\s*rememberedNeteaseMatch,?\s*\)/)
  assert.match(app, /:track-like-available="playbackSource === 'netease' \|\| nativeRoonHasNeteaseMatch \|\| localTrackFavoriteDescriptor !== null"/)
})

test('search playback gives immediate preparation feedback and rejects duplicate clicks', async () => {
  const app = await readFile(path.resolve('src/renderer/src/App.vue'), 'utf8')
  const playTrackStart = app.indexOf('async function playTrack(track: TrackSummary)')
  const roonPlayStart = app.indexOf('async function playRoonLibraryTrack', playTrackStart)
  const playTrack = app.slice(playTrackStart, roonPlayStart)

  assert.match(playTrack, /if \(playbackStartPending\.value\) return/)
  assert.match(playTrack, /playbackStartPending\.value = true[\s\S]*showToast\('正在准备'\)/)
  assert.match(playTrack, /window\.musicBridge\.play\(track\.id, selectedQuality\.value, rendererClickAtMs\)/)
  assert.match(playTrack, /finally \{\s*playbackStartPending\.value = false\s*\}/)
  assert.match(app, /:busy="playbackStartPending"/)
})

test('本地 Roon 点播先投影请求曲目再等待 Core 精确确认，并防止旧请求覆盖新请求', async () => {
  const app = await readFile(path.resolve('src/renderer/src/App.vue'), 'utf8')
  const start = app.indexOf('async function playRoonLibraryTrack')
  const end = app.indexOf('async function queueRoonLibraryTrack', start)
  const playRoonTrack = app.slice(start, end)

  const optimisticIndex = playRoonTrack.indexOf('createOptimisticRoonPlayback')
  const enterIndex = playRoonTrack.indexOf('enterNowPlaying()')
  const awaitIndex = playRoonTrack.indexOf('await window.musicBridge.playRoonTrack')
  assert.ok(optimisticIndex >= 0 && optimisticIndex < awaitIndex)
  assert.ok(enterIndex >= 0 && enterIndex < awaitIndex)
  assert.match(playRoonTrack, /const operation = \+\+roonPlaybackOperation/)
  assert.match(playRoonTrack, /if \(operation !== roonPlaybackOperation\) return/)
})

test('Roon 未提供真实码率时向用户说明 API 边界，不展示伪造数值', async () => {
  const nowPlaying = await readFile(
    path.resolve('src/renderer/src/components/NowPlayingView.vue'),
    'utf8',
  )

  assert.match(nowPlaying, /Roon API 未提供码率/)
})

test('P1-D keeps local-library navigation in the sidebar and wires real genre and Roon playlist drill-down', async () => {
  const app = await readFile(path.resolve('src/renderer/src/App.vue'), 'utf8')
  const navigation = await readFile(path.resolve('src/renderer/src/components/navigation.ts'), 'utf8')
  const artwork = await readFile(path.resolve('src/renderer/src/components/RoonArtwork.vue'), 'utf8')
  const trackTable = await readFile(path.resolve('src/renderer/src/components/media/TrackTable.vue'), 'utf8')

  assert.doesNotMatch(app, /roon-library-tabs|activeRoonCollection/)
  assert.match(navigation, /type: 'roon-genre'; reference: string/)
  assert.match(navigation, /type: 'roon-playlist'; reference: string/)
  assert.match(app, /getRoonGenreItems/)
  assert.match(app, /getRoonPlaylistTracks/)
  assert.match(app, /@select="navigateSource\(\{ type: 'roon-genre'/)
  assert.match(app, /@select="navigateSource\(\{ type: 'roon-playlist'/)
  assert.match(artwork, /封面解码失败/)
  assert.match(trackTable, /Smart 匹配不唯一/)
})

test('queue item selection preserves the existing V1/V2 mixed queue', async () => {
  const app = await readFile(path.resolve('src/renderer/src/App.vue'), 'utf8')
  const selectStart = app.indexOf('async function playQueueItem')
  const toggleStart = app.indexOf('async function togglePlayback', selectStart)
  const selection = app.slice(selectStart, toggleStart)

  assert.match(selection, /window\.musicBridge\.playQueueIndex\(index\)/)
  assert.doesNotMatch(selection, /playRoonTrack\(|replaceQueue\(/)
})

test('V1 large track and queue lists use a bounded virtual window', async () => {
  const files = await sourceFiles(rendererRoot)
  const source = (await Promise.all(files.map((file) => readFile(file, 'utf8')))).join('\n')
  assert.match(source, /calculateVirtualWindow/)
  assert.match(source, /VIRTUALIZATION_THRESHOLD/)
  assert.match(source, /QUEUE_VIRTUALIZATION_THRESHOLD/)
  assert.match(source, /is-virtualized/)
})

test('应用信息说明 FFmpeg 许可，参数文案区分显式转换与设备认证', async () => {
  const settings = await readFile(path.resolve('src/renderer/src/components/settings/SettingsView.vue'), 'utf8')
  const profile = await readFile(path.resolve('src/renderer/src/components/recording/RecordingProfileSettings.vue'), 'utf8')
  assert.match(settings, /FFmpeg 8\.1\.2/)
  assert.match(settings, /LGPL 2\.1 或更高版本/)
  assert.match(settings, /对应源码/)
  assert.match(profile, /明确选择转换执行/)
  assert.doesNotMatch(profile, /待接入|当前只编译同格式整数 PCM/)
})
