import { DatabaseSync } from 'node:sqlite';
import { parentPort, workerData } from 'node:worker_threads';
import { createLocalCatalogStore, verifyLocalCatalogDatabase } from '../local-catalog-store.js';
import { verifyLocalScanDatabase } from '../local-scan-store.js';
import { LocalAlbumReadError } from './grouping.js';
import { mobileSqlFileIdentity } from './mobile-sql-worker.js';
import { isMobileStructurePage } from './mobile-structure.js';
import { isArtistIndexCandidatePage } from './artist-index-candidates.js';
import { isCommandOutboxDatasetId } from '@music-bridge/contracts';
import type { LocalAlbumLyricsInventory, LocalAlbumSqlMobileQuery, LocalAlbumSqlScope } from './sql-types.js';

if (!parentPort) throw new Error('移动结构查询缺少原 Owner 端口。');
const port = parentPort;
const send = (message: unknown) => port.postMessage(message);
const exact = (value: unknown, keys: readonly string[]): value is Record<string, unknown> => !!value && typeof value === 'object'
  && Reflect.ownKeys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const warmQuery: LocalAlbumSqlMobileQuery = { kind: 'groups', offset: 0, limit: 1, query: '', rootId: null, albumKey: null, trackId: null, editionId: null, groupHash: null };
type Point = { changes: number; version: number; schema: number; userVersion: number };
type Input = { jobId: number; kind: 'prepare' | 'read'; scope: LocalAlbumSqlScope & { lyricsRevision?: string }; request: LocalAlbumSqlMobileQuery | null; cancellation: SharedArrayBuffer };
const same = (left: Point, right: Point) => left.changes === right.changes && left.version === right.version && left.schema === right.schema && left.userVersion === right.userVersion;
let db: DatabaseSync | undefined, cancellation: Int32Array | undefined;
let active: Input | undefined, jobCancellation: Int32Array | undefined, audited: Point | undefined, preparedScope: string | undefined;
let store: ReturnType<typeof createLocalCatalogStore> | undefined, closing = false, transaction = false, lastJobId = 0;
let indexDatasetId: string | undefined, currentLyrics: LocalAlbumLyricsInventory | undefined;
let finish!: () => void;
const lifetime = new Promise<void>(resolve => { finish = resolve; });
const unavailable = () => new LocalAlbumReadError('UNAVAILABLE', '移动结构只读连接未通过原核验。');
const changed = () => new LocalAlbumReadError('SNAPSHOT_CHANGED', '移动结构查询已撤销或水位改变。');
// 对象作者跨作业稳定以复用原 Compact；实际库存 view 仅存在于本次同步、已审计事务。
const indexLyrics: LocalAlbumLyricsInventory = {
  revision() { assertCurrent(); if (!currentLyrics) throw changed(); return currentLyrics.revision(); },
  read(trackId, rootId, fileRevision) { assertCurrent(); if (!currentLyrics) throw changed(); return currentLyrics.read(trackId, rootId, fileRevision); },
};
// 所有reader共用同一个函数作者；当前作业的SAB只由本同步任务委托，不保存旧作用域许可。
function assertCurrent(): void {
  if (!active || !jobCancellation || Atomics.load(jobCancellation, 0) !== 0 || !cancellation || Atomics.load(cancellation, 0) !== 0) throw changed();
}
function point(): Point {
  if (!db || db.prepare('PRAGMA query_only').get()?.query_only !== 1 || db.prepare('PRAGMA trusted_schema').get()?.trusted_schema !== 0
    || db.prepare('PRAGMA foreign_keys').get()?.foreign_keys !== 1) throw unavailable();
  const row = db.prepare('SELECT total_changes() changes,(SELECT data_version FROM pragma_data_version) version,(SELECT schema_version FROM pragma_schema_version) schema,(SELECT user_version FROM pragma_user_version) userVersion').get();
  if (!row || !['changes', 'version', 'schema', 'userVersion'].every(key => typeof row[key] === 'number' && Number.isSafeInteger(row[key]) && Number(row[key]) >= 0)
    || row.userVersion !== 34) throw unavailable();
  return { changes: Number(row.changes), version: Number(row.version), schema: Number(row.schema), userVersion: Number(row.userVersion) };
}
function invalidate(): void { audited = undefined; preparedScope = undefined; store = undefined; }
function shutdown(fatal: boolean): void {
  if (closing) return;
  closing = true;
  if (fatal) send({ type: 'fatal', code: 'UNAVAILABLE' });
  try { if (db?.isTransaction) { db.exec('ROLLBACK'); transaction = false; } } catch { fatal = true; }
  try { if (db) { db.close(); db = undefined; send({ type: 'stage', stage: 'closed' }); } } catch { fatal = true; }
  if (fatal) process.exitCode = 1;
  port.close(); finish();
}
function runJob(input: Input, databaseFile: string, fileIdentity: string): void {
  active = input; jobCancellation = new Int32Array(input.cancellation);
  const stage = (stage: string) => send({ type: 'stage', jobId: input.jobId, stage });
  let result: unknown, succeeded = false, skipped = false, rolledBack = false, fatal = false;
  let code: LocalAlbumReadError['code'] = 'UNAVAILABLE', snapshot: Point | undefined;
  try {
    if (Atomics.load(jobCancellation, 0) !== 0) { skipped = true; throw changed(); }
    assertCurrent();
    if (!db || db.isTransaction || mobileSqlFileIdentity(databaseFile) !== fileIdentity) throw unavailable();
    const before = point();
    db.exec('BEGIN'); transaction = true; stage('begun');
    // 首个SELECT建立当前作业快照；BEGIN之前的data_version不能证明这份实际快照。
    db.prepare('SELECT count(*) FROM sqlite_master').get();
    snapshot = point();
    if (!same(before, snapshot)) { invalidate(); throw changed(); }
    if (!audited || !same(audited, snapshot)) {
      invalidate(); stage('audit-begin');
      verifyLocalCatalogDatabase(db); assertCurrent(); stage('audit-catalog');
      verifyLocalScanDatabase(db); assertCurrent(); stage('audit-scan');
      if (!same(snapshot, point())) throw unavailable();
      audited = snapshot;
    }
    const connection = db;
    store ??= createLocalCatalogStore({
      read: read => { assertCurrent(); const value = read(connection); assertCurrent(); return value; },
      sources: { root() { throw new LocalAlbumReadError('UNAVAILABLE', '结构SQL不能读取Source能力。'); } },
      conflict() { throw new LocalAlbumReadError('UNAVAILABLE', '只读结构事实冲突。'); },
    });
    stage('entered');
    const { lyricsRevision, ...plainScope } = input.scope;
    const scope = { ...plainScope, assertReadActive: assertCurrent }, scopeKey = JSON.stringify(input.scope);
    if (indexDatasetId) {
      if (input.kind !== 'read' || typeof lyricsRevision !== 'string') throw unavailable();
      store.privateWithArtistIndexLyricsRead(indexDatasetId, lyricsRevision, assertCurrent, view => {
        currentLyrics = view;
        try {
          const indexScope = { ...scope, lyricsInventory: indexLyrics };
          if (preparedScope !== scopeKey) {
            const warm = store!.privateAlbumBrowserMobile(warmQuery, indexScope);
            assertCurrent(); if (!isArtistIndexCandidatePage(warm)) throw unavailable();
            preparedScope = scopeKey;
          }
          result = store!.privateAlbumBrowserMobile(input.request!, indexScope);
          assertCurrent(); if (!isArtistIndexCandidatePage(result)) throw unavailable();
        } finally { currentLyrics = undefined; }
      });
    } else {
      if (input.kind === 'prepare' || preparedScope !== scopeKey) {
        const warm = store.privateAlbumBrowserMobileStructure(warmQuery, scope);
        assertCurrent(); if (!isMobileStructurePage(warm)) throw unavailable();
        preparedScope = scopeKey;
      }
      if (input.kind === 'read') {
        result = store.privateAlbumBrowserMobileStructure(input.request!, scope);
        assertCurrent(); if (!isMobileStructurePage(result)) throw unavailable();
      }
    }
    if (!same(snapshot, point()) || mobileSqlFileIdentity(databaseFile) !== fileIdentity) throw changed();
    assertCurrent(); succeeded = true;
  } catch (error) {
    preparedScope = undefined;
    if (error instanceof LocalAlbumReadError) code = error.code;
    else fatal = true;
  } finally {
    try { if (transaction) { db!.exec('ROLLBACK'); transaction = false; rolledBack = true; stage('rollback'); } }
    catch { fatal = true; succeeded = false; }
    try {
      if (db && snapshot && (!same(snapshot, point()) || mobileSqlFileIdentity(databaseFile) !== fileIdentity)) {
        invalidate(); succeeded = false; code = 'SNAPSHOT_CHANGED';
      }
      if (succeeded) assertCurrent();
    } catch (error) { succeeded = false; if (error instanceof LocalAlbumReadError && error.code === 'SNAPSHOT_CHANGED') code = error.code; else fatal = true; }
    if (!succeeded) preparedScope = undefined;
    active = undefined; jobCancellation = undefined;
  }
  if (fatal || !skipped && !rolledBack) { shutdown(true); return; }
  if (skipped) send({ type: 'job-skipped', jobId: input.jobId, code: 'SNAPSHOT_CHANGED' });
  else if (!succeeded) send({ type: 'failure', jobId: input.jobId, code });
  else if (input.kind === 'prepare') send({ type: 'prepared', jobId: input.jobId });
  else send({ type: 'result', jobId: input.jobId, page: result });
}
try {
  const input = workerData as { databaseFile: string; fileIdentity: string; cancellation: SharedArrayBuffer; purpose?: string; datasetId?: string };
  const indexActor = exact(input, ['databaseFile', 'fileIdentity', 'cancellation', 'purpose', 'datasetId'])
    && input.purpose === 'artist-index' && isCommandOutboxDatasetId(input.datasetId);
  if ((!exact(input, ['databaseFile', 'fileIdentity', 'cancellation']) && !indexActor) || typeof input.databaseFile !== 'string' || !input.databaseFile.startsWith('/') || input.databaseFile === ':memory:'
    || typeof input.fileIdentity !== 'string' || !(input.cancellation instanceof SharedArrayBuffer) || input.cancellation.byteLength !== 4
    || mobileSqlFileIdentity(input.databaseFile) !== input.fileIdentity) throw unavailable();
  if (indexActor) indexDatasetId = input.datasetId;
  cancellation = new Int32Array(input.cancellation);
  if (Atomics.load(cancellation, 0) !== 0) { send({ type: 'never-opened', code: 'SNAPSHOT_CHANGED' }); port.close(); finish(); }
  else {
    // 只读打开原库一次；不迁移、不改WAL配置，也不运行任何Owner/Source写工厂。
    db = new DatabaseSync(input.databaseFile, { readOnly: true, enableForeignKeyConstraints: true, allowExtension: false });
    db.exec('PRAGMA query_only=ON;PRAGMA trusted_schema=OFF;PRAGMA busy_timeout=1000');
    point();
    send({ type: 'stage', stage: 'opened' });
    port.on('message', (message: unknown) => {
      if (closing) return;
      if (exact(message, ['type']) && message.type === 'close') { shutdown(false); return; }
      if (!exact(message, ['type', 'jobId', 'kind', 'scope', 'request', 'cancellation']) || message.type !== 'job'
        || message.jobId !== lastJobId + 1 || !['prepare', 'read'].includes(String(message.kind)) || active
        || !(message.cancellation instanceof SharedArrayBuffer) || message.cancellation.byteLength !== 4
        || !message.scope || typeof message.scope !== 'object' || (message.kind === 'prepare') !== (message.request === null)
        || indexDatasetId && (message.kind !== 'read' || !exact(message.scope, ['revision', 'roots', 'nameEnhancements', 'libraryOrganizations', 'lyricsRevision'])
          || typeof message.scope.lyricsRevision !== 'string')
        || Buffer.byteLength(JSON.stringify({ request: message.request, scope: message.scope })) > 2 * 1024 * 1024) { shutdown(true); return; }
      lastJobId = Number(message.jobId);
      runJob(message as unknown as Input, input.databaseFile, input.fileIdentity);
    });
    port.once('messageerror', () => shutdown(true));
    port.once('close', () => { if (!closing) shutdown(true); });
  }
} catch { shutdown(true); }
await lifetime;
