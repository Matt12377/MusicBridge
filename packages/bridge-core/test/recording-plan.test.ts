import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { writeFile, readFile, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createCollectionRepository } from '../src/collection/repository.js';
import { createRecordingPlanCoordinator } from '../src/recording/plan-coordinator.js';
import { recordingPlanContent, verifyRecordingPlanDatabase } from '../src/recording/plan-integrity.js';
import { archiveObjectPath } from '../src/recording/archive-files.js';
import { createRecordingPlanStore } from '../src/recording/plan-store.js';
import { mediaFingerprint } from '../src/recording/media-store.js';
import * as dto from '@music-bridge/contracts';
import { recordingPlanFixture as fixture } from './helpers/recording-plan-fixture.js';

function facts(filePath: string) {
  const db = new DatabaseSync(filePath, { readOnly: true });
  try { return db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT GLOB 'sqlite_*' AND name NOT GLOB 'recording_plan*' AND name NOT GLOB 'recording_attempt*' AND name NOT GLOB 'recording_record*' AND name NOT GLOB 'recording_print*' AND name NOT GLOB 'master_artwork*' AND name<>'recording_profile_snapshots' ORDER BY name").all().map(({ name }) => [name, db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all()]); }
  finally { db.close(); }
}

test('Plan预览、冻结、预检不改库存或旧事实；无GateB明确阻断而非正式就绪', async t => {
  const f = await fixture(t), before = facts(f.filePath);
  const proposal = await f.planPreview();
  assert.equal(proposal.formalReady, false);
  assert.deepEqual(facts(f.filePath), before);
  const plan = await f.plans.freeze(await f.planRequest());
  assert.equal(plan.formalReady, false);
  assert.equal((await f.plans.version({ id: plan.id })).plan?.id, plan.id);
  const result = await f.plans.preflight({ planVersionId: plan.id, readId: randomUUID() });
  assert.equal(result.formalReady, false);
  assert.match(JSON.stringify(result), /BACKEND_NOT_CERTIFIED/);
  assert.equal(result.checks.filter(check => check.state === 'passed').length, 7);
  assert.equal(dto.isRecordingPreflightResult(result), true);
  assert.deepEqual(facts(f.filePath), before);
});

test('Plan同命令精确重放，异body拒绝；第二命令不能复用旧proposal生成另一版本', async t => {
  const f = await fixture(t), request = await f.planRequest();
  const original = await f.plans.freeze(request);
  assert.deepEqual(await f.plans.freeze(request), original);
  await assert.rejects(f.plans.freeze({ ...request, proposalFingerprint: 'f'.repeat(64) }));
  await assert.rejects(f.plans.freeze({ ...request, commandId: randomUUID() }));
  assert.equal(f.plans.list({ draftId: f.draft.draftId }).versions.length, 1);
});

test('preview后会话、实体可用性或预留变化均拒绝冻结，不能凭旧确认写Plan', async t => {
  const f = await fixture(t), request = await f.planRequest();
  f.repository.recordingProfiles.saveSession({ commandId: randomUUID(), draftId: f.draft.draftId, expectedRevision: 1, profileVersionId: f.profile.id, overrides: { recordLevel: '新电平' }, userConfirmed: true });
  await assert.rejects(f.plans.freeze(request));
  const updated = await f.planRequest();
  const copy = f.repository.detail(f.plan.reservation!.modelId, { offset: 0, limit: 25 }).copies.items.find(c => c.physicalId === f.plan.reservation!.physicalId)!;
  f.repository.updateCopy({ commandId: randomUUID(), physicalId: copy.physicalId, expectedRevision: copy.revision, action: 'mark-unavailable' });
  await assert.rejects(f.plans.freeze(updated));
});

test('Direct当前源改变必须拒绝；归档存在不能冒充仍精确的当前源', async t => {
  const f = await fixture(t), request = await f.planRequest();
  await writeFile(f.file, '合成源已变化');
  await assert.rejects(f.plans.freeze(request));
});

test('Prepared计划读取原始Render与精确谱系，冻结不再次插入Gap', async t => {
  const f = await fixture(t, true), before = facts(f.filePath);
  const plan = await f.plans.freeze(await f.planRequest());
  assert.equal(plan.formalReady, false);
  assert.deepEqual(facts(f.filePath), before);
  assert.match(JSON.stringify(plan), /prepared-reference/);
});

test('当前Session overrides形成新Plan快照，旧asset与旧Plan保持原值；旧Plan预检不使用后来参数', async t => {
  const f = await fixture(t), originalAsset = f.repository.execution.asset(f.planSelection.assetId)!;
  const first = await f.plans.freeze(await f.planRequest());
  const overrides = { recordLevel: '明确改变电平', noiseReduction: null, calibration: '本次校准', signalChain: f.profile.content.signalChain };
  f.repository.recordingProfiles.saveSession({ commandId: randomUUID(), draftId: f.draft.draftId, expectedRevision: 1, profileVersionId: f.profile.id, overrides, userConfirmed: true });
  const second = await f.plans.freeze(await f.planRequest());
  assert.equal(second.parentId, first.id); assert.equal(second.sequence, 2);
  assert.equal(second.profileSnapshot.sessionRevision, 2);
  assert.deepEqual(second.profileSnapshot.settings.overrides, overrides);
  assert.deepEqual(second.execution.compiledSettings, originalAsset.settings);
  assert.deepEqual(f.repository.execution.asset(originalAsset.id), originalAsset);
  assert.deepEqual(f.plans.version({ id: first.id }).plan, first);
  const result = await f.plans.preflight({ planVersionId: first.id, readId: randomUUID() });
  assert.equal(result.checks.find(c => c.category === 'profile')?.state, 'passed');
});

test('同内容规划仅增加revision时预检归类版本失配，旧Plan与库存保持不变', async t => {
  const f = await fixture(t), request = await f.planRequest(), original = await f.plans.freeze(request);
  const history = f.plans.list({ draftId: original.draftId });
  const preview = await f.media.preview({ draftId: original.draftId, spec: f.layout.spec, page: { offset: 0, limit: 25 } });
  const updated = await f.media.save({ commandId: randomUUID(), draftId: original.draftId, planId: f.plan.id, expectedRevision: f.plan.revision, expectedDraftRevision: preview.draftRevision, inputFingerprint: preview.inputFingerprint, spec: f.layout.spec });
  assert.equal(updated.revision, original.mediaPlanRevision + 1);
  assert.deepEqual(updated.reservation, f.plan.reservation);
  const current = f.repository.recordingPlans.capture(f.planSelection, original.profileSnapshot);
  assert.deepEqual(current.material, { ...recordingPlanContent(original), mediaPlanRevision: updated.revision }, '重存后仅规划revision变化，实体、参数和容量没有变化');
  const before = facts(f.filePath);
  const result = await f.plans.preflight({ readId: randomUUID(), planVersionId: original.id });
  assert.deepEqual(result.checks.filter(check => check.state === 'blocked'), [{ category: 'versions', state: 'blocked', code: 'VERSION_MISMATCH' }]);
  assert.equal(result.state, 'blocked'); assert.equal(result.formalReady, false);
  assert.deepEqual(f.plans.list({ draftId: original.draftId }), history);
  assert.deepEqual(await f.plans.freeze(request), original, '旧命令仍返回原不可变回执，不生成新准入');
  assert.deepEqual(facts(f.filePath), before);

  f.repository.updateCopy({ commandId: randomUUID(), physicalId: original.physicalCopy.physicalId, expectedRevision: original.physicalCopy.revision, action: 'mark-unavailable' });
  const unavailableFacts = facts(f.filePath);
  const unavailable = await f.plans.preflight({ readId: randomUUID(), planVersionId: original.id });
  assert.deepEqual(unavailable.checks.find(check => check.category === 'physical-copy'), { category: 'physical-copy', state: 'blocked', code: 'COPY_UNAVAILABLE' }, '同时存在规划revision差异时，真实副本失效仍保留原分类');
  assert.deepEqual(f.plans.list({ draftId: original.draftId }), history);
  assert.deepEqual(facts(f.filePath), unavailableFacts);
});

test('已冻结历史不回填当前副本，预留释放或副本不可用后预检明确阻断', async t => {
  const f = await fixture(t), request = await f.planRequest(), plan = await f.plans.freeze(request);
  const copy = plan.physicalCopy;
  f.repository.updateCopy({ commandId: randomUUID(), physicalId: copy.physicalId, expectedRevision: copy.revision, action: 'mark-unavailable' });
  const result = await f.plans.preflight({ planVersionId: plan.id, readId: randomUUID() });
  assert.deepEqual(result.checks.find(c => c.category === 'physical-copy'), { category: 'physical-copy', state: 'blocked', code: 'COPY_UNAVAILABLE' });
  assert.deepEqual(await f.plans.freeze(request), plan, '历史命令回放不受后来依赖变化改写');
  assert.deepEqual(f.plans.version({ id: plan.id }).plan, plan);
});

test('冻结await期间Session变化不写计划；取消及关闭拒绝迟到结果且不写库存', async t => {
  let mutate = false;
  const f = await fixture(t, false, { afterVerification: async () => {
    if (mutate) { mutate = false; f.repository.recordingProfiles.saveSession({ commandId: randomUUID(), draftId: f.draft.draftId, expectedRevision: 1, profileVersionId: f.profile.id, overrides: { recordLevel: '核验期间改变' }, userConfirmed: true }); }
  } });
  const request = await f.planRequest(); mutate = true;
  await assert.rejects(f.plans.freeze(request));
  assert.equal(f.plans.list({ draftId: f.draft.draftId }).versions.length, 0);
  const id = randomUUID(); f.plans.cancelRead({ id });
  await assert.rejects(f.plans.preview({ selection: f.planSelection, readId: id }));
  await f.plans.close();
  await assert.rejects(f.plans.preview({ selection: f.planSelection, readId: randomUUID() }));
});

test('归档需FINALIZED，已冻结后对象损坏不能复用历史verified判据', async t => {
  const f = await fixture(t), db = new DatabaseSync(f.filePath); t.after(() => db.close());
  db.prepare("UPDATE archive_operations SET phase='DB_COMMITTED' WHERE id=?").run(f.archiveRequest.commandId);
  await assert.rejects(f.planPreview());
  db.prepare("UPDATE archive_operations SET phase='FINALIZED' WHERE id=?").run(f.archiveRequest.commandId);
  const plan = await f.plans.freeze(await f.planRequest());
  const object = f.repository.archive.operation(f.archiveRequest.commandId)!.owned!;
  await writeFile(archiveObjectPath(object.archive, object.files[0]!.sha256), '归档内容损坏');
  const result = await f.plans.preflight({ planVersionId: plan.id, readId: randomUUID() });
  assert.equal(result.checks.find(c => c.category === 'archive')?.code, 'ARCHIVE_INVALID');
});

test('freeze提交故障使版本与ledger一并回滚；冷开历史与只读完整性核验保持不变', async t => {
  const f = await fixture(t), request = await f.planRequest();
  let fail = true;
  const repository = createCollectionRepository({ filePath: f.filePath, beforeCommit: action => { if (fail && action === 'freeze-recording-plan') throw new Error('合成提交中断'); } });
  const plans = createRecordingPlanCoordinator({ store: repository.recordingPlans });
  t.after(async () => { await plans.close(); repository.close(); });
  await assert.rejects(plans.freeze(request));
  assert.equal(plans.list({ draftId: f.draft.draftId }).versions.length, 0);
  fail = false; const plan = await plans.freeze(request);
  await plans.close(); repository.close();
  const reopened = createCollectionRepository({ filePath: f.filePath }); t.after(() => reopened.close());
  assert.deepEqual(reopened.recordingPlans.version({ id: plan.id }).plan, plan);
  const db = new DatabaseSync(f.filePath); t.after(() => db.close());
  const before = facts(f.filePath); verifyRecordingPlanDatabase(db); assert.deepEqual(facts(f.filePath), before);
  assert.throws(() => db.prepare('UPDATE recording_plan_versions SET data=? WHERE id=?').run('{}', plan.id));
  db.exec('DROP TRIGGER recording_plan_versions_no_update');
  assert.throws(() => verifyRecordingPlanDatabase(db));
});

test('历史响应预算在冻结前按实际UTF8字节拒绝，已保存历史完整可读不被截断', async t => {
  const f = await fixture(t), first = await f.plans.freeze(await f.planRequest());
  const history = f.plans.list({ draftId: first.draftId }), bytes = Buffer.byteLength(JSON.stringify(history));
  const db = new DatabaseSync(f.filePath); t.after(() => db.close());
  const store = createRecordingPlanStore({ read: fn => fn(db), conflict: message => { throw new Error(message); }, historyBudgetBytes: bytes + 1 });
  const plans = createRecordingPlanCoordinator({ store }); t.after(() => plans.close());
  const request = await f.planRequest();
  await assert.rejects(plans.freeze(request), /历史.*预算/);
  assert.deepEqual(plans.list({ draftId: first.draftId }), history);
  assert.equal(dto.isRecordingPlanHistory(history), true);
  assert.equal(db.prepare('SELECT count(*) n FROM recording_plan_ledger').get()!.n, 1);
});

test('只读完整性核验重算ProfileSnapshot而不信重签的Plan摘要', async t => {
  const f = await fixture(t), plan = await f.plans.freeze(await f.planRequest());
  const db = new DatabaseSync(f.filePath); t.after(() => db.close());
  const corrupt = structuredClone(plan);
  corrupt.profileSnapshot.settings.fingerprint = 'f'.repeat(64);
  const { id, draftId, sequence, parentId, createdAt, contentHash, status, ...material } = corrupt;
  corrupt.contentHash = mediaFingerprint(material);
  const trigger = db.prepare("SELECT sql FROM sqlite_schema WHERE name='recording_plan_versions_no_update'").get()!.sql;
  db.exec('DROP TRIGGER recording_plan_versions_no_update');
  db.prepare('UPDATE recording_plan_versions SET data=? WHERE id=?').run(JSON.stringify(corrupt), plan.id);
  db.exec(String(trigger));
  assert.throws(() => verifyRecordingPlanDatabase(db));
});

test('当前会话缺失不能回退asset设置；预检对冻结快照不依赖后来session', async t => {
  const f = await fixture(t), plan = await f.plans.freeze(await f.planRequest());
  const db = new DatabaseSync(f.filePath); t.after(() => db.close());
  db.prepare('DELETE FROM recording_sessions WHERE draft_id=?').run(plan.draftId);
  await assert.rejects(f.planPreview(), /PROFILE_MISMATCH/);
  const result = await f.plans.preflight({ planVersionId: plan.id, readId: randomUUID() });
  assert.equal(result.checks.find(c => c.category === 'profile')!.state, 'passed');
});

test('实际在途取消丢弃迟到结果；同command并发仅保存一版且不允许只读取消写入', async t => {
  let entered!: () => void, release!: () => void;
  let held: Promise<void> | undefined;
  const f = await fixture(t, false, { afterVerification: async () => { entered?.(); await held; } });
  const request = await f.planRequest();
  let reached = new Promise<void>(resolve => { entered = resolve; });
  held = new Promise<void>(resolve => { release = resolve; });
  const readId = randomUUID(), pending = f.plans.preview({ readId, selection: f.planSelection });
  await reached; f.plans.cancelRead({ id: readId }); release(); await assert.rejects(pending);
  reached = new Promise<void>(resolve => { entered = resolve; });
  held = new Promise<void>(resolve => { release = resolve; });
  const one = f.plans.freeze(request), two = f.plans.freeze(request);
  await reached; assert.throws(() => f.plans.cancelRead({ id: request.commandId })); release();
  assert.deepEqual(await one, await two);
  assert.equal(f.plans.list({ draftId: f.draft.draftId }).versions.length, 1);
});

test('固定schema17迁移失败完整回滚；重试21逐列保留旧事实', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'musicbridge-plan-migrate-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'collection.sqlite'), db = new DatabaseSync(filePath);
  db.exec(await readFile(new URL('./fixtures/collection-schema17.sql', import.meta.url), 'utf8')); db.close();
  const before = facts(filePath);
  const failed = createCollectionRepository({ filePath, beforeCommit: action => { if (action === 'migrate-recording-plans') throw new Error('迁移中断'); } });
  assert.throws(() => failed.recordingPlans.list({ draftId: randomUUID() })); failed.close();
  const check = new DatabaseSync(filePath); assert.equal(check.prepare('PRAGMA user_version').get()!.user_version, 17); check.close();
  assert.deepEqual(facts(filePath), before);
  const repository = createCollectionRepository({ filePath }); t.after(() => repository.close());
  repository.recordingPlans.version({ id: randomUUID() });
  const migrated = new DatabaseSync(filePath, { readOnly: true }); t.after(() => migrated.close());
  assert.equal(migrated.prepare('PRAGMA user_version').get()!.user_version, 21);
  verifyRecordingPlanDatabase(migrated); assert.deepEqual(facts(filePath), before);
});

test('发布文件完整但任务非completed也不能冻结；归档统计不能被重签Plan伪造', async t => {
  const f = await fixture(t), plan = await f.plans.freeze(await f.planRequest());
  const db = new DatabaseSync(f.filePath); t.after(() => db.close());
  const job = JSON.parse(String(db.prepare('SELECT data FROM execution_jobs WHERE id=?').get(plan.execution.assetId)!.data));
  db.exec('DROP TRIGGER execution_jobs_completed_no_update'); job.public.state = 'failed';
  db.prepare('UPDATE execution_jobs SET data=? WHERE id=?').run(JSON.stringify(job), plan.execution.assetId);
  await assert.rejects(f.planPreview(), /EXECUTION_INVALID/);
  const corrupt = structuredClone(plan); corrupt.archive.copyBytes += 1;
  const { id, draftId, sequence, parentId, createdAt, contentHash, status, ...material } = corrupt;
  corrupt.contentHash = mediaFingerprint(material);
  const trigger = db.prepare("SELECT sql FROM sqlite_schema WHERE name='recording_plan_versions_no_update'").get()!.sql;
  db.exec('DROP TRIGGER recording_plan_versions_no_update'); db.prepare('UPDATE recording_plan_versions SET data=? WHERE id=?').run(JSON.stringify(corrupt), plan.id); db.exec(String(trigger));
  assert.throws(() => verifyRecordingPlanDatabase(db));
});

for (const change of ['track-order', 'program-type'] as const) test(`同planId按相同spec更新${change}后不能拼接旧M/L，旧Plan历史保留且预检报版本不一致`, async t => {
  const f = await fixture(t), request = await f.planRequest(), original = await f.plans.freeze(request);
  const draft = f.repository.drafts.detail(f.draft.draftId);
  const update = { commandId: randomUUID(), draftId: draft.id, expectedRevision: draft.revision, title: draft.title, programType: change === 'program-type' ? 'continuous' as const : draft.programType, trackIds: change === 'track-order' ? draft.tracks.map(track => track.id).reverse() : draft.tracks.map(track => track.id) };
  f.repository.drafts.update(update, mediaFingerprint(update));
  const preview = await f.media.preview({ draftId: draft.id, spec: f.layout.spec, page: { offset: 0, limit: 25 } });
  const updated = await f.media.save({ commandId: randomUUID(), draftId: draft.id, planId: f.plan.id, expectedRevision: f.plan.revision, expectedDraftRevision: preview.draftRevision, inputFingerprint: preview.inputFingerprint, spec: f.layout.spec });
  assert.deepEqual(updated.reservation, f.plan.reservation);
  const before = facts(f.filePath);
  await assert.rejects(f.planPreview(), /VERSION_MISMATCH/);
  await assert.rejects(f.plans.freeze({ ...request, commandId: randomUUID() }), /VERSION_MISMATCH/);
  const result = await f.plans.preflight({ readId: randomUUID(), planVersionId: original.id });
  assert.deepEqual(result.checks.find(check => check.category === 'versions'), { category: 'versions', state: 'blocked', code: 'VERSION_MISMATCH' });
  assert.deepEqual(f.plans.version({ id: original.id }).plan, original);
  assert.deepEqual(await f.plans.freeze(request), original);
  assert.deepEqual(facts(f.filePath), before);
});

test('草稿仅改显示标题且当前内容相同，可明确选择非最新M/L资产而不重命名旧Master', async t => {
  const f = await fixture(t), proposal = await f.versions.preview({ planId: f.plan.id, sampleRate: 48000 });
  const job = await f.versions.freeze({ commandId: randomUUID(), planId: f.plan.id, sampleRate: 48000, proposalFingerprint: proposal.proposalFingerprint, userConfirmed: true });
  await f.versions.idle();
  assert.notEqual(f.versions.job(job.id).job!.layoutVersionId, f.layout.id);
  const draft = f.repository.drafts.detail(f.draft.draftId);
  const update = { commandId: randomUUID(), draftId: draft.id, expectedRevision: draft.revision, title: '仅改变工作区显示标题', programType: draft.programType, trackIds: draft.tracks.map(track => track.id) };
  f.repository.drafts.update(update, mediaFingerprint(update));
  const preview = await f.media.preview({ draftId: draft.id, spec: f.layout.spec, page: { offset: 0, limit: 25 } });
  await f.media.save({ commandId: randomUUID(), draftId: draft.id, planId: f.plan.id, expectedRevision: f.plan.revision, expectedDraftRevision: preview.draftRevision, inputFingerprint: preview.inputFingerprint, spec: f.layout.spec });
  const plan = await f.plans.freeze(await f.planRequest());
  assert.equal(plan.layout.id, f.layout.id);
  assert.equal(plan.master.id, f.master.id);
  assert.equal(plan.master.title, f.master.title);
});

test('DAT计划使用完整Program容量而非半面，当前预检不操作实体或输出后端', async t => {
  const f = await fixture(t, false, { format: 'dat' }), before = facts(f.filePath);
  const plan = await f.plans.freeze(await f.planRequest());
  assert.deepEqual(plan.layout.timeline.sides.map(side => side.name), ['Program']);
  assert.equal(plan.layout.timeline.sides[0]!.capacityFrames, plan.physicalCopy.lengthMinutes! * 60 * plan.layout.timeline.sampleRate);
  assert.equal(plan.execution.recipes[0]!.capacityFrames, plan.physicalCopy.lengthMinutes! * 60 * plan.profileSnapshot.settings.format.sampleRate);
  const result = await f.plans.preflight({ planVersionId: plan.id, readId: randomUUID() });
  assert.deepEqual(result.checks.find(check => check.category === 'capacity'), { category: 'capacity', state: 'passed' });
  assert.equal(result.formalReady, false); assert.deepEqual(facts(f.filePath), before);
});
