import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

type Domain = 'catalog' | 'scan';
// SQL目标只来自本模块闭集；不接收Renderer、缓存正文或调用者传入的表名。
const tables: Readonly<Record<Domain, readonly string[]>> = {
  catalog: ['local_catalog_roots', 'local_catalog_assets', 'local_catalog_tracks', 'local_catalog_editions',
    'local_catalog_edition_tracks', 'local_catalog_observations', 'local_catalog_overrides', 'local_catalog_ledger',
    'source_roots', 'source_ledger', 'local_artwork_ledger'],
  scan: ['local_scan_jobs', 'local_scan_batches', 'local_scan_checkpoints', 'local_scan_file_state', 'local_scan_receipts',
    'local_cue_sources', 'local_cue_tracks', 'local_scan_snapshot_commits', 'local_scan_snapshot_chunks'],
};
interface Counter { writes: number; published: number; poisoned: boolean }
interface Observer {
  functionName: string;
  counters: Map<Domain, Counter>;
  observed: Set<string>;
  triggers: Map<string, { table: string; sql: string }>;
  mainSchema: number;
  tempSchema: number;
  invalid: boolean;
}
/** 仅在当前连接内比较；不进入持久快照，不包含源读取或写入能力。 */
export interface LocalAuditWritePoint { readonly owner: object; readonly writes: number }
const observers = new WeakMap<DatabaseSync, Observer>();
const readonlyOwners = new WeakMap<DatabaseSync, Map<Domain, object>>();
function scalar(db: DatabaseSync, sql: string, key: string): number {
  const value = db.prepare(sql).get()?.[key];
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error('本地审计写入观察器水位无效。');
  return value;
}
function currentObserver(db: DatabaseSync, observer: Observer): boolean {
  if (observer.invalid) return false;
  if (scalar(db, 'PRAGMA schema_version', 'schema_version') !== observer.mainSchema
    || scalar(db, 'PRAGMA temp.schema_version', 'schema_version') !== observer.tempSchema) observer.invalid = true;
  return !observer.invalid;
}
function readonlyPoint(db: DatabaseSync, domain: Domain): LocalAuditWritePoint | undefined {
  if (scalar(db, 'PRAGMA query_only', 'query_only') !== 1) return undefined;
  let owners = readonlyOwners.get(db);
  if (!owners) { owners = new Map(); readonlyOwners.set(db, owners); }
  let owner = owners.get(domain);
  if (!owner) { owner = Object.freeze({}); owners.set(domain, owner); }
  return { owner, writes: 0 };
}
/** 仅原完整核验或合法audit发布时设置基准；只读Actor不安装函数或TEMP触发器。 */
export function publishLocalAuditWritePoint(db: DatabaseSync, domain: Domain, fullyVerified = false): LocalAuditWritePoint | undefined {
  try {
    let observer = observers.get(db);
    if (observer && !currentObserver(db, observer)) {
      if (!fullyVerified || scalar(db, 'PRAGMA query_only', 'query_only') !== 0) return undefined;
      const rows = db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_temp_schema').all();
      // 完整重核只可重建本模块原有观察器；未知TEMP对象及改写的SQL仍不准入。
      if (rows.some(row => {
        const known = typeof row.name === 'string' ? observer!.triggers.get(row.name) : undefined;
        return !known || row.type !== 'trigger' || row.tbl_name !== known.table || row.sql !== known.sql;
      })) return undefined;
      for (const row of rows) db.exec(`DROP TRIGGER temp."${String(row.name)}"`);
      observer.counters.clear(); observer.observed.clear(); observer.triggers.clear();
      observer.mainSchema = scalar(db, 'PRAGMA schema_version', 'schema_version');
      observer.tempSchema = scalar(db, 'PRAGMA temp.schema_version', 'schema_version');
      observer.invalid = false;
    }
    if (!observer && scalar(db, 'PRAGMA query_only', 'query_only') === 1) return readonlyPoint(db, domain);
    if (!observer) {
      // 既存未知TEMP对象不能成为观察器的受信环境。
      if (db.prepare('SELECT name FROM sqlite_temp_schema LIMIT 1').get()) return undefined;
      observer = { functionName: 'mousa_local_audit_' + randomUUID().replaceAll('-', ''), counters: new Map(), observed: new Set(),
        triggers: new Map(), mainSchema: scalar(db, 'PRAGMA schema_version', 'schema_version'),
        tempSchema: scalar(db, 'PRAGMA temp.schema_version', 'schema_version'), invalid: false };
      const installed = observer;
      db.function(observer.functionName, { deterministic: false, directOnly: false }, (value: unknown) => {
        const counter = (value === 'catalog' || value === 'scan') ? installed.counters.get(value) : undefined;
        if (counter) {
          if (counter.writes === Number.MAX_SAFE_INTEGER) installed.invalid = true;
          else counter.writes++;
        }
        return 0;
      });
      observers.set(db, observer);
    }
    if (observer.counters.has(domain)) {
      const counter = observer.counters.get(domain)!;
      if (fullyVerified) counter.poisoned = false;
      if (counter.poisoned) return undefined;
      counter.published = counter.writes;
      return { owner: counter, writes: counter.writes };
    }
    if (scalar(db, 'PRAGMA query_only', 'query_only') !== 0) return undefined;
    const counter: Counter = { writes: 0, published: 0, poisoned: false };
    observer.counters.set(domain, counter);
    for (const table of tables[domain]) {
      if (!db.prepare("SELECT name FROM main.sqlite_schema WHERE type='table' AND name=?").get(table)) continue;
      for (const operation of ['INSERT', 'UPDATE', 'DELETE'] as const) {
        const name = observer.functionName + '_' + table + '_' + operation.toLowerCase();
        const sql = `CREATE TEMP TRIGGER "${name}" AFTER ${operation} ON main."${table}" BEGIN SELECT "${observer.functionName}"('${domain}'); END`;
        db.exec(sql);
        const row = db.prepare('SELECT type,tbl_name,sql FROM sqlite_temp_schema WHERE name=?').get(name);
        if (row?.type !== 'trigger' || row.tbl_name !== table || typeof row.sql !== 'string') throw new Error('本地审计观察器安装不完整。');
        // 立即记录SQLite规范化的本次可信DDL；过滤时逐字段核对，不以名称前缀放行。
        observer.triggers.set(name, { table, sql: row.sql });
      }
      observer.observed.add(table);
    }
    if (!tables[domain].some(table => observer!.observed.has(table))) throw new Error('本地审计观察器没有实际目标。');
    observer.tempSchema = scalar(db, 'PRAGMA temp.schema_version', 'schema_version');
    return { owner: counter, writes: counter.writes };
  } catch {
    const observer = observers.get(db); if (observer) observer.invalid = true;
    return undefined;
  }
}
/** 不安装观察器、不更新基准；派生候选只可取得当前已安装作者的私有计数。 */
export function currentLocalAuditWritePoint(db: DatabaseSync, domain: Domain): LocalAuditWritePoint | undefined {
  try {
    const observer = observers.get(db);
    if (observer) {
      if (!currentObserver(db, observer)) return undefined;
      const counter = observer.counters.get(domain);
      return counter && !counter.poisoned ? { owner: counter, writes: counter.writes } : undefined;
    }
    return readonlyPoint(db, domain);
  } catch { return undefined; }
}
/** counter仅看本域；库存、录音、queue或其它表的合法写入不会影响它。 */
export function isLocalAuditWritePointCurrent(db: DatabaseSync, domain: Domain, point: LocalAuditWritePoint): boolean {
  const current = currentLocalAuditWritePoint(db, domain);
  return !!current && current.owner === point.owner && current.writes === point.writes;
}
/** 原写事务入场前检查两域未知前缀；只锁定缓存资格，不改变业务执行或回滚。 */
export function lockUnknownLocalAuditWritePrefix(db: DatabaseSync): void {
  try {
    const observer = observers.get(db);
    if (!observer || !currentObserver(db, observer)) return;
    for (const counter of observer.counters.values()) if (counter.writes !== counter.published) counter.poisoned = true;
  } catch { const observer = observers.get(db); if (observer) observer.invalid = true; }
}
/** 原录音审计只忽略本模块仍有效且逐字段相等的TEMP观察器；未知对象全部保留。 */
export function withoutLocalAuditObserverSchema<T extends Record<string, unknown>>(db: DatabaseSync, rows: readonly T[]): T[] {
  try {
    const observer = observers.get(db);
    if (!observer || !currentObserver(db, observer)) return [...rows];
    return rows.filter(row => {
      const known = typeof row.name === 'string' ? observer.triggers.get(row.name) : undefined;
      return !known || row.type !== 'trigger' || row.tbl_name !== known.table || row.sql !== known.sql;
    });
  } catch { return [...rows]; }
}
