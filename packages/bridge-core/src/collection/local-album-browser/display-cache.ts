import { noteDesktopArtwork, desktopArtworkStarted, desktopArtworkElapsed } from '../../shared/desktop-artwork-trace-node.js'
import { localAlbumSafeError } from '../../shared/local-album-read-trace-node.js'
import { logLibraryOperation } from '../../shared/library-operation-log.js'
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { constants, closeSync, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, realpathSync, statfsSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import * as dto from '@music-bridge/contracts'

export type LocalAlbumDisplayCacheEvidence = {
  independent: readonly { relative: string; signature: string; size: number; included: boolean }[]
  embedded: { relative: string; signature: string; size: number } | null
  unresolved: boolean
  embeddedConfirmed: boolean
  independentOnly: boolean
  /** 新策略已评估明确子碟父目录；旧证据继续有效，只有旧CD缺图需定向重探。 */
  discoveryPolicy?: 'disc-parent-v1'
}
export interface LocalAlbumDisplayCacheRecord { image: dto.LocalArtworkImage; evidence: LocalAlbumDisplayCacheEvidence; grid?: dto.LocalAlbumArtworkGrid }

const MAX_ENTRIES = 20_000, MAX_BYTES = 16 * 1024 * 1024 * 1024, MAX_FILE_BYTES = 20 * 1024 * 1024 * 1024
const MAX_METADATA_BYTES = 2 * 1024 * 1024, PAGE_BYTES = 4096, APPLICATION_ID = 0x4d424143
const TABLE = 'CREATE TABLE local_album_display_cache(cache_key TEXT PRIMARY KEY,root_id TEXT NOT NULL,metadata TEXT NOT NULL CHECK(length(CAST(metadata AS BLOB)) BETWEEN 1 AND 2097152),jpeg BLOB NOT NULL CHECK(length(jpeg) BETWEEN 1 AND 1048576),payload_bytes INTEGER NOT NULL CHECK(payload_bytes=length(jpeg)),last_used INTEGER NOT NULL CHECK(last_used>=0)) STRICT'
const INDEXES = [
  'CREATE INDEX local_album_display_cache_lru ON local_album_display_cache(last_used,cache_key)',
  'CREATE INDEX local_album_display_cache_root ON local_album_display_cache(root_id,cache_key)',
] as const
function jpegGeometry(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 4 || bytes[0] !== 255 || bytes[1] !== 216 || bytes[bytes.length - 2] !== 255 || bytes[bytes.length - 1] !== 217) return null
  let offset = 2, geometry: { width: number; height: number } | null = null
  // 只核有界JPEG头部与SOF尺寸，不解码像素、不读取来源或调用Native。
  for (let markers = 0; markers < 512 && offset < bytes.length - 2; markers++) {
    if (bytes[offset++] !== 255) return null
    while (offset < bytes.length && bytes[offset] === 255) offset++
    const marker = bytes[offset++]
    if (marker === undefined || marker === 0 || marker === 216 || marker === 217 || marker >= 208 && marker <= 215) return null
    if (marker === 1) continue
    if (offset + 2 > bytes.length - 2) return null
    const length = bytes[offset]! * 256 + bytes[offset + 1]!
    if (length < 2 || offset + length > bytes.length - 2) return null
    if (marker === 218) return length >= 6 ? geometry : null
    if (marker >= 192 && marker <= 207 && ![196, 200, 204].includes(marker)) {
      if (length < 11) return null
      const height = bytes[offset + 3]! * 256 + bytes[offset + 4]!, width = bytes[offset + 5]! * 256 + bytes[offset + 6]!, components = bytes[offset + 7]!
      if (!safeInteger(width, 1, 1200) || !safeInteger(height, 1, 1200) || !safeInteger(components, 1, 4) || length !== 8 + 3 * components
        || geometry && (geometry.width !== width || geometry.height !== height)) return null
      geometry = { width, height }
    }
    offset += length
  }
  return null
}
const COVER_INDEX = 'CREATE INDEX local_album_display_cache_cover ON local_album_display_cache(last_used,cache_key,root_id,payload_bytes)'
const RETIRED_TABLE = 'CREATE TABLE local_album_display_cache_retired_roots(root_id TEXT PRIMARY KEY) STRICT'
const MAX_TRANSACTION_BYTES = 16 * 1024 * 1024, MAX_TRANSACTION_ROWS = 4, ROW_ALLOWANCE = 32 * 1024
const hash = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')
const safeInteger = (value: unknown, min: number, max: number): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max
const validKey = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value)
function closed(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value))
    && Reflect.ownKeys(value).length === keys.length && keys.every(key => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      return descriptor?.enumerable === true && Object.hasOwn(descriptor, 'value')
    })
}
function relative(value: unknown): value is string {
  if (typeof value !== 'string' || !value || Buffer.byteLength(value) > 4096 || /[\\\u0000-\u001f\u007f]/u.test(value)) return false
  const parts = value.split('/')
  return parts.length <= 64 && parts.every(part => part !== '' && part !== '.' && part !== '..')
}
const signature = (value: unknown): value is string => typeof value === 'string' && value.length > 0
  && Buffer.byteLength(value) <= 512 && !/[\u0000-\u001f\u007f]/u.test(value)
function sourceEvidence(value: unknown, independent: boolean): boolean {
  return closed(value, independent ? ['relative', 'signature', 'size', 'included'] : ['relative', 'signature', 'size'])
    && relative(value.relative) && signature(value.signature) && safeInteger(value.size, 1, 68_719_476_736)
    && (!independent || typeof value.included === 'boolean')
}
export function validLocalAlbumDisplayEvidence(value: unknown): value is LocalAlbumDisplayCacheEvidence {
  if (!closed(value, value && typeof value === 'object' && Object.hasOwn(value, 'discoveryPolicy')
    ? ['independent', 'embedded', 'unresolved', 'embeddedConfirmed', 'independentOnly', 'discoveryPolicy']
    : ['independent', 'embedded', 'unresolved', 'embeddedConfirmed', 'independentOnly'])
    || Object.hasOwn(value, 'discoveryPolicy') && value.discoveryPolicy !== 'disc-parent-v1' || value.unresolved !== false
    || typeof value.embeddedConfirmed !== 'boolean' || typeof value.independentOnly !== 'boolean'
    || !(value.embeddedConfirmed || value.independentOnly) || !Array.isArray(value.independent)
    || Object.getPrototypeOf(value.independent) !== Array.prototype || value.independent.length > 32
    || Reflect.ownKeys(value.independent).length !== value.independent.length + 1) return false
  let included = false
  for (let index = 0; index < value.independent.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value.independent, String(index))
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value') || !sourceEvidence(descriptor.value, true)) return false
    included ||= descriptor.value.included === true
  }
  return (!value.independentOnly || included) && (value.embedded === null || sourceEvidence(value.embedded, false))
}
export function encodeLocalAlbumDisplayRecord(value: unknown): { metadata: string; jpeg: Buffer } | null {
  if (!closed(value, value && typeof value === 'object' && Object.hasOwn(value, 'grid') ? ['image', 'evidence', 'grid'] : ['image', 'evidence']) || !validLocalAlbumDisplayEvidence(value.evidence)
    || !closed(value.image, ['original', 'display'])
    || !closed(value.image.original, ['mime', 'bytes', 'sha256', 'width', 'height'])
    || !closed(value.image.display, ['mime', 'bytes', 'sha256', 'width', 'height', 'dataUrl'])
    || !dto.isLocalArtworkImage(value.image)) return null
  const { dataUrl, ...display } = value.image.display, encoded = dataUrl.slice('data:image/jpeg;base64,'.length)
  const jpeg = Buffer.from(encoded, 'base64')
  const geometry = jpegGeometry(jpeg)
  if (jpeg.length !== display.bytes || jpeg.toString('base64') !== encoded || hash(jpeg) !== display.sha256
    || !geometry || geometry.width !== display.width || geometry.height !== display.height) return null
  let grid: Omit<dto.LocalAlbumArtworkGrid, 'dataUrl'> | undefined, gridBytes = Buffer.alloc(0)
  if (Object.hasOwn(value, 'grid')) {
    if (!dto.isLocalAlbumArtworkGrid(value.grid)) return null
    const { dataUrl, ...info } = value.grid
    const encoded = dataUrl.slice('data:image/jpeg;base64,'.length)
    gridBytes = Buffer.from(encoded, 'base64')
    const size = jpegGeometry(gridBytes)
    if (gridBytes.length !== info.bytes || gridBytes.toString('base64') !== encoded || hash(gridBytes) !== info.sha256
      || !size || size.width !== info.width || size.height !== info.height) return null
    grid = info
  }
  const payload = grid ? Buffer.concat([jpeg, gridBytes]) : jpeg
  if (payload.length > dto.LOCAL_ARTWORK_DISPLAY_BYTES) return null
  const metadata = JSON.stringify({ original: value.image.original, display, evidence: value.evidence, ...(grid ? { grid } : {}) })
  return Buffer.byteLength(metadata) <= MAX_METADATA_BYTES ? { metadata, jpeg: payload } : null
}
export function decodeLocalAlbumDisplayRecord(metadata: unknown, bytes: unknown): LocalAlbumDisplayCacheRecord | null {
  if (typeof metadata !== 'string' || Buffer.byteLength(metadata) > MAX_METADATA_BYTES || !(bytes instanceof Uint8Array)
    || !safeInteger(bytes.byteLength, 1, dto.LOCAL_ARTWORK_DISPLAY_BYTES)) return null
  const value: unknown = JSON.parse(metadata)
  if (!closed(value, value && typeof value === 'object' && Object.hasOwn(value, 'grid') ? ['original', 'display', 'evidence', 'grid'] : ['original', 'display', 'evidence'])
    || !closed(value.display, ['mime', 'bytes', 'sha256', 'width', 'height']) || !safeInteger(value.display.bytes, 1, dto.LOCAL_ARTWORK_DISPLAY_BYTES)) return null
  const displayBytes = bytes.subarray(0, value.display.bytes)
  const record = { image: { original: value.original, display: { ...value.display, dataUrl: `data:image/jpeg;base64,${Buffer.from(displayBytes).toString('base64')}` } }, evidence: value.evidence,
    ...(Object.hasOwn(value, 'grid') ? { grid: typeof value.grid === 'object' && value.grid !== null ? { ...value.grid, dataUrl: `data:image/jpeg;base64,${Buffer.from(bytes.subarray(value.display.bytes)).toString('base64')}` } : null } : {}) }
  const encoded = encodeLocalAlbumDisplayRecord(record)
  if (!encoded || encoded.metadata !== metadata || !encoded.jpeg.equals(Buffer.from(bytes))) return null
  return record as LocalAlbumDisplayCacheRecord
}

/** 仅保存派生显示副本；16GiB payload/20GiB文件是lazy上限，不预分配，也不接触主库或选图。 */
export function createLocalAlbumDisplayCache(options: { filePath: string; maxEntries?: number; maxBytes?: number }) {
  const maxEntries = options.maxEntries ?? MAX_ENTRIES, maxBytes = options.maxBytes ?? MAX_BYTES
  const fileCap = Math.min(MAX_FILE_BYTES, Math.max(8 * 1024 * 1024, Math.ceil(maxBytes * 5 / 4)))
  // 大记录事务最多16MiB并最多4条淘汰；留32MiB给journal和有界索引，小配额最多半文件是DB。
  const journalReserve = Math.min(32 * 1024 * 1024, Math.floor(fileCap / 2)), maxPages = Math.floor((fileCap - journalReserve) / PAGE_BYTES)
  type Entry = { rootId: string; payloadBytes: number; used: number }
  const entries = new Map<string, Entry>(), rootEntries = new Map<string, Set<string>>()
  const retiredRoots = new Set<string>(), cleanupRoots = new Set<string>(), badKeys = new Set<string>()
  // 迁移索引只读来源元数据，不在启动或命中时扫描JPEG；每个根按需建立一次。
  const migrationIndex = new Map<string, Map<string, string[]>>()
  let database: DatabaseSync | undefined, cleanup: ReturnType<typeof setImmediate> | undefined
  let stopped = false, failed = !safeInteger(maxEntries, 1, MAX_ENTRIES) || !safeInteger(maxBytes, 1, MAX_BYTES)
  let count = 0, bytes = 0, clock = 0, dataVersion = 0
  let physical: { dev: number; ino: number } | undefined
  const memory = options.filePath === ':memory:'
  const rowCost = (payload: number): number => MAX_METADATA_BYTES + payload + ROW_ALLOWANCE
  function cancelCleanup(): void { if (cleanup) { clearImmediate(cleanup); cleanup = undefined } }
  function disable(connection = database): void {
    failed = true; database = undefined; cancelCleanup(); entries.clear(); rootEntries.clear(); cleanupRoots.clear(); badKeys.clear()
    try { connection?.close() } catch { /* 派生缓存关闭失败不遮蔽原业务；本实例不再重开。 */ }
  }
  function diskBudget(): void {
    if (memory) return
    const directory = path.dirname(options.filePath)
    if (!lstatSync(directory).isDirectory() || realpathSync(directory) !== directory) throw new Error('显示缓存目录不可用。')
    let total = 0
    for (const suffix of ['', '-journal', '-wal', '-shm']) {
      try {
        const info = lstatSync(options.filePath + suffix)
        if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || (info.mode & 0o200) === 0) throw new Error('显示缓存文件不可用。')
        if ((info.mode & 0o077) !== 0 || suffix === '' && info.size > maxPages * PAGE_BYTES) throw new Error('显示缓存文件预算或权限无效。')
        if (suffix === '' && physical && (physical.dev !== info.dev || physical.ino !== info.ino)) throw new Error('显示缓存文件已改变。')
        total += info.size
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || suffix === '') throw error }
    }
    if (total > fileCap) throw new Error('显示缓存文件超过上限。')
  }
  function inspectConnection(db: DatabaseSync): void {
    diskBudget()
    if (Number(db.prepare('PRAGMA data_version').get()?.data_version) !== dataVersion) throw new Error('显示缓存连接已改变。')
    const pages = Number(db.prepare('PRAGMA page_count').get()?.page_count), free = Number(db.prepare('PRAGMA freelist_count').get()?.freelist_count)
    // freelist仍占真实文件，不能从物理上限扣除。
    if (!safeInteger(pages, 0, maxPages) || !safeInteger(free, 0, pages)) throw new Error('显示缓存页数超过上限。')
  }
  function writeSpace(recordBytes: number): boolean {
    if (memory) return true
    const available = statfsSync(path.dirname(options.filePath), { bigint: true })
    return available.bavail * available.bsize >= BigInt(256 * 1024 * 1024 + recordBytes * 4)
  }
  function transaction<T>(db: DatabaseSync, action: () => T): T {
    db.exec('BEGIN IMMEDIATE')
    try { const result = action(); db.exec('COMMIT'); return result }
    catch (error) { try { db.exec('ROLLBACK') } catch { /* 缓存实例随后停用；保留首个缓存失败。 */ }; throw error }
  }
  function index(key: string, entry: Entry): void {
    entries.set(key, entry)
    let keys = rootEntries.get(entry.rootId)
    if (!keys) { keys = new Set(); rootEntries.set(entry.rootId, keys) }
    keys.add(key)
  }
  function unindex(key: string): void {
    const entry = entries.get(key); if (!entry) return
    entries.delete(key); badKeys.delete(key)
    const keys = rootEntries.get(entry.rootId); keys?.delete(key)
    if (keys?.size === 0) rootEntries.delete(entry.rootId)
  }
  function erase(db: DatabaseSync, key: string): void {
    if (Number(db.prepare('DELETE FROM local_album_display_cache WHERE cache_key=?').run(key).changes) !== 1) throw new Error('显示缓存记录已改变。')
  }
  function queueCleanup(rootId: string): void { if (rootEntries.get(rootId)?.size) cleanupRoots.add(rootId) }
  function scheduleCleanup(): void {
    if (cleanup || stopped || failed || !database || !cleanupRoots.size) return
    cleanup = setImmediate(() => {
      cleanup = undefined
      if (stopped || failed || !database) return
      const db = database, rootId = cleanupRoots.values().next().value as string | undefined
      if (!rootId) return
      try {
        inspectConnection(db)
        const batch: Array<[string, Entry]> = []; let weight = 0
        for (const key of rootEntries.get(rootId) ?? []) {
          const entry = entries.get(key); if (!entry) continue
          if (batch.length >= MAX_TRANSACTION_ROWS || weight + rowCost(entry.payloadBytes) > MAX_TRANSACTION_BYTES) break
          batch.push([key, entry]); weight += rowCost(entry.payloadBytes)
        }
        if (batch.length) {
          transaction(db, () => { for (const [key] of batch) erase(db, key) })
          // SQLite COMMIT成功后才改内存账本；失败回滚不能让count/bytes假减。
          for (const [key, entry] of batch) { unindex(key); count--; bytes -= entry.payloadBytes }
          inspectConnection(db)
        }
        if (!rootEntries.get(rootId)?.size) cleanupRoots.delete(rootId)
        scheduleCleanup()
      } catch (error) { noteDesktopArtwork('disk-disable', null, { reason: 'cleanup', code: localAlbumSafeError(error).code }); disable() }
    })
    // 清派生数据不能单独维持进程；close会取消未开始的下一批。
    cleanup.unref()
  }
  function open(): DatabaseSync | undefined {
    if (stopped || failed) return undefined
    if (database) { inspectConnection(database); return database }
    if (!memory) {
      if (!path.isAbsolute(options.filePath) || path.resolve(options.filePath) !== options.filePath) throw new Error('显示缓存位置无效。')
      const directory = path.dirname(options.filePath)
      mkdirSync(directory, { recursive: true, mode: 0o700 })
      if (!lstatSync(directory).isDirectory() || realpathSync(directory) !== directory) throw new Error('显示缓存目录不可用。')
      for (const suffix of ['', '-journal', '-wal', '-shm']) {
        try { const info = lstatSync(options.filePath + suffix); if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || (info.mode & 0o200) === 0) throw new Error('显示缓存文件不可用。') }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      }
      const fd = openSync(options.filePath, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600)
      try {
        const info = fstatSync(fd)
        if (!info.isFile() || info.nlink !== 1 || (info.mode & 0o200) === 0) throw new Error('显示缓存文件不可用。')
        fchmodSync(fd, 0o600); physical = { dev: info.dev, ino: info.ino }
      } finally { closeSync(fd) }
      diskBudget()
    }
    const db = new DatabaseSync(options.filePath, { allowExtension: false, enableForeignKeyConstraints: true })
    try {
      db.exec('PRAGMA busy_timeout=0; PRAGMA trusted_schema=OFF; PRAGMA temp_store=MEMORY')
      const applicationId = Number(db.prepare('PRAGMA application_id').get()?.application_id), version = Number(db.prepare('PRAGMA user_version').get()?.user_version)
      const objects = db.prepare("SELECT type,name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'").all()
      const fresh = applicationId === 0 && version === 0 && objects.length === 0
      const base = applicationId === APPLICATION_ID && objects.some(row => row.type === 'table' && row.name === 'local_album_display_cache' && row.sql === TABLE)
        && INDEXES.every(sql => objects.some(row => row.type === 'index' && row.sql === sql))
      const previous = base && version === 1 && objects.length === 3
      const current = base && version === 2 && objects.length === 5 && objects.some(row => row.type === 'index' && row.sql === COVER_INDEX)
        && objects.some(row => row.type === 'table' && row.name === 'local_album_display_cache_retired_roots' && row.sql === RETIRED_TABLE)
      if (!fresh && !previous && !current) throw new Error('显示缓存结构无效。')
      db.exec('PRAGMA page_size=4096; PRAGMA journal_mode=DELETE; PRAGMA synchronous=NORMAL')
      if (Number(db.prepare('PRAGMA page_size').get()?.page_size) !== PAGE_BYTES
        || Number(db.prepare(`PRAGMA max_page_count=${maxPages}`).get()?.max_page_count) > maxPages) throw new Error('显示缓存页数不可用。')
      if (fresh || previous) transaction(db, () => {
        if (fresh) db.exec(`${TABLE};${INDEXES.join(';')}`)
        db.exec(`${COVER_INDEX};${RETIRED_TABLE};PRAGMA application_id=${APPLICATION_ID};PRAGMA user_version=2`)
      })
      // covering index仅载入最多20000条身份/字节/LRU元数据，不在启动时读取或hash全部JPEG。
      const rows = db.prepare('SELECT cache_key,root_id,payload_bytes,last_used FROM local_album_display_cache INDEXED BY local_album_display_cache_cover ORDER BY last_used,cache_key LIMIT ?').all(maxEntries + 1)
      if (rows.length > maxEntries) throw new Error('显示缓存条数超过上限。')
      for (const row of rows) {
        if (!validKey(row.cache_key) || !dto.isCollectionId(row.root_id) || !safeInteger(row.payload_bytes, 1, dto.LOCAL_ARTWORK_DISPLAY_BYTES)
          || !safeInteger(row.last_used, 0, Number.MAX_SAFE_INTEGER - 1)) throw new Error('显示缓存预算无效。')
        index(row.cache_key, { rootId: row.root_id, payloadBytes: row.payload_bytes, used: row.last_used })
        count++; bytes += row.payload_bytes; clock = Math.max(clock, row.last_used)
      }
      if (bytes > maxBytes) throw new Error('显示缓存字节超过上限。')
      const retired = db.prepare('SELECT root_id FROM local_album_display_cache_retired_roots LIMIT ?').all(MAX_ENTRIES + 1)
      if (retired.length > MAX_ENTRIES) throw new Error('显示缓存撤根记录超过上限。')
      for (const row of retired) { if (!dto.isCollectionId(row.root_id)) throw new Error('显示缓存撤根记录无效。'); retiredRoots.add(row.root_id) }
      for (const rootId of retiredRoots) queueCleanup(rootId)
      dataVersion = Number(db.prepare('PRAGMA data_version').get()?.data_version)
      database = db; inspectConnection(db); scheduleCleanup(); return db
    } catch (error) { noteDesktopArtwork('disk-disable', null, { reason: 'open', code: localAlbumSafeError(error).code }); disable(db); throw error }
  }
  return {
    get(key: string, rootId: string): LocalAlbumDisplayCacheRecord | null {
      if (!validKey(key) || !dto.isCollectionId(rootId) || retiredRoots.has(rootId) || badKeys.has(key) || stopped || failed) { noteDesktopArtwork('disk-skip', validKey(key) ? key : null, { reason: failed ? 'disabled' : stopped ? 'closed' : retiredRoots.has(rootId) ? 'retired' : badKeys.has(key) ? 'row-invalid' : 'invalid' }); return null }
      try {
        const db = open(); if (!db || retiredRoots.has(rootId)) return null
        const entry = entries.get(key); if (!entry || entry.rootId !== rootId) return null
        const row = db.prepare('SELECT CASE WHEN length(jpeg) BETWEEN 1 AND 1048576 THEN jpeg END jpeg,CASE WHEN length(CAST(metadata AS BLOB)) BETWEEN 1 AND 2097152 THEN metadata END metadata,payload_bytes FROM local_album_display_cache WHERE cache_key=? AND root_id=?').get(key, rootId)
        let record: LocalAlbumDisplayCacheRecord | null = null
        try { if (row) record = decodeLocalAlbumDisplayRecord(row.metadata, row.jpeg) } catch { /* 仅隔离本条坏JSON/内容，其他合法entry仍可命中。 */ }
        if (!record || row?.payload_bytes !== entry.payloadBytes || entry.payloadBytes !== record.image.display.bytes + (record.grid?.bytes ?? 0)) {
          if (badKeys.size < maxEntries) badKeys.add(key)
          return null
        }
        if (clock >= Number.MAX_SAFE_INTEGER - 1) throw new Error('显示缓存序号已满。')
        // get只触内存LRU；重启时以最近成功put恢复近似次序，不为命中逐条落盘。
        entries.delete(key); entries.set(key, { ...entry, used: ++clock }); return record
      } catch (error) { noteDesktopArtwork('disk-disable', key, { reason: 'get', code: localAlbumSafeError(error).code }); disable(); return null }
    },
    findTrusted(rootId: string, source: { relative: string; signature: string; directory: string }): LocalAlbumDisplayCacheRecord | null {
      if (!dto.isCollectionId(rootId) || !relative(source.relative) || !signature(source.signature) || retiredRoots.has(rootId) || stopped || failed) return null
      try {
        const db = open(); if (retiredRoots.has(rootId) || !db) return null
        let bySource = migrationIndex.get(rootId)
        if (!bySource) {
          bySource = new Map(); let metadataBytes = 0
          for (const row of db.prepare('SELECT cache_key,metadata FROM local_album_display_cache WHERE root_id=? ORDER BY last_used DESC,cache_key LIMIT ?').iterate(rootId, maxEntries)) {
            if (!validKey(row.cache_key) || typeof row.metadata !== 'string') continue
            metadataBytes += Buffer.byteLength(row.metadata)
            // 索引建立也有预算；未索引条目仍保留原库，下次可以走正常有界源读取。
            if (metadataBytes > 64 * 1024 * 1024) break
            try {
              const value = JSON.parse(row.metadata) as { evidence?: unknown }
              if (!validLocalAlbumDisplayEvidence(value.evidence) || !value.evidence.embedded) continue
              const embedded = value.evidence.embedded, identity = JSON.stringify([embedded.relative, embedded.signature])
              const keys = bySource.get(identity) ?? []
              if (keys.length < 32) keys.push(row.cache_key)
              bySource.set(identity, keys)
            } catch { /* 损坏旧条目不影响其它可验证资源；原件继续保留。 */ }
          }
          migrationIndex.set(rootId, bySource)
        }
        const directory = path.posix.normalize(source.directory || '.')
        for (const candidate of bySource.get(JSON.stringify([source.relative, source.signature])) ?? []) {
          const record = this.get(candidate, rootId)
          if (record && record.evidence.independent.every(item => path.posix.dirname(item.relative) === directory)) return record
        }
        return null
      } catch (error) { noteDesktopArtwork('disk-disable', null, { reason: 'get', code: localAlbumSafeError(error).code }); disable(); return null }
    },
    put(key: string, rootId: string, record: LocalAlbumDisplayCacheRecord): void {
      if (!validKey(key) || !dto.isCollectionId(rootId) || retiredRoots.has(rootId) || stopped || failed) { noteDesktopArtwork('disk-skip', validKey(key) ? key : null, { reason: failed ? 'disabled' : stopped ? 'closed' : retiredRoots.has(rootId) ? 'retired' : 'invalid' }); return }
      const putStarted = performance.now()
      try {
        const encoded = encodeLocalAlbumDisplayRecord(record); if (!encoded || encoded.jpeg.length > maxBytes) { noteDesktopArtwork('disk-skip', key, { reason: 'invalid' }); return }
        const db = open(); if (!db || retiredRoots.has(rootId)) { noteDesktopArtwork('disk-skip', key, { reason: 'retired' }); return }
        const prior = entries.get(key), previousBytes = prior?.payloadBytes ?? 0
        let plannedCount = count + (prior ? 0 : 1), plannedBytes = bytes - previousBytes + encoded.jpeg.length
        let weight = Buffer.byteLength(encoded.metadata) + encoded.jpeg.length + ROW_ALLOWANCE + (prior ? rowCost(prior.payloadBytes) : 0)
        const victims: Array<[string, Entry]> = []
        for (const [candidate, entry] of entries) {
          if (plannedCount <= maxEntries && plannedBytes <= maxBytes) break
          if (candidate === key) continue
          if (victims.length >= MAX_TRANSACTION_ROWS || weight + rowCost(entry.payloadBytes) > MAX_TRANSACTION_BYTES) { noteDesktopArtwork('disk-skip', key, { reason: 'capacity' }); return }
          victims.push([candidate, entry]); weight += rowCost(entry.payloadBytes); plannedCount--; plannedBytes -= entry.payloadBytes
        }
        if (plannedCount > maxEntries || plannedBytes > maxBytes || weight > MAX_TRANSACTION_BYTES) { noteDesktopArtwork('disk-skip', key, { reason: 'capacity' }); return }
        if (!writeSpace(weight)) { noteDesktopArtwork('disk-skip', key, { reason: 'space' }); return }
        if (clock >= Number.MAX_SAFE_INTEGER - 1) throw new Error('显示缓存序号已满。')
        const used = clock + 1
        transaction(db, () => {
          for (const [candidate] of victims) erase(db, candidate)
          db.prepare('INSERT INTO local_album_display_cache VALUES(?,?,?,?,?,?) ON CONFLICT(cache_key) DO UPDATE SET root_id=excluded.root_id,metadata=excluded.metadata,jpeg=excluded.jpeg,payload_bytes=excluded.payload_bytes,last_used=excluded.last_used').run(key, rootId, encoded.metadata, encoded.jpeg, encoded.jpeg.length, used)
        })
        // 原COMMIT确认前不修改count/bytes/LRU；失败时整个淘汰与插入回滚。
        for (const [candidate] of victims) unindex(candidate)
        unindex(key); index(key, { rootId, payloadBytes: encoded.jpeg.length, used }); badKeys.delete(key)
        count = plannedCount; bytes = plannedBytes; clock = used; inspectConnection(db)
        migrationIndex.delete(rootId)
        noteDesktopArtwork('disk-put', key, { elapsedMs: desktopArtworkElapsed(putStarted), bytes: encoded.jpeg.length })
        logLibraryOperation('cache', 'artwork.persist', 'complete', { id: key, elapsedMs: performance.now() - putStarted, bytes: encoded.jpeg.length, count: plannedCount, slowAfterMs: 50 })
      } catch (error) { logLibraryOperation('cache', 'artwork.persist', 'error', { id: key, elapsedMs: performance.now() - putStarted, code: 'CACHE_WRITE_FAILED', slowAfterMs: 50 }); noteDesktopArtwork('disk-disable', key, { reason: 'put', code: localAlbumSafeError(error).code }); disable() }
    },
    removeRoot(rootId: string): void {
      if (!dto.isCollectionId(rootId) || stopped || failed) return
      if (retiredRoots.size >= MAX_ENTRIES && !retiredRoots.has(rootId)) { noteDesktopArtwork('disk-disable', null, { reason: 'capacity' }); disable(); return }
      // 立即拒get/迟到put；持久墓碑成功后即可返回，不等整根物理清理。
      retiredRoots.add(rootId)
      migrationIndex.delete(rootId)
      try {
        const db = open(); if (!db) return
        if (retiredRoots.size > MAX_ENTRIES) throw new Error('显示缓存撤根记录超过上限。')
        transaction(db, () => { db.prepare('INSERT OR IGNORE INTO local_album_display_cache_retired_roots VALUES(?)').run(rootId) })
        queueCleanup(rootId); scheduleCleanup(); inspectConnection(db)
      } catch (error) { noteDesktopArtwork('disk-disable', null, { reason: 'remove', code: localAlbumSafeError(error).code }); disable() }
    },
    close(): void {
      if (stopped) return
      stopped = true; cancelCleanup(); entries.clear(); rootEntries.clear(); cleanupRoots.clear(); badKeys.clear(); migrationIndex.clear()
      const db = database; database = undefined
      // DB操作同步完成后才能到这里；取消尚未开始的setImmediate，不留下一轮写入。
      try { db?.close() } catch { failed = true }
    },
  }
}
