import { parentPort, workerData } from 'node:worker_threads';
import { writeSync } from 'node:fs';
import { createPlaybackStorageActor, playbackStoragePatchReply, readPlaybackStorageRejectionBoundary } from '../../../../packages/bridge-core/src/mobile/playback-state-codec.js';
import type { PlaybackStorageWithBase, EncodedPlaybackStorage } from '../../../../packages/bridge-core/src/mobile/playback-state-codec.js';
import { MobilePlaybackError } from '../../../../packages/bridge-core/src/mobile/playback-types.js';
import { decodePlaybackHistoryGroup } from '../../../../packages/bridge-core/src/mobile/playback-history-codec.js';
import { PLAYBACK_CODEC_PROTOCOL, captureCodecContext, codecBinding, closedData, codecByteLength, codecBusy } from './mobile-playback-state-codec-protocol.js';

if (!parentPort) throw codecBusy();
const capacityDiagnostic = closedData(workerData, ['resourceCapacityDiagnostic']) && workerData.resourceCapacityDiagnostic === true;
const port = parentPort, actor = createPlaybackStorageActor(capacityDiagnostic ? {
  observeCapacity(value) {
    try { writeSync(1, '[MusicBridgePlaybackCapacity] ' + JSON.stringify({ ...value, atMs: Date.now() }) + '\n'); }
    catch { /* 只读数字旁注失败不改变线程回包或原容量守门。 */ }
  },
} : {}); let lastId = 0, closed = false;
port.on('message', (raw: unknown) => {
  if (closed) return;
  if (closedData(raw, ['protocol', 'kind']) && raw.protocol === PLAYBACK_CODEC_PROTOCOL && raw.kind === 'close') {
    closed = true; actor.close(); port.close(); return;
  }
  let input: Uint8Array | undefined, output: Uint8Array | undefined;
  try {
    if (!closedData(raw, ['protocol', 'kind', 'id', 'operation', 'binding', 'context', 'input'])
      || raw.protocol !== PLAYBACK_CODEC_PROTOCOL || raw.kind !== 'job' || !Number.isSafeInteger(raw.id)
      || typeof raw.id !== 'number' || raw.id !== lastId + 1 || !['encode','decode','derive','derive-patch','history-read'].includes(raw.operation as string)) throw codecBusy();
    lastId = raw.id;
    if (raw.operation === 'decode') { codecByteLength(raw.input); input = raw.input as Uint8Array; }
    const context = captureCodecContext(raw.context);
    if (raw.binding !== codecBinding(context)) throw codecBusy();
    if (raw.operation === 'history-read') {
      if (!closedData(raw.input, ['plain', 'sessionId']) || typeof raw.input.sessionId !== 'string'
        || !codecByteLength(raw.input.plain) || codecByteLength(raw.input.plain) > context.limits.stateBytes) throw codecBusy();
      input = raw.input.plain as Uint8Array;
      const state = decodePlaybackHistoryGroup(input, context, raw.input.sessionId);
      port.postMessage({ protocol: PLAYBACK_CODEC_PROTOCOL, kind: 'result', id: raw.id, operation: raw.operation,
        binding: raw.binding, result: { state } });
      return;
    }
    const result = raw.operation === 'derive'||raw.operation==='derive-patch'
      ? (()=>{if(!closedData(raw.input,['base','patch']))throw codecBusy();return actor.derive(raw.input.base,raw.input.patch,context);})()
      : raw.operation === 'encode'
      ? actor.encode(raw.input, context)
      : (() => {
        if (!codecByteLength(raw.input) || codecByteLength(raw.input) > context.limits.stateBytes) throw codecBusy();
        return actor.decode(input!, context);
      })();
    if ('bytes' in result) {
      if (!(result.bytes instanceof Uint8Array)) throw codecBusy();
      output = result.bytes;
    }
    if (result.state.revision !== context.revision || result.state.commitId !== context.commitId) throw codecBusy();
    const projected=raw.operation==='derive-patch'&&closedData(raw.input,['base','patch'])&&'bytes'in result
      ?playbackStoragePatchReply(result as PlaybackStorageWithBase<EncodedPlaybackStorage>,raw.input.base,raw.input.patch,context):result;
    const message = { protocol: PLAYBACK_CODEC_PROTOCOL, kind: 'result', id: raw.id, operation: raw.operation, binding: raw.binding, result:projected };
    if (output) {
      const bytes = output;
      try { port.postMessage(message, [bytes.buffer as ArrayBuffer]); } finally { if (bytes.byteLength) bytes.fill(0); }
    } else port.postMessage(message);
  } catch (error) {
    if (!closedData(raw, ['protocol', 'kind', 'id', 'operation', 'binding', 'context', 'input'])) {
      closed = true; actor.close(); port.close(); return;
    }
    const safe = error instanceof MobilePlaybackError ? error : codecBusy();
    const budgetBoundary = raw.operation !== 'decode' && raw.operation !== 'history-read' ? readPlaybackStorageRejectionBoundary(error) : null;
    port.postMessage({ protocol: PLAYBACK_CODEC_PROTOCOL, kind: 'failure', id: raw.id, operation: raw.operation, binding: raw.binding,
      error: { status: safe.status, code: safe.code, retryable: safe.retryable, retryAfterMs: safe.retryAfterMs ?? null, ...(budgetBoundary ? { budgetBoundary } : {}) } });
  } finally { input?.fill(0); if (output?.byteLength) output.fill(0); }
});
