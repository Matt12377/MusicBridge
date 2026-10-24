import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { logLibraryOperation } from '../shared/library-operation-log.js'

// 只保存冷核或原扫描事务已读过的候选位置；命中后仍须读取原JSON、job及资产账本。
// 不缓存技术事实、Source许可或成功证明，也不修改持久扫描数据。
interface OriginPosition { ordinal: number; batchId: string; jobId: string }
export interface ScanOriginIndex {
  entries: Map<string, number[]>
  batches: Map<number, OriginPosition>
  bytes: number
  overflow: boolean
  point?: string
  pending?: boolean
}
const indexes = new WeakMap<DatabaseSync, ScanOriginIndex>()
const MAX_BYTES = 32 * 1024 * 1024
const key = (root: string, asset: string, track: string, relative: string, signature: string): string =>
  createHash('sha256').update(JSON.stringify([root, asset, track, relative, signature])).digest('base64')
function point(db: DatabaseSync): string | undefined {
  const changes = db.prepare('SELECT total_changes() n').get()?.n
  const version = db.prepare('PRAGMA data_version').get()?.data_version
  const schema = db.prepare('PRAGMA schema_version').get()?.schema_version
  if (db.prepare('PRAGMA foreign_keys').get()?.foreign_keys !== 1
    || ![changes, version, schema].every(value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)) return undefined
  return JSON.stringify([changes, version, schema])
}
export function createScanOriginIndex(): ScanOriginIndex { return { entries: new Map(), batches: new Map(), bytes: 0, overflow: false } }
export function discardScanOriginIndex(db: DatabaseSync): void { indexes.delete(db) }
export function ownsScanOriginIndex(db: DatabaseSync, index: ScanOriginIndex): boolean { return indexes.get(db) === index }
/** 仅已获原Owner连续队列证明的只读事务，保留同一份扫描事实索引。 */
export function continueReadonlyQueueScanOrigins(db: DatabaseSync, previousVersion: number): void {
  const index = indexes.get(db), actual = point(db)
  if (!db.isTransaction || db.prepare('PRAGMA query_only').get()?.query_only !== 1 || !actual) throw new Error('只读队列扫描水位不匹配。')
  if (!index) return
  const before = index.point ? JSON.parse(index.point) as number[] : []
  const after = JSON.parse(actual) as number[]
  if (before[1] !== previousVersion || before[0] !== after[0] || before[2] !== after[2]) throw new Error('只读队列扫描索引作者不匹配。')
  index.point = actual; index.pending = true
}
export function currentScanOriginIndex(db: DatabaseSync, allowPending = false): ScanOriginIndex | undefined {
  const index = indexes.get(db)
  if (!index) return undefined
  if ((index.pending || db.isTransaction) && !allowPending) return undefined
  if (index.point !== point(db)) {
    const before = index.point ? JSON.parse(index.point) as number[] : [], actual = point(db)
    const after = actual ? JSON.parse(actual) as number[] : []
    indexes.delete(db)
    logLibraryOperation('cache', 'scan.origin-index', 'skipped', { code: before[2] !== after[2] ? 'SCHEMA_CHANGED' : before[1] !== after[1] ? 'EXTERNAL_DATABASE_CHANGED' : 'DATABASE_CHANGED',
      count: before[0] ?? 0, total: after[0] ?? 0 })
    return undefined
  }
  return index
}
export function addScanOriginBatch(index: ScanOriginIndex, position: OriginPosition, rootId: string,
  items: readonly { reused: boolean }[], files: readonly { assetId: string | null; trackId: string | null; relative: string; signature: string }[]): void {
  if (index.overflow) return
  for (const [itemIndex, file] of files.entries()) {
    // 与原origin SQL一致：无新资产作者的fresh项仍占候选名额；reused项不占名额。
    if (items[itemIndex]?.reused !== false || file.assetId === null || file.trackId === null) continue
    const identity = key(rootId, file.assetId, file.trackId, file.relative, file.signature)
    let positions = index.entries.get(identity)
    if (!positions) { positions = []; index.entries.set(identity, positions); index.bytes += identity.length * 2 + 192 }
    if (!index.batches.has(position.ordinal)) {
      index.batches.set(position.ordinal, Object.freeze({ ...position }))
      index.bytes += (position.batchId.length + position.jobId.length) * 2 + 160
    }
    if (!positions.includes(position.ordinal)) {
      positions.push(position.ordinal); positions.sort((a, b) => b - a)
      if (positions.length > 200) positions.pop()
      else index.bytes += 8
    }
    if (index.bytes > MAX_BYTES) {
      index.overflow = true; index.entries.clear(); index.batches.clear(); return
    }
  }
}
/** 仅完整冷核成功或原作者真实COMMIT以后发布；回滚和未知写入不能续用。 */
export function publishScanOriginIndex(db: DatabaseSync, index: ScanOriginIndex): void {
  if (db.isTransaction || index.overflow) { indexes.delete(db); return }
  const actual = point(db)
  if (!actual) { indexes.delete(db); return }
  index.point = actual; index.pending = false; indexes.set(db, index)
}
/** 冷核在原恢复事务内完成，只暂存；任何公开读取都不能消费未COMMIT的候选。 */
export function stageScanOriginIndex(db: DatabaseSync, index: ScanOriginIndex): void {
  if (!db.isTransaction) { publishScanOriginIndex(db, index); return }
  const actual = point(db)
  if (!actual || index.overflow) { indexes.delete(db); return }
  index.point = actual; index.pending = true; indexes.set(db, index)
}
/** 播放队列CAS恰好写一行；首末真实水位闭合才保留无关origin索引，未知附加写仍整件弃。 */
export function captureScanOriginQueueWrite(db: DatabaseSync): { approve(): void; publish(): void } {
  const index = currentScanOriginIndex(db), before = point(db)
  let approved: string | undefined
  return {
    approve() {
      const actual = point(db)
      if (!index || !before || !actual || !db.isTransaction) return
      const [changes, version, schema] = JSON.parse(before) as number[], after = JSON.parse(actual) as number[]
      if (after[0] === changes! + 1 && after[1] === version && after[2] === schema) approved = actual
    },
    publish() {
      if (!index || !approved || db.isTransaction || !ownsScanOriginIndex(db, index) || point(db) !== approved) { discardScanOriginIndex(db); return }
      publishScanOriginIndex(db, index)
    },
  }
}
export function scanOriginPositions(index: ScanOriginIndex, root: string, asset: string, track: string, relative: string, signature: string): readonly OriginPosition[] {
  return (index.entries.get(key(root, asset, track, relative, signature)) ?? []).map(ordinal => index.batches.get(ordinal)!)
}
