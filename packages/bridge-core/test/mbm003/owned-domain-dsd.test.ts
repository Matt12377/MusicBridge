import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { backendFixture } from './fixture-helpers.js';
import type { DatasetProjectionPort } from '../../src/collection/dataset-owner-protocol.js';

test('MBM003唯一Owner工厂：实际固定后端与私有缓存资格在同一工作库内接线，close后不再宣告能力', { timeout: 45_000 }, async t => {
  const f = await backendFixture(t);
  // 与实际 fresh Core/固定 Worker 共用模块实例；行为没有注入合成 converter 或 cache。
  const { prepareOwnedDatasetDomain } = await import('../../dist/collection/dataset-domain.js');
  const dataDirectory = path.join(f.directory, 'owned-dataset');
  await mkdir(dataDirectory, { mode: 0o700 });
  const projection: DatasetProjectionPort = { async call() { throw new Error('该 Owner 能力用例不调用外部投影。'); } };
  const domain = await prepareOwnedDatasetDomain({ dataDirectory, epoch: f.ownerEpoch, testMode: true, projection,
    mobileDsd: { converterDirectory: process.env.MBM003_CONVERTER_DIRECTORY!,
      converterManifestSha256: process.env.MBM003_CONVERTER_MANIFEST_SHA256!,
      cacheDirectory: path.join(dataDirectory, 'mobile-dsd-cache') } });
  f.onClose(() => domain.close());
  await domain.commitBoot();
  const mobileMain = domain.mobileMain; assert.ok(mobileMain);
  assert.deepEqual(await mobileMain({ kind: 'media-source', datasetId: domain.datasetId,
    request: { operation: 'capabilities' } }), { kind: 'mobile-source-capabilities', resourceDsdToPcm: true });
  await domain.close();
  const after = await mobileMain({ kind: 'media-source', datasetId: domain.datasetId,
    request: { operation: 'capabilities' } });
  assert.ok('kind' in after);
  assert.equal(after.kind, 'mobile-error');
  await f.unchanged(); await f.close();
});
