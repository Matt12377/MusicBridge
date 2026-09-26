import assert from 'node:assert/strict'
import test from 'node:test'
import type {
  DailyRecommendationsSnapshot, Page, PageRequest, PlaylistDetail, PublicAuthState,
  PublicBridgeState, RemoteCoreTunnelState, TrackSummary,
} from '@music-bridge/contracts'
import type { MusicBridgePublicApi } from '../src/preload/api.js'
import { useNeteaseLibrary } from '../src/renderer/src/composables/application/useNeteaseLibrary.js'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve
    reject = onReject
  })
  return { promise, resolve, reject }
}

function page(trackId: string): Page<TrackSummary> {
  return {
    items: [{ id: trackId, title: trackId, artists: ['Synthetic Artist'], album: 'Synthetic Album' }],
    offset: 0, limit: 20, total: 1, hasMore: false,
  }
}

const emptyDaily: DailyRecommendationsSnapshot = { dayKey: '2026-09-26', tracks: [] }

function createHarness(overrides: Partial<MusicBridgePublicApi> = {}) {
  let runtime: PublicBridgeState['runtime'] = 'ready'
  let remote: RemoteCoreTunnelState['status'] = 'ready'
  let resetCount = 0
  let playlistSwitchCount = 0
  const readyPlaylists: string[] = []
  const errors: unknown[] = []
  const api = {
    getAccountState: async () => ({ status: 'missing' }),
    getLikedTracks: async () => page('default'),
    getUserPlaylists: async () => [],
    getDailyRecommendations: async () => emptyDaily,
    getPlaylist: async (id: string, request: PageRequest): Promise<PlaylistDetail> => ({
      id, name: id, trackCount: 0,
      tracks: { items: [], offset: request.offset, limit: request.limit, total: 0, hasMore: false },
    }),
    logout: async (): Promise<PublicAuthState> => ({ status: 'idle' }),
    ...overrides,
  } as MusicBridgePublicApi
  const library = useNeteaseLibrary({
    api,
    getCoreRuntime: () => runtime,
    getRemoteStatus: () => remote,
    getView: () => 'home',
    onMatchTracks: () => undefined,
    onPlaylistSwitch: () => { playlistSwitchCount += 1 },
    onPlaylistReady: id => { readyPlaylists.push(id) },
    onResetPrivate: () => { resetCount += 1 },
    onError: error => { errors.push(error) },
    accountMessage: () => '账户不可用',
    dailyMessage: () => '推荐不可用',
    libraryErrorKind: () => 'generic',
  })
  return {
    library, readyPlaylists, errors,
    get resetCount() { return resetCount },
    get playlistSwitchCount() { return playlistSwitchCount },
    setRuntime(value: PublicBridgeState['runtime']) { runtime = value },
    setRemote(value: RemoteCoreTunnelState['status']) { remote = value },
  }
}

async function settleAsync(): Promise<void> {
  await new Promise<void>(resolve => setImmediate(resolve))
}

test('初始认证快照晚于事件抵达时，保留新事件并只启动一次资料库加载', async t => {
  const calls = { liked: 0, playlists: 0, daily: 0, account: 0 }
  const harness = createHarness({
    getLikedTracks: async () => { calls.liked += 1; return page('current') },
    getUserPlaylists: async () => { calls.playlists += 1; return [] },
    getDailyRecommendations: async () => { calls.daily += 1; return emptyDaily },
    getAccountState: async () => { calls.account += 1; return { status: 'ready', profile: { displayName: 'Synthetic' } } },
  })
  t.after(() => harness.library.dispose())

  harness.library.applyAuthState({ status: 'authorized' })
  harness.library.applyInitialAuthState({ status: 'idle' })
  await settleAsync()

  assert.equal(harness.library.authState.value.status, 'authorized')
  assert.deepEqual(calls, { liked: 1, playlists: 1, daily: 1, account: 1 })
  assert.equal(harness.resetCount, 1)
  assert.deepEqual(harness.library.likedPage.value.items.map(track => track.id), ['current'])
})

test('登出后旧的喜欢、歌单及推荐响应均不能回填私有资料', async t => {
  const liked = deferred<Page<TrackSummary>>()
  const playlists = deferred<Awaited<ReturnType<MusicBridgePublicApi['getUserPlaylists']>>>()
  const daily = deferred<DailyRecommendationsSnapshot>()
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { confirm: () => true } })
  t.after(() => {
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow)
    else Reflect.deleteProperty(globalThis, 'window')
  })
  const harness = createHarness({
    getLikedTracks: () => liked.promise,
    getUserPlaylists: () => playlists.promise,
    getDailyRecommendations: () => daily.promise,
  })
  t.after(() => harness.library.dispose())

  harness.library.applyAuthState({ status: 'authorized' })
  await harness.library.logout()
  liked.resolve(page('stale-liked'))
  playlists.resolve([{ id: 'stale-playlist', name: '旧歌单', trackCount: 1 }])
  daily.resolve({ dayKey: '2026-09-26', tracks: page('stale-daily').items })
  await settleAsync()

  assert.equal(harness.library.authState.value.status, 'idle')
  assert.deepEqual(harness.library.likedPage.value.items, [])
  assert.deepEqual(harness.library.playlists.value, [])
  assert.deepEqual(harness.library.dailyRecommendations.value.tracks, [])
  assert.equal(harness.library.accountState.value.status, 'missing')
})

test('切换歌单同步撤销旧集合操作，同一歌单的分页和重试不重复撤销', async t => {
  const harness = createHarness()
  t.after(() => harness.library.dispose())
  harness.library.applyAuthState({ status: 'authorized' })

  await harness.library.loadPlaylist('playlist-1')
  assert.equal(harness.playlistSwitchCount, 1)
  await harness.library.loadPlaylist('playlist-1', { offset: 20, limit: 20 })
  await harness.library.loadPlaylist('playlist-1')
  assert.equal(harness.playlistSwitchCount, 1)
  await harness.library.loadPlaylist('playlist-2')
  assert.equal(harness.playlistSwitchCount, 2)
})

for (const transition of ['core', 'remote'] as const) {
  test(`${transition === 'core' ? 'Core' : 'Remote'} 切换使旧响应失效，恢复后只启动一次并补载待开的歌单`, async t => {
    const oldLiked = deferred<Page<TrackSummary>>()
    let likedCalls = 0
    let playlistCalls = 0
    const harness = createHarness({
      getLikedTracks: () => {
        likedCalls += 1
        return likedCalls === 1 ? oldLiked.promise : Promise.resolve(page('new-core'))
      },
      getPlaylist: async (id: string, request: PageRequest) => {
        playlistCalls += 1
        return {
          id, name: id, trackCount: 1,
          tracks: { ...page('new-playlist'), offset: request.offset, limit: request.limit },
        }
      },
    })
    t.after(() => harness.library.dispose())

    harness.library.applyAuthState({ status: 'authorized' })
    if (transition === 'core') harness.setRuntime('starting')
    else harness.setRemote('checking')
    harness.library.resetAuthorizedLoadStarted()
    await harness.library.loadPlaylist('playlist-1')
    assert.equal(playlistCalls, 0)
    harness.library.loadAuthorizedLibraryWhenReady()
    assert.equal(likedCalls, 1)

    if (transition === 'core') harness.setRuntime('ready')
    else harness.setRemote('ready')
    harness.library.loadAuthorizedLibraryWhenReady()
    harness.library.loadAuthorizedLibraryWhenReady()
    oldLiked.resolve(page('old-core'))
    await settleAsync()

    assert.equal(likedCalls, 2)
    assert.deepEqual(harness.library.likedPage.value.items.map(track => track.id), ['new-core'])
    assert.equal(playlistCalls, 1)
    assert.deepEqual(harness.readyPlaylists, ['playlist-1'])
    assert.deepEqual(harness.library.selectedPlaylist.value?.tracks.items.map(track => track.id), ['new-playlist'])
  })
}

test('卸载停止 QR 轮询，晚到响应和旧轮询失败都不改写新状态', async () => {
  const firstPoll = deferred<PublicAuthState>()
  const secondPoll = deferred<PublicAuthState>()
  const originalSetInterval = globalThis.setInterval
  const originalClearInterval = globalThis.clearInterval
  let tick: (() => void) | undefined
  let activeInterval = false
  let pollCalls = 0
  globalThis.setInterval = ((callback: () => void) => {
    tick = callback
    activeInterval = true
    return 1 as unknown as ReturnType<typeof setInterval>
  }) as typeof setInterval
  globalThis.clearInterval = ((_timer: ReturnType<typeof setInterval>) => {
    activeInterval = false
  }) as typeof clearInterval
  const harness = createHarness({
    pollQrLogin: () => {
      pollCalls += 1
      return pollCalls === 1 ? firstPoll.promise : secondPoll.promise
    },
  })
  try {
    harness.library.applyAuthState({ status: 'waiting', challengeId: 'challenge-1' })
    assert.equal(pollCalls, 1)
    assert.equal(activeInterval, true)
    harness.library.applyAuthState({ status: 'scanned', challengeId: 'challenge-1' })
    firstPoll.reject(new Error('旧轮询失败'))
    await settleAsync()
    assert.equal(harness.library.authError.value, false)
    assert.deepEqual(harness.errors, [])
    assert.equal(activeInterval, true)

    tick?.()
    assert.equal(pollCalls, 2)
    harness.library.dispose()
    assert.equal(activeInterval, false)
    secondPoll.resolve({ status: 'authorized' })
    await settleAsync()
    assert.equal(harness.library.authState.value.status, 'scanned')
    assert.equal(harness.resetCount, 0)
  } finally {
    harness.library.dispose()
    globalThis.setInterval = originalSetInterval
    globalThis.clearInterval = originalClearInterval
  }
})
