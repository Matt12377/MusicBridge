import { createHash } from 'node:crypto';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { LOCAL_WORKBENCH_JOURNAL_OPERATION, LOCAL_LIBRARY_MANAGEMENT_OPERATION, LOCAL_LYRICS_JOURNAL_OPERATION, LOCAL_LYRICS_ROOT_OPERATION } from '../local-library-workbench/owner-journal.js';
import { LOCAL_CUE_OUTPUT_OPERATION } from '../local-cue-output-protocol.js';
import { LOCAL_SCAN_SETTINGS_OPERATION } from '../local-scan-settings.js';
import { LOCAL_LYRICS_PHYSICAL_OPERATION } from '../../library/lyrics-source-format.js';

const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
interface RevisionCache {
  statements: Map<string, ReturnType<DatabaseSync['prepare']>>;
  schemaVersion?: number;
  barrier?: string;
  catalog?: string;
  scan?: string;
}
const revisions = new WeakMap<DatabaseSync, RevisionCache>();
function cacheFor(db: DatabaseSync): RevisionCache {
  let cache = revisions.get(db);
  if (!cache) { cache = { statements: new Map() }; revisions.set(db, cache); }
  return cache;
}
function statement(db: DatabaseSync, sql: string): ReturnType<DatabaseSync['prepare']> {
  const statements = cacheFor(db).statements, saved = statements.get(sql);
  if (saved) return saved;
  const prepared = db.prepare(sql); statements.set(sql, prepared); return prepared;
}
function clearResults(cache: RevisionCache): void { delete cache.barrier; delete cache.catalog; delete cache.scan; }
function sqlNumber(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error('专辑修订SQL屏障无效，本次未返回缓存。');
  return value;
}
function readBarrier(db: DatabaseSync, cache: RevisionCache): { key: string; transaction: boolean } {
  const changes = sqlNumber(statement(db, 'SELECT total_changes() n').get()?.n);
  const version = sqlNumber(statement(db, 'PRAGMA data_version').get()?.data_version);
  const schema = sqlNumber(statement(db, 'PRAGMA schema_version').get()?.schema_version);
  const transaction = db.isTransaction;
  if (typeof transaction !== 'boolean') throw new Error('专辑修订事务屏障无效，本次未返回缓存。');
  if (cache.schemaVersion !== undefined && cache.schemaVersion !== schema) { cache.statements.clear(); clearResults(cache); }
  cache.schemaVersion = schema;
  return { key: JSON.stringify([changes, version, schema, transaction]), transaction };
}
/** 只复用同原连接非事务内的hash；guard/certificate及实际SQL屏障每次仍执行。 */
function revision(db: DatabaseSync, kind: 'catalog' | 'scan', read: () => string): string {
  const cache = cacheFor(db);
  try {
    const before = readBarrier(db, cache);
    if (before.transaction || cache.barrier !== before.key) clearResults(cache);
    const saved = cache[kind], value = !before.transaction && saved !== undefined ? saved : read();
    const after = readBarrier(db, cache);
    if (after.key !== before.key) throw new Error('专辑修订读取期间SQL已变化，本次未返回混合水位。');
    // 同连接两次只读事务可能具有不同快照，事务内不发布或命中revision结果。
    if (!after.transaction) { cache.barrier = after.key; cache[kind] = value; }
    return value;
  } catch (error) { revisions.delete(db); throw error; }
}
const hasTable = (db: DatabaseSync, table: string): boolean => !!statement(db, "SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(table);
const watermark = (db: DatabaseSync, table: string, where = '', values: readonly SQLInputValue[] = []): unknown => hasTable(db, table)
  ? statement(db, `SELECT count(*) n, coalesce(max(rowid),0) last FROM ${table} ${where}`).get(...values) : null;

/** 仅在原 Owner 的 guarded read 中调用；版本不含对外可用路径或新授权。 */
export function albumCatalogRevision(db: DatabaseSync): string {
  return revision(db, 'catalog', () => digest([
    // 调用者仍先完整核原ledger；仅闭集纯快照不改变专辑来源事实。
    // 控制计划、独立输出、读取捕获和任务进度不改变原媒体；不能由自身受理使原读取失效。
    // Lyrics物理journal引用的实际资产/扫描/盘点仍由各自业务事实推进；inventory、binding和operation继续计入。
    // 实际字段、发行关系、定位、根、MBOnly作者和封面仍完整认证并推进修订。
    watermark(db, 'local_catalog_ledger',
      "WHERE operation NOT IN (?,?,?,?,?) AND NOT (operation = ? AND coalesce(json_extract(request,'$.recordKind'),'') IN ('capture','job')) AND NOT (operation = ? AND coalesce(json_extract(request,'$.recordKind'),'') IN ('save','job'))",
      [LOCAL_WORKBENCH_JOURNAL_OPERATION, LOCAL_CUE_OUTPUT_OPERATION, LOCAL_SCAN_SETTINGS_OPERATION, LOCAL_LYRICS_ROOT_OPERATION,
        LOCAL_LYRICS_PHYSICAL_OPERATION, LOCAL_LIBRARY_MANAGEMENT_OPERATION, LOCAL_LYRICS_JOURNAL_OPERATION]),
    watermark(db, 'local_artwork_ledger'),
    statement(db, 'SELECT data FROM local_catalog_roots ORDER BY id').all(),
    statement(db, 'SELECT data FROM source_roots WHERE id IN (SELECT source_root_id FROM local_catalog_roots) ORDER BY id').all(),
  ]));
}
export function albumScanRevision(db: DatabaseSync): string {
  return revision(db, 'scan', () => digest([watermark(db, 'local_scan_batches', "WHERE phase='committed'"),
    watermark(db, 'local_scan_file_state'), watermark(db, 'local_cue_sources')]));
}
