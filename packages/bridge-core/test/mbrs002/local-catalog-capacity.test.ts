import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { isAudioAsset, isLibraryRoot, isLocalCatalogReceipt, isLocalTrack, type LocalTrack } from '@music-bridge/contracts';
import { createCollectionRepository } from '../../src/collection/repository.js';
import { authorizeSourceDirectory } from '../../src/recording/source-files.js';
import { buildStoragePolicy } from '../../../../apps/desktop/scripts/build-storage-root.mjs';

const LOCAL_TABLES = ['local_catalog_roots', 'local_catalog_assets', 'local_catalog_tracks', 'local_catalog_editions', 'local_catalog_edition_tracks', 'local_catalog_observations', 'local_catalog_overrides', 'local_catalog_ledger'] as const;
const SINGLE_COMMAND_READ_ROW_BUDGET = 128;
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  return JSON.stringify(value);
}
const bodyFingerprint = (request: unknown): string => createHash('sha256').update(canonical(['create-track', request])).digest('hex');

/** Repository产生真实32结构和root/asset；只在关闭后的本测试私有副本批量加入合法合成whole-track历史。 */
async function syntheticCatalog(t: test.TestContext, trackCount: number) {
  const storage = buildStoragePolicy(), temporary = storage.check(process.env.TMPDIR!, { mustExist: true });
  const directory = await mkdtemp(path.join(temporary, 'musicbridge-local-capacity-')); storage.check(directory, { mustExist: true });
  assert.equal(typeof process.getuid, 'function');
  const info = await lstat(directory); assert.equal(info.uid, process.getuid!()); assert.equal(info.mode & 0o777, 0o700);
  let close = () => {};
  t.after(() => { close(); return rm(directory, { recursive: true, force: true }); });
  const seedFile = path.join(directory, 'api-seed.sqlite'), file = path.join(directory, 'private-workcopy.sqlite');
  const sourcePath = path.join(directory, '合成来源'); await mkdir(sourcePath);
  const seed = createCollectionRepository({ filePath: seedFile });
  let assetId: string;
  try {
    const source = seed.sources.authorize(randomUUID(), await authorizeSourceDirectory(sourcePath));
    const root = seed.localCatalog.registerRoot({ commandId: randomUUID(), sourceRootId: source.id, role: 'library' });
    assert.equal(isLibraryRoot(root), true);
    const asset = seed.localCatalog.registerAsset({ commandId: randomUUID(), libraryRootId: root.id, expectedRootRevision: root.revision, relative: '无媒体/合成.flac', sha256: null, sampleFrames: null, timebaseHz: null });
    assert.equal(isAudioAsset(asset), true); assetId = asset.id;
  } finally { seed.close(); }
  await copyFile(seedFile, file, constants.COPYFILE_EXCL);
  const workInfo = await lstat(file); assert.equal(workInfo.uid, process.getuid!()); assert.equal(workInfo.mode & 0o777, 0o600); assert.equal(workInfo.nlink, 1);
  const db = new DatabaseSync(file, { enableForeignKeyConstraints: true, allowExtension: false }), firstPage: LocalTrack[] = [];
  let rows = 0, bytes = 0;
  try {
    db.exec('PRAGMA trusted_schema=OFF;');
    assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, 34, '版本必须来自实际Repository的正式迁移');
    const insertTrack = db.prepare('INSERT INTO local_catalog_tracks(id,asset_id,data) VALUES(?,?,?)');
    const insertReceipt = db.prepare('INSERT INTO local_catalog_ledger(command_id,fingerprint,operation,request,result,created_at) VALUES(?,?,?,?,?,?)');
    db.exec('BEGIN IMMEDIATE');
    try {
      for (let index = 0; index < trackCount; index++) {
        const request = { commandId: randomUUID(), assetId, segment: null };
        const result: LocalTrack = { id: randomUUID(), assetId, selectionRevision: '1', segment: null };
        assert.equal(isLocalTrack(result), true);
        const fingerprint = bodyFingerprint(request);
        assert.equal(isLocalCatalogReceipt({ commandId: request.commandId, operation: 'create-track', fingerprint, result }), true);
        insertTrack.run(result.id, assetId, JSON.stringify(result));
        insertReceipt.run(request.commandId, fingerprint, 'create-track', JSON.stringify(request), JSON.stringify(result), '2026-10-04T00:00:00.000Z');
        if (firstPage.length < 20) firstPage.push(result);
      }
      assert.equal(db.prepare('PRAGMA integrity_check').get()?.integrity_check, 'ok');
      assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []); db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    // 独立核每条请求、指纹、DTO、投影和时间；不调用低容量production verifier来生产或判定夹具。
    let validated = 0;
    for (const row of db.prepare("SELECT l.*,t.data track_data,t.asset_id track_asset_id FROM local_catalog_ledger l JOIN local_catalog_tracks t ON t.id=json_extract(l.result,'$.id') WHERE l.operation='create-track' ORDER BY l.rowid").iterate()) {
      const request = JSON.parse(String(row.request)) as Record<string, unknown>, result: unknown = JSON.parse(String(row.result));
      assert.deepEqual(Object.keys(request).sort(), ['assetId', 'commandId', 'segment']);
      assert.equal(request.commandId, row.command_id); assert.equal(request.assetId, assetId); assert.equal(request.segment, null);
      assert.equal(row.fingerprint, bodyFingerprint(request)); assert.equal(row.created_at, '2026-10-04T00:00:00.000Z');
      assert.equal(isLocalCatalogReceipt({ commandId: row.command_id, operation: row.operation, fingerprint: row.fingerprint, result }), true);
      assert.ok(isLocalTrack(result)); assert.equal(result.assetId, assetId); assert.equal(result.selectionRevision, '1'); assert.equal(result.segment, null);
      assert.deepEqual(JSON.parse(String(row.track_data)), result); assert.equal(row.track_asset_id, assetId); validated++;
    }
    assert.equal(validated, trackCount); assert.equal(db.prepare('SELECT count(*) n FROM local_catalog_tracks').get()?.n, trackCount);
    assert.equal(db.prepare('SELECT count(*) n FROM local_catalog_ledger').get()?.n, trackCount + 2);
    for (const table of LOCAL_TABLES) {
      const columns = db.prepare(`PRAGMA table_info(${table})`).all().filter(column => column.type === 'TEXT').map(column => String(column.name));
      const size = db.prepare(`SELECT count(*) n,COALESCE(sum(${columns.map(column => `COALESCE(length(CAST(${column} AS BLOB)),0)`).join('+')}),0) bytes FROM ${table}`).get()!;
      rows += Number(size.n); bytes += Number(size.bytes);
    }
    assert.equal(rows, trackCount * 2 + 4);
    assert.ok(bytes < 128 * 1024 * 1024, '独立事实须低于当前字节上限，容量case只隔离累计行阈值');
    assert.equal(db.prepare('PRAGMA integrity_check').get()?.integrity_check, 'ok'); assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { db.close(); }
  const repository = createCollectionRepository({ filePath: file }); close = () => repository.close();
  return { repository, assetId, firstPage, rows, bytes, trackCount };
}

/** 只观察本次同步真实命令；Statement方法保持原SQL和绑定执行，finally恢复原型。 */
function observeReadRows<T>(operation: () => T) {
  const prepare = DatabaseSync.prototype.prepare;
  const methods = { get: 0, all: 0, iterate: 0 }, statements = new Map<string, number>();
  let rows = 0, fullIntegrityRuns = 0;
  const add = (sql: string, count: number, method: keyof typeof methods) => {
    methods[method] += count; rows += count; statements.set(sql, (statements.get(sql) ?? 0) + count);
    if (/^\s*PRAGMA\s+(?:main\.)?integrity_check\b/iu.test(sql)) fullIntegrityRuns++;
  };
  DatabaseSync.prototype.prepare = function (sql) {
    const statement = prepare.call(this, sql);
    return new Proxy(statement, { get(target, property) {
      const value: unknown = Reflect.get(target, property, target);
      if (property === 'get' || property === 'all') return (...bindings: unknown[]) => {
        const result: unknown = Reflect.apply(value as (...args: unknown[]) => unknown, target, bindings);
        add(sql, property === 'all' ? (result as unknown[]).length : result === undefined ? 0 : 1, property); return result;
      };
      if (property === 'iterate') return (...bindings: unknown[]) => {
        const iterator = Reflect.apply(value as (...args: unknown[]) => Iterable<Record<string, unknown>>, target, bindings);
        return (function*() { for (const row of iterator) { add(sql, 1, 'iterate'); yield row; } })();
      };
      return typeof value === 'function' ? value.bind(target) : value;
    } });
  };
  try { return { value: operation(), rows, methods, fullIntegrityRuns, statements: [...statements].sort(([, a], [, b]) => b - a).slice(0, 6) }; }
  finally { DatabaseSync.prototype.prepare = prepare; }
}

test('MBRS002 capacity：合法50000曲目累计100004实体与回执行可冷开分页，不能误判为损坏', async t => {
  const f = await syntheticCatalog(t, 50_000);
  assert.ok(f.rows > 100_000); t.diagnostic(`独立合法事实：${JSON.stringify({ tracks: f.trackCount, entityAndLedgerRows: f.rows, bytes: f.bytes, sqliteIntegrity: 'ok', foreignKeys: 0 })}`);
  let page: ReturnType<typeof f.repository.localCatalog.pageTracks> | undefined;
  assert.doesNotThrow(() => { page = f.repository.localCatalog.pageTracks({ offset: 0, limit: 20 }); }, '目标：独立合法schema32私有库应能cold-open，累计实体与ledger不能套用曲目数量上限');
  assert.ok(page); assert.equal(page.total, 50_000); assert.deepEqual(page.items, f.firstPage); assert.equal(page.hasMore, true);
  const tail = f.repository.localCatalog.pageTracks({ offset: 49_980, limit: 20 }); assert.equal(tail.items.length, 20); assert.equal(tail.hasMore, false);
  for (const track of tail.items) assert.equal(isLocalTrack(track), true);
});

test('MBRS002 complexity：1024条既有合法历史中新增单whole-track只读有界行，不重放全库与SQLite完整审计', async t => {
  const f = await syntheticCatalog(t, 1024);
  // 首次cold-open完整校验在观察窗口之外；本case只计一个热连接上的真实短事务。
  assert.equal(f.repository.localCatalog.pageTracks({ offset: 0, limit: 1 }).total, 1024);
  const request = { commandId: randomUUID(), assetId: f.assetId, segment: null };
  const observed = observeReadRows(() => f.repository.localCatalog.createTrack(request));
  assert.equal(isLocalTrack(observed.value), true); assert.equal(observed.value.assetId, f.assetId);
  assert.deepEqual(f.repository.localCatalog.receipt(request.commandId)?.result, observed.value);
  assert.equal(f.repository.localCatalog.pageTracks({ offset: 0, limit: 1 }).total, 1025);
  t.diagnostic(`单对象实际SQLite读行：${JSON.stringify({ priorTracks: 1024, budget: SINGLE_COMMAND_READ_ROW_BUDGET, rows: observed.rows, methods: observed.methods, fullIntegrityRuns: observed.fullIntegrityRuns, largestRowQueries: observed.statements })}`);
  assert.ok(observed.rows <= SINGLE_COMMAND_READ_ROW_BUDGET, `目标：单对象真实命令只读取相关实体/回执；实际${observed.rows}行超过固定${SINGLE_COMMAND_READ_ROW_BUDGET}行预算`);
  assert.equal(observed.fullIntegrityRuns, 0, '短事务完整SQLite审计应留给cold-open、迁移、备份和restore核验');
});
