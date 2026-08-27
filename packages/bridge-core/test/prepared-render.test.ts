import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { createCollectionRepository } from '../src/collection/repository.js';
import { mkdir, readdir, writeFile, readFile, unlink } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { preparationFixture } from './helpers/preparation-fixture.js';
import { createPreparationCoordinator } from '../src/recording/preparation-coordinator.js';
import { createPreparedCoordinator } from '../src/recording/prepared-coordinator.js';
import { isPreparedHistory, isPreparedImportProposal, isFrozenPrepared, type RenderAssessment } from '@music-bridge/contracts';
import { copyPreparationFile } from '../src/recording/preparation-files.js';
import { preparedCompatibility } from '../src/recording/render-conformance.js';

function wav(frames: number, sampleRate: number): Buffer {
  const b = Buffer.alloc(44 + frames * 4); b.write('RIFF'); b.writeUInt32LE(b.length - 8, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(2, 22); b.writeUInt32LE(sampleRate, 24); b.writeUInt32LE(sampleRate * 4, 28); b.writeUInt16LE(4, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(b.length - 44, 40); return b;
}
async function fixture(t: test.TestContext, beforeCommit?: (action: string) => void, hooks: Pick<Parameters<typeof createPreparedCoordinator>[0], 'copy' | 'afterPublish'> = {}, format: 'cassette' | 'dat' = 'cassette', emptyB = false) {
  const f = await preparationFixture(t, { format, emptyB, ...(beforeCommit ? { beforeCommit } : {}) }), version = await f.freeze(); await f.versions.idle();
  const { master, layout } = f.repository.preparations.frozen(f.versions.job(version.id).job!.layoutVersionId!);
  const preparation = createPreparationCoordinator({ store: f.repository.preparations, sourceStore: f.repository.sources, sources: f.sources });
  const destinationPath = path.join(f.directory, 'target'); await mkdir(destinationPath);
  const destination = await preparation.authorize(randomUUID(), destinationPath);
  const proposal = await preparation.preview({ layoutVersionId: layout.id, destinationId: destination.id });
  const pj = await preparation.start({ commandId: randomUUID(), layoutVersionId: layout.id, destinationId: destination.id, proposalFingerprint: proposal.proposalFingerprint, userConfirmed: true }); await preparation.idle();
  const preparationId = preparation.job(pj.id).job!.workspaceId!; assert.ok(preparationId);
  const prepared = createPreparedCoordinator({ store: f.repository.prepared, preparationStore: f.repository.preparations, preparation, sourceStore: f.repository.sources, ...hooks });
  t.after(async () => { await prepared.close(); await preparation.close(); });
  const selections = [], originalFiles = [];
  for (const side of layout.timeline.sides.filter(s => s.tracks.length > 0)) {
    const file = path.join(f.directory, `final-${side.name}.wav`), bytes = wav(side.totalFrames, layout.timeline.sampleRate); await writeFile(file, bytes); originalFiles.push({ file, bytes });
    selections.push(await prepared.select({ commandId: randomUUID(), preparationId, side: side.name }, file));
  }
  return { ...f, preparation, prepared, preparationId, destination, destinationPath, master, layout, selections, originalFiles };
}
async function startRequest(f: Awaited<ReturnType<typeof fixture>>) {
  const request = { preparationId: f.preparationId, destinationId: f.destination.id, selectionIds: f.selections.map(s => s.id) }, proposal = await f.prepared.previewImport(request);
  return { ...request, commandId: randomUUID(), proposalFingerprint: proposal.proposalFingerprint, userConfirmed: true as const };
}
function reviewRequest(f: Awaited<ReturnType<typeof fixture>>, id: string) {
  const done = f.prepared.job(id).job!;
  const assessment: RenderAssessment = { structureChanged: false, acceptVariance: false, varianceReason: '', timeline: { timebase: 'sample-frames', sides: f.layout.timeline.sides.map(s => { const a = done.assets!.find(a => a.side === s.name); if (!a) return { name: s.name, renderAssetId: null, renderFileHash: null, sampleRate: f.layout.timeline.sampleRate, channelLayout: 'none', totalFrames: 0, markers: [] }; return { name: s.name, renderAssetId: a.id, renderFileHash: a.sha256, sampleRate: a.sampleRate, channelLayout: 'stereo', totalFrames: a.totalFrames, markers: s.tracks.map(m => ({ trackId: m.trackId, exactSourceSha256: f.master.content.tracks.find(c => c.trackId === m.trackId)!.source.sha256, actualStartFrame: m.startFrame, actualEndFrame: m.endFrame, actualGapToNextFrames: m.gapAfterFrames, confirmationMethod: 'manual', userConfirmed: true })) } }) } };
  return { importJobId: id, assessment, daw: 'Logic 合成验证', processingLineage: '人工确认曲序及 Marker；不重复插入 Gap。' };
}

test('Prepared 历史初始为空，Preparation 工作区不能自动冒充已验收的 PREP', t => {
  const repository = createCollectionRepository({ filePath: ':memory:' }); t.after(() => repository.close());
  const draft = repository.drafts.append({ commandId: randomUUID(), fingerprint: 'a'.repeat(64), title: 'PREP 合成草稿', programType: 'compilation', metadata: [{ title: '合成曲目' }] });
  assert.ok('prepared' in repository, 'Frozen PREP 必须有独立的持久化版本仓库');
  const store = (repository as unknown as { prepared: { list(draftId: string): unknown } }).prepared;
  assert.deepEqual(store.list(draft.draftId), { draftId: draft.draftId, preps: [], jobs: [] });
});

test('原始 Render 从选择、确认保存、实际 Marker 到 Frozen PREP 保持独立身份与幂等', async t => {
  const f = await fixture(t);
  assert.equal((await readdir(f.destinationPath)).length, 1, '选择文件不复制 Render');
  const request = { preparationId: f.preparationId, destinationId: f.destination.id, selectionIds: f.selections.map(s => s.id) };
  const proposal = await f.prepared.previewImport(request); assert.equal(isPreparedImportProposal(proposal), true);
  assert.equal((await readdir(f.destinationPath)).length, 1, '预览不复制 Render');
  const start = { ...request, commandId: randomUUID(), proposalFingerprint: proposal.proposalFingerprint, userConfirmed: true as const };
  const job = await f.prepared.startImport(start); await f.prepared.idle();
  const done = f.prepared.job(job.id).job!; assert.equal(done.state, 'completed'); assert.deepEqual(await f.prepared.startImport(start), done);
  const rawDirectory = path.join(f.destinationPath, `MusicBridge-OriginalRender-${job.id}`);
  for (const [i, original] of f.originalFiles.entries()) {
    assert.deepEqual(await readFile(original.file), original.bytes);
    assert.deepEqual(await readFile(path.join(rawDirectory, `Originals/${done.assets![i]!.side}.wav`)), original.bytes);
  }
  const assessment: RenderAssessment = { structureChanged: false, acceptVariance: false, varianceReason: '', timeline: { timebase: 'sample-frames', sides: f.layout.timeline.sides.map(s => { const a = done.assets!.find(a => a.side === s.name); if (!a) return { name: s.name, renderAssetId: null, renderFileHash: null, sampleRate: f.layout.timeline.sampleRate, channelLayout: 'none', totalFrames: 0, markers: [] }; return { name: s.name, renderAssetId: a.id, renderFileHash: a.sha256, sampleRate: a.sampleRate, channelLayout: 'stereo', totalFrames: a.totalFrames, markers: s.tracks.map(m => ({ trackId: m.trackId, exactSourceSha256: f.master.content.tracks.find(c => c.trackId === m.trackId)!.source.sha256, actualStartFrame: m.startFrame, actualEndFrame: m.endFrame, actualGapToNextFrames: m.gapAfterFrames, confirmationMethod: 'manual', userConfirmed: true })) } }) } };
  const reviewRequest = { importJobId: job.id, assessment, daw: 'Logic Pro（合成流程）', processingLineage: '保持曲序和源；人工校正 Marker，未叠加 Gap。' };
  const review = await f.prepared.review(reviewRequest); assert.equal(review.conformance.status, 'MATCHED');
  const freeze = { ...reviewRequest, commandId: randomUUID(), proposalFingerprint: review.proposalFingerprint, userConfirmed: true as const };
  const prep = await f.prepared.freeze(freeze); assert.equal(isFrozenPrepared(prep), true); assert.equal(prep.transitionRenderingMode, 'Baked Into Render'); assert.equal(prep.executionReady, false);
  assert.deepEqual(await f.prepared.freeze(freeze), prep); assert.equal(f.prepared.list(f.draft.draftId).preps.length, 1); assert.equal(isPreparedHistory(f.prepared.list(f.draft.draftId)), true);
  assert.equal(prep.masterVersionId, f.master.id); assert.equal(prep.layoutVersionId, f.layout.id); assert.deepEqual(prep.plannedTimeline, f.layout.timeline);
  await assert.rejects(f.prepared.freeze({ ...freeze, daw: '另一 DAW' }));
  assert.equal(preparedCompatibility(prep, { masterVersionId: f.master.id, layoutVersionId: randomUUID() }), 'DIFFERENT_LAYOUT');
  assert.equal(preparedCompatibility(prep, { masterVersionId: randomUUID(), layoutVersionId: f.layout.id }), 'DIFFERENT_MASTER');
  assert.equal(preparedCompatibility(prep, { masterVersionId: f.master.id, layoutVersionId: f.layout.id }), 'COMPATIBLE');
  assert.deepEqual(f.prepared.list(f.draft.draftId).preps[0], prep);
  const db = new DatabaseSync(f.filePath); try {
    assert.throws(() => db.prepare('UPDATE prepared_versions SET data=data WHERE id=?').run(prep.id));
    assert.throws(() => db.prepare('DELETE FROM prepared_versions WHERE id=?').run(prep.id));
    assert.throws(() => db.prepare('UPDATE prepared_jobs SET data=data WHERE id=?').run(job.id));
    assert.throws(() => db.prepare('DELETE FROM prepared_ledger WHERE command_id=?').run(freeze.commandId));
  } finally { db.close(); }
});

test('Render 选择后的文件变化、错面、撤销和未确认请求均不会写入保留副本', async t => {
  const f = await fixture(t), request = await startRequest(f);
  await assert.rejects(f.prepared.startImport({ ...request, userConfirmed: false as true }));
  await assert.rejects(f.prepared.previewImport({ ...request, selectionIds: [...request.selectionIds].reverse() }));
  await writeFile(f.originalFiles[0]!.file, wav(f.layout.timeline.sides[0]!.totalFrames + 1, 96000));
  await assert.rejects(f.prepared.startImport(request)); assert.equal(f.prepared.list(f.draft.draftId).jobs.length, 0);
  f.prepared.revoke({ commandId: randomUUID(), id: f.selections[1]!.id });
  await assert.rejects(f.prepared.previewImport({ preparationId: f.preparationId, destinationId: f.destination.id, selectionIds: f.selections.map(s => s.id) }));
  assert.equal((await readdir(f.destinationPath)).length, 1);
});

test('Render 导入意图提交失败时不复制；原命令重试只创建一个任务', async t => {
  let fail = true;
  const f = await fixture(t, action => { if (fail && action === 'start-prepared') throw new Error('合成事务失败'); }), request = await startRequest(f);
  await assert.rejects(f.prepared.startImport(request)); assert.equal(f.prepared.list(f.draft.draftId).jobs.length, 0); assert.equal((await readdir(f.destinationPath)).length, 1);
  fail = false; const job = await f.prepared.startImport(request); await f.prepared.idle(); assert.equal(f.prepared.job(job.id).job!.state, 'completed'); assert.equal(f.prepared.list(f.draft.draftId).jobs.length, 1);
});

test('Render 复制 ENOSPC 不生成成功回执、不删除原件或不完整目录', async t => {
  const f = await fixture(t, undefined, { copy: async () => { throw Object.assign(new Error('合成磁盘已满'), { code: 'ENOSPC' }); } });
  const request = await startRequest(f), job = await f.prepared.startImport(request); await f.prepared.idle();
  assert.equal(f.prepared.job(job.id).job!.failure, 'DISK_FULL'); assert.equal(f.prepared.job(job.id).job!.assets, undefined); assert.equal(f.prepared.list(f.draft.draftId).preps.length, 0);
  assert.equal((await readdir(f.destinationPath)).length, 2); assert.deepEqual(await readFile(f.originalFiles[0]!.file), f.originalFiles[0]!.bytes);
});

for (const mode of ['cancel', 'revoke-file', 'revoke-target'] as const) test(`Render 复制中 ${mode} 立即终止授权，不发布 PREP`, async t => {
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; }), resume = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture(t, undefined, { copy: async (...args) => { entered(); await resume; return copyPreparationFile(...args); } });
  const request = await startRequest(f), job = await f.prepared.startImport(request); await started;
  try {
    if (mode === 'cancel') f.prepared.cancel({ commandId: randomUUID(), id: job.id });
    else if (mode === 'revoke-file') f.prepared.revoke({ commandId: randomUUID(), id: f.selections[0]!.id });
    else f.preparation.revoke({ commandId: randomUUID(), id: f.destination.id });
  } finally { release(); }
  await f.prepared.idle(); const result = f.prepared.job(job.id).job!;
  assert.equal(result.failure, mode === 'cancel' ? 'CANCELLED' : mode === 'revoke-file' ? 'SOURCE_INVALID' : 'DESTINATION_INVALID'); assert.equal(result.assets, undefined);
});

for (const mode of ['intact', 'tampered', 'revoked'] as const) test(`Render 发布后回执失败：冷启动 ${mode} 只校验原副本，不重读来源或重放复制`, async t => {
  let fail = true, copies = 0;
  const f = await fixture(t, action => { if (fail && action === 'finish-prepared') throw new Error('合成发布回执故障'); }, { copy: async (...args) => { copies++; return copyPreparationFile(...args); } });
  const request = await startRequest(f), job = await f.prepared.startImport(request); await f.prepared.idle();
  assert.equal(f.prepared.job(job.id).job!.state, 'interrupted'); assert.equal(copies, 2);
  await f.prepared.close();
  for (const original of f.originalFiles) await unlink(original.file);
  if (mode === 'tampered') await writeFile(path.join(f.destinationPath, `MusicBridge-OriginalRender-${job.id}`, 'Originals/A.wav'), Buffer.from('外部篡改'));
  if (mode === 'revoked') f.preparation.revoke({ commandId: randomUUID(), id: f.destination.id });
  f.repository.close(); fail = false;
  const repository = createCollectionRepository({ filePath: f.filePath });
  const reopened = createPreparedCoordinator({ store: repository.prepared, preparationStore: repository.preparations, preparation: f.preparation, sourceStore: repository.sources, copy: async () => { throw new Error('冷启动不允许重放复制'); } });
  t.after(async () => { await reopened.close(); repository.close(); });
  await reopened.idle(); const result = reopened.job(job.id).job!;
  assert.equal(result.state, mode === 'intact' ? 'completed' : 'interrupted'); assert.equal(copies, 2);
  assert.deepEqual(await reopened.startImport(request), result);
  assert.equal(isPreparedHistory(reopened.list(f.draft.draftId)), true);
});

test('PREP 冻结事务回滚后可用原命令恢复；保留副本改变后禁止新增冻结', async t => {
  let fail = true;
  const f = await fixture(t, action => { if (fail && action === 'freeze-prepared') throw new Error('合成冻结事务失败'); });
  const request = await startRequest(f), job = await f.prepared.startImport(request); await f.prepared.idle();
  const rr = reviewRequest(f, job.id), reviewed = await f.prepared.review(rr), freeze = { ...rr, commandId: randomUUID(), proposalFingerprint: reviewed.proposalFingerprint, userConfirmed: true as const };
  await assert.rejects(f.prepared.freeze(freeze)); assert.equal(f.prepared.list(f.draft.draftId).preps.length, 0);
  fail = false; const prep = await f.prepared.freeze(freeze); assert.equal(isFrozenPrepared(prep), true);
  await writeFile(path.join(f.destinationPath, `MusicBridge-OriginalRender-${job.id}`, 'Originals/A.wav'), Buffer.from('外部修改'));
  await assert.rejects(f.prepared.freeze({ ...freeze, commandId: randomUUID() }));
  assert.deepEqual(await f.prepared.freeze(freeze), prep, '回执重试返回原冻结事实，不当作新的文件校验成功');
});

test('未确认 Marker、需要新母版或布局均不能靠伪造接受状态冻结 PREP', async t => {
  const f = await fixture(t), request = await startRequest(f), job = await f.prepared.startImport(request); await f.prepared.idle();
  for (const mode of ['unconfirmed','source','layout'] as const) {
    const rr = reviewRequest(f, job.id);
    if (mode === 'unconfirmed') rr.assessment.timeline.sides[0]!.markers[0]!.userConfirmed = false;
    if (mode === 'source') rr.assessment.timeline.sides[0]!.markers[0]!.exactSourceSha256 = 'f'.repeat(64);
    if (mode === 'layout') rr.assessment.structureChanged = true;
    rr.assessment.acceptVariance = true; rr.assessment.varianceReason = '用户仍希望接受';
    const reviewed = await f.prepared.review(rr); assert.equal(reviewed.conformance.status, mode === 'unconfirmed' ? 'REJECTED' : mode === 'source' ? 'REQUIRES_NEW_MASTER' : 'REQUIRES_NEW_LAYOUT');
    await assert.rejects(f.prepared.freeze({ ...rr, commandId: randomUUID(), proposalFingerprint: reviewed.proposalFingerprint, userConfirmed: true }));
  }
  assert.equal(f.prepared.list(f.draft.draftId).preps.length, 0);
});

test('DAT Program 原始 Render 独立保存与冻结不引入 A/B 分面或重复 Gap', async t => {
  const f = await fixture(t, undefined, {}, 'dat'), request = await startRequest(f), job = await f.prepared.startImport(request); await f.prepared.idle();
  assert.equal(f.prepared.job(job.id).job!.state, 'completed'); assert.equal(f.prepared.job(job.id).job!.assets!.length, 1);
  const rr = reviewRequest(f, job.id), reviewed = await f.prepared.review(rr), prep = await f.prepared.freeze({ ...rr, commandId: randomUUID(), proposalFingerprint: reviewed.proposalFingerprint, userConfirmed: true });
  assert.equal(prep.conformance.status, 'MATCHED'); assert.equal(prep.renderTimeline.sides[0]!.name, 'Program'); assert.equal(prep.renderTimeline.sides.length, 1);
  assert.equal(prep.renderTimeline.sides[0]!.markers[0]!.actualGapToNextFrames, f.layout.timeline.sides[0]!.tracks[0]!.gapAfterFrames);
  assert.deepEqual(await readFile(path.join(f.destinationPath, `MusicBridge-OriginalRender-${job.id}`, 'Originals/Program.wav')), f.originalFiles[0]!.bytes);
});

test('Prepared schema 9 升级故障完整回滚，原工作区与母版历史不变', async t => {
  const f = await preparationFixture(t); await f.freeze(); await f.versions.idle(); const history = f.repository.versions.list(f.draft.draftId);
  await f.versions.close(); await f.sources.close(); f.repository.close();
  const db = new DatabaseSync(f.filePath); try { db.exec('DROP TABLE prepared_versions; DROP TABLE prepared_jobs; DROP TABLE prepared_selections; DROP TABLE prepared_ledger; PRAGMA user_version=9'); } finally { db.close(); }
  const failing = createCollectionRepository({ filePath: f.filePath, beforeCommit: action => { if (action === 'migrate-prepared') throw new Error('合成 PREP 迁移失败'); } });
  assert.throws(() => failing.prepared.list(f.draft.draftId)); failing.close();
  const inspect = new DatabaseSync(f.filePath); try { assert.equal(inspect.prepare('PRAGMA user_version').get()!.user_version, 9); assert.equal(inspect.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name LIKE 'prepared_%'").get()!.n, 0); } finally { inspect.close(); }
  const reopened = createCollectionRepository({ filePath: f.filePath }); try { assert.deepEqual(reopened.versions.list(f.draft.draftId), history); assert.deepEqual(reopened.prepared.list(f.draft.draftId), { draftId: f.draft.draftId, preps: [], jobs: [] }); } finally { reopened.close(); }
});

test('Cassette 空 B 面不要求虚构 WAV，空面事实与 A 面原件分别保留', async t => {
  const f = await fixture(t, undefined, {}, 'cassette', true), request = await startRequest(f), job = await f.prepared.startImport(request); await f.prepared.idle();
  const result = f.prepared.job(job.id).job!; assert.equal(result.state, 'completed'); assert.equal(result.assets!.length, 1); assert.equal(result.assets![0]!.side, 'A');
  const raw = path.join(f.destinationPath, `MusicBridge-OriginalRender-${job.id}`, 'Originals'); assert.deepEqual(await readdir(raw), ['A.wav']);
  const rr = reviewRequest(f, job.id), review = await f.prepared.review(rr); assert.equal(review.conformance.status, 'MATCHED');
  const prep = await f.prepared.freeze({ ...rr, commandId: randomUUID(), proposalFingerprint: review.proposalFingerprint, userConfirmed: true });
  assert.equal(isFrozenPrepared(prep), true); assert.equal(isPreparedHistory(f.prepared.list(f.draft.draftId)), true);
  assert.deepEqual(prep.renderTimeline.sides[1], { name: 'B', renderAssetId: null, renderFileHash: null, sampleRate: f.layout.timeline.sampleRate, channelLayout: 'none', totalFrames: 0, markers: [] });
  const changed = structuredClone(rr); changed.assessment.timeline.sides[1]!.sampleRate = 48000;
  assert.equal((await f.prepared.review(changed)).conformance.status, 'REJECTED', '空面采用计划时间基准，不能预览为 MATCHED 却无法冻结');
});
