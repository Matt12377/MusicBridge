import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  isLocalRelocationFrozenBody, isLocalRelocationFrozenContext, localRelocationFrozenPlanSnapshot,
  isLocalRelocationMainCommandPayload, isLocalRelocationMainCommandResult,
  localRelocationMainRequestSnapshot, localRelocationMainResponseSnapshot,
} from '../../src/local-relocation-private.js';
import { localRelocationPlanHashInput } from '../../src/local-relocation-plan.js';
import { id, hash, confirm, cleanup, grant, challenge, receipt, frozenBody, frozenContext } from './fixtures.js';

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const planHash = (value: unknown): string => createHash('sha256').update(localRelocationPlanHashInput(value)).digest('hex');

test('013 FrozenBody 九键、Context 十三键独立；完整合并快照绑定实际预约', () => {
  const body = frozenBody(), context = frozenContext();
  assert.equal(Object.keys(body).length, 9); assert.equal(Object.keys(context).length, 13);
  assert.equal(isLocalRelocationFrozenBody(body), true); assert.equal(isLocalRelocationFrozenContext(context), true);
  assert.equal(Object.isFrozen(localRelocationFrozenPlanSnapshot(body, context)), true);
  assert.throws(() => localRelocationFrozenPlanSnapshot(body, { ...context, reservationFingerprint: hash(90) }));
  for (const key of ['target_root_id', 'actor', 'grant', 'fd', 'readFacts', 'jobId', 'batchId']) {
    assert.equal(isLocalRelocationFrozenBody({ ...body, [key]: id(99) }), false, key);
    assert.equal(isLocalRelocationFrozenContext({ ...context, [key]: id(99) }), false, key);
  }
  assert.equal(isLocalRelocationFrozenBody({ version: 1, createdAt: body.createdAt, intent: body.intent, operations: body.operations, guards: body.guards, audit: {} }), false);
});

test('公开 path 不能伪装 capture；私有结构合法仍不宣称真实 Main actor 已认证', () => {
  const payload = { datasetId: id(1), commandId: id(2), kind: 'directory', absolutePath: '/Volumes/合成夹具/音乐' };
  assert.equal(isLocalRelocationMainCommandPayload('localRelocationMain.captureTarget', payload), true);
  for (const extra of ['actor', 'fd', 'rootIdentity', 'physicalRootFingerprint', 'sourceRootId', 'scanBefore']) assert.equal(isLocalRelocationMainCommandPayload('localRelocationMain.captureTarget', { ...payload, [extra]: id(3) }), false, extra);
  assert.equal(isLocalRelocationMainCommandPayload('localRelocationMain.captureTarget', { ...payload, absolutePath: 'relative/music' }), false);
  assert.equal(isLocalRelocationMainCommandPayload('localRelocationMain.captureTarget', { ...payload, absolutePath: 'file:///private/music' }), false);
  assert.equal(isLocalRelocationMainCommandPayload('localRelocationMain.captureTarget', { ...payload, absolutePath: '/music\u0000' }), false);
});

test('Main execute 与 cleanup 能力不混用，dataset 外内严格一致且旧 grant 拒绝', () => {
  const execute = { datasetId: id(1), confirm: confirm(), grant: grant() };
  const clean = { datasetId: id(1), cleanup: cleanup(), grant: grant('cleanup') };
  assert.equal(isLocalRelocationMainCommandPayload('localRelocationMain.executeGranted', execute), true);
  assert.equal(isLocalRelocationMainCommandPayload('localRelocationMain.cleanupGranted', clean), true);
  assert.equal(isLocalRelocationMainCommandPayload('localRelocationMain.executeGranted', { ...execute, grant: grant('cleanup') }), false);
  assert.equal(isLocalRelocationMainCommandPayload('localRelocationMain.cleanupGranted', { ...clean, grant: grant() }), false);
  assert.equal(isLocalRelocationMainCommandPayload('localRelocationMain.executeGranted', { ...execute, datasetId: id(99) }), false);
  const old012Grant = { challengeId: id(40), ownerEpoch: id(41), nonce: hash(4), authorityId: id(42), signature: hash(5) };
  assert.equal(isLocalRelocationMainCommandPayload('localRelocationMain.executeGranted', { ...execute, grant: old012Grant }), false);
  assert.equal(isLocalRelocationMainCommandPayload('localRelocationMain.executeGranted', { ...execute, grant: { ...grant(), unlinkSource: true } }), false);
});

test('初次 execute challenge 无 cleanup 权，二次 cleanup 必须精确已验目标与源资源', () => {
  assert.equal(isLocalRelocationMainCommandResult('localRelocationMain.challenge', challenge()), true);
  assert.equal(isLocalRelocationMainCommandResult('localRelocationMain.challengeCleanup', challenge('cleanup')), true);
  assert.equal(isLocalRelocationMainCommandResult('localRelocationMain.challenge', challenge('cleanup')), false);
  assert.equal(isLocalRelocationMainCommandResult('localRelocationMain.challenge', { ...challenge(), verifiedTargetFingerprint: hash(3), sourceResourceIds: [id(20)] }), false);
  assert.equal(isLocalRelocationMainCommandResult('localRelocationMain.challengeCleanup', { ...challenge('cleanup'), verifiedTargetFingerprint: null }), false);
  assert.equal(isLocalRelocationMainCommandResult('localRelocationMain.challengeCleanup', { ...challenge('cleanup'), sourceResourceIds: [] }), false);
  assert.equal(isLocalRelocationMainCommandResult('localRelocationMain.captureTarget', null), false);
  assert.equal(isLocalRelocationMainCommandResult('localRelocationMain.cleanupGranted', receipt()), false);
});

test('Main 信封闭键、sequence 与响应原 requestId；失败不泄路径或凭据', () => {
  const request = { version: 1, type: 'relocation-main-request', requestId: id(60), sequence: 1, command: 'localRelocationMain.challenge', payload: { datasetId: id(1), confirm: confirm() } };
  assert.equal(localRelocationMainRequestSnapshot(request).requestId, id(60));
  for (const mutation of [{ ...request, sequence: 0 }, { ...request, sequence: 1.5 }, { ...request, type: 'source-writes-request' }, { ...request, actor: id(9) }]) assert.throws(() => localRelocationMainRequestSnapshot(mutation));
  const response = { version: 1, type: 'relocation-main-response', requestId: id(60), sequence: 1, ok: true, result: challenge() };
  assert.equal(localRelocationMainResponseSnapshot(response, 'localRelocationMain.challenge').ok, true);
  assert.throws(() => localRelocationMainResponseSnapshot(response, 'localRelocationMain.challengeCleanup'));
  const failure = { version: 1, type: 'relocation-main-response', requestId: id(60), sequence: 1, ok: false, failure: { version: 1, id: id(60), ok: false, error: { code: 'NOT_READY', message: '计划尚未准备完成' } } };
  assert.equal(localRelocationMainResponseSnapshot(failure, 'localRelocationMain.challenge').ok, false);
  assert.throws(() => localRelocationMainResponseSnapshot({ ...failure, failure: { ...failure.failure, id: id(61) } }, 'localRelocationMain.challenge'));
  for (const message of ['/private/music/source.flac', 'token=synthetic-secret', 'file:///private/source', 'failed at /Volumes/private/file']) assert.throws(() => localRelocationMainResponseSnapshot({ ...failure, failure: { ...failure.failure, error: { code: 'NOT_READY', message } } }, 'localRelocationMain.challenge'));
});

test('普通 whole bytes 移动 Audio 不借 012 writer profile 或 padding 资格', () => {
  const body = frozenBody();
  assert.equal(isLocalRelocationFrozenBody(body), true);
  assert.equal(Object.keys(body.resourceClosure.resources[0]!).some(key => /profile|padding|application|metadataReader/u.test(key)), false);
  const malformed = clone(body); malformed.resourceClosure.resources[0]!.after.sha256 = hash(99);
  assert.equal(isLocalRelocationFrozenBody(malformed), false);
  const audioRewrite = clone(body); audioRewrite.resourceClosure.resources[0]!.action = 'rewrite-reference';
  assert.equal(isLocalRelocationFrozenBody(audioRewrite), false);
  const oldWriterField = { ...body.resourceClosure.resources[0]!, profile: 'FLAC_PADDING_ONLY' };
  assert.equal(isLocalRelocationFrozenBody({ ...body, resourceClosure: { ...body.resourceClosure, resources: [oldWriterField] } }), false);
  const swappedAudio = clone(body); swappedAudio.resourceClosure.resources[0]!.source = { ...swappedAudio.resourceClosure.resources[0]!.source, relative: '另一个同Hash副本.flac' };
  assert.equal(isLocalRelocationFrozenBody(swappedAudio), false);
});

test('完整伴随闭集参与 Hash、操作/资源双向索引与未知/共享引用拒绝', () => {
  const body = frozenBody();
  const audio = body.resourceClosure.resources[0]!;
  const lyric = { ...clone(audio), resourceId: id(21), role: 'LYRIC' as const, source: { ...audio.source, relative: '原曲.lrc' }, target: { ...audio.target, relative: '新曲.lrc' }, before: { sha256: hash(22), bytes: '100' }, after: { sha256: hash(22), bytes: '100' } };
  body.operations[0]!.resourceIds.push(id(21)); body.resourceClosure.resources.push(lyric);
  body.resourceClosure.referenceEdges.push({ edgeId: id(22), fromResourceId: id(21), toResourceId: id(20), kind: 'LYRIC_AUDIO', shared: false });
  assert.equal(isLocalRelocationFrozenBody(body), true); assert.notEqual(planHash(body), planHash(frozenBody()));
  const dangling = clone(body); dangling.resourceClosure.referenceEdges[0]!.toResourceId = id(99); assert.equal(isLocalRelocationFrozenBody(dangling), false);
  const missing = clone(body); missing.operations[0]!.resourceIds = [id(20)]; assert.equal(isLocalRelocationFrozenBody(missing), false);
  const unknown = clone(body); unknown.resourceClosure.resources[1]!.role = 'UNKNOWN_REFERENCE'; assert.equal(isLocalRelocationFrozenBody(unknown), false);
  const shared = clone(body); shared.resourceClosure.referenceEdges[0]!.shared = true; assert.equal(isLocalRelocationFrozenBody(shared), false);
  shared.resourceClosure.resources.forEach(resource => { resource.sharedMemberIds = [id(12)]; }); assert.equal(isLocalRelocationFrozenBody(shared), true);
  const duplicate = clone(body); duplicate.resourceClosure.resources.push(clone(lyric)); assert.equal(isLocalRelocationFrozenBody(duplicate), false);
});

test('跨卷 copy-retain 闭集精确保源；REQUEST_CLEANUP 不授第一次 unlink', () => {
  const body = frozenBody();
  body.resourceClosure.resources[0]!.action = 'copy-retain';
  assert.equal(isLocalRelocationFrozenBody(body), false);
  body.sourceRetention.resourceIds = [id(20)]; assert.equal(isLocalRelocationFrozenBody(body), true);
  body.sourceRetention.disposition = 'REQUEST_CLEANUP';
  if (body.intent.kind === 'rename') body.intent.sourceDisposition = 'REQUEST_CLEANUP';
  assert.equal(isLocalRelocationFrozenBody(body), true);
  assert.equal(isLocalRelocationFrozenBody({ ...body, sourceRetention: { ...body.sourceRetention, cleanupRequiresNewGrant: false } }), false);
  body.sourceRetention.resourceIds.push(id(99)); assert.equal(isLocalRelocationFrozenBody(body), false);
});

test('目标引用重写保原 CUE/清单，copy-retain、rewrite-reference、retain 源闭集不得漏项或越界', () => {
  for (const role of ['CUE', 'MANIFEST'] as const) {
    const body = frozenBody(), audio = body.resourceClosure.resources[0]!;
    audio.action = 'copy-retain';
    const extension = role === 'CUE' ? 'cue' : 'm3u';
    const reference = { ...clone(audio), resourceId: id(21), role, action: 'rewrite-reference' as const,
      source: { ...audio.source, relative: `原曲.${extension}` }, target: { ...audio.target, relative: `新曲.${extension}` },
      before: { sha256: hash(22), bytes: '100' }, after: { sha256: hash(23), bytes: '110' } };
    const lyric = { ...clone(audio), resourceId: id(22), role: 'LYRIC' as const, action: 'retain' as const,
      source: { ...audio.source, relative: '原曲.lrc' }, target: { ...audio.source, relative: '原曲.lrc' },
      before: { sha256: hash(24), bytes: '200' }, after: { sha256: hash(24), bytes: '200' } };
    body.operations[0]!.resourceIds.push(reference.resourceId, lyric.resourceId);
    body.resourceClosure.resources.push(reference, lyric);
    body.resourceClosure.referenceEdges.push({ edgeId: id(23), fromResourceId: reference.resourceId, toResourceId: audio.resourceId,
      kind: role === 'CUE' ? 'CUE_AUDIO' : 'MANIFEST', shared: false });
    body.sourceRetention.resourceIds = [audio.resourceId, reference.resourceId, lyric.resourceId];
    assert.equal(isLocalRelocationFrozenBody(body), true, role);
    const omitted = clone(body); omitted.sourceRetention.resourceIds = [audio.resourceId, lyric.resourceId];
    assert.equal(isLocalRelocationFrozenBody(omitted), false, `${role} 原件必须保留`);
    const extra = clone(body); extra.sourceRetention.resourceIds.push(id(99));
    assert.equal(isLocalRelocationFrozenBody(extra), false, `${role} 不得授权闭集外源`);
    const duplicate = clone(body); duplicate.sourceRetention.resourceIds.push(reference.resourceId);
    assert.equal(isLocalRelocationFrozenBody(duplicate), false, `${role} 保留索引不能重复`);
    const unretainedMove = clone(body); unretainedMove.resourceClosure.resources[0]!.action = 'move';
    assert.equal(isLocalRelocationFrozenBody(unretainedMove), false, `${role} move 不属于保留源动作`);
    body.sourceRetention.disposition = 'REQUEST_CLEANUP';
    if (body.intent.kind === 'rename') body.intent.sourceDisposition = 'REQUEST_CLEANUP';
    assert.equal(isLocalRelocationFrozenBody(body), true, `${role} cleanup 仍需新 grant`);
    assert.equal(body.sourceRetention.cleanupRequiresNewGrant, true);
    const noFreshGrant = clone(body);
    assert.equal(isLocalRelocationFrozenBody({ ...noFreshGrant, sourceRetention: { ...noFreshGrant.sourceRetention, cleanupRequiresNewGrant: false } }), false);
  }
});

test('相对路径、大小写/Unicode 原字节、实际逻辑根版本与底层指纹完整绑定', () => {
  for (const relative of ['../曲.flac', '/曲.flac', 'a//曲.flac', 'a/./曲.flac', 'a\\曲.flac', 'C:曲.flac', 'a/曲\u0000.flac']) {
    const body = frozenBody(); body.operations[0]!.source.relative = relative; assert.equal(isLocalRelocationFrozenBody(body), false, relative);
  }
  const composed = frozenBody(), decomposed = frozenBody();
  composed.operations[0]!.source.relative = 'é.flac'; composed.resourceClosure.resources[0]!.source.relative = 'é.flac';
  decomposed.operations[0]!.source.relative = 'e\u0301.flac'; decomposed.resourceClosure.resources[0]!.source.relative = 'e\u0301.flac';
  assert.equal(isLocalRelocationFrozenBody(composed), true); assert.equal(isLocalRelocationFrozenBody(decomposed), true); assert.notEqual(planHash(composed), planHash(decomposed));
  const replaced = clone(composed); replaced.rootMappings[0]!.sourcePhysicalRootFingerprint = hash(99); assert.notEqual(planHash(replaced), planHash(composed));
  const stale = frozenBody(); stale.rootMappings[0]!.source.expectedRootRevision = '8'; assert.equal(isLocalRelocationFrozenBody(stale), false);
});

test('16GiB 单源 B-1/B/B+1 和 64GiB 完整计划总量；不部分授权', () => {
  for (const count of [17_179_869_183n, 17_179_869_184n, 17_179_869_185n]) {
    const body = frozenBody(); body.resourceClosure.resources[0]!.before.bytes = String(count); body.resourceClosure.resources[0]!.after.bytes = String(count);
    assert.equal(isLocalRelocationFrozenBody(body), count <= 17_179_869_184n);
  }
  const body = frozenBody(); const audio = body.resourceClosure.resources[0]!;
  audio.before.bytes = '17179869184'; audio.after.bytes = '17179869184';
  for (let index = 1; index < 4; index++) {
    const next = { ...clone(audio), resourceId: id(100 + index), role: 'IMAGE' as const, source: { ...audio.source, relative: `source${index}.png` }, target: { ...audio.target, relative: `target${index}.png` } };
    body.resourceClosure.resources.push(next); body.operations[0]!.resourceIds.push(next.resourceId);
  }
  assert.equal(isLocalRelocationFrozenBody(body), true);
  const beyond = { ...clone(audio), resourceId: id(110), role: 'IMAGE' as const, before: { sha256: hash(1), bytes: '1' }, after: { sha256: hash(1), bytes: '1' } };
  body.resourceClosure.resources.push(beyond); body.operations[0]!.resourceIds.push(beyond.resourceId);
  assert.equal(isLocalRelocationFrozenBody(body), false);
});

test('伪装 Reader/Scanner 事实与属性 getter 不能成为计划私有信任输入', () => {
  const body = frozenBody(); const resource = body.resourceClosure.resources[0]!;
  for (const key of ['fd', 'readFacts', 'parserReceipt', 'jobId', 'batchId', 'actor', 'scanAfter']) {
    assert.equal(isLocalRelocationFrozenBody({ ...body, resourceClosure: { ...body.resourceClosure, resources: [{ ...resource, [key]: id(9) }] } }), false, key);
  }
  let calls = 0;
  const payload = { datasetId: id(1), get confirm() { calls++; return confirm(); } };
  assert.equal(isLocalRelocationMainCommandPayload('localRelocationMain.challenge', payload), false); assert.equal(calls, 0);
});
