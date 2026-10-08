import type { DatabaseSync } from 'node:sqlite';
import type { AudioAsset, LibraryRoot, LocalTrack, ScanJobRecord } from '@music-bridge/contracts';
import type { ScanFileState } from './local-scan-facts.js';
import type { RelocationReadAccess } from './source-relocation-verify.js';

export interface RelocationEndpoint {
  readonly libraryRootId: string;
  readonly sourceRootId: string;
  readonly rootRevision: string;
  readonly relative: string;
}
export interface RelocationScanMapping {
  readonly operationId: string;
  readonly resourceId: string;
  readonly beforeAsset: AudioAsset;
  readonly tracks: readonly LocalTrack[];
  readonly destination: RelocationEndpoint;
}
export interface RelocationScanReadRequest {
  readonly datasetId: string;
  readonly planId: string;
  readonly planHash: string;
  readonly resourceClosureHash: string;
  readonly mappings: readonly RelocationScanMapping[];
}
export interface RelocationCatalogCommitContext extends RelocationScanReadRequest {
  readonly commitCommandId: string;
  readonly afterAssets: readonly AudioAsset[];
}
export interface RelocationScanOrigin {
  readonly job: ScanJobRecord;
  readonly batchId: string;
  readonly startCommandId: string;
  readonly startFingerprint: string;
  readonly resumeCommandId: string;
  readonly resumeFingerprint: string;
  readonly prepareCommandId: string;
  readonly prepareFingerprint: string;
  readonly commitCommandId: string;
  readonly commitFingerprint: string;
  readonly checkpointId: string;
  readonly itemIndex: number;
}
export interface RelocationBoundScanFact {
  readonly operationId: string;
  readonly resourceId: string;
  readonly origin: RelocationScanOrigin;
  readonly state: ScanFileState;
}
export interface RelocationScanDelta {
  readonly facts: readonly RelocationBoundScanFact[];
  readonly changedRows: number;
  publish(): void;
}
export interface RelocationScanAuthor {
  prepare(request: RelocationScanReadRequest, access: RelocationReadAccess, signal: AbortSignal): Promise<unknown>;
  commit(context: RelocationCatalogCommitContext, prepared: unknown): RelocationScanDelta;
}
declare const preparedRelocationReadsBrand: unique symbol;
export interface PreparedRelocationReads { readonly [preparedRelocationReadsBrand]: true }
interface Ticket { db: DatabaseSync; author: RelocationScanAuthor; request: RelocationScanReadRequest; prepared: unknown; consumed: boolean }
const ports = new WeakMap<DatabaseSync, RelocationScanAuthor>();
const tickets = new WeakMap<object, Ticket>();
const isolatedSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;

/** 仅做叶端口的完整数据快照；Parser、根许可及真实数据库事实仍由原Scanner作者认证。 */
function snapshot<T>(value: T): T {
  let nodes = 0, textBytes = 0;
  function visit(input: unknown, depth: number): unknown {
    if (++nodes > 65536 || depth > 32) throw new Error('移动扫描上下文超出完整快照预算。');
    if (input === null || typeof input === 'boolean') return input;
    if (typeof input === 'number' && Number.isSafeInteger(input) && !Object.is(input, -0)) return input;
    if (typeof input === 'string') {
      if (isolatedSurrogate.test(input)) throw new Error('移动扫描上下文含孤立Unicode代理项。');
      textBytes += Buffer.byteLength(input, 'utf8');
      if (textBytes > 131072) throw new Error('移动扫描上下文文本预算已满。');
      return input;
    }
    if (!input || typeof input !== 'object') throw new Error('移动扫描上下文不是完整数据。');
    const array = Array.isArray(input), prototype = Object.getPrototypeOf(input);
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) throw new Error('移动扫描上下文含可执行对象。');
    const own = Object.getOwnPropertyDescriptors(input);
    if (Reflect.ownKeys(input).some(key => typeof key !== 'string')) throw new Error('移动扫描上下文含非数据键。');
    if (array) {
      const length = (input as unknown[]).length;
      if (Object.keys(own).length !== length + 1) throw new Error('移动扫描数组缺项或含额外属性。');
      const result = [];
      for (let at = 0; at < length; at++) {
        const entry = own[String(at)];
        if (!entry || !('value' in entry) || !entry.enumerable) throw new Error('移动扫描数组含访问器。');
        result.push(visit(entry.value, depth + 1));
      }
      return Object.freeze(result);
    }
    const result: Record<string, unknown> = Object.create(null);
    for (const key of Object.keys(own).sort()) {
      const entry = own[key]!;
      if (!('value' in entry) || !entry.enumerable) throw new Error('移动扫描对象含访问器。');
      if (isolatedSurrogate.test(key)) throw new Error('移动扫描上下文键含孤立Unicode代理项。');
      textBytes += Buffer.byteLength(key, 'utf8');
      result[key] = visit(entry.value, depth + 1);
    }
    return Object.freeze(result);
  }
  const result = visit(value, 0) as T;
  if (textBytes > 131072 || Buffer.byteLength(JSON.stringify(result), 'utf8') > 4194304) throw new Error('移动扫描完整上下文超预算。');
  return result;
}
function requestFor(value: RelocationScanReadRequest): RelocationScanReadRequest {
  const captured = snapshot(value);
  if (!Array.isArray(captured.mappings) || !captured.mappings.length || captured.mappings.length > 256
      || new Set(captured.mappings.map(row => row.resourceId)).size !== captured.mappings.length
      || new Set(captured.mappings.map(row => row.operationId)).size > 100) throw new Error('移动扫描资源映射不完整。');
  return captured;
}
function sameRequest(a: RelocationScanReadRequest, b: RelocationScanReadRequest): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** 原Scanner在同一连接安装一次；本模块没有SQL、事务或另一个writer。 */
export function installRelocationScanPort(db: DatabaseSync, author: RelocationScanAuthor): void {
  if (!db || typeof db !== 'object' || !author || typeof author.prepare !== 'function' || typeof author.commit !== 'function') throw new Error('移动扫描缺少原作者闭包。');
  const prior = ports.get(db);
  if (prior && prior !== author) throw new Error('移动扫描作者不能在现有连接上替换。');
  ports.set(db, author);
}
export async function prepareRelocationScanReads(db: DatabaseSync, request: RelocationScanReadRequest, access: RelocationReadAccess, signal: AbortSignal): Promise<PreparedRelocationReads> {
  const author = ports.get(db);
  if (!author || signal.aborted) throw new Error('移动扫描未就绪或已取消。');
  const captured = requestFor(request), prepared = await author.prepare(captured, access, signal);
  if (signal.aborted || ports.get(db) !== author) throw new Error('移动扫描准备期间作者或准入已改变。');
  const ticket = Object.freeze({}) as unknown as PreparedRelocationReads;
  tickets.set(ticket, { db, author, request: captured, prepared, consumed: false });
  return ticket;
}
/** ticket只在原连接、原作者、完整原请求的同步事务中消费一次；失败不重放。 */
export function applyRelocationScanFacts(db: DatabaseSync, context: RelocationCatalogCommitContext, reads: PreparedRelocationReads): RelocationScanDelta {
  const ticket = reads && typeof reads === 'object' ? tickets.get(reads) : undefined;
  if (!ticket || ticket.db !== db || ticket.author !== ports.get(db) || ticket.consumed) throw new Error('移动扫描读证明不是本事务的真实ticket。');
  const { commitCommandId, afterAssets, ...request } = snapshot(context);
  if (typeof commitCommandId !== 'string' || !commitCommandId || !Array.isArray(afterAssets)
      || afterAssets.length !== ticket.request.mappings.length || !sameRequest(ticket.request, requestFor(request))) throw new Error('移动扫描提交改变了完整映射。');
  ticket.consumed = true;
  const delta = ticket.author.commit({ ...request, commitCommandId, afterAssets }, ticket.prepared);
  if (!delta || typeof (delta as unknown as { then?: unknown }).then === 'function'
      || !Array.isArray(delta.facts) || delta.facts.length !== ticket.request.mappings.length
      || !Number.isSafeInteger(delta.changedRows) || delta.changedRows < 0 || typeof delta.publish !== 'function') throw new Error('移动扫描作者未返回完整同步事实。');
  return delta;
}
