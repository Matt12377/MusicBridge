import assert from 'node:assert/strict';
import { lstat, mkdtemp, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { createCollectionRepository } from '../src/collection/repository.js';
import { runLocalLibraryStartupAudit } from '../src/collection/local-library-startup-audit.js';
import { captureLocalCatalogAuditState } from '../src/collection/local-catalog-store.js';
import { captureLocalScanAuditState } from '../src/collection/local-scan-store.js';
import { readLocalStartupAuditCache, saveLocalStartupAuditCache } from '../src/collection/local-startup-audit-cache.js';

async function fixture(t: TestContext) {
  const temporary = process.env.TMPDIR;
  assert.ok(temporary && path.isAbsolute(temporary));
  assert.equal(await realpath(temporary), temporary);
  if (process.platform === 'darwin') assert.ok(path.resolve(temporary).startsWith('/Volumes/LifeWeave/Developer/CommandLine/tmp/'));
  const directory = await mkdtemp(path.join(temporary, 'library-startup-audit-service-'));
  const filePath = path.join(directory, 'collection.sqlite');
  const repository = createCollectionRepository({ filePath });
  repository.list({ offset: 0, limit: 1 });
  const db = repository.localCatalog.privateRead(current => current);
  t.after(async () => {
    if (db.isTransaction) db.exec('ROLLBACK'); repository.close();
    const target = await realpath(directory), info = await lstat(directory);
    assert.equal(target, directory); assert.equal(path.dirname(target), temporary);
    assert.match(path.basename(target), /^library-startup-audit-service-[A-Za-z0-9]+$/u);
    assert.ok(info.isDirectory() && !info.isSymbolicLink()); assert.equal(info.mode & 0o777, 0o700);
    if (typeof process.getuid === 'function') assert.equal(info.uid, process.getuid());
    await rm(target, { recursive: true, force: true });
  });
  return { filePath, repository, db };
}

test('启动审计服务：两域完整核验完成才返回，原事务与提交权仍属于调用者', async t => {
  const f = await fixture(t), stages: string[] = [];
  const changes = f.db.prepare('SELECT total_changes() n').get()!.n;
  f.db.exec('BEGIN IMMEDIATE');
  const reused = runLocalLibraryStartupAudit({ ...f, stage(name, operation) { stages.push(name); return operation(); } });
  assert.equal(reused, false); assert.deepEqual(stages, ['catalog', 'scan']);
  assert.equal(f.db.isTransaction, true); assert.equal(f.db.prepare('SELECT total_changes() n').get()!.n, changes);
  assert.ok(captureLocalCatalogAuditState(f.db)); assert.ok(captureLocalScanAuditState(f.db));
});

test('启动审计服务：真实scan schema失败清除先成功的catalog证明，不返回部分就绪', async t => {
  const f = await fixture(t), stages: string[] = [];
  f.db.exec('DROP INDEX local_scan_receipts_prepared; BEGIN IMMEDIATE');
  let catalogWasVerified = false;
  assert.throws(() => runLocalLibraryStartupAudit({ ...f, stage(name, operation) {
    stages.push(name); const result = operation();
    if (name === 'catalog') catalogWasVerified = !!captureLocalCatalogAuditState(f.db);
    return result;
  } }));
  assert.equal(catalogWasVerified, true); assert.deepEqual(stages, ['catalog', 'scan']);
  assert.equal(captureLocalCatalogAuditState(f.db), undefined); assert.equal(captureLocalScanAuditState(f.db), undefined);
  assert.equal(f.db.isTransaction, true, '失败也不擅自提交或回滚原Owner事务');
});

test('启动审计服务：取消保留原异常且撤销两域派生证明', async t => {
  const f = await fixture(t), cancelled = new Error('controlled startup audit cancellation');
  f.db.exec('BEGIN IMMEDIATE');
  assert.throws(() => runLocalLibraryStartupAudit({ ...f, stage(name, operation) {
    if (name === 'scan') throw cancelled;
    return operation();
  } }), error => error === cancelled);
  assert.equal(captureLocalCatalogAuditState(f.db), undefined); assert.equal(captureLocalScanAuditState(f.db), undefined);
});

test('启动审计服务：不在原事务中的误用不能形成就绪结果', async t => {
  const f = await fixture(t);
  assert.equal(f.db.isTransaction, false);
  assert.throws(() => runLocalLibraryStartupAudit(f));
  assert.equal(captureLocalCatalogAuditState(f.db), undefined); assert.equal(captureLocalScanAuditState(f.db), undefined);
});

test('启动审计服务：真实内容与实现绑定的缓存命中不再重放两域，但仍不提交原事务', async t => {
  const f = await fixture(t), implementationVersion = 'd'.repeat(64);
  assert.equal(await saveLocalStartupAuditCache(f.db, f.filePath, { implementationVersion }), true);
  const candidate = await readLocalStartupAuditCache(f.filePath, { implementationVersion }); assert.ok(candidate);
  f.db.exec('BEGIN IMMEDIATE');
  const stages: string[] = [];
  assert.equal(runLocalLibraryStartupAudit({ ...f, candidate, stage(name, operation) { stages.push(name); return operation(); } }), true);
  assert.deepEqual(stages, []); assert.equal(f.db.isTransaction, true);
  assert.ok(captureLocalCatalogAuditState(f.db)); assert.ok(captureLocalScanAuditState(f.db));
});
