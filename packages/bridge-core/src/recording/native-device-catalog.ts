import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { createHash } from 'node:crypto';
import { verifyPinnedDeviceOutputHelper, type PinnedDeviceOutputHelper } from './bundled-device-output-helper.js';
import type { ReadonlyDeviceCatalog, ReadonlyDeviceCatalogCandidate, ReadonlyDeviceObservation } from './device-selection-broker.js';
import { DEVICE_OUTPUT_BACKEND_ID, DEVICE_OUTPUT_BACKEND_VERSION, type DeviceOutputPcmFormat } from './device-output-protocol.js';

const REQUEST_BYTES = 144, RESPONSE_HEADER_BYTES = 16, CANDIDATE_BYTES = 392, OBSERVATION_BYTES = 152;
const MAX_RESPONSE_BYTES = RESPONSE_HEADER_BYTES + 64 * CANDIDATE_BYTES;
const decoder = new TextDecoder('utf-8', { fatal: true });
const fail = (): never => { throw new Error('只读输出设备目录协议或身份无效。'); };
const uidValid = (uid: string): boolean => !uid.includes('\0') && Buffer.byteLength(uid, 'utf8') >= 1
  && Buffer.byteLength(uid, 'utf8') <= 128;
const zero = (bytes: Buffer): boolean => bytes.every(byte => byte === 0);
const endpoint = (uid: string): string => `dev_${createHash('sha256').update(uid, 'utf8').digest('hex').slice(0, 24)}`;
const format = (code: number): DeviceOutputPcmFormat => {
  if (code === 1) return 'pcm-s16le';
  if (code === 2) return 'pcm-s24le';
  if (code === 3) return 'pcm-s32le';
  if (code === 4) return 'pcm-f32le';
  return fail();
};
function text(bytes: Buffer): string { try { return decoder.decode(bytes); } catch { return fail(); } }
function request(operation: 1 | 2, uid = ''): Buffer {
  const name = Buffer.from(uid, 'utf8');
  if (operation === 1 ? name.length !== 0 : !uidValid(uid)) return fail();
  const bytes = Buffer.alloc(REQUEST_BYTES);
  bytes.write('MBIQ', 0, 'ascii'); bytes.writeUInt16LE(1, 4); bytes.writeUInt16LE(operation, 6);
  bytes.writeUInt16LE(name.length, 8); name.copy(bytes, 16); return bytes;
}
function response(bytes: Buffer, operation: 1 | 2): { status: number; count: number; body: Buffer } {
  if (bytes.length < RESPONSE_HEADER_BYTES || bytes.length > MAX_RESPONSE_BYTES
    || bytes.toString('ascii', 0, 4) !== 'MBIR' || bytes.readUInt16LE(4) !== 1
    || bytes.readUInt16LE(6) !== operation || !zero(bytes.subarray(12, 16))) return fail();
  const status = bytes.readUInt16LE(8), count = bytes.readUInt16LE(10);
  if (operation === 1 && (status !== 0 || count > 64 || bytes.length !== RESPONSE_HEADER_BYTES + count * CANDIDATE_BYTES)
    || operation === 2 && (status === 0 ? count !== 1 || bytes.length !== RESPONSE_HEADER_BYTES + OBSERVATION_BYTES
      : status !== 1 || count !== 0 || bytes.length !== RESPONSE_HEADER_BYTES)) return fail();
  return { status, count, body: bytes.subarray(RESPONSE_HEADER_BYTES) };
}
function candidates(bytes: Buffer, count: number): readonly ReadonlyDeviceCatalogCandidate[] {
  const result: ReadonlyDeviceCatalogCandidate[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < count; index++) {
    const record = bytes.subarray(index * CANDIDATE_BYTES, (index + 1) * CANDIDATE_BYTES);
    const uidLength = record.readUInt16LE(0), labelLength = record.readUInt16LE(2), available = record[4];
    if (uidLength < 1 || uidLength > 128 || labelLength < 1 || labelLength > 256
      || (available !== 0 && available !== 1) || !zero(record.subarray(5, 8))
      || !zero(record.subarray(8 + uidLength, 136)) || !zero(record.subarray(136 + labelLength))) return fail();
    const uid = text(record.subarray(8, 8 + uidLength)), label = text(record.subarray(136, 136 + labelLength));
    if (!uidValid(uid) || seen.has(uid) || label.length < 1 || label.length > 128 || label.trim() !== label
      || /[\u0000-\u001f\u007f]/u.test(label)) return fail();
    seen.add(uid); result.push({ endpointId: endpoint(uid), uid, label, available: available === 1 });
  }
  return result;
}
function observation(bytes: Buffer, uid: string): ReadonlyDeviceObservation {
  const uidLength = bytes.readUInt16LE(0), virtual = format(bytes.readUInt16LE(2));
  const physical = format(bytes.readUInt16LE(4)), channels = bytes.readUInt16LE(6);
  const rate = bytes.readUInt32LE(8), bufferFrames = bytes.readUInt32LE(12);
  if (uidLength < 1 || uidLength > 128 || (channels !== 1 && channels !== 2)
    || (bytes[16] !== 0 && bytes[16] !== 1) || (bytes[17] !== 0 && bytes[17] !== 1)
    || !zero(bytes.subarray(18, 24)) || !zero(bytes.subarray(24 + uidLength))) return fail();
  const observedUid = text(bytes.subarray(24, 24 + uidLength));
  if (observedUid !== uid || !uidValid(observedUid)) return fail();
  const endpointId = endpoint(uid), route = { endpointId, uid, sampleRate: rate,
    channelCount: channels, format: virtual, physicalFormat: physical, bufferFrames,
    backendId: DEVICE_OUTPUT_BACKEND_ID, backendVersion: DEVICE_OUTPUT_BACKEND_VERSION };
  const configurationFingerprintSha256 = createHash('sha256').update(JSON.stringify(route)).digest('hex');
  return { ...route, configurationFingerprintSha256, alive: bytes[16] === 1, hasOutput: bytes[17] === 1 } as ReadonlyDeviceObservation;
}
interface Options { launch?: (file: string, args: string[], options: SpawnOptions) => ChildProcess; timeoutMs?: number }

/** 仅在显式设备目录操作时启动一次短命只读进程；构造此对象本身不会查询 HAL。 */
export function createNativeReadonlyDeviceCatalog(pin: PinnedDeviceOutputHelper, options: Options = {}): ReadonlyDeviceCatalog {
  const timeoutMs = options.timeoutMs ?? 5_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10_000) return fail();
  const invoke = async (operation: 1 | 2, uid: string, signal: AbortSignal) => {
    signal.throwIfAborted(); await verifyPinnedDeviceOutputHelper(pin); signal.throwIfAborted();
    const input = request(operation, uid);
    const bytes = await new Promise<Buffer>((resolve, reject) => {
      let child: ChildProcess;
      try { child = (options.launch ?? spawn)(pin.path, ['--inspect'], { shell: false,
        env: { LANG: 'C', LC_ALL: 'C' }, stdio: ['pipe', 'pipe', 'pipe'] }); }
      catch { reject(new Error('只读设备目录 helper 启动失败。')); return; }
      let settled = false, size = 0, stderr = 0;
      const chunks: Buffer[] = [];
      const settle = (error?: Error, output?: Buffer) => {
        if (settled) return; settled = true; clearTimeout(timer); signal.removeEventListener('abort', abort);
        if (error) { try { child.kill('SIGKILL'); } catch { /* 仅收口当前只读进程。 */ } reject(error); }
        else resolve(output!);
      };
      const abort = () => settle(new Error('只读设备目录操作已取消。'));
      const timer = setTimeout(() => settle(new Error('只读设备目录操作超时。')), timeoutMs);
      signal.addEventListener('abort', abort, { once: true });
      child.stdout?.on('data', (chunk: Buffer) => {
        size += chunk.length; if (size > MAX_RESPONSE_BYTES) return settle(new Error('只读设备目录响应超限。'));
        chunks.push(chunk);
      });
      child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.length; if (stderr > 0) settle(new Error('只读设备目录 helper 拒绝响应。')); });
      child.on('error', () => settle(new Error('只读设备目录 helper 不可用。')));
      child.on('close', code => code === 0 && stderr === 0 && size > 0
        ? settle(undefined, Buffer.concat(chunks, size)) : settle(new Error('只读设备目录 helper 未成功关闭。')));
      if (!child.stdin) { settle(new Error('只读设备目录 helper 缺少控制通道。')); return; }
      child.stdin.on('error', () => settle(new Error('只读设备目录请求写入失败。')));
      child.stdin.end(input);
      if (signal.aborted) abort();
    });
    signal.throwIfAborted(); await verifyPinnedDeviceOutputHelper(pin); signal.throwIfAborted();
    return response(bytes, operation);
  };
  return {
    async list(signal) { const result = await invoke(1, '', signal); return candidates(result.body, result.count); },
    async observeExact(uid, signal) {
      const result = await invoke(2, uid, signal);
      return result.status === 1 ? null : observation(result.body, uid);
    },
  };
}
