import assert from 'node:assert/strict';
import test from 'node:test';
import * as contracts from '../../src/index.js';

const dto = contracts as unknown as {
  LOCAL_LEGACY_LINKS_COMMANDS?: readonly string[];
  isLocalLegacyLinksCommandPayload?: (command: string, value: unknown) => boolean;
  localLegacyLinksCanonical?: (value: unknown) => string;
};
const id = '11111111-1111-4111-8111-111111111111';
const read = () => ({ datasetId: id, selector: { by: 'legacy', key: { kind: 'physical-release', physicalReleaseId: id } }, state: 'active', cursor: null, limit: 20 });

test('014 合同六命令：实体与数字主体各自保留身份，无 Roon 前置', () => {
  assert.deepEqual(dto.LOCAL_LEGACY_LINKS_COMMANDS, ['localLegacyLinks.read', 'localLegacyLinks.history', 'localLegacyLinks.preview', 'localLegacyLinks.confirm', 'localLegacyLinks.revoke', 'localLegacyLinks.undo']);
  assert.equal(typeof dto.isLocalLegacyLinksCommandPayload, 'function');
  assert.equal(dto.isLocalLegacyLinksCommandPayload!('localLegacyLinks.read', read()), true);
  const wrong = read(); Object.assign(wrong.selector.key, { digitalAlbumId: id });
  assert.equal(dto.isLocalLegacyLinksCommandPayload!('localLegacyLinks.read', wrong), false);
});

test('014 描述符守卫：getter、符号、隐藏键、稀疏及孤立代理均零求值拒绝', () => {
  assert.equal(typeof dto.isLocalLegacyLinksCommandPayload, 'function'); let evaluated = 0;
  const getter = read(); Object.defineProperty(getter, 'datasetId', { enumerable: true, get: () => { evaluated++; return id; } });
  const hidden = read(); Object.defineProperty(hidden, 'toJSON', { value: () => { evaluated++; return read(); } });
  const symbol = Object.assign(read(), { [Symbol('额外权限')]: true });
  for (const value of [getter, hidden, symbol, { ...read(), state: '\ud800' }, { ...read(), limit: -0 }, { ...read(), selector: new Array(1) }]) {
    assert.equal(dto.isLocalLegacyLinksCommandPayload!('localLegacyLinks.read', value), false);
  }
  assert.equal(evaluated, 0);
});

test('014 预览守卫：真实 u64 与完整 slot，拒批量/伪数字修订/额外文件证据', () => {
  assert.equal(typeof dto.isLocalLegacyLinksCommandPayload, 'function');
  const request = { datasetId: id, commandId: id, intent: { action: 'link', choice: { kind: 'legacy-edition', subject: { kind: 'physical-release', physicalReleaseId: id, expectedRevision: 1 }, localEditionId: id, expectedEditionRevision: '18446744073709551615', expectedSlot: { activeLinkId: null, lastTransitionEventId: null } } }, reason: '人工核对原发行' };
  assert.equal(dto.isLocalLegacyLinksCommandPayload!('localLegacyLinks.preview', request), true);
  for (const revision of ['018446744073709551615', '18446744073709551616', 1]) {
    assert.equal(dto.isLocalLegacyLinksCommandPayload!('localLegacyLinks.preview', { ...request, intent: { action: 'link', choice: { ...request.intent.choice, expectedEditionRevision: revision } } }), false);
  }
  assert.equal(dto.isLocalLegacyLinksCommandPayload!('localLegacyLinks.preview', { ...request, sha256: 'a'.repeat(64) }), false);
  assert.equal(dto.isLocalLegacyLinksCommandPayload!('localLegacyLinks.preview', { ...request, reason: ' ' }), false);
});

test('014 canonical：码点排键、保留 NFD 与原文，拒浮点及孤立代理', () => {
  assert.equal(typeof dto.localLegacyLinksCanonical, 'function');
  assert.equal(dto.localLegacyLinksCanonical!({ '\u{10000}': 2, '\ue000': 1, n: 'e\u0301' }), '{"n":"é","":1,"𐀀":2}');
  assert.notEqual(dto.localLegacyLinksCanonical!({ n: 'é' }), dto.localLegacyLinksCanonical!({ n: 'e\u0301' }));
  for (const value of [{ n: 1.25 }, { n: -0 }, { n: '\ud800' }, { n: NaN }]) assert.throws(() => dto.localLegacyLinksCanonical!(value));
});

const preview = (): contracts.LocalLegacyLinkPreview => ({ previewId: id, revision: '1', datasetId: id, previewHash: 'a'.repeat(64), contextFingerprint: 'b'.repeat(64), body: {
  version: 1, datasetId: id, previewId: id, plannedLinkId: id, createdAt: '2026-10-07T00:00:00.000Z', expiresAt: '2026-10-07T00:10:00.000Z',
  intent: { action: 'link', choice: { kind: 'legacy-edition', subject: { kind: 'physical-release', physicalReleaseId: id, expectedRevision: 1 }, localEditionId: id, expectedEditionRevision: '1', expectedSlot: { activeLinkId: null, lastTransitionEventId: null } } }, reason: '人工审阅', before: null,
  endpoints: { kind: 'legacy-edition', subject: { kind: 'physical-release', physicalReleaseId: id, revision: 1, summary: { format: 'cd', title: '原实体发行', artist: '合成艺人', year: null, edition: null }, releaseFingerprint: 'c'.repeat(64) }, localEditionId: id, editionRevision: '1', title: '本地发行', edition: '' }, evidence: { kind: 'manual-edition' },
  guard: { slot: { activeLinkId: null, lastTransitionEventId: null }, expectedLinkRevision: null, endpointsFingerprint: 'd'.repeat(64), editionMembersFingerprint: 'e'.repeat(64), bindingFingerprint: null, assetProofFingerprint: null }
} });

test('014 公共结果：manual/来源证据不可混用，成员指纹与服务端身份交叉核对', () => {
  assert.equal(contracts.isLocalLegacyLinksCommandResult('localLegacyLinks.preview', preview()), true);
  for (const mutation of [(p: contracts.LocalLegacyLinkPreview) => { p.body.guard.editionMembersFingerprint = null; }, (p: contracts.LocalLegacyLinkPreview) => { p.body.guard.bindingFingerprint = 'f'.repeat(64); }, (p: contracts.LocalLegacyLinkPreview) => { p.body.previewId = '22222222-2222-4222-8222-222222222222'; }, (p: contracts.LocalLegacyLinkPreview) => { p.body.createdAt = '2026-02-31T00:00:00.000Z'; }]) {
    const p = preview(); mutation(p); assert.equal(contracts.isLocalLegacyLinksCommandResult('localLegacyLinks.preview', p), false);
  }
  const applied: contracts.LocalLegacyLinkReceipt = { datasetId: id, commandId: id, action: 'confirm', previewId: id, outcome: 'applied', link: { version: 1, datasetId: id, linkId: id, revision: '1', state: 'active', endpoints: preview().body.endpoints, evidence: { kind: 'manual-edition' }, lastTransitionEventId: id }, transitionEventId: id, issue: null };
  assert.equal(contracts.isLocalLegacyLinksCommandResult('localLegacyLinks.confirm', applied), true);
  assert.equal(contracts.isLocalLegacyLinksCommandResult('localLegacyLinks.revoke', applied), false);
  assert.equal(contracts.isLocalLegacyLinksCommandResult('localLegacyLinks.confirm', { ...applied, outcome: 'rejected' }), false);
});

test('014 IPC 与 Outbox：六命令显式准入，三执行回执保留 action，不授权任意前缀', () => {
  const payload: contracts.ExecuteLocalLegacyLink = { datasetId: id, commandId: id, previewId: id, expectedPreviewRevision: '1', previewHash: 'a'.repeat(64), contextFingerprint: 'b'.repeat(64), userConfirmed: true };
  for (const command of ['localLegacyLinks.confirm', 'localLegacyLinks.revoke', 'localLegacyLinks.undo'] as const) {
    assert.equal(contracts.validateIpcRequest({ version: contracts.IPC_VERSION, id: id, command, payload, expectedDatasetId: id }).ok, true);
    assert.ok((contracts.COMMAND_OUTBOX_COMMANDS as readonly string[]).includes(command));
  }
  assert.equal(contracts.validateIpcRequest({ version: contracts.IPC_VERSION, id: id, command: 'localLegacyLinks.confirm', payload }).ok, false);
  assert.equal(contracts.validateIpcRequest({ version: contracts.IPC_VERSION, id: id, command: 'localLegacyLinks.autoMatch', payload, expectedDatasetId: id }).ok, false);
  let reads = 0; const envelope = { version: contracts.IPC_VERSION, id, command: 'localLegacyLinks.confirm', expectedDatasetId: id };
  Object.defineProperty(envelope, 'payload', { enumerable: true, get: () => { reads++; return payload; } });
  assert.equal(contracts.validateIpcRequest(envelope).ok, false); assert.equal(reads, 0);
});

test('014 Outbox 原始信封：执行 getter/toJSON 前拒绝，无副作用', () => {
  const payload = { datasetId: id, commandId: id, previewId: id, expectedPreviewRevision: '1', previewHash: 'a'.repeat(64), contextFingerprint: 'b'.repeat(64), userConfirmed: true };
  for (const command of ['localLegacyLinks.confirm', 'localLegacyLinks.revoke', 'localLegacyLinks.undo'] as const) {
    for (const field of ['datasetId', 'commandId', 'toJSON'] as const) {
      let calls = 0; const p = { ...payload };
      if (field === 'toJSON') Object.defineProperty(p, field, { enumerable: true, value: () => { calls++; return payload; } });
      else Object.defineProperty(p, field, { enumerable: true, get: () => { calls++; return id; } });
      assert.equal(contracts.isCommandOutboxExecute({ datasetId: id, command, payload: p }), false);
      assert.equal(calls, 0, `${command}/${field} 必须在普通 Get 或 JSON 求值前拒绝`);
    }
  }
});

test('014 描述符快照：Proxy 的普通 Get 不能改变 canonical、叶守卫或 IPC 传递值', () => {
  let gets = 0;
  for (const diverted of [1.25, 'x'.repeat(70000), {}]) {
    const p = new Proxy({ n: 1 }, { get: (_target, key) => { gets++; return key === 'n' ? diverted : undefined; } });
    assert.equal(contracts.localLegacyLinksCanonical(p), '{"n":1}');
  }
  const raw = read(), p = new Proxy(raw, { get: (_target, key) => { gets++; return key === 'limit' ? 1.25 : Reflect.get(raw, key); } });
  assert.equal(contracts.isLocalLegacyLinksCommandPayload('localLegacyLinks.read', p), true);
  const result = contracts.validateIpcRequest({ version: contracts.IPC_VERSION, id, command: 'localLegacyLinks.read', expectedDatasetId: id, payload: p });
  assert.equal(result.ok, true);
  if (result.ok) { assert.notEqual(result.value.payload, p); assert.deepEqual(result.value.payload, raw); }
  const original = preview(), returned = new Proxy(original, { get: (_target, key) => { gets++; return key === 'datasetId' ? 'x'.repeat(70000) : Reflect.get(original, key); } });
  const response = contracts.validateIpcResponseForCommand({ version: contracts.IPC_VERSION, id, ok: true, result: returned }, 'localLegacyLinks.preview');
  assert.equal(response.ok, true);
  if (response.ok && response.value.ok) { assert.notEqual(response.value.result, returned); assert.deepEqual(response.value.result, original); }
  assert.equal(gets, 0);
});

test('014 恶意描述符/撤销 Proxy/trap：入口有界拒绝，异常不外逸', () => {
  const revoked = Proxy.revocable(read(), {}); revoked.revoke();
  const cycle: Record<string, unknown> = {}; cycle.self = cycle;
  const invalid = [revoked.proxy, new Proxy(read(), { ownKeys: () => { throw new Error('私有路径不能外逸'); } }), new Proxy(read(), { getPrototypeOf: () => { throw new Error('私有路径不能外逸'); } }), { n: 'x'.repeat(70000) }, cycle];
  for (const p of invalid) {
    assert.equal(contracts.isLocalLegacyLinksCommandPayload('localLegacyLinks.read', p), false);
    assert.throws(() => contracts.localLegacyLinksCanonical(p));
    assert.doesNotThrow(() => assert.equal(contracts.validateIpcRequest({ version: contracts.IPC_VERSION, id, command: 'localLegacyLinks.read', expectedDatasetId: id, payload: p }).ok, false));
  }
  const envelope = new Proxy({ version: contracts.IPC_VERSION, id, command: 'localLegacyLinks.read', expectedDatasetId: id, payload: read() }, { getOwnPropertyDescriptor: () => { throw new Error('拒绝描述符观察'); } });
  assert.doesNotThrow(() => assert.equal(contracts.validateIpcRequest(envelope).ok, false));
});

test('014 状态自洽：revoke/undo 绑定原状态与最后 slot，确认/解除回执固定结果', () => {
  const other = '22222222-2222-4222-8222-222222222222', original = preview();
  const edge: contracts.LocalLegacyLink = { version: 1, datasetId: id, linkId: id, revision: '1', state: 'active', endpoints: original.body.endpoints, evidence: original.body.evidence, lastTransitionEventId: id };
  const revokedPreview = (): contracts.LocalLegacyLinkPreview => ({ ...preview(), body: { ...preview().body, intent: { action: 'revoke', linkId: id, expectedLinkRevision: '1' }, before: structuredClone(edge), guard: { slot: { activeLinkId: id, lastTransitionEventId: id }, expectedLinkRevision: '1', endpointsFingerprint: null, editionMembersFingerprint: null, bindingFingerprint: null, assetProofFingerprint: null } } });
  assert.equal(contracts.isLocalLegacyLinkPreview(revokedPreview()), true);
  for (const change of [(p: contracts.LocalLegacyLinkPreview) => { p.body.before!.state = 'revoked'; }, (p: contracts.LocalLegacyLinkPreview) => { p.body.guard.slot.activeLinkId = other; }, (p: contracts.LocalLegacyLinkPreview) => { p.body.guard.slot.lastTransitionEventId = other; }]) {
    const p = revokedPreview(); change(p); assert.equal(contracts.isLocalLegacyLinkPreview(p), false);
  }
  const undo = revokedPreview(); undo.body.intent = { action: 'undo', linkId: id, expectedLinkRevision: '1', undoTransitionEventId: other };
  assert.equal(contracts.isLocalLegacyLinkPreview(undo), false);
  const receipt: contracts.LocalLegacyLinkReceipt = { datasetId: id, commandId: id, action: 'confirm', previewId: id, outcome: 'applied', link: edge, transitionEventId: id, issue: null };
  assert.equal(contracts.isLocalLegacyLinkReceipt({ ...receipt, link: { ...edge, state: 'revoked' } }), false);
  assert.equal(contracts.isLocalLegacyLinkReceipt({ ...receipt, link: { ...edge, revision: '2' } }), false);
  assert.equal(contracts.isLocalLegacyLinkReceipt({ ...receipt, action: 'revoke' }), false);
  const transition: contracts.LocalLegacyLinkTransition = { eventId: other, datasetId: id, linkId: id, commandId: id, previewId: id, action: 'undone', occurredAt: original.body.createdAt, reason: '撤销最后转换', before: edge, after: { ...edge, revision: '2', state: 'revoked', lastTransitionEventId: other }, undoOfEventId: other };
  assert.equal(contracts.isLocalLegacyLinkTransition(transition), false);
  assert.equal(contracts.isLocalLegacyLinkTransition({ ...transition, undoOfEventId: id }), true);
});

test('014 Outbox 根 command accessor/隐藏与变化 trap：不得回落求值或换命令', () => {
  const raw = { datasetId: id, command: 'localLegacyLinks.confirm', payload: { datasetId: id, commandId: id, previewId: id, expectedPreviewRevision: '1', previewHash: 'a'.repeat(64), contextFingerprint: 'b'.repeat(64), userConfirmed: true } };
  for (const field of ['command','payload','datasetId'] as const) {
    let calls=0;const value={...raw};Object.defineProperty(value,field,{enumerable:true,get:()=>{calls++;return raw[field];}});
    assert.equal(contracts.isCommandOutboxExecute(value),false);assert.equal(contracts.isCommandOutboxRequest(value),false);assert.equal(calls,0);
  }
  const hidden={...raw};Object.defineProperty(hidden,'command',{enumerable:false,value:raw.command});assert.equal(contracts.isCommandOutboxExecute(hidden),false);
  const trap=new Proxy(raw,{getOwnPropertyDescriptor:()=>{throw new Error('私有 trap');}});assert.doesNotThrow(()=>assert.equal(contracts.isCommandOutboxExecute(trap),false));
});

test('014 Outbox 可变 descriptor command：快照与路由身份必须一致', () => {
  const raw={datasetId:id,command:'localLegacyLinks.confirm',payload:{datasetId:id,commandId:id,previewId:id,expectedPreviewRevision:'1',previewHash:'a'.repeat(64),contextFingerprint:'b'.repeat(64),userConfirmed:true}};
  const make=()=>{let reads=0;return new Proxy(raw,{getOwnPropertyDescriptor:(target,key)=>key==='command'?{enumerable:true,configurable:true,value:++reads===1?raw.command:'localLegacyLinks.unknown'}:Reflect.getOwnPropertyDescriptor(target,key)});};
  assert.equal(contracts.isCommandOutboxExecute(make()),false);assert.equal(contracts.isCommandOutboxRequest(make()),false);
  const payload=new Proxy(read(),{get:(target,key)=>key==='limit'?1.25:Reflect.get(target,key)});
  const makeIpc=(first:string)=>{let reads=0;const target={version:contracts.IPC_VERSION,id,command:'localLegacyLinks.read',expectedDatasetId:id,payload};return new Proxy(target,{getOwnPropertyDescriptor:(value,key)=>key==='command'?{enumerable:true,configurable:true,value:++reads===1?first:'localLegacyLinks.read'}:Reflect.getOwnPropertyDescriptor(value,key)});};
  assert.equal(contracts.validateIpcRequest(makeIpc('ping')).ok,false);
  const wrong=new Proxy({version:contracts.IPC_VERSION,id,command:'localLegacyLinks.read',expectedDatasetId:id,payload:read()},{getOwnPropertyDescriptor:(target,key)=>key==='command'?{enumerable:true,configurable:true,value:++commandReads===1?'localLegacyLinks.read':'localLegacyLinks.unknown'}:Reflect.getOwnPropertyDescriptor(target,key)});let commandReads=0;
  assert.equal(contracts.validateIpcRequest(wrong).ok,false);
});
