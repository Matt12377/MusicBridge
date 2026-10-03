import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { isDatasetCollectionSnapshot, isDatasetLargeCollectionSnapshot } from '../../src/collection/dataset-owner-protocol.js';
import { createRustReadonlyDatasetEndpoint, RustSidecarError } from '../../src/rust-core/readonly-sidecar.js';
import { exactScalePrepareFrame, exactScaleSnapshot, scalePrepareFrame } from '../helpers/optional-scale-fixture.js';

test('合法完整 snapshot 的 4MiB 与 8MiB ±1 独立于 prepare 帧预算', () => {
  for (const [count, limit, guard] of [[2_000, 4_194_304, isDatasetCollectionSnapshot], [5_000, 8_388_608, isDatasetLargeCollectionSnapshot]] as const) {
    for (const delta of [-1, 0, 1]) {
      const snapshot = exactScaleSnapshot(limit + delta, count);
      assert.equal(guard(snapshot), delta <= 0);
      if (count === 2_000) assert.ok(scalePrepareFrame(snapshot).length - 1 > limit);
    }
  }
});

test('已知合法 DTO 的 prepare 帧 4MiB+1 在 spawn 前拒绝，安全关闭不封禁', async t => {
  const snapshot = exactScalePrepareFrame(4_194_305);
  assert.equal(isDatasetCollectionSnapshot(snapshot), true);
  const binary = { path: process.execPath, sha256: createHash('sha256').update(readFileSync(process.execPath)).digest('hex') };
  let spawned = 0, fatal = 0;
  t.mock.method(childProcess, 'spawn', () => { spawned++; throw new Error('该已知超限帧不应创建进程。'); });
  const endpoint = createRustReadonlyDatasetEndpoint({ binary, snapshot, onFatal: () => { fatal++; } });
  await assert.rejects(endpoint.prepare(), error => error instanceof RustSidecarError && error.code === 'CAPACITY_EXCEEDED');
  assert.equal(spawned, 0);
  assert.equal(fatal, 0);
  const close = endpoint.close(); assert.equal(close, endpoint.close()); await close;
});
