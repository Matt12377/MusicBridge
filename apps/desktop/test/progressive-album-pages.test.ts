import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import type { LocalAlbumFilterCounts, LocalAlbumPage, LocalAlbumQuery, LocalAlbumSummary } from '@music-bridge/contracts'
import { LOCAL_ALBUM_STATUSES } from '@music-bridge/contracts'
import { createLocalAlbumBrowserModel, LOCAL_ALBUM_RECONCILE_INTERVAL_MS } from '../src/renderer/src/composables/application/local-library-browser/model.js'
import type { LocalAlbumBrowserSnapshot } from '../src/renderer/src/composables/application/local-library-browser/types.js'

// 纯Renderer合成读取：每个专辑10首，8,000张可代表80,000首；不发声、不扫描真实目录。
const id = (n: number) => `66666666-6666-4666-8666-${String(n).padStart(12, '0')}`
function albums(length: number, start = 1000): LocalAlbumSummary[] {
  return Array.from({ length }, (_, index) => ({ id: `synthetic-album-${start + index}`, rootId: id(1), kind: 'source-directory', editionId: null,
    title: `合成专辑 ${String(start + index).padStart(8, '0')}`, artists: ['合成作者'], year: null, versionLabel: null, trackCount: 10,
    representativeTrackId: id(100_000 + start + index), revision: '1', artworkAvailable: false, artworkState: 'unknown', statuses: [] }))
}
function deferred() {
  let release!: () => void, enter!: () => void
  const promise = new Promise<void>(resolve => { release = resolve }), entered = new Promise<void>(resolve => { enter = resolve })
  return { promise, entered, release, enter }
}
function fixture(t: TestContext, total = 350, options: { background?: boolean; pageSize?: number; onChange?(snapshot: LocalAlbumBrowserSnapshot): void } = {}) {
  const state = { rows: albums(total), version: 1, calls: [] as LocalAlbumQuery[], legacyCalls: 0, active: 0, maximum: 0,
    hold: null as ReturnType<typeof deferred> | null, malformed: false }
  const changes: { length: number; first: string | undefined; reconciling: boolean }[] = [], holds: ReturnType<typeof deferred>[] = []
  const observers = new Set<() => void>()
  const model = createLocalAlbumBrowserModel({ pageSize: options.pageSize, backgroundLoading: options.background ?? false, backgroundArtworkLoading: false,
    api: {
      async queryAlbums() { state.legacyCalls++; throw new Error('新读口不可绕回无修订的旧页') },
      async queryVersionedAlbums(request: LocalAlbumQuery) {
        assert.ok(request.limit > 0 && request.limit <= 100, '所有传输页不超过100张')
        state.calls.push(structuredClone(request)); state.active++; state.maximum = Math.max(state.maximum, state.active)
        const rows = state.rows.filter(album => !request.query || album.title.includes(request.query)), held = state.hold
        state.hold = null
        const items = rows.slice(request.offset, request.offset + request.limit), counts = Object.fromEntries(['all', ...LOCAL_ALBUM_STATUSES].map(filter => [filter, filter === 'all' ? rows.length : 0])) as LocalAlbumFilterCounts
        const page: LocalAlbumPage = { ...request, total: rows.length, hasMore: request.offset + items.length < rows.length, counts, items }
        const value = structuredClone({ revision: state.malformed ? '/synthetic/private-invalid-revision' : state.version.toString(16).padStart(64, '0'), page })
        state.malformed = false
        try { if (held) { held.enter(); await held.promise } return value } finally { state.active-- }
      },
      async queryAlbumTracks() { throw new Error('本组不伪装真实点播/详情') }, async getArtwork() { throw new Error('本组不伪装IMG解码') },
    },
    onChange(snapshot) { changes.push({ length: snapshot.items.length, first: snapshot.items[0]?.id, reconciling: snapshot.reconciling === true }); for (const observer of observers) observer(); options.onChange?.(snapshot) },
  })
  t.after(() => { for (const hold of holds) hold.release(); model.dispose() })
  const hold = () => { const value = deferred(); holds.push(value); state.hold = value; return value }
  const finishPass = async () => { for (let i = 0; i < 100 && model.getSnapshot().hasMore; i++) await model.loadMore(); assert.equal(model.getSnapshot().hasMore, false) }
  const stable = async () => { await model.refresh(); await finishPass(); assert.equal(model.getSnapshot().reconciling, false) }
  const waitFor = (predicate: () => boolean): Promise<void> => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { observers.delete(inspect); reject(new Error('有界后台分页未完成')) }, 2000)
    const inspect = () => { if (predicate()) { clearTimeout(timer); observers.delete(inspect); resolve() } }
    observers.add(inspect); inspect()
  })
  return { state, model, changes, hold, finishPass, stable, waitFor }
}

function clock(t: TestContext) {
  let now = 1_800_000_000_000, serial = 0, fired = 0
  const timers = new Map<number, { at: number; callback: () => void }>()
  t.mock.method(Date, 'now', () => now)
  t.mock.method(globalThis, 'setTimeout', (callback: () => void, delay = 0) => { const handle = ++serial; timers.set(handle, { at: now + Math.max(0, Number(delay)), callback }); return handle })
  t.mock.method(globalThis, 'clearTimeout', (handle: number) => { timers.delete(handle) })
  return { async advance(ms: number) {
    const end = now + ms
    for (;;) {
      const next = [...timers].sort((left, right) => left[1].at - right[1].at || left[0] - right[0])[0]
      if (!next || next[1].at > end) break
      assert.ok(++fired < 2000, '合成时钟不能陷入无界刷新')
      now = next[1].at; timers.delete(next[0]); next[1].callback()
      for (let pass = 0; pass < 48; pass++) await Promise.resolve()
    }
    now = end
    for (let pass = 0; pass < 48; pass++) await Promise.resolve()
  } }
}

async function first(f: ReturnType<typeof fixture>) {
  await f.model.activate()
  assert.equal(f.model.getSnapshot().items.length, 100, '首100张必须独立发布，不能等尾页或整库扫描')
  assert.equal(f.model.getSnapshot().error, '')
}

test('80,000首合成可见库首100张先发布，第二页未完成时仍可读首屏', async t => {
  const f = fixture(t, 8000); await first(f)
  const hold = f.hold(), pending = f.model.loadMore(); await hold.entered
  assert.equal(f.model.getSnapshot().items.length, 100); assert.equal(f.model.getSnapshot().loaded, true)
  assert.equal(f.state.calls.length, 2); assert.equal(f.state.legacyCalls, 0)
  hold.release(); await pending
  assert.equal(f.model.getSnapshot().items.length, 200)
  assert.deepEqual(f.state.calls.map(value => value.offset), [0, 100])
})

test('扫描提交期间total增长不是分页错误，先发布已提交项，再核对稳定顺序', async t => {
  const f = fixture(t, 120); await first(f)
  f.state.rows.push(...albums(30, 2000)); f.state.version++
  await f.model.loadMore()
  assert.equal(f.model.getSnapshot().items.length, 150); assert.equal(f.model.getSnapshot().loadMoreError, '')
  assert.equal(f.model.getSnapshot().reconciling, true)
  await f.stable()
  assert.deepEqual(f.model.getSnapshot().items.map(value => value.id), f.state.rows.map(value => value.id))
})

test('扫描把新专辑插到前面，跨页重叠去重且后续稳定轮不漏掉前插项', async t => {
  const f = fixture(t, 300); await first(f)
  f.state.rows.unshift(...albums(20, 0)); f.state.version++
  await f.model.loadMore()
  assert.equal(f.model.getSnapshot().items.length, 180); assert.equal(f.model.getSnapshot().loadMoreError, '')
  await f.finishPass(); await f.stable()
  const ids = f.model.getSnapshot().items.map(value => value.id)
  assert.equal(new Set(ids).size, 320); assert.deepEqual(ids, f.state.rows.map(value => value.id))
})

test('总量不变的删除/替换/排序变化也按真实修订重核；只在稳定轮安全移除旧项', async t => {
  const f = fixture(t, 300); await first(f)
  const removed = f.state.rows.splice(120, 1)[0]!
  f.state.rows.unshift(...albums(1, 0)); f.state.version++
  await f.finishPass(); assert.equal(f.model.getSnapshot().loadMoreError, '')
  await f.stable()
  assert.deepEqual(f.model.getSnapshot().items.map(value => value.id), f.state.rows.map(value => value.id))
  assert.equal(f.model.getSnapshot().items.some(value => value.id === removed.id), false)
})

test('已加载多页后的刷新先发布100张更新，不先重读全部旧前缀；保留滚动状态', async t => {
  const f = fixture(t, 400); await first(f); await f.finishPass()
  f.model.setScrollTop(2080); const before = f.state.calls.length
  f.state.rows.push(...albums(1, 2000)); f.state.version++
  await f.model.refresh()
  assert.deepEqual(f.state.calls.slice(before).map(value => value.offset), [0])
  assert.ok(f.model.getSnapshot().items.length >= 400, '更新轮不能清空已显示窗口')
  assert.equal(f.model.getSnapshot().scrollTop, 2080)
  await f.finishPass(); assert.equal(f.model.getSnapshot().items.length, 401)
})

test('500个扫描刷新请求合并到原在途分页，不撤销尾页、不制造并发整库重读', async t => {
  const f = fixture(t, 350); await first(f)
  const hold = f.hold(), pending = f.model.loadMore(); await hold.entered
  f.state.rows.push(...albums(1, 2000)); f.state.version++
  const refreshes = Array.from({ length: 500 }, () => f.model.refresh())
  assert.equal(f.state.active, 1); assert.equal(f.state.calls.length, 2)
  hold.release(); await pending; await Promise.all(refreshes)
  assert.equal(f.state.maximum, 1); assert.ok(f.state.calls.length <= 3)
  assert.equal(f.model.getSnapshot().loadMoreError, '')
  await f.finishPass(); await f.stable()
  assert.equal(f.model.getSnapshot().items.length, 351)
})

test('换查询后原版本化尾页迟到不覆盖新scope，也不把旧项转为新的可执行身份', async t => {
  const f = fixture(t, 300); await first(f)
  const hold = f.hold(), pending = f.model.loadMore(); await hold.entered
  await f.model.search('合成库中不存在的查询')
  assert.equal(f.model.getSnapshot().status, 'empty'); assert.equal(f.model.getSnapshot().items.length, 0)
  hold.release(); await pending
  assert.equal(f.model.getSnapshot().query, '合成库中不存在的查询'); assert.equal(f.model.getSnapshot().items.length, 0)
  assert.equal(f.state.legacyCalls, 0)
})

test('无效新信封保留已确认首屏并显示原错误，不降级绕回旧读口', async t => {
  const f = fixture(t, 300); await first(f)
  f.state.malformed = true; await f.model.loadMore()
  assert.equal(f.model.getSnapshot().items.length, 100); assert.ok(f.model.getSnapshot().loadMoreError)
  assert.equal(f.state.legacyCalls, 0)
})

test('同修订的跨页重复仍拒收；目录漂移不等于放弃服务端一致性守门', async t => {
  const f = fixture(t, 400); await first(f)
  ;[f.state.rows[0], f.state.rows[100]] = [f.state.rows[100]!, f.state.rows[0]!]
  await f.model.loadMore()
  assert.equal(f.model.getSnapshot().items.length, 100); assert.ok(f.model.getSnapshot().loadMoreError)
  assert.equal(f.state.legacyCalls, 0)
})

test('跨过一次修订漂移后，相邻同修订的页仍不能重复成员', async t => {
  const f = fixture(t, 400); await first(f)
  f.state.version++; await f.model.loadMore()
  assert.equal(f.model.getSnapshot().items.length, 200); assert.equal(f.model.getSnapshot().loadMoreError, '')
  ;[f.state.rows[100], f.state.rows[200]] = [f.state.rows[200]!, f.state.rows[100]!]
  await f.model.loadMore()
  assert.equal(f.model.getSnapshot().items.length, 200); assert.ok(f.model.getSnapshot().loadMoreError)
  assert.equal(f.state.legacyCalls, 0)
})

test('刷新恰在成功页最终发布时仍隔1000ms核对，不绕过短库防风暴节奏', async t => {
  const time = clock(t); assert.equal(LOCAL_ALBUM_RECONCILE_INTERVAL_MS, 1000)
  let f!: ReturnType<typeof fixture>
  f = fixture(t, 2, { background: true, onChange(snapshot) {
    if (snapshot.loaded && !snapshot.hasMore && !snapshot.initialLoading && !snapshot.refreshing && !snapshot.loadingMore && !snapshot.reconciling) void f.model.refresh()
  } })
  await f.model.activate(); assert.equal(f.state.calls.length, 1)
  await time.advance(999); assert.equal(f.state.calls.length, 1)
  await time.advance(1); assert.equal(f.state.calls.length, 2)
  await time.advance(1000); assert.equal(f.state.calls.length, 3)
  assert.equal(f.state.maximum, 1)
})

test('封面成员变化只标脏渐进pass，不重读已显示100张前缀或重置滚动', async t => {
  const time = clock(t), requests: LocalAlbumQuery[] = []
  let version = 1, rows = albums(150).map((album): LocalAlbumSummary => ({ ...album, artworkAvailable: true, artworkState: 'available', statuses: ['has-artwork'] }))
  const page = (request: LocalAlbumQuery): LocalAlbumPage => {
    const counts = Object.fromEntries(['all', ...LOCAL_ALBUM_STATUSES].map(filter => [filter, filter === 'all' ? 150 : filter === 'has-artwork' ? rows.length : filter === 'missing-artwork' ? 150 - rows.length : 0])) as LocalAlbumFilterCounts
    const items = rows.slice(request.offset, request.offset + request.limit)
    return { ...request, items, counts, total: rows.length, hasMore: request.offset + items.length < rows.length }
  }
  const model = createLocalAlbumBrowserModel({ backgroundLoading: false, backgroundArtworkLoading: false, api: {
    async queryAlbums(request) { assert.equal(request.limit, 1, '旧读口仅沿用原轻量计数，不得退回无修订画廊页'); return page(request) },
    async queryVersionedAlbums(request) { requests.push(structuredClone(request)); return { revision: version.toString(16).padStart(64, '0'), page: page(request) } },
    async queryAlbumTracks() { throw new Error('不伪装详情') }, async getArtwork({ albumKey, rootId, editionId, representativeTrackId, revision }) { return { albumKey, rootId, editionId, representativeTrackId, revision, image: null, status: 'ready' } },
  } }); t.after(model.dispose)
  await model.setFilter('has-artwork'); await model.activate(); model.setScrollTop(4321)
  const original = model.getSnapshot().items[0]!, ids = model.getSnapshot().items.map(album => album.id)
  rows = rows.filter(album => album.id !== original.id); version++
  await model.ensureArtwork(original, true); await time.advance(1000)
  assert.equal(requests.length, 1, '封面计数事件不能取消尚未读完的前缀pass')
  assert.equal(model.getSnapshot().scrollTop, 4321); assert.deepEqual(model.getSnapshot().items.map(album => album.id), ids)
  assert.equal(model.getSnapshot().reconciling, true); assert.equal(model.getSnapshot().refreshError, '')
})

test('后台目录仍每100张逐步发布且并发为1，自定义大pageSize不能越过100上限', async t => {
  const f = fixture(t, 350, { background: true, pageSize: 200 }); await first(f)
  await f.waitFor(() => f.model.getSnapshot().items.length === 350 && !f.model.getSnapshot().hasMore)
  assert.deepEqual(f.state.calls.map(value => value.limit), [100, 100, 100, 100])
  assert.equal(f.state.maximum, 1)
  assert.ok([100, 200, 300, 350].every(length => f.changes.some(change => change.length === length)))
})
