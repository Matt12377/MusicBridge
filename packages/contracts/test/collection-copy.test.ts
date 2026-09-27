import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { isCollectionCopyDetail, validateIpcRequest, validateIpcResponseForCommand } from '../src/index.js';

test('按永久实体编号读取副本的合同只接受精确 ID 和当前单盘投影', () => {
  const physicalId = 'MB-C-00427';
  const result = { modelId: randomUUID(), copy: { physicalId, lotId: randomUUID(), skuId: randomUUID(), lengthMinutes: 90,
    packaging: 'opened', usage: 'blank', available: true, origin: 'blank-pool', revision: 3 } };
  assert.equal(validateIpcRequest({ version: 1, id: 'copy', command: 'collection.copy', payload: { physicalId } }).ok, true);
  for (const payload of [{ physicalId: 'MB-C-0' }, { physicalId, page: { offset: 0, limit: 1 } }, { modelId: result.modelId }]) {
    assert.equal(validateIpcRequest({ version: 1, id: 'copy', command: 'collection.copy', payload }).ok, false);
  }
  assert.equal(isCollectionCopyDetail(result), true);
  assert.equal(isCollectionCopyDetail({ ...result, copyIndex: 0 }), true);
  assert.equal(isCollectionCopyDetail({ ...result, copyIndex: -1 }), false);
  assert.equal(isCollectionCopyDetail({ ...result, copyIndex: 0.5 }), false);
  assert.equal(isCollectionCopyDetail({ ...result, copy: { ...result.copy, usage: 'reserved', reservationOwner: { kind: 'inventory' } } }), true);
  assert.equal(isCollectionCopyDetail({ ...result, copy: { ...result.copy, usage: 'reserved' } }), true);
  assert.equal(isCollectionCopyDetail({ ...result, copy: { ...result.copy, usage: 'reserved', reservationOwner: { kind: 'recording-plan', draftId: randomUUID(), planId: randomUUID() } } }), true);
  assert.equal(isCollectionCopyDetail({ ...result, copy: { ...result.copy, usage: 'reserved', reservationOwner: { kind: 'unknown' } } }), true);
  assert.equal(isCollectionCopyDetail({ ...result, copy: { ...result.copy, usage: 'reserved', reservationOwner: { kind: 'recording-plan', planId: randomUUID() } } }), false);
  assert.equal(isCollectionCopyDetail({ ...result, copy: { ...result.copy, reservationOwner: { kind: 'inventory' } } }), false);
  assert.equal(validateIpcResponseForCommand({ version: 1, id: 'copy', ok: true, result }, 'collection.copy').ok, true);
  assert.equal(isCollectionCopyDetail({ ...result, copy: { ...result.copy, revision: 0 } }), false);
  assert.equal(isCollectionCopyDetail({ ...result, extra: 'private' }), false);
});
