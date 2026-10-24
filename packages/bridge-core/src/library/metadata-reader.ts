import { randomUUID } from 'node:crypto';
import type { FileHandle } from 'node:fs/promises';
import { getRustMediaWorkerPool } from './rust-media-worker.js';
import { logLibraryOperation } from '../shared/library-operation-log.js';
import { SourceFileError, MetadataLeaseReleaseError, withCheckedReadonlyMetadataSource } from '../recording/source-files.js';
import { withRelocationMetadataRead, type RelocationReadAccess } from '../collection/source-relocation-verify.js';
import { DEFAULT_METADATA_READ_BUDGET, RUST_MEDIA_METADATA_PARSER_VERSION, CUE_HEADER_METADATA_PARSER_VERSION, type MetadataReaderPort, type MetadataReaderOptions, type MetadataReaderLifecycle,
  type MetadataReadInput, type MetadataReadResult, type MetadataReadFailure, type MetadataReadBudget, type MetadataWorkerInput } from './metadata-reader-types.js';

const failure = (code: MetadataReadFailure): MetadataReadResult => ({ status: 'failure', code, readEvidence: null });
type RelocationReader = (input: MetadataReadInput, access: RelocationReadAccess, signal?: AbortSignal) => Promise<MetadataReadResult>;
interface RelocationRead { access: RelocationReadAccess }
const relocationReaders = new WeakMap<MetadataReaderPort, RelocationReader>();
/** 本域可信读取只进入真实原Reader；公开read/close与input不增加绕过字段。 */
export function readRelocationMetadata(reader: MetadataReaderPort, input: MetadataReadInput, access: RelocationReadAccess,
  signal?: AbortSignal): Promise<MetadataReadResult> {
  const read = relocationReaders.get(reader);
  return read ? read(input, access, signal) : Promise.resolve(failure('ADMISSION_FAILED'));
}
const sourceCodes = new Set(['REVOKED','SOURCE_ROOT_OFFLINE','OUTSIDE_ROOT','MISSING','CONTENT_CHANGED','IO_ERROR']);
function classify(error: unknown): MetadataReadFailure {
  if (error instanceof MetadataLeaseReleaseError) return 'LEASE_RELEASE_FAILED';
  if (error instanceof SourceFileError) {
    if (sourceCodes.has(error.code)) return error.code as MetadataReadFailure;
    if (error.code === 'CANCELLED') return 'CANCELLED';
    if (error.code === 'LIMIT_EXCEEDED') return 'BUDGET_EXCEEDED';
  }
  return 'IO_ERROR';
}
interface PendingRead { controller: AbortController; started: boolean; run(): Promise<void>; cancelQueued(): void; promise: Promise<MetadataReadResult> }
const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const keys = (value: Record<string, unknown>, names: readonly string[]): boolean => Reflect.ownKeys(value).length === names.length
  && Reflect.ownKeys(value).every(key => typeof key === 'string' && names.includes(key) && Object.prototype.propertyIsEnumerable.call(value, key));
const nonnegative = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
function checkedRustResult(value: MetadataReadResult, input: MetadataWorkerInput): boolean {
  if (value.status === 'failure') return true;
  if (!object(value) || !keys(value,['status','parserVersion','fields','technical','coverEvidence','readEvidence'])
    || !object(value.fields) || Reflect.ownKeys(value.fields).some(key => typeof key !== 'string' || !['title','artist','album','year','disc','track','albumArtist','artists','albumArtists'].includes(key))) return false;
  let textBytes=0;
  for(const [key,field] of Object.entries(value.fields)) {
    const values=key==='artists'||key==='albumArtists' ? field : [field];
    if(!Array.isArray(values)||values.length>64||values.some(v=>typeof v!=='string'||Buffer.byteLength(v)>input.budget.textFieldBytes))return false;
    if((key==='artists'||key==='albumArtists')&&new Set(values).size!==values.length)return false;
    for(const v of values)textBytes+=Buffer.byteLength(v);
  }
  if(textBytes>input.budget.totalTextBytes)return false;
  const technical=value.technical,evidence=value.readEvidence;
  if(!object(technical) || !keys(technical,['container','codec','lossless','sampleRateHz','channels','bitsPerSample','durationSeconds','evidence'])
    || typeof technical.codec !== 'string' || technical.codec.length<1 || Buffer.byteLength(technical.codec)>512
    || !(technical.lossless===null || typeof technical.lossless==='boolean') || !nonnegative(technical.sampleRateHz) || technical.sampleRateHz===0
    || !Number.isSafeInteger(technical.channels) || technical.channels<1 || technical.channels>64
    || !(technical.bitsPerSample===null || nonnegative(technical.bitsPerSample)) || !(technical.durationSeconds===null || nonnegative(technical.durationSeconds))
    || technical.evidence!=='bounded-parser-reported' || !object(evidence)
    || !keys(evidence,['bytesRead','readCalls','maxReadBytes','allocationBytes','elapsedMs','wholeAudioHash','wholeAudioDecode']))return false;
  for(const field of ['bytesRead','readCalls','maxReadBytes','allocationBytes'] as const)if(!Number.isSafeInteger(evidence[field]) || evidence[field]<0)return false;
  if(evidence.bytesRead>input.budget.totalReadBytes || evidence.maxReadBytes>input.budget.singleReadBytes
    || evidence.allocationBytes>input.budget.totalAllocationBytes || !nonnegative(evidence.elapsedMs) || evidence.wholeAudioHash!==false || evidence.wholeAudioDecode!==false
    || !Array.isArray(value.coverEvidence) || value.coverEvidence.length>8)return false;
  for(const cover of value.coverEvidence)if(!object(cover) || !keys(cover,['mime','bytes','sha256','evidence']) || !['image/png','image/jpeg'].includes(cover.mime)
    || !Number.isSafeInteger(cover.bytes) || cover.bytes<1 || cover.bytes>input.budget.coverBytes || !/^[a-f0-9]{64}$/u.test(cover.sha256)
    || cover.evidence!=='encoded-bytes-magic-and-digest')return false;
  if(['DSF','DFF'].includes(technical.container) && (!input.dsdMetadataEnabled || technical.codec!=='DSD' || technical.lossless!==true
    || technical.bitsPerSample!==1 || ![2822400,3072000,5644800,6144000,11289600,12288000,22579200,24576000].includes(technical.sampleRateHz)
    || technical.channels>6 || !nonnegative(technical.durationSeconds) || technical.durationSeconds===0))return false;
  if(value.parserVersion===CUE_HEADER_METADATA_PARSER_VERSION)return input.cueInputMetadataEnabled===true
    && ['TTA','TAK'].includes(technical.container) && Object.keys(value.fields).length===0 && value.coverEvidence.length===0;
  return value.parserVersion===RUST_MEDIA_METADATA_PARSER_VERSION && (['FLAC','MPEG','MP4','WAVE','AIFF','DSF','DFF'].includes(technical.container)
    || input.cueInputMetadataEnabled===true && ['OGG','WAVPACK','APE','MPC'].includes(technical.container));
}
/** 所有读取仍经原 Source/relocation 门禁，解析使用同 Owner 的有界常驻 Rust 池。 */
export function createMetadataReader(options: MetadataReaderOptions = {}): MetadataReaderPort {
  const concurrency = options.concurrency ?? 1, maxPending = options.maxPending ?? 16, cueInputMetadataEnabled = options.cueInputMetadataEnabled === true;
  if (![1,2,8].includes(concurrency) || !Number.isSafeInteger(maxPending) || maxPending < 0 || maxPending > 64) throw new Error('元数据reader池预算无效。');
  const budget: MetadataReadBudget = { ...DEFAULT_METADATA_READ_BUDGET, ...options.trustedBudget };
  for (const key of Object.keys(DEFAULT_METADATA_READ_BUDGET) as (keyof MetadataReadBudget)[]) {
    if (!Number.isSafeInteger(budget[key]) || budget[key] < 1 || budget[key] > DEFAULT_METADATA_READ_BUDGET[key]) throw new Error('元数据reader仅允许可信低预算。');
  }
  if (options.trustedBudget && Object.keys(options.trustedBudget).some(k => !Object.hasOwn(DEFAULT_METADATA_READ_BUDGET,k))) throw new Error('元数据reader预算包含未知字段。');
  const emit = (event: MetadataReaderLifecycle): void => { try { options.onLifecycle?.(event); } catch { /* 诊断观察者不能阻止真实关闭。 */ } };
  const queue: PendingRead[] = [], jobs = new Set<PendingRead>(); let active = 0, closed = false, closePromise: Promise<void> | undefined;
  let fatalLeaseFailure = false;
  const pump = (): void => {
    if (fatalLeaseFailure) {
      for (const job of [...queue]) { job.controller.abort(); job.cancelQueued(); }
      return;
    }
    while (active < concurrency && queue.length) {
      const job = queue.shift()!; if (!jobs.has(job)) continue;
      job.started = true; ++active;
      void job.run().finally(() => { --active; pump(); });
    }
  };
  const runWorker = async (handle: FileHandle, input: MetadataWorkerInput, signal: AbortSignal, readId: string): Promise<MetadataReadResult> => {
    const started = performance.now();
    let bytesRead = 0;
    const phase = (stage: 'read' | 'parse', state: 'start' | 'complete' | 'cancel' | 'error', values: { queueWaitMs: number; readMs: number; parseMs: number }, code?: MetadataReadFailure): void => {
      const elapsedMs = Math.max(0, performance.now() - started);
      emit({ type: 'metadata-phase', readId, stage, state, backend: 'rust-media-worker', ...values, elapsedMs, slow: elapsedMs >= 250, ...(code ? { code } : {}) });
      logLibraryOperation('metadata', `metadata.${stage}`, state === 'cancel' ? 'cancelled' : state, { id: readId, ...values, elapsedMs, ...(code ? { code } : {}) });
    };
    const zero = { queueWaitMs: 0, readMs: 0, parseMs: 0 };
    phase('read', 'start', zero); phase('parse', 'start', zero);
    // Node 保留已核验只读 FD 的所有权。Rust 只能请求有界位置读取，不能取得源路径或自行打开源文件。
    const result = await getRustMediaWorkerPool().readMetadata({ size: input.size, budget: input.budget,
      dsdMetadataEnabled: input.dsdMetadataEnabled === true, cueInputMetadataEnabled: input.cueInputMetadataEnabled === true, includeEmbeddedArtwork: input.includeEmbeddedArtwork !== false,
      async read(offset, length) {
        signal.throwIfAborted();
        if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 1
          || length > budget.singleReadBytes || length > budget.singleAllocationBytes || offset > input.size || length > input.size - offset
          || bytesRead + length > budget.totalReadBytes) throw new SourceFileError('LIMIT_EXCEEDED');
        const buffer = Buffer.alloc(length), read = await handle.read(buffer, 0, length, offset);
        bytesRead += read.bytesRead;
        return buffer.subarray(0, read.bytesRead);
      },
    }, signal);
    // performance 是当前读取的诊断，不改变持久 readEvidence 的闭集合同。
    const { performance: _performance, ...metadata } = result;
    const checked=checkedRustResult(metadata,input) ? metadata:failure('WORKER_FAILED');
    const values = result.performance ?? { queueWaitMs: 0, readMs: 0, parseMs: result.readEvidence?.elapsedMs ?? 0 };
    const state = checked.status === 'ok' ? 'complete' : checked.code === 'CANCELLED' ? 'cancel' : 'error';
    phase('read', state, values, checked.status === 'failure' ? checked.code : undefined);
    phase('parse', state, values, checked.status === 'failure' ? checked.code : undefined);
    return checked;
  };
  const execute = async (input: MetadataReadInput, signal: AbortSignal, relocation: RelocationRead | undefined, readId: string): Promise<MetadataReadResult> => {
    let release: (() => void | Promise<void>) | undefined;
    try {
      if (signal.aborted) return failure('CANCELLED');
      if (options.readAdmission) {
        try { release = await options.readAdmission.acquire(signal); }
        catch { return failure(signal.aborted ? 'CANCELLED' : 'ADMISSION_FAILED'); }
      }
      if (signal.aborted) return failure('CANCELLED');
      if (relocation) return await withRelocationMetadataRead(relocation.access, input, signal,
        (handle, size) => runWorker(handle, { fd: handle.fd, size, budget, dsdMetadataEnabled: options.dsdMetadataEnabled === true, cueInputMetadataEnabled, includeEmbeddedArtwork: input.includeEmbeddedArtwork !== false }, signal, readId), event => emit(event));
      return await withCheckedReadonlyMetadataSource(input.root, input.relative, input.expectedSignature, signal,
        (handle, size) => runWorker(handle, { fd: handle.fd, size, budget, dsdMetadataEnabled: options.dsdMetadataEnabled === true, cueInputMetadataEnabled, includeEmbeddedArtwork: input.includeEmbeddedArtwork !== false },signal,readId), input.assertCurrent,
        event => emit(event));
    } catch (error) {
      if (error instanceof MetadataLeaseReleaseError) { fatalLeaseFailure = true; return failure('LEASE_RELEASE_FAILED'); }
      return failure(signal.aborted ? 'CANCELLED' : classify(error));
    }
    finally { if (release) await release(); }
  };
  const enqueue = (input: MetadataReadInput, signal?: AbortSignal, relocation?: RelocationRead): Promise<MetadataReadResult> => {
      if (fatalLeaseFailure) return Promise.resolve(failure('LEASE_RELEASE_FAILED'));
      if (closed) return Promise.resolve(failure('CLOSED'));
      if (signal?.aborted) return Promise.resolve(failure('CANCELLED'));
      if (active >= concurrency && queue.length >= maxPending) return Promise.resolve(failure('QUEUE_FULL'));
      const readId = randomUUID(), queuedAt = performance.now();
      logLibraryOperation('metadata', 'metadata.request', 'start', { id: readId });
      logLibraryOperation('metadata', 'metadata.queue', 'start', { id: readId, active, pending: queue.length });
      const controller = new AbortController(); let settle!: (value: MetadataReadResult) => void;
      const promise = new Promise<MetadataReadResult>(resolve => { settle = resolve; });
      const complete = (value: MetadataReadResult): void => {
        signal?.removeEventListener('abort', forward); jobs.delete(job); emit({ type: 'read-complete', status: value.status });
        logLibraryOperation('metadata','metadata.request',value.status==='ok' ? 'complete':value.code==='CANCELLED' ? 'cancelled':'error',
          {id:readId,elapsedMs:Math.max(0,performance.now()-queuedAt),...(value.status==='failure' ? {code:value.code}:{})});
        settle(value);
      };
      const forward = (): void => { controller.abort(); if (!job.started) job.cancelQueued(); };
      const job: PendingRead = { controller, started: false, promise,
        async run() { logLibraryOperation('metadata', 'metadata.queue', 'complete', { id: readId, queueWaitMs: Math.max(0, performance.now() - queuedAt), elapsedMs: Math.max(0, performance.now() - queuedAt), active, pending: queue.length }); let value: MetadataReadResult; try { value = await execute(input,controller.signal,relocation,readId); } catch { value = failure(fatalLeaseFailure ? 'LEASE_RELEASE_FAILED' : 'IO_ERROR'); } complete(value); },
        cancelQueued() { const index = queue.indexOf(job); if (index >= 0) queue.splice(index,1); if (jobs.has(job)) { logLibraryOperation('metadata', 'metadata.queue', 'cancelled', { id: readId, queueWaitMs: Math.max(0, performance.now() - queuedAt), elapsedMs: Math.max(0, performance.now() - queuedAt) }); complete(failure(fatalLeaseFailure ? 'LEASE_RELEASE_FAILED' : 'CANCELLED')); } },
      };
      signal?.addEventListener('abort',forward,{ once: true }); jobs.add(job); queue.push(job); pump(); return promise;
  };
  const port: MetadataReaderPort = {
    read(input, signal) { return enqueue(input, signal); },
    close() {
      if (!closePromise) {
        closed = true; const pending = [...jobs];
        for (const job of pending) { job.controller.abort(); if (!job.started) job.cancelQueued(); }
        closePromise = Promise.all(pending.map(job => job.promise)).then(() => {
          if (fatalLeaseFailure) throw new MetadataLeaseReleaseError();
        });
      }
      return closePromise;
    },
  };
  relocationReaders.set(port, (input, access, signal) => enqueue(input, signal, { access }));
  return port;
}
