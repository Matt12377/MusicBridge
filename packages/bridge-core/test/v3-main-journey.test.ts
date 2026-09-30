import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import type { MediaLayoutSpec, RecordingAttempt } from '@music-bridge/contracts';
import { createCollectionRepository } from '../src/collection/repository.js';
import { createSourceEvidenceService } from '../src/recording/source-evidence.js';
import { createMediaPlanningCoordinator } from '../src/recording/media-coordinator.js';
import { createMasterVersionsCoordinator } from '../src/recording/versions-coordinator.js';
import { createPreparationCoordinator } from '../src/recording/preparation-coordinator.js';
import { createExecutionCoordinator } from '../src/recording/execution-coordinator.js';
import { createArchiveCoordinator } from '../src/recording/archive-coordinator.js';
import { createRecordingPlanCoordinator } from '../src/recording/plan-coordinator.js';
import { createRecordingAttemptCoordinator, type RecordingAttemptDriverRequest } from '../src/recording/attempt-coordinator.js';
import { createRecordingRecordCoordinator } from '../src/recording/record-coordinator.js';
import { fakePlanDeviceSelection } from './helpers/fake-plan-device-selection.js';
import { recordingProfileContent } from './helpers/recording-profile-fixture.js';
import { waitForVerifiedOutputRun } from './helpers/output-run-ready.js';

/** 本机只写已挂载外置卷；GitHub hosted CI 使用既有 RUNNER_TEMP，绝不创建模拟 Volumes。 */
async function journeyTemporaryRoot(): Promise<string> {
  const hosted = process.env.GITHUB_ACTIONS === 'true' && process.env.RUNNER_ENVIRONMENT === 'github-hosted';
  const expected = hosted ? process.env.RUNNER_TEMP : '/Volumes/LifeWeave/Developer/CommandLine/tmp';
  if (!expected || !path.isAbsolute(expected)) throw new Error('主流程验证必须明确提供绝对临时根目录');
  if (!hosted) {
    const mounts = execFileSync('/sbin/mount', { encoding: 'utf8' });
    if (!mounts.split('\n').some(line => line.includes(' on /Volumes/LifeWeave ('))) throw new Error('LifeWeave 外置卷未挂载，停止主流程验证');
    if (!process.env.TMPDIR || !path.isAbsolute(process.env.TMPDIR)) throw new Error('本机主流程验证必须明确提供外置 TMPDIR');
  }
  const root = await realpath(expected);
  // verify CI 没有 TMPDIR 配置，hosted 路径直接由 RUNNER_TEMP 指定；本机不回落系统目录。
  const actual = hosted ? root : await realpath(process.env.TMPDIR!);
  const relative = path.relative(root, actual);
  if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new Error('本机主流程 TMPDIR 必须位于批准的外置临时根目录中');
  await access(actual, constants.R_OK | constants.W_OK);
  return actual;
}
const page = { offset: 0, limit: 25 };
function audio(marker: number): Buffer {
  const bytes = Buffer.alloc(44 + 44100 * 4);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(2, 22);
  bytes.writeUInt32LE(44100, 24); bytes.writeUInt32LE(176400, 28); bytes.writeUInt16LE(4, 32);
  bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(bytes.length - 44, 40);
  bytes[44] = marker;
  return bytes;
}

/**
 * 只使用现有领域：Project/Track/Program 对应草稿与曲序/programType；
 * 源准备对应 confirmed binding，Project Master 对应 master/layout。
 * 当前没有独立 Original Master API，不能将此映射写成独立对象验收。
 * 本夹具逐步调用真实仓库/协调器；只有设备选择和输出 provider 为构造器合成注入。
 */
async function journey(t: test.TestContext) {
  const temporaryRoot = await journeyTemporaryRoot();
  const directory = await mkdtemp(path.join(temporaryRoot, 'musicbridge-v3-main-journey-'));
  const filePath = path.join(directory, 'clean.sqlite');
  const repository = createCollectionRepository({ filePath });
  const sources = createSourceEvidenceService({ store: repository.sources, drafts: repository.drafts });
  const media = createMediaPlanningCoordinator({ store: repository.media, drafts: repository.drafts, sources });
  const versions = createMasterVersionsCoordinator({ store: repository.versions, mediaStore: repository.media, media, drafts: repository.drafts, sourceStore: repository.sources, sources });
  const preparation = createPreparationCoordinator({ store: repository.preparations, sourceStore: repository.sources, sources });
  const execution = createExecutionCoordinator({ store: repository.execution, profiles: repository.recordingProfiles, preparationStore: repository.preparations, preparedStore: repository.prepared, mediaStore: repository.media, sourceStore: repository.sources, sources, preparation });
  const archive = createArchiveCoordinator({ store: repository.archive, executionStore: repository.execution, preparationStore: repository.preparations, sourceStore: repository.sources, sources, preparation });
  const fakeDevice = fakePlanDeviceSelection();
  const plans = createRecordingPlanCoordinator({ store: repository.recordingPlans, deviceSelection: fakeDevice.deviceSelection });
  const starts: RecordingAttemptDriverRequest[] = [];
  let closes = 0, stops = 0;
  const attempts = createRecordingAttemptCoordinator({ store: repository.recordingAttempts, admissionProvider: {
    async authorize() {},
    async start(request) { starts.push(request); return {
      async stop() {
        ++stops;
        if (request.signal.aborted) for (const type of ['engine-cutoff', 'stop-ack', 'cleanup-quiescent'] as const)
          request.onEvent({ type, side: request.side, runId: request.runId, at: new Date().toISOString() });
      },
      async close() { ++closes; },
    }; },
  } });
  const records = createRecordingRecordCoordinator({ store: repository.recordingRecords, assertCurrent() {}, assertExecutionIdle: () => attempts.assertExecutionIdle() });
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    records.close(); await attempts.close(); await plans.close(); await archive.close();
    await execution.close(); await preparation.close(); await versions.close(); await sources.close(); repository.close();
  };
  t.after(async () => { await close(); await rm(directory, { recursive: true, force: true }); });

  assert.equal(repository.drafts.list(page).total, 0, '主线从无草稿、无母版、无档案的干净库开始');
  assert.equal(records.list({ page }).total, 0);
  const draft = repository.drafts.append({ commandId: randomUUID(), fingerprint: 'b'.repeat(64), title: '外审主流程制作', programType: 'compilation', metadata: [{ title: '合成曲目甲' }, { title: '合成曲目乙' }] });
  const sourcePath = path.join(directory, '合成源'); await mkdir(sourcePath);
  const root = await sources.authorize(randomUUID(), sourcePath);
  const invalidFile = path.join(sourcePath, 'invalid.wav'); await writeFile(invalidFile, '合成无效音频');
  const failed = sources.start({ commandId: randomUUID(), draftId: draft.draftId, trackId: draft.trackIds[0]!, rootId: root.id, acquisition: 'userFileBind' }, invalidFile);
  await sources.idle();
  assert.equal(sources.job(failed.id).job?.state, 'failed');
  assert.equal(repository.sources.linked(draft.draftId, draft.trackIds[0]!), undefined, '源准备失败不能冒充就绪');
  const files: string[] = [], originalBytes: Buffer[] = [];
  for (const [index, trackId] of draft.trackIds.entries()) {
    const file = path.join(sourcePath, `source-${index}.wav`), bytes = audio(index + 1);
    files.push(file); originalBytes.push(bytes); await writeFile(file, bytes);
    const job = sources.start({ commandId: randomUUID(), draftId: draft.draftId, trackId, rootId: root.id, acquisition: 'userFileBind' }, file);
    await sources.idle(); assert.equal(sources.job(job.id).job?.state, 'completed');
    const binding = repository.sources.linked(draft.draftId, trackId)!;
    await sources.confirm({ commandId: randomUUID(), id: binding.id, draftId: draft.draftId, trackId, userConfirmed: true });
  }
  const order = [...draft.trackIds].reverse();
  repository.drafts.update({ commandId: randomUUID(), draftId: draft.draftId, expectedRevision: 1, title: '外审主流程编排后', programType: 'concert', trackIds: order }, 'c'.repeat(64));
  const unrelated = repository.drafts.append({ commandId: randomUUID(), fingerprint: 'd'.repeat(64), title: '防串线对照制作', programType: 'compilation', metadata: [{ title: '未绑定曲目' }] });
  const spec: MediaLayoutSpec = { format: 'cassette', splitAfter: 1, leadInMs: 1000, tailMs: 1000, defaultGapMs: 5000, rules: [], compatibility: { confirmed: true, cassetteTypes: ['II'], dat: true } };
  repository.receive({ commandId: randomUUID(), model: { brand: '合成', name: '外审主线', edition: '隔离库', year: 1990, format: 'cassette', tapeType: 'II', identification: 'verified' }, lengthMinutes: 60, quantities: { openedBlank: 1, sealedBlank: 0, legacyUsed: 0, unclassified: 0 } });
  const mediaPreview = await media.preview({ draftId: draft.draftId, spec, page });
  const saved = await media.save({ commandId: randomUUID(), draftId: draft.draftId, expectedDraftRevision: mediaPreview.draftRevision, inputFingerprint: mediaPreview.inputFingerprint, spec });
  const mediaPlan = await media.reserve({ commandId: randomUUID(), planId: saved.id, expectedRevision: saved.revision, skuId: mediaPreview.candidates.items[0]!.skuId, packaging: 'opened', userConfirmed: true });
  const proposed = await versions.preview({ planId: mediaPlan.id, sampleRate: 44100 });
  const versionJob = await versions.freeze({ commandId: randomUUID(), planId: mediaPlan.id, sampleRate: 44100, proposalFingerprint: proposed.proposalFingerprint, userConfirmed: true });
  await versions.idle(); assert.equal(versions.job(versionJob.id).job?.state, 'completed');
  const history = versions.list(draft.draftId), master = history.masters[0]!, layout = history.layouts[0]!;
  assert.deepEqual(master.content.tracks.map(track => track.trackId), order);
  assert.equal(master.content.programType, 'concert'); assert.equal(layout.masterVersionId, master.id);
  assert.deepEqual(master.content.tracks.map(track => track.source.sha256), [...originalBytes].reverse().map(bytes => createHash('sha256').update(bytes).digest('hex')));
  assert.equal(versions.list(unrelated.draftId).masters.length, 0);
  assert.equal(repository.workspace.get(unrelated.draftId), null);
  const workspace = repository.workspace.put({ commandId: randomUUID(), draftId: draft.draftId, expectedDraftRevision: 2, expectedContextRevision: 0, selection: { planId: mediaPlan.id, layoutId: layout.id, path: 'direct', selectedPhysicalId: layout.reservation.physicalId }, pagePosition: 'plan' });
  assert.throws(() => repository.workspace.put({ commandId: randomUUID(), draftId: unrelated.draftId, expectedDraftRevision: 1, expectedContextRevision: 0, selection: { layoutId: layout.id }, pagePosition: 'plan' }), /不属于当前草稿/u);
  const profile = repository.recordingProfiles.save({ commandId: randomUUID(), content: recordingProfileContent(), userConfirmed: true });
  const session = repository.recordingProfiles.saveSession({ commandId: randomUUID(), draftId: draft.draftId, expectedRevision: 0, profileVersionId: profile.id, overrides: { recordLevel: '合成人工电平' }, userConfirmed: true });
  const executionPath = path.join(directory, '执行'); await mkdir(executionPath);
  const destination = await preparation.authorize(randomUUID(), executionPath);
  const executionSelection = { layoutVersionId: layout.id, destinationId: destination.id, mode: 'direct' as const, sessionRevision: session.revision };
  const executionPreview = await execution.preview({ ...executionSelection, readId: randomUUID() });
  const executionJob = await execution.start({ ...executionSelection, commandId: randomUUID(), proposalFingerprint: executionPreview.proposalFingerprint, userConfirmed: true });
  await execution.idle(); assert.equal(execution.job(executionJob.id).job?.state, 'completed');
  const archivePath = path.join(directory, '归档'); await mkdir(archivePath);
  const archiveRoot = await archive.authorize(randomUUID(), archivePath);
  await archive.initialize({ commandId: randomUUID(), id: archiveRoot.id, userConfirmed: true });
  const archiveSelection = { rootId: archiveRoot.id, assetId: executionJob.id, sourcePolicy: 'preserve-exact-sources' as const };
  const archivePreview = await archive.preview({ ...archiveSelection, readId: randomUUID() });
  const archiveRequest = { ...archiveSelection, commandId: randomUUID(), proposalFingerprint: archivePreview.proposalFingerprint, userConfirmed: true as const };
  const archived = await archive.start(archiveRequest); await archive.idle();
  assert.equal(archive.operation(archived.id).operation?.phase, 'FINALIZED');
  assert.equal((await archive.verify({ id: archived.id, readId: randomUUID() })).state, 'verified');
  const selection = { assetId: executionJob.id, archiveOperationId: archived.id, outputSelection: fakeDevice.outputSelection! };
  const planPreview = await plans.preview({ selection, readId: randomUUID() });
  const plan = await plans.freeze({ selection, commandId: randomUUID(), proposalFingerprint: planPreview.proposalFingerprint, userConfirmed: true });
  assert.equal(plan.master.id, master.id); assert.equal(plan.layout.id, layout.id);
  assert.equal(plan.execution.assetId, executionJob.id); assert.equal(plan.archive.operationId, archived.id);
  assert.equal(plan.profileSnapshot.sessionRevision, session.revision);
  const preflight = await plans.preflight({ planVersionId: plan.id, readId: randomUUID() });
  assert.equal(preflight.state, 'blocked'); assert.equal(preflight.formalReady, false); assert.equal(preflight.gateB, 'NOT_RUN');
  assert.equal(preflight.checks.filter(check => check.category !== 'backend').every(check => check.state === 'passed'), true);
  assert.equal(preflight.checks.find(check => check.category === 'backend')?.code, 'BACKEND_NOT_CERTIFIED');
  const begin = { commandId: randomUUID(), planVersionId: plan.id, planContentHash: plan.contentHash, userConfirmed: true as const };
  const production = createRecordingAttemptCoordinator({ store: repository.recordingAttempts });
  try { await assert.rejects(production.begin(begin), { code: 'BACKEND_NOT_CERTIFIED' }); }
  finally { await production.close(); }
  assert.equal(attempts.list({ page }).total, 0, '默认拒绝后无Attempt或Record；同一命令仅在构造器合成驱动内重试');
  assert.equal(records.list({ page }).total, 0);
  return { repository, sources, media, versions, plans, archive, execution, executionSelection, fakeDevice, attempts, records, starts, driverCounts: () => ({ closes, stops }), close, filePath, files, originalBytes, draft, unrelated, master, layout, workspace, session, plan, begin, archived, archiveRequest };
}

test('V3主流程：干净库源失败恢复、Track/Program编排、冻结身份与归档、默认拒绝及合成Attempt结果冷启一致', async t => {
  const f = await journey(t);
  let current: RecordingAttempt = await f.attempts.begin(f.begin);
  const initial = structuredClone(current);
  for (let index = 0; index < current.sides.length; ++index) {
    if (index) {
      current = await f.attempts.confirm({ commandId: randomUUID(), attemptId: current.id, expectedRevision: current.revision, kind: 'flip', userConfirmed: true });
      current = await f.attempts.beginSide({ commandId: randomUUID(), attemptId: current.id, expectedRevision: current.revision, side: 'B', userConfirmed: true });
    }
    const driver = f.starts[index]!, side = current.sides[index]!, at = new Date().toISOString();
    assert.equal(driver.attempt.planVersionId, f.plan.id); assert.equal(driver.attempt.physicalId, f.layout.reservation.physicalId);
    const pcm = createHash('sha256');
    let readFrames = 0, sourceEof = false;
    while (!sourceEof) {
      const chunk = await driver.input.consumer.readFrames(readFrames, 4096);
      pcm.update(chunk.bytes); readFrames += chunk.frames; sourceEof = chunk.sourceEof;
    }
    assert.equal(readFrames, side.frameCount); assert.equal(pcm.digest('hex'), driver.input.audio.pcmSha256);
    driver.onEvent({ type: 'progress', side: side.side, runId: driver.runId, at, sourceFramesRead: side.frameCount, submittedFrames: side.frameCount, consumedFrames: side.frameCount });
    for (const type of ['source-eof', 'engine-cutoff', 'cleanup-quiescent', 'backend-drained'] as const) driver.onEvent({ type, side: side.side, runId: driver.runId, at });
    await waitForVerifiedOutputRun(f.repository, current.id, driver.runId);
    current = f.attempts.get({ attemptId: current.id }).attempt!;
    assert.notEqual(current.status, 'completed', '软件EOF/排空/关闭屏障不能冒充实体确认');
    assert.equal(f.records.list({ page }).total, 0);
    current = await f.attempts.confirm({ commandId: randomUUID(), attemptId: current.id, expectedRevision: current.revision, kind: 'physical-stop', side: side.side, userConfirmed: true });
  }
  current = await f.attempts.confirm({ commandId: randomUUID(), attemptId: current.id, expectedRevision: current.revision, kind: 'physical-recording', userConfirmed: true });
  assert.equal(f.records.list({ page }).total, 0, '尚未最终核验，不能生成正式档案');
  const finalRequest = { commandId: randomUUID(), attemptId: current.id, expectedRevision: current.revision, kind: 'final-verification' as const, userConfirmed: true as const };
  const completed = await f.attempts.confirm(finalRequest); assert.equal(completed.status, 'completed');
  const recordId = f.records.list({ page }).items[0]!.id, detail = f.records.get({ id: recordId }).record!;
  assert.deepEqual(detail.record.completion, completed); assert.equal(detail.plan.contentHash, f.plan.contentHash);
  assert.equal(detail.plan.archive.operationId, f.archived.id); assert.equal(detail.current.knowledge.state, 'confirmed-recording');
  assert.equal(f.records.list({ page, filter: { masterVersionId: randomUUID() } }).total, 0);
  assert.deepEqual(await f.attempts.begin(f.begin), initial, '重复Begin重放原受理回执，不开第二个流');
  assert.deepEqual(await f.attempts.confirm(finalRequest), completed); assert.equal(f.starts.length, 2);
  assert.deepEqual(f.driverCounts(), { closes: 2, stops: 2 });
  const archived = f.repository.archive.operation(f.archived.id), references = f.repository.archive.references(f.archived.id);
  const events = f.repository.recordingRecords.read(db => db.prepare('SELECT * FROM recording_attempt_events WHERE attempt_id=? ORDER BY revision').all(completed.id));
  for (const [index, file] of f.files.entries()) assert.deepEqual(await readFile(file), f.originalBytes[index]);
  await f.close();
  const reopened = createCollectionRepository({ filePath: f.filePath });
  let reopenedStarts = 0;
  const resumed = createRecordingAttemptCoordinator({ store: reopened.recordingAttempts, admissionProvider: { async authorize() {}, async start() { ++reopenedStarts; assert.fail('冷启或幂等重放不许自动采集'); } } });
  const records = createRecordingRecordCoordinator({ store: reopened.recordingRecords, assertCurrent() {}, assertExecutionIdle: () => resumed.assertExecutionIdle() });
  try {
    assert.deepEqual(resumed.get({ attemptId: completed.id }).attempt, completed);
    assert.deepEqual(await resumed.begin(f.begin), initial); assert.deepEqual(await resumed.confirm(finalRequest), completed);
    assert.deepEqual(records.get({ id: recordId }).record, detail); assert.equal(records.list({ page }).total, 1);
    assert.deepEqual(reopened.versions.list(f.draft.draftId).masters, [f.master]);
    assert.deepEqual(reopened.recordingPlans.version({ id: f.plan.id }).plan, f.plan);
    assert.deepEqual(reopened.recordingProfiles.session(f.draft.draftId).session, f.session);
    assert.deepEqual(reopened.archive.operation(f.archived.id), archived); assert.deepEqual(reopened.archive.references(f.archived.id), references);
    assert.deepEqual(reopened.recordingRecords.read(db => db.prepare('SELECT * FROM recording_attempt_events WHERE attempt_id=? ORDER BY revision').all(completed.id)), events);
    assert.equal(reopened.workspace.get(f.draft.draftId)?.selection.layoutId, f.layout.id);
    assert.equal(reopened.workspace.get(f.unrelated.draftId), null); assert.equal(reopenedStarts, 0);
  } finally { records.close(); await resumed.close(); reopened.close(); }
});

test('V3主流程：中途主动取消无成功档案；冷启保留Attempt/回执/归档而不续录', async t => {
  const f = await journey(t), accepted = await f.attempts.begin(f.begin);
  const stop = { commandId: randomUUID(), attemptId: accepted.id };
  const aborted = await f.attempts.stop(stop);
  assert.equal(aborted.status, 'aborted'); assert.equal(aborted.reason, 'user-stop');
  assert.equal(f.records.list({ page }).total, 0);
  const archived = f.repository.archive.operation(f.archived.id);
  await f.close();
  const reopened = createCollectionRepository({ filePath: f.filePath });
  const resumed = createRecordingAttemptCoordinator({ store: reopened.recordingAttempts });
  const records = createRecordingRecordCoordinator({ store: reopened.recordingRecords, assertCurrent() {}, assertExecutionIdle: () => resumed.assertExecutionIdle() });
  try {
    assert.deepEqual(resumed.get({ attemptId: aborted.id }).attempt, aborted);
    assert.deepEqual(await resumed.begin(f.begin), accepted); assert.deepEqual(await resumed.stop(stop), aborted);
    assert.equal(records.list({ page }).total, 0); assert.deepEqual(reopened.archive.operation(f.archived.id), archived);
    assert.equal(records.history({ physicalId: aborted.physicalId, page }).state.knowledge.state, 'unknown');
    await assert.rejects(resumed.confirm({ commandId: randomUUID(), attemptId: aborted.id, expectedRevision: aborted.revision, kind: 'final-verification', userConfirmed: true }));
  } finally { records.close(); await resumed.close(); reopened.close(); }
});

test('V3主流程：取消后须显式处置与新冻结Plan才能新Attempt；旧失败/新谱系冷启分离', async t => {
  const f = await journey(t), first = await f.attempts.begin(f.begin);
  const stopped = await f.attempts.stop({ commandId: randomUUID(), attemptId: first.id });
  const aborted = await f.attempts.confirm({ commandId: randomUUID(), attemptId: first.id, expectedRevision: stopped.revision, kind: 'physical-stop', side: 'A', userConfirmed: true });
  await assert.rejects(f.attempts.begin({ ...f.begin, commandId: randomUUID() }), '未知实体不能直接借旧Plan重试');
  assert.equal(f.starts.length, 1); assert.equal(f.records.list({ page }).total, 0);
  const preview = await f.media.preview({ draftId: f.draft.draftId, spec: f.layout.spec, page });
  const media = await f.media.save({ commandId: randomUUID(), draftId: f.draft.draftId, expectedDraftRevision: preview.draftRevision, inputFingerprint: preview.inputFingerprint, spec: f.layout.spec });
  const state = f.records.history({ physicalId: first.physicalId, page }).state;
  const disposition = f.records.previewDisposition({ physicalId: first.physicalId, expectedPhysicalRevision: state.physicalRevision, expectedContentRevision: state.revision, expectedAttempt: { id: aborted.id, revision: aborted.revision }, intent: { action: 'prepare-rerecord', mediaPlanId: media.id, expectedMediaPlanRevision: media.revision } });
  const permitted = f.records.applyDisposition({ ...disposition.request, commandId: randomUUID(), proposalFingerprint: disposition.proposalFingerprint, userConfirmed: true });
  assert.equal(permitted.state.activeRerecordPermit?.state, 'available');
  const versionPreview = await f.versions.preview({ planId: permitted.mediaPlan!.id, sampleRate: 44100 });
  const version = await f.versions.freeze({ commandId: randomUUID(), planId: permitted.mediaPlan!.id, sampleRate: 44100, proposalFingerprint: versionPreview.proposalFingerprint, userConfirmed: true });
  await f.versions.idle();
  const layoutId = f.versions.job(version.id).job!.layoutVersionId!;
  const executionSelection = { ...f.executionSelection, layoutVersionId: layoutId };
  const assetPreview = await f.execution.preview({ ...executionSelection, readId: randomUUID() });
  const asset = await f.execution.start({ ...executionSelection, commandId: randomUUID(), proposalFingerprint: assetPreview.proposalFingerprint, userConfirmed: true });
  await f.execution.idle(); assert.equal(f.execution.job(asset.id).job?.state, 'completed');
  const archiveSelection = { rootId: f.archived.rootId, assetId: asset.id, sourcePolicy: 'preserve-exact-sources' as const };
  const archivePreview = await f.archive.preview({ ...archiveSelection, readId: randomUUID() });
  const archived = await f.archive.start({ ...archiveSelection, commandId: randomUUID(), proposalFingerprint: archivePreview.proposalFingerprint, userConfirmed: true });
  await f.archive.idle(); assert.equal(f.archive.operation(archived.id).operation?.phase, 'FINALIZED');
  const selection = { assetId: asset.id, archiveOperationId: archived.id, outputSelection: f.fakeDevice.outputSelection! };
  const planPreview = await f.plans.preview({ selection, readId: randomUUID() });
  const plan = await f.plans.freeze({ selection, commandId: randomUUID(), proposalFingerprint: planPreview.proposalFingerprint, userConfirmed: true });
  assert.notEqual(plan.id, f.plan.id); assert.equal(plan.master.id, f.master.id); assert.notEqual(plan.layout.id, f.layout.id);
  const begin = { commandId: randomUUID(), planVersionId: plan.id, planContentHash: plan.contentHash, userConfirmed: true as const };
  const next = await f.attempts.begin(begin);
  assert.notEqual(next.id, first.id); assert.equal(next.physicalId, first.physicalId); assert.equal(next.planVersionId, plan.id);
  const oldDriver = f.starts[0]!;
  for (const type of ['source-eof', 'backend-drained'] as const) oldDriver.onEvent({ type, side: oldDriver.side, runId: oldDriver.runId, at: new Date().toISOString() });
  assert.deepEqual(f.attempts.get({ attemptId: next.id }).attempt, next, '迟到旧Run回报不能结束或推进新Attempt');
  assert.deepEqual(f.attempts.get({ attemptId: first.id }).attempt, aborted);
  assert.equal(f.records.history({ physicalId: first.physicalId, page }).state.activeRerecordPermit, null);
  const stop = { commandId: randomUUID(), attemptId: next.id }, second = await f.attempts.stop(stop);
  const beforeHistory = f.records.history({ physicalId: first.physicalId, page });
  await f.close();
  const reopened = createCollectionRepository({ filePath: f.filePath });
  const attempts = createRecordingAttemptCoordinator({ store: reopened.recordingAttempts });
  const records = createRecordingRecordCoordinator({ store: reopened.recordingRecords, assertCurrent() {}, assertExecutionIdle: () => attempts.assertExecutionIdle() });
  try {
    assert.deepEqual(attempts.get({ attemptId: first.id }).attempt, aborted); assert.deepEqual(attempts.get({ attemptId: next.id }).attempt, second);
    assert.deepEqual(await attempts.begin(begin), next); assert.deepEqual(await attempts.stop(stop), second);
    assert.deepEqual(records.history({ physicalId: first.physicalId, page }), beforeHistory); assert.equal(records.list({ page }).total, 0);
    assert.equal(reopened.recordingPlans.version({ id: plan.id }).plan?.archive.operationId, archived.id);
    assert.equal(reopened.recordingPlans.version({ id: f.plan.id }).plan?.archive.operationId, f.archived.id);
  } finally { records.close(); await attempts.close(); reopened.close(); }
});
