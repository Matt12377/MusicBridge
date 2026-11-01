import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { logLibraryOperation } from '../shared/library-operation-log.js'
import { currentLocalAuditWritePoint, isLocalAuditWritePointCurrent, type LocalAuditWritePoint } from './local-audit-write-observer.js'

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
/** 仅保存候选位置；连接水位与事务资格在恢复时重新取得。 */
export interface ScanOriginIndexState {
  entries: Map<string, number[]>
  batches: Map<number, OriginPosition>
  bytes: number
}
const indexes = new WeakMap<DatabaseSync, ScanOriginIndex>()
// 与活索引共用同一对象；只允许内容指纹绑定的新连接恢复，不续借旧SQL点。
const pureIndexes = new WeakMap<DatabaseSync, ScanOriginIndex>()
const writePoints = new WeakMap<ScanOriginIndex, { catalog: LocalAuditWritePoint; scan: LocalAuditWritePoint; version: number; schema: number }>()
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
export function discardScanOriginIndex(db: DatabaseSync): void { indexes.delete(db); pureIndexes.delete(db) }
function originStateRecord(value: unknown, names: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false
  const descriptors = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(descriptors)
  return keys.length === names.length && names.every(name => descriptors[name]?.enumerable && Object.hasOwn(descriptors[name]!, 'value'))
    && keys.every(name => typeof name === 'string' && names.includes(name))
}
function copyOriginState(value: unknown): ScanOriginIndexState | null {
  if (value === null) return null
  if (!originStateRecord(value, ['entries', 'batches', 'bytes']) || !(value.entries instanceof Map) || !(value.batches instanceof Map)
    || Object.getPrototypeOf(value.entries) !== Map.prototype || Object.getPrototypeOf(value.batches) !== Map.prototype
    || Reflect.ownKeys(value.entries).length || Reflect.ownKeys(value.batches).length
    || typeof value.bytes !== 'number' || !Number.isSafeInteger(value.bytes) || value.bytes < 0 || value.bytes > MAX_BYTES
    || value.entries.size > MAX_BYTES / 280 || value.batches.size > MAX_BYTES / 160) throw new Error('扫描候选快照无效。')
  const batches = new Map<number, OriginPosition>(), entries = new Map<string, number[]>()
  let allocation = 0
  for (const [ordinal, item] of value.batches) {
    if (typeof ordinal !== 'number' || !Number.isSafeInteger(ordinal) || ordinal < 1 || !originStateRecord(item, ['ordinal', 'batchId', 'jobId'])
      || item.ordinal !== ordinal || ![item.batchId, item.jobId].every(id => typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/u.test(id))) throw new Error('扫描候选批身份无效。')
    const position = { ordinal, batchId: item.batchId as string, jobId: item.jobId as string }
    allocation += (position.batchId.length + position.jobId.length) * 2 + 160
    batches.set(ordinal, Object.freeze(position))
  }
  for (const [identity, positions] of value.entries) {
    if (typeof identity !== 'string' || !/^[A-Za-z0-9+/]{43}=$/u.test(identity) || !Array.isArray(positions)
      || Object.getPrototypeOf(positions) !== Array.prototype || positions.length < 1 || positions.length > 200
      || Reflect.ownKeys(positions).length !== positions.length + 1) throw new Error('扫描候选位置无效。')
    const copied: number[] = []
    for (let index = 0; index < positions.length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(positions, String(index)), ordinal = descriptor?.value as unknown
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value') || typeof ordinal !== 'number' || !Number.isSafeInteger(ordinal)
        || ordinal < 1 || !batches.has(ordinal) || index > 0 && ordinal >= copied[index - 1]!) throw new Error('扫描候选顺序无效。')
      copied.push(ordinal)
    }
    allocation += identity.length * 2 + 192 + copied.length * 8
    entries.set(identity, copied)
  }
  // 后台重建可能还计入已释放的根索引开销；声明预算不能低于保留位置的实际分配。
  if (allocation > value.bytes || allocation > MAX_BYTES) throw new Error('扫描候选快照超过资源预算。')
  return { entries, batches, bytes: value.bytes }
}
/** 无索引或水位过期只省略派生候选，不能重建已失效的旧索引。 */
function currentPureIndex(db: DatabaseSync): ScanOriginIndex | undefined {
  const index = pureIndexes.get(db), writes = index && writePoints.get(index), actual = point(db)
  const values = actual ? JSON.parse(actual) as number[] : []
  if (!index || !writes || writes.version !== values[1] || writes.schema !== values[2]
    || !isLocalAuditWritePointCurrent(db, 'catalog', writes.catalog) || !isLocalAuditWritePointCurrent(db, 'scan', writes.scan)) return undefined
  return index
}
export function captureScanOriginIndexState(db: DatabaseSync): ScanOriginIndexState | null {
  const index = currentPureIndex(db)
  if (!index) return null
  return copyOriginState({ entries: index.entries, batches: index.batches, bytes: index.bytes })
}
/** 调用方已核实际数据库内容指纹；恢复仅发布本连接的纯候选位置。 */
export function restoreScanOriginIndexState(db: DatabaseSync, value: unknown): boolean {
  discardScanOriginIndex(db)
  try {
    const state = copyOriginState(value)
    if (!state) return true
    const index: ScanOriginIndex = { ...state, overflow: false }
    stageScanOriginIndex(db, index)
    return ownsScanOriginIndex(db, index)
  } catch { discardScanOriginIndex(db); return false }
}
export function ownsScanOriginIndex(db: DatabaseSync, index: ScanOriginIndex): boolean { return indexes.get(db) === index }
/** 仅已获原Owner连续队列证明的只读事务，保留同一份扫描事实索引。 */
export function continueReadonlyQueueScanOrigins(db: DatabaseSync, previousVersion: number): void {
  const index = indexes.get(db), actual = point(db)
  if (!db.isTransaction || db.prepare('PRAGMA query_only').get()?.query_only !== 1 || !actual) throw new Error('只读队列扫描水位不匹配。')
  if (!index) return
  const before = index.point ? JSON.parse(index.point) as number[] : []
  const after = JSON.parse(actual) as number[]
  if (before[1] !== previousVersion || before[0] !== after[0] || before[2] !== after[2]) throw new Error('只读队列扫描索引作者不匹配。')
  const writes = writePoints.get(index)
  if (writes && writes.version === previousVersion && writes.schema === after[2]
    && isLocalAuditWritePointCurrent(db, 'catalog', writes.catalog) && isLocalAuditWritePointCurrent(db, 'scan', writes.scan)) writes.version = after[1]!
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
  if (db.isTransaction || index.overflow) { discardScanOriginIndex(db); return }
  const actual = point(db)
  if (!actual) { discardScanOriginIndex(db); return }
  retainPureIndex(db, index, actual)
  index.point = actual; index.pending = false; indexes.set(db, index)
}
/** 冷核在原恢复事务内完成，只暂存；任何公开读取都不能消费未COMMIT的候选。 */
export function stageScanOriginIndex(db: DatabaseSync, index: ScanOriginIndex): void {
  if (!db.isTransaction) { publishScanOriginIndex(db, index); return }
  const actual = point(db)
  if (!actual || index.overflow) { discardScanOriginIndex(db); return }
  retainPureIndex(db, index, actual)
  index.point = actual; index.pending = true; indexes.set(db, index)
}
function retainPureIndex(db: DatabaseSync, index: ScanOriginIndex, actual: string): void {
  const catalog = currentLocalAuditWritePoint(db, 'catalog'), scan = currentLocalAuditWritePoint(db, 'scan')
  if (!catalog || !scan) { pureIndexes.delete(db); writePoints.delete(index); return }
  const values = JSON.parse(actual) as number[]
  writePoints.set(index, { catalog, scan, version: values[1]!, schema: values[2]! })
  pureIndexes.set(db, index)
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
      // 无活point时只保留两域均未变化的纯候选；不因queue写恢复活索引。
      if (!index) { if (!currentPureIndex(db)) pureIndexes.delete(db); return }
      if (!approved || db.isTransaction || !ownsScanOriginIndex(db, index) || point(db) !== approved) { discardScanOriginIndex(db); return }
      publishScanOriginIndex(db, index)
    },
  }
}
export function scanOriginPositions(index: ScanOriginIndex, root: string, asset: string, track: string, relative: string, signature: string): readonly OriginPosition[] {
  return (index.entries.get(key(root, asset, track, relative, signature)) ?? []).map(ordinal => index.batches.get(ordinal)!)
}
