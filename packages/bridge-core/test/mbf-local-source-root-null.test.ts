import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { createCollectionRepository, CollectionError } from '../src/collection/repository.js'
import { createBackupWorkflowStore } from '../src/recording/backup-workflow-store.js'
import { authorizeSourceDirectory } from '../src/recording/source-files.js'
import { localLibraryManagementDigest, type LocalLibraryManagementBindingRecord,
  type LocalLibraryManagementOperationRecord } from '../src/collection/local-library-workbench/owner-journal.js'

async function fixture(t: test.TestContext) {
  const temporary = process.env.TMPDIR
  if (!temporary?.startsWith('/Volumes/LifeWeave/Developer/CommandLine/tmp/')) throw new Error('Source 空值回归必须使用外置任务临时目录')
  const directory = await mkdtemp(path.join(temporary, 'mbf-source-null-')), media = path.join(directory, '自有目录'), file = path.join(directory, 'work.sqlite')
  await mkdir(media)
  const repository = createCollectionRepository({ filePath: file }); repository.list({ offset: 0, limit: 1 })
  const state = createBackupWorkflowStore({ filePath: path.join(directory, 'identity.sqlite') })
  const identity = state.datasetIdentities.bind('default', file, false), catalog = repository.localCatalog
  catalog.privateBindWorkbenchDataset(identity)
  const commandId = randomUUID(), source = repository.sources.authorize(commandId, await authorizeSourceDirectory(media))
  const root = catalog.registerRoot({ commandId, sourceRootId: source.id, role: 'library' })
  const operation: LocalLibraryManagementOperationRecord = { schema: 1, kind: 'operation', datasetId: identity.datasetId,
    key: commandId, revision: 1, original: { command: 'library.import.confirm', request: { commandId, choiceId: 'controlled-original-choice', role: 'catalog' } },
    originalSha256: '', receipt: { commandId, kind: 'library.import.confirm', state: 'succeeded', libraryIds: [root.id], message: null } }
  operation.originalSha256 = localLibraryManagementDigest(operation.original)
  const binding: LocalLibraryManagementBindingRecord = { schema: 1, kind: 'binding', datasetId: identity.datasetId, key: root.id,
    revision: 1, libraryId: root.id, sourceRootId: source.id, rootRevision: root.revision, role: 'catalog', name: '自有目录',
    active: true, watchEnabled: false, operationId: commandId }
  catalog.privateLibraryManagementCompareAndSwap(identity, [{ record: binding, expectedRevision: null }, { record: operation, expectedRevision: null }])
  t.after(async () => { repository.close(); state.close(); await rm(directory, { recursive: true }) })
  return { repository, catalog, identity, source }
}

const originalMissing = { kind: 'error', collection: true, code: 'INVENTORY_CONFLICT', message: '源目录不存在。' }
function outcome(read: () => unknown) {
  try { return { kind: 'returned', value: read() } }
  catch (error) {
    if (!(error instanceof Error)) throw error
    return { kind: 'error', collection: error instanceof CollectionError,
      code: 'code' in error ? error.code : null, message: error.message }
  }
}

test('Source JSON null：原SourceStore.root与组织读取均保留INVENTORY_CONFLICT和原消息', async t => {
  const f = await fixture(t)
  assert.equal(f.repository.sources.root(f.source.id).id, f.source.id)
  assert.equal(f.catalog.privateLibraryManagementOrganizations(f.identity).length, 1)
  // 同连接受控损坏夹具，只验证原作者对合法JSON null的拒绝合同；不改其他JSON类型规则。
  f.repository.privateMobileCatalogAccess!(db => db.prepare("UPDATE source_roots SET data='null' WHERE id=?").run(f.source.id))
  const observed = [outcome(() => f.repository.sources.root(f.source.id)),
    outcome(() => f.catalog.privateLibraryManagementOrganizations(f.identity))]
  console.log(JSON.stringify({ diagnostic: 'source-json-null-contract', observed }))
  assert.deepEqual(observed, [originalMissing, originalMissing])
})

test('Source SQL缺行：原SourceStore.root与组织读取均保留INVENTORY_CONFLICT和原消息', async t => {
  const f = await fixture(t)
  f.repository.privateMobileCatalogAccess!(db => {
    // 延迟FK仅在自有回滚事务中造缺行；foreign_keys保持ON，完整核验守门继续生效。
    db.exec('BEGIN'); db.exec('PRAGMA defer_foreign_keys=ON')
    try {
      db.prepare('DELETE FROM source_roots WHERE id=?').run(f.source.id)
      const observed = [outcome(() => f.repository.sources.root(f.source.id)),
        outcome(() => f.catalog.privateLibraryManagementOrganizations(f.identity))]
      console.log(JSON.stringify({ diagnostic: 'source-missing-row-contract', observed }))
      assert.deepEqual(observed, [originalMissing, originalMissing])
    } finally { db.exec('ROLLBACK') }
  })
  assert.equal(f.repository.sources.root(f.source.id).id, f.source.id)
  assert.equal(f.catalog.privateLibraryManagementOrganizations(f.identity).length, 1)
})
