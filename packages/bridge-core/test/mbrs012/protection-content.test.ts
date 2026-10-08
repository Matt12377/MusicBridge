import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import * as dto from '@music-bridge/contracts';
import { buildStoragePolicy } from '../../../../apps/desktop/scripts/build-storage-root.mjs';
import { catalogFixture } from '../mbrs006/catalog-fixture.js';
import { preparationFixture } from '../helpers/preparation-fixture.js';
import { createCollectionRepository, type CollectionRepository } from '../../src/collection/repository.js';
import { createLocalSourceWritesStore } from '../../src/collection/local-source-writes-store.js';
import { sourceWritesEvent, sourceWritesHash, sourceWritesRequestFingerprint } from '../../src/collection/local-source-writes-journal.js';
import { createSourceProtectionStore, type SourceProtectionProjection } from '../../src/recording/source-protection-store.js';

type CatalogFixture = Awaited<ReturnType<typeof catalogFixture>>;
const at = '2026-10-08T00:00:00.000Z';
// 独立保留旧保护表全集；逐表缺失的负例不能随产品名单削减而一起变绿。
const protectedTables = [
  'source_roots', 'source_bindings', 'source_ledger', 'master_versions', 'layout_versions',
  'preparation_destinations', 'preparation_jobs', 'preparation_workspaces', 'prepared_selections',
  'prepared_jobs', 'prepared_versions', 'execution_jobs', 'execution_assets', 'archive_roots',
  'archive_operations', 'archive_objects', 'archive_references', 'recording_plan_versions',
  'recording_plan_ledger', 'recording_attempts', 'recording_attempt_events', 'recording_attempt_receipts',
  'output_run_legacy_attempts', 'output_run_barrier_events',
] as const;

function database(repository: CollectionRepository): DatabaseSync {
  return repository.localCatalog.privateRead(db => db);
}
function counters(db: DatabaseSync) {
  return {
    totalChanges: Number(db.prepare('SELECT total_changes() AS n').get()!.n),
    dataVersion: Number(db.prepare('PRAGMA data_version').get()!.data_version),
  };
}
function storedProtectionRows(db: DatabaseSync): string {
  return JSON.stringify(protectedTables.map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
}
function complete(projection: SourceProtectionProjection): void {
  assert.equal(projection.complete, true, projection.issues.join(','));
  assert.deepEqual(projection.issues, []);
  assert.match(projection.storageFingerprint, /^[a-f0-9]{64}$/u);
}
function incomplete(projection: SourceProtectionProjection, issue: string): void {
  assert.equal(projection.complete, false);
  assert.ok(projection.issues.includes(issue), projection.issues.join(','));
}
function rolledBack<T>(db: DatabaseSync, work: () => T): T {
  db.exec('SAVEPOINT mbrs012_protection_content');
  try { return work(); }
  finally {
    db.exec('ROLLBACK TO mbrs012_protection_content');
    db.exec('RELEASE mbrs012_protection_content');
  }
}
function previewReceipt(f: CatalogFixture) {
  const planId = randomUUID(), commandId = randomUUID();
  const intent: dto.LocalSourceWritesIntent = {
    kind: 'tags', target: { mode: 'single', trackId: f.tracks[0]!.id },
    fields: { title: { action: 'set', value: '仅用于保护内容指纹的合成预览' } },
  };
  const request: dto.PreviewLocalSourceWrites = { datasetId: f.datasetId, commandId, intent };
  const header: dto.LocalSourceWritesPlan = {
    version: 1, datasetId: f.datasetId, planId, jobId: randomUUID(), viewRevision: '1', journalSequence: '1',
    scope: 'SOURCE_FILES', range: 'TAGS', state: 'PREVIEWING', createdAt: at, readyAt: null, expiresAt: null,
    policyRevision: '1', planHash: null, contextFingerprint: null,
    journalFingerprint: sourceWritesHash({ planId, empty: true }), summary: '合成持久受理，无文件写入',
    items: [], issues: [],
    resourceSummary: { resources: 0, sharedTargets: 1, backupBytes: null, spaceVerified: false, protection: 'unknown' },
    undoOf: null, recoveryOf: null, recoveryChoices: [],
  };
  const receipt: dto.LocalSourceWritesReceipt = {
    datasetId: f.datasetId, commandId, command: 'localSourceWrites.preview',
    requestFingerprint: sourceWritesRequestFingerprint('localSourceWrites.preview', request),
    planId, jobId: header.jobId, outcome: 'accepted', policy: null, issue: null,
  };
  assert.ok(dto.isLocalSourceWritesPlan(header));
  assert.ok(dto.isLocalSourceWritesReceipt(receipt));
  const event = sourceWritesEvent({
    version: 1 as const, eventId: randomUUID(), datasetId: f.datasetId, planId, occurredAt: at,
    kind: 'receipt' as const, command: 'localSourceWrites.preview' as const, request,
    requestFingerprint: receipt.requestFingerprint, receipt, header, intent, ownerEpoch: f.epoch, policy: null,
  });
  return { event, request, receipt, planId };
}

test('012 真实receipt/journal追加增加total_changes：旧指纹变化，新24表内容指纹保持', async t => {
  const f = await catalogFixture(t), db = database(f.repository);
  const store = createLocalSourceWritesStore(f.repository.localCatalog, () => Date.parse(at));
  try {
    const originalRows = storedProtectionRows(db), oldBefore = f.repository.sourceProtection.snapshot();
    const sourceBefore = f.repository.sourceProtection.sourceWritesSnapshot(), countBefore = counters(db);
    complete(oldBefore); complete(sourceBefore);
    assert.notEqual(sourceBefore.storageFingerprint, oldBefore.storageFingerprint, '新旧Hash必须有独立domain');
    const accepted = previewReceipt(f); store.append(accepted.event);
    assert.deepEqual(store.receipt('localSourceWrites.preview', accepted.request), accepted.receipt);
    assert.equal(store.plan(f.datasetId, accepted.planId).plan.state, 'PREVIEWING');
    const countAccepted = counters(db), oldAccepted = f.repository.sourceProtection.snapshot();
    assert.ok(countAccepted.totalChanges > countBefore.totalChanges);
    assert.equal(countAccepted.dataVersion, countBefore.dataVersion);
    assert.notEqual(oldAccepted.storageFingerprint, oldBefore.storageFingerprint);
    assert.deepEqual(f.repository.sourceProtection.sourceWritesSnapshot(), sourceBefore);
    store.state(f.datasetId, accepted.planId, 'BLOCKED', ['POLICY_DISABLED']);
    assert.equal(store.plan(f.datasetId, accepted.planId).plan.state, 'BLOCKED');
    assert.ok(counters(db).totalChanges > countAccepted.totalChanges);
    assert.notEqual(f.repository.sourceProtection.snapshot().storageFingerprint, oldAccepted.storageFingerprint);
    assert.deepEqual(f.repository.sourceProtection.sourceWritesSnapshot(), sourceBefore);
    assert.equal(storedProtectionRows(db), originalRows, '新域持久事件没有改旧保护记录');
    assert.deepEqual(await readFile(path.join(f.media, '一.wav')), f.bytes);
  } finally { store.close(); }
});

test('012 另一真实SQLite连接的目录写入改变data_version：旧指纹变化，私有内容指纹保持', async t => {
  const f = await catalogFixture(t), db = database(f.repository);
  const writer = createCollectionRepository({ filePath: path.join(f.directory, 'collection.sqlite') });
  try {
    // 先完成第二Owner冷核，再单独观察其正常目录事务；不直接伪造计数或覆盖保护projection。
    assert.equal(writer.localCatalog.pageTracks({ offset: 0, limit: 1 }).items.length, 1);
    const originalRows = storedProtectionRows(db), before = counters(db);
    const oldBefore = f.repository.sourceProtection.snapshot(), sourceBefore = f.repository.sourceProtection.sourceWritesSnapshot();
    complete(oldBefore); complete(sourceBefore);
    writer.localCatalog.createEdition({ commandId: randomUUID(), title: '无关目录元数据', edition: '合成' });
    const after = counters(db);
    assert.equal(after.totalChanges, before.totalChanges, '另一连接的提交不增加此连接total_changes');
    assert.ok(after.dataVersion > before.dataVersion);
    assert.notEqual(f.repository.sourceProtection.snapshot().storageFingerprint, oldBefore.storageFingerprint);
    assert.deepEqual(f.repository.sourceProtection.sourceWritesSnapshot(), sourceBefore);
    assert.equal(storedProtectionRows(db), originalRows);
  } finally { writer.close(); }
});

test('012 私有内容指纹冷重开稳定，仍绑定独立domain与原schema版本', async t => {
  const f = await catalogFixture(t), accepted = previewReceipt(f);
  const store = createLocalSourceWritesStore(f.repository.localCatalog, () => Date.parse(at));
  store.append(accepted.event); store.state(f.datasetId, accepted.planId, 'BLOCKED', ['POLICY_DISABLED']);
  const original = f.repository.sourceProtection.sourceWritesSnapshot(); complete(original);
  store.close(); f.repository.close();
  const reopened = createCollectionRepository({ filePath: path.join(f.directory, 'collection.sqlite') });
  const coldStore = createLocalSourceWritesStore(reopened.localCatalog, () => Date.parse(at));
  try {
    assert.deepEqual(coldStore.receipt('localSourceWrites.preview', accepted.request), accepted.receipt);
    assert.equal(coldStore.plan(f.datasetId, accepted.planId).plan.state, 'BLOCKED');
    assert.deepEqual(reopened.sourceProtection.sourceWritesSnapshot(), original);
    const db = database(reopened), schema = Number(db.prepare('PRAGMA user_version').get()!.user_version);
    assert.equal(schema, 34);
    rolledBack(db, () => {
      db.exec('PRAGMA user_version=33');
      assert.notEqual(reopened.sourceProtection.sourceWritesSnapshot().storageFingerprint, original.storageFingerprint);
    });
    assert.equal(Number(db.prepare('PRAGMA user_version').get()!.user_version), schema);
    assert.deepEqual(reopened.sourceProtection.sourceWritesSnapshot(), original);
  } finally { coldStore.close(); reopened.close(); }
});

test('012 真实来源根撤销必须改变保护内容指纹；保留旧目录浏览与原文件', async t => {
  const f = await catalogFixture(t), db = database(f.repository), before = f.repository.sourceProtection.sourceWritesSnapshot();
  complete(before);
  const trackIds = f.repository.localCatalog.pageTracks({ offset: 0, limit: 200 }).items.map(value => value.id);
  f.repository.sources.revoke({ commandId: randomUUID(), id: f.source.id });
  const after = f.repository.sourceProtection.sourceWritesSnapshot();
  assert.notEqual(after.storageFingerprint, before.storageFingerprint);
  assert.equal(f.repository.sources.root(f.source.id).authorized, false);
  const row = db.prepare('SELECT data FROM source_roots WHERE id=?').get(f.source.id)!;
  assert.equal((JSON.parse(String(row.data)) as { authorized: boolean }).authorized, false);
  assert.deepEqual(f.repository.localCatalog.pageTracks({ offset: 0, limit: 200 }).items.map(value => value.id), trackIds);
  assert.deepEqual(await readFile(path.join(f.media, '一.wav')), f.bytes);
});

test('012 新内容Hash复用真实Frozen冷核：错contentHash及撤销根仍UNKNOWN，不改旧证据', async t => {
  const storage = buildStoragePolicy();
  storage.check(process.env.TMPDIR!, { mustExist: true }); storage.check(os.tmpdir(), { mustExist: true });
  const f = await preparationFixture(t), job = await f.freeze(); await f.versions.idle();
  assert.equal(f.versions.job(job.id).job?.state, 'completed');
  const db = database(f.repository), old = f.repository.sourceProtection.snapshot();
  const before = f.repository.sourceProtection.sourceWritesSnapshot(); complete(old); complete(before);
  assert.deepEqual(before.references, old.references);
  assert.ok(before.references.some(ref => ref.kind === 'MASTER' && ref.locations.some(location => location.physical !== null)));
  assert.ok(before.references.reduce((count, ref) => count + ref.locations.length, 0) > 1);
  const limited = createSourceProtectionStore({ read: fn => fn(db), budget: { locations: 1 } });
  incomplete(limited.sourceWritesSnapshot(), 'SOURCE_PROTECTION_BUDGET_EXCEEDED');
  incomplete(limited.snapshot(), 'SOURCE_PROTECTION_BUDGET_EXCEEDED');
  const originalMaster = db.prepare('SELECT id,data FROM master_versions ORDER BY rowid LIMIT 1').get()!;
  const originalBytes = await readFile(f.file);
  rolledBack(db, () => {
    const master = JSON.parse(String(originalMaster.data)) as dto.MasterVersion;
    assert.ok(dto.isMasterVersion(master));
    master.contentHash = master.contentHash === 'a'.repeat(64) ? 'b'.repeat(64) : 'a'.repeat(64);
    assert.ok(dto.isMasterVersion(master), '负例保持原DTO合法，单独触发Frozen内容Hash核验');
    db.exec('DROP TRIGGER master_versions_no_update');
    db.prepare('UPDATE master_versions SET data=? WHERE id=?').run(JSON.stringify(master), String(originalMaster.id));
    const damaged = f.repository.sourceProtection.sourceWritesSnapshot();
    incomplete(damaged, 'HISTORY_CORRUPT');
    assert.notEqual(damaged.storageFingerprint, before.storageFingerprint);
    incomplete(f.repository.sourceProtection.snapshot(), 'HISTORY_CORRUPT');
  });
  assert.deepEqual(f.repository.sourceProtection.sourceWritesSnapshot(), before);
  await f.sources.revoke({ commandId: randomUUID(), id: f.root.id });
  const revoked = f.repository.sourceProtection.sourceWritesSnapshot();
  incomplete(revoked, 'SOURCE_ROOT_REVOKED'); assert.notEqual(revoked.storageFingerprint, before.storageFingerprint);
  assert.ok(revoked.references.some(ref => ref.kind === 'MASTER' && ref.locations.some(location => location.authorization === 'REVOKED')));
  assert.equal(db.prepare('SELECT data FROM master_versions WHERE id=?').get(String(originalMaster.id))!.data, originalMaster.data);
  assert.deepEqual(await readFile(f.file), originalBytes);
});

test('012 非规范旧JSON不能借内容Hash通过：重复键仍不完整且不回写损坏原文', async t => {
  const f = await catalogFixture(t), db = database(f.repository), before = f.repository.sourceProtection.sourceWritesSnapshot();
  complete(before);
  const original = String(db.prepare('SELECT data FROM source_roots WHERE id=?').get(f.source.id)!.data);
  const damaged = original.replace('{', '{"authorized":false,');
  assert.notEqual(damaged, original);
  assert.equal((JSON.parse(damaged) as { authorized: boolean }).authorized, true, '重复键解析后看似合法，不应覆盖原文核验');
  db.prepare('UPDATE source_roots SET data=? WHERE id=?').run(damaged, f.source.id);
  const projection = f.repository.sourceProtection.sourceWritesSnapshot();
  incomplete(projection, 'HISTORY_CORRUPT'); assert.notEqual(projection.storageFingerprint, before.storageFingerprint);
  incomplete(f.repository.sourceProtection.snapshot(), 'HISTORY_CORRUPT');
  assert.equal(db.prepare('SELECT data FROM source_roots WHERE id=?').get(f.source.id)!.data, damaged);
  assert.deepEqual(await readFile(path.join(f.media, '一.wav')), f.bytes);
});

test('012 24张旧保护表逐一缺失均保守拒绝，空表也不能从新审计全集删去', async t => {
  const f = await catalogFixture(t), db = database(f.repository), before = f.repository.sourceProtection.sourceWritesSnapshot();
  complete(before); assert.equal(protectedTables.length, 24); assert.equal(new Set(protectedTables).size, 24);
  const originalRows = storedProtectionRows(db);
  for (const table of protectedTables) {
    assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table), table);
    rolledBack(db, () => {
      // 合成库内临时改名使该表真正不可读；ROLLBACK同时恢复旧FK/trigger/schema原文。
      db.exec(`ALTER TABLE ${table} RENAME TO mbrs012_missing_protection_table`);
      const source = f.repository.sourceProtection.sourceWritesSnapshot(), old = f.repository.sourceProtection.snapshot();
      assert.equal(source.complete, false, `${table}缺失时新内容审计不能声称完整`);
      assert.ok(source.issues.includes('HISTORY_CORRUPT'), table);
      incomplete(old, 'HISTORY_CORRUPT');
    });
    assert.deepEqual(f.repository.sourceProtection.sourceWritesSnapshot(), before, `${table}回滚后内容证明恢复`);
  }
  assert.equal(storedProtectionRows(db), originalRows);
});

test('012 新内容审计仍服从原行数/总字节/单行预算，超限不截断历史或阻断旧浏览', async t => {
  const f = await catalogFixture(t), db = database(f.repository), before = f.repository.sourceProtection.sourceWritesSnapshot();
  complete(before); assert.ok(before.rows > 1);
  const originalRows = storedProtectionRows(db), actualRows = protectedTables.flatMap(table => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
  const largestRow = Math.max(...actualRows.map(row => Buffer.byteLength(JSON.stringify(row)))); assert.ok(largestRow > 1);
  const budgets: Partial<{ rows: number; bytes: number; rowBytes: number }>[] = [{ rows: before.rows - 1 }, { bytes: before.bytes - 1 }, { rowBytes: largestRow - 1 }];
  for (const budget of budgets) {
    const limited = createSourceProtectionStore({ read: fn => fn(db), budget });
    incomplete(limited.sourceWritesSnapshot(), 'SOURCE_PROTECTION_BUDGET_EXCEEDED');
    incomplete(limited.snapshot(), 'SOURCE_PROTECTION_BUDGET_EXCEEDED');
    assert.deepEqual(f.repository.sourceProtection.sourceWritesSnapshot(), before);
  }
  assert.equal(storedProtectionRows(db), originalRows);
  assert.deepEqual(f.repository.localCatalog.pageTracks({ offset: 0, limit: 200 }).items.map(value => value.id), f.tracks.map(value => value.id));
});

test('012 原8MiB单行预算在SQLite长度阶段拒绝：新旧审计均不先加载巨型JSON', async t => {
  const f = await catalogFixture(t), db = database(f.repository); complete(f.repository.sourceProtection.sourceWritesSnapshot());
  const damaged = JSON.stringify({ damaged: 'x'.repeat(9 * 1024 * 1024) });
  db.prepare('UPDATE source_roots SET data=? WHERE id=?').run(damaged, f.source.id);
  const originalLength = Number(db.prepare('SELECT length(CAST(data AS BLOB)) AS n FROM source_roots WHERE id=?').get(f.source.id)!.n);
  assert.ok(originalLength > 8 * 1024 * 1024);
  const prepare = DatabaseSync.prototype.prepare; let loaded = 0;
  t.mock.method(DatabaseSync.prototype, 'prepare', function (this: DatabaseSync, sql: string) {
    const statement = prepare.call(this, sql);
    if (sql !== 'SELECT * FROM source_roots WHERE rowid=?') return statement;
    return new Proxy(statement, { get(target, key) {
      if (key === 'get') return (...args: unknown[]) => { loaded++; return Reflect.apply(target.get, target, args); };
      const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value;
    } });
  });
  incomplete(f.repository.sourceProtection.sourceWritesSnapshot(), 'SOURCE_PROTECTION_BUDGET_EXCEEDED');
  incomplete(f.repository.sourceProtection.snapshot(), 'SOURCE_PROTECTION_BUDGET_EXCEEDED');
  assert.equal(loaded, 0, '未选出巨型旧JSON供Node解析或Hash');
  assert.equal(Number(db.prepare('SELECT length(CAST(data AS BLOB)) AS n FROM source_roots WHERE id=?').get(f.source.id)!.n), originalLength);
});
