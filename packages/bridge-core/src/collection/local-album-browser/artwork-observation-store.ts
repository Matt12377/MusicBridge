import { Buffer } from 'node:buffer'
import { constants, closeSync, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, realpathSync, statfsSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { isCollectionId } from '@music-bridge/contracts'
import type { LocalAlbumSqlArtworkObservation } from './sql-types.js'

/** 轻量成功观察不随图像LRU逐张淘汰；达到硬界限时拒新增并保留原事实。 */
export const MAX_LOCAL_ALBUM_ARTWORK_OBSERVATIONS = 100_000
const FILE_BYTES = 64 * 1024 * 1024, JOURNAL_BYTES = 8 * 1024 * 1024, PAGE_BYTES = 4096
const MAX_PAGES = (FILE_BYTES - JOURNAL_BYTES) / PAGE_BYTES, APPLICATION_ID = 0x4d42414f
const TABLE = 'CREATE TABLE local_album_artwork_observations(dataset_id BLOB NOT NULL CHECK(length(dataset_id)=16),album_key TEXT NOT NULL CHECK(length(CAST(album_key AS BLOB)) BETWEEN 1 AND 256),root_id BLOB NOT NULL CHECK(length(root_id)=16),source_revision BLOB NOT NULL CHECK(length(source_revision)=32),revision BLOB NOT NULL CHECK(length(revision)=32),state INTEGER NOT NULL CHECK(state IN(0,1)),generation INTEGER NOT NULL CHECK(generation>=0),PRIMARY KEY(dataset_id,album_key)) STRICT, WITHOUT ROWID'
const RETIRED = 'CREATE TABLE local_album_artwork_observation_retired_roots(root_id BLOB PRIMARY KEY CHECK(length(root_id)=16)) STRICT, WITHOUT ROWID'
const DATASETS = 'CREATE TABLE local_album_artwork_observation_datasets(dataset_id BLOB PRIMARY KEY CHECK(length(dataset_id)=16),generation INTEGER NOT NULL CHECK(generation>=0)) STRICT, WITHOUT ROWID'
const INDEXES = [
  'CREATE INDEX local_album_artwork_observation_read ON local_album_artwork_observations(dataset_id,generation,source_revision,album_key)',
  'CREATE INDEX local_album_artwork_observation_root ON local_album_artwork_observations(root_id,dataset_id,album_key)',
] as const
const sha = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value)
const album = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:@-]{0,255}$/u.test(value)
const integer = (value: unknown, max: number): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= max
const uuid = (value: string): Buffer => Buffer.from(value.replaceAll('-', ''), 'hex')
function readUuid(value: unknown): string | null {
  if (!(value instanceof Uint8Array) || value.byteLength !== 16) return null
  const hex = Buffer.from(value).toString('hex'), result = `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`
  return isCollectionId(result) ? result : null
}
function observation(value: unknown): value is LocalAlbumSqlArtworkObservation {
  try {
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false
  const keys = ['albumKey', 'rootId', 'sourceRevision', 'state', 'revision']
  if (Reflect.ownKeys(value).length !== keys.length || !keys.every(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    return descriptor?.enumerable === true && Object.hasOwn(descriptor, 'value')
  })) return false
  const record = value as Record<string, unknown>
  return album(record.albumKey) && isCollectionId(record.rootId) && sha(record.sourceRevision) && sha(record.revision)
    && (record.state === 'available' || record.state === 'missing')
  } catch { return false }
}

/** 独立派生副库；只存成功读取事实，不存图像、路径、权限或失败，不修改主库schema/水位。 */
export function createLocalAlbumArtworkObservationStore(options: { filePath: string }) {
  let database: DatabaseSync | undefined, cleanup: ReturnType<typeof setImmediate> | undefined
  let closed = false, failed = false, rows = 0, retiredCount = 0, datasetCount = 0, dataVersion = 0
  let fileIdentity: { dev: number; ino: number } | undefined, directoryIdentity: { dev: number; ino: number } | undefined
  const retiredRoots = new Set<string>(), pendingRoots = new Set<string>(), pendingDatasets = new Set<string>(), memory = options.filePath === ':memory:'
  function cancelCleanup(): void { if (cleanup) { clearImmediate(cleanup); cleanup = undefined } }
  function disable(connection = database): void {
    failed = true; database = undefined; cancelCleanup(); pendingRoots.clear(); pendingDatasets.clear()
    try { connection?.close() } catch { /* 派生状态失败不遮蔽原成功读取；本实例不再重开。 */ }
  }
  function diskBudget(): void {
    if (memory) return
    const directory = path.dirname(options.filePath), info = lstatSync(directory)
    if (!info.isDirectory() || info.isSymbolicLink() || realpathSync(directory) !== directory
      || directoryIdentity && (directoryIdentity.dev !== info.dev || directoryIdentity.ino !== info.ino)) throw new Error('封面观察目录已改变。')
    let bytes = 0
    for (const suffix of ['', '-journal', '-wal', '-shm']) {
      try {
        const file = lstatSync(options.filePath + suffix)
        if (!file.isFile() || file.isSymbolicLink() || file.nlink !== 1 || (file.mode & 0o200) === 0 || (file.mode & 0o077) !== 0) throw new Error('封面观察文件不可用。')
        if (suffix === '' && (file.size > MAX_PAGES * PAGE_BYTES || fileIdentity && (fileIdentity.dev !== file.dev || fileIdentity.ino !== file.ino))) throw new Error('封面观察文件已改变。')
        bytes += file.size
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || suffix === '') throw error }
    }
    if (bytes > FILE_BYTES) throw new Error('封面观察文件超过上限。')
  }
  function inspect(db: DatabaseSync): void {
    diskBudget()
    const pages = Number(db.prepare('PRAGMA page_count').get()?.page_count), free = Number(db.prepare('PRAGMA freelist_count').get()?.freelist_count)
    if (!integer(pages, MAX_PAGES) || !integer(free, pages) || Number(db.prepare('PRAGMA data_version').get()?.data_version) !== dataVersion) throw new Error('封面观察连接或预算已改变。')
  }
  function transaction<T>(db: DatabaseSync, action: () => T): T {
    db.exec('BEGIN IMMEDIATE')
    try { const result = action(); db.exec('COMMIT'); return result }
    catch (error) { try { db.exec('ROLLBACK') } catch { /* 随后停止本副库，保留首个失败。 */ }; throw error }
  }
  function generation(db: DatabaseSync, datasetId: string): number {
    const record = db.prepare('SELECT generation FROM local_album_artwork_observation_datasets WHERE dataset_id=?').get(uuid(datasetId))
    const value = record ? record.generation : 0
    if (!integer(value, Number.MAX_SAFE_INTEGER)) throw new Error('封面观察代际无效。')
    return value
  }
  function scheduleCleanup(): void {
    if (cleanup || closed || failed || !database || !pendingRoots.size && !pendingDatasets.size) return
    cleanup = setImmediate(() => {
      cleanup = undefined
      if (closed || failed || !database) return
      const db = database, rootId = pendingRoots.values().next().value as string | undefined
      const datasetId = !rootId ? pendingDatasets.values().next().value as string | undefined : undefined
      if (!rootId && !datasetId) return
      try {
        inspect(db)
        const currentGeneration = datasetId ? generation(db, datasetId) : 0
        // 已提交的墓碑/代际立即隔离旧事实；每轮最多128条，物理清理不占用整根同步等待。
        const batch = rootId
          ? db.prepare('SELECT dataset_id,album_key FROM local_album_artwork_observations WHERE root_id=? LIMIT 128').all(uuid(rootId))
          : db.prepare('SELECT dataset_id,album_key FROM local_album_artwork_observations WHERE dataset_id=? AND generation<? LIMIT 128').all(uuid(datasetId!), currentGeneration)
        if (batch.length) {
          const removed = transaction(db, () => {
            let changes = 0
            for (const item of batch) {
              const ownerDataset = readUuid(item.dataset_id)
              if (!ownerDataset || !album(item.album_key)) throw new Error('封面观察记录无效。')
              changes += Number(rootId
                ? db.prepare('DELETE FROM local_album_artwork_observations WHERE dataset_id=? AND album_key=? AND root_id=?').run(uuid(ownerDataset), item.album_key, uuid(rootId)).changes
                : db.prepare('DELETE FROM local_album_artwork_observations WHERE dataset_id=? AND album_key=? AND generation<?').run(uuid(ownerDataset), item.album_key, currentGeneration).changes)
            }
            if (changes !== batch.length) throw new Error('封面观察记录已改变。')
            return changes
          })
          rows -= removed; if (!integer(rows, MAX_LOCAL_ALBUM_ARTWORK_OBSERVATIONS)) throw new Error('封面观察条数无效。')
        }
        if (batch.length < 128) { if (rootId) pendingRoots.delete(rootId); else if (datasetId) pendingDatasets.delete(datasetId) }
        inspect(db); scheduleCleanup()
      } catch { disable() }
    })
    cleanup.unref()
  }
  function open(): DatabaseSync | undefined {
    if (closed || failed) return undefined
    if (database) { inspect(database); return database }
    if (!memory) {
      if (!path.isAbsolute(options.filePath) || path.resolve(options.filePath) !== options.filePath) throw new Error('封面观察位置无效。')
      const directory = path.dirname(options.filePath)
      mkdirSync(directory, { recursive: true, mode: 0o700 })
      const info = lstatSync(directory)
      if (!info.isDirectory() || info.isSymbolicLink() || realpathSync(directory) !== directory) throw new Error('封面观察目录无效。')
      directoryIdentity = { dev: info.dev, ino: info.ino }
      for (const suffix of ['', '-journal', '-wal', '-shm']) {
        try { const file = lstatSync(options.filePath + suffix); if (!file.isFile() || file.isSymbolicLink() || file.nlink !== 1 || (file.mode & 0o200) === 0) throw new Error('封面观察文件不可用。') }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      }
      const fd = openSync(options.filePath, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600)
      try {
        const file = fstatSync(fd)
        if (!file.isFile() || file.nlink !== 1 || (file.mode & 0o200) === 0) throw new Error('封面观察文件不可用。')
        fchmodSync(fd, 0o600); fileIdentity = { dev: file.dev, ino: file.ino }
      } finally { closeSync(fd) }
      diskBudget()
    }
    const db = new DatabaseSync(options.filePath, { allowExtension: false, enableForeignKeyConstraints: true })
    try {
      db.exec('PRAGMA busy_timeout=0; PRAGMA trusted_schema=OFF; PRAGMA temp_store=MEMORY')
      const applicationId = Number(db.prepare('PRAGMA application_id').get()?.application_id), version = Number(db.prepare('PRAGMA user_version').get()?.user_version)
      const objects = db.prepare("SELECT type,name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'").all()
      const fresh = applicationId === 0 && version === 0 && objects.length === 0
      if (!fresh && (applicationId !== APPLICATION_ID || version !== 1 || objects.length !== 5
        || ![TABLE, RETIRED, DATASETS, ...INDEXES].every(sql => objects.some(object => object.sql === sql)))) throw new Error('封面观察结构无效。')
      db.exec('PRAGMA page_size=4096; PRAGMA journal_mode=DELETE; PRAGMA synchronous=NORMAL')
      if (Number(db.prepare('PRAGMA page_size').get()?.page_size) !== PAGE_BYTES
        || Number(db.prepare(`PRAGMA max_page_count=${MAX_PAGES}`).get()?.max_page_count) > MAX_PAGES) throw new Error('封面观察页数无效。')
      if (fresh) transaction(db, () => { db.exec(`${TABLE};${RETIRED};${DATASETS};${INDEXES.join(';')};PRAGMA application_id=${APPLICATION_ID};PRAGMA user_version=1`) })
      const count = Number(db.prepare('SELECT count(*) n FROM local_album_artwork_observations').get()?.n)
      const rootCount = Number(db.prepare('SELECT count(*) n FROM local_album_artwork_observation_retired_roots').get()?.n)
      if (!integer(count, MAX_LOCAL_ALBUM_ARTWORK_OBSERVATIONS) || !integer(rootCount, MAX_LOCAL_ALBUM_ARTWORK_OBSERVATIONS)) throw new Error('封面观察条数超过上限。')
      const datasets = Number(db.prepare('SELECT count(*) n FROM local_album_artwork_observation_datasets').get()?.n)
      if (!integer(datasets, MAX_LOCAL_ALBUM_ARTWORK_OBSERVATIONS)) throw new Error('封面观察失效记录过多。')
      rows = count; retiredCount = rootCount; datasetCount = datasets
      const pending = db.prepare('SELECT DISTINCT o.root_id FROM local_album_artwork_observations o JOIN local_album_artwork_observation_retired_roots r ON r.root_id=o.root_id LIMIT ?').all(MAX_LOCAL_ALBUM_ARTWORK_OBSERVATIONS + 1)
      if (pending.length > MAX_LOCAL_ALBUM_ARTWORK_OBSERVATIONS) throw new Error('封面观察撤根记录过多。')
      for (const item of pending) { const rootId = readUuid(item.root_id); if (!rootId) throw new Error('封面观察撤根记录无效。'); retiredRoots.add(rootId); pendingRoots.add(rootId) }
      const stale = db.prepare('SELECT d.dataset_id FROM local_album_artwork_observation_datasets d WHERE EXISTS(SELECT 1 FROM local_album_artwork_observations o WHERE o.dataset_id=d.dataset_id AND o.generation<d.generation) LIMIT ?').all(MAX_LOCAL_ALBUM_ARTWORK_OBSERVATIONS + 1)
      if (stale.length > MAX_LOCAL_ALBUM_ARTWORK_OBSERVATIONS) throw new Error('封面观察失效记录过多。')
      for (const item of stale) { const datasetId = readUuid(item.dataset_id); if (!datasetId) throw new Error('封面观察失效记录无效。'); pendingDatasets.add(datasetId) }
      dataVersion = Number(db.prepare('PRAGMA data_version').get()?.data_version)
      database = db; inspect(db); scheduleCleanup(); return db
    } catch (error) { disable(db); throw error }
  }
  return {
    read(datasetId: string, sourceRevision: string): readonly LocalAlbumSqlArtworkObservation[] {
      if (!isCollectionId(datasetId) || !sha(sourceRevision) || closed || failed) return []
      try {
        const db = open(); if (!db) return []
        const stored = db.prepare('SELECT o.album_key,o.root_id,o.state,o.revision FROM local_album_artwork_observations o LEFT JOIN local_album_artwork_observation_datasets d ON d.dataset_id=o.dataset_id WHERE o.dataset_id=? AND o.source_revision=? AND o.generation=coalesce(d.generation,0) AND NOT EXISTS(SELECT 1 FROM local_album_artwork_observation_retired_roots r WHERE r.root_id=o.root_id) ORDER BY o.album_key LIMIT ?').all(uuid(datasetId), Buffer.from(sourceRevision, 'hex'), MAX_LOCAL_ALBUM_ARTWORK_OBSERVATIONS + 1)
        if (stored.length > MAX_LOCAL_ALBUM_ARTWORK_OBSERVATIONS) throw new Error('封面观察条数超过上限。')
        const result = stored.map(item => {
          const rootId = readUuid(item.root_id), revision = item.revision instanceof Uint8Array ? Buffer.from(item.revision).toString('hex') : null
          if (!rootId || !album(item.album_key) || !sha(revision) || item.state !== 0 && item.state !== 1) throw new Error('封面观察记录无效。')
          return Object.freeze({ albumKey: item.album_key, rootId, sourceRevision, state: item.state === 1 ? 'available' as const : 'missing' as const, revision })
        })
        inspect(db); return Object.freeze(result)
      } catch { disable(); return [] }
    },
    put(datasetId: string, value: LocalAlbumSqlArtworkObservation): boolean {
      if (!isCollectionId(datasetId) || !observation(value) || retiredRoots.has(value.rootId) || closed || failed) return false
      try {
        const db = open(); if (!db) return false
        if (db.prepare('SELECT 1 FROM local_album_artwork_observation_retired_roots WHERE root_id=?').get(uuid(value.rootId))) { retiredRoots.add(value.rootId); return false }
        const currentGeneration = generation(db, datasetId)
        const prior = db.prepare('SELECT root_id,source_revision,revision,state,generation FROM local_album_artwork_observations WHERE dataset_id=? AND album_key=?').get(uuid(datasetId), value.albumKey)
        if (prior && readUuid(prior.root_id) === value.rootId && prior.source_revision instanceof Uint8Array
          && Buffer.from(prior.source_revision).toString('hex') === value.sourceRevision && prior.revision instanceof Uint8Array
          && Buffer.from(prior.revision).toString('hex') === value.revision && prior.state === (value.state === 'available' ? 1 : 0)
          && prior.generation === currentGeneration) { inspect(db); return true }
        if (!prior && rows >= MAX_LOCAL_ALBUM_ARTWORK_OBSERVATIONS) return false
        if (!memory) { const available = statfsSync(path.dirname(options.filePath), { bigint: true }); if (available.bavail * available.bsize < BigInt(FILE_BYTES)) return false }
        transaction(db, () => { db.prepare('INSERT INTO local_album_artwork_observations VALUES(?,?,?,?,?,?,?) ON CONFLICT(dataset_id,album_key) DO UPDATE SET root_id=excluded.root_id,source_revision=excluded.source_revision,revision=excluded.revision,state=excluded.state,generation=excluded.generation').run(uuid(datasetId), value.albumKey, uuid(value.rootId), Buffer.from(value.sourceRevision, 'hex'), Buffer.from(value.revision, 'hex'), value.state === 'available' ? 1 : 0, currentGeneration) })
        if (!prior) rows++
        inspect(db); return true
      } catch { disable(); return false }
    },
    remove(datasetId: string, rootId: string, albumKey: string): void {
      if (!isCollectionId(datasetId) || !isCollectionId(rootId) || !album(albumKey) || closed || failed) return
      try {
        const db = open(); if (!db) return
        const removed = transaction(db, () => Number(db.prepare('DELETE FROM local_album_artwork_observations WHERE dataset_id=? AND root_id=? AND album_key=?').run(uuid(datasetId), uuid(rootId), albumKey).changes))
        if (!integer(removed, 1)) throw new Error('封面观察删除范围无效。')
        rows -= removed; inspect(db)
      } catch { disable() }
    },
    removeDataset(datasetId: string): void {
      if (!isCollectionId(datasetId) || closed || failed) return
      try {
        const db = open(); if (!db) return
        const present = db.prepare('SELECT generation FROM local_album_artwork_observation_datasets WHERE dataset_id=?').get(uuid(datasetId))
        const previous = generation(db, datasetId)
        if (previous === Number.MAX_SAFE_INTEGER || !present && datasetCount >= MAX_LOCAL_ALBUM_ARTWORK_OBSERVATIONS) {
          // 无法再可靠记录失效时停用这份派生格式，保留原件而不恢复旧事实。
          transaction(db, () => { db.exec('PRAGMA user_version=0') }); disable(); return
        }
        transaction(db, () => { db.prepare('INSERT INTO local_album_artwork_observation_datasets VALUES(?,?) ON CONFLICT(dataset_id) DO UPDATE SET generation=excluded.generation').run(uuid(datasetId), previous + 1) })
        if (!present) datasetCount++
        pendingDatasets.add(datasetId); scheduleCleanup(); inspect(db)
      } catch { disable() }
    },
    removeRoot(rootId: string): void {
      if (!isCollectionId(rootId) || closed || failed) return
      if (retiredRoots.size < MAX_LOCAL_ALBUM_ARTWORK_OBSERVATIONS) retiredRoots.add(rootId)
      try {
        const db = open(); if (!db) return
        const present = db.prepare('SELECT 1 FROM local_album_artwork_observation_retired_roots WHERE root_id=?').get(uuid(rootId))
        if (!present) {
          if (retiredCount >= MAX_LOCAL_ALBUM_ARTWORK_OBSERVATIONS) {
            // 撤权墓碑也有界；无法再记录时永久停用这份派生格式，不能让旧root复活。
            transaction(db, () => { db.exec('PRAGMA user_version=0') }); disable(); return
          }
          transaction(db, () => { db.prepare('INSERT INTO local_album_artwork_observation_retired_roots VALUES(?)').run(uuid(rootId)) })
          retiredCount++
        }
        pendingRoots.add(rootId); scheduleCleanup(); inspect(db)
      } catch { disable() }
    },
    close(): void {
      if (closed) return
      closed = true; cancelCleanup(); pendingRoots.clear(); pendingDatasets.clear(); retiredRoots.clear()
      const db = database; database = undefined
      try { db?.close() } catch { failed = true }
    },
  }
}
