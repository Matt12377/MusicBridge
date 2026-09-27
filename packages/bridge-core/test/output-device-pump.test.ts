import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { pumpOutputDevicePcm } from '../src/recording/output-device-pump.js';
import type { ReadonlyAudioReader } from '../src/recording/readonly-audio-consumer.js';

const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
function fakeReader(pcm: Buffer, frameBytes = 4): ReadonlyAudioReader {
  return {
    descriptor: { dataOffset: 44, frameCount: pcm.length / frameBytes, channelCount: 2, sampleFormat: 'pcm-s16le' },
    async readFrames(startFrame, frames) {
      const bytes = pcm.subarray(startFrame * frameBytes, (startFrame + frames) * frameBytes);
      return { bytes, frames, sourceEof: startFrame + frames === pcm.length / frameBytes };
    },
  };
}

test('Core仅按只读帧视图有界供PCM，完整Hash不冒充HAL排空', async () => {
  const pcm = Buffer.from(Array.from({ length: 40 }, (_, index) => index));
  const reads: Array<[number, number]> = [], chunks: Buffer[] = [];
  const original = fakeReader(pcm), reader: ReadonlyAudioReader = {
    descriptor: original.descriptor,
    readFrames(start, count) { reads.push([start, count]); return original.readFrames(start, count); },
  };
  const result = await pumpOutputDevicePcm({ reader, expectedPcmSha256: sha(pcm), signal: new AbortController().signal,
    checkOperation() {}, maxFramesPerRead: 4, async writeChunk(bytes) { chunks.push(Buffer.from(bytes)); } });
  assert.deepEqual(reads, [[0, 4], [4, 4], [8, 2]]);
  assert.ok(chunks.every(bytes => bytes.length <= 16));
  assert.deepEqual(Buffer.concat(chunks), pcm);
  assert.deepEqual(result, { suppliedFrames: 10, suppliedPcmSha256: sha(pcm) });
  assert.deepEqual(Reflect.ownKeys(reader).sort(), ['descriptor', 'readFrames']);
});

test('提前EOF、短读与错误全文件Hash均不能产生供帧成功', async () => {
  const pcm = Buffer.alloc(16, 3), base = fakeReader(pcm);
  await assert.rejects(pumpOutputDevicePcm({ reader: { ...base, async readFrames() { return { bytes: pcm.subarray(0, 4), frames: 1, sourceEof: true }; } },
    expectedPcmSha256: sha(pcm), signal: new AbortController().signal, checkOperation() {}, async writeChunk() {} }), { code: 'INPUT_CHANGED' });
  await assert.rejects(pumpOutputDevicePcm({ reader: base, expectedPcmSha256: '0'.repeat(64), signal: new AbortController().signal,
    checkOperation() {}, async writeChunk() {} }), { code: 'INPUT_CHANGED' });
});

test('写端取消、scope漂移和管道失败都停止下一块读取', async () => {
  const pcm = Buffer.alloc(32, 7), base = fakeReader(pcm);
  for (const mode of ['cancel', 'scope', 'sink'] as const) {
    const controller = new AbortController(); let reads = 0, writes = 0, current = true;
    const reader: ReadonlyAudioReader = { descriptor: base.descriptor, readFrames(start, count) { ++reads; return base.readFrames(start, count); } };
    const pending = pumpOutputDevicePcm({ reader, expectedPcmSha256: sha(pcm), signal: controller.signal, maxFramesPerRead: 2,
      checkOperation() { if (!current) throw new Error('合成scope失效'); },
      async writeChunk() {
        ++writes;
        if (mode === 'cancel') controller.abort();
        if (mode === 'scope') current = false;
        if (mode === 'sink') throw new Error('合成管道关闭');
      } });
    await assert.rejects(pending, { code: mode === 'cancel' ? 'CANCELLED' : mode === 'scope' ? 'SCOPE_CHANGED' : 'SINK_CLOSED' });
    assert.equal(reads, 1); assert.equal(writes, 1);
  }
});
