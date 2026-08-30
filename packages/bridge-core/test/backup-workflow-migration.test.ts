import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { BACKUP_INDEX_MISSING_FACTS } from '@music-bridge/contracts';
import { createBackupWorkflowStore } from '../src/recording/backup-workflow-store.js';
import type { PreparedRestoredDataset } from '../src/recording/restore-activation-files.js';

// 固定历史 v1 结构，不能从当前生产 schema 生成迁移输入。
const versionOneSchema = `
CREATE TABLE backup_roots(id TEXT PRIMARY KEY, data TEXT NOT NULL) STRICT;
CREATE TABLE backup_commands(command_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, result_id TEXT NOT NULL, action TEXT NOT NULL) STRICT;
CREATE TABLE backup_jobs(id TEXT PRIMARY KEY, data TEXT NOT NULL) STRICT;
CREATE TRIGGER backup_commands_no_update BEFORE UPDATE ON backup_commands BEGIN SELECT RAISE(ABORT,'备份确认账本不可改写'); END;
CREATE TRIGGER backup_commands_no_delete BEFORE DELETE ON backup_commands BEGIN SELECT RAISE(ABORT,'备份确认账本不可删除'); END;
PRAGMA application_id=1296192087;
PRAGMA user_version=1;
`;
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

async function versionOne(t: test.TestContext, index = false) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'musicbridge-ledger-migration-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'maintenance.sqlite');
  const db = new DatabaseSync(filePath);
  const capability = { id: randomUUID(), path: directory, dev: '1', ino: '2', authorized: true, label: '合成历史授权' };
  const authorization = { commandId: randomUUID(), kind: index ? 'backup-source' as const : 'backup-destination' as const };
  const root = { id: capability.id, kind: authorization.kind, label: capability.label, authorized: true };
  const request = index
    ? { commandId: randomUUID(), kind: 'index' as const, rootId: root.id, userConfirmed: true as const }
    : { commandId: randomUUID(), kind: 'backup' as const, rootId: root.id, mode: 'metadata' as const, userConfirmed: true as const };
  const view = {
    id: randomUUID(), kind: request.kind, rootId: root.id, createdAt: '2026-08-28T00:00:00.000Z',
    ...(index ? { state: 'succeeded' as const, index: { operationCount: 2, quarantinedCount: 1, issueCount: 3, historyTrusted: false, inventoryReconstructed: false } } : { state: 'running' as const, mode: 'metadata' as const }),
  };
  try {
    db.exec(versionOneSchema);
    db.prepare('INSERT INTO backup_roots VALUES(?,?)').run(root.id, JSON.stringify({ view: root, capability }));
    db.prepare('INSERT INTO backup_jobs VALUES(?,?)').run(view.id, JSON.stringify({ request, view }));
    db.prepare('INSERT INTO backup_commands VALUES(?,?,?,?)').run(authorization.commandId, digest([authorization.kind, capability.path, capability.dev, capability.ino, capability.label]), root.id, 'authorize');
    db.prepare('INSERT INTO backup_commands VALUES(?,?,?,?)').run(request.commandId, digest([request.kind, root.id, index ? null : 'metadata', null]), view.id, 'start');
    return { directory, filePath, capability, authorization, root, request, view, receipts: db.prepare('SELECT * FROM backup_commands ORDER BY command_id').all() };
  } finally { db.close(); }
}

function dataset(id: string, restoreId: string): PreparedRestoredDataset {
  const root = { id: randomUUID(), path: '/private/synthetic', dev: '1', ino: '2', authorized: true, label: '合成隔离库' };
  return { id, directory: root, database: { ...root, path: '/private/synthetic/database' }, databaseFile: { relative: 'collection.sqlite', sha256: 'a'.repeat(64), size: 1 }, source: { ...root, path: '/private/synthetic/source' }, restoreId, restoreManifestHash: 'b'.repeat(64), contentIncluded: false };
}

test('v1升级v3保持已有授权、任务、不可变命令回执；冷开不自动恢复或重放任务', async t => {
  const f = await versionOne(t), store = createBackupWorkflowStore({ filePath: f.filePath });
  try {
    assert.deepEqual(store.overview(), { roots: [f.root], jobs: [f.view], activations: [] });
    assert.deepEqual(store.authorize(f.authorization, f.capability), f.root);
    assert.deepEqual(store.startJob(f.request), f.view);
    assert.deepEqual(store.activations.overview(), { activeId: null, activations: [] });
  } finally { store.close(); }
  const db = new DatabaseSync(f.filePath);
  try {
    assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, 3);
    assert.deepEqual(db.prepare('SELECT * FROM backup_commands ORDER BY command_id').all(), f.receipts);
    assert.throws(() => db.exec('DELETE FROM backup_commands'));
    assert.throws(() => db.exec("UPDATE backup_commands SET action='activate'"));
  } finally { db.close(); }
  const cold = createBackupWorkflowStore({ filePath: f.filePath });
  try { assert.deepEqual(cold.startJob(f.request), f.view); assert.deepEqual(cold.authorizationReceipt(f.authorization.commandId), f.root); }
  finally { cold.close(); }
});

test('v1聚合index只补缺失说明，不伪造对象明细，原命令回执和聚合计数保持不变', async t => {
  const f = await versionOne(t, true), store = createBackupWorkflowStore({ filePath: f.filePath });
  assert.ok('index' in f.view);
  const expected = { ...f.view, index: { ...f.view.index, issueDetails: [], issueDetailsOmittedCount: 3, missingFacts: [...BACKUP_INDEX_MISSING_FACTS] } };
  try { assert.deepEqual(store.overview().jobs, [expected]); assert.deepEqual(store.startJob(f.request), expected); }
  finally { store.close(); }
  const db = new DatabaseSync(f.filePath);
  try {
    assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, 3);
    assert.deepEqual(db.prepare('SELECT * FROM backup_commands ORDER BY command_id').all(), f.receipts);
    assert.deepEqual(JSON.parse(String(db.prepare('SELECT data FROM backup_jobs WHERE id=?').get(f.view.id)?.data)), { request: f.request, view: expected });
  } finally { db.close(); }
});

test('固定v2结构升级v3保留激活指针与回执，新增身份表不重放激活', async t => {
  const f = await versionOne(t), id = randomUUID(), commandId = randomUUID(), restoreJobId = randomUUID();
  const view = { id, restoreJobId, previousId: null, state: 'failed', createdAt: new Date().toISOString(), issue: 'PREPARATION_FAILED' };
  const db = new DatabaseSync(f.filePath);
  try {
    // 固定历史 v2 结构，不引用当前生产建表文本。
    db.exec('CREATE TABLE restore_activations(id TEXT PRIMARY KEY, data TEXT NOT NULL) STRICT; CREATE TABLE active_dataset(singleton INTEGER PRIMARY KEY CHECK(singleton=1), active_id TEXT, pending_id TEXT) STRICT; INSERT INTO active_dataset VALUES(1,NULL,NULL); PRAGMA user_version=2;');
    db.prepare('INSERT INTO restore_activations VALUES(?,?)').run(id, JSON.stringify({ view }));
    db.prepare('INSERT INTO backup_commands VALUES(?,?,?,?)').run(commandId, createHash('sha256').update(JSON.stringify([restoreJobId, null])).digest('hex'), id, 'activate');
  } finally { db.close(); }
  const store = createBackupWorkflowStore({ filePath: f.filePath });
  try {
    assert.deepEqual(store.overview().activations, [view]);
    assert.deepEqual(store.activations.receipt({ commandId, restoreJobId, expectedActiveId: null, userConfirmed: true, stopPlaybackConfirmed: true }), view);
    assert.deepEqual(store.activations.beginBoot(), {});
    assert.deepEqual(store.startJob(f.request), f.view);
  } finally { store.close(); }
  const inspected = new DatabaseSync(f.filePath);
  try { assert.equal(inspected.prepare('PRAGMA user_version').get()?.user_version, 3); assert.equal(inspected.prepare('SELECT count(*) n FROM dataset_identities').get()?.n, 0); }
  finally { inspected.close(); }
});

test('激活回执复用维护连接；prepared冷开只在beginBoot租用，二次冷开回滚到上一已激活库', async t => {
  const f = await versionOne(t), first = createBackupWorkflowStore({ filePath: f.filePath });
  const request = { commandId: randomUUID(), restoreJobId: randomUUID(), expectedActiveId: null, userConfirmed: true as const, stopPlaybackConfirmed: true as const };
  let activeId = '', pendingId = '';
  const nextRequest = { ...request, commandId: randomUUID(), expectedActiveId: '' };
  try {
    activeId = first.activations.begin(request).view.id;
    first.activations.prepared(activeId, dataset(activeId, request.restoreJobId));
    first.activations.beginBoot(); first.activations.commitBoot(activeId);
    nextRequest.expectedActiveId = activeId;
    pendingId = first.activations.begin(nextRequest).view.id;
    first.activations.prepared(pendingId, dataset(pendingId, request.restoreJobId));
    const second = createBackupWorkflowStore({ filePath: f.filePath });
    try { assert.throws(() => second.activations.beginBoot()); }
    finally { second.close(); }
    assert.equal(first.overview().activations.find(value => value.id === pendingId)?.state, 'prepared');
  } finally { first.close(); }
  const second = createBackupWorkflowStore({ filePath: f.filePath });
  try {
    assert.equal(second.overview().activations.find(value => value.id === pendingId)?.state, 'prepared');
    const boot = second.activations.beginBoot();
    assert.equal(boot.active?.view.id, activeId); assert.equal(boot.pending?.view.id, pendingId);
    assert.equal(second.activations.overview().activeId, activeId);
    assert.equal(second.activations.begin(nextRequest).view.state, 'activating');
  } finally { second.close(); }
  const third = createBackupWorkflowStore({ filePath: f.filePath });
  try {
    const boot = third.activations.beginBoot();
    assert.equal(boot.active?.view.id, activeId); assert.equal(boot.pending, undefined);
    assert.equal(third.activations.get(pendingId).view.state, 'rolled-back');
    assert.equal(third.activations.get(pendingId).view.issue, 'BOOT_INTERRUPTED');
    assert.equal(third.activations.begin(nextRequest).view.state, 'rolled-back');
    assert.equal(JSON.stringify(third.overview()).includes('/private'), false);
  } finally { third.close(); }
});

for (const mutation of ['extra-object', 'future-version', 'invalid-legacy-index'] as const) {
  test(`未知结构或旧数据 ${mutation} 在迁移前拒绝，不改变字节和权限`, async t => {
    const f = await versionOne(t, mutation === 'invalid-legacy-index'), db = new DatabaseSync(f.filePath);
    try {
      if (mutation === 'extra-object') db.exec('CREATE TABLE sqliteX_user(value TEXT)');
      else if (mutation === 'future-version') db.exec('PRAGMA user_version=4');
      else {
        assert.ok('index' in f.view);
        db.prepare('UPDATE backup_jobs SET data=? WHERE id=?').run(JSON.stringify({ request: f.request, view: { ...f.view, index: { ...f.view.index, privatePath: '/private/unknown' } } }), f.view.id);
      }
    } finally { db.close(); }
    await chmod(f.filePath, 0o640);
    const before = await readFile(f.filePath), mode = (await stat(f.filePath)).mode;
    const store = createBackupWorkflowStore({ filePath: f.filePath });
    try { assert.throws(() => store.overview()); }
    finally { store.close(); }
    assert.ok((await readFile(f.filePath)).equals(before), '拒绝迁移不得改动原文件');
    assert.equal((await stat(f.filePath)).mode, mode);
  });
}
