import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync,
  openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync,
} from 'node:fs';
import type { BigIntStats } from 'node:fs';
import path from 'node:path';
import { isMobileId, mobileCanonicalJson, mobileInteger } from '@music-bridge/contracts';
import type { MobileJsonValue } from '@music-bridge/contracts';
import {
  captureMobileContentState, createMobileContentState, decodeMobileContentState,
  encodeMobileContentState, type MobileContentState,
} from './content-state.js';
import type { MobileContentStateLimits } from './content-types.js';
import { MobileServiceError } from './types.js';

/** 只含安全结果与原 commit；不传播文件路径、正文或加密底层异常。 */
export class MobileContentPersistenceError extends MobileServiceError {
  constructor(readonly outcome: 'not-sent' | 'unknown', readonly commitId: string | null = null) {
    super(503, 'BUSY', false);
  }
}
export interface MobileContentOwnerStoreOptions {
  directory: string; serverId: string; datasetId: string; limits: MobileContentStateLimits;
  /** 可信 Owner 组合根注入的同步认证加密端口；不进入配置或 IPC。 */
  seal(plain: Uint8Array): Uint8Array;
  open(sealed: Uint8Array): Uint8Array;
  assertCurrent(): void;
  /** 密文开销有独立容量，不借用原 auth/playback 上限。 */
  sealedBytes?: number;
  /** 仅可信本地故障测试可注入，生产消息不能提供回调。 */
  afterPublish?(): void;
}
export interface MobileContentLoadedState {
  state: MobileContentState; revision: number; commitId: string | null;
}
export interface MobileContentOwnerSave {
  expectedRevision: number; commitId: string; state: MobileContentState; guard(): void;
}
export type MobileContentOwnerSaveResult =
  | { kind: 'saved'; revision: number; commitId: string }
  | { kind: 'conflict'; currentRevision: number };
export interface MobileContentOwnerStore {
  load(): MobileContentLoadedState;
  save(request: MobileContentOwnerSave): MobileContentOwnerSaveResult;
  resolve(commitId: string): MobileContentLoadedState;
}

const SCHEMA = 'musicbridge.mobile-content-sealed-owner-state.v1';
const PAYLOAD_SCHEMA = 'musicbridge.mobile-content-owner-payload.v1';
const digest = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const canonical = (value: unknown): string => mobileCanonicalJson(value as MobileJsonValue);
const uuid = (raw: unknown): raw is string => typeof raw === 'string'
  && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(raw);
const hashString = (raw: unknown): raw is string => typeof raw === 'string' && /^[a-f0-9]{64}$/u.test(raw);
function record(raw: unknown): raw is Record<string, unknown> {
  return raw !== null && typeof raw === 'object' && !Array.isArray(raw);
}
function closed(raw: unknown, keys: readonly string[]): raw is Record<string, unknown> {
  if (!record(raw) || ![Object.prototype, null].includes(Object.getPrototypeOf(raw))
    || Reflect.ownKeys(raw).length !== keys.length) return false;
  return keys.every(key => {
    const d = Object.getOwnPropertyDescriptor(raw, key);
    return d?.enumerable === true && Object.hasOwn(d, 'value');
  });
}
function sameFile(a: BigIntStats, b: BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.birthtimeNs === b.birthtimeNs && a.size === b.size
    && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs && a.mode === b.mode && a.uid === b.uid && a.nlink === b.nlink;
}
function sameDirectory(a: BigIntStats, b: BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.birthtimeNs === b.birthtimeNs && a.uid === b.uid && a.mode === b.mode;
}

/** 一个 Dataset Owner 的同步文件 actor；此模块不打开 SQLite，不另建 auth store。 */
export function createMobileContentOwnerStore(options: MobileContentOwnerStoreOptions): MobileContentOwnerStore {
  let directory: string, file: string, limits: MobileContentStateLimits, sealedMax: number, fileMax: number;
  try {
    if (!path.isAbsolute(options.directory) || options.directory.includes('\0') || !isMobileId(options.serverId)
      || !isMobileId(options.datasetId) || typeof options.assertCurrent !== 'function'
      || typeof options.seal !== 'function' || typeof options.open !== 'function'
      || options.afterPublish !== undefined && typeof options.afterPublish !== 'function') throw new Error('参数');
    // 由状态 codec 验证全部显式限额；这里只保存不可变副本。
    const empty = createMobileContentState({ serverId: options.serverId, datasetId: options.datasetId });
    captureMobileContentState(empty, options.limits);
    limits = Object.freeze({ ...options.limits });
    sealedMax = options.sealedBytes ?? limits.stateBytes + 65536;
    if (!mobileInteger(sealedMax, 1) || !Number.isSafeInteger(limits.stateBytes + 4096)) throw new Error('限额');
    fileMax = Math.ceil(sealedMax / 3) * 4 + 4096;
    if (!Number.isSafeInteger(fileMax)) throw new Error('限额');
    directory = path.join(options.directory, 'mobile-content');
    file = path.join(directory, 'content-state.v1.sealed.json');
    options = Object.freeze({ ...options, limits });
  } catch { throw new MobileContentPersistenceError('not-sent'); }
  const root = path.resolve(options.directory);
  let rootIdentity: BigIntStats | null = null, directoryIdentity: BigIntStats | null = null;
  let pending: { commitId: string; revision: number; stateHash: string } | null = null;
  let saving = false;
  const uid = process.getuid?.();
  function assertCurrent(): void {
    if (options.assertCurrent() !== undefined) throw new Error('围栏必须同步');
  }
  function assertGuard(guard: () => void): void {
    if (guard() !== undefined) throw new Error('发布许可必须同步');
  }
  function assertRoot(): void {
    assertCurrent();
    const info = lstatSync(root, { bigint: true });
    if (uid === undefined || !info.isDirectory() || info.isSymbolicLink() || info.uid !== BigInt(uid)
      || (info.mode & 0o022n) !== 0n || realpathSync(root) !== root
      || rootIdentity !== null && !sameDirectory(rootIdentity, info)) throw new Error('目录');
    rootIdentity ??= info;
  }
  function assertNamedDirectory(info?: BigIntStats): BigIntStats {
    assertRoot();
    const named = lstatSync(directory, { bigint: true });
    if (!named.isDirectory() || named.isSymbolicLink() || named.uid !== BigInt(uid!)
      || (named.mode & 0o777n) !== 0o700n || directoryIdentity !== null && !sameDirectory(directoryIdentity, named)
      || info !== undefined && !sameDirectory(info, named)) throw new Error('目录');
    directoryIdentity ??= named;
    return named;
  }
  function openDirectory(): number {
    assertRoot();
    try { mkdirSync(directory, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const before = assertNamedDirectory(), fd = openSync(directory, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { if (!sameDirectory(before, fstatSync(fd, { bigint: true }))) throw new Error('目录变化'); }
    catch (error) { closeSync(fd); throw error; }
    return fd;
  }
  function privateFile(info: BigIntStats, max: number): void {
    if (!info.isFile() || info.nlink !== 1n || info.uid !== BigInt(uid!) || (info.mode & 0o777n) !== 0o600n
      || info.size < 1n || info.size > BigInt(max)) throw new Error('文件');
  }
  type Readback = MobileContentLoadedState & { stateHash: string; fileIdentity: BigIntStats | null };
  function read(): Readback {
    const directoryFd = openDirectory();
    try {
      const directoryInfo = fstatSync(directoryFd, { bigint: true });
      let fd: number;
      try { fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        assertNamedDirectory(directoryInfo); assertCurrent();
        const state = createMobileContentState({ serverId: options.serverId, datasetId: options.datasetId });
        return { state, revision: 0, commitId: null, stateHash: digest(encodeMobileContentState(state, limits)), fileIdentity: null };
      }
      try {
        const before = fstatSync(fd, { bigint: true }); privateFile(before, fileMax);
        const bytes = readFileSync(fd);
        if (BigInt(bytes.length) !== before.size || !sameFile(before, fstatSync(fd, { bigint: true }))
          || !sameFile(before, lstatSync(file, { bigint: true }))) throw new Error('文件变化');
        const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        const envelope: unknown = JSON.parse(text);
        if (!closed(envelope, ['schema', 'serverId', 'datasetId', 'revision', 'commitId', 'stateSha256', 'sealedSha256', 'sealed'])
          || envelope.schema !== SCHEMA || envelope.serverId !== options.serverId || envelope.datasetId !== options.datasetId
          || !mobileInteger(envelope.revision, 1) || !uuid(envelope.commitId) || !hashString(envelope.stateSha256)
          || !hashString(envelope.sealedSha256) || typeof envelope.sealed !== 'string' || envelope.sealed.length > fileMax
          || text !== canonical(envelope) + '\n') throw new Error('信封');
        const sealed = new Uint8Array(Buffer.from(envelope.sealed, 'base64'));
        if (sealed.length < 1 || sealed.length > sealedMax || Buffer.from(sealed).toString('base64') !== envelope.sealed
          || digest(sealed) !== envelope.sealedSha256) throw new Error('密文');
        const opened = options.open(new Uint8Array(sealed));
        if (!(opened instanceof Uint8Array) || opened.buffer instanceof SharedArrayBuffer
          || opened.byteLength < 1 || opened.byteLength > limits.stateBytes + 4096) throw new Error('明文限额');
        const plain = new Uint8Array(opened), plainText = new TextDecoder('utf-8', { fatal: true }).decode(plain);
        const payload: unknown = JSON.parse(plainText);
        if (!closed(payload, ['schema', 'serverId', 'datasetId', 'revision', 'commitId', 'state'])
          || payload.schema !== PAYLOAD_SCHEMA || payload.serverId !== options.serverId || payload.datasetId !== options.datasetId
          || payload.revision !== envelope.revision || payload.commitId !== envelope.commitId
          || canonical(payload) !== plainText) throw new Error('认证提交');
        const state = decodeMobileContentState(new Uint8Array(Buffer.from(canonical(payload.state), 'utf8')), limits);
        const stateHash = digest(encodeMobileContentState(state, limits));
        if (state.serverId !== options.serverId || state.datasetId !== options.datasetId || state.revision !== envelope.revision
          || stateHash !== envelope.stateSha256 || !sameFile(before, fstatSync(fd, { bigint: true }))
          || !sameFile(before, lstatSync(file, { bigint: true }))) throw new Error('身份');
        assertNamedDirectory(directoryInfo); assertCurrent();
        return { state, revision: state.revision, commitId: envelope.commitId, stateHash, fileIdentity: before };
      } finally { closeSync(fd); }
    } finally { closeSync(directoryFd); }
  }
  const publicRead = (value: Readback): MobileContentLoadedState => Object.freeze({ state: value.state,
    revision: value.revision, commitId: value.commitId });
  function sameCurrent(a: Readback, b: Readback): boolean {
    return a.revision === b.revision && a.commitId === b.commitId && a.stateHash === b.stateHash
      && (a.fileIdentity === null ? b.fileIdentity === null : b.fileIdentity !== null && sameFile(a.fileIdentity, b.fileIdentity));
  }
  function syncDirectory(): void {
    const fd = openDirectory();
    try { assertNamedDirectory(fstatSync(fd, { bigint: true })); fsyncSync(fd); }
    finally { closeSync(fd); }
  }
  return {
    load(): MobileContentLoadedState {
      if (pending !== null) throw new MobileContentPersistenceError('unknown', pending.commitId);
      try { return publicRead(read()); }
      catch { throw new MobileContentPersistenceError('not-sent'); }
    },
    save(raw: MobileContentOwnerSave): MobileContentOwnerSaveResult {
      if (pending !== null) throw new MobileContentPersistenceError('unknown', pending.commitId);
      if (saving) throw new MobileContentPersistenceError('not-sent');
      saving = true; let published = false, commitId: string | null = null;
      let temporary: string | null = null, temporaryFd: number | null = null, directoryFd: number | null = null;
      try {
        if (!closed(raw, ['expectedRevision', 'commitId', 'state', 'guard'])) throw new Error('参数');
        const descriptors = Object.getOwnPropertyDescriptors(raw);
        const request = Object.freeze({ expectedRevision: descriptors.expectedRevision!.value as unknown,
          commitId: descriptors.commitId!.value as unknown, state: descriptors.state!.value as MobileContentState,
          guard: descriptors.guard!.value as () => void });
        if (!mobileInteger(request.expectedRevision) || request.expectedRevision === Number.MAX_SAFE_INTEGER
          || !uuid(request.commitId) || typeof request.guard !== 'function') throw new Error('参数');
        commitId = request.commitId;
        const state = captureMobileContentState(request.state, limits), bytes = encodeMobileContentState(state, limits), stateHash = digest(bytes);
        if (state.serverId !== options.serverId || state.datasetId !== options.datasetId || state.revision !== request.expectedRevision + 1) throw new Error('状态');
        const current = read();
        if (current.commitId === request.commitId) {
          if (current.revision !== state.revision || current.stateHash !== stateHash) throw new Error('提交冲突');
          assertGuard(request.guard); assertCurrent();
          if (!sameCurrent(current, read())) throw new Error('变化');
          return Object.freeze({ kind: 'saved', revision: current.revision, commitId: request.commitId });
        }
        if (current.revision !== request.expectedRevision) return Object.freeze({ kind: 'conflict', currentRevision: current.revision });
        const payload = new Uint8Array(Buffer.from(canonical({ schema: PAYLOAD_SCHEMA, serverId: options.serverId,
          datasetId: options.datasetId, revision: state.revision, commitId: request.commitId, state }), 'utf8'));
        if (payload.byteLength > limits.stateBytes + 4096) throw new Error('明文限额');
        const sealedRaw = options.seal(new Uint8Array(payload));
        if (!(sealedRaw instanceof Uint8Array) || sealedRaw.buffer instanceof SharedArrayBuffer
          || sealedRaw.byteLength < 1 || sealedRaw.byteLength > sealedMax) throw new Error('密文限额');
        const sealed = new Uint8Array(sealedRaw);
        const data = Buffer.from(canonical({ schema: SCHEMA, serverId: options.serverId, datasetId: options.datasetId,
          revision: state.revision, commitId: request.commitId, stateSha256: stateHash,
          sealedSha256: digest(sealed), sealed: Buffer.from(sealed).toString('base64') }) + '\n', 'utf8');
        if (data.length > fileMax) throw new Error('信封限额');
        directoryFd = openDirectory(); const directoryInfo = fstatSync(directoryFd, { bigint: true });
        temporary = path.join(directory, `.pending-${randomUUID()}.sealed`);
        temporaryFd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        fchmodSync(temporaryFd, 0o600); writeFileSync(temporaryFd, data); fsyncSync(temporaryFd);
        const temporaryInfo = fstatSync(temporaryFd, { bigint: true }); privateFile(temporaryInfo, fileMax);
        if (temporaryInfo.size !== BigInt(data.length) || !sameFile(temporaryInfo, lstatSync(temporary, { bigint: true }))) throw new Error('临时文件变化');
        // 同步 guard 不跨 await；guard 之后重读 CAS，防止回调重入造成覆盖。
        assertCurrent(); assertGuard(request.guard);
        if (!sameCurrent(current, read())) throw new Error('CAS变化');
        assertNamedDirectory(directoryInfo); assertCurrent();
        if (!sameFile(temporaryInfo, fstatSync(temporaryFd, { bigint: true }))
          || !sameFile(temporaryInfo, lstatSync(temporary, { bigint: true }))) throw new Error('临时文件变化');
        renameSync(temporary, file); published = true;
        pending = { commitId: request.commitId, revision: state.revision, stateHash };
        if (options.afterPublish?.() !== undefined) throw new Error('发布观察器必须同步');
        assertNamedDirectory(directoryInfo); fsyncSync(directoryFd);
        const observed = read();
        if (observed.commitId !== request.commitId || observed.revision !== state.revision || observed.stateHash !== stateHash) throw new Error('结果未确认');
        pending = null;
        return Object.freeze({ kind: 'saved', revision: state.revision, commitId: request.commitId });
      } catch {
        throw new MobileContentPersistenceError(published ? 'unknown' : 'not-sent', commitId);
      } finally {
        if (temporaryFd !== null) {
          if (!published && temporary !== null) {
            try { if (sameFile(fstatSync(temporaryFd, { bigint: true }), lstatSync(temporary, { bigint: true }))) unlinkSync(temporary); }
            catch { /* 只清理仍等于本次 FD 的私有临时名；不碰替换后的文件。 */ }
          }
          closeSync(temporaryFd);
        }
        if (directoryFd !== null) closeSync(directoryFd);
        saving = false;
      }
    },
    resolve(commitId: string): MobileContentLoadedState {
      if (saving || pending === null || commitId !== pending.commitId) throw new MobileContentPersistenceError('unknown', pending?.commitId ?? null);
      try {
        const current = read();
        if (current.commitId !== pending.commitId || current.revision !== pending.revision || current.stateHash !== pending.stateHash) throw new Error('未对账');
        syncDirectory(); const final = read();
        if (!sameCurrent(current, final)) throw new Error('变化');
        pending = null; return publicRead(final);
      } catch { throw new MobileContentPersistenceError('unknown', pending?.commitId ?? commitId); }
    },
  };
}
