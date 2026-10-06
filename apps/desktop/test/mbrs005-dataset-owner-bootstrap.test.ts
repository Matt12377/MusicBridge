import assert from 'node:assert/strict';
import test from 'node:test';
import { parseDatasetOwnerWorkerData } from '../src/main/dataset-owner-bootstrap.js';
import { PHYSICAL_RESOURCE_BUFFER_BYTES } from '../../../packages/bridge-core/src/stream/physical-resource-locks.js';

test('MBRS005 私有Worker启动SAB限定固定尺寸，旧两字段兼容且未知字段/伪buffer拒绝', () => {
  const old = { dataDirectory: '/synthetic/data', resourcesDirectory: '/synthetic/resources' };
  assert.deepEqual(parseDatasetOwnerWorkerData(old), old);
  const buffer = new SharedArrayBuffer(PHYSICAL_RESOURCE_BUFFER_BYTES), input = { ...old, physicalResourceBuffer: buffer };
  assert.equal(parseDatasetOwnerWorkerData(input).physicalResourceBuffer, buffer);
  for (const fake of [new ArrayBuffer(PHYSICAL_RESOURCE_BUFFER_BYTES), new SharedArrayBuffer(4), new SharedArrayBuffer(PHYSICAL_RESOURCE_BUFFER_BYTES + 4), undefined, null, { byteLength: PHYSICAL_RESOURCE_BUFFER_BYTES }]) {
    assert.throws(() => parseDatasetOwnerWorkerData({ ...old, physicalResourceBuffer: fake }), /启动身份无效/u);
  }
  assert.throws(() => parseDatasetOwnerWorkerData({ ...input, session_id: 'fake' }), /启动身份无效/u);
});
