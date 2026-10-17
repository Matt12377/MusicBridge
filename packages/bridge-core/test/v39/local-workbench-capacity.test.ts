import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import * as dto from '@music-bridge/contracts'
import { sourceRootAvailability } from '../../src/recording/source-files.js'
import { createLocalWorkbenchReadService } from '../../src/collection/local-library-workbench/read-service.js'
import { createLocalWorkbenchPlanRegistry } from '../../src/collection/local-library-workbench/plan-registry.js'
import { createLocalWorkbenchOwnerPersistence } from '../../src/collection/local-library-workbench/owner-journal.js'
import { capacityCorpus, capacityRoot, capacityCheck, capacityEvidence, capacityMerge, capacityRequest, openCapacityOwner } from './local-album-capacity.test.js'

// 同一实际隔离数据库的DatasetIdentity来自原物理身份store；不以任意UUID签发持久端口。
// 本叶不执行原音乐/封面/标签写入，不把“计划已持久”冒充音频完成。
test('002容量：300k库完整10000私有组与2048公开组、同dataset CAS冷开原件不截断', async () => {
  const queries = [], boundaries = [], first = await openCapacityOwner(); let service: ReturnType<typeof createLocalWorkbenchReadService> | undefined
  let expected: Awaited<ReturnType<ReturnType<typeof createLocalWorkbenchOwnerPersistence>['load']>> = null
  try {
    const page = await first.owner.queryAlbums({ query: '', rootId: null, filter: 'all', offset: 0, limit: 200 })
    assert.equal(page.items.reduce((n, item) => n + item.trackCount, 0), 300000)
    const whole = page.items.find(item => item.trackCount === 10000), small = page.items.find(item => item.trackCount === 2048)
    assert.ok(whole && small)
    service = createLocalWorkbenchReadService({ datasetId: first.identity.datasetId, repository: first.repository, localAlbums: first.owner,
      assertCurrent: () => first.identity.assertCurrent(), readRootViews: async () => Promise.all(first.repository.localCatalog.roots().map(async root => ({ root, label: '任务自有容量源', availability: await sourceRootAvailability(first.repository.sources.root(root.sourceRootId)) }))) })
    const observed = await capacityRequest('whole-10000', false, () => service!.readAlbumTargets({ albums: [{ albumId: whole.id, rootId: whole.rootId, revision: whole.revision }] }), result => ({ items: result.albums[0]!.album.trackCount!, bytes: Buffer.byteLength(JSON.stringify(result)), truncated: false }))
    assert.equal(observed.result.albums.length, 1); assert.deepEqual(observed.result.albums[0]!.album.trackIds, [])
    assert.ok(Buffer.byteLength(JSON.stringify(observed.result)) <= 131072)
    queries.push(observed.query)
    const reference = { datasetId: first.identity.datasetId, capture: observed.result.albums[0]!.capture }
    const resolved = await capacityRequest('resolve-whole-10000', false, () => service!.resolveCapture(reference), result => ({ items: result.capture.members.length, bytes: Buffer.byteLength(JSON.stringify(result.capture)), truncated: false }))
    const captured = resolved.result; assert.equal(captured.capture.members.length, 10000)
    const privateBytes = resolved.query.completeGroup.bytes; assert.ok(privateBytes <= 33554432); queries.push(resolved.query)
    boundaries.push({ id: 'whole-group-10000-32mib', accepted: true, items: captured.capture.members.length, bytes: privateBytes, raw: resolved.query.raw })
    const inspected = await first.owner.inspectAlbum({ albumKey: small.id, rootId: small.rootId, revision: small.revision })
    assert.equal(inspected.members.length, 2048)
    const smaller = await capacityRequest('small-2048', false, () => service!.readAlbums({ albums: [{ albumId: small.id, rootId: small.rootId,
      title: small.title, artist: small.artists.join(' / '), trackIds: inspected.members.map(member => member.fact.summary.track.id) }] }), result => ({ items: result.albums[0]!.album.trackIds.length, bytes: Buffer.byteLength(JSON.stringify(result)), truncated: false }))
    assert.equal(smaller.query.completeGroup.items, 2048); assert.ok(smaller.query.completeGroup.bytes <= 131072); queries.push(smaller.query)
    boundaries.push({ id: 'small-group-2048-128kib', accepted: true, items: 2048, bytes: smaller.query.completeGroup.bytes, raw: smaller.query.raw })
    const persistence = createLocalWorkbenchOwnerPersistence(first.identity.datasetId, first.repository.localCatalog)
    const registry = await createLocalWorkbenchPlanRegistry({ datasetId: first.identity.datasetId, persistence,
      writer: { revalidate: async () => { throw new Error('容量测试不执行原写入资格判断') }, readOriginalReceipt: async () => null,
        apply: async () => { throw new Error('容量测试不执行用户源写') } } })
    await registry.issuePlan({ kind: 'ai', scope: 'MB_ONLY', candidateIds: [], albumIds: [whole.id], state: 'blocked',
      blockers: ['仅容量/CAS验证，不执行名称改写'], items: [{ itemId: randomUUID(), albumId: whole.id, label: whole.title, changes: [] }] },
      { datasetId: first.identity.datasetId, datasetRevision: captured.datasetRevision, albums: [captured.capture] })
    expected = await persistence.load(first.identity.datasetId); assert.ok(expected)
    assert.equal(expected.entries[0]!.capture.albums[0]!.members.length, 10000)
    await assert.rejects(persistence.save(expected, 0)); assert.deepEqual(await persistence.load(first.identity.datasetId), expected)
    const publicShape: unknown = observed.result; assert.ok(dto.isLocalWorkbenchReadback(publicShape))
  } finally { service?.close(); first.close() }
  const cold = await openCapacityOwner()
  try {
    assert.equal(cold.identity.datasetId, capacityCorpus().datasetId); const persistence = createLocalWorkbenchOwnerPersistence(cold.identity.datasetId, cold.repository.localCatalog)
    assert.deepEqual(await persistence.load(cold.identity.datasetId), expected); assert.ok(expected)
    await assert.rejects(persistence.save(expected, 0)); assert.deepEqual(await persistence.load(cold.identity.datasetId), expected)
  } finally { cold.close() }
  capacityCheck(); const before = JSON.parse(readFileSync(capacityRoot() + '/proof.json', 'utf8'))
  const closure = capacityEvidence('album-capacity/workbench-closure.json', { samePhysicalDatasetColdId: capacityCorpus().datasetId,
    completeMembersRestored: 10000, repositoriesClosedAndSubsequentOperationsRejected: true, identityStoresClosedAndSubsequentOperationsRejected: true,
    nodeWorkersCreated: 0, sourceWriteClaimsCreated: 0, nativeProcessesCreated: 0, productWritingNeverAttempted: true })
  capacityMerge({ queries: [...before.queries, ...queries], boundaries: [...before.boundaries, ...boundaries], closureRaw: closure,
    physicalClosure: { fdsClosed: true, workersClosed: true, claimsReleased: true } })
})
