import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import * as c from '../../src/index.js';
import { confirm, context, hash, id, other, plan, preview, receipt } from './fixtures.js';

test('012 七方法/三 Outbox 闭集，私有源能力不进入普通 IPC', () => {
  assert.deepEqual(c.LOCAL_SOURCE_WRITES_COMMANDS, ['localSourceWrites.preview', 'localSourceWrites.get', 'localSourceWrites.history', 'localSourceWrites.confirm', 'localSourceWrites.undo', 'localSourceWrites.cancel', 'localSourceWrites.setPolicy']);
  assert.deepEqual(c.LOCAL_SOURCE_WRITES_OUTBOX_COMMANDS, ['localSourceWrites.setPolicy', 'localSourceWrites.confirm', 'localSourceWrites.undo']);
  for (const command of c.LOCAL_SOURCE_WRITES_COMMANDS) assert.ok((c.IPC_COMMANDS as readonly string[]).includes(command));
  for (const command of c.LOCAL_SOURCE_WRITES_PRIVATE_COMMANDS) {
    assert.equal((c.IPC_COMMANDS as readonly string[]).includes(command), false);
    assert.equal(c.validateIpcInternalRequest({ version: c.IPC_VERSION, id, command, payload: {}, expectedDatasetId: id }).ok, false);
  }
  assert.equal((c.COMMAND_OUTBOX_COMMANDS as readonly string[]).includes('localSourceWrites.cancel'), false);
  assert.equal(c.isCommandOutboxRequest({ datasetId: id, command: 'localSourceWrites.preview', payload: preview() }), false);
});

test('012 原始描述符：getter/toJSON/symbol/隐藏键/非纯原型/稀疏/环零求值拒绝', () => {
  let reads = 0;
  const getter = preview(); Object.defineProperty(getter, 'intent', { enumerable: true, get: () => { reads++; return preview().intent; } });
  const toJSON = preview(); Object.defineProperty(toJSON, 'toJSON', { enumerable: true, value: () => { reads++; return preview(); } });
  const hidden = preview(); Object.defineProperty(hidden, 'grant', { value: true });
  const cycle: Record<string, unknown> = { ...preview() }; cycle.intent = cycle;
  const sparse = preview(); sparse.intent = { kind: 'tags', target: { mode: 'batch', trackIds: new Array<string>(2) }, fields: { title: { action: 'remove' } } };
  for (const value of [getter, toJSON, hidden, cycle, sparse, Object.assign(preview(), { [Symbol('能力')]: true }), Object.assign(Object.create({ grant: true }), preview())]) assert.equal(c.isLocalSourceWritesCommandPayload('localSourceWrites.preview', value), false);
  assert.equal(reads, 0);
  const trap = new Proxy(preview(), { ownKeys: () => { throw new Error('私有失败'); } });
  assert.doesNotThrow(() => assert.equal(c.isLocalSourceWritesCommandPayload('localSourceWrites.preview', trap), false));
  const revoked = Proxy.revocable(preview(), {}); revoked.revoke();
  assert.equal(c.isLocalSourceWritesCommandPayload('localSourceWrites.preview', revoked.proxy), false);
});

test('012 使用一次捕获的纯快照；普通 Get trap 不改变已捕获的请求及指纹', () => {
  let calls = 0;
  const input = new Proxy(preview(), { get: () => { calls++; throw new Error('不应调用普通 Get'); } });
  const captured = c.localSourceWritesDataSnapshot(input) as c.PreviewLocalSourceWrites;
  assert.equal(c.isLocalSourceWritesCommandPayload('localSourceWrites.preview', captured), true);
  assert.equal(c.localSourceWritesRequestCanonical('localSourceWrites.preview', captured), c.localSourceWritesRequestCanonical('localSourceWrites.preview', preview()));
  assert.equal(calls, 0); assert.ok(Object.isFrozen(captured)); assert.ok(Object.isFrozen(captured.intent));
});

test('012 canonical 保留文本与码点序；拒浮点/-0/unsafe integer/孤立代理', () => {
  assert.equal(c.localSourceWritesCanonical({ '\u{10000}': 2, '\ue000': 1, n: 'e\u0301' }), '{"n":"é","":1,"𐀀":2}');
  assert.notEqual(c.localSourceWritesCanonical({ n: 'é' }), c.localSourceWritesCanonical({ n: 'e\u0301' }));
  for (const value of [1.5, -0, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, '\ud800', '\udfff', 1n, undefined]) assert.throws(() => c.localSourceWritesCanonical({ value }));
  const before = createHash('sha256').update(c.localSourceWritesRequestCanonical('localSourceWrites.preview', preview()), 'utf8').digest('hex');
  const changed = preview(); changed.datasetId = other;
  assert.notEqual(createHash('sha256').update(c.localSourceWritesRequestCanonical('localSourceWrites.preview', changed), 'utf8').digest('hex'), before);
});

test('012 六字段显式 set/remove；多值不猜拆，不接受旧 clear 或混合范围', () => {
  for (const fields of [{ title: { action: 'remove' } }, { artist: { action: 'set', value: '艺人甲 / 艺人乙' } }, { year: { action: 'set', value: '2026' } }, { disc: { action: 'set', value: '0' }, track: { action: 'set', value: '100000' } }]) assert.equal(c.isLocalSourceWritesCommandPayload('localSourceWrites.preview', { ...preview(), intent: { ...preview().intent, fields } }), true);
  for (const fields of [{}, { title: { action: 'clear' } }, { genres: { action: 'set', value: '摇滚' } }, { year: { action: 'set', value: '2026-10-08' } }, { track: { action: 'set', value: '1/12' } }, { disc: { action: 'set', value: '01' } }, { artist: { action: 'set', value: ['甲', '乙'] } }]) assert.equal(c.isLocalSourceWritesCommandPayload('localSourceWrites.preview', { ...preview(), intent: { ...preview().intent, fields } }), false);
  assert.equal(c.isLocalSourceWritesCommandPayload('localSourceWrites.preview', { ...preview(), intent: { ...preview().intent, artwork: {} } }), false);
});

test('012 policy 正 u64 CAS；开启设置不授予 grant，scope/hash/闭集确认独立', () => {
  assert.deepEqual(c.LOCAL_SOURCE_WRITES_DEFAULT_POLICY, { enabled: false, revision: '1', draining: false });
  for (const revision of ['1', '18446744073709551615']) assert.equal(c.isLocalSourceWritesCommandPayload('localSourceWrites.setPolicy', { datasetId: id, commandId: id, expectedPolicyRevision: revision, enabled: true }), true);
  for (const revision of ['0', '01', '18446744073709551616', 1]) assert.equal(c.isLocalSourceWritesCommandPayload('localSourceWrites.setPolicy', { datasetId: id, commandId: id, expectedPolicyRevision: revision, enabled: true }), false);
  for (const change of [{ scope: 'MB_ONLY' }, { range: 'MOVE' }, { planHash: hash.toUpperCase() }, { approval: true }, { userConfirmed: true }, { grant: {} }, { permission: id }, { path: '秘密路径' }, { fd: 4 }]) assert.equal(c.isLocalSourceWritesCommandPayload('localSourceWrites.confirm', { ...confirm(), ...change }), false);
});

test('012 get 的 command 对账保留原命令/指纹；未找到不附带重派能力', () => {
  const request = { datasetId: id, selector: { kind: 'command', commandId: other, expectedCommand: 'localSourceWrites.confirm', requestFingerprint: hash } };
  assert.equal(c.isLocalSourceWritesCommandPayload('localSourceWrites.get', request), true);
  for (const selector of [{ ...request.selector, expectedCommand: 'confirm' }, { ...request.selector, expectedCommand: 'localSourceWrites.executeGranted' }, { ...request.selector, requestFingerprint: 'a' }, { ...request.selector, retry: true }]) assert.equal(c.isLocalSourceWritesCommandPayload('localSourceWrites.get', { ...request, selector }), false);
  const found = { datasetId: id, kind: 'command', commandId: other, expectedCommand: 'localSourceWrites.confirm', requestFingerprint: hash, receipt: receipt(), issue: null };
  assert.equal(c.isLocalSourceWritesCommandResult('localSourceWrites.get', found), true);
  assert.equal(c.isLocalSourceWritesCommandResult('localSourceWrites.get', { ...found, receipt: null, issue: 'NOT_FOUND' }), true);
  assert.equal(c.isLocalSourceWritesCommandResult('localSourceWrites.get', { ...found, requestFingerprint: 'b'.repeat(64) }), false);
  assert.equal(c.isLocalSourceWritesCommandResult('localSourceWrites.get', { ...found, receipt: null, issue: 'NOT_FOUND', canRetry: true }), false);
});

test('012 三 Outbox 请求先拒描述符能力；dataset 不能从其他作用域借用', () => {
  const payloads = {
    'localSourceWrites.confirm': confirm(),
    'localSourceWrites.undo': { datasetId: id, commandId: other, planId: id, expectedViewRevision: '1', operationIds: [id], journalFingerprint: hash },
    'localSourceWrites.setPolicy': { datasetId: id, commandId: other, expectedPolicyRevision: '1', enabled: true },
  };
  for (const command of c.LOCAL_SOURCE_WRITES_OUTBOX_COMMANDS) {
    const payload = payloads[command], value = { datasetId: id, command, payload };
    assert.equal(c.isCommandOutboxRequest(value), true);
    assert.equal(c.isCommandOutboxExecute(value), true);
    assert.equal(c.isCommandOutboxExecute({ ...value, datasetId: other }), false);
    let reads = 0; const malicious = { ...payload }; Object.defineProperty(malicious, 'toJSON', { enumerable: true, value: () => { reads++; return payload; } });
    assert.equal(c.isCommandOutboxExecute({ ...value, payload: malicious }), false); assert.equal(reads, 0);
    Object.defineProperty(malicious, 'commandId', { enumerable: true, get: () => { reads++; return other; } });
    assert.equal(c.isCommandOutboxRequest({ ...value, payload: malicious }), false); assert.equal(reads, 0);
  }
});

test('012 IPC 捕获与路由相同快照；getter/变 command/trap 都不会执行新能力', () => {
  const envelope = { version: c.IPC_VERSION, id, command: 'localSourceWrites.confirm', payload: confirm(), expectedDatasetId: id };
  assert.equal(c.validateIpcRequest(envelope).ok, true);
  assert.equal(c.validateIpcRequest({ ...envelope, expectedDatasetId: other }).ok, false);
  for (const field of ['payload', 'expectedDatasetId', 'command'] as const) {
    let reads = 0; const value = { ...envelope }; Object.defineProperty(value, field, { enumerable: true, get: () => { reads++; return envelope[field]; } });
    assert.equal(c.validateIpcRequest(value).ok, false); assert.equal(reads, 0);
  }
  let observations = 0;
  const change = new Proxy(envelope, { getOwnPropertyDescriptor: (target, key) => key === 'command' ? { enumerable: true, configurable: true, value: ++observations === 1 ? target.command : 'localSourceWrites.setPolicy' } : Reflect.getOwnPropertyDescriptor(target, key) });
  assert.equal(c.validateIpcRequest(change).ok, false);
  const failure = new Proxy(envelope, { getOwnPropertyDescriptor: () => { throw new Error('不能泄露的 trap'); } });
  assert.doesNotThrow(() => assert.equal(c.validateIpcRequest(failure).ok, false));
});

test('012 受理回执不假写成功：命令/政策/计划 ID 必须闭合', () => {
  assert.equal(c.isLocalSourceWritesCommandResult('localSourceWrites.confirm', receipt()), true);
  for (const change of [{ command: 'localSourceWrites.undo' }, { outcome: 'written' }, { jobId: null }, { policy: context().policy }, { issue: 'SOURCE_CHANGED' }, { state: 'COMPLETED' }]) assert.equal(c.isLocalSourceWritesCommandResult('localSourceWrites.confirm', { ...receipt(), ...change }), false);
  const appliedPolicy = { ...receipt(), command: 'localSourceWrites.setPolicy', planId: null, jobId: null, policy: { enabled: true, revision: '2', draining: false } };
  assert.equal(c.isLocalSourceWritesCommandResult('localSourceWrites.setPolicy', appliedPolicy), true);
  assert.equal(c.isLocalSourceWritesCommandResult('localSourceWrites.setPolicy', { ...appliedPolicy, policy: { ...appliedPolicy.policy, draining: true } }), false);
});

test('012 READY/COMPLETED 与逐项、期限、保护/备份核验状态自洽', () => {
  assert.equal(c.isLocalSourceWritesPlan(plan()), true);
  for (const mutate of [(p: c.LocalSourceWritesPlan) => { p.expiresAt = p.readyAt; }, (p: c.LocalSourceWritesPlan) => { p.resourceSummary.protection = 'unknown'; }, (p: c.LocalSourceWritesPlan) => { p.issues.push('SOURCE_CHANGED'); }, (p: c.LocalSourceWritesPlan) => { p.state = 'COMPLETED'; }, (p: c.LocalSourceWritesPlan) => { p.items[0]!.state = 'unknown'; }]) {
    const value = plan(); mutate(value); assert.equal(c.isLocalSourceWritesPlan(value), false);
  }
  const completed = plan(); completed.state = 'COMPLETED'; Object.assign(completed.items[0]!, { state: 'applied', currentFileRevision: '2', phase: 'TERMINAL', backup: { state: 'verified', bytes: '256' }, verification: { audio: 'verified', unselectedMetadata: 'verified', content: 'verified', reread: 'verified' } });
  assert.equal(c.isLocalSourceWritesPlan(completed), true);
  const unsafe = structuredClone(completed); unsafe.items[0]!.verification.reread = 'pending'; assert.equal(c.isLocalSourceWritesPlan(unsafe), false);
  const missingRevision = structuredClone(completed); missingRevision.items[0]!.currentFileRevision = '1'; assert.equal(c.isLocalSourceWritesPlan(missingRevision), false);
  const directory = structuredClone(completed); directory.range = 'DIRECTORY_COVER'; assert.equal(c.isLocalSourceWritesPlan(directory), false);
});

test('012 两类封面引用当前 selection；目录封面不递增音频 revision，内嵌封面必须递增', () => {
  const ref: c.LocalSourceWritesArtworkRef = { editionId: id, candidateId: other, selectionId: id, expectedSelectionRevision: '1', contentRef: other, originalSha256: hash };
  for (const intent of [{ kind: 'embedded-cover', target: { mode: 'single', trackId: id }, artwork: ref, slot: 'front' }, { kind: 'directory-cover', target: { mode: 'edition', editionId: id }, artwork: ref, fileName: 'cover.png' }]) {
    assert.equal(c.isLocalSourceWritesCommandPayload('localSourceWrites.preview', { ...preview(), intent }), true);
    assert.equal(c.isLocalSourceWritesCommandPayload('localSourceWrites.preview', { ...preview(), intent: { ...intent, artwork: { ...ref, expectedSelectionRevision: '0' } } }), false);
    assert.equal(c.isLocalSourceWritesCommandPayload('localSourceWrites.preview', { ...preview(), intent: { ...intent, artwork: { ...ref, path: '原图路径' } } }), false);
  }
  assert.equal(c.isLocalSourceWritesCommandPayload('localSourceWrites.preview', { ...preview(), intent: { kind: 'directory-cover', target: { mode: 'single', trackId: id }, artwork: ref, fileName: '../cover.png' } }), false);
  for (const range of ['DIRECTORY_COVER', 'EMBEDDED_COVER'] as const) {
    const value = plan(); value.range = range; value.state = 'COMPLETED';
    Object.assign(value.items[0]!, { changes: [], artwork: { ...ref, mime: 'image/png', bytes: 4, width: 1, height: 1, slot: range === 'DIRECTORY_COVER' ? 'directory' : 'front' }, state: 'applied', phase: 'TERMINAL', currentFileRevision: range === 'DIRECTORY_COVER' ? '1' : '2', backup: { state: 'retained', bytes: '0' }, verification: { audio: range === 'DIRECTORY_COVER' ? 'not-applicable' : 'verified', unselectedMetadata: range === 'DIRECTORY_COVER' ? 'not-applicable' : 'verified', content: 'verified', reread: 'verified' } });
    assert.equal(c.isLocalSourceWritesPlan(value), true);
    const revision = structuredClone(value); revision.items[0]!.currentFileRevision = range === 'DIRECTORY_COVER' ? '2' : '1'; assert.equal(c.isLocalSourceWritesPlan(revision), false);
    const mixed = structuredClone(value); mixed.items[0]!.changes = plan().items[0]!.changes; assert.equal(c.isLocalSourceWritesPlan(mixed), false);
    const slot = structuredClone(value); slot.items[0]!.artwork!.slot = range === 'DIRECTORY_COVER' ? 'front' : 'directory'; assert.equal(c.isLocalSourceWritesPlan(slot), false);
    const selection = structuredClone(value); selection.items[0]!.artwork!.expectedSelectionRevision = '2'; assert.equal(c.isLocalSourceWritesPlan(selection), false);
    if (range === 'EMBEDDED_COVER') { const profile = structuredClone(value); profile.items[0]!.profile = null; assert.equal(c.isLocalSourceWritesPlan(profile), false); }
  }
});

test('012 Source Outbox 结果在路由和叶守卫前捕获，拒 getter/变 command/trap', () => {
  const value = { command: 'localSourceWrites.confirm', result: receipt() };
  assert.equal(c.isCommandOutboxResult(value), true); assert.equal(c.isCommandOutboxDispatchResult(value), true);
  for (const guard of [c.isCommandOutboxResult, c.isCommandOutboxDispatchResult]) {
    let reads = 0; const getter = { ...value }; Object.defineProperty(getter, 'result', { enumerable: true, get: () => { reads++; return receipt(); } });
    assert.equal(guard(getter), false); assert.equal(reads, 0);
    let observations = 0;
    const changing = new Proxy(value, { getOwnPropertyDescriptor: (target, key) => key === 'command' ? { enumerable: true, configurable: true, value: ++observations === 1 ? target.command : 'localSourceWrites.undo' } : Reflect.getOwnPropertyDescriptor(target, key) });
    assert.equal(guard(changing), false);
    const trap = new Proxy(value, { ownKeys: () => { throw new Error('私有 trap 信息'); } });
    assert.doesNotThrow(() => assert.equal(guard(trap), false));
  }
});

test('012 公共结果不携带私有路径、物理签名、FD 或授权对象', () => {
  const response = { datasetId: id, kind: 'plan', plan: plan(), issue: null };
  for (const field of ['body', 'path', 'dev', 'ino', 'grant', 'permission', 'signature', 'fd']) assert.equal(c.isLocalSourceWritesCommandResult('localSourceWrites.get', { ...response, plan: { ...response.plan, [field]: '秘密材料' } }), false);
  assert.equal(c.isLocalSourceWritesPlan({ ...plan(), summary: '/绝对路径/秘密原件' }), false);
  assert.equal(c.isLocalSourceWritesCommandResult('localSourceWrites.get', { datasetId: id, kind: 'context', context: context() }), true);
  assert.equal(c.isLocalSourceWritesCommandResult('localSourceWrites.get', { datasetId: other, kind: 'context', context: context() }), false);
});

test('012 撤销/恢复只描述新预览，不接收 resume 或文件操作；恢复选择绑定当前原计划', () => {
  const inverse = { datasetId: id, commandId: other, planId: id, expectedViewRevision: '2', operationIds: [id], journalFingerprint: hash };
  assert.equal(c.isLocalSourceWritesCommandPayload('localSourceWrites.undo', inverse), true);
  assert.equal(c.isLocalSourceWritesCommandPayload('localSourceWrites.undo', { ...inverse, operationIds: [id, id] }), false);
  assert.equal(c.isLocalSourceWritesCommandPayload('localSourceWrites.preview', { datasetId: id, commandId: other, intent: { kind: 'recovery', originPlanId: id, expectedOriginViewRevision: '2', choiceId: other, recoveryFingerprint: hash } }), true);
  assert.equal(c.isLocalSourceWritesCommandPayload('localSourceWrites.preview', { datasetId: id, commandId: other, intent: { kind: 'resume', originPlanId: id } }), false);
  const recoverable = plan(); recoverable.state = 'RECOVERY_REQUIRED'; recoverable.recoveryChoices = [{ choiceId: other, originPlanId: id, expectedOriginViewRevision: '1', recoveryFingerprint: hash, action: 'restore-original', label: '核对后恢复原件', operationIds: [id] }];
  assert.equal(c.isLocalSourceWritesPlan(recoverable), true);
  assert.equal(c.isLocalSourceWritesPlan({ ...recoverable, recoveryChoices: [{ ...recoverable.recoveryChoices[0]!, expectedOriginViewRevision: '2' }] }), false);
});

test('012 原 body 六键/op 九键及旧 MB_ONLY clear 合同保持', () => {
  const body = { created_at: '2026-10-08T00:00:00.000Z', scope: 'SOURCE_FILES', operations: [{ operation_id: id, kind: 'WRITE_TAGS', root_id: id, target_asset_id: id, expected_asset_revision: '1', source_relative_path: '合成.flac', target_relative_path: null, field_patch: { title: '新标题' }, backup_required: true }], root_mapping_revisions: { [id]: '1' }, conflicts: [], resource_guards: { require_exclusive_asset_lock: true, defer_if_read_lease: true, protect_frozen_sources: true, recheck_at_execution: true } };
  assert.equal(c.isOrganizerFrozenBody(body), true); assert.equal(Object.keys(body).length, 6); assert.equal(Object.keys(body.operations[0]!).length, 9);
  assert.equal(c.isOrganizerFrozenBody({ ...body, datasetId: id }), false);
  assert.equal(c.isOrganizerFrozenBody({ ...body, operations: [{ ...body.operations[0], grant: id }] }), false);
  assert.equal(c.isLocalOrganizerCommandPayload('localOrganizer.preview', { commandId: id, scope: 'MB_ONLY', target: { mode: 'single', trackId: id }, patch: { fields: { title: { action: 'clear' } } } }), true);
});

test('012 冷 UNKNOWN 仅 Source 视图投影原请求指纹，旧域无新键且不能重派', () => {
  const view = { id, commandId: other, command: 'localSourceWrites.confirm', datasetId: id, state: 'uncertain', createdAt: '2026-10-08T00:00:00.000Z', updatedAt: '2026-10-08T00:00:00.000Z', acknowledged: false, canRetry: false, sourceRequestFingerprint: hash };
  assert.equal(c.isCommandOutboxView(view), true);
  assert.equal(c.isCommandOutboxView({ ...view, canRetry: true }), false);
  assert.equal(c.isCommandOutboxView({ ...view, sourceRequestFingerprint: 'b' }), false);
  const legacy = { ...view, command: 'localOrganizer.confirm' }; delete (legacy as Partial<typeof legacy>).sourceRequestFingerprint;
  assert.equal(c.isCommandOutboxView(legacy), true);
  assert.equal(c.isCommandOutboxView({ ...legacy, sourceRequestFingerprint: hash }), false);
  let calls = 0; const getter = { ...view }; Object.defineProperty(getter, 'sourceRequestFingerprint', { enumerable: true, get: () => { calls++; return hash; } });
  assert.equal(c.isCommandOutboxView(getter), false); assert.equal(calls, 0);
  const input = confirm(), encoded = c.localSourceWritesRequestCanonical('localSourceWrites.confirm', input);
  assert.equal(encoded, c.localSourceWritesCanonical({ datasetId: input.datasetId, command: 'localSourceWrites.confirm', payload: input }));
});
