import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { validateIpcRequest } from '@music-bridge/contracts';
import { isDatasetCommand, isDatasetProjectionPayload, isDatasetProjectionResult, isDatasetOwnerProjectionRequest, DATASET_OWNER_PROTOCOL_VERSION } from '../src/collection/dataset-owner-protocol.js';

test('扫描预算私有协议：只接受原Node投影上的空闭合payload', () => {
  for (const value of [{}, Object.create(null)]) assert.equal(isDatasetProjectionPayload('scanReadBudget', value), true);
  let reads = 0;
  const getter = Object.defineProperty({}, 'concurrency', { enumerable: true, get() { ++reads; throw new Error('不能读getter'); } });
  const proxy = new Proxy({}, { ownKeys() { ++reads; throw new Error('不能触发proxy'); }, getPrototypeOf() { ++reads; throw new Error('不能触发proxy'); } });
  for (const value of [null, [], 1, { purpose: 'scan' }, { concurrency: 1 }, { permitId: randomUUID() },
    Object.create({ inherited: true }), getter, proxy, { [Symbol('extra')]: 1 }]) {
    assert.equal(isDatasetProjectionPayload('scanReadBudget', value), false);
  }
  assert.equal(reads, 0);
});

test('扫描预算私有协议：提示严格限制0/1/2/8且不是许可回执', () => {
  for (const concurrency of [0, 1, 2, 8]) {
    assert.equal(isDatasetProjectionResult('scanReadBudget', { concurrency }), true);
    assert.equal(isDatasetProjectionResult('scanReadBudget', Object.assign(Object.create(null), { concurrency })), true);
    assert.equal(isDatasetProjectionResult('scanReadAcquire', { concurrency }), false);
    assert.equal(isDatasetProjectionResult('scanReadStatus', { concurrency }), false);
  }
  let reads = 0;
  const getter = Object.defineProperty({}, 'concurrency', { enumerable: true, get() { ++reads; return 8; } });
  const proxy = new Proxy({ concurrency: 8 }, { ownKeys() { ++reads; throw new Error('不能触发proxy'); }, getPrototypeOf() { ++reads; throw new Error('不能触发proxy'); } });
  for (const value of [null, [], {}, { concurrency: -0 }, { concurrency: -1 }, { concurrency: 3 }, { concurrency: 9 },
    { concurrency: NaN }, { concurrency: Infinity }, { concurrency: 1.5 }, { concurrency: '1' },
    { concurrency: 1, permitId: randomUUID() }, { concurrency: 1, [Symbol('extra')]: true },
    Object.create({ concurrency: 8 }), Object.defineProperty({}, 'concurrency', { value: 8, enumerable: false }), getter, proxy,
    { status: 'granted', permitId: randomUUID() }]) {
    assert.equal(isDatasetProjectionResult('scanReadBudget', value), false);
  }
  assert.equal(reads, 0);
});

test('扫描预算私有协议：不成为公开Ipc、Dataset写命令或Source授权字段', () => {
  assert.equal(isDatasetCommand('scanReadBudget'), false);
  assert.equal(validateIpcRequest({ version: 1, id: randomUUID(), command: 'scanReadBudget', payload: {} }).ok, false);
  assert.equal(isDatasetProjectionPayload('scanReadBudget', { library_write_enabled: true }), false);
  assert.equal(isDatasetProjectionPayload('scanReadBudget', { purpose: 'local-album-display' }), false);
  const request = { version: DATASET_OWNER_PROTOCOL_VERSION, type: 'projection', projectionRequestId: randomUUID(),
    epoch: randomUUID(), command: 'scanReadBudget', payload: {} };
  assert.equal(isDatasetOwnerProjectionRequest(request), true);
  assert.equal(isDatasetOwnerProjectionRequest({ ...request, payload: { concurrency: 8 } }), false);
});
