import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { constants, closeSync, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, realpathSync, statfsSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync, type StatementSync } from 'node:sqlite'
import { isCollectionId } from '@music-bridge/contracts'
import { logLibraryOperation } from '../../shared/library-operation-log.js'
import { classifyDirectoryName } from '../../library/local-name-rules.js'
import { isLocalAlbumPrivateRelative } from './grouping.js'
import { decodeLocalAlbumDisplayRecord, encodeLocalAlbumDisplayRecord, validLocalAlbumDisplayEvidence, type LocalAlbumDisplayCacheEvidence, type LocalAlbumDisplayCacheRecord } from './display-cache.js'

/** 授权身份独立于图片内容；全库扫描水位和在线状态不参与稳定专辑绑定。 */
export interface LocalAlbumArtworkResourceBinding {
  datasetId: string; rootId: string; albumKey: string; authority: string; membership: string
  editionId: string | null; representativeTrackId: string | null
}
export interface LocalAlbumSavedArtwork {
  record: LocalAlbumDisplayCacheRecord | null; evidence: LocalAlbumDisplayCacheEvidence
  state: 'available' | 'missing'; revision: string
}
export class LocalAlbumArtworkResourceError extends Error {
  constructor(readonly code: 'ARTWORK_STORE_UNAVAILABLE' | 'ARTWORK_STORE_FULL' | 'ARTWORK_RECORD_INVALID' | 'ARTWORK_ROOT_RETIRED' | 'ARTWORK_INVENTORY_CHANGED') {
    super('本地封面资源未能可靠保存，请稍后重试。')
  }
}
const MAX_ROWS = 100_000, MAX_PAYLOAD_BYTES = 16 * 1024 ** 3, MAX_FILE_BYTES = 20 * 1024 ** 3
const PAGE_BYTES = 4096, MAX_PAGES = (MAX_FILE_BYTES - 32 * 1024 ** 2) / PAGE_BYTES, APPLICATION_ID = 0x4d424152
const MAX_METADATA = 2 * 1024 ** 2
const TABLES = [
  'CREATE TABLE local_album_artwork_resources(content_hash TEXT PRIMARY KEY CHECK(length(content_hash)=64),metadata TEXT NOT NULL CHECK(length(CAST(metadata AS BLOB)) BETWEEN 1 AND 2097152),jpeg BLOB NOT NULL CHECK(length(jpeg) BETWEEN 1 AND 1048576),payload_bytes INTEGER NOT NULL CHECK(payload_bytes=length(jpeg))) STRICT',
  'CREATE TABLE local_album_artwork_bindings(dataset_id TEXT NOT NULL,root_id TEXT NOT NULL,album_key TEXT NOT NULL CHECK(length(CAST(album_key AS BLOB)) BETWEEN 1 AND 256),authority TEXT NOT NULL CHECK(length(authority)=64),membership TEXT NOT NULL CHECK(length(membership)=64),edition_id TEXT,representative_track_id TEXT,content_hash TEXT REFERENCES local_album_artwork_resources(content_hash),evidence TEXT NOT NULL CHECK(length(CAST(evidence AS BLOB)) BETWEEN 1 AND 2097152),revision INTEGER NOT NULL CHECK(revision>0),PRIMARY KEY(dataset_id,root_id,album_key)) STRICT, WITHOUT ROWID',
  'CREATE TABLE local_album_artwork_resource_retired_roots(root_id TEXT PRIMARY KEY) STRICT, WITHOUT ROWID',
  'CREATE TABLE local_album_artwork_resource_revision(id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL CHECK(revision>=0)) STRICT',
  'CREATE INDEX local_album_artwork_binding_root ON local_album_artwork_bindings(root_id,dataset_id,album_key)',
  'CREATE INDEX local_album_artwork_binding_content ON local_album_artwork_bindings(content_hash)',
] as const
const sha = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value)
const album = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:@-]{0,255}$/u.test(value)
const integer = (value: unknown, max = Number.MAX_SAFE_INTEGER): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= max
const digest = (metadata: string, jpeg: Uint8Array): string => createHash('sha256').update(metadata).update('\0').update(jpeg).digest('hex')
function validBinding(value: LocalAlbumArtworkResourceBinding): boolean {
  return isCollectionId(value.datasetId) && isCollectionId(value.rootId) && album(value.albumKey) && sha(value.authority) && sha(value.membership)
    && (value.editionId === null || isCollectionId(value.editionId)) && (value.representativeTrackId === null || isCollectionId(value.representativeTrackId))
}
type InventoryEntry = { binding: LocalAlbumArtworkResourceBinding; state: 'available' | 'missing'; revision: string; legacyDiscAudioRelative?: string }
const INVENTORY_SQL = `SELECT b.authority,b.membership,b.edition_id,b.representative_track_id,b.content_hash,b.revision,
  r.content_hash present_content,
  CASE WHEN b.content_hash IS NULL THEN CASE
    WHEN NOT json_valid(b.evidence) THEN -1
    WHEN json_type(b.evidence,'$.discoveryPolicy') IS NULL THEN 0
    WHEN json_type(b.evidence,'$.discoveryPolicy')='text' AND json_extract(b.evidence,'$.discoveryPolicy')='disc-parent-v1' THEN 1
    ELSE -1 END END missing_policy,
  CASE WHEN b.content_hash IS NULL AND json_valid(b.evidence) THEN json_extract(b.evidence,'$.embedded.relative') END missing_audio
  FROM local_album_artwork_bindings b
  LEFT JOIN local_album_artwork_resources r ON r.content_hash=b.content_hash WHERE b.dataset_id=? AND b.root_id=? AND b.album_key=?`

/** 独立本地资源库：图片按内容去重，来源证据随专辑绑定，提交失败必须抛出而不能冒充成功。 */
export function createLocalAlbumArtworkResourceStore(options: { filePath: string; maxEntries?: number; maxBytes?: number }) {
  const maxEntries = options.maxEntries ?? MAX_ROWS, maxBytes = options.maxBytes ?? MAX_PAYLOAD_BYTES, memory = options.filePath === ':memory:'
  let database: DatabaseSync | undefined, stopped = false, failed = false, dataVersion = 0
  let fileIdentity: { dev: number; ino: number } | undefined, directoryIdentity: { dev: number; ino: number } | undefined
  const retired = new Set<string>()
  let retiredEpoch = 0
  type InventoryRead = { db: DatabaseSync | undefined; lookup?: StatementSync; revision?: StatementSync; initialFailure?: LocalAlbumArtworkResourceError; initialRevision: string | null; retiredEpoch: number; invalid: boolean; entries: Map<string, InventoryEntry | null> }
  let inventoryRead: InventoryRead | undefined
  const unavailable = (): never => { throw new LocalAlbumArtworkResourceError('ARTWORK_STORE_UNAVAILABLE') }
  const inventoryChanged = (): never => { if (inventoryRead) inventoryRead.invalid = true; throw new LocalAlbumArtworkResourceError('ARTWORK_INVENTORY_CHANGED') }
  function checkInventory(): void {
    if (inventoryRead && (inventoryRead.invalid || stopped || retiredEpoch !== inventoryRead.retiredEpoch
      || inventoryRead.db && (failed || database !== inventoryRead.db))) inventoryChanged()
  }
  function readRevision(db: DatabaseSync, statement?: StatementSync): string {
    const revision = Number((statement ?? db.prepare('SELECT revision FROM local_album_artwork_resource_revision WHERE id=1')).get()?.revision)
    if (!integer(revision)) return unavailable()
    return String(revision)
  }
  /** 只允许同步元数据读取；起始不可用沿原调用方降级，期间变化则在外层整件拒绝。 */
  function withInventoryRead<T>(read: () => T): T {
    if (inventoryRead) return inventoryChanged()
    const current: InventoryRead = { db: undefined, initialRevision: null, retiredEpoch, invalid: false, entries: new Map() }
    try {
      const db = open(), revision = db.prepare('SELECT revision FROM local_album_artwork_resource_revision WHERE id=1')
      current.initialRevision = readRevision(db, revision); current.db = db; current.revision = revision; current.lookup = db.prepare(INVENTORY_SQL)
    } catch (error) {
      if (!(error instanceof LocalAlbumArtworkResourceError) || error.code !== 'ARTWORK_STORE_UNAVAILABLE') throw error
      current.initialFailure = error
    }
    current.retiredEpoch = retiredEpoch
    inventoryRead = current
    try {
      const result = read()
      if (result !== null && (typeof result === 'object' || typeof result === 'function') && typeof (result as { then?: unknown }).then === 'function') return inventoryChanged()
      checkInventory()
      if (current.db) {
        // 不经lookup memo：真正读取水位，再检查路径、inode、权限、links、预算和外部SQLite作者。
        try { const revision = readRevision(current.db, current.revision); inspect(current.db); if (revision !== current.initialRevision) return inventoryChanged() }
        catch { return inventoryChanged() }
      }
      checkInventory()
      return result
    } finally { current.entries.clear(); inventoryRead = undefined }
  }
  function diskBudget(): void {
    if (memory) return
    const directory = path.dirname(options.filePath), info = lstatSync(directory)
    if (!info.isDirectory() || info.isSymbolicLink() || realpathSync(directory) !== directory
      || directoryIdentity && (directoryIdentity.dev !== info.dev || directoryIdentity.ino !== info.ino)) unavailable()
    let total = 0
    for (const suffix of ['', '-journal', '-wal', '-shm']) {
      try {
        const file = lstatSync(options.filePath + suffix)
        if (!file.isFile() || file.isSymbolicLink() || file.nlink !== 1 || (file.mode & 0o200) === 0 || (file.mode & 0o077) !== 0
          || suffix === '' && (file.size > MAX_PAGES * PAGE_BYTES || fileIdentity && (file.dev !== fileIdentity.dev || file.ino !== fileIdentity.ino))) unavailable()
        total += file.size
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || suffix === '') throw error }
    }
    if (total > MAX_FILE_BYTES) unavailable()
  }
  function inspect(db: DatabaseSync): void {
    diskBudget()
    const pages = Number(db.prepare('PRAGMA page_count').get()?.page_count)
    if (!integer(pages, MAX_PAGES) || Number(db.prepare('PRAGMA data_version').get()?.data_version) !== dataVersion) unavailable()
  }
  function disable(db = database): void {
    failed = true; database = undefined
    try { db?.close() } catch { /* 保留原文件和首个安全错误；实例不再重开。 */ }
  }
  function transaction<T>(db: DatabaseSync, action: () => T): T {
    db.exec('BEGIN IMMEDIATE')
    try { const result = action(); db.exec('COMMIT'); return result }
    catch (error) { try { db.exec('ROLLBACK') } catch { disable(db) }; throw error }
  }
  function open(): DatabaseSync {
    if (stopped || failed || !integer(maxEntries, MAX_ROWS) || maxEntries === 0 || !integer(maxBytes, MAX_PAYLOAD_BYTES) || maxBytes === 0) return unavailable()
    if (database) { inspect(database); return database }
    let db: DatabaseSync | undefined
    try {
      if (!memory) {
        if (!path.isAbsolute(options.filePath) || path.resolve(options.filePath) !== options.filePath) unavailable()
        const directory = path.dirname(options.filePath)
        mkdirSync(directory, { recursive: true, mode: 0o700 })
        const parent = lstatSync(directory)
        if (!parent.isDirectory() || parent.isSymbolicLink() || realpathSync(directory) !== directory) unavailable()
        directoryIdentity = { dev: parent.dev, ino: parent.ino }
        for (const suffix of ['', '-journal', '-wal', '-shm']) {
          try { const file = lstatSync(options.filePath + suffix); if (!file.isFile() || file.isSymbolicLink() || file.nlink !== 1 || (file.mode & 0o200) === 0) unavailable() }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
        }
        const fd = openSync(options.filePath, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600)
        try {
          const file = fstatSync(fd)
          if (!file.isFile() || file.nlink !== 1 || (file.mode & 0o200) === 0) unavailable()
          fchmodSync(fd, 0o600); fileIdentity = { dev: file.dev, ino: file.ino }
        } finally { closeSync(fd) }
        diskBudget()
      }
      db = new DatabaseSync(options.filePath, { allowExtension: false, enableForeignKeyConstraints: true })
      db.exec('PRAGMA busy_timeout=0; PRAGMA trusted_schema=OFF; PRAGMA temp_store=MEMORY')
      const application = Number(db.prepare('PRAGMA application_id').get()?.application_id), version = Number(db.prepare('PRAGMA user_version').get()?.user_version)
      const schema = db.prepare("SELECT sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'").all()
      const fresh = application === 0 && version === 0 && schema.length === 0
      if (!fresh && (application !== APPLICATION_ID || version !== 1 || schema.length !== TABLES.length || !TABLES.every(sql => schema.some(row => row.sql === sql)))) unavailable()
      // FULL保证返回成功前资源事务已可靠提交；旧显示LRU副库原封保留。
      db.exec('PRAGMA page_size=4096; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL')
      if (Number(db.prepare('PRAGMA page_size').get()?.page_size) !== PAGE_BYTES
        || Number(db.prepare(`PRAGMA max_page_count=${MAX_PAGES}`).get()?.max_page_count) > MAX_PAGES) unavailable()
      if (fresh) transaction(db, () => { db!.exec(`${TABLES.join(';')};INSERT INTO local_album_artwork_resource_revision VALUES(1,0);PRAGMA application_id=${APPLICATION_ID};PRAGMA user_version=1`) })
      const totals = db.prepare('SELECT count(*) n,coalesce(sum(payload_bytes),0) bytes FROM local_album_artwork_resources').get()!
      const bindings = db.prepare('SELECT count(*) n FROM local_album_artwork_bindings').get()!
      if (!integer(totals.n, maxEntries) || !integer(totals.bytes, maxBytes) || !integer(bindings.n, maxEntries)) unavailable()
      const roots = db.prepare('SELECT root_id FROM local_album_artwork_resource_retired_roots LIMIT ?').all(MAX_ROWS + 1)
      if (roots.length > MAX_ROWS) unavailable()
      for (const row of roots) { if (!isCollectionId(row.root_id)) unavailable(); retired.add(row.root_id as string) }
      dataVersion = Number(db.prepare('PRAGMA data_version').get()?.data_version)
      database = db; inspect(db); return db
    } catch { disable(db); return unavailable() }
  }
  function accepted(binding: LocalAlbumArtworkResourceBinding): DatabaseSync {
    if (!validBinding(binding)) throw new LocalAlbumArtworkResourceError('ARTWORK_RECORD_INVALID')
    if (retired.has(binding.rootId)) throw new LocalAlbumArtworkResourceError('ARTWORK_ROOT_RETIRED')
    const db = open()
    if (retired.has(binding.rootId)) throw new LocalAlbumArtworkResourceError('ARTWORK_ROOT_RETIRED')
    return db
  }
  function find(binding: LocalAlbumArtworkResourceBinding) {
    const db = accepted(binding)
    return { db, row: db.prepare('SELECT content_hash,evidence,revision FROM local_album_artwork_bindings WHERE dataset_id=? AND root_id=? AND album_key=? AND authority=? AND membership=? AND edition_id IS ? AND representative_track_id IS ?').get(binding.datasetId, binding.rootId, binding.albumKey, binding.authority, binding.membership, binding.editionId, binding.representativeTrackId) }
  }
  function readEvidence(value: unknown): LocalAlbumDisplayCacheEvidence {
    if (typeof value !== 'string' || Buffer.byteLength(value) > MAX_METADATA) throw new LocalAlbumArtworkResourceError('ARTWORK_RECORD_INVALID')
    let evidence: unknown
    try { evidence = JSON.parse(value) } catch { throw new LocalAlbumArtworkResourceError('ARTWORK_RECORD_INVALID') }
    if (!validLocalAlbumDisplayEvidence(evidence)) throw new LocalAlbumArtworkResourceError('ARTWORK_RECORD_INVALID')
    return evidence
  }
  function nextRevision(db: DatabaseSync): number {
    const previous = Number(db.prepare('SELECT revision FROM local_album_artwork_resource_revision WHERE id=1').get()?.revision)
    if (!integer(previous, Number.MAX_SAFE_INTEGER - 1)) return unavailable()
    const next = previous + 1
    db.prepare('UPDATE local_album_artwork_resource_revision SET revision=? WHERE id=1').run(next)
    return next
  }
  return {
    withInventoryRead,
    lookup(datasetId: string, rootId: string, albumKey: string): InventoryEntry | null {
      if (!isCollectionId(datasetId) || !isCollectionId(rootId) || !album(albumKey)) throw new LocalAlbumArtworkResourceError('ARTWORK_RECORD_INVALID')
      checkInventory()
      const current = inventoryRead, key = JSON.stringify([datasetId, rootId, albumKey])
      if (current?.initialFailure) throw current.initialFailure
      const copy = (entry: InventoryEntry | null): InventoryEntry | null => entry ? { ...entry, binding: { ...entry.binding } } : null
      if (current?.db && current.entries.has(key)) return copy(current.entries.get(key)!)
      const db = current?.db ?? open()
      if (retired.has(rootId)) return null
      const row = (current?.lookup ?? db.prepare(INVENTORY_SQL)).get(datasetId, rootId, albumKey)
      if (!row) { if (current?.db && current.entries.size < MAX_ROWS) current.entries.set(key, null); return null }
      const binding = { datasetId, rootId, albumKey, authority: row.authority, membership: row.membership, editionId: row.edition_id, representativeTrackId: row.representative_track_id }
      if (!validBinding(binding as LocalAlbumArtworkResourceBinding) || !integer(row.revision) || row.revision === 0 || row.content_hash !== null && !sha(row.content_hash)) throw new LocalAlbumArtworkResourceError('ARTWORK_RECORD_INVALID')
      if (row.content_hash !== null && row.present_content !== row.content_hash) throw new LocalAlbumArtworkResourceError('ARTWORK_RECORD_INVALID')
      if (row.content_hash === null && ![0, 1].includes(Number(row.missing_policy))) throw new LocalAlbumArtworkResourceError('ARTWORK_RECORD_INVALID')
      // 仅轻量提示旧CD缺图；当前目录/分组/授权仍由Reader从实际catalog重新证明。
      const legacyDiscAudioRelative = row.content_hash === null && row.missing_policy === 0 && isLocalAlbumPrivateRelative(row.missing_audio)
        && classifyDirectoryName(path.posix.basename(path.posix.dirname(row.missing_audio))) === 'disc' ? row.missing_audio : undefined
      const entry: InventoryEntry = { binding: binding as LocalAlbumArtworkResourceBinding, state: row.content_hash === null ? 'missing' : 'available', revision: String(row.revision),
        ...(legacyDiscAudioRelative ? { legacyDiscAudioRelative } : {}) }
      if (current?.db && current.entries.size < MAX_ROWS) current.entries.set(key, entry)
      return copy(entry)
    },
    get(binding: LocalAlbumArtworkResourceBinding): LocalAlbumSavedArtwork | null {
      const started = performance.now()
      try {
        const { db, row } = find(binding)
        if (!row) return null
        const evidence = readEvidence(row.evidence)
        if (!integer(row.revision) || row.revision === 0) throw new LocalAlbumArtworkResourceError('ARTWORK_RECORD_INVALID')
        if (row.content_hash === null) return { state: 'missing', record: null, evidence, revision: String(row.revision) }
        if (!sha(row.content_hash)) throw new LocalAlbumArtworkResourceError('ARTWORK_RECORD_INVALID')
        const content = db.prepare('SELECT metadata,jpeg,payload_bytes FROM local_album_artwork_resources WHERE content_hash=?').get(row.content_hash)
        if (!content || typeof content.metadata !== 'string' || Buffer.byteLength(content.metadata) > MAX_METADATA || !(content.jpeg instanceof Uint8Array)
          || content.payload_bytes !== content.jpeg.byteLength || digest(content.metadata, content.jpeg) !== row.content_hash) throw new LocalAlbumArtworkResourceError('ARTWORK_RECORD_INVALID')
        let meta: Record<string, unknown>
        try { meta = JSON.parse(content.metadata) as Record<string, unknown> }
        catch { throw new LocalAlbumArtworkResourceError('ARTWORK_RECORD_INVALID') }
        if (!meta || typeof meta !== 'object' || Array.isArray(meta)
          || JSON.stringify({ original: meta.original, display: meta.display, ...(Object.hasOwn(meta, 'grid') ? { grid: meta.grid } : {}) }) !== content.metadata) throw new LocalAlbumArtworkResourceError('ARTWORK_RECORD_INVALID')
        const record = decodeLocalAlbumDisplayRecord(JSON.stringify({ original: meta.original, display: meta.display, evidence, ...(Object.hasOwn(meta, 'grid') ? { grid: meta.grid } : {}) }), content.jpeg)
        if (!record) throw new LocalAlbumArtworkResourceError('ARTWORK_RECORD_INVALID')
        logLibraryOperation('cache', 'artwork.resource-read', 'hit', { id: row.content_hash, bytes: content.jpeg.byteLength, elapsedMs: performance.now() - started, slowAfterMs: 50 })
        return { state: 'available', record, evidence, revision: String(row.revision) }
      } catch (error) {
        logLibraryOperation('cache', 'artwork.resource-read', 'error', { code: error instanceof LocalAlbumArtworkResourceError ? error.code : 'ARTWORK_STORE_UNAVAILABLE', elapsedMs: performance.now() - started, slowAfterMs: 50 })
        if (error instanceof LocalAlbumArtworkResourceError) throw error
        disable(); return unavailable()
      }
    },
    state(binding: LocalAlbumArtworkResourceBinding): { state: 'available' | 'missing'; revision: string } | null {
      const { row } = find(binding)
      if (!row) return null
      if (!integer(row.revision) || row.revision === 0 || row.content_hash !== null && !sha(row.content_hash)) throw new LocalAlbumArtworkResourceError('ARTWORK_RECORD_INVALID')
      return { state: row.content_hash === null ? 'missing' : 'available', revision: String(row.revision) }
    },
    put(binding: LocalAlbumArtworkResourceBinding, value: LocalAlbumDisplayCacheRecord | { image: null; evidence: LocalAlbumDisplayCacheEvidence }, seal: () => void): void {
      const started = performance.now()
      let sealError: unknown
      const sealCurrent = (): void => { try { seal() } catch (error) { sealError = error; throw error } }
      try {
        if (!validLocalAlbumDisplayEvidence(value.evidence) || value.image === null && (!value.evidence.embeddedConfirmed || value.evidence.independent.some(item => item.included))) throw new LocalAlbumArtworkResourceError('ARTWORK_RECORD_INVALID')
        const encoded = value.image === null ? null : encodeLocalAlbumDisplayRecord(value)
        if (value.image !== null && !encoded) throw new LocalAlbumArtworkResourceError('ARTWORK_RECORD_INVALID')
        const parsed = encoded ? JSON.parse(encoded.metadata) as Record<string, unknown> : null
        const metadata = parsed ? JSON.stringify({ original: parsed.original, display: parsed.display, ...(Object.hasOwn(parsed, 'grid') ? { grid: parsed.grid } : {}) }) : null
        const contentHash = encoded && metadata ? digest(metadata, encoded.jpeg) : null
        const evidence = JSON.stringify(value.evidence), db = accepted(binding)
        if (Buffer.byteLength(evidence) > MAX_METADATA) throw new LocalAlbumArtworkResourceError('ARTWORK_RECORD_INVALID')
        sealCurrent()
        transaction(db, () => {
          sealCurrent()
          if (retired.has(binding.rootId)) throw new LocalAlbumArtworkResourceError('ARTWORK_ROOT_RETIRED')
          const previous = db.prepare('SELECT content_hash FROM local_album_artwork_bindings WHERE dataset_id=? AND root_id=? AND album_key=?').get(binding.datasetId, binding.rootId, binding.albumKey)
          if (!previous && Number(db.prepare('SELECT count(*) n FROM local_album_artwork_bindings').get()?.n) >= maxEntries) throw new LocalAlbumArtworkResourceError('ARTWORK_STORE_FULL')
          const existing = contentHash ? db.prepare('SELECT metadata,jpeg,payload_bytes FROM local_album_artwork_resources WHERE content_hash=?').get(contentHash) : null
          if (contentHash && encoded && metadata && !existing) {
            const totals = db.prepare('SELECT count(*) n,coalesce(sum(payload_bytes),0) bytes FROM local_album_artwork_resources').get()!
            if (Number(totals.n) >= maxEntries || Number(totals.bytes) + encoded.jpeg.length > maxBytes) throw new LocalAlbumArtworkResourceError('ARTWORK_STORE_FULL')
            if (!memory) { const free = statfsSync(path.dirname(options.filePath), { bigint: true }); if (free.bavail * free.bsize < BigInt(256 * 1024 ** 2 + encoded.jpeg.length * 4)) throw new LocalAlbumArtworkResourceError('ARTWORK_STORE_FULL') }
            db.prepare('INSERT INTO local_album_artwork_resources VALUES(?,?,?,?)').run(contentHash, metadata, encoded.jpeg, encoded.jpeg.length)
          } else if (existing && contentHash && encoded && metadata && (existing.metadata !== metadata || !(existing.jpeg instanceof Uint8Array)
            || existing.payload_bytes !== existing.jpeg.byteLength || digest(metadata, existing.jpeg) !== contentHash)) {
            // 原损坏字节继续视为miss；只有重新验证过的真实源输出才能原位修复该内容资源。
            db.prepare('UPDATE local_album_artwork_resources SET metadata=?,jpeg=?,payload_bytes=? WHERE content_hash=?').run(metadata, encoded.jpeg, encoded.jpeg.length, contentHash)
          }
          const revision = nextRevision(db)
          db.prepare('INSERT INTO local_album_artwork_bindings VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(dataset_id,root_id,album_key) DO UPDATE SET authority=excluded.authority,membership=excluded.membership,edition_id=excluded.edition_id,representative_track_id=excluded.representative_track_id,content_hash=excluded.content_hash,evidence=excluded.evidence,revision=excluded.revision').run(binding.datasetId, binding.rootId, binding.albumKey, binding.authority, binding.membership, binding.editionId, binding.representativeTrackId, contentHash, evidence, revision)
          if (previous?.content_hash && previous.content_hash !== contentHash) db.prepare('DELETE FROM local_album_artwork_resources WHERE content_hash=? AND NOT EXISTS(SELECT 1 FROM local_album_artwork_bindings b WHERE b.content_hash=local_album_artwork_resources.content_hash)').run(previous.content_hash)
          sealCurrent()
        })
        inspect(db)
        logLibraryOperation('cache', 'artwork.resource-write', 'complete', { ...(contentHash ? { id: contentHash } : {}), elapsedMs: performance.now() - started, bytes: encoded?.jpeg.length ?? 0, slowAfterMs: 50 })
      } catch (error) {
        logLibraryOperation('cache', 'artwork.resource-write', 'error', { code: error instanceof LocalAlbumArtworkResourceError ? error.code : 'ARTWORK_STORE_UNAVAILABLE', elapsedMs: performance.now() - started, slowAfterMs: 50 })
        if (error instanceof LocalAlbumArtworkResourceError) throw error
        // seal失败须原样回传；其它SQLite/文件错误封成安全细码，不能冒充成功。
        if (error === sealError) throw error
        disable(); return unavailable()
      }
    },
    revision(): string { checkInventory(); if (inventoryRead?.initialFailure) throw inventoryRead.initialFailure; return readRevision(inventoryRead?.db ?? open(), inventoryRead?.revision) },
    removeRoot(rootId: string): void {
      if (!isCollectionId(rootId)) throw new LocalAlbumArtworkResourceError('ARTWORK_RECORD_INVALID')
      // 内存先封住迟到写；墓碑提交后即使重开也不能复活旧根，图片原件继续保留。
      if (!retired.has(rootId)) { retired.add(rootId); retiredEpoch++ }
      const db = open()
      transaction(db, () => { db.prepare('INSERT OR IGNORE INTO local_album_artwork_resource_retired_roots VALUES(?)').run(rootId); nextRevision(db) })
      logLibraryOperation('cache', 'artwork.resource-root', 'complete', { id: rootId })
    },
    close(): void { if (stopped) return; stopped = true; const db = database; database = undefined; db?.close() },
  }
}
