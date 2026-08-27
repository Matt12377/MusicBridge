import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { isExecutionHistory, isExecutionProposal, type RenderAssessment } from '@music-bridge/contracts';
import { preparationFixture } from './helpers/preparation-fixture.js';
import { recordingProfileContent } from './helpers/recording-profile-fixture.js';
import { createPreparationCoordinator } from '../src/recording/preparation-coordinator.js';
import { createCollectionRepository } from '../src/collection/repository.js';
import { compileExecutionFile } from '../src/recording/preparation-files.js';
import { createPreparedCoordinator } from '../src/recording/prepared-coordinator.js';
import { pcmWaveHeader } from '../src/recording/execution-wave.js';

type Hooks = { compile?: typeof compileExecutionFile; afterPublish?: () => Promise<void>; operationTimeoutMs?: number };
async function setup(t: test.TestContext, options: Hooks & { beforeCommit?: (action: string) => void; emptyB?: boolean; format?: 'cassette' | 'dat' } = {}) {
  const f = await preparationFixture(t, options), v = await f.freeze(); await f.versions.idle();
  assert.ok('execution' in f.repository, '缺少持久化执行资产仓库');
  const { createExecutionCoordinator } = await import('../src/recording/execution-coordinator.js');
  const frozen = f.repository.preparations.frozen(f.versions.job(v.id).job!.layoutVersionId!);
  const preparation = createPreparationCoordinator({ store: f.repository.preparations, sourceStore: f.repository.sources, sources: f.sources });
  const target = path.join(f.directory, '执行文件'); await mkdir(target); const destination = await preparation.authorize(randomUUID(), target);
  const profile = f.repository.recordingProfiles.save({ commandId: randomUUID(), content: recordingProfileContent(), userConfirmed: true });
  const session = f.repository.recordingProfiles.saveSession({ commandId: randomUUID(), draftId: f.draft.draftId, expectedRevision: 0, profileVersionId: profile.id, overrides: { recordLevel: '本次人工电平' }, userConfirmed: true });
  const make = (repository = f.repository, hooks: Hooks = options) => createExecutionCoordinator({ store: repository.execution, profiles: repository.recordingProfiles, preparationStore: repository.preparations, preparedStore: repository.prepared, mediaStore: repository.media, sourceStore: repository.sources, sources: f.sources, preparation, ...hooks });
  const execution = make(); t.after(async () => { await execution.close(); await preparation.close(); });
  const selection = { layoutVersionId: frozen.layout.id, destinationId: destination.id, mode: 'direct' as const, sessionRevision: session.revision };
  const preview = () => execution.preview({ ...selection, readId: randomUUID() });
  const request = async () => ({ ...selection, commandId: randomUUID(), proposalFingerprint: (await preview()).proposalFingerprint, userConfirmed: true as const });
  return { ...f, ...frozen, profile, session, preparation, target, destination, execution, make, selection, preview, request };
}

test('Direct 明确预览不写盘，确认持久化逐面 PCM/清单/参数，原命令不重复编译', async t => {
  const f = await setup(t), p = await f.preview(); assert.equal(isExecutionProposal(p), true); assert.deepEqual(await readdir(f.target), []);
  assert.equal(p.settings.effective.recordLevel, '本次人工电平'); assert.equal(p.settings.effective.preRollMs, 1000);
  const request = await f.request(), job = await f.execution.start(request); assert.equal(job.state, 'running'); await f.execution.idle();
  const history = f.execution.list(f.draft.draftId); assert.equal(isExecutionHistory(history), true); assert.equal(history.assets.length, 1); assert.equal(history.jobs[0]!.state, 'completed');
  assert.deepEqual(await f.execution.start(request), history.jobs[0]); assert.equal((await readdir(f.target)).length, 1);
  const asset = history.assets[0]!, owned = f.repository.execution.job(job.id)!.owned!;
  assert.equal(asset.formalReady, false); assert.equal(asset.state, 'verified-at-publication'); assert.equal(asset.retentionPolicy, 'unresolved-no-automatic-deletion');
  assert.equal(asset.settings.profile.id, f.profile.id); assert.equal(asset.settings.effective.recordLevel, '本次人工电平');
  for (const receipt of asset.audio) { const bytes = await readFile(path.join(owned.root.path, `Audio/${receipt.recipe.side}.execution.wav`)); assert.equal(createHash('sha256').update(bytes).digest('hex'), receipt.audio.sha256); assert.equal(bytes.readUInt32LE(24), 44100); }
  assert.equal((await f.execution.verify({ assetId: asset.id, readId: randomUUID() })).state, 'verified');
  assert.ok(!JSON.stringify(history).includes(f.sourcePath)); assert.ok(!JSON.stringify(history).includes(f.target));
  const db = new DatabaseSync(f.filePath); try { for (const table of ['execution_assets','execution_jobs']) assert.throws(() => db.exec(`UPDATE ${table} SET data=data`)); assert.throws(() => db.exec('UPDATE execution_ledger SET result=result')); } finally { db.close(); }
});

test('空 B 无占位音频；DAT 只有 Program；旧 Profile 默认变更不改写已确认参数', async t => {
  for (const options of [{ emptyB: true }, { format: 'dat' as const }]) {
    const f = await setup(t, options), request = await f.request();
    f.repository.recordingProfiles.save({ commandId: randomUUID(), profileId: f.profile.profileId, expectedVersionId: f.profile.id, content: { ...f.profile.content, defaults: { ...f.profile.content.defaults, noiseReduction: '新默认' } }, userConfirmed: true });
    const job = await f.execution.start(request); await f.execution.idle(); const asset = f.execution.list(f.draft.draftId).assets[0]!;
    assert.equal(asset.settings.profile.id, f.profile.id); assert.equal(asset.settings.effective.noiseReduction, 'Off'); assert.equal(asset.audio.length, 1); assert.equal(f.execution.job(job.id).job!.totalSides, 1);
    assert.deepEqual(await readdir(path.join(f.repository.execution.job(job.id)!.owned!.root.path, 'Audio')), [options.emptyB ? 'A.execution.wav' : 'Program.execution.wav']);
  }
});

test('参数修订、容量/兼容性或转换需求变化必须重新确认，预览/失效启动不写文件', async t => {
  const f = await setup(t), request = await f.request();
  f.repository.recordingProfiles.saveSession({ commandId: randomUUID(), draftId: f.draft.draftId, expectedRevision: 1, profileVersionId: f.profile.id, overrides: { noiseReduction: null }, userConfirmed: true });
  await assert.rejects(f.execution.start(request)); assert.equal(f.execution.list(f.draft.draftId).jobs.length, 0); assert.deepEqual(await readdir(f.target), []);
  for (const content of [{ ...f.profile.content, executionFormat: { ...f.profile.content.executionFormat, sampleRate: 48000 } }, { ...f.profile.content, compatibility: { confirmed: true, cassetteTypes: [] as const, dat: false } }]) {
    const profile = f.repository.recordingProfiles.save({ commandId: randomUUID(), content, userConfirmed: true }), previous = f.repository.recordingProfiles.session(f.draft.draftId).session!;
    const session = f.repository.recordingProfiles.saveSession({ commandId: randomUUID(), draftId: f.draft.draftId, expectedRevision: previous.revision, profileVersionId: profile.id, overrides: {}, userConfirmed: true });
    await assert.rejects(f.execution.preview({ ...f.selection, sessionRevision: session.revision, readId: randomUUID() })); assert.deepEqual(await readdir(f.target), []);
  }
});

test('写任务事务失败不写盘；发布后 DB 故障保留已校验文件，冷启动只补交不重编译', async t => {
  let actionToFail = '', compiles = 0;
  const f = await setup(t, { beforeCommit: action => { if (action === actionToFail) throw new Error('合成 DB 故障'); }, compile: async (...args) => { compiles++; return compileExecutionFile(...args); } });
  const request = await f.request(); actionToFail = 'start-execution'; await assert.rejects(f.execution.start(request)); assert.deepEqual(await readdir(f.target), []); assert.equal(f.execution.list(f.draft.draftId).jobs.length, 0);
  actionToFail = 'finish-execution'; const job = await f.execution.start(request); await f.execution.idle(); assert.equal(f.execution.job(job.id).job!.state, 'interrupted'); assert.equal(f.execution.list(f.draft.draftId).assets.length, 0);
  const count = compiles; await f.execution.close(); await rm(f.sourcePath, { recursive: true });
  actionToFail = ''; const reopened = createCollectionRepository({ filePath: f.filePath }), resumed = f.make(reopened, { compile: async (...args) => { compiles++; return compileExecutionFile(...args); } });
  try { await resumed.idle(); assert.equal(compiles, count); assert.equal(resumed.job(job.id).job!.state, 'completed'); assert.equal(resumed.list(f.draft.draftId).assets.length, 1); assert.deepEqual(await resumed.start(request), resumed.job(job.id).job); } finally { await resumed.close(); reopened.close(); }
});

test('发布后字节损坏不会恢复成功；历史发布事实不冒充当前可用', async t => {
  const f = await setup(t), job = await f.execution.start(await f.request()); await f.execution.idle(); const stored = f.repository.execution.job(job.id)!, asset = f.execution.list(f.draft.draftId).assets[0]!;
  const file = path.join(stored.owned!.root.path, stored.files[0]!.relative), bytes = await readFile(file); bytes[44] = bytes[44]! ^ 1; await writeFile(file, bytes);
  const check = await f.execution.verify({ assetId: asset.id, readId: randomUUID() }); assert.equal(check.state, 'unavailable'); assert.equal(check.reason, 'ASSET_INVALID'); assert.equal(f.execution.list(f.draft.draftId).assets[0]!.state, 'verified-at-publication');
});

test('编译中取消或撤权不发布资产，不删除已拥有的目录，冷启动不重放', async t => {
  for (const revoke of [false,true]) {
    let entered!: () => void, release!: () => void; const seen = new Promise<void>(resolve => { entered = resolve; }), wait = new Promise<void>(resolve => { release = resolve; });
    const f = await setup(t, { compile: async (...args) => { entered(); await wait; return compileExecutionFile(...args); } }), job = await f.execution.start(await f.request()); await seen;
    if (revoke) f.preparation.revoke({ commandId: randomUUID(), id: f.destination.id }); else f.execution.cancel({ commandId: randomUUID(), id: job.id });
    release(); await f.execution.idle(); assert.equal(f.execution.job(job.id).job!.state, revoke ? 'failed' : 'cancelled'); assert.equal(f.execution.list(f.draft.draftId).assets.length, 0); assert.equal((await readdir(f.target)).length, 1);
    await f.execution.close(); const resumed = f.make(f.repository, { compile: async () => { assert.fail('不得重放'); } }); try { await resumed.idle(); assert.equal(resumed.list(f.draft.draftId).assets.length, 0); } finally { await resumed.close(); }
  }
});

async function preparedSetup(t: test.TestContext, options: Parameters<typeof setup>[1] = {}) {
  const f = await setup(t, options), profile = f.repository.recordingProfiles.save({ commandId: randomUUID(), content: recordingProfileContent(96000), userConfirmed: true });
  const session = f.repository.recordingProfiles.saveSession({ commandId: randomUUID(), draftId: f.draft.draftId, expectedRevision: 1, profileVersionId: profile.id, overrides: {}, userConfirmed: true });
  const workspaceProposal = await f.preparation.preview({ layoutVersionId: f.layout.id, destinationId: f.destination.id });
  const workspace = await f.preparation.start({ commandId: randomUUID(), layoutVersionId: f.layout.id, destinationId: f.destination.id, proposalFingerprint: workspaceProposal.proposalFingerprint, userConfirmed: true }); await f.preparation.idle();
  const preparationId = f.preparation.job(workspace.id).job!.workspaceId!, prepared = createPreparedCoordinator({ store: f.repository.prepared, preparationStore: f.repository.preparations, preparation: f.preparation, sourceStore: f.repository.sources }); t.after(() => prepared.close());
  const rawTarget = path.join(f.directory, '原始 Render 保留目录'); await mkdir(rawTarget); const rawDestination = await f.preparation.authorize(randomUUID(), rawTarget);
  const selections = [];
  for (const side of f.layout.timeline.sides.filter(s => s.totalFrames > 0)) {
    const file = path.join(f.directory, `合成Render-${side.name}.wav`), pcm = Buffer.alloc(side.totalFrames * 4); pcm.writeInt16LE(12345, 0); pcm.writeInt16LE(-12345, pcm.length - 2);
    await writeFile(file, Buffer.concat([pcmWaveHeader(96000, 2, 16, side.totalFrames), pcm]));
    selections.push(await prepared.select({ commandId: randomUUID(), preparationId, side: side.name }, file));
  }
  const importedSelection = { preparationId, destinationId: rawDestination.id, selectionIds: selections.map(s => s.id) }, importedProposal = await prepared.previewImport(importedSelection);
  const imported = await prepared.startImport({ ...importedSelection, commandId: randomUUID(), proposalFingerprint: importedProposal.proposalFingerprint, userConfirmed: true }); await prepared.idle();
  const done = prepared.job(imported.id).job!;
  const assessment: RenderAssessment = { structureChanged: false, acceptVariance: false, varianceReason: '', timeline: { timebase: 'sample-frames', sides: f.layout.timeline.sides.map(s => { const a = done.assets!.find(a => a.side === s.name); return { name: s.name, renderAssetId: a?.id ?? null, renderFileHash: a?.sha256 ?? null, sampleRate: 96000, channelLayout: a ? 'stereo' : 'none', totalFrames: s.totalFrames, markers: s.tracks.map(m => ({ trackId: m.trackId, exactSourceSha256: f.master.content.tracks.find(c => c.trackId === m.trackId)!.source.sha256, actualStartFrame: m.startFrame, actualEndFrame: m.endFrame, actualGapToNextFrames: m.gapAfterFrames, confirmationMethod: 'manual', userConfirmed: true })) }; }) } };
  const reviewRequest = { importJobId: done.id, assessment, daw: '合成 DAW', processingLineage: '合成 Render；未运行真实 Logic。' }, review = await prepared.review(reviewRequest), prep = await prepared.freeze({ ...reviewRequest, commandId: randomUUID(), proposalFingerprint: review.proposalFingerprint, userConfirmed: true });
  const selection = { ...f.selection, mode: 'prepared-reference' as const, preparedVersionId: prep.id, sessionRevision: session.revision };
  const request = async () => ({ ...selection, commandId: randomUUID(), proposalFingerprint: (await f.execution.preview({ ...selection, readId: randomUUID() })).proposalFingerprint, userConfirmed: true as const });
  return { ...f, rawDestination, rawTarget, imported: f.repository.prepared.job(imported.id)!, prep, request, selection };
}

test('PREP 实际原件引用逐面核对，不复制、不加 Gap；原件授权撤销立即使当前检查不可用', async t => {
  for (const options of [{ emptyB: true }, { format: 'dat' as const }, {}]) {
    const f = await preparedSetup(t, options), request = await f.request(), p = await f.execution.preview({ ...f.selection, readId: randomUUID() });
    assert.equal(p.audioBytesToWrite, 0); assert.equal(p.referencedAudioBytes, f.prep.assets.reduce((sum,a) => sum + a.size, 0));
    const job = await f.execution.start(request); await f.execution.idle(); const asset = f.execution.list(f.draft.draftId).assets[0]!; assert.ok(asset); assert.equal(asset.preparedVersionId, f.prep.id);
    assert.deepEqual(await readdir(path.join(f.repository.execution.job(job.id)!.owned!.root.path, 'Audio')), []);
    for (const receipt of asset.audio) { const original = f.prep.assets.find(a => a.side === receipt.recipe.side)!; assert.equal(receipt.origin, 'retained-render'); assert.equal(receipt.audio.sha256, original.sha256); assert.equal(receipt.audio.frameCount, original.totalFrames); assert.equal(receipt.recipe.segments.length, 1); }
    assert.equal((await f.execution.verify({ assetId: asset.id, readId: randomUUID() })).state, 'verified');
    f.preparation.revoke({ commandId: randomUUID(), id: f.rawDestination.id }); const check = await f.execution.verify({ assetId: asset.id, readId: randomUUID() }); assert.equal(check.state, 'unavailable'); assert.equal(check.reason, 'DESTINATION_INVALID');
    assert.equal((await readdir(f.rawTarget)).length, 1);
  }
});

test('PREP 发布后提交故障，原件损坏时冷启动保持中断，不错误补交也不重建', async t => {
  let fail = false; const f = await preparedSetup(t, { beforeCommit: action => { if (fail && action === 'finish-execution') throw new Error('合成故障'); } });
  fail = true; const job = await f.execution.start(await f.request()); await f.execution.idle(); assert.equal(f.execution.job(job.id).job!.state, 'interrupted'); await f.execution.close();
  const original = path.join(f.imported.owned!.root.path, f.imported.files[0]!.relative), bytes = await readFile(original); bytes[44] = bytes[44]! ^ 1; await writeFile(original, bytes);
  fail = false; const resumed = f.make(f.repository, { compile: async () => { assert.fail('恢复不能重编译'); } }); try { await resumed.idle(); assert.equal(resumed.job(job.id).job!.state, 'interrupted'); assert.equal(resumed.list(f.draft.draftId).assets.length, 0); } finally { await resumed.close(); }
});

test('执行有总体期限；超时的慢编译不返回资产，读取消先于预览也有效', async t => {
  const f = await setup(t, { operationTimeoutMs: 100, compile: async (...args) => { await new Promise(resolve => setTimeout(resolve, 150)); return compileExecutionFile(...args); } });
  const readId = randomUUID(); f.execution.cancelRead(readId); await assert.rejects(f.execution.preview({ ...f.selection, readId })); assert.deepEqual(await readdir(f.target), []);
  const job = await f.execution.start(await f.request()); await f.execution.idle(); assert.equal(f.execution.job(job.id).job!.state, 'failed'); assert.equal(f.execution.job(job.id).job!.failure, 'IO_ERROR'); assert.equal(f.execution.list(f.draft.draftId).assets.length, 0);
});

test('预览转换需求以公开 BAD_REQUEST 拒绝；后续编译故障保留明确磁盘已满状态', async t => {
  const f = await setup(t, { compile: async () => { throw Object.assign(new Error('/private/fake-destination'), { code: 'ENOSPC' }); } }), job = await f.execution.start(await f.request());
  await f.execution.idle(); assert.equal(f.execution.job(job.id).job!.failure, 'DISK_FULL');
  const profile = f.repository.recordingProfiles.save({ commandId: randomUUID(), content: recordingProfileContent(48000), userConfirmed: true }), session = f.repository.recordingProfiles.saveSession({ commandId: randomUUID(), draftId: f.draft.draftId, expectedRevision: 1, profileVersionId: profile.id, overrides: {}, userConfirmed: true });
  await assert.rejects(f.execution.preview({ ...f.selection, sessionRevision: session.revision, readId: randomUUID() }), error => error instanceof Error && 'code' in error && error.code === 'BAD_REQUEST' && error.message.includes('转换'));
});
