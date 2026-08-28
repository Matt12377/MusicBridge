import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { PreparedRestoredDataset } from '../src/recording/restore-activation-files.js';
import { createBackupWorkflowStore } from '../src/recording/backup-workflow-store.js';

async function fixture(t: test.TestContext) {
  const module = await import('../src/recording/restore-activation-store.js').catch(() => ({}));
  assert.ok('createRestoreActivationStore' in module, '缺少激活意图与工作库指针事务边界');
  const api = module as typeof import('../src/recording/restore-activation-store.js');
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  db.exec('CREATE TABLE backup_commands(command_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, result_id TEXT NOT NULL, action TEXT NOT NULL) STRICT;');
  db.exec(api.restoreActivationSchema);
  const store = api.createRestoreActivationStore({ read: fn => fn(db), transaction: fn => {
    db.exec('BEGIN IMMEDIATE'); try { const result = fn(db); db.exec('COMMIT'); return result; } catch (error) { db.exec('ROLLBACK'); throw error; }
  } });
  const request = { commandId: randomUUID(), restoreJobId: randomUUID(), expectedActiveId: null, userConfirmed: true as const, stopPlaybackConfirmed: true as const };
  const prepared = (id: string): PreparedRestoredDataset => {
    const root = { id: randomUUID(), path: '/private/synthetic', dev: '1', ino: '2', authorized: true, label: '合成' };
    return { id, directory: root, database: { ...root, path: '/private/synthetic/database' }, databaseFile: { relative: 'collection.sqlite', sha256: 'a'.repeat(64), size: 1 }, source: { ...root, path: '/private/restore' }, restoreId: request.restoreJobId, restoreManifestHash: 'b'.repeat(64), contentIncluded: true };
  };
  return { store, request, prepared };
}

test('激活须单独确认影响，稳定命令回执不能改指向或自动重试失败', async t => {
  const f = await fixture(t);
  assert.throws(() => f.store.begin({ ...f.request, stopPlaybackConfirmed: false } as never));
  assert.deepEqual(f.store.overview(), { activeId: null, activations: [] });
  const value = f.store.begin(f.request);
  assert.equal(value.view.state, 'preparing');
  assert.equal(f.store.begin(f.request).view.id, value.view.id);
  assert.throws(() => f.store.begin({ ...f.request, restoreJobId: randomUUID() }));
  assert.throws(() => f.store.begin({ ...f.request, commandId: randomUUID() }));
  f.store.fail(value.view.id, 'PREPARATION_FAILED');
  assert.equal(f.store.begin(f.request).view.state, 'failed');
  assert.equal(f.store.overview().activeId, null);
});

test('Core首次启动只租用已确认候选，ready前指针不变；ready后原子切换', async t => {
  const f = await fixture(t), value = f.store.begin(f.request), prepared = f.prepared(value.view.id);
  f.store.prepared(value.view.id, prepared);
  const boot = f.store.beginBoot();
  assert.equal(boot.pending?.view.id, value.view.id);
  assert.equal(f.store.overview().activeId, null);
  assert.equal(f.store.overview().activations[0]?.state, 'activating');
  f.store.commitBoot(value.view.id);
  assert.equal(f.store.overview().activeId, value.view.id);
  assert.equal(f.store.beginBoot().active?.view.id, value.view.id);
  assert.equal(f.store.begin(f.request).view.state, 'active');
  assert.equal(JSON.stringify(f.store.overview()).includes('/private'), false);
});

test('准备中或激活中崩溃不自动重放；已激活工作库保留为回滚基线', async t => {
  const f = await fixture(t), interrupted = f.store.begin(f.request);
  assert.equal(f.store.beginBoot().pending, undefined);
  assert.equal(f.store.begin(f.request).view.state, 'failed');
  assert.equal(f.store.overview().activations[0]?.issue, 'PREPARATION_INTERRUPTED');
  const second = f.store.begin({ ...f.request, commandId: randomUUID() });
  f.store.prepared(second.view.id, f.prepared(second.view.id)); f.store.beginBoot(); f.store.commitBoot(second.view.id);
  const third = f.store.begin({ ...f.request, commandId: randomUUID(), expectedActiveId: second.view.id });
  f.store.prepared(third.view.id, f.prepared(third.view.id)); f.store.beginBoot();
  const recovery = f.store.beginBoot();
  assert.equal(recovery.pending, undefined);
  assert.equal(recovery.active?.view.id, second.view.id);
  assert.equal(f.store.get(third.view.id).view.state, 'rolled-back');
  assert.equal(f.store.overview().activeId, second.view.id);
  assert.throws(() => f.store.commitBoot(third.view.id));
  assert.throws(() => f.store.begin({ ...f.request, commandId: randomUUID() }));
  assert.notEqual(interrupted.view.id, second.view.id);
});

test('维护库激活确认冲突保持可识别冲突码，不伪装成存储故障要求无限重试', () => {
  const store = createBackupWorkflowStore({ filePath: ':memory:' });
  try {
    const request = { commandId: randomUUID(), restoreJobId: randomUUID(), expectedActiveId: null, userConfirmed: true as const, stopPlaybackConfirmed: true as const };
    store.activations.begin(request);
    assert.throws(() => store.activations.begin({ ...request, restoreJobId: randomUUID() }), { code: 'BACKUP_CONFLICT' });
  } finally { store.close(); }
});
