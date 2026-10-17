import { parentPort } from 'node:worker_threads';
import { encodePlaybackStorage, decodePlaybackStorage } from '../../../../packages/bridge-core/src/mobile/playback-state-codec.js';
import { MobilePlaybackError } from '../../../../packages/bridge-core/src/mobile/playback-types.js';
import { PLAYBACK_CODEC_PROTOCOL, captureCodecContext, codecBinding, closedData, codecByteLength, codecBusy } from './mobile-playback-state-codec-protocol.js';

if (!parentPort) throw codecBusy();
const port = parentPort; let lastId = 0, closed = false;
port.on('message', (raw: unknown) => {
  if (closed) return;
  if (closedData(raw, ['protocol', 'kind']) && raw.protocol === PLAYBACK_CODEC_PROTOCOL && raw.kind === 'close') {
    closed = true; port.close(); return;
  }
  let input: Uint8Array | undefined, output: Uint8Array | undefined;
  try {
    if (!closedData(raw, ['protocol', 'kind', 'id', 'operation', 'binding', 'context', 'input'])
      || raw.protocol !== PLAYBACK_CODEC_PROTOCOL || raw.kind !== 'job' || !Number.isSafeInteger(raw.id)
      || typeof raw.id !== 'number' || raw.id !== lastId + 1 || (raw.operation !== 'encode' && raw.operation !== 'decode')) throw codecBusy();
    lastId = raw.id;
    if (raw.operation === 'decode') { codecByteLength(raw.input); input = raw.input as Uint8Array; }
    const context = captureCodecContext(raw.context);
    if (raw.binding !== codecBinding(context)) throw codecBusy();
    const result = raw.operation === 'encode'
      ? encodePlaybackStorage(raw.input, context.serverId, context.datasetId, context.responseOrigin, context.limits)
      : (() => {
        if (!codecByteLength(raw.input) || codecByteLength(raw.input) > context.limits.stateBytes) throw codecBusy();
        return decodePlaybackStorage(input!, context.serverId, context.datasetId, context.responseOrigin, context.limits);
      })();
    if ('bytes' in result) output = result.bytes;
    if (result.state.revision !== context.revision || result.state.commitId !== context.commitId) throw codecBusy();
    const message = { protocol: PLAYBACK_CODEC_PROTOCOL, kind: 'result', id: raw.id, operation: raw.operation, binding: raw.binding, result };
    if ('bytes' in result) {
      const bytes = result.bytes;
      try { port.postMessage(message, [bytes.buffer as ArrayBuffer]); } finally { if (bytes.byteLength) bytes.fill(0); }
    } else port.postMessage(message);
  } catch (error) {
    if (!closedData(raw, ['protocol', 'kind', 'id', 'operation', 'binding', 'context', 'input'])) {
      closed = true; port.close(); return;
    }
    const safe = error instanceof MobilePlaybackError ? error : codecBusy();
    port.postMessage({ protocol: PLAYBACK_CODEC_PROTOCOL, kind: 'failure', id: raw.id, operation: raw.operation, binding: raw.binding,
      error: { status: safe.status, code: safe.code, retryable: safe.retryable, retryAfterMs: safe.retryAfterMs ?? null } });
  } finally { input?.fill(0); if (output?.byteLength) output.fill(0); }
});
