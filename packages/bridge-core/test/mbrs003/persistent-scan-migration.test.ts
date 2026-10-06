import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile, lstat, realpath, mkdtemp, chmod } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { isDeepStrictEqual } from 'node:util';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createCollectionRepository } from '../../src/collection/repository.js';
import { createRecordingRecordCoordinator } from '../../src/recording/record-coordinator.js';
import { buildStoragePolicy } from '../../../../apps/desktop/scripts/build-storage-root.mjs';
interface Column { cid: number; name: string; type: string; notnull: number; dflt_value: unknown; pk: number }
interface Table { name: string; sql: unknown; columns: Column[]; extendedColumns: unknown[]; rows: unknown[][] }
interface SchemaObject { type: string; name: string; tbl_name: string; sql: unknown }
interface Facts { schemaVersion: number; schemaObjects: SchemaObject[]; tables: Table[] }
interface LegacyApi {
  ids: { draftId: string; layoutId: string; planId: string; recordId: string; physicalId: string; sourceLinks: Array<{ draftId: string; trackId: string; bindingId: string }> };
  releaseId: string; linked: { digitalId: string }; results: Record<string, unknown>;
}
interface FixtureIds { sourceRootId: string; libraryRootId: string; assetId: string; trackIds: string[]; metadataTrackId: string; editionId: string; commandIds: string[] }
interface ApiFacts { ids: FixtureIds; baselineApi: LegacyApi; expectedApi: unknown; constructed: unknown }
const pinned = {"files":[{"file":"schema31-nonempty-local.sqlite","bytes":1323008,"sha256":"cff9762879a3f678715f07cd866fc20e4e1deb26c364b1fdd930f1ac29112fb6"},{"file":"schema31-full-facts.json","bytes":524520,"sha256":"4ab53a237f9df7d1e14251e20b2e9837a566551e8dafbb4ce54c951ee7ccf5eb"},{"file":"schema31-cold-api.json","bytes":278451,"sha256":"afe50fdac7d23d4ba47da54f1da9d96b86abcbae3883795b4f91a9bc7ffe0a89"},{"file":"schema31-synthetic.provenance.json","bytes":1989,"sha256":"ae80c8920ddcfadb3071f3432b6be657d9ba711a739a09de18f96aabe9671399"}]};
const fixtureDirectory = fileURLToPath(new URL('./fixtures/', import.meta.url));
// 全部函数仅用于本次合成副本；固定原件从不交给SQLite。
const hash = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex');
const exact = (actual: unknown, expected: unknown, label: string): void => assert.equal(isDeepStrictEqual(actual, expected), true, label);
const normalized = (value: unknown): unknown => JSON.parse(JSON.stringify(value));
const encode = (value: unknown): unknown => typeof value === 'bigint' ? { sqliteType: 'INTEGER', exact: value.toString() }
  : value instanceof Uint8Array ? { sqliteType: 'BLOB', base64: Buffer.from(value).toString('base64') } : value;
const quoted = (name: string): string => { assert.equal(/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name), true); return '"' + name + '"'; };
function inspect(file: string): Facts {
  const db = new DatabaseSync(file, { readOnly: true, allowExtension: false });
  try {
    db.exec('PRAGMA trusted_schema=OFF; PRAGMA query_only=ON;');
    assert.equal(db.prepare('PRAGMA integrity_check').get()?.integrity_check, 'ok');
    exact(db.prepare('PRAGMA foreign_key_check').all(), [], '副本外键完整');
    const schemaObjects = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' ORDER BY type,name").all().map(row => ({ ...row })) as unknown as SchemaObject[];
    const tables = db.prepare("SELECT name,sql FROM sqlite_schema WHERE type='table' AND name NOT GLOB 'sqlite_*' ORDER BY name").all().map(row => {
      const name = String(row.name), q = quoted(name);
      const columns = db.prepare('PRAGMA table_info(' + q + ')').all().map(column => ({ ...column })) as unknown as Column[];
      const extendedColumns = db.prepare('PRAGMA table_xinfo(' + q + ')').all().map(column => ({ ...column }));
      const order = /WITHOUT\s+ROWID/iu.test(String(row.sql)) ? columns.filter(c => Number(c.pk) > 0).sort((a,b) => Number(a.pk)-Number(b.pk)).map(c => quoted(String(c.name))).join(',') : 'rowid';
      assert.ok(order);
      const statement = db.prepare('SELECT * FROM ' + q + ' ORDER BY ' + order); statement.setReadBigInts(true);
      const rows = statement.all().map(record => columns.map(column => encode(record[String(column.name)])));
      return { name, sql: row.sql, columns, extendedColumns, rows };
    });
    return { schemaVersion: Number(db.prepare('PRAGMA user_version').get()?.user_version), schemaObjects, tables };
  } finally { db.close(); }
}
function preserveOld(actual: Facts, baseline: Facts): void {
  const current = new Map(actual.tables.map(table => [table.name, table]));
  for (const old of baseline.tables) {
    const after = current.get(old.name); assert.ok(after, '完整旧表不能消失');
    exact(after.sql, old.sql, '旧表SQL EXACT'); exact(after.columns, old.columns, '旧完整列 EXACT');
    if ('extendedColumns' in old) exact(after.extendedColumns, old.extendedColumns, '旧扩展完整列 EXACT');
    exact(after.rows, old.rows, '旧全部typed cells与原行序 EXACT');
  }
  if ('schemaObjects' in baseline) {
    const objects = new Map(actual.schemaObjects.map(row => [row.type + ':' + row.name, row]));
    for (const old of baseline.schemaObjects) exact(objects.get(old.type + ':' + old.name), old, '旧全部DDL索引触发器 EXACT');
  }
}
async function legacyApi(repository: ReturnType<typeof createCollectionRepository>, baseline: LegacyApi): Promise<unknown> {
  const { ids, releaseId, linked } = baseline;
  const records = createRecordingRecordCoordinator({ store: repository.recordingRecords, assertCurrent() {}, assertExecutionIdle() {} });
  try {
    const storedBindings = ids.sourceLinks.map(link => {
      const binding = repository.sources.linked(link.draftId, link.trackId); assert.ok(binding);
      assert.equal(binding.id, link.bindingId); exact(repository.sources.binding(binding.id), binding, '原SourceBinding两个API对象一致'); return binding;
    });
    return normalized({ ids, releaseId, linked, results: {
      collection: repository.list({ offset: 0, limit: 100 }), physical: repository.links.physical(releaseId),
      digital: repository.links.digitalDetail(linked.digitalId), linkHistory: repository.links.history(releaseId, { offset: 0, limit: 100 }),
      matrix: repository.links.matrix({ offset: 0, limit: 100 }), versionHistory: repository.versions.list(ids.draftId),
      frozen: repository.preparations.frozen(ids.layoutId), storedBindings,
      plan: repository.recordingPlans.version({ id: ids.planId }), planHistory: repository.recordingPlans.list({ draftId: ids.draftId }),
      recordsPage: records.list({ page: { offset: 0, limit: 10 } }), recordDetail: records.get({ id: ids.recordId }),
      recordingHistory: records.history({ physicalId: ids.physicalId, page: { offset: 0, limit: 10 } }),
    } });
  } finally { await records.close(); }
}
async function allApi(file: string, ids: FixtureIds, baseline: LegacyApi): Promise<unknown> {
  const repository = createCollectionRepository({ filePath: file });
  try {
    const legacy = await legacyApi(repository, baseline);
    const listed = repository.list({ offset: 0, limit: 100 });
    const local = {
      sourceRoot: repository.sources.root(ids.sourceRootId), roots: repository.localCatalog.roots(),
      root: repository.localCatalog.root(ids.libraryRootId), asset: repository.localCatalog.asset(ids.assetId),
      tracks: ids.trackIds.map(id => repository.localCatalog.track(id)), trackPage: repository.localCatalog.pageTracks({ offset: 0, limit: 100 }),
      edition: repository.localCatalog.edition(ids.editionId), editionTracks: repository.localCatalog.editionTracks(ids.editionId),
      observations: repository.localCatalog.observations(ids.metadataTrackId), metadata: repository.localCatalog.metadata(ids.metadataTrackId),
      receipts: ids.commandIds.map(id => repository.localCatalog.receipt(id)),
    };
    return normalized({ legacy, listed, details: listed.items.map(model => repository.detail(model.id, { offset: 0, limit: 100 })), local });
  } finally { repository.close(); }
}

// fixture由冻结a7b旧Repository形成31；本case只拷固定字节、只用已存在API，绝不重生成旧库。
test('MBRS003 schema31真实迁移：111旧表全事实和原API稳定对象保留且升级32', { timeout: 30_000 }, async t => {
  assert.equal(process.versions.node.split('.')[0], '22');
  const storage = buildStoragePolicy();
  assert.ok(process.env.TMPDIR && path.isAbsolute(process.env.TMPDIR), 'root须提供私有准入TMPDIR');
  const temporary = storage.check(process.env.TMPDIR, { mustExist: true });
  const temporaryInfo = await lstat(temporary);
  assert.ok(temporaryInfo.isDirectory() && !temporaryInfo.isSymbolicLink());
  assert.equal(await realpath(temporary), temporary); assert.equal(temporaryInfo.mode & 0o777, 0o700);
  if (process.getuid) assert.equal(temporaryInfo.uid, process.getuid());
  const input = await Promise.all(pinned.files.map(async item => {
    const bytes = await readFile(path.join(fixtureDirectory, item.file)); assert.equal(bytes.length, item.bytes); assert.equal(hash(bytes), item.sha256); return bytes;
  }));
  assert.equal(input[0]!.readUInt32BE(60), 31, '固定SQLite header31');
  const facts = JSON.parse(input[1]!.toString('utf8')) as Facts;
  const api = JSON.parse(input[2]!.toString('utf8')) as ApiFacts;
  const provenance = JSON.parse(input[3]!.toString('utf8')) as { synthetic: boolean; fixtureSchemaVersion: number; originBase: string; wholeTables: number; files: unknown };
  assert.equal(facts.schemaVersion, 31); assert.equal(facts.tables.length, 111);
  assert.equal(provenance.synthetic, true); assert.equal(provenance.fixtureSchemaVersion, 31);
  assert.equal(provenance.originBase, 'a7b27b5b6a5168bd146a3cbe61b579efd5639263'); assert.equal(provenance.wholeTables, 111);
  exact(provenance.files, pinned.files.slice(0,3), '三个runtime输入固定身份');
  const directory = await mkdtemp(path.join(temporary, 'musicbridge-mbrs003-schema31-')); await chmod(directory, 0o700);
  storage.check(directory, { mustExist: true });
  // 保留失败私有copy供root收据定位，不自动清除。
  t.diagnostic('私有副本已创建；固定原件不SQL打开，不宣称新ScanJob接口证据。');
  const work = storage.check(path.join(directory, 'collection.sqlite'), { kind: 'file' });
  await writeFile(work, input[0]!, { flag: 'wx', mode: 0o600 });
  const fileInfo = await lstat(work); assert.equal(fileInfo.mode & 0o777, 0o600); assert.equal(fileInfo.nlink, 1);
  if (process.getuid) assert.equal(fileInfo.uid, process.getuid());
  assert.equal(hash(await readFile(work)), pinned.files[0]!.sha256);
  exact(inspect(work), facts, '迁移前私有副本111全表/DDL/全部typed cells EXACT');
  for (const cycle of [1,2]) {
    exact(await allApi(work, api.ids, api.baselineApi), api.expectedApi, '第' + cycle + '次原13API、list/detail、root/资产/whole+segment/raw/manual/edition/ledger完整对象 EXACT');
    preserveOld(inspect(work), facts);
  }
  const after = inspect(work); preserveOld(after, facts);
  for (let i=0; i<pinned.files.length; i++) assert.equal(hash(await readFile(path.join(fixtureDirectory,pinned.files[i]!.file))), pinned.files[i]!.sha256, '固定原件字节保持');
  // 唯一新目标断言；旧a7b现Repository实际31，未来真实migration32后应32。
  assert.equal(after.schemaVersion, 33, '原Repository必须自然将固定31副本迁移到33');
});
