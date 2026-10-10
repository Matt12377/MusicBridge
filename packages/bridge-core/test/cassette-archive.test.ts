import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import yazl from 'yazl';
import { parseReferenceSourcePack, type CanonicalReference } from '@music-bridge/contracts';
import {
  CassetteArchiveError, getCassetteArchiveAsset, getCassetteArchiveRecord,
  loadCassetteArchive, prepareCassetteArchive,
} from '../src/collection/cassette-archive.js';

const sha = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const root = '合成磁带资料档案/';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jD4YAAAAASUVORK5CYII=', 'base64');
const item = (id: string): CanonicalReference => ({
  referenceId: id, bookId: 'synthetic-cassette-book', brand: '合成品牌', series: '', edition: '书中1973标签',
  model: id, iec: 'I', era: null, lengths: [], image: { kind: 'none' }, pages: ['12'], notes: '仅合成测试资料', confidence: 'unknown',
});
interface FixtureOptions { change?: (files: Map<string, Buffer>) => void; bytes?: Buffer }
async function fixture(t: test.TestContext, options: FixtureOptions = {}) {
  const temporaryRoot = path.resolve(os.tmpdir()), externalRoot = '/Volumes/LifeWeave/Developer/CommandLine/tmp';
  if (process.platform === 'darwin' && temporaryRoot !== externalRoot && !temporaryRoot.startsWith(`${externalRoot}/`)) throw new Error('磁带档案测试必须使用 LifeWeave 外置 TMPDIR。');
  const directory = await mkdtemp(path.join(temporaryRoot, 'musicbridge-cassette-archive-'));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const archiveRoot = path.join(directory, 'data', 'reference-archives'), archivePath = path.join(directory, 'source.zip');
  const items = [item('ref-a'), item('ref-no-picture')];
  const records = items.map(reference => ({
    ...reference, lengths: null, production_year_verified: false, all_possible_lengths_known: false,
    asset_ids: reference.referenceId === 'ref-a' ? ['book-image-a'] : [], auxiliary_asset_ids: [],
    r3_information: {
      summary_zh: reference.referenceId === 'ref-a' ? '合成摘要' : '',
      fields: { materials: { value: null, status: 'not_stated', sources: [{ scope: 'product_panel', value: null }] } },
      source_transcriptions: [{ panel_id: `panel-${reference.referenceId}`, source_page_id: 'page-a', printed_page: '12', scope: 'product_panel', transcription_zh: '完整中文原文\n第二段保留换行、未知字段与来源限定。' }],
      shared_context_summaries_zh: ['合成共享语境原文。'],
    },
  }));
  const files = new Map<string, Buffer>();
  const json = (name: string, value: unknown): void => { files.set(root + name, Buffer.from(JSON.stringify(value))); };
  json('catalog/SOURCEPACK.json', { schemaVersion: 1, bookId: items[0]!.bookId, title: '合成档案目录', sourceVersion: 'synthetic-r3', items });
  json('catalog/reference_catalog_r3.json', { schema_version: 'musicbridge-rich-reference-r3/v1', bookId: items[0]!.bookId, sourceVersion: 'synthetic-r3', records });
  json('catalog/primary_images.json', { records: [
    { referenceId: 'ref-a', primary_asset_id: 'book-image-a', status: 'eligible_native_primary_candidate' },
    { referenceId: 'ref-no-picture', primary_asset_id: null, status: 'no_eligible_primary_image' },
  ] });
  json('catalog/images_manifest.json', [{ asset_id: 'book-image-a', role: 'packaging_front', printed_page_label: '12',
    canonical_reference_ids: ['ref-a'], cutout_path: 'assets/cutouts/a.png', wall_512_path: 'assets/wall_512/a.png', thumbnail_256_path: 'assets/thumbs_256/a.png', sha256: sha(png) }]);
  json('catalog/PRIMARY_RECONCILIATION.json', { remaining_no_primary_cases: [{ referenceId: 'ref-no-picture', reason_label: '原书没有该身份的独立照片' }] });
  json('photo_upgrade/PHOTO_REFERENCES.json', { records: [{ reference_id: 'real-a', asset_id: 'book-image-a', canonical_ids: ['ref-a'],
    local_relative_path: 'source/photo/a.png', sha256: sha(png), observed_source_role: 'packaging_front',
    use_label: '同角色真实包装参考；保留裁切和水印限制', source_url: 'https://example.test/real-photo-a', worker_decision: 'matched_cropped_source_reference' }] });
  json('photo_upgrade/DISPLAY_OVERLAY.json', { records: [{ asset_id: 'book-image-a', reference_id: 'real-a', canonical_ids: ['ref-a'],
    display_mode: 'opaque_original_photograph_with_watermark', photo_relative_path: 'assets/hd_display/a.png', sha256: sha(png),
    role: 'packaging_front', original_native_relative_path: 'assets/cutouts/a.png', original_native_sha256: sha(png),
    original_catalogue_primary_asset_id_changed: false, original_alpha_png_changed: false, source_url: 'https://example.test/real-photo-a' }] });
  for (const name of ['assets/cutouts/a.png', 'assets/wall_512/a.png', 'assets/thumbs_256/a.png', 'source/photo/a.png', 'assets/hd_display/a.png', 'archive/old-release/original.png']) files.set(root + name, png);
  files.set(root + 'tools/do-not-execute.js', Buffer.from("throw new Error('包内脚本不是程序入口');\n"));
  files.set(root + 'README.md', Buffer.from('本文件只是原包资料，保留原字节。\n'));
  options.change?.(files);
  const zip = new yazl.ZipFile();
  for (const [name, bytes] of files) zip.addBuffer(bytes, name, { compress: true });
  zip.end();
  const chunks: Buffer[] = [];
  for await (const bytes of zip.outputStream) chunks.push(Buffer.from(bytes));
  const bytes = options.bytes ?? Buffer.concat(chunks);
  await writeFile(archivePath, bytes);
  return { directory, archiveRoot, archivePath, bytes, files, records };
}
function error(code: CassetteArchiveError['code']) {
  return (value: unknown): boolean => value instanceof CassetteArchiveError && value.code === code;
}

test('完整档案保留 ZIP、所有原始文件和全文；投影不创建库存，也不更换主图关系', async t => {
  const f = await fixture(t), archive = await prepareCassetteArchive(f);
  assert.deepEqual(archive.summary, { sha256: sha(f.bytes), zipBytes: f.bytes.length, bookId: 'synthetic-cassette-book', title: '合成档案目录', sourceVersion: 'synthetic-r3',
    itemCount: 2, assetCount: 1, primaryCount: 1, missingPrimaryCount: 1, realPhotoCount: 1, opaqueDisplayCount: 1 });
  assert.deepEqual(await readFile(path.join(archive.directory, 'container.zip')), f.bytes);
  for (const [name, bytes] of f.files) assert.deepEqual(await readFile(path.join(archive.directory, 'files', name)), bytes);
  assert.deepEqual(await getCassetteArchiveRecord(archive, 'ref-a'), f.records[0]);
  assert.deepEqual(await getCassetteArchiveRecord(archive, 'ref-no-picture'), f.records[1], '没有 summary 的记录仍保留完整原文');
  assert.equal(archive.index.references['ref-a']!.primaryAssetId, 'book-image-a');
  assert.deepEqual(archive.index.references['ref-a']!.realPhotoIds, ['photo:real-a']);
  assert.deepEqual(archive.index.references['ref-a']!.opaqueDisplayIds, ['display:book-image-a']);
  assert.equal(archive.index.references['ref-no-picture']!.missingPrimaryReason, '原书没有该身份的独立照片');
  const pack = parseReferenceSourcePack(archive.rawPack)!;
  assert.equal(pack.items.length, 2); assert.deepEqual(pack.items[0]!.lengths, []);
  assert.deepEqual(pack.items[0]!.archive, { sha256: sha(f.bytes), primaryAssetId: 'book-image-a' });
  assert.ok(pack.items.every(reference => reference.image.kind === 'none'));
  assert.ok(!archive.rawPack.includes('data:image/'));
  assert.ok(!archive.rawPack.includes('完整中文原文'));
  assert.deepEqual((await readdir(f.archiveRoot)).filter(name => name.startsWith('.cassette-stage-')), []);
});

test('逻辑图 ID 将书图、原生图、照片参考和不透明辅助展示分开，私有资产返回实际 SHA', async t => {
  const f = await fixture(t), archive = await prepareCassetteArchive(f);
  for (const id of ['book-image-a', 'book-image-a:original', 'photo:real-a', 'display:book-image-a']) {
    const asset = await getCassetteArchiveAsset(archive, id);
    assert.ok(path.isAbsolute(asset.path)); assert.equal(asset.sha256, sha(png)); assert.equal(asset.contentType, 'image/png');
  }
  assert.ok(archive.index.assets['book-image-a']!.path.includes('wall_512'));
  assert.ok(archive.index.assets['book-image-a:original']!.path.includes('cutouts'));
  assert.equal(archive.index.assets['photo:real-a']!.origin, 'real-photo-reference');
  assert.equal(archive.index.assets['display:book-image-a']!.origin, 'opaque-display');
  await assert.rejects(getCassetteArchiveAsset(archive, '../README.md'), error('INVALID_DATA'));
  await assert.rejects(getCassetteArchiveAsset(archive, 'README.md'), error('UNAVAILABLE'));
  await assert.rejects(getCassetteArchiveRecord(archive, 'unlisted'), error('UNAVAILABLE'));
});

test('重复相同 ZIP 和冷重载复用不可变目录，不重写文件；SourcePack 字段和原文保持一致', async t => {
  const f = await fixture(t), first = await prepareCassetteArchive(f);
  const before = await lstat(path.join(first.directory, 'container.zip'), { bigint: true });
  const second = await prepareCassetteArchive(f), loaded = await loadCassetteArchive(f.archiveRoot, first.summary.sha256);
  const after = await lstat(path.join(first.directory, 'container.zip'), { bigint: true });
  assert.equal(second.directory, first.directory); assert.equal(before.ino, after.ino); assert.equal(before.mtimeNs, after.mtimeNs);
  assert.deepEqual(loaded.summary, first.summary); assert.equal(loaded.rawPack, first.rawPack);
  assert.deepEqual(await getCassetteArchiveRecord(loaded, 'ref-a'), f.records[0]);
  assert.deepEqual(await readdir(f.archiveRoot), [first.summary.sha256]);
});

test('不完整 manifest 和资源 SHA 不一致均清理自己的 staging；源 ZIP 原字节保留', async t => {
  for (const type of ['missing', 'bad-sha'] as const) {
    const f = await fixture(t, { change(files) {
      if (type === 'missing') files.delete(root + 'catalog/reference_catalog_r3.json');
      else { const data = JSON.parse(files.get(root + 'catalog/images_manifest.json')!.toString()) as Record<string, unknown>[]; data[0]!.sha256 = '0'.repeat(64); files.set(root + 'catalog/images_manifest.json', Buffer.from(JSON.stringify(data))); }
    } });
    await assert.rejects(prepareCassetteArchive(f), error('INVALID_DATA'));
    assert.deepEqual(await readFile(f.archivePath), f.bytes); assert.deepEqual(await readdir(f.archiveRoot), []);
  }
});

test('重复 referenceId 与 SourcePack/原文身份分叉不能靠第一条覆盖', async t => {
  for (const type of ['duplicate', 'identity-conflict'] as const) {
    const f = await fixture(t, { change(files) {
      const data = JSON.parse(files.get(root + 'catalog/reference_catalog_r3.json')!.toString()) as { records: Record<string, unknown>[] };
      if (type === 'duplicate') data.records.push(data.records[0]!); else data.records[0]!.brand = '另一个品牌';
      files.set(root + 'catalog/reference_catalog_r3.json', Buffer.from(JSON.stringify(data)));
    } });
    await assert.rejects(prepareCassetteArchive(f), error('INVALID_DATA')); assert.deepEqual(await readdir(f.archiveRoot), []);
  }
});

test('manifest 不能通过相对路径或网页类型把包内脚本当作图片资源公开', async t => {
  for (const type of ['traversal', 'script'] as const) {
    const f = await fixture(t, { change(files) {
      const data = JSON.parse(files.get(root + 'catalog/images_manifest.json')!.toString()) as Record<string, unknown>[];
      data[0]!.wall_512_path = type === 'traversal' ? '../escaped.png' : 'tools/do-not-execute.js';
      files.set(root + 'catalog/images_manifest.json', Buffer.from(JSON.stringify(data)));
    } });
    await assert.rejects(prepareCassetteArchive(f), error('INVALID_DATA')); assert.deepEqual(await readdir(f.archiveRoot), []);
  }
});

test('入口拒绝符号链接 ZIP 与符号链接档案根，不跟随它们写入', async t => {
  const f = await fixture(t), sourceLink = path.join(f.directory, 'source-link.zip');
  await symlink(f.archivePath, sourceLink);
  await assert.rejects(prepareCassetteArchive({ ...f, archivePath: sourceLink }), error('UNAVAILABLE'));
  const actual = path.join(f.directory, 'actual-data'), rootLink = path.join(f.directory, 'root-link');
  await mkdir(actual); await symlink(actual, rootLink);
  await assert.rejects(prepareCassetteArchive({ ...f, archiveRoot: rootLink }), error('UNAVAILABLE'));
  await assert.rejects(prepareCassetteArchive({ ...f, archiveRoot: path.join(rootLink, 'must-not-create') }), error('UNAVAILABLE'));
  assert.deepEqual(await readdir(actual), []);
});

test('取消与坏 ZIP 不发布半成品，自己的临时目录全部清理', async t => {
  const f = await fixture(t), controller = new AbortController(); controller.abort();
  await assert.rejects(prepareCassetteArchive({ ...f, signal: controller.signal }), error('CANCELLED'));
  const invalid = await fixture(t, { bytes: Buffer.from('非 ZIP 合成输入') });
  await assert.rejects(prepareCassetteArchive(invalid), error('INVALID_ARCHIVE'));
  assert.deepEqual(await readdir(invalid.archiveRoot), []);
});

test('冷重载检测 rawPack/index/原始文件篡改；读取详情和图片时再核实际字节 SHA', async t => {
  for (const name of ['source-pack.json', 'index.json', `files/${root}archive/old-release/original.png`] as const) {
    const f = await fixture(t), archive = await prepareCassetteArchive(f);
    const target = path.join(archive.directory, name), bytes = await readFile(target);
    bytes[0] = bytes[0]! ^ 1; await writeFile(target, bytes);
    await assert.rejects(loadCassetteArchive(f.archiveRoot, archive.summary.sha256), error('CONTENT_CHANGED'));
  }
  const f = await fixture(t), archive = await prepareCassetteArchive(f);
  await writeFile(path.join(archive.directory, archive.index.references['ref-a']!.recordPath), '{}');
  await assert.rejects(getCassetteArchiveRecord(archive, 'ref-a'), error('CONTENT_CHANGED'));
  const asset = archive.index.assets['book-image-a']!;
  await writeFile(path.join(archive.directory, asset.path), Buffer.from('已改变的图像'));
  await assert.rejects(getCassetteArchiveAsset(archive, 'book-image-a'), error('CONTENT_CHANGED'));
});

test('已有同 hash 空目录不会被覆盖，也不会删掉未知档案；失败只清理本次 stage', async t => {
  const f = await fixture(t), expected = path.join(f.archiveRoot, sha(f.bytes));
  await mkdir(expected, { recursive: true });
  await assert.rejects(prepareCassetteArchive(f));
  assert.ok((await lstat(expected)).isDirectory()); assert.deepEqual(await readdir(f.archiveRoot), [sha(f.bytes)]);
});
