import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Worker } from 'node:worker_threads';
import test, { type TestContext } from 'node:test';
import { createCollectionRepository } from '../src/collection/repository.js';
import { captureLocalCatalogAuditState, verifyLocalCatalogDatabase } from '../src/collection/local-catalog-store.js';
import { captureLocalScanAuditState, verifyLocalScanDatabase } from '../src/collection/local-scan-store.js';
import { readLocalStartupAuditCache, restoreLocalStartupAuditCache, saveLocalStartupAuditCache, captureLocalStartupAuditForActor, acceptLocalStartupAuditFromOwner } from '../src/collection/local-startup-audit-cache.js';
import { prepareOwnedDatasetDomain, type DatasetDomain } from '../src/collection/dataset-domain.js';
import { createMobileSqlWorker } from '../src/collection/local-album-browser/mobile-sql-worker.js';
import { readLibraryOperationLine } from '../src/shared/library-operation-log.js';

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
  assert.equal(captureLocalStartupAuditForActor(f.db, f.file, { implementationVersion: version }), undefined, 'checkpoint不能给原活连接重新盖可信物理水位');
  assert.equal(await saveLocalStartupAuditCache(f.db, f.file, { implementationVersion: version }), false);
  assert.equal(await saveLocalStartupAuditCache(f.db, f.file, { implementationVersion: version }), false, '重复调用仍必须保留原失效锚点');
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

test('活连接锚点：未变化重复保存不再生成整库指纹，也不替换原缓存文件', async t => {
  const f = await fixture(t), lines: string[] = [];
  t.mock.method(console, 'info', (line: string) => { lines.push(line); });
  assert.equal(await saveLocalStartupAuditCache(f.db, f.file, { implementationVersion: version }), true);
  const before = await lstat(f.cache, { bigint: true }), bytes = await readFile(f.cache);
  assert.equal(await saveLocalStartupAuditCache(f.db, f.file, { implementationVersion: version }), true);
  assert.equal(await saveLocalStartupAuditCache(f.db, f.file, { implementationVersion: version }), true);
  const after = await lstat(f.cache, { bigint: true });
  assert.deepEqual([after.dev, after.ino, after.size, after.mtimeNs, after.ctimeNs], [before.dev, before.ino, before.size, before.mtimeNs, before.ctimeNs]);
  assert.deepEqual(await readFile(f.cache), bytes);
  const events = lines.map(line => readLibraryOperationLine(line));
  assert.equal(events.filter(event => event?.action === 'startup.audit-fingerprint' && event.state === 'start').length, 1);
  assert.equal(events.filter(event => event?.action === 'startup.audit-cache-save' && event.code === 'ANCHOR_CURRENT').length, 2);
});

test('Owner恢复连接锚点：提交后只绑定本连接实际SQL点，无变化保存沿用原文件和内容指纹', async t => {
  const f = await fixture(t);
  f.db.exec('UPDATE preparation_zip_session SET epoch=epoch+1 WHERE id=1');
  assert.equal(await saveLocalStartupAuditCache(f.db, f.file, { implementationVersion: version }), true);
  const candidate = await readLocalStartupAuditCache(f.file, { implementationVersion: version }); assert.ok(candidate);
  const reader = f.reader();
  assert.notEqual(f.db.prepare('SELECT total_changes() n').get()?.n, reader.prepare('SELECT total_changes() n').get()?.n);
  assert.equal(restoreLocalStartupAuditCache(reader, f.file, candidate), true);
  // 此连接模拟成功交付的可写Owner；其TEMP观察器与原启动事务一并提交。
  reader.exec('COMMIT');
  assert.ok(captureLocalCatalogAuditState(reader)); assert.ok(captureLocalScanAuditState(reader));
  const before = await lstat(f.cache, { bigint: true }), lines: string[] = [];
  t.mock.method(console, 'info', (line: string) => { lines.push(line); });
  assert.equal(await saveLocalStartupAuditCache(reader, f.file, { implementationVersion: version }), true);
  const after = await lstat(f.cache, { bigint: true });
  assert.deepEqual([after.dev, after.ino, after.size, after.mtimeNs, after.ctimeNs], [before.dev, before.ino, before.size, before.mtimeNs, before.ctimeNs]);
  const events = lines.map(line => readLibraryOperationLine(line));
  assert.equal(events.some(event => event?.action === 'startup.audit-fingerprint'), false);
  assert.equal(events.some(event => event?.action === 'startup.audit-cache-save' && event.code === 'ANCHOR_CURRENT'), true);
});

test('活连接锚点：缓存原位损坏、删除或替换都不能继续交付旧RAM候选', async t => {
  const f = await fixture(t);
  assert.equal(await saveLocalStartupAuditCache(f.db, f.file, { implementationVersion: version }), true);
  const old = captureLocalStartupAuditForActor(f.db, f.file, { implementationVersion: version }); assert.ok(old);
  const bytes = await readFile(f.cache); bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1; await writeFile(f.cache, bytes);
  assert.equal(captureLocalStartupAuditForActor(f.db, f.file, { implementationVersion: version }), undefined);
  assert.equal(acceptLocalStartupAuditFromOwner(f.file, old, { implementationVersion: version }), undefined);
  assert.equal(await saveLocalStartupAuditCache(f.db, f.file, { implementationVersion: version }), true);
  const repaired = captureLocalStartupAuditForActor(f.db, f.file, { implementationVersion: version }); assert.ok(repaired);
  await unlink(f.cache);
  assert.equal(acceptLocalStartupAuditFromOwner(f.file, repaired, { implementationVersion: version }), undefined);
  assert.equal(captureLocalStartupAuditForActor(f.db, f.file, { implementationVersion: version }), undefined);
  assert.equal(await saveLocalStartupAuditCache(f.db, f.file, { implementationVersion: version }), true);
  assert.equal(acceptLocalStartupAuditFromOwner(f.file, repaired, { implementationVersion: version }), undefined, '相同内容的新文件也不能冒充原缓存文件身份');
});

test('活连接锚点：外部SQLite写、实现变化和未提交事务都关闭RAM复用', async t => {
  const f = await fixture(t);
  assert.equal(await saveLocalStartupAuditCache(f.db, f.file, { implementationVersion: version }), true);
  assert.equal(captureLocalStartupAuditForActor(f.db, f.file, { implementationVersion: 'b'.repeat(64) }), undefined);
  assert.equal(await saveLocalStartupAuditCache(f.db, f.file, { implementationVersion: version }), true);
  const old = captureLocalStartupAuditForActor(f.db, f.file, { implementationVersion: version }); assert.ok(old);
  f.db.exec('BEGIN IMMEDIATE');
  try {
    assert.equal(captureLocalStartupAuditForActor(f.db, f.file, { implementationVersion: version }), undefined);
    assert.equal(await saveLocalStartupAuditCache(f.db, f.file, { implementationVersion: version }), false);
  } finally { f.db.exec('ROLLBACK'); }
  const external = new DatabaseSync(f.file, { allowExtension: false });
  try { external.exec("CREATE TABLE external_anchor_probe(value TEXT);INSERT INTO external_anchor_probe VALUES('已变化')"); }
  finally { external.close(); }
  assert.equal(captureLocalStartupAuditForActor(f.db, f.file, { implementationVersion: version }), undefined);
  assert.equal(acceptLocalStartupAuditFromOwner(f.file, old, { implementationVersion: version }), undefined);
  assert.equal(await saveLocalStartupAuditCache(f.db, f.file, { implementationVersion: version }), false);
});

test('Owner纯锚点：复制不共享Map，实际事务重核变化且不接纳函数或伪造版本', async t => {
  const f = await fixture(t);
  assert.equal(await saveLocalStartupAuditCache(f.db, f.file, { implementationVersion: version }), true);
  const first = captureLocalStartupAuditForActor(f.db, f.file, { implementationVersion: version }); assert.ok(first);
  const second = captureLocalStartupAuditForActor(f.db, f.file, { implementationVersion: version }); assert.ok(second);
  assert.notEqual(first.catalog, second.catalog);
  assert.notEqual((first.catalog as { rows: Map<string, number> }).rows, (second.catalog as { rows: Map<string, number> }).rows);
  assert.equal(acceptLocalStartupAuditFromOwner(f.file, { ...first, catalog: { liveSource() {} } }, { implementationVersion: version }), undefined);
  assert.equal(acceptLocalStartupAuditFromOwner(f.file, { ...first, runtime: '合成伪造运行时' }, { implementationVersion: version }), undefined);
  const accepted = acceptLocalStartupAuditFromOwner(f.file, second, { implementationVersion: version }); assert.ok(accepted);
  f.db.exec('CREATE TABLE after_owner_anchor(value TEXT)');
  const actor = f.reader();
  assert.equal(restoreLocalStartupAuditCache(actor, f.file, accepted), false);
  assert.equal(captureLocalCatalogAuditState(actor), undefined); assert.equal(captureLocalScanAuditState(actor), undefined);
  actor.exec('ROLLBACK');
});

for (const replaced of [false, true]) test(replaced
  ? '实际只读Actor：Owner旧缓存文件身份失效后退回磁盘内容核验，仍完成原事务/回滚/关闭'
  : '实际只读Actor：可信Owner纯锚点跳过整库指纹，仍完成原事务/回滚/关闭', { timeout: 20_000 }, async t => {
  const f = await fixture(t);
  assert.equal(await saveLocalStartupAuditCache(f.db, f.file, { implementationVersion: version }), true);
  const captured = captureLocalStartupAuditForActor(f.db, f.file, { implementationVersion: version }); assert.ok(captured);
  if (replaced) {
    await unlink(f.cache);
    assert.equal(await saveLocalStartupAuditCache(f.db, f.file, { implementationVersion: version }), true);
    assert.equal(acceptLocalStartupAuditFromOwner(f.file, captured, { implementationVersion: version }), undefined);
  }
  const events: NonNullable<ReturnType<typeof readLibraryOperationLine>>[] = [], stages: string[] = [], exits: number[] = [];
  let delivered = false;
  const actor = createMobileSqlWorker({ databaseFile: f.file,
    captureStartupAudit: () => captured,
    workerFactory(options) {
      delivered = Object.hasOwn(options.workerData, 'startupAudit');
      assert.doesNotThrow(() => structuredClone(options.workerData));
      const worker = new Worker(new URL('./helpers/mobile-sql-startup-anchor-worker.ts', import.meta.url), { ...options, stdout: true, execArgv: ['--import', 'tsx'] });
      let pending = '';
      worker.stdout!.on('data', chunk => {
        pending += String(chunk); const lines = pending.split('\n'); pending = lines.pop() ?? '';
        for (const line of lines) { const event = readLibraryOperationLine(line); if (event) events.push(event); }
      });
      worker.on('message', message => { if (message.type === 'stage') stages.push(message.stage); });
      worker.on('exit', code => exits.push(code));
      return worker;
    },
  });
  try { await actor.prepare({ revision: '0'.repeat(64), roots: [] }, () => {}); }
  finally { await actor.close(); }
  assert.equal(delivered, true);
  assert.equal(events.some(event => event.action === 'startup.audit-owner-anchor' && event.state === 'hit'), !replaced);
  assert.equal(events.some(event => event.action === 'startup.audit-fingerprint' && event.state === 'start'), replaced);
  if (replaced) assert.equal(events.some(event => event.action === 'startup.audit-cache' && event.state === 'hit'), true);
  assert.ok(stages.includes('begun') && stages.includes('rollback') && stages.includes('closed'));
  assert.deepEqual(exits, [0]);
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
