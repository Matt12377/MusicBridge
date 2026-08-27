import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

import type {
  Page,
  PlaylistDetail,
  PlaylistSummary,
  LyricsSnapshot,
  PlaybackSnapshot,
  PublicAuthState,
  PublicAccountState,
  PublicBridgeState,
  DailyRecommendationsSnapshot,
  TrackSummary,
} from '@music-bridge/contracts'
import { createPreloadApi, PUBLIC_API_KEYS } from '../src/preload/api.js'
import { summarizePreloadRoonImage } from '../src/preload/image-diagnostic.js'

test('Preload 图片诊断保持 sandbox 本地实现，不引入 contracts 运行期依赖', async () => {
  const source = await readFile(path.resolve('src/preload/index.ts'), 'utf8')
  assert.match(source, /import type \{[\s\S]*?\} from '@music-bridge\/contracts'/u)
  assert.doesNotMatch(source, /summarizeRoonImageBinary/u)
  assert.deepEqual(summarizePreloadRoonImage({
    contentType: 'image/jpeg',
    body: new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]),
  }), {
    layer: 'preload',
    contentType: 'image/jpeg',
    byteLength: 8,
    magic8: 'ffd8ffe000104a46',
    bodyType: 'Uint8Array',
    isBuffer: false,
    isUint8Array: true,
    isArrayBuffer: false,
    valid: true,
  })
})

test('Preload exposes only sanitized business methods', async () => {
  const appInfo = {
    version: '0.1.0-beta.2',
    buildMode: 'development' as const,
    platform: 'darwin',
  }
  const state: PublicBridgeState = {
    runtime: 'ready',
    roon: 'paired',
    provider: 'missing',
    activeStreamCount: 0,
    activePlaybackPresent: false,
  }
  const authState: PublicAuthState = { status: 'idle' }
  const accountState: PublicAccountState = {
    status: 'ready',
    profile: { displayName: 'Synthetic Account', avatarUrl: 'https://p1.music.126.net/avatar.jpg' },
  }
  const dailyRecommendations: DailyRecommendationsSnapshot = {
    dayKey: '2026-08-22',
    tracks: [],
  }
  const page: Page<TrackSummary> = {
    items: [],
    offset: 0,
    limit: 20,
    total: 0,
    hasMore: false,
  }
  const playlists: readonly PlaylistSummary[] = []
  const playlist: PlaylistDetail = {
    id: '301',
    name: 'Synthetic Playlist',
    trackCount: 0,
    tracks: page,
  }
  const playbackState: PlaybackSnapshot = {
    state: 'idle',
    queue: { items: [], index: -1, hasNext: false, hasPrevious: false },
    positionMs: 0,
    canNext: false,
    canPrevious: false,
    canStop: false,
    canPause: false,
    canResume: false,
  }
  const lyrics: LyricsSnapshot = {
    status: 'unavailable',
    lines: [],
    activeLineIndex: -1,
    timingSource: 'static',
  }
  const api = createPreloadApi(
    async () => appInfo,
    async () => state,
    async () => state,
    async () => ({ pong: true as const }),
    async () => ({ exported: true }),
    async () => authState,
    async () => authState,
    async () => authState,
    async () => authState,
    async () => authState,
    async () => accountState,
    async () => accountState,
    async () => page,
    async () => page,
    async () => playlists,
    async () => playlist,
    async () => dailyRecommendations,
    async () => ({ zones: [] }),
    async () => state,
    async () => lyrics,
    async () => playbackState,
    async () => playbackState,
    async () => playbackState,
    async () => playbackState,
    async () => playbackState,
    async () => playbackState,
    async () => playbackState,
    async () => playbackState,
    async () => playbackState,
    async () => playbackState,
    () => () => undefined,
    () => () => undefined,
  )

  assert.deepEqual(PUBLIC_API_KEYS, [
    'pickCollectionPhoto',
    'addCollectionPhoto',
    'getCollectionPhoto',
    'changeCollectionPhoto',
    'listCollection',
    'getCollectionModel',
    'receiveCollectionStock',
    'materializeCollectionCopy',
    'updateCollectionCopy',
    'setCollectionPolicy',
    'getAppInfo',
    'getCoreHealth',
    'getCoreState',
    'pingCore',
    'exportDiagnostics',
    'getAuthState',
    'beginQrLogin',
    'pollQrLogin',
    'cancelQrLogin',
    'logout',
    'getAccountState',
  'refreshAccountProfile',
  'searchTracks',
  'searchArtists',
  'searchAlbums',
  'getArtist',
  'getAlbum',
    'getLikedTracks',
    'getTrackLikeStatus',
    'setTrackLiked',
    'matchLibraryTrack',
    'aggregateSearch',
    'seek',
    'getUserPlaylists',
    'getPlaylist',
    'getDailyRecommendations',
    'listFavorites',
    'checkFavorite',
    'setFavorite',
    'listZones',
    'selectZone',
    'listRoonAlbums',
    'listRoonArtists',
    'listRoonGenres',
    'listRoonPlaylists',
    'getRoonAlbumTracks',
    'getRoonArtistAlbums',
    'getRoonGenreItems',
    'getRoonPlaylistTracks',
    'searchRoonLibrary',
    'getRoonImage',
    'playRoonTrack',
    'queueRoonTrack',
    'stopRoonTransport',
    'getLyrics',
    'getLocalLyricsMatch',
    'selectLocalLyricsMatch',
    'revokeLocalLyricsMatch',
    'getPlaybackState',
    'play',
    'pause',
    'resume',
    'stop',
    'next',
    'previous',
    'playQueueIndex',
    'replaceQueue',
    'appendQueue',
    'insertNext',
    'onCoreEvent',
    'onAppCommand',
    'getRemoteCoreState',
    'startRemoteCore',
    'stopRemoteCore',
    'reconnectRemoteCore',
    'onRemoteCoreEvent',
  ])
  assert.deepEqual(Object.keys(api), [
    'pickCollectionPhoto',
    'addCollectionPhoto',
    'getCollectionPhoto',
    'changeCollectionPhoto',
    'listCollection',
    'getCollectionModel',
    'receiveCollectionStock',
    'materializeCollectionCopy',
    'updateCollectionCopy',
    'setCollectionPolicy',
    'getAppInfo',
    'getCoreHealth',
    'getCoreState',
    'pingCore',
    'exportDiagnostics',
    'getAuthState',
    'beginQrLogin',
    'pollQrLogin',
    'cancelQrLogin',
    'logout',
    'getAccountState',
  'refreshAccountProfile',
  'searchTracks',
  'searchArtists',
  'searchAlbums',
  'getArtist',
  'getAlbum',
    'getLikedTracks',
    'getTrackLikeStatus',
    'setTrackLiked',
    'matchLibraryTrack',
    'aggregateSearch',
    'seek',
    'getUserPlaylists',
    'getPlaylist',
    'getDailyRecommendations',
    'listFavorites',
    'checkFavorite',
    'setFavorite',
    'listZones',
    'selectZone',
    'listRoonAlbums',
    'listRoonArtists',
    'listRoonGenres',
    'listRoonPlaylists',
    'getRoonAlbumTracks',
    'getRoonArtistAlbums',
    'getRoonGenreItems',
    'getRoonPlaylistTracks',
    'searchRoonLibrary',
    'getRoonImage',
    'playRoonTrack',
    'queueRoonTrack',
    'stopRoonTransport',
    'getLyrics',
    'getLocalLyricsMatch',
    'selectLocalLyricsMatch',
    'revokeLocalLyricsMatch',
    'getPlaybackState',
    'play',
    'pause',
    'resume',
    'stop',
    'next',
    'previous',
    'playQueueIndex',
    'replaceQueue',
    'appendQueue',
    'insertNext',
    'onCoreEvent',
    'onAppCommand',
    'getRemoteCoreState',
    'startRemoteCore',
    'stopRemoteCore',
    'reconnectRemoteCore',
    'onRemoteCoreEvent',
  ])
  assert.equal(Object.isFrozen(api), true)
  assert.deepEqual(await api.getAppInfo(), appInfo)
  assert.deepEqual(await api.getCoreHealth(), state)
  assert.deepEqual(await api.getCoreState(), state)
  assert.deepEqual(await api.pingCore(), { pong: true })
  assert.deepEqual(await api.exportDiagnostics(), { exported: true })
  assert.deepEqual(await api.getAuthState(), authState)
  assert.deepEqual(await api.beginQrLogin(), authState)
  assert.deepEqual(await api.pollQrLogin('challenge-1'), authState)
  assert.deepEqual(await api.cancelQrLogin('challenge-1'), authState)
  assert.deepEqual(await api.logout(), authState)
  assert.deepEqual(await api.getAccountState(), accountState)
  assert.deepEqual(await api.refreshAccountProfile(), accountState)
  assert.deepEqual(await api.searchTracks('synthetic', { offset: 0, limit: 20 }), page)
  assert.deepEqual(await api.getLikedTracks({ offset: 0, limit: 20 }), page)
  await assert.rejects(
    () => api.matchLibraryTrack({ id: '301', title: 'Synthetic Song', artists: ['Synthetic Artist'], album: 'Synthetic Album' }),
    /Roon matching API is unavailable/,
  )
  await assert.rejects(
    () => api.aggregateSearch('synthetic', { offset: 0, limit: 20 }),
    /Aggregated search API is unavailable/,
  )
  await assert.rejects(
    () => api.seek(12_345),
    /Roon Transport seek API is unavailable/,
  )
  assert.deepEqual(await api.getUserPlaylists(), playlists)
  assert.deepEqual(await api.getPlaylist('301', { offset: 0, limit: 20 }), playlist)
  assert.deepEqual(await api.getDailyRecommendations(), dailyRecommendations)
  assert.deepEqual(await api.listZones(), { zones: [] })
  assert.deepEqual(await api.selectZone('zone-1'), state)
  assert.deepEqual(await api.getLyrics('301'), lyrics)
  assert.deepEqual(await api.getLocalLyricsMatch(), { status: 'hidden', candidates: [], canRevoke: false })
  await assert.rejects(() => api.selectLocalLyricsMatch('session-0123456789abcdef', 'candidate-0123456789abcdef'), /unavailable/iu)
  await assert.rejects(() => api.revokeLocalLyricsMatch(), /unavailable/iu)
  assert.deepEqual(await api.getPlaybackState(), playbackState)
  assert.deepEqual(await api.play('301', 'lossless'), playbackState)
  assert.deepEqual(await api.pause(), playbackState)
  assert.deepEqual(await api.resume(), playbackState)
  assert.deepEqual(await api.stop(), playbackState)
  assert.deepEqual(await api.next(), playbackState)
  assert.deepEqual(await api.previous(), playbackState)
  await assert.rejects(
    () => api.playQueueIndex(0),
    /Queue index API is unavailable/,
  )
  assert.deepEqual(
    await api.replaceQueue([{ trackId: '301', qualityPreference: 'lossless' }], 0),
    playbackState,
  )
})
