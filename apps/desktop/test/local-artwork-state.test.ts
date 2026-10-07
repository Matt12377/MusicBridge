import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { compileScript, parse } from '@vue/compiler-sfc'
import ts from 'typescript'
import { createSSRApp, type Component } from 'vue'
import { renderToString } from 'vue/server-renderer'
import {
  LOCAL_ARTWORK_INPUT_BYTES, isCoverArtArchiveSource, isLocalArtworkCandidate, isLocalArtworkContext,
  type ApplyLocalArtworkSelection, type CommandOutboxOverview, type CommandOutboxPublicApi, type CommandOutboxState, type CommandOutboxView,
  type LocalArtworkCandidate, type LocalArtworkContext, type LocalArtworkPublicApi, type LocalArtworkSelection, type SearchLocalArtworkCandidates,
} from '@music-bridge/contracts'
import { localArtworkCandidatePresentation, useLocalArtwork } from '../src/renderer/src/composables/application/useLocalArtwork.js'

const id = (n: number) => `11111111-1111-4111-8111-${String(n).padStart(12, '0')}`
const track = id(1), otherTrack = id(2), edition = id(10), otherEdition = id(11)
function candidate(candidateId = id(30), editionId = edition, origin: LocalArtworkCandidate['origin'] = 'local-independent'): LocalArtworkCandidate {
  return { id: candidateId, editionId, origin, sourceIdentity: 'b'.repeat(64), sourceLabel: origin === 'embedded' ? '内嵌封面 1' : origin === 'manual' ? '手选图片' : 'cover.png', provider: 'local-readonly-v1', license: 'user-supplied', expiresAt: '2099-01-01T00:00:00.000Z',
    original: { mime: 'image/png', bytes: 4, sha256: 'a'.repeat(64), width: 32, height: 32 }, display: { mime: 'image/jpeg', bytes: 3, sha256: 'c'.repeat(64), width: 16, height: 16, dataUrl: 'data:image/jpeg;base64,/9j/' } }
}
function context(trackId = track, editionId: string | null = edition, selection: LocalArtworkSelection | null = null): LocalArtworkContext {
  return { trackId, trackRevision: '1', target: editionId ? { trackId, editionId, expectedEditionRevision: '1', expectedTrackRevision: '1', expectedSourceRevision: 'a'.repeat(64) } : null,
    editions: editionId ? [{ id: editionId, title: '同名专辑', edition: '', revision: '1' }] : [], selection, candidates: editionId ? [candidate(id(30), editionId), candidate(id(31), editionId, 'embedded')] : [],
    remoteProvider: 'off-pending-license', sourceFilesWrite: 'OFF', status: 'ready' }
}
function providerCandidate(candidateId = id(40), editionId = edition, author = '合成作者甲'): LocalArtworkCandidate {
  return { ...candidate(candidateId, editionId), origin: 'provider', provider: 'commons-cc0-v1', license: 'CC0-1.0', sourceLabel: 'Commons 合成封面',
    remoteSource: { pageId: 123, pageRevision: 456, fileSha1: 'd'.repeat(40), fileTimestamp: '2026-10-07T00:00:00Z', title: 'File:Synthetic_Cover.png', author,
      descriptionUrl: 'https://commons.wikimedia.org/wiki/File:Synthetic_Cover.png', licenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/', policyVersion: '2026-10-07-cc0-only-v1' } }
}
function remoteContext(trackId = track, editionId: string | null = edition, selection: LocalArtworkSelection | null = null): LocalArtworkContext {
  return { ...context(trackId, editionId, selection), remoteProvider: 'commons-cc0-v1' }
}
function musicCandidate(candidateId = id(60), releaseId = id(70), releaseDate = '2000-01-01', country = 'US', artist = '合成艺人'): LocalArtworkCandidate {
  return { ...candidate(candidateId), origin: 'provider', provider: 'cover-art-archive-v1', license: 'rights-unverified', sourceLabel: '同名发行封面',
    remoteSource: { releaseId, imageId: '100', releaseTitle: '同名专辑', artist, releaseDate, country, releaseUrl: `https://musicbrainz.org/release/${releaseId}`, front: true, approved: true,
      musicBrainzMetadataLicense: 'CC0-core', imageRights: 'unverified', imageVariant: 'original', policyVersion: '2026-10-07-caa-personal-v1' } }
}
function musicContext(mode: LocalArtworkContext['remoteProvider'] = 'music-and-commons-v1'): LocalArtworkContext { return { ...context(), remoteProvider: mode } }
function receipt(request: ApplyLocalArtworkSelection): LocalArtworkSelection {
  return { id: id(50), editionId: request.target.editionId, revision: String(BigInt(request.expectedSelectionRevision ?? '0') + 1n),
    mode: request.candidateId === null ? 'local-default' : 'manual', candidate: request.candidateId === null ? null : candidate(request.candidateId, request.target.editionId) }
}
function api(overrides: Partial<LocalArtworkPublicApi & Pick<CommandOutboxPublicApi, 'getCommandOutbox'>> = {}): LocalArtworkPublicApi & Partial<Pick<CommandOutboxPublicApi, 'getCommandOutbox'>> {
  return { getLocalArtworkContext: async request => context(request.trackId, request.editionId ?? edition), findLocalArtworkCandidates: async target => context(target.trackId, target.editionId),
    searchLocalArtworkCandidates: async request => ({ ...context(request.target.trackId, request.target.editionId), remoteProvider: request.provider ?? 'cover-art-archive-v1' }),
    chooseLocalArtworkFile: async () => null, importLocalArtworkBytes: async request => context(request.target.trackId, request.target.editionId), applyLocalArtworkSelection: async request => receipt(request),
    createLocalArtworkEdition: async request => ({ id: otherEdition, title: request.title, edition: '', revision: '1' }), cancelLocalArtworkLookup: async () => {}, ...overrides }
}
function deferred<T>() { let resolve!: (value: T) => void, reject!: (reason: Error) => void; const promise = new Promise<T>((r, e) => { resolve = r; reject = e }); return { promise, resolve, reject } }
function entry(commandId: string, command: CommandOutboxView['command'], state: CommandOutboxState, datasetId = id(90)): CommandOutboxView {
  return { id: id(91), commandId, command, datasetId, state, createdAt: '2026-10-07T00:00:00.000Z', updatedAt: '2026-10-07T00:00:00.000Z', acknowledged: false, canRetry: state === 'uncertain' }
}
/** 在内存中渲染真实选图模板；不挂载App、不执行mounted、不开网络、不写编译产物。 */
function rendererComponent(url: URL): Component {
  const { descriptor } = parse(readFileSync(url, 'utf8'), { filename: url.pathname })
  const script = compileScript(descriptor, { id: 'mbrs010-source-text', inlineTemplate: true })
  const output = ts.transpileModule(script.content, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } })
  const module = { exports: {} as Record<string, unknown> }, require = createRequire(import.meta.url)
  const dependencies = (name: string) => {
    if (name.endsWith('/SafeArtwork.vue')) return { __esModule: true, default: rendererComponent(new URL('../src/renderer/src/components/SafeArtwork.vue', import.meta.url)) }
    if (name.endsWith('/useLocalArtwork')) return { localArtworkCandidatePresentation, useLocalArtwork }
    return require(name)
  }
  new Function('require', 'module', 'exports', output.outputText)(dependencies, module, module.exports)
  return module.exports.default as Component
}

test('010状态会话按曲目代际丢弃迟到的旧上下文', async t => {
  const late = deferred<LocalArtworkContext>(), started = deferred<void>(), calls: string[] = []
  const model = useLocalArtwork({ api: api({ getLocalArtworkContext: request => { calls.push(request.trackId); if (request.trackId === track) { started.resolve(); return late.promise }; return Promise.resolve(context(otherTrack, otherEdition)) } }) }); t.after(() => model.dispose())
  const first = model.open(track); await started.promise; await model.open(otherTrack, otherEdition); late.resolve(context()); await first
  assert.deepEqual(calls, [track, otherTrack]); assert.equal(model.context.value?.trackId, otherTrack); assert.equal(model.target.value?.editionId, otherEdition); assert.equal(model.loading.value, false)
})
test('010来源修订独立围栏拒绝同track/edition修订下的旧来源候选', async t => {
  const initial = context(), changed = context(); changed.target!.expectedSourceRevision = 'b'.repeat(64); changed.candidates = [candidate(id(35))]
  const model = useLocalArtwork({ api: api({ getLocalArtworkContext: async () => initial, findLocalArtworkCandidates: async () => changed }) }); t.after(() => model.dispose()); await model.open(track, edition)
  await model.search(); assert.equal(model.context.value, initial); assert.equal(model.target.value?.expectedSourceRevision, 'a'.repeat(64)); assert.equal(model.context.value?.candidates[0]?.id, id(30)); assert.match(model.error.value, /读取失败.*保留/u)
})
test('010候选读取按完整target围栏，切换同曲目发行后旧候选零覆盖', async t => {
  const late = deferred<LocalArtworkContext>(), cancelled: unknown[] = []
  const model = useLocalArtwork({ api: api({ findLocalArtworkCandidates: () => late.promise, cancelLocalArtworkLookup: async target => { cancelled.push(target) } }) }); t.after(() => model.dispose())
  await model.open(track, edition); const reading = model.search(); await model.open(track, otherEdition)
  const old = context(); old.candidates = [candidate(id(35))]; late.resolve(old); await reading
  assert.equal(model.target.value?.editionId, otherEdition); assert.equal(model.context.value?.candidates[0]?.editionId, otherEdition); assert.ok(cancelled.some((v: any) => v.editionId === edition)); assert.equal(model.searching.value, false)
})
test('010取消读取保留当前已保存封面，迟到成功与关闭后异常均零覆盖', async t => {
  const success = deferred<LocalArtworkContext>(), failure = deferred<LocalArtworkContext>(), saved = receipt({ commandId: id(80), target: context().target!, candidateId: id(31), expectedSelectionRevision: null })
  let lookups = 0
  const model = useLocalArtwork({ api: api({ getLocalArtworkContext: async () => context(track, edition, saved), findLocalArtworkCandidates: () => ++lookups === 1 ? success.promise : failure.promise }) }); t.after(() => model.dispose())
  await model.open(track, edition); const previous = model.context.value
  const first = model.search(); model.cancelLookup(); success.resolve(context()); await first
  assert.equal(model.context.value, previous); assert.equal(model.context.value?.selection, saved); assert.equal(model.lookupBusy.value, false)
  const second = model.search(); model.close(); failure.reject(new Error('合成迟到错误')); await second
  assert.equal(model.context.value, previous); assert.equal(model.error.value, ''); assert.equal(model.isOpen.value, false)
})
test('010本地查找失败与文件选择取消均保留已保存封面和已有候选', async t => {
  const saved = receipt({ commandId: id(80), target: context().target!, candidateId: id(30), expectedSelectionRevision: null })
  const model = useLocalArtwork({ api: api({ getLocalArtworkContext: async () => context(track, edition, saved), findLocalArtworkCandidates: async () => { throw new Error('合成源不可用') } }) }); t.after(() => model.dispose())
  await model.open(track, edition); const previous = model.context.value; await model.search()
  assert.equal(model.context.value, previous); assert.match(model.error.value, /读取失败.*保留/u)
  await model.pick(); assert.equal(model.context.value, previous); assert.equal(model.context.value?.selection?.candidate?.id, id(30)); assert.equal(model.picking.value, false)
})
test('010超过4MiB、空文件与错误格式在读取和派发前拒绝', async t => {
  let imports = 0, reads = 0
  const model = useLocalArtwork({ api: api({ importLocalArtworkBytes: async request => { imports++; return context(request.target.trackId, request.target.editionId) } }) }); t.after(() => model.dispose()); await model.open(track, edition)
  const oversized = new File([new Uint8Array(LOCAL_ARTWORK_INPUT_BYTES + 1)], 'large.png', { type: 'image/png' })
  Object.defineProperty(oversized, 'arrayBuffer', { value: () => { reads++; throw new Error('不应读取') } })
  await model.drop(oversized); assert.match(model.error.value, /4 MiB/u); assert.equal(imports, 0); assert.equal(reads, 0)
  await model.drop(new File([], 'empty.jpg', { type: 'image/jpeg' })); assert.equal(imports, 0)
  await model.drop(new File(['text'], 'image.svg', { type: 'image/svg+xml' })); assert.match(model.error.value, /只接受 PNG 或 JPEG/u); assert.equal(imports, 0); assert.equal(model.importing.value, false)
})
test('010拖图arrayBuffer迟到后切换曲目不再派发旧bytes', async t => {
  const late = deferred<ArrayBuffer>(), file = new File([new Uint8Array(4)], 'chosen.png', { type: 'image/png' }); let imports = 0
  Object.defineProperty(file, 'arrayBuffer', { value: () => late.promise })
  const model = useLocalArtwork({ api: api({ importLocalArtworkBytes: async request => { imports++; return context(request.target.trackId, request.target.editionId) } }) }); t.after(() => model.dispose())
  await model.open(track, edition); const reading = model.drop(file); await model.open(otherTrack, otherEdition); late.resolve(new ArrayBuffer(4)); await reading
  assert.equal(imports, 0); assert.equal(model.context.value?.trackId, otherTrack); assert.equal(model.importing.value, false)
})
test('010通过前端门禁的合成拖图派发Uint8Array与原target，候选不隐式保存', async t => {
  const requests: any[] = []; let writes = 0
  const model = useLocalArtwork({ api: api({ importLocalArtworkBytes: async request => { requests.push(request); const value = context(request.target.trackId, request.target.editionId); value.candidates = [candidate(id(32), edition, 'manual')]; return value }, applyLocalArtworkSelection: async request => { writes++; return receipt(request) } }) }); t.after(() => model.dispose())
  await model.open(track, edition); await model.drop(new File([new Uint8Array([1, 2, 3, 4])], 'chosen.png', { type: 'image/png' }))
  assert.equal(requests.length, 1); assert.ok(requests[0].bytes instanceof Uint8Array); assert.deepEqual([...requests[0].bytes], [1, 2, 3, 4]); assert.deepEqual(requests[0].target, context().target); assert.equal(writes, 0); assert.equal(model.context.value?.selection, null)
})
test('010候选筛选与双图比较只改变本地草稿，过期候选零保存', async t => {
  let writes = 0
  const initial = context(); initial.candidates = [...initial.candidates, candidate(id(32), edition, 'manual')]
  const model = useLocalArtwork({ api: api({ getLocalArtworkContext: async () => initial, applyLocalArtworkSelection: async request => { writes++; return receipt(request) } }) }); t.after(() => model.dispose()); await model.open(track, edition)
  model.filter('内嵌', 'embedded'); assert.deepEqual(model.filteredCandidates.value.map(c => c.id), [id(31)])
  for (const value of initial.candidates) model.toggleComparison(value.id)
  assert.equal(model.comparisonCandidates.value.length, 2); assert.match(model.notice.value, /两张/u); assert.equal(writes, 0)
  initial.candidates[0]!.expiresAt = '2000-01-01T00:00:00.000Z'; model.selectCandidate(id(30)); await model.apply(); assert.equal(writes, 0); assert.match(model.error.value, /失效/u)
})
test('010有效保存回执更新选择；恢复默认建立新修订，两者各单次派发', async t => {
  const requests: ApplyLocalArtworkSelection[] = []; let notifications = 0
  const model = useLocalArtwork({ api: api({ applyLocalArtworkSelection: async request => { requests.push(request); return receipt(request) } }), onApplied: () => { notifications++ } }); t.after(() => model.dispose()); await model.open(track, edition)
  model.selectCandidate(id(31)); await model.apply(); assert.equal(model.context.value?.selection?.candidate?.id, id(31)); assert.equal(model.context.value?.selection?.revision, '1'); assert.equal(model.pendingApply.value, null)
  await model.restoreDefault(); assert.equal(model.context.value?.selection?.mode, 'local-default'); assert.equal(model.context.value?.selection?.revision, '2'); assert.equal(requests[1]?.candidateId, null); assert.equal(requests[1]?.expectedSelectionRevision, '1'); assert.equal(notifications, 2)
})
test('010保存迟到回执不覆盖后来曲目；回执确认原命令后可释放其锁', async t => {
  const late = deferred<LocalArtworkSelection>(), started = deferred<void>(); let original!: ApplyLocalArtworkSelection, notifications = 0
  const model = useLocalArtwork({ api: api({ applyLocalArtworkSelection: request => { original = request; started.resolve(); return late.promise } }), onApplied: () => { notifications++ } }); t.after(() => model.dispose())
  await model.open(track, edition); model.selectCandidate(id(30)); const saving = model.apply(); await started.promise; await model.open(otherTrack, otherEdition)
  late.resolve(receipt(original)); await saving
  assert.equal(model.context.value?.trackId, otherTrack); assert.equal(model.context.value?.selection, null); assert.equal(model.pendingApply.value, null); assert.equal(notifications, 0)
})
test('010未知保存保留冻结原body/commandId；读取选择吻合仍不冒充命令完成', async t => {
  const writes: ApplyLocalArtworkSelection[] = []; let selection: LocalArtworkSelection | null = null
  const model = useLocalArtwork({ api: api({ getLocalArtworkContext: async () => context(track, edition, selection), applyLocalArtworkSelection: async request => { writes.push(request); throw new Error('合成未知结果') } }) }); t.after(() => model.dispose())
  await model.open(track, edition); model.selectCandidate(id(30)); await model.apply(); const original = model.pendingApply.value!
  assert.ok(Object.isFrozen(original)); assert.ok(Object.isFrozen(original.target)); model.selectCandidate(id(31)); await model.apply(); await model.restoreDefault(); model.close(); await model.open(track, edition)
  assert.equal(model.pendingApply.value, original); assert.equal(writes.length, 1); assert.match(model.error.value, /未确认/u)
  selection = receipt(original); await model.reconcile()
  assert.equal(model.pendingApply.value, original); assert.equal(model.context.value?.selection?.candidate?.id, id(30)); assert.match(model.notice.value, /当前选择已核对.*终态仍未确认/u); assert.equal(model.appliedCount.value, 0); assert.equal(writes.length, 1)
})
test('010原dataset+command+commandId的Outbox终态才恢复保存锁，未知和取消等待均不重发', async t => {
  let overview: CommandOutboxOverview = { datasetId: id(90), entries: [] }, writes = 0
  const model = useLocalArtwork({ api: api({ getCommandOutbox: async () => overview, applyLocalArtworkSelection: async () => { writes++; throw new Error('合成未知') } }) }); t.after(() => model.dispose()); await model.open(track, edition); model.selectCandidate(id(30)); await model.apply()
  const original = model.pendingApply.value!
  for (const state of ['uncertain', 'dismissed'] as const) { overview = { datasetId: id(90), entries: [entry(original.commandId, 'localArtwork.apply', state)] }; await model.reconcile(); assert.equal(model.pendingApply.value, original) }
  overview = { datasetId: id(92), entries: [entry(original.commandId, 'localArtwork.apply', 'succeeded', id(92))] }; await model.reconcile(); assert.equal(model.pendingApply.value, original)
  overview = { datasetId: id(90), entries: [entry(id(93), 'localArtwork.apply', 'succeeded')] }; await model.reconcile(); assert.equal(model.pendingApply.value, original)
  overview = { datasetId: id(90), entries: [entry(original.commandId, 'localArtwork.createEdition', 'succeeded')] }; await model.reconcile(); assert.equal(model.pendingApply.value, original)
  overview = { datasetId: id(90), entries: [entry(original.commandId, 'localArtwork.apply', 'rejected')] }; await model.reconcile(); assert.equal(model.pendingApply.value, null); assert.equal(writes, 1)
})
test('010关闭期间原Outbox终态只记证据，返回后重新读同库与当前封面', async t => {
  let overview: CommandOutboxOverview = { datasetId: id(90), entries: [] }, selection: LocalArtworkSelection | null = null, writes = 0
  const model = useLocalArtwork({ api: api({ getCommandOutbox: async () => overview, getLocalArtworkContext: async () => context(track, edition, selection), applyLocalArtworkSelection: async () => { writes++; throw new Error('合成未知') } }) }); t.after(() => model.dispose()); await model.open(track, edition); model.selectCandidate(id(30)); await model.apply()
  const original = model.pendingApply.value!; model.close(); selection = receipt(original); overview = { datasetId: id(90), entries: [entry(original.commandId, 'localArtwork.apply', 'succeeded')] }; model.observeOutbox(overview)
  assert.equal(model.pendingApply.value, original); await model.open(track, edition)
  assert.equal(model.pendingApply.value, null); assert.equal(model.context.value?.selection?.candidate?.id, id(30)); assert.equal(writes, 1)
})
test('010错误回执和错误图片合同不能覆盖当前选择，也不释放未知保存', async t => {
  const initial = context(); let badImage = false
  const model = useLocalArtwork({ api: api({ getLocalArtworkContext: async () => { if (!badImage) return initial; const bad = context(); bad.candidates[0]!.display.dataUrl = 'https://invalid.example/cover.jpg'; return bad }, applyLocalArtworkSelection: async request => ({ ...receipt(request), editionId: otherEdition }) }) }); t.after(() => model.dispose()); await model.open(track, edition)
  model.selectCandidate(id(30)); await model.apply(); assert.ok(model.pendingApply.value); assert.equal(model.context.value?.selection, null)
  badImage = true; await model.refresh(); assert.equal(model.context.value, initial); assert.match(model.error.value, /刷新失败.*保留/u); assert.equal(isLocalArtworkContext(context()), true)
})
test('010无发行先明确建立独立发行并按返回id读取，不以同名聚合', async t => {
  const creates: unknown[] = [], reads: unknown[] = []
  const model = useLocalArtwork({ api: api({ getLocalArtworkContext: async request => { reads.push(request); return request.editionId === null ? context(track, null) : context(track, request.editionId) }, createLocalArtworkEdition: async request => { creates.push(request); return { id: otherEdition, title: request.title, edition: '', revision: '1' } } }) }); t.after(() => model.dispose()); await model.open(track)
  assert.equal(model.target.value, null); await model.search(); model.editionTitle.value = '同名专辑'; await model.createEdition()
  const createdTarget = model.context.value?.target
  assert.equal(creates.length, 1); assert.equal((creates[0] as any).expectedTrackRevision, '1'); assert.deepEqual(reads[1], { trackId: track, editionId: otherEdition }); assert.equal(createdTarget?.editionId, otherEdition)
})
test('010建立发行未知保留原请求，改名和重新读取不能重复建立', async t => {
  const creates: unknown[] = []
  const model = useLocalArtwork({ api: api({ getLocalArtworkContext: async () => context(track, null), createLocalArtworkEdition: async request => { creates.push(request); throw new Error('合成未知建立') } }) }); t.after(() => model.dispose()); await model.open(track); model.editionTitle.value = '独立发行 A'; await model.createEdition(); const original = model.pendingEdition.value
  model.editionTitle.value = '独立发行 B'; await model.createEdition(); await model.reconcile(); assert.equal(model.pendingEdition.value, original); assert.equal(creates.length, 1); assert.match(model.error.value, /结果未确认/u)
})
test('010远程关键词默认取明确发行标题，打开/编辑/筛选不查图，只有显式搜索才派发', async t => {
  const requests: SearchLocalArtworkCandidates[] = []; let writes = 0
  const model = useLocalArtwork({ api: api({ getLocalArtworkContext: async () => remoteContext(), searchLocalArtworkCandidates: async request => { requests.push(request); const value = remoteContext(); value.candidates = [providerCandidate()]; return value }, applyLocalArtworkSelection: async request => { writes++; return receipt(request) } }) }); t.after(() => model.dispose())
  await model.open(track, edition); assert.equal(model.remoteQuery.value, '同名专辑'); assert.equal(requests.length, 0)
  model.remoteQuery.value = '  合成专辑  '; model.filter('独立筛选', 'provider'); assert.equal(requests.length, 0)
  await model.searchRemote(); assert.equal(requests.length, 1); assert.equal(requests[0]!.query, '合成专辑'); assert.equal(requests[0]!.provider, 'commons-cc0-v1'); assert.deepEqual(requests[0]!.target, context().target); assert.ok(Object.isFrozen(requests[0]!.target)); assert.equal(model.query.value, '独立筛选'); assert.equal(model.context.value?.selection, null); assert.equal(writes, 0)
})
test('010远程空白/网址/控制字符/超80字关键词在API前拒绝', async t => {
  let calls = 0
  const model = useLocalArtwork({ api: api({ getLocalArtworkContext: async () => remoteContext(), searchLocalArtworkCandidates: async () => { calls++; return remoteContext() } }) }); t.after(() => model.dispose()); await model.open(track, edition)
  for (const query of ['', '   ', 'https://invalid.example/cover', '合成\n专辑', '合成\n', '字'.repeat(81)]) {
    model.remoteQuery.value = query; await model.searchRemote(); assert.equal(calls, 0); assert.match(model.error.value, /1 至 80.*网址或控制字符/u)
  }
  assert.equal(model.lookupBusy.value, false); assert.equal(model.context.value?.selection, null)
})
test('010旧off合同不启用远程，本地查找仍用原API且不触发远程调用', async t => {
  let local = 0, remote = 0
  const model = useLocalArtwork({ api: api({ findLocalArtworkCandidates: async () => { local++; return context() }, searchLocalArtworkCandidates: async () => { remote++; return remoteContext() } }) }); t.after(() => model.dispose()); await model.open(track, edition)
  assert.equal(model.remoteEnabled.value, false); await model.searchRemote(); assert.equal(remote, 0); assert.match(model.error.value, /尚未启用/u)
  await model.search(); assert.equal(local, 1); assert.equal(remote, 0)
})
test('010远程请求切换曲目后旧候选迟到零覆盖，取消携原target与来源围栏', async t => {
  const late = deferred<LocalArtworkContext>(), cancelled: unknown[] = []
  const model = useLocalArtwork({ api: api({ getLocalArtworkContext: async request => remoteContext(request.trackId, request.editionId ?? edition), searchLocalArtworkCandidates: () => late.promise, cancelLocalArtworkLookup: async target => { cancelled.push(target) } }) }); t.after(() => model.dispose()); await model.open(track, edition)
  const searching = model.searchRemote(); assert.equal(model.remoteSearching.value, true); await model.open(otherTrack, otherEdition)
  const old = remoteContext(); old.candidates = [providerCandidate()]; late.resolve(old); await searching
  assert.equal(model.context.value?.trackId, otherTrack); assert.equal(model.target.value?.editionId, otherEdition); assert.ok(cancelled.some((value: any) => value.trackId === track && value.expectedSourceRevision === 'a'.repeat(64))); assert.equal(model.remoteSearching.value, false); assert.equal(model.context.value?.candidates.some(c => c.origin === 'provider'), false)
})
test('010取消旧远程请求后可显式搜新词，旧错误不能覆盖新候选或清新忙碌状态', async t => {
  const old = deferred<LocalArtworkContext>(), next = deferred<LocalArtworkContext>(); let calls = 0
  const model = useLocalArtwork({ api: api({ getLocalArtworkContext: async () => remoteContext(), searchLocalArtworkCandidates: () => ++calls === 1 ? old.promise : next.promise }) }); t.after(() => model.dispose()); await model.open(track, edition)
  const first = model.searchRemote(); model.cancelLookup(); model.remoteQuery.value = '下一次明确搜索'; const second = model.searchRemote()
  old.reject(new Error('合成旧查询失败')); await first; assert.equal(model.remoteSearching.value, true); assert.equal(model.error.value, '')
  const value = remoteContext(); value.candidates = [providerCandidate(id(41))]; next.resolve(value); await second
  assert.equal(calls, 2); assert.equal(model.remoteSearching.value, false); assert.equal(model.context.value?.candidates[0]?.id, id(41)); assert.equal(model.error.value, '')
})
test('010远程查图失败保留已保存选择、现有候选、待选图和比较草稿', async t => {
  const saved = receipt({ commandId: id(80), target: context().target!, candidateId: id(30), expectedSelectionRevision: null })
  const initial = remoteContext(track, edition, saved); initial.candidates.push(providerCandidate())
  const model = useLocalArtwork({ api: api({ getLocalArtworkContext: async () => initial, searchLocalArtworkCandidates: async () => { throw new Error('合成Provider暂不可用') } }) }); t.after(() => model.dispose()); await model.open(track, edition)
  model.selectCandidate(id(40)); model.toggleComparison(id(40)); await model.searchRemote()
  assert.equal(model.context.value, initial); assert.equal(model.context.value?.selection, saved); assert.equal(model.selectedCandidateId.value, id(40)); assert.deepEqual(model.comparisonIds.value, [id(40)]); assert.match(model.error.value, /远程查图.*保留当前封面与已有候选/u); assert.equal(model.pendingApply.value, null)
})
test('010Commons作者/来源筛选独立于远程关键词，本地与Provider可并排比较且不隐式保存', async t => {
  const initial = remoteContext(); initial.candidates.push(providerCandidate(), providerCandidate(id(41), edition, '合成作者乙')); let searches = 0, writes = 0
  const model = useLocalArtwork({ api: api({ getLocalArtworkContext: async () => initial, searchLocalArtworkCandidates: async () => { searches++; return initial }, applyLocalArtworkSelection: async request => { writes++; return receipt(request) } }) }); t.after(() => model.dispose()); await model.open(track, edition)
  const keyword = model.remoteQuery.value; model.filter('合成作者乙', 'provider'); assert.deepEqual(model.filteredCandidates.value.map(c => c.id), [id(41)]); assert.equal(model.remoteQuery.value, keyword)
  model.toggleComparison(id(40)); model.toggleComparison(id(30)); assert.deepEqual(new Set(model.comparisonCandidates.value.map(c => c.origin)), new Set(['provider', 'local-independent'])); assert.equal(localArtworkCandidatePresentation(providerCandidate()).origin, 'Wikimedia Commons · CC0 补充图库'); assert.equal(searches, 0); assert.equal(writes, 0)
})
test('010非CC0 Provider响应不进入候选，保留原上下文而不展示错误许可', async t => {
  const initial = remoteContext(), bad = remoteContext(); bad.candidates = [{ ...providerCandidate(), license: 'CC-BY-4.0' } as unknown as LocalArtworkCandidate]
  const model = useLocalArtwork({ api: api({ getLocalArtworkContext: async () => initial, searchLocalArtworkCandidates: async () => bad }) }); t.after(() => model.dispose()); await model.open(track, edition); await model.searchRemote()
  assert.equal(model.context.value, initial); assert.equal(model.context.value?.candidates.some(c => c.origin === 'provider'), false); assert.match(model.error.value, /远程查图.*保留/u)
})
test('010远程候选选图未知仍保留原body/commandId，随后搜索不能重发或解锁写操作', async t => {
  const initial = remoteContext(); initial.candidates.push(providerCandidate()); const writes: ApplyLocalArtworkSelection[] = []; let searches = 0
  const model = useLocalArtwork({ api: api({ getLocalArtworkContext: async () => initial, applyLocalArtworkSelection: async request => { writes.push(request); throw new Error('合成未知保存') }, searchLocalArtworkCandidates: async () => { searches++; return initial } }) }); t.after(() => model.dispose()); await model.open(track, edition); model.selectCandidate(id(40)); await model.apply(); const original = model.pendingApply.value
  await model.searchRemote(); model.close(); await model.open(track, edition); await model.searchRemote(); await model.apply()
  assert.equal(model.pendingApply.value, original); assert.equal(writes.length, 1); assert.equal(writes[0]!.candidateId, id(40)); assert.equal(searches, 0); assert.match(model.error.value, /结果未确认/u)
})
test('010远程响应来源修订变化也须拒绝，稳定发行已保存选择保留', async t => {
  const saved = receipt({ commandId: id(80), target: context().target!, candidateId: id(30), expectedSelectionRevision: null })
  const initial = remoteContext(track, edition, saved), changed = remoteContext(track, edition, saved); changed.target!.expectedSourceRevision = 'b'.repeat(64); changed.candidates = [providerCandidate()]
  const model = useLocalArtwork({ api: api({ getLocalArtworkContext: async () => initial, searchLocalArtworkCandidates: async () => changed }) }); t.after(() => model.dispose()); await model.open(track, edition); await model.searchRemote()
  assert.equal(model.context.value, initial); assert.equal(model.context.value?.selection, saved); assert.match(model.error.value, /远程查图.*保留/u)
})
test('010音乐封面是默认远程来源，切到CC0补充图库只改草稿，搜索固定显式provider', async t => {
  const requests: SearchLocalArtworkCandidates[] = []
  const model = useLocalArtwork({ api: api({ getLocalArtworkContext: async () => musicContext(), searchLocalArtworkCandidates: async request => { requests.push(request); return musicContext() } }) }); t.after(() => model.dispose()); await model.open(track, edition)
  assert.equal(model.remoteProvider.value, 'cover-art-archive-v1'); assert.equal(requests.length, 0); assert.ok(model.remoteProviders.value.every(p => p.enabled))
  await model.searchRemote(); assert.equal(requests[0]!.provider, 'cover-art-archive-v1'); assert.deepEqual(Object.keys(requests[0]!).sort(), ['provider', 'query', 'target']); assert.ok(Object.isFrozen(requests[0]!))
  model.remoteProvider.value = 'commons-cc0-v1'; assert.equal(requests.length, 1); await model.searchRemote(); assert.equal(requests[1]!.provider, 'commons-cc0-v1'); assert.equal(model.context.value?.sourceFilesWrite, 'OFF')
})
test('010音乐查找失败不默认转Commons，不自动重试，不改变当前选择', async t => {
  const initial = musicContext(), requests: SearchLocalArtworkCandidates[] = []
  const model = useLocalArtwork({ api: api({ getLocalArtworkContext: async () => initial, searchLocalArtworkCandidates: async request => { requests.push(request); throw new Error('合成CAA失败') } }) }); t.after(() => model.dispose()); await model.open(track, edition); await model.searchRemote()
  assert.equal(requests.length, 1); assert.equal(requests[0]!.provider, 'cover-art-archive-v1'); assert.equal(model.remoteProvider.value, 'cover-art-archive-v1'); assert.equal(model.context.value, initial); assert.match(model.error.value, /远程查图.*保留/u)
})
test('010远程选择器按context禁用不可用来源，仅Commons上下文可明确使用补充图库', async t => {
  let value = musicContext('cover-art-archive-v1'), requests: SearchLocalArtworkCandidates[] = []
  const model = useLocalArtwork({ api: api({ getLocalArtworkContext: async () => value, searchLocalArtworkCandidates: async request => { requests.push(request); return value } }) }); t.after(() => model.dispose()); await model.open(track, edition)
  assert.equal(model.remoteProviders.value.find(p => p.value === 'commons-cc0-v1')?.enabled, false); model.remoteProvider.value = 'commons-cc0-v1'; await model.searchRemote(); assert.equal(requests.length, 0)
  value = remoteContext(); await model.refresh(); assert.equal(model.remoteProviders.value.find(p => p.value === 'cover-art-archive-v1')?.enabled, false); assert.equal(model.remoteProvider.value, 'commons-cc0-v1'); assert.equal(requests.length, 0)
  await model.searchRemote(); assert.equal(requests[0]!.provider, 'commons-cc0-v1')
})
test('010同名CAA多发行保留独立候选与日期国家来源，不自动建立或合并本地发行', async t => {
  const initial = musicContext(); initial.candidates = [musicCandidate(), musicCandidate(id(61), id(71), '2020-02-02', 'JP')]; let creates = 0, writes = 0
  const model = useLocalArtwork({ api: api({ getLocalArtworkContext: async () => initial, createLocalArtworkEdition: async request => { creates++; return { id: otherEdition, title: request.title, edition: '', revision: '1' } }, applyLocalArtworkSelection: async request => { writes++; return receipt(request) } }) }); t.after(() => model.dispose()); await model.open(track, edition)
  assert.equal(model.filteredCandidates.value.length, 2); assert.notEqual(localArtworkCandidatePresentation(initial.candidates[0]).label, localArtworkCandidatePresentation(initial.candidates[1]).label)
  model.toggleComparison(id(60)); model.toggleComparison(id(61)); assert.equal(model.comparisonCandidates.value.length, 2); model.filter('JP', 'provider'); assert.deepEqual(model.filteredCandidates.value.map(c => c.id), [id(61)])
  assert.deepEqual(model.context.value?.editions, context().editions); assert.equal(model.target.value?.editionId, edition); assert.equal(creates, 0); assert.equal(writes, 0); assert.equal(model.context.value?.sourceFilesWrite, 'OFF')
})
test('010CAA审核与核心元数据CC0不冒充封面许可，审核变化不改变权利未核实记录', () => {
  const image = musicCandidate(); assert.equal(isLocalArtworkCandidate(image), true); const source = image.remoteSource; assert.ok(isCoverArtArchiveSource(source))
  const approved = localArtworkCandidatePresentation(image); assert.match(approved.fields.find(f => f.label === 'CAA 审核')!.text, /已审核.*不代表图片许可/u); assert.match(approved.notice, /权利状态未核实.*仅用于 MusicBridge 显示.*独立整理计划/u)
  assert.equal(image.license, 'rights-unverified'); assert.equal(source.musicBrainzMetadataLicense, 'CC0-core'); assert.equal(source.imageRights, 'unverified')
  source.approved = false; const unchecked = localArtworkCandidatePresentation(image); assert.match(unchecked.fields.find(f => f.label === 'CAA 审核')!.text, /尚未审核/u); assert.equal(unchecked.notice, approved.notice)
})
test('010实际选图模板以纯文本展示版权和来源，不输出链接HTML，不发网络或文件写回', async t => {
  const image = musicCandidate(id(60), id(70), '2000-01-01', 'US', '<script>合成艺人</script>'), supplemental = providerCandidate(id(40), edition, '<b>合成作者</b>')
  const initial = musicContext('cover-art-archive-v1'); initial.candidates = [image, supplemental]; initial.selection = { id: id(50), editionId: edition, revision: '1', mode: 'manual', candidate: image }; let reads = 0, writes = 0
  const model = useLocalArtwork({ api: api({ getLocalArtworkContext: async () => initial, searchLocalArtworkCandidates: async () => { reads++; return initial }, applyLocalArtworkSelection: async request => { writes++; return receipt(request) } }) }); t.after(() => model.dispose()); await model.open(track, edition)
  const dialog = rendererComponent(new URL('../src/renderer/src/components/library/LocalArtworkDialog.vue', import.meta.url)), html = await renderToString(createSSRApp(dialog, { session: model }))
  assert.match(html, /封面权利状态未核实/u); assert.match(html, /审核状态不代表图片许可/u); assert.match(html, /&lt;script&gt;合成艺人&lt;\/script&gt;/u); assert.match(html, /&lt;b&gt;合成作者&lt;\/b&gt;/u)
  assert.doesNotMatch(html, /<script\b|<a\b|\bhref=/iu); assert.match(html, /https:\/\/musicbrainz\.org\/release\//u); assert.match(html, /data:image\/jpeg;base64,/u); assert.match(html, /<option(?=[^>]*value="commons-cc0-v1")(?=[^>]*disabled)[^>]*>/u)
  assert.equal(model.context.value?.sourceFilesWrite, 'OFF'); assert.equal(reads, 0); assert.equal(writes, 0)
})
