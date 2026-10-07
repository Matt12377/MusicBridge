import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { isAudioAsset, isLibraryRoot, isLocalTrack, isLocalMetadata, isLocalExactInteger } from '@music-bridge/contracts';
import { createCollectionRepository } from '../../src/collection/repository.js';
import { authorizeSourceDirectory } from '../../src/recording/source-files.js';
import { buildStoragePolicy } from '../../../../apps/desktop/scripts/build-storage-root.mjs';

const page = { offset: 0, limit: 100 };
async function directory(t: test.TestContext, close: () => void = () => {}): Promise<string> {
  const storage = buildStoragePolicy(), temporary = storage.check(process.env.TMPDIR!, { mustExist: true });
  const value = await mkdtemp(path.join(temporary, 'musicbridge-local-catalog-')); storage.check(value, { mustExist: true });
  t.after(() => { close(); return rm(value, { recursive: true, force: true }); }); return value;
}
async function fixture(t: test.TestContext, beforeCommit?: (action: string) => void) {
  let close = () => {};
  const parent = await directory(t, () => close()), file = path.join(parent, 'collection.sqlite');
  const repository = createCollectionRepository({ filePath: file, ...(beforeCommit ? { beforeCommit } : {}) });
  close = () => repository.close();
  const sourcePath = path.join(parent, '合成来源'); await mkdir(sourcePath);
  const capability = await authorizeSourceDirectory(sourcePath);
  const source = repository.sources.authorize(randomUUID(), capability);
  const root = repository.localCatalog.registerRoot({ commandId: randomUUID(), sourceRootId: source.id, role: 'library' });
  const assetRequest = () => ({ commandId: randomUUID(), libraryRootId: root.id, expectedRootRevision: root.revision, relative: '合成/同名.flac', sha256: 'a'.repeat(64), sampleFrames: '96000', timebaseHz: 48000 });
  return { parent, file, repository, sourcePath, capability, source, root, assetRequest, catalog: repository.localCatalog };
}

test('MBRS002 stable：同名同Hash资产不合并，改名和同路径替换分别推进位置与内容修订', async t => {
  const f = await fixture(t), first = f.catalog.registerAsset(f.assetRequest()), second = f.catalog.registerAsset(f.assetRequest());
  assert.notEqual(first.id, second.id); assert.notEqual(first.id, f.root.id);
  const renamed = f.catalog.moveAsset({ commandId: randomUUID(), assetId: first.id, expectedLocationRevision: '1', expectedRootRevision: '1', relative: '合成/改名.flac' });
  assert.equal(renamed.id, first.id); assert.equal(renamed.fileRevision, '1'); assert.equal(renamed.locationRevision, '2');
  const replaced = f.catalog.replaceAsset({ ...f.assetRequest(), assetId: first.id, expectedFileRevision: '1', expectedLocationRevision: '2', relative: '合成/改名.flac' });
  assert.equal(replaced.id, first.id); assert.equal(replaced.fileRevision, '2'); assert.equal(replaced.locationRevision, '2');
  assert.equal(isAudioAsset(replaced), true); assert.equal(isAudioAsset({ ...replaced, relative: '秘密位置' }), false);
  assert.ok(!JSON.stringify([f.root, replaced]).includes(f.sourcePath));
  f.repository.close();
  const cold = createCollectionRepository({ filePath: f.file });
  try { assert.deepEqual(cold.localCatalog.asset(first.id), replaced); assert.deepEqual(cold.localCatalog.asset(second.id), second); }
  finally { cold.close(); }
});

test('MBRS002 root：稳定逻辑根重新关联新许可，旧许可及旧资产观察不被改写', async t => {
  const f = await fixture(t), asset = f.catalog.registerAsset(f.assetRequest());
  f.repository.sources.revoke({ commandId: randomUUID(), id: f.source.id });
  assert.throws(() => f.catalog.registerAsset(f.assetRequest()), /授权/u);
  const fresh = f.repository.sources.authorize(randomUUID(), f.capability);
  const relinked = f.catalog.relinkRoot({ commandId: randomUUID(), rootId: f.root.id, expectedRevision: '1', sourceRootId: fresh.id, role: 'recording-reference' });
  assert.equal(relinked.id, f.root.id); assert.equal(relinked.revision, '2'); assert.equal(relinked.sourceRootId, fresh.id);
  assert.equal(isLibraryRoot(relinked), true); assert.deepEqual(f.catalog.asset(asset.id), asset);
  assert.equal(f.repository.sources.root(f.source.id).authorized, false);
  assert.throws(() => f.catalog.moveAsset({ commandId: randomUUID(), assetId: asset.id, expectedLocationRevision: '1', expectedRootRevision: '2', relative: '改名.flac' }), /观察/u);
  const rebound = f.catalog.replaceAsset({ ...f.assetRequest(), expectedRootRevision: '2', assetId: asset.id, expectedFileRevision: '1', expectedLocationRevision: '1' });
  assert.equal(rebound.sourceRootId, fresh.id); assert.equal(rebound.id, asset.id); assert.equal(rebound.fileRevision, '2');
  assert.throws(() => f.catalog.relinkRoot({ commandId: randomUUID(), rootId: f.root.id, expectedRevision: '1', sourceRootId: fresh.id, role: 'library' }), /修订/u);
});

test('MBRS002 root：重复、重叠和未知许可不建立第二授权真相', async t => {
  const f = await fixture(t);
  assert.throws(() => f.catalog.registerRoot({ commandId: randomUUID(), sourceRootId: f.source.id, role: 'library' }), /重叠/u);
  const nestedPath = path.join(f.sourcePath, '嵌套'); await mkdir(nestedPath);
  const nested = f.repository.sources.authorize(randomUUID(), await authorizeSourceDirectory(nestedPath));
  assert.throws(() => f.catalog.registerRoot({ commandId: randomUUID(), sourceRootId: nested.id, role: 'library' }), /重叠/u);
  assert.throws(() => f.catalog.registerRoot({ commandId: randomUUID(), sourceRootId: randomUUID(), role: 'library' }), /目录/u);
  assert.equal(f.catalog.roots().length, 1);
});

test('MBRS002 segment：整文件、多片段独立；超安全整数的精确帧无损且拒非法边界', async t => {
  const f = await fixture(t), asset = f.catalog.registerAsset({ ...f.assetRequest(), sampleFrames: '18446744073709551615' });
  const whole = f.catalog.createTrack({ commandId: randomUUID(), assetId: asset.id, segment: null });
  const exact = { startFrame: '9007199254740993', endFrameExclusive: '9007199254740994', timebaseHz: 48000 };
  const one = f.catalog.createTrack({ commandId: randomUUID(), assetId: asset.id, segment: exact });
  const two = f.catalog.createTrack({ commandId: randomUUID(), assetId: asset.id, segment: exact });
  assert.equal(new Set([whole.id, one.id, two.id]).size, 3); assert.notEqual(one.segment!.id, two.segment!.id);
  assert.equal(one.segment!.startFrame, exact.startFrame); assert.equal(isLocalTrack(one), true);
  for (const bad of [
    { ...exact, startFrame: '-1' }, { ...exact, startFrame: '01' }, { ...exact, endFrameExclusive: exact.startFrame },
    { ...exact, endFrameExclusive: '18446744073709551616' }, { ...exact, timebaseHz: 1.5 }, { ...exact, timebaseHz: 44100 },
  ]) assert.throws(() => f.catalog.createTrack({ commandId: randomUUID(), assetId: asset.id, segment: bad }));
  const short = f.catalog.registerAsset({ ...f.assetRequest(), sampleFrames: '100' });
  assert.throws(() => f.catalog.createTrack({ commandId: randomUUID(), assetId: short.id, segment: { startFrame: '0', endFrameExclusive: '101', timebaseHz: 48000 } }), /范围/u);
  assert.throws(() => f.catalog.selectAsset({ commandId: randomUUID(), trackId: one.id, expectedSelectionRevision: '1', assetId: short.id }), /范围/u);
  assert.deepEqual(f.catalog.track(one.id), one); assert.equal(f.catalog.pageTracks(page).total, 3);
  assert.equal(isLocalExactInteger('18446744073709551616'), false);
});

test('MBRS002 editions：同名同版描述不自动并版，解除一个关系不删除共享曲目', async t => {
  const f = await fixture(t), asset = f.catalog.registerAsset(f.assetRequest()), track = f.catalog.createTrack({ commandId: randomUUID(), assetId: asset.id, segment: null });
  const first = f.catalog.createEdition({ commandId: randomUUID(), title: '同名专辑', edition: '合成版' });
  const second = f.catalog.createEdition({ commandId: randomUUID(), title: '同名专辑', edition: '合成版' });
  assert.notEqual(first.id, second.id);
  const a = f.catalog.linkEditionTrack({ commandId: randomUUID(), editionId: first.id, trackId: track.id, disc: 1, trackNumber: 1, sequence: 1 });
  const b = f.catalog.linkEditionTrack({ commandId: randomUUID(), editionId: second.id, trackId: track.id, disc: 1, trackNumber: 1, sequence: 1 });
  assert.throws(() => f.catalog.linkEditionTrack({ commandId: randomUUID(), editionId: first.id, trackId: track.id, disc: 2, trackNumber: 1, sequence: 1 }), /序号/u);
  const removed = f.catalog.removeEditionTrack({ commandId: randomUUID(), id: a.id, expectedRevision: '1' });
  assert.equal(removed.active, false); assert.deepEqual(f.catalog.editionTracks(second.id), [b]);
  assert.deepEqual(f.catalog.track(track.id), track); assert.deepEqual(f.catalog.asset(asset.id), asset);
});

test('MBRS002 metadata：raw历史与人工override分离，新增观察不抹人工值且拒媒体私密字段', async t => {
  const f = await fixture(t), asset = f.catalog.registerAsset(f.assetRequest()), track = f.catalog.createTrack({ commandId: randomUUID(), assetId: asset.id, segment: null });
  const raw = f.catalog.observeMetadata({ commandId: randomUUID(), trackId: track.id, source: 'synthetic', parserVersion: 'fixture-1', fields: { title: '原观察', artist: '原艺人' } });
  const override = f.catalog.overrideMetadata({ commandId: randomUUID(), trackId: track.id, expectedRevision: null, fields: { title: '人工标题' } });
  const later = f.catalog.observeMetadata({ commandId: randomUUID(), trackId: track.id, source: 'synthetic', parserVersion: 'fixture-2', fields: { title: '后续观察', album: '新专辑' } });
  assert.deepEqual(f.catalog.observations(track.id), [raw, later]);
  assert.deepEqual(f.catalog.metadata(track.id), { raw: { title: '后续观察', artist: '原艺人', album: '新专辑' }, override, effective: { title: '人工标题', artist: '原艺人', album: '新专辑' } });
  assert.equal(isLocalMetadata({ title: 'https://media.invalid/private-token' }), false);
  assert.equal(isLocalMetadata({ title: 'Cookie=private-value' }), false);
  const bad = { commandId: randomUUID(), trackId: track.id, expectedRevision: '1', fields: { sessionHandle: 'private-value' } };
  assert.throws(() => f.catalog.overrideMetadata(bad as unknown as Parameters<typeof f.catalog.overrideMetadata>[0]));
  assert.deepEqual(f.catalog.metadata(track.id).override, override);
});

test('MBRS002 receipts：完整body指纹、旧回执和改对象后的重投不产生第二稳定ID', async t => {
  const f = await fixture(t), request = f.assetRequest(), created = f.catalog.registerAsset(request);
  const receipt = f.catalog.receipt(request.commandId)!;
  assert.deepEqual(receipt.result, created); assert.ok(!JSON.stringify(receipt).includes(request.relative));
  assert.deepEqual(f.catalog.registerAsset({ ...request }), created);
  assert.throws(() => f.catalog.registerAsset({ ...request, relative: '其他.flac' }), /操作编号/u);
  f.catalog.moveAsset({ commandId: randomUUID(), assetId: created.id, expectedLocationRevision: '1', expectedRootRevision: '1', relative: '改名.flac' });
  assert.deepEqual(f.catalog.registerAsset(request), created); assert.deepEqual(f.catalog.receipt(request.commandId), receipt);
  const unknown = { ...f.assetRequest(), backend: 'second-writer' };
  assert.throws(() => f.catalog.registerAsset(unknown), /无效/u);
  assert.equal(f.catalog.receipt(unknown.commandId), null);
});

test('MBRS002 transaction：写实体和receipt后的提交故障全部回滚，原command重试仅一份业务写', async t => {
  let fail = true;
  const f = await fixture(t, action => { if (fail && action === 'local-catalog:create-track') throw new Error('合成提交中断'); });
  const asset = f.catalog.registerAsset(f.assetRequest()), request = { commandId: randomUUID(), assetId: asset.id, segment: null };
  assert.throws(() => f.catalog.createTrack(request)); assert.equal(f.catalog.pageTracks(page).total, 0); assert.equal(f.catalog.receipt(request.commandId), null);
  fail = false;
  const created = f.catalog.createTrack(request); assert.deepEqual(f.catalog.createTrack(request), created); assert.equal(f.catalog.pageTracks(page).total, 1);
  f.repository.close(); const cold = createCollectionRepository({ filePath: f.file });
  try { assert.deepEqual(cold.localCatalog.track(created.id), created); assert.deepEqual(cold.localCatalog.receipt(request.commandId)!.result, created); }
  finally { cold.close(); }
});

test('MBRS002 migration：真实固定30执行DDL后提交故障回滚，旧全部行保持，再次迁移31可冷开', async t => {
  const parent = await directory(t), file = path.join(parent, 'collection.sqlite');
  const bytes = await readFile(new URL('./fixtures/schema30-synthetic.sqlite', import.meta.url));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), '3cf4fd2319904cf5e683f06b6eec6ef58ae1f3ef8a3ed694cb1fad32e08e2344');
  await writeFile(file, bytes, { flag: 'wx', mode: 0o600 });
  const inspect = () => {
    const db = new DatabaseSync(file, { readOnly: true, allowExtension: false });
    try { return { version: db.prepare('PRAGMA user_version').get()!.user_version, rows: db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'local_catalog_%' AND name NOT IN ('local_scan_jobs','local_scan_batches','local_scan_checkpoints','local_scan_file_state','local_scan_receipts','mb_playback_queue','local_artwork_candidates','local_artwork_selections','local_artwork_ledger','local_artwork_create_intents') ORDER BY name").all().map(row => [row.name, db.prepare(`SELECT * FROM "${String(row.name)}" ORDER BY rowid`).all()]), newTables: db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'local_catalog_%'").all(), artworkTables: db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('local_artwork_candidates','local_artwork_selections','local_artwork_ledger','local_artwork_create_intents') ORDER BY name").all().map(row => [row.name, db.prepare(`SELECT * FROM "${String(row.name)}"`).all()]) }; }
    finally { db.close(); }
  };
  const before = inspect(); let reached = false;
  const failed = createCollectionRepository({ filePath: file, beforeCommit(action) { if (action === 'migrate-local-catalog') { reached = true; throw new Error('合成31提交故障'); } } });
  try { assert.throws(() => failed.list(page)); } finally { failed.close(); }
  assert.equal(reached, true); assert.deepEqual(inspect(), before);
  for (let attempt = 0; attempt < 2; attempt++) {
    const upgraded = createCollectionRepository({ filePath: file });
    try { assert.equal(upgraded.list(page).total, 2); assert.equal(upgraded.localCatalog.pageTracks(page).total, 0); } finally { upgraded.close(); }
    const after = inspect(); assert.equal(after.version, 34); assert.deepEqual(after.rows, before.rows); assert.ok(after.newTables.length > 0);
    assert.equal(after.artworkTables.length, 4); assert.ok(after.artworkTables.every(([, rows]) => Array.isArray(rows) && rows.length === 0));
  }
});

test('MBRS002 integrity：schema31缺失不可变trigger与future版本均拒绝，不自动重建', async t => {
  const f = await fixture(t); f.repository.close();
  const db = new DatabaseSync(f.file); try { db.exec('DROP TRIGGER local_catalog_ledger_no_update'); } finally { db.close(); }
  const damaged = createCollectionRepository({ filePath: f.file });
  try { assert.throws(() => damaged.list(page)); } finally { damaged.close(); }
  const future = path.join(f.parent, 'future.sqlite'); await writeFile(future, await readFile(f.file), { flag: 'wx', mode: 0o600 });
  const next = new DatabaseSync(future); try { next.exec('PRAGMA user_version=35'); } finally { next.close(); }
  const unsupported = createCollectionRepository({ filePath: future });
  try { assert.throws(() => unsupported.list(page)); } finally { unsupported.close(); }
  const check = new DatabaseSync(future, { readOnly: true }); try { assert.equal(check.prepare('PRAGMA user_version').get()!.user_version, 35); } finally { check.close(); }
});

test('MBRS002 integrity：实体与末条回执一起伪改为合法JSON，仍因创建修订不符而拒绝冷开', async t => {
  const f = await fixture(t), request = f.assetRequest(), created = f.catalog.registerAsset(request); f.repository.close();
  const db = new DatabaseSync(f.file);
  try {
    const trigger = String(db.prepare("SELECT sql FROM sqlite_master WHERE name='local_catalog_ledger_no_update'").get()?.sql);
    db.exec('DROP TRIGGER local_catalog_ledger_no_update');
    const forged = JSON.stringify({ ...created, fileRevision: '2' });
    db.prepare('UPDATE local_catalog_assets SET data=? WHERE id=?').run(forged, created.id);
    db.prepare('UPDATE local_catalog_ledger SET result=? WHERE command_id=?').run(forged, request.commandId);
    db.exec(trigger);
    assert.equal(db.prepare('PRAGMA integrity_check').get()?.integrity_check, 'ok');
  } finally { db.close(); }
  const rejected = createCollectionRepository({ filePath: f.file });
  try { assert.throws(() => rejected.list(page)); } finally { rejected.close(); }
});

test('MBRS002 audit：完整冷核后出现外部提交，热写拒绝且不留业务或回执，重新冷核仍以SourceStore许可为准', async t => {
  const f = await fixture(t), asset = f.catalog.registerAsset(f.assetRequest());
  const request = { commandId: randomUUID(), assetId: asset.id, segment: null };
  const outside = new DatabaseSync(f.file);
  try { outside.prepare("UPDATE source_roots SET data=json_set(data,'$.authorized',json('false')) WHERE id=?").run(f.source.id); }
  finally { outside.close(); }
  assert.throws(() => f.catalog.createTrack(request)); assert.equal(f.catalog.receipt(request.commandId), null);
  assert.equal(f.catalog.pageTracks(page).total, 0); f.repository.close();
  const cold = createCollectionRepository({ filePath: f.file });
  try {
    assert.equal(cold.sources.root(f.source.id).authorized, false); assert.deepEqual(cold.localCatalog.root(f.root.id), f.root);
    const created = cold.localCatalog.createTrack(request); assert.deepEqual(cold.localCatalog.receipt(request.commandId)!.result, created);
    assert.equal(cold.localCatalog.pageTracks(page).total, 1);
    assert.throws(() => cold.localCatalog.registerAsset(f.assetRequest()), /授权/u);
  } finally { cold.close(); }
});

test('MBRS002 audit：流式raw冷核仍逐回执核修订，raw与回执一起伪改为合法JSON也拒绝', async t => {
  const f = await fixture(t), asset = f.catalog.registerAsset(f.assetRequest()), track = f.catalog.createTrack({ commandId: randomUUID(), assetId: asset.id, segment: null });
  f.catalog.observeMetadata({ commandId: randomUUID(), trackId: track.id, source: 'synthetic', parserVersion: 'raw-1', fields: { title: '第一次观察' } });
  const request = { commandId: randomUUID(), trackId: track.id, source: 'synthetic' as const, parserVersion: 'raw-2', fields: { title: '第二次观察' } };
  const second = f.catalog.observeMetadata(request); assert.equal(second.revision, '2'); f.repository.close();
  const db = new DatabaseSync(f.file);
  try {
    const names = ['local_catalog_observations_no_update', 'local_catalog_ledger_no_update'];
    const triggers = names.map(name => String(db.prepare("SELECT sql FROM sqlite_master WHERE name=?").get(name)?.sql));
    for (const name of names) db.exec(`DROP TRIGGER ${name}`);
    const forged = JSON.stringify({ ...second, revision: '1' });
    db.prepare('UPDATE local_catalog_observations SET data=? WHERE id=?').run(forged, second.id);
    db.prepare('UPDATE local_catalog_ledger SET result=? WHERE command_id=?').run(forged, request.commandId);
    for (const trigger of triggers) db.exec(trigger);
    assert.equal(db.prepare('PRAGMA integrity_check').get()?.integrity_check, 'ok'); assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { db.close(); }
  const rejected = createCollectionRepository({ filePath: f.file });
  try { assert.throws(() => rejected.list(page)); } finally { rejected.close(); }
});
