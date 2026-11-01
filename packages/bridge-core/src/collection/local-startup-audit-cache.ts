import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, lstatSync, realpathSync } from 'node:fs';
import { lstat, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import { deserialize, serialize } from 'node:v8';
import { captureLocalCatalogAuditState, restoreLocalCatalogAuditState, clearLocalCatalogAuditState } from './local-catalog-store.js';
import { captureLocalScanAuditState, restoreLocalScanAuditState, clearLocalScanAuditState } from './local-scan-store.js';
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
  databaseStamp: DatabaseStamp;
  fingerprint: string;
  catalog: unknown;
  scan: unknown;
}
export interface LocalStartupAuditCacheOptions { implementationVersion?: string }

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
async function ensureDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || realpathSync(directory) !== directory || (info.mode & 0o077) !== 0
    || typeof process.getuid === 'function' && info.uid !== process.getuid()) throw new Error('核验缓存目录身份无效。');
}

/** 使用 SQLite 自己的快照处理 WAL；普通 checkpoint 不会改变有效页指纹。 */
async function fingerprint(db: DatabaseSync, directory: string): Promise<string> {
  const file = path.join(directory, 'snapshot-' + randomUUID() + '.sqlite');
  const handle = await open(file, 'wx', 0o600);
  try {
    const identity = await handle.stat({ bigint: true });
    await backup(db, file, { rate: 8192 });
    const current = await lstat(file, { bigint: true });
    if (!current.isFile() || current.nlink !== 1n || current.ino !== identity.ino || current.dev !== identity.dev) throw new Error('核验快照身份发生变化。');
    const digest = createHash('sha256');
    for await (const bytes of createReadStream(file)) digest.update(bytes);
    return digest.digest('hex');
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
    const info = await lstat(cache);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || (info.mode & 0o077) !== 0
      || typeof process.getuid === 'function' && info.uid !== process.getuid()
      || info.size > maximumPayload + maximumHeader + magic.length + 4) throw new Error('核验缓存大小或身份无效。');
    if (realpathSync(cache) !== cache) throw new Error('核验缓存不能是链接。');
    const bytes = await readFile(cache);
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
    if (!state || typeof state !== 'object' || Reflect.ownKeys(state).length !== 2 || !Object.hasOwn(state, 'catalog') || !Object.hasOwn(state, 'scan')) throw new Error('核验缓存状态无效。');
    logLibraryOperation('cache', 'startup.audit-cache', 'hit', { code: 'CONTENT_MATCH', elapsedMs: performance.now() - started });
    return { implementation, databaseStamp: before, fingerprint: actual, catalog: (state as { catalog: unknown }).catalog, scan: (state as { scan: unknown }).scan };
  } catch (error) {
    logLibraryOperation('cache', 'startup.audit-cache', 'miss', { code: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'NOT_FOUND' : 'RECHECK_REQUIRED', elapsedMs: performance.now() - started });
    return undefined;
  } finally { if (db) { try { if (db.isTransaction) db.exec('ROLLBACK'); db.close(); } catch { /* 缓存失效仍由原启动完整核验。 */ } } }
}

export function restoreLocalStartupAuditCache(db: DatabaseSync, file: string, candidate: PreparedLocalStartupAudit | undefined): boolean {
  if (!candidate) return false;
  try {
    if (!db.isTransaction || !same(candidate.databaseStamp, databaseStamp(file))) throw new Error('工作库在缓存读取后已变化。');
    if (!restoreLocalCatalogAuditState(db, candidate.catalog) || !restoreLocalScanAuditState(db, candidate.scan)) throw new Error('核验缓存状态未完整恢复。');
    logLibraryOperation('library', 'startup.repository.audit-reuse', 'complete', { code: 'CONTENT_MATCH' });
    return true;
  } catch { clearLocalCatalogAuditState(db); clearLocalScanAuditState(db); return false; }
}

/** 只在原 Owner 尚未交付或所有读写任务已静止时调用；不从缓存创建活权限。 */
export async function saveLocalStartupAuditCache(db: DatabaseSync, file: string, options: LocalStartupAuditCacheOptions = {}): Promise<boolean> {
  const implementation = implementationFor(options);
  if (!implementation || !digestPattern.test(implementation) || file === ':memory:' || db.isTransaction) return false;
  let transaction = false, temporary: string | undefined;
  const started = performance.now();
  try {
    const catalog = captureLocalCatalogAuditState(db), scan = captureLocalScanAuditState(db);
    if (!catalog || !scan) return false;
    const initial = point(db);
    const { directory, cache } = locations(file);
    await ensureDirectory(directory);
    db.exec('BEGIN'); transaction = true;
    db.prepare('SELECT count(*) FROM sqlite_master').get();
    if (!same(initial, point(db))) throw new Error('工作库已推进，暂不保存核验缓存。');
    const before = databaseStamp(file);
    const actual = await fingerprint(db, directory);
    if (!same(initial, point(db)) || !same(before, databaseStamp(file))) throw new Error('工作库在生成核验快照时已变化。');
    db.exec('ROLLBACK'); transaction = false;
    if (!same(initial, point(db))) throw new Error('工作库在快照之后已推进。');
    const payload = serialize({ catalog, scan });
    if (payload.length > maximumPayload) throw new Error('核验缓存超过预算，沿用完整核验。');
    const header = Buffer.from(JSON.stringify({ schema: 1, implementation, runtime: runtime(), path: hash(file), device: before.database.device,
      inode: before.database.inode, fingerprint: actual, bytes: payload.length, payloadSha256: hash(payload) }));
    const length = Buffer.alloc(4); length.writeUInt32BE(header.length);
    temporary = path.join(directory, 'audit-' + randomUUID() + '.new');
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(Buffer.concat([magic, length, header, payload])); await handle.sync(); } finally { await handle.close(); }
    try { const previous = await lstat(cache); if (!previous.isFile() || previous.isSymbolicLink() || previous.nlink !== 1) throw new Error('核验缓存目标身份无效。'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    await rename(temporary, cache); temporary = undefined;
    logLibraryOperation('cache', 'startup.audit-cache-save', 'complete', { elapsedMs: performance.now() - started, bytes: payload.length });
    return true;
  } catch {
    logLibraryOperation('cache', 'startup.audit-cache-save', 'skipped', { code: 'RECHECK_REQUIRED', elapsedMs: performance.now() - started });
    return false;
  } finally {
    if (transaction) try { db.exec('ROLLBACK'); } catch { /* 原数据库关闭链继续处理。 */ }
    if (temporary) await unlink(temporary).catch(() => undefined);
  }
}
