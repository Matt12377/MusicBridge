import { mobilePreparationSync } from '../../../../packages/bridge-core/src/mobile/capability-trace.js';
import { Worker } from 'node:worker_threads';
import { MobilePlaybackError, type MobilePlaybackStateCodecContext, type MobilePlaybackStateCodecPort } from '../../../../packages/bridge-core/src/mobile/playback-types.js';
import type { PlaybackState } from '../../../../packages/bridge-core/src/mobile/playback-state.js';
import { playbackCanonical } from '../../../../packages/bridge-core/src/mobile/playback-state.js';
import { capturePlaybackHistoryGroup } from '../../../../packages/bridge-core/src/mobile/playback-history-codec.js';
import type { DecodedPlaybackStorage, EncodedPlaybackStorage, PlaybackStorageBase, PlaybackStoragePatch, PlaybackStoragePatchReply, PlaybackStorageWithBase, IncrementalPlaybackStateCodecPort } from '../../../../packages/bridge-core/src/mobile/playback-state-codec.js';
import { PLAYBACK_CODEC_PROTOCOL, PLAYBACK_CODEC_MAX_JOBS, PLAYBACK_CODEC_TIMEOUT_MS,
  captureCodecContext, codecBinding, captureCodecData, captureCodecDelta, captureCodecBase, captureCodecPatchReply, captureCodecHistoryInput, copyCodecBytes, codecByteLength, codecBusy, dataRecord, closedData, wipeCodecReply, codecRejectionBoundary, markCodecRejectionBoundary, readCodecRejectionBoundary } from './mobile-playback-state-codec-protocol.js';

interface Job {
  id: number; operation: 'encode' | 'decode' | 'derive' | 'derive-patch' | 'history-read'; context: MobilePlaybackStateCodecContext; binding: string;
  input: unknown; resolve(value: EncodedPlaybackStorage | DecodedPlaybackStorage | PlaybackStoragePatchReply | PlaybackState): void; reject(error: unknown): void;
  sessionId?: string;
  delta?: {base:string;patch:string};
  timer?: ReturnType<typeof setTimeout>;
}
// 两种包共用Record基础类型，闭集判别只返回boolean，避免取反时把Record误排除成never。
function closedPacket(value: Record<string, unknown>, keys: readonly string[]): boolean { return closedData(value, keys); }
/** 一组合一个独立持久CPU线程；队列、错误和关闭均fail closed，不回退到Main计算。 */
export function createMobilePlaybackStateCodec(options: {
  workerUrl?: URL; workerFactory?: () => Worker; timeoutMs?: number;
} = {}): IncrementalPlaybackStateCodecPort & {derivePatch:NonNullable<IncrementalPlaybackStateCodecPort['derivePatch']>} {
  const timeout = options.timeoutMs ?? PLAYBACK_CODEC_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > PLAYBACK_CODEC_TIMEOUT_MS) throw codecBusy();
  let worker: Worker | undefined, active: Job | undefined, nextId = 0, closing = false, closeSent = false;
  let failure: MobilePlaybackError | undefined, closeFlight: Promise<void> | undefined, closeTimer: ReturnType<typeof setTimeout> | undefined;
  let exitFlight: Promise<number> | undefined; const queue: Job[] = [];
  let diagnosticCount = 0;
  const observeCapture = process.argv.includes('--mb-private-owner-load-trace')
    ? (metrics: import('./mobile-playback-state-codec-protocol.js').CodecCaptureMetrics) => {
      if (diagnosticCount++ >= 32) return;
      process.stdout.write('[MusicBridgePlaybackBudget] ' + JSON.stringify({ schema: 1, atMs: Date.now(), ...metrics }) + '\n');
    } : undefined;
  function discard(job: Job): void {
    if (job.timer) clearTimeout(job.timer);
    if (job.operation === 'decode' && job.input instanceof Uint8Array && codecByteLength(job.input)) job.input.fill(0);
    if (job.operation === 'history-read' && dataRecord(job.input) && job.input.plain instanceof Uint8Array) job.input.plain.fill(0);
    job.input = undefined;
  }
  function fail(): void {
    if (!failure) failure = codecBusy();
    closing = true;
    if (active) { active.reject(failure); discard(active); active = undefined; }
    for (const job of queue.splice(0)) { job.reject(failure); discard(job); }
    // terminate只在故障/超时，close始终等待实际exit；没有unref或后台假收尾。
    if (worker) void worker.terminate().catch(() => undefined);
  }
  function requestClose(): void {
    if (!worker || active || closeSent || failure) return;
    closeSent = true;
    try { worker.postMessage({ protocol: PLAYBACK_CODEC_PROTOCOL, kind: 'close' }); } catch { fail(); }
  }
  function ensureWorker(): Worker {
    if (worker) return worker;
    worker = options.workerFactory ? options.workerFactory() : new Worker(
      options.workerUrl ?? new URL('./mobile-playback-state-worker-entry.js', import.meta.url),
      { execArgv: [], env: {}, name: 'mobile-playback-codec',
        workerData: { resourceCapacityDiagnostic: process.argv.includes('--mb-private-resource-capacity-trace') },
        resourceLimits: { maxOldGenerationSizeMb: 512, maxYoungGenerationSizeMb: 64, stackSizeMb: 4 } });
    const actual = worker;
    exitFlight = new Promise(resolve => {
      actual.once('exit', code => {
        if (closeTimer) clearTimeout(closeTimer);
        if (!closing || !closeSent || code !== 0) fail();
        resolve(code);
      });
    });
    actual.on('error', () => fail());
    actual.on('messageerror', () => fail());
    actual.on('message', (raw: unknown) => {
      if (failure) { wipeCodecReply(raw); return; }
      if (!dataRecord(raw)) { wipeCodecReply(raw); fail(); return; }
      const job = active;
      const resultPacket = closedPacket(raw, ['protocol', 'kind', 'id', 'operation', 'binding', 'result']);
      const errorPacket = closedPacket(raw, ['protocol', 'kind', 'id', 'operation', 'binding', 'error']);
      if (!job || (!resultPacket && !errorPacket) || raw.protocol !== PLAYBACK_CODEC_PROTOCOL
        || raw.id !== job.id || raw.operation !== job.operation || raw.binding !== job.binding
        || (resultPacket ? raw.kind !== 'result' : raw.kind !== 'failure')) { wipeCodecReply(raw); fail(); return; }
      discard(job); active = undefined;
      if (closing) { wipeCodecReply(raw); requestClose(); return; }
      if (errorPacket) {
        const error = raw.error;
        const hasBoundary = dataRecord(error) && Object.hasOwn(error, 'budgetBoundary');
        if (!closedData(error, ['status', 'code', 'retryable', 'retryAfterMs', ...(hasBoundary ? ['budgetBoundary'] : [])])
          || hasBoundary && (job.operation === 'decode' || job.operation === 'history-read' || error.status !== 429 || error.code !== 'RESOURCE_BUSY' || !codecRejectionBoundary(error.budgetBoundary))
          || !((error.status === 503 && error.code === 'BUSY' || error.status === 429 && error.code === 'RESOURCE_BUSY')
            && error.retryable === true && error.retryAfterMs === 1_000
            || error.status === 409 && error.code === 'SOURCE_CHANGED' && error.retryable === false && error.retryAfterMs === null)) {
          job.reject(codecBusy()); fail(); return;
        }
        const failure = new MobilePlaybackError(error.status as 409 | 429 | 503, error.code as 'BUSY' | 'RESOURCE_BUSY' | 'SOURCE_CHANGED',
          error.retryable as boolean, error.retryAfterMs === null ? undefined : error.retryAfterMs as number);
        if (hasBoundary && codecRejectionBoundary(error.budgetBoundary)) markCodecRejectionBoundary(failure, error.budgetBoundary);
        job.reject(failure);
      } else {
        const result = raw.result;
        if (job.operation === 'history-read') {
          try {
            if (!closedData(result, ['state']) || !job.sessionId) throw codecBusy();
            job.resolve(capturePlaybackHistoryGroup(result.state, job.context, job.sessionId));
          } catch { wipeCodecReply(raw); job.reject(codecBusy()); fail(); return; }
          pump(); return;
        }
        if(job.operation==='derive-patch'){
          try{const owned=captureCodecPatchReply(result,job.context);
            if(!job.delta||playbackCanonical(owned.previousBase)!==job.delta.base||playbackCanonical(owned.patch)!==job.delta.patch)throw codecBusy();
            job.resolve(owned);
          }catch{wipeCodecReply(raw);job.reject(codecBusy());fail();return;}
          pump();return;
        }
        const hasBase = dataRecord(result) && Object.hasOwn(result,'base');
        if (!closedData(result, ['state', 'canonical', 'format', ...(job.operation !== 'decode' ? ['bytes'] : []), ...(hasBase ? ['base'] : [])])
          || job.operation === 'derive' && !hasBase
          || typeof result.canonical !== 'string' || Buffer.byteLength(result.canonical) > job.context.limits.stateBytes
          || (result.format !== 'v1' && result.format !== 'v2' && result.format !== 'v3' && result.format !== 'v4' && result.format !== 'v5' && result.format !== 'v6')
          || !closedData(result.state, ['schema', 'serverId', 'datasetId', 'revision', 'commitId', 'clockFloor', 'sessions', 'resources', 'receipts'])
          || result.state.schema !== 'musicbridge.mobile002.playback-state.v1'
          || result.state.serverId !== job.context.serverId || result.state.datasetId !== job.context.datasetId
          || result.state.revision !== job.context.revision || result.state.commitId !== job.context.commitId) {
          wipeCodecReply(raw); job.reject(codecBusy()); fail(); return;
        }
        try {
          if (job.operation !== 'decode' && codecByteLength(result.bytes) !== Buffer.byteLength(result.canonical)) throw codecBusy();
          if (hasBase) { const base=captureCodecBase(result.base); if(base.revision!==job.context.revision||base.commitId!==job.context.commitId)throw codecBusy(); }
          job.resolve(result as unknown as EncodedPlaybackStorage | DecodedPlaybackStorage);
        } catch { wipeCodecReply(raw); job.reject(codecBusy()); fail(); return; }
      }
      pump();
    });
    return actual;
  }
  function pump(): void {
    if (failure || active) return;
    if (closing) { requestClose(); return; }
    const job = queue.shift(); if (!job) return;
    active = job;
    try {
      const actual = ensureWorker();
      job.timer = setTimeout(fail, timeout);
      const message = { protocol: PLAYBACK_CODEC_PROTOCOL, kind: 'job', id: job.id, operation: job.operation,
        binding: job.binding, context: job.context, input: job.input };
      if (job.operation === 'decode' || job.operation === 'history-read') {
        const bytes = job.operation === 'decode' ? job.input as Uint8Array : (job.input as { plain: Uint8Array }).plain;
        actual.postMessage(message, [bytes.buffer as ArrayBuffer]);
      } else actual.postMessage(message);
      job.input = undefined; // postMessage已拥有data副本或已接管专用明文字节。
    } catch { fail(); }
  }
  async function run(operation: 'encode' | 'decode' | 'derive' | 'derive-patch' | 'history-read', input: unknown, rawContext: MobilePlaybackStateCodecContext): Promise<EncodedPlaybackStorage | DecodedPlaybackStorage | PlaybackStoragePatchReply | PlaybackState> {
    if (closing || failure || queue.length + Number(!!active) >= PLAYBACK_CODEC_MAX_JOBS || nextId >= Number.MAX_SAFE_INTEGER) throw codecBusy();
    const context = captureCodecContext(rawContext);
    const owned = operation === 'history-read' ? captureCodecHistoryInput(input, context)
      : operation === 'derive'||operation==='derive-patch' ? mobilePreparationSync('preparation.playback.codec.main-capture',()=>captureCodecDelta(input,context)) : operation === 'encode'
      ? mobilePreparationSync('preparation.playback.codec.main-capture', () => captureCodecData(input, context, observeCapture))
      : copyCodecBytes(input, context.limits.stateBytes);
    const delta=operation==='derive-patch'?{base:playbackCanonical((owned as {base:PlaybackStorageBase}).base),patch:playbackCanonical((owned as {patch:PlaybackStoragePatch}).patch)}:undefined;
    try { return await new Promise<EncodedPlaybackStorage | DecodedPlaybackStorage | PlaybackStoragePatchReply | PlaybackState>((resolve, reject) => {
      queue.push({ id: ++nextId, operation, context, binding: codecBinding(context), input: owned, resolve, reject,
        ...(operation === 'history-read' ? { sessionId: (owned as { sessionId: string }).sessionId } : {}), ...(delta?{delta}:{}) }); pump();
    }); } catch (error) {
      const boundary = readCodecRejectionBoundary(error);
      if (boundary) {
        const stages = {
          'worker-raw': 'preparation.playback.codec.worker-raw', 'worker-state': 'preparation.playback.codec.worker-state',
          'terminal-logical': 'preparation.playback.codec.terminal-logical', 'v3-physical': 'preparation.playback.codec.v3-physical',
          'terminal-v3-reserve': 'preparation.playback.codec.terminal-v3-reserve',
          'v4-physical': 'preparation.playback.codec.v4-physical', 'terminal-v4-reserve': 'preparation.playback.codec.terminal-v4-reserve',
        } as const;
        return mobilePreparationSync(stages[boundary], () => { throw error; });
      }
      throw error;
    }
  }
  return {
    encode: async (state: PlaybackState, context) => await run('encode', state, context) as EncodedPlaybackStorage,
    decode: async (plain, context) => await run('decode', plain, context) as DecodedPlaybackStorage,
    readHistory: async (plain, context, sessionId) => await run('history-read', { plain, sessionId }, context) as PlaybackState,
    derive: async (base:PlaybackStorageBase,patch:PlaybackStoragePatch,context) => await run('derive',{base,patch},context) as PlaybackStorageWithBase<EncodedPlaybackStorage>,
    derivePatch:async(base,patch,context)=>await run('derive-patch',{base,patch},context) as PlaybackStoragePatchReply,
    close(): Promise<void> {
      if (closeFlight) return closeFlight;
      closing = true;
      // 停止发布已关闭端口的结果；仍让实际在算job结束、清零回包，再自然关闭线程。
      if (active) active.reject(codecBusy());
      for (const job of queue.splice(0)) { job.reject(codecBusy()); discard(job); }
      requestClose();
      closeFlight = (async () => {
        if (!worker) { if (failure) throw codecBusy(); return; }
        closeTimer = setTimeout(fail, timeout);
        const code = await exitFlight;
        if (closeTimer) clearTimeout(closeTimer);
        if (failure || code !== 0) throw codecBusy();
      })();
      return closeFlight;
    },
  };
}
