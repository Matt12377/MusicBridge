import assert from 'node:assert/strict';
import test from 'node:test';

const runId = '73000000-0000-4000-8000-000000000001';
const hash = 'ab'.repeat(32);
const uuidBytes = (id: string) => Buffer.from(id.replaceAll('-', ''), 'hex');
function event(kind: number, seq: number, frames = 0, code = 0): Buffer {
  const b = Buffer.alloc(128); b.write('MBFE'); b.writeUInt16LE(1, 4); b.writeUInt16LE(kind, 6); b.writeUInt32LE(seq, 8); b.writeUInt32LE(code, 12); uuidBytes(runId).copy(b, 16); b.writeBigUInt64LE(BigInt(seq * 1000), 32); b.writeBigUInt64LE(BigInt(frames), 40);
  if (kind >= 2) Buffer.from(hash, 'hex').copy(b, 64);
  if (kind === 5) Buffer.from(hash, 'hex').copy(b, 96);
  return b;
}
const load = () => import('../src/recording/output-protocol.js');
test('原生输出协议按固定偏移编码真实身份和只读PCM边界，不包含路径', async () => {
  const { encodeOutputHeader, encodeOutputControl } = await load();
  const request = { identity: { runId, planVersionId: runId, assetId: runId, planContentHash: hash, recipeHash: hash }, format: { sampleRate: 48000, channelCount: 2, outputSampleFormat: 'pcm-s24le' }, audio: { sha256: hash, pcmSha256: hash, size: 124, dataOffset: 64, frameCount: 10 } };
  const b = encodeOutputHeader(request as never, 7); assert.equal(b.length, 256); assert.equal(b.toString('ascii', 0, 4), 'MBFP'); assert.equal(b.readBigUInt64LE(184), 124n); assert.equal(b.readBigUInt64LE(192), 64n); assert.equal(b.readBigUInt64LE(200), 60n); assert.equal(b.readBigUInt64LE(208), 10n); assert.equal(b.readUInt16LE(222), 2); assert.equal(b.readUInt32LE(224), 7); assert.deepEqual(b.subarray(228), Buffer.alloc(28));
  const stop = encodeOutputControl(runId, 'stop', 1); assert.equal(stop.length, 32); assert.equal(stop.readUInt16LE(6), 2); assert.equal(stop.readUInt32LE(24), 1); assert.deepEqual(stop.subarray(8, 24), uuidBytes(runId));
  assert.throws(() => encodeOutputHeader({ ...request, audio: { ...request.audio, frameCount: Number.MAX_SAFE_INTEGER } } as never));
  assert.throws(() => encodeOutputHeader(request as never, 4097));
});
test('原生事件逐字节分片仍按序解码，只有实际帧和PCM Hash完整排空且退出0才通过', async () => {
  const { createOutputEventDecoder } = await load(); const decoder = createOutputEventDecoder({ runId, frameCount: 10, pcmSha256: hash });
  const kinds: number[] = []; for (const byte of Buffer.concat([event(1, 1), event(2, 2), event(3, 3), event(4, 4, 10), event(5, 5, 10)])) kinds.push(...decoder.push(Buffer.from([byte])).map(e => e.kind));
  assert.deepEqual(kinds, [1, 2, 3, 4, 5]); assert.deepEqual(decoder.finish(0), { consumedFrames: 10, pcmSha256: hash });
});
test('拒绝跨run、跳序、非法顺序、额外终态、Hash或帧数不符及截断尾部', async () => {
  const { createOutputEventDecoder } = await load();
  const valid = () => [event(1, 1), event(2, 2), event(3, 3), event(4, 4, 10), event(5, 5, 10)];
  const badRun = event(1, 1); badRun[16] = badRun[16]! ^ 1;
  const badHash = valid(); badHash[4]![100] = badHash[4]![100]! ^ 1;
  for (const frames of [[badRun], [event(1, 2)], [event(2, 1)], [...valid(), event(5, 6, 10)], badHash, [event(1, 1), event(2, 2), event(3, 3), event(4, 4, 9)]]) {
    const decoder = createOutputEventDecoder({ runId, frameCount: 10, pcmSha256: hash }); assert.throws(() => { decoder.push(Buffer.concat(frames)); decoder.finish(0); });
  }
  const decoder = createOutputEventDecoder({ runId, frameCount: 10, pcmSha256: hash }); decoder.push(Buffer.concat([...valid(), Buffer.from([1])])); assert.throws(() => decoder.finish(0));
});
test('停止、失败、退出码不符或stdout超预算不能伪造无设备检查通过', async () => {
  const { createOutputEventDecoder } = await load();
  for (const [tail, exit] of [[event(6, 2, 0, 1), 2], [event(7, 2, 0, 8), 1]] as const) { const d = createOutputEventDecoder({ runId, frameCount: 10, pcmSha256: hash }); d.push(Buffer.concat([event(1, 1), tail])); assert.throws(() => d.finish(exit)); }
  const d = createOutputEventDecoder({ runId, frameCount: 10, pcmSha256: hash }); d.push(Buffer.concat([event(1, 1), event(2, 2), event(3, 3), event(4, 4, 10), event(5, 5, 10)])); assert.throws(() => d.finish(1));
  assert.throws(() => createOutputEventDecoder({ runId, frameCount: 10, pcmSha256: hash }).push(Buffer.alloc(1025)));
});
test('SOURCE_EOF只表示供帧结束，最后回调消费完整帧后才允许SYNTHETIC_DRAINED', async () => {
  const { createOutputEventDecoder } = await load();
  const prefix = [event(1, 1), event(2, 2), event(3, 3), event(4, 4, 2048)];
  const decoder = createOutputEventDecoder({ runId, frameCount: 2051, pcmSha256: hash });
  assert.equal(decoder.push(Buffer.concat(prefix)).at(-1)!.consumedFrames, 2048);
  assert.throws(() => decoder.finish(0));
  decoder.push(event(5, 5, 2051));
  assert.deepEqual(decoder.finish(0), { consumedFrames: 2051, pcmSha256: hash });
  const short = createOutputEventDecoder({ runId, frameCount: 2051, pcmSha256: hash });
  short.push(Buffer.concat(prefix)); assert.throws(() => short.push(event(5, 5, 2048)));
});
