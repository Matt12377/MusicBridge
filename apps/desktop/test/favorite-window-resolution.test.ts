import assert from 'node:assert/strict'
import test from 'node:test'
import { createRenderer, defineComponent, ref } from 'vue'
import type { FavoriteRecord, LibraryReadRequest, RoonLibraryPage } from '@music-bridge/contracts'
import type { MusicBridgePublicApi } from '../src/preload/api.js'
import { useFavoriteWindowResolution, favoriteResolutionKey } from '../src/renderer/src/composables/useFavoriteWindowResolution.js'
const turn = () => new Promise<void>(done => setImmediate(done))
const original: FavoriteRecord = { favoriteId: 'fav', kind: 'album', title: '合成收藏', createdAt: 1, updatedAt: 1 }
function flight<T>() { let resolve!: (value: T) => void, reject!: (reason: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
function start(t: test.TestContext, api: Partial<MusicBridgePublicApi>) {
  const items = ref<readonly FavoriteRecord[]>([original]), scope = ref('scope-a'), kind = ref<'album' | 'artist'>('album')
  let state!: ReturnType<typeof useFavoriteWindowResolution>
  const renderer = createRenderer<object, object>({ createElement: () => ({}), createText: () => ({}), createComment: () => ({}), setText() {}, setElementText() {}, patchProp() {}, insert() {}, remove() {}, parentNode: () => null, nextSibling: () => null })
  const app = renderer.createApp(defineComponent({ setup() { state = useFavoriteWindowResolution(items, () => scope.value, () => kind.value, api as MusicBridgePublicApi); return () => null } }))
  app.mount({}); t.after(() => app.unmount()); return { state, items, scope, kind }
}
const page = (title = original.title, reference = 'current'): RoonLibraryPage => ({ items: [{ kind: 'album', title, reference }], offset: 0, limit: 100, hasMore: false })
for (const invalidation of ['离窗', 'scope', '同id新事实'] as const) test(`007 收藏窗口 ${invalidation}：仅取消自己subscriber，迟到ready不能暖池/覆盖当前`, async t => {
  const jobs: Array<{ request: LibraryReadRequest; job: ReturnType<typeof flight<RoonLibraryPage>> }> = [], cancelled: string[] = []
  const h = start(t, { readLibrary: (async request => { const job = flight<RoonLibraryPage>(); jobs.push({ request, job }); return job.promise }) as MusicBridgePublicApi['readLibrary'], cancelLibraryRead: async id => { cancelled.push(id) } })
  assert.equal(jobs.length, 1)
  if (invalidation === 'scope') h.scope.value = 'scope-b'
  else h.items.value = [{ ...original, ...(invalidation === '离窗' ? { favoriteId: 'new-id' } : { title: '当前新标题', updatedAt: 2 }) }]
  await turn(); assert.equal(cancelled.length, 1); assert.equal(cancelled[0], jobs[0]!.request.id); assert.equal(jobs.length, 2)
  jobs[0]!.job.resolve(page(original.title, 'stale')); await turn(); assert.equal(h.state.stats().entries, 0); assert.equal(h.state.stats().pending, 1)
  const current = h.items.value[0]!; jobs[1]!.job.resolve(page(current.title)); await turn()
  const value = h.state.result(current); assert.equal(value?.state, 'ready'); if (value?.state === 'ready') assert.equal(value.item.reference, 'current')
  assert.equal(h.state.stats().entries, 1)
})
test('007 收藏窗口旧reject/finally不能撤销新scope结果，手动retry走同一串行pump', async t => {
  const jobs: ReturnType<typeof flight<RoonLibraryPage>>[] = []
  const h = start(t, { readLibrary: (async () => { const job = flight<RoonLibraryPage>(); jobs.push(job); return job.promise }) as MusicBridgePublicApi['readLibrary'], cancelLibraryRead: async () => {} })
  h.scope.value = 'scope-b'; await turn(); jobs[1]!.resolve(page()); await turn(); jobs[0]!.reject(new Error('旧scope失败')); await turn()
  assert.equal(h.state.result(original)?.state, 'ready'); assert.equal(h.state.resolving.value, null)
  h.state.retry(original); h.state.retry(original); await turn(); assert.equal(jobs.length, 3, '重复retry只保持一逻辑job，不并发派发')
  jobs[2]!.resolve(page(original.title, 'retried')); await turn(); assert.equal(h.state.stats().entries, 1)
})
test('007 收藏完整事实key包括同id metadata/时间与scope/kind，不按favoriteId永久复用', () => {
  const base = favoriteResolutionKey('scope', 'album', original)
  for (const value of [{ ...original, title: '新' }, { ...original, updatedAt: 2 }, { ...original, subtitle: '新说明' }, { ...original, createdAt: 2 }, { ...original, version: '第二版' }]) assert.notEqual(favoriteResolutionKey('scope', 'album', value), base)
  assert.notEqual(favoriteResolutionKey('nextscope', 'album', original), base); assert.notEqual(favoriteResolutionKey('scope', 'artist', original), base)
})
test('007 收藏TTL15s与负age不fresh，不延长旧引用；expiry只重采当前窗口', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100_000 }); let calls = 0
  const h = start(t, { searchRoonLibrary: async () => page(original.title, String(++calls)) }); await turn(); assert.equal(calls, 1)
  t.mock.timers.tick(15_001); await turn(); assert.equal(calls, 2)
  t.mock.timers.setTime(90_000); assert.equal(h.state.result(original), undefined); h.items.value = [{ ...original }]; await turn(); assert.equal(calls, 3)
})
test('007 收藏有限纯值池最多128/2MiB，扫描过窗口不全镜像保存，离窗不继续请求', async t => {
  let calls = 0
  const h = start(t, { searchRoonLibrary: async (query, request) => { calls++; return { ...request, items: [{ kind: 'album', title: query, reference: query }], hasMore: false } } })
  await turn()
  for (let batch = 0; batch < 10; batch++) { h.items.value = Array.from({ length: 20 }, (_, i) => ({ ...original, favoriteId: `${batch}-${i}`, title: `收藏${batch}-${i}` })); await turn() }
  assert.equal(calls, 201); assert.equal(h.state.stats().entries, 128); assert.ok(h.state.stats().bytes <= 2 * 1024 * 1024)
  h.items.value = []; await turn(); const before = calls; await turn(); assert.equal(calls, before); assert.equal(h.state.stats().queued, 0)
})
