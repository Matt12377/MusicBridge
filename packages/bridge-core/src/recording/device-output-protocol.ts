import { isCollectionId } from '@music-bridge/contracts';

export const DEVICE_OUTPUT_PROTOCOL_VERSION = 1;
export const DEVICE_OUTPUT_BACKEND_ID = 'musicbridge-coreaudio-hal';
export const DEVICE_OUTPUT_BACKEND_VERSION = '0.2.0';
export const DEVICE_OUTPUT_DRAIN_ALGORITHM_ID = 'hal-sample-zero-cover-v1';
export const DEVICE_OUTPUT_HEADER_BYTES = 320;
export const DEVICE_OUTPUT_CONTROL_BYTES = 32;
export const DEVICE_OUTPUT_EVENT_BYTES = 64;

export type DeviceOutputPcmFormat = 'pcm-s16le' | 'pcm-s24le' | 'pcm-s32le' | 'pcm-f32le';
export type DeviceOutputEventKind = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
export interface DeviceOutputRoute {
  uid: string; sampleRate: number; channelCount: 1 | 2; format: DeviceOutputPcmFormat;
  bufferFrames: number; capacityFrames: number; tailFrames: number; minimumZeroCallbacks: number;
}
/** 同一HAL机制的两个独立授权域；64～95字节Hash按scope解释，不允许占位冒用。 */
export type DeviceOutputHeader = DeviceOutputRoute & { runId: string; pcmSha256: string; frameCount: number } & (
  | { scope: 'formal-recording'; recordSha256: string }
  | { scope: 'replica-playback'; playbackIdentitySha256: string }
);
export interface DeviceOutputEvent {
  kind: DeviceOutputEventKind; sequence: number; code: number; runId: string;
  suppliedFrames: number; consumedFrames: number; zeroFilledFrames: number;
  sourceEof: boolean; hardwareDrained: boolean; stopAcknowledged: boolean; destroyAcknowledged: boolean;
  callbackFault: boolean; startAttempted: boolean;
}

export class DeviceOutputProtocolError extends Error {
  constructor() { super('正式输出 helper 协议身份或时序无效。'); }
}
const invalid = (): never => { throw new DeviceOutputProtocolError(); };
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const natural = (value: unknown, minimum: number, maximum: number): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= maximum;
const uuidBytes = (value: string): Buffer => {
  if (!isCollectionId(value)) return invalid();
  return Buffer.from(value.replaceAll('-', ''), 'hex');
};
const uuid = (bytes: Buffer): string => {
  const value = bytes.toString('hex');
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
};
const formatCodes: Record<DeviceOutputPcmFormat, number> = { 'pcm-s16le': 1, 'pcm-s24le': 2, 'pcm-s32le': 3, 'pcm-f32le': 4 };
const supportedRates = new Set([44100, 48000, 88200, 96000, 176400, 192000]);

/** 固定320字节、LE、无ABI填充；任何未使用字节保持零。 */
export function encodeDeviceOutputHeader(value: DeviceOutputHeader): Buffer {
  const uid = Buffer.from(value.uid, 'utf8');
  const identitySha256 = value.scope === 'formal-recording' ? value.recordSha256
    : value.scope === 'replica-playback' ? value.playbackIdentitySha256 : undefined;
  if (!isCollectionId(value.runId) || !hash(identitySha256) || !hash(value.pcmSha256)
    || /^0{64}$/u.test(identitySha256) || /^0{64}$/u.test(value.pcmSha256)
    || uid.length < 1 || uid.length > 128 || uid.includes(0) || uid.toString('utf8') !== value.uid
    || !supportedRates.has(value.sampleRate) || !natural(value.channelCount, 1, 2)
    || !(value.format in formatCodes) || !natural(value.bufferFrames, 16, 4096) || (value.bufferFrames & value.bufferFrames - 1) !== 0
    || !natural(value.capacityFrames, value.bufferFrames, 16384)
    || !natural(value.tailFrames, value.bufferFrames, 3840000)
    || !natural(value.minimumZeroCallbacks, 1, 128)
    || !natural(value.frameCount, 1, Math.floor(value.sampleRate * 6 * 60 * 60))) return invalid();
  const bytes = Buffer.alloc(DEVICE_OUTPUT_HEADER_BYTES);
  bytes.write('MBOD', 0, 'ascii'); bytes.writeUInt16LE(DEVICE_OUTPUT_PROTOCOL_VERSION, 4); bytes.writeUInt16LE(bytes.length, 6);
  uuidBytes(value.runId).copy(bytes, 8); bytes.writeUInt16LE(uid.length, 24); bytes.writeUInt16LE(formatCodes[value.format], 26);
  bytes.writeUInt32LE(value.sampleRate, 28); bytes.writeUInt32LE(value.channelCount, 32);
  bytes.writeUInt32LE(value.bufferFrames, 36); bytes.writeUInt32LE(value.capacityFrames, 40);
  bytes.writeUInt32LE(value.minimumZeroCallbacks, 44); bytes.writeBigUInt64LE(BigInt(value.frameCount), 48);
  bytes.writeBigUInt64LE(BigInt(value.tailFrames), 56);
  Buffer.from(identitySha256, 'hex').copy(bytes, 64); Buffer.from(value.pcmSha256, 'hex').copy(bytes, 96);
  uid.copy(bytes, 128); bytes[256] = value.scope === 'formal-recording' ? 1 : 2; return bytes;
}

export function encodeDeviceOutputControl(runId: string, operation: 'run' | 'cancel', sequence: number): Buffer {
  if (!natural(sequence, 1, 0xffff_ffff)) return invalid();
  const bytes = Buffer.alloc(DEVICE_OUTPUT_CONTROL_BYTES);
  bytes.write('MBDC', 0, 'ascii'); bytes.writeUInt16LE(DEVICE_OUTPUT_PROTOCOL_VERSION, 4);
  bytes.writeUInt16LE(operation === 'run' ? 1 : 2, 6); uuidBytes(runId).copy(bytes, 8);
  bytes.writeUInt32LE(sequence, 24); return bytes;
}

const flag = (value: number): boolean => { if (value > 1) return invalid(); return value === 1; };
const safeBigInt = (value: bigint): number => {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) return invalid(); return Number(value);
};

/** 仅接收同一run、连续序号、单调且有界的进度；终态仍须等待child.close。 */
export function createDeviceOutputEventDecoder(input: { runId: string; frameCount: number; tailFrames: number }) {
  if (!isCollectionId(input.runId) || !natural(input.frameCount, 1, Number.MAX_SAFE_INTEGER)
    || !natural(input.tailFrames, 1, 3840000)) return invalid();
  let carry = Buffer.alloc(0), sequence = 0, phase: 'initial' | 'accepted' | 'prepared' | 'running' | 'source-eof' | 'drained' | 'terminal' = 'initial';
  let previousSupplied = 0, previousConsumed = 0, previousZero = 0, previousStarted = false;
  let terminal: DeviceOutputEvent | undefined;
  function decode(bytes: Buffer): DeviceOutputEvent {
    if (bytes.toString('ascii', 0, 4) !== 'MBDE' || bytes.readUInt16LE(4) !== DEVICE_OUTPUT_PROTOCOL_VERSION
      || !bytes.subarray(62, 64).every(byte => byte === 0)) return invalid();
    const kind = bytes.readUInt16LE(6), next = bytes.readUInt32LE(8), code = bytes.readUInt32LE(12);
    if (kind < 1 || kind > 9 || next !== sequence + 1 || next > 300000 || uuid(bytes.subarray(16, 32)) !== input.runId
      || (kind !== 7 && kind !== 8 && code !== 0) || (kind === 7 && code !== 11) || (kind === 8 && (code < 1 || code > 13))) return invalid();
    const suppliedFrames = safeBigInt(bytes.readBigUInt64LE(32));
    const consumedFrames = safeBigInt(bytes.readBigUInt64LE(40));
    const zeroFilledFrames = safeBigInt(bytes.readBigUInt64LE(48));
    const event: DeviceOutputEvent = { kind: kind as DeviceOutputEventKind, sequence: next, code, runId: input.runId,
      suppliedFrames, consumedFrames, zeroFilledFrames,
      sourceEof: flag(bytes[56]!), hardwareDrained: flag(bytes[57]!), stopAcknowledged: flag(bytes[58]!),
      destroyAcknowledged: flag(bytes[59]!), callbackFault: flag(bytes[60]!), startAttempted: flag(bytes[61]!) };
    if (suppliedFrames < previousSupplied || suppliedFrames > input.frameCount
      || consumedFrames < previousConsumed || consumedFrames > suppliedFrames || zeroFilledFrames < previousZero
      || previousStarted && !event.startAttempted || phase === 'terminal') return invalid();
    if (kind === 1 && phase === 'initial' && !event.startAttempted) phase = 'accepted';
    else if (kind === 2 && phase === 'accepted' && !event.startAttempted) phase = 'prepared';
    else if (kind === 3 && phase === 'prepared' && event.startAttempted) phase = 'running';
    else if (kind === 9 && (phase === 'running' || phase === 'source-eof')) {
      if (consumedFrames <= previousConsumed) return invalid();
    } else if (kind === 4 && phase === 'running' && suppliedFrames === input.frameCount) phase = 'source-eof';
    else if (kind === 5 && phase === 'source-eof' && suppliedFrames === input.frameCount
      && consumedFrames === input.frameCount && zeroFilledFrames >= input.tailFrames && event.hardwareDrained
      && !event.callbackFault) phase = 'drained';
    else if (kind === 6 && phase === 'drained' && event.hardwareDrained && event.stopAcknowledged
      && event.destroyAcknowledged && !event.callbackFault) phase = 'terminal';
    else if (kind === 7 && phase !== 'initial' && event.destroyAcknowledged
      && (event.startAttempted ? event.stopAcknowledged : !event.stopAcknowledged)) phase = 'terminal';
    else if (kind === 8 && phase !== 'initial') phase = 'terminal';
    else return invalid();
    sequence = next; previousSupplied = suppliedFrames; previousConsumed = consumedFrames;
    previousZero = zeroFilledFrames; previousStarted = event.startAttempted;
    if (phase === 'terminal') terminal = event;
    return event;
  }
  return {
    push(chunk: Buffer): DeviceOutputEvent[] {
      if (!Buffer.isBuffer(chunk) || chunk.length === 0 || chunk.length > 64 * 1024 || carry.length + chunk.length > 64 * 1024 + 63) return invalid();
      carry = Buffer.concat([carry, chunk]);
      const events: DeviceOutputEvent[] = [];
      while (carry.length >= DEVICE_OUTPUT_EVENT_BYTES) {
        events.push(decode(carry.subarray(0, DEVICE_OUTPUT_EVENT_BYTES)));
        carry = carry.subarray(DEVICE_OUTPUT_EVENT_BYTES);
      }
      return events;
    },
    finish(exitCode: number | null): DeviceOutputEvent {
      if (carry.length || !terminal || (terminal.kind === 6 ? exitCode !== 0 : terminal.kind === 7 ? exitCode !== 2 : exitCode !== 1)) return invalid();
      return terminal;
    },
    get terminal(): DeviceOutputEvent | undefined { return terminal; },
    get sequence(): number { return sequence; },
  };
}
