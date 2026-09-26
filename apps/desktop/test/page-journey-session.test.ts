import assert from 'node:assert/strict'
import test from 'node:test'
import type { MusicBridgePublicApi } from '../src/preload/api.js'
import type { RoonLibraryPage } from '@music-bridge/contracts'
import { useAggregatedSearch } from '../src/renderer/src/composables/application/useAggregatedSearch.js'
import { useRoonBrowse } from '../src/renderer/src/composables/application/useRoonBrowse.js'
import { usePageJourney } from '../src/renderer/src/composables/application/usePageJourney.js'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(onResolve => { resolve = onResolve })
  return { promise, resolve }
}

const album = {
  reference: 'musicbridge-v2-entity-00000000-0000-0000-0000-000000000201',
  kind: 'album' as const,
  title: '合成专辑',
}
const albumPage: RoonLibraryPage = { items: [album], offset: 0, limit: 20, total: 1, hasMore: false }
const emptyRoonPage: RoonLibraryPage = { items: [], offset: 0, limit: 20, total: 0, hasMore: false }
const emptyProviderPage = { items: [], offset: 0, limit: 20, total: 0, hasMore: false }

test('本地搜索路径可返回，其他上下文的新搜索清旧路径，迟到详情不劫持当前页', async t => {
  const pendingDetail = deferred<RoonLibraryPage>()
  const api = {
    listRoonAlbums: async () => albumPage,
    searchRoonLibrary: async () => albumPage,
    getRoonAlbumTracks: () => pendingDetail.promise,
    checkFavorite: async () => ({ favorite: false }),
    searchArtists: async () => emptyProviderPage,
    searchTracks: async () => emptyProviderPage,
    searchAlbums: async () => emptyProviderPage,
  } as unknown as MusicBridgePublicApi
  let journey!: ReturnType<typeof usePageJourney>
  const browse = useRoonBrowse({
    api,
    formatError: () => '测试请求失败',
    onError: error => { throw error },
    onToast: () => undefined,
    getView: () => journey.currentView.value,
    onDetailOpening: view => journey.setDetailView(view),
    onDetailReady: (view, source) => journey.setDetailView(view, source),
    onNavigateSource: source => journey.navigateSource(source),
    onPlayTrack: () => undefined,
  })
  const search = useAggregatedSearch({
    api,
    getZoneId: () => undefined,
    getScrollTop: () => 0,
    scrollTo: () => undefined,
    classifyError: () => 'generic',
    onResetSearchOrigin: () => { journey.roonSearchOrigin.value = false },
    onInvalidateRoonDetails: () => browse.invalidateAlbumArtistRequests(),
  })
  journey = usePageJourney({
    search, browse,
    library: {
      hasLikedItems: () => false,
      isPlaylistReady: () => false,
      getPlaylistScrollTop: () => 0,
      setPlaylistScrollTop: () => undefined,
      loadLiked: async () => undefined,
      loadPlaylists: async () => undefined,
      loadPlaylist: async () => undefined,
    },
    onPlayRoonTrack: () => undefined,
    onCloseInspector: () => undefined,
    onClearActionError: () => undefined,
  })
  t.after(() => { journey.dispose(); search.dispose(); browse.dispose() })

  journey.navigateSource({ type: 'roon-albums' })
  await new Promise<void>(resolve => setImmediate(resolve))
  journey.updateSearchQuery('旧查询')
  assert.equal(browse.localAlbumQuery.value, '旧查询')
  journey.navigateSource({ type: 'roon-album', reference: album.reference })
  assert.equal(journey.currentView.value, 'roon-album-detail')
  journey.returnFromRoonDetail('album')
  assert.equal(journey.currentView.value, 'roon-albums')
  pendingDetail.resolve(emptyRoonPage)
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(journey.currentView.value, 'roon-albums')

  journey.navigateSource({ type: 'home' })
  assert.equal(journey.currentView.value, 'home')
  journey.navigateSource({ type: 'roon-albums' })
  assert.equal(journey.currentView.value, 'roon-albums')
  assert.equal(browse.localAlbumQuery.value, '旧查询')

  journey.navigateSource({ type: 'home' })
  journey.updateSearchQuery('新查询')
  assert.equal(journey.currentView.value, 'search')
  assert.equal(search.searchQuery.value, '新查询')
  assert.equal(browse.localAlbumQuery.value, '')
  journey.navigateSource({ type: 'roon-albums' })
  assert.equal(browse.localAlbumQuery.value, '')
})
