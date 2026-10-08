import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  LOCAL_RELOCATION_PLAN_BUDGET, LOCAL_RELOCATION_PLAN_COMMANDS, LOCAL_RELOCATION_PLAN_DEFAULT_POLICY,
  isLocalRelocationPlanCommandPayload, isLocalRelocationPlanCommandResult, isLocalRelocationPlan,
  isLocalRelocationPlanIssue, localRelocationDataSnapshot, localRelocationCanonical,
  localRelocationRequestFingerprintInput, localRelocationPlanHashInput, localRelocationContextFingerprintInput,
  localRelocationCompletePlanWithinBudget, localRelocationPlanCommandSnapshot,
} from '../../src/local-relocation-plan.js';
import { id, hash, plan, confirm, cleanup, receipt, selection, frozenBody, frozenContext } from './fixtures.js';

const utf8 = (value: string): number => new TextEncoder().encode(value).byteLength;
const sha = (value: string): string => createHash('sha256').update(value).digest('hex');
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

test('013 独立八命令与 G0 预算；默认关闭不冒充资格', () => {
  assert.equal(LOCAL_RELOCATION_PLAN_COMMANDS.length, 8);
  assert.equal(LOCAL_RELOCATION_PLAN_COMMANDS.every(command => command.startsWith('localRelocationPlan.')), true);
  assert.deepEqual(LOCAL_RELOCATION_PLAN_DEFAULT_POLICY, { enabled: false, revision: '1', draining: false });
  assert.equal(LOCAL_RELOCATION_PLAN_BUDGET.requestUtf8Bytes, 4_194_304);
  assert.equal(LOCAL_RELOCATION_PLAN_BUDGET.completePlanBodyContextBytes, 4_194_304);
  assert.equal(LOCAL_RELOCATION_PLAN_BUDGET.operations, 100);
  assert.equal(LOCAL_RELOCATION_PLAN_BUDGET.closedResources, 256);
  assert.equal(LOCAL_RELOCATION_PLAN_BUDGET.referenceEdges, 512);
  assert.equal(LOCAL_RELOCATION_PLAN_BUDGET.sourceAndTargetRoots, 16);
  assert.equal(LOCAL_RELOCATION_PLAN_BUDGET.runtimeDeadlineMs, 1_800_000);
});

test('公开请求只含稳定 ID 与版本；拒路径、actor、FD、grant 与 Scanner 事实', () => {
  const request = { datasetId: id(1), commandId: id(2), intent: { kind: 'move', targets: [selection()], targetChoiceId: id(40), sourceDisposition: 'RETAIN' } };
  assert.equal(isLocalRelocationPlanCommandPayload('localRelocationPlan.preview', request), true);
  for (const key of ['path', 'absolutePath', 'target_root_id', 'actor', 'grant', 'fd', 'scanBefore', 'scanAfter', 'readFacts', 'jobId', 'batchId']) {
    assert.equal(isLocalRelocationPlanCommandPayload('localRelocationPlan.preview', { ...request, [key]: id(9) }), false, key);
    assert.equal(isLocalRelocationPlanCommandPayload('localRelocationPlan.confirm', { ...confirm(), [key]: id(9) }), false, key);
  }
  assert.equal(isLocalRelocationPlanCommandPayload('localRelocationPlan.chooseTarget', { datasetId: id(1), commandId: id(2), kind: 'directory' }), true);
  assert.equal(isLocalRelocationPlanCommandPayload('localRelocationPlan.chooseTarget', { datasetId: id(1), commandId: id(2), kind: 'directory', absolutePath: '/private/library' }), false);
});

test('rename basename 原 Unicode 保留；控制、路径、dot traversal 与重复资产拒绝', () => {
  const request = (name: string) => ({ datasetId: id(1), commandId: id(2), intent: { kind: 'rename', target: selection(), newName: name, sourceDisposition: 'RETAIN' } });
  for (const name of ['é.flac', 'e\u0301.flac', '音樂😀.flac', 'A.FLAC']) assert.equal(isLocalRelocationPlanCommandPayload('localRelocationPlan.preview', request(name)), true, name);
  for (const name of ['', '.', '..', '../a.flac', 'a/b.flac', 'a\\b.flac', '/a.flac', 'file:a.flac', '\u0000.flac', '\ud800.flac']) assert.equal(isLocalRelocationPlanCommandPayload('localRelocationPlan.preview', request(name)), false);
  const duplicate = { datasetId: id(1), commandId: id(2), intent: { kind: 'move', targets: [selection(), selection()], targetChoiceId: id(40), sourceDisposition: 'RETAIN' } };
  assert.equal(isLocalRelocationPlanCommandPayload('localRelocationPlan.preview', duplicate), false);
  for (const count of [99, 100, 101]) {
    const targets = Array.from({ length: count }, (_, index) => ({ ...selection(), assetId: id(100 + index) }));
    assert.equal(isLocalRelocationPlanCommandPayload('localRelocationPlan.preview', { ...duplicate, intent: { ...duplicate.intent, targets } }), count <= 100);
  }
});

test('具体 confirm 与二次 cleanup 闭键分域；旧 012 不取得 013 权限', () => {
  assert.equal(isLocalRelocationPlanCommandPayload('localRelocationPlan.confirm', confirm()), true);
  assert.equal(isLocalRelocationPlanCommandPayload('localRelocationPlan.cleanup', cleanup()), true);
  assert.equal(isLocalRelocationPlanCommandPayload('localRelocationPlan.confirm', cleanup()), false);
  assert.equal(isLocalRelocationPlanCommandPayload('localRelocationPlan.cleanup', confirm()), false);
  assert.equal(isLocalRelocationPlanCommandPayload('localRelocationPlan.confirm', { ...confirm(), domain: 'LOCAL_SOURCE_WRITES_V1' }), false);
  assert.equal(isLocalRelocationPlanCommandPayload('localRelocationPlan.cleanup', { ...cleanup(), sourceResourceIds: [] }), false);
  assert.equal(isLocalRelocationPlanCommandPayload('localRelocationPlan.cleanup', { ...cleanup(), sourceResourceIds: [id(20), id(20)] }), false);
  assert.equal(isLocalRelocationPlanCommandPayload('localRelocationPlan.confirm', { datasetId: id(1), commandId: id(2), planId: id(3), expectedViewRevision: '1', scope: 'SOURCE_FILES', range: 'single-tags', planHash: hash(1), contextFingerprint: hash(2) }), false);
});

test('描述符捕获不执行 getter/toJSON/iterator；捕获后原对象变更不改授权输入', () => {
  let calls = 0;
  const input = { ...confirm(), get grant() { calls++; return hash(2); } };
  assert.throws(() => localRelocationPlanCommandSnapshot('localRelocationPlan.confirm', input));
  assert.equal(calls, 0);
  const toJSON = { ...confirm(), toJSON() { calls++; return confirm(); } };
  assert.throws(() => localRelocationDataSnapshot(toJSON));
  const iterator = { ...confirm(), [Symbol.iterator]() { calls++; return [][Symbol.iterator](); } };
  assert.throws(() => localRelocationDataSnapshot(iterator));
  assert.equal(calls, 0);
  const original = confirm(); const snapshot = localRelocationPlanCommandSnapshot('localRelocationPlan.confirm', original);
  original.planHash = hash(9); assert.equal(snapshot.planHash, hash(1)); assert.equal(Object.isFrozen(snapshot), true);
  const hidden = { ...confirm() }; Object.defineProperty(hidden, 'owner', { value: id(9), enumerable: false });
  assert.throws(() => localRelocationDataSnapshot(hidden));
  const sparse = new Array(2); sparse[1] = null;
  assert.throws(() => localRelocationDataSnapshot(sparse));
  const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
  assert.throws(() => localRelocationDataSnapshot(cyclic));
  for (const value of [undefined, NaN, Infinity, -0, 1.5, 1n, new Date(), new Map(), new Uint8Array([1])]) assert.throws(() => localRelocationDataSnapshot(value));
});

test('JSON 精确 escaped UTF8 预算 B-1/B/B+1，文本、节点和深度独立计数', () => {
  for (const value of [{ '\u0001': '\n"\\😀é' }, ['é', 'e\u0301', '😀', true, null], { x: '\u0000'.repeat(15) }]) {
    const actual = utf8(localRelocationCanonical(value));
    assert.throws(() => localRelocationDataSnapshot(value, { maxBytes: actual - 1 }));
    assert.doesNotThrow(() => localRelocationDataSnapshot(value, { maxBytes: actual }));
    assert.doesNotThrow(() => localRelocationDataSnapshot(value, { maxBytes: actual + 1 }));
  }
  assert.throws(() => localRelocationDataSnapshot({ é: '😀' }, { maxTextBytes: 5 }));
  assert.doesNotThrow(() => localRelocationDataSnapshot({ é: '😀' }, { maxTextBytes: 6 }));
  assert.doesNotThrow(() => localRelocationDataSnapshot({ é: '😀' }, { maxTextBytes: 7 }));
  assert.throws(() => localRelocationDataSnapshot([null, null], { maxNodes: 2 }));
  assert.doesNotThrow(() => localRelocationDataSnapshot([null, null], { maxNodes: 3 }));
  assert.doesNotThrow(() => localRelocationDataSnapshot([null, null], { maxNodes: 4 }));
  const nested = (depth: number): unknown => { let value: unknown = 'leaf'; for (let index = 0; index < depth; index++) value = { x: value }; return value; };
  assert.doesNotThrow(() => localRelocationDataSnapshot(nested(31)));
  assert.doesNotThrow(() => localRelocationDataSnapshot(nested(32)));
  assert.throws(() => localRelocationDataSnapshot(nested(33)));
  assert.throws(() => localRelocationDataSnapshot('x', { maxBytes: 4_194_305 }));
  assert.throws(() => localRelocationDataSnapshot('x'.repeat(131_073)));
});

test('Unicode 码点 canonical 独立参考；排列同 Hash，组合与大小写不同 Hash', () => {
  const referenceCompare = (a: string, b: string): number => {
    const left = Array.from(a, character => character.codePointAt(0)!), right = Array.from(b, character => character.codePointAt(0)!);
    for (let index = 0; index < Math.min(left.length, right.length); index++) if (left[index] !== right[index]) return left[index]! - right[index]!;
    return left.length - right.length;
  };
  const keys = ['', '10', '2', '\u0001', '"', '\\', 'é', 'e\u0301', '\ue000', '😀', '😀a', '😀😀', 'A', 'a'];
  const expected = `{${[...keys].sort(referenceCompare).map(key => `${JSON.stringify(key)}:${JSON.stringify(`value:${key}`)}`).join(',')}}`;
  for (let offset = 0; offset < keys.length; offset++) {
    const rotated = [...keys.slice(offset), ...keys.slice(0, offset)];
    const object = Object.fromEntries(rotated.map(key => [key, `value:${key}`]));
    assert.equal(localRelocationCanonical(object), expected); assert.equal(sha(localRelocationCanonical(object)), sha(expected));
  }
  assert.notEqual(sha(localRelocationCanonical({ name: 'é' })), sha(localRelocationCanonical({ name: 'e\u0301' })));
  assert.notEqual(sha(localRelocationCanonical({ name: 'A' })), sha(localRelocationCanonical({ name: 'a' })));
});

test('plan/context/request 分域 Hash 输入绑定完整 body 和版本，合并预算不截断', () => {
  const body = frozenBody(), context = frozenContext();
  assert.equal(localRelocationCompletePlanWithinBudget(body, context), true);
  const requestInput = localRelocationRequestFingerprintInput('localRelocationPlan.confirm', confirm());
  assert.equal(requestInput.startsWith('LOCAL_RELOCATION_V1\nREQUEST\n'), true);
  const original = sha(localRelocationPlanHashInput(body));
  const changed = clone(body); changed.resourceClosure.resources[0]!.attributesFingerprint = hash(90);
  assert.notEqual(sha(localRelocationPlanHashInput(changed)), original);
  const changedContext = { ...context, protectionFingerprint: hash(91) };
  assert.notEqual(sha(localRelocationContextFingerprintInput(context)), sha(localRelocationContextFingerprintInput(changedContext)));
  assert.notEqual(sha(localRelocationPlanHashInput(body)), sha(localRelocationContextFingerprintInput(context)));
  assert.throws(() => localRelocationPlanHashInput({ ...body, target_root_id: id(99) }));
  assert.equal(localRelocationCompletePlanWithinBudget({ note: 'x'.repeat(70_000) }, { note: 'y'.repeat(70_000) }), false);
});

test('公开闭集索引、计数和 READY 全量语义拒伪造；Audio 不投影为引用重写', () => {
  assert.equal(isLocalRelocationPlan(plan()), true);
  const mutations: Array<(value: ReturnType<typeof plan>) => void> = [
    value => { value.closure.resourceCount = 2; }, value => { value.closure.complete = false; },
    value => { value.closure.spaceVerified = false; }, value => { value.closure.protection = 'unknown'; },
    value => { value.items[0]!.resourceIds = [id(99)]; }, value => { value.resources[0]!.operationIds = [id(99)]; },
    value => { value.resources[0]!.contentEffect = 'reference-rewritten'; }, value => { value.closure.totalSourceBytes = '1025'; },
    value => { value.resources[0]!.role = 'UNKNOWN_REFERENCE'; }, value => { value.resources.push(clone(value.resources[0]!)); value.closure.resourceCount = 2; },
  ];
  for (const mutate of mutations) { const value = plan(); mutate(value); assert.equal(isLocalRelocationPlan(value), false); }
  const extras = { ...plan(), path: '/private/library' }; assert.equal(isLocalRelocationPlan(extras), false);
});

test('VERIFIED_TARGET 不是二次 cleanup 资格；具体 cleanup 只能列已验闭集资源', () => {
  const value = plan(); value.state = 'VERIFIED_TARGET';
  value.cleanup = { state: 'eligible', verifiedTargetFingerprint: hash(3), sourceResourceIds: [id(20)], issue: null };
  assert.equal(isLocalRelocationPlan(value), false);
  value.resources[0]!.verification = 'verified-target'; value.resources[0]!.state = 'registered'; value.resources[0]!.sourceHandling = 'retained';
  assert.equal(isLocalRelocationPlan(value), false);
  value.state = 'SOURCE_RETAINED';
  assert.equal(isLocalRelocationPlan(value), true);
  value.cleanup.sourceResourceIds = [id(99)]; assert.equal(isLocalRelocationPlan(value), false);
});

test('Receipt accepted 不等完成；UNKNOWN只查询原 command/fingerprint', () => {
  assert.equal(isLocalRelocationPlanCommandResult('localRelocationPlan.confirm', receipt()), true);
  assert.equal(isLocalRelocationPlanCommandResult('localRelocationPlan.cleanup', receipt()), false);
  assert.equal(isLocalRelocationPlanCommandResult('localRelocationPlan.confirm', { ...receipt(), outcome: 'COMPLETED' }), false);
  const unknown = { code: 'COMMAND_UNKNOWN', label: '原命令结果待核对', retry: 'query-original', operationId: null, resourceId: null };
  assert.equal(isLocalRelocationPlanIssue(unknown), true);
  assert.equal(isLocalRelocationPlanIssue({ ...unknown, retry: 'repreview' }), false);
  const query = { datasetId: id(1), selector: { kind: 'command', commandId: id(2), expectedCommand: 'localRelocationPlan.confirm', requestFingerprint: hash(6) } };
  assert.equal(isLocalRelocationPlanCommandPayload('localRelocationPlan.get', query), true);
  assert.equal(isLocalRelocationPlanCommandPayload('localRelocationPlan.get', { ...query, selector: { ...query.selector, requestFingerprint: '' } }), false);
  const result = { datasetId: id(1), kind: 'command', commandId: id(2), expectedCommand: 'localRelocationPlan.confirm', requestFingerprint: hash(6), receipt: receipt(), issue: null };
  assert.equal(isLocalRelocationPlanCommandResult('localRelocationPlan.get', result), true);
  assert.equal(isLocalRelocationPlanCommandResult('localRelocationPlan.get', { ...result, requestFingerprint: hash(99) }), false);
});

test('公开 Choice/Issue 不泄路径，分页完整游标与计划事件匹配', () => {
  assert.equal(isLocalRelocationPlanCommandResult('localRelocationPlan.chooseTarget', null), true);
  assert.equal(isLocalRelocationPlanCommandResult('localRelocationPlan.chooseTarget', { choiceId: id(40), kind: 'directory', label: '/private/library', expiresAt: '2026-10-08T10:30:00.000Z' }), false);
  const result = { datasetId: id(1), kind: 'events', planId: id(3), snapshotFingerprint: hash(1), limit: 1, items: [{ eventId: id(50), planId: id(3), journalSequence: '1', operationId: id(11), resourceId: id(20), phase: 'PLANNED', occurredAt: '2026-10-08T10:00:00.000Z', label: '计划已登记', issue: null }], cursor: null, hasMore: false };
  assert.equal(isLocalRelocationPlanCommandResult('localRelocationPlan.history', result), true);
  assert.equal(isLocalRelocationPlanCommandResult('localRelocationPlan.history', { ...result, cursor: id(51) }), false);
  assert.equal(isLocalRelocationPlanCommandResult('localRelocationPlan.history', { ...result, items: [{ ...result.items[0]!, planId: id(99) }] }), false);
});

test('公开完整资源/边/根 B-1/B/B+1；闭集计数不截断', () => {
  for (const count of [255, 256, 257]) {
    const value = plan(); const original = value.resources[0]!;
    value.resources = Array.from({ length: count }, (_, index) => ({ ...clone(original), resourceId: id(200 + index), role: index === 0 ? 'AUDIO' as const : 'IMAGE' as const, bytes: '1', label: `资源${index}` }));
    value.items[0]!.resourceIds = value.resources.map(resource => resource.resourceId);
    value.closure.resourceCount = count; value.closure.totalSourceBytes = String(count);
    assert.equal(isLocalRelocationPlan(value), count <= 256);
    assert.equal(isLocalRelocationPlanCommandPayload('localRelocationPlan.cleanup', { ...cleanup(), sourceResourceIds: value.resources.map(resource => resource.resourceId) }), count <= 256);
  }
  for (const count of [511, 512, 513]) {
    const value = plan(); value.resources.push({ ...clone(value.resources[0]!), resourceId: id(21), role: 'CUE', label: '曲目单' });
    value.items[0]!.resourceIds.push(id(21)); value.closure.resourceCount = 2; value.closure.totalSourceBytes = '2048';
    value.referenceEdges = Array.from({ length: count }, (_, index) => ({ edgeId: id(1000 + index), fromResourceId: id(21), toResourceId: id(20), kind: 'CUE_AUDIO' as const, shared: false }));
    value.closure.referenceEdgeCount = count; assert.equal(isLocalRelocationPlan(value), count <= 512);
  }
  for (const count of [15, 16, 17]) { const value = plan(); value.closure.rootCount = count; assert.equal(isLocalRelocationPlan(value), count <= 16); }
});
