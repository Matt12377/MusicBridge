import assert from 'node:assert/strict'
import test from 'node:test'

import type {
  Page,
  PlaylistDetail,
  PlaylistSummary,
  LyricsSnapshot,
  PlaybackSnapshot,
  PublicAuthState,
  PublicBridgeState,
  TrackSummary,
} from '@music-bridge/contracts'
import { createPreloadApi, PUBLIC_API_KEYS } from '../src/preload/api.js'

test('Preload exposes only sanitized business methods', async () => {
  const appInfo = {
    version: '0.1.0-poc.1',
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
    canNext: false,
    canPrevious: false,
    canStop: false,
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
    async () => page,
    async () => page,
    async () => playlists,
    async () => playlist,
    async () => ({ zones: [] }),
    async () => state,
    async () => lyrics,
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
    'searchTracks',
    'getLikedTracks',
    'getUserPlaylists',
    'getPlaylist',
    'listZones',
    'selectZone',
    'getLyrics',
    'getPlaybackState',
    'play',
    'stop',
    'next',
    'previous',
    'replaceQueue',
    'onCoreEvent',
    'onAppCommand',
  ])
  assert.deepEqual(Object.keys(api), [
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
    'searchTracks',
    'getLikedTracks',
    'getUserPlaylists',
    'getPlaylist',
    'listZones',
    'selectZone',
    'getLyrics',
    'getPlaybackState',
    'play',
    'stop',
    'next',
    'previous',
    'replaceQueue',
    'onCoreEvent',
    'onAppCommand',
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
  assert.deepEqual(await api.searchTracks('synthetic', { offset: 0, limit: 20 }), page)
  assert.deepEqual(await api.getLikedTracks({ offset: 0, limit: 20 }), page)
  assert.deepEqual(await api.getUserPlaylists(), playlists)
  assert.deepEqual(await api.getPlaylist('301', { offset: 0, limit: 20 }), playlist)
  assert.deepEqual(await api.listZones(), { zones: [] })
  assert.deepEqual(await api.selectZone('zone-1'), state)
  assert.deepEqual(await api.getLyrics('301'), lyrics)
  assert.deepEqual(await api.getPlaybackState(), playbackState)
  assert.deepEqual(await api.play('301', 'lossless'), playbackState)
  assert.deepEqual(await api.stop(), playbackState)
  assert.deepEqual(await api.next(), playbackState)
  assert.deepEqual(await api.previous(), playbackState)
  assert.deepEqual(
    await api.replaceQueue([{ trackId: '301', quality: 'lossless' }], 0),
    playbackState,
  )
})
