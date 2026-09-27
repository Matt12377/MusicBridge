import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import {
  createDeviceOutputEventDecoder, encodeDeviceOutputControl, encodeDeviceOutputHeader,
  type DeviceOutputEventKind,
} from '../src/recording/device-output-protocol.js';

const hash = (digit: string) => digit.repeat(64);
function event(runId: string, kind: DeviceOutputEventKind, sequence: number, supplied: number, consumed: number, zero: number,
  flags: { eof?: boolean; drained?: boolean; stop?: boolean; destroy?: boolean; fault?: boolean; started?: boolean } = {}, code = 0): Buffer {
  const bytes = Buffer.alloc(64);
  bytes.write('MBDE', 0); bytes.writeUInt16LE(1, 4); bytes.writeUInt16LE(kind, 6);
  bytes.writeUInt32LE(sequence, 8); bytes.writeUInt32LE(code, 12);
  Buffer.from(runId.replaceAll('-', ''), 'hex').copy(bytes, 16);
  bytes.writeBigUInt64LE(BigInt(supplied), 32); bytes.writeBigUInt64LE(BigInt(consumed), 40); bytes.writeBigUInt64LE(BigInt(zero), 48);
  bytes[56] = Number(!!flags.eof); bytes[57] = Number(!!flags.drained); bytes[58] = Number(!!flags.stop);
  bytes[59] = Number(!!flags.destroy); bytes[60] = Number(!!flags.fault);
  bytes[61] = Number(flags.started ?? [3, 4, 5, 6, 9].includes(kind));
  return bytes;
}

test('设备头/控制帧使用独立MBOD身份与严格固定偏移', () => {
  const runId = randomUUID();
  const header = encodeDeviceOutputHeader({ runId, uid: '精确-设备-01', sampleRate: 48000, channelCount: 2,
    format: 'pcm-s16le', bufferFrames: 256, capacityFrames: 2048, frameCount: 48000,
    tailFrames: 1024, minimumZeroCallbacks: 2, scope: 'formal-recording', recordSha256: hash('a'), pcmSha256: hash('b') });
  assert.equal(header.length, 320); assert.equal(header.toString('ascii', 0, 4), 'MBOD');
  assert.equal(header.readUInt16LE(6), 320); assert.equal(header.readUInt16LE(24), Buffer.byteLength('精确-设备-01'));
  assert.equal(header.readUInt16LE(26), 1); assert.equal(header.readBigUInt64LE(48), 48000n);
  assert.equal(header.readBigUInt64LE(56), 1024n); assert.equal(header.subarray(64, 96).toString('hex'), hash('a'));
  assert.equal(header[256], 1); assert.ok(header.subarray(257).every(byte => byte === 0));
  const replica = encodeDeviceOutputHeader({ runId, uid: '精确-设备-01', sampleRate: 48000, channelCount: 2,
    format: 'pcm-s16le', bufferFrames: 256, capacityFrames: 2048, frameCount: 48000,
    tailFrames: 1024, minimumZeroCallbacks: 2, scope: 'replica-playback', playbackIdentitySha256: hash('c'), pcmSha256: hash('b') });
  assert.equal(replica[256], 2); assert.equal(replica.subarray(64, 96).toString('hex'), hash('c'));
  const run = encodeDeviceOutputControl(runId, 'run', 1), cancel = encodeDeviceOutputControl(runId, 'cancel', 2);
  assert.equal(run.length, 32); assert.equal(run.toString('ascii', 0, 4), 'MBDC');
  assert.equal(run.readUInt16LE(6), 1); assert.equal(cancel.readUInt16LE(6), 2); assert.equal(cancel.readUInt32LE(24), 2);
  assert.throws(() => encodeDeviceOutputHeader({ runId, uid: 'device', sampleRate: 48000, channelCount: 2,
    format: 'pcm-s16le', bufferFrames: 16, capacityFrames: 32, frameCount: 8,
    tailFrames: 16, minimumZeroCallbacks: 2, scope: 'formal-recording', recordSha256: hash('0'), pcmSha256: hash('b') }));
  assert.throws(() => encodeDeviceOutputHeader({ runId, uid: 'device', sampleRate: 48000, channelCount: 2,
    format: 'pcm-s16le', bufferFrames: 16, capacityFrames: 32, frameCount: 8,
    tailFrames: 16, minimumZeroCallbacks: 2, scope: 'replica-playback', playbackIdentitySha256: hash('0'), pcmSha256: hash('b') }));
});

test('碎片事件按run/sequence绑定，进度、EOF、排空、close前终态分离', () => {
  const runId = randomUUID(), decoder = createDeviceOutputEventDecoder({ runId, frameCount: 8, tailFrames: 4 });
  const messages = [event(runId, 1, 1, 0, 0, 0), event(runId, 2, 2, 0, 0, 0),
    event(runId, 3, 3, 4, 0, 0), event(runId, 9, 4, 8, 4, 0),
    event(runId, 4, 5, 8, 4, 0), event(runId, 9, 6, 8, 8, 4, { eof: true }),
    event(runId, 5, 7, 8, 8, 8, { eof: true, drained: true }),
    event(runId, 6, 8, 8, 8, 8, { eof: true, drained: true, stop: true, destroy: true })];
  const bytes = Buffer.concat(messages), observed = [];
  for (let offset = 0; offset < bytes.length; offset += 19) observed.push(...decoder.push(bytes.subarray(offset, offset + 19)));
  assert.deepEqual(observed.map(item => item.kind), [1, 2, 3, 9, 4, 9, 5, 6]);
  assert.equal(decoder.terminal?.hardwareDrained, true); assert.equal(decoder.finish(0).kind, 6);
});

test('篡改身份、回退进度、过早排空与仅exit0都不能成功', () => {
  const runId = randomUUID(), another = randomUUID();
  const fresh = () => createDeviceOutputEventDecoder({ runId, frameCount: 8, tailFrames: 4 });
  const sequence = [event(runId, 1, 1, 0, 0, 0), event(runId, 2, 2, 0, 0, 0), event(runId, 3, 3, 4, 0, 0)];
  const wrong = fresh(); for (const item of sequence) wrong.push(item);
  assert.throws(() => wrong.push(event(another, 9, 4, 8, 4, 0)));
  const rollback = fresh(); for (const item of sequence) rollback.push(item);
  rollback.push(event(runId, 9, 4, 8, 4, 0));
  assert.throws(() => rollback.push(event(runId, 9, 5, 7, 3, 0)));
  const early = fresh(); for (const item of sequence) early.push(item);
  assert.throws(() => early.push(event(runId, 5, 4, 8, 8, 4, { eof: true, drained: true })));
  assert.throws(() => fresh().finish(0));
});

test('Prepared取消与已启动取消使用不同Stop证明，均需Destroy和close', () => {
  const runId = randomUUID();
  const prepared = createDeviceOutputEventDecoder({ runId, frameCount: 8, tailFrames: 4 });
  prepared.push(event(runId, 1, 1, 0, 0, 0)); prepared.push(event(runId, 2, 2, 0, 0, 0));
  prepared.push(event(runId, 7, 3, 0, 0, 0, { destroy: true }, 11));
  assert.equal(prepared.finish(2).startAttempted, false);
  const started = createDeviceOutputEventDecoder({ runId, frameCount: 8, tailFrames: 4 });
  started.push(event(runId, 1, 1, 0, 0, 0)); started.push(event(runId, 2, 2, 0, 0, 0));
  started.push(event(runId, 3, 3, 4, 0, 0));
  started.push(event(runId, 7, 4, 4, 0, 0, { started: true, stop: true, destroy: true }, 11));
  assert.equal(started.finish(2).startAttempted, true);
  const missingStop = createDeviceOutputEventDecoder({ runId, frameCount: 8, tailFrames: 4 });
  missingStop.push(event(runId, 1, 1, 0, 0, 0)); missingStop.push(event(runId, 2, 2, 0, 0, 0));
  missingStop.push(event(runId, 3, 3, 4, 0, 0));
  assert.throws(() => missingStop.push(event(runId, 7, 4, 4, 0, 0, { started: true, destroy: true }, 11)));
});
