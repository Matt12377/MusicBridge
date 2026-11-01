import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { lstat, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import { deserialize, serialize } from 'node:v8';
import { captureLocalCatalogAuditState, restoreLocalCatalogAuditState, clearLocalCatalogAuditState, copyLocalAuditSnapshotData } from './local-catalog-store.js';
import { captureLocalScanAuditState, restoreLocalScanAuditState, clearLocalScanAuditState } from './local-scan-store.js';
import { captureLocalAlbumStartupState, restoreLocalAlbumStartupState } from './local-album-browser/sql-read.js';
import { logLibraryOperation } from '../shared/library-operation-log.js';

declare const __MUSIC_BRIDGE_LOCAL_AUDIT_VERSION__: string;
const magic = Buffer.from('MOUSA_LOCAL_AUDIT_V1\n');
const maximumPayload = 128 * 1024 * 1024;
const maximumHeader = 4096;
const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const digestPattern = /^[a-f0-9]{64}$/u;
type FileStamp = { device: string; inode: string; size: string; modified: string; changed: string };
type DatabaseStamp = { database: FileStamp; wal: FileStamp | null };
type Point = { changes: number; version: number; schema: number; userVersion: number };
export interface PreparedLocalStartupAudit {
  implementation: string;
  runtime: string;
  databaseStamp: DatabaseStamp;
  cacheStamp: FileStamp;
  cacheDigest: string;
  payloadSha256: string;
  fingerprint: string;
  catalog: unknown;
  scan: unknown;
  compact: unknown;
}
export interface LocalStartupAuditCacheOptions { implementationVersion?: string }
type AuditState = Pick<PreparedLocalStartupAudit, 'catalog' | 'scan' | 'compact'>;
type SavedAnchor = Omit<PreparedLocalStartupAudit, keyof AuditState> & { file: string; point: Point };
const savedAnchors = new WeakMap<DatabaseSync, SavedAnchor>();

export function localStartupAuditImplementation(): string | undefined {
  return typeof __MUSIC_BRIDGE_LOCAL_AUDIT_VERSION__ === 'string' && digestPattern.test(__MUSIC_BRIDGE_LOCAL_AUDIT_VERSION__)
    ? __MUSIC_BRIDGE_LOCAL_AUDIT_VERSION__ : undefined;
}
const implementationFor = (options: LocalStartupAuditCacheOptions) => options.implementationVersion ?? localStartupAuditImplementation();
const runtime = () => `${process.versions.v8}/${process.versions.sqlite}`;
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
function stampFile(file: string): FileStamp {
  const info = lstatSync(file, { bigint: true });
  if (!info.isFile() || info.nlink !== 1n || realpathSync(file) !== file) throw new Error('核验缓存的数据库文件身份无效。');
  return { device: String(info.dev), inode: String(info.ino), size: String(info.size), modified: String(info.mtimeNs), changed: String(info.ctimeNs) };
}
function databaseStamp(file: string): DatabaseStamp {
  const database = stampFile(file);
  let wal: FileStamp | null = null;
  try {
    const current = stampFile(file + '-wal');
    // 未写入任何帧的空 WAL 与不存在的 WAL 代表相同的物理水位。
    if (BigInt(current.size) > 32n) wal = current;
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  return { database, wal };
}
function point(db: DatabaseSync): Point {
  const value = db.prepare('SELECT total_changes() changes,(SELECT data_version FROM pragma_data_version) version,(SELECT schema_version FROM pragma_schema_version) schema,(SELECT user_version FROM pragma_user_version) userVersion').get();
  if (!value || !['changes', 'version', 'schema', 'userVersion'].every(key => Number.isSafeInteger(value[key]) && Number(value[key]) >= 0)) throw new Error('核验缓存的数据库水位无效。');
  return { changes: Number(value.changes), version: Number(value.version), schema: Number(value.schema), userVersion: Number(value.userVersion) };
}
function locations(file: string) {
  if (!path.isAbsolute(file) || file === ':memory:') throw new Error('核验缓存只适用于本机工作库。');
  const directory = path.join(path.dirname(file), '.mousa-startup-audit');
  return { directory, cache: path.join(directory, hash(file) + '.bin') };
}
function cacheStamp(file: string): FileStamp {
  const info = lstatSync(file);
  if ((info.mode & 0o077) !== 0 || typeof process.getuid === 'function' && info.uid !== process.getuid()
    || info.size > maximumPayload + maximumHeader + magic.length + 4) throw new Error('核验缓存大小或权限无效。');
  return stampFile(file);
}
function cacheMatches(file: string, candidate: Pick<PreparedLocalStartupAudit, 'cacheStamp' | 'cacheDigest'>): boolean {
  try {
    const cache = locations(file).cache, before = cacheStamp(cache);
    return same(before, candidate.cacheStamp) && hash(readFileSync(cache)) === candidate.cacheDigest && same(before, cacheStamp(cache));
  } catch { return false; }
}
function captureState(db: DatabaseSync): AuditState | undefined {
  const catalog = captureLocalCatalogAuditState(db), scan = captureLocalScanAuditState(db);
  return catalog && scan ? { catalog, scan, compact: captureLocalAlbumStartupState(db) ?? null } : undefined;
}
function anchorCurrent(db: DatabaseSync, file: string, anchor: SavedAnchor, implementation: string): boolean {
  return anchor.file === file && anchor.implementation === implementation && anchor.runtime === runtime()
    && same(anchor.point, point(db)) && same(anchor.databaseStamp, databaseStamp(file));
}
/** 只在同一活连接仍匹配已核内容锚点时交付纯副本，不给新物理水位重新盖章。 */
export function captureLocalStartupAuditForActor(db: DatabaseSync, file: string, options: LocalStartupAuditCacheOptions = {}): PreparedLocalStartupAudit | undefined {
  const anchor = savedAnchors.get(db), implementation = implementationFor(options);
  if (!anchor || !implementation || db.isTransaction) return undefined;
  try {
    if (!anchorCurrent(db, file, anchor, implementation) || !cacheMatches(file, anchor)) throw new Error('原核验锚点已变化。');
    const state = captureState(db);
    if (!state) throw new Error('原核验状态已过期。');
    const { file: _file, point: _point, ...identity } = anchor;
    const result = copyLocalAuditSnapshotData({ ...identity, ...state });
    if (!anchorCurrent(db, file, anchor, implementation) || !same(anchor.cacheStamp, cacheStamp(locations(file).cache))) throw new Error('交付期间原锚点已变化。');
    return result;
  } catch { return undefined; }
}
/** Worker启动数据只接受原Owner的有界纯快照；实际作业事务还会再次核对物理水位。 */
export function acceptLocalStartupAuditFromOwner(file: string, input: unknown, options: LocalStartupAuditCacheOptions = {}): PreparedLocalStartupAudit | undefined {
  if (input === undefined) return undefined;
  try {
    const value = copyLocalAuditSnapshotData(input) as PreparedLocalStartupAudit;
    const fields = ['implementation', 'runtime', 'databaseStamp', 'cacheStamp', 'cacheDigest', 'payloadSha256', 'fingerprint', 'catalog', 'scan', 'compact'];
    const implementation = implementationFor(options);
    if (!value || typeof value !== 'object' || Reflect.ownKeys(value).length !== fields.length || !fields.every(key => Object.hasOwn(value, key))
      || !implementation || value.implementation !== implementation || value.runtime !== runtime()
      || !digestPattern.test(value.fingerprint) || !digestPattern.test(value.cacheDigest) || !digestPattern.test(value.payloadSha256)
      || !same(value.databaseStamp, databaseStamp(file)) || !cacheMatches(file, value)
      || !same(value.databaseStamp, databaseStamp(file))) return undefined;
    return value;
  } catch { return undefined; }
}
async function ensureDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || realpathSync(directory) !== directory || (info.mode & 0o077) !== 0
    || typeof process.getuid === 'function' && info.uid !== process.getuid()) throw new Error('核验缓存目录身份无效。');
}

/** 使用 SQLite 自己的快照处理 WAL；普通 checkpoint 不会改变有效页指纹。 */
async function fingerprint(db: DatabaseSync, directory: string): Promise<string> {
  const started = performance.now();
  logLibraryOperation('cache', 'startup.audit-fingerprint', 'start');
  const file = path.join(directory, 'snapshot-' + randomUUID() + '.sqlite');
  const handle = await open(file, 'wx', 0o600);
  try {
    const identity = await handle.stat({ bigint: true });
    await backup(db, file, { rate: 8192 });
    const current = await lstat(file, { bigint: true });
    if (!current.isFile() || current.nlink !== 1n || current.ino !== identity.ino || current.dev !== identity.dev) throw new Error('核验快照身份发生变化。');
    const digest = createHash('sha256');
    for await (const bytes of createReadStream(file)) digest.update(bytes);
    const result = digest.digest('hex');
    logLibraryOperation('cache', 'startup.audit-fingerprint', 'complete', { elapsedMs: performance.now() - started });
    return result;
  } finally {
    await handle.close();
    // 只释放本次排他创建的短期快照，不清理其他缓存或用户文件。
    await unlink(file).catch(() => undefined);
  }
}

/** 指纹来自实际内容；物理水位仅用于防止本次指纹读取到工作连接取得写锁之间的变化。 */
export async function readLocalStartupAuditCache(file: string, options: LocalStartupAuditCacheOptions = {}): Promise<PreparedLocalStartupAudit | undefined> {
  const implementation = implementationFor(options);
  if (!implementation || !digestPattern.test(implementation) || file === ':memory:') return undefined;
  const started = performance.now();
  let db: DatabaseSync | undefined;
  try {
    const { directory, cache } = locations(file);
    const originalCacheStamp = cacheStamp(cache);
    const bytes = await readFile(cache);
    if (!same(originalCacheStamp, cacheStamp(cache))) throw new Error('核验缓存读取期间已变化。');
    if (!bytes.subarray(0, magic.length).equals(magic)) throw new Error('核验缓存格式无效。');
    const headerSize = bytes.readUInt32BE(magic.length);
    if (headerSize < 1 || headerSize > maximumHeader) throw new Error('核验缓存头无效。');
    const offset = magic.length + 4 + headerSize;
    const header = JSON.parse(bytes.subarray(magic.length + 4, offset).toString('utf8'));
    const payload = bytes.subarray(offset);
    const identity = stampFile(file);
    if (header.schema !== 1 || header.implementation !== implementation || header.runtime !== runtime()
      || header.path !== hash(file) || header.device !== identity.device || header.inode !== identity.inode
      || !digestPattern.test(header.fingerprint) || payload.length < 1 || payload.length > maximumPayload
      || header.bytes !== payload.length || header.payloadSha256 !== hash(payload)) throw new Error('核验缓存身份或摘要不匹配。');
    db = new DatabaseSync(file, { readOnly: true, allowExtension: false });
    db.exec('PRAGMA trusted_schema=OFF; PRAGMA query_only=ON; BEGIN');
    db.prepare('SELECT count(*) FROM sqlite_master').get();
    const before = databaseStamp(file), initial = point(db);
    if (initial.userVersion !== 34) throw new Error('核验缓存的数据库版本已变化。');
    await ensureDirectory(directory);
    const actual = await fingerprint(db, directory);
    db.exec('ROLLBACK');
    if (actual !== header.fingerprint || !same(before, databaseStamp(file)) || !same(initial, point(db))) throw new Error('工作库内容已变化。');
    db.close(); db = undefined;
    if (!same(before, databaseStamp(file))) throw new Error('工作库在指纹读取后已变化。');
    const state: unknown = deserialize(payload);
    if (!state || typeof state !== 'object' || Reflect.ownKeys(state).length !== 3 || !['catalog', 'scan', 'compact'].every(key => Object.hasOwn(state, key))
      || !same(originalCacheStamp, cacheStamp(cache))) throw new Error('核验缓存状态无效。');
    logLibraryOperation('cache', 'startup.audit-cache', 'hit', { code: 'CONTENT_MATCH', elapsedMs: performance.now() - started });
    return { implementation, runtime: runtime(), databaseStamp: before, cacheStamp: originalCacheStamp, cacheDigest: hash(bytes), payloadSha256: header.payloadSha256,
      fingerprint: actual, ...(state as AuditState) };
  } catch (error) {
    logLibraryOperation('cache', 'startup.audit-cache', 'miss', { code: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'NOT_FOUND' : 'RECHECK_REQUIRED', elapsedMs: performance.now() - started });
    return undefined;
  } finally { if (db) { try { if (db.isTransaction) db.exec('ROLLBACK'); db.close(); } catch { /* 缓存失效仍由原启动完整核验。 */ } } }
}

export function restoreLocalStartupAuditCache(db: DatabaseSync, file: string, candidate: PreparedLocalStartupAudit | undefined): boolean {
  if (!candidate) return false;
  try {
    if (!db.isTransaction || !same(candidate.databaseStamp, databaseStamp(file)) || !cacheMatches(file, candidate)) throw new Error('工作库在缓存读取后已变化。');
    if (!restoreLocalCatalogAuditState(db, candidate.catalog) || !restoreLocalScanAuditState(db, candidate.scan)) throw new Error('核验缓存状态未完整恢复。');
    restoreLocalAlbumStartupState(db, undefined);
    if (candidate.compact !== null && !restoreLocalAlbumStartupState(db, candidate.compact)) throw new Error('专辑纯缓存状态无效。');
    if (!same(candidate.databaseStamp, databaseStamp(file)) || !same(candidate.cacheStamp, cacheStamp(locations(file).cache))) throw new Error('恢复期间原锚点已变化。');
    const { catalog: _catalog, scan: _scan, compact: _compact, ...identity } = candidate;
    savedAnchors.set(db, { ...identity, file, point: point(db) });
    logLibraryOperation('library', 'startup.repository.audit-reuse', 'complete', { code: 'CONTENT_MATCH' });
    return true;
  } catch { savedAnchors.delete(db); clearLocalCatalogAuditState(db); clearLocalScanAuditState(db); restoreLocalAlbumStartupState(db, undefined); return false; }
}

/** 只在原 Owner 尚未交付或所有读写任务已静止时调用；不从缓存创建活权限。 */
export async function saveLocalStartupAuditCache(db: DatabaseSync, file: string, options: LocalStartupAuditCacheOptions = {}): Promise<boolean> {
  const implementation = implementationFor(options);
  if (!implementation || !digestPattern.test(implementation) || file === ':memory:' || db.isTransaction) return false;
  const originalAnchor = savedAnchors.get(db);
  let transaction = false, temporary: string | undefined;
  const started = performance.now();
  try {
    const capturedStamp = databaseStamp(file), initial = point(db);
    const state = captureState(db);
    if (!state) return false;
    if (!same(initial, point(db)) || !same(capturedStamp, databaseStamp(file))) throw new Error('捕获核验状态时工作库已变化。');
    const { directory, cache } = locations(file);
    const previous = savedAnchors.get(db), payload = serialize(state), payloadSha256 = hash(payload);
    if (payload.length > maximumPayload) throw new Error('核验缓存超过预算，沿用完整核验。');
    let reusable: SavedAnchor | undefined;
    if (previous) {
      if (same(previous.point, initial) && !same(previous.databaseStamp, databaseStamp(file))) {
        throw new Error('没有SQL推进证明的数据库物理变化需要重新核验。');
      }
      if (anchorCurrent(db, file, previous, implementation) && cacheMatches(file, previous) && anchorCurrent(db, file, previous, implementation)) reusable = previous;
    }
    if (reusable && reusable.payloadSha256 === payloadSha256) {
      logLibraryOperation('cache', 'startup.audit-cache-save', 'hit', { code: 'ANCHOR_CURRENT', elapsedMs: performance.now() - started });
      return true;
    }
    await ensureDirectory(directory);
    db.exec('BEGIN'); transaction = true;
    db.prepare('SELECT count(*) FROM sqlite_master').get();
    if (!same(initial, point(db))) throw new Error('工作库已推进，暂不保存核验缓存。');
    const before = databaseStamp(file);
    if (!same(capturedStamp, before)) throw new Error('捕获核验状态后工作库物理水位已变化。');
    if (reusable && !same(reusable.databaseStamp, before)) throw new Error('原已核内容锚点在保存前已变化。');
    const actual = reusable ? reusable.fingerprint : await fingerprint(db, directory);
    if (!same(initial, point(db)) || !same(before, databaseStamp(file))) throw new Error('工作库在生成核验快照时已变化。');
    db.exec('ROLLBACK'); transaction = false;
    if (!same(initial, point(db))) throw new Error('工作库在快照之后已推进。');
    const header = Buffer.from(JSON.stringify({ schema: 1, implementation, runtime: runtime(), path: hash(file), device: before.database.device,
      inode: before.database.inode, fingerprint: actual, bytes: payload.length, payloadSha256 }));
    const length = Buffer.alloc(4); length.writeUInt32BE(header.length);
    const bytes = Buffer.concat([magic, length, header, payload]);
    temporary = path.join(directory, 'audit-' + randomUUID() + '.new');
    const handle = await open(temporary, 'wx', 0o600);
    let writtenIdentity: FileStamp | undefined;
    try { await handle.writeFile(bytes); await handle.sync(); writtenIdentity = stampFile(temporary); } finally { await handle.close(); }
    if (!writtenIdentity) throw new Error('核验缓存临时文件没有完成写入。');
    try { const previous = await lstat(cache); if (!previous.isFile() || previous.isSymbolicLink() || previous.nlink !== 1) throw new Error('核验缓存目标身份无效。'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    await rename(temporary, cache); temporary = undefined;
    const published = cacheStamp(cache);
    const cacheDigest = hash(bytes);
    if (published.device !== writtenIdentity.device || published.inode !== writtenIdentity.inode || published.size !== writtenIdentity.size || published.modified !== writtenIdentity.modified
      || !cacheMatches(file, { cacheStamp: published, cacheDigest })
      || !same(initial, point(db)) || !same(before, databaseStamp(file))) throw new Error('发布时工作库或缓存身份已变化。');
    savedAnchors.set(db, { file, implementation, runtime: runtime(), point: initial, databaseStamp: before, cacheStamp: published,
      cacheDigest, payloadSha256, fingerprint: actual });
    logLibraryOperation('cache', 'startup.audit-cache-save', 'complete', { elapsedMs: performance.now() - started, bytes: payload.length });
    return true;
  } catch {
    // 保留原锚点作为失效水位；失败不能让下一次保存把未知物理变化重新盖成可信。
    if (originalAnchor) savedAnchors.set(db, originalAnchor);
    else savedAnchors.delete(db);
    logLibraryOperation('cache', 'startup.audit-cache-save', 'skipped', { code: 'RECHECK_REQUIRED', elapsedMs: performance.now() - started });
    return false;
  } finally {
    if (transaction) try { db.exec('ROLLBACK'); } catch { /* 原数据库关闭链继续处理。 */ }
    if (temporary) await unlink(temporary).catch(() => undefined);
  }
}
