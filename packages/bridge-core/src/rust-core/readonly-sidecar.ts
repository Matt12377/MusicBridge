import childProcess, { type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import {
  isCollectionId, isCollectionModel, isCollectionPage, validateIpcRequest,
  validateIpcResponseForCommand, type CollectionModel, type IpcRequest, type Page,
} from '@music-bridge/contracts';
import type { DatasetOwnerEndpoint, DatasetOwnerIdentity } from '../collection/dataset-owner-protocol.js';

export const RUST_SIDECAR_LIMITS = Object.freeze({ frameBytes: 4_194_304, models: 2_000, inflight: 16, sequence: 65_536 });
const wireCodes = new Set(['INVALID_REQUEST', 'UNSUPPORTED_OPERATION', 'UNSUPPORTED_COMMAND', 'UNSUPPORTED_FILTER',
  'SCOPE_MISMATCH', 'CAPACITY_EXCEEDED', 'NOT_READY', 'CLOSING', 'PROTOCOL_ERROR']);
export type RustSidecarErrorCode = 'INVALID_REQUEST' | 'UNSUPPORTED_OPERATION' | 'UNSUPPORTED_COMMAND' | 'UNSUPPORTED_FILTER'
  | 'SCOPE_MISMATCH' | 'CAPACITY_EXCEEDED' | 'NOT_READY' | 'CLOSING' | 'PROTOCOL_ERROR'
  | 'BINARY_PIN_MISMATCH' | 'TIMEOUT' | 'PROCESS_EXIT';
const messages: Record<RustSidecarErrorCode, string> = {
  INVALID_REQUEST: 'Rust 只读请求无效。', UNSUPPORTED_OPERATION: 'Rust 只读操作未准入。',
  UNSUPPORTED_COMMAND: 'Rust 快照端点不支持此命令。', UNSUPPORTED_FILTER: 'Rust 快照端点尚不支持筛选。',
  SCOPE_MISMATCH: 'Rust 快照身份不匹配。', CAPACITY_EXCEEDED: 'Rust 只读资源预算已满。',
  NOT_READY: 'Rust 快照尚未就绪。', CLOSING: 'Rust 快照端点已封闭。',
  PROTOCOL_ERROR: 'Rust 只读协议校验失败。', BINARY_PIN_MISMATCH: 'Rust 可执行文件身份校验失败。',
  TIMEOUT: 'Rust 只读操作超过期限。', PROCESS_EXIT: 'Rust 进程未完成预期关闭。',
};
export class RustSidecarError extends Error {
  constructor(readonly code: RustSidecarErrorCode) { super(messages[code]); this.name = 'RustSidecarError'; }
}
export interface RustReadonlySnapshot extends DatasetOwnerIdentity {
  readonly snapshotId: string;
  readonly models: readonly CollectionModel[];
}
export interface RustReadonlyDatasetEndpoint extends DatasetOwnerEndpoint {
  readonly readOnly: true;
  readonly snapshotId: string;
  readonly capabilities: readonly ['collection.list'];
}
export interface RustReadonlySidecarOptions {
  binary: { path: string; sha256: string };
  snapshot: RustReadonlySnapshot;
  requestTimeoutMs?: number;
  closeTimeoutMs?: number;
  onFatal?: (code: RustSidecarErrorCode) => void;
}
const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const exact = (v: Record<string, unknown>, keys: readonly string[]) => Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
function jsonCopy<T>(value: T): T {
  const visiting = new Set<object>();
  let nodes = 0;
  function copy(v: unknown, depth: number): unknown {
    if (++nodes > 1_000_000 || depth > 32) throw new RustSidecarError('CAPACITY_EXCEEDED');
    if (v === null || typeof v === 'boolean') return v;
    if (typeof v === 'string') {
      if (/[\uD800-\uDFFF]/u.test(v)) throw new RustSidecarError('INVALID_REQUEST');
      return v;
    }
    // JSON 不保留负零；先归一化，避免把合法往返误判为快照被替换。
    if (typeof v === 'number' && Number.isSafeInteger(v)) return v === 0 ? 0 : v;
    if (typeof v !== 'object' || visiting.has(v)) throw new RustSidecarError('INVALID_REQUEST');
    const array = Array.isArray(v), proto = Object.getPrototypeOf(v);
    if ((array ? proto !== Array.prototype : proto !== Object.prototype && proto !== null)
      || 'toJSON' in v || Object.getOwnPropertySymbols(v).length) throw new RustSidecarError('INVALID_REQUEST');
    visiting.add(v);
    const result: unknown[] | Record<string, unknown> = array ? [] : {};
    const descriptors = Object.getOwnPropertyDescriptors(v);
    if (array && Object.keys(descriptors).length !== (v as unknown[]).length + 1) throw new RustSidecarError('INVALID_REQUEST');
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (array && key === 'length') continue;
      if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')
        || array && !/^(?:0|[1-9][0-9]*)$/.test(key)) throw new RustSidecarError('INVALID_REQUEST');
      Object.defineProperty(result, key, { value: copy(descriptor.value, depth + 1), enumerable: true, writable: true, configurable: true });
    }
    visiting.delete(v);
    return result;
  }
  return copy(value, 0) as T;
}
/** JSON.parse 负责标准语法，第二次扫描拒绝各层覆盖式重复键。 */
function strictJson(text: string): unknown {
  const value: unknown = JSON.parse(text);
  let at = 0;
  const space = () => { while (/\s/.test(text[at] ?? '') && at < text.length) at++; };
  function string(): string {
    const start = at++;
    while (at < text.length) {
      if (text[at] === '\\') { at += 2; continue; }
      if (text[at++] === '"') return JSON.parse(text.slice(start, at)) as string;
    }
    throw new RustSidecarError('PROTOCOL_ERROR');
  }
  function scan(depth: number): void {
    if (depth > 32) throw new RustSidecarError('PROTOCOL_ERROR');
    space();
    if (text[at] === '{') {
      at++; space(); const keys = new Set<string>();
      if (text[at] === '}') { at++; return; }
      while (true) {
        space(); const key = string();
        if (keys.has(key)) throw new RustSidecarError('PROTOCOL_ERROR');
        keys.add(key); space(); at++; scan(depth + 1); space();
        if (text[at++] === '}') return;
      }
    }
    if (text[at] === '[') {
      at++; space(); if (text[at] === ']') { at++; return; }
      while (true) { scan(depth + 1); space(); if (text[at++] === ']') return; }
    }
    if (text[at] === '"') { string(); return; }
    while (at < text.length && !/[,\]}\s]/.test(text[at]!)) at++;
  }
  scan(0); space();
  if (at !== text.length) throw new RustSidecarError('PROTOCOL_ERROR');
  return value;
}
/** 只接受一次公开读取返回的完整页；不拼接多页冒充一致性快照。 */
export function freezeCollectionSnapshot(identity: DatasetOwnerIdentity, completePage: Page<CollectionModel>): RustReadonlySnapshot {
  const source = jsonCopy(identity), page = jsonCopy(completePage);
  if (!isCollectionPage(page, isCollectionModel) || page.offset !== 0
    || page.hasMore || page.items.length !== page.total) throw new RustSidecarError('INVALID_REQUEST');
  return copySnapshot({ epoch: source.epoch, datasetId: source.datasetId, snapshotId: randomUUID(), models: page.items });
}
function copySnapshot(value: RustReadonlySnapshot): RustReadonlySnapshot {
  const copy = jsonCopy(value);
  if (!record(copy) || !exact(copy, ['epoch', 'datasetId', 'snapshotId', 'models'])
    || ![copy.epoch, copy.datasetId, copy.snapshotId].every(isCollectionId) || !Array.isArray(copy.models)) throw new RustSidecarError('INVALID_REQUEST');
  if (copy.models.length > RUST_SIDECAR_LIMITS.models) throw new RustSidecarError('CAPACITY_EXCEEDED');
  if (!copy.models.every(m => isCollectionModel(m) && typeof m.collectorPolicy === 'string')
    || new Set(copy.models.map(m => m.id)).size !== copy.models.length) throw new RustSidecarError('INVALID_REQUEST');
  function freeze(v: unknown): void { if (v !== null && typeof v === 'object') { Object.values(v).forEach(freeze); Object.freeze(v); } }
  freeze(copy);
  return copy;
}
type Operation = 'prepare' | 'commitBoot' | 'dispatch' | 'close';
interface Pending {
  operation: Operation; sequence: number; timer: NodeJS.Timeout;
  deadline: number; sent: boolean;
  resolve(value: unknown): void; reject(error: RustSidecarError): void; promise: Promise<unknown>;
  request?: IpcRequest;
}
function budget(value: number | undefined, fallback: number): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1 || result > 30_000) throw new RustSidecarError('INVALID_REQUEST');
  return result;
}
function checkBinary(binary: RustReadonlySidecarOptions['binary']): void {
  try {
    if (!path.isAbsolute(binary.path) || !/^[a-f0-9]{64}$/.test(binary.sha256)) throw new Error();
    const before = lstatSync(binary.path);
    if (!before.isFile() || before.isSymbolicLink() || realpathSync(binary.path) !== binary.path
      || process.platform !== 'win32' && (before.mode & 0o111) === 0) throw new Error();
    const digest = createHash('sha256').update(readFileSync(binary.path)).digest('hex');
    const after = lstatSync(binary.path);
    if (digest !== binary.sha256 || before.ino !== after.ino || before.dev !== after.dev
      || before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error();
  } catch { throw new RustSidecarError('BINARY_PIN_MISMATCH'); }
}
/** 显式只读适配器；不接收数据目录，也不改变正式 Core 的默认 owner。 */
export function createRustReadonlyDatasetEndpoint(options: RustReadonlySidecarOptions): RustReadonlyDatasetEndpoint {
  const snapshot = copySnapshot(options.snapshot);
  const binary = { ...options.binary };
  const requestTimeout = budget(options.requestTimeoutMs, 5_000), closeTimeout = budget(options.closeTimeoutMs, 5_000);
  let child: ChildProcessWithoutNullStreams | undefined;
  let phase: 'new' | 'starting' | 'prepared' | 'ready' | 'closed' = 'new';
  let failure: RustSidecarError | undefined, closing = false, closeAck = false, exited = false, sequence = 0;
  let closeDeadline = Infinity;
  let preparePromise: Promise<DatasetOwnerIdentity> | undefined, bootPromise: Promise<void> | undefined, closePromise: Promise<void> | undefined;
  let writeTail = Promise.resolve();
  const pending = new Map<string, Pending>();
  let fragments: Buffer[] = [], fragmentBytes = 0;
  let resolveExit!: () => void, rejectExit!: (error: RustSidecarError) => void;
  const exitPromise = new Promise<void>((resolve, reject) => { resolveExit = resolve; rejectExit = reject; });
  void exitPromise.catch(() => {});
  function fail(code: RustSidecarErrorCode): void {
    if (failure) return;
    failure = new RustSidecarError(code);
    fragments = []; fragmentBytes = 0;
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(failure); }
    pending.clear(); rejectExit(failure);
    if (child && !exited) child.kill('SIGKILL');
    try { options.onFatal?.(code); } catch { /* 诊断观察者不能改变清理。 */ }
  }
  function validateResult(item: Pending, result: unknown): boolean {
    if (item.operation === 'commitBoot' || item.operation === 'close') return result === null;
    if (item.operation === 'prepare') {
      return record(result) && exact(result, ['epoch', 'datasetId', 'snapshotId', 'readOnly', 'capabilities', 'modelCount'])
        && result.epoch === snapshot.epoch && result.datasetId === snapshot.datasetId && result.snapshotId === snapshot.snapshotId
        && result.readOnly === true && Array.isArray(result.capabilities) && result.capabilities.length === 1
        && result.capabilities[0] === 'collection.list' && result.modelCount === snapshot.models.length;
    }
    const request = item.request!;
    const response = validateIpcResponseForCommand({ version: 1, id: request.id, ok: true, result }, 'collection.list');
    if (!response.ok || !response.value.ok || !record(request.payload) || !record(request.payload.page)) return false;
    const page = response.value.result;
    // 合法 DTO 仍不能把另一快照/分页内容混进本次读取。
    return page.offset === request.payload.page.offset && page.limit === request.payload.page.limit
      && page.total === snapshot.models.length
      && isDeepStrictEqual(page.items, snapshot.models.slice(page.offset, page.offset + page.limit));
  }
  function receive(value: unknown): void {
    if (failure || !record(value)) { fail('PROTOCOL_ERROR'); return; }
    const common = ['protocolVersion', 'requestId', 'epoch', 'datasetId', 'snapshotId', 'sequence', 'operation', 'ok'];
    if (!exact(value, [...common, value.ok === true ? 'result' : 'error']) || value.protocolVersion !== 1
      || value.epoch !== snapshot.epoch || value.datasetId !== snapshot.datasetId || value.snapshotId !== snapshot.snapshotId
      || typeof value.requestId !== 'string') { fail('PROTOCOL_ERROR'); return; }
    const item = pending.get(value.requestId);
    if (!item || !item.sent || item.sequence !== value.sequence || item.operation !== value.operation || typeof value.ok !== 'boolean') { fail('PROTOCOL_ERROR'); return; }
    if (performance.now() >= item.deadline) { fail('TIMEOUT'); return; }
    if (value.ok ? !validateResult(item, value.result) : !record(value.error) || !exact(value.error, ['code', 'message'])
      || typeof value.error.code !== 'string' || !wireCodes.has(value.error.code)
      || typeof value.error.message !== 'string' || value.error.message.length > 160) { fail('PROTOCOL_ERROR'); return; }
    if (performance.now() >= item.deadline) { fail('TIMEOUT'); return; }
    clearTimeout(item.timer); pending.delete(value.requestId);
    if (!value.ok) {
      item.reject(new RustSidecarError((value.error as { code: RustSidecarErrorCode }).code));
      if (item.operation === 'close' || item.operation === 'prepare') fail('PROTOCOL_ERROR');
      return;
    }
    if (item.operation === 'close') closeAck = true;
    item.resolve(value.result);
  }
  function consume(chunk: Buffer): void {
    if (failure) return;
    for (let start = 0; start < chunk.length;) {
      const end = chunk.indexOf(10, start), stop = end < 0 ? chunk.length : end;
      fragmentBytes += stop - start;
      if (fragmentBytes > RUST_SIDECAR_LIMITS.frameBytes) { fail('CAPACITY_EXCEEDED'); return; }
      fragments.push(chunk.subarray(start, stop));
      if (end < 0) return;
      const frame = Buffer.concat(fragments, fragmentBytes);
      fragments = []; fragmentBytes = 0;
      try { receive(strictJson(new TextDecoder('utf-8', { fatal: true }).decode(frame))); }
      catch { fail('PROTOCOL_ERROR'); }
      if (failure) return;
      start = end + 1;
    }
  }
  function start(): void {
    checkBinary(binary);
    child = childProcess.spawn(binary.path, [], {
      shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      cwd: path.dirname(binary.path), env: { LANG: 'C.UTF-8' },
    });
    child.on('error', () => fail('PROCESS_EXIT'));
    child.stdin.on('error', () => fail('PROCESS_EXIT'));
    child.stdout.on('data', consume);
    child.stdout.on('end', () => { if (fragmentBytes) fail('PROTOCOL_ERROR'); });
    child.stderr.on('data', () => { /* 原生 stderr 只消费，不转发或持有。 */ });
    child.on('close', (code, signal) => {
      exited = true;
      if (!failure && closeAck && closing && code === 0 && signal === null && pending.size === 0) {
        try {
          checkBinary(binary);
          if (performance.now() >= closeDeadline) fail('TIMEOUT'); else resolveExit();
        } catch { fail('BINARY_PIN_MISMATCH'); }
      } else fail('PROCESS_EXIT');
    });
  }
  function rpc(operation: Operation, payload: unknown, request?: IpcRequest): Promise<unknown> {
    if (failure) return Promise.reject(failure);
    if (pending.size >= RUST_SIDECAR_LIMITS.inflight || sequence >= RUST_SIDECAR_LIMITS.sequence - (operation === 'close' ? 0 : 1)) return Promise.reject(new RustSidecarError('CAPACITY_EXCEEDED'));
    const requestId = randomUUID(), nextSequence = sequence + 1;
    const frame = Buffer.from(JSON.stringify({ protocolVersion: 1, requestId, epoch: snapshot.epoch, datasetId: snapshot.datasetId,
      snapshotId: snapshot.snapshotId, sequence: nextSequence, operation, payload }) + '\n');
    if (frame.length - 1 > RUST_SIDECAR_LIMITS.frameBytes) return Promise.reject(new RustSidecarError('CAPACITY_EXCEEDED'));
    sequence = nextSequence;
    let resolve!: Pending['resolve'], reject!: Pending['reject'];
    const promise = new Promise<unknown>((yes, no) => { resolve = yes; reject = no; });
    void promise.catch(() => {});
    const timeout = operation === 'close' ? Math.max(1, closeDeadline - performance.now()) : requestTimeout;
    const timer = setTimeout(() => fail('TIMEOUT'), timeout);
    const item: Pending = { operation, sequence, resolve, reject, timer, promise, deadline: performance.now() + timeout, sent: false, ...(request ? { request } : {}) };
    pending.set(requestId, item);
    writeTail = writeTail.then(() => new Promise<void>((yes, no) => {
      if (failure || !child || exited) { no(failure ?? new RustSidecarError('PROCESS_EXIT')); return; }
      if (performance.now() >= item.deadline) { fail('TIMEOUT'); no(failure!); return; }
      item.sent = true;
      child.stdin.write(frame, error => { if (error) no(error); else yes(); });
    }));
    void writeTail.catch(() => fail('PROCESS_EXIT'));
    return promise;
  }
  const endpoint: RustReadonlyDatasetEndpoint = {
    readOnly: true, snapshotId: snapshot.snapshotId, capabilities: Object.freeze(['collection.list'] as const),
    prepare() {
      if (failure) return Promise.reject(failure);
      if (closing || phase === 'closed') return Promise.reject(new RustSidecarError('CLOSING'));
      if (preparePromise) return preparePromise;
      phase = 'starting';
      preparePromise = (async () => {
        try { start(); await rpc('prepare', { models: snapshot.models }); if (failure) throw failure; phase = 'prepared'; return { epoch: snapshot.epoch, datasetId: snapshot.datasetId }; }
        catch (error) { fail(error instanceof RustSidecarError ? error.code : 'PROCESS_EXIT'); throw failure!; }
      })();
      return preparePromise;
    },
    commitBoot() {
      if (failure) return Promise.reject(failure);
      if (closing || phase === 'closed') return Promise.reject(new RustSidecarError('CLOSING'));
      if (bootPromise) return bootPromise;
      if (phase !== 'prepared') return Promise.reject(new RustSidecarError('NOT_READY'));
      bootPromise = rpc('commitBoot', {}).then(() => { if (failure) throw failure; phase = 'ready'; });
      return bootPromise;
    },
    async dispatch(input) {
      if (failure) throw failure;
      if (closing || phase === 'closed') throw new RustSidecarError('CLOSING');
      if (phase !== 'ready') throw new RustSidecarError('NOT_READY');
      const validated = validateIpcRequest(jsonCopy(input));
      if (!validated.ok) throw new RustSidecarError('INVALID_REQUEST');
      const request = jsonCopy(validated.value);
      if (request.command !== 'collection.list') throw new RustSidecarError('UNSUPPORTED_COMMAND');
      if (request.expectedDatasetId !== undefined && request.expectedDatasetId !== snapshot.datasetId) throw new RustSidecarError('SCOPE_MISMATCH');
      const filter = (request.payload as { filter?: Record<string, unknown> }).filter;
      if (filter && Object.keys(filter).length) throw new RustSidecarError('UNSUPPORTED_FILTER');
      const result = await rpc('dispatch', { request }, request);
      if (failure) throw failure;
      return result;
    },
    close() {
      if (closePromise) return closePromise;
      closing = true;
      closeDeadline = performance.now() + closeTimeout;
      closePromise = (async () => {
        if (phase === 'new' && !failure) { phase = 'closed'; return; }
        const timer = setTimeout(() => fail('TIMEOUT'), closeTimeout);
        try {
          if (preparePromise) await preparePromise;
          if (bootPromise) await bootPromise;
          await Promise.allSettled([...pending.values()].map(item => item.promise));
          if (failure) throw failure;
          if (performance.now() >= closeDeadline) throw new RustSidecarError('TIMEOUT');
          await rpc('close', {});
          child!.stdin.end();
          await exitPromise;
          if (performance.now() >= closeDeadline) throw new RustSidecarError('TIMEOUT');
          phase = 'closed';
        } catch (error) {
          fail(error instanceof RustSidecarError ? error.code : 'PROTOCOL_ERROR');
          throw failure!;
        } finally { clearTimeout(timer); }
      })();
      void closePromise.catch(() => {});
      return closePromise;
    },
  };
  return endpoint;
}
