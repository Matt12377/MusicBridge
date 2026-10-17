import assert from 'node:assert/strict'
import test from 'node:test'
import type { LocalLyricsCommand, LocalLyricsCommandPayloads, LocalLyricsCommandResults, LocalLyricsSession, LocalLyricsScope, LocalLyricsSaveReceipt, LocalLyricsCandidate } from '@music-bridge/contracts'
import { useLocalWorkbenchLyrics, type LocalLyricsRendererApi } from '../src/renderer/src/composables/application/local-library-workbench/lyrics.js'
const scope: LocalLyricsScope = { datasetId: 'dataset-a', libraryId: 'library-a', albumId: 'album-a', captureId: 'capture-a' }
const library = { datasetId: scope.datasetId, libraryId: scope.libraryId, captureId: 'library-capture' }
const candidate: LocalLyricsCandidate = { candidateId: 'candidate-a', trackId: 'track-a', source: 'netease', title: '合成曲目', artist: '合成艺人', album: '合成专辑', durationMs: 120000, language: '中文', version: 'original', score: 95 }
const session = (target = scope, selected = false): LocalLyricsSession => ({ sessionId: 'session-' + target.albumId, scope: target, state: 'ready', candidates: [candidate], tracks: [{ trackId: candidate.trackId, title: candidate.title, presence: 'false', match: 'review', candidateIds: [candidate.candidateId], selectedCandidateId: selected ? candidate.candidateId : null, sources: [{ source: 'netease', state: 'ok' }, { source: 'qq', state: 'failed' }, { source: 'kugou', state: 'ok' }, { source: 'kuwo', state: 'unavailable' }, { source: 'lrclib', state: 'ok' }] }] })
function fixture(run?: (command: LocalLyricsCommand, payload: LocalLyricsCommandPayloads[LocalLyricsCommand]) => Promise<unknown>) {
  const calls: { command: LocalLyricsCommand; payload: unknown }[] = []; let current = session()
  const api: LocalLyricsRendererApi = { async localLibraryLyrics<C extends LocalLyricsCommand>(command: C, payload: LocalLyricsCommandPayloads[C]): Promise<LocalLyricsCommandResults[C]> {
    calls.push({ command, payload: structuredClone(payload) })
    if (run) return await run(command, payload) as LocalLyricsCommandResults[C]
    let value: unknown
    if (command === 'localLyrics.query') current = session((payload as LocalLyricsCommandPayloads['localLyrics.query']).scope)
    if (command === 'localLyrics.select') current = session(current.scope, (payload as LocalLyricsCommandPayloads['localLyrics.select']).candidateId !== null)
    if (command === 'localLyrics.detail') value = { candidate, body: '[00:00.00]合成歌词正文' }
    else value = current
    return value as LocalLyricsCommandResults[C]
  } }
  return { api, calls }
}

test('歌词正文与候选选择零写；真实五来源结果保留，歧义由明确选择解决', async t => {
  const f = fixture(), model = useLocalWorkbenchLyrics({ api: f.api }); t.after(model.dispose)
  model.bind(scope, library); await model.query(); await model.preview(candidate.candidateId); await model.select(candidate.trackId, candidate.candidateId)
  assert.equal(model.detail.value?.body, '[00:00.00]合成歌词正文'); assert.equal(model.selectedCount.value, 1)
  assert.equal(model.session.value?.tracks[0]?.sources.length, 5); assert.equal(model.session.value?.tracks[0]?.sources[1]?.state, 'failed')
  assert.deepEqual(f.calls.map(v => v.command), ['localLyrics.query', 'localLyrics.detail', 'localLyrics.select']); assert.equal(model.pending.value, true)
})
test('歌词save超时保原body和UUID；UNKNOWN只查receipt，null不清锁且不能discard或换专辑', async t => {
  let ids = 0
  const f = fixture(async (command, payload) => {
    if (command === 'localLyrics.save') throw new Error('合成超时')
    if (command === 'localLyrics.receipt') return null
    if (command === 'localLyrics.select') return session(scope, true)
    return session(scope)
  }), model = useLocalWorkbenchLyrics({ api: f.api, makeCommandId: () => 'command-' + ++ids }); t.after(model.dispose)
  model.bind(scope, library); await model.query(); await model.select(candidate.trackId, candidate.candidateId); await model.save(); const original = structuredClone(model.originalSave.value)
  await model.save(); await model.readOriginal(); await model.retryFailed()
  assert.equal(ids, 1); assert.equal(f.calls.filter(v => v.command === 'localLyrics.save').length, 1); assert.equal(f.calls.filter(v => v.command === 'localLyrics.save.retry').length, 0)
  assert.deepEqual(model.originalSave.value, original); assert.equal(model.locked.value, true); assert.equal(await model.discard(), false)
  assert.equal(model.bind({ ...scope, albumId: 'album-b' }, library), false); assert.equal(model.scope.value?.albumId, scope.albumId)
})
test('迟到歌词正文不覆盖新album捕获，候选不被绑定到新track', async t => {
  let resolve!: (v: unknown) => void
  const held = new Promise<unknown>(r => { resolve = r })
  const f = fixture(async (command, payload) => command === 'localLyrics.detail' ? held : session((payload as LocalLyricsCommandPayloads['localLyrics.query']).scope)), model = useLocalWorkbenchLyrics({ api: f.api }); t.after(model.dispose)
  model.bind(scope, library); await model.query(); const reading = model.preview(candidate.candidateId)
  model.bind({ ...scope, albumId: 'album-b', captureId: 'capture-b' }, library)
  resolve({ candidate, body: '[00:01.00]旧目标正文' }); await reading
  assert.equal(model.detail.value, null); assert.equal(model.scope.value?.albumId, 'album-b')
})
test('全库start不带page/filter；lost response仅查询原jobId，stop后原断点可恢复', async t => {
  let starting = true
  const f = fixture(async (command, payload) => {
    if (command === 'localLyrics.job.start' && starting) { starting = false; throw new Error('合成返回丢失') }
    return { jobId: 'whole-library-job', library, state: command === 'localLyrics.job.stop' ? 'stopped' : 'running', totalAlbums: 501, processedAlbums: 200, savedAlbums: 190, reviewAlbumIds: ['album-review'], failedAlbumIds: ['album-failed'], unknownAlbumIds: [], sidecars: 190, embedded: 190, inspectionFailures: 0, revision: f.calls.length }
  }), model = useLocalWorkbenchLyrics({ api: f.api, makeCommandId: () => 'whole-library-job' }); t.after(model.dispose)
  model.bind(null, library); model.inventoryFilter.value = 'missingLyrics'; model.inventoryOffset.value = 400
  await model.startBatch(); await model.startBatch(); await model.batchAction('read'); await model.batchAction('stop'); await model.batchAction('resume')
  assert.equal(f.calls.filter(v => v.command === 'localLyrics.job.start').length, 1)
  assert.deepEqual(f.calls[0]?.payload, { commandId: 'whole-library-job', library, embed: true })
  assert.deepEqual(f.calls[1]?.payload, { jobId: 'whole-library-job' }); assert.equal(model.job.value?.totalAlbums, 501); assert.equal(model.job.value?.state, 'running')
})
test('LRC成功与embed失败分开；原snapshot.retry零query零重写，已失败embed仅同id显式恢复', async t => {
  const receipt = (snapshot: LocalLyricsSaveReceipt['snapshot'], embed: 'failed' | 'saved'): LocalLyricsSaveReceipt => ({ commandId: 'save-a', sessionId: session().sessionId, state: embed === 'failed' ? 'partial' : 'complete', cover: 'saved', tracks: [{ trackId: candidate.trackId, lrc: 'saved', embed }], snapshot })
  const f = fixture(async command => command === 'localLyrics.save' ? receipt('failed', 'failed') : command === 'localLyrics.snapshot.retry' ? receipt('saved', 'failed') : command === 'localLyrics.save.retry' ? receipt('saved', 'saved') : session(scope, command === 'localLyrics.select'))
  const model = useLocalWorkbenchLyrics({ api: f.api, makeCommandId: () => 'save-a' }); t.after(model.dispose)
  model.bind(scope, library); await model.query(); await model.select(candidate.trackId, candidate.candidateId); assert.equal(await model.save(), false)
  await model.retrySnapshot(); assert.equal(model.receipt.value?.tracks[0]?.lrc, 'saved'); assert.equal(model.pending.value, true)
  await model.retryFailed(); assert.equal(model.receipt.value?.state, 'complete'); assert.equal(model.pending.value, false)
  assert.equal(f.calls.filter(v => v.command === 'localLyrics.query').length, 1); assert.equal(f.calls.filter(v => v.command === 'localLyrics.save').length, 1)
  for (const call of f.calls.filter(v => v.command.endsWith('.retry'))) assert.deepEqual(call.payload, { sessionId: session().sessionId, commandId: 'save-a' })
})

test('冷恢复保留两个原保存pair与embed；UNKNOWN查询null不清锁且不重发save或discard', async t => {
  const originals = [false, true].map((embed, index) => ({ request: { sessionId: 'original-session-' + index, commandId: 'original-save-' + index, embed }, receipt: { sessionId: 'original-session-' + index, commandId: 'original-save-' + index, state: 'unknown' as const, cover: 'unknown' as const, tracks: [], snapshot: 'not-requested' as const } }))
  let ids = 0
  const f = fixture(async command => command === 'localLyrics.receipt' ? null : { ...session(), pendingOperations: originals })
  const model = useLocalWorkbenchLyrics({ api: f.api, makeCommandId: () => 'new-' + ++ids }); t.after(model.dispose)
  model.bind(scope, library); await model.query(); await model.save(); await model.readOriginal(); await model.retryFailed()
  assert.equal(await model.discard(), false); assert.equal(ids, 0)
  assert.deepEqual(model.saveOperations.value.map(row => row.request), originals.map(row => row.request))
  assert.equal(model.pending.value, true); assert.equal(model.locked.value, true)
  assert.deepEqual(f.calls.filter(row => row.command === 'localLyrics.receipt').map(row => row.payload), [0, 1, 0, 1].map(index => ({ sessionId: 'original-session-' + index, commandId: 'original-save-' + index })))
  assert.equal(f.calls.filter(row => ['localLyrics.save', 'localLyrics.save.retry', 'localLyrics.discard'].includes(row.command)).length, 0)
  model.selectOriginal('original-save-1'); assert.equal(model.embed.value, true); assert.equal(model.originalSave.value?.sessionId, 'original-session-1')
})

test('丢弃待选歌词等待真实Owner停止确认；失败不清选择，已确认partial先丢原pair再丢draft', async t => {
  let rejectDiscard = true
  const original = { sessionId: 'old-session-a', commandId: 'old-save-a', embed: false }
  const partial: LocalLyricsSaveReceipt = { commandId: original.commandId, sessionId: original.sessionId, state: 'partial', cover: 'saved', tracks: [{ trackId: candidate.trackId, lrc: 'saved', embed: 'failed' }], snapshot: 'saved' }
  const f = fixture(async (command, payload) => {
    if (command === 'localLyrics.discard') {
      if (rejectDiscard) throw new Error('合成physical尚未关闭')
      return 'commandId' in payload ? partial : { ...session(), state: 'cancelled', tracks: session().tracks.map(row => ({ ...row, selectedCandidateId: null })), pendingOperations: [] }
    }
    return { ...session(scope, true), pendingOperations: [{ request: original, receipt: partial }] }
  }), model = useLocalWorkbenchLyrics({ api: f.api }); t.after(model.dispose)
  model.bind(scope, library); await model.query(); assert.equal(await model.discard(), false)
  assert.equal(model.pending.value, true); assert.deepEqual(model.originalSave.value, original); assert.equal(model.selectedCount.value, 1)
  rejectDiscard = false; assert.equal(await model.discard(), true); assert.equal(model.pending.value, false); assert.equal(model.session.value, null)
  assert.deepEqual(f.calls.filter(row => row.command === 'localLyrics.discard').map(row => row.payload), [{ sessionId: 'old-session-a', commandId: 'old-save-a' }, { sessionId: 'old-session-a', commandId: 'old-save-a' }, { sessionId: session().sessionId }])
  assert.equal(f.calls.filter(row => ['localLyrics.save', 'localLyrics.save.retry', 'localLyrics.snapshot.retry'].includes(row.command)).length, 0)
})

test('已写LRC的快照失败不当全部保存；仅snapshot.retry成功后共同门禁才能离开', async t => {
  const original = { sessionId: 'snapshot-session', commandId: 'snapshot-save', embed: false }
  const result = (snapshot: LocalLyricsSaveReceipt['snapshot']): LocalLyricsSaveReceipt => ({ commandId: original.commandId, sessionId: original.sessionId, state: 'complete', cover: 'not-requested', tracks: [{ trackId: candidate.trackId, lrc: 'saved', embed: 'not-requested' }], snapshot })
  const f = fixture(async command => command === 'localLyrics.snapshot.retry' ? result('saved') : { ...session(), pendingOperations: [{ request: original, receipt: result('failed') }] })
  const model = useLocalWorkbenchLyrics({ api: f.api }); t.after(model.dispose); model.bind(scope, library); await model.query()
  assert.equal(model.pending.value, true); assert.equal(model.locked.value, false)
  await model.retrySnapshot(); assert.equal(model.pending.value, false)
  assert.deepEqual(f.calls.filter(row => row.command !== 'localLyrics.query'), [{ command: 'localLyrics.snapshot.retry', payload: { sessionId: original.sessionId, commandId: original.commandId } }])
})

function stageTwoLyricsHeld<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void
  const promise = new Promise<T>((done, failed) => { resolve = done; reject = failed })
  return { promise, resolve, reject }
}
const stageTwoJob = (commandId: string, target = library, state: import('@music-bridge/contracts').LocalLyricsJobSnapshot['state'] = 'partial', revision = 1): import('@music-bridge/contracts').LocalLyricsJobSnapshot => ({
  jobId: commandId, library: target, state, totalAlbums: 2, processedAlbums: 2, savedAlbums: 1,
  reviewAlbumIds: [], failedAlbumIds: ['album-failed'], unknownAlbumIds: [], sidecars: 1, embedded: 0, inspectionFailures: 1, revision,
})
const stageTwoInventory = (filter: 'all' | 'missingLyrics', offset: number): import('@music-bridge/contracts').LocalLyricsInventoryPage => ({
  total: 201, offset, watermark: 'inventory-' + filter,
  rows: Array.from({ length: Math.min(200, 201 - offset) }, (_, index) => ({ albumId: 'inventory-album-' + (offset + index), presence: filter === 'missingLyrics' ? 'false' as const : 'true' as const })),
})

test('已知失败歌词批次实际stop确认后显式新批可选另一库，历史保原body且只查询旧job', async t => {
  for (const terminal of ['partial', 'failed'] as const) {
    const other = { ...library, libraryId: 'library-b', captureId: 'library-capture-b' }
    let ids = 0, revision = 0
    const f = fixture(async (command, payload) => {
      if (command === 'localLyrics.job.start') { const p = payload as LocalLyricsCommandPayloads['localLyrics.job.start']; return stageTwoJob(p.commandId, p.library, terminal, ++revision) }
      if (command === 'localLyrics.job.stop' || command === 'localLyrics.job.read') return stageTwoJob('stage-two-job-1', library, terminal === 'partial' ? 'partial' : 'stopped', ++revision)
      throw new Error('合成测试没有授权其他操作')
    }), model = useLocalWorkbenchLyrics({ api: f.api, makeCommandId: () => 'stage-two-job-' + ++ids }); t.after(model.dispose)
    const freshOriginal = (): import('@music-bridge/contracts').LocalLyricsJobStartRequest | null => model.originalJob.value
    model.bind(null, library); model.setLibraries([library, other]); await model.startBatch()
    const original = structuredClone(model.originalJob.value), originalState = structuredClone(model.job.value)
    assert.equal(await model.discard(), true); assert.deepEqual(model.originalJob.value, original)
    model.newBatch(); assert.equal(model.originalJob.value, null); assert.equal(model.job.value, null)
    const history = Reflect.get(model, 'jobHistory') as { value: readonly { request: unknown; snapshot: unknown }[] }
    assert.deepEqual(history.value[0]?.request, original); assert.notDeepEqual(history.value[0]?.snapshot, originalState)
    model.chooseLibrary(other.libraryId); await model.startBatch()
    assert.equal(ids, 2); assert.equal(freshOriginal()?.library.libraryId, other.libraryId)
    const current = structuredClone(model.originalJob.value), readHistory = Reflect.get(model, 'readJobHistory') as (commandId: string) => Promise<void>
    assert.equal(typeof readHistory, 'function'); await readHistory('stage-two-job-1')
    assert.deepEqual(model.originalJob.value, current); assert.deepEqual(history.value[0]?.request, original)
    assert.deepEqual(f.calls.filter(row => row.command === 'localLyrics.job.read').map(row => row.payload), [{ jobId: 'stage-two-job-1' }])
    assert.equal(f.calls.filter(row => row.command === 'localLyrics.job.stop').length, 1)
  }
})

test('歌词stop失败或返回unknown queued running及未知单项不能清旧ID或开始另一批', async t => {
  for (const outcome of ['throw', 'unknown', 'queued', 'running', 'unknown-item'] as const) {
    let ids = 0
    const f = fixture(async (command, payload) => {
      if (command === 'localLyrics.job.start') return stageTwoJob((payload as LocalLyricsCommandPayloads['localLyrics.job.start']).commandId)
      if (command === 'localLyrics.job.stop') {
        if (outcome === 'throw') throw new Error('合成停止结果丢失')
        const next = stageTwoJob('protected-job-1', library, outcome === 'unknown-item' ? 'partial' : outcome, 2)
        return outcome === 'unknown-item' ? { ...next, failedAlbumIds: [], unknownAlbumIds: ['album-unknown'] } : next
      }
      throw new Error('合成测试没有授权其他操作')
    }), model = useLocalWorkbenchLyrics({ api: f.api, makeCommandId: () => 'protected-job-' + ++ids }); t.after(model.dispose)
    model.bind(null, library); model.setLibraries([library, { ...library, libraryId: 'library-b', captureId: 'capture-b' }]); await model.startBatch()
    const original = structuredClone(model.originalJob.value)
    assert.equal(await model.discard(), false); model.newBatch(); model.chooseLibrary('library-b'); await model.startBatch()
    assert.deepEqual(model.originalJob.value, original); assert.equal(ids, 1); assert.equal(model.pending.value, true)
    assert.equal(model.library.value?.libraryId, library.libraryId)
    assert.deepEqual(Reflect.get(model, 'jobHistory')?.value ?? [], [])
  }
})

test('同scope歌词库存all与missing反序返回只保最后filter和offset，迟到旧成功零覆盖', async t => {
  const all = stageTwoLyricsHeld<import('@music-bridge/contracts').LocalLyricsInventoryPage>(), missing = stageTwoLyricsHeld<import('@music-bridge/contracts').LocalLyricsInventoryPage>()
  const f = fixture(async (command, payload) => {
    assert.equal(command, 'localLyrics.inventory')
    return (payload as LocalLyricsCommandPayloads['localLyrics.inventory']).filter === 'all' ? all.promise : missing.promise
  }), model = useLocalWorkbenchLyrics({ api: f.api }); t.after(model.dispose); model.bind(scope, library)
  const first = model.readInventory('all', 0), last = model.readInventory('missingLyrics', 200), expected = stageTwoInventory('missingLyrics', 200)
  missing.resolve(expected); await last; all.resolve(stageTwoInventory('all', 0)); await first
  assert.deepEqual(model.inventory.value, expected); assert.equal(model.inventoryFilter.value, 'missingLyrics'); assert.equal(model.inventoryOffset.value, 200)
})

test('库存最后意图成功后旧失败不改错误或已显示结果', async t => {
  const old = stageTwoLyricsHeld<import('@music-bridge/contracts').LocalLyricsInventoryPage>()
  const f = fixture(async (_command, payload) => (payload as LocalLyricsCommandPayloads['localLyrics.inventory']).filter === 'all' ? old.promise : stageTwoInventory('missingLyrics', 0))
  const model = useLocalWorkbenchLyrics({ api: f.api }); t.after(model.dispose); model.bind(scope, library)
  const first = model.readInventory('all', 0); await model.readInventory('missingLyrics', 0)
  old.reject(new Error('合成旧库存失败')); await first
  assert.equal(model.error.value, ''); assert.equal(model.inventoryFilter.value, 'missingLyrics')
  assert.deepEqual(model.inventory.value, stageTwoInventory('missingLyrics', 0))
})

test('库存bind 选库 捕获集合ABA及dispose均隔离旧读取，不因回到同库接受旧回复', async t => {
  for (const invalidation of ['bind', 'choose', 'libraries', 'scope', 'dispose'] as const) {
    const held = stageTwoLyricsHeld<import('@music-bridge/contracts').LocalLyricsInventoryPage>(), other = { ...library, libraryId: 'library-b', captureId: 'library-capture-b' }
    const f = fixture(async () => held.promise), model = useLocalWorkbenchLyrics({ api: f.api }); t.after(model.dispose)
    model.bind(scope, library); model.setLibraries([library, other]); const reading = model.readInventory('all', 0)
    if (invalidation === 'bind') { model.bind(scope, other); model.bind(scope, library) }
    else if (invalidation === 'choose') { model.chooseLibrary(other.libraryId); model.chooseLibrary(library.libraryId) }
    else if (invalidation === 'libraries') { model.setLibraries([other]); model.setLibraries([library]) }
    else if (invalidation === 'scope') { model.bind({ ...scope, albumId: 'album-b', captureId: 'capture-b' }, library); model.bind(scope, library) }
    else model.dispose()
    held.resolve(stageTwoInventory('all', 0)); await reading
    assert.equal(model.inventory.value, null); assert.equal(model.error.value, '')
  }
})


import type { LocalWorkbenchLyricsResultKey, LocalWorkbenchOriginalLyricsEntry } from '../src/renderer/src/composables/application/local-library-workbench/types.js'
const stageFourKey = (category: LocalWorkbenchLyricsResultKey['category'] = 'unknown', revision = 4): LocalWorkbenchLyricsResultKey => ({
  jobId: 'inspect-job', jobRevision: revision, library: { ...library }, albumId: 'album-' + category, category,
})
const stageFourScope = (key = stageFourKey()): LocalLyricsScope => ({ ...scope, albumId: key.albumId, captureId: 'original-album-capture-' + key.albumId })
const stageFourOriginal = (key = stageFourKey()): LocalWorkbenchOriginalLyricsEntry => ({ scope: stageFourScope(key), sessionId: 'original-' + key.albumId,
  saveRequest: { sessionId: 'original-' + key.albumId, commandId: 'original-save-' + key.albumId, embed: false } })
const stageFourReceipt = (key = stageFourKey(), state: LocalLyricsSaveReceipt['state'] = 'unknown'): LocalLyricsSaveReceipt => ({
  ...stageFourOriginal(key).saveRequest!, state, cover: 'not-requested', tracks: [{ trackId: candidate.trackId, lrc: state === 'complete' ? 'saved' : 'unknown', embed: 'not-requested' }], snapshot: 'not-requested',
})
const stageFourSession = (key = stageFourKey()): LocalLyricsSession => ({ ...session(stageFourScope(key)), sessionId: stageFourOriginal(key).sessionId!,
  pendingOperations: [{ request: stageFourOriginal(key).saveRequest!, receipt: stageFourReceipt(key) }],
})
const stageFourJob = (revision = 4): import('@music-bridge/contracts').LocalLyricsJobSnapshot => ({
  jobId: 'inspect-job', library: { ...library }, state: 'unknown', totalAlbums: 3, processedAlbums: 3, savedAlbums: 0,
  reviewAlbumIds: ['album-review'], failedAlbumIds: ['album-failed'], unknownAlbumIds: ['album-unknown'], sidecars: 0, embedded: 0, inspectionFailures: 0, revision,
})
const stageFourCurrent = (m: ReturnType<typeof useLocalWorkbenchLyrics>) => ({
  scope: structuredClone(m.scope.value), library: structuredClone(m.library.value), session: structuredClone(m.session.value), detail: structuredClone(m.detail.value),
  job: structuredClone(m.job.value), originalJob: structuredClone(m.originalJob.value), operations: structuredClone(m.saveOperations.value), originalSave: structuredClone(m.originalSave.value),
  receipt: structuredClone(m.receipt.value), embed: m.embed.value, pending: m.pending.value, locked: m.locked.value, error: m.error.value,
})

/** inspection 仅使用作者安全定位的原Entry，禁止新查询取得另一个session。 */
test('原批次UNKNOWN独立读取原session和pair，不接管当前歌词、pending或原job', async t => {
  const key = stageFourKey(), original = stageFourOriginal(key)
  const f = fixture(async (command, payload) => {
    if (command === 'localLyrics.job.start') return stageFourJob()
    if (command === 'localLyrics.session.read') { assert.deepEqual(payload, { sessionId: original.sessionId }); return stageFourSession(key) }
    if (command === 'localLyrics.receipt') return stageFourReceipt(key)
    throw new Error('合成inspection禁止其他命令')
  }), m = useLocalWorkbenchLyrics({ api: f.api, makeCommandId: () => 'inspect-job' }); t.after(m.dispose)
  m.bind(scope, library); await m.startBatch(); const before = stageFourCurrent(m), callStart = f.calls.length
  assert.equal(typeof m.inspectOriginalResult, 'function', '缺少独立原结果读取')
  await m.inspectOriginalResult(key, original)
  const inspected = m.resultInspection.value; assert.ok(inspected); assert.equal(inspected.session?.sessionId, original.sessionId)
  assert.deepEqual(inspected.originalEntry, original); assert.deepEqual(inspected.operations.map(row => row.request), [original.saveRequest])
  assert.deepEqual(stageFourCurrent(m), before); assert.equal(m.pending.value, true); assert.equal(m.locked.value, true)
  assert.ok(f.calls.slice(callStart).every(row => ['localLyrics.session.read', 'localLyrics.receipt'].includes(row.command)))
  m.closeResultInspection(); assert.equal(m.resultInspection.value, null); assert.deepEqual(stageFourCurrent(m), before)
})

test('原结果无定位port保真实key并明确未接入，零query/session/read写入', async t => {
  const f = fixture(async command => { if (command === 'localLyrics.job.start') return stageFourJob(); throw new Error('不得请求原定位替代命令') })
  const m = useLocalWorkbenchLyrics({ api: f.api, makeCommandId: () => 'inspect-job' }); t.after(m.dispose); m.bind(null, library); await m.startBatch()
  const before = stageFourCurrent(m), calls = f.calls.length
  assert.equal(typeof m.inspectOriginalResult, 'function'); await m.inspectOriginalResult(stageFourKey())
  assert.deepEqual(m.resultInspection.value?.key, stageFourKey()); assert.notEqual(m.resultInspection.value?.phase, 'ready')
  assert.ok(m.resultInspection.value?.error); assert.equal(f.calls.length, calls); assert.deepEqual(stageFourCurrent(m), before)
})

test('原结果拒绝错job/revision/library/类别成员和非原scope，不能读取新session', async t => {
  const f = fixture(async command => { if (command === 'localLyrics.job.start') return stageFourJob(); throw new Error('错身份不应送Owner') })
  const m = useLocalWorkbenchLyrics({ api: f.api, makeCommandId: () => 'inspect-job' }); t.after(m.dispose); m.bind(null, library); await m.startBatch()
  const keys: LocalWorkbenchLyricsResultKey[] = [
    { ...stageFourKey(), jobId: 'another-job' }, { ...stageFourKey(), jobRevision: 3 },
    { ...stageFourKey(), library: { ...library, captureId: 'new-library-capture' } },
    { ...stageFourKey(), category: 'failed' }, { ...stageFourKey(), albumId: 'not-in-original-job' },
  ]
  const before = stageFourCurrent(m), calls = f.calls.length
  assert.equal(typeof m.inspectOriginalResult, 'function')
  for (const key of keys) await m.inspectOriginalResult(key, stageFourOriginal(key))
  await m.inspectOriginalResult(stageFourKey(), { ...stageFourOriginal(), scope: { ...stageFourScope(), datasetId: 'another-dataset' } })
  assert.equal(f.calls.length, calls); assert.deepEqual(stageFourCurrent(m), before)
  assert.notEqual(m.resultInspection.value?.phase, 'ready')
})

test('原session NOT_FOUND仍保原saveRequest；receipt null单独显示且不解当前UNKNOWN', async t => {
  const key = stageFourKey(), original = stageFourOriginal(key)
  const f = fixture(async command => {
    if (command === 'localLyrics.job.start') return stageFourJob()
    if (command === 'localLyrics.session.read') throw Object.assign(new Error('原session不存在'), { code: 'NOT_FOUND' })
    if (command === 'localLyrics.receipt') return null
    throw new Error('合成冷读禁止其他命令')
  }), m = useLocalWorkbenchLyrics({ api: f.api, makeCommandId: () => 'inspect-job' }); t.after(m.dispose); m.bind(null, library); await m.startBatch()
  const before = stageFourCurrent(m); assert.equal(typeof m.inspectOriginalResult, 'function')
  await m.inspectOriginalResult(key, original); await m.readResultReceipt(original.saveRequest!.commandId)
  const inspected = m.resultInspection.value; assert.ok(inspected); assert.equal(inspected.session, null); assert.equal(inspected.sessionPhase, 'not-found')
  assert.deepEqual(inspected.originalEntry, original); assert.ok(inspected.operations.some(row => row.request.commandId === original.saveRequest!.commandId && row.receipt === null))
  assert.deepEqual(f.calls.filter(row => row.command === 'localLyrics.receipt').map(row => row.payload), f.calls.filter(row => row.command === 'localLyrics.receipt').map(() => ({ sessionId: original.sessionId, commandId: original.saveRequest!.commandId })))
  assert.ok(f.calls.some(row => row.command === 'localLyrics.receipt')); assert.deepEqual(stageFourCurrent(m), before)
})

test('inspection迟到成功和失败在关闭、库捕获ABA、dispose后均零覆盖', async t => {
  for (const action of ['close', 'library-aba', 'dispose'] as const) for (const failed of [false, true]) {
    const held = stageTwoLyricsHeld<unknown>()
    const f = fixture(async command => command === 'localLyrics.job.start' ? stageFourJob() : command === 'localLyrics.session.read' ? held.promise : command === 'localLyrics.receipt' ? null : Promise.reject(new Error('禁止其他命令')))
    const m = useLocalWorkbenchLyrics({ api: f.api, makeCommandId: () => 'inspect-job' }); t.after(m.dispose); m.bind(null, library); await m.startBatch()
    assert.equal(typeof m.inspectOriginalResult, 'function'); const reading = m.inspectOriginalResult(stageFourKey(), stageFourOriginal())
    if (action === 'library-aba') { m.setLibraries([{ ...library, captureId: 'capture-b' }]); m.setLibraries([library]) }
    else if (action === 'dispose') m.dispose()
    else m.closeResultInspection()
    const before = structuredClone(m.resultInspection.value), current = stageFourCurrent(m)
    if (failed) held.reject(new Error('迟到合成失败')); else held.resolve(stageFourSession())
    await reading; assert.deepEqual(m.resultInspection.value, before); assert.deepEqual(stageFourCurrent(m), current)
  }
})

test('inspection A-B-A独立序号拒绝旧同key成功及旧失败', async t => {
  const held = [stageTwoLyricsHeld<unknown>(), stageTwoLyricsHeld<unknown>(), stageTwoLyricsHeld<unknown>()]; let reads = 0
  const f = fixture(async command => command === 'localLyrics.job.start' ? stageFourJob() : command === 'localLyrics.session.read' ? held[reads++]!.promise : command === 'localLyrics.receipt' ? null : Promise.reject(new Error('禁止其他命令')))
  const m = useLocalWorkbenchLyrics({ api: f.api, makeCommandId: () => 'inspect-job' }); t.after(m.dispose); m.bind(null, library); await m.startBatch()
  assert.equal(typeof m.inspectOriginalResult, 'function'); const a = m.inspectOriginalResult(stageFourKey(), stageFourOriginal())
  const b = m.inspectOriginalResult(stageFourKey('failed'), stageFourOriginal(stageFourKey('failed')))
  const c = m.inspectOriginalResult(stageFourKey(), stageFourOriginal())
  held[2]!.resolve({ ...stageFourSession(), candidates: [{ ...candidate, title: '最新原session内容' }] }); await c
  const latest = structuredClone(m.resultInspection.value)
  held[0]!.resolve(stageFourSession()); held[1]!.reject(new Error('旧B错误')); await Promise.all([a, b])
  assert.deepEqual(m.resultInspection.value, latest); assert.equal(m.resultInspection.value?.session?.candidates[0]?.title, '最新原session内容')
})

test('inspection正文和原receipt只更新独立结果，原pair与embed不借当前上下文', async t => {
  const key = stageFourKey(), original = stageFourOriginal(key)
  const f = fixture(async (command, payload) => {
    if (command === 'localLyrics.job.start') return stageFourJob()
    if (command === 'localLyrics.session.read') return stageFourSession(key)
    if (command === 'localLyrics.detail') { assert.deepEqual(payload, { sessionId: original.sessionId, candidateId: candidate.candidateId }); return { candidate, body: '[00:02.00]仅属于原候选的正文' } }
    if (command === 'localLyrics.receipt') { assert.deepEqual(payload, { sessionId: original.sessionId, commandId: original.saveRequest!.commandId }); return stageFourReceipt(key, 'complete') }
    throw new Error('禁止新查询/选择/保存')
  }), m = useLocalWorkbenchLyrics({ api: f.api, makeCommandId: () => 'inspect-job' }); t.after(m.dispose); m.bind(scope, library); await m.startBatch()
  const before = stageFourCurrent(m); assert.equal(typeof m.inspectOriginalResult, 'function'); await m.inspectOriginalResult(key, original)
  await m.previewResultCandidate(candidate.candidateId); await m.readResultReceipt(original.saveRequest!.commandId)
  assert.equal(m.resultInspection.value?.detail?.body, '[00:02.00]仅属于原候选的正文'); assert.equal(m.resultInspection.value?.operations[0]?.receipt?.state, 'complete')
  assert.deepEqual(m.resultInspection.value?.operations[0]?.request, original.saveRequest); assert.deepEqual(stageFourCurrent(m), before)
  assert.equal(m.embed.value, true); assert.equal(m.resultInspection.value?.operations[0]?.request.embed, false)
  assert.ok(f.calls.every(row => ['localLyrics.job.start', 'localLyrics.session.read', 'localLyrics.detail', 'localLyrics.receipt'].includes(row.command)))
})

test('原条目返回不同capture的session不当ready；原定位迟到与job revision更换不再读取', async t => {
  const located = stageTwoLyricsHeld<LocalWorkbenchOriginalLyricsEntry | null>()
  const f = fixture(async command => command === 'localLyrics.job.start' ? stageFourJob() : command === 'localLyrics.session.read' ? { ...stageFourSession(), scope: { ...stageFourScope(), captureId: 'new-album-capture' } } : command === 'localLyrics.receipt' ? null : Promise.reject(new Error('禁止其他命令')))
  const m = useLocalWorkbenchLyrics({ api: f.api, makeCommandId: () => 'inspect-job', readOriginalResultEntry: () => located.promise }); t.after(m.dispose); m.bind(null, library); await m.startBatch()
  assert.equal(typeof m.inspectOriginalResult, 'function'); await m.inspectOriginalResult(stageFourKey(), stageFourOriginal())
  assert.equal(m.resultInspection.value?.session, null); assert.notEqual(m.resultInspection.value?.sessionPhase, 'ready')
  const calls = f.calls.length, reading = m.inspectOriginalResult(stageFourKey()); m.job.value = stageFourJob(5); located.resolve(stageFourOriginal()); await reading
  assert.equal(f.calls.length, calls); assert.notEqual(m.resultInspection.value?.phase, 'ready')
})
