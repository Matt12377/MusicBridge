import assert from 'node:assert/strict';
import test from 'node:test';
import * as c from '../../src/index.js';
import { id, plan, preview } from './fixtures.js';
const uuid = (index: number): string => `${index.toString(16).padStart(8, '0')}-1111-4111-8111-111111111111`;

test('012 正确处理100目标边界、重复身份及每计划整体2MiB而非逐项乘积', () => {
  const hundred = Array.from({ length: 100 }, (_, index) => uuid(index + 1));
  const request = { ...preview(), intent: { ...preview().intent, target: { mode: 'batch', trackIds: hundred } } };
  assert.equal(c.isLocalSourceWritesCommandPayload('localSourceWrites.preview', request), true);
  assert.equal(c.isLocalSourceWritesCommandPayload('localSourceWrites.preview', { ...request, intent: { ...request.intent, target: { mode: 'batch', trackIds: [...hundred, uuid(101)] } } }), false);
  assert.equal(c.isLocalSourceWritesCommandPayload('localSourceWrites.preview', { ...request, intent: { ...request.intent, target: { mode: 'batch', trackIds: [id, id] } } }), false);
  const large = plan(), first = large.items[0]!;
  large.items = hundred.map(operationId => ({ ...structuredClone(first), operationId, resourceRef: operationId, trackId: operationId, assetId: operationId, changes: [{ field: 'title', action: 'set', before: Array.from({ length: 32 }, () => '中'.repeat(512)), after: ['新标题'] }] }));
  large.resourceSummary.resources = 400; large.resourceSummary.sharedTargets = 100;
  assert.ok(Buffer.byteLength(JSON.stringify(large), 'utf8') > 2097152);
  assert.equal(c.isLocalSourceWritesPlan(large), false);
});

test('012 字节/描述符预算在规范化前生效；深度/键数/数组/节点不可绕过', () => {
  assert.throws(() => c.localSourceWritesDataSnapshot({ text: 'x'.repeat(2097152) }));
  assert.throws(() => c.localSourceWritesDataSnapshot(Object.fromEntries(Array.from({ length: 33 }, (_, index) => [`key${index}`, true]))));
  assert.throws(() => c.localSourceWritesDataSnapshot(new Array(101).fill(null)));
  assert.throws(() => c.localSourceWritesDataSnapshot([1, 2, 3], 100, 2));
  let deep: unknown = '叶子'; for (let index = 0; index < 14; index++) deep = { nested: deep };
  assert.throws(() => c.localSourceWritesDataSnapshot(deep));
  const hidden = [id]; Object.defineProperty(hidden, 'grant', { value: true }); assert.throws(() => c.localSourceWritesDataSnapshot(hidden));
  for (const limit of [0, -1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => c.localSourceWritesDataSnapshot({}, limit));
  assert.throws(() => c.localSourceWritesDataSnapshot({}, 2097153));
  assert.throws(() => c.localSourceWritesDataSnapshot({}, 100, 65537));
  assert.throws(() => c.localSourceWritesDataSnapshot({}, 100, 100, 2049));
  assert.throws(() => c.localSourceWritesDataSnapshot({}, 100, 100, 100, 101));
});

test('012 journal 64KiB/16KiB限制覆盖所有TEXT，计入原指纹/事件编号/时间', () => {
  const base = { command_id: id, fingerprint: 'a'.repeat(64), operation: 'source-writes-journal-v1', request: '', result: '{"accepted":true}', created_at: '2026-10-08T00:00:00.000Z' };
  const overhead = Object.values(base).reduce((bytes, value) => bytes + Buffer.byteLength(value, 'utf8'), 0);
  for (const [kind, maximum] of [['header', 65536], ['item', 65536], ['phase', 16384]] as const) {
    const exact = { ...base, request: 'x'.repeat(maximum - overhead) };
    assert.equal(c.localSourceWritesJournalTextWithinBudget(exact, kind), true);
    assert.equal(c.localSourceWritesJournalTextWithinBudget({ ...exact, request: `${exact.request}x` }, kind), false);
    assert.equal(c.localSourceWritesJournalTextWithinBudget({ ...exact, result: `${exact.result}中` }, kind), false);
  }
  assert.equal(c.localSourceWritesJournalTextWithinBudget({ ...base, request: 'x'.repeat(65536) }, 'item'), false);
});

test('012 新事件/终结预留与原图留存/I/O上限独立，不放宽旧Outbox', () => {
  const limits = c.LOCAL_SOURCE_WRITES_BUDGET;
  assert.equal(limits.phaseEventsPerOperation, 32); assert.equal(limits.phaseEventsPerPlan, 4096);
  assert.equal(limits.terminalReservedEventsPerOperation, 4); assert.equal(limits.terminalReservedEventsPerPlan, 16);
  assert.ok(limits.phaseEventsPerOperation * limits.operations + limits.terminalReservedEventsPerPlan <= limits.phaseEventsPerPlan);
  assert.equal(limits.journalProjectionBytes, 67108864); assert.equal(limits.retainedOriginalBytes, 67108864); assert.equal(limits.retainedOriginalCount, 128);
  assert.equal(limits.sourceFileBytes, 268435456); assert.equal(limits.tagRegionBytes, 8388608); assert.equal(limits.tagParts, 4096);
  assert.equal(limits.planPayloadIoBytes, 2147483648); assert.equal(limits.safetyRepositoryBytes, 2147483648);
  assert.equal(c.MAX_COMMAND_OUTBOX_PAYLOAD_BYTES, 2097152); assert.equal(c.MAX_COMMAND_OUTBOX_ENTRIES, 1000); assert.equal(c.MAX_COMMAND_OUTBOX_TOTAL_BYTES, 67108864);
});

test('012 history 分页范围、cursor 与快照闭集，无任意路径查询', () => {
  const request = { datasetId: id, selector: { kind: 'plans', range: 'all' }, cursor: null, limit: 100 };
  assert.equal(c.isLocalSourceWritesCommandPayload('localSourceWrites.history', request), true);
  for (const change of [{ limit: 101 }, { limit: -0 }, { cursor: 'x'.repeat(513) }, { selector: { kind: 'path', path: '秘密路径' } }]) assert.equal(c.isLocalSourceWritesCommandPayload('localSourceWrites.history', { ...request, ...change }), false);
  const page = { datasetId: id, kind: 'plans', range: 'all', snapshotFingerprint: 'a'.repeat(64), limit: 20, items: [], cursor: null, hasMore: false };
  assert.equal(c.isLocalSourceWritesCommandResult('localSourceWrites.history', page), true);
  assert.equal(c.isLocalSourceWritesCommandResult('localSourceWrites.history', { ...page, hasMore: true }), false);
});

test('012 私有原正文/context/公开投影共同限额且操作映射保持原六键九键', () => {
  const projection = plan();
  const body: c.OrganizerFrozenBody = { created_at: projection.readyAt!, scope: 'SOURCE_FILES', operations: [{ operation_id: id, kind: 'WRITE_TAGS', root_id: id, target_asset_id: id, expected_asset_revision: '1', source_relative_path: '合成.flac', target_relative_path: null, field_patch: { title: '合成标题' }, backup_required: true }], root_mapping_revisions: { [id]: '1' }, conflicts: [], resource_guards: { require_exclusive_asset_lock: true, defer_if_read_lease: true, protect_frozen_sources: true, recheck_at_execution: true } };
  const capture = { body, context: { datasetId: id, resources: [id] }, projection };
  assert.equal(c.localSourceWritesCompletePlanWithinBudget(capture), true);
  assert.equal(c.localSourceWritesCompletePlanWithinBudget({ ...capture, context: { text: 'x'.repeat(2097152) } }), false);
  assert.equal(c.localSourceWritesCompletePlanWithinBudget({ ...capture, body: { ...body, operations: [{ ...body.operations[0], field_patch: { title: '其他字段值' } }] } }), false);
  assert.equal(c.localSourceWritesCompletePlanWithinBudget({ ...capture, body: { ...body, operations: [{ ...body.operations[0], kind: 'MOVE', target_relative_path: '移后.flac' }] } }), false);
});

test('012 联合捕获保留原 body 的 100 根映射容量，公开纯记录仍有独立 32 键预算', () => {
  const projection = plan(), first = projection.items[0]!, roots = Array.from({ length: 100 }, (_, index) => uuid(index + 1));
  projection.items = roots.map(root => ({ ...structuredClone(first), operationId: root, resourceRef: root, trackId: root, assetId: root }));
  projection.resourceSummary.resources = 400; projection.resourceSummary.sharedTargets = 100;
  const body: c.OrganizerFrozenBody = { created_at: projection.readyAt!, scope: 'SOURCE_FILES', operations: roots.map(root => ({ operation_id: root, kind: 'WRITE_TAGS', root_id: root, target_asset_id: root, expected_asset_revision: '1', source_relative_path: '合成.flac', target_relative_path: null, field_patch: { title: '合成标题' }, backup_required: true })), root_mapping_revisions: Object.fromEntries(roots.map(root => [root, '1'])), conflicts: [], resource_guards: { require_exclusive_asset_lock: true, defer_if_read_lease: true, protect_frozen_sources: true, recheck_at_execution: true } };
  assert.equal(c.isOrganizerFrozenBody(body), true);
  assert.equal(c.localSourceWritesCompletePlanWithinBudget({ body, context: { resources: roots }, projection }), true);
  assert.equal(c.localSourceWritesCompletePlanWithinBudget({ body: { ...body, root_mapping_revisions: { ...body.root_mapping_revisions, [uuid(101)]: '1' } }, context: {}, projection }), false);
  assert.throws(() => c.localSourceWritesDataSnapshot(body.root_mapping_revisions));
});
