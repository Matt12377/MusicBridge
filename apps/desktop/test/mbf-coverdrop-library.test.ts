import assert from 'node:assert/strict'
import test from 'node:test'
import type { LocalLibraryManagementCommand, LocalLibraryManagementPayloads, LocalLibraryManagementResults, LocalNameSettingsCommand, LocalNameSettingsPayloads, LocalNameSettingsResults, LocalNameSettings, LocalLibraryManagementReadback } from '@music-bridge/contracts'
import { useLocalWorkbenchLibrary, type LocalLibraryWorkspaceApi } from '../src/renderer/src/composables/application/local-library-workbench/library.js'
const state: LocalLibraryManagementReadback = { datasetId: 'dataset-a', revision: '1', scanConcurrency: 12, libraries: ['library-a', 'library-b'].map(libraryId => ({ libraryId, label: '合成 ' + libraryId, role: 'catalog', online: true, watching: false, latestSnapshotId: 'snapshot-' + libraryId, totalAlbums: 501, totalTracks: 5010, scanState: 'complete' })) }
const settings: LocalNameSettings = { revision: '1', backend: 'ollama', ollama: { endpoint: 'http://127.0.0.1:11434', model: 'synthetic-local' }, vllm: { endpoint: 'http://127.0.0.1:8000/v1', model: 'synthetic-vllm' }, cloud: { endpoint: 'https://example.invalid/v1', model: 'synthetic-cloud', keyConfigured: false } }
function fixture(run?: (command: LocalLibraryManagementCommand, payload: LocalLibraryManagementPayloads[LocalLibraryManagementCommand]) => Promise<unknown>, cancel525?: (request: import('@music-bridge/contracts').LocalLibraryManagementMainPayloads['library.import.cancel']) => Promise<import('@music-bridge/contracts').LocalLibraryManagementMainResults['library.import.cancel']>) {
  const calls: { command: string; payload: unknown }[] = [], saved = new Map<string, string>()
  let current = structuredClone(settings)
  const api: LocalLibraryWorkspaceApi = {
    async localLibraryManagement<C extends import('@music-bridge/contracts').LocalLibraryManagementMainCommand>(command: C, payload: import('@music-bridge/contracts').LocalLibraryManagementMainPayloads[C]): Promise<import('@music-bridge/contracts').LocalLibraryManagementMainResults[C]> {
      calls.push({ command, payload: structuredClone(payload) })
      if (command === 'library.import.cancel') { const request = payload as import('@music-bridge/contracts').LocalLibraryManagementMainPayloads['library.import.cancel']; return (cancel525 ? await cancel525(request) : { choiceId: request.choiceId, released: true }) as import('@music-bridge/contracts').LocalLibraryManagementMainResults[C] }
      if (run) return await run(command as LocalLibraryManagementCommand, payload as LocalLibraryManagementPayloads[LocalLibraryManagementCommand]) as import('@music-bridge/contracts').LocalLibraryManagementMainResults[C]
      let value: unknown
      if (command === 'library.read') value = state
      else if (command === 'library.import.prepare') value = { choiceId: 'choice-a', label: '合成文件夹', suggestedRole: 'container', evidence: ['多个专辑目录'] }
      else if (command === 'library.capture') value = { datasetId: state.datasetId, captureId: 'complete-capture', libraryIds: (payload as LocalLibraryManagementPayloads['library.capture']).libraryIds, revision: state.revision, lyricsLibraries: [] }
      else value = { commandId: (payload as { commandId: string }).commandId, kind: command, state: 'succeeded', libraryIds: ['library-a'], message: null }
      return value as import('@music-bridge/contracts').LocalLibraryManagementMainResults[C]
    },
    async localNameSettings<C extends LocalNameSettingsCommand>(command: C, payload: LocalNameSettingsPayloads[C]): Promise<LocalNameSettingsResults[C]> {
      calls.push({ command, payload: structuredClone(payload) })
      let value: unknown
      if (command === 'name.settings.save') { const next = (payload as LocalNameSettingsPayloads['name.settings.save']).settings; current = { ...next, revision: '2', cloud: { ...next.cloud, keyConfigured: current.cloud.keyConfigured } }; delete (current as unknown as Record<string, unknown>).expectedRevision }
      if (command === 'name.settings.securityPrompt') { current.cloud.keyConfigured = true; value = { configured: true, cancelled: false } } else value = current
      return value as LocalNameSettingsResults[C]
    },
  }
  return { api, calls, storage: { getItem: (key: string) => saved.get(key) ?? null, setItem: (key: string, value: string) => { saved.set(key, value) } } }
}

test('库角色确认显式写入，多库选择按实际dataset持久回读而不改源目录', async t => {
  const f = fixture(), model = useLocalWorkbenchLibrary({ api: f.api, storage: f.storage, makeCommandId: () => 'import-a' }); t.after(model.dispose)
  await model.read(); model.selectLibrary('library-a', true); model.selectLibrary('library-b', true)
  await model.prepareImport(); assert.equal(f.calls.some(v => v.command === 'library.import.confirm'), false); assert.equal(model.role.value, 'container')
  model.role.value = 'album'; await model.confirmImport()
  assert.deepEqual(f.calls.find(v => v.command === 'library.import.confirm')?.payload, { commandId: 'import-a', choiceId: 'choice-a', role: 'album' })
  const cold = useLocalWorkbenchLibrary({ api: f.api, storage: f.storage }); t.after(cold.dispose); await cold.read(); assert.deepEqual(cold.selectedLibraryIds.value, ['library-a', 'library-b'])
})
test('本地清理超时保原明确库集合，UNKNOWN阻新rename和新UUID，仅query原operation', async t => {
  let ids = 0
  const f = fixture(async command => command === 'library.read' ? state : command === 'library.operation.read' ? null : Promise.reject(new Error('合成返回丢失')))
  const model = useLocalWorkbenchLibrary({ api: f.api, makeCommandId: () => `command-${++ids}` }); t.after(model.dispose)
  await model.read(); model.selectLibrary('library-a', true); await model.remove(); const original = structuredClone(model.originals.value[0])
  await model.rename('library-b', '新名字'); await model.remove(); await model.readOriginal('command-1')
  assert.equal(ids, 1); assert.deepEqual(model.originals.value[0], original); assert.equal(model.locked.value, true); assert.equal(await model.discard(), false)
  assert.deepEqual(f.calls.filter(v => v.command !== 'library.read').map(v => v.command), ['library.remove', 'library.operation.read'])
  assert.deepEqual(f.calls.find(v => v.command === 'library.remove')?.payload, { commandId: 'command-1', libraryIds: ['library-a'] })
})
test('原快照失败独立retry只派有限snapshot命令，零重扫或Provider查询', async t => {
  const f = fixture(), model = useLocalWorkbenchLibrary({ api: f.api, makeCommandId: () => 'snapshot-retry' }); t.after(model.dispose)
  await model.read(); await model.snapshot('library-a', 'retry')
  assert.deepEqual(f.calls.filter(v => v.command !== 'library.read'), [{ command: 'library.snapshot.retry', payload: { commandId: 'snapshot-retry', libraryId: 'library-a' } }])
})
test('全库AI先取完整Owner捕获，missing-cover不截501张到UI当前页并保原job读取', async t => {
  const calls: { command: string; payload: unknown }[] = []
  const f = fixture(async (command, payload) => {
    calls.push({ command, payload: structuredClone(payload) })
    if (command === 'library.read') return state
    if (command === 'library.capture') return { datasetId: state.datasetId, captureId: 'complete-capture', libraryIds: ['library-a'], revision: state.revision, lyricsLibraries: [] }
    return { jobId: 'ai-job', captureId: 'complete-capture', kind: 'ai', state: 'running', totalAlbums: 501, processedAlbums: 200, succeededAlbums: 180, failedAlbums: 20, offset: 0, items: [] }
  }), model = useLocalWorkbenchLibrary({ api: f.api, makeCommandId: () => 'ai-job' }); t.after(model.dispose)
  await model.read(); model.selectLibrary('library-a', true); await model.startAi('ollama'); await model.jobAction('read')
  assert.deepEqual(calls.find(v => v.command === 'library.ai.start')?.payload, { commandId: 'ai-job', captureId: 'complete-capture', backend: 'ollama', selection: 'missing-cover', albumIds: [] })
  assert.equal(model.job.value?.totalAlbums, 501); assert.deepEqual(calls.find(v => v.command === 'library.job.read')?.payload, { jobId: 'ai-job', offset: 0, limit: 200 })
})
test('AI配置只传无凭据端点，云端密钥仅调用Main系统安全输入且回读真实配置', async t => {
  const f = fixture(), model = useLocalWorkbenchLibrary({ api: f.api, makeCommandId: () => 'name-config' }); t.after(model.dispose)
  await model.readNameSettings(); const next = model.settingsDraft.value!; model.editName({ ...next, backend: 'vllm', vllm: { ...next.vllm, model: 'synthetic-new' } })
  assert.equal(await model.saveNameSettings(), true); await model.configureCloudKey()
  assert.deepEqual(f.calls.find(v => v.command === 'name.settings.securityPrompt')?.payload, { commandId: 'name-config', backend: 'cloud' })
  assert.equal(model.settings.value?.cloud.keyConfigured, true); assert.equal(model.settings.value?.vllm.model, 'synthetic-new')
  assert.doesNotMatch(JSON.stringify(f.calls), /password|apiKey|token|bearer/iu)
})

test('全库CUE明确all-unsplit不传页面100选项；超时只查原job，完整分页失败集合再恢复', async t => {
  const calls: { command: string; payload: unknown }[] = [], target = { choiceId: 'target-a', label: '合成独立输出', independent: true as const }
  let lost = true
  const f = fixture(async (command, payload) => {
    calls.push({ command, payload: structuredClone(payload) })
    if (command === 'library.read') return state
    if (command === 'library.capture') return { datasetId: state.datasetId, captureId: 'whole-cue-capture', libraryIds: ['library-a'], revision: state.revision, lyricsLibraries: [] }
    if (command === 'library.cue.start' && lost) { lost = false; throw new Error('合成返回丢失') }
    const offset = command === 'library.job.read' ? (payload as LocalLibraryManagementPayloads['library.job.read']).offset : 0
    return { jobId: 'cue-job', captureId: 'whole-cue-capture', kind: 'cue', state: 'partial', totalAlbums: 501, processedAlbums: 501, succeededAlbums: 499, failedAlbums: 2, offset,
      items: Array.from({ length: Math.min(200, 501 - offset) }, (_, index) => { const n = offset + index; return { albumId: 'album-' + n, state: n === 205 || n === 500 ? 'failed' : 'applied', message: null } }) }
  }), model = useLocalWorkbenchLibrary({ api: f.api, makeCommandId: () => 'cue-job' }); t.after(model.dispose)
  await model.read(); model.selectLibrary('library-a', true); await model.startAllCue('flac', target); await model.startAllCue('flac', target)
  await model.jobAction('stop'); assert.equal(calls.some(row => row.command === 'library.job.stop'), false)
  await model.jobAction('read'); await model.retryAllFailed()
  assert.equal(calls.filter(row => row.command === 'library.cue.start').length, 1)
  assert.deepEqual(calls.find(row => row.command === 'library.cue.start')?.payload, { commandId: 'cue-job', captureId: 'whole-cue-capture', selection: 'all-unsplit', selections: [], outputFormat: 'flac', target })
  assert.deepEqual(calls.filter(row => row.command === 'library.job.read').map(row => row.payload), [0, 0, 200, 400].map(offset => ({ jobId: 'cue-job', offset, limit: 200 })))
  assert.deepEqual(calls.find(row => row.command === 'library.job.retry')?.payload, { jobId: 'cue-job', albumIds: ['album-205', 'album-500'] })
})

test('真实库列表支持范围与全选并持久化，存在外部未确认意图时不更换库捕获', async t => {
  const f = fixture(); let blocked = false
  const model = useLocalWorkbenchLibrary({ api: f.api, storage: f.storage, canChangeLibrary: () => !blocked }); t.after(model.dispose)
  await model.read(); model.selectLibraryAt('library-a', false); model.selectLibraryAt('library-b', true)
  assert.deepEqual(model.selectedLibraryIds.value, ['library-a', 'library-b'])
  blocked = true; model.selectLibraries([]); model.selectLibraryAt('library-a', false); assert.deepEqual(model.selectedLibraryIds.value, ['library-a', 'library-b'])
  blocked = false; model.selectLibraries([]); model.selectLibraries(state.libraries.map(value => value.libraryId))
  const cold = useLocalWorkbenchLibrary({ api: f.api, storage: f.storage }); t.after(cold.dispose); await cold.read(); assert.deepEqual(cold.selectedLibraryIds.value, model.selectedLibraryIds.value)
  assert.equal(f.calls.some(value => value.command !== 'library.read'), false)
})

function captureReply<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void
  const promise = new Promise<T>((done, failed) => { resolve = done; reject = failed })
  return { promise, resolve, reject }
}
const capturedLibraries = (libraryIds: readonly string[], captureId: string): import('@music-bridge/contracts').LocalLibraryCompleteCapture => ({
  datasetId: state.datasetId, captureId, libraryIds: [...libraryIds], revision: state.revision,
  lyricsLibraries: libraryIds.map(libraryId => ({ datasetId: state.datasetId, libraryId, captureId: captureId + '-' + libraryId })),
})

test('当前库捕获A与B反序返回时只保留最后选择B，迟到A不能覆盖库或歌词捕获', async t => {
  const a = captureReply<import('@music-bridge/contracts').LocalLibraryCompleteCapture>(), b = captureReply<import('@music-bridge/contracts').LocalLibraryCompleteCapture>()
  const f = fixture(async (command, payload) => {
    if (command === 'library.read') return state
    assert.equal(command, 'library.capture')
    return (payload as LocalLibraryManagementPayloads['library.capture']).libraryIds[0] === 'library-a' ? a.promise : b.promise
  }), model = useLocalWorkbenchLibrary({ api: f.api }); t.after(model.dispose)
  await model.read(); model.selectLibraries(['library-a']); const readingA = model.captureLibraries()
  model.selectLibraries(['library-b']); const readingB = model.captureLibraries()
  const expected = capturedLibraries(['library-b'], 'capture-b')
  b.resolve(expected); assert.deepEqual(await readingB, expected)
  a.resolve(capturedLibraries(['library-a'], 'capture-a')); assert.equal(await readingA, null)
  assert.deepEqual(model.selectedLibraryIds.value, ['library-b']); assert.deepEqual(model.capture.value, expected)
  assert.equal(model.capture.value?.lyricsLibraries[0]?.libraryId, 'library-b')
})

test('当前库捕获等待期间选择改变且未发新请求时旧捕获也必须失效', async t => {
  const held = captureReply<import('@music-bridge/contracts').LocalLibraryCompleteCapture>()
  const f = fixture(async command => command === 'library.read' ? state : held.promise), model = useLocalWorkbenchLibrary({ api: f.api }); t.after(model.dispose)
  await model.read(); model.selectLibraries(['library-a']); const reading = model.captureLibraries()
  model.selectLibraries(['library-b']); held.resolve(capturedLibraries(['library-a'], 'capture-a'))
  assert.equal(await reading, null); assert.deepEqual(model.selectedLibraryIds.value, ['library-b']); assert.equal(model.capture.value, null)
})

test('显式专辑rootIds捕获与当前多库选择分开，其他库的选择变化不阻断明确专辑入口', async t => {
  const held = captureReply<import('@music-bridge/contracts').LocalLibraryCompleteCapture>()
  const f = fixture(async command => command === 'library.read' ? state : held.promise), model = useLocalWorkbenchLibrary({ api: f.api }); t.after(model.dispose)
  await model.read(); model.selectLibraries(['library-b']); const reading = model.captureLibraries(['library-a'])
  model.selectLibraries([]); const expected = capturedLibraries(['library-a'], 'explicit-album-root')
  held.resolve(expected); assert.deepEqual(await reading, expected); assert.deepEqual(model.capture.value, expected)
  assert.deepEqual(model.selectedLibraryIds.value, [])
  assert.deepEqual(f.calls.find(row => row.command === 'library.capture')?.payload, { libraryIds: ['library-a'] })
})

for (const kind of ['ai', 'cue-all', 'cue-selected'] as const) {
  test(`全库${kind}首个await前固定启动意图，双击与切库不产生第二UUID或丢失原job`, async t => {
    const capture = captureReply<import('@music-bridge/contracts').LocalLibraryCompleteCapture>(), started = captureReply<void>(), reply = captureReply<import('@music-bridge/contracts').LocalLibraryBatchPage>()
    const target = { choiceId: 'target-a', label: '合成独立输出', independent: true as const }
    let ids = 0, firstStart: { command: string; payload: unknown } | null = null
    const f = fixture(async (command, payload) => {
      if (command === 'library.read') return state
      if (command === 'library.capture') return capture.promise
      if (command === 'library.ai.start' || command === 'library.cue.start') {
        firstStart ??= { command, payload: structuredClone(payload) }; started.resolve(); return reply.promise
      }
      assert.equal(command, 'library.job.read')
      const body = firstStart!.payload as LocalLibraryManagementPayloads['library.ai.start'] | LocalLibraryManagementPayloads['library.cue.start']
      return { jobId: body.commandId, captureId: body.captureId, kind: kind === 'ai' ? 'ai' : 'cue', state: 'running', totalAlbums: 501, processedAlbums: 0, succeededAlbums: 0, failedAlbums: 0, offset: 0, items: [] }
    }), model = useLocalWorkbenchLibrary({ api: f.api, makeCommandId: () => 'batch-' + ++ids }); t.after(model.dispose)
    await model.read(); model.selectLibraries(['library-a'])
    const start = () => kind === 'ai' ? model.startAi('ollama') : kind === 'cue-all' ? model.startAllCue('flac', target) : model.startCue([{ albumId: 'album-a', cueId: 'cue-a' }], 'flac', target)
    const first = start(), occupiedBeforeReply = model.selectionLocked.value && model.pending.value, second = start()
    model.selectLibraries(['library-b']); const selectedDuringStart = [...model.selectedLibraryIds.value]
    capture.resolve(capturedLibraries(['library-a'], 'whole-capture')); await started.promise
    const original = structuredClone(firstStart)
    reply.reject(new Error('合成原start响应丢失')); await Promise.all([first, second])
    await start(); await model.jobAction('read')
    assert.equal(occupiedBeforeReply, true); assert.deepEqual(selectedDuringStart, ['library-a'])
    assert.equal(ids, 1); assert.equal(f.calls.filter(row => row.command === 'library.capture').length, 1)
    assert.equal(f.calls.filter(row => row.command === 'library.ai.start' || row.command === 'library.cue.start').length, 1)
    assert.deepEqual(model.originalJob.value, original); assert.equal(model.job.value?.jobId, 'batch-1'); assert.equal(model.job.value?.state, 'running')
    assert.deepEqual(f.calls.filter(row => row.command === 'library.job.read').map(row => row.payload), [{ jobId: 'batch-1', offset: 0, limit: 200 }])
  })
}


test('UNKNOWN重试围栏：合法partial含failed和unknown只查原任务，不重试或重造捕获', async t => {
  let ids = 0
  const dto = await import('@music-bridge/contracts'), captureId = 'partial-original-capture', jobId = 'unknown-job-1'
  const page: import('@music-bridge/contracts').LocalLibraryBatchPage = { jobId, captureId, kind: 'ai', state: 'partial', totalAlbums: 2, processedAlbums: 2, succeededAlbums: 0, failedAlbums: 1, offset: 0,
    items: [{ albumId: 'failed-album', state: 'failed', message: '合成明确失败' }, { albumId: 'unknown-album', state: 'unknown', message: '合成原结果未确认' }] }
  const f = fixture(async (command, payload) => {
    if (command === 'library.read') return state
    if (command === 'library.capture') return capturedLibraries(['library-a'], captureId)
    assert.ok(['library.ai.start', 'library.job.read', 'library.job.retry', 'library.job.stop'].includes(command))
    assert.equal(dto.isLocalLibraryManagementResult<LocalLibraryManagementCommand>(command, page, payload), true)
    return structuredClone(page)
  }), model = useLocalWorkbenchLibrary({ api: f.api, makeCommandId: () => 'unknown-job-' + ++ids }); t.after(model.dispose)
  await model.read(); model.selectLibraries(['library-a']); await model.startAi('ollama')
  const original = structuredClone(model.originalJob.value), originalCapture = structuredClone(model.capture.value), originalPage = structuredClone(model.job.value)
  assert.equal(model.job.value?.state, 'partial'); assert.deepEqual(model.job.value?.items.map(row => row.state), ['failed', 'unknown'])
  await model.retryAllFailed(); await model.retryAllFailed(); await model.jobAction('retry'); await model.jobAction('read')
  await model.startAi('ollama'); await model.captureLibraries(); model.newBatch(); model.selectLibraries(['library-b'])
  assert.equal(await model.discard(), false)
  assert.equal(ids, 1); assert.equal(model.locked.value, true); assert.deepEqual(model.selectedLibraryIds.value, ['library-a'])
  assert.deepEqual(model.originalJob.value, original); assert.deepEqual(model.capture.value, originalCapture); assert.deepEqual(model.job.value, originalPage)
  assert.equal(f.calls.filter(row => row.command === 'library.capture').length, 1)
  assert.equal(f.calls.filter(row => row.command === 'library.ai.start').length, 1)
  assert.equal(f.calls.some(row => ['library.job.retry', 'library.job.stop', 'library.job.resume'].includes(row.command)), false)
  assert.deepEqual(f.calls.filter(row => row.command === 'library.job.read').map(row => row.payload), [{ jobId, offset: 0, limit: 200 }])
})

test('UNKNOWN重试围栏：完整分页发现后页unknown，第一页回读不能清除，原条目确认后只恢复原failed集合', async t => {
  let ids = 0, unknownResolved = false, overallUnknown = false
  const dto = await import('@music-bridge/contracts'), captureId = 'paged-original-capture', jobId = 'paged-job-1'
  function page(offset: number): import('@music-bridge/contracts').LocalLibraryBatchPage {
    return { jobId, captureId, kind: 'ai', state: overallUnknown && offset === 200 ? 'unknown' : 'partial', totalAlbums: 501, processedAlbums: 501, succeededAlbums: 499, failedAlbums: unknownResolved ? 2 : 1, offset,
      items: Array.from({ length: Math.min(200, 501 - offset) }, (_, index) => { const n = offset + index; return { albumId: 'album-' + n, state: n === 5 || n === 450 && unknownResolved ? 'failed' : n === 450 ? 'unknown' : 'applied', message: null } }) }
  }
  const f = fixture(async (command, payload) => {
    if (command === 'library.read') return state
    if (command === 'library.capture') return capturedLibraries(['library-a'], captureId)
    assert.ok(['library.ai.start', 'library.job.read', 'library.job.retry'].includes(command))
    const offset = command === 'library.job.read' ? (payload as LocalLibraryManagementPayloads['library.job.read']).offset : 0, result = page(offset)
    assert.equal(dto.isLocalLibraryManagementResult<LocalLibraryManagementCommand>(command, result, payload), true)
    return result
  }), model = useLocalWorkbenchLibrary({ api: f.api, makeCommandId: () => 'paged-job-' + ++ids }); t.after(model.dispose)
  await model.read(); model.selectLibraries(['library-a']); await model.startAi('ollama')
  const original = structuredClone(model.originalJob.value), originalCapture = structuredClone(model.capture.value), originalPage = structuredClone(model.job.value)
  assert.equal(model.job.value?.items.some(row => row.state === 'unknown'), false)
  await model.retryAllFailed()
  assert.deepEqual(f.calls.filter(row => row.command === 'library.job.read').map(row => row.payload), [0, 200, 400].map(offset => ({ jobId, offset, limit: 200 })))
  assert.equal(f.calls.some(row => row.command === 'library.job.retry'), false); assert.equal(model.locked.value, true)
  assert.deepEqual(model.job.value, originalPage); assert.deepEqual(model.originalJob.value, original); assert.deepEqual(model.capture.value, originalCapture)
  await model.jobAction('read', 0); await model.jobAction('retry'); await model.retryAllFailed(); await model.startAi('ollama'); await model.captureLibraries(); model.newBatch()
  assert.equal(model.locked.value, true); assert.equal(ids, 1); assert.equal(f.calls.filter(row => row.command === 'library.capture').length, 1)
  assert.equal(f.calls.some(row => row.command === 'library.job.retry'), false)
  assert.deepEqual(model.originalJob.value, original); assert.deepEqual(model.capture.value, originalCapture)
  unknownResolved = true; await model.jobAction('read', 400); await model.retryAllFailed()
  assert.deepEqual(f.calls.filter(row => row.command === 'library.job.retry').map(row => row.payload), [{ jobId, albumIds: ['album-5', 'album-450'] }])
  assert.equal(ids, 1); assert.equal(f.calls.filter(row => row.command === 'library.capture').length, 1)
  assert.deepEqual(model.originalJob.value, original); assert.deepEqual(model.capture.value, originalCapture)
  // 同一原任务在分页途中回显整体UNKNOWN，也必须留下未知围栏。
  overallUnknown = true; await model.retryAllFailed(); assert.equal(model.locked.value, true); await model.jobAction('retry')
  assert.equal(f.calls.filter(row => row.command === 'library.job.retry').length, 1); assert.equal(ids, 1)
  assert.deepEqual(model.originalJob.value, original); assert.deepEqual(model.capture.value, originalCapture)
})


test('实际目录drop只消费原Main候选，未确认角色不调用新prepare或扫描', async t => {
  const f=fixture(),model=useLocalWorkbenchLibrary({api:f.api,makeCommandId:()=> 'native-import'});t.after(model.dispose)
  await model.read();const callsBefore=f.calls.length,finish=model.beginNativeImport();assert.ok(finish);assert.equal(model.busy.value,true);assert.equal(model.beginNativeImport(),null)
  const choice={choiceId:'actual-native-choice',label:'实际拖入目录',suggestedRole:'artist' as const,evidence:['目录实际身份已核']}
  assert.equal(finish(choice),true);assert.equal(model.busy.value,false);assert.deepEqual(model.importChoice.value,choice);assert.equal(model.role.value,'artist');assert.equal(f.calls.length,callsBefore)
  assert.equal(finish({...choice,label:'迟到替换'}),false);assert.equal(model.importChoice.value?.label,'实际拖入目录')
  await model.confirmImport();assert.deepEqual(f.calls.find(row=>row.command==='library.import.confirm')?.payload,{commandId:'native-import',choiceId:'actual-native-choice',role:'artist'})
  assert.equal(f.calls.some(row=>row.command==='library.import.prepare'||row.command.includes('scan')),false)
})
test('目录drop遇原未保存意图、撤销或非法候选时不安装新选择', async t => {
  let canChange=true;const f=fixture(),model=useLocalWorkbenchLibrary({api:f.api,canChangeLibrary:()=>canChange});t.after(model.dispose)
  await model.read();canChange=false;assert.equal(model.beginNativeImport(),null);canChange=true
  const invalid=model.beginNativeImport();assert.ok(invalid);assert.equal(invalid({choiceId:'伪选择',label:'无证据',suggestedRole:'album'} as never),false);assert.equal(model.importChoice.value,null);assert.equal(model.busy.value,false)
  const cancelled=model.beginNativeImport();assert.ok(cancelled);assert.equal(cancelled(null),true);assert.equal(model.importChoice.value,null);assert.equal(model.error.value,'')
  const late=model.beginNativeImport();assert.ok(late);canChange=false;assert.equal(late({choiceId:'native-choice',label:'旧目录',suggestedRole:'catalog',evidence:[]}),false);assert.equal(model.importChoice.value,null);assert.equal(model.busy.value,false)
  canChange=true;const disposed=model.beginNativeImport();assert.ok(disposed);model.dispose();assert.equal(disposed({choiceId:'native-choice',label:'已离开',suggestedRole:'catalog',evidence:[]}),false);assert.equal(model.importChoice.value,null)
})


// 525只核当前Controller原Promise与intent；受控API回复不授Main/Owner FD或冷读资格。
test('Main-only取消525：Controller等待原release成功才清choice，单请求且不创建确认UUID', async t => {
  const released = captureReply<import('@music-bridge/contracts').LocalLibraryManagementMainResults['library.import.cancel']>(), started = captureReply<void>()
  const choice = { choiceId: 'choice-controller-525-a', label: '原临时目录', suggestedRole: 'artist' as const, evidence: ['受控Controller输入'] }
  let ids = 0
  const f = fixture(async command => {
    if (command === 'library.read') return state
    if (command === 'library.import.prepare') return choice
    throw new Error('此Controller取消场景不派其它业务命令')
  }, async request => { assert.deepEqual(request, { choiceId: choice.choiceId }); started.resolve(); return released.promise }), model = useLocalWorkbenchLibrary({ api: f.api, makeCommandId: () => '不应分配-' + ++ids }); t.after(model.dispose)
  await model.read(); model.selectLibraries(['library-a']); await model.prepareImport()
  const original = structuredClone(model.importChoice.value), running = model.discard()
  await started.promise; assert.deepEqual(model.importChoice.value, original); assert.equal(model.locked.value, true); assert.equal(model.pending.value, true)
  assert.equal(await model.discard(), false); assert.equal(f.calls.filter(row => row.command === 'library.import.cancel').length, 1)
  assert.deepEqual(f.calls.find(row => row.command === 'library.import.cancel')?.payload, { choiceId: choice.choiceId })
  released.resolve({ choiceId: choice.choiceId, released: true }); assert.equal(await running, true)
  assert.equal(model.importChoice.value, null); assert.equal(model.locked.value, false); assert.equal(model.pending.value, false)
  assert.deepEqual(model.selectedLibraryIds.value, ['library-a']); assert.equal(ids, 0); assert.equal(f.calls.some(row => row.command === 'library.import.confirm'), false)
})

test('Main-only取消525：失败或未释放保原choice和UNKNOWN锁，仅同choice重试而拒确认换库', async t => {
  for (const outcome of ['rejected', 'not-released'] as const) {
    const released = captureReply<import('@music-bridge/contracts').LocalLibraryManagementMainResults['library.import.cancel']>(), started = captureReply<void>()
    const choice = { choiceId: 'choice-controller-525-' + outcome, label: '原未知目录', suggestedRole: 'album' as const, evidence: ['受控Controller输入'] }
    let cancels = 0, ids = 0
    const f = fixture(async command => {
      if (command === 'library.read') return state
      if (command === 'library.import.prepare') return choice
      throw new Error('此Controller未知取消场景不派其它业务命令')
    }, async request => {
      assert.deepEqual(request, { choiceId: choice.choiceId })
      if (++cancels === 1) { if (outcome === 'rejected') throw new Error('原Main关闭尚未确认'); return { choiceId: choice.choiceId, released: false } }
      started.resolve(); return released.promise
    }), model = useLocalWorkbenchLibrary({ api: f.api, makeCommandId: () => '不应新建-' + ++ids }); t.after(model.dispose)
    await model.read(); model.selectLibraries(['library-a']); await model.prepareImport()
    const original = structuredClone(model.importChoice.value)
    assert.equal(await model.discard(), false); assert.deepEqual(model.importChoice.value, original); assert.equal(model.locked.value, true); assert.equal(model.pending.value, true); assert.notEqual(model.error.value, '')
    assert.equal(await model.confirmImport(), false); assert.equal(await model.rename('library-a', '不能改写'), false)
    model.selectLibraries(['library-b']); await model.prepareImport(); assert.deepEqual(model.selectedLibraryIds.value, ['library-a'])
    assert.equal(f.calls.filter(row => row.command === 'library.import.prepare').length, 1); assert.equal(ids, 0)
    const retry = model.discard(); await started.promise
    assert.deepEqual(f.calls.filter(row => row.command === 'library.import.cancel').map(row => row.payload), [{ choiceId: choice.choiceId }, { choiceId: choice.choiceId }])
    assert.deepEqual(model.importChoice.value, original); released.resolve({ choiceId: choice.choiceId, released: true }); assert.equal(await retry, true)
    assert.equal(model.importChoice.value, null); assert.equal(model.locked.value, false); assert.equal(f.calls.some(row => row.command === 'library.import.confirm'), false)
  }
})

test('Main-only取消525：Controller dispose后迟到release不清新实例同名choice或改旧意图', async t => {
  const released = captureReply<import('@music-bridge/contracts').LocalLibraryManagementMainResults['library.import.cancel']>(), started = captureReply<void>()
  const choice = { choiceId: 'choice-controller-525-late', label: '原受控目录', suggestedRole: 'container' as const, evidence: ['受控Controller输入'] }
  const f = fixture(async command => { if (command === 'library.read') return state; if (command === 'library.import.prepare') return choice; throw Error('此旧实例不派其它业务命令') }, async request => { assert.deepEqual(request, { choiceId: choice.choiceId }); started.resolve(); return released.promise })
  const model = useLocalWorkbenchLibrary({ api: f.api }); t.after(model.dispose); await model.read(); await model.prepareImport()
  const running = model.discard(); await started.promise; model.dispose(); const oldAfterDispose = structuredClone({ state: model.state.value, choice: model.importChoice.value })
  const peerApi = fixture(async command => { if (command === 'library.read') return { ...state, datasetId: 'dataset-b' }; if (command === 'library.import.prepare') return { ...choice, label: '新实例原目录' }; throw Error('新实例不派其它业务命令') }).api
  const peer = useLocalWorkbenchLibrary({ api: peerApi }); t.after(peer.dispose); await peer.read(); await peer.prepareImport(); const peerBefore = structuredClone({ state: peer.state.value, choice: peer.importChoice.value })
  released.resolve({ choiceId: choice.choiceId, released: true }); assert.equal(await running, false)
  assert.deepEqual({ state: model.state.value, choice: model.importChoice.value }, oldAfterDispose); assert.deepEqual({ state: peer.state.value, choice: peer.importChoice.value }, peerBefore)
})

 test('暖终态丢弃653：partial/failed只发原job单次stop，实际ACK前保选择和原回执，成功后才解除前台意图',async t=>{
  for(const terminal of ['partial','failed'] as const){
    const entered=captureReply<void>(),release=captureReply<import('@music-bridge/contracts').LocalLibraryBatchPage>(),jobId='terminal-job-'+terminal,captureId='terminal-capture-'+terminal
    const page:import('@music-bridge/contracts').LocalLibraryBatchPage={jobId,captureId,kind:'ai',state:terminal,totalAlbums:2,processedAlbums:2,succeededAlbums:terminal==='partial'?1:0,failedAlbums:terminal==='partial'?1:2,offset:0,
      items:[{albumId:'album-original-a',state:terminal==='partial'?'applied':'failed',message:'原完整条目'},{albumId:'album-original-b',state:'failed',message:'原失败条目'}]}
    let ids=0
    const f=fixture(async(command,payload)=>{
      if(command==='library.read')return state
      if(command==='library.capture')return capturedLibraries(['library-a'],captureId)
      if(command==='library.ai.start')return structuredClone(page)
      assert.equal(command,'library.job.stop');assert.deepEqual(payload,{jobId});entered.resolve();return release.promise
    }),model=useLocalWorkbenchLibrary({api:f.api,makeCommandId:()=>{ids++;return jobId}});t.after(model.dispose)
    await model.read();model.selectLibraries(['library-a']);await model.startAi('ollama')
    const original=structuredClone(model.originalJob.value),capture=structuredClone(model.capture.value),oldJob=structuredClone(model.job.value)
    const discarding=model.discard()
    try{
      await entered.promise;assert.equal(model.pending.value,true);assert.equal(model.locked.value,true);assert.equal(await model.discard(),false)
      assert.deepEqual(model.selectedLibraryIds.value,['library-a']);assert.deepEqual(model.job.value,oldJob)
      release.resolve(structuredClone(page));assert.equal(await discarding,true)
      assert.equal(model.pending.value,false);assert.equal(model.locked.value,false);assert.deepEqual(model.job.value,oldJob)
      assert.deepEqual(model.originalJob.value,original);assert.deepEqual(model.capture.value,capture);assert.deepEqual(model.selectedLibraryIds.value,['library-a'])
      assert.equal(ids,1);assert.deepEqual(f.calls.filter(row=>row.command==='library.job.stop'),[{command:'library.job.stop',payload:{jobId}}])
      assert.equal(f.calls.some(row=>['library.job.retry','library.job.resume','library.remove'].includes(row.command)),false)
    }finally{release.resolve(structuredClone(page));await discarding}
  }
})

 test('暖终态丢弃653：UNKNOWN/未执行尾项及换dataset或原请求代次迟到ACK不解除原意图',async t=>{
  for(const variant of ['unknown','running-tail','queued-tail','dataset-swap','original-swap','disposed'] as const){
    const entered=captureReply<void>(),release=captureReply<import('@music-bridge/contracts').LocalLibraryBatchPage>(),jobId='guard-job-'+variant,captureId='guard-capture-'+variant
    const page:import('@music-bridge/contracts').LocalLibraryBatchPage={jobId,captureId,kind:'ai',state:'failed',totalAlbums:1,processedAlbums:1,succeededAlbums:0,failedAlbums:1,offset:0,items:[{albumId:'original-failed-album',state:'failed',message:null}]}
    let ids=0
    const f=fixture(async(command,payload)=>{
      if(command==='library.read')return state
      if(command==='library.capture')return capturedLibraries(['library-a'],captureId)
      if(command==='library.ai.start')return structuredClone(page)
      assert.equal(command,'library.job.stop');assert.deepEqual(payload,{jobId});entered.resolve();return release.promise
    }),model=useLocalWorkbenchLibrary({api:f.api,makeCommandId:()=>{ids++;return jobId}});t.after(model.dispose)
    await model.read();model.selectLibraries(['library-a']);await model.startAi('ollama')
    const before=structuredClone({job:model.job.value,capture:model.capture.value}),discarding=model.discard()
    try{
      await entered.promise
      const reply=structuredClone(page)
      if(variant==='unknown'){reply.state='unknown';reply.items[0]!.state='unknown';reply.failedAlbums=0}
      else if(variant==='running-tail'||variant==='queued-tail'){reply.state='partial';reply.items[0]!.state=variant==='running-tail'?'running':'queued';reply.processedAlbums=0;reply.failedAlbums=0}
      else if(variant==='dataset-swap')model.state.value={...state,datasetId:'changed-dataset-653'}
      else if(variant==='original-swap')model.originalJob.value=structuredClone(model.originalJob.value)
      else if(variant==='disposed')model.dispose()
      const original=structuredClone(model.originalJob.value)
      release.resolve(reply);assert.equal(await discarding,false)
      assert.equal(model.pending.value,true);assert.deepEqual(model.job.value,before.job);assert.deepEqual(model.capture.value,before.capture);assert.deepEqual(model.originalJob.value,original)
      assert.deepEqual(model.selectedLibraryIds.value,['library-a']);assert.equal(ids,1);assert.equal(f.calls.filter(row=>row.command==='library.job.stop').length,1)
      assert.equal(f.calls.some(row=>['library.job.retry','library.job.resume','library.remove'].includes(row.command)),false)
    }finally{release.resolve(structuredClone(page));await discarding}
  }
})

// 仅复现Renderer读占忙的意图丢失；不冒充Main身份守门或原生面板现场证据。
test('导入意图：等待在途库读取后单次prepare，迟回选择不被面板读取抢占', async t => {
  for (const outcome of ['chosen', 'cancelled', 'rejected'] as const) {
    const readReply = captureReply<LocalLibraryManagementReadback>(), choiceReply = captureReply<import('@music-bridge/contracts').LocalLibraryImportChoice | null>()
    const choice = { choiceId: 'read-then-import-' + outcome, label: '合成目录', suggestedRole: 'artist' as const, evidence: ['合成选择'] }
    let ids = 0
    const f = fixture(async command => {
      if (command === 'library.read') return readReply.promise
      assert.equal(command, 'library.import.prepare'); return choiceReply.promise
    }), model = useLocalWorkbenchLibrary({ api: f.api, makeCommandId: () => '不应创建-' + ++ids }); t.after(model.dispose)
    const reading = model.read(), importing = model.prepareImport(), duplicate = model.prepareImport()
    try {
      assert.equal(model.busy.value, true); assert.deepEqual(f.calls.map(row => row.command), ['library.read'])
      readReply.resolve(structuredClone(state)); await reading
      assert.equal(f.calls.filter(row => row.command === 'library.import.prepare').length, 1, '旧读取完成后应消费原单击一次，不需要用户再次点击')
      assert.equal(model.busy.value, true); assert.equal(model.importChoice.value, null)
      await model.read(); await model.prepareImport()
      assert.deepEqual(f.calls.map(row => row.command), ['library.read', 'library.import.prepare'], '原生选择等待期间面板不抢读，也不派第二个prepare')
      if (outcome === 'rejected') choiceReply.reject(new Error('合成选择器拒绝'))
      else choiceReply.resolve(outcome === 'chosen' ? choice : null)
      await Promise.all([importing, duplicate])
      assert.equal(model.busy.value, false); assert.equal(ids, 0)
      assert.deepEqual(model.importChoice.value, outcome === 'chosen' ? choice : null)
      if (outcome === 'chosen') assert.equal(model.role.value, 'artist')
      if (outcome === 'rejected') assert.notEqual(model.error.value, '')
      assert.equal(f.calls.some(row => row.command === 'library.import.confirm'), false)
    } finally { readReply.resolve(structuredClone(state)); choiceReply.resolve(null); await Promise.all([reading, importing, duplicate]) }
  }
})

test('导入意图：读等待期间dispose、未保存变更或换库均不派prepare', async t => {
  for (const guard of ['disposed', 'pending', 'dataset-changed', 'read-failed'] as const) {
    const readReply = captureReply<LocalLibraryManagementReadback>(); let reads = 0
    const f = fixture(async command => {
      if (command === 'library.read') return ++reads === 1 ? state : readReply.promise
      throw new Error('围栏阻断后不应派发导入')
    }), model = useLocalWorkbenchLibrary({ api: f.api }); t.after(model.dispose)
    await model.read(); const reading = model.read(), importing = model.prepareImport()
    try {
      if (guard === 'disposed') model.dispose()
      if (guard === 'pending') model.scanConcurrency.value = state.scanConcurrency + 1
      if (guard === 'read-failed') readReply.reject(new Error('合成库读取失败'))
      else readReply.resolve(guard === 'dataset-changed' ? { ...state, datasetId: 'changed-dataset-import' } : structuredClone(state))
      await Promise.all([reading, importing])
      assert.equal(f.calls.some(row => row.command === 'library.import.prepare'), false)
      assert.equal(model.importChoice.value, null)
      if (guard === 'pending') assert.equal(model.pending.value, true)
      if (guard === 'read-failed') assert.notEqual(model.error.value, '', '保留原读取安全错误，不因有旧state而打开选择器')
    } finally { readReply.resolve(structuredClone(state)); await Promise.all([reading, importing]) }
  }
})
