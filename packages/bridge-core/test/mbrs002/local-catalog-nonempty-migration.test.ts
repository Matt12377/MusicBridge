import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, realpath, readFile, writeFile, mkdtemp, chmod } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { createCollectionRepository } from '../../src/collection/repository.js';
import { createRecordingRecordCoordinator } from '../../src/recording/record-coordinator.js';
import { buildStoragePolicy } from '../../../../apps/desktop/scripts/build-storage-root.mjs';

// 原件由f34旧Repository自然20→30产生；当前实现只迁移新私有副本，不重建或打开原件SQL。
const fixtureNames = [
  'schema30-nonempty-legacy.sqlite',
  'schema30-nonempty-full-facts.json',
  'schema30-nonempty-cold-api.json',
  'schema30-nonempty-legacy.provenance.json',
] as const;
const pinned = [
  { bytes: 1_228_800, sha256: '5205a95ec06f1d10b87b31731c6d0295dee156ed06567dc7bc9f912d4117da62' },
  { bytes: 323_581, sha256: '12d87c78f17a2e52251010aaebfe1fbc0ddbe08d3e8fb93d18f4617d18e01154' },
  { bytes: 120_642, sha256: 'f759add15de51f919dedbe413aded78796e6a743ad3c25e2d02aa73037b8fdaa' },
  { bytes: 1_905, sha256: '5c21e9398f406f758f5669e2c866e26700f89cf5cc071d7fe5e3c2ea638ac48e' },
] as const;
const fixtureFiles = fixtureNames.map(name => fileURLToPath(new URL('./fixtures/' + name, import.meta.url)));
const localTables = [
  'local_catalog_assets', 'local_catalog_edition_tracks', 'local_catalog_editions', 'local_catalog_ledger',
  'local_catalog_observations', 'local_catalog_overrides', 'local_catalog_roots', 'local_catalog_tracks',
] as const;
const apiNames = [
  'collection', 'physical', 'digital', 'linkHistory', 'matrix', 'versionHistory', 'frozen',
  'storedBindings', 'plan', 'planHistory', 'recordsPage', 'recordDetail', 'recordingHistory',
] as const;
const hash = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex');
interface Column { cid: number; name: string; type: string; notnull: number; dflt_value: unknown; pk: number }
interface Table { name: string; sql: unknown; columns: Column[]; rows: unknown[][] }
interface Facts { schemaVersion: number; tables: Table[] }
interface BaselineApi {
  ids: { draftId: string; layoutId: string; planId: string; recordId: string; physicalId: string;
    sourceLinks: Array<{ draftId: string; trackId: string; bindingId: string }> };
  releaseId: string; linked: { id: string; digitalId: string; linkId: string };
  results: Record<typeof apiNames[number], unknown>;
}
interface Provenance {
  schema: string; synthetic: boolean; fixtureSchemaVersion: number; originSourceBase: string;
  baselineTables: number; files: Array<{ file: string; bytes: number; sha256: string }>;
  frozenPrepared: string; legacyManualContent: string; queue: string;
}
// 只断言布尔值及固定目标，失败TAP不打印旧对象、历史路径或私有定位事实。
function exact(actual: unknown, expected: unknown, target: string): void {
  assert.equal(isDeepStrictEqual(actual, expected), true, target);
}
const encode = (value: unknown): unknown => typeof value === 'bigint'
  ? { sqliteType: 'INTEGER', exact: value.toString() }
  : value instanceof Uint8Array ? { sqliteType: 'BLOB', base64: Buffer.from(value).toString('base64') } : value;
function identifier(name: string): string {
  assert.equal(/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name), true, '表标识必须在既有白名单形状内');
  return '"' + name + '"';
}
function wholeFacts(database: DatabaseSync): Table[] {
  return database.prepare("SELECT name,sql FROM sqlite_schema WHERE type='table' AND name NOT GLOB 'sqlite_*' ORDER BY name").all().map(row => {
    const name = String(row.name), quoted = identifier(name);
    // PRAGMA行原型为null；仅归一原型，完整列字段保留，不能JSON序列化typed数据行。
    const columns = database.prepare('PRAGMA table_info(' + quoted + ')').all().map(column => ({ ...column })) as unknown as Column[];
    const order = /WITHOUT\s+ROWID/iu.test(String(row.sql))
      ? columns.filter(column => Number(column.pk) > 0).sort((a, b) => Number(a.pk) - Number(b.pk)).map(column => identifier(column.name)).join(',')
      : 'rowid';
    assert.equal(order.length > 0, true, '完整行读取必须具有原rowid或PK顺序');
    const statement = database.prepare('SELECT * FROM ' + quoted + ' ORDER BY ' + order);
    statement.setReadBigInts(true);
    const rows = statement.all().map(record => columns.map(column => encode(record[column.name])));
    return { name, sql: row.sql, columns, rows };
  });
}
function inspectCopy(workcopy: string): Facts {
  const database = new DatabaseSync(workcopy, { readOnly: true, allowExtension: false });
  try {
    assert.equal(database.prepare('PRAGMA integrity_check').get()?.integrity_check === 'ok', true, '私有副本完整性检查通过');
    exact(database.prepare('PRAGMA foreign_key_check').all(), [], '私有副本不得产生外键错误');
    return { schemaVersion: Number(database.prepare('PRAGMA user_version').get()?.user_version), tables: wholeFacts(database) };
  } finally { database.close(); }
}
function assertOld103(actual: Facts, baseline: Facts): void {
  assert.equal(actual.schemaVersion, 31, '当前Repository必须自然迁移为31');
  assert.equal(baseline.schemaVersion, 30, '固定输入必须为30');
  assert.equal(baseline.tables.length, 103, '完整旧表基线必须为103');
  const byName = new Map(actual.tables.map(table => [table.name, table]));
  assert.equal(byName.size, actual.tables.length, '完整事实不得包含重复表名');
  for (const old of baseline.tables) {
    const after = byName.get(old.name);
    assert.equal(after !== undefined, true, '旧表不得消失');
    exact(after!.sql, old.sql, '全部103旧表SQL定义必须EXACT保持');
    exact(after!.columns, old.columns, '全部103旧表完整列字段必须EXACT保持');
    exact(after!.rows, old.rows, '全部103旧表typed cells、ledger及原行序必须EXACT保持');
  }
}
async function fixtureBytes(): Promise<Buffer[]> {
  const bytes: Buffer[] = [];
  for (const [index, file] of fixtureFiles.entries()) {
    const info = await lstat(file);
    assert.equal(info.isFile() && !info.isSymbolicLink(), true, '固定fixture必须是普通文件');
    const value = await readFile(file);
    assert.equal(value.length, pinned[index]!.bytes, '固定fixture字节长度保持');
    assert.equal(hash(value), pinned[index]!.sha256, '固定fixture SHA保持');
    bytes.push(value);
  }
  return bytes;
}
async function sidecars(file: string): Promise<boolean[]> {
  return Promise.all(['-wal', '-shm'].map(async suffix => {
    try { await lstat(file + suffix); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
  }));
}
async function ownFile(file: string): Promise<void> {
  const info = await lstat(file);
  assert.equal(info.isFile() && !info.isSymbolicLink(), true, '私有副本必须为普通文件');
  assert.equal(info.mode & 0o777, 0o600, '私有副本权限600');
  assert.equal(info.nlink, 1, '私有副本不得是原件硬链接');
  assert.equal(info.uid, process.getuid!(), '私有副本须归当前用户');
}
function readAllApi(workcopy: string, baseline: BaselineApi): BaselineApi {
  const { ids, releaseId, linked } = baseline;
  const repository = createCollectionRepository({ filePath: workcopy });
  let records: ReturnType<typeof createRecordingRecordCoordinator> | undefined;
  try {
    records = createRecordingRecordCoordinator({ store: repository.recordingRecords, assertCurrent() {}, assertExecutionIdle() {} });
    const storedBindings = ids.sourceLinks.map(link => {
      const binding = repository.sources.linked(link.draftId, link.trackId);
      assert.equal(binding !== undefined, true, '原SourceBinding必须能按原关联读取');
      assert.equal(binding!.id === link.bindingId, true, '原SourceBinding ID保持');
      exact(repository.sources.binding(binding!.id), binding, 'SourceBinding两种旧冷读保持同对象');
      return binding;
    });
    // 与producer02全部13个实际API一致；不调用SourceEvidence availability/context/publicBinding或解释历史locator。
    const results = {
      collection: repository.list({ offset: 0, limit: 100 }), physical: repository.links.physical(releaseId),
      digital: repository.links.digitalDetail(linked.digitalId), linkHistory: repository.links.history(releaseId, { offset: 0, limit: 100 }),
      matrix: repository.links.matrix({ offset: 0, limit: 100 }), versionHistory: repository.versions.list(ids.draftId),
      frozen: repository.preparations.frozen(ids.layoutId), storedBindings,
      plan: repository.recordingPlans.version({ id: ids.planId }), planHistory: repository.recordingPlans.list({ draftId: ids.draftId }),
      recordsPage: records.list({ page: { offset: 0, limit: 10 } }), recordDetail: records.get({ id: ids.recordId }),
      recordingHistory: records.history({ physicalId: ids.physicalId, page: { offset: 0, limit: 10 } }),
    };
    // 基线保存的是完整JSON对象；未保存的undefined字段不凭空升级为已证实字段。
    return JSON.parse(JSON.stringify({ ids, releaseId, linked, results })) as BaselineApi;
  } finally { records?.close(); repository.close(); }
}

// 只保留一个行为case；准备失败不伪称产品RED。失败目录保留供root收据定位，无自动清理。
test('MBRS002 nonempty schema30自然迁移：103旧表完整事实和13 API跨两次冷开保持', { timeout: 20_000 }, async t => {
  let phase = 'PREPARATION';
  try {
    assert.equal(process.versions.node.split('.')[0], '22', '沿既定Node22，不固定fixture producer补丁版本');
    assert.equal(typeof process.getuid, 'function', '本私有副本Gate需要已有mac/Linux所有者语义');
    const temporaryRoot = process.env.TMPDIR;
    assert.equal(typeof temporaryRoot === 'string' && path.isAbsolute(temporaryRoot), true, 'root须提供批准的私有TMPDIR');
    const storage = buildStoragePolicy();
    const temporary = storage.check(temporaryRoot!, { mustExist: true });
    const temporaryInfo = await lstat(temporary);
    assert.equal(temporaryInfo.isDirectory() && !temporaryInfo.isSymbolicLink(), true, '准入临时根必须为实际目录');
    assert.equal(await realpath(temporary), temporary, '准入临时根须为canonical身份');
    assert.equal(temporaryInfo.mode & 0o777, 0o700, '准入临时根700');
    assert.equal(temporaryInfo.uid, process.getuid!(), '准入临时根须归当前用户');
    // 本机外置卷/hosted双marker及musicbridge子树准入只复用原storagePolicy，不重写或放宽它。
    const inputs = await fixtureBytes();
    const databaseBytes = inputs[0]!, baseline = JSON.parse(inputs[1]!.toString('utf8')) as Facts;
    const baselineApi = JSON.parse(inputs[2]!.toString('utf8')) as BaselineApi;
    const provenance = JSON.parse(inputs[3]!.toString('utf8')) as Provenance;
    assert.equal(databaseBytes.subarray(0, 16).toString('binary') === 'SQLite format 3\x00', true, '固定fixture须有SQLite字节header');
    assert.equal(databaseBytes.readUInt32BE(60), 30, 'fixture header必须为30');
    assert.equal(baseline.schemaVersion, 30, '基线schema30');
    assert.equal(baseline.tables.length, 103, '完整旧103表');
    assert.equal(provenance.synthetic && provenance.fixtureSchemaVersion === 30 && provenance.baselineTables === 103, true, '来源必须为完整合成schema30');
    assert.equal(provenance.originSourceBase, 'f34dd904a473893f213a2a894b858c4ddfbf4423', '来源冻结f34');
    exact(provenance.files, fixtureNames.slice(0, 3).map((file, index) => ({ file, bytes: pinned[index]!.bytes, sha256: pinned[index]!.sha256 })), '来源说明固定三个runtime基线身份');
    exact(Object.keys(baselineApi.results).sort(), [...apiNames].sort(), '全部13实际API不能缩成部分字段');
    const fixtureSidecars = await sidecars(fixtureFiles[0]!);
    exact(fixtureSidecars, [false, false], '原fixture不得依赖WAL/SHM');
    phase = 'NEW_PRIVATE_COPY';
    const directory = await mkdtemp(path.join(temporary, 'musicbridge-mbrs002-nonempty-'));
    await chmod(directory, 0o700); storage.check(directory, { mustExist: true });
    const directoryInfo = await lstat(directory);
    assert.equal(directoryInfo.mode & 0o777, 0o700, '新私有run700');
    assert.equal(directoryInfo.uid, process.getuid!(), '新私有run归当前用户');
    const workcopy = storage.check(path.join(directory, 'collection.sqlite'), { kind: 'file' });
    // wx是O_EXCL，仅写已核固定字节；从不调用DatabaseSync(fixtureFiles[0])，不复制sidecars。
    await writeFile(workcopy, databaseBytes, { flag: 'wx', mode: 0o600 });
    storage.check(workcopy, { mustExist: true, kind: 'file' }); await ownFile(workcopy);
    assert.equal(hash(await readFile(workcopy)), pinned[0].sha256, '私有副本初始字节须与fixture相同');
    phase = 'BASELINE103_BEFORE_MIGRATION';
    exact(inspectCopy(workcopy), baseline, '迁移前仅副本重算全部103 SQL/列/typed cells与原序等于冻结基线');
    phase = 'ACTUAL_REPOSITORY_30_TO31';
    const first = createCollectionRepository({ filePath: workcopy });
    try { first.list({ offset: 0, limit: 1 }); } finally { first.close(); }
    const migrated = inspectCopy(workcopy); assertOld103(migrated, baseline);
    assert.equal(migrated.tables.length, 111, 'schema31实际完整111表');
    const oldNames = new Set(baseline.tables.map(table => table.name));
    const newTables = migrated.tables.filter(table => !oldNames.has(table.name));
    exact(newTables.map(table => table.name).sort(), [...localTables].sort(), '自然迁移只新增既定八张local表');
    assert.equal(newTables.every(table => table.rows.length === 0), true, '本迁移不伪造新local业务事实');
    for (const cycle of [1, 2] as const) {
      phase = cycle === 1 ? 'COLD_API_CYCLE_1' : 'COLD_API_CYCLE_2';
      exact(readAllApi(workcopy, baselineApi), baselineApi, 'same ids全部13实际API持久对象须EXACT等于f34基线');
      phase = cycle === 1 ? 'FULL_FACTS_AFTER_COLD_1' : 'FULL_FACTS_AFTER_COLD_2';
      const after = inspectCopy(workcopy); assertOld103(after, baseline);
      exact(after, migrated, '两次独立冷开后111完整事实不得产生隐式改写或删除');
    }
    phase = 'CHECKPOINT_OWN_COPY';
    const closing = new DatabaseSync(workcopy, { allowExtension: false });
    try {
      assert.equal(closing.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get()?.busy === 0, true, '仅owncopy checkpoint须完成');
      assert.equal(closing.prepare('PRAGMA journal_mode=DELETE').get()?.journal_mode === 'delete', true, '仅owncopy收口为无sidecar');
    } finally { closing.close(); }
    await ownFile(workcopy); exact(await sidecars(workcopy), [false, false], '关闭后的私有副本无sidecar');
    const finalBytes = await readFile(workcopy);
    assert.equal(finalBytes.readUInt32BE(60), 31, '最终副本header31');
    exact(inspectCopy(workcopy), migrated, 'checkpoint后111 SQL/列/typed cells与原序仍不变');
    phase = 'ORIGINAL_INPUT_FENCE';
    const endInputs = await fixtureBytes();
    exact(endInputs.map(bytes => hash(bytes)), inputs.map(bytes => hash(bytes)), '四个原fixture字节hash前后保持');
    exact(await sidecars(fixtureFiles[0]!), fixtureSidecars, '原fixture sidecar前后保持');
    const empty = migrated.tables.filter(table => ['prepared_versions', 'legacy_recording_content'].includes(table.name));
    assert.equal(empty.length === 2 && empty.every(table => table.rows.length === 0), true, 'Prepared与手工旧录音为空，仅保留事实边界');
    phase = 'COMPLETE';
    t.diagnostic(JSON.stringify({ synthetic: true, oldTablesExact: 103, wholeFactsTables: 111, apiObjects: 13, coldCycles: 2,
      originalFixtureUnchanged: true, preparedLegacyManual: 'EMPTY_NOT_COVERED', queue: 'SEPARATE_006_007', realMediaOwner: 'NOT_RUN', at00202: 'PARTIAL' }));
  } catch {
    // 屏蔽错误消息、历史定位字段与内部栈；固定阶段保留准备/目标失败归因，不给失败假成功。
    assert.fail('非空迁移核验未完成：' + phase + '；原任务验收未升级。');
  }
});
