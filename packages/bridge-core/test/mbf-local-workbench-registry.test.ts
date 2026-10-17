import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import type { LocalWorkbenchApplyRequest, LocalWorkbenchPlan, LocalWorkbenchReceipt } from '@music-bridge/contracts'
import { createLocalWorkbenchPlanRegistry, isLocalWorkbenchRegistrySnapshot, isLocalWorkbenchArtworkCapture, isLocalWorkbenchPlanCapture } from '../src/collection/local-library-workbench/plan-registry.js'
import { buildLocalCuePlan } from '../src/collection/local-library-workbench/cue-plan.js'
import { parseCueText } from '../src/library/cue-text-reader.js'
import type {
  LocalWorkbenchAlbumCapture, LocalWorkbenchPlanCapture, LocalWorkbenchPlanDraft, LocalWorkbenchProtectedWriter,
  LocalWorkbenchRegistryPersistence, LocalWorkbenchRegistrySnapshot, LocalCueFormatQualification,
} from '../src/collection/local-library-workbench/types.js'

function album(id = 'album-a'): LocalWorkbenchAlbumCapture {
  return { albumId: id, readToken: 'read-' + id, revision: 'album-1', rootId: 'root-a', directoryId: 'directory-' + id, editionId: null,
    artistName: '合成艺人', albumName: '合成专辑', directoryName: '合成目录', manualLocks: { artistName: false, albumName: false },
    members: [{ trackId: 'track-' + id, assetId: 'asset-' + id, fileName: '合成-' + id + '.flac', title: null, artist: null, album: null,
      rootRevision: 'root-1', fileRevision: 'file-1', locationRevision: 'location-1', metadataRevision: 'metadata-1' }] }
}
const imageBytes = readFileSync(new URL('./fixtures/mbrs012-source/owned-cover-16.jpg', import.meta.url))
const imageDigest = createHash('sha256').update(imageBytes).digest('hex')
const originalImageBytes = readFileSync(new URL('./fixtures/mbrs012-source/owned-cover-32.jpg', import.meta.url))
const originalImageDigest = createHash('sha256').update(originalImageBytes).digest('hex')
function capture(albums = [album()], artwork = true): LocalWorkbenchPlanCapture {
  return { datasetId: 'dataset-a', datasetRevision: 'dataset-1', albums, ...(artwork ? { artwork: albums.map(item => ({ albumId: item.albumId,
    candidateId: 'candidate-' + item.albumId, revision: 'image-1', origin: 'manual' as const, sourceLabel: '合成测试选图', licenseLabel: '用户自有合成测试图',
    originalBase64: originalImageBytes.toString('base64'),
    image: { original: { mime: 'image/jpeg' as const, bytes: originalImageBytes.length, sha256: originalImageDigest, width: 32, height: 32 },
      display: { mime: 'image/jpeg' as const, bytes: imageBytes.length, sha256: imageDigest, width: 16, height: 16, dataUrl: 'data:image/jpeg;base64,' + imageBytes.toString('base64') } } })) } : {}) }
}
function draft(albums = [album()]): LocalWorkbenchPlanDraft {
  return { kind: 'artwork', scope: 'MB_ONLY', relationship: 'create-on-apply', albumIds: albums.map(item => item.albumId), state: 'ready', blockers: [],
    items: albums.map(item => ({ itemId: 'item-' + item.albumId, albumId: item.albumId, label: item.albumName, changes: [] })) }
}
function request(plan: LocalWorkbenchPlan, commandId = 'command-a'): LocalWorkbenchApplyRequest {
  return { commandId, datasetId: plan.datasetId, planId: plan.planId, expectedRevision: plan.revision, planHash: plan.planHash, contextFingerprint: plan.contextFingerprint, kind: plan.kind }
}
function receipt(original: Readonly<LocalWorkbenchApplyRequest>, plan: Readonly<LocalWorkbenchPlan>, state: LocalWorkbenchReceipt['state'] = 'succeeded'): LocalWorkbenchReceipt {
  return { commandId: original.commandId, datasetId: original.datasetId, planId: original.planId, planHash: original.planHash, state, message: null,
    items: plan.items.map(item => ({ itemId: item.itemId, albumId: item.albumId, label: item.label, state: state === 'succeeded' ? 'applied' : state === 'cancelled' ? 'cancelled' : 'unknown', message: null })) }
}
/** 受控合成CAS，不读写真实数据库或音乐。 */
function memory() {
  let stored: LocalWorkbenchRegistrySnapshot | null = null, fail = false
  const events: string[] = []
  const persistence: LocalWorkbenchRegistryPersistence = {
    load: async () => stored === null ? null : structuredClone(stored),
    save: async (next, expected) => {
      assert.equal(expected, stored?.revision ?? 0); events.push('持久:' + next.revision)
      if (fail) throw new Error('合成持久故障')
      stored = structuredClone(next)
    },
  }
  return { persistence, events, fail: () => { fail = true }, snapshot: () => stored === null ? null : structuredClone(stored) }
}
function writer(overrides: Partial<LocalWorkbenchProtectedWriter> = {}): LocalWorkbenchProtectedWriter {
  return { revalidate: async () => ({ valid: true }), apply: async (original, plan) => receipt(original, plan), readOriginalReceipt: async () => null, ...overrides }
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r }); return { promise, resolve } }
async function registry(storage = memory(), port = writer(), clock = () => 1_000_000) {
  let plans = 0
  const value = await createLocalWorkbenchPlanRegistry({ datasetId: 'dataset-a', persistence: storage.persistence, writer: port,
    now: clock, makePlanId: () => 'plan-' + ++plans, ttlMs: 1000 })
  return { value, storage }
}

test('原命令先CAS持久化才调用受保护writer；选择/预览零执行，重复apply不重派', async () => {
  const storage = memory(), calls: string[] = []
  const { value } = await registry(storage, writer({ apply: async (original, plan) => {
    assert.equal(storage.snapshot()?.entries[0]?.original?.commandId, original.commandId)
    assert.equal(storage.events.at(-1), '持久:2'); calls.push(original.commandId); return receipt(original, plan)
  } }))
  const plan = await value.issuePlan(draft(), capture()); assert.deepEqual(calls, [])
  assert.ok(Object.isFrozen(plan)); assert.ok(Object.isFrozen(plan.items)); assert.match(plan.planHash, /^[a-f0-9]{64}$/u)
  const original = request(plan), first = await value.apply(original), repeated = await value.apply(original)
  assert.equal(first.state, 'succeeded'); assert.deepEqual(repeated, first); assert.deepEqual(calls, ['command-a'])
  await assert.rejects(value.apply(request(plan, 'new-command')), /不能重签/u)
})

test('unknown保留原请求；重建registry不执行，恢复只能读同一原回执', async () => {
  const storage = memory(), calls: string[] = [], reads: LocalWorkbenchApplyRequest[] = []
  const port = writer({ apply: async original => { calls.push(original.commandId); throw new Error('合成回执丢失') } })
  const { value } = await registry(storage, port), plan = await value.issuePlan(draft(), capture()), original = request(plan)
  assert.equal((await value.apply(original)).state, 'unknown')
  assert.deepEqual(value.inspect().entries[0]?.original, original)
  const restored = await createLocalWorkbenchPlanRegistry({ datasetId: 'dataset-a', persistence: storage.persistence,
    writer: writer({ apply: async req => { calls.push(req.commandId); throw new Error('禁止合成补发') }, readOriginalReceipt: async req => { reads.push(structuredClone(req)); return receipt(req, plan) } }), now: () => 1_000_000 })
  assert.deepEqual(calls, ['command-a']); assert.equal(restored.operations()[0]?.state, 'unknown')
  await assert.rejects(restored.apply(request(plan, 're-signed')), /不能重签/u)
  assert.equal((await restored.readOriginalReceipt(original))?.state, 'succeeded')
  assert.deepEqual(reads, [original]); assert.deepEqual(calls, ['command-a'])
})

test('unknown不能用新plan绕过同一专辑/物理源的原回执收口', async () => {
  const { value } = await registry(memory(), writer({ apply: async () => { throw new Error('合成未知') } }))
  const first = await value.issuePlan(draft(), capture()); await value.apply(request(first))
  const second = await value.issuePlan(draft(), capture())
  await assert.rejects(value.apply(request(second, 'second-command')), /未确认原命令/u)
  assert.equal(value.inspect().entries[1]?.original, null)
})

test('原回执先确认终态后迟到unknown不倒退；并发相同原命令只执行一次', async () => {
  const late = deferred<LocalWorkbenchReceipt>(), started = deferred<Readonly<LocalWorkbenchApplyRequest>>(), calls: string[] = []
  let frozenPlan!: LocalWorkbenchPlan
  const { value } = await registry(memory(), writer({
    apply: original => { calls.push(original.commandId); started.resolve(original); return late.promise },
    readOriginalReceipt: async original => receipt(original, frozenPlan),
  }))
  frozenPlan = await value.issuePlan(draft(), capture()); const original = request(frozenPlan)
  const applying = value.apply(original); await started.promise
  const repeated = value.apply(original); await value.readOriginalReceipt(original)
  late.resolve(receipt(original, frozenPlan, 'unknown'))
  assert.equal((await applying).state, 'succeeded'); assert.equal((await repeated).state, 'succeeded')
  assert.deepEqual(calls, ['command-a']); assert.equal(value.operations()[0]?.state, 'succeeded')
})

test('部分回执含unknown仍锁住原范围，迟到未知项不抹掉已知applied', async () => {
  const albums = [album(), album('album-b')]
  let frozenPlan!: LocalWorkbenchPlan
  const { value } = await registry(memory(), writer({
    apply: async original => ({ ...receipt(original, frozenPlan, 'partial'), items: receipt(original, frozenPlan, 'partial').items.map((item, index) => ({ ...item, state: index === 0 ? 'applied' : 'unknown' })) }),
    readOriginalReceipt: async original => receipt(original, frozenPlan, 'unknown'),
  }))
  frozenPlan = await value.issuePlan(draft(albums), capture(albums)); const original = request(frozenPlan)
  await value.apply(original); assert.equal(value.operations()[0]?.state, 'unknown')
  await value.readOriginalReceipt(original)
  assert.deepEqual(value.operations()[0]?.receipt?.items.map(item => item.state), ['applied', 'unknown'])
})

test('原查询已确认终态后，旧apply抛错或错身份回报仍返回已确认原回执', async () => {
  for (const malformed of [false, true]) {
    const started = deferred<Readonly<LocalWorkbenchApplyRequest>>(), release = deferred<void>()
    let frozenPlan!: LocalWorkbenchPlan
    const { value } = await registry(memory(), writer({ apply: async original => {
      started.resolve(original); await release.promise
      if (!malformed) throw new Error('合成迟到异常')
      return { ...receipt(original, frozenPlan), commandId: 'wrong-command' }
    }, readOriginalReceipt: async original => receipt(original, frozenPlan) }))
    frozenPlan = await value.issuePlan(draft(), capture()); const original = request(frozenPlan), pending = value.apply(original)
    await started.promise; assert.equal((await value.readOriginalReceipt(original))?.state, 'succeeded'); release.resolve()
    assert.equal((await pending).state, 'succeeded'); assert.equal(value.operations()[0]?.state, 'succeeded')
  }
})

test('过期/修订变化预览返回真实not-written，零writer执行', async () => {
  let time = 1_000_000, writes = 0
  const { value } = await registry(memory(), writer({ apply: async (original, plan) => { writes++; return receipt(original, plan) } }), () => time)
  const expired = await value.issuePlan(draft(), capture()); time += 1001
  const result = await value.apply(request(expired)); assert.equal(result.state, 'failed'); assert.equal(result.items[0]?.state, 'not-written'); assert.equal(writes, 0)
  const changed = await registry(memory(), writer({ revalidate: async () => ({ valid: false, reason: '合成来源修订变化。' }), apply: async (original, plan) => { writes++; return receipt(original, plan) } }))
  const plan = await changed.value.issuePlan(draft(), capture()), known = await changed.value.apply(request(plan))
  assert.equal(known.items[0]?.state, 'not-written'); assert.equal(writes, 0)
})

test('CAS失败不执行writer且registry停止后续变更，不把存储失败当安全重签理由', async () => {
  const storage = memory(); let writes = 0
  const { value } = await registry(storage, writer({ apply: async (original, plan) => { writes++; return receipt(original, plan) } }))
  const plan = await value.issuePlan(draft(), capture()); storage.fail()
  await assert.rejects(value.apply(request(plan)), /持久结果尚未确认/u)
  await assert.rejects(value.apply(request(plan, 'new-command')), /不会执行或重签/u)
  assert.equal(writes, 0)
})

test('取消原任务先保存取消ID，失败/重建后均不重签取消或重发apply', async () => {
  const storage = memory(), cancels: string[] = []
  const { value } = await registry(storage, writer({ apply: async () => { throw new Error('合成响应丢失') }, cancel: async cancelled => {
    assert.equal(storage.snapshot()?.entries[0]?.cancellation?.cancelCommandId, cancelled.cancelCommandId)
    cancels.push(cancelled.cancelCommandId); throw new Error('合成取消响应丢失')
  } }))
  const plan = await value.issuePlan(draft(), capture()), original = request(plan), cancellation = { original, cancelCommandId: 'cancel-a' }
  await value.apply(original); await value.cancel(cancellation); await value.cancel(cancellation)
  assert.deepEqual(cancels, ['cancel-a']); assert.equal(value.operations()[0]?.state, 'unknown')
  await assert.rejects(value.cancel({ original, cancelCommandId: 'cancel-b' }), /不能重新签发/u)
  const restored = await createLocalWorkbenchPlanRegistry({ datasetId: 'dataset-a', persistence: storage.persistence, writer: writer({ cancel: async () => { throw new Error('不允许合成补发') } }) })
  await assert.rejects(restored.cancel({ original, cancelCommandId: 'cancel-c' }), /不能重新签发/u)
})

test('错命令回执保持unknown，隐含源写字段不经clone抹掉后蒙混通过', async () => {
  const { value } = await registry(memory(), writer({ apply: async (original, plan) => ({ ...receipt(original, plan), commandId: 'other-command' }) }))
  const plan = await value.issuePlan(draft(), capture()); assert.equal((await value.apply(request(plan))).state, 'unknown')
  assert.equal(value.inspect().entries[0]?.receipt, null)
  const hidden = draft(); Object.defineProperty(hidden, 'grant', { value: '合成SOURCE_FILES', enumerable: false })
  await assert.rejects(value.issuePlan(hidden, capture()), /隐藏字段/u)
  await assert.rejects(value.issuePlan({ ...draft(), scope: 'SOURCE_FILES' } as unknown as LocalWorkbenchPlanDraft, capture()), /捕获/u)
})

test('持久快照哈希被改动时拒绝恢复，不猜计划或自动补发', async () => {
  const storage = memory(), { value } = await registry(storage)
  await value.issuePlan(draft(), capture()); const corrupted = storage.snapshot()!
  corrupted.entries[0]!.capture.datasetRevision = 'wrong-revision'
  await assert.rejects(createLocalWorkbenchPlanRegistry({ datasetId: 'dataset-a', persistence: { load: async () => corrupted, save: async () => assert.fail('禁止保存伪快照') }, writer: writer() }), /持久计划/u)
})

test('独立CUE冻结逐轨源绑定与真实读帧修订；有范围越界时不给应用计划', async () => {
  const captured = album(), primary = captured.members[0]!
  if (primary.assetId === null) assert.fail('合成CUE必须有真实资产捕获')
  const reference = { assetId: primary.assetId, libraryRootId: captured.rootId, sourceRootId: 'source-a', rootRevision: 'root-1', fileRevision: 'file-1', locationRevision: 'location-1' }
  const parsed = parseCueText('FILE "合成.flac" WAVE\nTRACK 01 AUDIO\nINDEX 01 00:00:00\nTRACK 02 AUDIO\nINDEX 01 00:01:00\n', new Map([['合成.flac', [reference]]]))
  if (parsed.status !== 'ok') assert.fail('合成CUE解析失败')
  const target = { choiceId: 'target-a', label: '合成独立输出', independent: true as const }
  const format: LocalCueFormatQualification = { formatId: 'flac', revision: 'format-1', codec: 'flac', extension: 'flac', lossless: true, evidence: 'encoder-tag-audio-roundtrip', available: true }
  const audio = [{ assetReference: reference, sourceLabel: '合成整轨', evidence: 'audio-pcm-read' as const, readRevision: 'pcm-1', sampleRate: 44100, totalPcmFrames: 88200 }]
  const built = buildLocalCuePlan({ selections: [{ album: captured, cueId: 'cue-a', cueRevision: 'cue-1', parsed, audio }], target, format, pregapPolicy: 'append-to-previous' })
  const source: LocalWorkbenchPlanCapture = { ...capture([captured], false), cueSheets: [{ cueId: 'cue-a', revision: 'cue-1', albumId: captured.albumId }],
    cueOutputs: built.outputs, audio, target: { ...target, revision: 'target-1' }, format }
  const { value } = await registry(), plan = await value.issuePlan(built.draft, source)
  assert.equal(plan.scope, 'INDEPENDENT_OUTPUT'); assert.equal(value.inspect().entries[0]?.capture.cueOutputs?.[0]?.sourceReadRevision, 'pcm-1')
  const over = structuredClone(built.draft); over.tracks[1]!.frameCount = 88201
  await assert.rejects(value.issuePlan(over, source), /逐轨范围/u)
})

test('封面真实副本随冻结捕获持久化，后改候选/错hash不能替换原计划图', async () => {
  const storage = memory(), source = capture(), seen: string[] = []
  const { value } = await registry(storage, writer({ apply: async (original, plan, captured) => {
    seen.push(captured.artwork![0]!.image.display.sha256)
    assert.equal(captured.artwork![0]!.candidateId, 'candidate-album-a')
    return receipt(original, plan)
  } }))
  const plan = await value.issuePlan(draft(), source)
  source.artwork![0]!.image.display.sha256 = '0'.repeat(64)
  source.artwork![0]!.originalBase64 = imageBytes.toString('base64')
  assert.equal(value.inspect().entries[0]?.capture.artwork?.[0]?.image.display.sha256, imageDigest)
  assert.equal(value.inspect().entries[0]?.capture.artwork?.[0]?.originalBase64, originalImageBytes.toString('base64'))
  const saved = storage.snapshot()!
  assert.equal(isLocalWorkbenchRegistrySnapshot(saved, 'dataset-a'), true)
  await value.apply(request(plan)); assert.deepEqual(seen, [imageDigest])
  const bad = capture(); bad.artwork![0]!.image.display.sha256 = '0'.repeat(64)
  await assert.rejects(value.issuePlan(draft(), bad), /捕获/u)
  const missing = capture(undefined, false)
  await assert.rejects(value.issuePlan(draft(), missing), /真实已解码副本/u)
  const corrupted = structuredClone(saved); corrupted.entries[0]!.capture.artwork![0]!.candidateId = 'other-candidate'
  assert.equal(isLocalWorkbenchRegistrySnapshot(corrupted, 'dataset-a'), false)
})

test('封面重建只按dataset/plan/候选精确恢复不同于缩略图的原图，不下载、不执行或补签', async () => {
  const storage = memory(), { value } = await registry(storage), plan = await value.issuePlan(draft(), capture())
  const restored = await createLocalWorkbenchPlanRegistry({ datasetId: 'dataset-a', persistence: storage.persistence,
    writer: writer({ apply: async () => { assert.fail('只读恢复不能执行写入') } }), now: () => Date.parse(plan.expiresAt) + 1 })
  const original = restored.readArtworkCapture({ datasetId: 'dataset-a', planId: plan.planId, candidateId: 'candidate-album-a' })
  assert.ok(original); assert.ok(Object.isFrozen(original)); assert.ok(Object.isFrozen(original.artwork))
  assert.equal(original.datasetRevision, 'dataset-1'); assert.equal(original.planHash, plan.planHash); assert.equal(original.contextFingerprint, plan.contextFingerprint)
  assert.deepEqual(original.capture, album()); assert.equal(original.artwork.image.original.sha256, originalImageDigest)
  assert.notEqual(original.artwork.image.original.sha256, original.artwork.image.display.sha256)
  assert.deepEqual(Buffer.from(original.artwork.originalBase64, 'base64'), originalImageBytes)
  assert.equal(restored.operations().length, 0)
  assert.equal(restored.readArtworkCapture({ datasetId: 'other-dataset', planId: plan.planId, candidateId: 'candidate-album-a' }), null)
  assert.equal(restored.readArtworkCapture({ datasetId: 'dataset-a', planId: 'other-plan', candidateId: 'candidate-album-a' }), null)
  assert.equal(restored.readArtworkCapture({ datasetId: 'dataset-a', planId: plan.planId, candidateId: 'other-candidate' }), null)
  const corrupted = storage.snapshot()!; corrupted.entries[0]!.capture.artwork![0]!.originalBase64 = imageBytes.toString('base64')
  assert.equal(isLocalWorkbenchRegistrySnapshot(corrupted, 'dataset-a'), false)
  await assert.rejects(createLocalWorkbenchPlanRegistry({ datasetId: 'dataset-a', persistence: { load: async () => corrupted, save: async () => { assert.fail('损坏快照不能重写') } },
    writer: writer() }), /持久计划\/原回执身份无效/u)
})

test('原图canonical字节/实际hash/mime与4MiB、整体32MiB预算独立于display校验', () => {
  const source = capture(), original = source.artwork![0]!, badHash = structuredClone(original)
  assert.equal(isLocalWorkbenchArtworkCapture(original), true)
  badHash.image.original.sha256 = '0'.repeat(64); assert.equal(isLocalWorkbenchArtworkCapture(badHash), false)
  const thumbnail = structuredClone(original); thumbnail.originalBase64 = imageBytes.toString('base64')
  assert.equal(isLocalWorkbenchArtworkCapture(thumbnail), false)
  const noncanonical = structuredClone(original), alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  const index = noncanonical.originalBase64.length - 3
  noncanonical.originalBase64 = noncanonical.originalBase64.slice(0, index) + alphabet[alphabet.indexOf(noncanonical.originalBase64[index]!) + 1] + noncanonical.originalBase64.slice(index + 1)
  assert.deepEqual(Buffer.from(noncanonical.originalBase64, 'base64'), originalImageBytes)
  assert.equal(isLocalWorkbenchArtworkCapture(noncanonical), false)
  const png = readFileSync(new URL('./fixtures/mbrs012-source/owned-cover-32.png', import.meta.url)), pngCapture = structuredClone(original)
  pngCapture.originalBase64 = png.toString('base64'); pngCapture.image.original = { mime: 'image/png', bytes: png.length, sha256: createHash('sha256').update(png).digest('hex'), width: 32, height: 32 }
  assert.equal(isLocalWorkbenchArtworkCapture(pngCapture), true)
  const wrongMime = structuredClone(pngCapture); wrongMime.image.original.mime = 'image/jpeg'; assert.equal(isLocalWorkbenchArtworkCapture(wrongMime), false)
  const overImage = structuredClone(original); overImage.image.original.bytes = 4 * 1024 * 1024 + 1
  assert.equal(isLocalWorkbenchArtworkCapture(overImage), false)
  const albums = Array.from({ length: 9 }, (_, group) => {
    const captured = album('budget-' + group), member = captured.members[0]! as import('../src/collection/local-library-workbench/types.js').LocalWorkbenchCatalogMemberCapture
    return { ...captured, members: Array.from({ length: 220 }, (_, index) => ({ ...member, trackId: 'track-' + group + '-' + index,
      assetId: 'asset-' + group + '-' + index, title: '标'.repeat(2000), artist: '艺'.repeat(2000), album: '专'.repeat(2000) })) }
  })
  assert.equal(isLocalWorkbenchPlanCapture(capture(albums)), false)
})
