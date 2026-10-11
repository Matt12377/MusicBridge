import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { compileScript, compileTemplate, parse } from '@vue/compiler-sfc'
import ts from 'typescript'
import type {
  LocalLibraryPublicApi, LocalLibraryQuery, LocalLibraryQueryPage, LocalLibraryTrackDetail,
  LocalLibraryTrackSummary, LocalPlayAccepted, LocalPlayReceipt, LocalPlayRejection,
  LocalPlayRequest, LocalRootView, Page, PlaybackQueueRequestItem, PlaybackSnapshot, TrackSummary,
} from '@music-bridge/contracts'
import { useLocalLibrary, type LocalLibraryOptions } from '../src/renderer/src/composables/application/useLocalLibrary.js'
import { usePlaybackSession } from '../src/renderer/src/composables/application/usePlaybackSession.js'
import * as playbackDetails from '../src/renderer/src/components/player/details.js'
import type { MusicBridgePublicApi } from '../src/preload/api.js'
import { createLocalLibraryClient } from '../src/preload/local-library-client.js'
import { createCommandOutboxDatasetScope } from '../src/preload/command-outbox-client.js'
import { installLocalLibraryHandlers } from '../src/main/local-library-ipc.js'
import { CoreIpcError } from '../src/main/core-supervisor.js'

// 全部使用合成DTO与受控端口；覆盖正式软件行为，不构成实际App、Roon或听感证据。
const id = (n: number) => `11111111-1111-4111-8111-${String(n).padStart(12, '0')}`
const target = { core_id: '合成Core', zone_id: '合成Zone' }
const root: LocalRootView = {
  root: { id: id(1), sourceRootId: id(2), role: 'library', revision: '1' },
  label: '合成只读目录', availability: 'ONLINE',
}
function item(n = 0): LocalLibraryTrackSummary {
  return {
    track: { id: id(1000 + n), assetId: id(2000 + n), selectionRevision: '1', segment: null },
    asset: { id: id(2000 + n), libraryRootId: root.root.id, sourceRootId: root.root.sourceRootId,
      rootRevision: '1', fileRevision: '1', locationRevision: '1', sampleFrames: null, timebaseHz: null },
    metadata: { title: `合成曲目 ${n}`, artist: '合成作者', album: '合成专辑' }, versionTokens: [],
  }
}
function detail(n = 0): LocalLibraryTrackDetail {
  const value = item(n)
  return { track: value.track, asset: value.asset, metadata: { raw: value.metadata, effective: value.metadata, override: null },
    editions: [], versionTokens: [], fileParameters: null }
}
function page(query: LocalLibraryQuery): LocalLibraryQueryPage {
  const values = [item(), item(1)]
  return { ...query, total: values.length, hasMore: false, items: values.slice(query.offset, query.offset + query.limit) }
}
function libraryApi(overrides: Partial<LocalLibraryPublicApi> = {}): LocalLibraryPublicApi {
  return {
    queryLocalLibraryTracks: async query => page(query),
    getLocalLibraryTrackDetail: async trackId => detail(Number(trackId.slice(-12)) - 1000),
    getLocalLibraryPlaybackTarget: async () => ({ ...target }), listLocalLibraryRoots: async () => [root],
    ...overrides,
  } as LocalLibraryPublicApi
}
function selection(n = 0): LocalPlayRequest {
  return { schema_version: '1.2', request_id: id(700 + n), route: 'roon_audio_input', source_kind: 'local_file',
    local_track_id: item(n).track.id, asset_id: item(n).asset.id, expected_asset_revision: '1',
    target: { ...target }, action: 'PLAY_NOW' }
}
function accepted(request: LocalPlayRequest): LocalPlayAccepted {
  return { status: 'accepted', request_id: request.request_id, action: request.action }
}
function received(request: LocalPlayRequest): LocalPlayReceipt {
  return { status: 'received', request_id: request.request_id, action: request.action, result: accepted(request) }
}
function unsettled(status: 'missing' | 'pending', request: LocalPlayRequest): LocalPlayReceipt {
  return { status, request_id: request.request_id, action: request.action }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
const flush = () => new Promise<void>(resolve => setImmediate(resolve))
function librarySession(t: TestContext, options: Partial<LocalLibraryOptions> = {}) {
  const sends: LocalPlayRequest[] = []
  const model = useLocalLibrary({ api: libraryApi(), getSelectedZone: () => ({ zoneId: target.zone_id, displayName: '合成目标', selected: true }),
    play: async request => { sends.push(structuredClone(request)); throw new Error('[TIMEOUT] 合成丢失受理回执') }, ...options })
  t.after(() => model.dispose())
  return { model, sends }
}

test('MBF001-B：原未知请求反复核对保留UUID与九字段，missing/pending均不授权重发', async t => {
  const uuid = t.mock.method(globalThis.crypto, 'randomUUID', () => id(700) as ReturnType<Crypto['randomUUID']>)
  let status: 'missing' | 'pending' | 'received' = 'missing', revision = '1', currentTarget = { ...target }
  const reads: LocalPlayRequest[] = []
  const f = librarySession(t, {
    api: libraryApi({ getLocalLibraryTrackDetail: async trackId => { const value = detail(Number(trackId.slice(-12)) - 1000); value.asset.fileRevision = revision; return value },
      getLocalLibraryPlaybackTarget: async () => currentTarget }),
    readPlayReceipt: async request => { reads.push(structuredClone(request)); return status === 'received' ? received(request) : unsettled(status, request) },
  })
  await f.model.activate(); await f.model.playTrack(item().track.id)
  const binding = f.model.lastPlay.value!, original = structuredClone(binding.request)
  assert.equal(binding.outcome, 'unknown'); assert.equal(f.model.canReadOriginalPlay.value, true)
  assert.equal(Object.keys(original).length, 9)
  revision = '9'; currentTarget = { core_id: '新的合成Core', zone_id: '新的合成Zone' }
  await f.model.selectTrack(item(1).track.id)
  for (const next of ['missing', 'pending', 'missing', 'pending'] as const) {
    status = next; await f.model.readOriginalPlay()
    assert.equal(f.model.lastPlay.value, binding)
    assert.equal(f.model.lastPlay.value?.outcome, 'unknown')
    assert.match(f.model.actionError.value, next === 'missing' ? /没有原提交的回执.*不会重发/u : /仍在处理.*不会新增或重发/u)
    for (const action of ['PLAY_NOW', 'APPEND_MB_QUEUE', 'PLAY_NEXT_MB_QUEUE'] as const) await f.model.playTrack(item(1).track.id, action)
    assert.equal(f.sends.length, 1); assert.match(f.model.actionError.value, /原点播.*尚未闭合.*暂不新增点播/u)
  }
  status = 'received'; await f.model.readOriginalPlay()
  assert.equal(f.model.lastPlay.value?.outcome, 'received'); assert.deepEqual(f.model.lastPlay.value?.result, accepted(original))
  assert.deepEqual(f.model.lastPlay.value?.request, original); assert.ok(reads.every(request => JSON.stringify(request) === JSON.stringify(original)))
  await f.model.playTrack(item(1).track.id)
  assert.equal(f.sends.length, 1); assert.equal(uuid.mock.callCount(), 1)
  assert.doesNotMatch(playbackDetails.localLibraryPlaybackStatus(null, f.model.lastPlay.value).request, /Roon 已确认播放/u)
})

test('MBF001-B：无专用回调时读取公开API，查询副本不能改动原提交body', async t => {
  const reads: LocalPlayRequest[] = []
  const f = librarySession(t, { api: libraryApi({ getLocalLibraryPlayReceipt: async request => {
    reads.push(structuredClone(request)); const result = received(request)
    request.target.zone_id = '回调改动副本'; request.asset_id = id(9999)
    return result
  } }) })
  await f.model.activate(); await f.model.playTrack(item().track.id)
  const original = structuredClone(f.model.lastPlay.value!.request)
  await f.model.readOriginalPlay(); await f.model.readOriginalPlay()
  assert.deepEqual(reads, [original, original]); assert.deepEqual(f.model.lastPlay.value?.request, original)
  assert.equal(f.model.lastPlay.value?.outcome, 'received'); assert.equal(f.sends.length, 1)
})

const invalidReads: { label: string; read: (request: LocalPlayRequest) => Promise<LocalPlayReceipt> }[] = [
  { label: '外层请求ID失配', read: async request => ({ ...received(request), request_id: id(999) }) },
  { label: '动作失配', read: async request => ({ ...unsettled('pending', request), action: 'APPEND_MB_QUEUE' }) },
  { label: '内层受理ID失配', read: async request => ({ ...received(request), result: { ...accepted(request), request_id: id(999) } }) },
  { label: '回执夹带隐藏路径', read: async request => Object.defineProperty(received(request), 'absolutePath', { value: '/合成禁止路径' }) },
  { label: '查询传输失败', read: async () => { throw new Error('合成只读查询失败') } },
]
for (const entry of invalidReads) test(`MBF001-B：${entry.label}保留原未知请求与重试读取能力`, async t => {
  const f = librarySession(t, { readPlayReceipt: entry.read })
  await f.model.activate(); await f.model.playTrack(item().track.id)
  const original = f.model.lastPlay.value!
  for (let i = 0; i < 2; i++) {
    await f.model.readOriginalPlay()
    assert.equal(f.model.lastPlay.value, original); assert.equal(f.model.actionBusy.value, false)
    assert.match(f.model.actionError.value, /原请求和未确认状态保留/u)
  }
  await f.model.playTrack(item(1).track.id)
  assert.equal(f.sends.length, 1); assert.equal(f.model.lastPlay.value?.outcome, 'unknown')
})

const rejections: { reason: LocalPlayRejection; message: RegExp }[] = [
  { reason: 'REQUEST_REJECTED', message: /原点播请求已拒绝/u },
  { reason: 'TARGET_UNAVAILABLE', message: /Roon 播放目标不可用/u },
  { reason: 'SOURCE_UNAVAILABLE', message: /来源准备失败/u },
  { reason: 'MEDIA_ERROR', message: /原媒体错误/u },
  { reason: 'ROON_TIMEOUT', message: /原启动请求已超时/u },
  { reason: 'INTERNAL_ERROR', message: /原请求处理失败/u },
]
for (const entry of rejections) test(`MBF001-B：原回执${entry.reason}呈现具体失败，不保留未知或伪造Playing`, async t => {
  const f = librarySession(t, { readPlayReceipt: async request => ({ status: 'rejected', request_id: request.request_id, action: request.action, reason: entry.reason }) })
  await f.model.activate(); await f.model.playTrack(item().track.id)
  const request = structuredClone(f.model.lastPlay.value!.request)
  await f.model.readOriginalPlay()
  assert.deepEqual(f.model.lastPlay.value, { request, result: null, outcome: 'rejected', failure: entry.reason })
  assert.match(f.model.actionError.value, entry.message)
  const status = playbackDetails.localLibraryPlaybackStatus(null, f.model.lastPlay.value)
  assert.match(status.request, /已失败/u); assert.doesNotMatch(status.request, /未知|已确认播放/u)
  assert.equal(f.sends.length, 1)
})

test('MBF001-B：派发前详情读取失败不产生未知请求，恢复读取后仍可明确点播', async t => {
  let available = false
  const f = librarySession(t, { api: libraryApi({ getLocalLibraryTrackDetail: async () => { if (!available) throw new Error('合成预检失败'); return detail() } }) })
  await f.model.activate(); await f.model.playTrack(item().track.id)
  const unsubmitted = f.model.lastPlay.value
  assert.equal(unsubmitted, null); assert.equal(f.model.canReadOriginalPlay.value, false); assert.equal(f.sends.length, 0)
  assert.match(f.model.actionError.value, /尚未派发/u)
  available = true; await f.model.playTrack(item().track.id)
  assert.equal(f.sends.length, 1); assert.equal(f.model.lastPlay.value?.outcome, 'unknown')
})

for (const code of ['LOCAL_PLAY_REJECTED', 'INVENTORY_CONFLICT', 'INVALID_IPC_REQUEST'] as const) {
  test(`MBF001-B：已知${code}与丢回执区分，确定未受理后可接受新的明确选择`, async t => {
    const sends: LocalPlayRequest[] = []
    const f = librarySession(t, { play: async request => { sends.push(structuredClone(request)); if (sends.length === 1) throw new Error(`[${code}] 合成确定拒绝`); return accepted(request) } })
    await f.model.activate(); await f.model.playTrack(item().track.id)
    assert.equal(f.model.lastPlay.value?.outcome, 'rejected'); assert.equal(f.model.lastPlay.value?.failure, 'REQUEST_REJECTED')
    assert.match(f.model.actionError.value, /已拒绝/u); assert.doesNotMatch(f.model.actionError.value, /结果未获确认/u)
    await f.model.playTrack(item(1).track.id)
    assert.equal(sends.length, 2); assert.notEqual(sends[0]!.request_id, sends[1]!.request_id)
    assert.equal(sends[1]!.local_track_id, item(1).track.id); assert.equal(f.model.lastPlay.value?.outcome, 'received')
  })
}

test('MBF001-B：核对期间并发点击只产生一次查询，新的三种点播动作均零派发', async t => {
  const waiting = deferred<LocalPlayReceipt>(), reads: LocalPlayRequest[] = []
  const f = librarySession(t, { readPlayReceipt: request => { reads.push(structuredClone(request)); return waiting.promise } })
  await f.model.activate(); await f.model.playTrack(item().track.id)
  const original = f.model.lastPlay.value!, first = f.model.readOriginalPlay()
  await f.model.readOriginalPlay()
  for (const action of ['PLAY_NOW', 'APPEND_MB_QUEUE', 'PLAY_NEXT_MB_QUEUE'] as const) await f.model.playTrack(item(1).track.id, action)
  assert.equal(reads.length, 1); assert.equal(f.sends.length, 1); assert.equal(f.model.actionBusy.value, true)
  waiting.resolve(unsettled('pending', original.request)); await first
  assert.equal(f.model.lastPlay.value, original); assert.equal(f.model.actionBusy.value, false)
})

test('MBF001-B：原回执迟到时保留当前B详情、滚动和选择，仍只关联原A请求', async t => {
  const waiting = deferred<LocalPlayReceipt>(), reads: LocalPlayRequest[] = []
  const f = librarySession(t, { readPlayReceipt: request => { reads.push(structuredClone(request)); return waiting.promise } })
  await f.model.activate(); await f.model.selectTrack(item().track.id); await f.model.playTrack(item().track.id)
  const original = f.model.lastPlay.value!.request, reading = f.model.readOriginalPlay()
  await f.model.selectTrack(item(1).track.id); f.model.scrollTop.value = 84
  const current = f.model.detail.value
  waiting.resolve(received(original)); await reading
  assert.equal(f.model.selectedId.value, item(1).track.id); assert.equal(f.model.detail.value, current); assert.equal(f.model.scrollTop.value, 84)
  assert.equal(f.model.lastPlay.value?.request.local_track_id, item().track.id); assert.deepEqual(reads, [original]); assert.equal(f.sends.length, 1)
})

test('MBF001-B：dispose后的迟到回执不能修改原未知结果或启动新查询', async t => {
  const waiting = deferred<LocalPlayReceipt>(); let reads = 0
  const f = librarySession(t, { readPlayReceipt: () => { reads++; return waiting.promise } })
  await f.model.activate(); await f.model.playTrack(item().track.id)
  const original = f.model.lastPlay.value!, reading = f.model.readOriginalPlay()
  f.model.dispose(); waiting.resolve(received(original.request)); await reading
  await f.model.readOriginalPlay(); await f.model.playTrack(item(1).track.id)
  assert.equal(f.model.lastPlay.value, original); assert.equal(f.model.lastPlay.value?.outcome, 'unknown')
  assert.equal(reads, 1); assert.equal(f.sends.length, 1)
})

test('MBF001-B：原received回执的不支持结论保留来源事实，不当成受理或Playing', async t => {
  const f = librarySession(t, { readPlayReceipt: async request => ({ status: 'received', request_id: request.request_id, action: request.action,
    result: { status: 'unsupported', reason: 'LOCAL_PLAYBACK_PROTOCOL_UNSUPPORTED' } }) })
  await f.model.activate(); await f.model.playTrack(item().track.id); await f.model.readOriginalPlay()
  assert.equal(f.model.lastPlay.value?.outcome, 'received'); assert.equal(f.model.lastPlay.value?.result?.status, 'unsupported')
  const status = playbackDetails.localLibraryPlaybackStatus(null, f.model.lastPlay.value)
  assert.match(status.request, /不支持原文件直送/u); assert.doesNotMatch(status.request, /已受理|已确认播放/u); assert.equal(f.sends.length, 1)
})

type SyntheticEvent = { trusted: boolean }
type Handler = (event: SyntheticEvent, value?: unknown) => unknown
function mainHarness(request: (command: string, payload: unknown, datasetId?: string) => Promise<unknown>) {
  const handlers = new Map<string, Handler>()
  installLocalLibraryHandlers({ handle: (channel, handler) => handlers.set(channel, handler),
    requireTrusted: (event: SyntheticEvent) => { if (!event.trusted) throw new Error('合成不可信窗口') },
    supervisor: { request, requestInternal: async () => { throw new Error('只读回执不得进入内部通道') } } as any,
    pick: async () => { throw new Error('只读回执不得打开picker') },
  })
  return { handlers, invoke: async (channel: string, value?: unknown) => handlers.get(channel)!({ trusted: true }, value) }
}
const writes = {
  chooseRoot: async () => null,
  confirm: async (): Promise<never> => { throw new Error('回执查询不得重定位') },
  relink: async (): Promise<never> => { throw new Error('回执查询不得重关联') },
}

test('MBF001-B：Preload到Main的原回执只读闭集固定dataset，换库不借新库查询原UUID', async () => {
  const calls: { command: string; payload: unknown; datasetId?: string }[] = [], original = selection()
  const initialDataset = id(90); let currentDataset = initialDataset, contexts = 0
  const f = mainHarness(async (command, payload, datasetId) => {
    calls.push({ command, payload: structuredClone(payload), datasetId })
    if (datasetId !== currentDataset) throw new CoreIpcError('OUTBOX_SCOPE_MISMATCH', '合成工作库失配')
    return received(payload as LocalPlayRequest)
  })
  const invoke = async (channel: string, value?: unknown) => {
    if (channel === 'commandOutbox:context') { contexts++; return { datasetId: currentDataset } }
    return f.invoke(channel, value)
  }
  const client = createLocalLibraryClient(invoke, createCommandOutboxDatasetScope(invoke), writes)
  assert.deepEqual(await client.getLocalLibraryPlayReceipt!(original), received(original))
  currentDataset = id(91)
  await assert.rejects(client.getLocalLibraryPlayReceipt!(original), /\[INVENTORY_CONFLICT\]/u)
  currentDataset = initialDataset
  assert.deepEqual(await client.getLocalLibraryPlayReceipt!(original), received(original))
  assert.equal(contexts, 1); assert.equal(calls.length, 3)
  assert.ok(calls.every(call => call.command === 'localCatalog.playReceipt' && call.datasetId === initialDataset))
  assert.ok(calls.every(call => JSON.stringify(call.payload) === JSON.stringify(original)))
})

test('MBF001-B：Preload在clone前拒绝隐藏键、symbol和getter，不发送篡改原selection', async () => {
  let sent = 0
  const client = createLocalLibraryClient(async () => { sent++; return null }, async () => id(90), writes)
  const hidden = Object.defineProperty(selection(), 'absolutePath', { value: '/合成禁止路径' })
  const symbol = Object.assign(selection(), { [Symbol('私有选择')]: '合成内部值' })
  const getter = Object.defineProperty(selection(), 'asset_id', { enumerable: true, get: () => item().asset.id })
  const targetExtra = { ...selection(), target: Object.defineProperty({ ...target }, 'session', { value: '合成内部值' }) }
  const extra = { ...selection(), datasetId: id(91) }
  for (const request of [hidden, symbol, getter, targetExtra, extra]) await assert.rejects(client.getLocalLibraryPlayReceipt!(request), /\[INVALID_IPC_REQUEST\]/u)
  assert.equal(sent, 0)
})

test('MBF001-B：Main仅接受可信窗口闭合回执信封，拒绝播放写命令与私有选择参数', async () => {
  let sent = 0
  const f = mainHarness(async () => { sent++; return null }), handler = f.handlers.get('localLibrary:request')!
  const envelope = { datasetId: id(90), command: 'localCatalog.playReceipt', payload: selection() }
  await assert.rejects(async () => handler({ trusted: false }, envelope), /不可信窗口/u)
  const hidden = Object.defineProperty({ ...envelope }, 'absolutePath', { value: '/合成禁止路径' })
  const symbol = Object.assign({ ...envelope }, { [Symbol('私有信封')]: true })
  for (const body of [hidden, symbol, { ...envelope, datasetId: id(91), expectedDatasetId: id(90) },
    { ...envelope, payload: { ...selection(), absolutePath: '/合成禁止路径' } },
    { ...envelope, payload: { ...selection(), target: { ...target, session_id: '合成内部值' } } },
    ...['playback.play', 'localCatalog.overrideMetadata', 'localCatalog.createEdition', 'localScan.prepareBatch'].map(command => ({ ...envelope, command }))]) {
    await assert.rejects(async () => handler({ trusted: true }, body), /\[INVALID_IPC_REQUEST\]/u)
  }
  assert.equal(sent, 0)
})

test('MBF001-B：Main保留确定拒绝与scope冲突类别，超时只投影未知且不泄漏Core细节', async () => {
  const cases: { code: ConstructorParameters<typeof CoreIpcError>[0]; expected: RegExp }[] = [
    { code: 'INVALID_IPC_REQUEST', expected: /^\[LOCAL_PLAY_REJECTED\]/u },
    { code: 'ROON_ZONE_NOT_SELECTED', expected: /^\[LOCAL_PLAY_REJECTED\]/u },
    { code: 'ROON_CORE_NOT_CONNECTED', expected: /^\[LOCAL_PLAY_REJECTED\]/u },
    { code: 'INVENTORY_CONFLICT', expected: /^\[INVENTORY_CONFLICT\]/u },
    { code: 'OUTBOX_SCOPE_MISMATCH', expected: /^\[INVENTORY_CONFLICT\]/u },
    { code: 'TIMEOUT', expected: /^\[INVENTORY_UNAVAILABLE\]/u },
  ]
  for (const entry of cases) {
    const f = mainHarness(async () => { throw new CoreIpcError(entry.code, '/合成私有路径 SDK内部session-secret') })
    for (const command of ['localCatalog.prepare', 'localCatalog.playReceipt']) {
      await assert.rejects(f.invoke('localLibrary:request', { datasetId: id(90), command, payload: selection() }), error => {
        assert.ok(error instanceof Error); assert.match(error.message, entry.expected)
        assert.doesNotMatch(error.message, /合成私有路径|session-secret|SDK内部/u)
        return true
      })
    }
  }
})

test('MBF001-B：Preload拒绝非法或夹带路径的回执，不把非合同结果交给Renderer', async () => {
  const request = selection()
  const invalid = [
    { ...received(request), absolutePath: '/合成禁止路径' },
    { status: 'rejected', request_id: request.request_id, action: request.action, reason: 'SDK_INTERNAL_STACK' },
    { ...received(request), result: { ...accepted(request), action: 'APPEND_MB_QUEUE' } },
    { status: 'pending', request_id: request.request_id, action: request.action, result: accepted(request) },
  ]
  for (const result of invalid) {
    const client = createLocalLibraryClient(async () => result, async () => id(90), writes)
    await assert.rejects(client.getLocalLibraryPlayReceipt!(request), /\[INVALID_IPC_REQUEST\]/u)
  }
})

function observed(request = selection(), phase: 'AWAITING_ROON' | 'PLAYING' | 'PAUSED' = 'AWAITING_ROON'): PlaybackSnapshot {
  const track = { id: request.local_track_id, title: '合成本地播放', artists: ['合成作者'], album: '合成专辑' }
  const confirmed = phase !== 'AWAITING_ROON'
  return {
    state: phase === 'PLAYING' ? 'playing' : phase === 'PAUSED' ? 'paused' : 'preparing', source: 'local_file', currentTrack: track,
    positionMs: 0, selectedZoneId: request.target.zone_id,
    queue: { items: [{ trackId: track.id, track, resolvedSource: 'local_file', qualityPreference: 'auto',
      local: { local_track_id: track.id, asset_id: request.asset_id, asset_revision: request.expected_asset_revision,
        selection_revision: '1', location_revision: '1', root_revision: '1' } }], index: 0, hasNext: false, hasPrevious: false },
    canNext: false, canPrevious: false, canPause: phase === 'PLAYING', canResume: phase === 'PAUSED', canStop: true,
    local: { schema_version: '1.2', request_id: request.request_id, attempt_id: id(800), intent_generation: '1', route: request.route,
      local_track_id: track.id, asset_id: request.asset_id, asset_revision: request.expected_asset_revision, target: { ...request.target },
      session_epoch: confirmed ? '合成观察轮次' : null, phase, ownership: confirmed ? 'MB_OWNED' : 'MB_PENDING', queue_owner: 'MB',
      delivery_state: 'UNKNOWN', roon_observation: { event: phase === 'PLAYING' ? 'PLAYING' : phase === 'PAUSED' ? 'PAUSED' : 'NONE', observed: confirmed,
        correlation: confirmed ? 'ATTEMPT_CONFIRMED' : 'UNKNOWN' }, position_ms: 0,
      quality: { http_bytes: 'NOT_TESTED', signal_path: 'NOT_TESTED', digital_output: 'NOT_TESTED', gapless: 'NOT_TESTED' }, error_code: null },
  }
}
function playbackSession(t: TestContext, overrides: Partial<MusicBridgePublicApi>,
  getSelectedZone = () => ({ zoneId: target.zone_id, displayName: '合成目标', selected: true })) {
  const forbidden: string[] = [], errors: unknown[] = [], messages: string[] = []
  const deny = (name: string) => async (): Promise<never> => { forbidden.push(name); throw new Error(`回执查询不得调用 ${name}`) }
  const api = { play: deny('play'), playLocalLibraryTrack: deny('playLocalLibraryTrack'), replaceQueue: deny('replaceQueue'),
    appendQueue: deny('appendQueue'), insertNext: deny('insertNext'), getLyrics: deny('getLyrics'),
    getTrackLikeStatus: deny('getTrackLikeStatus'), setTrackLiked: deny('setTrackLiked'), ...overrides } as MusicBridgePublicApi
  const model = usePlaybackSession({ api, getSelectedZone,
    getZoneLifecycleStatus: () => 'selected', getSelectedQuality: () => 'auto', getMatchResult: () => undefined,
    getPendingMatch: () => undefined, onMatchTracks() {}, getRoonPlaybackContext: () => undefined,
    resolveFavoriteDescriptor: () => { throw new Error('合成本地请求无Provider身份') }, onEnterNowPlaying() {}, clearActionError() {},
    onActionMessage: message => messages.push(message), onError: error => errors.push(error), onToast() {},
  })
  t.after(() => model.dispose())
  return { model, forbidden, errors, messages }
}

test('MBF001-B：播放Store只查原回执并读取公开快照，accepted不能自行转换Playing', async t => {
  const request = selection(), state = observed(request), calls: string[] = [], reads: LocalPlayRequest[] = []
  const f = playbackSession(t, {
    getLocalLibraryPlayReceipt: async body => { calls.push('receipt'); reads.push(structuredClone(body)); return received(body) },
    getPlaybackState: async () => { calls.push('snapshot'); return state },
  })
  assert.deepEqual(await f.model.readLocalLibraryPlayReceipt(request), received(request))
  assert.deepEqual(calls, ['receipt', 'snapshot']); assert.deepEqual(reads, [request]); assert.deepEqual(f.forbidden, [])
  assert.equal(f.model.playbackState.value?.state, 'preparing'); assert.equal(f.model.playbackState.value?.local?.phase, 'AWAITING_ROON')
  assert.equal(f.model.recentTracks.value.length, 0); assert.equal(f.model.playbackStartPending.value, false)
  assert.deepEqual(f.errors, [])
  const status = playbackDetails.localLibraryPlaybackStatus(f.model.playbackState.value, { request, result: accepted(request), outcome: 'received' })
  assert.match(status.state, /等待 Roon 确认/u); assert.doesNotMatch(status.state + status.request, /Roon 已确认播放/u)
})

test('MBF001-B：missing/pending回执也只刷新真实公开观察，不由查询清空现有队列', async t => {
  const request = selection(), state = observed(request, 'PAUSED'); let status: 'missing' | 'pending' = 'missing', snapshots = 0
  const f = playbackSession(t, { getLocalLibraryPlayReceipt: async body => unsettled(status, body),
    getPlaybackState: async () => { snapshots++; return state } })
  f.model.applyPlaybackState(state)
  const queue = f.model.playbackState.value!.queue
  for (const value of ['missing', 'pending'] as const) {
    status = value; assert.deepEqual(await f.model.readLocalLibraryPlayReceipt(request), unsettled(value, request))
    assert.equal(f.model.playbackState.value?.queue, queue); assert.equal(f.model.playbackState.value?.state, 'paused')
  }
  assert.equal(snapshots, 2); assert.deepEqual(f.forbidden, []); assert.deepEqual(f.errors, [])
})

test('MBF001-B：只读核对PLAY_NOW原UUID不取消正在补页的既有集合', async t => {
  const request = selection(), state = observed(request), nextPage = deferred<Page<TrackSummary>>()
  const firstTrack = { id: id(3000), title: '既有集合首曲', artists: [], album: '' }, secondTrack = { ...firstTrack, id: id(3001), title: '既有集合次曲' }
  const appended: PlaybackQueueRequestItem[][] = []; const calls: number[] = []
  const f = playbackSession(t, { getLocalLibraryPlayReceipt: async body => unsettled('missing', body), getPlaybackState: async () => state,
    appendQueue: async entries => { appended.push(structuredClone([...entries])); return state } })
  await f.model.appendCollection(async query => {
    calls.push(query.offset)
    return query.offset === 0 ? { ...query, total: 40, hasMore: true, items: [firstTrack] } : nextPage.promise
  })
  assert.deepEqual(calls, [0, 20]); assert.equal(appended.length, 1)
  await f.model.readLocalLibraryPlayReceipt(request)
  nextPage.resolve({ offset: 20, limit: 20, total: 40, hasMore: false, items: [secondTrack] })
  await flush(); await flush()
  assert.equal(appended.length, 2); assert.equal(appended[1]![0]!.trackId, secondTrack.id)
  assert.deepEqual(f.forbidden, []); assert.deepEqual(f.errors, [])
})

for (const interruption of ['新集合代次', 'dispose'] as const) test(`MBF001-B：Store查询后的迟到快照遇到${interruption}不覆盖当前状态`, async t => {
  const request = selection(), oldState = observed(request), current = observed(selection(1), 'PAUSED')
  const waiting = deferred<PlaybackSnapshot>(), snapshotStarted = deferred<void>()
  const f = playbackSession(t, { getLocalLibraryPlayReceipt: async body => received(body),
    getPlaybackState: () => { snapshotStarted.resolve(); return waiting.promise } })
  f.model.applyPlaybackState(current)
  const binding = f.model.playbackState.value, reading = f.model.readLocalLibraryPlayReceipt(request)
  await snapshotStarted.promise
  if (interruption === 'dispose') f.model.dispose()
  else f.model.invalidateCollectionOperation()
  waiting.resolve(oldState); await reading
  assert.equal(f.model.playbackState.value, binding); assert.equal(f.model.playbackState.value?.currentTrack?.id, current.currentTrack?.id)
  assert.deepEqual(f.forbidden, []); assert.deepEqual(f.errors, []); assert.equal(f.model.playbackStartPending.value, false)
})

test('MBF001-B：Store原回执读取失败保留当前观察，不重播或新增快照查询', async t => {
  let snapshots = 0
  const f = playbackSession(t, { getLocalLibraryPlayReceipt: async () => { throw new Error('合成回执读失败') },
    getPlaybackState: async () => { snapshots++; return observed() } })
  f.model.applyPlaybackState(observed(selection(1), 'PAUSED'))
  const binding = f.model.playbackState.value
  await assert.rejects(f.model.readLocalLibraryPlayReceipt(selection()), /合成回执读失败/u)
  assert.equal(f.model.playbackState.value, binding); assert.equal(f.model.playbackStartPending.value, false)
  assert.equal(snapshots, 0); assert.deepEqual(f.forbidden, [])
})

function emptyPlayback(): PlaybackSnapshot {
  return { state: 'idle', positionMs: 0, queue: { items: [], index: 0, hasNext: false, hasPrevious: false },
    canNext: false, canPrevious: false, canPause: false, canResume: false, canStop: false }
}
function submissionUnknown(request: LocalPlayRequest): PlaybackSnapshot {
  const snapshot = observed(request)
  snapshot.local!.phase = 'SUBMISSION_UNKNOWN'; snapshot.local!.ownership = 'UNKNOWN'; snapshot.local!.queue_owner = 'UNKNOWN'
  return snapshot
}
function terminalPlayback(request: LocalPlayRequest, phase: 'ENDED' | 'FAILED' | 'CANCELLED'): PlaybackSnapshot {
  const snapshot = observed(request)
  snapshot.state = phase === 'FAILED' ? 'error' : 'idle'; snapshot.canStop = false
  snapshot.local!.phase = phase; snapshot.local!.ownership = 'NONE'; snapshot.local!.queue_owner = 'NONE'
  return snapshot
}

/** 实际Composable、Store、Preload与Main串联；只有Core公开输入和提交端口为受控合成替身。 */
function recoveryChain(t: TestContext, attribution: 'store' | 'absent' | 'null' = 'store') {
  const prepared: LocalPlayRequest[] = [], submissions: LocalPlayRequest[] = [], queries: LocalPlayRequest[] = []
  let current: PlaybackSnapshot = emptyPlayback(), snapshots = 0, attributionReads = 0
  let selectedTarget = { ...target }
  const selectedZone = () => ({ zoneId: selectedTarget.zone_id, displayName: '合成目标', selected: true })
  let receipt: (request: LocalPlayRequest) => LocalPlayReceipt = received
  const main = mainHarness(async (command, payload, datasetId) => {
    assert.equal(datasetId, id(90))
    const request = payload as LocalPlayRequest
    if (command === 'localCatalog.playReceipt') { queries.push(structuredClone(request)); return receipt(request) }
    assert.equal(command, 'localCatalog.prepare')
    prepared.push(structuredClone(request))
    // 此spy仅记录受控Core替身的提交次数，不能当作真实Roon SDK调用证据。
    submissions.push(structuredClone(request))
    if (prepared.length === 1) {
      current = request.action === 'PLAY_NOW' ? submissionUnknown(request) : emptyPlayback()
      throw new CoreIpcError('TIMEOUT', '合成原IPC已超时，Core保留原提交状态')
    }
    current = observed(request, 'PLAYING')
    return accepted(request)
  })
  const client = createLocalLibraryClient(main.invoke, async () => id(90), writes)
  const playback = playbackSession(t, { playLocalLibraryTrack: client.playLocalLibraryTrack,
    getLocalLibraryPlayReceipt: client.getLocalLibraryPlayReceipt,
    getPlaybackState: async () => { snapshots++; return structuredClone(current) } }, selectedZone)
  const model = useLocalLibrary({ api: libraryApi({ getLocalLibraryPlaybackTarget: async () => ({ ...selectedTarget }) }), getSelectedZone: selectedZone,
    play: playback.model.playLocalLibrarySelection, readPlayReceipt: playback.model.readLocalLibraryPlayReceipt,
    ...(attribution === 'absent' ? {} : { getPlaybackSnapshot: () => { attributionReads++; return attribution === 'null' ? null : playback.model.playbackState.value } }),
  })
  t.after(() => model.dispose())
  const begin = async (action: LocalPlayRequest['action'] = 'PLAY_NOW') => {
    await model.activate(); await model.playTrack(item().track.id, action)
    await playback.model.refreshPlayback()
    const binding = model.lastPlay.value!
    assert.equal(binding.outcome, 'unknown'); assert.equal(prepared.length, 1)
    return structuredClone(binding.request)
  }
  return { model, playback, prepared, submissions, queries, begin,
    snapshotReads: () => snapshots, setSnapshot: (snapshot: PlaybackSnapshot) => { current = snapshot },
    snapshotGetterReads: () => attributionReads,
    receiveSnapshot: (snapshot: PlaybackSnapshot) => { current = structuredClone(snapshot); playback.model.applyPlaybackState(structuredClone(snapshot)) },
    setTarget: (next: LocalPlayRequest['target']) => { selectedTarget = { ...next } },
    setReceipt: (value: (request: LocalPlayRequest) => LocalPlayReceipt) => { receipt = value } }
}

test('MBF001-B：IPC超时后读到accepted仍保留UNKNOWN原意图，再次点击不生成UUID或提交', async t => {
  let nextId = 700
  const uuid = t.mock.method(globalThis.crypto, 'randomUUID', () => id(nextId++) as ReturnType<Crypto['randomUUID']>)
  const f = recoveryChain(t), original = await f.begin()
  assert.equal(f.playback.model.playbackState.value?.local?.phase, 'SUBMISSION_UNKNOWN')
  assert.equal(f.playback.model.playbackState.value?.local?.ownership, 'UNKNOWN')
  const beforeReads = f.snapshotReads()
  await f.model.readOriginalPlay()
  assert.equal(f.model.lastPlay.value?.outcome, 'received'); assert.deepEqual(f.model.lastPlay.value?.result, accepted(original))
  assert.equal(f.snapshotReads(), beforeReads + 1)
  assert.equal(f.playback.model.playbackState.value?.local?.phase, 'SUBMISSION_UNKNOWN')
  assert.equal(f.playback.model.playbackState.value?.local?.ownership, 'UNKNOWN')
  for (const trackId of [item().track.id, item(1).track.id, item().track.id]) await f.model.playTrack(trackId)
  assert.equal(uuid.mock.callCount(), 1); assert.deepEqual(f.prepared, [original]); assert.deepEqual(f.submissions, [original])
  assert.deepEqual(f.queries, [original]); assert.deepEqual(f.model.lastPlay.value?.request, original)
  assert.match(f.model.actionError.value, /未确认|未知|尚未闭合/u)
  assert.doesNotMatch(playbackDetails.localLibraryPlaybackStatus(f.playback.model.playbackState.value, f.model.lastPlay.value).state, /Roon 已确认播放/u)
  assert.deepEqual(f.playback.forbidden, []); assert.deepEqual(f.playback.errors, [])
})

for (const phase of ['PLAYING', 'PAUSED', 'ENDED', 'FAILED', 'CANCELLED'] as const) {
  test(`MBF001-B：原强绑定${phase}安全观察解除未确认意图，允许新的明确点播`, async t => {
    let nextId = 700
    const uuid = t.mock.method(globalThis.crypto, 'randomUUID', () => id(nextId++) as ReturnType<Crypto['randomUUID']>)
    const f = recoveryChain(t), original = await f.begin()
    const state = phase === 'PLAYING' || phase === 'PAUSED' ? observed(original, phase) : terminalPlayback(original, phase)
    f.setSnapshot(state); await f.model.readOriginalPlay()
    assert.equal(f.playback.model.playbackState.value?.local?.phase, phase)
    assert.deepEqual(f.queries, [original]); assert.equal(f.prepared.length, 1)
    await f.model.playTrack(item(1).track.id)
    assert.equal(uuid.mock.callCount(), 2); assert.equal(f.prepared.length, 2); assert.equal(f.submissions.length, 2)
    const next = f.prepared[1]!
    assert.notEqual(next.request_id, original.request_id); assert.equal(next.local_track_id, item(1).track.id)
    assert.equal(f.model.lastPlay.value?.request.request_id, next.request_id); assert.deepEqual(f.playback.forbidden, [])
  })
}

function nonLocalPlayback(): PlaybackSnapshot {
  const track = { id: '合成非本地B', title: '来自主页的非本地曲目B', artists: [], album: '' }
  return { state: 'playing', source: 'roon', currentTrack: track, positionMs: 0, selectedZoneId: target.zone_id,
    queue: { items: [{ trackId: track.id, track, resolvedSource: 'roon', preferredSource: 'roon', qualityPreference: 'auto' }],
      index: 0, hasNext: false, hasPrevious: false },
    canNext: false, canPrevious: false, canPause: true, canResume: false, canStop: true }
}

for (const initialReceipt of ['unknown', 'received'] as const) {
  for (const closingPhase of ['PLAYING', 'CANCELLED'] as const) {
    test(`MBF001-B：原${initialReceipt}请求先收到${closingPhase}再切非本地B，旧accepted不重锁本地C`, async t => {
      let nextId = 700
      const uuid = t.mock.method(globalThis.crypto, 'randomUUID', () => id(nextId++) as ReturnType<Crypto['randomUUID']>)
      const f = recoveryChain(t), original = await f.begin()
      if (initialReceipt === 'received') await f.model.readOriginalPlay()
      const binding = f.model.lastPlay.value!, oldQueries = f.queries.length, oldSnapshotReads = f.snapshotReads()
      f.model.suspend()
      const closed = closingPhase === 'PLAYING' ? observed(original, 'PLAYING') : terminalPlayback(original, 'CANCELLED')
      // 同一调用栈应用两次真实Store ref；页面未read/play，只有同步watch能消费中间闭合观察。
      f.receiveSnapshot(closed); f.receiveSnapshot(nonLocalPlayback())
      assert.equal(f.model.lastPlay.value, binding); assert.equal(f.model.lastPlay.value?.outcome, initialReceipt)
      assert.equal(f.playback.model.playbackState.value?.source, 'roon'); assert.equal(f.playback.model.playbackState.value?.local, undefined)
      assert.equal(f.snapshotReads(), oldSnapshotReads); assert.equal(f.queries.length, oldQueries)
      await f.model.activate(); await f.model.readOriginalPlay()
      assert.equal(f.model.lastPlay.value?.outcome, 'received'); assert.deepEqual(f.model.lastPlay.value?.request, original)
      assert.ok(f.queries.every(request => JSON.stringify(request) === JSON.stringify(original)))
      assert.doesNotMatch(playbackDetails.localLibraryPlaybackStatus(f.playback.model.playbackState.value, f.model.lastPlay.value).request, /Roon 已确认播放/u)
      await f.model.playTrack(item(1).track.id)
      assert.equal(uuid.mock.callCount(), 2); assert.equal(f.prepared.length, 2); assert.equal(f.submissions.length, 2)
      assert.notEqual(f.prepared[1]!.request_id, original.request_id); assert.equal(f.prepared[1]!.local_track_id, item(1).track.id)
      assert.deepEqual(f.playback.forbidden, []); assert.deepEqual(f.playback.errors, [])
    })
  }
}

test('MBF001-B：未知回执保持unknown，已消费的原Playing在切源后仍允许新明确点播', async t => {
  const f = recoveryChain(t), original = await f.begin()
  const binding = f.model.lastPlay.value!
  f.model.suspend(); f.receiveSnapshot(observed(original, 'PLAYING')); f.receiveSnapshot(nonLocalPlayback())
  await f.model.activate()
  assert.equal(f.model.lastPlay.value, binding); assert.equal(f.model.lastPlay.value?.outcome, 'unknown')
  assert.equal(f.queries.length, 0); assert.deepEqual(f.prepared, [original])
  await f.model.playTrack(item(1).track.id)
  assert.equal(f.prepared.length, 2); assert.equal(f.prepared[1]!.local_track_id, item(1).track.id)
  assert.equal(f.queries.length, 0); assert.deepEqual(f.playback.forbidden, [])
})

for (const observation of ['没有闭合观察', '闭合请求身份失配'] as const) {
  test(`MBF001-B：${observation}就切非本地B清local，旧accepted仍不得解除原A意图`, async t => {
    let nextId = 700
    const uuid = t.mock.method(globalThis.crypto, 'randomUUID', () => id(nextId++) as ReturnType<Crypto['randomUUID']>)
    const f = recoveryChain(t), original = await f.begin()
    await f.model.readOriginalPlay(); f.model.suspend()
    if (observation === '闭合请求身份失配') f.receiveSnapshot(observed(selection(8), 'PLAYING'))
    f.receiveSnapshot(nonLocalPlayback()); await f.model.activate(); await f.model.readOriginalPlay()
    assert.equal(f.playback.model.playbackState.value?.local, undefined)
    assert.equal(f.model.lastPlay.value?.outcome, 'received'); assert.deepEqual(f.queries, [original, original])
    await f.model.playTrack(item(1).track.id)
    assert.equal(uuid.mock.callCount(), 1); assert.deepEqual(f.prepared, [original]); assert.deepEqual(f.submissions, [original])
    assert.deepEqual(f.model.lastPlay.value?.request, original); assert.deepEqual(f.playback.forbidden, [])
  })
}

test('MBF001-B：dispose释放实际snapshot同步watch，随后Store事件不再求值旧页面getter', async t => {
  const f = recoveryChain(t), original = await f.begin(), binding = f.model.lastPlay.value
  f.model.dispose()
  const getterReads = f.snapshotGetterReads()
  f.receiveSnapshot(observed(original, 'PLAYING')); f.receiveSnapshot(nonLocalPlayback())
  assert.equal(f.snapshotGetterReads(), getterReads); assert.equal(f.model.lastPlay.value, binding)
  assert.deepEqual(f.prepared, [original]); assert.equal(f.queries.length, 0); assert.deepEqual(f.playback.forbidden, [])
})

function switchedZoneSnapshot(snapshot: PlaybackSnapshot, zoneId: string): PlaybackSnapshot {
  const track = { id: '合成新Zone曲目', title: '新Zone当前观察', artists: [], album: '' }
  return { ...snapshot, source: 'roon', selectedZoneId: zoneId, currentTrack: track,
    queue: { items: [{ trackId: track.id, track, resolvedSource: 'roon', qualityPreference: 'auto' }],
      index: 0, hasNext: false, hasPrevious: false } }
}

test('MBF001-B：原CANCELLED+NONE终态后切换Zone与队列，不永久锁住新的明确点播', async t => {
  const f = recoveryChain(t), original = await f.begin()
  const nextTarget = { core_id: '合成新Core', zone_id: '合成新Zone' }
  f.setTarget(nextTarget)
  f.setSnapshot(switchedZoneSnapshot(terminalPlayback(original, 'CANCELLED'), nextTarget.zone_id))
  await f.model.readOriginalPlay()
  assert.equal(f.playback.model.playbackState.value?.selectedZoneId, nextTarget.zone_id)
  assert.equal(f.playback.model.playbackState.value?.source, 'roon')
  assert.equal(f.playback.model.playbackState.value?.local?.target.zone_id, original.target.zone_id)
  assert.deepEqual(f.queries, [original]); assert.equal(f.prepared.length, 1)
  await f.model.playTrack(item(1).track.id)
  assert.equal(f.prepared.length, 2); assert.equal(f.submissions.length, 2)
  assert.deepEqual(f.prepared[1]!.target, nextTarget); assert.equal(f.prepared[1]!.local_track_id, item(1).track.id)
  assert.deepEqual(f.playback.forbidden, [])
})

for (const originalLeaf of ['未知原leaf', '不匹配终态leaf'] as const) {
  test(`MBF001-B：切换Zone与队列后${originalLeaf}仍不能解除原点播意图`, async t => {
    const f = recoveryChain(t), original = await f.begin(), nextTarget = { core_id: '合成新Core', zone_id: '合成新Zone' }
    const localState = originalLeaf === '未知原leaf' ? submissionUnknown(original) : terminalPlayback(selection(8), 'CANCELLED')
    f.setTarget(nextTarget); f.setSnapshot(switchedZoneSnapshot(localState, nextTarget.zone_id))
    await f.model.readOriginalPlay(); await f.model.playTrack(item(1).track.id)
    assert.deepEqual(f.prepared, [original]); assert.deepEqual(f.submissions, [original]); assert.deepEqual(f.queries, [original])
    assert.deepEqual(f.model.lastPlay.value?.request, original); assert.deepEqual(f.playback.forbidden, [])
  })
}

const insufficientObservations: { label: string; snapshot: (request: LocalPlayRequest) => PlaybackSnapshot }[] = [
  { label: 'request_id失配', snapshot: request => { const value = observed(request, 'PAUSED'); value.local!.request_id = id(999); return value } },
  { label: '曲目身份失配', snapshot: request => { const value = observed(request, 'PAUSED'); value.local!.local_track_id = item(1).track.id;
    value.currentTrack!.id = item(1).track.id; value.queue.items[0]!.trackId = item(1).track.id; value.queue.items[0]!.local!.local_track_id = item(1).track.id; return value } },
  { label: '资产身份失配', snapshot: request => { const value = observed(request, 'PAUSED'); value.local!.asset_id = item(1).asset.id; value.queue.items[0]!.local!.asset_id = item(1).asset.id; return value } },
  { label: '资产修订失配', snapshot: request => { const value = observed(request, 'PAUSED'); value.local!.asset_revision = '9'; value.queue.items[0]!.local!.asset_revision = '9'; return value } },
  { label: 'Core身份失配', snapshot: request => { const value = observed(request, 'PAUSED'); value.local!.target.core_id = '另一个合成Core'; return value } },
  { label: 'Zone身份失配', snapshot: request => { const value = observed(request, 'PAUSED'); value.local!.target.zone_id = '另一个合成Zone'; value.selectedZoneId = value.local!.target.zone_id; return value } },
  { label: '重启后只有另一请求观察', snapshot: () => observed(selection(8), 'PLAYING') },
  { label: '公开快照缺失local叶', snapshot: emptyPlayback },
  { label: 'Paused缺失session epoch', snapshot: request => { const value = observed(request, 'PAUSED'); value.local!.session_epoch = null; return value } },
  { label: 'Paused只有PARTIAL关联', snapshot: request => { const value = observed(request, 'PAUSED'); value.local!.roon_observation.correlation = 'PARTIAL'; return value } },
  { label: 'Paused所有权仍未知', snapshot: request => { const value = observed(request, 'PAUSED'); value.local!.ownership = 'UNKNOWN'; return value } },
  { label: '终止但所有权未释放', snapshot: request => { const value = terminalPlayback(request, 'ENDED'); value.local!.ownership = 'UNKNOWN'; return value } },
  { label: 'accepted后仍等待Roon', snapshot: request => observed(request) },
]
test('MBF001-B：received后缺失、重启或不充分归因的观察矩阵均不能解除原意图', async t => {
  let nextId = 700
  const uuid = t.mock.method(globalThis.crypto, 'randomUUID', () => id(nextId++) as ReturnType<Crypto['randomUUID']>)
  for (const entry of insufficientObservations) {
    const f = recoveryChain(t), original = await f.begin(), beforeIds = uuid.mock.callCount()
    f.setSnapshot(entry.snapshot(original)); await f.model.readOriginalPlay()
    assert.equal(f.model.lastPlay.value?.outcome, 'received', entry.label)
    await f.model.playTrack(item(1).track.id)
    assert.equal(uuid.mock.callCount(), beforeIds, entry.label); assert.deepEqual(f.prepared, [original], entry.label)
    assert.deepEqual(f.submissions, [original], entry.label); assert.deepEqual(f.queries, [original], entry.label)
    assert.deepEqual(f.model.lastPlay.value?.request, original, entry.label)
    assert.deepEqual(f.playback.forbidden, [], entry.label)
    f.model.dispose(); f.playback.model.dispose()
  }
})

for (const attribution of ['absent', 'null'] as const) {
  test(`MBF001-B：${attribution === 'absent' ? '无snapshot getter' : 'getter返回null'}时原accepted不能作为归因放行`, async t => {
    const f = recoveryChain(t, attribution), original = await f.begin()
    f.setSnapshot(observed(original, 'PLAYING')); await f.model.readOriginalPlay()
    assert.equal(f.playback.model.playbackState.value?.local?.phase, 'PLAYING')
    await f.model.playTrack(item(1).track.id)
    assert.deepEqual(f.prepared, [original]); assert.deepEqual(f.submissions, [original])
    assert.deepEqual(f.model.lastPlay.value?.request, original)
  })
}

test('MBF001-B：直接Store PLAY_NOW入口也在UNKNOWN观察前阻断，不靠页面latch兜底', async t => {
  const f = recoveryChain(t), original = await f.begin()
  await f.model.readOriginalPlay()
  await assert.rejects(f.playback.model.playLocalLibrarySelection(selection(1)), /未确认|未知|尚未/u)
  assert.deepEqual(f.prepared, [original]); assert.deepEqual(f.submissions, [original])
  assert.equal(f.playback.model.playbackStartPending.value, false); assert.deepEqual(f.playback.forbidden, [])
})

for (const conclusion of ['unsupported', 'rejected'] as const) {
  test(`MBF001-B：原回执${conclusion}且Core已空闲可安全解除意图，后续明确点播正常派发`, async t => {
    const f = recoveryChain(t), original = await f.begin()
    f.setReceipt(request => conclusion === 'unsupported'
      ? { status: 'received', request_id: request.request_id, action: request.action, result: { status: 'unsupported', reason: 'LOCAL_PLAYBACK_PROTOCOL_UNSUPPORTED' } }
      : { status: 'rejected', request_id: request.request_id, action: request.action, reason: 'REQUEST_REJECTED' })
    f.setSnapshot(emptyPlayback()); await f.model.readOriginalPlay()
    assert.deepEqual(f.model.lastPlay.value?.request, original)
    if (conclusion === 'unsupported') assert.equal(f.model.lastPlay.value?.result?.status, 'unsupported')
    else assert.equal(f.model.lastPlay.value?.outcome, 'rejected')
    await f.model.playTrack(item(1).track.id)
    assert.equal(f.prepared.length, 2); assert.equal(f.submissions.length, 2)
    assert.equal(f.prepared[1]!.local_track_id, item(1).track.id); assert.deepEqual(f.playback.forbidden, [])
  })
}

for (const action of ['APPEND_MB_QUEUE', 'PLAY_NEXT_MB_QUEUE'] as const) {
  test(`MBF001-B：原${action}的accepted回执不等待Roon Playing，允许后续明确点播`, async t => {
    const f = recoveryChain(t), original = await f.begin(action)
    await f.model.readOriginalPlay()
    assert.deepEqual(f.queries, [original]); assert.equal(f.model.lastPlay.value?.result?.status, 'accepted')
    assert.equal(f.playback.model.playbackState.value?.local, undefined)
    await f.model.playTrack(item(1).track.id)
    assert.equal(f.prepared.length, 2); assert.equal(f.prepared[1]!.action, 'PLAY_NOW')
    assert.equal(f.prepared[1]!.local_track_id, item(1).track.id); assert.deepEqual(f.playback.forbidden, [])
  })
}

// 真实LocalLibraryView模板在合成Host中挂载；无关子组件为空壳，不调用扫描、App或文件服务。
interface Host {
  type: string; tagName: string; text: string; props: Record<string, any>; children: Host[]; parent: Host | null
  value: unknown; checked: boolean; listeners: Record<string, (event: any) => void>; style: Record<string, string>
  focus(): void; addEventListener(name: string, listener: (event: any) => void): void; removeEventListener(name: string): void
}
async function mountLibraryView(t: TestContext, model: ReturnType<typeof useLocalLibrary>) {
  const require = createRequire(import.meta.url), vue = require('vue') as typeof import('vue')
  const document = { activeElement: null as Host | null }
  const previousDocument = globalThis.document
  Object.assign(globalThis, { document })
  t.after(() => { if (previousDocument === undefined) delete (globalThis as any).document; else Object.assign(globalThis, { document: previousDocument }) })
  const node = (type = ''): Host => {
    const el: Host = { type, tagName: type.toUpperCase(), text: '', props: {}, children: [], parent: null, value: '', checked: false,
      listeners: {}, style: {}, focus() { document.activeElement = el },
      addEventListener(name, listener) { el.listeners[name] = listener }, removeEventListener(name) { delete el.listeners[name] } }
    Object.defineProperties(el, { options: { get: () => el.children.filter(child => child.type === 'option') }, multiple: { get: () => !!el.props.multiple } })
    return el
  }
  const filename = fileURLToPath(new URL('../src/renderer/src/components/library/LocalLibraryView.vue', import.meta.url))
  const { descriptor } = parse(readFileSync(filename, 'utf8')), script = compileScript(descriptor, { id: filename })
  const template = compileTemplate({ id: filename, filename, source: descriptor.template!.content, compilerOptions: { bindingMetadata: script.bindings } })
  assert.deepEqual(template.errors, [])
  const imports = (name: string) => {
    if (name === 'vue') return vue
    if (name.endsWith('.vue')) return { default: { render: () => vue.h('span') } }
    if (name.endsWith('/details.js')) return playbackDetails
    return createRequire(path.resolve(filename))(name)
  }
  const compile = (code: string) => ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
  const module = { exports: {} as { default: import('vue').Component } }, rendered = { exports: {} as { render: (...args: any[]) => any } }
  new Function('require', 'module', 'exports', 'document', 'window', compile(script.content))(imports, module, module.exports, document, {})
  new Function('require', 'module', 'exports', compile(template.code))(imports, rendered, rendered.exports)
  const remove = (el: Host) => { if (el.parent) el.parent.children.splice(el.parent.children.indexOf(el), 1); el.parent = null }
  const renderer = vue.createRenderer<Host, Host>({ createElement: node, createText: text => ({ ...node('text'), text }), createComment: () => node('comment'),
    setText: (el, text) => { el.text = text }, setElementText: (el, text) => { el.text = text; el.children = [] },
    patchProp: (el, key, _old, value) => { el.props[key] = value; if (key === 'value') el.value = value; if (key === 'checked') el.checked = !!value },
    insert: (el, parent, anchor) => { remove(el); el.parent = parent; const index = anchor ? parent.children.indexOf(anchor) : -1; parent.children.splice(index < 0 ? parent.children.length : index, 0, el) },
    remove, parentNode: el => el.parent, nextSibling: el => el.parent?.children[el.parent.children.indexOf(el) + 1] ?? null })
  const host = node('root'), component = { ...module.exports.default, render: rendered.exports.render }
  const app = renderer.createApp({ render: () => vue.h(component, { session: model, playbackState: null }) })
  app.mount(host); t.after(() => app.unmount())
  const all = (el: Host = host): Host[] => [el, ...el.children.flatMap(child => all(child))]
  const text = (el: Host = host): string => el.text + el.children.map(child => text(child)).join('')
  const settle = async () => { for (let i = 0; i < 4; i++) { await flush(); await vue.nextTick() } }
  const button = (label: string) => { const found = all().find(el => el.type === 'button' && text(el) === label); assert.ok(found, `缺少按钮：${label}`); return found }
  const click = async (label: string) => { const el = button(label); if (!el.props.disabled) el.props.onClick?.({ target: el, currentTarget: el, preventDefault() {}, stopPropagation() {} }); await settle() }
  await settle()
  return { text, button, click, settle }
}

test('MBF001-B：真实页面核对按钮发送原查询，处理中禁用，missing后仍阻止再次直送', async t => {
  const waiting = deferred<LocalPlayReceipt>(), reads: LocalPlayRequest[] = []
  const f = librarySession(t, { readPlayReceipt: request => { reads.push(structuredClone(request)); return waiting.promise } })
  const view = await mountLibraryView(t, f.model)
  await f.model.selectTrack(item().track.id); await view.settle(); await view.click('原文件直送')
  assert.equal(f.model.lastPlay.value?.outcome, 'unknown'); assert.match(view.text(), /结果未知/u)
  const original = structuredClone(f.model.lastPlay.value!.request)
  await view.click('核对原点播')
  assert.equal(view.button('核对原点播').props.disabled, true); assert.equal(f.model.actionBusy.value, true)
  await view.click('核对原点播'); await view.click('原文件直送')
  assert.equal(reads.length, 1); assert.equal(f.sends.length, 1)
  waiting.resolve(unsettled('missing', original)); await view.settle()
  assert.equal(view.button('核对原点播').props.disabled, false)
  assert.equal(f.model.lastPlay.value?.outcome, 'unknown'); assert.match(view.text(), /没有原提交的回执.*不会重发/u)
  await view.click('原文件直送')
  assert.equal(f.sends.length, 1); assert.deepEqual(reads, [original]); assert.doesNotMatch(view.text(), /Roon 已确认播放/u)
})

test('MBF001-B：真实页面核对原拒绝显示目标失败，保留原请求且不显示Playing', async t => {
  const f = librarySession(t, { readPlayReceipt: async request => ({ status: 'rejected', request_id: request.request_id, action: request.action, reason: 'TARGET_UNAVAILABLE' }) })
  const view = await mountLibraryView(t, f.model)
  await f.model.selectTrack(item().track.id); await view.settle(); await view.click('原文件直送')
  const request = structuredClone(f.model.lastPlay.value!.request)
  await view.click('核对原点播')
  assert.match(view.text(), /Roon 播放目标不可用/u); assert.match(view.text(), /原点播请求已失败/u)
  assert.doesNotMatch(view.text(), /Roon 已确认播放/u); assert.equal(f.model.lastPlay.value?.failure, 'TARGET_UNAVAILABLE')
  assert.deepEqual(f.model.lastPlay.value?.request, request); assert.equal(f.sends.length, 1)
})
