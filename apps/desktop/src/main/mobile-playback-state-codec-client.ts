import { Worker } from 'node:worker_threads';
import { MobilePlaybackError, type MobilePlaybackStateCodecContext, type MobilePlaybackStateCodecPort } from '../../../../packages/bridge-core/src/mobile/playback-types.js';
import type { PlaybackState } from '../../../../packages/bridge-core/src/mobile/playback-state.js';
import type { DecodedPlaybackStorage, EncodedPlaybackStorage } from '../../../../packages/bridge-core/src/mobile/playback-state-codec.js';
import { PLAYBACK_CODEC_PROTOCOL, PLAYBACK_CODEC_MAX_JOBS, PLAYBACK_CODEC_TIMEOUT_MS,
  captureCodecContext, codecBinding, captureCodecData, copyCodecBytes, codecByteLength, codecBusy, dataRecord, closedData, wipeCodecReply } from './mobile-playback-state-codec-protocol.js';

interface Job {
  id: number; operation: 'encode' | 'decode'; context: MobilePlaybackStateCodecContext; binding: string;
  input: unknown; resolve(value: EncodedPlaybackStorage | DecodedPlaybackStorage): void; reject(error: unknown): void;
  timer?: ReturnType<typeof setTimeout>;
}
// 两种包共用Record基础类型，闭集判别只返回boolean，避免取反时把Record误排除成never。
function closedPacket(value: Record<string, unknown>, keys: readonly string[]): boolean { return closedData(value, keys); }
/** 一组合一个独立持久CPU线程；队列、错误和关闭均fail closed，不回退到Main计算。 */
export function createMobilePlaybackStateCodec(options: {
  workerUrl?: URL; workerFactory?: () => Worker; timeoutMs?: number;
} = {}): MobilePlaybackStateCodecPort {
  const timeout = options.timeoutMs ?? PLAYBACK_CODEC_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > PLAYBACK_CODEC_TIMEOUT_MS) throw codecBusy();
  let worker: Worker | undefined, active: Job | undefined, nextId = 0, closing = false, closeSent = false;
  let failure: MobilePlaybackError | undefined, closeFlight: Promise<void> | undefined, closeTimer: ReturnType<typeof setTimeout> | undefined;
  let exitFlight: Promise<number> | undefined; const queue: Job[] = [];
  function discard(job: Job): void {
    if (job.timer) clearTimeout(job.timer);
    if (job.operation === 'decode' && job.input instanceof Uint8Array && codecByteLength(job.input)) job.input.fill(0);
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
        if (!closedData(error, ['status', 'code', 'retryable', 'retryAfterMs'])
          || !((error.status === 503 && error.code === 'BUSY' || error.status === 429 && error.code === 'RESOURCE_BUSY')
            && error.retryable === true && error.retryAfterMs === 1_000
            || error.status === 409 && error.code === 'SOURCE_CHANGED' && error.retryable === false && error.retryAfterMs === null)) {
          job.reject(codecBusy()); fail(); return;
        }
        job.reject(new MobilePlaybackError(error.status as 409 | 429 | 503, error.code as 'BUSY' | 'RESOURCE_BUSY' | 'SOURCE_CHANGED',
          error.retryable as boolean, error.retryAfterMs === null ? undefined : error.retryAfterMs as number));
      } else {
        const result = raw.result;
        if (!closedData(result, ['state', 'canonical', 'format', ...(job.operation === 'encode' ? ['bytes'] : [])])
          || typeof result.canonical !== 'string' || Buffer.byteLength(result.canonical) > job.context.limits.stateBytes
          || (result.format !== 'v1' && result.format !== 'v2')
          || !closedData(result.state, ['schema', 'serverId', 'datasetId', 'revision', 'commitId', 'clockFloor', 'sessions', 'resources', 'receipts'])
          || result.state.schema !== 'musicbridge.mobile002.playback-state.v1'
          || result.state.serverId !== job.context.serverId || result.state.datasetId !== job.context.datasetId
          || result.state.revision !== job.context.revision || result.state.commitId !== job.context.commitId) {
          wipeCodecReply(raw); job.reject(codecBusy()); fail(); return;
        }
        try {
          if (job.operation === 'encode' && codecByteLength(result.bytes) !== Buffer.byteLength(result.canonical)) throw codecBusy();
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
      if (job.operation === 'decode') {
        const bytes = job.input as Uint8Array;
        actual.postMessage(message, [bytes.buffer as ArrayBuffer]);
      } else actual.postMessage(message);
      job.input = undefined; // postMessage已拥有data副本或已接管专用明文字节。
    } catch { fail(); }
  }
  async function run(operation: 'encode' | 'decode', input: unknown, rawContext: MobilePlaybackStateCodecContext): Promise<EncodedPlaybackStorage | DecodedPlaybackStorage> {
    if (closing || failure || queue.length + Number(!!active) >= PLAYBACK_CODEC_MAX_JOBS || nextId >= Number.MAX_SAFE_INTEGER) throw codecBusy();
    const context = captureCodecContext(rawContext);
    const owned = operation === 'encode' ? captureCodecData(input, context) : copyCodecBytes(input, context.limits.stateBytes);
    return await new Promise<EncodedPlaybackStorage | DecodedPlaybackStorage>((resolve, reject) => {
      queue.push({ id: ++nextId, operation, context, binding: codecBinding(context), input: owned, resolve, reject }); pump();
    });
  }
  return {
    encode: async (state: PlaybackState, context) => await run('encode', state, context) as EncodedPlaybackStorage,
    decode: async (plain, context) => await run('decode', plain, context),
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
