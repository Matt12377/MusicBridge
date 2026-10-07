import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { chmod, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import * as dto from '@music-bridge/contracts';
import { catalogFixture } from '../mbrs006/catalog-fixture.js';
import { createLocalOrganizerService } from '../../src/collection/local-organizer-service.js';
import { createLocalOrganizerStore } from '../../src/collection/local-organizer-store.js';
import { createCollectionRepository } from '../../src/collection/repository.js';
import { organizerCanonical, organizerContextFingerprint, organizerHash, organizerId } from '../../src/collection/local-organizer-journal.js';
import { physicalResourceLocks } from '../../src/stream/physical-resource-locks.js';
import { stat } from 'node:fs/promises';

const confirmation = (p: dto.LocalOrganizerPlan, commandId = randomUUID()): dto.ConfirmLocalOrganizer => ({ commandId, planId: p.planId, expectedRevision: p.revision, scope: p.scope, planHash: p.planHash, contextFingerprint: p.contextFingerprint });
const serviceFor = (f: Awaited<ReturnType<typeof catalogFixture>>) => createLocalOrganizerService({ repository: f.repository, datasetId: f.datasetId, assertCurrent: () => f.repository.list({ offset: 0, limit: 1 }) });
const previewFor = (trackIds: string[], patch: dto.LocalOrganizerPatch = { fields: { title: { action: 'set', value: '仅MB名称' } } }): dto.PreviewLocalOrganizer => ({ commandId: randomUUID(), scope: 'MB_ONLY', target: { mode: 'batch', trackIds }, patch });

test('011TypeScript canonical逐字匹配原包Python golden，码点排序/无NFC/安全整数独立守卫', async () => {
  const golden = JSON.parse(await readFile(new URL('./python-canonical-golden.json', import.meta.url), 'utf8'));
  assert.equal(organizerCanonical(golden.body), golden.canonical); assert.equal(organizerHash(golden.body), 'a6f38f3bc45ee4ce7b47ca4df6b076c2057bfd6bd23ebeea3e9d9da6ecc8cb48');
  assert.equal(organizerCanonical({ '\u{10000}': 2, '\uE000': 1 }), '{"\uE000":1,"\u{10000}":2}');
  assert.notEqual(organizerHash({ value: 'é' }), organizerHash({ value: 'e\u0301' }));
  for (const bad of [1.1, NaN, Infinity, 9007199254740992, undefined, new Array(1), '\uD800']) assert.throws(() => organizerCanonical(bad));
  let calls = 0; const getter = Object.defineProperty({}, 'value', { enumerable: true, get() { calls++; return 1; } }); assert.throws(() => organizerCanonical(getter)); assert.equal(calls, 0);
});
test('011MB_ONLY六字段与注记实际持久，raw并列、扫描保留、播放读租约不受干扰、无新schema', async t => {
  const f = await catalogFixture(t), service = serviceFor(f), track = f.tracks[0]!, beforeAsset = f.repository.localCatalog.asset(track.assetId), beforeTrack = f.repository.localCatalog.track(track.id);
  const edition = f.repository.localCatalog.createEdition({ commandId: randomUUID(), title: '建议关联的独立发行', edition: '首版' });
  const fields: dto.LocalOrganizerPatch['fields'] = Object.fromEntries(['title', 'artist', 'album', 'year', 'disc', 'track'].map(key => [key, { action: 'set', value: key === 'disc' ? '侧A' : key === 'track' ? 'Bonus' : `人工${key}` }]));
  const request = previewFor([track.id], { fields, annotations: { versionDescription: { action: 'set', value: '版本说明只属于MB' }, groupingSuggestions: { action: 'set', value: [{ editionId: edition.id, expectedRevision: '1', reason: '显式建议，不合并实体' }] } } });
  const plan = await service.preview(request); assert.equal(dto.isLocalOrganizerPlan(plan), true); assert.equal(plan.items[0]!.sourceObservation.status, 'observed');
  assert.equal(plan.planHash, organizerHash(plan.body)); assert.equal(plan.contextFingerprint, organizerContextFingerprint(plan));
  assert.equal(Object.hasOwn(plan.body.operations[0]!.field_patch, 'disc_number'), false); assert.equal(Object.hasOwn(plan.body.operations[0]!.field_patch, 'track_number'), false);
  assert.deepEqual(plan.body.operations[0]!.field_patch.artists, ['人工artist']);
  assert.deepEqual(f.repository.localCatalog.metadata(track.id).override, null);
  const info = await stat(path.join(f.media, '一.wav'), { bigint: true }), readLease = physicalResourceLocks.acquireRead([{ dev: String(info.dev), ino: String(info.ino) }]);
  const bytes = await readFile(path.join(f.media, '一.wav')), requestConfirm = confirmation(plan), applied = await service.confirm(requestConfirm); await readLease.release();
  assert.equal(applied.state, 'COMPLETED'); assert.ok(applied.results.every(result => result.state === 'applied'));
  assert.deepEqual(await service.confirm(requestConfirm), applied); assert.deepEqual(await service.preview(request), applied);
  const detail = f.repository.localCatalog.trackDetail(track.id); assert.equal(detail.metadata.raw.title, '一.wav'); assert.equal(detail.metadata.effective.title, '人工title');
  assert.equal(detail.metadata.override?.annotations?.versionDescription, '版本说明只属于MB'); assert.deepEqual(detail.editions, []);
  assert.deepEqual(f.repository.localCatalog.asset(track.assetId), beforeAsset); assert.deepEqual(f.repository.localCatalog.track(track.id), beforeTrack); assert.deepEqual(await readFile(path.join(f.media, '一.wav')), bytes);
  (await f.commit(['一.wav'])).apply(); assert.equal(f.repository.localCatalog.metadata(track.id).override?.annotations?.versionDescription, '版本说明只属于MB');
  f.repository.localCatalog.overrideMetadata({ commandId: randomUUID(), trackId: track.id, expectedRevision: '1', fields: { title: '原入口再次编辑' } }); assert.equal(f.repository.localCatalog.metadata(track.id).override?.annotations?.versionDescription, '版本说明只属于MB');
  await service.close(); f.repository.close(); const reopened = createCollectionRepository({ filePath: path.join(f.directory, 'collection.sqlite') });
  assert.equal(reopened.localCatalog.metadata(track.id).override?.fields.title, '原入口再次编辑');
  assert.equal(reopened.localCatalog.privateRead(db => db.prepare('PRAGMA user_version').get()!.user_version), 34); reopened.close();
});
test('011批量commit前故障整批回滚，历史记录not-written，重试原command不重写', async t => {
  let failApply = false; const f = await catalogFixture(t, action => { if (failApply && action === 'local-organizer:apply') throw new Error('合成提交前故障'); }), service = serviceFor(f);
  const plan = await service.preview(previewFor(f.tracks.map(track => track.id))), request = confirmation(plan); failApply = true;
  const result = await service.confirm(request); assert.equal(result.state, 'FAILED'); assert.equal(result.issue, 'MB_OVERRIDE_TRANSACTION_FAILED');
  assert.ok(result.results.every(item => item.state === 'not-written')); assert.ok(f.tracks.every(track => f.repository.localCatalog.metadata(track.id).override === null));
  for (const item of plan.items) assert.equal(f.repository.localCatalog.privateReceiptRequest(item.operation.operation_id), null);
  failApply = false; assert.deepEqual(await service.confirm(request), result); assert.ok(f.tracks.every(track => f.repository.localCatalog.metadata(track.id).override === null));
  await service.close(); f.repository.close(); const reopened = createCollectionRepository({ filePath: path.join(f.directory, 'collection.sqlite') }); reopened.list({ offset: 0, limit: 1 }); reopened.close();
});
test('011外部文件、chmod、授权、raw、人工覆盖和发行成员改变逐项失效，保留后续编辑', async t => {
  for (const scenario of ['file', 'chmod', 'authorization', 'raw', 'override', 'edition-membership'] as const) await t.test(scenario, async child => {
    const f = await catalogFixture(child), service = serviceFor(f), track = f.tracks[0]!;
    let request = previewFor([track.id]);
    if (scenario === 'edition-membership') { const e = f.repository.localCatalog.createEdition({ commandId: randomUUID(), title: '单一发行', edition: '' }); f.repository.localCatalog.linkEditionTrack({ commandId: randomUUID(), editionId: e.id, trackId: track.id, disc: 1, trackNumber: 1, sequence: 1 }); request = { ...request, target: { mode: 'edition', editionId: e.id } }; }
    const plan = await service.preview(request);
    if (scenario === 'file') await writeFile(path.join(f.media, '一.wav'), Buffer.from('合成外部改写'));
    if (scenario === 'chmod') await chmod(path.join(f.media, '一.wav'), 0o400);
    if (scenario === 'authorization') f.repository.sources.revoke({ commandId: randomUUID(), id: f.source.id });
    if (scenario === 'raw') f.repository.localCatalog.observeMetadata({ commandId: randomUUID(), trackId: track.id, source: 'synthetic', parserVersion: '011合成', fields: { title: '新raw' } });
    if (scenario === 'override') f.repository.localCatalog.overrideMetadata({ commandId: randomUUID(), trackId: track.id, expectedRevision: null, fields: { title: '后续编辑' } });
    if (scenario === 'edition-membership') f.repository.localCatalog.linkEditionTrack({ commandId: randomUUID(), editionId: (request.target as { editionId: string }).editionId, trackId: f.tracks[1]!.id, disc: 1, trackNumber: 2, sequence: 2 });
    const result = await service.confirm(confirmation(plan)); assert.equal(result.state, 'FAILED'); assert.ok(result.results.every(item => item.state === 'not-written'));
    assert.equal(f.repository.localCatalog.metadata(track.id).override?.fields.title ?? null, scenario === 'override' ? '后续编辑' : null); await service.close();
  });
});
test('011SOURCE_FILES生成共享保护审查且强拒绝执行；Hash或operation_id参数复用均拒绝', async t => {
  const f = await catalogFixture(t), service = serviceFor(f), request = previewFor([f.tracks[0]!.id]), plan = await service.preview({ ...request, scope: 'SOURCE_FILES' });
  assert.equal(plan.state, 'BLOCKED'); assert.equal(plan.issue, 'SOURCE_FILES_WRITE_OFF'); assert.equal(plan.items[0]!.protection.complete, false); assert.equal(plan.items[0]!.protection.activeLease, 'unknown');
  assert.equal(plan.body.resource_guards.require_exclusive_asset_lock, true); assert.equal(plan.body.operations[0]!.backup_required, true); assert.ok(plan.body.conflicts.includes('FROZEN_PROTECTION_UNKNOWN'));
  assert.throws(() => service.confirm(confirmation(plan)), /SOURCE_FILES_WRITE_OFF/u); assert.equal(f.repository.localCatalog.metadata(f.tracks[0]!.id).override, null);
  const mb = await service.preview(previewFor([f.tracks[0]!.id])); assert.throws(() => service.confirm({ ...confirmation(mb), planHash: 'c'.repeat(64) }), /Hash/u);
  await assert.rejects(async () => service.preview({ ...request, scope: 'MB_ONLY' }));
  const cancelled = service.cancel({ commandId: randomUUID(), planId: mb.planId, expectedRevision: mb.revision }); assert.equal(cancelled.state, 'CANCELLED');
  assert.throws(() => service.confirm(confirmation(cancelled))); await service.close();
});
test('011undo先生成反向预览，确认后恢复完整before，不删除override，后续编辑CAS拒绝', async t => {
  const f = await catalogFixture(t), service = serviceFor(f), track = f.tracks[0]!;
  const applied = await service.confirm(confirmation(await service.preview(previewFor([track.id], { fields: {}, annotations: { versionDescription: { action: 'set', value: '只修改注记也有合法冻结patch' } } }))));
  const undo = await service.undo({ commandId: randomUUID(), planId: applied.planId, expectedRevision: applied.revision });
  assert.equal(undo.state, 'DRAFT'); assert.equal(f.repository.localCatalog.metadata(track.id).override?.annotations?.versionDescription, '只修改注记也有合法冻结patch'); assert.equal(undo.body.operations[0]!.field_patch.title, null);
  const reverted = await service.confirm(confirmation(undo)); assert.equal(reverted.state, 'COMPLETED'); assert.equal(service.get({ planId: applied.planId }).state, 'ROLLED_BACK');
  assert.deepEqual(f.repository.localCatalog.metadata(track.id).override, { trackId: track.id, revision: '2', fields: {}, annotations: {} });
  assert.throws(() => service.confirm(confirmation({ ...undo, revision: reverted.revision })));
  const nextApplied = await service.confirm(confirmation(await service.preview(previewFor([track.id]))));
  f.repository.localCatalog.overrideMetadata({ commandId: randomUUID(), trackId: track.id, expectedRevision: '3', fields: { title: '后续人工编辑' } });
  await assert.rejects(() => service.undo({ commandId: randomUUID(), planId: nextApplied.planId, expectedRevision: nextApplied.revision })); assert.equal(f.repository.localCatalog.metadata(track.id).override?.fields.title, '后续人工编辑');
  await service.close(); f.repository.close(); const reopened = createCollectionRepository({ filePath: path.join(f.directory, 'collection.sqlite') }); reopened.list({ offset: 0, limit: 1 }); reopened.close();
});
test('011持久确认后冷开只对账到RECOVERY_REQUIRED，显式新确认重读CAS，原command重试不重放', async t => {
  const f = await catalogFixture(t), service = serviceFor(f), track = f.tracks[0]!, plan = await service.preview(previewFor([track.id])), request = confirmation(plan);
  const store = createLocalOrganizerStore({ catalog: f.repository.localCatalog, sources: f.repository.sources, datasetId: f.datasetId, assertCurrent() {} });
  const confirmed = store.confirm(request, plan.items.map(item => item.sourceObservation), Date.now()); assert.equal(confirmed.state, 'CONFIRMED');
  await service.close(); f.repository.close(); const repository = createCollectionRepository({ filePath: path.join(f.directory, 'collection.sqlite') });
  const cold = createLocalOrganizerService({ repository, datasetId: f.datasetId, assertCurrent() {} });
  const recovery = cold.get({ planId: plan.planId }); assert.equal(recovery.state, 'RECOVERY_REQUIRED'); assert.equal(repository.localCatalog.metadata(track.id).override, null);
  assert.equal((await cold.confirm(request)).state, 'RECOVERY_REQUIRED'); assert.equal(repository.localCatalog.metadata(track.id).override, null);
  const completed = await cold.confirm(confirmation(recovery)); assert.equal(completed.state, 'COMPLETED'); assert.equal(repository.localCatalog.metadata(track.id).override?.revision, '1');
  assert.equal(organizerId(plan.planId, 'operation/0'), completed.results[0]!.operationId); await cold.close(); repository.close();
});
test('011恢复预算保留正式撤销修订，29确认零写入拒绝、27完成后仍可撤销并冷开', async t => {
  const f = await catalogFixture(t), service = serviceFor(f);
  const store = createLocalOrganizerStore({ catalog: f.repository.localCatalog, sources: f.repository.sources, datasetId: f.datasetId, assertCurrent() {} });
  const interrupt = (plan: dto.LocalOrganizerPlan, cycles: number): dto.LocalOrganizerPlan => {
    let current = plan;
    for (let index = 0; index < cycles; index++) {
      const confirmed = store.confirm(confirmation(current), current.items.map(item => item.sourceObservation), Date.now());
      assert.equal(confirmed.state, 'CONFIRMED'); assert.equal(confirmed.revision, String(2 + 2 * index));
      current = store.get(plan.planId, true);
      assert.equal(current.state, 'RECOVERY_REQUIRED'); assert.equal(current.revision, String(3 + 2 * index));
    }
    return current;
  };
  try {
    const exhausted = interrupt(await service.preview(previewFor([f.tracks[0]!.id])), 14), rejected = confirmation(exhausted);
    const ledger = () => f.repository.localCatalog.privateRead(db => db.prepare('SELECT command_id,operation,request,result FROM local_catalog_ledger ORDER BY rowid').all());
    const before = ledger(); assert.equal(exhausted.revision, '29');
    await assert.rejects(async () => service.confirm(rejected), /预算/u);
    assert.deepEqual(service.get({ planId: exhausted.planId }), exhausted); assert.deepEqual(ledger(), before);
    assert.equal(f.repository.localCatalog.metadata(f.tracks[0]!.id).override, null);
    for (const item of exhausted.items) assert.equal(f.repository.localCatalog.privateReceiptRequest(item.operation.operation_id), null);
    const admitted = interrupt(await service.preview(previewFor([f.tracks[1]!.id])), 13);
    assert.equal(admitted.revision, '27');
    const applied = await service.confirm(confirmation(admitted)); assert.equal(applied.state, 'COMPLETED'); assert.equal(applied.revision, '30');
    const undo = await service.undo({ commandId: randomUUID(), planId: applied.planId, expectedRevision: applied.revision });
    assert.equal((await service.confirm(confirmation(undo))).state, 'COMPLETED');
    const original = service.get({ planId: applied.planId }); assert.equal(original.state, 'ROLLED_BACK'); assert.equal(original.revision, '31');
    assert.deepEqual(f.repository.localCatalog.metadata(f.tracks[1]!.id).override, { trackId: f.tracks[1]!.id, revision: '2', fields: {}, annotations: {} });
    await service.close(); f.repository.close();
    const repository = createCollectionRepository({ filePath: path.join(f.directory, 'collection.sqlite') });
    const cold = createLocalOrganizerService({ repository, datasetId: f.datasetId, assertCurrent() {} });
    try {
      assert.equal(cold.get({ planId: exhausted.planId }).revision, '29');
      assert.equal(cold.get({ planId: applied.planId }).state, 'ROLLED_BACK');
      assert.equal(cold.get({ planId: applied.planId }).revision, '31');
      assert.equal(repository.localCatalog.privateRead(db => db.prepare('PRAGMA user_version').get()!.user_version), 34);
    } finally { await cold.close(); repository.close(); }
  } finally { await service.close(); }
});
test('011合成换datasetId后历史仅返回当前工作库计划，旧计划执行拒绝且原日志保留', async t => {
  const f = await catalogFixture(t), service = serviceFor(f), trackId = f.tracks[0]!.id;
  const old = await service.preview(previewFor([trackId]));
  const readJournal = (repository: ReturnType<typeof createCollectionRepository>) => repository.localCatalog.privateRead(db => String(db.prepare('SELECT request FROM local_catalog_ledger WHERE command_id=?').get(old.planId)!.request));
  const preserved = readJournal(f.repository); await service.close(); f.repository.close();
  const repository = createCollectionRepository({ filePath: path.join(f.directory, 'collection.sqlite') }), datasetId = randomUUID();
  const cold = createLocalOrganizerService({ repository, datasetId, assertCurrent: () => repository.list({ offset: 0, limit: 1 }) });
  try {
    assert.deepEqual(cold.history({ offset: 0, limit: 10 }), { offset: 0, limit: 10, total: 0, items: [] });
    assert.throws(() => cold.get({ planId: old.planId }), /工作库/u);
    assert.throws(() => cold.confirm(confirmation(old)), /工作库/u);
    assert.equal(repository.localCatalog.metadata(trackId).override, null);
    const fresh = await cold.preview(previewFor([trackId])), applied = await cold.confirm(confirmation(fresh));
    assert.equal(applied.state, 'COMPLETED'); assert.equal(applied.datasetId, datasetId);
    const history = cold.history({ offset: 0, limit: 10 }); assert.equal(history.total, 1); assert.deepEqual(history.items.map(item => item.planId), [fresh.planId]);
    assert.equal(readJournal(repository), preserved);
  } finally { await cold.close(); repository.close(); }
});
test('011未知COMMIT不落伪成功或伪失败，封口旧owner；实际SQLite冷开只按原回执对账', async t => {
  for (const commitActuallyHappened of [false, true]) await t.test(commitActuallyHappened ? 'COMMIT后抛错' : 'COMMIT前抛错', async child => {
    let armed = false; const f = await catalogFixture(child, action => { if (action === 'local-organizer:apply') armed = true; }), service = serviceFor(f);
    const plan = await service.preview(previewFor(f.tracks.map(track => track.id))), request = confirmation(plan);
    f.repository.localCatalog.privateRead(db => { const exec = db.exec.bind(db); db.exec = (sql: string) => { if (armed && sql === 'COMMIT') { armed = false; if (commitActuallyHappened) exec(sql); throw new Error('合成未知提交返回'); } return exec(sql); }; });
    await assert.rejects(() => service.confirm(request)); assert.throws(() => f.repository.localCatalog.metadata(f.tracks[0]!.id)); await assert.rejects(() => service.close()); f.repository.close();
    const repository = createCollectionRepository({ filePath: path.join(f.directory, 'collection.sqlite') }), cold = createLocalOrganizerService({ repository, datasetId: f.datasetId, assertCurrent() {} });
    const recovered = cold.get({ planId: plan.planId }); assert.equal(recovered.state, commitActuallyHappened ? 'COMPLETED' : 'RECOVERY_REQUIRED');
    assert.ok(recovered.results.every(result => result.state === (commitActuallyHappened ? 'applied' : 'not-written')));
    for (const track of f.tracks) assert.equal(repository.localCatalog.metadata(track.id).override?.revision ?? null, commitActuallyHappened ? '1' : null);
    assert.equal((await cold.confirm(request)).state, recovered.state); await cold.close(); repository.close();
  });
});
