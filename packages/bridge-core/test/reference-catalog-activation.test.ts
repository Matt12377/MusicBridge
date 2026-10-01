import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import yazl from 'yazl';
import type { CanonicalReference, CatalogMatch, CatalogRevisionDetail, CatalogSnapshot } from '@music-bridge/contracts';
import { createCollectionRepository } from '../src/collection/repository.js';
import { verifyReferenceCatalogDatabase, verifyReferenceCatalogZipDatabase } from '../src/collection/reference-catalog-store.js';

const sha = (value: string): string => createHash('sha256').update(value).digest('hex');
const bookId = 'synthetic-activation-book';
const item = (index: number): CanonicalReference => ({
  referenceId: `ref-${index}`, bookId, brand: '合成品牌', series: '合成系列', edition: '1990', model: `型号-${index}`,
  lengths: [60, 90], iec: 'II', era: '1990', image: { kind: 'none' }, pages: ['1'], notes: '仅合成测试资料', confidence: 'high',
});
function publish(repository: ReturnType<typeof createCollectionRepository>, sourceId: string, items: CanonicalReference[], previous: string | null) {
  const request = { sourceId, items, expectedCurrentRevisionId: previous, mappings: [] };
  const preview = repository.catalog.previewRevision(request);
  return repository.catalog.publishRevision({ ...request, commandId: randomUUID(), baselineFingerprint: preview.baselineFingerprint, userConfirmed: true });
}
async function fixture(t: test.TestContext, size = 80, modelCount = 0, zip = false) {
  const externalRoot = '/Volumes/LifeWeave/Developer/CommandLine/tmp';
  const temporaryRoot = path.resolve(os.tmpdir());
  if (process.platform === 'darwin' && temporaryRoot !== externalRoot && !temporaryRoot.startsWith(`${externalRoot}/`)) {
    throw new Error('本机目录校验测试必须使用 LifeWeave 外置 TMPDIR。');
  }
  const rootStat = await stat(temporaryRoot);
  if (!rootStat.isDirectory()) throw new Error('合成证据临时根不可用。');
  const directory = await mkdtemp(path.join(temporaryRoot, 'musicbridge-catalog-activation-'));
  const filePath = path.join(directory, 'collection.sqlite');
  const repository = createCollectionRepository({ filePath });
  t.after(() => repository.close());
  t.diagnostic(`合成证据目录：${directory}`);
  const models: string[] = [];
  for (let index = 0; index < modelCount; index++) models.push(repository.receive({
    commandId: randomUUID(), model: { brand: '合成品牌', name: `库存-${index}`, edition: '1990', year: 1990, format: 'cassette', tapeType: 'II', identification: 'verified' },
    lengthMinutes: 90, quantities: { sealedBlank: 1, openedBlank: 0, legacyUsed: 0, unclassified: 0 },
  }).modelId);
  const items = Array.from({ length: size }, (_, index) => item(index));
  const rawPack = JSON.stringify({ schemaVersion: 1, bookId, title: '合成激活目录', sourceVersion: '第一版', items });
  let sourceId: string;
  if (zip) {
    const archive = new yazl.ZipFile();
    archive.addBuffer(Buffer.from(rawPack), 'catalog.json', { compress: false }); archive.end();
    const parts: Buffer[] = [];
    for await (const part of archive.outputStream) parts.push(Buffer.from(part));
    const zipBase64 = Buffer.concat(parts).toString('base64');
    const preview = await repository.catalog.previewSourceZip({ zipBase64 });
    sourceId = (await repository.catalog.registerSourceZip({ commandId: randomUUID(), zipBase64,
      expectedZipSha256: preview.zipSha256, expectedRawPackHash: preview.rawPackHash, userConfirmed: true })).source.id;
  } else sourceId = repository.catalog.registerSource({ commandId: randomUUID(), rawPack, packHash: sha(rawPack), userConfirmed: true }).id;
  const first = publish(repository, sourceId, items, null);
  let current = publish(repository, sourceId, items, first.revision.id);
  for (let index = 0; index < models.length; index++) current = repository.catalog.setMatch({
    commandId: randomUUID(), revisionId: current.revision.id, expectedMatchVersion: current.matchVersion,
    match: { referenceId: items[index]!.referenceId, modelId: models[index]!, status: 'candidate', availability: 'unknown' }, userConfirmed: true,
  });
  const db = new DatabaseSync(filePath, { readOnly: true }); t.after(() => db.close());
  return { directory, filePath, repository, db, first, current, models, rawPack, sourceId };
}
function protectedFacts(db: DatabaseSync): string {
  const hash = createHash('sha256');
  for (const table of ['reference_sources', 'reference_catalog_revisions', 'reference_catalog_heads', 'reference_catalog_matches',
    'reference_catalog_snapshots', 'reference_catalog_ledger', 'reference_source_zip_receipts', 'collection_models', 'inventory_lots', 'inventory_ledger']) {
    hash.update(table); for (const row of db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).iterate()) hash.update(JSON.stringify(row));
  }
  return hash.digest('hex');
}
function updateImmutable(db: DatabaseSync, table: string, column: string, key: string, id: string, value: string): void {
  const triggerName = `${table}_no_update`;
  const trigger = String(db.prepare('SELECT sql FROM sqlite_master WHERE name=?').get(triggerName)!.sql);
  db.exec(`DROP TRIGGER ${triggerName}`);
  try { db.prepare(`UPDATE ${table} SET ${column}=? WHERE ${key}=?`).run(value, id); }
  finally { db.exec(trigger); }
}
function measuredVerification(db: DatabaseSync, verify: (db: DatabaseSync) => void) {
  const parses = new Map<string, number>(), queries: string[] = [];
  const tracked = new Map<string, string>();
  for (const table of ['reference_sources', 'reference_catalog_revisions', 'reference_catalog_snapshots']) {
    for (const row of db.prepare(`SELECT * FROM ${table}`).iterate()) {
      tracked.set(String(row.data), `${table}:${row.id}`);
      if (table === 'reference_sources') tracked.set(String(row.raw_pack).replace(/^\uFEFF/u, ''), `raw_pack:${row.id}`);
    }
  }
  const matchJSON = new Set(db.prepare('SELECT data FROM reference_catalog_matches').all().map(row => String(row.data)));
  let referenceReads = 0, matchCount = 0, validatingMatches = false;
  const originalParse = JSON.parse, originalPrepare = db.prepare;
  JSON.parse = function (text: string, reviver?: (this: unknown, key: string, value: unknown) => unknown): unknown {
    const result = originalParse(text, reviver) as unknown;
    const label = tracked.get(text); if (label) parses.set(label, (parses.get(label) ?? 0) + 1);
    if (matchJSON.has(text) && Array.isArray(result)) {
      validatingMatches = true;
      matchCount += result.length;
      for (const match of result as CatalogMatch[]) {
        const referenceId = match.referenceId;
        Object.defineProperty(match, 'referenceId', { enumerable: true, configurable: true, get() { if (validatingMatches) referenceReads++; return referenceId; } });
      }
    }
    return result;
  };
  Object.defineProperty(db, 'prepare', { configurable: true, value(sql: string) {
    // 计数覆盖当前 matches 的完整字段/成员校验，到查询 latest snapshot 为止；后续原有排序/事实比较另计，不冒充总工作量。
    if (sql === 'SELECT id FROM reference_catalog_snapshots WHERE revision_id=? ORDER BY rowid DESC LIMIT 1') validatingMatches = false;
    queries.push(sql); return originalPrepare.call(db, sql);
  } });
  try { verify(db); }
  finally { JSON.parse = originalParse; delete (db as unknown as { prepare?: unknown }).prepare; }
  return { parses, queries, referenceReads, matchCount };
}

test('完整校验对每个 distinct 来源、revision 和 snapshot 完整解析一次，ZIP 校验共用同一上下文', async t => {
  const { db } = await fixture(t, 25, 3, true), before = protectedFacts(db);
  const measured = measuredVerification(db, verifyReferenceCatalogZipDatabase);
  assert.ok(measured.parses.size >= 10, '必须覆盖来源、两个 revision 及完整历史快照');
  for (const [label, count] of measured.parses) assert.equal(count, 1, `${label}不应因 head、ledger 或容器回执重复解析`);
  const receiptReads = measured.queries.filter(sql => sql === 'SELECT * FROM reference_source_zip_receipts WHERE id=?');
  assert.equal(receiptReads.length, 1, '已验证容器回执在 ledger 和 ZIP 完整校验之间只读取一次');
  assert.equal(protectedFacts(db), before); assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
});

test('完整匹配校验的实际 reference 成员访问随 refs 加 matches 线性增长', async t => {
  const { db } = await fixture(t, 80);
  const measured = measuredVerification(db, verifyReferenceCatalogDatabase);
  assert.equal(measured.matchCount, 160, '两个完整 revision 都必须解析当前匹配');
  assert.ok(measured.referenceReads <= measured.matchCount * 10, `匹配成员访问应保持线性，实际${measured.referenceReads}次`);
  t.diagnostic(`匹配${measured.matchCount}项，reference 字段实际读取${measured.referenceReads}次`);
});

test('当前和全部历史 snapshot 的型号存在性按 distinct ID 分块校验', async t => {
  const { db, current, models } = await fixture(t, 55, 55), before = protectedFacts(db);
  const measured = measuredVerification(db, verifyReferenceCatalogDatabase);
  assert.equal(current.matchVersion, 55); assert.equal(models.length, 55);
  assert.equal(measured.queries.filter(sql => sql === 'SELECT id FROM collection_models WHERE id=?').length, 0, '完整校验不逐历史匹配查询型号');
  assert.equal(measured.queries.filter(sql => sql.startsWith('SELECT id FROM collection_models WHERE id IN (')).length, 2, '55个不同型号应按50参数分两块');
  assert.equal(protectedFacts(db), before);
});

test('局部上下文仍拒绝只出现在历史快照中的缺失型号，保留全部历史事实', async t => {
  for (const status of ['candidate', 'needs-review', 'confirmed'] as const) {
    const { filePath, db, first } = await fixture(t, 3), writable = new DatabaseSync(filePath);
    const counts = { ...first.snapshot.counts, ...(status === 'confirmed' ? { owned: 1, unknown: 2 }
      : status === 'candidate' ? { candidate: 1 } : { needsReview: 1 }) };
    const forged: CatalogSnapshot = { ...first.snapshot, id: randomUUID(), counts, entries: first.snapshot.entries.map((entry, index) => index === 0
      ? { ...entry, state: status === 'confirmed' ? 'owned' : 'unknown', stockCount: status === 'confirmed' ? 1 : 0,
        matches: [{ referenceId: entry.referenceId, modelId: randomUUID(), status, availability: 'unknown' }] } : entry) };
    writable.prepare('INSERT INTO reference_catalog_snapshots(rowid,id,revision_id,match_version,data) VALUES(?,?,?,?,?)')
      .run(-1, forged.id, forged.revisionId, forged.matchVersion, JSON.stringify(forged)); writable.close();
    const before = protectedFacts(db);
    assert.throws(() => verifyReferenceCatalogDatabase(db), /参考目录/u, `${status}历史匹配同样必须核验型号存在性`);
    assert.equal(protectedFacts(db), before);
  }
});

test('完整 verification 终尾仍执行 FK 核验，拒绝未被 revision 遍历命中的孤立匹配行', async t => {
  const { filePath, db } = await fixture(t, 3), writable = new DatabaseSync(filePath);
  writable.exec('PRAGMA foreign_keys=OFF');
  writable.prepare('INSERT INTO reference_catalog_matches VALUES(?,?,?)').run(randomUUID(), 0, '[]'); writable.close();
  const before = protectedFacts(db);
  assert.throws(() => verifyReferenceCatalogDatabase(db), /参考目录/u);
  assert.throws(() => verifyReferenceCatalogZipDatabase(db), /参考目录/u);
  assert.equal(protectedFacts(db), before);
});

test('ledger 的完整 DTO 与来源、revision、snapshot 持久字段事实都不能由局部缓存代替', async t => {
  const { filePath, db, current } = await fixture(t, 3), writable = new DatabaseSync(filePath);
  t.after(() => writable.close());
  const ledger = writable.prepare("SELECT command_id,result FROM reference_catalog_ledger WHERE kind='publish' ORDER BY rowid DESC LIMIT 1").get()!;
  const original = String(ledger.result), detail = JSON.parse(original) as CatalogRevisionDetail;
  const invalids = [
    { ...detail, revision: { ...detail.revision, items: detail.revision.items.map((value, index) => index === 0 ? { ...value, notes: '形状合法但持久事实不同' } : value) } },
    { ...detail, snapshot: { ...detail.snapshot, createdAt: '2000-01-01T00:00:00.000Z' } },
    { ...detail, currentEntries: detail.currentEntries.map((entry, index) => index === 0 ? { ...entry, referenceId: 'unknown-ref' } : entry) },
    { ...detail, revision: { ...detail.revision, extra: true } },
  ];
  for (const invalid of invalids) {
    updateImmutable(writable, 'reference_catalog_ledger', 'result', 'command_id', String(ledger.command_id), JSON.stringify(invalid));
    const before = protectedFacts(db); assert.throws(() => verifyReferenceCatalogDatabase(db), /参考目录/u); assert.equal(protectedFacts(db), before);
    updateImmutable(writable, 'reference_catalog_ledger', 'result', 'command_id', String(ledger.command_id), original);
    verifyReferenceCatalogDatabase(db);
  }
  assert.equal(current.revision.items.length, 3);
});

test('完整 verification 每次成功和失败后丢弃上下文，同一连接立即发现另一 owner 的来源损坏', async t => {
  const { filePath, db, sourceId, rawPack, repository } = await fixture(t, 5), writable = new DatabaseSync(filePath);
  t.after(() => writable.close());
  verifyReferenceCatalogZipDatabase(db);
  updateImmutable(writable, 'reference_sources', 'raw_pack', 'id', sourceId, rawPack + '\n');
  const corrupted = protectedFacts(db); assert.throws(() => verifyReferenceCatalogZipDatabase(db), /参考目录/u); assert.equal(protectedFacts(db), corrupted);
  updateImmutable(writable, 'reference_sources', 'raw_pack', 'id', sourceId, rawPack); verifyReferenceCatalogZipDatabase(db);
  repository.close();
  const next = createCollectionRepository({ filePath });
  try { assert.equal(next.catalog.source({ id: sourceId }).rawPack, rawPack); } finally { next.close(); }
  updateImmutable(writable, 'reference_sources', 'raw_pack', 'id', sourceId, rawPack + '\n\n');
  assert.throws(() => verifyReferenceCatalogZipDatabase(db), /参考目录/u);
  const damaged = createCollectionRepository({ filePath });
  try { assert.throws(() => damaged.catalog.source({ id: sourceId }), /库存暂时不可用/u); } finally { damaged.close(); }
});

test('公开读取在 owner 间匹配变化后保持最新结果，冷开保留旧 revision、snapshot 和全部账本', async t => {
  const { filePath, repository, first, current, models, db } = await fixture(t, 4, 1);
  const second = createCollectionRepository({ filePath }); t.after(() => second.close());
  const changed = second.catalog.setMatch({ commandId: randomUUID(), revisionId: current.revision.id, expectedMatchVersion: current.matchVersion,
    match: { referenceId: 'ref-0', modelId: models[0]!, status: 'confirmed', availability: 'unknown' }, userConfirmed: true });
  assert.deepEqual(repository.catalog.revision({ id: current.revision.id }), changed);
  assert.deepEqual(repository.catalog.snapshot({ id: current.snapshot.id }), current.snapshot);
  assert.deepEqual(repository.catalog.revision({ id: first.revision.id }).revision, first.revision);
  const before = protectedFacts(db); repository.close(); second.close();
  const reopened = createCollectionRepository({ filePath });
  try { assert.deepEqual(reopened.catalog.revision({ id: current.revision.id }), changed); } finally { reopened.close(); }
  verifyReferenceCatalogZipDatabase(db); assert.equal(protectedFacts(db), before);
});
