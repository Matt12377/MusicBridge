import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { isLocalScanPreparedBatch, validateIpcInternalRequest, validateIpcRequest } from '../src/index.js';

function preparedDsdBatch(container: 'DSF' | 'DFF') {
  return {
    batchId: randomUUID(), jobId: randomUUID(), expectedJobRevision: '3', checkpointBefore: null,
    items: [{
      relative: `合成专辑/合成曲目.${container.toLowerCase()}`, signature: '1:2:4096:3:4',
      parserVersion: 'musicbridge-rust-media/v1', outcome: 'accepted',
      fields: { title: '合成曲目', artist: '合成艺人', album: '合成专辑' }, failureCode: null, reused: false,
      readFacts: {
        technical: { container, codec: 'DSD', lossless: true, sampleRateHz: 2822400, channels: 2,
          bitsPerSample: 1, durationSeconds: 1, evidence: 'bounded-parser-reported' },
        coverEvidence: [],
        readEvidence: { bytesRead: 64, readCalls: 1, maxReadBytes: 64, allocationBytes: 64,
          elapsedMs: 1, wholeAudioHash: false, wholeAudioDecode: false },
      },
    }],
    frontier: ['合成专辑'], completed: false, kind: 'cue-sidecars-v1', cueItems: [],
  };
}

const rejectedTechnical: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
  ['非 DSD 编码', { codec: 'PCM' }],
  ['有损声明', { lossless: false }],
  ['未知无损声明', { lossless: null }],
  ['非 1 位深', { bitsPerSample: 16 }],
  ['未知位深', { bitsPerSample: null }],
  ['未支持采样率', { sampleRateHz: 44100 }],
  ['无限采样率', { sampleRateHz: Infinity }],
  ['声道超限', { channels: 7 }],
  ['非整数声道', { channels: 1.5 }],
  ['零声道', { channels: 0 }],
  ['零时长', { durationSeconds: 0 }],
  ['负时长', { durationSeconds: -1 }],
  ['未知时长', { durationSeconds: null }],
  ['无限时长', { durationSeconds: Infinity }],
];

for (const container of ['DSF', 'DFF'] as const) {
  test(`v4 扫描合同：CUE 批次接收 ${container} 原 DSD 事实，公开入口仍拒绝私有批`, () => {
    const batch = preparedDsdBatch(container);
    const request = { version: 1, id: 'scan-dsd-fixture', command: 'localScan.prepareBatch',
      expectedDatasetId: randomUUID(), payload: { commandId: randomUUID(), jobId: batch.jobId, batch } };
    assert.equal(isLocalScanPreparedBatch(batch), true);
    assert.equal(validateIpcInternalRequest(request).ok, true);
    assert.equal(validateIpcRequest(request).ok, false);
    // 同一事实不依赖 CUE 标签；既有普通批仍使用相同 DSD 技术边界。
    const { kind: _kind, cueItems: _cueItems, ...ordinary } = batch;
    assert.equal(isLocalScanPreparedBatch(ordinary), true);
  });

  test(`v4 扫描合同：${container} 原采样率集合和 1 至 6 整数声道边界有效`, () => {
    for (const sampleRateHz of [2822400,3072000,5644800,6144000,11289600,12288000,22579200,24576000]) {
      for (const channels of [1, 6]) {
        const batch = preparedDsdBatch(container);
        Object.assign(batch.items[0]!.readFacts.technical, { sampleRateHz, channels, durationSeconds: 0.001 });
        assert.equal(isLocalScanPreparedBatch(batch), true);
      }
    }
  });

  for (const [label, patch] of rejectedTechnical) {
    test(`v4 扫描合同：${container} 拒绝${label}`, () => {
      const batch = preparedDsdBatch(container);
      Object.assign(batch.items[0]!.readFacts.technical, patch);
      assert.equal(isLocalScanPreparedBatch(batch), false);
    });
  }

  test(`v4 扫描合同：${container} 读取拒绝可保留且不能夹带非法成功事实`, () => {
    const batch = preparedDsdBatch(container), item = batch.items[0]!;
    const rejected = { ...item, outcome: 'rejected', fields: null, failureCode: 'BUDGET_EXCEEDED', readFacts: null };
    assert.equal(isLocalScanPreparedBatch({ ...batch, items: [rejected] }), true);
    assert.equal(isLocalScanPreparedBatch({ ...batch, items: [{ ...rejected, reused: true }] }), false);
    const invalidFacts = { ...item.readFacts, technical: { ...item.readFacts.technical, codec: 'PCM' } };
    assert.equal(isLocalScanPreparedBatch({ ...batch, items: [{ ...rejected, readFacts: invalidFacts }] }), false);
  });

  test(`v4 扫描合同：${container} 容器不得通过对象字符串伪装`, () => {
    let stringifications = 0;
    const batch = preparedDsdBatch(container);
    Object.assign(batch.items[0]!.readFacts.technical, { container: { toString() { stringifications++; return container; } } });
    assert.equal(isLocalScanPreparedBatch(batch), false);
    assert.equal(stringifications, 0);
  });
}

test('v4 扫描合同：既有 PCM 事实与读取预算保持原边界', () => {
  const batch = preparedDsdBatch('DSF');
  Object.assign(batch.items[0]!.readFacts.technical, { container: 'FLAC', codec: 'FLAC', sampleRateHz: 44100,
    lossless: true, bitsPerSample: 16, durationSeconds: null });
  assert.equal(isLocalScanPreparedBatch(batch), true);
  batch.items[0]!.readFacts.readEvidence.bytesRead = 32 * 1024 * 1024 + 1;
  assert.equal(isLocalScanPreparedBatch(batch), false);
});
