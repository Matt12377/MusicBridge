import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
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
const photoImage = { dataUrl: 'data:image/jpeg;base64,/9j/2Q==', width: 1, height: 1 };
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

test('首次版本读取也等待短暂数据库锁，释放后仅提交一次', async t => {
  const { repository, filePath } = await fixture(t);
  repository.list(page); repository.close();
  const blocker = new DatabaseSync(filePath);
  blocker.exec('PRAGMA journal_mode=DELETE; BEGIN EXCLUSIVE');
  t.after(() => blocker.close());
  const command = receipt();
  const modulePath = fileURLToPath(new URL('../src/collection/repository.ts', import.meta.url));
  const script = `import {createCollectionRepository} from ${JSON.stringify(modulePath)}; process.stdout.write('ready\\n'); const r=createCollectionRepository({filePath:${JSON.stringify(filePath)}}); process.stdout.write(JSON.stringify(r.receive(${JSON.stringify(command)}))); r.close();`;
  let released = false;
  const release = () => { if (!released) { blocker.exec('COMMIT'); released = true; } };
  try {
    const result = await new Promise<string>((resolve, reject) => {
      const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { timeout: 10_000 });
      let stdout = '', stderr = '', timer: ReturnType<typeof setTimeout> | undefined;
      child.stdout.on('data', data => { stdout += data; if (!timer && stdout.includes('ready\n')) timer = setTimeout(release, 200); });
      child.stderr.on('data', data => { stderr += data; });
      child.on('error', reject);
      child.on('close', code => { clearTimeout(timer); release(); code === 0 ? resolve(stdout.slice('ready\n'.length)) : reject(new Error(`子进程失败 ${code}: ${stderr}`)); });
    });
    assert.deepEqual(JSON.parse(result), JSON.parse(String(blocker.prepare('SELECT result FROM inventory_ledger WHERE command_id=?').get(command.commandId)?.result)));
    assert.equal(blocker.prepare('SELECT COUNT(*) AS n FROM inventory_ledger').get()?.n, 1);
  } finally { release(); }
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

test('品牌、关键词与年代查询在分页前筛选，不改变全量库存', async t => {
  const { repository } = await fixture(t);
  const a = receipt(); repository.receive(a);
  repository.receive(receipt({ model: { ...a.model, name: 'SA 100%', year: 1988 } }));
  repository.receive(receipt({ model: { ...a.model, brand: 'Sony', year: null } }));
  assert.equal(repository.list(page, { brand: 'tdk', decade: 1990 }).total, 1);
  assert.equal(repository.list(page, { query: '%' }).total, 1);
  assert.equal(repository.list(page, { decade: 'unknown' }).items[0]?.brand, 'Sony');
  assert.equal(repository.list(page).total, 3);
});

test('照片与已有单盘归属、代表图切换、删除回退均不改变数量', async t => {
  const { repository, filePath } = await fixture(t);
  const stock = repository.receive(receipt());
  const request = { commandId: randomUUID(), modelId: stock.modelId, image: photoImage };
  const first = repository.addPhoto(request);
  assert.deepEqual(repository.addPhoto(request), first);
  assert.equal(repository.addPhoto({ ...request, commandId: randomUUID() }).photoId, first.photoId);
  let detail = repository.detail(stock.modelId, page);
  assert.equal(detail.copies.total, 0); assert.equal(detail.model.counts.total, 8);
  assert.equal(detail.model.featuredPhoto?.id, first.photoId); assert.equal(detail.photos?.length, 1);
  const copy = repository.materialize({ commandId: randomUUID(), lotId: stock.lotId!, bucket: 'sealedBlank', action: 'identify' });
  const second = repository.addPhoto({ ...request, commandId: randomUUID(), physicalId: copy.physicalId! });
  detail = repository.detail(stock.modelId, page);
  repository.changePhoto({ commandId: randomUUID(), modelId: stock.modelId, photoId: second.photoId!, expectedRevision: detail.model.revision, action: 'feature' });
  assert.equal(repository.detail(stock.modelId, page).model.featuredPhoto?.physicalId, copy.physicalId);
  assert.throws(() => repository.changePhoto({ commandId: randomUUID(), modelId: stock.modelId, photoId: first.photoId!, expectedRevision: 1, action: 'feature' }), /已改变/u);
  const revision = repository.detail(stock.modelId, page).model.revision;
  repository.changePhoto({ commandId: randomUUID(), modelId: stock.modelId, photoId: second.photoId!, expectedRevision: revision, action: 'remove' });
  assert.equal(repository.detail(stock.modelId, page).model.featuredPhoto?.id, first.photoId);
  assert.throws(() => repository.photo(second.photoId!), /照片不存在/u);
  repository.close();
  const reopened = createCollectionRepository({ filePath });
  try { assert.deepEqual(reopened.photo(first.photoId!), photoImage); assert.equal(reopened.detail(stock.modelId, page).model.counts.total, 8); }
  finally { reopened.close(); }
});

test('照片跨型号归属与提交前故障不会留下半份照片或修改库存', async t => {
  let fail = false;
  const { repository } = await fixture(t, action => { if (action === 'add-photo' && fail) throw new Error('合成照片提交故障'); });
  const a = receipt(); const stock = repository.receive(a);
  const other = repository.receive(receipt({ model: { ...a.model, edition: '别版' } }));
  const copy = repository.materialize({ commandId: randomUUID(), lotId: other.lotId!, bucket: 'sealedBlank', action: 'identify' });
  assert.throws(() => repository.addPhoto({ commandId: randomUUID(), modelId: stock.modelId, physicalId: copy.physicalId!, image: photoImage }), /不属于/u);
  fail = true;
  const command = { commandId: randomUUID(), modelId: stock.modelId, image: photoImage };
  assert.throws(() => repository.addPhoto(command), /库存暂时不可用/u);
  assert.equal(repository.detail(stock.modelId, page).photos?.length, 0);
  fail = false; repository.addPhoto(command);
  assert.equal(repository.detail(stock.modelId, page).photos?.length, 1);
});

test('v1 库存迁移保留全部账本和实体；迁移失败仍保留 v1 可恢复状态', async t => {
  const { repository, filePath } = await fixture(t);
  const stock = repository.receive(receipt());
  repository.materialize({ commandId: randomUUID(), lotId: stock.lotId!, bucket: 'sealedBlank', action: 'open' });
  repository.setPolicy({ commandId: randomUUID(), modelId: stock.modelId, expectedRevision: 1, collectorPolicy: 'preserve-sealed', minimumSealedReserve: 2 });
  const before = repository.detail(stock.modelId, page); repository.close();
  // 去除 v1 之后新增的表，恢复为实际 v1 schema；既有业务数据与账本保留。
  const db = new DatabaseSync(filePath);
  db.exec('DROP TABLE prepared_versions; DROP TABLE prepared_jobs; DROP TABLE prepared_selections; DROP TABLE prepared_ledger; DROP TABLE preparation_workspaces; DROP TABLE preparation_jobs; DROP TABLE preparation_destinations; DROP TABLE preparation_ledger; DROP TABLE layout_versions; DROP TABLE master_versions; DROP TABLE version_jobs; DROP TABLE version_ledger; DROP TABLE media_reservations; DROP TABLE media_plans; DROP TABLE media_ledger; DROP TABLE draft_source_links; DROP TABLE source_bindings; DROP TABLE source_roots; DROP TABLE source_jobs; DROP TABLE source_ledger; DROP TABLE master_drafts; DROP TABLE master_drafts_ledger; DROP TABLE physical_digital_links; DROP TABLE physical_digital_absence; DROP TABLE digital_albums; DROP TABLE physical_links_ledger; DROP TABLE music_photos; DROP TABLE legacy_recording_content; DROP TABLE music_releases; DROP TABLE music_ledger; DROP TABLE collection_featured_photos; DROP TABLE collection_photos; PRAGMA user_version=1');
  const ledger = db.prepare('SELECT * FROM inventory_ledger ORDER BY rowid').all(); db.close();
  const failing = createCollectionRepository({ filePath, beforeCommit: action => { if (action === 'migrate-photos') throw new Error('合成迁移中断'); } });
  assert.throws(() => failing.list(page), /库存暂时不可用/u); failing.close();
  const old = new DatabaseSync(filePath, { readOnly: true });
  assert.equal(old.prepare('PRAGMA user_version').get()?.user_version, 1);
  assert.equal(old.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='collection_photos'").get()?.n, 0); old.close();
  const migrated = createCollectionRepository({ filePath });
  try { assert.deepEqual(migrated.detail(stock.modelId, page), before); } finally { migrated.close(); }
  const check = new DatabaseSync(filePath, { readOnly: true });
  try { assert.equal(check.prepare('PRAGMA user_version').get()?.user_version, 10); assert.deepEqual(check.prepare('SELECT * FROM inventory_ledger ORDER BY rowid').all(), ledger); }
  finally { check.close(); }
});

test('照片数量有界，内容损坏不会清空库存，最后一张删除后回到缺图', async t => {
  const { repository, filePath } = await fixture(t);
  const stock = repository.receive(receipt());
  const first = repository.addPhoto({ commandId: randomUUID(), modelId: stock.modelId, image: photoImage });
  const db = new DatabaseSync(filePath); db.prepare('UPDATE collection_photos SET content_hash=? WHERE id=?').run('corrupted', first.photoId!); db.close();
  assert.throws(() => repository.photo(first.photoId!), /库存暂时不可用/u);
  assert.equal(repository.detail(stock.modelId, page).model.counts.total, 8);
  repository.changePhoto({ commandId: randomUUID(), modelId: stock.modelId, photoId: first.photoId!, expectedRevision: 2, action: 'remove' });
  assert.equal(repository.detail(stock.modelId, page).model.featuredPhoto, undefined);
  for (let n = 0; n < 24; n++) repository.addPhoto({ commandId: randomUUID(), modelId: stock.modelId, image: { ...photoImage, dataUrl: `data:image/jpeg;base64,${Buffer.from([255,216,255,n,255,217]).toString('base64')}` } });
  assert.throws(() => repository.addPhoto({ commandId: randomUUID(), modelId: stock.modelId, image: photoImage }), /最多保存/u);
  assert.equal(repository.detail(stock.modelId, page).model.counts.total, 8);
});

test('原版实体发行版独立于库存，命令幂等、更新冲突与重启持久化', async t => {
  const { repository, filePath } = await fixture(t);
  const release = { format: 'cd' as const, title: '合成唱片', artist: '合成艺术家', quantity: 2, completeness: 'basic' as const, tracks: [] };
  const command = { commandId: randomUUID(), release };
  const result = repository.music.saveRelease(command);
  assert.deepEqual(repository.music.saveRelease(command), result);
  assert.equal(repository.list(page).total, 0);
  assert.equal(repository.music.list(page).items[0]?.quantity, 2);
  const detail = repository.music.detail(result.id);
  assert.equal(detail.entry.kind, 'cd'); assert.equal(detail.entry.revision, 1);
  assert.throws(() => repository.music.saveRelease({ ...command, release: { ...release, title: '冲突' } }), /操作编号/u);
  const changed = { commandId: randomUUID(), id: result.id, expectedRevision: 1, release: { ...release, edition: '首版', completeness: 'partial' as const } };
  repository.music.saveRelease(changed);
  assert.throws(() => repository.music.saveRelease({ ...changed, commandId: randomUUID() }), /已改变/u);
  repository.close(); const reopened = createCollectionRepository({ filePath }); t.after(() => reopened.close());
  assert.equal(reopened.music.detail(result.id).release?.edition, '首版');
  assert.equal(reopened.music.list(page, { query: '不会匹配' }).total, 0);
});

test('历史自录只补已有单盘内容，两个库仍指向相同身份且不伪造正式录音', async t => {
  const { repository } = await fixture(t);
  const stock = repository.receive(receipt({ quantities: { sealedBlank: 0, openedBlank: 1, legacyUsed: 1, unclassified: 0 } }));
  const legacy = repository.materialize({ commandId: randomUUID(), lotId: stock.lotId!, bucket: 'legacyUsed', action: 'register-legacy' });
  const blank = repository.materialize({ commandId: randomUUID(), lotId: stock.lotId!, bucket: 'openedBlank', action: 'identify' });
  const original = repository.music.detail(legacy.physicalId!);
  assert.equal(original.entry.contentStatus, 'missing');
  const content = { title: '两面精选', artist: '多位艺术家', tracks: [{ title: '第一首', artist: '甲', side: 'A' as const, position: 1 }, { title: '第二首', artist: '乙', side: 'B' as const, position: 1 }] };
  const command = { commandId: randomUUID(), physicalId: legacy.physicalId!, expectedRevision: 1, content };
  repository.music.saveLegacy(command); repository.music.saveLegacy(command);
  assert.equal(repository.music.detail(legacy.physicalId!).entry.modelId, stock.modelId);
  assert.equal(repository.music.detail(legacy.physicalId!).entry.contentStatus, 'legacy');
  assert.equal(repository.music.detail(legacy.physicalId!).recording?.tracks.length, 2);
  assert.equal(repository.detail(stock.modelId, page).copies.items.find(c => c.physicalId === legacy.physicalId)?.recordingTitle, '两面精选');
  assert.equal(repository.music.list(page).total, 1);
  assert.equal(repository.detail(stock.modelId, page).model.counts.total, 2);
  assert.throws(() => repository.music.saveLegacy({ ...command, commandId: randomUUID(), physicalId: blank.physicalId! }), /旧录音/u);
});

test('音乐资料事务失败回滚，原版照片去重与归属检查且不污染库存照片', async t => {
  let fail = false; const { repository } = await fixture(t, action => { if (fail && action === 'save-release') throw new Error('synthetic'); });
  const release = { format: 'cassette' as const, title: '原版磁带', artist: '合成艺术家', quantity: 1, completeness: 'basic' as const, tracks: [] };
  fail = true; const command = { commandId: randomUUID(), release };
  assert.throws(() => repository.music.saveRelease(command), /不可用/u);
  fail = false; assert.equal(repository.music.list(page).total, 0);
  const result = repository.music.saveRelease(command);
  const photo = repository.music.addPhoto({ commandId: randomUUID(), id: result.id, image: photoImage });
  assert.equal(repository.music.addPhoto({ commandId: randomUUID(), id: result.id, image: photoImage }).photoId, photo.photoId);
  assert.equal(repository.music.detail(result.id).photos.length, 1);
  assert.deepEqual(repository.music.photo(photo.photoId!), photoImage);
  assert.throws(() => repository.photo(photo.photoId!), /不存在/u);
  repository.music.removePhoto({ commandId: randomUUID(), id: result.id, photoId: photo.photoId!, expectedRevision: repository.music.detail(result.id).entry.revision });
  assert.equal(repository.music.detail(result.id).photos.length, 0);
});

test('schema 2 音乐迁移失败回滚，成功后库存、照片、编号和账本完整保留', async t => {
  const { repository, filePath } = await fixture(t);
  const stock = repository.receive(receipt());
  repository.addPhoto({ commandId: randomUUID(), modelId: stock.modelId, image: photoImage });
  const before = repository.detail(stock.modelId, page); repository.close();
  const db = new DatabaseSync(filePath);
  db.exec('DROP TABLE prepared_versions; DROP TABLE prepared_jobs; DROP TABLE prepared_selections; DROP TABLE prepared_ledger; DROP TABLE preparation_workspaces; DROP TABLE preparation_jobs; DROP TABLE preparation_destinations; DROP TABLE preparation_ledger; DROP TABLE layout_versions; DROP TABLE master_versions; DROP TABLE version_jobs; DROP TABLE version_ledger; DROP TABLE media_reservations; DROP TABLE media_plans; DROP TABLE media_ledger; DROP TABLE draft_source_links; DROP TABLE source_bindings; DROP TABLE source_roots; DROP TABLE source_jobs; DROP TABLE source_ledger; DROP TABLE master_drafts; DROP TABLE master_drafts_ledger; DROP TABLE physical_digital_links; DROP TABLE physical_digital_absence; DROP TABLE digital_albums; DROP TABLE physical_links_ledger; DROP TABLE music_photos; DROP TABLE legacy_recording_content; DROP TABLE music_releases; DROP TABLE music_ledger; PRAGMA user_version=2'); db.close();
  const interrupted = createCollectionRepository({ filePath, beforeCommit: action => { if (action === 'migrate-music') throw new Error('synthetic'); } });
  assert.throws(() => interrupted.music.list(page), /不可用/u); interrupted.close();
  const old = new DatabaseSync(filePath); assert.equal(old.prepare('PRAGMA user_version').get()?.user_version, 2); old.close();
  const reopened = createCollectionRepository({ filePath }); t.after(() => reopened.close());
  assert.deepEqual(reopened.detail(stock.modelId, page), before);
  assert.equal(reopened.music.list(page).total, 0);
});

const linkFingerprint = (v: unknown): string => createHash('sha256').update(JSON.stringify(v)).digest('hex');
test('原版与数字关联双向可见，明确缺少与已有关系互斥，不向自录建立商业关系', async t => {
  const { repository } = await fixture(t);
  const release = repository.music.saveRelease({ commandId: randomUUID(), release: { format: 'cd', title: '关联专辑', artist: '合成艺术家', tracks: [], quantity: 1, completeness: 'basic' } });
  assert.equal(repository.links.physical(release.id).digitalAbsenceConfirmed, false);
  const missing = { commandId: randomUUID(), id: release.id, target: 'digital' as const, expectedRevision: 1, confirmedAbsent: true, userConfirmed: true as const };
  repository.links.absence(missing, linkFingerprint(missing));
  assert.equal(repository.links.physical(release.id).digitalAbsenceConfirmed, true);
  const command = { commandId: randomUUID(), fingerprint: linkFingerprint('link'), releaseId: release.id, expectedRevision: 2, relation: 'exact' as const, ripFromCdConfirmed: true, metadata: { title: '关联专辑', artist: '合成艺术家', version: '首版' } };
  const result = repository.links.link(command);
  assert.deepEqual(repository.links.link(command), result);
  assert.equal(repository.links.physical(release.id).digitalAbsenceConfirmed, false);
  const digital = repository.links.digitalDetail(result.digitalId!);
  assert.equal(digital.links[0]?.release.id, release.id);
  assert.equal(digital.links[0]?.link.ripFromCdConfirmed, true);
  assert.equal(repository.links.matrix(page).items[0]?.cd, 1);
  const impossible = { ...missing, commandId: randomUUID(), expectedRevision: 3 };
  assert.throws(() => repository.links.absence(impossible, linkFingerprint(impossible)), /仍有数字关联/u);
  const remove = { commandId: randomUUID(), linkId: result.linkId!, expectedRevision: 1 };
  repository.links.remove(remove, linkFingerprint(remove));
  assert.equal(repository.links.digitalDetail(result.digitalId!).links.length, 0);
  assert.equal(repository.links.physical(release.id).digitalAbsenceConfirmed, false);
});

test('Roon 关系不凭同名合并数字对象，Related 不计同版收藏，原版磁带不能冒充 CD Rip', async t => {
  const { repository, filePath } = await fixture(t);
  const release = repository.music.saveRelease({ commandId: randomUUID(), release: { format: 'cassette', title: '同名专辑', artist: '合成', tracks: [], quantity: 1, completeness: 'basic' } });
  const command = { commandId: randomUUID(), fingerprint: linkFingerprint('related'), releaseId: release.id, expectedRevision: 1, relation: 'related' as const, ripFromCdConfirmed: false, metadata: { title: '同名专辑' } };
  const first = repository.links.link(command);
  const second = repository.links.register(randomUUID(), linkFingerprint('same-name'), { title: '同名专辑' }, true);
  assert.notEqual(first.digitalId, second.digitalId);
  const row = repository.links.matrix(page).items.find(r => r.digitalId === first.digitalId)!;
  assert.equal(row.cassette, 0); assert.equal(row.uncertainRelations, 1);
  assert.throws(() => repository.links.link({ ...command, commandId: randomUUID(), fingerprint: linkFingerprint('invalid-rip'), expectedRevision: 2, relation: 'exact', ripFromCdConfirmed: true }), /CD Rip/u);
  repository.close(); const reopened = createCollectionRepository({ filePath }); t.after(() => reopened.close());
  assert.equal(reopened.links.digitalDetail(second.digitalId!).album.physicalAbsenceConfirmed, true);
  assert.equal(reopened.links.physical(release.id).links[0]?.link.relation, 'related');
});

test('关联提交失败不留下数字孤儿或部分关系；历史副本不能作为商业原版关联', async t => {
  let fail = false;
  const { repository } = await fixture(t, action => { if (fail && action === 'confirm-physical-link') throw new Error('synthetic'); });
  const release = repository.music.saveRelease({ commandId: randomUUID(), release: { format: 'cd', title: '回滚', artist: '合成', tracks: [], quantity: 1, completeness: 'basic' } });
  const command = { commandId: randomUUID(), fingerprint: linkFingerprint('rollback'), releaseId: release.id, expectedRevision: 1, relation: 'probable' as const, ripFromCdConfirmed: false, metadata: { title: '回滚' } };
  fail = true; assert.throws(() => repository.links.link(command), /不可用/u); fail = false;
  assert.equal(repository.links.digitalList(page).total, 0);
  assert.equal(repository.links.physical(release.id).revision, 1);
  repository.links.link(command);
  const stock = repository.receive(receipt({ quantities: { sealedBlank: 0, openedBlank: 0, legacyUsed: 1, unclassified: 0 } }));
  const copy = repository.materialize({ commandId: randomUUID(), lotId: stock.lotId!, bucket: 'legacyUsed', action: 'register-legacy' });
  assert.throws(() => repository.links.physical(copy.physicalId!), /编号无效/u);
});

test('schema 3 关系迁移中断回滚，已有音乐与照片完整保留', async t => {
  const { repository, filePath } = await fixture(t);
  const saved = repository.music.saveRelease({ commandId: randomUUID(), release: { format: 'cd', title: '迁移验收', artist: '合成', quantity: 1, completeness: 'basic', tracks: [] } });
  repository.music.addPhoto({ commandId: randomUUID(), id: saved.id, image: photoImage });
  const before = repository.music.detail(saved.id); repository.close();
  const db = new DatabaseSync(filePath);
  db.exec('DROP TABLE prepared_versions; DROP TABLE prepared_jobs; DROP TABLE prepared_selections; DROP TABLE prepared_ledger; DROP TABLE preparation_workspaces; DROP TABLE preparation_jobs; DROP TABLE preparation_destinations; DROP TABLE preparation_ledger; DROP TABLE layout_versions; DROP TABLE master_versions; DROP TABLE version_jobs; DROP TABLE version_ledger; DROP TABLE media_reservations; DROP TABLE media_plans; DROP TABLE media_ledger; DROP TABLE draft_source_links; DROP TABLE source_bindings; DROP TABLE source_roots; DROP TABLE source_jobs; DROP TABLE source_ledger; DROP TABLE master_drafts; DROP TABLE master_drafts_ledger; DROP TABLE physical_digital_links; DROP TABLE physical_digital_absence; DROP TABLE digital_albums; DROP TABLE physical_links_ledger; PRAGMA user_version=3'); db.close();
  const interrupted = createCollectionRepository({ filePath, beforeCommit: action => { if (action === 'migrate-links') throw new Error('合成迁移中断'); } });
  assert.throws(() => interrupted.links.digitalList(page), /不可用/u); interrupted.close();
  const old = new DatabaseSync(filePath);
  assert.equal(old.prepare('PRAGMA user_version').get()?.user_version, 3);
  assert.equal(old.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name='digital_albums'").get()?.n, 0); old.close();
  const reopened = createCollectionRepository({ filePath }); t.after(() => reopened.close());
  assert.deepEqual(reopened.music.detail(saved.id), before);
  assert.equal(reopened.links.physical(saved.id).links.length, 0);
});

test('关系数据库和不可变账本只保留本地身份及快照，不落盘 Roon 运行引用', async t => {
  const { repository, filePath } = await fixture(t);
  const { createPhysicalLinksCoordinator } = await import('../src/collection/physical-links-coordinator.js');
  const { createSyntheticRoonLibrary } = await import('../src/roon/synthetic-library.js');
  const coordinator = createPhysicalLinksCoordinator({ repository: repository.links, library: createSyntheticRoonLibrary() });
  const candidate = (await coordinator.search('', page)).items[0]!;
  const result = coordinator.register({ commandId: randomUUID(), reference: candidate.reference, physicalAbsenceConfirmed: false, userConfirmed: true });
  const check = new DatabaseSync(filePath);
  assert.throws(() => check.exec('UPDATE physical_links_ledger SET fingerprint=\'changed\''), /immutable ledger/u);
  assert.throws(() => check.exec('DELETE FROM physical_links_ledger'), /immutable ledger/u);
  const persisted = JSON.stringify([check.prepare('SELECT * FROM digital_albums').all(), check.prepare('SELECT * FROM physical_links_ledger').all()]);
  assert.doesNotMatch(persisted, /musicbridge-v2|synthetic-private|itemKey|runtimeReference/u);
  assert.ok(persisted.includes(result.digitalId!)); check.close(); repository.close();
  const bytes = await (await import('node:fs/promises')).readFile(filePath);
  assert.equal(bytes.includes(Buffer.from(candidate.reference)), false);
  assert.equal(bytes.includes(Buffer.from('synthetic-private-album-1')), false);
});

test('选曲草稿持久化独立身份、幂等追加和显式曲序，不把浏览信息当 Source Lock', async t => {
  const { repository, filePath } = await fixture(t);
  const metadata = { title: '合成同名曲', artist: '合成艺术家', album: '合成专辑', durationMs: 180000 };
  const request = { commandId: randomUUID(), fingerprint: linkFingerprint('draft'), title: '私人精选', programType: 'compilation' as const, metadata: [metadata, metadata] };
  const result = repository.drafts.append(request);
  assert.deepEqual(repository.drafts.append(request), result);
  const first = repository.drafts.detail(result.draftId);
  assert.equal(first.sourceLockEligible, false); assert.equal(first.status, 'draft');
  assert.equal(first.estimatedDurationMs, 365000); assert.equal(first.trackCount, 2);
  assert.notEqual(first.tracks[0]?.id, first.tracks[1]?.id);
  const edit = { commandId: randomUUID(), draftId: result.draftId, expectedRevision: 1, title: '换个顺序', programType: 'concert' as const, trackIds: [...result.trackIds].reverse() };
  repository.drafts.update(edit, linkFingerprint(edit));
  assert.deepEqual(repository.drafts.detail(result.draftId).tracks.map(track => track.id), edit.trackIds);
  assert.equal(repository.drafts.detail(result.draftId).estimatedDurationMs, 360000);
  assert.throws(() => repository.drafts.update({ ...edit, commandId: randomUUID() }, linkFingerprint('stale-draft')), /已改变/u);
  repository.close(); const reopened = createCollectionRepository({ filePath }); t.after(() => reopened.close());
  assert.equal(reopened.drafts.detail(result.draftId).title, '换个顺序');
  assert.deepEqual(reopened.drafts.detail(result.draftId).tracks.map(track => track.id), edit.trackIds);
  assert.equal(reopened.list(page).total, 0); assert.equal(reopened.music.list(page).total, 0);
});

test('草稿事务失败回滚，未知时长不伪造估算，删除只接受本草稿曲目', async t => {
  let fail = false; const { repository } = await fixture(t, action => { if (fail && action === 'append-draft-tracks') throw new Error('合成提交中断'); });
  const request = { commandId: randomUUID(), fingerprint: linkFingerprint('draft-rollback'), title: '待核实', programType: 'compilation' as const, metadata: [{ title: '未知时长' }] };
  fail = true; assert.throws(() => repository.drafts.append(request), /不可用/u); fail = false;
  assert.equal(repository.drafts.list(page).total, 0);
  const result = repository.drafts.append(request);
  assert.equal(repository.drafts.detail(result.draftId).estimatedDurationMs, undefined);
  const edit = { commandId: randomUUID(), draftId: result.draftId, expectedRevision: 1, title: '待核实', programType: 'continuous' as const, trackIds: [randomUUID()] };
  assert.throws(() => repository.drafts.update(edit, linkFingerprint(edit)), /曲目/u);
  const remove = { ...edit, commandId: randomUUID(), trackIds: [] };
  repository.drafts.update(remove, linkFingerprint(remove));
  assert.equal(repository.drafts.detail(result.draftId).trackCount, 0);
  assert.equal(repository.drafts.detail(result.draftId).sourceLockEligible, false);
});

test('schema 4 草稿迁移中断完整回滚，成功后原音乐与 Roon 关系不变', async t => {
  const { repository, filePath } = await fixture(t);
  const release = repository.music.saveRelease({ commandId: randomUUID(), release: { format: 'cd', title: '迁移保留', artist: '合成', quantity: 1, completeness: 'basic', tracks: [] } });
  repository.links.link({ commandId: randomUUID(), fingerprint: linkFingerprint('before-draft'), releaseId: release.id, expectedRevision: 1, relation: 'related', ripFromCdConfirmed: false, metadata: { title: '关联数字版' } });
  const before = repository.links.physical(release.id); repository.close();
  const db = new DatabaseSync(filePath); db.exec('DROP TABLE prepared_versions; DROP TABLE prepared_jobs; DROP TABLE prepared_selections; DROP TABLE prepared_ledger; DROP TABLE preparation_workspaces; DROP TABLE preparation_jobs; DROP TABLE preparation_destinations; DROP TABLE preparation_ledger; DROP TABLE layout_versions; DROP TABLE master_versions; DROP TABLE version_jobs; DROP TABLE version_ledger; DROP TABLE media_reservations; DROP TABLE media_plans; DROP TABLE media_ledger; DROP TABLE draft_source_links; DROP TABLE source_bindings; DROP TABLE source_roots; DROP TABLE source_jobs; DROP TABLE source_ledger; DROP TABLE master_drafts; DROP TABLE master_drafts_ledger; PRAGMA user_version=4'); db.close();
  const interrupted = createCollectionRepository({ filePath, beforeCommit: action => { if (action === 'migrate-drafts') throw new Error('合成迁移故障'); } });
  assert.throws(() => interrupted.drafts.list(page), /不可用/u); interrupted.close();
  const old = new DatabaseSync(filePath); assert.equal(old.prepare('PRAGMA user_version').get()?.user_version, 4); assert.equal(old.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name='master_drafts'").get()?.n, 0); old.close();
  const reopened = createCollectionRepository({ filePath }); t.after(() => reopened.close());
  assert.deepEqual(reopened.links.physical(release.id), before);
  assert.equal(reopened.drafts.list(page).total, 0);
});

test('草稿上限与不可变账本有界，磁盘不存运行引用', async t => {
  const { repository, filePath } = await fixture(t);
  const { createMasterDraftsCoordinator } = await import('../src/recording/drafts-coordinator.js');
  const { createSyntheticRoonLibrary } = await import('../src/roon/synthetic-library.js');
  const library = createSyntheticRoonLibrary(), coordinator = createMasterDraftsCoordinator({ repository: repository.drafts, library });
  const album = (await library.browseAlbums(page)).items[0]!;
  const track = (await library.browseAlbum(album.reference, page)).items[0]!;
  const request = { commandId: randomUUID(), title: '草稿字节证据', programType: 'compilation' as const, references: [track.reference], userConfirmed: true as const };
  const saved = coordinator.append(request);
  assert.throws(() => coordinator.append({ ...request, title: '不同内容' }), /操作编号/u);
  const many = { commandId: randomUUID(), fingerprint: linkFingerprint('draft-many'), draftId: saved.draftId, expectedRevision: 1, metadata: Array.from({ length: 100 }, () => ({ title: '重复节目', durationMs: 1000 })) };
  repository.drafts.append(many);
  assert.throws(() => repository.drafts.append({ ...many, commandId: randomUUID(), fingerprint: linkFingerprint('draft-over'), expectedRevision: 2 }), /最多包含/u);
  assert.equal(repository.drafts.detail(saved.draftId).trackCount, 101);
  const db = new DatabaseSync(filePath);
  assert.throws(() => db.exec("UPDATE master_drafts_ledger SET fingerprint='changed'"), /immutable ledger/u);
  assert.throws(() => db.exec('DELETE FROM master_drafts_ledger'), /immutable ledger/u); db.close();
  repository.close();
  const bytes = await (await import('node:fs/promises')).readFile(filePath);
  assert.equal(bytes.includes(Buffer.from(track.reference)), false);
  assert.equal(bytes.includes(Buffer.from('synthetic-private-track-1')), false);
});

test('源目录能力初始为空；只读源仓库与库存共用事务数据库', async t => {
  const { repository } = await fixture(t);
  assert.ok('sources' in repository, '源目录不能通过默认读取用户音乐目录提供');
  assert.deepEqual((repository as unknown as { sources: { roots(): unknown[] } }).sources.roots(), []);
});

test('v5 源证据迁移失败回滚；重试保留草稿及所有旧账本', async t => {
  const { repository, filePath } = await fixture(t);
  const draft = repository.drafts.append({ commandId: randomUUID(), fingerprint: 'c'.repeat(64), title: '迁移前草稿', programType: 'compilation', metadata: [{ title: '迁移前曲目' }] });
  const before = repository.drafts.detail(draft.draftId); repository.close();
  const db = new DatabaseSync(filePath); db.exec('DROP TABLE prepared_versions; DROP TABLE prepared_jobs; DROP TABLE prepared_selections; DROP TABLE prepared_ledger; DROP TABLE preparation_workspaces; DROP TABLE preparation_jobs; DROP TABLE preparation_destinations; DROP TABLE preparation_ledger; DROP TABLE layout_versions; DROP TABLE master_versions; DROP TABLE version_jobs; DROP TABLE version_ledger; DROP TABLE media_reservations; DROP TABLE media_plans; DROP TABLE media_ledger; DROP TABLE draft_source_links; DROP TABLE source_bindings; DROP TABLE source_roots; DROP TABLE source_jobs; DROP TABLE source_ledger; PRAGMA user_version=5');
  const ledger = db.prepare('SELECT * FROM master_drafts_ledger').all(); db.close();
  const failing = createCollectionRepository({ filePath, beforeCommit: action => { if (action === 'migrate-sources') throw new Error('合成迁移中断'); } });
  assert.throws(() => failing.sources.roots(), /库存暂时不可用/u); failing.close();
  const old = new DatabaseSync(filePath); assert.equal(old.prepare('PRAGMA user_version').get()?.user_version, 5); assert.deepEqual(old.prepare('SELECT * FROM master_drafts_ledger').all(), ledger); assert.equal(old.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name='source_roots'").get()?.n, 0); old.close();
  const migrated = createCollectionRepository({ filePath }); try { assert.deepEqual(migrated.drafts.detail(draft.draftId), before); assert.deepEqual(migrated.sources.roots(), []); } finally { migrated.close(); }
});

test('录音规划初始为空并归属现有草稿，读取不产生库存实体', async t => {
  const { repository } = await fixture(t);
  const draft = repository.drafts.append({ commandId: randomUUID(), fingerprint: 'd'.repeat(64), title: '库存规划草稿', programType: 'compilation', metadata: [{ title: '合成曲目', durationMs: 180000 }] });
  assert.ok('media' in repository, '分面与预留必须进入正式库存数据库');
  assert.deepEqual((repository as unknown as { media: { list(id: string): unknown } }).media.list(draft.draftId), { draftId: draft.draftId, plans: [] });
  assert.equal(repository.list(page).total, 0);
});

function mediaFixture(repository: ReturnType<typeof createCollectionRepository>) {
  const saved = repository.drafts.append({ commandId: randomUUID(), fingerprint: createHash('sha256').update(randomUUID()).digest('hex'), title: '介质规划合成', programType: 'compilation', metadata: [{ title: '合成一', durationMs: 180000 }, { title: '合成二', durationMs: 210000 }] });
  const draft = repository.drafts.detail(saved.draftId);
  const input = { draftId: draft.id, revision: draft.revision, identity: repository.media.inputIdentity(draft.id), fingerprint: createHash('sha256').update(draft.id).digest('hex'), tracks: draft.tracks.map(t => ({ trackId: t.id, durationMs: t.metadata.durationMs!, basis: 'roon-estimate' as const })), basis: 'roon-estimate' as const };
  const spec = { format: 'cassette' as const, splitAfter: 1, leadInMs: 0, tailMs: 0, defaultGapMs: 5000, rules: [], compatibility: { confirmed: true, cassetteTypes: ['II' as const], dat: false } };
  const plan = repository.media.save({ commandId: randomUUID(), draftId: draft.id, expectedDraftRevision: draft.revision, inputFingerprint: input.fingerprint, spec }, input);
  return { input, plan };
}

test('录音预留单一事务守恒，回执重复不增加实体，取消不返池且再次预留复用实体', async t => {
  const { repository } = await fixture(t), stock = repository.receive(receipt({ quantities: { sealedBlank: 5, openedBlank: 3, legacyUsed: 0, unclassified: 0 } }));
  const { plan, input } = mediaFixture(repository), skuId = repository.detail(stock.modelId, page).lots.items[0]!.skuId;
  const request = { commandId: randomUUID(), planId: plan.id, expectedRevision: plan.revision, skuId, packaging: 'opened' as const, userConfirmed: true as const };
  const reserved = repository.media.reserve(request, input); assert.equal(reserved.reservation?.physicalId, 'MB-C-00001'); assert.equal(reserved.revision, 2);
  assert.equal(repository.media.reserve(request, input).reservation?.physicalId, 'MB-C-00001');
  let detail = repository.detail(stock.modelId, page); assert.equal(detail.model.counts.total, 8); assert.equal(detail.model.counts.openedBlank, 2); assert.equal(detail.model.counts.reserved, 1); assert.equal(detail.copies.total, 1);
  assert.throws(() => repository.updateCopy({ commandId: randomUUID(), physicalId: 'MB-C-00001', expectedRevision: detail.copies.items[0]!.revision, action: 'cancel-reservation' }), /录音规划/u);
  const release = { commandId: randomUUID(), planId: plan.id, expectedRevision: reserved.revision, userConfirmed: true as const };
  const released = repository.media.release(release); assert.equal(released.reservation, undefined); assert.equal(repository.media.release(release).revision, released.revision);
  detail = repository.detail(stock.modelId, page); assert.equal(detail.model.counts.total, 8); assert.equal(detail.model.counts.openedBlank, 3); assert.equal(detail.lots.items[0]!.quantities.openedBlank, 2); assert.equal(detail.copies.total, 1);
  assert.equal(repository.media.reserve({ ...request, commandId: randomUUID(), expectedRevision: released.revision }, input).reservation?.physicalId, 'MB-C-00001');
});

test('预留最后一盘互斥；源/草稿变更和保护策略不能借旧预览绕过', async t => {
  const { repository } = await fixture(t), stock = repository.receive(receipt({ quantities: { sealedBlank: 0, openedBlank: 1, legacyUsed: 0, unclassified: 0 } }));
  const first = mediaFixture(repository), second = mediaFixture(repository), skuId = repository.detail(stock.modelId, page).lots.items[0]!.skuId;
  const reserve = (planId: string) => ({ commandId: randomUUID(), planId, expectedRevision: 1, skuId, packaging: 'opened' as const, userConfirmed: true as const });
  repository.media.reserve(reserve(first.plan.id), first.input);
  assert.throws(() => repository.media.reserve(reserve(second.plan.id), second.input));
  assert.equal(repository.detail(stock.modelId, page).model.counts.reserved, 1);
  repository.drafts.update({ commandId: randomUUID(), draftId: second.input.draftId, expectedRevision: 1, title: '新曲序', programType: 'compilation', trackIds: [...second.input.tracks].reverse().map(t => t.trackId) }, 'e'.repeat(64));
  assert.throws(() => repository.media.reserve(reserve(second.plan.id), second.input), /草稿或源绑定/u);
  assert.equal(repository.media.detail(second.plan.id).requiresReview, true);
});

test('预留完成前故障回滚 Pool、Copy、两个账本和序号，原命令重试可恢复', async t => {
  let fail = false; const { repository, filePath } = await fixture(t, action => { if (fail && action === 'reserve-media-plan') throw new Error('合成预留事务中断'); });
  const stock = repository.receive(receipt({ quantities: { sealedBlank: 0, openedBlank: 1, legacyUsed: 0, unclassified: 0 } }));
  const { plan, input } = mediaFixture(repository), skuId = repository.detail(stock.modelId, page).lots.items[0]!.skuId;
  const request = { commandId: randomUUID(), planId: plan.id, expectedRevision: 1, skuId, packaging: 'opened' as const, userConfirmed: true as const };
  fail = true; assert.throws(() => repository.media.reserve(request, input));
  assert.equal(repository.detail(stock.modelId, page).copies.total, 0); assert.equal(repository.detail(stock.modelId, page).model.counts.openedBlank, 1); assert.equal(repository.media.detail(plan.id).revision, 1);
  const db = new DatabaseSync(filePath); assert.equal(db.prepare('SELECT COUNT(*) n FROM inventory_ledger WHERE command_id=?').get(request.commandId)?.n, 0); assert.equal(db.prepare('SELECT COUNT(*) n FROM media_ledger WHERE command_id=?').get(request.commandId)?.n, 0); db.close();
  fail = false; assert.equal(repository.media.reserve(request, input).reservation?.physicalId, 'MB-C-00001');
});

test('库存候选仅计可用空白和已擦除，未知/旧录音/预留/不可用不混入', async t => {
  const { repository } = await fixture(t), stock = repository.receive(receipt({ quantities: { sealedBlank: 1, openedBlank: 1, legacyUsed: 1, unclassified: 4 } }));
  const copy = repository.materialize({ commandId: randomUUID(), lotId: stock.lotId!, bucket: 'openedBlank', action: 'identify' });
  repository.updateCopy({ commandId: randomUUID(), physicalId: copy.physicalId!, expectedRevision: 1, action: 'mark-unavailable' });
  const candidates = repository.media.stock(page, 'cassette'); assert.equal(candidates.total, 1); assert.equal(candidates.items[0]!.packaging, 'sealed'); assert.equal(candidates.items[0]!.availableCount, 1);
});

test('分面迁移从 schema 6 原子升级，失败不改变草稿与库存，两个账本不可改写', async t => {
  const { repository, filePath } = await fixture(t), stock = repository.receive(receipt());
  const { plan } = mediaFixture(repository), draft = repository.drafts.detail(plan.draftId), before = repository.detail(stock.modelId, page);
  repository.close();
  const db = new DatabaseSync(filePath); db.exec('DROP TABLE prepared_versions; DROP TABLE prepared_jobs; DROP TABLE prepared_selections; DROP TABLE prepared_ledger; DROP TABLE preparation_workspaces; DROP TABLE preparation_jobs; DROP TABLE preparation_destinations; DROP TABLE preparation_ledger; DROP TABLE layout_versions; DROP TABLE master_versions; DROP TABLE version_jobs; DROP TABLE version_ledger; DROP TABLE media_reservations; DROP TABLE media_plans; DROP TABLE media_ledger; PRAGMA user_version=6'); db.close();
  const interrupted = createCollectionRepository({ filePath, beforeCommit: action => { if (action === 'migrate-media-planning') throw new Error('合成迁移中断'); } });
  assert.throws(() => interrupted.media.list(draft.id)); interrupted.close();
  const failed = new DatabaseSync(filePath); assert.equal(failed.prepare('PRAGMA user_version').get()?.user_version, 6); assert.equal(failed.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name='media_plans'").get()?.n, 0); failed.close();
  const restored = createCollectionRepository({ filePath });
  try {
    assert.deepEqual(restored.drafts.detail(draft.id), draft); assert.deepEqual(restored.detail(stock.modelId, page), before);
    assert.deepEqual(restored.media.list(draft.id).plans, []);
    const f = mediaFixture(restored), skuId = before.lots.items[0]!.skuId;
    const request = { commandId: randomUUID(), planId: f.plan.id, expectedRevision: 1, skuId, packaging: 'sealed' as const, userConfirmed: true as const };
    restored.media.reserve(request, f.input);
    const check = new DatabaseSync(filePath);
    try {
      for (const table of ['inventory_ledger', 'media_ledger']) { assert.throws(() => check.prepare(`DELETE FROM ${table} WHERE command_id=?`).run(request.commandId)); assert.throws(() => check.prepare(`UPDATE ${table} SET fingerprint=? WHERE command_id=?`).run('x', request.commandId)); }
    } finally { check.close(); }
  } finally { restored.close(); }
});
