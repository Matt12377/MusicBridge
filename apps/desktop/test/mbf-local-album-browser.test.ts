import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import * as dto from '@music-bridge/contracts'
import { createLocalAlbumClient } from '../src/preload/local-album-client.js'
import { registerLocalAlbumIpc } from '../src/main/local-library-workbench/album-ipc.js'
import { effectScope } from 'vue'
import type { LocalArtworkImage } from '@music-bridge/contracts'
import { createLocalAlbumBrowserModel, LOCAL_ALBUM_ARTWORK_COUNT_QUIET_MS, isLocalAlbumArtworkReply, isLocalAlbumPage, isLocalAlbumSummary, localAlbumTrackPresentation } from '../src/renderer/src/composables/application/local-library-browser/model.js'
import { useLocalAlbumBrowser, useLocalAlbumBrowserPages } from '../src/renderer/src/composables/application/local-library-browser/useLocalAlbumBrowser.js'
import { LOCAL_ALBUM_STATUSES, type LocalAlbumArtworkReply, type LocalAlbumArtworkRequest, type LocalAlbumBrowserApi, type LocalAlbumFilterCounts, type LocalAlbumPage, type LocalAlbumQuery, type LocalAlbumSummary, type LocalAlbumTrackItem, type LocalAlbumTrackPage, type LocalAlbumTrackQuery } from '../src/renderer/src/composables/application/local-library-browser/types.js'

// 所有数据均为内存合成事实；不扫描目录、不连接工作库、不读取音乐或调用播放器。
const id = (n: number) => `11111111-1111-4111-8111-${String(n).padStart(12, '0')}`
const root = id(1), otherRoot = id(2)
function album(n: number, changes: Partial<LocalAlbumSummary> = {}): LocalAlbumSummary {
  return { id: `edition-${n}`, kind: 'edition', rootId: root, editionId: id(100 + n), title: '同名专辑', artists: ['合成艺人'], year: '2000', versionLabel: `发行 ${n}`,
    sourceLabel: '合成来源', trackCount: 3, representativeTrackId: id(1000 + n * 10), revision: '1', artworkAvailable: true, statuses: ['has-artwork'], ...changes }
}
function counts(albums: readonly LocalAlbumSummary[]): LocalAlbumFilterCounts {
  return Object.fromEntries([['all', albums.length], ...LOCAL_ALBUM_STATUSES.map(status => [status, albums.filter(value => value.statuses.includes(status)).length])]) as unknown as LocalAlbumFilterCounts
}
function page(request: LocalAlbumQuery, albums: readonly LocalAlbumSummary[]): LocalAlbumPage {
  const scoped = albums.filter(value => (request.rootId === null || value.rootId === request.rootId)
    && (!request.query || `${value.title} ${value.artists.join(' ')} ${value.versionLabel ?? ''}`.includes(request.query)))
  const selected = scoped.filter(value => request.filter === 'all' || value.statuses.includes(request.filter))
  const items = selected.slice(request.offset, request.offset + request.limit)
  return { ...request, total: selected.length, hasMore: request.offset + items.length < selected.length, counts: counts(scoped), items }
}
function track(value: LocalAlbumSummary, index: number): LocalAlbumTrackItem {
  const seed = Number(value.representativeTrackId!.slice(-12)), trackId = id(seed + index), assetId = id(10_000 + seed + index)
  const raw = { title: `原始曲目 ${index + 1}`, artist: '原始艺人', album: value.title, year: value.year ?? '', disc: '1', track: String(index + 1) }
  return { facts: { track: { id: trackId, assetId, selectionRevision: '2', segment: null },
    asset: { id: assetId, libraryRootId: value.rootId, sourceRootId: id(3), rootRevision: '1', fileRevision: '3', locationRevision: '4', sampleFrames: null, timebaseHz: null },
    metadata: { raw, override: null, effective: { ...raw } }, versionTokens: [{ raw: 'SACD', source: 'album', kind: 'format', start: 0, end: 4 }],
    editions: value.editionId ? [{ id: value.editionId, title: value.title, edition: value.versionLabel ?? '', revision: '1' }] : [],
    fileParameters: { container: 'FLAC', codec: 'FLAC', lossless: true, sampleRateHz: 48_000, channels: 2, bitsPerSample: 24, durationMs: 123_000, evidence: 'bounded-parser-reported' } },
    disc: 1, trackNumber: index + 1, sequence: index + 1, statuses: value.statuses }
}
function trackPage(request: LocalAlbumTrackQuery, value: LocalAlbumSummary): LocalAlbumTrackPage {
  const items = Array.from({ length: Math.min(request.limit, Math.max(0, value.trackCount - request.offset)) }, (_, index) => track(value, request.offset + index))
  return { ...request, album: value, total: value.trackCount, hasMore: request.offset + items.length < value.trackCount, items }
}
function image(base64 = '/9j/'): LocalArtworkImage {
  return { original: { mime: 'image/png', bytes: 4, sha256: 'a'.repeat(64), width: 32, height: 32 },
    display: { mime: 'image/jpeg', bytes: 3, sha256: 'b'.repeat(64), width: 16, height: 16, dataUrl: `data:image/jpeg;base64,${base64}` } }
}
function artworkTuple(request: LocalAlbumArtworkRequest): LocalAlbumArtworkRequest {
  return { albumKey: request.albumKey, rootId: request.rootId, editionId: request.editionId, representativeTrackId: request.representativeTrackId, revision: request.revision }
}
function api(albums: readonly LocalAlbumSummary[], changes: Partial<LocalAlbumBrowserApi> = {}): LocalAlbumBrowserApi {
  return { queryAlbums: async request => page(request, albums), queryAlbumTracks: async request => { const selected = albums.find(value => value.id === request.albumKey && value.rootId === request.rootId); assert.ok(selected); return trackPage(request, selected) },
    getArtwork: async request => ({ ...artworkTuple(request), image: image() }), ...changes }
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: Error) => void
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail })
  return { promise, resolve, reject }
}
const settle = async () => { for (let i = 0; i < 4; i++) await Promise.resolve() }

test('MBF合并作用域setScope一次更新搜索来源和筛选，只发一个完整请求并丢弃旧回复',async t=>{
  const selected=album(1,{rootId:otherRoot,title:'合并专辑',statuses:['has-artwork','track-named-audio']}),pending=deferred<LocalAlbumPage>(),requests:LocalAlbumQuery[]=[]
  const model=createLocalAlbumBrowserModel({api:api([selected],{queryAlbums:request=>{requests.push(request);return requests.length===1?pending.promise:Promise.resolve(page(request,[selected]))}})});t.after(model.dispose)
  const activating=model.activate();await model.setScope({query:' 合并 ',rootId:otherRoot,filter:'track-named-audio'})
  assert.equal(requests.length,2);assert.deepEqual(requests[1],{query:'合并',rootId:otherRoot,filter:'track-named-audio',offset:0,limit:60})
  assert.equal(model.getSnapshot().items[0]!.id,selected.id);const current=model.getSnapshot()
  pending.resolve(page(requests[0]!,[]));await activating;assert.equal(model.getSnapshot(),current)
  await model.setScope({query:'合并',rootId:otherRoot,filter:'track-named-audio'});assert.equal(requests.length,2)
})

test('MBF合并作用域无效条件不部分生效，也不执行getter或发新请求',async t=>{
  const values=[album(1)],requests:LocalAlbumQuery[]=[],model=createLocalAlbumBrowserModel({api:api(values,{queryAlbums:async request=>{requests.push(request);return page(request,values)}})});t.after(model.dispose)
  await model.activate();const before=model.getSnapshot()
  await model.setScope({query:'有效搜索',rootId:otherRoot,filter:'无效筛选'} as unknown as Pick<LocalAlbumQuery,'query'|'rootId'|'filter'>)
  assert.equal(requests.length,1);assert.equal(model.getSnapshot().query,before.query);assert.equal(model.getSnapshot().rootId,before.rootId);assert.equal(model.getSnapshot().filter,before.filter);assert.equal(model.getSnapshot().items,before.items)
  let reads=0
  const unsafe=Object.defineProperty({rootId:null,filter:'all'},'query',{enumerable:true,get(){reads++;return'不应读取'}})
  await model.setScope(unsafe as Pick<LocalAlbumQuery,'query'|'rootId'|'filter'>);assert.equal(reads,0);assert.equal(requests.length,1);assert.match(model.getSnapshot().error,/条件无效/u)
})

test('MBF专辑分页保留同名但不同根与不同发行的真实身份，搜索与七类计数按服务器作用域更新', async t => {
  const albums = [album(1), album(2, { rootId: otherRoot, statuses: ['has-artwork', 'parse-failed'] }), album(3, { statuses: ['has-artwork', 'track-named-audio'], title: '曲目命名专辑' })]
  const requests: LocalAlbumQuery[] = []
  const model = createLocalAlbumBrowserModel({ api: api(albums, { queryAlbums: async request => { requests.push(request); return page(request, albums) } }), pageSize: 2 }); t.after(model.dispose)
  await model.activate()
  assert.deepEqual(model.getSnapshot().items.map(value => value.id), ['edition-1', 'edition-2'])
  assert.equal(model.getSnapshot().total, 3); assert.equal(model.getSnapshot().hasMore, true)
  await model.loadMore()
  assert.deepEqual(requests.map(value => value.offset), [0, 2]); assert.equal(model.getSnapshot().items.length, 3)
  assert.equal(model.getSnapshot().counts['track-named-audio'], 1)
  assert.equal(model.getSnapshot().counts['parse-failed'], 1); assert.equal(model.getSnapshot().items[1]!.trackCount, 3)
  await model.setFilter('track-named-audio')
  assert.deepEqual(model.getSnapshot().items.map(value => value.id), ['edition-3']); assert.equal(model.getSnapshot().counts.all, 3)
  await model.search('命名'); assert.equal(model.getSnapshot().query, '命名'); assert.equal(model.getSnapshot().counts.all, 1)
  await model.setRoot(otherRoot); assert.equal(model.getSnapshot().status, 'empty'); assert.equal(model.getSnapshot().loaded, true)
  assert.deepEqual(LOCAL_ALBUM_STATUSES, ['missing-artwork', 'has-artwork', 'cue-unsplit', 'metadata-issue', 'parse-failed', 'loose-audio', 'track-named-audio', 'missing-lyrics'])
})

test('MBF首页失败、确认空结果、加载更多失败和刷新失败分别呈现且错误不泄露内部原因', async t => {
  const albums = [album(1), album(2), album(3)]
  let failure: 'initial' | 'more' | 'refresh' | null = 'initial'
  const model = createLocalAlbumBrowserModel({ api: api(albums, { queryAlbums: async request => {
    if (failure === 'initial' || failure === 'refresh' || failure === 'more' && request.offset > 0) throw new Error('file:///private/example token=合成内部凭据')
    return page(request, albums)
  } }), pageSize: 2 }); t.after(model.dispose)
  await model.activate()
  assert.equal(model.getSnapshot().status, 'error'); assert.equal(model.getSnapshot().loaded, false); assert.match(model.getSnapshot().error, /暂时无法读取/u)
  assert.doesNotMatch(JSON.stringify(model.getSnapshot()), /file:|private|token=|凭据/u)
  failure = null; await model.refresh(); assert.equal(model.getSnapshot().status, 'ready')
  failure = 'more'; await model.loadMore(); assert.equal(model.getSnapshot().items.length, 2); assert.match(model.getSnapshot().loadMoreError, /更多专辑/u); assert.equal(model.getSnapshot().error, '')
  failure = 'refresh'; const previous = model.getSnapshot().items; await model.refresh()
  assert.equal(model.getSnapshot().items, previous); assert.equal(model.getSnapshot().stale, true); assert.match(model.getSnapshot().refreshError, /保留上次/u)
  failure = null; await model.search('没有匹配的合成标题')
  assert.equal(model.getSnapshot().status, 'empty'); assert.equal(model.getSnapshot().loaded, true); assert.equal(model.getSnapshot().error, '')
})

test('MBF查询代际丢弃迟到搜索与离页回复，旧请求不能清除新请求的加载状态', async t => {
  const first = deferred<LocalAlbumPage>(), next = deferred<LocalAlbumPage>(), albums = [album(1, { title: '旧专辑' }), album(2, { title: '新专辑' })]
  const requests: LocalAlbumQuery[] = []
  const model = createLocalAlbumBrowserModel({ api: api(albums, { queryAlbums: request => { requests.push(request); return requests.length === 1 ? first.promise : next.promise } }) }); t.after(model.dispose)
  const activating = model.activate(), searching = model.search('新')
  first.resolve(page(requests[0]!, albums)); await activating
  assert.equal(model.getSnapshot().query, '新'); assert.equal(model.getSnapshot().initialLoading, true); assert.equal(model.getSnapshot().items.length, 0)
  model.deactivate(); const before = model.getSnapshot()
  next.resolve(page(requests[1]!, albums)); await searching
  assert.equal(model.getSnapshot(), before); assert.equal(model.getSnapshot().active, false); assert.equal(model.getSnapshot().loaded, false)
})

test('MBF进入详情读取真实轨道与资产事实、按页追加，并在返回时恢复搜索筛选和滚动', async t => {
  const selected = album(1, { statuses: ['has-artwork', 'metadata-issue'] }), requests: LocalAlbumTrackQuery[] = []
  const model = createLocalAlbumBrowserModel({ api: api([selected], { queryAlbumTracks: async request => { requests.push(request); return trackPage(request, selected) } }), trackPageSize: 2 }); t.after(model.dispose)
  await model.activate(); await model.search('同名'); await model.setFilter('metadata-issue'); model.setScrollTop(742)
  await model.openAlbum(model.getSnapshot().items[0]!, { scrollTop: 742 })
  assert.equal(model.getSnapshot().tracks.length, 2); assert.equal(model.getSnapshot().tracks[0]!.facts.asset.fileRevision, '3')
  assert.equal(model.getSnapshot().tracks[0]!.facts.metadata.raw.title, '原始曲目 1'); assert.equal(model.getSnapshot().tracks[0]!.facts.track.selectionRevision, '2')
  await model.loadMoreTracks(); assert.deepEqual(requests.map(value => value.offset), [0, 2]); assert.equal(model.getSnapshot().tracks.length, 3)
  const displayed = localAlbumTrackPresentation(model.getSnapshot().tracks[0]!, selected)
  assert.equal(displayed.id, selected.representativeTrackId); assert.equal(displayed.version, 'SACD'); assert.equal(displayed.durationMs, 123_000); assert.equal(displayed.format, 'FLAC')
  model.setScrollTop(0); const target = model.closeAlbum()
  assert.deepEqual(target, { albumKey: selected.id, query: '同名', rootId: null, filter: 'metadata-issue', scrollTop: 742 })
  assert.equal(model.getSnapshot().scrollTop, 742); assert.equal(model.getSnapshot().query, '同名'); assert.equal(model.getSnapshot().filter, 'metadata-issue'); assert.equal(model.getSnapshot().selectedAlbum, null)
})

test('MBF切换详情与关闭后迟到曲目不覆盖当前专辑，也不产生新播放意图', async t => {
  const left = album(1), right = album(2), late = deferred<LocalAlbumTrackPage>(), closeLate = deferred<LocalAlbumTrackPage>()
  let leftReads = 0
  const requests: LocalAlbumTrackQuery[] = []
  const model = createLocalAlbumBrowserModel({ api: api([left, right], { queryAlbumTracks: request => {
    requests.push(request)
    return request.albumKey === left.id ? ++leftReads === 1 ? late.promise : closeLate.promise : Promise.resolve(trackPage(request, right))
  } }) }); t.after(model.dispose)
  await model.activate(); const old = model.openAlbum(left); await model.openAlbum(right)
  late.resolve(trackPage(requests[0]!, left)); await old
  assert.equal(model.getSnapshot().selectedAlbum?.id, right.id); assert.equal(model.getSnapshot().tracks[0]!.facts.track.id, right.representativeTrackId)
  const closing = model.openAlbum(left); model.closeAlbum(); const closed = model.getSnapshot()
  closeLate.resolve(trackPage(requests[2]!, left)); await closing
  assert.equal(model.getSnapshot(), closed); assert.equal(model.getSnapshot().selectedAlbum, null); assert.equal(model.getSnapshot().tracks.length, 0)
})

test('MBF未分轨CUE目录可拥有零曲目与空代表轨道，不误归入AI名称增强失败', async t => {
  const failed = album(1, { id: 'directory-root1-opaque', kind: 'source-directory', editionId: null, trackCount: 0, representativeTrackId: null, artworkAvailable: false, statuses: ['missing-artwork', 'cue-unsplit'] })
  let imageReads = 0
  const model = createLocalAlbumBrowserModel({ api: api([failed], { getArtwork: async request => { imageReads++; return { ...request, image: null } } }) }); t.after(model.dispose)
  await model.activate(); await model.openAlbum(failed); await model.ensureArtwork(failed)
  assert.equal(model.getSnapshot().detailStatus, 'empty'); assert.equal(model.getSnapshot().trackTotal, 0); assert.equal(model.getSnapshot().tracks.length, 0)
  assert.equal(model.getSnapshot().selectedAlbum?.representativeTrackId, null); assert.equal(model.artworkFor(failed).status, 'missing'); assert.equal(imageReads, 0)
  assert.equal(model.getSnapshot().counts['parse-failed'], 0)
  assert.equal(isLocalAlbumSummary({ ...failed, representativeTrackId: id(999) }), false)
})

test('MBF图片仅按需读取且有并发、LRU字节和条数预算，查询页不携带大图', async t => {
  const albums = [album(1), album(2), album(3)], jobs: Array<{ request: LocalAlbumArtworkRequest; pending: ReturnType<typeof deferred<LocalAlbumArtworkReply>> }> = []
  let running = 0, maximum = 0
  const model = createLocalAlbumBrowserModel({ api: api(albums, { getArtwork: request => {
    const pending = deferred<LocalAlbumArtworkReply>(); jobs.push({ request, pending }); running++; maximum = Math.max(maximum, running)
    return pending.promise.finally(() => { running-- })
  } }), artworkConcurrency: 2, artworkCacheBytes: 112, artworkCacheEntries: 2 }); t.after(model.dispose)
  await model.activate(); assert.equal(jobs.length, 0); assert.equal('image' in model.getSnapshot().items[0]!, false)
  const first = model.ensureArtwork(albums[0]!), second = model.ensureArtwork(albums[1]!), same = model.ensureArtwork(albums[0]!)
  assert.equal(jobs.length, 2); assert.equal(model.getArtworkCacheUsage().running, 2)
  jobs[0]!.pending.resolve({ ...jobs[0]!.request, image: image() }); jobs[1]!.pending.resolve({ ...jobs[1]!.request, image: image() }); await Promise.all([first, second, same])
  const third = model.ensureArtwork(albums[2]!); assert.equal(jobs.length, 3)
  jobs[2]!.pending.resolve({ ...jobs[2]!.request, image: image() }); await third
  assert.equal(maximum, 2); assert.equal(model.getArtworkCacheUsage().entries, 2); assert.ok(model.getArtworkCacheUsage().bytes <= 112)
  assert.equal(model.artworkFor(albums[0]!).status, 'idle'); assert.equal(model.artworkFor(albums[2]!).status, 'ready')
  assert.equal(model.artworkFor(albums[2]!).dataUrl, 'data:image/jpeg;base64,/9j/')
  assert.equal(JSON.stringify(model.getSnapshot().artwork).includes('original'), false)
})

test('MBF封面错误不自动循环重试，显式重试拒绝URL、错误身份和超预算显示图', async t => {
  const selected = album(1); let reads = 0
  const model = createLocalAlbumBrowserModel({ api: api([selected], { getArtwork: async request => {
    reads++
    return reads === 1 ? { ...artworkTuple(request), image: { ...image(), display: { ...image().display, dataUrl: 'https://example.invalid/unsafe.jpg' } } }
      : reads === 2 ? { ...artworkTuple(request), rootId: otherRoot, image: image() } : { ...artworkTuple(request), image: image() }
  } }) }); t.after(model.dispose)
  await model.activate(); await model.ensureArtwork(selected); assert.equal(model.artworkFor(selected).status, 'error'); assert.equal(model.artworkFor(selected).dataUrl, null)
  await model.ensureArtwork(selected); assert.equal(reads, 1); await model.retryArtwork(selected); assert.equal(model.artworkFor(selected).status, 'error')
  await model.retryArtwork(selected); assert.equal(model.artworkFor(selected).status, 'ready'); assert.equal(reads, 3)
  const small = createLocalAlbumBrowserModel({ api: api([selected]), artworkCacheBytes: 1 }); t.after(small.dispose)
  await small.activate(); await small.ensureArtwork(selected); assert.equal(small.artworkFor(selected).status, 'error'); assert.equal(small.getArtworkCacheUsage().bytes, 0)
})

test('MBF真实选图终态后必须显式失效，更新gallery修订且迟到旧封面不覆盖新图', async t => {
  let selected = album(1), imageReads = 0, queryReads = 0
  const late = deferred<LocalAlbumArtworkReply>(), requests: LocalAlbumArtworkRequest[] = []
  const model = createLocalAlbumBrowserModel({ api: api([selected], { queryAlbums: async request => { queryReads++; return page(request, [selected]) },
    getArtwork: request => { requests.push(request); return ++imageReads === 1 ? late.promise : Promise.resolve({ ...request, image: image('abcd') }) } }) }); t.after(model.dispose)
  await model.activate(); const oldImage = model.ensureArtwork(selected)
  selected = { ...selected, revision: '2', versionLabel: '真实选图后修订' }
  await model.invalidateArtwork(selected.id)
  const refreshed = model.getSnapshot().items[0]!
  assert.equal(refreshed.revision, '2'); assert.equal(queryReads, 2)
  await model.ensureArtwork(refreshed); late.resolve({ ...requests[0]!, image: image() }); await oldImage
  assert.equal(model.artworkFor(refreshed).dataUrl, 'data:image/jpeg;base64,abcd'); assert.equal(model.getSnapshot().items[0]!.revision, '2')
})

test('MBF离页时封面队列停止派发，迟到结果不污染返回后的缓存', async t => {
  const albums = [album(1), album(2)], pending = deferred<LocalAlbumArtworkReply>(), requests: LocalAlbumArtworkRequest[] = []
  const model = createLocalAlbumBrowserModel({ api: api(albums, { getArtwork: request => { requests.push(request); return pending.promise } }), artworkConcurrency: 1 }); t.after(model.dispose)
  await model.activate(); const first = model.ensureArtwork(albums[0]!), queued = model.ensureArtwork(albums[1]!)
  assert.equal(requests.length, 1); model.deactivate(); await queued; const snapshot = model.getSnapshot()
  pending.resolve({ ...requests[0]!, image: image() }); await first
  assert.equal(model.getSnapshot(), snapshot); assert.equal(requests.length, 1); assert.equal(model.getArtworkCacheUsage().queued, 0)
  assert.equal(model.artworkFor(albums[0]!).status, 'idle')
})

test('MBF未探测目录与无轨CUE封面不冒充缺图，按真实albumKey探测并区分来源暂不可用', async t => {
  const selected = album(1, { id: 'directory-zero-track', kind: 'source-directory', editionId: null, trackCount: 0, representativeTrackId: null,
    artworkAvailable: false, artworkState: 'unknown', statuses: ['cue-unsplit'] })
  const requests: LocalAlbumArtworkRequest[] = []; let available = false
  const model = createLocalAlbumBrowserModel({ api: api([selected], { getArtwork: async request => { requests.push(request); return available ? { ...artworkTuple(request), image: image(), status: 'ready' }
    : { ...artworkTuple(request), image: null, status: 'source-unavailable' } } }) }); t.after(model.dispose)
  await model.activate(); assert.equal(model.getSnapshot().counts['missing-artwork'], 0); assert.equal(model.artworkFor(selected).status, 'idle')
  await model.ensureArtwork(selected); assert.equal(requests[0]!.representativeTrackId, null); assert.equal(model.artworkFor(selected).status, 'error'); assert.equal(model.artworkFor(selected).canRetry, true)
  await model.ensureArtwork(selected); assert.equal(requests.length, 1)
  available = true; await model.retryArtwork(selected); assert.equal(model.artworkFor(selected).status, 'ready'); assert.equal(requests.length, 2)
})

test('MBF明确来源不可用先提示重试，只有实际探测ready且null才确认没有封面', async t => {
  const selected = album(1, { artworkAvailable: false, artworkState: 'source-unavailable', statuses: [] }); let reads = 0
  const model = createLocalAlbumBrowserModel({ api: api([selected], { getArtwork: async request => { reads++; return { ...artworkTuple(request), image: null, status: 'ready' } } }) }); t.after(model.dispose)
  await model.activate(); await model.ensureArtwork(selected)
  assert.equal(reads, 0); assert.equal(model.artworkFor(selected).status, 'error'); assert.equal(model.getSnapshot().counts['missing-artwork'], 0)
  await model.retryArtwork(selected); assert.equal(reads, 1); assert.equal(model.artworkFor(selected).status, 'missing')
})

test('MBF详情内重试不可用来源先更新详情修订，恢复后封面不用过期请求身份', async t => {
  const selected = album(1, { artworkAvailable: false, artworkState: 'source-unavailable', statuses: [] }), requests: LocalAlbumArtworkRequest[] = []
  let current = selected
  const model = createLocalAlbumBrowserModel({ api: api([selected], { queryAlbums: async request => page(request, [current]), queryAlbumTracks: async request => trackPage(request, current),
    getArtwork: async request => { requests.push(request); assert.equal(request.revision, current.revision); return { ...artworkTuple(request), image: image(), status: 'ready' } } }) }); t.after(model.dispose)
  await model.activate(); await model.openAlbum(selected); await model.ensureArtwork(selected)
  current = { ...selected, revision: '2', artworkState: 'unknown' }
  await model.retryArtwork(selected)
  assert.equal(model.getSnapshot().selectedAlbum?.revision, '2'); assert.equal(requests[0]!.revision, '2'); assert.equal(model.artworkFor(current).status, 'ready')
})

test('MBF封面来源重试等候刷新期间切换搜索，旧重试不再向新页面派发请求', async t => {
  const selected = album(1, { artworkAvailable: false, artworkState: 'source-unavailable', statuses: [] }), pending = deferred<LocalAlbumPage>()
  let reads = 0, artworkReads = 0, refreshRequest!: LocalAlbumQuery
  const model = createLocalAlbumBrowserModel({ api: api([selected], { queryAlbums: request => {
    reads++; if (reads === 2) { refreshRequest = request; return pending.promise }; return Promise.resolve(page(request, [selected]))
  }, getArtwork: async request => { artworkReads++; return { ...request, image: image() } } }) }); t.after(model.dispose)
  await model.activate(); const retrying = model.retryArtwork(selected)
  await model.search('新搜索'); pending.resolve(page(refreshRequest, [selected])); await retrying
  assert.equal(model.getSnapshot().query, '新搜索'); assert.equal(model.getSnapshot().status, 'empty'); assert.equal(artworkReads, 0)
  assert.equal(model.getSnapshot().artwork[selected.id], undefined)
})

test('MBF分页身份、未知字段、重复专辑和来源错配均拒绝，已有页不被默默合并', async t => {
  const albums = [album(1), album(2)], requests: LocalAlbumQuery[] = []
  const model = createLocalAlbumBrowserModel({ api: api(albums, { queryAlbums: async request => { requests.push(request); const result = page(request, albums); return request.offset ? { ...result, items: [albums[0]!] } : result } }), pageSize: 1 }); t.after(model.dispose)
  await model.activate(); await model.loadMore()
  assert.equal(model.getSnapshot().items.length, 1); assert.match(model.getSnapshot().loadMoreError, /更多专辑/u)
  const valid = page(requests[0]!, albums)
  assert.equal(isLocalAlbumPage({ ...valid, image: image() }, requests[0]!), false)
  assert.equal(isLocalAlbumPage({ ...valid, query: '另一搜索' }, requests[0]!), false)
  assert.equal(isLocalAlbumSummary({ ...albums[0], sourceLabel: '/private/unsafe' }), false)
  assert.equal(isLocalAlbumArtworkReply({ ...requests[0], image: image() }, { albumKey: albums[0]!.id, rootId: root, editionId: albums[0]!.editionId, representativeTrackId: albums[0]!.representativeTrackId, revision: '1' }), false)
  let getterCalls = 0
  const invalid = { ...albums[0] }; Object.defineProperty(invalid, 'title', { enumerable: true, get: () => { getterCalls++; return '不应执行' } })
  assert.equal(isLocalAlbumSummary(invalid), false); assert.equal(getterCalls, 0)
})

test('MBF读取快照与API原对象分离，Vue组合式函数不自动读取且scope销毁丢弃迟到响应', async t => {
  const selected = album(1), reply = page({ query: '', rootId: null, filter: 'all', offset: 0, limit: 60 }, [selected])
  const model = createLocalAlbumBrowserModel({ api: api([selected], { queryAlbums: async () => reply }) }); t.after(model.dispose)
  await model.activate(); selected.title = 'API原对象之后改变'
  assert.equal(model.getSnapshot().items[0]!.title, '同名专辑'); assert.equal(Object.isFrozen(model.getSnapshot().items[0]), true)
  const pending = deferred<LocalAlbumPage>(); let request: LocalAlbumQuery | undefined, reads = 0
  const scope = effectScope(), session = scope.run(() => useLocalAlbumBrowser({ api: api([album(2)], { queryAlbums: value => { reads++; request = value; return pending.promise } }) }))!
  assert.equal(reads, 0); const activating = session.activate(); assert.equal(session.initialLoading.value, true)
  scope.stop(); const snapshot = session.snapshot.value
  pending.resolve(page(request!, [album(2)])); await activating; await settle()
  assert.equal(session.snapshot.value, snapshot); assert.equal(session.snapshot.value.active, false); assert.equal(session.snapshot.value.items.length, 0)
})

// 原自有16×16 JPEG，整字节SHA；这里只验证公共DTO/渲染分支，不授Main实际decoder资格。
function publicArtworkFixture(): dto.LocalArtworkImage {
  const bytes = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgMCAgMDAgMDAwMDBAcFBAQEBAkGBwUHCgkLCwoJCgoMDREODAwQDAoKDhQPEBESExMTCw4UFhQSFhESExL/2wBDAQMDAwQEBAgFBQgSDAoMEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhL/wAARCAAQABADAREAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD5++FfwE/1P+jen8NbUZHmcO8Xbe8fVGj/AAZTRPBmqXkoa08qycJMoIKSMNqEEcj5ivPbrxX0GVyprEwlVaUIvmk5NKKjHWTbellFNu/Q/R8+8QVlnC+OxPtnCSpyUZK91OS5YW5dU+dxSfR6tpK657Qvj94D8OQ3A8NaRrHiCW2EZhnMIs7WfO0t875lXALDmLllwOCGr34eHeLwWCePzfEQw9CCbm23KUei0jpJydkkpXd0knL3T8G4D8NuIMZKl9brQoqV7q/PNb20XuO+n/LzRO71VjP+NP7VHjrX/Ad1p3grQdI8N6bqt1awwTGM3V3blSJWYu/7pwTEy4MQwH9QDX4rmEcv4nzGlhqc6n1WmnKUXaHtZbLnUW3GMG04xVRpyjzy3jGH7txx4fZBknBijj6k8RUrVIwfvckFq6ifKk57QS/iLV3va8X/AP/Z', 'base64'), sha256 = createHash('sha256').update(bytes).digest('hex');
  return { original: { mime: 'image/jpeg', bytes: bytes.length, sha256, width: 16, height: 16 },
    display: { mime: 'image/jpeg', bytes: bytes.length, sha256, width: 16, height: 16, dataUrl: `data:image/jpeg;base64,${bytes.toString('base64')}` } };
}

test('公共封面贯穿client/Main/model：合法JPEG进入ready，RPC和错DTO为error且ready-null仅表示无图', async t => {
  const datasetId=id(901), selected=album(81,{artworkState:'available'}), displayed=publicArtworkFixture();
  let handler!: (event:{},value:unknown)=>Promise<unknown>, mode:'ready'|'rpc-rejected'|'wrong-tuple'|'missing'|'source-unavailable'='ready';
  const event=Object.freeze({}), requested: dto.LocalAlbumArtworkRequest[]=[];
  registerLocalAlbumIpc({ipcMain:{handle(channel,callback){assert.equal(channel,'localAlbum:request');handler=callback}},assertTrusted(received){assert.equal(received,event)},assertDataset(value){assert.equal(value,datasetId)},
    async read(request){
      if(request.command==='localAlbum.query')return page(request.payload,[selected]);
      if(request.command==='localAlbum.tracks')return trackPage(request.payload,selected);
      requested.push(structuredClone(request.payload));
      if(mode==='rpc-rejected')throw new Error('受控内部错误 /private/不应进入Renderer消息');
      return {...artworkTuple(request.payload as LocalAlbumArtworkRequest),...(mode==='wrong-tuple'?{revision:'wrong-revision'}:{}), image:mode==='missing'||mode==='source-unavailable'?null:displayed,
        status:mode==='source-unavailable'?'source-unavailable' as const:'ready' as const};
    }});
  const client=createLocalAlbumClient((channel,value)=>{assert.equal(channel,'localAlbum:request');return handler(event,value)},async()=>datasetId);
  const model=createLocalAlbumBrowserModel({api:{queryAlbums:client.queryLocalAlbums,queryAlbumTracks:client.getLocalAlbumTracks,getArtwork:client.getLocalAlbumArtwork}});t.after(model.dispose);
  await model.activate();await model.ensureArtwork(selected);
  assert.deepEqual(requested[0],{albumKey:selected.id,rootId:selected.rootId,editionId:selected.editionId,representativeTrackId:selected.representativeTrackId,revision:selected.revision});
  assert.equal(model.artworkFor(selected).status,'ready');assert.equal(model.artworkFor(selected).dataUrl,displayed.display.dataUrl);assert.equal(model.artworkFor(selected).canRetry,false);
  for (const next of ['rpc-rejected','wrong-tuple'] as const) {mode=next;await model.retryArtwork(selected);const state=model.artworkFor(selected);assert.equal(state.status,'error');assert.equal(state.dataUrl,null);assert.equal(state.canRetry,true);assert.doesNotMatch(state.error,/private|wrong-revision/u);}
  mode='missing';await model.retryArtwork(selected);assert.equal(model.artworkFor(selected).status,'missing');assert.equal(model.artworkFor(selected).dataUrl,null);
  await model.invalidateArtwork(selected.id);mode='source-unavailable';await model.ensureArtwork(selected);assert.equal(model.artworkFor(selected).status,'error');assert.equal(model.artworkFor(selected).canRetry,true);
  assert.equal(requested.length,5,'无图/来源不可用不自动重试，也不借IMG事件混成RPC层证明。');
});

test('本地音乐与CoverDrop保留各自纯读范围选择详情位置，切页不串回复或加倍封面缓存', async t => {
  const values = [album(1, { title: '本地专辑' }), album(2, { rootId: otherRoot, title: '整理专辑', statuses: ['has-artwork', 'missing-lyrics'] })]
  const requests: LocalAlbumQuery[] = []
  const scope = effectScope(), pages = scope.run(() => useLocalAlbumBrowserPages({ api: api(values, {
    queryAlbums: async request => { requests.push(request); return page(request, values) },
  }) }))!
  t.after(() => scope.stop())
  assert.notEqual(pages.localLibrary, pages.coverDrop)
  await pages.localLibrary.activate()
  assert.equal(pages.coverDrop.snapshot.value.active, false)
  assert.equal(pages.coverDrop.snapshot.value.loaded, false)
  await pages.localLibrary.setScope({ query: '本地', rootId: root, filter: 'has-artwork' })
  pages.localLibrary.setScrollTop(742); pages.localLibrary.setSelectedAlbums([values[0]!.id])
  await pages.localLibrary.openAlbum(values[0]!); await pages.localLibrary.ensureArtwork(values[0]!)
  const origin = pages.localLibrary.snapshot.value
  assert.ok(pages.localLibrary.getArtworkCacheUsage().bytes > 0)
  await pages.coverDrop.activate()
  assert.equal(pages.localLibrary.snapshot.value.active, false)
  assert.equal(pages.localLibrary.getArtworkCacheUsage().bytes, 0)
  assert.equal(pages.coverDrop.snapshot.value.query, '')
  await pages.coverDrop.setScope({ query: '整理', rootId: otherRoot, filter: 'missing-lyrics' })
  pages.coverDrop.setScrollTop(128); pages.coverDrop.setSelectedAlbums([values[1]!.id])
  await pages.coverDrop.openAlbum(values[1]!); await pages.coverDrop.ensureArtwork(values[1]!)
  assert.equal(pages.localLibrary.snapshot.value.query, origin.query)
  assert.equal(pages.localLibrary.snapshot.value.rootId, origin.rootId)
  assert.equal(pages.localLibrary.snapshot.value.filter, origin.filter)
  assert.equal(pages.localLibrary.snapshot.value.scrollTop, origin.scrollTop)
  assert.deepEqual(pages.localLibrary.snapshot.value.selectedAlbumIds, origin.selectedAlbumIds)
  assert.equal(pages.localLibrary.snapshot.value.selectedAlbum?.id, origin.selectedAlbum?.id)
  assert.equal(pages.localLibrary.snapshot.value.returnTarget, origin.returnTarget)
  const coverOrigin = pages.coverDrop.snapshot.value
  await pages.localLibrary.activate()
  assert.equal(pages.coverDrop.snapshot.value.active, false)
  assert.equal(pages.coverDrop.getArtworkCacheUsage().bytes, 0)
  assert.equal(pages.localLibrary.snapshot.value.scrollTop, 742)
  assert.equal(pages.coverDrop.snapshot.value.selectedAlbum?.id, coverOrigin.selectedAlbum?.id)
  assert.ok(requests.some(request => request.query === '本地' && request.rootId === root && request.filter === 'has-artwork'))
  assert.ok(requests.some(request => request.query === '整理' && request.rootId === otherRoot && request.filter === 'missing-lyrics'))
  // 独立迟到案例使用正在请求的原对象，不能靠换 query 或伪造身份触发拒绝。
  const pendingRead = deferred<LocalAlbumPage>(), pendingRequests: LocalAlbumQuery[] = []
  const pendingScope = effectScope(), pendingPages = pendingScope.run(() => useLocalAlbumBrowserPages({ api: api(values, {
    queryAlbums: request => { pendingRequests.push(request); return pendingRequests.length === 1 ? pendingRead.promise : Promise.resolve(page(request, values)) },
  }) }))!
  t.after(() => pendingScope.stop())
  const opening = pendingPages.localLibrary.activate()
  await pendingPages.coverDrop.activate(); const beforeLate = pendingPages.localLibrary.snapshot.value, coverBeforeLate = pendingPages.coverDrop.snapshot.value
  pendingRead.resolve(page(pendingRequests[0]!, values)); await opening
  assert.equal(pendingPages.localLibrary.snapshot.value, beforeLate)
  assert.equal(pendingPages.coverDrop.snapshot.value, coverBeforeLate)
  assert.equal(pendingPages.localLibrary.snapshot.value.loaded, false)
  assert.equal(pendingPages.coverDrop.snapshot.value.loaded, true)
})


// 重新激活只读取原scope的当前事实；不扫描、不写源、不请求Owner或真实App。
test('MBF重新激活593：成功空结果离页后源变1，原scope返回只查一次且保查询筛选滚动',async t=>{
  const values:LocalAlbumSummary[]=[],requests:LocalAlbumQuery[]=[],model=createLocalAlbumBrowserModel({api:api(values,{queryAlbums:async request=>{requests.push({...request});return page(request,values)}})});t.after(model.dispose)
  await model.setScope({query:'返回',rootId:otherRoot,filter:'has-artwork'});assert.equal(requests.length,0)
  await model.activate();assert.equal(requests.length,1);assert.equal(model.getSnapshot().loaded,true);assert.equal(model.getSnapshot().status,'empty');assert.equal(model.getSnapshot().total,0);assert.equal(model.getSnapshot().stale,false)
  model.setScrollTop(314);model.deactivate();const before=model.getSnapshot()
  values.push(album(9,{rootId:otherRoot,title:'返回后的真实合成专辑'}))
  await model.activate();assert.equal(requests.length,2,'离页后的成功empty不得免除这次当前gallery读取')
  assert.deepEqual(requests[1],{query:'返回',rootId:otherRoot,filter:'has-artwork',offset:0,limit:60})
  const current=model.getSnapshot();assert.equal(current.active,true);assert.equal(current.loaded,true);assert.equal(current.status,'ready');assert.equal(current.total,1);assert.deepEqual(current.items.map(value=>value.id),[values[0]!.id]);assert.equal(current.stale,false)
  assert.equal(current.query,before.query);assert.equal(current.rootId,before.rootId);assert.equal(current.filter,before.filter);assert.equal(current.scrollTop,before.scrollTop)
  const same=current;await model.activate();assert.equal(requests.length,2,'已active不得重复query');assert.equal(model.getSnapshot(),same)
})
test('MBF重新激活593：旧refresh迟到不能覆盖新scope或清除新首页加载状态',async t=>{
  const values=[album(1,{title:'旧专辑'}),album(2,{rootId:otherRoot,title:'新专辑'})],old=deferred<LocalAlbumPage>(),next=deferred<LocalAlbumPage>(),requests:LocalAlbumQuery[]=[]
  const model=createLocalAlbumBrowserModel({api:api(values,{queryAlbums:request=>{requests.push({...request});return requests.length===2?old.promise:requests.length===3?next.promise:Promise.resolve(page(request,values))}})});t.after(model.dispose)
  await model.activate();const originalItems=model.getSnapshot().items;model.deactivate();const returning=model.activate()
  assert.equal(requests.length,2,'重新激活必须进入真实refresh');assert.equal(model.getSnapshot().refreshing,true);assert.equal(model.getSnapshot().items,originalItems)
  const changing=model.setScope({query:'新',rootId:otherRoot,filter:'has-artwork'});assert.equal(requests.length,3);const newLoading=model.getSnapshot()
  assert.equal(newLoading.initialLoading,true);assert.equal(newLoading.query,'新');assert.equal(newLoading.rootId,otherRoot)
  old.resolve(page(requests[1]!,values));await returning
  assert.equal(model.getSnapshot(),newLoading,'旧reactivation reply不得发布任何新scope状态');assert.equal(model.getSnapshot().initialLoading,true)
  next.resolve(page(requests[2]!,values));await changing
  const current=model.getSnapshot();assert.equal(current.status,'ready');assert.equal(current.initialLoading,false);assert.equal(current.refreshing,false);assert.equal(current.query,'新');assert.equal(current.rootId,otherRoot);assert.equal(current.filter,'has-artwork');assert.deepEqual(current.items.map(value=>value.id),[values[1]!.id])
})
test('MBF重新激活593：刷新失败保旧成功范围详情选择缓存，明确refreshError且不泄露内部异常',async t=>{
  const values=[album(3,{rootId:otherRoot,title:'保留专辑'})],requests:LocalAlbumQuery[]=[];let fail=false
  const model=createLocalAlbumBrowserModel({api:api(values,{queryAlbums:async request=>{requests.push({...request});if(fail)throw new Error('file:///synthetic-reactivation-private-failure');return page(request,values)}})});t.after(model.dispose)
  await model.setScope({query:'保留',rootId:otherRoot,filter:'has-artwork'});await model.activate();model.setScrollTop(742);model.setSelectedAlbums([values[0]!.id]);await model.openAlbum(values[0]!,{scrollTop:742});await model.ensureArtwork(values[0]!)
  const previous=model.getSnapshot(),usage=model.getArtworkCacheUsage();assert.equal(previous.status,'ready');assert.equal(previous.loaded,true);assert.equal(previous.stale,false);assert.equal(previous.detailStatus,'ready');assert.ok(usage.bytes>0)
  model.deactivate();fail=true;await model.activate();assert.equal(requests.length,2,'重新进入必须有本次真实失败query，不能免读冒成功')
  const current=model.getSnapshot();assert.equal(current.active,true);assert.equal(current.status,'ready');assert.equal(current.loaded,true);assert.equal(current.items,previous.items);assert.equal(current.total,previous.total);assert.deepEqual(current.counts,previous.counts)
  assert.equal(current.query,previous.query);assert.equal(current.rootId,previous.rootId);assert.equal(current.filter,previous.filter);assert.equal(current.scrollTop,previous.scrollTop);assert.equal(current.selectedAlbum,previous.selectedAlbum);assert.deepEqual(current.selectedAlbumIds,previous.selectedAlbumIds);assert.equal(current.returnTarget,previous.returnTarget)
  assert.equal(current.error,'');assert.equal(current.stale,true);assert.match(current.refreshError,/保留上次/u);assert.equal(current.refreshing,false);assert.equal(current.initialLoading,false);assert.doesNotMatch(JSON.stringify(current),/synthetic-reactivation-private-failure|file:\/\//u)
  assert.deepEqual(model.getArtworkCacheUsage(),usage);assert.equal(model.artworkFor(values[0]!).status,'ready')
})


// 纯读模型的临时来源失败恢复；不调用真实Source、Native、播放或工作库。
test('MBF临时封面恢复：默认与显式过高并发都不超过原两个读取槽', async t => {
  for (const concurrency of [undefined, 4]) {
    const values = [album(11), album(12), album(13)], jobs: Array<{ request: LocalAlbumArtworkRequest; pending: ReturnType<typeof deferred<LocalAlbumArtworkReply>> }> = []
    let running = 0, maximum = 0
    const model = createLocalAlbumBrowserModel({ api: api(values, { getArtwork: request => {
      const pending = deferred<LocalAlbumArtworkReply>(); jobs.push({ request, pending }); running++; maximum = Math.max(maximum, running)
      return pending.promise.finally(() => { running-- })
    } }), ...(concurrency === undefined ? {} : { artworkConcurrency: concurrency }) })
    t.after(() => { model.dispose(); for (const job of jobs) job.pending.resolve({ ...job.request, image: image() }) })
    await model.activate(); assert.equal(jobs.length, 0)
    const pending = values.map(value => model.ensureArtwork(value))
    assert.equal(jobs.length, 2); assert.equal(model.getArtworkCacheUsage().running, 2); assert.equal(model.getArtworkCacheUsage().queued, 1)
    jobs[0]!.pending.resolve({ ...jobs[0]!.request, image: image() }); await pending[0]
    assert.equal(jobs.length, 3); assert.equal(model.getArtworkCacheUsage().running, 2)
    jobs[1]!.pending.resolve({ ...jobs[1]!.request, image: image() }); jobs[2]!.pending.resolve({ ...jobs[2]!.request, image: image() }); await Promise.all(pending)
    assert.equal(maximum, 2); assert.equal(model.getArtworkCacheUsage().running, 0); assert.equal(model.getArtworkCacheUsage().queued, 0)
    assert.equal(model.getArtworkCacheUsage().entries, 3); assert.ok(model.getArtworkCacheUsage().bytes <= 8 * 1024 * 1024)
  }
})

test('MBF临时封面恢复：失败刷新保原错误，成功刷新只重读一次且仍繁忙不循环', async t => {
  const selected = album(14, { artworkState: 'unknown', artworkAvailable: false, statuses: [] }); let queryReads = 0, artworkReads = 0, queryFails = false, available = false
  const model = createLocalAlbumBrowserModel({ api: api([selected], { queryAlbums: async request => {
    queryReads++; if (queryFails) throw new Error('file:///synthetic-transient-private-error'); return page(request, [selected])
  }, getArtwork: async request => { artworkReads++; return available ? { ...request, image: image(), status: 'ready' } : { ...request, image: null, status: 'source-unavailable' } } }) }); t.after(model.dispose)
  await model.activate(); await model.ensureArtwork(selected)
  const unavailable = model.artworkFor(selected), usage = model.getArtworkCacheUsage()
  assert.equal(unavailable.status, 'error'); assert.equal(unavailable.canRetry, true); assert.equal(artworkReads, 1)
  for (let n = 0; n < 4; n++) await model.ensureArtwork(selected)
  assert.equal(artworkReads, 1)
  queryFails = true; await model.refresh(); await model.ensureArtwork(selected)
  assert.equal(artworkReads, 1); assert.equal(model.artworkFor(selected), unavailable); assert.deepEqual(model.getArtworkCacheUsage(), usage)
  assert.equal(model.getSnapshot().stale, true); assert.match(model.getSnapshot().refreshError, /保留上次/u); assert.doesNotMatch(JSON.stringify(model.getSnapshot()), /synthetic-transient-private-error|file:\/\//u)
  queryFails = false; await model.refresh(); await model.ensureArtwork(model.getSnapshot().items[0]!)
  assert.equal(artworkReads, 2); assert.equal(model.artworkFor(selected).status, 'error')
  for (let n = 0; n < 4; n++) await model.ensureArtwork(selected)
  assert.equal(artworkReads, 2, '成功范围刷新只授本次原不可用项一次探测，仍繁忙不能自动再派发')
  await model.refresh(); await model.ensureArtwork(selected); assert.equal(artworkReads, 3, '新的明确刷新代仍可恢复，不能把临时繁忙冻结为永久失败')
  for (let n = 0; n < 4; n++) await model.ensureArtwork(selected)
  assert.equal(artworkReads, 3, '同刷新代内的重复ensure不续授机会')
  available = true; model.deactivate(); await model.activate(); await model.ensureArtwork(selected)
  assert.equal(queryReads, 5); assert.equal(artworkReads, 4, '下一明确重新激活可恢复同五字段临时失败'); assert.equal(model.artworkFor(selected).status, 'ready')
  await model.refresh(); await model.ensureArtwork(selected); assert.equal(artworkReads, 4)
})

test('MBF临时封面恢复：重新激活恢复来源失败，普通错误仍显式重试且ready和missing缓存保留', async t => {
  const busy = album(15, { artworkState: 'unknown', artworkAvailable: false, statuses: [] }), invalid = album(16), ready = album(17), missing = album(18, { artworkAvailable: false, artworkState: 'missing', statuses: ['missing-artwork'] })
  const values = [busy, invalid, ready, missing], reads = new Map<string, number>(); let available = false, queryReads = 0
  const model = createLocalAlbumBrowserModel({ api: api(values, { queryAlbums: async request => { queryReads++; return page(request, values) }, getArtwork: async request => {
    reads.set(request.albumKey, (reads.get(request.albumKey) ?? 0) + 1)
    if (request.albumKey === busy.id && !available) return { ...request, image: null, status: 'source-unavailable' }
    if (request.albumKey === invalid.id && !available) return { ...artworkTuple(request), image: { ...image(), display: { ...image().display, dataUrl: 'https://example.invalid/unsafe.jpg' } } }
    return { ...artworkTuple(request), image: image(), status: 'ready' }
  } }) }); t.after(model.dispose)
  await model.activate(); await Promise.all(values.map(value => model.ensureArtwork(value))); model.setScrollTop(314)
  const error = model.artworkFor(invalid), readyState = model.artworkFor(ready), missingState = model.artworkFor(missing)
  assert.equal(error.status, 'error'); assert.equal(readyState.status, 'ready'); assert.equal(missingState.status, 'missing')
  model.deactivate(); available = true; await model.activate(); await Promise.all(values.map(value => model.ensureArtwork(value)))
  assert.equal(queryReads, 2); assert.equal(reads.get(busy.id), 2); assert.equal(model.artworkFor(busy).status, 'ready')
  assert.equal(reads.get(invalid.id), 1); assert.equal(model.artworkFor(invalid), error)
  assert.equal(reads.get(ready.id), 1); assert.equal(model.artworkFor(ready), readyState); assert.equal(reads.has(missing.id), false); assert.equal(model.artworkFor(missing), missingState)
  assert.equal(model.getSnapshot().scrollTop, 314); await model.activate(); assert.equal(queryReads, 2)
  await model.refresh(); await Promise.all(values.map(value => model.ensureArtwork(value))); assert.equal(reads.get(invalid.id), 1); assert.equal(reads.get(busy.id), 2)
  await model.retryArtwork(invalid); assert.equal(reads.get(invalid.id), 2); assert.equal(model.artworkFor(invalid).status, 'ready')
})

test('MBF临时封面恢复：详情刷新丢弃关闭后的迟到回复，再次合法刷新才恢复原项', async t => {
  const selected = album(19, { artworkState: 'unknown', artworkAvailable: false, statuses: [] }), late = deferred<LocalAlbumTrackPage>()
  let detailReads = 0, artworkReads = 0, available = false, lateRequest!: LocalAlbumTrackQuery
  const model = createLocalAlbumBrowserModel({ api: api([selected], { queryAlbumTracks: request => {
    if (++detailReads === 2) { lateRequest = request; return late.promise }; return Promise.resolve(trackPage(request, selected))
  }, getArtwork: async request => { artworkReads++; return available ? { ...request, image: image(), status: 'ready' } : { ...request, image: null, status: 'source-unavailable' } } }) }); t.after(model.dispose)
  await model.activate(); await model.openAlbum(selected); await model.ensureArtwork(selected); assert.equal(artworkReads, 1)
  available = true; const refreshing = model.refreshAlbum(); model.closeAlbum(); const closed = model.getSnapshot()
  late.resolve(trackPage(lateRequest, selected)); await refreshing
  assert.equal(model.getSnapshot(), closed); assert.equal(artworkReads, 1); assert.equal(model.getSnapshot().selectedAlbum, null)
  await model.openAlbum(selected); assert.equal(artworkReads, 1); await model.refreshAlbum(); await model.ensureArtwork(model.getSnapshot().selectedAlbum!)
  assert.equal(detailReads, 4); assert.equal(artworkReads, 2); assert.equal(model.artworkFor(selected).status, 'ready')
  await model.refreshAlbum(); await model.ensureArtwork(selected); assert.equal(artworkReads, 2)
})


import { createScanReadAdmission } from '../../../packages/bridge-core/src/library/scan-read-admission.js'
test('MBF临时封面恢复：foreign真实两票连续繁忙后释放，同身份下一激活恢复且渲染不循环', async t => {
  const selected = album(20, { artworkState: 'unknown', artworkAvailable: false, statuses: [] }), context = { epoch: id(900), datasetId: id(901) }, admission = createScanReadAdmission({ isBusy: () => false })
  const foreign = [admission.acquire(context), admission.acquire(context)]; assert.ok(foreign.every(value => value.status === 'granted'))
  let reads = 0
  // 这是纯显示模型+实际Admission状态组合；展示DTO仍合成，不授Source FD或Native解码资格。
  const model = createLocalAlbumBrowserModel({ api: api([selected], { getArtwork: async request => {
    reads++; const permit = admission.acquire(context)
    if (permit.status === 'deferred') return { ...request, image: null, status: 'source-unavailable' }
    try { return { ...request, image: image(), status: 'ready' } } finally { admission.release(context, permit.permitId) }
  } }) }); t.after(() => { model.dispose(); for (const value of foreign) if (value.status === 'granted') admission.release(context, value.permitId); admission.close() })
  await model.activate(); await model.ensureArtwork(selected); assert.equal(reads, 1); assert.equal(model.artworkFor(selected).status, 'error')
  await model.refresh(); await model.ensureArtwork(selected); assert.equal(reads, 2); assert.equal(model.artworkFor(selected).canRetry, true)
  for (let n = 0; n < 5; n++) await model.ensureArtwork(selected)
  assert.equal(reads, 2); assert.equal(admission.resourceCounts().permits, 2)
  for (const value of foreign) { assert.equal(value.status, 'granted'); if (value.status === 'granted') admission.release(context, value.permitId) }
  model.deactivate(); await model.activate(); await model.ensureArtwork(model.getSnapshot().items[0]!)
  assert.equal(reads, 3); assert.equal(model.artworkFor(selected).status, 'ready'); assert.equal(admission.resourceCounts().permits, 0)
  for (let n = 0; n < 5; n++) await model.ensureArtwork(selected)
  assert.equal(reads, 3)
})

// 正式model默认分页与合成来源观察；不证明真实SQL、IMG解码或万级性能。
test('MBF连续浏览封面观察变化：187项未知封面首图成功后分页继续至完整墙', async t => {
  const albums = Array.from({ length: 187 }, (_, index) => album(index + 1, { artworkAvailable: false, artworkState: 'unknown', statuses: [] }))
  const requests: LocalAlbumQuery[] = [], replies: LocalAlbumPage[] = [], artworkRequests: LocalAlbumArtworkRequest[] = []
  const model = createLocalAlbumBrowserModel({ api: api(albums, {
    queryAlbums: async request => {
      requests.push({ ...request })
      const reply = page(request, albums)
      assert.equal(isLocalAlbumPage(reply, request), true, '封面观察前后的每一页均须先满足原DTO合同')
      replies.push(reply); return reply
    },
    getArtwork: async request => {
      artworkRequests.push({ ...request })
      assert.equal(request.albumKey, albums[0]!.id); assert.equal(request.revision, '1')
      albums[0] = { ...albums[0]!, artworkAvailable: true, artworkState: 'available', revision: '2', statuses: ['has-artwork'] }
      return { ...request, image: image(), status: 'ready' }
    },
  }) }); t.after(model.dispose)
  await model.activate()
  const initial = model.getSnapshot(), first = initial.items[0]!
  assert.equal(initial.items.length, 60); assert.equal(initial.total, 187); assert.equal(initial.hasMore, true)
  assert.equal(initial.counts['has-artwork'], 0); assert.equal(initial.counts['missing-artwork'], 0)
  assert.ok(initial.items.every(value => value.artworkState === 'unknown' && !value.statuses.includes('has-artwork') && !value.statuses.includes('missing-artwork')))
  await model.ensureArtwork(first)
  assert.equal(model.artworkFor(first).status, 'ready'); assert.equal(artworkRequests.length, 1)
  assert.equal(albums[0]!.revision, '2'); assert.equal(albums[0]!.artworkState, 'available')
  assert.deepEqual(albums[0]!.statuses, ['has-artwork'])
  await new Promise<void>(resolve => setTimeout(resolve, LOCAL_ALBUM_ARTWORK_COUNT_QUIET_MS))
  assert.equal(model.getSnapshot().items.length, 60); assert.equal(model.getSnapshot().counts['has-artwork'], 1, '首图成功批量确认计数，不重置原首页')
  await model.loadMore()
  assert.equal(model.getSnapshot().items.length, 120, '同一集合仅封面观察计数变化时，连续浏览应接收合法下一页')
  assert.equal(model.getSnapshot().loadMoreError, ''); assert.equal(model.getSnapshot().counts['has-artwork'], 1)
  assert.equal(replies[2]!.total, replies[0]!.total); assert.equal(replies[2]!.counts['missing-artwork'], 0)
  assert.notEqual(replies[2]!.counts['has-artwork'], replies[0]!.counts['has-artwork'])
  for (const expected of [180, 187]) { await model.loadMore(); assert.equal(model.getSnapshot().items.length, expected); assert.equal(model.getSnapshot().loadMoreError, '') }
  assert.deepEqual(requests.map(value => [value.offset, value.limit]), [[0, 60], [0, 1], [60, 60], [120, 60], [180, 60]])
  assert.deepEqual(replies.map(value => value.items.length), [60, 1, 60, 60, 7])
  const complete = model.getSnapshot()
  assert.equal(complete.total, 187); assert.equal(complete.hasMore, false); assert.equal(new Set(complete.items.map(value => value.id)).size, 187)
  assert.deepEqual(complete.items.map(value => value.id), albums.map(value => value.id)); assert.equal(complete.counts['has-artwork'], 1)
  assert.equal(complete.counts['missing-artwork'], 0); assert.equal(artworkRequests.length, 1)
})

test('MBF连续浏览规模：10001项以默认60完整读取167页，末页9960起41项且身份唯一', async t => {
  // 只核原model与内存分页API；167页不是SQL耗时、Native或持久缓存资格。
  const albums = Array.from({ length: 10001 }, (_, index) => album(index + 1, { artworkAvailable: false, artworkState: 'unknown', statuses: [] }))
  const requests: LocalAlbumQuery[] = [], lengths: number[] = []
  let failRefresh = false
  const model = createLocalAlbumBrowserModel({ api: api(albums, { queryAlbums: async request => {
    requests.push({ ...request }); if (failRefresh) throw new Error('合成首页刷新失败'); const reply = page(request, albums)
    assert.equal(isLocalAlbumPage(reply, request), true); lengths.push(reply.items.length); return reply
  }, getArtwork: async () => { throw new Error('此例不读取或解码封面') } }) }); t.after(model.dispose)
  await model.activate()
  assert.equal(model.getSnapshot().items.length, 60); assert.equal(model.getSnapshot().total, 10001)
  for (let index = 1; index < 167; index++) {
    assert.equal(model.getSnapshot().hasMore, true)
    await model.loadMore()
    assert.equal(model.getSnapshot().items.length, Math.min((index + 1) * 60, 10001))
    assert.equal(model.getSnapshot().loadMoreError, '')
  }
  assert.equal(requests.length, 167); assert.deepEqual(requests.map(value => value.offset), Array.from({ length: 167 }, (_, index) => index * 60))
  assert.ok(requests.every(value => value.limit === 60)); assert.equal(requests[166]!.offset, 9960)
  assert.ok(lengths.slice(0, 166).every(value => value === 60)); assert.equal(lengths[166], 41)
  const complete = model.getSnapshot()
  assert.equal(complete.items.length, 10001); assert.equal(complete.total, 10001); assert.equal(complete.counts.all, 10001)
  assert.equal(complete.hasMore, false); assert.equal(new Set(complete.items.map(value => value.id)).size, 10001)
  assert.deepEqual(complete.items.map(value => value.id), albums.map(value => value.id))
  model.setScrollTop(50_000); model.setSelectedAlbums([albums.at(-1)!.id])
  failRefresh = true; await model.refresh(true)
  assert.equal(requests.length, 168); assert.equal(requests.at(-1)!.offset, 0, '明确刷新失败也只准尝试一个首页')
  assert.equal(model.getSnapshot().items, complete.items); assert.equal(model.getSnapshot().scrollTop, 50_000)
  assert.deepEqual(model.getSnapshot().selectedAlbumIds, [albums.at(-1)!.id]); assert.equal(model.getSnapshot().stale, true); assert.match(model.getSnapshot().refreshError, /刷新暂未完成/u)
  failRefresh = false; await model.refresh(true)
  const restarted = model.getSnapshot()
  assert.equal(requests.length, 169); assert.equal(requests.at(-1)!.offset, 0, '已加载10001项后的明确刷新只重新查询第一页')
  assert.equal(restarted.items.length, 60); assert.equal(restarted.total, 10001); assert.equal(restarted.counts.all, 10001); assert.equal(restarted.hasMore, true)
  assert.equal(restarted.scrollTop, 0); assert.deepEqual(restarted.selectedAlbumIds, []); assert.equal(restarted.stale, false); assert.equal(restarted.refreshError, '')
  assert.deepEqual(restarted.items.map(value => value.id), albums.slice(0, 60).map(value => value.id))
  await model.loadMore(); assert.equal(requests.length, 170); assert.equal(requests.at(-1)!.offset, 60)
  assert.equal(model.getSnapshot().items.length, 120); assert.equal(model.getSnapshot().total, 10001); assert.equal(model.getSnapshot().loadMoreError, '')
  assert.deepEqual(model.getSnapshot().items.map(value => value.id), albums.slice(0, 120).map(value => value.id), '不能混入旧尾页或跳过新首页之后的成员')
})

test('MBF连续浏览集合守门：总数、非封面计数与封面筛选计数变化仍拒收', async t => {
  const cases = [
    { name: '总数改变', kind: 'total', filter: 'all' },
    { name: '非封面计数改变', kind: 'non-artwork', filter: 'all' },
    { name: '有封面筛选时缺封面计数改变', kind: 'has-filter', filter: 'has-artwork' },
    { name: '缺封面筛选时有封面计数改变', kind: 'missing-filter', filter: 'missing-artwork' },
  ] as const
  for (const scenario of cases) await t.test(scenario.name, async sub => {
    const albums = Array.from({ length: 3 }, (_, index) => album(index + 1, { artworkAvailable: false, artworkState: 'unknown', statuses: [] }))
    if (scenario.filter !== 'all') for (const index of [0, 1]) albums[index] = { ...albums[index]!,
      artworkAvailable: scenario.filter === 'has-artwork', artworkState: scenario.filter === 'has-artwork' ? 'available' : 'missing', statuses: [scenario.filter] }
    const requests: LocalAlbumQuery[] = [], replies: LocalAlbumPage[] = []
    const model = createLocalAlbumBrowserModel({ pageSize: 1, api: api(albums, { queryAlbums: async request => {
      requests.push({ ...request })
      if (request.offset > 0) {
        if (scenario.kind === 'total') albums.push(album(4, { artworkAvailable: false, artworkState: 'unknown', statuses: [] }))
        else if (scenario.kind === 'non-artwork') albums[0] = { ...albums[0]!, statuses: ['parse-failed'] }
        else if (scenario.kind === 'has-filter') albums[2] = { ...albums[2]!, artworkAvailable: false, artworkState: 'missing', statuses: ['missing-artwork'] }
        else albums[2] = { ...albums[2]!, artworkAvailable: true, artworkState: 'available', statuses: ['has-artwork'] }
      }
      const reply = page(request, albums)
      assert.equal(isLocalAlbumPage(reply, request), true, '负例必须是合法本页，不能以DTO错误替代集合守门')
      replies.push(reply); return reply
    } }) }); sub.after(model.dispose)
    await model.setFilter(scenario.filter); await model.activate()
    const previous = model.getSnapshot()
    assert.equal(previous.items.length, 1); assert.equal(previous.hasMore, true)
    await model.loadMore()
    assert.deepEqual(requests.map(value => value.offset), [0, 1]); assert.ok(requests.every(value => value.filter === scenario.filter))
    if (scenario.kind === 'total') assert.equal(replies[1]!.total, previous.total + 1)
    else {
      assert.equal(replies[1]!.total, previous.total)
      const changed = LOCAL_ALBUM_STATUSES.filter(status => replies[1]!.counts[status] !== previous.counts[status])
      assert.deepEqual(changed, [scenario.kind === 'non-artwork' ? 'parse-failed' : scenario.kind === 'has-filter' ? 'missing-artwork' : 'has-artwork'])
    }
    const rejected = model.getSnapshot()
    assert.equal(rejected.items, previous.items); assert.equal(rejected.total, previous.total); assert.deepEqual(rejected.counts, previous.counts)
    assert.equal(rejected.hasMore, previous.hasMore); assert.equal(rejected.loadingMore, false); assert.equal(rejected.error, '')
    assert.match(rejected.loadMoreError, /更多专辑/u)
  })
})

test('MBF可见封面窗口：跳滚撤旧排队，有效离窗结果保留且可见优先仍只占两槽', async t => {
  const values = Array.from({ length: 8 }, (_, index) => album(80 + index))
  const jobs: { request: LocalAlbumArtworkRequest; pending: ReturnType<typeof deferred<LocalAlbumArtworkReply>> }[] = []
  const tasks: Promise<void>[] = []
  let running = 0, maximum = 0
  const model = createLocalAlbumBrowserModel({ api: api(values, { getArtwork: request => {
    const pending = deferred<LocalAlbumArtworkReply>(); jobs.push({ request: { ...request }, pending }); maximum = Math.max(maximum, ++running)
    return pending.promise.finally(() => { running-- })
  } }) })
  t.after(async () => { model.dispose(); for (const job of jobs) job.pending.resolve({ ...artworkTuple(job.request), image: image() }); await Promise.all(tasks) })
  await model.activate()
  model.setArtworkWindow({ visible: values.slice(0, 2), nearby: values.slice(2, 4) })
  tasks.push(...values.slice(0, 4).map(value => model.ensureArtwork(value)))
  assert.deepEqual(jobs.map(job => job.request.albumKey), values.slice(0, 2).map(value => value.id))
  assert.equal(model.getArtworkCacheUsage().running, 2); assert.equal(model.getArtworkCacheUsage().queued, 2)
  model.setArtworkWindow({ visible: values.slice(4, 6), nearby: values.slice(6, 8) })
  await Promise.all(tasks.slice(2)); assert.equal(jobs.length, 2, '旧窗未启动两项必须直接收口，不触碰API')
  // 故意先排近邻；原两槽腾出后仍必须先派发真正可见项。
  tasks.push(...[values[6]!, values[7]!, values[4]!, values[5]!].map(value => model.ensureArtwork(value)))
  assert.equal(model.getArtworkCacheUsage().running, 2); assert.equal(model.getArtworkCacheUsage().queued, 4)
  jobs[0]!.pending.resolve({ ...artworkTuple(jobs[0]!.request), image: image() }); await tasks[0]
  assert.equal(model.artworkFor(values[0]!).status, 'ready'); assert.equal(jobs[2]!.request.albumKey, values[4]!.id)
  jobs[1]!.pending.resolve({ ...artworkTuple(jobs[1]!.request), image: image() }); await tasks[1]
  assert.equal(model.artworkFor(values[1]!).status, 'ready'); assert.equal(jobs[3]!.request.albumKey, values[5]!.id)
  for (let index = 2; index < 6; index++) {
    assert.ok(jobs[index]); jobs[index]!.pending.resolve({ ...artworkTuple(jobs[index]!.request), image: image() }); await settle()
  }
  await Promise.all(tasks)
  assert.deepEqual(jobs.map(job => job.request.albumKey), [0, 1, 4, 5, 6, 7].map(index => values[index]!.id))
  assert.equal(maximum, 2); assert.equal(running, 0); assert.equal(model.getArtworkCacheUsage().running, 0); assert.equal(model.getArtworkCacheUsage().queued, 0)
  assert.ok(jobs.every(job => !Object.hasOwn(job.request, 'refresh')), '普通窗口变动不能冒充显式刷新')
  await model.setRoot(otherRoot); assert.equal(model.getSnapshot().items.length, 0)
  model.setArtworkWindow({ visible: [values[2]!], nearby: [] })
  const stale = model.ensureArtwork(values[2]!); tasks.push(stale)
  assert.equal(jobs.length, 6, '换scope后的旧窗口和旧ensure不能重开旧来源请求'); await stale
})

test('MBF可见封面刷新：仅显式意图重探缺图与成功图，先探测筛选旧成员再更新计数', async t => {
  for (const filter of ['all', 'has-artwork', 'missing-artwork'] as const) await t.test(filter, async t => {
    let values = [album(91, { artworkAvailable: false, artworkState: 'missing', statuses: ['missing-artwork'] }), album(92),
      album(93, { artworkAvailable: false, artworkState: 'missing', statuses: ['missing-artwork'] }), album(94, { artworkAvailable: false, artworkState: 'missing', statuses: ['missing-artwork'] })]
    const requests: LocalAlbumArtworkRequest[] = [], phases: string[] = []
    const model = createLocalAlbumBrowserModel({ api: api(values, {
      queryAlbums: async request => { phases.push('query'); return page(request, values) },
      getArtwork: async request => {
        requests.push({ ...request }); phases.push(`artwork:${request.albumKey}:${request.refresh === true ? 'refresh' : 'ordinary'}`)
        const reply = { ...artworkTuple(request), image: image(request.refresh === true ? 'abcd' : '/9j/') }
        assert.equal(isLocalAlbumArtworkReply(reply, request), true, '意图不能回显进严格五字段回复')
        if (request.refresh === true) values = values.map(value => value.id === request.albumKey
          ? { ...value, artworkAvailable: true, artworkState: 'available', statuses: ['has-artwork'] } : value)
        return reply
      },
    }) }); t.after(model.dispose)
    await model.setFilter(filter); await model.activate()
    const original = model.getSnapshot().items.slice(0, filter === 'all' ? 2 : 1)
    model.setArtworkWindow({ visible: original, nearby: [] })
    await Promise.all(original.map(value => model.ensureArtwork(value)))
    assert.ok(requests.every(request => !Object.hasOwn(request, 'refresh')))
    const before = requests.length, phaseStart = phases.length
    await model.refresh(true)
    assert.deepEqual(requests.slice(before).map(request => request.albumKey), original.map(value => value.id))
    assert.ok(requests.slice(before).every(request => request.refresh === true))
    assert.deepEqual(phases.slice(phaseStart), [...original.map(value => `artwork:${value.id}:refresh`), 'query'])
    assert.equal(model.getSnapshot().refreshError, ''); assert.equal(model.getSnapshot().refreshing, false)
    for (const value of original) { assert.equal(model.artworkFor(value).status, 'ready'); assert.equal(model.artworkFor(value).dataUrl, image('abcd').display.dataUrl) }
    assert.equal(model.getSnapshot().counts['has-artwork'], filter === 'has-artwork' ? 1 : 2)
    const after = requests.length
    await model.refresh(); await model.loadMore(); assert.equal(requests.length, after, '普通query/分页不能再强制读取成功图')
    if (filter === 'all') {
      const remaining = model.getSnapshot().items.find(value => value.id === values[2]!.id)!
      model.setArtworkWindow({ visible: [remaining], nearby: [] }); await model.ensureArtwork(remaining)
      assert.equal(requests.length, after + 1); assert.equal(requests.at(-1)!.refresh, true, '本次刷新前未入窗的确认缺图只在进入时惰性重探')
      await model.ensureArtwork(remaining); assert.equal(requests.length, after + 1)
      model.setArtworkWindow({ visible: original, nearby: [] }); await Promise.all(original.map(value => model.ensureArtwork(value)))
      assert.equal(requests.length, after + 1, '同刷新代返回成功图不能循环获得强制资格')
      model.deactivate(true); await model.activate()
      const stillMissing = model.getSnapshot().items.find(value => value.id === values[3]!.id)!
      model.setArtworkWindow({ visible: [stillMissing], nearby: [] }); await model.ensureArtwork(stillMissing)
      assert.equal(requests.length, after + 1, '离页撤销旧刷新代，普通再激活不携意图重探缺图')
      assert.equal(model.artworkFor(stillMissing).status, 'missing')
    }
  })
  const original = album(97, { artworkAvailable: false, artworkState: 'missing', statuses: ['missing-artwork'] })
  let current = original, queries = 0
  const probes: LocalAlbumArtworkRequest[] = []
  const model = createLocalAlbumBrowserModel({ api: api([original], {
    queryAlbums: async request => { queries++; return page(request, [current]) },
    getArtwork: async request => {
      probes.push({ ...request })
      if (request.revision === '1') { current = { ...original, revision: '2' }; throw new Error('合成旧tuple拒绝') }
      return { ...artworkTuple(request), image: image() }
    },
  }) }); t.after(model.dispose)
  await model.activate(); model.setArtworkWindow({ visible: [original], nearby: [] }); await model.refresh(true)
  assert.equal(queries, 2); assert.equal(model.getSnapshot().items[0]!.revision, '2'); assert.equal(model.getSnapshot().refreshError, '')
  model.setArtworkWindow({ visible: [current], nearby: [] }); await model.ensureArtwork(current)
  assert.deepEqual(probes.map(request => [request.revision, request.refresh]), [['1', true], ['2', true]])
  assert.equal(model.artworkFor(current).status, 'ready', '旧probe失败不能堵住新首页和合法新身份的一次探测')
})

test('MBF可见封面详情刷新：旧tuple探测拒绝仍更新详情并按新身份仅重探一次', async t => {
  const original = album(95, { artworkAvailable: false, artworkState: 'missing', statuses: ['missing-artwork'] })
  let current = original, details = 0
  const requests: LocalAlbumArtworkRequest[] = []
  const model = createLocalAlbumBrowserModel({ api: api([original], {
    queryAlbumTracks: async request => { details++; return trackPage(request, current) },
    getArtwork: async request => {
      requests.push({ ...request }); assert.equal(request.refresh, true)
      if (request.revision === '1') { current = { ...original, revision: '2' }; throw new Error('合成旧身份拒绝') }
      return { ...artworkTuple(request), image: image('abcd') }
    },
  }) }); t.after(model.dispose)
  await model.activate(); await model.openAlbum(original)
  model.setArtworkWindow({ visible: [original], nearby: [] })
  await model.ensureArtwork(original); assert.equal(requests.length, 0)
  await model.refreshAlbum(true)
  assert.deepEqual(requests.map(request => [request.revision, request.refresh]), [['1', true], ['2', true]])
  assert.equal(details, 2); assert.equal(model.getSnapshot().selectedAlbum?.revision, '2'); assert.equal(model.getSnapshot().detailRefreshError, '')
  assert.equal(model.artworkFor(current).status, 'ready'); assert.equal(model.artworkFor(current).dataUrl, image('abcd').display.dataUrl)
  await model.refreshAlbum(); assert.equal(details, 3); assert.equal(requests.length, 2, '内部默认详情刷新保持纯投影读取')
})

test('MBF可见封面刷新运输：literaltrue经真实Client和Main到读口，毒意图零invoke且reply不回显flag', async t => {
  const selected = album(96), datasetId = id(996), event = Object.freeze({}), displayed = publicArtworkFixture()
  let handler!: (event: {}, value: unknown) => Promise<unknown>, invokes = 0, getters = 0, poisonMain = false, poisonPreload = false
  const requests: LocalAlbumArtworkRequest[] = []
  registerLocalAlbumIpc({ ipcMain: { handle(channel, callback) { assert.equal(channel, 'localAlbum:request'); handler = callback } },
    assertTrusted: received => assert.equal(received, event), assertDataset: value => assert.equal(value, datasetId),
    read: async request => {
      if (request.command === 'localAlbum.query') return page(request.payload, [selected])
      if (request.command === 'localAlbum.tracks') return trackPage(request.payload, selected)
      requests.push({ ...request.payload })
      const reply = { ...artworkTuple(request.payload), image: displayed }
      return poisonMain ? { ...reply, refresh: true } : reply
    },
  })
  const client = createLocalAlbumClient(async (channel, value) => {
    invokes++; assert.equal(channel, 'localAlbum:request')
    const reply = await handler(event, value)
    return poisonPreload ? { ...(reply as Record<string, unknown>), refresh: true } : reply
  }, async () => datasetId)
  const model = createLocalAlbumBrowserModel({ api: { queryAlbums: client.queryLocalAlbums, queryAlbumTracks: client.getLocalAlbumTracks, getArtwork: client.getLocalAlbumArtwork } }); t.after(model.dispose)
  await model.activate(); model.setArtworkWindow({ visible: [selected], nearby: [] }); await model.ensureArtwork(selected)
  assert.equal(Object.hasOwn(requests[0]!, 'refresh'), false)
  await model.refresh(true)
  assert.equal(requests.length, 2); assert.equal(requests[1]!.refresh, true)
  assert.equal(model.artworkFor(selected).status, 'ready'); assert.equal(model.artworkFor(selected).dataUrl, displayed.display.dataUrl)
  const tuple = artworkTuple(requests[1]!), beforeInvoke = invokes, beforeRead = requests.length
  const invalid: unknown[] = [false, undefined, 'true'].map(refresh => ({ ...tuple, refresh }))
  invalid.push({ ...tuple, refresh: true, unknownField: true })
  invalid.push(Object.defineProperty({ ...tuple }, 'refresh', { enumerable: true, get() { getters++; return true } }))
  for (const value of invalid) await assert.rejects(client.getLocalAlbumArtwork(value as LocalAlbumArtworkRequest), /INVALID_IPC_REQUEST/u)
  assert.equal(invokes, beforeInvoke); assert.equal(requests.length, beforeRead); assert.equal(getters, 0)
  const refresh = { ...tuple, refresh: true as const }, poisoned = { ...tuple, image: displayed, refresh: true }
  assert.equal(isLocalAlbumArtworkReply(poisoned, refresh), false)
  poisonMain = true
  await assert.rejects(handler(event, { datasetId, command: 'localAlbum.artwork', payload: refresh }), /结果无效/u)
  poisonMain = false; poisonPreload = true
  await assert.rejects(client.getLocalAlbumArtwork(refresh), /INVALID_IPC_REQUEST/u)
  assert.equal(model.artworkFor(selected).status, 'ready', '边界拒绝不能改写另一已确认模型快照')
})


test('MBF封面在途复用：A到B再回A只读取一次，两个真实槽位直到settle才归还', async t => {
  const values = [album(981), album(982)], jobs: { request: LocalAlbumArtworkRequest; gate: ReturnType<typeof deferred<LocalAlbumArtworkReply>> }[] = []
  const model = createLocalAlbumBrowserModel({ api: api(values, { getArtwork: request => { const gate = deferred<LocalAlbumArtworkReply>(); jobs.push({ request, gate }); return gate.promise } }) })
  t.after(() => { model.dispose(); for (const job of jobs) job.gate.resolve({ ...artworkTuple(job.request), image: image() }) })
  await model.activate(); const a = model.getSnapshot().items[0]!, b = model.getSnapshot().items[1]!
  model.setArtworkWindow({ visible: [a], nearby: [] }); const first = model.ensureArtwork(a)
  model.setArtworkWindow({ visible: [b], nearby: [] }); const second = model.ensureArtwork(b)
  assert.equal(model.getArtworkCacheUsage().running, 2)
  model.setArtworkWindow({ visible: [a], nearby: [] }); const joined = model.ensureArtwork(a)
  assert.equal(joined, first); assert.equal(jobs.length, 2); assert.equal(model.getArtworkCacheUsage().running, 2)
  jobs[0]!.gate.resolve({ ...artworkTuple(jobs[0]!.request), image: image() }); await joined
  assert.equal(model.artworkFor(a).status, 'ready'); assert.equal(jobs.filter(job => job.request.albumKey === a.id).length, 1)
  jobs[1]!.gate.resolve({ ...artworkTuple(jobs[1]!.request), image: image() }); await second
  assert.equal(model.getArtworkCacheUsage().running, 0)
})

test('MBF封面在途复用：显式刷新不加入旧普通读取，旧结果不能覆盖刷新代', async t => {
  const values = [album(983)], jobs: { request: LocalAlbumArtworkRequest; gate: ReturnType<typeof deferred<LocalAlbumArtworkReply>> }[] = []
  const model = createLocalAlbumBrowserModel({ api: api(values, { getArtwork: request => { const gate = deferred<LocalAlbumArtworkReply>(); jobs.push({ request, gate }); return gate.promise } }) })
  t.after(() => { model.dispose(); for (const job of jobs) job.gate.resolve({ ...artworkTuple(job.request), image: image() }) })
  await model.activate(); const a = model.getSnapshot().items[0]!
  model.setArtworkWindow({ visible: [a], nearby: [] }); const ordinary = model.ensureArtwork(a), refreshed = model.ensureArtwork(a, true)
  assert.equal(jobs.length, 2); assert.equal(jobs[1]!.request.refresh, true)
  jobs[0]!.gate.resolve({ ...artworkTuple(jobs[0]!.request), image: image() }); await ordinary
  assert.equal(model.artworkFor(a).status, 'loading', '普通读取迟到不能写入显式刷新的展示项')
  jobs[1]!.gate.resolve({ ...artworkTuple(jobs[1]!.request), image: image('abcd') }); await refreshed
  assert.equal(model.artworkFor(a).dataUrl, image('abcd').display.dataUrl)
  assert.equal(model.getArtworkCacheUsage().running, 0)
})
