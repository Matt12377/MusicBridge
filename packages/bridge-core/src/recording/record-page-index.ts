import type { DatabaseSync } from 'node:sqlite'
import type { RecordingPlanVersion, RecordingRecord } from '@music-bridge/contracts'
import { parseRecordingPlan } from './plan-integrity.js'
import { readRecordingRecord } from './record-integrity.js'
import { buildRecordPageSearch, type RecordPageSearchProjection } from './record-projections.js'

// 既有 record 完整性审计以 recording_record* 收集固定 schema；新增索引名须避开此前缀。
const pageIndex = "CREATE INDEX idx_recordpage_completed ON recording_records(json_extract(data,'$.completion.endedAt') DESC,id DESC)"
/** schema27 为普通无筛选分页固定完成时间顺序；既有档案字节不迁移或重写。 */
export const recordingRecordPageMigration = `${pageIndex}; PRAGMA user_version=27;`

export function verifyRecordingRecordPageIndex(db: DatabaseSync): void {
  if (db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_recordpage_completed'").get()?.sql !== pageIndex) {
    throw new Error('录音档案分页索引缺失或损坏。')
  }
}

const searchColumns = [
  'record_id', 'physical_id', 'master_version_id', 'completed_at', 'master_text', 'media_brand_text', 'media_series_text',
  'track_text', 'artist_text', 'artist_display', 'equipment_text', 'query_text', 'record_content_hash', 'plan_content_hash',
] as const satisfies readonly (keyof RecordPageSearchProjection)[]
const searchTable = `CREATE TABLE recordpage_search(${searchColumns.map(column => `${column} TEXT ${column === 'record_id' ? 'PRIMARY KEY NOT NULL REFERENCES recording_records(id)' : 'NOT NULL'}`).join(',')}) STRICT`
const searchCompletedIndex = 'CREATE INDEX idx_recordpage_search_completed ON recordpage_search(completed_at DESC,record_id DESC)'
const searchPhysicalIndex = 'CREATE INDEX idx_recordpage_search_physical ON recordpage_search(physical_id,completed_at DESC,record_id DESC)'
const searchMasterIndex = 'CREATE INDEX idx_recordpage_search_master ON recordpage_search(master_version_id,completed_at DESC,record_id DESC)'
const searchNoUpdate = "CREATE TRIGGER recordpage_search_no_update BEFORE UPDATE ON recordpage_search BEGIN SELECT RAISE(ABORT,'immutable record page search'); END"
const searchNoDelete = "CREATE TRIGGER recordpage_search_no_delete BEFORE DELETE ON recordpage_search BEGIN SELECT RAISE(ABORT,'immutable record page search'); END"
const searchSchema = [searchTable, searchCompletedIndex, searchPhysicalIndex, searchMasterIndex, searchNoUpdate, searchNoDelete] as const
const MAX_SEARCH_ROW_BYTES = 512 * 1024
const MAX_SEARCH_TOTAL_BYTES = 256 * 1024 * 1024
const fail = (): never => { throw new Error('录音档案搜索投影缺失或与不可变 Record/Plan 不一致。') }
const encodedBytes = (projection: RecordPageSearchProjection): number => searchColumns.reduce((sum, column) => sum + Buffer.byteLength(projection[column]), 0)
const text = (value: unknown): value is string => typeof value === 'string'

/** 调用方已有写事务；先限制单行，再插入恰好一行并返回 UTF-8 字节数。 */
function insertSearchRow(db: DatabaseSync, record: RecordingRecord, frozenPlan: RecordingPlanVersion): number {
  const projected = buildRecordPageSearch(record, frozenPlan)
  const bytes = encodedBytes(projected)
  if (record.completion.planVersionId !== frozenPlan.id || bytes > MAX_SEARCH_ROW_BYTES) fail()
  db.prepare(`INSERT INTO recordpage_search(${searchColumns.join(',')}) VALUES (${searchColumns.map(() => '?').join(',')})`)
    .run(...searchColumns.map(column => projected[column]))
  return bytes
}

/** 正式完成登记与 Attempt 同事务；每次追加后核验整表预算。 */
export function insertRecordingRecordPageSearch(db: DatabaseSync, record: RecordingRecord, frozenPlan: RecordingPlanVersion): void {
  insertSearchRow(db, record, frozenPlan)
  const size = db.prepare(`SELECT coalesce(sum(${searchColumns.map(column => `length(CAST(${column} AS BLOB))`).join('+')}),0) AS n FROM recordpage_search`).get()
  if (Number(size?.n) > MAX_SEARCH_TOTAL_BYTES) fail()
}

/** schema29 只追加投影；原 Record、Plan 及完成账本字节原封不动。外层迁移事务负责回滚。 */
export function migrateRecordingRecordPageSearch(db: DatabaseSync): void {
  for (const sql of searchSchema) db.exec(sql)
  let totalBytes = 0
  for (const row of db.prepare('SELECT id,plan_id FROM recording_records ORDER BY rowid').all()) {
    const record = readRecordingRecord(db, String(row.id)) ?? fail()
    const source = db.prepare('SELECT data FROM recording_plan_versions WHERE id=?').get(String(row.plan_id)) ?? fail()
    totalBytes += insertSearchRow(db, record, parseRecordingPlan(source.data))
  }
  if (totalBytes > MAX_SEARCH_TOTAL_BYTES) fail()
  db.exec('PRAGMA user_version=29')
  verifyRecordingRecordPageSearch(db)
}

/** 冷开、备份、隔离恢复都要核对完整投影，不对历史做无声重建。 */
export function verifyRecordingRecordPageSearch(db: DatabaseSync): void {
  const normalize = (sql: string): string => sql.trim().replace(/;\s*$/u, '').replace(/\s+/gu, ' ')
  for (const sql of searchSchema) {
    const name = /^(?:CREATE (?:TABLE|INDEX|TRIGGER)) ([A-Za-z0-9_]+)/u.exec(sql)?.[1] ?? fail()
    const actual = db.prepare('SELECT sql FROM sqlite_master WHERE name=?').get(name)
    if (!text(actual?.sql) || normalize(actual.sql) !== normalize(sql)) fail()
  }
  if (db.prepare('PRAGMA foreign_key_check(recordpage_search)').get()) fail()
  const rows = db.prepare(`SELECT ${searchColumns.join(',')} FROM recordpage_search ORDER BY record_id`).all()
  if (rows.length !== Number(db.prepare('SELECT count(*) AS n FROM recording_records').get()?.n) || rows.length > 100_000) fail()
  let totalBytes = 0
  for (const row of rows) {
    if (!searchColumns.every(column => text(row[column]))) fail()
    const record = readRecordingRecord(db, String(row.record_id)) ?? fail()
    const planRow = db.prepare('SELECT data FROM recording_plan_versions WHERE id=?').get(String(record.completion.planVersionId)) ?? fail()
    const projected = buildRecordPageSearch(record, parseRecordingPlan(planRow.data))
    const bytes = encodedBytes(projected)
    if (bytes > MAX_SEARCH_ROW_BYTES || !searchColumns.every(column => row[column] === projected[column])) fail()
    totalBytes += bytes
    if (totalBytes > MAX_SEARCH_TOTAL_BYTES) fail()
  }
}
