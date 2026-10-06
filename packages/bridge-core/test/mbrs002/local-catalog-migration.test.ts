import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, realpath, readFile, writeFile, mkdtemp, chmod, rm } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createCollectionRepository } from '../../src/collection/repository.js';
import { buildStoragePolicy } from '../../../../apps/desktop/scripts/build-storage-root.mjs';

// 固定夹具由旧 schema30 Repository 产生；本测试绝不使用当前实现重建它。
const fixtureFile = fileURLToPath(new URL('./fixtures/schema30-synthetic.sqlite', import.meta.url));
const factsFile = fileURLToPath(new URL('./fixtures/schema30-legacy-facts.json', import.meta.url));
const provenanceFile = fileURLToPath(new URL('./fixtures/schema30-synthetic.provenance.json', import.meta.url));
const pinned = {
  databaseBytes: 1_093_632,
  databaseSha256: '3cf4fd2319904cf5e683f06b6eec6ef58ae1f3ef8a3ed694cb1fad32e08e2344',
  factsSha256: '7eb51363e85ae7ecd48a7a01ae3c41f4ae8167f954bc5ea7f8255991e8126477',
  provenanceSha256: '6cdd3fec3a0f683465770d51b02aa3eda5262f552306fef04b75a5b576640c3e',
} as const;
const legacyTables = ['collection_models', 'collection_skus', 'inventory_lots', 'physical_copies', 'inventory_ledger'] as const;
type LegacyTableName = typeof legacyTables[number];
type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
type JsonRow = { [key: string]: JsonValue };
interface PinnedLegacyTable {
  name: string;
  columns: JsonRow[];
  rows: JsonRow[];
  rowCount: number;
  columnsSha256: string;
  rowsSha256: string;
}
interface FixtureFacts {
  userVersion: number;
  tables: PinnedLegacyTable[];
  apiResults: { listed: unknown; details: Array<{ model: { id: string } }> };
}
const hash = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex');
// 与生产夹具记录相同：递归排序对象键，行按规范化JSON排序，不做Unicode正规化。
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : item);
}
// node:sqlite 返回无原型行；完整JSON转换只统一原型，不删除列或字段。
function jsonRows(rows: unknown[]): JsonRow[] {
  return JSON.parse(JSON.stringify(rows)) as JsonRow[];
}
function inspectLegacy(filePath: string): { userVersion: number; tables: Map<LegacyTableName, { columns: JsonRow[]; rows: JsonRow[] }> } {
  const database = new DatabaseSync(filePath, { readOnly: true, allowExtension: false });
  try {
    database.exec('PRAGMA trusted_schema=OFF; PRAGMA query_only=ON;');
    const userVersion = Number(database.prepare('PRAGMA user_version').get()?.user_version);
    const tables = new Map<LegacyTableName, { columns: JsonRow[]; rows: JsonRow[] }>();
    for (const name of legacyTables) {
      // 表名来自固定白名单；读取全部列和行，不能用数量摘要代替旧事实。
      const columns = jsonRows(database.prepare(`PRAGMA table_info("${name}")`).all());
      const rows = jsonRows(database.prepare(`SELECT * FROM "${name}"`).all())
        .sort((a, b) => canonical(a).localeCompare(canonical(b), 'en'));
      tables.set(name, { columns, rows });
    }
    return { userVersion, tables };
  } finally { database.close(); }
}
function assertLegacyFacts(actual: ReturnType<typeof inspectLegacy>, expected: FixtureFacts): void {
  for (const name of legacyTables) {
    const old = expected.tables.find(table => table.name === name);
    assert.ok(old, `固定旧事实缺少${name}`);
    const observed = actual.tables.get(name);
    assert.ok(observed);
    assert.equal(hash(canonical(old.columns)), old.columnsSha256, `${name}固定列摘要`);
    assert.equal(hash(canonical(old.rows)), old.rowsSha256, `${name}固定行摘要`);
    assert.deepEqual(observed.columns, old.columns, `${name}全部旧列保持`);
    assert.deepEqual(observed.rows, old.rows, `${name}全部旧行保持`);
  }
  const ledger = actual.tables.get('inventory_ledger')!;
  assert.deepEqual(ledger.columns.map(column => column.name), ['command_id', 'fingerprint', 'action', 'result', 'event_data', 'created_at']);
  assert.equal(ledger.rows.length, 5);
  // 前面的deepEqual覆盖5行的全部6列；这里额外固定真实账本形状。
}

test('MBRS002 schema30实际迁移：旧型号批次账本保留且升级当前33', async t => {
  assert.equal(process.versions.node.split('.')[0], '22', '此夹具准入使用Node22');
  const temporaryRoot = process.env.TMPDIR;
  assert.ok(temporaryRoot && path.isAbsolute(temporaryRoot), 'root必须提供批准的私有TMPDIR');
  // 共用既有canonical准入；真实hosted必须双marker且位于专用musicbridge子树。
  const storage = buildStoragePolicy();
  const temporaryPath = storage.check(temporaryRoot, { mustExist: true });
  if (!storage.hosted) {
    const externalRoot = '/Volumes/LifeWeave/Developer/CommandLine';
    assert.equal(storage.root, externalRoot, '本机只允许真实LifeWeave构建根');
    assert.ok(temporaryPath.startsWith(path.join(externalRoot, 'tmp') + path.sep), '本机临时目录必须位于外置tmp子树');
  }
  const temporaryInfo = await lstat(temporaryPath);
  assert.ok(temporaryInfo.isDirectory() && !temporaryInfo.isSymbolicLink());
  assert.equal(await realpath(temporaryPath), temporaryPath);
  assert.equal(temporaryInfo.mode & 0o777, 0o700, '准入临时根权限必须为0700');
  if (process.getuid) assert.equal(temporaryInfo.uid, process.getuid(), '准入临时根必须归当前用户');

  const fixedBytes = await readFile(fixtureFile);
  const factsBytes = await readFile(factsFile);
  const provenanceBytes = await readFile(provenanceFile);
  assert.equal(fixedBytes.length, pinned.databaseBytes);
  assert.equal(hash(fixedBytes), pinned.databaseSha256);
  assert.equal(hash(factsBytes), pinned.factsSha256);
  assert.equal(hash(provenanceBytes), pinned.provenanceSha256);
  const expected = JSON.parse(factsBytes.toString('utf8')) as FixtureFacts;
  const provenance = JSON.parse(provenanceBytes.toString('utf8')) as { database: { bytes: number; sha256: string; userVersion: number } };
  assert.equal(expected.userVersion, 30);
  assert.equal(provenance.database.userVersion, 30);
  assert.equal(provenance.database.bytes, pinned.databaseBytes);
  assert.equal(provenance.database.sha256, pinned.databaseSha256);

  const directory = await mkdtemp(path.join(temporaryPath, 'musicbridge-mbrs002-schema30-red-'));
  storage.check(directory, { mustExist: true });
  await chmod(directory, 0o700);
  t.after(async () => { await rm(directory, { recursive: true, force: true }); });
  const workcopy = storage.check(path.join(directory, 'collection.sqlite'), { kind: 'file' });
  // 从已核固定原字节写独占副本，wx避免覆盖；当前Repository不参与旧夹具生成。
  await writeFile(workcopy, fixedBytes, { flag: 'wx', mode: 0o600 });
  storage.check(workcopy, { mustExist: true, kind: 'file' });
  const workcopyInfo = await lstat(workcopy);
  assert.equal(workcopyInfo.mode & 0o777, 0o600);
  assert.equal(workcopyInfo.nlink, 1);
  if (process.getuid) assert.equal(workcopyInfo.uid, process.getuid());
  assert.equal(hash(await readFile(workcopy)), pinned.databaseSha256);
  const before = inspectLegacy(workcopy);
  assert.equal(before.userVersion, 30);
  assertLegacyFacts(before, expected);

  const page = { offset: 0, limit: 100 };
  const repository = createCollectionRepository({ filePath: workcopy });
  try {
    // 工厂是惰性的；现有list/detail必须实际打开副本并返回完整旧业务事实。
    assert.deepEqual(repository.list(page), expected.apiResults.listed);
    for (const detail of expected.apiResults.details) {
      assert.deepEqual(repository.detail(detail.model.id, page), detail);
    }
  } finally { repository.close(); }
  const after = inspectLegacy(workcopy);
  assertLegacyFacts(after, expected);
  assert.equal(hash(await readFile(fixtureFile)), pinned.databaseSha256, '固定原件从未原地打开为写库');
  assert.equal(hash(await readFile(factsFile)), pinned.factsSha256);
  assert.equal(hash(await readFile(provenanceFile)), pinned.provenanceSha256);

  // 固定输入仍为30；当前实现应在真实首次读取时完整迁移到33。
  assert.equal(after.userVersion, 33, '现有Repository应将固定schema30副本迁移到当前33');
});
