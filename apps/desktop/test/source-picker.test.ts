import assert from 'node:assert/strict'
import test from 'node:test'
import type { CollectionMatrixRow, DigitalAlbumDetail, DigitalRuntime, Page, RoonLibraryItem, RoonLibraryPage, TypedIpcEvent } from '@music-bridge/contracts'
import { SourcePickerController, matrixStatus, relationSummary, sourceRoonAvailability, sourceTabForKey, type SourcePickerApi } from '../src/renderer/src/components/recording/source-picker-controller.js'

const album = (reference = 'album-a'): RoonLibraryItem => ({ kind: 'album', reference, title: `专辑 ${reference}` })
const track = (reference = 'track-a'): RoonLibraryItem => ({ kind: 'track', reference, title: `曲目 ${reference}` })
const page = (items: RoonLibraryItem[], offset = 0): RoonLibraryPage => ({ items, offset, limit: 30, hasMore: false })
const detail = (id = 'digital-a'): DigitalAlbumDetail => ({ album: { id, metadata: { title: '同名专辑' }, revision: 1, physicalAbsenceConfirmed: false }, links: [] })
const matrix: Page<CollectionMatrixRow> = { items: [{ id: 'digital-a', digitalId: 'digital-a', title: '同名专辑', cd: 2, cassette: 0, uncertainRelations: 2, digitalState: 'linked', physicalState: 'owned' }], offset: 0, limit: 24, total: 1, hasMore: false }
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
function setup(overrides: Partial<SourcePickerApi> = {}) {
  const calls: string[] = []
  const api: SourcePickerApi = {
    searchPhysicalRoonAlbums: async query => { calls.push(`search:${query}`); return page([album()]) },
    getRoonAlbumTracks: async reference => { calls.push(`tracks:${reference}`); return page([track(`${reference}-track`)]) },
    getCollectionMatrix: async (request, query) => { calls.push(`matrix:${request.offset}:${query ?? ''}`); return matrix },
    getDigitalAlbum: async id => { calls.push(`detail:${id}`); return detail(id) },
    getDigitalRuntime: async id => { calls.push(`runtime:${id}`); return { status: 'available', reference: `runtime-${id}` } },
    ...overrides,
  }
  return { controller: new SourcePickerController(api), calls }
}

test('关系列表只调用正式矩阵；点开本地ID才读详情和runtime，不按同名猜身份', async () => {
  const { controller, calls } = setup()
  controller.setTab('relations')
  await controller.loadMatrix('同名', 24)
  assert.deepEqual(calls, ['matrix:24:同名'])
  await controller.openDigital('digital-a')
  assert.equal(controller.state.digital?.album.id, 'digital-a')
  assert.equal(controller.state.runtime?.status, 'available')
  assert.deepEqual(calls, ['matrix:24:同名', 'detail:digital-a', 'runtime:digital-a'])
})

test('Exact按实体数量计数，Probable与Related分别展示且不算Exact', () => {
  const data = detail()
  data.links = ['exact', 'probable', 'related'].map((relation, index) => ({
    link: { id: `link-${index}`, releaseId: `release-${index}`, digitalId: data.album.id, relation: relation as 'exact' | 'probable' | 'related', revision: 1, ripFromCdConfirmed: false },
    release: { id: `release-${index}`, kind: index === 2 ? 'cassette' : 'cd', title: '实体', artist: '艺术家', quantity: index + 2, revision: 1, contentStatus: 'commercial' },
  }))
  assert.deepEqual(relationSummary(data), { exactCd: 2, exactCassette: 0, probable: 3, related: 4 })
  const row = matrix.items[0]!
  assert.match(matrixStatus({ ...row, digitalId: undefined, digitalState: 'confirmed-missing' }), /Physical Only/u)
  assert.match(matrixStatus({ ...row, physicalState: 'confirmed-missing' }), /Digital Only/u)
  assert.match(matrixStatus({ ...row, digitalId: undefined, digitalState: 'unchecked' }), /未核实/u)
  assert.match(matrixStatus({ ...row, physicalState: 'unchecked' }), /未核实/u)
})

for (const status of ['needs-resolution', 'unavailable'] as const) test(`${status}保留本地关系，不能请求Roon曲目`, async () => {
  const { controller, calls } = setup({ getDigitalRuntime: async () => ({ status }) })
  await controller.openDigital('digital-a')
  await controller.loadRelationTracks()
  assert.equal(controller.state.digital?.album.id, 'digital-a')
  assert.equal(controller.state.runtime?.status, status)
  assert.equal(controller.state.tracks, undefined)
  assert.equal(calls.some(call => call.startsWith('tracks:')), false)
})

test('关系曲目前后核对当前runtime；切换引用的迟到曲目不得出现', async () => {
  let runtime: DigitalRuntime = { status: 'available', reference: 'current-album' }
  const delayed = deferred<RoonLibraryPage>()
  const { controller, calls } = setup({ getDigitalRuntime: async () => runtime, getRoonAlbumTracks: async reference => { calls.push(`tracks:${reference}`); return delayed.promise } })
  await controller.openDigital('digital-a')
  const reading = controller.loadRelationTracks()
  await Promise.resolve()
  runtime = { status: 'available', reference: 'replacement-album' }
  delayed.resolve(page([track('stale')]))
  await reading
  assert.equal(controller.state.tracks, undefined)
  assert.match(controller.state.error, /变化|失效/u)
})

test('跨Roon浏览、关系专辑与返回共用选择，重复选中不改变原顺序', async () => {
  const { controller } = setup()
  await controller.loadAlbums('')
  await controller.loadRoonTracks(album())
  controller.toggle(controller.state.tracks!.items[0]!, true)
  controller.backFromTracks()
  controller.setTab('relations')
  await controller.openDigital('digital-b')
  await controller.loadRelationTracks()
  const second = controller.state.tracks!.items[0]!
  controller.toggle(second, true)
  controller.toggle(second, true)
  controller.backFromTracks()
  assert.equal(controller.state.digital?.album.id, 'digital-b')
  controller.backToMatrix()
  assert.deepEqual(controller.selectedReferences(), ['album-a-track', 'runtime-digital-b-track'])
  controller.toggle(second, false)
  assert.deepEqual(controller.selectedReferences(), ['album-a-track'])
})

test('100首上限在控制器强制执行，不能选择非当前页曲目', async () => {
  const items = Array.from({ length: 101 }, (_, index) => track(`track-${index}`))
  const { controller } = setup({ getRoonAlbumTracks: async () => page(items) })
  await controller.loadRoonTracks(album())
  for (const item of items) controller.toggle(item, true)
  controller.toggle(track('fabricated'), true)
  assert.equal(controller.state.selected.length, 100)
  assert.equal(controller.selectedReferences().length, 100)
})

test('断线阻止正在读取的曲目回填；恢复不恢复旧选择，重新勾选才可用', async () => {
  let waiting = false
  const delayed = deferred<RoonLibraryPage>()
  const { controller } = setup({ getRoonAlbumTracks: async () => waiting ? delayed.promise : page([track()]) })
  await controller.openDigital('digital-a')
  await controller.loadRelationTracks()
  controller.toggle(track(), true)
  waiting = true
  const reading = controller.loadRelationTracks()
  await Promise.resolve()
  controller.setRoonAvailable(false)
  delayed.resolve(page([track('late')]))
  await reading
  assert.equal(controller.state.tracks, undefined)
  assert.equal(controller.state.digital?.album.id, 'digital-a')
  assert.equal(controller.state.selected[0]?.stale, true)
  assert.deepEqual(controller.selectedReferences(), [])
  controller.setRoonAvailable(true)
  assert.deepEqual(controller.selectedReferences(), [])
  waiting = false
  await controller.loadRelationTracks()
  controller.toggle(track(), true)
  assert.deepEqual(controller.selectedReferences(), ['track-a'])
})

test('切tab与卸载均拒绝迟到详情，不复活旧页面或loading', async () => {
  const delayed = deferred<DigitalAlbumDetail>()
  const { controller } = setup({ getDigitalAlbum: async () => delayed.promise })
  controller.setTab('relations')
  const reading = controller.openDigital('digital-a')
  controller.setTab('roon')
  delayed.resolve(detail())
  await reading
  assert.equal(controller.state.tab, 'roon')
  assert.equal(controller.state.digital, undefined)
  assert.equal(controller.state.loading, false)
  const later = deferred<RoonLibraryPage>()
  const second = setup({ searchPhysicalRoonAlbums: async () => later.promise }).controller
  const loading = second.loadAlbums('')
  second.dispose()
  later.resolve(page([album('late')]))
  await loading
  assert.equal(second.state.albums, undefined)
})

test('关系运行态读取失败仍保留已读取本地详情且不能退化为空曲目成功', async () => {
  const { controller } = setup({ getDigitalRuntime: async () => { throw new Error('不公开内部错误') } })
  await controller.openDigital('digital-a')
  assert.equal(controller.state.digital?.album.id, 'digital-a')
  assert.equal(controller.state.runtime, undefined)
  assert.equal(controller.state.tracks, undefined)
  assert.match(controller.state.error, /运行|Roon/u)
  assert.doesNotMatch(controller.state.error, /不公开内部错误/u)
})

test('失效数字引用只影响该专辑的选择，其他专辑顺序保留', async () => {
  let unavailable = false
  const { controller } = setup({ getDigitalRuntime: async id => unavailable && id === 'digital-a' ? { status: 'needs-resolution' } : { status: 'available', reference: `runtime-${id}` } })
  await controller.openDigital('digital-a'); await controller.loadRelationTracks(); controller.toggle(controller.state.tracks!.items[0]!, true)
  await controller.openDigital('digital-b'); await controller.loadRelationTracks(); controller.toggle(controller.state.tracks!.items[0]!, true)
  unavailable = true
  await controller.openDigital('digital-a')
  assert.deepEqual(controller.state.selected.map(item => item.stale), [true, false])
  assert.deepEqual(controller.selectedReferences(), [])
  controller.toggle(controller.state.selected[0]!.item, false)
  assert.deepEqual(controller.selectedReferences(), ['runtime-digital-b-track'])
})

test('来源tab方向键环绕，Home/End明确落点，其他键不接管', () => {
  assert.equal(sourceTabForKey('roon', 'ArrowRight'), 'relations')
  assert.equal(sourceTabForKey('relations', 'ArrowLeft'), 'roon')
  assert.equal(sourceTabForKey('relations', 'ArrowRight'), 'roon')
  assert.equal(sourceTabForKey('relations', 'Home'), 'roon')
  assert.equal(sourceTabForKey('roon', 'End'), 'relations')
  assert.equal(sourceTabForKey('roon', 'Tab'), undefined)
})

test('最终确认前重新核对所有已选关系runtime，不以旧页可用状态提交', async () => {
  let available = true
  const { controller } = setup({ getDigitalRuntime: async () => available ? { status: 'available', reference: 'runtime-a' } : { status: 'unavailable' } })
  await controller.openDigital('digital-a'); await controller.loadRelationTracks(); controller.toggle(controller.state.tracks!.items[0]!, true)
  controller.backFromTracks(); controller.backToMatrix()
  available = false
  assert.equal(await controller.validateSelection(), false)
  assert.equal(controller.state.selected[0]?.stale, true)
  assert.deepEqual(controller.selectedReferences(), [])
})

test('Core健康事件也使选曲失效，不只监听Roon变化；无关事件不改状态', () => {
  const availability = sourceRoonAvailability
  const event = (event: string, runtime = 'ready', roon = 'ready') => ({ event, payload: { state: { runtime, roon } } }) as TypedIpcEvent
  assert.equal(availability(event('core.health', 'failed')), false)
  assert.equal(availability(event('core.health')), true)
  assert.equal(availability(event('roon.changed', 'ready', 'disconnected')), false)
  assert.equal(availability(event('core.ready', 'ready', 'paired')), true)
  assert.equal(availability(event('playback.changed')), undefined)
})

test('收藏分页请求乱序时只显示最后一页，参数与搜索保持有界', async () => {
  const first = deferred<Page<CollectionMatrixRow>>()
  const requests: { offset: number; limit: number; query?: string }[] = []
  const { controller } = setup({ getCollectionMatrix: async (request, query) => {
    requests.push({ ...request, query })
    return request.offset === 0 ? first.promise : { ...matrix, offset: request.offset }
  } })
  const old = controller.loadMatrix('同名', 0)
  await controller.loadMatrix('同名', 24)
  first.resolve(matrix)
  await old
  assert.deepEqual(requests, [{ offset: 0, limit: 24, query: '同名' }, { offset: 24, limit: 24, query: '同名' }])
  assert.equal(controller.state.matrix?.offset, 24)
})

test('Roon断线不丢弃独立的本地矩阵读取，离线详情仍展示本地关系', async () => {
  const delayed = deferred<Page<CollectionMatrixRow>>()
  const { controller } = setup({ getCollectionMatrix: async () => delayed.promise })
  const reading = controller.loadMatrix('')
  controller.setRoonAvailable(false)
  delayed.resolve(matrix)
  await reading
  assert.equal(controller.state.matrix?.items[0]?.digitalId, 'digital-a')
  await controller.openDigital('digital-a')
  assert.equal(controller.state.digital?.album.id, 'digital-a')
  assert.equal(controller.state.runtime?.status, 'unavailable')
})

test('断线时保留迟到的本地详情，但断线前发出的runtime不能恢复为available', async () => {
  const local = deferred<DigitalAlbumDetail>()
  const remote = deferred<DigitalRuntime>()
  const remoteStarted = deferred<void>()
  const { controller } = setup({ getDigitalAlbum: async () => local.promise, getDigitalRuntime: async () => { remoteStarted.resolve(); return remote.promise } })
  const localReading = controller.openDigital('digital-a')
  controller.setRoonAvailable(false)
  local.resolve(detail())
  await localReading
  assert.equal(controller.state.digital?.album.id, 'digital-a')
  assert.equal(controller.state.runtime?.status, 'unavailable')
  controller.setRoonAvailable(true)
  const remoteReading = controller.openDigital('digital-a')
  await remoteStarted.promise
  controller.setRoonAvailable(false)
  controller.setRoonAvailable(true)
  remote.resolve({ status: 'available', reference: 'old-runtime' })
  await remoteReading
  assert.notEqual(controller.state.runtime?.status, 'available')
})
