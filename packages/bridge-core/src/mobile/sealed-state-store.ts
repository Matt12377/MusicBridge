import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync,
  openSync, readFileSync, renameSync, writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { isMobileId } from '@music-bridge/contracts';
import {
  MOBILE_AUTH_SEALED_MAX_BYTES, MobileAuthPersistenceError,
  type MobileSealedSave, type MobileSealedSaveResult, type MobileSealedState,
} from './types.js';

const fileName = 'device-state.v1.sealed.json';
const hash = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const uuid = (value: unknown): value is string => typeof value === 'string'
  && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(value);
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const fileMax = Math.ceil(MOBILE_AUTH_SEALED_MAX_BYTES / 3) * 4 + 2048;
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function same(a: ReturnType<typeof fstatSync>, b: NonNullable<ReturnType<typeof lstatSync>>): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs;
}

/** 只在原 Dataset Owner 内构造；不打开 SQLite，也不接收公开路径。 */
export function createMobileSealedStateStore(options: {
  directory: string; datasetId: string; assertCurrent(): void;
  /** 仅本地故障测试使用；IPC/配置/环境都不能提供回调。 */
  afterPublish?: () => void;
}) {
  if (!path.isAbsolute(options.directory) || options.directory.includes('\0') || !isMobileId(options.datasetId)) {
    throw new MobileAuthPersistenceError('not-sent');
  }
  const directory = path.join(options.directory, 'mobile-devices');
  const file = path.join(directory, fileName);
  function assertDirectory(): void {
    options.assertCurrent();
    const parent = lstatSync(options.directory);
    if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== process.getuid?.()) throw new Error('private');
    try { mkdirSync(directory, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const info = lstatSync(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.()
      || (info.mode & 0o777) !== 0o700) throw new Error('private');
  }
  function read(): MobileSealedState {
    assertDirectory();
    let fd: number;
    try { fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing', datasetId: options.datasetId, revision: 0 };
      throw error;
    }
    try {
      const before = fstatSync(fd);
      if (!before.isFile() || before.nlink !== 1 || before.uid !== process.getuid?.() || (before.mode & 0o777) !== 0o600
        || before.size < 1 || before.size > fileMax) throw new Error('private');
      const bytes = readFileSync(fd);
      if (!same(before, fstatSync(fd)) || !same(before, lstatSync(file)) || bytes.length !== before.size) throw new Error('changed');
      const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      const keys = ['schema', 'datasetId', 'revision', 'commitId', 'sha256', 'sealed'];
      if (!record(value) || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))
        || value.schema !== 'musicbridge.mobile-sealed-state.v1' || value.datasetId !== options.datasetId
        || !integer(value.revision) || value.revision < 1 || !uuid(value.commitId)
        || typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(value.sha256)
        || typeof value.sealed !== 'string' || value.sealed.length > fileMax || value.sealed.length % 4 !== 0) throw new Error('invalid');
      const sealed = new Uint8Array(Buffer.from(value.sealed, 'base64'));
      if (sealed.length < 1 || sealed.length > MOBILE_AUTH_SEALED_MAX_BYTES
        || Buffer.from(sealed).toString('base64') !== value.sealed || hash(sealed) !== value.sha256) throw new Error('invalid');
      options.assertCurrent();
      return { kind: 'sealed', datasetId: options.datasetId, revision: value.revision, commitId: value.commitId, sealed };
    } finally { closeSync(fd); }
  }
  return {
    load(datasetId: string): MobileSealedState {
      try {
        if (datasetId !== options.datasetId) throw new Error('scope');
        return read();
      } catch { throw new MobileAuthPersistenceError('not-sent'); }
    },
    save(request: MobileSealedSave): MobileSealedSaveResult {
      let published = false;
      try {
        if (request.datasetId !== options.datasetId || !integer(request.expectedRevision)
          || request.expectedRevision >= Number.MAX_SAFE_INTEGER || !uuid(request.commitId)
          || !(request.sealed instanceof Uint8Array) || request.sealed.length < 1
          || request.sealed.length > MOBILE_AUTH_SEALED_MAX_BYTES) throw new Error('invalid');
        const sealed = new Uint8Array(request.sealed);
        const digest = hash(sealed), current = read();
        if (current.kind === 'sealed' && current.commitId === request.commitId) {
          if (current.revision !== request.expectedRevision + 1 || hash(current.sealed) !== digest) throw new Error('conflict');
          return { kind: 'saved', datasetId: options.datasetId, revision: current.revision, commitId: current.commitId };
        }
        if (current.revision !== request.expectedRevision) return { kind: 'conflict', datasetId: options.datasetId, currentRevision: current.revision };
        const revision = current.revision + 1;
        const data = Buffer.from(JSON.stringify({ schema: 'musicbridge.mobile-sealed-state.v1', datasetId: options.datasetId,
          revision, commitId: request.commitId, sha256: digest, sealed: Buffer.from(sealed).toString('base64') }) + '\n');
        if (data.length > fileMax) throw new Error('budget');
        const temporary = path.join(directory, `.pending-${randomUUID()}.sealed`);
        const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        try {
          fchmodSync(fd, 0o600); writeFileSync(fd, data); fsyncSync(fd);
          const info = fstatSync(fd);
          if (info.nlink !== 1 || info.size !== data.length || !same(info, lstatSync(temporary))) throw new Error('changed');
          options.assertCurrent();
          // 单一 Owner 同步 CAS，不跨进程或异步窗口拼接保存。
          renameSync(temporary, file); published = true;
          options.afterPublish?.();
          const directoryFd = openSync(directory, constants.O_RDONLY | constants.O_NOFOLLOW);
          try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
        } finally { closeSync(fd); }
        const observed = read();
        if (observed.kind !== 'sealed' || observed.revision !== revision || observed.commitId !== request.commitId
          || hash(observed.sealed) !== digest) throw new Error('unconfirmed');
        return { kind: 'saved', datasetId: options.datasetId, revision, commitId: request.commitId };
      } catch { throw new MobileAuthPersistenceError(published ? 'unknown' : 'not-sent'); }
    },
  };
}
