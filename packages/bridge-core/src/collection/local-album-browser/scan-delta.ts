import type { DatabaseSync } from 'node:sqlite'
import { Buffer } from 'node:buffer'
import { readLocalLibraryManagementEvent, emptyLocalLibraryManagementProjection, projectLocalLibraryManagementEvent,
  assertLocalLibraryManagementComplete } from '../local-library-workbench/owner-journal.js'

/** 仅原Owner同连接的已提交写集；不进入wire，不保存源许可、FD或资产路径全集。 */
export interface LocalAlbumScanPoint { changes: number; version: number; schema: number }
export interface LocalAlbumScanDirectory { rootId: string; sourceRootId: string; rootRevision: string; directory: string }
export interface LocalAlbumScanCue { rootId: string; relative: string }
export interface LocalAlbumScanPath { directories: readonly LocalAlbumScanDirectory[]; cues: readonly LocalAlbumScanCue[] }
export interface LocalAlbumScanScopeOrigin { owner: object; stable: string; revision: string; catalog: string; scan: string; readonlyActor?: true }
const scopeOrigins = new WeakMap<object, LocalAlbumScanScopeOrigin>()
const queueReaders = new WeakMap<object, { db: DatabaseSync; point: LocalAlbumScanPoint; origin: LocalAlbumScanScopeOrigin; epoch: object }>()
/** 只由原Owner捕获；不透明令牌不能由wire或同值对象补造。 */
export function captureLocalAlbumQueueReader(db: DatabaseSync, scope: { revision: string }, epoch: object): object | undefined {
  const origin = localAlbumScanScopeOrigin(scope), point = localAlbumScanPoint(db)
  if (!origin || !point || db.isTransaction) return undefined
  const token = Object.freeze({}); queueReaders.set(token, { db, point, origin, epoch }); return token
}
export function continuesLocalAlbumQueueReader(db: DatabaseSync, before: object, after: object): boolean {
  const old = queueReaders.get(before), current = queueReaders.get(after)
  return !!old && !!current && old.db === db && current.db === db && old.epoch === current.epoch && !db.isTransaction
    && pointKey(current.point) === pointKey(localAlbumScanPoint(db) ?? { changes: -1, version: -1, schema: -1 })
    && old.origin.owner === current.origin.owner && old.origin.stable === current.origin.stable
    && old.origin.revision === current.origin.revision && old.origin.catalog === current.origin.catalog && old.origin.scan === current.origin.scan
    && current.point.changes > old.point.changes
    && localAlbumScanPath(db, old.point, current.point, { queueOnly: true }) !== null
}
/** scope仍由原Owner完整读取、seal；此品牌只说明不透明修订中哪些组件来自原catalog/scan。 */
export function bindLocalAlbumScanScope(scope: object, origin: LocalAlbumScanScopeOrigin): void { scopeOrigins.set(scope, Object.freeze({ ...origin })) }
export function localAlbumScanScopeOrigin(scope: { revision: string }): LocalAlbumScanScopeOrigin | undefined {
  const value = scopeOrigins.get(scope)
  return value?.revision === scope.revision ? value : undefined
}
export function localAlbumScanPoint(db: DatabaseSync): LocalAlbumScanPoint | null {
  try {
    const changes = db.prepare('SELECT total_changes() n').get()?.n
    const version = db.prepare('PRAGMA data_version').get()?.data_version
    const schema = db.prepare('PRAGMA schema_version').get()?.schema_version
    return [changes, version, schema].every(value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)
      ? { changes: Number(changes), version: Number(version), schema: Number(schema) } : null
  } catch { return null }
}
const pointKey = (value: LocalAlbumScanPoint): string => JSON.stringify([value.changes, value.version, value.schema])
const directoryKey = (value: Pick<LocalAlbumScanDirectory, 'rootId' | 'directory'>): string => JSON.stringify([value.rootId, value.directory])
const cueKey = (value: LocalAlbumScanCue): string => JSON.stringify([value.rootId, value.relative])
// 只保存近期已核事务链；消费者起点被逐出或路径超过预算便完整重建，不把后缀当完整证明。
const MAX_SPANS = 128, MAX_DIRECTORIES = 512, MAX_CUES = 512, MAX_BYTES = 1024 * 1024
interface Candidate {
  db: DatabaseSync; before: LocalAlbumScanPoint | null; scanWrites: number; valid: boolean
  directories: Map<string, LocalAlbumScanDirectory>; cues: Map<string, LocalAlbumScanCue>; bytes: number; approved?: LocalAlbumScanPoint
}
/** 空对象的内容只存在本模块WeakMap；调用者不能补造认可计数或改写已发布链。 */
export type LocalAlbumScanDelta = Readonly<Record<never, never>>
const candidates = new WeakMap<LocalAlbumScanDelta, Candidate>()
interface Span extends LocalAlbumScanPath { before: string; after: string; bytes: number; queueWrite?: true; captureWrite?: true }
const chains = new WeakMap<DatabaseSync, { spans: Span[]; bytes: number }>()
export function beginLocalAlbumScanDelta(db: DatabaseSync): LocalAlbumScanDelta {
  const token = Object.freeze({})
  candidates.set(token, { db, before: db.isTransaction ? null : localAlbumScanPoint(db), scanWrites: 0, valid: true, directories: new Map(), cues: new Map(), bytes: 0 })
  return token
}
export function recordLocalAlbumScanWrites(token: LocalAlbumScanDelta, writes: number): void {
  const value = candidates.get(token)
  if (!value) return
  if (!Number.isSafeInteger(writes) || writes < 0) value.valid = false
  else value.scanWrites += writes
}
export function invalidateLocalAlbumScanDelta(token: LocalAlbumScanDelta | undefined): void {
  if (token) { const value = candidates.get(token); if (value) value.valid = false }
}
export function recordLocalAlbumScanDirectory(token: LocalAlbumScanDelta, directory: LocalAlbumScanDirectory, cueRelative?: string): void {
  const value = candidates.get(token)
  if (!value?.valid) return
  const key = directoryKey(directory)
  const previous = value.directories.get(key)
  if (previous && (previous.sourceRootId !== directory.sourceRootId || previous.rootRevision !== directory.rootRevision)) { value.valid = false; return }
  if (!previous) { const copy = Object.freeze({ ...directory }); value.directories.set(key, copy); value.bytes += Buffer.byteLength(JSON.stringify(copy)) * 4 + 256 }
  if (cueRelative !== undefined) {
    const cue = Object.freeze({ rootId: directory.rootId, relative: cueRelative }), key = cueKey(cue)
    if (!value.cues.has(key)) { value.cues.set(key, cue); value.bytes += Buffer.byteLength(JSON.stringify(cue)) * 4 + 128 }
  }
  if (value.directories.size > MAX_DIRECTORIES || value.cues.size > MAX_CUES || value.bytes > MAX_BYTES) value.valid = false
}
/** 必须在原beforeCommit及写fence之后、真实COMMIT之前核精确总写数；不改变原事务结果。 */
export function approveLocalAlbumScanDelta(db: DatabaseSync, token: LocalAlbumScanDelta | undefined, catalogWrites = 0): void {
  const value = token ? candidates.get(token) : undefined, actual = localAlbumScanPoint(db)
  if (!value || value.db !== db || !value.valid || !value.before || !actual || !db.isTransaction
    || !Number.isSafeInteger(catalogWrites) || catalogWrites < 0 || actual.version !== value.before.version || actual.schema !== value.before.schema
    || actual.changes !== value.before.changes + value.scanWrites + catalogWrites) { if (value) value.valid = false; return }
  value.approved = actual
}
/** 只有外围真实COMMIT完成且物理水位仍完全吻合，才允许读模型消费；失败仅丢派生证明。 */
export function publishLocalAlbumScanDelta(db: DatabaseSync, token: LocalAlbumScanDelta | undefined): void {
  if (!token) return
  const value = candidates.get(token); candidates.delete(token)
  if (!value || value.db !== db || !value.valid || !value.before || !value.approved || db.isTransaction) return
  const actual = localAlbumScanPoint(db)
  if (!actual || pointKey(actual) !== pointKey(value.approved)) return
  retainSpan(db, { before: pointKey(value.before), after: pointKey(actual),
    directories: [...value.directories.values()], cues: [...value.cues.values()], bytes: value.bytes + 256 })
}
function retainSpan(db: DatabaseSync, span: Span): void {
  if (span.before === span.after) return
  const previous = chains.get(db), chain = previous?.spans.at(-1)?.after === span.before ? previous : { spans: [], bytes: 0 }
  if (span.bytes > MAX_BYTES) { chains.delete(db); return }
  // 仅逐出最旧完整段；近期读者仍可沿精确起点消费，落后读者找不到起点时完整重建。
  while (chain.spans.length && (chain.spans.length >= MAX_SPANS || chain.bytes + span.bytes > MAX_BYTES)) {
    const oldest = chain.spans.shift()!; chain.bytes -= oldest.bytes
  }
  chain.spans.push(span); chain.bytes += span.bytes; chains.set(db, chain)
}
export function discardLocalAlbumScanDelta(token: LocalAlbumScanDelta | undefined): void { if (token) candidates.delete(token) }
/** 只供原播放队列固定UPSERT：实际影响一行、完整原JSON回读及提交首末水位都闭合，才发布空段。
 * 这不是通用“无关写”许可；任何附加写、schema/data_version跳转、回滚或缺链仍无法续接。
 */
export function captureLocalAlbumQueueWrite(db: DatabaseSync,
  expected: Readonly<{ datasetId: string; queueId: string; revision: string; data: string }>,
): { approve(changes: number | bigint): void; publish(): void } {
  const before = db.isTransaction ? null : localAlbumScanPoint(db)
  const target = { ...expected }
  let approved: LocalAlbumScanPoint | undefined
  const matches = (): boolean => {
    const row = db.prepare('SELECT * FROM mb_playback_queue WHERE slot=1').get()
    return !!row && Object.keys(row).length === 5 && row.slot === 1 && row.dataset_id === target.datasetId
      && row.queue_id === target.queueId && row.revision === target.revision && row.data === target.data
  }
  return {
    approve(changes) {
      approved = undefined
      try {
        if (!before || !db.isTransaction || changes !== 1 && changes !== 1n || !matches()) return
        const actual = localAlbumScanPoint(db)
        if (actual && actual.changes === before.changes + 1 && actual.version === before.version && actual.schema === before.schema) approved = actual
      } catch { /* 派生证明失败只弃缓存，不改变原队列事务。 */ }
    },
    publish() {
      const committed = approved; approved = undefined
      try {
        if (!before || !committed || db.isTransaction) return
        const actual = localAlbumScanPoint(db)
        if (!actual || pointKey(actual) !== pointKey(committed) || !matches()) return
        retainSpan(db, { before: pointKey(before), after: pointKey(actual), directories: [], cues: [], bytes: 256, queueWrite: true })
      } catch { /* 只在原writer已成功COMMIT的分支调用；失败不补链。 */ }
    },
  }
}
/** 只供原管理CAS的首次capture完整账本；证明与队列证书分开，不能用于job/binding/operation。
 * 原capture、事务和audit仍由catalog完整核验；这里只证明该物理水位间恰好新增这些原codec认可行。
 * 预算只限制派生证书，超界不改变原capture受理与持久化合同。
 */
export interface LocalAlbumCaptureWrite {
  approve(rows: readonly Record<string, string>[]): void
  publish(): void
}
export function captureLocalAlbumCaptureWrite(db: DatabaseSync, datasetId: string): LocalAlbumCaptureWrite {
  const columns = ['command_id', 'fingerprint', 'operation', 'request', 'result', 'created_at'] as const
  let before: LocalAlbumScanPoint | null = null, highWater = -1
  try {
    if (!db.isTransaction) {
      before = localAlbumScanPoint(db)
      const actual = db.prepare('SELECT coalesce(max(rowid),0) n FROM local_catalog_ledger').get()?.n
      if (typeof actual === 'number' && Number.isSafeInteger(actual) && actual >= 0) highWater = actual
    }
  } catch { /* 证书失败不影响原CAS。 */ }
  let approved: LocalAlbumScanPoint | undefined, expected: readonly Readonly<Record<string, string>>[] | undefined
  const matches = (rows: readonly Readonly<Record<string, string>>[], validate: boolean): boolean => {
    const projection = validate ? emptyLocalLibraryManagementProjection(datasetId) : null
    for (let index = 0; index < rows.length; index++) {
      const target = rows[index]!, row = db.prepare('SELECT rowid AS _ledger_rowid,* FROM local_catalog_ledger WHERE command_id=?').get(target.command_id!)
      if (!row || Object.keys(row).length !== columns.length + 1 || row._ledger_rowid !== highWater + index + 1
        || columns.some(column => row[column] !== target[column])) return false
      // 回读永远走原闭集event codec；批准阶段还重放完整capture chunks、hash和batch闭包。
      const event = readLocalLibraryManagementEvent(row)
      if (event.datasetId !== datasetId || event.recordKind !== 'capture' || event.encoding !== 'full-v1'
        || event.expectedRevision !== null || event.revision !== 1) return false
      if (projection) projectLocalLibraryManagementEvent(projection, event, Number(row._ledger_rowid))
    }
    if (projection) assertLocalLibraryManagementComplete(projection)
    return true
  }
  return {
    approve(rows) {
      approved = undefined; expected = undefined
      try {
        if (!before || highWater < 0 || !db.isTransaction || !Array.isArray(rows) || !rows.length || rows.length > 512
          || !Number.isSafeInteger(highWater + rows.length)) return
        let bytes = 0
        const captured = rows.map(row => {
          if (Object.keys(row).length !== columns.length || columns.some(column => typeof row[column] !== 'string')) throw new Error('原capture账本行无效。')
          for (const column of columns) bytes += Buffer.byteLength(row[column]!)
          if (bytes > MAX_BYTES) throw new Error('原capture派生证书超出预算。')
          return Object.freeze({ ...row })
        })
        if (new Set(captured.map(row => row.command_id)).size !== captured.length || !matches(captured, true)) return
        const actual = localAlbumScanPoint(db)
        if (actual && actual.changes === before.changes + captured.length && actual.version === before.version && actual.schema === before.schema) {
          expected = captured; approved = actual
        }
      } catch { /* 未知写、原codec/闭包或预算不合格时只弃证明。 */ }
    },
    publish() {
      const committed = approved, rows = expected; approved = undefined; expected = undefined
      try {
        if (!before || !committed || !rows || db.isTransaction) return
        const actual = localAlbumScanPoint(db)
        if (!actual || pointKey(actual) !== pointKey(committed) || !matches(rows, false)) return
        const after = localAlbumScanPoint(db)
        if (!after || pointKey(after) !== pointKey(actual)) return
        retainSpan(db, { before: pointKey(before), after: pointKey(after), directories: [], cues: [], bytes: 256, captureWrite: true })
      } catch { /* 只能在原COMMIT与audit成功后调用；回读失败不补链。 */ }
    },
  }
}
/** queueOnly保持仅原队列证书；revisionStableOnly另允许精确capture证书，普通空scan仍不合格。 */
export function localAlbumScanPath(db: DatabaseSync, before: LocalAlbumScanPoint, after: LocalAlbumScanPoint,
  options?: { queueOnly?: true; revisionStableOnly?: true },
): LocalAlbumScanPath | null {
  if (before.schema !== after.schema || before.changes > after.changes) return null
  const from = pointKey(before), until = pointKey(after)
  if (from === until) return { directories: [], cues: [] }
  const chain = chains.get(db), start = chain?.spans.findIndex(value => value.before === from) ?? -1
  if (!chain || start < 0) return null
  const directories = new Map<string, LocalAlbumScanDirectory>(), cues = new Map<string, LocalAlbumScanCue>(); let cursor = from, bytes = 0
  for (const span of chain.spans.slice(start)) {
    if (span.before !== cursor || options?.queueOnly && span.queueWrite !== true
      || options?.revisionStableOnly && span.queueWrite !== true && span.captureWrite !== true) return null
    for (const value of span.directories) {
      const key = directoryKey(value), old = directories.get(key)
      if (old && (old.sourceRootId !== value.sourceRootId || old.rootRevision !== value.rootRevision)) return null
      directories.set(key, value)
    }
    for (const value of span.cues) cues.set(cueKey(value), value)
    bytes += span.bytes
    if (directories.size > MAX_DIRECTORIES || cues.size > MAX_CUES || bytes > MAX_BYTES) return null
    cursor = span.after
    if (cursor === until) return { directories: [...directories.values()], cues: [...cues.values()] }
  }
  return null
}

/** 仅隔离只读Actor已核的Owner队列连续链；未知版本变化没有此span，仍拒绝复用。 */
export function retainReadonlyAlbumQueueSpan(db: DatabaseSync, before: LocalAlbumScanPoint, after: LocalAlbumScanPoint): void {
  if (!db.isTransaction || db.prepare('PRAGMA query_only').get()?.query_only !== 1
    || before.changes !== after.changes || before.schema !== after.schema
    || pointKey(after) !== pointKey(localAlbumScanPoint(db) ?? { changes: -1, version: -1, schema: -1 })) throw new Error('只读队列连续链水位不匹配。')
  retainSpan(db, { before: pointKey(before), after: pointKey(after), directories: [], cues: [], bytes: 256, queueWrite: true })
}
