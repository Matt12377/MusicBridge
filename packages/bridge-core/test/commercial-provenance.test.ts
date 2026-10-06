import { rebuildLegacySchema } from './helpers/rebuild-legacy-schema.js';
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { createCollectionRepository } from '../src/collection/repository.js'
import { authorizeSourceDirectory } from '../src/recording/source-files.js'
import { readBackupIndex } from '../src/recording/backup-index.js'
import { isolateRestoredDatabase, verifyRestoredDatabaseIsolation } from '../src/recording/restore-database.js'

const page = { offset: 0, limit: 20 }
const image = { dataUrl: 'data:image/jpeg;base64,/9j/2Q==', width: 1, height: 1 }
const release = { format: 'cd' as const, title: '合成发行', artist: '合成艺术家', quantity: 2, completeness: 'basic' as const, storage: '旧发行版位置', condition: '旧发行版品相', purchaseInfo: '旧发行版购买备注', tracks: [] }
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')

async function fixture(t: test.TestContext) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'musicbridge-commercial-provenance-'))
  const filePath = path.join(directory, 'collection.sqlite')
  const repository = createCollectionRepository({ filePath })
  t.after(async () => { repository.close(); await rm(directory, { recursive: true, force: true }) })
  return { repository, filePath }
}
function at(filePath: string) { return new DatabaseSync(filePath) }
function oldRows(db: DatabaseSync, releaseId: string) {
  return {
    release: db.prepare('SELECT * FROM music_releases WHERE id=?').get(releaseId),
    photos: db.prepare('SELECT * FROM music_photos WHERE release_id=? ORDER BY rowid').all(releaseId),
    ledger: db.prepare('SELECT * FROM physical_links_ledger ORDER BY rowid').all(),
    links: db.prepare('SELECT * FROM physical_digital_links ORDER BY rowid').all(),
  }
}
function downgradeTo23(db: DatabaseSync): void {
  rebuildLegacySchema(db, 23)
}

test('23→24只加逐件与未知历史标记；旧发行原文、照片字节、关系和旧账本不变', async t => {
  const { repository, filePath } = await fixture(t)
  const created = repository.music.saveRelease({ commandId: randomUUID(), release })
  const photo = repository.music.addPhoto({ commandId: randomUUID(), id: created.id, image })
  const previous = repository.links.link({ commandId: randomUUID(), fingerprint: hash('旧关系'), releaseId: created.id, expectedRevision: 2, relation: 'related', ripFromCdConfirmed: false, metadata: { title: '旧数字版' } })
  assert.ok(previous.linkId && photo.photoId)
  repository.close()
  const db = at(filePath)
  downgradeTo23(db)
  const before = oldRows(db, created.id)
  assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, 23)
  db.close()

  const migrated = createCollectionRepository({ filePath }); t.after(() => migrated.close())
  const copies = migrated.music.copies(created.id, page)
  assert.deepEqual({ quantity: copies.quantity, assigned: copies.assignedCount, pool: copies.poolCount }, { quantity: 2, assigned: 0, pool: 2 })
  assert.deepEqual(migrated.music.photo(photo.photoId!), image)
  const history = migrated.links.history(created.id, page)
  assert.equal(history.total, 1)
  assert.deepEqual({ kind: history.items[0]?.kind, occurredAt: history.items[0]?.occurredAt, evidence: history.items[0]?.evidence }, { kind: 'historical-unknown', occurredAt: null, evidence: undefined })
  const after = at(filePath)
  assert.equal(after.prepare('PRAGMA user_version').get()?.user_version, 32)
  assert.deepEqual(oldRows(after, created.id), before)
  assert.deepEqual(after.prepare('PRAGMA foreign_key_check').all(), [])
  after.close()
})

test('24迁移中断完整回滚，旧23字节与schema保持，重试只生成一个未知标记', async t => {
  const { repository, filePath } = await fixture(t)
  const created = repository.music.saveRelease({ commandId: randomUUID(), release })
  repository.music.addPhoto({ commandId: randomUUID(), id: created.id, image })
  repository.links.link({ commandId: randomUUID(), fingerprint: hash('旧关联'), releaseId: created.id, expectedRevision: 2, relation: 'probable', ripFromCdConfirmed: false, metadata: { title: '旧关联' } })
  repository.close()
  const beforeDb = at(filePath); downgradeTo23(beforeDb); const before = oldRows(beforeDb, created.id); beforeDb.close()
  const interrupted = createCollectionRepository({ filePath, beforeCommit(action) { if (action === 'migrate-commercial-provenance') throw new Error('合成迁移中断') } })
  assert.throws(() => interrupted.music.copies(created.id, page), /库存暂时不可用/u)
  interrupted.close()
  const rolledBack = at(filePath)
  assert.equal(rolledBack.prepare('PRAGMA user_version').get()?.user_version, 23)
  assert.equal(rolledBack.prepare("SELECT count(*) n FROM sqlite_schema WHERE name IN ('commercial_release_copies','commercial_copy_details','commercial_copy_photos','physical_link_history')").get()?.n, 0)
  assert.deepEqual(oldRows(rolledBack, created.id), before)
  rolledBack.close()
  const retried = createCollectionRepository({ filePath }); t.after(() => retried.close())
  assert.equal(retried.links.history(created.id, page).total, 1)
  retried.close()
  const cold = createCollectionRepository({ filePath }); t.after(() => cold.close())
  assert.equal(cold.links.history(created.id, page).total, 1)
})

test('Pool→永久逐件、详情与照片归属守恒；旧批量字段、照片字节和自录库存不变', async t => {
  const { repository, filePath } = await fixture(t)
  const created = repository.music.saveRelease({ commandId: randomUUID(), release })
  const firstPhoto = repository.music.addPhoto({ commandId: randomUUID(), id: created.id, image })
  const secondImage = { ...image, dataUrl: `data:image/jpeg;base64,${Buffer.from([255, 216, 255, 1, 255, 217]).toString('base64')}` }
  const secondPhoto = repository.music.addPhoto({ commandId: randomUUID(), id: created.id, image: secondImage })
  const initial = repository.music.copies(created.id, page)
  assert.equal(initial.poolCount, 2); assert.equal(initial.assignedCount, 0)
  const firstRequest = { commandId: randomUUID(), releaseId: created.id, expectedRevision: repository.music.detail(created.id).entry.revision, userConfirmed: true as const }
  const first = repository.music.materializeCopy(firstRequest)
  assert.deepEqual(repository.music.materializeCopy(firstRequest), first)
  assert.equal(repository.music.copies(created.id, page).poolCount, 1)
  const second = repository.music.materializeCopy({ ...firstRequest, commandId: randomUUID(), expectedRevision: repository.music.detail(created.id).entry.revision })
  assert.notEqual(first.copyId, second.copyId)
  assert.equal(repository.music.copies(created.id, page).poolCount, 0)
  assert.throws(() => repository.music.materializeCopy({ ...firstRequest, commandId: randomUUID(), expectedRevision: repository.music.detail(created.id).entry.revision }), /Pool/u)
  assert.throws(() => repository.music.saveRelease({ commandId: randomUUID(), id: created.id, expectedRevision: repository.music.detail(created.id).entry.revision, release: { ...release, quantity: 1 } }), /不能低于/u)
  const firstCopy = repository.music.copies(created.id, page).copies.items.find(item => item.id === first.copyId)!
  const details = { location: '左侧书架', condition: '已核实盘面', purchaseInfo: '本件收据' }
  const detailRequest = { commandId: randomUUID(), copyId: first.copyId!, expectedRevision: firstCopy.revision, details, userConfirmed: true as const }
  repository.music.saveCopyDetails(detailRequest)
  assert.deepEqual(repository.music.saveCopyDetails(detailRequest), { id: created.id, copyId: first.copyId })
  const revision = repository.music.copies(created.id, page).copies.items.find(item => item.id === first.copyId)!.revision
  const attached = { commandId: randomUUID(), copyId: first.copyId!, photoId: firstPhoto.photoId!, expectedRevision: revision, action: 'attach' as const, userConfirmed: true as const }
  repository.music.assignCopyPhoto(attached)
  assert.deepEqual(repository.music.assignCopyPhoto(attached), { id: created.id, copyId: first.copyId, photoId: firstPhoto.photoId })
  const secondCopy = repository.music.copies(created.id, page).copies.items.find(item => item.id === second.copyId)!
  assert.throws(() => repository.music.assignCopyPhoto({ ...attached, commandId: randomUUID(), copyId: second.copyId!, expectedRevision: secondCopy.revision }), /已有逐件归属/u)
  const snapshot = repository.music.copies(created.id, page)
  assert.deepEqual(snapshot.photoAssignments, [{ photoId: firstPhoto.photoId, copyId: first.copyId }])
  assert.deepEqual(snapshot.copies.items.find(item => item.id === first.copyId)?.details, details)
  assert.deepEqual(repository.music.detail(created.id).release, release)
  assert.deepEqual(repository.music.photo(firstPhoto.photoId!), image)
  assert.deepEqual(repository.music.photo(secondPhoto.photoId!), secondImage)
  const db = at(filePath)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM physical_copies').get()?.n, 0)
  assert.throws(() => db.exec(`UPDATE commercial_release_copies SET id='${randomUUID()}' WHERE id='${first.copyId}'`), /immutable commercial copy/u)
  db.close()
  repository.music.removePhoto({ commandId: randomUUID(), id: created.id, photoId: firstPhoto.photoId!, expectedRevision: repository.music.detail(created.id).entry.revision })
  assert.equal(repository.music.copies(created.id, page).photoAssignments.length, 0)
  assert.equal(repository.music.copies(created.id, page).assignedCount, 2)
})

test('关系确认→更正→撤销追加当时事实与理由，旧命令不伪造缺失理由', async t => {
  const { repository, filePath } = await fixture(t)
  const created = repository.music.saveRelease({ commandId: randomUUID(), release })
  const first = repository.links.link({ commandId: randomUUID(), fingerprint: hash('确认'), releaseId: created.id, expectedRevision: 1, relation: 'probable', ripFromCdConfirmed: false, reason: '先按目录核对', origin: 'roon-candidate', metadata: { title: '合成数字版', version: '第一版' } })
  const digitalId = first.digitalId
  assert.ok(digitalId)
  const corrected = repository.links.link({ commandId: randomUUID(), fingerprint: hash('更正'), releaseId: created.id, expectedRevision: 2, relation: 'exact', ripFromCdConfirmed: true, reason: '核对了盘面与目录号', origin: 'existing-digital', digitalId })
  assert.equal(corrected.linkId, first.linkId)
  const current = repository.links.physical(created.id).links[0]!.link
  repository.links.remove({ commandId: randomUUID(), linkId: current.id, expectedRevision: current.revision, reason: '发现版次不一致', userConfirmed: true }, hash('撤销'))
  const events = [...repository.links.history(created.id, page).items].reverse()
  assert.deepEqual(events.map(event => event.kind), ['confirmed', 'corrected', 'revoked'])
  assert.deepEqual(events.map(event => event.evidence?.reason), ['先按目录核对', '核对了盘面与目录号', '发现版次不一致'])
  assert.equal(events[0]?.after?.relation, 'probable')
  assert.equal(events[1]?.before?.relation, 'probable')
  assert.equal(events[1]?.after?.relation, 'exact')
  assert.equal(events[2]?.before?.relation, 'exact')
  assert.equal(events[2]?.after, undefined)
  assert.equal(events[0]?.evidence?.metadata.version, '第一版')
  const legacy = repository.links.link({ commandId: randomUUID(), fingerprint: hash('旧确认'), releaseId: created.id, expectedRevision: 4, relation: 'related', ripFromCdConfirmed: false, reason: null, legacyRequest: true, metadata: { title: '旧关系' } })
  repository.links.remove({ commandId: randomUUID(), linkId: legacy.linkId!, expectedRevision: 1 }, hash('旧撤销'))
  const latest = repository.links.history(created.id, page).items.slice(0, 2)
  assert.deepEqual(latest.map(event => [event.kind, event.evidence?.reason, event.evidence?.userConfirmed, event.evidence?.legacyRequest]), [
    ['revoked', null, null, true], ['confirmed', null, true, true],
  ])
  const db = at(filePath)
  assert.throws(() => db.exec(`DELETE FROM physical_link_history WHERE release_id='${created.id}'`), /immutable relation history/u)
  db.close()
})

test('24备份只读校验与隔离恢复保留逐件、归属及历史；超额逐件损坏拒绝且不改坏副本', async t => {
  const { repository, filePath } = await fixture(t)
  const created = repository.music.saveRelease({ commandId: randomUUID(), release })
  const photo = repository.music.addPhoto({ commandId: randomUUID(), id: created.id, image })
  const copy = repository.music.materializeCopy({ commandId: randomUUID(), releaseId: created.id, expectedRevision: 2, userConfirmed: true })
  repository.music.assignCopyPhoto({ commandId: randomUUID(), copyId: copy.copyId!, photoId: photo.photoId!, expectedRevision: 1, action: 'attach', userConfirmed: true })
  repository.music.materializeCopy({ commandId: randomUUID(), releaseId: created.id, expectedRevision: 3, userConfirmed: true })
  repository.links.link({ commandId: randomUUID(), fingerprint: hash('备份关系'), releaseId: created.id, expectedRevision: 4, relation: 'related', ripFromCdConfirmed: false, reason: '只作相关引用', metadata: { title: '合成备份数字版' } })
  const beforeCopies = repository.music.copies(created.id, page), beforeHistory = repository.links.history(created.id, page)
  const directory = path.dirname(filePath), target = path.join(directory, '隔离副本')
  await mkdir(target)
  const snapshot = await repository.backupSnapshot({ ...await authorizeSourceDirectory(target), id: randomUUID() })
  const restoredPath = path.join(target, snapshot.relative)
  assert.equal(readBackupIndex(restoredPath).index.operations.length, 0)
  isolateRestoredDatabase(restoredPath)
  verifyRestoredDatabaseIsolation(restoredPath)
  assert.equal(readBackupIndex(restoredPath).index.operations.length, 0)
  const restored = createCollectionRepository({ filePath: restoredPath }); t.after(() => restored.close())
  assert.deepEqual(restored.music.copies(created.id, page), beforeCopies)
  assert.deepEqual(restored.links.history(created.id, page), beforeHistory)
  assert.deepEqual(restored.music.photo(photo.photoId!), image)
  assert.deepEqual(repository.music.copies(created.id, page), beforeCopies)
  restored.close()
  const damaged = at(restoredPath)
  damaged.prepare('UPDATE music_releases SET data=? WHERE id=?').run(JSON.stringify({ ...release, quantity: 1 }), created.id)
  damaged.close()
  const evidence = await readFile(restoredPath)
  assert.throws(() => readBackupIndex(restoredPath))
  assert.deepEqual(await readFile(restoredPath), evidence, '拒绝损坏备份时不得修改坏副本或原工作库')
  assert.deepEqual(repository.music.copies(created.id, page), beforeCopies)
})
