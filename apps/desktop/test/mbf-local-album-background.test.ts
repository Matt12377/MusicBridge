import assert from 'node:assert/strict'
import test from 'node:test'
import { effectScope, nextTick, watch } from 'vue'
import { createLocalAlbumBrowserModel } from '../src/renderer/src/composables/application/local-library-browser/model.js'
import { useLocalAlbumBrowser, useLocalAlbumBrowserPages } from '../src/renderer/src/composables/application/local-library-browser/useLocalAlbumBrowser.js'
import type { LocalAlbumArtworkReply, LocalAlbumArtworkRequest, LocalAlbumBrowserApi, LocalAlbumFilterCounts, LocalAlbumPage, LocalAlbumQuery, LocalAlbumSummary, LocalAlbumTrackPage, LocalAlbumTrackQuery } from '../src/renderer/src/composables/application/local-library-browser/types.js'
import { LOCAL_ALBUM_STATUSES } from '../src/renderer/src/composables/application/local-library-browser/types.js'

// 合成目录与显示副本；不访问真实数据库、音乐文件、图片解码器或播放器。
const rootId = '11111111-1111-4111-8111-111111111111'
const id = (index: number) => `11111111-1111-4111-8111-${String(index).padStart(12, '0')}`
const albums = (count: number): LocalAlbumSummary[] => Array.from({ length: count }, (_, index) => ({
  id: `background-${index}`, kind: 'edition', rootId, editionId: id(index + 1), representativeTrackId: null,
  title: `合成专辑 ${index}`, artists: ['合成艺人'], year: null, versionLabel: null, sourceLabel: '合成来源', trackCount: 0, revision: '1',
  artworkAvailable: true, artworkPrepared: true, statuses: ['has-artwork'],
}))
function page(request: LocalAlbumQuery, values: readonly LocalAlbumSummary[]): LocalAlbumPage {
  const selected = values.filter(value => !request.query || value.title.includes(request.query))
  const items = selected.slice(request.offset, request.offset + request.limit)
  const counts = Object.fromEntries([['all', selected.length], ...LOCAL_ALBUM_STATUSES.map(status => [status, status === 'has-artwork' ? selected.length : 0])]) as unknown as LocalAlbumFilterCounts
  return { ...request, items, counts, total: selected.length, hasMore: request.offset + items.length < selected.length }
}
const grid = Object.freeze({ mime: 'image/jpeg' as const, dataUrl: 'data:image/jpeg;base64,/9j/', width: 512, height: 512, bytes: 3, sha256: 'c'.repeat(64) })
const displayBytes = Buffer.concat([Buffer.from([255, 216, 255]), Buffer.alloc(180000)])
const display = Object.freeze({ mime: 'image/jpeg' as const, dataUrl: `data:image/jpeg;base64,${displayBytes.toString('base64')}`, width: 1200, height: 1200, bytes: displayBytes.length, sha256: 'b'.repeat(64) })
const reply = (request: LocalAlbumArtworkRequest): LocalAlbumArtworkReply => ({
  albumKey: request.albumKey, rootId: request.rootId, editionId: request.editionId, representativeTrackId: request.representativeTrackId, revision: request.revision,
  ...(request.variant ? { variant: request.variant } : {}), status: 'ready', grid,
  image: { original: { mime: 'image/jpeg', width: 1200, height: 1200, bytes: displayBytes.length, sha256: 'a'.repeat(64) }, display: request.variant === 'grid' ? grid : display } })
const api = (values: readonly LocalAlbumSummary[], changes: Partial<LocalAlbumBrowserApi> = {}): LocalAlbumBrowserApi => ({
  queryAlbums: async request => page(request, values), getArtwork: async request => reply(request),
  queryAlbumTracks: async request => ({ ...request, album: values.find(value => value.id === request.albumKey)!, items: [], total: 0, hasMore: false }), ...changes,
})
async function until(predicate: () => boolean, message: string): Promise<void> {
  const deadline = performance.now() + 4000
  while (!predicate() && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5))
  assert.ok(predicate(), message)
}

test('正式专辑墙默认200项首屏后无需滚动继续发现407项并暖图，滚回复用网格图，详情独立读取高清', async t => {
  const values = albums(407), queries: LocalAlbumQuery[] = [], reads: LocalAlbumArtworkRequest[] = []
  const model = createLocalAlbumBrowserModel({ backgroundLoading: true, compactGridArtwork: true, artworkCacheEntries: 2048, artworkCacheBytes: 32 * 1024 * 1024,
    api: api(values, { queryAlbums: async request => { queries.push(request); return page(request, values) }, getArtwork: async request => { reads.push(request); return reply(request) } }) })
  t.after(model.dispose)
  await model.activate()
  assert.equal(model.getSnapshot().items.length, 200, '首屏只等待一页，不等待后台全库加载')
  assert.equal(queries.length, 1)
  await until(() => model.getSnapshot().items.length === 407 && model.getSnapshot().backgroundArtwork?.completed === 407, '目录与封面必须在没有滚动事件时自动推进')
  assert.deepEqual(queries.map(value => [value.offset, value.limit]), [[0, 200], [200, 200], [400, 200]])
  assert.equal(reads.length, 407); assert.equal(model.getArtworkCacheUsage().entries, 407)
  assert.ok(reads.every(value => value.variant === 'grid'), '画廊传输只申请持久网格副本')
  assert.equal(model.getSnapshot().backgroundArtwork?.running, false)
  for (const value of values) assert.equal(model.artworkFor(value).dataUrl, grid.dataUrl)
  assert.ok(model.getArtworkCacheUsage().bytes < 407 * 1000, '画廊不能保留407张1200显示大图')
  model.setArtworkWindow({ visible: values.slice(0, 6), nearby: [] })
  await Promise.all(values.slice(0, 6).map(value => model.ensureArtwork(value)))
  assert.equal(reads.length, 407, '已准备的407项滚回不再读取磁盘或源图')
  await model.openAlbum(values[0]!); await model.ensureArtwork(values[0]!)
  assert.equal(model.artworkFor(values[0]!).dataUrl, display.dataUrl, '详情不能把512网格图冒充高清')
  assert.equal(reads.length, 408)
  assert.equal(reads.at(-1)!.variant, undefined, '详情通过原无variant读口申请高清')
  model.closeAlbum()
  assert.equal(model.artworkFor(values[0]!).dataUrl, grid.dataUrl)
  assert.ok(model.getArtworkCacheUsage().bytes < 407 * 1000, '关闭详情应立即撤销高清缓存引用')
})

test('后台暖图单次走过有界LRU，淘汰后不在空闲时无限重读', async t => {
  const values = albums(240), reads: string[] = []
  const model = createLocalAlbumBrowserModel({ backgroundLoading: true, compactGridArtwork: true, artworkCacheEntries: 8, artworkCacheBytes: 1024,
    api: api(values, { getArtwork: async request => { reads.push(request.albumKey); return reply(request) } }) })
  t.after(model.dispose); await model.activate()
  await until(() => model.getSnapshot().backgroundArtwork?.completed === values.length, '后台必须走过全部卡片')
  assert.equal(new Set(reads).size, 240); assert.equal(reads.length, 240)
  assert.ok(model.getArtworkCacheUsage().entries <= 8); assert.ok(model.getArtworkCacheUsage().bytes <= 1024)
  await new Promise(resolve => setTimeout(resolve, 40)); assert.equal(reads.length, 240, 'LRU内存淘汰不产生第二轮后台任务')
  model.setArtworkWindow({ visible: [values[0]!], nearby: [] }); await model.ensureArtwork(values[0]!)
  assert.equal(reads.length, 241, '超出RAM预算的返滚只按前台兴趣重读本地副本')
  assert.equal(model.artworkFor(values[0]!).status, 'ready')
  await new Promise(resolve => setTimeout(resolve, 40)); assert.equal(reads.length, 241)
})

test('后台目录失败停在现有内容，显式重试成功后继续且不依赖页底按钮', async t => {
  const values = albums(5), queries: number[] = []; let fail = true
  const model = createLocalAlbumBrowserModel({ backgroundLoading: true, pageSize: 2, api: api(values, { queryAlbums: async request => {
    queries.push(request.offset); if (request.offset === 2 && fail) throw new Error('合成暂时失败'); return page(request, values)
  } }) }); t.after(model.dispose); await model.activate()
  await until(() => !!model.getSnapshot().loadMoreError, '第二页失败必须可见')
  assert.equal(model.getSnapshot().items.length, 2)
  await new Promise(resolve => setTimeout(resolve, 40)); assert.deepEqual(queries, [0, 2], '后台错误不能无限重试')
  fail = false; await model.loadMore()
  await until(() => model.getSnapshot().items.length === 5, '显式恢复后自动继续后续目录')
  assert.deepEqual(queries, [0, 2, 2, 4]); assert.equal(model.getSnapshot().loadMoreError, '')
})

test('离页立即停止后台目录与暖图，迟到图片不覆盖保留快照', async t => {
  const values = albums(9), queries: number[] = [], reads: LocalAlbumArtworkRequest[] = []
  let release!: (value: LocalAlbumArtworkReply) => void
  const pending = new Promise<LocalAlbumArtworkReply>(resolve => { release = resolve })
  const model = createLocalAlbumBrowserModel({ backgroundLoading: true, pageSize: 2, api: api(values, {
    queryAlbums: async request => { queries.push(request.offset); return page(request, values) }, getArtwork: request => { reads.push(request); return pending },
  }) }); t.after(model.dispose); await model.activate()
  await until(() => reads.length === 1, '后台必须主动准备第一张图')
  model.deactivate(); const before = model.getSnapshot(), queryCount = queries.length
  release(reply(reads[0]!)); await new Promise(resolve => setTimeout(resolve, 40))
  assert.equal(model.getSnapshot(), before); assert.equal(queries.length, queryCount); assert.equal(reads.length, 1)
})

test('双入口显式开启RAM预热仍自动读取目录，普通多页返回保留已确认结果', async t => {
  const values = albums(7), requests: number[] = [], scope = effectScope()
  const pages = scope.run(() => useLocalAlbumBrowserPages({ backgroundArtworkLoading: true, pageSize: 2, api: api(values, {
    queryAlbums: async request => { requests.push(request.offset); return page(request, values) },
  }) }))!
  t.after(() => scope.stop()); await pages.localLibrary.activate()
  await until(() => pages.localLibrary.items.value.length === 7 && pages.localLibrary.backgroundArtwork.value?.completed === 7, '正式入口默认开启目录和封面后台读取')
  const before = pages.localLibrary.snapshot.value, reads = requests.length
  pages.localLibrary.setScrollTop(400); pages.localLibrary.deactivate(); await pages.localLibrary.activate()
  assert.equal(requests.length, reads); assert.equal(pages.localLibrary.items.value, before.items); assert.equal(pages.localLibrary.scrollTop.value, 400)
})

test('10001项默认51页普通返回不重复查询，明确刷新与范围变更仍读取真实新事实', async t => {
  const values = albums(10001), requests: LocalAlbumQuery[] = []
  const model = createLocalAlbumBrowserModel({ reuseLoadedOnActivate: true, api: api(values, {
    queryAlbums: async request => { requests.push(request); return page(request, values) },
  }) }); t.after(model.dispose); await model.activate()
  while (model.getSnapshot().hasMore) await model.loadMore()
  assert.equal(requests.length, 51); const before = model.getSnapshot()
  model.setScrollTop(10000); model.deactivate(); await model.activate()
  assert.equal(requests.length, 51, '普通返回不能再同步串读51页')
  assert.equal(model.getSnapshot().items, before.items); assert.equal(model.getSnapshot().scrollTop, 10000)
  await model.refresh(true)
  assert.equal(requests.length, 52); assert.equal(requests.at(-1)!.offset, 0); assert.equal(model.getSnapshot().items.length, 200)
  await model.search('合成专辑 10000')
  assert.equal(requests.length, 53); assert.equal(model.getSnapshot().items.length, 1); assert.equal(model.getSnapshot().items[0]!.id, 'background-10000')
  model.deactivate(); await model.invalidateArtwork(); const count = requests.length
  await model.activate(); assert.equal(requests.length, count + 1, '失效信号仍强制重新查询，缓存不冒充当前事实')
})

test('后台仅一路，前台可见项优先补位且离窗不撤后台任务', async t => {
  const values = albums(20), jobs: Array<{ request: LocalAlbumArtworkRequest; resolve(value: LocalAlbumArtworkReply): void }> = []
  const model = createLocalAlbumBrowserModel({ backgroundLoading: true, api: api(values, { getArtwork: request => new Promise(resolve => { jobs.push({ request, resolve }) }) }) })
  const tasks: Promise<void>[] = []
  t.after(async () => { model.dispose(); for (const job of jobs) job.resolve(reply(job.request)); await Promise.all(tasks) })
  await model.activate(); await until(() => jobs.length === 1, '后台主动占用单路')
  model.setArtworkWindow({ visible: values.slice(10), nearby: [] })
  tasks.push(...values.slice(10).map(value => model.ensureArtwork(value)))
  assert.equal(jobs.length, 8, '后台单路为前台保留其余并发槽位')
  jobs[0]!.resolve(reply(jobs[0]!.request)); await until(() => jobs.length === 9, '后台完成后先补原前台队列')
  assert.equal(jobs[8]!.request.albumKey, values[17]!.id)
  await new Promise(resolve => setTimeout(resolve, 5)); assert.equal(jobs.length, 9, '第二个后台任务不能挤过已排队前台')
  model.setArtworkWindow({ visible: [], nearby: [] })
  assert.equal(model.getArtworkCacheUsage().queued, 1, '离窗只取消旧前台排队，保留后台单路')
})

test('普通返页的新后台代不被上一代未返回的尾页阻塞', async t => {
  const values = albums(5), requests: LocalAlbumQuery[] = []
  let release!: (value: LocalAlbumPage) => void
  const late = new Promise<LocalAlbumPage>(resolve => { release = resolve })
  const model = createLocalAlbumBrowserModel({ backgroundLoading: true, reuseLoadedOnActivate: true, pageSize: 2,
    api: api(values, { queryAlbums: request => { requests.push(request); return requests.length === 2 ? late : Promise.resolve(page(request, values)) } }) })
  t.after(model.dispose); await model.activate()
  await until(() => requests.length === 2, '原后台尾页开始读取')
  model.deactivate(); await model.activate()
  await until(() => model.getSnapshot().items.length === 5 && model.getSnapshot().backgroundArtwork?.completed === 5, '返回后新代必须能继续读取，不能被旧在途请求卡住')
  assert.deepEqual(requests.map(value => value.offset), [0, 2, 2, 4])
  const before = model.getSnapshot(); release(page(requests[1]!, values)); await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(model.getSnapshot(), before, '旧代尾页不得覆盖新代完整目录')
})

test('Renderer后台只读prepared持久图，未准备项等待Core事实变化且不冒充完成', async t => {
  const values = albums(4), reads: string[] = []
  values[0] = { ...values[0]!, artworkPrepared: false, artworkAvailable: false, artworkState: 'unknown', statuses: [] }
  const model = createLocalAlbumBrowserModel({ backgroundLoading: true, api: api(values, { getArtwork: async request => {
    assert.equal(values.find(value => value.id === request.albumKey)!.artworkPrepared, true, '后台不得通过前台读口抽未准备源图')
    reads.push(request.albumKey); return reply(request)
  } }) }); t.after(model.dispose); await model.activate()
  await until(() => model.getSnapshot().backgroundArtwork?.completed === 3, '已准备资源应自动暖入')
  assert.equal(model.getSnapshot().backgroundArtwork?.total, 4); assert.equal(model.getSnapshot().backgroundArtwork?.running, false)
  assert.deepEqual(reads, values.slice(1).map(value => value.id))
  values[0] = { ...values[0]!, artworkPrepared: true, artworkAvailable: true, artworkState: 'available', statuses: ['has-artwork'] }
  await model.refresh()
  await until(() => model.getSnapshot().backgroundArtwork?.completed === 4, 'Core准备事实更新后再暖入该图')
  assert.equal(reads.length, 4); assert.equal(reads.at(-1), values[0]!.id)
})

test('prepared由false变true使同身份失败失效并实读本地图，重复页面和其他ready src保持', async t => {
  for (const failure of ['error', 'unavailable'] as const) await t.test(failure, async sub => {
    const values = albums(3), reads: LocalAlbumArtworkRequest[] = []; let prepared = false
    values[0] = { ...values[0]!, artworkPrepared: false }
    const model = createLocalAlbumBrowserModel({ backgroundLoading: true, compactGridArtwork: true, api: api(values, { getArtwork: async request => {
      reads.push(request)
      if (request.albumKey === values[0]!.id && !prepared) {
        if (failure === 'unavailable') return { albumKey: request.albumKey, rootId: request.rootId, editionId: request.editionId, representativeTrackId: request.representativeTrackId,
          revision: request.revision, variant: 'grid', image: null, status: 'source-unavailable' }
        throw new Error('合成源超时')
      }
      return reply(request)
    } }) }); sub.after(model.dispose)
    await model.activate(); await model.ensureArtwork(values[0]!)
    await until(() => model.getSnapshot().backgroundArtwork?.completed === 2, '其他两张预备图应真实完成')
    const original = model.artworkFor(values[1]!)
    assert.equal(model.artworkFor(values[0]!).status, 'error'); assert.equal(reads.length, 3)
    prepared = true; values[0] = { ...values[0]!, artworkPrepared: true }; await model.refresh()
    await until(() => model.artworkFor(values[0]!).status === 'ready' && model.getSnapshot().backgroundArtwork?.completed === 3, '旧error不能冒充本次prepared成功')
    assert.equal(reads.length, 4); assert.ok(reads.every(request => !Object.hasOwn(request, 'refresh')))
    assert.equal(model.artworkFor(values[1]!), original)
    await model.refresh(); await new Promise(resolve => setTimeout(resolve, 30))
    assert.equal(reads.length, 4); assert.equal(model.artworkFor(values[1]!), original)
  })
})

test('后台失败只消耗一次尝试，不增加成功检查计数或留下虚假的running', async t => {
  const values = albums(3), reads: string[] = []
  const model = createLocalAlbumBrowserModel({ backgroundLoading: true, api: api(values, { getArtwork: async request => {
    reads.push(request.albumKey); if (request.albumKey === values[1]!.id) throw new Error('合成后台读取未确认'); return reply(request)
  } }) }); t.after(model.dispose)
  await model.activate(); await until(() => reads.length === 3 && model.getSnapshot().backgroundArtwork?.running === false, '单轮后台应实际收口')
  assert.equal(model.getSnapshot().backgroundArtwork?.completed, 2); assert.equal(model.getSnapshot().backgroundArtwork?.total, 3)
  assert.equal(model.artworkFor(values[1]!).status, 'error')
  await new Promise(resolve => setTimeout(resolve, 40)); assert.equal(reads.length, 3, '未入窗失败不能轮询全库源图')
})

test('详情高清失败或超过共用预算时保留网格图，错误不自动循环重试', async t => {
  for (const failure of ['unavailable', 'oversize'] as const) await t.test(failure, async sub => {
    const values = albums(1); let reads = 0
    const model = createLocalAlbumBrowserModel({ compactGridArtwork: true, artworkCacheBytes: 1024, api: api(values, { getArtwork: async request => {
      reads++; if (!request.variant && failure === 'unavailable') throw new Error('合成高清暂时失败'); return reply(request)
    } }) }); sub.after(model.dispose); await model.activate(); await model.ensureArtwork(values[0]!)
    assert.equal(model.artworkFor(values[0]!).dataUrl, grid.dataUrl)
    await model.openAlbum(values[0]!); await model.ensureArtwork(values[0]!)
    assert.equal(model.artworkFor(values[0]!).status, 'error'); assert.equal(reads, 2)
    assert.ok(model.getArtworkCacheUsage().bytes <= 1024)
    await model.ensureArtwork(values[0]!); assert.equal(reads, 2, '同一详情错误必须等待明确重试')
    await model.retryArtwork(values[0]!); assert.equal(reads, 3, '明确高清重试不清除已有网格副本')
    model.closeAlbum(); assert.equal(model.artworkFor(values[0]!).dataUrl, grid.dataUrl)
  })
})

test('详情等待高清时重复加入同一在途请求不发布快照，Vue响应循环停稳且成功或失败均保留网格', async t => {
  for (const outcome of ['ready', 'error'] as const) await t.test(outcome, async sub => {
    const values = albums(1), scope = effectScope(), requests: LocalAlbumArtworkRequest[] = []
    let finishImage!: (value: LocalAlbumArtworkReply) => void, failImage!: (error: Error) => void, finishTracks!: (value: LocalAlbumTrackPage) => void
    const pendingImage = new Promise<LocalAlbumArtworkReply>((resolve, reject) => { finishImage = resolve; failImage = reject })
    const pendingTracks = new Promise<LocalAlbumTrackPage>(resolve => { finishTracks = resolve })
    let publishes = 0, cycles = 0, tripped = false, trackRequest: LocalAlbumTrackQuery | undefined
    const browser = scope.run(() => useLocalAlbumBrowser({ compactGridArtwork: true, onChange: () => { publishes++ }, api: api(values, {
      getArtwork: request => { requests.push(request); return request.variant === 'grid' ? Promise.resolve(reply(request)) : pendingImage },
      queryAlbumTracks: request => { trackRequest = request; return pendingTracks },
    }) }))!
    sub.after(() => {
      browser.dispose(); finishImage(reply(requests.at(-1)!))
      if (trackRequest) finishTracks({ ...trackRequest, album: values[0]!, total: 0, items: [], hasMore: false })
      scope.stop()
    })
    await browser.activate(); await browser.ensureArtwork(values[0]!)
    const before = publishes
    // 保留旧详情监听的数组getter，直接检验model自身不会由join制造新的反应源。
    let stop!: () => void
    stop = scope.run(() => watch(() => [browser.snapshot.value.active, browser.snapshot.value.selectedAlbum?.id ?? null], () => {
      const selected = browser.snapshot.value.selectedAlbum
      if (!selected) return
      cycles++
      // 旧实现会自激；保险丝使RED可终止，不等待Vue递归上限或耗尽内存。
      if (cycles >= 20) { tripped = true; stop(); return }
      browser.setArtworkWindow({ visible: [selected], nearby: [] })
      const status = browser.snapshot.value.artwork[selected.id]?.status ?? 'idle'
      if (status === 'idle' || status === 'ready') void browser.ensureArtwork(selected)
    }, { immediate: true }))!
    const opening = browser.openAlbum(values[0]!)
    await nextTick()
    assert.equal(tripped, false, '加入同一高清flight不能再publish并唤醒原监听')
    assert.ok(publishes - before <= 4, '打开详情与首次高清排队之外没有反复发布')
    assert.equal(requests.length, 2); assert.equal(requests[1]!.variant, undefined)
    assert.ok(trackRequest, '点击同步发出曲目查询，不等待高清或DOM切换')
    assert.equal(browser.snapshot.value.artwork[values[0]!.id]!.dataUrl, grid.dataUrl, '高清pending期间保留已有grid')
    const waiting = publishes
    const joined = Array.from({ length: 5 }, () => browser.ensureArtwork(values[0]!))
    await nextTick(); assert.equal(publishes, waiting, '前台重复加入正在显示的flight不改变快照')
    if (outcome === 'ready') finishImage(reply(requests[1]!))
    else failImage(new Error('合成高清读取失败'))
    finishTracks({ ...trackRequest, album: values[0]!, total: 0, items: [], hasMore: false })
    await Promise.all([opening, ...joined]); await nextTick()
    await until(() => browser.getArtworkCacheUsage().running === 0, '真实槽位在原请求settle后归还')
    const settled = publishes; await new Promise(resolve => setTimeout(resolve, 25)); await nextTick()
    assert.equal(publishes, settled); assert.equal(requests.length, 2)
    assert.equal(browser.artworkFor(values[0]!).status, outcome === 'ready' ? 'ready' : 'error')
    browser.closeAlbum(); await nextTick(); assert.equal(browser.artworkFor(values[0]!).dataUrl, grid.dataUrl)
  })
})
