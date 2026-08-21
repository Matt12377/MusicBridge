import assert from 'node:assert/strict'
import test from 'node:test'

import type {
  Page,
  PlaylistDetail,
  PlaylistSummary,
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
  const api = createPreloadApi(
    async () => appInfo,
    async () => state,
    async () => state,
    async () => ({ pong: true as const }),
    async () => authState,
    async () => authState,
    async () => authState,
    async () => authState,
    async () => authState,
    async () => page,
    async () => page,
    async () => playlists,
    async () => playlist,
    () => () => undefined,
  )

  assert.deepEqual(PUBLIC_API_KEYS, [
    'getAppInfo',
    'getCoreHealth',
    'getCoreState',
    'pingCore',
    'getAuthState',
    'beginQrLogin',
    'pollQrLogin',
    'cancelQrLogin',
    'logout',
    'searchTracks',
    'getLikedTracks',
    'getUserPlaylists',
    'getPlaylist',
    'onCoreEvent',
  ])
  assert.deepEqual(Object.keys(api), [
    'getAppInfo',
    'getCoreHealth',
    'getCoreState',
    'pingCore',
    'getAuthState',
    'beginQrLogin',
    'pollQrLogin',
    'cancelQrLogin',
    'logout',
    'searchTracks',
    'getLikedTracks',
    'getUserPlaylists',
    'getPlaylist',
    'onCoreEvent',
  ])
  assert.equal(Object.isFrozen(api), true)
  assert.deepEqual(await api.getAppInfo(), appInfo)
  assert.deepEqual(await api.getCoreHealth(), state)
  assert.deepEqual(await api.getCoreState(), state)
  assert.deepEqual(await api.pingCore(), { pong: true })
  assert.deepEqual(await api.getAuthState(), authState)
  assert.deepEqual(await api.beginQrLogin(), authState)
  assert.deepEqual(await api.pollQrLogin('challenge-1'), authState)
  assert.deepEqual(await api.cancelQrLogin('challenge-1'), authState)
  assert.deepEqual(await api.logout(), authState)
  assert.deepEqual(await api.searchTracks('synthetic', { offset: 0, limit: 20 }), page)
  assert.deepEqual(await api.getLikedTracks({ offset: 0, limit: 20 }), page)
  assert.deepEqual(await api.getUserPlaylists(), playlists)
  assert.deepEqual(await api.getPlaylist('301', { offset: 0, limit: 20 }), playlist)
})
