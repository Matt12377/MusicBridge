import assert from 'node:assert/strict'
import test from 'node:test'
import { DatabaseSync, StatementSync } from 'node:sqlite'
import { createLocalAlbumOwnerService } from '../src/collection/local-album-browser/owner-port.js'
import { readLibraryOperationLine, type LibraryOperationEvent } from '../src/shared/library-operation-log.js'
import { createHash,randomUUID } from 'node:crypto'
import path from 'node:path'
import { mkdtemp,mkdir,writeFile,readFile,stat } from 'node:fs/promises'
import { createCollectionRepository } from '../src/collection/repository.js'
import { authorizeSourceDirectory, sourceRootAvailability } from '../src/recording/source-files.js'
import { createCompletedScanSnapshotView } from '../src/collection/local-scan-snapshot-view.js'
import { createLocalLibraryManagementBatchEvents,localLibraryManagementLedgerRow,localLibraryManagementDigest,localWorkbenchJournalCanonical,createLocalWorkbenchOwnerPersistence,type LocalLibraryManagementOperationRecord,type LocalLibraryManagementBindingRecord,type LocalLibraryManagementJobRecord,type LocalLibraryManagementCaptureRecord } from '../src/collection/local-library-workbench/owner-journal.js'
import { createLocalWorkbenchPlanRegistry } from '../src/collection/local-library-workbench/plan-registry.js'
import type { ScanPreparedItem } from '../src/collection/local-scan-store.js'
import { LocalWorkbenchPlanError } from '../src/collection/local-library-workbench/types.js'
import { createLocalLibraryManagementRuntime,type LocalLibraryManagementRuntimeOptions,type LocalLibraryManagementJobPort } from '../src/collection/local-library-workbench/read-service.js'
import { readFileSync } from 'node:fs'
import * as dto from '@music-bridge/contracts'
import { parseCueText } from '../src/library/cue-text-reader.js'
import type { LocalAlbumGroup } from '../src/collection/local-album-browser/types.js'
import type { ScanReadFacts } from '../src/collection/local-scan-facts.js'
import { createLocalWorkbenchReadService, type LocalWorkbenchDirectoryFacts, type LocalWorkbenchReadServiceOptions } from '../src/collection/local-library-workbench/read-service.js'
import { createLocalRelocationCoordinator } from '../src/collection/local-relocation-coordinator.js'
import { dispatchDatasetCommand } from '../src/collection/dataset-dispatch.js'
import { createDatasetCommandBoundary } from '../src/recording/dataset-identity.js'
import { LocalFactsCommitFatal } from '../src/stream/local-source-fence.js'

const digest = (value: string): string => createHash('sha256').update(value).digest('hex')
const uuid = (index: number): string => '10000000-0000-4000-8000-' + index.toString(16).padStart(12, '0')
const cueId = uuid(4)
const metadataFacts: ScanReadFacts = {
  technical: { container: 'FLAC', codec: 'FLAC', lossless: true, sampleRateHz: 44100, channels: 2, bitsPerSample: 16,
    durationSeconds: 2, evidence: 'bounded-parser-reported' }, coverEvidence: [],
  readEvidence: { bytesRead: 32, readCalls: 1, maxReadBytes: 32, allocationBytes: 32, elapsedMs: 1, wholeAudioHash: false, wholeAudioDecode: false },
}

/** 合成强类型原Owner端口；本用例不打开真实数据库、媒体库或网络。 */
function fixture(count = 1) {
  const root: dto.LibraryRoot = { id: uuid(1), sourceRootId: uuid(2), role: 'library', revision: '1' }
  const group: LocalAlbumGroup = { summary: { id: 'album-a', kind: 'source-directory', rootId: root.id, editionId: null,
    title: '合成专辑', artists: ['原合成艺术家'], year: null, versionLabel: null, sourceLabel: '合成来源', trackCount: count,
    representativeTrackId: count ? uuid(1000) : null, revision: 'album-1', artworkAvailable: false, artworkState: 'unknown', statuses: [] },
  directory: '合成目录', members: Array.from({ length: count }, (_, index) => {
    const raw: dto.LocalMetadata = { title: '原标题' + index, artist: '原合成艺术家', album: '原合成专辑' }
    return { fact: { relative: '合成目录/Track' + index + '.flac', summary: { track: { id: uuid(1000 + index), assetId: uuid(2000 + index), selectionRevision: '1', segment: null },
      asset: { id: uuid(2000 + index), libraryRootId: root.id, sourceRootId: root.sourceRootId, rootRevision: root.revision, fileRevision: '1', locationRevision: '1', sampleFrames: null, timebaseHz: null },
      metadata: structuredClone(raw), versionTokens: [] }, rawMetadata: raw, hasArtwork: false, artworkRevision: null, artworkState: 'unknown' as const },
    disc: null, trackNumber: index + 1, sequence: index + 1, editionLink: null, statuses: [] }
  }), issues: [], rejectedFiles: [] }
  assert.ok(dto.isLibraryRoot(root)); assert.ok(dto.isLocalAlbumSummary(group.summary))
  group.members.forEach(member => assert.ok(dto.isLocalLibraryTrackSummary(member.fact.summary)))
  let catalogRevision = digest('catalog-1'), scanRevision = digest('scan-1'), online = true, serial = 0, preparings = 0
  const overrides = new Map<string, dto.LocalMetadataOverride>(), calls: string[] = []
  const facts: LocalWorkbenchDirectoryFacts = { revision: scanRevision, files: group.members.map((member, index) => ({
    jobId: uuid(3), rootRevision: '1', sourceRootId: root.sourceRootId, currentRelative: member.fact.relative,
    value: { libraryRootId: root.id, relative: member.fact.relative, signature: '1:' + index + ':128:3:4', parserVersion: 'synthetic-parser',
      outcome: 'accepted' as const, assetId: member.fact.summary.asset.id, trackId: member.fact.summary.track.id, failureCode: null, readFacts: structuredClone(metadataFacts) },
  })), cues: [] }
  const options: LocalWorkbenchReadServiceOptions = {
    datasetId: 'dataset-a', assertCurrent() { calls.push('check') }, now: () => 1000, ttlMs: 1000,
    makeReadToken: () => uuid(4000 + ++serial), makePreparationId: () => uuid(5000 + ++preparings),
    localAlbums: { inspectAlbum(request) { calls.push('inspect'); assert.equal(request.albumKey, group.summary.id); assert.equal(request.rootId, root.id); return structuredClone(group) } },
    async readRootViews() {
      calls.push('root-online')
      const result: dto.LocalRootView = { root: structuredClone(root), label: '合成来源', availability: online ? 'ONLINE' : 'SOURCE_ROOT_OFFLINE' }
      assert.ok(dto.isLocalRootView(result)); return [result]
    },
    repository: {
      localCatalog: {
        root(id) { assert.equal(id, root.id); return structuredClone(root) },
        track(id) { calls.push('track'); return structuredClone(group.members.find(member => member.fact.summary.track.id === id)!.fact.summary.track) },
        metadata(id) {
          calls.push('metadata')
          const member = group.members.find(member => member.fact.summary.track.id === id)!
          return { raw: structuredClone(member.fact.rawMetadata), override: structuredClone(overrides.get(id) ?? null), effective: structuredClone(member.fact.summary.metadata) }
        },
        privateAssetLocator(id) { calls.push('locator'); const member = group.members.find(member => member.fact.summary.asset.id === id)!
          return { asset: structuredClone(member.fact.summary.asset), relative: member.fact.relative } },
        privateAlbumBrowserRevision() { return catalogRevision },
        privateWorkbenchMetadataProvenance(ids) { calls.push('override-ledger-once'); return ids.map(trackId => {
          const value = overrides.get(trackId)
          return { trackId, override: value ? { commandId: uuid(3000 + group.members.findIndex(member => member.fact.summary.track.id === trackId)), revision: value.revision, fields: structuredClone(value.fields) } : null }
        }) },
      },
      localScan: {
        privateAlbumBrowserRevision() { return scanRevision },
        privateWorkbenchDirectoryFacts(request) { calls.push('directory-closed-read'); assert.equal(request.expectedRevision, scanRevision)
          assert.equal(request.libraryRootId, root.id); assert.ok(request.directories.includes('合成目录')); assert.equal(request.maxFiles, 10000)
          const result = structuredClone({ ...facts, revision: scanRevision })
          if (Buffer.byteLength(JSON.stringify(result), 'utf8') > request.maxBytes) throw new Error('明确选择的完整整理范围超过预算；本次未返回截断结果。')
          return result },
      },
    },
  }
  function request(): dto.LocalWorkbenchReadRequest { return { albums: [{ albumId: group.summary.id, rootId: root.id, title: group.summary.title,
    artist: '原合成艺术家', trackIds: group.members.map(member => member.fact.summary.track.id) }] } }
  function rejectFile(code = 'PARSE_FAILED') {
    facts.files = [...facts.files, { jobId: uuid(3), rootRevision: root.revision, sourceRootId: root.sourceRootId, currentRelative: '合成目录/实际失败.flac',
      value: { libraryRootId: root.id, relative: '合成目录/实际失败.flac', signature: '8:9:128:3:4', parserVersion: 'synthetic-parser', outcome: 'rejected',
        assetId: null, trackId: null, failureCode: code, readFacts: null } }]
    group.rejectedFiles = [...(group.rejectedFiles ?? []), { relative: '合成目录/实际失败.flac', revision: 'scan-rejected-1' }]
    if (code === 'PARSE_FAILED') group.issues = [...group.issues, { kind: 'metadata-read-failed', relative: '合成目录/实际失败.flac' }]
  }
  function override(fields: dto.LocalMetadata) {
    const member = group.members[0]!
    overrides.set(member.fact.summary.track.id, { trackId: member.fact.summary.track.id, revision: '1', fields: structuredClone(fields) })
    assert.ok(dto.isLocalMetadataOverride(overrides.get(member.fact.summary.track.id)))
    member.fact.summary.metadata = { ...member.fact.rawMetadata, ...fields }
  }
  return { root, group, facts, options, calls, request, rejectFile, override, offline() { online = false },
    changed() { catalogRevision = digest('catalog-2'); scanRevision = digest('scan-2') } }
}
async function read(f: ReturnType<typeof fixture>, overrides: Partial<LocalWorkbenchReadServiceOptions> = {}) {
  const service = createLocalWorkbenchReadService({ ...f.options, ...overrides }), result = await service.readAlbums(f.request())
  return { service, result, reference: { datasetId: result.datasetId, capture: result.albums[0]!.capture } }
}
const modelContent = JSON.stringify({ artistName: '建议合成艺术家', albumName: '建议合成专辑' })

test('字段作者分别回读，AI更名不会解除未改艺人的人工锁', async () => {
  const f = fixture(); f.override({ artist: '人工艺人', album: 'AI专辑' })
  let originalFacts = 0
  const { service, reference } = await read(f, { readNameSources(fact) {
    originalFacts++; assert.equal(fact.trackId, f.group.members[0]!.fact.summary.track.id)
    assert.equal(fact.override?.fields.artist, '人工艺人')
    return { artistName: 'manual', albumName: 'workbench-ai' }
  }, readOverrideAuthor() { throw new Error('不应退回聚合作者') } })
  try {
    const captured = await service.resolveCapture(reference)
    assert.deepEqual(captured.capture.nameSources, { artistName: 'manual', albumName: 'workbench-ai' })
    assert.deepEqual(captured.capture.manualLocks, { artistName: true, albumName: false })
    assert.ok(originalFacts >= 2)
  } finally { await service.close() }
})

test('已覆盖字段不能凭raw或多余属性绕过原作者证明', async () => {
  for (const invalidSources of [
    { artistName: 'raw', albumName: 'workbench-ai' },
    { artistName: 'manual', albumName: 'workbench-ai', declaredHuman: true },
  ]) {
    const f = fixture(); f.override({ artist: '人工艺人', album: 'AI专辑' })
    const service = createLocalWorkbenchReadService({ ...f.options,
      readNameSources: () => invalidSources as { artistName: 'manual'; albumName: 'workbench-ai' } })
    try { await assert.rejects(service.readAlbums(f.request()), /字段作者证明无效/) }
    finally { await service.close() }
  }
})

test('整理只读捕获真实原inspect/catalog/scan事实，模型仅取原名称/目录/字段，预览不执行', async () => {
  const f = fixture(), { service, result, reference } = await read(f)
  const captured = await service.resolveCapture(reference)
  assert.equal(captured.capture.members.length, 1); assert.equal(captured.capture.members[0]!.assetId, uuid(2000))
  assert.equal(result.albums[0]?.album.editionId, undefined); assert.equal(result.albums[0]?.album.trackIds[0], uuid(1000))
  assert.ok(f.calls.includes('inspect')); assert.ok(f.calls.includes('locator')); assert.ok(f.calls.includes('directory-closed-read')); assert.ok(f.calls.includes('override-ledger-once'))
  const preparation = await service.prepareNameSuggestion({ ...reference, backend: 'ollama' })
  const prompt = JSON.parse(preparation.userPrompt) as Record<string, unknown>
  assert.equal(prompt.artistName, '原合成艺术家'); assert.equal(prompt.albumName, '原合成专辑'); assert.equal(prompt.directoryName, '合成目录')
  assert.doesNotMatch(preparation.userPrompt, /trackId|assetId|rootId|readToken|sourceRootId|metadataRevision|signature/u)
  const proposed = await service.completeNameSuggestion(preparation.preparationId, { backend: 'ollama', content: modelContent })
  if (proposed.status !== 'ready') assert.fail('未返回原两键名称候选')
  const preview = await service.prepareNamePreview({ datasetId: reference.datasetId, captures: [reference.capture], selections: [{ albumId: reference.capture.albumId, candidateId: proposed.candidate.candidateId }] })
  assert.equal(preview.draft.state, 'ready'); assert.equal(preview.draft.scope, 'MB_ONLY'); assert.equal(preview.capture.albums[0]?.members.length, 1)
  assert.deepEqual(f.group.members[0]?.fact.summary.metadata, { title: '原标题0', artist: '原合成艺术家', album: '原合成专辑' })
})

test('零Track失败目录保留真实scan文件名/签名/null资产，仍能准备名称候选，不伪造发行或音轨', async () => {
  const f = fixture(0); f.rejectFile()
  const { service, result, reference } = await read(f), captured = await service.resolveCapture(reference), member = captured.capture.members[0]!
  assert.equal(result.albums[0]?.album.trackIds.length, 0); assert.equal(captured.group.summary.representativeTrackId, null)
  assert.equal(member.trackId, null); assert.equal(member.assetId, null); assert.equal(member.fileRevision, null); assert.equal(member.metadataRevision, null)
  assert.equal(member.fileName, '实际失败.flac'); assert.equal(member.scan?.signature, '8:9:128:3:4')
  assert.match(result.albums[0]!.issues.join(' '), /不计为名称 AI 失败/u)
  const preparation = await service.prepareNameSuggestion({ ...reference, backend: 'vllm' })
  assert.equal(JSON.parse(preparation.userPrompt).audioFiles[0].fileName, '实际失败.flac')
  assert.equal((await service.completeNameSuggestion(preparation.preparationId, { backend: 'vllm', content: modelContent })).status, 'ready')
  assert.deepEqual(f.group.members, [])
})

test('完整授权成员不随12曲提示摘要截断；输入不完整选择整组拒绝', async () => {
  const f = fixture(20), { service, reference } = await read(f)
  const captured = await service.resolveCapture(reference), preparation = await service.prepareNameSuggestion({ ...reference, backend: 'cloud' })
  assert.equal(captured.capture.members.length, 20); assert.equal(JSON.parse(preparation.userPrompt).audioFiles.length, 12)
  assert.equal(JSON.parse(preparation.userPrompt).totalAudioFiles, 20)
  const incomplete = f.request(); incomplete.albums[0]!.trackIds = [uuid(1000)]
  await assert.rejects(service.readAlbums(incomplete), /已变化/u)
})

test('原override ledger不冒充人工锁；unknown阻断、明确human锁、已应用AI可继续建议', async () => {
  for (const author of [undefined, 'manual', 'workbench-ai'] as const) {
    const f = fixture(); f.override({ album: '已覆盖专辑' })
    const { service, reference } = await read(f, author ? { readOverrideAuthor: async () => author } : {})
    const resolved = await service.resolveCapture(reference)
    assert.equal(resolved.capture.manualLocks.albumName, author === 'manual')
    assert.equal(resolved.capture.nameSources?.albumName, author ?? 'unknown')
    const preparation = await service.prepareNameSuggestion({ ...reference, backend: 'ollama' }), result = await service.completeNameSuggestion(preparation.preparationId, { backend: 'ollama', content: modelContent })
    if (result.status !== 'ready') assert.fail('未返回名称候选')
    const preview = await service.prepareNamePreview({ datasetId: reference.datasetId, captures: [reference.capture], selections: [{ albumId: reference.capture.albumId, candidateId: result.candidate.candidateId }] })
    assert.equal(preview.draft.state, author === 'workbench-ai' ? 'ready' : 'blocked')
    assert.equal(preview.draft.items[0]!.changes.find(change => change.field === 'album')!.before, '已覆盖专辑')
  }
})

test('准备后原Owner水位变化，迟到模型结果丢弃，不写成名称AI失败或新候选', async () => {
  const f = fixture(), { service, reference } = await read(f), preparation = await service.prepareNameSuggestion({ ...reference, backend: 'ollama' })
  f.changed()
  await assert.rejects(service.completeNameSuggestion(preparation.preparationId, { backend: 'ollama', content: modelContent }), /已变化/u)
  assert.equal(service.inspect().candidates, 0)
})

test('取消准备和关闭丢弃迟到模型回报；读取Abort不签发捕获', async () => {
  const f = fixture(), { service, reference } = await read(f), preparation = await service.prepareNameSuggestion({ ...reference, backend: 'ollama' })
  assert.equal(service.cancelNamePreparation(preparation.preparationId), true); assert.equal(service.cancelNamePreparation(preparation.preparationId), false)
  await assert.rejects(service.completeNameSuggestion(preparation.preparationId, { backend: 'ollama', content: modelContent }), /迟到结果/u)
  const signal = new AbortController(); signal.abort()
  await assert.rejects(service.readAlbums(f.request(), { signal: signal.signal }), /已取消/u)
  assert.equal(service.inspect().captures, 1)
  const next = await service.prepareNameSuggestion({ ...reference, backend: 'vllm' }); service.close()
  await assert.rejects(service.completeNameSuggestion(next.preparationId, { backend: 'vllm', content: modelContent }), /已结束/u)
})

test('当前定位与历史scan relative分开；只按已分配的非PARSE rejected归属捕获', async () => {
  const f = fixture(); f.rejectFile('UNSUPPORTED')
  f.facts.files[0]!.value.relative = '旧目录/旧文件.flac'
  const { service, reference } = await read(f), captured = await service.resolveCapture(reference)
  assert.equal(captured.capture.members[0]!.fileName, 'Track0.flac'); assert.equal(captured.directoryFacts.files[0]?.value.relative, '旧目录/旧文件.flac')
  assert.equal(captured.directoryFacts.files[0]?.currentRelative, '合成目录/Track0.flac')
  assert.equal(captured.capture.members.length, 2); assert.equal(captured.capture.members[1]!.scan?.failureCode, 'UNSUPPORTED')
  const ambiguous = fixture(); ambiguous.rejectFile(); delete ambiguous.group.rejectedFiles
  await assert.rejects(read(ambiguous), /不能猜测成员范围/u)
})

test('读取预算、重复当前定位和缺真实rejected事实整组拒绝；不截断或补签名', async () => {
  await assert.rejects(read(fixture(), { maxBytes: 64 }), /完整整理范围超过预算/u)
  const duplicate = fixture(); duplicate.facts.files = [...duplicate.facts.files, structuredClone(duplicate.facts.files[0]!)]
  await assert.rejects(read(duplicate), /原作者事实/u)
  const absent = fixture(0); absent.group.rejectedFiles = [{ relative: '合成目录/不存在.flac', revision: 'rejected-1' }]
  await assert.rejects(read(absent), /已变化/u)
  const outside = fixture(); outside.facts.files[0]!.currentRelative = '../outside.flac'
  await assert.rejects(read(outside), /原作者事实/u)
})

test('原CUE声明与实际asset绑定独立读取；纯事实不冒称已实读PCM或生成分轨', async () => {
  const f = fixture(), primary = f.group.members[0]!.fact.summary.asset, scan = f.facts.files[0]!
  const reference = { assetId: primary.id, libraryRootId: primary.libraryRootId, sourceRootId: primary.sourceRootId, rootRevision: primary.rootRevision,
    fileRevision: primary.fileRevision, locationRevision: primary.locationRevision, relative: scan.currentRelative, signature: scan.value.signature }
  const parsed = parseCueText('FILE "Track0.flac" WAVE\nTRACK 01 AUDIO\nINDEX 01 00:00:00\nTRACK 02 AUDIO\nINDEX 01 00:01:00\n', new Map([['Track0.flac', [reference]]]))
  if (parsed.status !== 'ok') assert.fail('合成CUE解析失败')
  f.facts.cues = [{ id: cueId, sidecarId: uuid(5), libraryRootId: f.root.id, sourceRootId: f.root.sourceRootId, rootRevision: f.root.revision,
    item: { relative: '合成目录/all.cue', signature: '1:2:3:4:5', parserVersion: 'cue-text-75fps/mbrs003-v1', outcome: 'accepted', failureCode: null,
      reused: false, previousSnapshotId: null, result: parsed } }]
  assert.ok(dto.isLocalCuePreparedItem(f.facts.cues[0]!.item))
  f.group.issues = [{ kind: 'cue', relative: '合成目录/all.cue', status: 'ready' }]
  const { service, result, reference: selected } = await read(f)
  assert.equal(result.albums[0]?.cueSheets[0]?.eligible, true)
  const captured = await service.resolveCueFacts({ ...selected, cueId })
  if (captured.parsed.status !== 'ok') assert.fail('未返回实际CD75事实')
  assert.equal(captured.parsed.tracks[1]?.index01Frames, 75); assert.equal(captured.parsed.tracks[1]?.endFrames, null)
  assert.equal(captured.parsed.tracks[1]?.playback, 'NOT_VERIFIED'); assert.equal('relative' in captured.parsed.tracks[0]!.assetReference, false)
  assert.equal(primary.sampleFrames, null)
})

test('离线仍回读原事实，名称请求明确不可用；错误引用不变为新捕获', async () => {
  const f = fixture(); f.offline()
  const { service, result, reference } = await read(f)
  assert.equal(result.albums[0]?.availability, 'offline')
  await assert.rejects(service.prepareNameSuggestion({ ...reference, backend: 'cloud' }), /离线或不可读/u)
  await assert.rejects(service.resolveCapture({ ...reference, datasetId: 'other-dataset' }), /不属于/u)
  await assert.rejects(service.resolveCapture({ ...reference, capture: { ...reference.capture, albumId: 'other-album' } }), /已过期/u)
  assert.equal(service.inspect().preparations, 0)
})

test('封面预览只冻结真实规范副本，无发行先预览；零Track或本地来源无原identity阻断', async () => {
  const bytes = readFileSync(new URL('./fixtures/mbrs012-source/owned-cover-16.jpg', import.meta.url)), hash = createHash('sha256').update(bytes).digest('hex')
  const original = readFileSync(new URL('./fixtures/mbrs012-source/owned-cover-32.jpg', import.meta.url)), originalHash = createHash('sha256').update(original).digest('hex')
  const artwork = { albumId: 'album-a', candidateId: 'image-a', revision: 'image-1', origin: 'manual' as const, sourceLabel: '合成自选图片', licenseLabel: '合成自有测试图',
    originalBase64: original.toString('base64'),
    image: { original: { mime: 'image/jpeg' as const, bytes: original.length, sha256: originalHash, width: 32, height: 32 },
      display: { mime: 'image/jpeg' as const, bytes: bytes.length, sha256: hash, width: 16, height: 16, dataUrl: 'data:image/jpeg;base64,' + bytes.toString('base64') } } }
  const { service, reference } = await read(fixture()), resolved = await service.resolveCapture(reference)
  const plan = await service.prepareArtworkPreview({ resolved, artwork })
  assert.equal(plan.draft.state, 'ready'); assert.equal(plan.draft.relationship, 'create-on-apply'); assert.equal(plan.capture.artwork?.[0]?.image.display.sha256, hash)
  assert.equal(plan.capture.artwork?.[0]?.originalBase64, original.toString('base64')); assert.notEqual(plan.capture.artwork?.[0]?.image.original.sha256, hash)
  await assert.rejects(service.prepareArtworkPreview({ resolved, artwork: { ...artwork, originalBase64: bytes.toString('base64') } }), /封面与原专辑/u)
  assert.equal(resolved.capture.editionId, null)
  const unbound = await service.prepareArtworkPreview({ resolved, artwork: { ...artwork, origin: 'embedded' } })
  assert.equal(unbound.draft.state, 'blocked'); assert.match(unbound.draft.blockers.join(' '), /不能猜测或伪造/u)
  const empty = fixture(0); empty.rejectFile(); const zero = await read(empty)
  const zeroPlan = await zero.service.prepareArtworkPreview({ resolved: await zero.service.resolveCapture(zero.reference), artwork })
  assert.equal(zeroPlan.draft.state, 'blocked'); assert.match(zeroPlan.draft.blockers.join(' '), /没有成功音轨/u)
})


/** 426仅同一个新鲜合成SQLite和受控文本扫描输入；没有真实音乐、网络或Native许可。 */
async function runtime426(t:import('node:test').TestContext,{albums=3,rawNames,legacy=false}:{albums?:number;rawNames?:{artist:string;album:string};legacy?:boolean}={}){
  const setupStartedAt=performance.now()
  assert.ok(process.env.TMPDIR?.startsWith('/Volumes/LifeWeave/Developer/CommandLine/'))
  const directory=await mkdtemp(path.join(process.env.TMPDIR!,'runtime426-'));await mkdir(directory+'/source',{mode:0o700});await mkdir(directory+'/stage',{mode:0o700})
  const datasetId=randomUUID(),file=directory+'/catalog.sqlite';let alive=true,serial=0,confirms=0,originalReads=0,watchClosed=0,active=true,failWatch=false
  const identity={datasetId,assertCurrent(){assert.ok(alive)}}
  let repository=createCollectionRepository({filePath:file,stagingRoot:directory+'/stage'});repository.localCatalog.privateBindWorkbenchDataset(identity)
  const capability=await authorizeSourceDirectory(directory+'/source'),commandId=randomUUID(),source=repository.sources.authorize(commandId,capability)
  const root=repository.localCatalog.registerRoot({commandId,sourceRootId:source.id,role:'library'})
  const originals:{relative:string;bytes:Buffer}[]=[],items:ScanPreparedItem[]=[]
  for(let i=0;i<albums;i++){
    await mkdir(directory+'/source/专辑'+i,{mode:0o700});const relative='专辑'+i+'/原音轨.flac',bytes=Buffer.from('不可播放的合成原文件-'+i);await writeFile(directory+'/source/'+relative,bytes,{flag:'wx',mode:0o600});originals.push({relative,bytes})
    const info=await stat(directory+'/source/'+relative,{bigint:true});items.push({relative,signature:[info.dev,info.ino,info.size,info.mtimeNs,info.ctimeNs].join(':'),parserVersion:'controlled426',outcome:'accepted',fields:{title:'原标题'+i,artist:rawNames?.artist??'原作者',album:rawNames?.album??'原专辑'+i,track:'1'},failureCode:null,reused:false,readFacts:structuredClone(metadataFacts)})
  }
  const started=repository.localScan.start({commandId:randomUUID(),datasetId,libraryRootId:root.id,expectedRootRevision:root.revision,parserVersion:'controlled426'}).job
  let running=repository.localScan.resume({commandId:randomUUID(),jobId:started.jobId,expectedRevision:started.jobRevision})
  const settings=repository.localCatalog.privateScanSettingsStore(identity)
  settings.freeze(identity,{schema:1,datasetId,eventId:randomUUID(),commandId:randomUUID(),kind:'launch',frozen:{jobId:running.jobId,settingsRevision:'1',albumConcurrency:12,readerConcurrency:1}})
  for(let offset=0;offset<items.length;offset+=200){const selected=items.slice(offset,offset+200),last=offset+selected.length===items.length
    const batch={batchId:randomUUID(),jobId:running.jobId,expectedJobRevision:running.jobRevision,checkpointBefore:running.checkpointRef,items:selected,frontier:last?[]:['剩余合成目录'],completed:last}
    repository.localScan.privatePrepareBatch({commandId:randomUUID(),jobId:running.jobId,batch});running=repository.localScan.privateCommitBatch({commandId:randomUUID(),jobId:running.jobId,batchId:batch.batchId,expectedRevision:running.jobRevision})
  }
  const watched=new Set<string>(),events:string[]=[],originalImport=new Map<string,{request:dto.LocalLibraryManagementPayloads['library.import.confirm'];root:dto.LibraryRoot}>()
  function scope(){return {revision:localLibraryManagementDigest([datasetId,repository.localCatalog.privateAlbumBrowserRevision(),repository.localScan.privateAlbumBrowserRevision(),null]),roots:[{root:repository.localCatalog.root(root.id),label:'原合成库',availability:'ONLINE' as const}]}}
  let workbench:ReturnType<typeof createLocalWorkbenchReadService>,completed:ReturnType<typeof createCompletedScanSnapshotView>,runtime:ReturnType<typeof createLocalLibraryManagementRuntime>
  function options(overrides:Partial<LocalLibraryManagementRuntimeOptions>={}):LocalLibraryManagementRuntimeOptions {
    return {identity,catalog:repository.localCatalog,localScan:repository.localScan,workbench,localAlbums:{queryAlbums(request){events.push('query:'+request.offset);return repository.localCatalog.privateAlbumBrowserQuery(request,scope())}},
      readRootViews:async()=>scope().roots,assertAccepting(){assert.ok(active)},completedSnapshots:completed,
      imports:{async prepare(){return {choiceId:'approved-choice',label:'原合成库',suggestedRole:'catalog',evidence:['受控目录审批；不是Main真实授权']}}
        ,async confirm(request){confirms++;events.push('confirm');const saved=repository.localCatalog.privateLibraryManagementRead(identity,'operation',request.commandId);assert.deepEqual(saved?.record.original,{command:'library.import.confirm',request});assert.equal(saved?.record.receipt.state,'running');
          // 原已登记root的合成审批，真新目录路径在426a以同command注册另行覆盖。
          originalImport.set(request.commandId,{request:structuredClone(request),root});return root},async readOriginal(commandId){originalReads++;events.push('read-original');const found=originalImport.get(commandId);return found?{original:{command:'library.import.confirm',request:structuredClone(found.request)},root:found.root,state:'succeeded'}:null}},
      watch:{async enable(id){events.push('enable');if(failWatch)throw new Error('受控READY失联');watched.add(id)},async disable(id){events.push('disable');watched.delete(id);return null},async remove(id){events.push('remove');watched.delete(id);return null},watching:id=>watched.has(id),async close(){watchClosed++;watched.clear()}},
      activateSnapshot:async(_id,value)=>{events.push('activate-snapshot');assert.equal(value.snapshot.job.phase,'completed')},
      // 本fixture只有受控watch状态与真实in-memory read leases，没有Main/Native/FD或physicalClosed回声。
      // 该组件作者核原running事务，再释放自己实际持有的状态；不用于正式Owner资源join资格。
      async removeResources(libraryId,context,removingLibraries,original){
        identity.assertCurrent();assert.equal(context.signal?.aborted??false,false)
        assert.equal(libraryId,root.id);assert.deepEqual(removingLibraries,[root.id])
        const saved=repository.localCatalog.privateLibraryManagementRead(identity,'operation',original.commandId)
        assert.ok(saved&&saved.record.kind==='operation');const operation=saved.record
        assert.equal(operation.revision,1);assert.equal(operation.receipt.state,'running');assert.equal(operation.originalSha256,original.originalSha256)
        assert.deepEqual(operation.original,{command:'library.remove',request:{commandId:original.commandId,libraryIds:[...removingLibraries]}})
        events.push('remove');watched.delete(libraryId);workbench.invalidateRoot(libraryId)
        identity.assertCurrent()
      },...overrides}
  }
  function assemble(overrides:Partial<LocalLibraryManagementRuntimeOptions>={}){
    workbench=createLocalWorkbenchReadService({datasetId,repository,assertCurrent:()=>identity.assertCurrent(),readRootViews:async()=>scope().roots,
      makeReadToken:()=>uuid(900000+(++serial)),localAlbums:{inspectAlbum(request){const members=repository.localCatalog.privateAlbumBrowserMembers({albumKey:request.albumKey,rootId:request.rootId,offset:0,limit:200},scope()),issues=repository.localCatalog.privateAlbumBrowserIssues({albumKey:request.albumKey,rootId:request.rootId,offset:0,limit:200},scope());assert.equal(members.items.length,members.total);return {summary:members.album,members:members.items,directory:members.directory,issues:issues.items,rejectedFiles:issues.rejectedFiles}}}})
    completed=createCompletedScanSnapshotView({repository,identity});runtime=createLocalLibraryManagementRuntime(options(overrides))
  }
  assemble()
  // 原已存在SQL库的历史绑定（不是本测试从typed UUID新授根许可）。
  const operation:LocalLibraryManagementOperationRecord={schema:1,kind:'operation',datasetId,key:commandId,revision:1,original:{command:'library.import.confirm',request:{commandId,choiceId:'controlled-original-choice',role:'catalog'}},originalSha256:'',receipt:{commandId,kind:'library.import.confirm',state:'succeeded',libraryIds:[root.id],message:null}}
  operation.originalSha256=localLibraryManagementDigest(operation.original)
  const binding:LocalLibraryManagementBindingRecord={schema:1,kind:'binding',datasetId,key:root.id,revision:1,libraryId:root.id,sourceRootId:source.id,rootRevision:root.revision,role:'catalog',name:'原合成库',active:true,watchEnabled:false,operationId:commandId}
  if(!legacy)repository.localCatalog.privateLibraryManagementCompareAndSwap(identity,[{record:binding,expectedRevision:null},{record:operation,expectedRevision:null}])
  async function stop(){await runtime.close();workbench.close();completed.close();if(alive){repository.close();alive=false}}
  async function cold(overrides:Partial<LocalLibraryManagementRuntimeOptions>={}){const startedAt=performance.now();await stop();repository=createCollectionRepository({filePath:file,stagingRoot:directory+'/stage'});alive=true;repository.localCatalog.privateBindWorkbenchDataset(identity);assemble(overrides);console.log(JSON.stringify({diagnostic:'426-cold',albums,durationMs:performance.now()-startedAt}))}
  t.after(async()=>{await stop();for(const value of originals)assert.deepEqual(await readFile(directory+'/source/'+value.relative),value.bytes)})
  console.log(JSON.stringify({diagnostic:'426-fixture-setup',albums,durationMs:performance.now()-setupStartedAt}))
  return {root,source,identity,directory,file,originals,events,commandId,options,cold,stop,get runtime(){return runtime},get workbench(){return workbench},get completed(){return completed},get repository(){return repository},get confirms(){return confirms},get originalReads(){return originalReads},get watchClosed(){return watchClosed},failWatch(){failWatch=true},inactive(){active=false}}
}
const original426=async(f:Awaited<ReturnType<typeof runtime426>>)=>{
  const startedAt=performance.now(),capture=await f.runtime.execute('library.capture',{libraryIds:[f.root.id]}),record=f.repository.localCatalog.privateLibraryManagementRead(f.identity,'capture',capture.captureId)!.record
  console.log(JSON.stringify({diagnostic:'426-library-capture-call',albums:record.original.albums.length,durationMs:performance.now()-startedAt,captureId:capture.captureId,wholeCaptureDurable:true}));return {capture,record}
}
test('名称查询462：同SQL原捕获提供原始与清洗名称，暖冷只读不改源字段且闭集拒额外/getter',async t=>{
  const raw={artist:'原作者 [FLAC]',album:'原专辑 [FLAC]'},f=await runtime426(t,{albums:1,rawNames:raw});
  const query=()=>f.repository.localCatalog.privateAlbumBrowserQuery({rootId:f.root.id,query:'',filter:'all',offset:0,limit:1},{revision:localLibraryManagementDigest([f.identity.datasetId,f.repository.localCatalog.privateAlbumBrowserRevision(),f.repository.localScan.privateAlbumBrowserRevision(),null]),roots:[{root:f.root,label:'原合成库',availability:'ONLINE'}]}).items[0]!;
  const album=query(),before=f.repository.localCatalog.metadata(album.representativeTrackId!),request={albumId:album.id,rootId:f.root.id,revision:album.revision};
  const result=await f.runtime.execute('library.album.capture',request),names={original:{artist:raw.artist,title:raw.album},cleaned:{artist:'原作者',title:'原专辑'}};
  assert.deepEqual(result.albums[0]!.searchNames,names);assert.ok(dto.isLocalWorkbenchReadback(result));assert.deepEqual(f.repository.localCatalog.metadata(album.representativeTrackId!),before);
  const bad=structuredClone(result);bad.albums[0]!.searchNames={...names,sourcePath:'/不能公开的路径'} as typeof names;assert.equal(dto.isLocalWorkbenchReadback(bad),false);
  let gets=0;const dangerous=structuredClone(result);Object.defineProperty(dangerous.albums[0]!.searchNames!.original,'title',{enumerable:true,get(){gets++;return raw.album;}});assert.equal(dto.isLocalWorkbenchReadback(dangerous),false);assert.equal(gets,0);
  await f.cold();const current=query(),cold=await f.runtime.execute('library.album.capture',{albumId:current.id,rootId:f.root.id,revision:current.revision});assert.deepEqual(cold.albums[0]!.searchNames,names);assert.deepEqual(f.repository.localCatalog.metadata(album.representativeTrackId!),before);
  for(const original of f.originals)assert.deepEqual(await readFile(f.directory+'/source/'+original.relative),original.bytes);
});

test('426管理read真实SQL计数和role，watch实际READY与持久意图区分，移除不删除源',async t=>{
  const f=await runtime426(t),read=await f.runtime.execute('library.read',{});assert.equal(read.libraries[0]?.role,'catalog');assert.equal(read.libraries[0]?.totalAlbums,3);assert.equal(read.libraries[0]?.totalTracks,3);assert.equal(read.libraries[0]?.scanState,'complete');assert.equal(read.scanConcurrency,12)
  const watch={commandId:randomUUID(),libraryId:f.root.id,enabled:true};assert.equal((await f.runtime.execute('library.watch.set',watch)).state,'succeeded');assert.equal((await f.runtime.execute('library.read',{})).libraries[0]?.watching,true)
  const rename={commandId:randomUUID(),libraryId:f.root.id,name:'原命令命名'};await f.runtime.execute('library.rename',rename);assert.equal((await f.runtime.execute('library.read',{})).libraries[0]?.label,rename.name)
  await assert.rejects(f.runtime.execute('library.rename',{...rename,name:'换body'}));assert.equal((await f.runtime.execute('library.operation.read',{commandId:rename.commandId}))?.state,'succeeded')
  await f.runtime.execute('library.settings.save',{commandId:randomUUID(),scanConcurrency:24});assert.equal((await f.runtime.execute('library.settings.read',{})).scanConcurrency,24)
  const removed=await f.runtime.execute('library.remove',{commandId:randomUUID(),libraryIds:[f.root.id]});assert.equal(removed.state,'succeeded');assert.ok(f.events.includes('remove'));assert.equal((await f.runtime.execute('library.read',{})).libraries.length,0)
  assert.equal(f.repository.localCatalog.root(f.root.id).sourceRootId,f.source.id);assert.equal(f.repository.localCatalog.queryTracks({rootId:f.root.id,query:'',offset:0,limit:1}).total,3)
})
test('426完整库capture跨SQL全部页且不预开UI leases，原lyrics范围冷回读与惰性单token',async t=>{
  const f=await runtime426(t,{albums:201});let heartbeat=false;setImmediate(()=>{heartbeat=true});const {capture,record}=await original426(f);assert.equal(heartbeat,true,'完整库循环必须真实让步控制端口，不能只排已完成Promise微任务')
  assert.equal(record.original.albumRefs.length,201);assert.equal(record.original.albums.length,201);assert.ok(f.events.includes('query:200'));assert.equal(f.workbench.inspect().captures,0)
  const library=capture.lyricsLibraries[0]!,proof=await f.runtime.lyricsLibraryAuthor.capture(library),first=await f.runtime.lyricsLibraryAuthor.page(proof,null)
  assert.equal(first.scopes.length,200);assert.equal(first.total,201);assert.equal(first.watermark,record.original.watermark);assert.equal(f.workbench.inspect().captures,0)
  const last=await f.runtime.lyricsLibraryAuthor.page(proof,first.next);assert.equal(last.scopes.length,1);assert.equal(last.next,null)
  const scope=last.scopes[0]!,frozen=await f.runtime.readFrozenAlbum(scope),token=await f.runtime.lyricsLibraryAuthor.resolveAlbumReadToken(scope)
  assert.equal(token,frozen.resolved.capture.readToken);assert.equal(f.workbench.inspect().captures,1);const live=await f.workbench.resolveCapture({datasetId:f.identity.datasetId,capture:{albumId:scope.albumId,readToken:token}});assert.equal(live.datasetRevision,frozen.resolved.datasetRevision,'纯capture/control账本不推进媒体水位');assert.deepEqual(live,frozen.resolved)
  await assert.rejects(f.runtime.lyricsLibraryAuthor.assertCurrent({...proof,authorityRef:{}}));await f.cold()
  const coldReadStart=performance.now(),restored=await f.runtime.readFrozenAlbum(scope);console.log(JSON.stringify({diagnostic:'426-cold-frozen-read',albums:201,durationMs:performance.now()-coldReadStart,originalCaptureId:scope.captureId}));assert.deepEqual(restored.resolved,frozen.resolved);assert.equal(restored.captureRecord.originalSha256,record.originalSha256)
  await assert.rejects(f.runtime.readFrozenAlbum({...scope,libraryId:randomUUID()}));await assert.rejects(f.runtime.readFrozenAlbum({...scope,datasetId:randomUUID()}))
})
test('426UI原readToken完整持久，纯ledger水位不换token而外部成员与元数据变化拒绝',async t=>{
  const f=await runtime426(t),ref=f.repository.localCatalog.privateAlbumBrowserQuery({rootId:f.root.id,query:'',filter:'all',offset:0,limit:1},{revision:localLibraryManagementDigest([f.identity.datasetId,f.repository.localCatalog.privateAlbumBrowserRevision(),f.repository.localScan.privateAlbumBrowserRevision(),null]),roots:[{root:f.root,label:'原合成库',availability:'ONLINE'}]}).items[0]!
  const read=await f.runtime.execute('library.album.capture',{albumId:ref.id,rootId:f.root.id,revision:ref.revision}),token=read.albums[0]!.capture.readToken
  const scope={datasetId:f.identity.datasetId,libraryId:f.root.id,albumId:ref.id,captureId:token},saved=await f.runtime.readFrozenAlbum(scope)
  assert.equal(saved.resolved.capture.readToken,token);await f.runtime.rememberAlbumReadback(read)
  assert.equal(await f.runtime.lyricsLibraryAuthor.resolveAlbumReadToken(scope),token);await f.cold();assert.deepEqual((await f.runtime.readFrozenAlbum(scope)).resolved,saved.resolved)
  const current=saved.resolved.group.members[0]!.fact.summary.track.id
  f.repository.localCatalog.overrideMetadata({commandId:randomUUID(),trackId:current,expectedRevision:null,fields:{artist:'外部作者改动'}})
  await assert.rejects(f.runtime.lyricsLibraryAuthor.resolveAlbumReadToken(scope),/变化/u)
  assert.equal((await f.runtime.readFrozenAlbum(scope)).captureRecord.originalSha256,saved.captureRecord.originalSha256)
})
test('426无实际执行作者不写queued，原cap选择不会换成新分页或被已撤库复用',async t=>{
  const f=await runtime426(t),{capture,record}=await original426(f),commandId=randomUUID()
  await assert.rejects(f.runtime.execute('library.ai.start',{commandId,captureId:capture.captureId,backend:'ollama',selection:'selected',albumIds:[record.original.albumRefs[0]!.albumId]}),/未装配/u)
  assert.equal(f.repository.localCatalog.privateLibraryManagementRead(f.identity,'job',commandId),null)
  const {removeResources:_componentRemove,watch:_componentWatch,...withoutJoin}=f.options(),missingJoin=createLocalLibraryManagementRuntime(withoutJoin),missingCommand=randomUUID()
  try{
    await assert.rejects(missingJoin.execute('library.remove',{commandId:missingCommand,libraryIds:[f.root.id]}),/join作者未装配/u)
    assert.equal(f.repository.localCatalog.privateLibraryManagementRead(f.identity,'operation',missingCommand),null)
    assert.equal(f.repository.localCatalog.privateLibraryManagementRead(f.identity,'binding',f.root.id)?.record.active,true)
  }finally{await missingJoin.close()}
  await f.runtime.execute('library.remove',{commandId:randomUUID(),libraryIds:[f.root.id]});await assert.rejects(f.runtime.lyricsLibraryAuthor.capture(capture.lyricsLibraries[0]!));await assert.rejects(f.runtime.execute('library.capture',{libraryIds:[f.root.id]}))
})
test('426真实异步job停止先abort再join，原stop/selection冷恢复，resume不改start',async t=>{
  const f=await runtime426(t),{capture,record}=await original426(f);await f.runtime.close()
  let entered!:()=>void,release!:()=>void;const reached=new Promise<void>(r=>{entered=r}),finish=new Promise<void>(r=>{release=r});let prepares=0,joins=0,aborted=false
  const jobs:LocalLibraryManagementJobPort={async prepare(_input,context){prepares++;entered();context.signal!.addEventListener('abort',()=>{aborted=true},{once:true});await finish;context.signal!.throwIfAborted();return null},async run(){throw new Error('本组无写入')},async readOriginal(){return null},async join(){joins++;await finish}}
  const runtime=createLocalLibraryManagementRuntime({...f.options(),jobs}),albumId=record.original.albumRefs[0]!.albumId,request={commandId:randomUUID(),captureId:capture.captureId,backend:'ollama' as const,selection:'selected' as const,albumIds:[albumId]}
  t.after(()=>runtime.close());assert.equal((await runtime.execute('library.ai.start',request)).state,'queued');await reached
  let stopped=false;const stopping=runtime.execute('library.job.stop',{jobId:request.commandId}).then(r=>{stopped=true;return r});await new Promise(r=>setImmediate(r));assert.equal(aborted,true);assert.equal(stopped,false);release();assert.equal((await stopping).state,'stopped');assert.equal(joins,2);assert.equal(prepares,1)
  const before=f.repository.localCatalog.privateLibraryManagementRead(f.identity,'job',request.commandId)!.record;assert.equal(before.original.start.request.commandId,request.commandId);assert.equal(before.checkpoint.items[0]!.state,'cancelled')
  assert.equal((await runtime.execute('library.job.resume',{jobId:request.commandId})).jobId,request.commandId);await runtime.joinJob(request.commandId);assert.equal(prepares,2)
  const after=f.repository.localCatalog.privateLibraryManagementRead(f.identity,'job',request.commandId)!.record;assert.deepEqual(after.original,before.original);assert.equal(after.checkpoint.items[0]!.state,'review');assert.equal(after.checkpoint.state,'complete')
})
test('426UNKNOWN准备与冷job只查原UUID，明确failed子集才可显式retry',async t=>{
  const f=await runtime426(t),{capture,record}=await original426(f);await f.runtime.close();let calls=0,joins=0
  const jobs:LocalLibraryManagementJobPort={async prepare(){calls++;throw new Error('受控原准备响应遗失')},async run(){throw new Error('不能写')},async readOriginal(){return null},async join(){joins++}}
  const runtime=createLocalLibraryManagementRuntime({...f.options(),jobs}),request={commandId:randomUUID(),captureId:capture.captureId,backend:'ollama' as const,selection:'selected' as const,albumIds:[record.original.albumRefs[0]!.albumId]};t.after(()=>runtime.close())
  await runtime.execute('library.ai.start',request);await runtime.joinJob(request.commandId);assert.equal((await runtime.execute('library.job.read',{jobId:request.commandId,offset:0,limit:200}))?.state,'unknown');assert.equal(calls,1)
  await assert.rejects(runtime.execute('library.job.retry',{jobId:request.commandId,albumIds:request.albumIds}));await runtime.execute('library.ai.start',request);assert.equal(calls,1);assert.equal(joins,1)
  await assert.rejects(runtime.execute('library.ai.start',{...request,backend:'cloud'}));await runtime.close();await f.cold({jobs})
  assert.equal((await f.runtime.execute('library.job.read',{jobId:request.commandId,offset:0,limit:200}))?.state,'unknown');assert.equal(calls,1)
})
test('426最近完成快照实际保存并独立retry，失败watch不伪READY，原操作只查不重发',async t=>{
  const f=await runtime426(t);const job=f.repository.localScan.page(f.identity.datasetId,{offset:0,limit:200}).items[0]!
  assert.equal(f.completed.captureCompleted(job.jobId).status,'ready')
  const load=await f.runtime.execute('library.snapshot.load',{commandId:randomUUID(),libraryId:f.root.id});assert.equal(load.state,'succeeded');assert.ok(f.events.includes('activate-snapshot'))
  f.failWatch();const watch={commandId:randomUUID(),libraryId:f.root.id,enabled:true};const original=await f.runtime.execute('library.watch.set',watch);assert.equal(original.state,'unknown')
  assert.deepEqual(await f.runtime.execute('library.watch.set',watch),original);assert.equal(f.events.filter(e=>e==='enable').length,1);assert.equal((await f.runtime.execute('library.read',{})).libraries[0]!.watching,false)
  await assert.rejects(f.runtime.execute('library.watch.set',{...watch,enabled:false}));assert.deepEqual(await f.runtime.execute('library.operation.read',{commandId:watch.commandId}),original)
})

test('426原UI读取惰性lease沿原token准备名称，全局账本变化不洗白目标字段变化',async t=>{
  const f=await runtime426(t),{capture,record}=await original426(f),album=record.original.albums[0]!,scope={datasetId:f.identity.datasetId,libraryId:f.root.id,albumId:album.resolved.capture.albumId,captureId:capture.captureId}
  const token=await f.runtime.lyricsLibraryAuthor.resolveAlbumReadToken(scope),reference={datasetId:f.identity.datasetId,capture:{albumId:scope.albumId,readToken:token},backend:'ollama' as const}
  const prepared=await f.workbench.prepareNameSuggestion(reference);assert.ok(prepared.preparationId)
  const result=await f.workbench.completeNameSuggestion(prepared.preparationId,{backend:'ollama',content:modelContent});assert.equal(result.status,'ready')
  const saved=await f.runtime.readFrozenAlbum(scope);assert.equal(saved.resolved.capture.readToken,token);assert.equal(saved.captureRecord.originalSha256,record.originalSha256)
  const unrelated=record.original.albums[1]!.resolved.group.members[0]!.fact.summary.track.id
  f.repository.localCatalog.overrideMetadata({commandId:randomUUID(),trackId:unrelated,expectedRevision:null,fields:{artist:'其它专辑实际变化'}})
  assert.equal(await f.runtime.lyricsLibraryAuthor.resolveAlbumReadToken(scope),token)
  f.repository.localCatalog.overrideMetadata({commandId:randomUUID(),trackId:album.resolved.group.members[0]!.fact.summary.track.id,expectedRevision:null,fields:{album:'目标外部变化'}})
  await assert.rejects(f.runtime.lyricsLibraryAuthor.resolveAlbumReadToken(scope),/变化/u)
})
test('426明确failed仅重试原failed子集，原job/selection保持且成功或review不重跑',async t=>{
  const f=await runtime426(t),{capture,record}=await original426(f);await f.runtime.close();const seen:string[]=[],first=record.original.albumRefs[0]!.albumId,second=record.original.albumRefs[1]!.albumId
  const jobs:LocalLibraryManagementJobPort={async prepare(input){seen.push(input.selection.albumId);if(input.selection.albumId===first&&input.action===null)throw new LocalWorkbenchPlanError('CHANGED','原准备明确拒绝');return null},async run(){throw new Error('本组无Source写入')},async readOriginal(){return null},async join(){}}
  const runtime=createLocalLibraryManagementRuntime({...f.options(),jobs}),request={commandId:randomUUID(),captureId:capture.captureId,backend:'ollama' as const,selection:'selected' as const,albumIds:[first,second]};t.after(()=>runtime.close())
  await runtime.execute('library.ai.start',request);await runtime.joinJob(request.commandId)
  const before=f.repository.localCatalog.privateLibraryManagementRead(f.identity,'job',request.commandId)!.record;assert.deepEqual(before.checkpoint.items.map(i=>i.state),['failed','review'])
  await assert.rejects(runtime.execute('library.job.retry',{jobId:request.commandId,albumIds:[second]}))
  await runtime.execute('library.job.retry',{jobId:request.commandId,albumIds:[first]});await runtime.joinJob(request.commandId)
  const after=f.repository.localCatalog.privateLibraryManagementRead(f.identity,'job',request.commandId)!.record;assert.deepEqual(after.original,before.original);assert.deepEqual(seen,[first,second,first]);assert.equal(after.checkpoint.state,'complete')
})
test('426import副作用前原body落账，确认失联冷只读原Root回执且不重发审批',async t=>{
  const f=await runtime426(t);await f.runtime.close();const sourceDirectory=f.directory+'/approved';await mkdir(sourceDirectory,{mode:0o700});const approved=await authorizeSourceDirectory(sourceDirectory);let confirms=0,reads=0
  const imports:NonNullable<LocalLibraryManagementRuntimeOptions['imports']>={async prepare(){return {choiceId:'actual-controlled-choice',label:'受控批准目录',suggestedRole:'album',evidence:[]}},async confirm(request){confirms++;const op=f.repository.localCatalog.privateLibraryManagementRead(f.identity,'operation',request.commandId)!;assert.deepEqual(op.record.original.request,request);assert.deepEqual(op.record.receipt.libraryIds,[])
    const source=f.repository.sources.authorize(request.commandId,approved);f.repository.localCatalog.registerRoot({commandId:request.commandId,sourceRootId:source.id,role:'library'});throw new Error('实际注册后响应遗失')},async readOriginal(commandId){reads++;const op=f.repository.localCatalog.privateLibraryManagementRead(f.identity,'operation',commandId),rootReceipt=f.repository.localCatalog.receipt(commandId),source=f.repository.sources.rootReceipt(commandId)
    if(!op||op.record.original.command!=='library.import.confirm'||!rootReceipt||rootReceipt.operation!=='register-root'||!dto.isLibraryRoot(rootReceipt.result)||rootReceipt.result.sourceRootId!==source?.id)return null
    return {original:op.record.original,root:rootReceipt.result,state:'succeeded'}}}
  let runtime=createLocalLibraryManagementRuntime({...f.options(),imports}),request={commandId:randomUUID(),choiceId:'actual-controlled-choice',role:'album' as const};t.after(()=>runtime.close())
  assert.equal((await runtime.execute('library.import.confirm',request)).state,'unknown');assert.equal(confirms,1);await runtime.close();await f.cold({imports});runtime=f.runtime
  const actual=await runtime.execute('library.operation.read',{commandId:request.commandId});assert.equal(actual?.state,'succeeded');assert.equal(confirms,1);assert.equal(reads,1)
  assert.equal(f.repository.localCatalog.privateLibraryManagementRead(f.identity,'binding',actual!.libraryIds[0]!)?.record.role,'album')
  await assert.rejects(runtime.execute('library.import.confirm',{...request,role:'catalog'}));assert.equal(confirms,1)
})

test('426完整edition新增未列目录成员拒绝，背景capture让步后原abort不落半原件',async t=>{
  const f=await runtime426(t),all=await original426(f),a=all.record.original.albums[0]!.resolved.group.members[0]!.fact.summary.track.id,b=all.record.original.albums[1]!.resolved.group.members[0]!.fact.summary.track.id,c=all.record.original.albums[2]!.resolved.group.members[0]!.fact.summary.track.id
  const edition=f.repository.localCatalog.createEdition({commandId:randomUUID(),title:'原完整发行',edition:'原版'})
  f.repository.localCatalog.linkEditionTrack({commandId:randomUUID(),editionId:edition.id,trackId:a,disc:1,trackNumber:1,sequence:1})
  f.repository.localCatalog.linkEditionTrack({commandId:randomUUID(),editionId:edition.id,trackId:b,disc:1,trackNumber:2,sequence:2})
  const {capture,record}=await original426(f),captured=record.original.albums.find(a=>a.resolved.group.summary.editionId===edition.id)!;assert.equal(captured.resolved.group.members.length,2)
  const scope={datasetId:f.identity.datasetId,libraryId:f.root.id,albumId:captured.resolved.capture.albumId,captureId:capture.captureId}
  f.repository.localCatalog.linkEditionTrack({commandId:randomUUID(),editionId:edition.id,trackId:c,disc:1,trackNumber:3,sequence:3})
  await assert.rejects(f.runtime.readFrozenAlbum(scope),/变化/u)
  await f.runtime.close();const key='cancelled-whole-capture',runtime=createLocalLibraryManagementRuntime({...f.options(),makeCaptureId:()=>key});t.after(()=>runtime.close())
  const signal=new AbortController();setImmediate(()=>signal.abort());await assert.rejects(runtime.execute('library.capture',{libraryIds:[f.root.id]},{signal:signal.signal}),/取消/u)
  assert.equal(f.repository.localCatalog.privateLibraryManagementRead(f.identity,'capture',key),null)
})

/** 441模拟已持久但进程不在本实例的原任务；全部capture和checkpoint均经真实同SQLite codec/CAS冷验。 */
function receipt441(request:Readonly<dto.LocalWorkbenchApplyRequest>,plan:Readonly<dto.LocalWorkbenchPlan>,state:'failed'|'succeeded'|'unknown'):dto.LocalWorkbenchReceipt {
  const receipt:dto.LocalWorkbenchReceipt={commandId:request.commandId,datasetId:request.datasetId,planId:request.planId,planHash:request.planHash,state,
    items:plan.items.map(item=>({itemId:item.itemId,albumId:item.albumId,label:item.label,state:state==='succeeded'?'applied':state==='failed'?'failed':'unknown',message:null})),message:null}
  assert.equal(dto.isLocalWorkbenchReceipt(receipt),true)
  return receipt
}
async function registry441(f:Awaited<ReturnType<typeof runtime426>>,state:'failed'|'succeeded'|'unknown'){
  return createLocalWorkbenchPlanRegistry({datasetId:f.identity.datasetId,persistence:createLocalWorkbenchOwnerPersistence(f.identity.datasetId,f.repository.localCatalog),
    writer:{async revalidate(){return {valid:true}},async apply(request,plan){return receipt441(request,plan,state)},async readOriginalReceipt(){return null}}})
}
async function issue441(registry:Awaited<ReturnType<typeof registry441>>,capture:Readonly<LocalLibraryManagementCaptureRecord>,albumId:string,blocked=false){
  const original=capture.original.albums.find(a=>a.resolved.capture.albumId===albumId)!.resolved,album=original.capture
  const plan=await registry.issuePlan({kind:'ai',scope:'MB_ONLY',candidateIds:[randomUUID()],albumIds:[albumId],state:blocked?'blocked':'ready',blockers:blocked?['合成原作者明确未派发']:[],
    items:[{itemId:randomUUID(),albumId,label:'合成原名候选',changes:[{field:'artist',before:album.artistName,after:album.artistName,reason:'受控原作者验证原名不变'}]}]},{datasetId:capture.datasetId,datasetRevision:original.datasetRevision,albums:[structuredClone(album)]})
  const request:dto.LocalWorkbenchApplyRequest={commandId:randomUUID(),datasetId:plan.datasetId,planId:plan.planId,expectedRevision:plan.revision,planHash:plan.planHash,contextFingerprint:plan.contextFingerprint,kind:plan.kind}
  return {plan,request}
}
async function coldJob441(f:Awaited<ReturnType<typeof runtime426>>,capture:Readonly<LocalLibraryManagementCaptureRecord>,state:LocalLibraryManagementJobRecord['checkpoint']['state'],pending:'unknown'|'running'|'queued'|'review',pendingIndex=1,firstCancelled=false):Promise<Readonly<LocalLibraryManagementJobRecord>> {
  const commandId=randomUUID(),refs=capture.original.albumRefs
  assert.ok(refs.length>pendingIndex)
  const start:LocalLibraryManagementJobRecord['original']['start']={command:'library.ai.start',request:{commandId,captureId:capture.key,backend:'ollama',selection:'selected',albumIds:refs.map(r=>r.albumId)}}
  const original:LocalLibraryManagementJobRecord['original']={start,startSha256:localLibraryManagementDigest(start),captureId:capture.key,captureSha256:capture.originalSha256,expandedSelection:refs.map(r=>({...r,cueId:null}))}
  let record:LocalLibraryManagementJobRecord={schema:1,kind:'job',datasetId:f.identity.datasetId,key:commandId,revision:1,original,originalSha256:localLibraryManagementDigest(original),
    checkpoint:{state:'queued',action:null,items:refs.map(r=>({albumId:r.albumId,state:'queued',message:null,planId:null,commandId:null,receipt:null}))}}
  f.repository.localCatalog.privateLibraryManagementCompareAndSwap(f.identity,[{record,expectedRevision:null}])
  const registry=await registry441(f,'unknown'),first=firstCancelled?null:await issue441(registry,capture,refs[0]!.albumId,true),last=pending==='unknown'?await issue441(registry,capture,refs[pendingIndex]!.albumId):null
  const firstReceipt=first?await registry.apply(first.request):null,lastReceipt=last?await registry.apply(last.request):null
  const items:LocalLibraryManagementJobRecord['checkpoint']['items']=refs.map((r,index)=>index===0
    ?{albumId:r.albumId,state:firstCancelled?'cancelled':'failed',message:null,planId:first?.request.planId??null,commandId:first?.request.commandId??null,receipt:firstReceipt}
    :index===pendingIndex?{albumId:r.albumId,state:pending,message:null,planId:last?.request.planId??null,commandId:last?.request.commandId??null,receipt:lastReceipt}
    :{albumId:r.albumId,state:'review',message:null,planId:null,commandId:null,receipt:null})
  if(state==='stopped'){
    record={...record,revision:2,checkpoint:{state:'running',action:null,items}}
    f.repository.localCatalog.privateLibraryManagementCompareAndSwap(f.identity,[{record,expectedRevision:1}])
  }
  const next:LocalLibraryManagementJobRecord={...record,revision:record.revision+1,checkpoint:{state,action:state==='stopped'?{command:'library.job.stop',request:{jobId:commandId}}:null,items}}
  f.repository.localCatalog.privateLibraryManagementCompareAndSwap(f.identity,[{record:next,expectedRevision:record.revision}])
  return f.repository.localCatalog.privateLibraryManagementRead(f.identity,'job',commandId)!.record
}
function inactiveJobs441(events:string[]):LocalLibraryManagementJobPort {
  return {async prepare(){events.push('prepare');return null},async run(){events.push('run');return null},async readOriginal(){events.push('read-original');return null},async join(){events.push('join')}}
}
test('441partial原job后页UNKNOWN拒绝failed子集retry，原capture及全部回执不变',async t=>{
  const f=await runtime426(t,{albums:201}),{record:capture}=await original426(f),job=await coldJob441(f,capture,'partial','unknown',200),events:string[]=[]
  await f.cold({jobs:inactiveJobs441(events)})
  const before=f.repository.localCatalog.privateLibraryManagementRead(f.identity,'job',job.key)!,original=f.repository.localCatalog.privateLibraryManagementRead(f.identity,'capture',capture.key)!,watermark=f.repository.localCatalog.privateLibraryManagementRevision(f.identity)
  const first=await f.runtime.execute('library.job.read',{jobId:job.key,offset:0,limit:200}),last=await f.runtime.execute('library.job.read',{jobId:job.key,offset:200,limit:200})
  assert.equal(first?.state,'partial');assert.equal(first?.totalAlbums,201);assert.equal(first?.items.length,200);assert.ok(first?.items.every(item=>item.state!=='unknown'))
  assert.equal(last?.items[0]?.state,'unknown');assert.equal(f.runtime.inspect().runningJobs,0)
  await assert.rejects(f.runtime.execute('library.job.retry',{jobId:job.key,albumIds:[job.checkpoint.items[0]!.albumId]}),/未确认|尚未收口/u)
  await new Promise<void>(r=>setImmediate(r))
  assert.deepEqual(events,[],'冷原job的UNKNOWN不能启动prepare/run或把空flights当join')
  assert.equal(f.runtime.inspect().runningJobs,0)
  assert.deepEqual(f.repository.localCatalog.privateLibraryManagementRead(f.identity,'job',job.key),before)
  assert.deepEqual(f.repository.localCatalog.privateLibraryManagementRead(f.identity,'capture',capture.key),original)
  assert.equal(f.repository.localCatalog.privateLibraryManagementRevision(f.identity),watermark)
  assert.deepEqual(before.record,job)
})
test('441冷UNKNOWN及同页queued running拒绝重启，stopped含UNKNOWN也不能resume',async t=>{
  const f=await runtime426(t),{record:capture}=await original426(f),events:string[]=[]
  const jobs=[]
  for(const [state,pending]of [['unknown','review'],['partial','queued'],['partial','running'],['queued','review'],['running','review']] as const)jobs.push(await coldJob441(f,capture,state,pending))
  const stopped=await coldJob441(f,capture,'stopped','unknown',1,true)
  await f.cold({jobs:inactiveJobs441(events)})
  const before=jobs.concat(stopped).map(job=>f.repository.localCatalog.privateLibraryManagementRead(f.identity,'job',job.key)),original=f.repository.localCatalog.privateLibraryManagementRead(f.identity,'capture',capture.key),watermark=f.repository.localCatalog.privateLibraryManagementRevision(f.identity)
  for(const job of jobs)await assert.rejects(f.runtime.execute('library.job.retry',{jobId:job.key,albumIds:[job.checkpoint.items[0]!.albumId]}),/未确认|尚未收口/u)
  await assert.rejects(f.runtime.execute('library.job.resume',{jobId:stopped.key}),/未确认|尚未收口/u)
  await new Promise<void>(r=>setImmediate(r));assert.deepEqual(events,[]);assert.equal(f.runtime.inspect().runningJobs,0)
  assert.deepEqual(jobs.concat(stopped).map(job=>f.repository.localCatalog.privateLibraryManagementRead(f.identity,'job',job.key)),before)
  assert.deepEqual(f.repository.localCatalog.privateLibraryManagementRead(f.identity,'capture',capture.key),original)
  assert.equal(f.repository.localCatalog.privateLibraryManagementRevision(f.identity),watermark)
})
test('441明确failed实际join收口后可重试原job，未重试成功回执和全选择不变',async t=>{
  const f=await runtime426(t),{capture,record}=await original426(f),first=record.original.albumRefs[0]!.albumId,second=record.original.albumRefs[1]!.albumId,events:string[]=[]
  let release!:()=>void,reached!:()=>void;const joined=new Promise<void>(r=>{release=r}),entered=new Promise<void>(r=>{reached=r});let joins=0
  await f.cold();const originals=new Map<string,dto.LocalWorkbenchApplyRequest>(),states=new Map<string,'failed'|'succeeded'>()
  const registry=await createLocalWorkbenchPlanRegistry({datasetId:f.identity.datasetId,persistence:createLocalWorkbenchOwnerPersistence(f.identity.datasetId,f.repository.localCatalog),
    writer:{async revalidate(){return {valid:true}},async apply(request,plan){return receipt441(request,plan,states.get(plan.planId)!)},async readOriginalReceipt(){return null}}})
  const jobs:LocalLibraryManagementJobPort={async prepare(input){events.push('prepare:'+input.selection.albumId);const value=await issue441(registry,record,input.selection.albumId);originals.set(value.plan.planId,value.request);states.set(value.plan.planId,input.selection.albumId===first&&input.action===null?'failed':'succeeded');return {planId:value.plan.planId,commandId:value.request.commandId}},
    async run(input,attempt){events.push('run:'+input.selection.albumId);const request=originals.get(attempt.planId)!;assert.equal(request.commandId,attempt.commandId);return registry.apply(request)},
    async readOriginal(){throw new Error('已确认结果不需新查或重发')},async join(){joins++;events.push('join-enter');if(joins===1){reached();await joined}events.push('join-closed')}}
  await f.runtime.close();const runtime=createLocalLibraryManagementRuntime({...f.options(),jobs}),request={commandId:randomUUID(),captureId:capture.captureId,backend:'ollama' as const,selection:'selected' as const,albumIds:[first,second]}
  try{
    await runtime.execute('library.ai.start',request)
    let timer:ReturnType<typeof setTimeout>|undefined
    try{await Promise.race([entered,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('受控原join阶段未在2秒内到达')),2000)})])}finally{if(timer)clearTimeout(timer)}
    const running=f.repository.localCatalog.privateLibraryManagementRead(f.identity,'job',request.commandId)!
    assert.equal(running.record.checkpoint.state,'running');assert.deepEqual(running.record.checkpoint.items.map(i=>i.state),['failed','applied'])
    await assert.rejects(runtime.execute('library.job.retry',{jobId:request.commandId,albumIds:[first]}),/尚未join/u)
    assert.deepEqual(f.repository.localCatalog.privateLibraryManagementRead(f.identity,'job',request.commandId),running)
    const quiet=runtime.joinJob(request.commandId);release();await quiet
    const before=f.repository.localCatalog.privateLibraryManagementRead(f.identity,'job',request.commandId)!
    assert.equal(before.record.checkpoint.state,'partial');assert.equal(runtime.inspect().runningJobs,0);assert.equal(joins,1)
    const resumed=await runtime.execute('library.job.retry',{jobId:request.commandId,albumIds:[first]});assert.equal(resumed.jobId,request.commandId);await runtime.joinJob(request.commandId)
    const after=f.repository.localCatalog.privateLibraryManagementRead(f.identity,'job',request.commandId)!
    assert.equal(after.record.checkpoint.state,'complete');assert.deepEqual(after.record.original,before.record.original);assert.equal(after.record.originalSha256,before.record.originalSha256)
    assert.deepEqual(after.record.checkpoint.items[1],before.record.checkpoint.items[1]);assert.equal(after.record.checkpoint.items[0]!.receipt?.state,'succeeded')
    assert.deepEqual(events,['prepare:'+first,'run:'+first,'prepare:'+second,'run:'+second,'join-enter','join-closed','prepare:'+first,'run:'+first,'join-enter','join-closed'])
    assert.equal(joins,2);assert.deepEqual(f.repository.localCatalog.privateLibraryManagementRead(f.identity,'capture',capture.captureId)?.record,record)
  }finally{release();await runtime.close()}
})

test('原结果452管理job冷UNKNOWN单专辑读口保原库根和token，零恢复CAS或新执行',async t=>{
  const f=await runtime426(t),{record:capture}=await original426(f),job=await coldJob441(f,capture,'unknown','unknown',1),events:string[]=[]
  await f.cold({jobs:inactiveJobs441(events)})
  const before=f.repository.localCatalog.privateLibraryManagementRead(f.identity,'job',job.key),revision=f.repository.localCatalog.privateLibraryManagementRevision(f.identity)
  const original=capture.original.albums[1]!,albumId=original.resolved.capture.albumId
  const page=await f.runtime.execute('library.job.read',{jobId:job.key,offset:0,limit:1,albumId})
  assert.equal(page?.state,'unknown');assert.equal(page?.originalEntry?.datasetId,f.identity.datasetId)
  assert.equal(page?.originalEntry?.album.rootId,original.libraryId);assert.notEqual(original.libraryId,original.sourceRootId)
  assert.deepEqual(page?.originalEntry?.capture,{albumId,readToken:original.resolved.capture.readToken})
  assert.notEqual(page?.originalEntry?.capture.readToken,page?.captureId);assert.deepEqual(page?.originalEntry?.album.trackIds,[])
  assert.equal(page?.originalEntry?.album.trackCount,original.resolved.group.summary.trackCount)
  assert.equal((await f.runtime.execute('library.job.read',{jobId:job.key,offset:0,limit:1,albumId:'not-original-album'}))?.originalEntry,null)
  assert.deepEqual(events,[]);assert.equal(f.repository.localCatalog.privateLibraryManagementRevision(f.identity),revision)
  assert.deepEqual(f.repository.localCatalog.privateLibraryManagementRead(f.identity,'job',job.key),before)
  assert.deepEqual(f.repository.localCatalog.privateLibraryManagementRead(f.identity,'capture',capture.key)?.record,capture)
})

test('原结果452管理投影闭集只在带albumId的原read返回，非read和错专辑拒绝',()=>{
  const entry:dto.LocalLibraryJobOriginalEntry={datasetId:'dataset-original',album:{albumId:'album-original',rootId:'library-original',title:'原专辑',artist:'原艺人',trackIds:[],trackCount:1,revision:'revision-original'},capture:{albumId:'album-original',readToken:'token-original'}}
  const page:dto.LocalLibraryBatchPage={jobId:'job-original',captureId:'whole-library-original',kind:'ai',state:'unknown',totalAlbums:1,processedAlbums:1,succeededAlbums:0,failedAlbums:0,offset:0,items:[{albumId:'album-original',state:'unknown',message:null}],originalEntry:entry}
  const request={jobId:page.jobId,offset:0,limit:1,albumId:entry.album.albumId}
  assert.equal(dto.isLocalLibraryManagementResult('library.job.read',page,request),true)
  assert.equal(dto.isLocalLibraryManagementResult('library.job.read',page,{jobId:page.jobId,offset:0,limit:1}),false)
  assert.equal(dto.isLocalLibraryManagementResult('library.job.read',page,{...request,albumId:'other-album'}),false)
  for(const command of ['library.job.stop','library.job.resume','library.job.retry'] as const)assert.equal(dto.isLocalLibraryManagementResult(command,page,{jobId:page.jobId,...(command==='library.job.retry'?{albumIds:[]}: {})}),false)
  let getters=0;const malicious={...entry};Object.defineProperty(malicious,'capture',{enumerable:true,get(){getters++;return entry.capture}})
  assert.equal(dto.isLocalLibraryJobOriginalEntry(malicious),false);assert.equal(getters,0)
  assert.equal(dto.isLocalLibraryJobOriginalEntry({...entry,sourcePath:'/private/forbidden'}),false)
  assert.equal(dto.isLocalLibraryJobOriginalEntry({...entry,album:{...entry.album,trackIds:['page-only-track']}}),false)
})


// 仅同SQL组件的正文隔离回归，不授DefaultOwner/Main/Native或耗时资格。
test('完整捕获549：原读取正文递归冻结，替代正文仍复制且旧正文不能越过当前SQL水位',async t=>{
  const f=await runtime426(t,{albums:2}),options=f.options(),page=await options.localAlbums.queryAlbums({rootId:f.root.id,query:'',filter:'all',offset:0,limit:200})
  assert.equal(page.items.length,2);const summary=page.items[0]!,request={albumId:summary.id,rootId:summary.rootId,revision:summary.revision}
  const originalRead=f.workbench.readUnleasedAlbum,body=await originalRead(request)
  assert.equal(Object.isFrozen(body),true);assert.equal(Object.isFrozen(body.group.members),true);assert.equal(Object.isFrozen(body.directoryFacts.files[0]!.value),true)
  assert.equal(Reflect.set(body.capture.members[0]!,'title','不得改原正文'),false)
  const capture=await f.runtime.execute('library.capture',{libraryIds:[f.root.id]}),saved=f.repository.localCatalog.privateLibraryManagementRead(f.identity,'capture',capture.captureId)!.record
  assert.equal(saved.kind,'capture');if(saved.kind!=='capture')assert.fail('必须持久完整capture')
  assert.equal(saved.original.albums.length,2);assert.equal(saved.original.albums[0]!.resolved.capture.members.length,body.capture.members.length)
  const replacements:Array<Readonly<import('../src/collection/local-library-workbench/read-service.js').LocalWorkbenchResolvedReadCapture>>=[]
  f.workbench.readUnleasedAlbum=async(target,context)=>{
    if(replacements.length)assert.equal(Reflect.set(replacements[0]!.capture.members[0]!,'title','替代端口在第二专辑读取前改第一正文'),true)
    const value=structuredClone(await originalRead(target,context));replacements.push(value);return value
  }
  t.after(()=>{f.workbench.readUnleasedAlbum=originalRead})
  const next=await f.runtime.execute('library.capture',{libraryIds:[f.root.id]}),before=f.repository.localCatalog.privateLibraryManagementRead(f.identity,'capture',next.captureId)!.record
  assert.equal(before.kind,'capture');if(before.kind!=='capture')assert.fail('替代正文也必须完整持久')
  assert.equal(replacements.length,2);assert.equal(Object.isFrozen(replacements[0]!),false)
  assert.equal(replacements[0]!.capture.members[0]!.title,'替代端口在第二专辑读取前改第一正文')
  assert.deepEqual(before.original.albums[0]!.resolved.capture.members,saved.original.albums[0]!.resolved.capture.members,'第二次读取的外部更改不得进入已捕获第一专辑')
  assert.equal(Reflect.set(replacements[1]!.capture.members[0]!,'title','替代端口提交后迟到更改'),true)
  assert.deepEqual(f.repository.localCatalog.privateLibraryManagementRead(f.identity,'capture',next.captureId)!.record,before)
  f.workbench.readUnleasedAlbum=async(target,context)=>target.albumId===body.capture.albumId?body:originalRead(target,context)
  f.repository.localCatalog.overrideMetadata({commandId:randomUUID(),trackId:body.group.members[0]!.fact.summary.track.id,expectedRevision:null,fields:{title:'同SQL真实后继字段'}})
  const staleId=randomUUID(),stale=createLocalLibraryManagementRuntime({...f.options(),makeCaptureId:()=>staleId});t.after(()=>stale.close())
  const existing=f.repository.localCatalog.privateLibraryManagementRead(f.identity,'capture',capture.captureId)!.record
  await assert.rejects(stale.execute('library.capture',{libraryIds:[f.root.id]}),error=>{assert.ok(error instanceof LocalWorkbenchPlanError);assert.equal(error.code,'CHANGED');return true})
  assert.equal(f.repository.localCatalog.privateLibraryManagementRead(f.identity,'capture',staleId),null)
  assert.deepEqual(f.repository.localCatalog.privateLibraryManagementRead(f.identity,'capture',capture.captureId)!.record,existing)
})

/** 沿已封自有16px JPEG提供规范展示DTO；此测试只验证首次详情门禁与previewURL。 */
async function firstArtwork715Image():Promise<dto.LocalArtworkImage>{
  const bytes=await readFile(new URL('./fixtures/mbrs012-source/owned-cover-16.jpg',import.meta.url)),sha=createHash('sha256').update(bytes).digest('hex');
  assert.equal(bytes.length,960);assert.equal(sha,'555f7915442690ccb14754bd0da000ceadfbdcfb50b4e3402f55d4806e3e989d');
  const image:dto.LocalArtworkImage={original:{mime:'image/jpeg',bytes:bytes.length,sha256:sha,width:16,height:16},display:{mime:'image/jpeg',bytes:bytes.length,sha256:sha,width:16,height:16,dataUrl:'data:image/jpeg;base64,'+bytes.toString('base64')}};
  assert.ok(dto.isLocalArtworkImage(image));return image;
}
type FirstArtwork715Entry='legacy-read'|'capture-one';
async function firstArtwork715Read(entry:FirstArtwork715Entry,f:ReturnType<typeof fixture>,service:ReturnType<typeof createLocalWorkbenchReadService>,context:Parameters<typeof service.readAlbums>[1]){
  return entry==='legacy-read'?service.readAlbums(f.request(),context):service.readAlbumTarget({albumId:f.group.summary.id,rootId:f.root.id,revision:f.group.summary.revision},context);
}

test('首次封面C：未开墙的legacy read和album.capture均有实际JPEG previewUrl，沿原deadline',async()=>{
  const image=await firstArtwork715Image();
  for(const entry of ['legacy-read','capture-one'] as const){
    const f=fixture(),before=structuredClone(f.group.summary),context={signal:new AbortController().signal,deadlineAtMs:performance.now()+2000};let reads=0;
    assert.equal(f.group.summary.artworkAvailable,false);assert.equal(f.group.summary.artworkState,'unknown');
    const service=createLocalWorkbenchReadService({...f.options,async readCurrentArtwork(group,originalContext){reads++;assert.equal(group.summary.id,f.group.summary.id);assert.equal(originalContext,context);assert.equal((originalContext as typeof context).deadlineAtMs,context.deadlineAtMs);return image;}});
    try{
      const readback=await firstArtwork715Read(entry,f,service,context);assert.ok(dto.isLocalWorkbenchReadback(readback));
      const preview=readback.albums[0]!.currentArtwork?.previewUrl;assert.equal(preview,image.display.dataUrl);
      assert.equal(reads,1);
      assert.deepEqual(Buffer.from(preview!.slice('data:image/jpeg;base64,'.length),'base64'),Buffer.from(image.display.dataUrl.slice('data:image/jpeg;base64,'.length),'base64'));
      assert.equal(createHash('sha256').update(Buffer.from(preview!.slice('data:image/jpeg;base64,'.length),'base64')).digest('hex'),image.display.sha256);
      assert.deepEqual(f.group.summary,before,'首次探测不改原public summary或有图布尔');assert.ok(f.calls.includes('inspect'));
    }finally{await service.close();}
  }
});

test('首次封面C：真正无图与offline分别保持空/不探测，旧有图空preview descriptor保留',async()=>{
  for(const entry of ['legacy-read','capture-one'] as const){
    for(const mode of ['no-image','offline','old-available-empty'] as const){
      const f=fixture();if(mode==='offline')f.offline();
      if(mode==='old-available-empty'){f.group.summary.artworkAvailable=true;f.group.summary.artworkState='available';f.group.summary.statuses=['has-artwork'];}
      assert.ok(dto.isLocalAlbumSummary(f.group.summary));let reads=0;
      const service=createLocalWorkbenchReadService({...f.options,async readCurrentArtwork(){reads++;return null;}});
      try{
        const value=await firstArtwork715Read(entry,f,service,{signal:new AbortController().signal});
        assert.equal(reads,mode==='offline'?0:1);
        assert.deepEqual(value.albums[0]!.currentArtwork,mode==='old-available-empty'?{label:'已有封面',previewUrl:null}:null);
        if(mode==='offline')assert.equal(value.albums[0]!.availability,'offline');
      }finally{await service.close();}
    }
  }
});

test('首次封面C：探测中原身份水位变化拒绝捕获，原读取异常不吞作缺图',async()=>{
  const image=await firstArtwork715Image();
  for(const entry of ['legacy-read','capture-one'] as const){
    const changed=fixture(),service=createLocalWorkbenchReadService({...changed.options,async readCurrentArtwork(){changed.changed();return image;}});
    try{await assert.rejects(firstArtwork715Read(entry,changed,service,{signal:new AbortController().signal}),error=>error instanceof LocalWorkbenchPlanError && error.code==='CHANGED');assert.equal(service.inspect().captures,0);}
    finally{await service.close();}
    const failed=fixture(),originalFailure=new Error('受控源读图失败，保持原失败边界'),failedService=createLocalWorkbenchReadService({...failed.options,async readCurrentArtwork(){throw originalFailure;}});
    try{await assert.rejects(firstArtwork715Read(entry,failed,failedService,{signal:new AbortController().signal}),error=>error===originalFailure);assert.equal(failedService.inspect().captures,0);}
    finally{await failedService.close();}
  }
});

test('移除闭环：真实旧库无管理绑定也沿原running与资源join落停用标记，冷开不伪造导入',async t=>{
  const f=await runtime426(t,{albums:1,legacy:true}),request={commandId:randomUUID(),libraryIds:[f.root.id]}
  assert.equal(f.repository.localCatalog.privateLibraryManagementRead(f.identity,'binding',f.root.id),null)
  assert.equal((await f.runtime.execute('library.read',{})).libraries[0]?.libraryId,f.root.id)
  assert.equal(f.confirms,0)
  const receipt=await f.runtime.execute('library.remove',request)
  assert.equal(receipt.state,'succeeded');assert.equal(f.events.filter(value=>value==='remove').length,1)
  const tombstone=f.repository.localCatalog.privateLibraryManagementRead(f.identity,'binding',f.root.id)!.record
  assert.equal(tombstone.revision,1);assert.equal(tombstone.active,false);assert.equal(tombstone.watchEnabled,false)
  assert.equal(tombstone.role,'catalog');assert.equal(tombstone.sourceRootId,f.source.id);assert.equal(tombstone.rootRevision,f.root.revision)
  assert.equal(tombstone.operationId,request.commandId);assert.equal(f.confirms,0)
  assert.equal(f.repository.localCatalog.privateLibraryManagementRead(f.identity,'operation',f.commandId),null)
  await f.cold()
  assert.deepEqual(f.repository.localCatalog.privateLibraryManagementRead(f.identity,'binding',f.root.id)?.record,tombstone)
  assert.deepEqual((await f.runtime.execute('library.operation.read',{commandId:request.commandId}))?.state,'succeeded')
  assert.equal((await f.runtime.execute('library.read',{})).libraries.length,0)
  assert.equal(f.repository.localCatalog.roots().length,1);assert.deepEqual(f.repository.localCatalog.root(f.root.id),f.root)
  assert.equal(f.repository.localCatalog.queryTracks({rootId:f.root.id,query:'',offset:0,limit:1}).total,1)
  assert.deepEqual(await f.runtime.execute('library.remove',request),receipt)
})

test('移除闭环：旧库资源join未知保留可见根且不写停用标记，也不能借兼容入口改名或监听',async t=>{
  const f=await runtime426(t,{albums:1,legacy:true})
  await assert.rejects(f.runtime.execute('library.rename',{commandId:randomUUID(),libraryId:f.root.id,name:'不应授予的改名'}))
  await assert.rejects(f.runtime.execute('library.watch.set',{commandId:randomUUID(),libraryId:f.root.id,enabled:true}))
  await f.cold({async removeResources(){throw new Error('合成资源物理关闭未确认')}})
  const request={commandId:randomUUID(),libraryIds:[f.root.id]},receipt=await f.runtime.execute('library.remove',request)
  assert.equal(receipt.state,'unknown');assert.equal(f.repository.localCatalog.privateLibraryManagementRead(f.identity,'binding',f.root.id),null)
  assert.equal(f.repository.localCatalog.privateLibraryManagementRootVisible(f.root.id),true)
  assert.equal(f.repository.localCatalog.privateLibraryManagementRootAvailable(f.root.id),false)
  assert.equal((await f.runtime.execute('library.read',{})).libraries[0]?.libraryId,f.root.id)
  await f.cold();assert.equal((await f.runtime.execute('library.operation.read',{commandId:request.commandId}))?.state,'unknown')
  assert.equal(f.repository.localCatalog.privateLibraryManagementRead(f.identity,'binding',f.root.id),null)
})

test('移除闭环：仅公开roots隐藏成功停用根，原coordinator与catalog历史仍完整',async t=>{
  const f=await runtime426(t,{albums:1}),coordinator=createLocalRelocationCoordinator({repository:f.repository,assertCurrent:()=>f.identity.assertCurrent()})
  t.after(()=>coordinator.close())
  await f.runtime.execute('library.remove',{commandId:randomUUID(),libraryIds:[f.root.id]})
  const request:dto.IpcRequest={version:dto.IPC_VERSION,id:randomUUID(),command:'localRelocation.roots',payload:{},expectedDatasetId:f.identity.datasetId}
  assert.equal((await coordinator.roots()).length,1)
  const commandOutbox=createDatasetCommandBoundary({datasetId:f.identity.datasetId,assertCurrent:()=>f.identity.assertCurrent()})
  assert.deepEqual(await dispatchDatasetCommand({collection:f.repository,localRelocation:coordinator,commandOutbox},request),[])
  assert.deepEqual(f.repository.localCatalog.roots(),[f.root])
})

test('移除期限：原signal尚未abort但提交前真实期限失效时只落unknown且不撤绑定',async t=>{
  const f=await runtime426(t,{albums:1}),request={commandId:randomUUID(),libraryIds:[f.root.id]},controller=new AbortController();let checks=0
  await f.cold({assertRemoveCurrent(context){assert.equal(context.signal?.aborted,false);if(++checks===2)throw new LocalWorkbenchPlanError('CHANGED','合成原Owner单调期限已到')}})
  const before=f.repository.localCatalog.privateLibraryManagementRead(f.identity,'binding',f.root.id)!.record
  const receipt=await f.runtime.execute('library.remove',request,{signal:controller.signal})
  assert.equal(checks,2);assert.equal(controller.signal.aborted,false);assert.equal(receipt.state,'unknown')
  assert.deepEqual(f.repository.localCatalog.privateLibraryManagementRead(f.identity,'binding',f.root.id)?.record,before)
  await f.cold();assert.equal((await f.runtime.execute('library.operation.read',{commandId:request.commandId}))?.state,'unknown')
})


/** 捕获快路Gate：原Repository/Source账本/Scan批；SQL observer只计真正get/all执行，不替换任何返回行。 */
function captureFastSql(t:import('node:test').TestContext,database:DatabaseSync){
  const statements=new WeakMap<StatementSync,string>(),executed:{sql:string;method:'get'|'all';bindings:unknown[]}[]=[]
  const prepare=DatabaseSync.prototype.prepare,get=StatementSync.prototype.get,all=StatementSync.prototype.all
  t.mock.method(DatabaseSync.prototype,'prepare',function(this:DatabaseSync,sql:string){
    const statement=prepare.call(this,sql);if(this===database)statements.set(statement,sql.replace(/\s+/gu,' ').trim());return statement
  })
  t.mock.method(StatementSync.prototype,'get',function(this:StatementSync,...bindings:unknown[]){
    const sql=statements.get(this);if(sql)executed.push({sql,method:'get',bindings});return Reflect.apply(get,this,bindings)
  })
  t.mock.method(StatementSync.prototype,'all',function(this:StatementSync,...bindings:unknown[]){
    const sql=statements.get(this);if(sql)executed.push({sql,method:'all',bindings});return Reflect.apply(all,this,bindings)
  })
  return {executed,clear(){executed.length=0},ledger(){return executed.filter(v=>v.method==='all'&&v.sql.includes('FROM local_catalog_ledger')&&v.sql.includes("operation='override-metadata'")&&v.sql.includes('max(rowid)'))},
    tracks(){return executed.filter(v=>v.method==='get'&&v.sql==='SELECT * FROM local_catalog_tracks WHERE id=?').map(v=>v.bindings[0])}}
}
function captureFastIds(f:Awaited<ReturnType<typeof runtime426>>,count=3):string[]{
  return Array.from({length:count},(_,i)=>{const state=f.repository.localScan.privateFileState(f.root.id,'专辑'+i+'/原音轨.flac')!.value;assert.equal(state.outcome,'accepted');assert.ok(state.trackId);return state.trackId})
}
function captureFastPoint(database:DatabaseSync){return [database.prepare('SELECT total_changes() n').get()!.n,database.prepare('PRAGMA data_version').get()!.data_version,database.prepare('PRAGMA schema_version').get()!.schema_version]}
function captureFastLogs(t:import('node:test').TestContext){
  const events:LibraryOperationEvent[]=[]
  t.mock.method(console,'info',(...args:unknown[])=>{for(const line of args){if(typeof line!=='string'||!line.startsWith('[MB_LIBRARY_OPERATION] '))continue;const event=readLibraryOperationLine(line);assert.ok(event,'阶段日志必须通过原闭集validator');events.push(event)}})
  return events
}

test('捕获快路：无当前override零账本聚合，逐track实读、顺序与只读水位保留，缺失实体仍拒绝',async t=>{
  const f=await runtime426(t),ids=captureFastIds(f),database=f.repository.localCatalog.privateRead(db=>db),sql=captureFastSql(t,database),events=captureFastLogs(t)
  const selected=[ids[2]!,ids[0]!],before=captureFastPoint(database);sql.clear()
  assert.deepEqual(f.repository.localCatalog.privateWorkbenchMetadataProvenance(selected),selected.map(trackId=>({trackId,override:null})))
  assert.equal(sql.ledger().length,0);assert.deepEqual(sql.tracks(),selected);assert.deepEqual(captureFastPoint(database),before)
  assert.ok(events.some(e=>e.action==='workbench.provenance.phase'&&e.code==='NO_CURRENT_OVERRIDE'&&e.count===2))
  assert.throws(()=>f.repository.localCatalog.privateWorkbenchMetadataProvenance([randomUUID()]),error=>error!==null&&typeof error==='object'&&Object.getOwnPropertyDescriptor(error,'code')?.value==='INVENTORY_CONFLICT')
  assert.equal(sql.ledger().length,0,'缺失track不能借快路变成合法空事实')
})

test('捕获快路：一个当前override和清空字段override都走原latest与完整receipt，结果保持原作者',async t=>{
  const f=await runtime426(t),ids=captureFastIds(f),catalog=f.repository.localCatalog,database=catalog.privateRead(db=>db),sql=captureFastSql(t,database)
  const commandId=randomUUID(),override=catalog.overrideMetadata({commandId,trackId:ids[0]!,expectedRevision:null,fields:{artist:'原人工覆盖'}})
  const before=captureFastPoint(database);sql.clear()
  assert.deepEqual(catalog.privateWorkbenchMetadataProvenance(ids),ids.map(trackId=>({trackId,override:trackId===ids[0]?{commandId,revision:override.revision,fields:override.fields}:null})))
  assert.equal(sql.ledger().length,1);assert.deepEqual(sql.tracks(),ids);assert.deepEqual(captureFastPoint(database),before)
  const clearedId=randomUUID(),cleared=catalog.overrideMetadata({commandId:clearedId,trackId:ids[0]!,expectedRevision:override.revision,fields:{}});sql.clear()
  assert.deepEqual(catalog.privateWorkbenchMetadataProvenance([ids[0]!]),[{trackId:ids[0]!,override:{commandId:clearedId,revision:cleared.revision,fields:{}}}])
  assert.equal(sql.ledger().length,1,'空fields仍是当前override，不能冒充null快路')
})

test('捕获快路：selected之外的真实override不触发全账本聚合，也不混入本次事实',async t=>{
  const f=await runtime426(t),ids=captureFastIds(f),catalog=f.repository.localCatalog,database=catalog.privateRead(db=>db)
  const commandId=randomUUID(),outside=catalog.overrideMetadata({commandId,trackId:ids[2]!,expectedRevision:null,fields:{title:'未选中覆盖'}}),sql=captureFastSql(t,database)
  const selected=ids.slice(0,2)
  assert.deepEqual(catalog.privateWorkbenchMetadataProvenance(selected),selected.map(trackId=>({trackId,override:null})))
  assert.equal(sql.ledger().length,0);assert.deepEqual(sql.tracks(),selected)
  sql.clear();assert.deepEqual(catalog.privateWorkbenchMetadataProvenance([ids[2]!]),[{trackId:ids[2]!,override:{commandId,revision:outside.revision,fields:outside.fields}}]);assert.equal(sql.ledger().length,1)
})

test('捕获快路：当前override缺失receipt或字段与receipt不符均原样拒绝，不降为null',async t=>{
  for(const mode of ['dangling','mismatch'] as const){
    const f=await runtime426(t,{albums:1}),catalog=f.repository.localCatalog,trackId=captureFastIds(f,1)[0]!,database=catalog.privateRead(db=>db)
    if(mode==='dangling')database.prepare('INSERT INTO local_catalog_overrides(track_id,data) VALUES(?,?)').run(trackId,JSON.stringify({trackId,revision:'1',fields:{artist:'无原回执字段'}}))
    else{const current=catalog.overrideMetadata({commandId:randomUUID(),trackId,expectedRevision:null,fields:{artist:'回执原字段'}});database.prepare('UPDATE local_catalog_overrides SET data=? WHERE track_id=?').run(JSON.stringify({...current,fields:{artist:'与回执不符字段'}}),trackId)}
    // 只改自有连接的合成行；真实生产没有这类旁路写入口。原receipt查询必须亲自发现不一致。
    const sql=captureFastSql(t,database)
    assert.throws(()=>catalog.privateWorkbenchMetadataProvenance([trackId]),error=>error!==null&&typeof error==='object'&&Object.getOwnPropertyDescriptor(error,'code')?.value==='INVENTORY_UNAVAILABLE',mode)
    assert.equal(sql.ledger().length,1,mode+'必须走原账本与codec核验')
  }
})

test('捕获快路：真实管理capture复用首group，remember仍独立完整resolve后持久化，闭集阶段不含内容',async t=>{
  const f=await runtime426(t,{albums:1}),events=captureFastLogs(t),database=f.repository.localCatalog.privateRead(db=>db),sql=captureFastSql(t,database)
  const page=await f.options().localAlbums.queryAlbums({query:'',rootId:f.root.id,filter:'all',offset:0,limit:1}),album=page.items[0]!
  const members=t.mock.method(f.repository.localCatalog,'privateAlbumBrowserMembers'),facts=t.mock.method(f.repository.localScan,'privateWorkbenchDirectoryFacts')
  sql.clear();const readback=await f.runtime.execute('library.album.capture',{albumId:album.id,rootId:album.rootId,revision:album.revision})
  assert.ok(dto.isLocalWorkbenchReadback(readback));assert.equal(readback.albums.length,1);assert.equal(readback.albums[0]!.album.trackCount,1)
  assert.equal(members.mock.callCount(),2,'首inspect一次，remember的独立resolve一次；不能重复首inspect或删末复核')
  assert.equal(facts.mock.callCount(),2);assert.equal(sql.ledger().length,0)
  const token=readback.albums[0]!.capture.readToken,saved=f.repository.localCatalog.privateLibraryManagementRead(f.identity,'capture',token)
  assert.ok(saved);assert.equal(saved.record.original.albums[0]!.resolved.capture.members[0]!.trackId,captureFastIds(f,1)[0])
  const phases=events.filter(e=>e.action==='workbench.capture.phase'&&e.state==='complete').map(e=>e.code)
  for(const code of ['OWNER_REVISION','TARGET_INSPECT','GROUP_REUSED','DIRECTORY_FACTS','PROVENANCE','MEMBER_FACTS','ROOT_VERIFY','READBACK_VERIFY','REMEMBER_RESOLVE','REMEMBER_COMMIT'])assert.ok(phases.includes(code),code)
  assert.equal(phases.filter(code=>code==='GROUP_INSPECT').length,1)
  for(const event of events.filter(e=>e.action.startsWith('workbench.'))){assert.equal(event.id,undefined);assert.equal(Object.keys(event).some(key=>/path|title|album|token|rootId/u.test(key)),false);if(event.state==='complete')assert.ok(typeof event.elapsedMs==='number'&&event.elapsedMs>=0)}
})

test('捕获快路：首group后实际元数据变化和末await作者失效均拒绝整批，原异常不吞且不发布lease',async t=>{
  const f=await runtime426(t,{albums:1}),catalog=f.repository.localCatalog,trackId=captureFastIds(f,1)[0]!
  const roots=async():Promise<dto.LocalRootView[]>=>[{root:catalog.root(f.root.id),label:'自有合成来源',availability:'ONLINE'}]
  const owner=createLocalAlbumOwnerService({repository:f.repository,assertCurrent:()=>f.identity.assertCurrent(),readRootViews:roots,readArtwork:async()=>({image:null,status:'ready'})})
  t.after(()=>owner.close())
  const page=await owner.queryAlbums({query:'',rootId:f.root.id,filter:'all',offset:0,limit:1}),album=page.items[0]!,request={albumId:album.id,rootId:album.rootId,revision:album.revision}
  let changed=false
  const changedService=createLocalWorkbenchReadService({datasetId:f.identity.datasetId,repository:f.repository,localAlbums:owner,assertCurrent:()=>f.identity.assertCurrent(),readRootViews:roots,
    makeReadToken(){if(!changed){changed=true;catalog.overrideMetadata({commandId:randomUUID(),trackId,expectedRevision:null,fields:{title:'首inspect之后的真实字段'}})}return randomUUID()}})
  try{await assert.rejects(changedService.readAlbumTarget(request),error=>error instanceof LocalWorkbenchPlanError&&error.code==='CHANGED');assert.equal(changedService.inspect().captures,0)}finally{changedService.close()}
  const fresh=(await owner.queryAlbums({query:'',rootId:f.root.id,filter:'all',offset:0,limit:1})).items[0]!,originalError=new Error('末端受控作者失效');let retired=false
  const guarded=createLocalWorkbenchReadService({datasetId:f.identity.datasetId,repository:f.repository,localAlbums:owner,assertCurrent(){f.identity.assertCurrent();if(retired)throw originalError},
    async readRootViews(){const current=await roots();retired=true;return current}})
  try{await assert.rejects(guarded.readAlbumTarget({albumId:fresh.id,rootId:fresh.rootId,revision:fresh.revision}),error=>error===originalError);assert.equal(guarded.inspect().captures,0)}finally{guarded.close()}
})


/** 真Owner组织/Source作者夹具；旧426的直接SQL端口特意不作为current-scope证据。 */
function captureBindRole426(f:Awaited<ReturnType<typeof runtime426>>,role:dto.LocalLibraryRole){
  const catalog=f.repository.localCatalog,old=catalog.privateLibraryManagementRead(f.identity,'binding',f.root.id),commandId=randomUUID()
  assert.ok(old)
  const original={command:'library.import.confirm' as const,request:{commandId,choiceId:'controlled-cd01-role-choice',role}}
  const operation:LocalLibraryManagementOperationRecord={schema:1,kind:'operation',datasetId:f.identity.datasetId,key:commandId,revision:1,
    original,originalSha256:localLibraryManagementDigest(original),receipt:{commandId,kind:'library.import.confirm',state:'succeeded',libraryIds:[f.root.id],message:null}}
  const binding:LocalLibraryManagementBindingRecord={...old.record,revision:old.record.revision+1,role,operationId:commandId}
  // 沿同SQL真实CAS改变组织绑定；不替换Source授权、SELECT结果或源文件读取。
  catalog.privateLibraryManagementCompareAndSwap(f.identity,[{record:operation,expectedRevision:null},{record:binding,expectedRevision:old.record.revision}])
  const stored=catalog.privateLibraryManagementRead(f.identity,'binding',f.root.id)
  assert.ok(stored);assert.equal(stored.record.role,role);assert.equal(stored.record.revision,binding.revision)
  return stored
}
async function captureScoped426(t:import('node:test').TestContext,{names=false,role='catalog',albums=1}:{names?:boolean;role?:dto.LocalLibraryRole;albums?:number}={}){
  const f=await runtime426(t,{albums});await f.runtime.close()
  if(role!=='catalog')captureBindRole426(f,role)
  const catalog=f.repository.localCatalog,database=catalog.privateRead(db=>db)
  // 原修订语句会被memo；必须在首次真实Owner读取前登记Statement，清空执行记录不能清掉这份识别。
  const sql=captureFastSql(t,database),events=captureFastLogs(t)
  const roots=async():Promise<dto.LocalRootView[]>=>{const root=catalog.root(f.root.id),source=f.repository.sources.root(root.sourceRootId);return [{root,label:source.label,availability:await sourceRootAvailability(source)}]}
  const organizations=()=>catalog.privateLibraryManagementOrganizations(f.identity)
  const owner=createLocalAlbumOwnerService({repository:f.repository,datasetId:f.identity.datasetId,assertCurrent:()=>f.identity.assertCurrent(),readRootViews:roots,
    readLibraryOrganizations:organizations,readArtwork:async()=>({image:null,status:'ready'}),
    ...(names?{nameEnhancements:{revision:()=>digest('真实名称投影作者'),read:()=>[{rootId:f.root.id,directory:'专辑0',revision:'1',state:'not-run' as const}]}}:{})})
  const workbench=createLocalWorkbenchReadService({datasetId:f.identity.datasetId,repository:f.repository,localAlbums:owner,assertCurrent:()=>f.identity.assertCurrent(),
    readRootViews:roots,...(role!=='catalog'?{readLibraryOrganizations:organizations}:{}),readAuthorRevision:()=>catalog.privateWorkbenchMBOnlyAuthorRevision(f.identity)})
  const runtime=createLocalLibraryManagementRuntime(f.options({workbench,localAlbums:owner,readRootViews:roots}))
  t.after(async()=>{await runtime.close();workbench.close();owner.close()})
  const album=(await owner.queryAlbums({rootId:f.root.id,query:'',filter:'all',offset:0,limit:1})).items[0]!
  assert.ok(album);const expected=await owner.inspectAlbum({rootId:album.rootId,albumKey:album.id,revision:album.revision})
  const writes:LocalLibraryManagementCaptureRecord[]=[]
  const original=catalog.privateLibraryManagementCompareAndSwap.bind(catalog)
  t.mock.method(catalog,'privateLibraryManagementCompareAndSwap',(...args:Parameters<typeof original>)=>{for(const write of args[1])if(write.record.kind==='capture')writes.push(structuredClone(write.record));return original(...args)})
  const request={albumId:album.id,rootId:album.rootId,revision:album.revision}
  return {f,catalog,database,owner,workbench,runtime,album,expected,writes,sql,events,
    run:()=>runtime.execute('library.album.capture',request),
    codes:()=>events.filter(e=>e.action==='workbench.capture.verify'&&e.state==='complete').map(e=>e.code),
    aggregations:()=>sql.executed.filter(e=>e.sql.startsWith('SELECT count(*) n, coalesce(max(rowid),0) last FROM '))}
}
/** 在原BEGIN之前执行一次真实变化；不伪造point、SELECT结果或COMMIT成功。 */
function captureBeforeBegin(t:import('node:test').TestContext,database:DatabaseSync,change:()=>void){
  const exec=database.exec.bind(database);let fired=false
  t.mock.method(database,'exec',(statement:string)=>{if(statement==='BEGIN IMMEDIATE'&&!fired){fired=true;change()}return exec(statement)})
  return ()=>assert.equal(fired,true,'必须确实经过原BEGIN边界')
}

test('捕获同域：真实Owner完整捕获在同物理点预核，锁后不重算全库修订且成员与原完整读取相同',async t=>{
  const x=await captureScoped426(t);x.sql.clear();x.events.length=0
  const result=await x.run();assert.ok(dto.isLocalWorkbenchReadback(result))
  assert.deepEqual(x.codes(),['CURRENT_OWNER_SCOPE','LOCKED_POINT_MATCH'])
  assert.equal(x.aggregations().length,0,'不能在BEGIN后重复全ledger/scan修订聚合')
  assert.equal(x.events.some(e=>e.action==='albums.members'&&e.code==='DERIVED_MISS'),false)
  const saved=x.catalog.privateLibraryManagementRead(x.f.identity,'capture',result.albums[0]!.capture.readToken)
  assert.ok(saved);assert.deepEqual(saved.record.original.albums[0]!.resolved.group,x.expected)
  assert.equal(saved.record.original.albums[0]!.resolved.directoryFacts.files.length,x.expected.members.length)
  assert.deepEqual(saved.record.original.albums[0]!.resolved.capture.members.map(m=>m.trackId),x.expected.members.map(m=>m.fact.summary.track.id))
  const independent=new DatabaseSync(x.f.file)
  try{assert.ok(Number(independent.prepare("SELECT count(*) n FROM local_catalog_ledger WHERE operation='local-library-management-v1' AND json_extract(request,'$.key')=?").get(saved.record.key)!.n)>=2)}finally{independent.close()}
})

test('捕获同域：预核后真实未知DML即使同值也必须转回锁内完整核验',async t=>{
  const x=await captureScoped426(t),state=x.f.repository.localScan.privateFileState(x.f.root.id,'专辑0/原音轨.flac')!
  const assertFired=captureBeforeBegin(t,x.database,()=>{const before=captureFastPoint(x.database);assert.equal(x.database.prepare('UPDATE local_scan_jobs SET data=data WHERE id=?').run(state.jobId).changes,1);assert.notDeepEqual(captureFastPoint(x.database),before)})
  x.sql.clear();x.events.length=0;const result=await x.run();assertFired();assert.ok(dto.isLocalWorkbenchReadback(result))
  assert.deepEqual(x.codes(),['CURRENT_OWNER_SCOPE','LOCKED_ORIGINAL_CHECK']);assert.ok(x.aggregations().length>0)
  assert.deepEqual(x.catalog.privateLibraryManagementRead(x.f.identity,'capture',result.albums[0]!.capture.readToken)!.record.original.albums[0]!.resolved.group,x.expected)
})

test('捕获同域：预核后真实metadata提交、Source撤销或Root旧pin变化均拒绝，不能沿旧证明落盘capture',async t=>{
  for(const mode of ['metadata','source','root'] as const)await t.test(mode,async t=>{
    const x=await captureScoped426(t),trackId=captureFastIds(x.f,1)[0]!
    const assertFired=captureBeforeBegin(t,x.database,()=>{
      if(mode==='metadata')x.catalog.overrideMetadata({commandId:randomUUID(),trackId,expectedRevision:null,fields:{title:'原预核之后变化'}})
      else if(mode==='source')x.f.repository.sources.revoke({commandId:randomUUID(),id:x.f.source.id})
      else {const next=x.catalog.relinkRoot({commandId:randomUUID(),rootId:x.f.root.id,expectedRevision:x.f.root.revision,sourceRootId:x.f.source.id,role:'library'});assert.notEqual(next.revision,x.f.root.revision)}
    })
    x.events.length=0;await assert.rejects(x.run());assertFired()
    assert.ok(x.codes().includes('CURRENT_OWNER_SCOPE'));assert.equal(x.codes().includes('LOCKED_POINT_MATCH'),false)
    assert.equal(x.writes.length,1)
    const durable=new DatabaseSync(x.f.file,{readOnly:true})
    try{
      assert.equal(Number(durable.prepare("SELECT count(*) n FROM local_catalog_ledger WHERE operation='local-library-management-v1' AND json_extract(request,'$.key')=?").get(x.writes[0]!.key)!.n),0,'原变化可持久化，但未确认capture不能留下任一ledger片段')
      if(mode==='root'){const actual=durable.prepare('SELECT data FROM local_catalog_roots WHERE id=?').get(x.f.root.id);assert.ok(actual);assert.equal(JSON.parse(String(actual.data)).revision,(BigInt(x.f.root.revision)+1n).toString(),'必须是真实Root提交，不能仅靠hook抛错得到拒绝')}
    }finally{durable.close()}
  })
})

test('捕获同域：BEGIN前真实外部schema提交由原guard拒绝，不消费旧同连接预核或留下capture',async t=>{
  const x=await captureScoped426(t),beforeRows=x.database.prepare('SELECT * FROM local_catalog_ledger ORDER BY rowid').all()
  const assertFired=captureBeforeBegin(t,x.database,()=>{const before=captureFastPoint(x.database),other=new DatabaseSync(x.f.file);try{other.exec('CREATE TABLE owned_capture_external(value TEXT) STRICT')}finally{other.close()};const after=captureFastPoint(x.database);assert.notEqual(after[1],before[1]);assert.notEqual(after[2],before[2])})
  x.sql.clear();x.events.length=0
  await assert.rejects(x.run(),error=>error!==null&&typeof error==='object'&&Object.getOwnPropertyDescriptor(error,'code')?.value==='INVENTORY_UNAVAILABLE');assertFired()
  assert.deepEqual(x.codes(),['CURRENT_OWNER_SCOPE']);assert.equal(x.database.isTransaction,false);assert.equal(x.writes.length,1)
  const durable=new DatabaseSync(x.f.file,{readOnly:true})
  try{
    assert.deepEqual(durable.prepare('SELECT * FROM local_catalog_ledger ORDER BY rowid').all(),beforeRows,'外部DDL不允许本capture追加局部ledger')
    assert.equal(Number(durable.prepare("SELECT count(*) n FROM local_catalog_ledger WHERE operation='local-library-management-v1' AND json_extract(request,'$.key')=?").get(x.writes[0]!.key)!.n),0)
  }finally{durable.close()}
})

test('捕获同域：真实COMMIT失败后ROLLBACK无持久capture，原Repository保持fatal封口',async t=>{
  const x=await captureScoped426(t),beforeRows=x.database.prepare('SELECT * FROM local_catalog_ledger ORDER BY rowid').all(),exec=x.database.exec.bind(x.database),failure=new Error('合成capture提交失败');let fired=false
  t.mock.method(x.database,'exec',(statement:string)=>{if(statement==='COMMIT'&&!fired){fired=true;throw failure}return exec(statement)})
  x.events.length=0;await assert.rejects(x.run(),error=>error instanceof LocalFactsCommitFatal)
  assert.equal(fired,true);assert.equal(x.database.isTransaction,false);assert.equal(x.writes.length,1)
  assert.deepEqual(x.codes(),['CURRENT_OWNER_SCOPE','LOCKED_POINT_MATCH'],'预核成功不能代替真实COMMIT回执')
  const original=x.writes[0]!,durable=new DatabaseSync(x.f.file,{readOnly:true})
  try{
    assert.deepEqual(durable.prepare('SELECT * FROM local_catalog_ledger ORDER BY rowid').all(),beforeRows,'由独立只读连接核实原ledger完整保留且没有半批写入')
    assert.equal(Number(durable.prepare("SELECT count(*) n FROM local_catalog_ledger WHERE operation='local-library-management-v1' AND json_extract(request,'$.key')=?").get(original.key)!.n),0)
  }finally{durable.close()}
  assert.throws(()=>x.catalog.privateLibraryManagementRead(x.f.identity,'capture',original.key),error=>error instanceof LocalFactsCommitFatal,'不能因已ROLLBACK就恢复未知COMMIT作者')
  assert.equal(x.writes.length,1,'封口后没有重发CAS或另发metadata写入')
})

test('捕获同域：已有耐久readback沿原receipt读取不新增CAS，名称投影不合资格仍走原完整路径',async t=>{
  const x=await captureScoped426(t),readback=await x.run(),key=readback.albums[0]!.capture.readToken,saved=x.catalog.privateLibraryManagementRead(x.f.identity,'capture',key)
  assert.ok(saved);x.catalog.overrideMetadata({commandId:randomUUID(),trackId:captureFastIds(x.f,1)[0]!,expectedRevision:null,fields:{title:'已捕获之后的新字段'}})
  const point=captureFastPoint(x.database),writes=x.writes.length;x.events.length=0
  await x.runtime.rememberAlbumReadback(readback)
  assert.deepEqual(captureFastPoint(x.database),point);assert.equal(x.writes.length,writes);assert.deepEqual(x.codes(),[])
  assert.deepEqual(x.catalog.privateLibraryManagementRead(x.f.identity,'capture',key),saved)
  const fallback=await captureScoped426(t,{names:true});fallback.events.length=0;fallback.sql.clear();await fallback.run()
  assert.deepEqual(fallback.codes(),['ORIGINAL_FALLBACK','LOCKED_ORIGINAL_CHECK']);assert.ok(fallback.aggregations().length>0)
})

test('CD01捕获同域：album与artist真实绑定复用当前完整Reader，remember仍独立读取后持久化',async t=>{
  for(const role of ['album','artist'] as const)await t.test(role,async t=>{
    const x=await captureScoped426(t,{role,albums:3}),binding=x.catalog.privateLibraryManagementRead(x.f.identity,'binding',x.f.root.id)
    assert.ok(binding);assert.equal(binding.record.role,role)
    const organization=x.catalog.privateLibraryManagementOrganizations(x.f.identity).find(value=>value.rootId===x.f.root.id)
    assert.ok(organization);assert.equal(organization.role,role);assert.equal(organization.bindingRevision,binding.record.revision);assert.equal(organization.recordSha256,binding.recordSha256)
    const members=t.mock.method(x.catalog,'privateAlbumBrowserMembers'),facts=t.mock.method(x.f.repository.localScan,'privateWorkbenchDirectoryFacts')
    x.sql.clear();x.events.length=0;const result=await x.run();assert.ok(dto.isLocalWorkbenchReadback(result))
    assert.deepEqual(x.codes(),['CURRENT_OWNER_SCOPE','LOCKED_POINT_MATCH']);assert.equal(x.aggregations().length,0)
    assert.equal(members.mock.callCount(),2,'首inspect和remember独立resolve都须实际读取');assert.equal(facts.mock.callCount(),2)
    const saved=x.catalog.privateLibraryManagementRead(x.f.identity,'capture',result.albums[0]!.capture.readToken)
    assert.ok(saved);assert.deepEqual(saved.record.original.albums[0]!.resolved.group,x.expected)
    assert.deepEqual(saved.record.original.albums[0]!.resolved.capture.members.map(value=>value.trackId),x.expected.members.map(value=>value.fact.summary.track.id))
    assert.equal(saved.record.original.albums[0]!.resolved.directoryFacts.files.length,x.expected.members.length)
    if(role==='album'){assert.equal(x.expected.directory,'');assert.equal(x.expected.members.length,3)}
    const durable=new DatabaseSync(x.f.file,{readOnly:true})
    try{assert.ok(Number(durable.prepare("SELECT count(*) n FROM local_catalog_ledger WHERE operation='local-library-management-v1' AND json_extract(request,'$.key')=?").get(saved.record.key)!.n)>=2)}finally{durable.close()}
  })
})

test('CD01捕获同域：结构化角色预核后真实同值DML必须退回锁内完整核验',async t=>{
  for(const role of ['album','artist'] as const)await t.test(role,async t=>{
    const x=await captureScoped426(t,{role}),state=x.f.repository.localScan.privateFileState(x.f.root.id,'专辑0/原音轨.flac')!
    const assertFired=captureBeforeBegin(t,x.database,()=>{const before=captureFastPoint(x.database);assert.equal(x.database.prepare('UPDATE local_scan_jobs SET data=data WHERE id=?').run(state.jobId).changes,1);assert.notDeepEqual(captureFastPoint(x.database),before)})
    x.sql.clear();x.events.length=0;const result=await x.run();assertFired();assert.ok(dto.isLocalWorkbenchReadback(result))
    assert.deepEqual(x.codes(),['CURRENT_OWNER_SCOPE','LOCKED_ORIGINAL_CHECK']);assert.ok(x.aggregations().length>0)
    const saved=x.catalog.privateLibraryManagementRead(x.f.identity,'capture',result.albums[0]!.capture.readToken)
    assert.ok(saved);assert.deepEqual(saved.record.original.albums[0]!.resolved.group,x.expected)
  })
})

test('CD01捕获同域：结构化角色预核后metadata来源根或role真实变化拒绝旧捕获',async t=>{
  for(const role of ['album','artist'] as const)for(const mode of ['metadata','source','root','role'] as const)await t.test(role+'/'+mode,async t=>{
    const x=await captureScoped426(t,{role}),trackId=captureFastIds(x.f,1)[0]!
    const assertFired=captureBeforeBegin(t,x.database,()=>{
      if(mode==='metadata')x.catalog.overrideMetadata({commandId:randomUUID(),trackId,expectedRevision:null,fields:{title:'CD01预核后的真实覆盖'}})
      else if(mode==='source')x.f.repository.sources.revoke({commandId:randomUUID(),id:x.f.source.id})
      else if(mode==='root'){const next=x.catalog.relinkRoot({commandId:randomUUID(),rootId:x.f.root.id,expectedRevision:x.f.root.revision,sourceRootId:x.f.source.id,role:'library'});assert.notEqual(next.revision,x.f.root.revision)}
      else captureBindRole426(x.f,role==='album'?'artist':'album')
    })
    x.events.length=0
    await assert.rejects(x.run(),error=>{const code=error!==null&&typeof error==='object'?Object.getOwnPropertyDescriptor(error,'code')?.value:undefined;return typeof code==='string'&&['INVENTORY_CONFLICT','INVENTORY_UNAVAILABLE','SNAPSHOT_CHANGED','CHANGED'].includes(code)})
    assertFired();assert.ok(x.codes().includes('CURRENT_OWNER_SCOPE'));assert.equal(x.codes().includes('LOCKED_POINT_MATCH'),false);assert.equal(x.writes.length,1)
    const durable=new DatabaseSync(x.f.file,{readOnly:true})
    try{
      assert.equal(Number(durable.prepare("SELECT count(*) n FROM local_catalog_ledger WHERE operation='local-library-management-v1' AND json_extract(request,'$.key')=?").get(x.writes[0]!.key)!.n),0)
      if(mode==='role'){const actual=x.catalog.privateLibraryManagementRead(x.f.identity,'binding',x.f.root.id);assert.ok(actual);assert.equal(actual.record.role,role==='album'?'artist':'album')}
    }finally{durable.close()}
  })
})

test('CD01捕获同域：结构化角色BEGIN前真实外部DDL不得消费旧物理点或留下capture',async t=>{
  for(const role of ['album','artist'] as const)await t.test(role,async t=>{
    const x=await captureScoped426(t,{role}),beforeRows=x.database.prepare('SELECT * FROM local_catalog_ledger ORDER BY rowid').all()
    const assertFired=captureBeforeBegin(t,x.database,()=>{const before=captureFastPoint(x.database),other=new DatabaseSync(x.f.file);try{other.exec('CREATE TABLE cd01_capture_external(value TEXT) STRICT')}finally{other.close()};const after=captureFastPoint(x.database);assert.notEqual(after[1],before[1]);assert.notEqual(after[2],before[2])})
    x.events.length=0;await assert.rejects(x.run(),error=>error!==null&&typeof error==='object'&&Object.getOwnPropertyDescriptor(error,'code')?.value==='INVENTORY_UNAVAILABLE');assertFired()
    assert.deepEqual(x.codes(),['CURRENT_OWNER_SCOPE']);assert.equal(x.database.isTransaction,false);assert.equal(x.writes.length,1)
    const durable=new DatabaseSync(x.f.file,{readOnly:true})
    try{assert.deepEqual(durable.prepare('SELECT * FROM local_catalog_ledger ORDER BY rowid').all(),beforeRows)}finally{durable.close()}
  })
})

test('CD01捕获同域：结构化角色的名称增强与container仍沿原完整路径',async t=>{
  for(const role of ['album','artist'] as const)await t.test(role+'/names',async t=>{
    const x=await captureScoped426(t,{role,names:true});x.events.length=0;x.sql.clear();await x.run()
    assert.deepEqual(x.codes(),['ORIGINAL_FALLBACK','LOCKED_ORIGINAL_CHECK']);assert.ok(x.aggregations().length>0)
  })
  const x=await captureScoped426(t,{role:'container'});x.events.length=0;x.sql.clear();await x.run()
  assert.deepEqual(x.codes(),['ORIGINAL_FALLBACK','LOCKED_ORIGINAL_CHECK']);assert.ok(x.aggregations().length>0)
})


/** 只计真实SQLite执行；不替代结果、Source身份或原历史codec。 */
function captureHistoryQueries(t:import('node:test').TestContext){
  const statements=new WeakMap<StatementSync,string>(),reads:{sql:string;bindings:unknown[]}[]=[]
  const prepare=DatabaseSync.prototype.prepare,all=StatementSync.prototype.all
  t.mock.method(DatabaseSync.prototype,'prepare',function(this:DatabaseSync,sql:string){const statement=prepare.call(this,sql);statements.set(statement,sql.replace(/\s+/gu,' ').trim());return statement})
  t.mock.method(StatementSync.prototype,'all',function(this:StatementSync,...bindings:unknown[]){
    const sql=statements.get(this);if(sql?.startsWith('SELECT o.data FROM local_catalog_observations o WHERE o.track_id=?'))reads.push({sql,bindings})
    return Reflect.apply(all,this,bindings)
  })
  return {reads,clear(){reads.length=0},correlated(){return reads.filter(r=>r.sql.includes('EXISTS(SELECT 1 FROM local_catalog_ledger l')&&r.sql.includes('l.rowid<?'))},indexed(){return reads.filter(r=>r.sql.includes('o.rowid IN ('))}}
}
function captureHistoryDropUpdate(db:DatabaseSync,name:'local_catalog_observations_no_update'|'local_catalog_ledger_no_update',change:()=>void){
  const sql=db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?").get(name)?.sql;assert.equal(typeof sql,'string')
  db.exec('DROP TRIGGER '+name)
  try{change()}finally{db.exec(String(sql))}
}
function captureHistoryInsert(db:DatabaseSync,record:LocalLibraryManagementCaptureRecord){
  // 负例仍使用原codec、规范化、chunk/hash与完整batch；只故意缺少实际历史语义。
  const events=createLocalLibraryManagementBatchEvents([{record,previous:null}]);assert.ok(events.length>=2)
  for(const row of events.map(localLibraryManagementLedgerRow))db.prepare('INSERT INTO local_catalog_ledger VALUES(?,?,?,?,?,?)').run(row.command_id!,row.fingerprint!,row.operation!,row.request!,row.result!,row.created_at!)
}
function captureHistoryRenamed(record:LocalLibraryManagementCaptureRecord):LocalLibraryManagementCaptureRecord{
  const next:LocalLibraryManagementCaptureRecord=structuredClone(record);next.key=randomUUID();next.original.captureId=next.key;return next
}
function captureHistoryColdRejected(f:Awaited<ReturnType<typeof runtime426>>){
  assert.throws(()=>{const repository=createCollectionRepository({filePath:f.file,stagingRoot:f.directory+'/stage'});try{repository.localCatalog.privateRead(()=>undefined)}finally{repository.close()}},'原真实冷开必须拒绝历史损坏，不能因有候选索引接受')
}

test('管理历史观测：多个capture只用当序观察和override，真实冷开无逐曲相关ledger扫描',async t=>{
  const f=await runtime426(t,{albums:4}),ids=captureFastIds(f,4),first=await original426(f)
  f.repository.localCatalog.observeMetadata({commandId:randomUUID(),trackId:ids[0]!,source:'synthetic',parserVersion:'history-replay-v1',fields:{title:'第二快照原题名'}})
  const override=f.repository.localCatalog.overrideMetadata({commandId:randomUUID(),trackId:ids[0]!,expectedRevision:null,fields:{artist:'第二快照人工艺人'}})
  const second=await original426(f)
  f.repository.localCatalog.observeMetadata({commandId:randomUUID(),trackId:ids[0]!,source:'synthetic',parserVersion:'history-replay-v1',fields:{title:'快照之后的题名',album:'快照之后的新分组'}})
  const sql=captureHistoryQueries(t);await f.cold()
  assert.equal(sql.correlated().length,0,'热候选必须消除原每曲EXISTS相关ledger SQL')
  assert.ok(sql.indexed().length>=16,'两个真实完整capture的全组和逐成员仍实际读取原观察行')
  assert.deepEqual(f.repository.localCatalog.privateLibraryManagementRead(f.identity,'capture',first.record.key)!.record,first.record)
  assert.deepEqual(f.repository.localCatalog.privateLibraryManagementRead(f.identity,'capture',second.record.key)!.record,second.record)
  const view=f.repository.localCatalog.metadata(ids[0]!);assert.equal(view.raw.title,'快照之后的题名');assert.equal(view.raw.album,'快照之后的新分组');assert.deepEqual(view.override,override)
  sql.clear();await f.cold();assert.equal(sql.correlated().length,0);assert.ok(sql.indexed().length>=16,'重开必须从原ledger重新建立本次候选，不依赖已关闭连接')
})

test('管理历史观测：原observation.rowid顺序与ledger顺序相反仍逐字等价，保64位SQLite行号',async t=>{
  const f=await runtime426(t,{albums:1}),trackId=captureFastIds(f,1)[0]!,initial=f.repository.localCatalog.metadata(trackId).raw
  for(const title of ['较早ledger观察','较晚ledger观察'])f.repository.localCatalog.observeMetadata({commandId:randomUUID(),trackId,source:'synthetic',parserVersion:'history-replay-v1',fields:{title,album:title}})
  const db=f.repository.localCatalog.privateRead(value=>value)
  captureHistoryDropUpdate(db,'local_catalog_observations_no_update',()=>{
    db.prepare('UPDATE local_catalog_observations SET rowid=-rowid WHERE track_id=?').run(trackId)
    // 不把SQLite行号转换为JS安全整数；索引只保原ID，排序仍由真实SQLite完成。
    db.prepare('UPDATE local_catalog_observations SET rowid=9223372036854775807 WHERE id=(SELECT id FROM local_catalog_observations WHERE track_id=? ORDER BY rowid DESC LIMIT 1)').run(trackId)
  })
  await f.cold();assert.deepEqual(f.repository.localCatalog.metadata(trackId).raw,initial)
  const saved=await original426(f),sql=captureHistoryQueries(t);await f.cold()
  assert.equal(sql.correlated().length,0);assert.ok(sql.indexed().length>=2)
  assert.deepEqual(f.repository.localCatalog.privateLibraryManagementRead(f.identity,'capture',saved.record.key)!.record,saved.record)
  assert.deepEqual(f.repository.localCatalog.metadata(trackId).raw,initial)
})

test('管理历史观测：0及有符号64位两端与ledger逆序仍走真实索引，capture逐字等价',async t=>{
  const f=await runtime426(t,{albums:1}),catalog=f.repository.localCatalog,relative='行号边界/原注册音轨.flac',bytes=Buffer.from('只属行号边界夹具的合成原件')
  await mkdir(f.directory+'/source/行号边界',{mode:0o700});await writeFile(f.directory+'/source/'+relative,bytes,{flag:'wx',mode:0o600})
  const root=catalog.root(f.root.id),asset=catalog.registerAsset({commandId:randomUUID(),libraryRootId:root.id,expectedRootRevision:root.revision,relative,sha256:null,sampleFrames:null,timebaseHz:null})
  const track=catalog.createTrack({commandId:randomUUID(),assetId:asset.id,segment:null}),first={title:'最早ledger观察',artist:'行号边界艺人',album:'行号边界专辑'}
  for(const title of [first.title,'中间ledger观察','最晚ledger观察'])catalog.observeMetadata({commandId:randomUUID(),trackId:track.id,source:'synthetic',parserVersion:'history-rowid-boundary-v1',fields:{...first,title}})
  const db=catalog.privateRead(value=>value),ledger=db.prepare("SELECT o.id FROM local_catalog_observations o JOIN local_catalog_ledger l ON l.operation='observe-metadata' AND json_extract(l.result,'$.id')=o.id WHERE o.track_id=? ORDER BY l.rowid").all(track.id)
  assert.equal(ledger.length,3)
  const positions=['9223372036854775807','0','-9223372036854775808']
  captureHistoryDropUpdate(db,'local_catalog_observations_no_update',()=>{
    const update=db.prepare('UPDATE local_catalog_observations SET rowid=? WHERE id=?')
    for(const [index,entry] of ledger.entries())update.run(BigInt(positions[index]!),String(entry.id))
  })
  const actual=db.prepare('SELECT id,CAST(rowid AS TEXT) position FROM local_catalog_observations WHERE track_id=? ORDER BY rowid').all(track.id)
  assert.deepEqual(actual.map(row=>String(row.position)),[...positions].reverse())
  assert.deepEqual(actual.map(row=>String(row.id)),ledger.map(row=>String(row.id)).reverse(),'真实SQLite行号顺序须与原ledger顺序相反')
  await f.cold();assert.deepEqual(f.repository.localCatalog.metadata(track.id).raw,first)
  const saved=await original426(f),capturedBytes=Buffer.from(localWorkbenchJournalCanonical(saved.record)),sql=captureHistoryQueries(t);await f.cold()
  assert.equal(sql.correlated().length,0);assert.ok(sql.indexed().length>=2)
  const complete=sql.indexed().filter(read=>read.bindings.length===4);assert.ok(complete.length>=2,'完整三观察必须在原capture全组及成员读取中实际绑定')
  for(const read of complete)assert.deepEqual(read.bindings.slice(1).map(value=>{assert.equal(typeof value,'bigint');return String(value)}).sort(),[...positions].sort(),'0/MIN/MAX必须以精确SQLite INTEGER绑定，不截断或按文本排序')
  const restored=f.repository.localCatalog.privateLibraryManagementRead(f.identity,'capture',saved.record.key)!.record
  assert.deepEqual(restored,saved.record);assert.deepEqual(Buffer.from(localWorkbenchJournalCanonical(restored)),capturedBytes)
  assert.deepEqual(f.repository.localCatalog.metadata(track.id).raw,first);assert.deepEqual(await readFile(f.directory+'/source/'+relative),bytes)
})

test('管理历史观测：没有任何观察的实际注册track保空raw，不能从别曲候选借字段',async t=>{
  const f=await runtime426(t,{albums:1}),relative='无观察目录/原注册音轨.flac',bytes=Buffer.from('只属本夹具的未扫描原件')
  await mkdir(f.directory+'/source/无观察目录',{mode:0o700});await writeFile(f.directory+'/source/'+relative,bytes,{flag:'wx',mode:0o600})
  const asset=f.repository.localCatalog.registerAsset({commandId:randomUUID(),libraryRootId:f.root.id,expectedRootRevision:f.root.revision,relative,sha256:null,sampleFrames:null,timebaseHz:null})
  const track=f.repository.localCatalog.createTrack({commandId:randomUUID(),assetId:asset.id,segment:null}),saved=await original426(f),sql=captureHistoryQueries(t)
  assert.equal(saved.record.original.albums.flatMap(a=>a.resolved.group.members).length,2)
  await f.cold();assert.equal(sql.correlated().length,0);assert.deepEqual(f.repository.localCatalog.metadata(track.id),{raw:{},override:null,effective:{}})
  assert.deepEqual(f.repository.localCatalog.privateLibraryManagementRead(f.identity,'capture',saved.record.key)!.record,saved.record)
  assert.deepEqual(await readFile(f.directory+'/source/'+relative),bytes)
})

test('管理历史观测：恰200条仍可capture，202候选整曲回原SQL且不抬201读取拒绝门槛',async t=>{
  const f=await runtime426(t,{albums:1}),trackId=captureFastIds(f,1)[0]!
  for(let i=1;i<200;i++)f.repository.localCatalog.observeMetadata({commandId:randomUUID(),trackId,source:'synthetic',parserVersion:'history-replay-v1',fields:{title:'原标题0'}})
  const db=f.repository.localCatalog.privateRead(value=>value),before=Number(db.prepare('SELECT max(rowid) n FROM local_catalog_ledger').get()!.n)
  const saved=await original426(f),after=Number(db.prepare('SELECT max(rowid) n FROM local_catalog_ledger').get()!.n),sql=captureHistoryQueries(t)
  await f.cold();assert.equal(sql.correlated().length,0);assert.ok(sql.indexed().some(q=>q.bindings.length===201),'200个观察ID加trackId仍由真实SQL读取')
  assert.deepEqual(f.repository.localCatalog.privateLibraryManagementRead(f.identity,'capture',saved.record.key)!.record,saved.record)
  for(let i=0;i<2;i++)f.repository.localCatalog.observeMetadata({commandId:randomUUID(),trackId,source:'synthetic',parserVersion:'history-replay-v1',fields:{title:'原标题0'}})
  await f.stop()
  const changed=new DatabaseSync(f.file)
  try{
    const last=Number(changed.prepare('SELECT max(rowid) n FROM local_catalog_ledger').get()!.n)
    captureHistoryDropUpdate(changed,'local_catalog_ledger_no_update',()=>changed.prepare('UPDATE local_catalog_ledger SET rowid=rowid+? WHERE rowid>? AND rowid<=?').run(last,before,after))
  }finally{changed.close()}
  sql.clear();captureHistoryColdRejected(f)
  assert.ok(sql.correlated().length>=1,'超过201候选必须实际执行原SQL fallback，并由原201行预算拒绝；不能默默截成200')
})

test('管理历史观测：观察正文遭真实改写仍在原PK/codec对账拒绝，不因索引保ID跳过',async t=>{
  const f=await runtime426(t,{albums:1}),saved=await original426(f),trackId=captureFastIds(f,1)[0]!
  await f.stop();const db=new DatabaseSync(f.file)
  try{
    const row=db.prepare('SELECT id,data FROM local_catalog_observations WHERE track_id=? ORDER BY rowid LIMIT 1').get(trackId)!,observation=JSON.parse(String(row.data));observation.fields.title='未经原ledger的改写'
    captureHistoryDropUpdate(db,'local_catalog_observations_no_update',()=>db.prepare('UPDATE local_catalog_observations SET data=? WHERE id=?').run(JSON.stringify(observation),String(row.id)))
  }finally{db.close()}
  assert.ok(saved.record.original.albums.length);captureHistoryColdRejected(f)
})

test('管理历史观测：完整规范codec/hash/chunk也不能让全库capture漏掉实际组成员',async t=>{
  const f=await runtime426(t,{albums:3}),saved=await original426(f),forged=captureHistoryRenamed(saved.record)
  forged.original.albums=forged.original.albums.slice(0,-1);forged.original.albumRefs=forged.original.albumRefs.slice(0,-1);forged.originalSha256=localLibraryManagementDigest(forged.original)
  assert.equal(forged.original.albums.flatMap(a=>a.resolved.group.members).length,2)
  await f.stop();const db=new DatabaseSync(f.file)
  try{captureHistoryInsert(db,forged)}finally{db.close()}
  captureHistoryColdRejected(f)
})

test('管理历史观测：相同track/asset观察不能借实际另一个Root的合法pin变成该库成员',async t=>{
  const f=await runtime426(t,{albums:1});await mkdir(f.directory+'/other-source',{mode:0o700})
  const otherSource=f.repository.sources.authorize(randomUUID(),await authorizeSourceDirectory(f.directory+'/other-source'))
  const otherRoot=f.repository.localCatalog.registerRoot({commandId:randomUUID(),sourceRootId:otherSource.id,role:'library'}),saved=await original426(f),forged=captureHistoryRenamed(saved.record)
  forged.original.libraries=[{libraryId:otherRoot.id,sourceRootId:otherRoot.sourceRootId,rootRevision:otherRoot.revision}]
  assert.equal(forged.original.mode,'library');if(forged.original.mode!=='library')assert.fail('原完整库capture')
  forged.original.request={libraryIds:[otherRoot.id]}
  for(const ref of forged.original.albumRefs)ref.rootId=otherRoot.id
  for(const album of forged.original.albums){
    album.libraryId=otherRoot.id;album.sourceRootId=otherRoot.sourceRootId;album.rootRevision=otherRoot.revision
    const r=album.resolved;r.capture.rootId=otherRoot.id;r.group.summary.rootId=otherRoot.id
    for(const member of r.group.members){member.fact.summary.asset.libraryRootId=otherRoot.id;member.fact.summary.asset.sourceRootId=otherRoot.sourceRootId;member.fact.summary.asset.rootRevision=otherRoot.revision}
    for(const file of r.directoryFacts.files){file.sourceRootId=otherRoot.sourceRootId;file.rootRevision=otherRoot.revision;file.value.libraryRootId=otherRoot.id}
    for(const member of r.capture.members){member.rootRevision=otherRoot.revision;const file=r.directoryFacts.files.find(f=>f.currentRelative.endsWith('/'+member.fileName));if(member.scan&&file)member.scan.revision=localLibraryManagementDigest(file)}
    const directories=[r.group.directory!];r.capture.directoryId='directory-'+localLibraryManagementDigest([otherRoot.id,otherRoot.sourceRootId,directories])
    r.capture.revision=localLibraryManagementDigest([r.group.summary.revision,otherRoot,r.directoryFacts,r.provenance,r.capture.members,r.capture.nameSources])
  }
  forged.originalSha256=localLibraryManagementDigest(forged.original)
  await f.stop();const db=new DatabaseSync(f.file)
  try{captureHistoryInsert(db,forged)}finally{db.close()}
  captureHistoryColdRejected(f)
})
