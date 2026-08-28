import { createHash, randomUUID } from 'node:crypto'
import { closeSync, constants, lstatSync, mkdirSync, openSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  COMMAND_OUTBOX_ERROR_CODES, MAX_COMMAND_OUTBOX_ENTRIES, MAX_COMMAND_OUTBOX_TOTAL_BYTES,
  isCollectionId, isCommandOutboxRequest, isCommandOutboxDispatchResult,
  type CommandOutboxRequest, type CommandOutboxView, type CommandOutboxState, type CommandOutboxErrorCode,
} from '@music-bridge/contracts'

export class CommandOutboxError extends Error {
  constructor(readonly code: CommandOutboxErrorCode, readonly outboxId?: string) {
    super(`操作记录暂未确认，请查看待处理操作。 [${code}]`)
  }
}
export type StoredCommandOutboxEntry = CommandOutboxRequest & {
  schemaVersion: 1; id: string; commandId: string; fingerprint: string; createdAt: string
  state: CommandOutboxState; updatedAt: string; acknowledged: boolean; errorCode?: CommandOutboxErrorCode; result?: unknown
}
export interface CommandOutboxConfirmation { entry: StoredCommandOutboxEntry; created: boolean }
const fail = (code: CommandOutboxErrorCode = 'OUTBOX_UNAVAILABLE'): never => { throw new CommandOutboxError(code) }
const legacySchemaObjects = [
  'CREATE TABLE outbox_entries(id TEXT PRIMARY KEY, command_id TEXT NOT NULL UNIQUE, request_json TEXT NOT NULL) STRICT',
  'CREATE TABLE outbox_states(id TEXT PRIMARY KEY REFERENCES outbox_entries(id), state TEXT NOT NULL, updated_at TEXT NOT NULL, acknowledged INTEGER NOT NULL CHECK(acknowledged IN (0,1)), error_code TEXT, result_json TEXT) STRICT',
  "CREATE TRIGGER outbox_entries_no_update BEFORE UPDATE ON outbox_entries BEGIN SELECT RAISE(ABORT,'操作确认不可改写'); END",
  "CREATE TRIGGER outbox_entries_no_delete BEFORE DELETE ON outbox_entries BEGIN SELECT RAISE(ABORT,'操作确认不可删除'); END",
]
const removableState = "((state='succeeded' AND acknowledged=1) OR state='dismissed')"
const schemaObjects = [...legacySchemaObjects.slice(0, 3),
  `CREATE TRIGGER outbox_entries_no_delete BEFORE DELETE ON outbox_entries BEGIN SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM outbox_states WHERE id=OLD.id AND ${removableState}) THEN RAISE(ABORT,'未确认操作不可删除') END; DELETE FROM outbox_states WHERE id=OLD.id; END`,
]
const schema = `${schemaObjects.join(';')}; PRAGMA application_id=1296192088; PRAGMA user_version=2;`
const ownedPaths = new Set<string>()
const states: CommandOutboxState[] = ['pending', 'sending', 'uncertain', 'succeeded', 'rejected', 'dismissed']
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (typeof value === 'object' && value !== null) return `{${Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
  return JSON.stringify(value)
}
const fingerprint = (request: CommandOutboxRequest): string => createHash('sha256').update(canonical(request)).digest('hex')
const date = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value
function verifySchema(db: DatabaseSync): 1 | 2 {
  const version = db.prepare('PRAGMA user_version').get()?.user_version
  if (db.prepare('PRAGMA application_id').get()?.application_id !== 1296192088 || (version !== 1 && version !== 2)) return fail()
  const expected = version === 1 ? legacySchemaObjects : schemaObjects
  const objects = db.prepare("SELECT sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*'").all()
  if (objects.length !== expected.length || objects.some(row => !expected.includes(String(row.sql)))) return fail()
  return version
}
function publicView(entry: StoredCommandOutboxEntry): CommandOutboxView {
  return { id: entry.id, commandId: entry.commandId, command: entry.command, datasetId: entry.datasetId, state: entry.state,
    createdAt: entry.createdAt, updatedAt: entry.updatedAt, acknowledged: entry.acknowledged,
    canRetry: entry.state === 'pending' || entry.state === 'uncertain', ...(entry.errorCode ? { errorCode: entry.errorCode } : {}) }
}

/** Main 私有请求账本；不打开 Core 维护库，也不属于 collection 快照。 */
export function createCommandOutboxStore(options: { filePath: string }) {
  let database: DatabaseSync | undefined, closed = false, ownedPath: string | undefined
  const release = () => { if (ownedPath) ownedPaths.delete(ownedPath); ownedPath = undefined }
  function open(): DatabaseSync {
    if (closed) return fail()
    if (database) return database
    let db: DatabaseSync | undefined
    try {
      let filePath = options.filePath, created = filePath === ':memory:'
      if (!created) {
        if (!path.isAbsolute(filePath) || filePath.includes('\0')) return fail()
        const directory = path.dirname(filePath)
        mkdirSync(directory, { recursive: true, mode: 0o700 })
        if (lstatSync(directory).isSymbolicLink()) return fail()
        filePath = path.join(realpathSync(directory), path.basename(filePath))
        if (ownedPaths.has(filePath)) return fail()
        ownedPaths.add(filePath); ownedPath = filePath
        let exists = false, sidecar = false
        for (const suffix of ['', '-wal', '-shm', '-journal']) {
          try {
            const info = lstatSync(filePath + suffix)
            if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) return fail()
            if (suffix === '') exists = true; else sidecar = true
          } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
        }
        if (exists) {
          const before = lstatSync(filePath, { bigint: true })
          const inspection = new DatabaseSync(filePath, { readOnly: true, allowExtension: false })
          try { inspection.exec('PRAGMA trusted_schema=OFF'); verifySchema(inspection) } finally { inspection.close() }
          const after = lstatSync(filePath, { bigint: true })
          if (after.isSymbolicLink() || after.nlink !== 1n || after.dev !== before.dev || after.ino !== before.ino) return fail()
        } else {
          if (sidecar) return fail()
          const fd = openSync(filePath, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600)
          closeSync(fd); created = true
        }
      }
      db = new DatabaseSync(filePath, { allowExtension: false, enableForeignKeyConstraints: true })
      // 空闲事务间隙仍持有排他锁；进程崩溃由系统释锁，不猜测 PID 或过期时间。
      db.exec('PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=1000; PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE;')
      if (created) db.exec(schema)
      if (verifySchema(db) === 1) {
        for (const row of db.prepare('SELECT id FROM outbox_entries').all()) get(db, String(row.id))
        db.exec(`DROP TRIGGER outbox_entries_no_delete; ${schemaObjects[3]}; PRAGMA user_version=2;`)
      }
      db.prepare("UPDATE outbox_states SET state='uncertain',error_code='OUTBOX_RESULT_UNKNOWN',updated_at=? WHERE state='sending'").run(new Date().toISOString())
      db.exec('COMMIT; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;')
      database = db; return db
    } catch { try { db?.close() } finally { release() }; return fail() }
  }
  function read<T>(fn: (db: DatabaseSync) => T): T {
    try { return fn(open()) } catch (error) { if (error instanceof CommandOutboxError) throw error; return fail() }
  }
  function transaction<T>(fn: (db: DatabaseSync) => T): T {
    return read(db => { db.exec('BEGIN IMMEDIATE'); try { const result = fn(db); db.exec('COMMIT'); return result } catch (error) { db.exec('ROLLBACK'); throw error } })
  }
  function get(db: DatabaseSync, id: string): StoredCommandOutboxEntry {
    if (!isCollectionId(id)) return fail('OUTBOX_CONFLICT')
    const row = db.prepare('SELECT e.request_json,e.command_id,s.* FROM outbox_entries e JOIN outbox_states s ON s.id=e.id WHERE e.id=?').get(id)
    if (!row) return fail('OUTBOX_CONFLICT')
    const value = JSON.parse(String(row.request_json)) as StoredCommandOutboxEntry
    const request = { datasetId: value.datasetId, command: value.command, payload: value.payload }
    if (Object.keys(value).sort().join(',') !== 'command,commandId,createdAt,datasetId,fingerprint,id,payload,schemaVersion'
      || !isCommandOutboxRequest(request) || value.schemaVersion !== 1 || value.id !== id || value.commandId !== row.command_id
      || value.commandId !== request.payload.commandId || value.fingerprint !== fingerprint(request) || !date(value.createdAt)
      || !states.includes(row.state as CommandOutboxState) || !date(row.updated_at) || ![0, 1].includes(Number(row.acknowledged))
      || (row.error_code !== null && !COMMAND_OUTBOX_ERROR_CODES.includes(row.error_code as CommandOutboxErrorCode))) return fail()
    const result = row.result_json === null ? undefined : JSON.parse(String(row.result_json)) as unknown
    if ((row.state === 'succeeded' && row.result_json === null) || (row.result_json !== null && !isCommandOutboxDispatchResult({ command: value.command, result }))) return fail()
    return { ...value, state: row.state as CommandOutboxState, updatedAt: String(row.updated_at), acknowledged: row.acknowledged === 1,
      ...(row.error_code !== null ? { errorCode: row.error_code as CommandOutboxErrorCode } : {}), ...(row.result_json !== null ? { result } : {}) }
  }
  function bytes(db: DatabaseSync): number {
    return Number(db.prepare('SELECT COALESCE(sum(length(CAST(request_json AS BLOB))),0) n FROM outbox_entries').get()?.n)
      + Number(db.prepare('SELECT COALESCE(sum(length(CAST(result_json AS BLOB))),0) n FROM outbox_states').get()?.n)
  }
  /** 仅为本次写入腾空间；清理与新写同事务，空间仍不足时一并回滚。 */
  function purgeTerminal(db: DatabaseSync, additionalBytes: number, additionalEntries: number, protectedIds: ReadonlySet<string> = new Set()): void {
    let count = Number(db.prepare('SELECT count(*) n FROM outbox_entries').get()?.n), total = bytes(db)
    const fits = () => count + additionalEntries <= MAX_COMMAND_OUTBOX_ENTRIES && total + additionalBytes <= MAX_COMMAND_OUTBOX_TOTAL_BYTES
    if (fits()) return
    const candidates = db.prepare(`SELECT e.id,length(CAST(e.request_json AS BLOB))+COALESCE(length(CAST(s.result_json AS BLOB)),0) bytes FROM outbox_entries e JOIN outbox_states s ON s.id=e.id WHERE ${removableState} ORDER BY s.updated_at,e.rowid`).all()
    for (const row of candidates) {
      if (fits()) break
      if (protectedIds.has(String(row.id))) continue
      const entry = get(db, String(row.id))
      if (entry.state !== 'dismissed' && !(entry.state === 'succeeded' && entry.acknowledged)) return fail()
      // 触发器再次检查终态，并只删除这条outbox的状态；不触碰业务幂等账本或文件。
      db.prepare('DELETE FROM outbox_entries WHERE id=?').run(entry.id)
      count--; total -= Number(row.bytes)
    }
    if (!fits()) return fail('OUTBOX_LIMIT_EXCEEDED')
  }
  function update(db: DatabaseSync, entry: StoredCommandOutboxEntry, state: CommandOutboxState, errorCode?: CommandOutboxErrorCode): StoredCommandOutboxEntry {
    db.prepare('UPDATE outbox_states SET state=?,updated_at=?,error_code=? WHERE id=?').run(state, new Date().toISOString(), errorCode ?? null, entry.id)
    return get(db, entry.id)
  }
  function priorConfirmation(db: DatabaseSync, request: CommandOutboxRequest, digest: string): CommandOutboxConfirmation | undefined {
    const prior = db.prepare('SELECT id FROM outbox_entries WHERE command_id=?').get(request.payload.commandId)
    if (!prior) return undefined
    const entry = get(db, String(prior.id))
    if (entry.fingerprint !== digest) return fail('OUTBOX_CONFLICT')
    return { entry, created: false }
  }
  function confirmInTransaction(db: DatabaseSync, request: CommandOutboxRequest, digest: string, protectedIds?: ReadonlySet<string>): CommandOutboxConfirmation {
    const prior = priorConfirmation(db, request, digest)
    if (prior) return prior
    const entry = { ...request, schemaVersion: 1 as const, id: randomUUID(), commandId: request.payload.commandId, fingerprint: digest, createdAt: new Date().toISOString() }
    const encoded = JSON.stringify(entry)
    purgeTerminal(db, Buffer.byteLength(encoded), 1, protectedIds)
    db.prepare('INSERT INTO outbox_entries VALUES(?,?,?)').run(entry.id, entry.commandId, encoded)
    db.prepare("INSERT INTO outbox_states VALUES(?,'pending',?,0,NULL,NULL)").run(entry.id, entry.createdAt)
    return { entry: get(db, entry.id), created: true }
  }
  const api = {
    confirm(input: CommandOutboxRequest): CommandOutboxConfirmation {
      if (!isCommandOutboxRequest(input)) return fail('INVALID_IPC_REQUEST')
      const request = structuredClone(input), digest = fingerprint(request)
      return transaction(db => confirmInTransaction(db, request, digest))
    },
    confirmBatch(inputs: readonly CommandOutboxRequest[]): readonly CommandOutboxConfirmation[] {
      if (!Array.isArray(inputs) || inputs.length < 1 || inputs.length > 3
        || !Array.from(inputs).every(request => isCommandOutboxRequest(request) && request.command === 'recordingPrepared.revoke')) return fail('INVALID_IPC_REQUEST')
      const requests = structuredClone(inputs) as readonly Extract<CommandOutboxRequest, { command: 'recordingPrepared.revoke' }>[]
      if (!requests.every(request => request.datasetId === requests[0]!.datasetId)
        || new Set(requests.map(request => request.payload.commandId)).size !== requests.length
        || new Set(requests.map(request => request.payload.id)).size !== requests.length) return fail('INVALID_IPC_REQUEST')
      const digests = requests.map(fingerprint)
      return transaction(db => {
        // 先复核整批既有指纹，尾项冲突不能留下前项；容量清理不能删掉本批要返回的旧回执。
        const prior = requests.map((request, index) => priorConfirmation(db, request, digests[index]!))
        const protectedIds = new Set(prior.flatMap(value => value ? [value.entry.id] : []))
        return requests.map((request, index) => prior[index] ?? confirmInTransaction(db, request, digests[index]!, protectedIds))
      })
    },
    get(id: string): StoredCommandOutboxEntry { return read(db => get(db, id)) },
    list(): CommandOutboxView[] { return read(db => db.prepare('SELECT id FROM outbox_entries ORDER BY rowid DESC').all().map(row => publicView(get(db, String(row.id))))) },
    markSending(id: string): StoredCommandOutboxEntry { return transaction(db => { const entry = get(db, id); if (!['pending', 'uncertain'].includes(entry.state)) return fail('OUTBOX_CONFLICT'); return update(db, entry, 'sending') }) },
    markUncertain(id: string, code: CommandOutboxErrorCode = 'OUTBOX_RESULT_UNKNOWN'): StoredCommandOutboxEntry {
      if (!COMMAND_OUTBOX_ERROR_CODES.includes(code)) return fail('OUTBOX_CONFLICT')
      return transaction(db => { const entry = get(db, id); if (!['pending', 'sending', 'uncertain'].includes(entry.state)) return fail('OUTBOX_CONFLICT'); return update(db, entry, 'uncertain', code) })
    },
    reject(id: string, code: CommandOutboxErrorCode): StoredCommandOutboxEntry {
      if (!COMMAND_OUTBOX_ERROR_CODES.includes(code)) return fail('OUTBOX_CONFLICT')
      return transaction(db => { const entry = get(db, id); if (entry.state !== 'sending') return fail('OUTBOX_CONFLICT'); return update(db, entry, 'rejected', code) })
    },
    succeed(id: string, result: unknown): StoredCommandOutboxEntry {
      return transaction(db => {
        const entry = get(db, id)
        if (entry.state !== 'sending' || !isCommandOutboxDispatchResult({ command: entry.command, result })) return fail('OUTBOX_RESULT_UNKNOWN')
        const encoded = JSON.stringify(result)
        purgeTerminal(db, Buffer.byteLength(encoded), 0)
        db.prepare('UPDATE outbox_states SET result_json=? WHERE id=?').run(encoded, id)
        return update(db, entry, 'succeeded')
      })
    },
    ack(id: string): CommandOutboxView { return transaction(db => { const entry = get(db, id); if (entry.state !== 'succeeded') return fail('OUTBOX_CONFLICT'); db.prepare('UPDATE outbox_states SET acknowledged=1,updated_at=? WHERE id=?').run(new Date().toISOString(), id); return publicView(get(db, id)) }) },
    dismiss(id: string): CommandOutboxView { return transaction(db => { const entry = get(db, id); if (entry.state === 'sending') return fail('OUTBOX_CONFLICT'); if (entry.state === 'succeeded') return fail('OUTBOX_CONFLICT'); return publicView(update(db, entry, 'dismissed')) }) },
    recoverInterrupted(): void { read(() => undefined) },
    close(): void { if (closed) return; closed = true; try { database?.close() } finally { database = undefined; release() } },
  }
  return api
}
export type CommandOutboxStore = ReturnType<typeof createCommandOutboxStore>
