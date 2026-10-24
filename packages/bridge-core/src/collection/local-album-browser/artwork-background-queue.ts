import { randomUUID } from 'node:crypto'
import { constants, closeSync, fchmodSync, fstatSync, lstatSync, openSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { isCollectionId, isLocalAlbumArtworkRequest, isLocalCatalogRevision, type LocalAlbumArtworkRequest } from '@music-bridge/contracts'
import { logLibraryOperation } from '../../shared/library-operation-log.js'

export type ArtworkBackgroundMode = 'running' | 'paused' | 'cancelled'
export interface ArtworkBackgroundClaim {
  id: string
  token: string
  request: LocalAlbumArtworkRequest
  attempts: number
}
export interface ArtworkBackgroundCursor { offset: number; done: boolean }
export interface ArtworkDiscoveryCursor extends ArtworkBackgroundCursor {
  key: string
  code: 'CURSOR_START' | 'CURSOR_CONTINUE' | 'CURSOR_REWIND' | 'ROOT_CHANGED'
}
export type ArtworkPersistedState = 'available' | 'missing' | null

interface DiscoveryRevision {
  v: 2
  identity: string
  revision: string
  dirty: boolean
  retryRevision: string | null
  end: number | null
}

const APPLICATION_ID = 0x4d424151
const MAX_JOBS = 300_000
const RECONCILE_BATCH = 50
const SCHEMA = [
  "CREATE TABLE artwork_queue_control(dataset_id TEXT PRIMARY KEY,mode TEXT NOT NULL CHECK(mode IN ('running','paused','cancelled'))) STRICT",
  "CREATE TABLE artwork_queue_jobs(id TEXT PRIMARY KEY,dataset_id TEXT NOT NULL,root_id TEXT NOT NULL,album_key TEXT NOT NULL,revision TEXT NOT NULL,request TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('pending','running','complete')),priority INTEGER NOT NULL,attempts INTEGER NOT NULL,not_before INTEGER NOT NULL,token TEXT,UNIQUE(dataset_id,root_id,album_key)) STRICT",
  'CREATE INDEX artwork_queue_pending ON artwork_queue_jobs(dataset_id,state,priority DESC,not_before,id)',
  "CREATE INDEX artwork_queue_completed ON artwork_queue_jobs(dataset_id,id) WHERE state='complete'",
  'CREATE TABLE artwork_queue_cursors(dataset_id TEXT NOT NULL,root_id TEXT NOT NULL,revision TEXT NOT NULL,offset INTEGER NOT NULL,done INTEGER NOT NULL,PRIMARY KEY(dataset_id,root_id)) STRICT',
  'CREATE TABLE artwork_queue_retired(dataset_id TEXT NOT NULL,root_id TEXT NOT NULL,PRIMARY KEY(dataset_id,root_id)) STRICT',
  'CREATE TABLE artwork_queue_source_changes(dataset_id TEXT NOT NULL,root_id TEXT NOT NULL,revision TEXT NOT NULL,PRIMARY KEY(dataset_id,root_id)) STRICT',
] as const

export class LocalAlbumArtworkQueueError extends Error {
  readonly code = 'ARTWORK_QUEUE_UNAVAILABLE'
  constructor() { super('后台封面任务存储暂时不可用，已有任务保留。'); this.name = 'LocalAlbumArtworkQueueError' }
}

function discoveryIdentity(value: string): boolean {
  const parts = value.split(':')
  return parts.length === 2 && isCollectionId(parts[0]) && isLocalCatalogRevision(parts[1])
}
function discoveryRevision(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 160 && !/[\u0000-\u001f\u007f]/u.test(value)
}
function readDiscovery(value: unknown): DiscoveryRevision | null {
  if (typeof value !== 'string' || value.length > 512) throw new LocalAlbumArtworkQueueError()
  try {
    const data: unknown = JSON.parse(value)
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null
    const v = data as Record<string, unknown>
    const keys = ['v', 'identity', 'revision', 'dirty', 'retryRevision', 'end']
    if (Object.keys(v).length !== keys.length || !keys.every(key => Object.hasOwn(v, key)) || v.v !== 2
      || typeof v.identity !== 'string' || !discoveryIdentity(v.identity) || !discoveryRevision(v.revision)
      || typeof v.dirty !== 'boolean' || v.retryRevision !== null && !discoveryRevision(v.retryRevision)
      || v.end !== null && (!Number.isSafeInteger(v.end) || Number(v.end) < 0 || Number(v.end) > MAX_JOBS)) return null
    return v as unknown as DiscoveryRevision
  } catch { return null }
}
function writeDiscovery(value: DiscoveryRevision): string {
  const encoded = JSON.stringify(value)
  if (encoded.length > 512 || !readDiscovery(encoded)) throw new LocalAlbumArtworkQueueError()
  return encoded
}
function readCursor(row: Record<string, unknown>): ArtworkBackgroundCursor {
  if (!Number.isSafeInteger(row.offset) || Number(row.offset) < 0 || ![0, 1].includes(Number(row.done))) throw new LocalAlbumArtworkQueueError()
  return { offset: Number(row.offset), done: row.done === 1 }
}

/** 派生任务只保存逻辑身份与断点，不保存路径、Source许可或图片。 */
export function createLocalAlbumArtworkQueue(options: { filePath: string }) {
  let db: DatabaseSync | undefined
  let closed = false
  try {
    const file = options.filePath
    if (file === ':memory:') db = new DatabaseSync(file)
    else {
      if (!path.isAbsolute(file) || realpathSync(path.dirname(file)) !== path.dirname(file)) throw new LocalAlbumArtworkQueueError()
      const fd = openSync(file, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600)
      let identity: ReturnType<typeof fstatSync>
      try {
        identity = fstatSync(fd)
        if (!identity.isFile() || identity.nlink !== 1) throw new LocalAlbumArtworkQueueError()
        fchmodSync(fd, 0o600)
      } finally { closeSync(fd) }
      db = new DatabaseSync(file)
      const current = lstatSync(file)
      if (!current.isFile() || current.isSymbolicLink() || current.dev !== identity.dev || current.ino !== identity.ino || current.nlink !== 1) throw new LocalAlbumArtworkQueueError()
    }
    db.exec('PRAGMA busy_timeout=0; PRAGMA synchronous=FULL')
    const application = Number(db.prepare('PRAGMA application_id').get()?.application_id)
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()
    if (!application && tables.length === 0) db.exec(`BEGIN IMMEDIATE;${SCHEMA.join(';')};PRAGMA application_id=${APPLICATION_ID};COMMIT`)
    else {
      if (application !== APPLICATION_ID) throw new LocalAlbumArtworkQueueError()
      for (const sql of SCHEMA) {
        const name = /^CREATE (?:TABLE|INDEX) (\w+)/u.exec(sql)![1]!
        const prior = db.prepare('SELECT sql FROM sqlite_master WHERE name=?').get(name)
        // 新增派生结构只补装，不重建旧任务、领取令牌或人工控制状态。
        if (!prior && (name === 'artwork_queue_source_changes' || name === 'artwork_queue_completed')) db.exec(sql)
        else if (prior?.sql !== sql) throw new LocalAlbumArtworkQueueError()
      }
    }
    if (Number(db.prepare('SELECT count(*) n FROM artwork_queue_jobs').get()?.n) > MAX_JOBS) throw new LocalAlbumArtworkQueueError()
  } catch {
    try { db?.close() } catch { /* 损坏派生库保留原文件，不影响主库启动。 */ }
    db = undefined
    logLibraryOperation('artwork', 'artwork.queue', 'error', { code: 'QUEUE_STORAGE_FAILED' })
  }
  function connection(): DatabaseSync { if (!db || closed) throw new LocalAlbumArtworkQueueError(); return db }
  function dataset(id: string): void { if (!isCollectionId(id)) throw new LocalAlbumArtworkQueueError() }
  function transaction<T>(action: (db: DatabaseSync) => T): T {
    const current = connection(); current.exec('BEGIN IMMEDIATE')
    try { const value = action(current); current.exec('COMMIT'); return value }
    catch (error) { if (current.isTransaction) current.exec('ROLLBACK'); throw error }
  }
  function mode(datasetId: string): ArtworkBackgroundMode {
    dataset(datasetId)
    const value = connection().prepare('SELECT mode FROM artwork_queue_control WHERE dataset_id=?').get(datasetId)?.mode
    if (!['running', 'paused', 'cancelled'].includes(String(value))) throw new LocalAlbumArtworkQueueError()
    return value as ArtworkBackgroundMode
  }
  return {
    get available(): boolean { return !!db && !closed },
    recover(datasetId: string): number {
      dataset(datasetId)
      return transaction(current => {
        current.prepare("INSERT OR IGNORE INTO artwork_queue_control VALUES(?,'running')").run(datasetId)
        return Number(current.prepare("UPDATE artwork_queue_jobs SET state='pending',token=NULL WHERE dataset_id=? AND state='running'").run(datasetId).changes)
      })
    },
    mode,
    setMode(datasetId: string, value: ArtworkBackgroundMode): void {
      dataset(datasetId)
      if (!['running', 'paused', 'cancelled'].includes(value)) throw new LocalAlbumArtworkQueueError()
      connection().prepare('INSERT INTO artwork_queue_control VALUES(?,?) ON CONFLICT(dataset_id) DO UPDATE SET mode=excluded.mode').run(datasetId, value)
    },
    enqueue(datasetId: string, requests: readonly LocalAlbumArtworkRequest[], priority = 0): void {
      dataset(datasetId)
      if (requests.length > 200 || !Number.isSafeInteger(priority) || priority < 0 || priority > 1000 || !requests.every(isLocalAlbumArtworkRequest)) throw new LocalAlbumArtworkQueueError()
      transaction(current => {
        let size: number | undefined
        for (const request of requests) {
          if (current.prepare('SELECT 1 FROM artwork_queue_retired WHERE dataset_id=? AND root_id=?').get(datasetId, request.rootId)) continue
          const refresh = current.prepare('SELECT 1 FROM artwork_queue_source_changes WHERE dataset_id=? AND root_id=?').get(datasetId, request.rootId)
          const prior = current.prepare('SELECT id,revision,request FROM artwork_queue_jobs WHERE dataset_id=? AND root_id=? AND album_key=?').get(datasetId, request.rootId, request.albumKey)
          const previous: unknown = prior ? JSON.parse(String(prior.request)) : null
          if (prior && (!isLocalAlbumArtworkRequest(previous) || previous.revision !== prior.revision)) throw new LocalAlbumArtworkQueueError()
          const target = refresh || isLocalAlbumArtworkRequest(previous) && previous.refresh ? { ...request, refresh: true as const } : request
          if (!prior) {
            size ??= Number(current.prepare('SELECT count(*) n FROM artwork_queue_jobs').get()?.n)
            if (size++ >= MAX_JOBS) throw new LocalAlbumArtworkQueueError()
            current.prepare("INSERT INTO artwork_queue_jobs VALUES(?,?,?,?,?,?,'pending',?,0,0,NULL)").run(randomUUID(), datasetId, request.rootId, request.albumKey, request.revision, JSON.stringify(target), priority)
          } else if (isLocalAlbumArtworkRequest(previous) && (previous.revision !== request.revision
            || previous.editionId !== request.editionId || previous.representativeTrackId !== request.representativeTrackId)) {
            // 扫描中的专辑修订撤旧令牌，但不能抹去同一源失败项的冷却与尝试次数。
            current.prepare("UPDATE artwork_queue_jobs SET revision=?,request=?,state='pending',priority=max(priority,?),token=NULL WHERE id=?").run(request.revision, JSON.stringify(target), priority, String(prior.id))
          } else current.prepare('UPDATE artwork_queue_jobs SET priority=max(priority,?) WHERE id=?').run(priority, String(prior.id))
        }
      })
    },
    claim(datasetId: string, nowMs = Date.now(), rootIds?: readonly string[]): ArtworkBackgroundClaim | null {
      dataset(datasetId)
      if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new LocalAlbumArtworkQueueError()
      return transaction(current => {
        if (mode(datasetId) !== 'running') return null
        const row = current.prepare("SELECT id,request,attempts FROM artwork_queue_jobs q WHERE dataset_id=? AND state='pending' AND not_before<=? AND (? IS NULL OR root_id IN(SELECT value FROM json_each(?))) AND NOT EXISTS(SELECT 1 FROM artwork_queue_retired r WHERE r.dataset_id=q.dataset_id AND r.root_id=q.root_id) ORDER BY priority DESC,rowid LIMIT 1").get(datasetId, nowMs, rootIds ? JSON.stringify(rootIds) : null, rootIds ? JSON.stringify(rootIds) : null)
        if (!row) return null
        const request: unknown = JSON.parse(String(row.request))
        if (!isCollectionId(row.id) || !isLocalAlbumArtworkRequest(request) || !Number.isSafeInteger(row.attempts) || Number(row.attempts) < 0) throw new LocalAlbumArtworkQueueError()
        const token = randomUUID(), attempts = Number(row.attempts) + 1
        current.prepare("UPDATE artwork_queue_jobs SET state='running',token=?,attempts=? WHERE id=?").run(token, attempts, row.id)
        return { id: row.id, token, request, attempts }
      })
    },
    complete(claim: ArtworkBackgroundClaim): boolean {
      return Number(connection().prepare("UPDATE artwork_queue_jobs SET state='complete',token=NULL WHERE id=? AND token=? AND state='running'").run(claim.id, claim.token).changes) === 1
    },
    retry(claim: ArtworkBackgroundClaim, notBeforeMs: number): boolean {
      if (!Number.isSafeInteger(notBeforeMs) || notBeforeMs < 0) throw new LocalAlbumArtworkQueueError()
      return Number(connection().prepare("UPDATE artwork_queue_jobs SET state='pending',token=NULL,not_before=? WHERE id=? AND token=? AND state='running'").run(notBeforeMs, claim.id, claim.token).changes) === 1
    },
    /** 仅检查已完成项的本地持久状态；主键游标限制批次，缺失才以原身份重排。 */
    reconcileCompleted(datasetId: string, afterId: string | null, rootIds: readonly string[], readPersisted: (request: LocalAlbumArtworkRequest) => ArtworkPersistedState) {
      dataset(datasetId)
      if (afterId !== null && !isCollectionId(afterId) || rootIds.length > 100 || !rootIds.every(isCollectionId)) throw new LocalAlbumArtworkQueueError()
      return transaction(current => {
        if (mode(datasetId) !== 'running' || rootIds.length === 0) return { afterId, checked: 0, requeued: 0, done: true }
        const rows = current.prepare("SELECT id,revision,request FROM artwork_queue_jobs q INDEXED BY artwork_queue_completed WHERE dataset_id=? AND state='complete' AND id>? AND root_id IN(SELECT value FROM json_each(?)) AND NOT EXISTS(SELECT 1 FROM artwork_queue_retired r WHERE r.dataset_id=q.dataset_id AND r.root_id=q.root_id) ORDER BY id LIMIT ?")
          .all(datasetId, afterId ?? '', JSON.stringify(rootIds), RECONCILE_BATCH)
        let requeued = 0, next = afterId
        for (const row of rows) {
          if (typeof row.request !== 'string') throw new LocalAlbumArtworkQueueError()
          const request: unknown = JSON.parse(row.request)
          if (!isCollectionId(row.id) || !isLocalAlbumArtworkRequest(request) || row.revision !== request.revision) throw new LocalAlbumArtworkQueueError()
          const state = readPersisted(request)
          if (state !== null && state !== 'available' && state !== 'missing') throw new LocalAlbumArtworkQueueError()
          if (state === null) requeued += Number(current.prepare("UPDATE artwork_queue_jobs SET state='pending',token=NULL,attempts=0,not_before=0 WHERE id=? AND dataset_id=? AND revision=? AND request=? AND state='complete' AND token IS NULL AND EXISTS(SELECT 1 FROM artwork_queue_control c WHERE c.dataset_id=artwork_queue_jobs.dataset_id AND c.mode='running') AND NOT EXISTS(SELECT 1 FROM artwork_queue_retired r WHERE r.dataset_id=artwork_queue_jobs.dataset_id AND r.root_id=artwork_queue_jobs.root_id)")
            .run(row.id, datasetId, request.revision, row.request).changes)
          next = row.id
        }
        return { afterId: next, checked: rows.length, requeued, done: rows.length < RECONCILE_BATCH }
      })
    },
    cursor(datasetId: string, rootId: string, identity: string, revision: string): ArtworkDiscoveryCursor {
      dataset(datasetId)
      if (!isCollectionId(rootId) || !discoveryIdentity(identity) || !discoveryRevision(revision)) throw new LocalAlbumArtworkQueueError()
      return transaction(current => {
        const row = current.prepare('SELECT revision,offset,done FROM artwork_queue_cursors WHERE dataset_id=? AND root_id=?').get(datasetId, rootId)
        const previous = row ? readDiscovery(row.revision) : null
        let cursor = row ? readCursor(row) : { offset: 0, done: false }
        let state: DiscoveryRevision = previous ?? { v: 2, identity, revision, dirty: false, retryRevision: null, end: null }
        let code: ArtworkDiscoveryCursor['code'] = 'CURSOR_CONTINUE'
        // 旧 opaque 游标保守开一轮；不迁移表，也不信任旧数据中的补扫资格。
        const legacyIdentity = !previous && typeof row?.revision === 'string' ? row.revision.split(':').slice(0, 2).join(':') : null
        const changed = previous ? previous.identity !== identity : !!legacyIdentity && discoveryIdentity(legacyIdentity) && legacyIdentity !== identity
        if (!previous || changed) {
          state = { v: 2, identity, revision, dirty: false, retryRevision: null, end: null }
          cursor = { offset: 0, done: false }; code = changed ? 'ROOT_CHANGED' : 'CURSOR_START'
          if (changed) current.prepare("UPDATE artwork_queue_jobs SET request=json_set(request,'$.refresh',json('true')),state='pending',token=NULL,attempts=0,not_before=0 WHERE dataset_id=? AND root_id=?").run(datasetId, rootId)
        } else {
          if (state.revision !== revision) state = { ...state, dirty: true }
          if (cursor.done && state.dirty) {
            state = { ...state, revision, dirty: false, end: null }
            cursor = { offset: 0, done: false }; code = 'CURSOR_REWIND'
          }
        }
        const key = writeDiscovery(state)
        if (!row) current.prepare('INSERT INTO artwork_queue_cursors VALUES(?,?,?,?,?)').run(datasetId, rootId, key, cursor.offset, cursor.done ? 1 : 0)
        else if (row.revision !== key || row.offset !== cursor.offset || row.done !== Number(cursor.done)) current.prepare('UPDATE artwork_queue_cursors SET revision=?,offset=?,done=? WHERE dataset_id=? AND root_id=?').run(key, cursor.offset, cursor.done ? 1 : 0, datasetId, rootId)
        return { ...cursor, key, code }
      })
    },
    advance(datasetId: string, rootId: string, previous: ArtworkDiscoveryCursor, next: ArtworkBackgroundCursor, total: number, revision: string): boolean {
      dataset(datasetId)
      if (!Number.isSafeInteger(next.offset) || next.offset < previous.offset || !Number.isSafeInteger(total) || total < 0 || total > MAX_JOBS || !discoveryRevision(revision)) throw new LocalAlbumArtworkQueueError()
      return transaction(current => {
        const row = current.prepare('SELECT revision,offset,done FROM artwork_queue_cursors WHERE dataset_id=? AND root_id=?').get(datasetId, rootId)
        const state = row ? readDiscovery(row.revision) : null, expected = readDiscovery(previous.key)
        if (!state || !expected || state.identity !== expected.identity || state.revision !== expected.revision || row!.offset !== previous.offset || row!.done !== 0) return false
        const end = state.end ?? total
        // await 查询期间到达的 dirty 必须保留；该轮只前进到首个成功页的目录上界。
        const key = writeDiscovery({ ...state, end, dirty: state.dirty || state.revision !== revision })
        current.prepare('UPDATE artwork_queue_cursors SET revision=?,offset=?,done=? WHERE dataset_id=? AND root_id=?').run(key, next.offset, next.done || next.offset >= end ? 1 : 0, datasetId, rootId)
        return true
      })
    },
    dirtyDiscovery(datasetId: string, rootId?: string, retryRevision?: string): void {
      dataset(datasetId)
      if (rootId !== undefined && !isCollectionId(rootId) || retryRevision !== undefined && !discoveryRevision(retryRevision)) throw new LocalAlbumArtworkQueueError()
      transaction(current => {
        const rows = rootId ? current.prepare('SELECT root_id,revision FROM artwork_queue_cursors WHERE dataset_id=? AND root_id=?').all(datasetId, rootId)
          : current.prepare('SELECT root_id,revision FROM artwork_queue_cursors WHERE dataset_id=?').all(datasetId)
        for (const row of rows) {
          const rowRootId = row.root_id
          if (!isCollectionId(rowRootId)) throw new LocalAlbumArtworkQueueError()
          const state = readDiscovery(row.revision)
          if (!state || retryRevision !== undefined && state.retryRevision === retryRevision) continue
          const key = writeDiscovery({ ...state, dirty: true, retryRevision: retryRevision ?? state.retryRevision })
          if (row.revision !== key) current.prepare('UPDATE artwork_queue_cursors SET revision=? WHERE dataset_id=? AND root_id=?').run(key, datasetId, rowRootId)
        }
      })
    },
    refreshRoot(datasetId: string, rootId: string, sourceRevision: string): boolean {
      dataset(datasetId)
      if (!isCollectionId(rootId) || !sourceRevision || sourceRevision.length > 512) throw new LocalAlbumArtworkQueueError()
      return transaction(current => {
        if (current.prepare('SELECT 1 FROM artwork_queue_retired WHERE dataset_id=? AND root_id=?').get(datasetId, rootId)) return false
        const prior = current.prepare('SELECT revision FROM artwork_queue_source_changes WHERE dataset_id=? AND root_id=?').get(datasetId, rootId)
        if (prior?.revision === sourceRevision) return false
        current.prepare('INSERT INTO artwork_queue_source_changes VALUES(?,?,?) ON CONFLICT(dataset_id,root_id) DO UPDATE SET revision=excluded.revision').run(datasetId, rootId, sourceRevision)
        current.prepare("UPDATE artwork_queue_jobs SET request=json_set(request,'$.refresh',json('true')),state='pending',token=NULL,attempts=0,not_before=0 WHERE dataset_id=? AND root_id=?").run(datasetId, rootId)
        current.prepare("UPDATE artwork_queue_cursors SET revision='',offset=0,done=0 WHERE dataset_id=? AND root_id=?").run(datasetId, rootId)
        return true
      })
    },
    removeRoot(datasetId: string, rootId: string): void {
      dataset(datasetId)
      if (!isCollectionId(rootId)) throw new LocalAlbumArtworkQueueError()
      transaction(current => {
        current.prepare('INSERT OR IGNORE INTO artwork_queue_retired VALUES(?,?)').run(datasetId, rootId)
        current.prepare('DELETE FROM artwork_queue_jobs WHERE dataset_id=? AND root_id=?').run(datasetId, rootId)
        current.prepare('DELETE FROM artwork_queue_cursors WHERE dataset_id=? AND root_id=?').run(datasetId, rootId)
      })
    },
    isRootRetired(datasetId: string, rootId: string): boolean {
      dataset(datasetId)
      return !!connection().prepare('SELECT 1 FROM artwork_queue_retired WHERE dataset_id=? AND root_id=?').get(datasetId, rootId)
    },
    inspect(datasetId: string) {
      dataset(datasetId)
      const counts = { pending: 0, running: 0, complete: 0 }
      for (const row of connection().prepare('SELECT state,count(*) n FROM artwork_queue_jobs WHERE dataset_id=? GROUP BY state').all(datasetId)) {
        if (!Object.hasOwn(counts, String(row.state))) throw new LocalAlbumArtworkQueueError()
        counts[row.state as keyof typeof counts] = Number(row.n)
      }
      return { mode: mode(datasetId), ...counts }
    },
    close(): void { if (closed) return; closed = true; db?.close(); db = undefined },
  }
}

export type LocalAlbumArtworkQueue = ReturnType<typeof createLocalAlbumArtworkQueue>
