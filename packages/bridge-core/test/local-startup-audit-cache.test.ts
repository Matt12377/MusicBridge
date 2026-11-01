import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { createCollectionRepository } from '../src/collection/repository.js';
import { captureLocalCatalogAuditState, verifyLocalCatalogDatabase } from '../src/collection/local-catalog-store.js';
import { captureLocalScanAuditState, verifyLocalScanDatabase } from '../src/collection/local-scan-store.js';
import { readLocalStartupAuditCache, restoreLocalStartupAuditCache, saveLocalStartupAuditCache } from '../src/collection/local-startup-audit-cache.js';
import { prepareOwnedDatasetDomain, type DatasetDomain } from '../src/collection/dataset-domain.js';

const version = 'a'.repeat(64);
async function fixture(t: TestContext) {
  const temporary = process.env.TMPDIR;
  assert.ok(temporary && path.isAbsolute(temporary));
  if (process.platform === 'darwin') assert.ok(path.resolve(temporary) === '/Volumes/LifeWeave/Developer/CommandLine/tmp' || path.resolve(temporary).startsWith('/Volumes/LifeWeave/Developer/CommandLine/tmp/'));
  const directory = await mkdtemp(path.join(temporary, 'local-startup-audit-'));
  const file = path.join(directory, 'work.sqlite');
  const repository = createCollectionRepository({ filePath: file });
  repository.list({ offset: 0, limit: 1 });
  const db = repository.localCatalog.privateRead(current => current);
  verifyLocalCatalogDatabase(db); verifyLocalScanDatabase(db);
  const connections: DatabaseSync[] = [];
  t.after(async () => { for (const reader of connections) reader.close(); repository.close(); await rm(directory, { recursive: true, force: true }); });
  const cache = path.join(directory, '.mousa-startup-audit', createHash('sha256').update(file).digest('hex') + '.bin');
  function reader() {
    const current = new DatabaseSync(file, { enableForeignKeyConstraints: true, allowExtension: false });
    current.exec('PRAGMA trusted_schema=OFF;BEGIN IMMEDIATE'); connections.push(current); return current;
  }
  return { directory, file, cache, db, repository, reader };
}

test('启动核验缓存：内容指纹匹配后恢复两域，普通checkpoint与关库布局变化不要求重放历史', async t => {
  const f = await fixture(t);
  assert.equal(await saveLocalStartupAuditCache(f.db, f.file, { implementationVersion: version }), true);
  f.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  const candidate = await readLocalStartupAuditCache(f.file, { implementationVersion: version });
  assert.ok(candidate);
  const reader = f.reader();
  assert.equal(restoreLocalStartupAuditCache(reader, f.file, candidate), true);
  assert.ok(captureLocalCatalogAuditState(reader)); assert.ok(captureLocalScanAuditState(reader));
  reader.exec('ROLLBACK');
});

test('启动核验缓存：数据在WAL改变时失效，核验实现版本变化也不能复用', async t => {
  const f = await fixture(t);
  assert.equal(await saveLocalStartupAuditCache(f.db, f.file, { implementationVersion: version }), true);
  assert.equal(await readLocalStartupAuditCache(f.file, { implementationVersion: 'b'.repeat(64) }), undefined);
  f.db.exec("CREATE TABLE cache_change_probe(value TEXT);INSERT INTO cache_change_probe VALUES('变化');");
  assert.equal(await readLocalStartupAuditCache(f.file, { implementationVersion: version }), undefined);
  assert.equal(await saveLocalStartupAuditCache(f.db, f.file, { implementationVersion: version }), false, '未知SQL写不能保存成已核缓存');
});

test('启动核验缓存：读取指纹之后再发生修改，实际工作事务拒绝旧候选并清除两域', async t => {
  const f = await fixture(t);
  assert.equal(await saveLocalStartupAuditCache(f.db, f.file, { implementationVersion: version }), true);
  const candidate = await readLocalStartupAuditCache(f.file, { implementationVersion: version }); assert.ok(candidate);
  f.db.exec('UPDATE collection_models SET revision=revision+1');
  f.db.exec("CREATE TABLE changed_after_fingerprint(value TEXT)");
  const reader = f.reader();
  assert.equal(restoreLocalStartupAuditCache(reader, f.file, candidate), false);
  assert.equal(captureLocalCatalogAuditState(reader), undefined); assert.equal(captureLocalScanAuditState(reader), undefined);
  reader.exec('ROLLBACK');
});

test('启动核验缓存：损坏、缺失缓存都回到原完整核验，不改变工作库数据', async t => {
  const f = await fixture(t), before = f.db.prepare('SELECT count(*) n FROM local_catalog_ledger').get()?.n;
  assert.equal(await readLocalStartupAuditCache(f.file, { implementationVersion: version }), undefined);
  assert.equal(await saveLocalStartupAuditCache(f.db, f.file, { implementationVersion: version }), true);
  const bytes = await readFile(f.cache); bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1; await writeFile(f.cache, bytes);
  assert.equal(await readLocalStartupAuditCache(f.file, { implementationVersion: version }), undefined);
  verifyLocalCatalogDatabase(f.db); verifyLocalScanDatabase(f.db);
  assert.equal(f.db.prepare('SELECT count(*) n FROM local_catalog_ledger').get()?.n, before);
  assert.equal(await saveLocalStartupAuditCache(f.db, f.file, { implementationVersion: version }), true);
  assert.ok(await readLocalStartupAuditCache(f.file, { implementationVersion: version }));
});

test('启动核验缓存：缓存目录异常只关闭复用，库仍能完整核验和读取', async t => {
  const f = await fixture(t);
  await mkdir(path.dirname(f.cache));
  await mkdir(f.cache);
  assert.equal(await saveLocalStartupAuditCache(f.db, f.file, { implementationVersion: version }), false);
  assert.equal(await readLocalStartupAuditCache(f.file, { implementationVersion: version }), undefined);
  assert.equal(f.repository.list({ offset: 0, limit: 1 }).total, 0);
});

test('实际Owner冷准备：ZIP会话推进后才保存缓存，首代和重启后的只读连接都能复用', async () => {
  const temporary = process.env.TMPDIR; assert.ok(temporary && path.isAbsolute(temporary));
  const directory = await mkdtemp(path.join(temporary, 'owned-startup-audit-'));
  const macro = '__MUSIC_BRIDGE_LOCAL_AUDIT_VERSION__', previous = Object.getOwnPropertyDescriptor(globalThis, macro);
  Object.defineProperty(globalThis, macro, { configurable: true, value: version });
  let domain: DatasetDomain | undefined;
  try {
    for (const reopening of [false, true]) {
      domain = await prepareOwnedDatasetDomain({ dataDirectory: directory, epoch: randomUUID(), testMode: true,
        projection: { async call() { throw new Error('合成测试不连接Roon。'); } } });
      assert.equal(domain.collection.privateStartupAuditReused, reopening);
      const file = path.join(directory, 'collection.v1.sqlite');
      const candidate = await readLocalStartupAuditCache(file, { implementationVersion: version });
      assert.ok(candidate, 'Owner交付后的缓存必须包含本代ZIP会话变化');
      const actor = new DatabaseSync(file, { readOnly: true, enableForeignKeyConstraints: true, allowExtension: false });
      try {
        actor.exec('PRAGMA query_only=ON;PRAGMA trusted_schema=OFF;BEGIN');
        assert.equal(restoreLocalStartupAuditCache(actor, file, candidate), true);
        actor.exec('ROLLBACK');
      } finally { actor.close(); }
      await domain.close(); domain = undefined;
    }
  } finally {
    try { await domain?.close(); }
    finally {
      if (previous) Object.defineProperty(globalThis, macro, previous); else Reflect.deleteProperty(globalThis, macro);
      await rm(directory, { recursive: true, force: true });
    }
  }
});
