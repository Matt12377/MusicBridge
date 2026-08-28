import { createHash, randomUUID } from 'node:crypto';
import { constants, closeSync, lstatSync, mkdirSync, openSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { BACKUP_INDEX_MISSING_FACTS, isAuthorizeBackupRoot, isBackupRootView, isStartBackupJob, isBackupJobView, isCollectionId, type StartBackupJob, type BackupJobView, type BackupJobIssue, type AuthorizeBackupRoot, type BackupOverview, type BackupRootView } from '@music-bridge/contracts';
import type { RootCapability } from './source-files.js';
import { createRestoreActivationStore, restoreActivationSchema, restoreActivationSchemaObjects, RestoreActivationError, type RestoreActivationStore } from './restore-activation-store.js';
import { createDatasetIdentityStore, datasetIdentitySchemaObjects } from './dataset-identity.js';

export class BackupWorkflowError extends Error {
  constructor(readonly code: 'BACKUP_CONFLICT' | 'BACKUP_UNAVAILABLE') {
    super(code === 'BACKUP_CONFLICT' ? '备份操作与已有确认不一致，请刷新后重试。' : '备份维护数据暂时不可用，原有文件不会被自动覆盖或删除。');
  }
}
const conflict = (): never => { throw new BackupWorkflowError('BACKUP_CONFLICT'); };
const unavailable = (): never => { throw new BackupWorkflowError('BACKUP_UNAVAILABLE'); };
const fingerprint = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
interface StoredJob { request: StartBackupJob; view: BackupJobView; output?: RootCapability }
interface StoredRoot { view: BackupRootView; capability: RootCapability }
const schemaObjects = [
  'CREATE TABLE backup_roots(id TEXT PRIMARY KEY, data TEXT NOT NULL) STRICT',
  'CREATE TABLE backup_commands(command_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, result_id TEXT NOT NULL, action TEXT NOT NULL) STRICT',
  'CREATE TABLE backup_jobs(id TEXT PRIMARY KEY, data TEXT NOT NULL) STRICT',
  "CREATE TRIGGER backup_commands_no_update BEFORE UPDATE ON backup_commands BEGIN SELECT RAISE(ABORT,'备份确认账本不可改写'); END",
  "CREATE TRIGGER backup_commands_no_delete BEFORE DELETE ON backup_commands BEGIN SELECT RAISE(ABORT,'备份确认账本不可删除'); END",
];
const schema = `${schemaObjects.join(';\n')};
PRAGMA application_id=1296192087;
PRAGMA user_version=1;
`;
const ownedPaths = new Set<string>();

function verifySchema(db: DatabaseSync): 1 | 2 | 3 {
  const version = db.prepare('PRAGMA user_version').get()?.user_version;
  if ((version !== 1 && version !== 2 && version !== 3) || db.prepare('PRAGMA application_id').get()?.application_id !== 1296192087) return unavailable();
  const expected = [...schemaObjects, ...(version >= 2 ? restoreActivationSchemaObjects : []), ...(version >= 3 ? datasetIdentitySchemaObjects : [])];
  const objects = db.prepare("SELECT sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*'").all();
  if (objects.length !== expected.length || objects.some(row => !expected.includes(String(row.sql)))) return unavailable();
  return version;
}

function legacyJobUpdates(db: DatabaseSync): { id: string; data: string }[] {
  const updates: { id: string; data: string }[] = [];
  for (const row of db.prepare('SELECT id,data FROM backup_jobs').all()) {
    const value = JSON.parse(String(row.data)) as StoredJob;
    const index = value.view?.index;
    const legacyKeys = ['operationCount', 'quarantinedCount', 'issueCount', 'historyTrusted', 'inventoryReconstructed'];
    const legacy = index && Object.keys(index).length === legacyKeys.length && Object.keys(index).every(key => legacyKeys.includes(key));
    if (legacy) {
      // 旧回执仅保存聚合计数；缺失的明细如实计入省略数，不能合成对象或历史事实。
      value.view.index = { ...index, issueDetails: [], issueDetailsOmittedCount: index.issueCount, missingFacts: [...BACKUP_INDEX_MISSING_FACTS] };
    }
    if (!isStartBackupJob(value.request) || !isBackupJobView(value.view) || value.view.id !== row.id) return unavailable();
    if (legacy) updates.push({ id: String(row.id), data: JSON.stringify(value) });
  }
  return updates;
}

/** 独立于 collection 快照，恢复旧工作库不会回滚目录授权与操作回执。 */
export function createBackupWorkflowStore(options: { filePath: string }) {
  let database: DatabaseSync | undefined, closed = false;
  let ownedPath: string | undefined;
  function releaseOwnership(): void {
    if (ownedPath) ownedPaths.delete(ownedPath);
    ownedPath = undefined;
  }
  function open(): DatabaseSync {
    if (closed) return unavailable();
    if (database) return database;
    let db: DatabaseSync | undefined;
    try {
      let filePath = options.filePath, created = filePath === ':memory:';
      if (filePath !== ':memory:') {
        if (!path.isAbsolute(filePath)) return unavailable();
        const directory = path.dirname(filePath);
        mkdirSync(directory, { recursive: true, mode: 0o700 });
        if (lstatSync(directory).isSymbolicLink()) return unavailable();
        filePath = path.join(realpathSync(directory), path.basename(filePath));
        if (ownedPaths.has(filePath)) return unavailable();
        ownedPaths.add(filePath); ownedPath = filePath;
        let existing = false, hasSidecar = false;
        for (const suffix of ['', '-wal', '-shm', '-journal']) {
          try {
            const info = lstatSync(filePath + suffix);
            if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) return unavailable();
            if (suffix === '') existing = true; else hasSidecar = true;
          } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        }
        if (existing) {
          // 已有文件必须先只读识别；空文件、空 SQLite 和相似表名均不是初始化授权。
          const inspection = new DatabaseSync(filePath, { readOnly: true, allowExtension: false });
          try {
            inspection.exec('PRAGMA trusted_schema=OFF;');
            if (verifySchema(inspection) === 1) legacyJobUpdates(inspection);
          }
          finally { inspection.close(); }
        } else {
          if (hasSidecar) return unavailable();
          const fd = openSync(filePath, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
          closeSync(fd); created = true;
        }
      }
      db = new DatabaseSync(filePath, { allowExtension: false, enableForeignKeyConstraints: true });
      // 在首次访问前启用连接生命周期排他，事务间隙也不释放；崩溃由系统释放，无 PID/超时抢锁。
      db.exec('PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=1000; PRAGMA locking_mode=EXCLUSIVE;');
      db.exec('BEGIN EXCLUSIVE');
      if (created) db.exec(schema);
      if (verifySchema(db) === 1) {
        const updates = legacyJobUpdates(db);
        db.exec(restoreActivationSchema);
        for (const value of updates) db.prepare('UPDATE backup_jobs SET data=? WHERE id=?').run(value.data, value.id);
        db.exec('PRAGMA user_version=2');
      }
      if (verifySchema(db) === 2) db.exec(`${datasetIdentitySchemaObjects.join(';')}; PRAGMA user_version=3;`);
      db.exec('COMMIT');
      db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
      database = db; return db;
    } catch (error) {
      try { db?.close(); } finally { releaseOwnership(); }
      throw error;
    }
  }
  function read<T>(fn: (db: DatabaseSync) => T): T {
    try { return fn(open()); }
    catch (error) { if (error instanceof BackupWorkflowError) throw error; if (error instanceof RestoreActivationError) throw new BackupWorkflowError(error.code); return unavailable(); }
  }
  function transaction<T>(fn: (db: DatabaseSync) => T): T {
    return read(db => { db.exec('BEGIN IMMEDIATE'); try { const result = fn(db); db.exec('COMMIT'); return result; } catch (error) { db.exec('ROLLBACK'); throw error; } });
  }
  function root(db: DatabaseSync, id: string): StoredRoot {
    const row = db.prepare('SELECT data FROM backup_roots WHERE id=?').get(id); if (!row) return conflict();
    const value = JSON.parse(String(row.data)) as StoredRoot;
    if (!isBackupRootView(value.view) || value.view.id !== id) return unavailable(); return value;
  }
  function job(db: DatabaseSync, id: string): StoredJob {
    const row = db.prepare('SELECT data FROM backup_jobs WHERE id=?').get(id); if (!row) return conflict();
    const value = JSON.parse(String(row.data)) as StoredJob;
    if (!isStartBackupJob(value.request) || !isBackupJobView(value.view) || value.view.id !== id) return unavailable(); return value;
  }
  function saveJob(db: DatabaseSync, value: StoredJob): void {
    if (!isBackupJobView(value.view)) return unavailable();
    db.prepare('INSERT INTO backup_jobs VALUES (?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(value.view.id, JSON.stringify(value));
  }
  function receipt(db: DatabaseSync, commandId: string, digest: string, action: string): string | undefined {
    const row = db.prepare('SELECT fingerprint,result_id,action FROM backup_commands WHERE command_id=?').get(commandId);
    if (!row) return undefined; if (row.fingerprint !== digest || row.action !== action) return conflict(); return String(row.result_id);
  }
  function recordCommand(db: DatabaseSync, commandId: string, digest: string, id: string, action: string): void {
    db.prepare('INSERT INTO backup_commands VALUES (?,?,?,?)').run(commandId, digest, id, action);
  }
  const active = (view: BackupJobView): boolean => view.state === 'queued' || view.state === 'running' || view.state === 'cancelling';
  const activations: RestoreActivationStore = createRestoreActivationStore({ read, transaction });
  return {
    datasetIdentities: createDatasetIdentityStore({ read, transaction }),
    activations,
    overview(): BackupOverview { return read(db => ({ roots: db.prepare('SELECT id FROM backup_roots ORDER BY rowid DESC').all().map(row => root(db, String(row.id)).view), jobs: db.prepare('SELECT id FROM backup_jobs ORDER BY rowid DESC LIMIT 100').all().map(row => job(db, String(row.id)).view), activations: activations.overview().activations })); },
    authorize(command: AuthorizeBackupRoot, capability: RootCapability): BackupRootView {
      const view: BackupRootView = { id: capability.id, kind: command.kind, label: capability.label, authorized: true };
      if (!isAuthorizeBackupRoot(command) || !isBackupRootView(view) || !capability.authorized || !path.isAbsolute(capability.path) || !/^\d+$/u.test(capability.dev) || !/^\d+$/u.test(capability.ino)) return conflict();
      return transaction(db => {
        const digest = fingerprint([command.kind, capability.path, capability.dev, capability.ino, capability.label]);
        const previous = receipt(db, command.commandId, digest, 'authorize');
        if (previous) return root(db, previous).view;
        if (Number(db.prepare('SELECT count(*) n FROM backup_roots').get()?.n) >= 100) return conflict();
        db.prepare('INSERT INTO backup_roots VALUES (?,?)').run(view.id, JSON.stringify({ view, capability }));
        recordCommand(db, command.commandId, digest, view.id, 'authorize');
        return view;
      });
    },
    authorizationReceipt(commandId: string): BackupRootView | undefined {
      return read(db => { const row = db.prepare('SELECT result_id,action FROM backup_commands WHERE command_id=?').get(commandId); if (row && row.action !== 'authorize') return conflict(); return row ? root(db, String(row.result_id)).view : undefined; });
    },
    root(id: string): StoredRoot { return read(db => root(db, id)); },
    job(id: string): StoredJob { return read(db => job(db, id)); },
    startJob(request: StartBackupJob): BackupJobView {
      if (!isStartBackupJob(request)) return conflict();
      return transaction(db => {
        const digest = fingerprint([request.kind, request.rootId, request.kind === 'backup' ? request.mode : null, request.kind === 'restore' ? [request.destinationId,request.verificationId] : null]);
        const previous = receipt(db, request.commandId, digest, 'start'); if (previous) return job(db, previous).view;
        const source = root(db, request.rootId);
        if (!source.view.authorized || source.view.kind !== (request.kind === 'backup' ? 'backup-destination' : 'backup-source')) return conflict();
        if (request.kind === 'restore') {
          const target = root(db, request.destinationId), verified = job(db, request.verificationId);
          if (!target.view.authorized || target.view.kind !== 'restore-destination' || verified.view.kind !== 'verify' || verified.view.state !== 'succeeded' || verified.view.rootId !== request.rootId) return conflict();
        }
        if (Number(db.prepare('SELECT count(*) n FROM backup_jobs').get()?.n) >= 1000) return conflict();
        const view: BackupJobView = { id: randomUUID(), kind: request.kind, rootId: request.rootId, state: 'queued', createdAt: new Date().toISOString(), ...(request.kind === 'backup' ? { mode: request.mode } : {}), ...(request.kind === 'restore' ? { destinationId: request.destinationId } : {}) };
        saveJob(db, { request, view }); recordCommand(db, request.commandId, digest, view.id, 'start'); return view;
      });
    },
    markRunning(id: string): BackupJobView {
      return transaction(db => { const value = job(db, id); if (value.view.state === 'queued') { value.view.state = 'running'; saveJob(db, value); } return value.view; });
    },
    finish(id: string, result: Pick<BackupJobView, 'summary' | 'index'>, output?: RootCapability): BackupJobView {
      return transaction(db => {
        const value = job(db, id); if (!active(value.view)) return value.view;
        value.view = { ...value.view, state: 'succeeded', ...result };
        if (output) value.output = output;
        if (value.view.kind === 'backup') {
          if (!output || Number(db.prepare('SELECT count(*) n FROM backup_roots').get()?.n) >= 100) return conflict();
          const view: BackupRootView = { id: value.view.id, kind: 'backup-source', label: output.label, authorized: true };
          db.prepare('INSERT INTO backup_roots VALUES (?,?)').run(view.id, JSON.stringify({ view, capability: { ...output, id: view.id } }));
          value.view.resultRootId = view.id;
        }
        saveJob(db, value); return value.view;
      });
    },
    failJob(id: string, issue: BackupJobIssue): BackupJobView {
      return transaction(db => { const value = job(db, id); if (active(value.view)) { value.view.state = issue === 'CANCELLED' ? 'cancelled' : issue === 'INTERRUPTED' ? 'interrupted' : 'failed'; value.view.issue = issue; saveJob(db, value); } return value.view; });
    },
    cancel(request: { commandId: string; id: string }): BackupJobView {
      if (!isCollectionId(request.commandId) || !isCollectionId(request.id)) return conflict();
      return transaction(db => {
        const digest = fingerprint(['cancel', request.id]), previous = receipt(db, request.commandId, digest, 'cancel');
        if (previous) return job(db, previous).view;
        const value = job(db, request.id);
        if (value.view.state === 'queued') { value.view.state = 'cancelled'; value.view.issue = 'CANCELLED'; saveJob(db, value); }
        else if (value.view.state === 'running') { value.view.state = 'cancelling'; saveJob(db, value); }
        recordCommand(db, request.commandId, digest, request.id, 'cancel'); return value.view;
      });
    },
    revoke(request: { commandId: string; id: string }): BackupRootView {
      if (!isCollectionId(request.commandId) || !isCollectionId(request.id)) return conflict();
      return transaction(db => {
        const digest = fingerprint(['revoke', request.id]), previous = receipt(db, request.commandId, digest, 'revoke'); if (previous) return root(db, previous).view;
        const value = root(db, request.id); value.view.authorized = false; value.capability.authorized = false;
        db.prepare('UPDATE backup_roots SET data=? WHERE id=?').run(JSON.stringify(value), request.id);
        recordCommand(db, request.commandId, digest, request.id, 'revoke'); return value.view;
      });
    },
    recoverInterrupted(): void {
      transaction(db => { for (const row of db.prepare('SELECT id FROM backup_jobs').all()) { const value = job(db, String(row.id)); if (active(value.view)) { value.view.state = 'interrupted'; value.view.issue = 'INTERRUPTED'; saveJob(db, value); } } });
    },
    close(): void {
      if (closed) return;
      database?.close(); database = undefined;
      releaseOwnership(); closed = true;
    },
  };
}
export type BackupWorkflowStore = ReturnType<typeof createBackupWorkflowStore>;
