import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, rm, rename, copyFile } from 'node:fs/promises'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createCollectionRepository, CollectionError } from '../src/collection/repository.js'
import { verifyLocalCatalogDatabase } from '../src/collection/local-catalog-store.js'
import { createBackupWorkflowStore } from '../src/recording/backup-workflow-store.js'
import { authorizeSourceDirectory } from '../src/recording/source-files.js'
import { localLibraryManagementDigest, type LocalLibraryManagementBindingRecord,
  type LocalLibraryManagementOperationRecord } from '../src/collection/local-library-workbench/owner-journal.js'
import type { LocalAlbumLibraryOrganization } from '../src/collection/local-album-browser/sql-types.js'

async function fixture(t: test.TestContext, count = 1) {
  const temporary = process.env.TMPDIR
  if (!temporary?.startsWith('/Volumes/LifeWeave/Developer/CommandLine/tmp/')) throw new Error('组织投影回归必须使用外置任务临时目录')
  const directory = await mkdtemp(path.join(temporary, 'mbf-organizations-')), file = path.join(directory, 'work.sqlite')
  const repository = createCollectionRepository({ filePath: file })
  repository.list({ offset: 0, limit: 1 })
  const state = createBackupWorkflowStore({ filePath: path.join(directory, 'identity.sqlite') })
  const identity = state.datasetIdentities.bind('default', file, false), catalog = repository.localCatalog
  catalog.privateBindWorkbenchDataset(identity)
  const entries = []
  for (let i = 0; i < count; i++) {
    const media = path.join(directory, `目录${i}`); await mkdir(media)
    const source = repository.sources.authorize(randomUUID(), await authorizeSourceDirectory(media)), commandId = randomUUID()
    const root = catalog.registerRoot({ commandId, sourceRootId: source.id, role: 'library' })
    const operation: LocalLibraryManagementOperationRecord = { schema: 1, kind: 'operation', datasetId: identity.datasetId,
      key: commandId, revision: 1, original: { command: 'library.import.confirm', request: { commandId, choiceId: 'controlled-original-choice', role: 'catalog' } },
      originalSha256: '', receipt: { commandId, kind: 'library.import.confirm', state: 'succeeded', libraryIds: [root.id], message: null } }
    operation.originalSha256 = localLibraryManagementDigest(operation.original)
    const binding: LocalLibraryManagementBindingRecord = { schema: 1, kind: 'binding', datasetId: identity.datasetId, key: root.id,
      revision: 1, libraryId: root.id, sourceRootId: source.id, rootRevision: root.revision, role: 'catalog', name: `目录${i}`,
      active: true, watchEnabled: false, operationId: commandId }
    catalog.privateLibraryManagementCompareAndSwap(identity, [{ record: binding, expectedRevision: null }, { record: operation, expectedRevision: null }])
    entries.push({ root, source, binding })
  }
  t.after(async () => { repository.close(); state.close(); await rm(directory, { recursive: true }) })
  return { directory, file, repository, catalog, identity, entries }
}

function originalOrganizations(f: Awaited<ReturnType<typeof fixture>>): LocalAlbumLibraryOrganization[] {
  f.identity.assertCurrent(); const result: LocalAlbumLibraryOrganization[] = []
  for (const stored of f.catalog.privateLibraryManagementBindings(f.identity)) {
    const binding = stored.record
    if (!binding.active || !f.catalog.privateLibraryManagementRootVisible(binding.libraryId)) continue
    const root = f.catalog.root(binding.libraryId), source = f.repository.sources.root(binding.sourceRootId)
    if (binding.datasetId !== f.identity.datasetId || binding.key !== root.id || root.role !== 'library'
      || root.sourceRootId !== binding.sourceRootId || root.revision !== binding.rootRevision || !source.authorized)
      throw new CollectionError('INVENTORY_UNAVAILABLE', '原组织角色绑定或来源身份已变化。')
    result.push({ datasetId: f.identity.datasetId, rootId: root.id, sourceRootId: root.sourceRootId, rootRevision: root.revision,
      bindingRevision: binding.revision, recordSha256: stored.recordSha256, role: binding.role,
      rootName: path.basename(source.path), parentName: path.basename(path.dirname(source.path)) })
  }
  f.identity.assertCurrent(); return result.sort((a, b) => a.rootId.localeCompare(b.rootId, 'en'))
}
const unavailable = (error: unknown): error is CollectionError => error instanceof CollectionError && error.code === 'INVENTORY_UNAVAILABLE'

test('组织投影：九字段和原排序一致，返回值不污染账本，实际身份与跨库范围逐次校验', async t => {
  const f = await fixture(t, 2), other = await fixture(t)
  const expected = originalOrganizations(f), read = () => f.catalog.privateLibraryManagementOrganizations(f.identity)
  assert.deepEqual(read(), expected)
  const changed = read() as LocalAlbumLibraryOrganization[]; changed[0]!.rootName = '调用方改写'
  assert.deepEqual(read(), expected)
  assert.throws(() => f.catalog.privateLibraryManagementOrganizations({ ...f.identity }))
  assert.throws(() => f.catalog.privateLibraryManagementOrganizations(other.identity))
  assert.deepEqual(other.catalog.privateLibraryManagementOrganizations(other.identity), originalOrganizations(other))
  const originalFile = path.join(f.directory, 'original.sqlite')
  await rename(f.file, originalFile); await copyFile(originalFile, f.file)
  try { assert.throws(read, /工作库/u) }
  finally { await rm(f.file); await rename(originalFile, f.file) }
  assert.deepEqual(read(), expected)
})

test('组织投影：同根换管理角色和binding修订不复用旧scope，撤销binding不再展示', async t => {
  const f = await fixture(t), entry = f.entries[0]!, before = f.catalog.privateLibraryManagementOrganizations(f.identity)[0]!
  const commandId = randomUUID()
  const operation: LocalLibraryManagementOperationRecord = { schema: 1, kind: 'operation', datasetId: f.identity.datasetId,
    key: commandId, revision: 1, original: { command: 'library.import.confirm', request: { commandId, choiceId: 'same-actual-root', role: 'artist' } },
    originalSha256: '', receipt: { commandId, kind: 'library.import.confirm', state: 'succeeded', libraryIds: [entry.root.id], message: null } }
  operation.originalSha256 = localLibraryManagementDigest(operation.original)
  const binding = { ...entry.binding, revision: 2, role: 'artist' as const, operationId: commandId }
  f.catalog.privateLibraryManagementCompareAndSwap(f.identity, [{ record: binding, expectedRevision: 1 }, { record: operation, expectedRevision: null }])
  const after = f.catalog.privateLibraryManagementOrganizations(f.identity)[0]!
  assert.equal(after.rootId, before.rootId); assert.equal(after.role, 'artist'); assert.equal(after.bindingRevision, 2)
  assert.notEqual(after.recordSha256, before.recordSha256); assert.deepEqual(after, originalOrganizations(f)[0])
  const removeId = randomUUID(), removal: LocalLibraryManagementOperationRecord = { schema: 1, kind: 'operation', datasetId: f.identity.datasetId,
    key: removeId, revision: 1, original: { command: 'library.remove', request: { commandId: removeId, libraryIds: [entry.root.id] } },
    originalSha256: '', receipt: { commandId: removeId, kind: 'library.remove', state: 'succeeded', libraryIds: [entry.root.id], message: null } }
  removal.originalSha256 = localLibraryManagementDigest(removal.original)
  f.catalog.privateLibraryManagementCompareAndSwap(f.identity, [{ record: { ...binding, revision: 3, active: false, operationId: removeId }, expectedRevision: 2 }, { record: removal, expectedRevision: null }])
  assert.deepEqual(f.catalog.privateLibraryManagementOrganizations(f.identity), [])
})

test('组织投影：合法重关联结算绑定，原catalog根换角色或Source撤销仍拒绝旧绑定', async t => {
  for (const mutation of ['role', 'revision', 'revoke'] as const) {
    const f = await fixture(t), { root, source } = f.entries[0]!
    const before = f.catalog.privateLibraryManagementOrganizations(f.identity)[0]!
    const oldBinding = f.catalog.privateLibraryManagementRead(f.identity, 'binding', root.id)!, originalBinding = structuredClone(oldBinding)
    const commandId = randomUUID()
    if (mutation === 'revoke') f.repository.sources.revoke({ commandId: randomUUID(), id: source.id })
    else f.catalog.relinkRoot({ commandId, rootId: root.id, expectedRevision: root.revision,
      sourceRootId: source.id, role: mutation === 'role' ? 'recording-reference' : 'library' })
    if (mutation === 'revision') {
      const after = f.catalog.privateLibraryManagementOrganizations(f.identity), binding = f.catalog.privateLibraryManagementRead(f.identity, 'binding', root.id)!
      assert.deepEqual(after, originalOrganizations(f))
      assert.equal(after.length, 1); assert.equal(after[0]!.rootId, root.id); assert.equal(after[0]!.sourceRootId, source.id)
      assert.equal(after[0]!.rootRevision, '2'); assert.equal(after[0]!.bindingRevision, before.bindingRevision + 1)
      assert.notEqual(after[0]!.recordSha256, before.recordSha256)
      assert.deepEqual(binding.record, { ...originalBinding.record, revision: originalBinding.record.revision + 1, rootRevision: '2' })
      assert.equal(binding.rootRelinkProof?.commandId, commandId)
      assert.deepEqual(binding.rootRelinkProof?.beforeRoot, root)
      assert.deepEqual(binding.rootRelinkProof?.afterRoot, f.catalog.root(root.id))
    } else assert.throws(() => f.catalog.privateLibraryManagementOrganizations(f.identity), unavailable, mutation)
    assert.deepEqual(oldBinding, originalBinding, '读取方持有的原绑定快照不能被重关联突变。')
  }
})

test('组织投影：同连接事务、同连接写入、外部提交、schema与关闭后均执行当前事实', async t => {
  const f = await fixture(t), read = () => f.catalog.privateLibraryManagementOrganizations(f.identity)
  const first = read(), entry = f.entries[0]!
  f.repository.privateMobileCatalogAccess!(db => {
    const source = { ...entry.source, path: path.join(f.directory, '新父目录', '事务内新根') }
    db.exec('BEGIN')
    try {
      db.prepare('UPDATE source_roots SET data=? WHERE id=?').run(JSON.stringify(source), source.id)
      assert.equal(read()[0]!.rootName, '事务内新根'); assert.equal(read()[0]!.parentName, '新父目录')
      source.path = path.join(f.directory, '事务内第二根')
      db.prepare('UPDATE source_roots SET data=? WHERE id=?').run(JSON.stringify(source), source.id)
      assert.equal(read()[0]!.rootName, '事务内第二根')
    } finally { db.exec('ROLLBACK') }
    assert.deepEqual(read(), first)
    db.exec('CREATE TABLE owned_organization_changes(value TEXT)')
    db.exec("INSERT INTO owned_organization_changes VALUES('同连接写入')")
    assert.deepEqual(read(), first)
  })
  const external = new DatabaseSync(f.file)
  try {
    external.exec("INSERT INTO owned_organization_changes VALUES('另一连接提交')")
    assert.throws(read, unavailable, '原完整核验凭证失效必须拒绝暖读，不能复用组织结果')
    f.repository.privateMobileCatalogAccess!(db => verifyLocalCatalogDatabase(db))
    assert.deepEqual(read(), first)
    external.prepare('UPDATE source_roots SET data=? WHERE id=?').run(JSON.stringify({ ...entry.source, authorized: false }), entry.source.id)
    assert.throws(read, unavailable)
  } finally { external.close() }
  f.repository.close(); assert.throws(read)
})

test('组织投影：根读取中途同连接写入、外部提交、schema或事务状态变化均拒绝混合事实', async t => {
  for (const mutation of ['write', 'external', 'schema', 'transaction'] as const) {
    const f = await fixture(t)
    f.repository.privateMobileCatalogAccess!(db => {
      db.exec('CREATE TABLE owned_organization_barrier(value TEXT)')
      const external = new DatabaseSync(f.file), prepare = db.prepare.bind(db)
      let change = true
      Object.defineProperty(db, 'prepare', { configurable: true, value(sql: string) {
        const statement = prepare(sql)
        if (sql === 'SELECT * FROM local_catalog_roots WHERE id=?') {
          const get = statement.get.bind(statement)
          Object.defineProperty(statement, 'get', { value(...args: Parameters<typeof get>) {
            const row = get(...args)
            if (change) {
              change = false
              if (mutation === 'write') db.exec("INSERT INTO owned_organization_barrier VALUES('读取中写入')")
              else if (mutation === 'external') external.exec("INSERT INTO owned_organization_barrier VALUES('读取中外部提交')")
              else if (mutation === 'schema') db.exec('CREATE TABLE owned_organization_mid_schema(value TEXT)')
              else db.exec('BEGIN')
            }
            return row
          } })
        }
        return statement
      } })
      try {
        assert.throws(() => f.catalog.privateLibraryManagementOrganizations(f.identity), error => unavailable(error) && /读取期间/u.test(error.message))
        if (db.isTransaction) db.exec('ROLLBACK')
        if (mutation === 'external') {
          assert.throws(() => f.catalog.privateLibraryManagementOrganizations(f.identity), unavailable)
          verifyLocalCatalogDatabase(db)
        }
        assert.deepEqual(f.catalog.privateLibraryManagementOrganizations(f.identity), originalOrganizations(f))
      } finally { if (db.isTransaction) db.exec('ROLLBACK'); external.close(); Object.defineProperty(db, 'prepare', { value: prepare }) }
    })
  }
})
