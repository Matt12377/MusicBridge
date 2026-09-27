import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import yazl from 'yazl';
import { createReferenceCatalogStore, referenceCatalogMigration, referenceCatalogZipMigration,
  verifyReferenceCatalogDatabase, verifyReferenceCatalogZipDatabase } from '../src/collection/reference-catalog-store.js';
import { parseReferenceSourceZip, ReferenceSourceZipError } from '../src/collection/reference-source-zip.js';

const sha = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
const rawPack = '\uFEFF' + JSON.stringify({ schemaVersion: 1, bookId: 'synthetic-book', title: '合成目录', sourceVersion: '第一版', items: [{
  referenceId: 'ref-1', bookId: 'synthetic-book', brand: '合成品牌', series: '系列', edition: '1990', model: 'M-1',
  lengths: [60], iec: 'II', era: '1990', image: { kind: 'none' }, pages: ['1'], notes: '', confidence: 'high',
}] }) + '\n';

async function zip(entries: readonly { name: string; value: string }[], zip64 = false): Promise<Buffer> {
  const file = new yazl.ZipFile();
  for (const entry of entries) file.addBuffer(Buffer.from(entry.value, 'utf8'), entry.name, { compress: false, forceZip64Format: zip64 });
  file.end({ forceZip64Format: zip64, comment: '' });
  const parts: Buffer[] = [];
  for await (const part of file.outputStream) parts.push(Buffer.from(part));
  return Buffer.concat(parts);
}
async function staging(t: test.TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'mb-c11-source-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
function store(stagingRoot: string, beforeCommit?: (action: string) => void) {
  const db = new DatabaseSync(':memory:', { enableForeignKeyConstraints: true });
  db.exec(referenceCatalogMigration);
  db.exec(referenceCatalogZipMigration);
  const catalog = createReferenceCatalogStore({ read: operation => operation(db), model: () => { throw new Error('模型不应读取'); },
    conflict: message => { throw new Error(message); }, stagingRoot, ...(beforeCommit ? { beforeCommit } : {}) });
  return { db, catalog };
}

test('单根 JSON ZIP/ZIP64 完整读取，原 JSON 字节与容器 Hash 独立，暂存成功后清空', async t => {
  const root = await staging(t), bytes = await zip([{ name: 'catalog.json', value: rawPack }], true);
  const parsed = await parseReferenceSourceZip(bytes.toString('base64'), root);
  assert.equal(parsed.rawPack, rawPack);
  assert.equal(parsed.preview.rawPackHash, sha(rawPack));
  assert.equal(parsed.preview.zipSha256, sha(bytes));
  assert.equal(parsed.preview.zipBytes, bytes.length);
  assert.equal(parsed.preview.itemCount, 1);
  assert.deepEqual(await readdir(root), []);
});

test('额外条目、非根目录、外部图片依赖、坏 CRC 和非规范 base64 均拒绝且不留 ZIP', async t => {
  const root = await staging(t);
  const invalid = [
    await zip([{ name: 'catalog.json', value: rawPack }, { name: 'source.json', value: rawPack }]),
    await zip([{ name: 'nested/catalog.json', value: rawPack }]),
    await zip([{ name: 'manifest.json', value: rawPack }]),
    await zip([{ name: 'catalog.json', value: rawPack.replace('"kind":"none"', '"kind":"reference","path":"outside.jpg"') }]),
  ];
  const corrupted = Buffer.from(await zip([{ name: 'catalog.json', value: rawPack }]));
  const contentOffset = corrupted.indexOf(Buffer.from(rawPack, 'utf8'));
  assert.ok(contentOffset > 0);
  corrupted[contentOffset + 10] = corrupted[contentOffset + 10]! ^ 1;
  invalid.push(corrupted);
  for (const bytes of invalid) {
    await assert.rejects(parseReferenceSourceZip(bytes.toString('base64'), root), ReferenceSourceZipError);
    assert.deepEqual(await readdir(root), []);
  }
  await assert.rejects(parseReferenceSourceZip('UEs=', root), ReferenceSourceZipError);
  await assert.rejects(parseReferenceSourceZip('UEs==', root), ReferenceSourceZipError);
  assert.deepEqual(await readdir(root), []);
});

test('确认重验同字节，异 ZIP 同 JSON 只新增容器回执，事务与命令幂等', async t => {
  const root = await staging(t), { db, catalog } = store(root);
  t.after(() => db.close());
  const first = (await zip([{ name: 'catalog.json', value: rawPack }])).toString('base64');
  const second = (await zip([{ name: 'source.json', value: rawPack }])).toString('base64');
  const preview = await catalog.previewSourceZip({ zipBase64: first });
  assert.equal(db.prepare('SELECT count(*) n FROM reference_sources').get()?.n, 0);
  const command = { commandId: randomUUID(), zipBase64: first, expectedZipSha256: preview.zipSha256,
    expectedRawPackHash: preview.rawPackHash, userConfirmed: true as const };
  await assert.rejects(catalog.registerSourceZip({ ...command, expectedZipSha256: '0'.repeat(64) }), /预览不一致/u);
  await assert.rejects(catalog.registerSourceZip({ ...command, zipBase64: second }), /预览不一致/u);
  assert.equal(db.prepare('SELECT count(*) n FROM reference_sources').get()?.n, 0);
  const saved = await catalog.registerSourceZip(command);
  assert.deepEqual(await catalog.registerSourceZip(command), saved);
  const secondPreview = await catalog.previewSourceZip({ zipBase64: second });
  const next = await catalog.registerSourceZip({ commandId: randomUUID(), zipBase64: second,
    expectedZipSha256: secondPreview.zipSha256, expectedRawPackHash: secondPreview.rawPackHash, userConfirmed: true });
  assert.equal(next.source.id, saved.source.id);
  assert.notEqual(next.receipt.id, saved.receipt.id);
  assert.equal(db.prepare('SELECT count(*) n FROM reference_sources').get()?.n, 1);
  assert.equal(catalog.source({ id: saved.source.id }).rawPack, rawPack);
  assert.equal(catalog.sourceZipReceipts({ sourceId: saved.source.id, offset: 0, limit: 25 }).total, 2);
  assert.equal(db.prepare('SELECT count(*) n FROM reference_source_zip_receipts').get()?.n, 2);
  assert.equal(db.prepare('SELECT count(*) n FROM reference_catalog_revisions').get()?.n, 0);
  const items = JSON.parse(rawPack.slice(1)).items;
  assert.equal(catalog.previewRevision({ sourceId: saved.source.id, expectedCurrentRevisionId: null, items, mappings: [] }).counts.total, 1);
  verifyReferenceCatalogDatabase(db);
  verifyReferenceCatalogZipDatabase(db);
  assert.throws(() => db.exec('UPDATE reference_source_zip_receipts SET zip_bytes=zip_bytes'), /immutable reference catalog zip/u);
  assert.deepEqual(await readdir(root), []);
});

test('ZIP 来源与回执同一事务回滚，原命令可明确重试；重复命令换包被拒绝', async t => {
  const root = await staging(t);
  let fail = true;
  const { db, catalog } = store(root, action => { if (fail && action === 'register-reference-source-zip') throw new Error('合成提交中断'); });
  t.after(() => db.close());
  const first = (await zip([{ name: 'catalog.json', value: rawPack }])).toString('base64');
  const second = (await zip([{ name: 'source.json', value: rawPack }])).toString('base64');
  const preview = await catalog.previewSourceZip({ zipBase64: first });
  const request = { commandId: randomUUID(), zipBase64: first, expectedZipSha256: preview.zipSha256,
    expectedRawPackHash: preview.rawPackHash, userConfirmed: true as const };
  await assert.rejects(catalog.registerSourceZip(request), /合成提交中断/u);
  for (const table of ['reference_sources', 'reference_source_zip_receipts', 'reference_catalog_ledger'])
    assert.equal(db.prepare(`SELECT count(*) n FROM ${table}`).get()?.n, 0);
  fail = false;
  const saved = await catalog.registerSourceZip(request);
  assert.deepEqual(await catalog.registerSourceZip(request), saved);
  const other = await catalog.previewSourceZip({ zipBase64: second });
  await assert.rejects(catalog.registerSourceZip({ ...request, zipBase64: second,
    expectedZipSha256: other.zipSha256 }), /同一操作编号/u);
  assert.equal(db.prepare('SELECT count(*) n FROM reference_source_zip_receipts').get()?.n, 1);
  assert.deepEqual(await readdir(root), []);
});
