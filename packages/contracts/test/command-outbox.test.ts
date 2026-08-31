import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import * as contracts from '../src/index.js';

const datasetId = randomUUID(), commandId = randomUUID(), id = randomUUID();
const request = { datasetId, command: 'collection.setPolicy', payload: { commandId, modelId: id, expectedRevision: 1, collectorPolicy: 'normal', minimumSealedReserve: 0 } };
async function api() {
  const module = await import('../src/command-outbox.js').catch(() => ({}));
  assert.ok('isCommandOutboxExecute' in module, '缺少严格命令 outbox 合同');
  return module as typeof import('../src/command-outbox.js');
}

test('普通 outbox 使用原领域验证，拒绝跨域、读取、嵌套与私有路径', async () => {
  const c = await api();
  assert.equal(c.isCommandOutboxExecute(request), true);
  for (const command of ['playback.play', 'auth.setCredential', 'collection.list', 'recordingSources.authorize', 'commandOutbox.execute', 'recordingBackups.activate']) {
    assert.equal(c.isCommandOutboxExecute({ ...request, command }), false);
  }
  for (const change of [{ absolutePath: '/private/合成' }, { credential: '合成密钥' }, { expectedRevision: -1 }]) {
    assert.equal(c.isCommandOutboxExecute({ ...request, payload: { ...request.payload, ...change } }), false);
  }
  assert.equal(c.isCommandOutboxExecute({ ...request, datasetId: '/private/合成' }), false);
  assert.equal(contracts.validateIpcRequest({ version: 1, id, command: 'commandOutbox.execute', payload: request }).ok, true);
  assert.equal(contracts.validateIpcRequest({ version: 1, id, command: 'commandOutbox.context', payload: { datasetId } }).ok, false);
});

test('选择与激活仅保留公开参数，不能借普通execute重开原生授权', async () => {
  const c = await api();
  for (const command of ['recordingSources.chooseRoot', 'recordingPreparation.chooseDestination', 'recordingArchive.choose']) {
    const selection = { datasetId, command, payload: { commandId } };
    assert.equal(c.isCommandOutboxRequest(selection), true);
    assert.equal(c.isCommandOutboxExecute(selection), false);
    assert.equal(c.isCommandOutboxRequest({ ...selection, payload: { commandId, absolutePath: '/private/合成' } }), false);
  }
  const activation = { datasetId, command: 'recordingBackups.activate', payload: { commandId, restoreJobId: id, expectedActiveId: null, userConfirmed: true, stopPlaybackConfirmed: true } };
  assert.equal(c.isCommandOutboxRequest(activation), true);
  assert.equal(c.isCommandOutboxExecute(activation), false);
});

test('照片保留受限规范化数据且拒绝原图路径与超限内容', async () => {
  const c = await api(), image = { dataUrl: 'data:image/jpeg;base64,/9j/2Q==', width: 1, height: 1 };
  const photo = { datasetId, command: 'collection.addPhoto', payload: { commandId, modelId: id, image } };
  assert.equal(c.isCommandOutboxExecute(photo), true);
  assert.equal(c.isCommandOutboxExecute({ ...photo, payload: { ...photo.payload, image: { ...image, dataUrl: '/private/photo.jpg' } } }), false);
  assert.equal(c.isCommandOutboxExecute({ ...photo, payload: { ...photo.payload, image: { ...image, dataUrl: image.dataUrl + 'A'.repeat(c.MAX_COMMAND_OUTBOX_PAYLOAD_BYTES) } } }), false);
});

test('响应按实际命令校验，公开概览不暴露请求、结果或路径', async () => {
  const c = await api(), result = { modelId: id };
  assert.equal(c.isCommandOutboxResult({ command: request.command, result }), true);
  assert.equal(c.isCommandOutboxResult({ command: 'recordingDrafts.update', result }), false);
  assert.equal(c.isCommandOutboxResult({ command: request.command, result: { ...result, absolutePath: '/private/合成' } }), false);
  const view = { id, commandId, command: request.command, datasetId, state: 'uncertain', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), acknowledged: false, canRetry: true };
  assert.equal(c.isCommandOutboxOverview({ datasetId, entries: [view] }), true);
  for (const extra of [{ payload: request.payload }, { result }, { path: '/private/合成' }, { errorCode: '合成堆栈' }]) assert.equal(c.isCommandOutboxView({ ...view, ...extra }), false);
  assert.equal(c.isCommandOutboxAction({ id, userConfirmed: false }), false);
});

test('原生内部信封保留严格scope，激活回执只允许内部响应', () => {
  const input = { version: 1, id, command: 'recordingSources.authorize', expectedDatasetId: datasetId, payload: { commandId, absolutePath: '/private/合成' } };
  const result = contracts.validateIpcRequest(input);
  assert.equal(result.ok, true); if (result.ok) assert.equal((result.value as typeof input).expectedDatasetId, datasetId);
  assert.equal(contracts.validateIpcRequest({ ...input, expectedDatasetId: '/private/坏scope' }).ok, false);
  const payload = { commandId, restoreJobId: id, expectedActiveId: null, userConfirmed: true, stopPlaybackConfirmed: true };
  assert.equal(contracts.validateIpcRequest({ version: 1, id, command: 'recordingBackups.activationReceipt', payload }).ok, true);
  const response = { version: 1, id, ok: true, result: { activation: null } };
  assert.equal(contracts.validateIpcResponseForCommand(response, 'recordingBackups.activationReceipt').ok, false);
  assert.equal(contracts.validateIpcInternalResponseForCommand(response, 'recordingBackups.activationReceipt').ok, true);
});
