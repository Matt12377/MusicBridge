import { createHash } from 'node:crypto';
import {
  isFileAudioParameters, isMobileAudioInfo, type FileAudioParameters, type MobileAudioInfo,
} from '@music-bridge/contracts';
import type { CollectionRepository } from '../collection/repository.js';
import type { createLocalSourceTickets } from '../collection/local-source-tickets.js';
import { isLocalSourceCaptureResult, type LocalSourceCaptureResult } from '../collection/local-source-ticket-types.js';
import { LocalSourcePreparationError } from '../application/local-source-resolver.js';
import { LocalFileLeaseError, LocalFileSourcePool, type AssetLease, type ConfirmedLocalSession } from '../stream/local-file-source.js';
import { LocalSourceFence } from '../stream/local-source-fence.js';
import { PhysicalResourceBusy } from '../stream/physical-resource-locks.js';
import { SourceFileError } from '../recording/source-files.js';
import { isMobileOwnerSourceRequest, isMobileOwnerSourceResult, type MobileOwnerSourceRequest, type MobileOwnerSourceResult } from './source-protocol.js';
import type { MobilePlaybackPreparedSource, MobilePlaybackSourceRequest } from './playback-types.js';
import type { MobileOwnerPrivateFailure } from './types.js';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
const MAX_RECORDS = 2048, MAX_READ_IDS = 4096, MAX_READERS = 32, MAX_RESOURCE_READERS = 4;
type SourceFailure = MobileOwnerPrivateFailure;
class SourceError extends Error {
  constructor(readonly failure: SourceFailure) { super('手机原文件读取能力当前不可用。'); }
}
const failure = (status: SourceFailure['status'], code: SourceFailure['code'], retryable = false): SourceFailure =>
  Object.freeze({ kind: 'mobile-error', status, code, retryable, outcome: null });
const fail = (status: SourceFailure['status'], code: SourceFailure['code'], retryable = false): never => { throw new SourceError(failure(status, code, retryable)); };
const released = (): never => fail(410, 'RESOURCE_RELEASED');
const busy = (): never => fail(429, 'RESOURCE_BUSY', true);
const fingerprint = (selection: MobilePlaybackSourceRequest): string => JSON.stringify([
  selection.resourceId, selection.trackId, selection.versionId, selection.contentRevision,
]);
const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');

interface Lane { ownerId: string; attempt: number; record: SourceRecord | null }
interface ReadRecord {
  handle: string; readId: string; controller: AbortController; closed: boolean;
  nextOffset: number | null; pending: Promise<Uint8Array> | null;
  last: { start: number; maxBytes: number; bytes: Uint8Array | null } | null;
  closing: Promise<void> | null;
}
interface SourceRecord {
  handle: string; selection: MobilePlaybackSourceRequest | null; fingerprint: string | null;
  state: 'preparing' | 'active' | 'releasing' | 'released'; explicitRelease: boolean;
  controller: AbortController; lane: Lane | null; attempt: number;
  capture: LocalSourceCaptureResult | null; fence: LocalSourceFence | null;
  releaseHold: (() => void) | null; lease: AssetLease | null;
  prepared: MobilePlaybackPreparedSource | null; failure: SourceFailure | null;
  preparation: Promise<MobilePlaybackPreparedSource> | null; closing: Promise<void> | null;
  readers: Set<ReadRecord>;
}

/** 仅转换原 Scanner 真正报告的编码词汇；扩展名不创造音频参数。 */
function audio(parameters: FileAudioParameters | undefined): { source: MobileAudioInfo; contentType: MobilePlaybackPreparedSource['contentType']; durationMs: number } {
  if (!parameters || !isFileAudioParameters(parameters) || parameters.durationMs === null) return fail(409, 'UNSUPPORTED_FORMAT');
  const codec = parameters.codec.toLowerCase(), bits = parameters.bitsPerSample;
  let normalized: string, container: string, contentType: string;
  if (parameters.container === 'FLAC' && codec === 'flac' && parameters.lossless === true && bits !== null) {
    normalized = 'flac'; container = 'flac'; contentType = 'audio/flac';
  } else if (parameters.container === 'MP4' && /^(?:alac|apple lossless)$/u.test(codec) && parameters.lossless === true && bits !== null) {
    normalized = 'alac'; container = 'm4a'; contentType = 'audio/mp4';
  } else if (parameters.container === 'MPEG' && /^(?:mp3|mpeg (?:1|2|2\.5) layer (?:3|iii))$/u.test(codec) && parameters.lossless !== true) {
    normalized = 'mp3'; container = 'mp3'; contentType = 'audio/mpeg';
  } else if (['WAVE', 'AIFF'].includes(parameters.container) && parameters.lossless === true && bits !== null && [8, 16, 24, 32].includes(bits)) {
    const expected = bits === 8 ? parameters.container === 'WAVE' ? 'pcm_u8' : 'pcm_s8'
      : `pcm_s${bits}${parameters.container === 'WAVE' ? 'le' : 'be'}`;
    if (codec !== 'pcm' && codec !== expected) return fail(409, 'UNSUPPORTED_FORMAT');
    normalized = expected; container = parameters.container === 'WAVE' ? 'wav' : 'aiff';
    contentType = parameters.container === 'WAVE' ? 'audio/wav' : 'audio/aiff';
  } else return fail(409, 'UNSUPPORTED_FORMAT');
  const source: MobileAudioInfo = { codec: normalized, container, sampleRateHz: parameters.sampleRateHz, channels: parameters.channels,
    ...(bits === null ? {} : { bitsPerSample: bits }) };
  if (!isMobileAudioInfo(source)) return fail(409, 'UNSUPPORTED_FORMAT');
  return { source: Object.freeze(source), contentType, durationMs: parameters.durationMs };
}

/** 原 Owner/SAB 域内组合；手机确认与家庭 Roon 会话完全独立。 */
export function createMobileOwnerSourceService(options: {
  collection: CollectionRepository; tickets: ReturnType<typeof createLocalSourceTickets>;
  datasetId: string; ownerEpoch: string; assertCurrent(): void;
}) {
  const { collection, tickets, datasetId, ownerEpoch } = options;
  if (!UUID.test(datasetId) || !UUID.test(ownerEpoch)) throw new Error('手机源服务需要原 Owner 的完整工作库身份。');
  const pool = new LocalFileSourcePool({ maxLeases: 8 });
  // 固定八条 lane，退休后只推进 attempt；不能让资源 UUID 无界增长 Pool 的 owner 表。
  const lanes: Lane[] = Array.from({ length: 8 }, (_, index) => ({ ownerId: `mobile-${ownerEpoch}-${index}`, attempt: 0, record: null }));
  const records = new Map<string, SourceRecord>(), reads = new Map<string, ReadRecord>();
  let closed = false, closing: Promise<void> | null = null;

  function ownerCurrent(): void {
    if (closed) return fail(503, 'BUSY', true);
    try { options.assertCurrent(); } catch { return fail(503, 'BUSY', true); }
  }
  function asFailure(error: unknown): SourceFailure {
    if (error instanceof SourceError) return error.failure;
    if (error instanceof LocalFileLeaseError) {
      if (error.code === 'CAPACITY') return failure(429, 'RESOURCE_BUSY', true);
      if (error.code === 'CLOSED' || error.code === 'EXPIRED') return failure(410, 'RESOURCE_RELEASED');
      return failure(409, 'SOURCE_CHANGED');
    }
    if (error instanceof LocalSourcePreparationError) return error.code === 'SEGMENT_UNSUPPORTED'
      ? failure(409, 'UNSUPPORTED_FORMAT') : failure(409, 'SOURCE_CHANGED');
    if (error instanceof PhysicalResourceBusy) return failure(429, 'RESOURCE_BUSY', true);
    if (error instanceof SourceFileError) return failure(409, 'SOURCE_CHANGED');
    return failure(503, 'BUSY', true);
  }
  function makeRecord(handle: string): SourceRecord {
    if (records.size >= MAX_RECORDS) return busy();
    const record: SourceRecord = { handle, selection: null, fingerprint: null, state: 'released', explicitRelease: true,
      controller: new AbortController(), lane: null, attempt: 0, capture: null, fence: null, releaseHold: null,
      lease: null, prepared: null, failure: null, preparation: null, closing: null, readers: new Set() };
    records.set(handle, record); return record;
  }
  function selected(selection: MobilePlaybackSourceRequest) {
    ownerCurrent();
    const pieces = selection.trackId.split(':');
    if (pieces.length !== 4 || pieces[0] !== 'lt' || pieces[1] !== datasetId || !UUID.test(pieces[2]!) || !UUID.test(pieces[3]!)) return fail(404, 'INVALID_REQUEST');
    const found = collection.localCatalog.privateMobileCandidates({ kind: 'tracks', offset: 0, limit: 1, query: '', editionId: pieces[3]!, trackId: pieces[2]! });
    if (found.total !== 1 || found.items.length !== 1 || found.items[0]!.trackId !== pieces[2] || found.items[0]!.editionId !== pieces[3]) return fail(404, 'INVALID_REQUEST');
    const detail = collection.localCatalog.trackDetail(pieces[2]!);
    if (!detail.editions.some(edition => edition.id === pieces[3])) return fail(404, 'INVALID_REQUEST');
    if (detail.track.segment !== null) return fail(409, 'UNSUPPORTED_FORMAT');
    const content = digest([datasetId, detail.asset.id, detail.asset.fileRevision, detail.track.selectionRevision, detail.track.segment]);
    if (selection.versionId !== 'lv:' + content || selection.contentRevision !== 'lc:' + content) return fail(409, 'SOURCE_CHANGED');
    const root = collection.localCatalog.root(detail.asset.libraryRootId);
    if (root.role !== 'library' || root.revision !== detail.asset.rootRevision) return fail(409, 'SOURCE_CHANGED');
    return detail;
  }
  function current(record: SourceRecord, preparing = false): void {
    if (record.explicitRelease || record.controller.signal.aborted || record.state !== 'active' && !(preparing && record.state === 'preparing')) {
      if (!record.explicitRelease && record.failure) throw new SourceError(record.failure);
      return released();
    }
    ownerCurrent();
    if (!record.lane || record.lane.record !== record || record.lane.attempt !== record.attempt) return fail(409, 'SOURCE_CHANGED');
    if (!record.capture || !record.fence?.current || !tickets.revalidate(record.capture.ticketId)) return fail(409, 'SOURCE_CHANGED');
    try { selected(record.selection!); }
    catch (error) { if (error instanceof SourceError && error.failure.status === 404) return fail(409, 'SOURCE_CHANGED'); throw error; }
  }
  function permission(record: SourceRecord): ConfirmedLocalSession {
    return { sessionId: record.handle, attempt: record.attempt, isConfirmed() {
      try { current(record); return true; } catch { return false; }
    } };
  }
  function countReaders(): number { let count = 0; for (const record of records.values()) count += record.readers.size; return count; }
  async function closeReader(record: SourceRecord | undefined, read: ReadRecord): Promise<void> {
    if (read.closing) return read.closing;
    read.closed = true; read.controller.abort();
    read.closing = (async () => {
      if (read.pending) await Promise.allSettled([read.pending]);
      read.last = null; record?.readers.delete(read);
    })();
    return read.closing;
  }
  function releaseRecord(record: SourceRecord, explicit = false): Promise<void> {
    if (explicit) record.explicitRelease = true;
    if (record.closing) return record.closing;
    record.state = 'releasing'; record.controller.abort();
    for (const read of record.readers) read.controller.abort();
    record.closing = (async () => {
      // 迟到 prepare 必须先实际退出；它不能在 ACK 之后才打开 FD。
      if (record.preparation) await Promise.allSettled([record.preparation]);
      await Promise.all([...record.readers].map(read => closeReader(record, read)));
      if (record.lease) await record.lease.close();
      // close 拒绝意味着 FD/claims quiet 未确认，以下保护和 lane 不释放。
      record.releaseHold?.(); record.releaseHold = null;
      if (record.capture) tickets.release(record.capture.ticketId);
      record.capture = null; record.fence = null;
      if (record.lane?.record === record) record.lane.record = null;
      record.lane = null; record.lease = null; record.prepared = null; record.state = 'released';
    })();
    return record.closing;
  }
  function retireOnSignal(record: SourceRecord): void {
    const leaseFailure = record.lease?.failureCode;
    if (!record.explicitRelease && record.failure === null && leaseFailure) record.failure = asFailure(new LocalFileLeaseError(leaseFailure));
    void releaseRecord(record).catch(() => { record.failure = failure(503, 'BUSY', true); });
  }
  async function prepareRecord(record: SourceRecord): Promise<MobilePlaybackPreparedSource> {
    try {
      if (record.controller.signal.aborted || record.explicitRelease) return released();
      const detail = selected(record.selection!);
      const captured = tickets.captureMobile({ local_track_id: detail.track.id, asset_id: detail.asset.id, expected_asset_revision: detail.asset.fileRevision });
      record.capture = captured;
      if (!isLocalSourceCaptureResult(captured) || captured.datasetId !== datasetId || captured.epoch !== ownerEpoch
        || captured.facts.track.id !== detail.track.id || captured.facts.asset.id !== detail.asset.id
        || captured.facts.asset.fileRevision !== detail.asset.fileRevision || captured.facts.track.selectionRevision !== detail.track.selectionRevision) return fail(409, 'SOURCE_CHANGED');
      record.fence = new LocalSourceFence(captured.buffer); record.releaseHold = record.fence.retain();
      const technical = audio(captured.fileParameters);
      current(record, true);
      const lease = await pool.prepare({ source_kind: 'local_file', status: 'prepared_descriptor', facts: captured.facts }, {
        ownerId: record.lane!.ownerId, attempt: record.attempt, isCurrent() { try { current(record, true); return true; } catch { return false; } },
      });
      record.lease = lease;
      lease.signal.addEventListener('abort', () => retireOnSignal(record), { once: true });
      if (lease.signal.aborted) return released();
      current(record, true); record.state = 'active';
      lease.confirmSession(permission(record));
      if (captured.fileParameters?.container === 'WAVE' || captured.fileParameters?.container === 'AIFF') {
        // Scanner 的通用 PCM 名称不包含字节序；只接受真实 FD 的标准 RIFF/WAVE 或 FORM/AIFF。
        // AIFC 的压缩/字节序不能仅凭 AIFF 容器标签猜成 pcm_s*be。
        if (lease.size < 12) return fail(409, 'UNSUPPORTED_FORMAT');
        const head = lease.readSlice(0, 11, record.controller.signal);
        try {
          const item = await head.next(); if (item.done || item.value.length !== 12) return fail(409, 'SOURCE_CHANGED');
          const magic = item.value.subarray(0, 4).toString('ascii'), kind = item.value.subarray(8, 12).toString('ascii');
          if (captured.fileParameters.container === 'WAVE' ? magic !== 'RIFF' || kind !== 'WAVE' : magic !== 'FORM' || kind !== 'AIFF') return fail(409, 'UNSUPPORTED_FORMAT');
        } finally { await head.return(undefined); }
      }
      await lease.verify(); current(record);
      const source: MobilePlaybackPreparedSource = Object.freeze({ handle: record.handle,
        sourceAudio: technical.source, actualAudio: Object.freeze({ ...technical.source }),
        processing: Object.freeze({ mode: 'direct', reason: '原工作库当前扫描文件的直接只读传输。', fromPreparedCache: false }),
        contentType: technical.contentType, size: lease.size, durationMs: technical.durationMs, seekable: true });
      if (!isMobileOwnerSourceResult({ kind: 'mobile-source-prepared', source }, { operation: 'prepare', selection: record.selection! })) return fail(503, 'BUSY', true);
      record.prepared = source; return source;
    } catch (error) {
      const final = record.explicitRelease ? new SourceError(failure(410, 'RESOURCE_RELEASED')) : error;
      record.failure = asFailure(final); record.state = 'releasing'; record.controller.abort(); throw final;
    }
  }
  async function prepare(selection: MobilePlaybackSourceRequest): Promise<MobileOwnerSourceResult> {
    ownerCurrent();
    let record = records.get(selection.resourceId);
    if (record) {
      if (record.fingerprint !== null && record.fingerprint !== fingerprint(selection)) return fail(409, 'IDEMPOTENCY_CONFLICT');
      if (record.explicitRelease) return released();
      if (!record.preparation) return released();
    } else {
      const lane = lanes.find(item => item.record === null && item.attempt < Number.MAX_SAFE_INTEGER);
      if (!lane) return busy();
      record = makeRecord(selection.resourceId); record.selection = selection; record.fingerprint = fingerprint(selection);
      record.state = 'preparing'; record.explicitRelease = false; record.lane = lane; record.attempt = ++lane.attempt; lane.record = record;
      // 先登记原 id/promise，再允许异步打开；release-before-prepare 有真实 tombstone。
      record.preparation = Promise.resolve().then(() => prepareRecord(record!));
    }
    try {
      const source = await record.preparation;
      current(record); return { kind: 'mobile-source-prepared', source: structuredClone(source) };
    } catch (error) {
      await releaseRecord(record); throw error;
    }
  }
  async function active(handle: string): Promise<SourceRecord> {
    const record = records.get(handle); if (!record) return released();
    try { current(record); return record; }
    catch (error) { record.failure = asFailure(error); await releaseRecord(record); throw error; }
  }
  function readRecord(record: SourceRecord, readId: string): ReadRecord {
    const previous = reads.get(readId);
    if (previous) {
      if (previous.handle !== record.handle) return fail(409, 'INVALID_REQUEST');
      if (previous.closed) return released();
      return previous;
    }
    if (reads.size >= MAX_READ_IDS || countReaders() >= MAX_READERS || record.readers.size >= MAX_RESOURCE_READERS) return busy();
    const read: ReadRecord = { handle: record.handle, readId, controller: new AbortController(), closed: false,
      nextOffset: null, pending: null, last: null, closing: null };
    reads.set(readId, read); record.readers.add(read); return read;
  }
  async function readSource(request: Extract<MobileOwnerSourceRequest, { operation: 'read' }>): Promise<MobileOwnerSourceResult> {
    const record = await active(request.handle);
    // active 的异步 quiet 路径不能给并发 release 留一个晚建 reader 的窗口。
    current(record);
    if (request.start > record.lease!.size) return fail(400, 'INVALID_REQUEST');
    const read = readRecord(record, request.readId);
    const same = read.last?.start === request.start && read.last.maxBytes === request.maxBytes;
    if (read.pending && !same) return busy();
    if (!same && read.nextOffset !== null && request.start !== read.nextOffset) return fail(409, 'INVALID_REQUEST');
    try {
      let bytes: Uint8Array;
      if (same && read.pending) bytes = await read.pending;
      else if (same && read.last?.bytes) {
        await record.lease!.verify(); current(record); bytes = read.last.bytes;
      } else {
        read.last = { start: request.start, maxBytes: request.maxBytes, bytes: null };
        const pending = (async () => {
          current(record); read.controller.signal.throwIfAborted();
          const lease = record.lease!;
          await lease.verify(); current(record); read.controller.signal.throwIfAborted();
          let result = new Uint8Array(0);
          if (request.start < lease.size) {
            const end = Math.min(lease.size - 1, request.start + Math.min(request.maxBytes, lease.size - request.start) - 1);
            const iterator = lease.readSlice(request.start, end, read.controller.signal);
            try {
              const next = await iterator.next();
              if (next.done || next.value.byteLength !== end - request.start + 1) return fail(409, 'SOURCE_CHANGED');
              result = new Uint8Array(next.value);
            } finally { await iterator.return(undefined); }
          }
          await lease.verify(); current(record); read.controller.signal.throwIfAborted();
          if (read.closed) return released();
          read.nextOffset = request.start + result.byteLength; read.last!.bytes = result;
          return result;
        })();
        read.pending = pending;
        try { bytes = await pending; } finally { if (read.pending === pending) read.pending = null; }
      }
      current(record); if (read.closed || read.controller.signal.aborted) return released();
      return { kind: 'mobile-source-read', handle: request.handle, readId: request.readId, start: request.start, bytes: new Uint8Array(bytes) };
    } catch (error) {
      // lease 的真实验证错误先同步 abort；自动退休关闭 reader 不能遮掉随后返回的 SOURCE_CHANGED。
      // 显式资源 release 和仅关闭原 HTTP readId 仍返回原释放语义。
      if (record.explicitRelease || read.closed && !record.controller.signal.aborted) return released();
      record.failure = asFailure(error); await releaseRecord(record); throw new SourceError(record.failure);
    }
  }
  async function closeRead(handle: string, readId: string): Promise<void> {
    let read = reads.get(readId);
    if (read && read.handle !== handle) return fail(409, 'INVALID_REQUEST');
    if (!read) {
      if (reads.size >= MAX_READ_IDS) return busy();
      // 原 close RPC 先到时，该 readId 不能稍后重新取得读取能力。
      read = { handle, readId, controller: new AbortController(), closed: true, nextOffset: null, pending: null, last: null, closing: null };
      reads.set(readId, read);
    }
    await closeReader(records.get(handle), read);
  }
  async function dispatch(raw: MobileOwnerSourceRequest): Promise<MobileOwnerSourceResult | MobileOwnerPrivateFailure> {
    if (!isMobileOwnerSourceRequest(raw)) return failure(400, 'INVALID_REQUEST');
    let request: MobileOwnerSourceRequest;
    try { request = structuredClone(raw); } catch { return failure(400, 'INVALID_REQUEST'); }
    try {
      let result: MobileOwnerSourceResult;
      switch (request.operation) {
        case 'prepare': result = await prepare(request.selection); break;
        case 'read': result = await readSource(request); break;
        case 'verify': case 'renew': {
          const record = await active(request.handle);
          try { current(record); await record.lease!.verify(); current(record); if (request.operation === 'renew') record.lease!.renew(permission(record)); }
          catch (error) { record.failure = asFailure(error); await releaseRecord(record); throw new SourceError(record.failure); }
          result = { kind: 'mobile-source-ack', operation: request.operation, handle: request.handle, readId: null, quiet: true }; break;
        }
        case 'close-read':
          await closeRead(request.handle, request.readId);
          result = { kind: 'mobile-source-ack', operation: request.operation, handle: request.handle, readId: request.readId, quiet: true }; break;
        case 'release': {
          const record = records.get(request.handle) ?? makeRecord(request.handle);
          await releaseRecord(record, true);
          result = { kind: 'mobile-source-ack', operation: request.operation, handle: request.handle, readId: null, quiet: true }; break;
        }
      }
      if (!isMobileOwnerSourceResult(result, request)) return failure(503, 'BUSY', true);
      return result;
    } catch (error) { return asFailure(error); }
  }
  function close(): Promise<void> {
    if (closing) return closing; closed = true;
    closing = (async () => {
      await Promise.all([...records.values()].map(record => releaseRecord(record, true)));
      await pool.close();
    })(); return closing;
  }
  function resourceSnapshot() {
    let liveResources = 0, preparing = 0, releasing = 0, activeIo = 0, retainedFences = 0, ownedTickets = 0;
    for (const record of records.values()) {
      if (record.state === 'active') liveResources++;
      if (record.state === 'preparing') preparing++;
      if (record.state === 'releasing') releasing++;
      if (record.releaseHold) retainedFences++;
      if (record.capture) ownedTickets++;
      activeIo += record.lease?.resourceSnapshot().activeIo ?? 0;
    }
    return { liveResources, preparing, releasing, readers: countReaders(), activeIo, ...pool.resourceSnapshot(),
      tickets: ownedTickets, retainedFences, lanes: lanes.filter(lane => lane.record !== null).length,
      records: records.size, readTombstones: [...reads.values()].filter(read => read.closed).length, closing: closed };
  }
  return { dispatch, close, resourceSnapshot };
}
