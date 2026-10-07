import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { isLocalOrganizerCommandPayload, isLocalOrganizerPlan, isOrganizerFrozenOperation, isOrganizerFrozenBody } from '../../src/local-organizer.js';
import { isCommandOutboxRequest } from '../../src/command-outbox.js';
import { validateIpcRequest, validateIpcResponseForCommand } from '../../src/validator.js';
import { isLocalMetadataAnnotations } from '../../src/local-catalog.js';
import { organizerPlanFixture } from './fixture.js';

test('011闭集目标和patch拒getter/symbol/稀疏数组/任意源路径，保持零getter调用', () => {
  const request = { commandId: randomUUID(), scope: 'MB_ONLY', target: { mode: 'batch', trackIds: [randomUUID()] }, patch: { fields: { title: { action: 'set', value: '仅MB' } } } };
  assert.equal(isLocalOrganizerCommandPayload('localOrganizer.preview', request), true);
  let calls = 0; const getter = { ...request }; Object.defineProperty(getter, 'patch', { enumerable: true, get() { calls++; return request.patch; } });
  for (const bad of [getter, { ...request, absolutePath: '/禁止路径' }, { ...request, [Symbol('隐藏')]: 1 }, { ...request, target: { mode: 'batch', trackIds: new Array(2) } }, { ...request, patch: { fields: { artists: { action: 'set', value: ['不扁平化'] } } } }]) assert.equal(isLocalOrganizerCommandPayload('localOrganizer.preview', bad), false);
  assert.equal(calls, 0);
  assert.equal(isLocalOrganizerCommandPayload('localOrganizer.preview', { ...request, target: { mode: 'batch', trackIds: Array.from({ length: 101 }, () => randomUUID()) } }), false);
  assert.equal(isLocalOrganizerCommandPayload('localOrganizer.preview', { ...request, target: { mode: 'batch', trackIds: [request.target.trackIds[0], request.target.trackIds[0]] } }), false);
});
test('011冻结body精确六键/operation九键，目标和非空patch遵守原语义', () => {
  const p = organizerPlanFixture(); assert.equal(isLocalOrganizerPlan(p), true); assert.equal(isOrganizerFrozenBody(p.body), true);
  assert.equal(isOrganizerFrozenBody({ ...p.body, datasetId: p.datasetId }), false);
  assert.equal(isOrganizerFrozenBody({ ...p.body, conflicts: [null] }), false);
  assert.equal(isOrganizerFrozenBody({ ...p.body, created_at: '2024-02-29T00:00:00.000Z' }), true);
  const boundaries = [
    { name: '空冲突串', body: { ...p.body, conflicts: [''] } },
    { name: '非闰年2月29日', body: { ...p.body, created_at: '2026-02-29T00:00:00.000Z' } },
    { name: '2月31日', body: { ...p.body, created_at: '2026-02-31T00:00:00.000Z' } },
  ];
  // 一次计算所有守卫结果，RED能同时显示三个独立无效输入被误接纳。
  assert.deepEqual(boundaries.map(({ name, body }) => ({ name, accepted: isOrganizerFrozenBody(body) })), boundaries.map(({ name }) => ({ name, accepted: false })));
  assert.equal(isOrganizerFrozenOperation({ ...p.items[0]!.operation, field_patch: {} }), false);
  assert.equal(isOrganizerFrozenOperation({ ...p.items[0]!.operation, kind: 'MOVE', backup_required: true }), false);
  assert.equal(isOrganizerFrozenOperation({ ...p.items[0]!.operation, kind: 'MOVE', target_relative_path: '合成/新名.wav', backup_required: true, field_patch: {} }), true);
  let calls = 0; assert.equal(isLocalOrganizerPlan({ ...p, state: { toString() { calls++; return 'DRAFT'; } } }), false); assert.equal(calls, 0);
});
test('011确认与撤销接原outbox，并强制可信dataset范围', () => {
  const p = organizerPlanFixture(), payload = { commandId: randomUUID(), planId: p.planId, expectedRevision: '1', scope: p.scope, planHash: p.planHash, contextFingerprint: p.contextFingerprint };
  assert.equal(isCommandOutboxRequest({ datasetId: p.datasetId, command: 'localOrganizer.confirm', payload }), true);
  assert.equal(isCommandOutboxRequest({ datasetId: p.datasetId, command: 'localOrganizer.undo', payload: { commandId: randomUUID(), planId: p.planId, expectedRevision: '1' } }), true);
  assert.equal(isCommandOutboxRequest({ datasetId: p.datasetId, command: 'localOrganizer.preview', payload }), false);
  const envelope = { version: 1, id: randomUUID(), command: 'localOrganizer.confirm', payload };
  assert.equal(validateIpcRequest(envelope).ok, false); assert.equal(validateIpcRequest({ ...envelope, expectedDatasetId: p.datasetId }).ok, true);
  assert.equal(validateIpcResponseForCommand({ version: 1, id: envelope.id, ok: true, result: p }, 'localOrganizer.confirm').ok, true);
});
test('011注记仅typed MB overlay，分组引用明确版本且无重复，plan仍有字节预算', () => {
  const editionId = randomUUID(); assert.equal(isLocalMetadataAnnotations({ versionDescription: '人工版本说明', groupingSuggestions: [{ editionId, expectedRevision: '1', reason: '人工建议' }] }), true);
  assert.equal(isLocalMetadataAnnotations({ groupingSuggestions: [{ editionId, expectedRevision: '1', reason: '重复' }, { editionId, expectedRevision: '1', reason: '重复' }] }), false);
  assert.equal(isLocalMetadataAnnotations({ edition_note: '冻结字段不是overlay DTO' }), false);
  const p = organizerPlanFixture(); p.items[0]!.after.fields.title = 'x'.repeat(5000); assert.equal(isLocalOrganizerPlan(p), false);
});
