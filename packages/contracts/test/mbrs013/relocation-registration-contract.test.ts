import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as c from '../../src/index.js';
import { id, hash, confirm, cleanup, receipt, selection } from './fixtures.js';
import { confirm as confirm012, id as dataset012 } from '../mbrs012/fixtures.js';

const payloads: c.LocalRelocationPlanCommandPayloads = {
  'localRelocationPlan.chooseTarget': { datasetId: id(1), commandId: id(2), kind: 'directory' },
  'localRelocationPlan.preview': { datasetId: id(1), commandId: id(2), intent: { kind: 'rename', target: selection(), newName: '新曲.flac', sourceDisposition: 'RETAIN' } },
  'localRelocationPlan.confirm': confirm(), 'localRelocationPlan.cleanup': cleanup(),
  'localRelocationPlan.cancel': { datasetId: id(1), commandId: id(2), planId: id(3), expectedViewRevision: '1' },
  'localRelocationPlan.setPolicy': { datasetId: id(1), commandId: id(2), expectedPolicyRevision: '1', enabled: false },
  'localRelocationPlan.get': { datasetId: id(1), selector: { kind: 'command', commandId: id(2), expectedCommand: 'localRelocationPlan.confirm', requestFingerprint: hash(6) } },
  'localRelocationPlan.history': { datasetId: id(1), selector: { kind: 'plans' }, cursor: null, limit: 10 },
};
const envelope = <C extends c.LocalRelocationPlanCommand>(command: C) => ({ version: 1, id: id(60), command, payload: payloads[command], expectedDatasetId: id(1) });

test('013 公开注册恰好八条；私有 Main 五条未进入普通或 internal IPC', () => {
  const registered = c.IPC_COMMANDS.filter(command => command.startsWith('localRelocationPlan.'));
  assert.deepEqual(registered, [...c.LOCAL_RELOCATION_PLAN_COMMANDS]);
  assert.equal(new Set(registered).size, registered.length);
  for (const command of c.LOCAL_RELOCATION_MAIN_COMMANDS) {
    assert.equal((c.IPC_COMMANDS as readonly string[]).includes(command), false, command);
    const raw = { version: 1, id: id(60), command, payload: { datasetId: id(1), confirm: confirm() }, expectedDatasetId: id(1) };
    assert.equal(c.validateIpcRequest(raw).ok, false, command);
    assert.equal(c.validateIpcInternalRequest(raw).ok, false, command);
  }
  assert.equal(c.validateIpcRequest({ ...envelope('localRelocationPlan.confirm'), command: 'localRelocationPlan.executeGranted' }).ok, false);
});

test('八条请求 expectedDatasetId 必填并与捕获 payload.datasetId 相同', () => {
  for (const command of c.LOCAL_RELOCATION_PLAN_COMMANDS) {
    const request = envelope(command);
    assert.equal(c.validateIpcRequest(request).ok, true, command);
    assert.equal(c.validateIpcRequest({ ...request, expectedDatasetId: id(99) }).ok, false, command);
    assert.equal(c.validateIpcRequest({ ...request, expectedDatasetId: 'not-a-dataset' }).ok, false, command);
    const { expectedDatasetId: _scope, ...unscoped } = request;
    assert.equal(c.validateIpcRequest(unscoped).ok, false, command);
    assert.equal(c.validateIpcRequest({ ...request, payload: { ...request.payload, datasetId: id(99) } }).ok, false, command);
    assert.equal(c.validateIpcRequest({ ...request, payload: { ...request.payload, datasetId: 'not-a-dataset' }, expectedDatasetId: 'not-a-dataset' }).ok, false, command);
  }
});

test('013 信封全量捕获且闭键；getter/command 变换/隐藏字段都不能进入新域', () => {
  const request = envelope('localRelocationPlan.confirm');
  for (const key of ['version', 'id', 'command', 'payload', 'expectedDatasetId'] as const) {
    let reads = 0; const input = { ...request };
    Object.defineProperty(input, key, { enumerable: true, get() { reads++; return request[key]; } });
    assert.equal(c.validateIpcRequest(input).ok, false, key); assert.equal(reads, 0, key);
  }
  for (const key of ['actor', 'grant', 'fd', 'absolutePath', 'readFacts', 'readContext', 'target_root_id']) assert.equal(c.validateIpcRequest({ ...request, [key]: key === 'readContext' ? { deadlineAtMs: 1 } : id(9) }).ok, false, key);
  const hidden = { ...request }; Object.defineProperty(hidden, 'actor', { value: id(9), enumerable: false });
  assert.equal(c.validateIpcRequest(hidden).ok, false);
  assert.equal(c.validateIpcRequest({ ...request, [Symbol('能力')]: id(9) }).ok, false);
  let descriptors = 0;
  const changed = new Proxy(request, { getOwnPropertyDescriptor(target, key) {
    return key === 'command' ? { enumerable: true, configurable: true, value: ++descriptors === 1 ? target.command : 'localRelocationPlan.cleanup' } : Reflect.getOwnPropertyDescriptor(target, key);
  } });
  assert.equal(c.validateIpcRequest(changed).ok, false);
  const trap = new Proxy(request, { getOwnPropertyDescriptor() { throw new Error('合成捕获失败'); } });
  assert.doesNotThrow(() => assert.equal(c.validateIpcRequest(trap).ok, false));
});

test('generic Outbox 名称、request/result/execute 对公开与私有 013 均拒绝', () => {
  for (const command of c.LOCAL_RELOCATION_PLAN_COMMANDS) {
    const payload = payloads[command];
    assert.equal(c.isCommandOutboxCommand(command), false, command);
    assert.equal(c.isCommandOutboxTrackedCommand(command), false, command);
    const request = { datasetId: id(1), command, payload };
    assert.equal(c.isCommandOutboxRequest(request), false, command);
    assert.equal(c.isCommandOutboxExecute(request), false, command);
    assert.equal(c.isCommandOutboxResult({ command, result: receipt() }), false, command);
    assert.equal(c.validateIpcRequest({ version: 1, id: id(60), command: 'commandOutbox.execute', payload: request, expectedDatasetId: id(1) }).ok, false, command);
  }
  for (const command of c.LOCAL_RELOCATION_MAIN_COMMANDS) assert.equal(c.isCommandOutboxRequest({ datasetId: id(1), command, payload: { commandId: id(2) } }), false, command);
});

test('013 响应捕获返回闭键结果，getter/隐藏路径/跨命令 receipt 拒绝', () => {
  const response = { version: 1, id: id(60), ok: true, result: receipt() };
  assert.equal(c.validateIpcResponseForCommand(response, 'localRelocationPlan.confirm').ok, true);
  assert.equal(c.validateIpcResponseForCommand(response, 'localRelocationPlan.cleanup').ok, false);
  for (const key of ['id', 'ok', 'result'] as const) {
    let reads = 0; const input = { ...response };
    Object.defineProperty(input, key, { enumerable: true, get() { reads++; return response[key]; } });
    assert.equal(c.validateIpcResponseForCommand(input, 'localRelocationPlan.confirm').ok, false, key); assert.equal(reads, 0, key);
  }
  const hidden = { ...response }; Object.defineProperty(hidden, 'absolutePath', { value: '/synthetic/private', enumerable: false });
  assert.equal(c.validateIpcResponseForCommand(hidden, 'localRelocationPlan.confirm').ok, false);
  assert.equal(c.validateIpcResponseForCommand({ ...response, result: { ...response.result, path: '/synthetic/private' } }, 'localRelocationPlan.confirm').ok, false);
});

test('013 success/failure 信封必须互斥；不能把另一分支字段静默忽略', () => {
  const success = { version: 1, id: id(60), ok: true, result: receipt() };
  const failure = { version: 1, id: id(60), ok: false, error: { code: 'NOT_READY', message: '计划尚未就绪' } };
  assert.equal(c.validateIpcResponseForCommand(success, 'localRelocationPlan.confirm').ok, true);
  assert.equal(c.validateIpcResponseForCommand(failure, 'localRelocationPlan.confirm').ok, true);
  assert.equal(c.validateIpcResponseForCommand({ ...success, error: failure.error }, 'localRelocationPlan.confirm').ok, false);
  assert.equal(c.validateIpcResponseForCommand({ ...failure, result: receipt() }, 'localRelocationPlan.confirm').ok, false);
  assert.equal(c.validateIpcResponseForCommand({ ...success, result: undefined }, 'localRelocationPlan.confirm').ok, false);
});

test('原五命令及012 request/snapshot/Outbox 正向控制保持独立', () => {
  assert.deepEqual(c.LOCAL_RELOCATION_COMMANDS, ['localRelocation.roots', 'localRelocation.registerRoot', 'localRelocation.capture', 'localRelocation.confirm', 'localRelocation.relinkRoot']);
  for (const command of c.LOCAL_RELOCATION_COMMANDS) assert.equal((c.IPC_COMMANDS as readonly string[]).includes(command), true, command);
  const original = { version: 1, id: id(60), command: 'localSourceWrites.confirm', payload: confirm012(), expectedDatasetId: dataset012 };
  assert.equal(c.validateIpcRequest(original).ok, true);
  assert.equal(c.validateIpcRequest({ ...original, expectedDatasetId: id(99) }).ok, false);
  assert.equal(c.isCommandOutboxExecute({ datasetId: dataset012, command: 'localSourceWrites.confirm', payload: confirm012() }), true);
  assert.equal(c.isLocalRelocationPlanCommandPayload('localRelocationPlan.confirm', confirm012()), false);
  assert.equal(c.isLocalSourceWritesCommandPayload('localSourceWrites.confirm', confirm()), false);
  assert.equal(c.LOCAL_SOURCE_WRITES_BUDGET.requestBytes, 65_536);
  assert.equal(c.LOCAL_SOURCE_WRITES_BUDGET.planBytes, 2_097_152);
});
