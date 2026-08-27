import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, stat, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import type { CollectionReceiveRequest } from '@music-bridge/contracts';
import { createCollectionRepository } from '../src/collection/repository.js';

const page = { offset: 0, limit: 100 };
const receipt = (overrides: Partial<CollectionReceiveRequest> = {}): CollectionReceiveRequest => ({
  commandId: randomUUID(),
  model: { brand: 'TDK', name: 'SA', edition: '1990', year: 1990, format: 'cassette', tapeType: 'II', identification: 'verified' },
  lengthMinutes: 90, quantities: { sealedBlank: 8, openedBlank: 0, legacyUsed: 0, unclassified: 0 }, ...overrides,
});
async function fixture(t: test.TestContext, beforeCommit?: (action: string) => void) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'musicbridge-inventory-'));
  const filePath = path.join(directory, 'collection.sqlite');
  const repository = createCollectionRepository({ filePath, ...(beforeCommit ? { beforeCommit } : {}) });
  t.after(async () => { repository.close(); await rm(directory, { recursive: true, force: true }); });
  return { directory, filePath, repository };
}

test('库存首用为空，收货后跨连接读取，文件仅所属用户可访问', async t => {
  const { repository, filePath } = await fixture(t);
  assert.equal(repository.list(page).total, 0);
  const result = repository.receive(receipt());
  assert.equal(repository.detail(result.modelId, page).model.counts.total, 8);
  repository.close();
  const reopened = createCollectionRepository({ filePath });
  try { assert.equal(reopened.list(page).items[0]?.counts.sealedBlank, 8); }
  finally { reopened.close(); }
  assert.equal((await stat(filePath)).mode & 0o777, 0o600);
});

test('同型号版次不同时长只产生一个型号；版次不同独立保存', async t => {
  const { repository } = await fixture(t);
  const a = receipt(); const first = repository.receive(a);
  const second = repository.receive(receipt({ model: { ...a.model, brand: ' tdk ' }, lengthMinutes: 60 }));
  assert.equal(second.modelId, first.modelId);
  assert.deepEqual(repository.detail(first.modelId, page).model.lengths, [60, 90]);
  repository.receive(receipt({ model: { ...a.model, edition: '1992', year: 1992 } }));
  assert.equal(repository.list(page).total, 2);
});

test('已用三盘与未知七盘不能算可用空白，也不自动分配实体 ID', async t => {
  const { repository } = await fixture(t);
  const result = repository.receive(receipt({ quantities: { sealedBlank: 0, openedBlank: 0, legacyUsed: 3, unclassified: 7 } }));
  const detail = repository.detail(result.modelId, page);
  assert.deepEqual(detail.model.counts, { total: 10, sealedBlank: 0, openedBlank: 0, legacyUsed: 3, unknown: 7, recorded: 0, reserved: 0, unavailable: 0 });
  assert.equal(detail.copies.total, 0);
  assert.throws(() => repository.materialize({ commandId: randomUUID(), lotId: result.lotId!, bucket: 'unclassified', action: 'open' }), /库存请求无效/u);
});

test('拆封在一个事务内把 Pool 8 转为 Pool 7 + Copy 1', async t => {
  const { repository } = await fixture(t);
  const stock = repository.receive(receipt());
  const result = repository.materialize({ commandId: randomUUID(), lotId: stock.lotId!, bucket: 'sealedBlank', action: 'open' });
  const detail = repository.detail(stock.modelId, page);
  assert.equal(result.physicalId, 'MB-C-00001');
  assert.equal(detail.lots.items[0]?.quantities.sealedBlank, 7);
  assert.equal(detail.copies.items[0]?.packaging, 'opened');
  assert.equal(detail.model.counts.total, 8);
  assert.equal(detail.model.counts.openedBlank, 1);
});

test('旧录音登记从 Legacy Used 转出，标为历史来源且总数不增加', async t => {
  const { repository } = await fixture(t);
  const stock = repository.receive(receipt({ quantities: { sealedBlank: 0, openedBlank: 0, legacyUsed: 3, unclassified: 7 } }));
  repository.materialize({ commandId: randomUUID(), lotId: stock.lotId!, bucket: 'legacyUsed', action: 'register-legacy' });
  const detail = repository.detail(stock.modelId, page);
  assert.equal(detail.model.counts.total, 10); assert.equal(detail.model.counts.legacyUsed, 2);
  assert.equal(detail.copies.items[0]?.origin, 'legacy-registration'); assert.equal(detail.copies.items[0]?.usage, 'recorded');
});

test('重复收货与实例化命令幂等，同 ID 不同内容拒绝', async t => {
  const { repository } = await fixture(t);
  const command = receipt(); const first = repository.receive(command);
  assert.deepEqual(repository.receive({ ...command }), first);
  assert.throws(() => repository.receive({ ...command, lengthMinutes: 60 }), /同一操作编号/u);
  const transfer = { commandId: randomUUID(), lotId: first.lotId!, bucket: 'sealedBlank' as const, action: 'open' as const };
  const result = repository.materialize(transfer);
  assert.deepEqual(repository.materialize(transfer), result);
  assert.equal(repository.detail(first.modelId, page).copies.total, 1);
  assert.equal(repository.detail(first.modelId, page).model.counts.total, 8);
});

test('独立连接重试相同命令仍只记一笔账', async t => {
  const { repository, filePath } = await fixture(t);
  const second = createCollectionRepository({ filePath });
  t.after(() => second.close());
  const command = receipt();
  const results = await Promise.all([Promise.resolve().then(() => repository.receive(command)), Promise.resolve().then(() => second.receive(command))]);
  assert.deepEqual(results[0], results[1]);
  assert.equal(second.list(page).items[0]?.counts.total, 8);
  const db = new DatabaseSync(filePath, { readOnly: true });
  try { assert.equal(db.prepare('SELECT COUNT(*) AS n FROM inventory_ledger').get()?.n, 1); } finally { db.close(); }
});

test('两个独立进程并发提交相同命令，只有一个数量和账本结果', async t => {
  const { repository, filePath } = await fixture(t);
  repository.list(page); repository.close();
  const command = receipt();
  const modulePath = fileURLToPath(new URL('../src/collection/repository.ts', import.meta.url));
  const script = `import {createCollectionRepository} from ${JSON.stringify(modulePath)}; const r=createCollectionRepository({filePath:${JSON.stringify(filePath)}}); process.stdout.write(JSON.stringify(r.receive(${JSON.stringify(command)}))); r.close();`;
  function run(): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { timeout: 10_000 });
      let stdout = '', stderr = '';
      child.stdout.on('data', data => { stdout += data; });
      child.stderr.on('data', data => { stderr += data; });
      child.on('error', reject);
      child.on('close', code => code === 0 ? resolve(stdout) : reject(new Error(`子进程失败 ${code}: ${stderr}`)));
    });
  }
  const [a, b] = await Promise.all([run(), run()]);
  assert.deepEqual(JSON.parse(a), JSON.parse(b));
  const reopened = createCollectionRepository({ filePath });
  try { assert.equal(reopened.list(page).items[0]?.counts.total, 8); } finally { reopened.close(); }
  const db = new DatabaseSync(filePath, { readOnly: true });
  try { assert.equal(db.prepare('SELECT COUNT(*) AS n FROM inventory_ledger').get()?.n, 1); } finally { db.close(); }
});

test('提交前故障回滚数量、实体 ID 及账本；可安全重试', async t => {
  let fail = true;
  const { repository, filePath } = await fixture(t, action => { if (action === 'materialize' && fail) throw new Error('合成故障'); });
  const stock = repository.receive(receipt());
  const command = { commandId: randomUUID(), lotId: stock.lotId!, bucket: 'sealedBlank' as const, action: 'open' as const };
  assert.throws(() => repository.materialize(command), /库存暂时不可用/u);
  assert.equal(repository.detail(stock.modelId, page).copies.total, 0);
  assert.equal(repository.detail(stock.modelId, page).model.counts.sealedBlank, 8);
  fail = false;
  assert.equal(repository.materialize(command).physicalId, 'MB-C-00001');
  repository.close();
  const reopened = createCollectionRepository({ filePath });
  try { assert.equal(reopened.materialize(command).physicalId, 'MB-C-00001'); } finally { reopened.close(); }
});

test('进程在 COMMIT 前退出后，重开数据库恢复完整旧库存', async t => {
  const { repository, filePath } = await fixture(t);
  const stock = repository.receive(receipt()); repository.close();
  const command = { commandId: randomUUID(), lotId: stock.lotId!, bucket: 'sealedBlank', action: 'open' };
  const modulePath = fileURLToPath(new URL('../src/collection/repository.ts', import.meta.url));
  const script = `import {createCollectionRepository} from ${JSON.stringify(modulePath)}; const r=createCollectionRepository({filePath:${JSON.stringify(filePath)},beforeCommit:()=>process.exit(86)}); r.materialize(${JSON.stringify(command)});`;
  const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { timeout: 10_000, encoding: 'utf8' });
  assert.equal(child.status, 86, child.stderr);
  const reopened = createCollectionRepository({ filePath });
  try { const detail = reopened.detail(stock.modelId, page); assert.equal(detail.model.counts.sealedBlank, 8); assert.equal(detail.copies.total, 0); }
  finally { reopened.close(); }
});

test('不足余额与未知副本的预留均被拒绝', async t => {
  const { repository } = await fixture(t);
  const stock = repository.receive(receipt({ quantities: { sealedBlank: 0, openedBlank: 0, legacyUsed: 0, unclassified: 1 } }));
  assert.throws(() => repository.materialize({ commandId: randomUUID(), lotId: stock.lotId!, bucket: 'sealedBlank', action: 'open' }), /库存不足/u);
  const copy = repository.materialize({ commandId: randomUUID(), lotId: stock.lotId!, bucket: 'unclassified', action: 'identify' });
  assert.throws(() => repository.updateCopy({ commandId: randomUUID(), physicalId: copy.physicalId!, expectedRevision: 1, action: 'reserve' }), /仅可预留/u);
});

test('预留、取消与不可用状态不复用实体 ID，也不增加库存', async t => {
  const { repository } = await fixture(t);
  const stock = repository.receive(receipt());
  const copy = repository.materialize({ commandId: randomUUID(), lotId: stock.lotId!, bucket: 'sealedBlank', action: 'open' });
  repository.updateCopy({ commandId: randomUUID(), physicalId: copy.physicalId!, expectedRevision: 1, action: 'reserve' });
  assert.equal(repository.detail(stock.modelId, page).model.counts.reserved, 1);
  assert.throws(() => repository.updateCopy({ commandId: randomUUID(), physicalId: copy.physicalId!, expectedRevision: 1, action: 'cancel-reservation' }), /已改变/u);
  repository.updateCopy({ commandId: randomUUID(), physicalId: copy.physicalId!, expectedRevision: 2, action: 'mark-unavailable' });
  repository.updateCopy({ commandId: randomUUID(), physicalId: copy.physicalId!, expectedRevision: 3, action: 'cancel-reservation' });
  const detail = repository.detail(stock.modelId, page);
  assert.equal(detail.model.counts.total, 8); assert.equal(detail.model.counts.unavailable, 1);
  assert.equal(detail.copies.items[0]?.physicalId, copy.physicalId); assert.equal(detail.copies.items[0]?.usage, 'blank');
});

test('封存保留线和 Collector Policy 阻止拆封与预留，不阻止单独编号', async t => {
  const { repository } = await fixture(t);
  const stock = repository.receive(receipt({ quantities: { sealedBlank: 1, openedBlank: 0, legacyUsed: 0, unclassified: 0 } }));
  repository.setPolicy({ commandId: randomUUID(), modelId: stock.modelId, expectedRevision: 1, collectorPolicy: 'normal', minimumSealedReserve: 1 });
  assert.throws(() => repository.materialize({ commandId: randomUUID(), lotId: stock.lotId!, bucket: 'sealedBlank', action: 'open' }), /封存保护/u);
  const copy = repository.materialize({ commandId: randomUUID(), lotId: stock.lotId!, bucket: 'sealedBlank', action: 'identify' });
  assert.throws(() => repository.updateCopy({ commandId: randomUUID(), physicalId: copy.physicalId!, expectedRevision: 1, action: 'reserve' }), /封存保护/u);
  repository.setPolicy({ commandId: randomUUID(), modelId: stock.modelId, expectedRevision: 2, collectorPolicy: 'collector', minimumSealedReserve: 0 });
  assert.throws(() => repository.updateCopy({ commandId: randomUUID(), physicalId: copy.physicalId!, expectedRevision: 1, action: 'reserve' }), /收藏保护/u);
});

test('DAT 使用独立永久序列，重复补货不修改已有保护与确认信息', async t => {
  const { repository } = await fixture(t);
  const a = receipt(); const stock = repository.receive(a);
  repository.setPolicy({ commandId: randomUUID(), modelId: stock.modelId, expectedRevision: 1, collectorPolicy: 'collector', minimumSealedReserve: 2 });
  repository.receive(receipt({ model: { ...a.model, identification: 'candidate' } }));
  assert.equal(repository.detail(stock.modelId, page).model.identification, 'verified');
  assert.equal(repository.detail(stock.modelId, page).model.collectorPolicy, 'collector');
  const dat = repository.receive(receipt({ model: { ...a.model, format: 'dat', tapeType: 'dat' }, lengthMinutes: 120 }));
  assert.equal(repository.materialize({ commandId: randomUUID(), lotId: dat.lotId!, bucket: 'sealedBlank', action: 'open' }).physicalId, 'MB-D-00001');
});

test('分页不截断总数，未知时长只保留一个 SKU', async t => {
  const { repository } = await fixture(t);
  const stock = repository.receive(receipt({ lengthMinutes: null }));
  repository.receive(receipt({ lengthMinutes: null }));
  const detail = repository.detail(stock.modelId, { offset: 0, limit: 1 });
  assert.equal(detail.lots.total, 2); assert.equal(detail.lots.items.length, 1); assert.equal(detail.lots.hasMore, true);
  assert.deepEqual(detail.model.lengths, [null]);
  assert.equal(repository.detail(stock.modelId, { offset: 1, limit: 1 }).lots.hasMore, false);
});

test('非法请求不创建数据库，不支持的 Schema 保留原文件', async t => {
  const { repository, filePath } = await fixture(t);
  assert.throws(() => repository.receive(receipt({ quantities: { sealedBlank: -1, openedBlank: 0, legacyUsed: 0, unclassified: 0 } })), /库存请求无效/u);
  await assert.rejects(stat(filePath), { code: 'ENOENT' });
  const db = new DatabaseSync(filePath); db.exec('PRAGMA user_version=99; CREATE TABLE marker(value TEXT); INSERT INTO marker VALUES (\'preserved\')'); db.close();
  assert.throws(() => repository.list(page), /库存暂时不可用/u);
  const preserved = new DatabaseSync(filePath, { readOnly: true });
  try { assert.equal(preserved.prepare('SELECT value FROM marker').get()?.value, 'preserved'); } finally { preserved.close(); }
});

test('拒绝符号链接数据库，不修改其目标', async t => {
  const { repository, directory, filePath } = await fixture(t);
  const target = path.join(directory, 'other.sqlite'); const db = new DatabaseSync(target); db.exec('PRAGMA user_version=99'); db.close();
  await symlink(target, filePath);
  assert.throws(() => repository.list(page), /库存暂时不可用/u);
  const preserved = new DatabaseSync(target, { readOnly: true });
  try { assert.equal(preserved.prepare('PRAGMA user_version').get()?.user_version, 99); } finally { preserved.close(); }
});
