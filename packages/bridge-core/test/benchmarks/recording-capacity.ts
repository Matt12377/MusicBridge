import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { appendFileSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync, backup } from 'node:sqlite';
import { performance } from 'node:perf_hooks';
import { createCapacitySeed, summarizeCapacitySamples, readCapacityBudget, capacityProfile, createCapacityClone, finishCapacityClone,
  hashCapacityFile, checkCapacitySpace, appendCapacityMeasureStage, capacityMeasurePlan, runCapacityStopRounds,
  prepareCapacityStopPlans, summarizeCapacityFixtureTree,
  type CapacityMeasureGroup, type CapacityMeasureSample, type CapacitySample,
  type CapacityProfileName, type CapacityStopWorkspace } from '../helpers/recording-capacity-fixture.js';
import { createCollectionRepository } from '../../src/collection/repository.js';
import { createRecordingAttemptCoordinator, type RecordingAttemptDriverRequest } from '../../src/recording/attempt-coordinator.js';
import { createRecordingRecordCoordinator } from '../../src/recording/record-coordinator.js';
import { verifyRecordingAttemptDatabase } from '../../src/recording/attempt-integrity.js';
import { verifyRecordingRecordDatabase } from '../../src/recording/record-integrity.js';
import { verifyRecordingPlanDatabase } from '../../src/recording/plan-integrity.js';

// 此文件不在默认*.test.ts glob；只有明确CLI阶段和唯一标签才会创建证据目录。
const root = fileURLToPath(new URL('../../../../', import.meta.url));
if (realpathSync(process.cwd()) !== realpathSync(root)) throw new Error('容量入口必须在任务根目录显式运行');
const options = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i], value = process.argv[i + 1];
  if (!key || !value || !['--phase', '--profile', '--label', '--seed-label', '--window', '--runtime-root'].includes(key) || options.has(key)) throw new Error('容量入口参数无效');
  options.set(key, value);
}
const phase = options.get('--phase'), profile = options.get('--profile'), label = options.get('--label');
if (!['generate', 'measure'].includes(phase ?? '') || !profile || !label || !/^[a-z0-9-]{1,64}$/u.test(label)) throw new Error('需要明确phase、已实现profile和新唯一label');
const profileDefinition = capacityProfile(profile as CapacityProfileName);
const seedLabel = options.get('--seed-label'), window = options.get('--window');
if (phase === 'measure' && (!seedLabel || !/^[a-z0-9-]{1,64}$/u.test(seedLabel) || !window || !/^[a-z0-9-]{1,64}$/u.test(window))) throw new Error('性能采样需明确种子与总控已批准的独占窗口标签');
if (phase === 'generate' && !['pilot', 'history-small'].includes(profile) && (!window || !/^[a-z0-9-]{1,64}$/u.test(window))) throw new Error('新增大profile生成需明确已批准独占窗口');
const runtimeOption = options.get('--runtime-root');
if (phase === 'generate' && runtimeOption !== undefined) throw new Error('generate不得接受runtime-root');
if (phase === 'measure' && runtimeOption === undefined) throw new Error('measure必须显式提供TASK078 runtime-root');
function validatedMeasureRuntime(value: string): string {
  if (!path.isAbsolute(value)) throw new Error('runtime-root必须是绝对规范目录');
  if (path.resolve(value) === realpathSync(root)) throw new Error('runtime-root不得等于TASK079 candidate root');
  let info;
  try { info = lstatSync(value); } catch { throw new Error('runtime-root必须是存在的绝对规范目录'); }
  if (info.isSymbolicLink()) throw new Error('runtime-root不得是符号链接');
  if (!info.isDirectory()) throw new Error('runtime-root必须是存在的绝对规范目录');
  const canonical = realpathSync(value);
  if (canonical !== value) throw new Error('runtime-root必须是绝对规范目录');
  const runtimeParent = path.dirname(canonical), reports = path.dirname(runtimeParent), task078 = path.dirname(reports);
  if (path.basename(canonical) !== 'task-078-v3-acceptance' || path.basename(runtimeParent) !== 'runtime'
      || path.basename(reports) !== 'reports' || path.basename(task078) !== 'task-078-v3-acceptance') {
    throw new Error('runtime-root结构必须绑定TASK078');
  }
  return canonical;
}
const runtime = phase === 'measure' ? validatedMeasureRuntime(runtimeOption!) : path.join(root, 'reports/runtime/task-078-v3-acceptance');
const output = path.join(runtime, label); mkdirSync(output);
const json = (name: string, value: unknown) => {
  const fd = openSync(path.join(output, name), 'wx');
  try { writeFileSync(fd, JSON.stringify(value, null, 2) + '\n'); fsyncSync(fd); } finally { closeSync(fd); }
  const directory = openSync(output, 'r'); try { fsyncSync(directory); } finally { closeSync(directory); }
};
const sha = hashCapacityFile;
const codePaths = ['attempt', 'record', 'print'].flatMap(group => ['store', 'coordinator', 'integrity'].map(kind => `packages/bridge-core/src/recording/${group}-${kind}.ts`));
const pins = () => Object.fromEntries(codePaths.map(file => [file, execFileSync('git', ['hash-object', file], { cwd: root, encoding: 'utf8' }).trim()]));
const initialPins = pins(); json('source-before.json', initialPins);
json('command.json', { executable: process.execPath, args: process.argv.slice(1), cwd: root, node: process.version, platform: process.platform, arch: process.arch,
  osVersion: os.version(), logicalCpus: os.cpus().length, cache: 'OS cache未知/可能warm；未清cache，不是物理冷盘', profileDefinition,
  phase, profile, window: window ?? null, deviceOpened: false, formalReady: false, gateB: 'NOT_RUN' });
const recordExit = (code: number) => { if (!existsSync(path.join(output, 'exit.json'))) json('exit.json', { exit: code }); };
process.once('exit', code => recordExit(code));

test(`R023 ${phase} ${profile}`, { timeout: 45 * 60_000 }, async t => {
  t.after(() => { const finalPins = pins(); json('source-after.json', finalPins); assert.deepEqual(finalPins, initialPins, '测量过程中生产代码变化，不能作为冻结候选证据'); });
  if (phase === 'generate') {
    const marker = { id: randomUUID(), scope: 'musicbridge-capacity-synthetic-only' }; let marked = false, checkpoint = 0;
    const f = await createCapacitySeed(t, { profile: profile as CapacityProfileName, retainDirectory: true, checkpoint(value) {
      const fixtureDirectory = (value as { fixtureDirectory: string }).fixtureDirectory;
      if (!marked) { writeFileSync(path.join(fixtureDirectory, 'capacity-owner.json'), JSON.stringify(marker), { flag: 'wx' }); marked = true; }
      json(`checkpoint-${++checkpoint}.json`, value);
    } });
    assert.equal(f.manifest.budget.attempts, f.manifest.budget.records, '种子只能保留Completed，nextPlan不能提前Begin');
    assert.equal(f.db.prepare("SELECT count(*) n FROM recording_attempts WHERE status='in-progress'").get()!.n, 0);
    if (!marked) writeFileSync(path.join(f.directory, 'capacity-owner.json'), JSON.stringify(marker), { flag: 'wx' });
    json('space-before-snapshot.json', checkCapacitySpace(output, 2 * (f.manifest.budget.photoBytes + f.manifest.budget.printObjectBytes + f.manifest.budget.attemptBytes) + 256 * 1024 ** 2));
    const snapshot = path.join(output, 'seed.sqlite'); await backup(f.db, snapshot);
    const record = f.db.prepare('SELECT id,data FROM recording_records WHERE attempt_id=?').get(f.manifest.completedAttemptId)!;
    json('seed.json', { ...f.manifest, marker, fixtureDirectory: f.directory, snapshotSha256: sha(snapshot),
      nextPlanHash: f.nextPlan.contentHash, recordingId: String(record.id), recordSha256: createHash('sha256').update(String(record.data)).digest('hex'),
      retained: true, cleanup: '全部服务关闭，合成目录保留供下一独占窗口复核' });
    if ('growth' in f.manifest) assert.equal(f.manifest.growth.state, 'target-reached', '联合边界或生成上限先触发，合法partial不得改称profile通过');
    return;
  }

  const seedDirectory = path.join(runtime, seedLabel!), seedPath = path.join(seedDirectory, 'seed.sqlite');
  const seed = JSON.parse(readFileSync(path.join(seedDirectory, 'seed.json'), 'utf8')) as {
    schema: number; profile: string; fixtureDirectory: string; snapshotSha256: string; marker: { id: string; scope: string };
    nextPlanId: string; nextPlanHash: string; recordingId: string; completedPhysicalId: string; growth?: { state: string };
  };
  assert.equal(seed.schema, 21); assert.equal(seed.profile, profile);
  if (seed.growth) assert.equal(seed.growth.state, 'target-reached', '未达到profile目标的种子不可作为该档测量');
  assert.ok(path.basename(seed.fixtureDirectory).startsWith('musicbridge-version-'));
  assert.deepEqual(JSON.parse(readFileSync(path.join(seed.fixtureDirectory, 'capacity-owner.json'), 'utf8')), seed.marker);
  assert.equal(seed.marker.scope, 'musicbridge-capacity-synthetic-only');
  const fixtureBefore = summarizeCapacityFixtureTree(seed.fixtureDirectory); json('fixture-before.json', fixtureBefore);
  t.after(() => {
    const fixtureAfter = summarizeCapacityFixtureTree(seed.fixtureDirectory); json('fixture-after.json', fixtureAfter);
    assert.deepEqual(fixtureAfter, fixtureBefore, 'measure不得改写共享generation fixture的身份或内容');
  });
  json('measurement.json', { seedLabel, seedSha256: seed.snapshotSha256, profile, window, classification: 'software-only/exclusive-window',
    cache: '新DatabaseSync实例，OS页缓存未清理；不是物理冷盘。此入口不测新Node进程或UI ready。',
    measurePlan: { groupCloneCount: 3, fullHashCount: 3, stopRoundReceiptCount: 105, sampleCount: 1575 },
    excluded: ['真实设备无声', '新进程冷启', '完整恢复50s', '真实Print领取/写入', '父IPC排队Stop'] });
  const grouped = new Map<string, CapacitySample[]>();
  const allSamples: unknown[] = [];
  const samplePath = path.join(output, 'samples.jsonl');
  function sample(metric: string, durationMs: number, warmup: boolean, outcome: CapacitySample['outcome'] = 'ok', details: unknown = null): CapacityMeasureSample {
    const row = { metric, durationMs, warmup, outcome, details }; allSamples.push(row);
    const fd = openSync(samplePath, 'a'); try { appendFileSync(fd, JSON.stringify(row) + '\n'); fsyncSync(fd); } finally { closeSync(fd); }
    if (!warmup) { const values = grouped.get(metric) ?? []; values.push({ durationMs, outcome }); grouped.set(metric, values); }
    return row;
  }
  function commitSamples(rows: CapacityMeasureSample[]): void {
    const fd = openSync(samplePath, 'a');
    try { appendFileSync(fd, rows.map(row => JSON.stringify(row)).join('\n') + '\n'); fsyncSync(fd); } finally { closeSync(fd); }
    for (const row of rows) {
      allSamples.push(row);
      if (!row.warmup) { const values = grouped.get(row.metric) ?? []; values.push({ durationMs: row.durationMs, outcome: row.outcome }); grouped.set(row.metric, values); }
    }
  }
  function openGroup(group: CapacityMeasureGroup) {
    const clone = createCapacityClone(output, `group-${group}`, seedPath), filePath = clone.filePath;
    appendCapacityMeasureStage(output, group, 'copy', { groupMarker: clone.marker, seedSha256: seed.snapshotSha256 });
    const repository = createCollectionRepository({ filePath }), auditDb = new DatabaseSync(filePath, { readOnly: true });
    // 打开及完整审计在计时外；独立冷开指标由总控/A另测同一seed。
    try {
      repository.recordingPlans.version({ id: seed.nextPlanId });
      assert.equal(auditDb.prepare("SELECT count(*) n FROM recording_attempts WHERE status='in-progress'").get()!.n, 0);
      appendCapacityMeasureStage(output, group, 'open-audit', { groupMarker: clone.marker, inProgress: 0 });
    } catch (error) {
      auditDb.close(); repository.close(); throw error;
    }
    return { group, filePath, repository, auditDb, clone };
  }
  async function running(repository: ReturnType<typeof createCollectionRepository>, selectedPlan: { id: string; contentHash: string } = { id: seed.nextPlanId, contentHash: seed.nextPlanHash }) {
    let driver: RecordingAttemptDriverRequest | undefined;
    const times: Record<string, number> = {};
    const coordinator = createRecordingAttemptCoordinator({ store: repository.recordingAttempts, admissionProvider: {
      async authorize() {}, async start(request) {
        driver = request;
        request.signal.addEventListener('abort', () => { times.signalAborted = performance.now(); }, { once: true });
        return { async stop() { times.driverStopInvoked = performance.now(); times.driverStopAck = performance.now(); },
          async close() { times.driverCloseInvoked = performance.now(); times.driverCloseResolved = performance.now(); } };
      },
    } });
    try {
      const beginCommandId = randomUUID();
      const attempt = await coordinator.begin({ commandId: beginCommandId, planVersionId: selectedPlan.id, planContentHash: selectedPlan.contentHash, userConfirmed: true });
      return { coordinator, attempt, beginCommandId, driver: driver!, times };
    } catch (error) { await coordinator.close(); throw error; }
  }

  const plan = capacityMeasurePlan(); assert.equal(plan.totalSamples, 1575);
  const progressGroup = openGroup('progress'), progress = await running(progressGroup.repository);
  appendCapacityMeasureStage(output, 'progress', 'operation', { rounds: plan.progressRounds });
  let progressOutcome: CapacitySample['outcome'] = 'ok';
  try {
    for (let i = 0; i < plan.progressRounds; ++i) {
      const start = performance.now(), frames = i + 1;
      progress.driver.onEvent({ type: 'progress', side: progress.driver.side, runId: progress.driver.runId, at: new Date().toISOString(), sourceFramesRead: frames, submittedFrames: frames, consumedFrames: frames });
      const durationMs = performance.now() - start;
      const state = progress.coordinator.get({ attemptId: progress.attempt.id }).attempt!;
      sample('progress', durationMs, i < 5, state.sides[0]!.consumedFrames === frames && state.status === 'in-progress' ? 'ok' : 'failed');
    }
    if (allSamples.some(value => (value as CapacitySample).outcome !== 'ok')) throw new Error('PROGRESS_GROUP_FAILED');
  } catch (error) { progressOutcome = 'failed'; throw error; }
  finally {
    let closeError: unknown;
    appendCapacityMeasureStage(output, 'progress', 'round-fsync', { completedSamples: allSamples.length,
      expectedSamples: plan.progressRounds });
    try { await progress.coordinator.close(); } catch (error) { progressOutcome = 'failed'; closeError = error; }
    progressGroup.auditDb.close(); progressGroup.repository.close();
    if (progressOutcome === 'ok') finishCapacityClone(progressGroup.clone, { outcome: 'ok', resourcesClosed: true, samples: allSamples.slice(0, plan.progressRounds),
      onPhase: (phaseName, details) => appendCapacityMeasureStage(output, 'progress', phaseName, details) });
    if (closeError) throw closeError;
  }

  const stopGroup = openGroup('stop'), stopStart = allSamples.length;
  let stopOutcome: CapacitySample['outcome'] = 'ok', stopWorkspace: CapacityStopWorkspace | undefined;
  try {
    // 计时前经公开Core路径准备独立实体及冻结Plan；不重放physical copy，不伪造rerecord permit。
    const template = stopGroup.repository.recordingPlans.version({ id: seed.nextPlanId }).plan!;
    const prepared = await prepareCapacityStopPlans(stopGroup.repository, template, plan.stopRounds, path.join(stopGroup.clone.directory, 'group-stop-workspace'));
    const stopPlans = prepared.plans; stopWorkspace = prepared.workspace;
    verifyRecordingPlanDatabase(stopGroup.auditDb); verifyRecordingAttemptDatabase(stopGroup.auditDb); verifyRecordingRecordDatabase(stopGroup.auditDb);
    assert.equal(stopPlans.length, plan.stopRounds); assert.equal(new Set(stopPlans.map(value => value.physicalCopy.physicalId)).size, plan.stopRounds);
    await runCapacityStopRounds(stopGroup.clone, plan.stopRounds, async roundIndex => {
      const inProgressBefore = Number(stopGroup.auditDb.prepare("SELECT count(*) n FROM recording_attempts WHERE status='in-progress'").get()!.n);
      assert.equal(inProgressBefore, 0, '每轮Begin前不得存在in-progress Attempt');
      const f = await running(stopGroup.repository, stopPlans[roundIndex - 1]!), received = performance.now(), commandId = randomUUID();
      let outcome: CapacitySample['outcome'] = 'ok', stopError: unknown;
      try { await f.coordinator.stop({ commandId, attemptId: f.attempt.id }); }
      catch (error) { outcome = 'failed'; stopError = error; }
      f.times.receiptSettled = performance.now();
      try { await f.coordinator.close(); } catch (error) { outcome = 'failed'; stopError ??= error; }
      const terminal = stopGroup.repository.recordingAttempts.get({ attemptId: f.attempt.id }).attempt!;
      const inProgressAfter = Number(stopGroup.auditDb.prepare("SELECT count(*) n FROM recording_attempts WHERE status='in-progress'").get()!.n);
      const samples: CapacityMeasureSample[] = ['signalAborted', 'driverStopInvoked', 'driverStopAck', 'driverCloseInvoked', 'driverCloseResolved', 'receiptSettled'].map(key => {
        const at = f.times[key]; if (at === undefined) outcome = 'failed';
        return { metric: key, durationMs: (at ?? performance.now()) - received, warmup: roundIndex <= 5, outcome,
          details: { roundIndex, observed: at !== undefined, attemptId: f.attempt.id, commandId } };
      });
      if (stopError || outcome !== 'ok') throw stopError ?? new Error('STOP_ROUND_FAILED');
      assert.equal(inProgressAfter, 0); assert.equal(terminal.status, 'aborted'); assert.equal(terminal.reason, 'user-stop');
      return { attemptId: f.attempt.id, commandId, inProgressBefore: 0 as const, inProgressAfter: 0 as const,
        attemptStatus: 'aborted' as const, attemptReason: 'user-stop' as const,
        coordinatorClosed: true as const, repositoryOpen: true as const, samples };
    }, receipt => commitSamples(receipt.samples));
    verifyRecordingPlanDatabase(stopGroup.auditDb); verifyRecordingAttemptDatabase(stopGroup.auditDb); verifyRecordingRecordDatabase(stopGroup.auditDb);
  } catch (error) { stopOutcome = 'failed'; throw error; }
  finally {
    stopGroup.auditDb.close(); stopGroup.repository.close();
    if (stopOutcome === 'ok') {
      assert.ok(stopWorkspace);
      finishCapacityClone(stopGroup.clone, { outcome: 'ok', resourcesClosed: true, samples: allSamples.slice(stopStart),
        ownedWorkspace: stopWorkspace,
        onPhase: (phaseName, details) => appendCapacityMeasureStage(output, 'stop', phaseName, details) });
    }
  }

  const reading = openGroup('read');
  const records = createRecordingRecordCoordinator({ store: reading.repository.recordingRecords, assertCurrent() {}, assertExecutionIdle() {} });
  const readingStart = allSamples.length; let readingOutcome: CapacitySample['outcome'] = 'ok';
  try {
    appendCapacityMeasureStage(output, 'read', 'operation', { operations: plan.readOperations, roundsPerOperation: plan.readRoundsPerOperation });
    const detail = records.get({ id: seed.recordingId }).record!, attachment = detail.record.visuals.photos;
    assert.equal(attachment.state, 'captured');
    const job = reading.repository.recordingPrints.list({ recordingId: seed.recordingId, page: { offset: 0, limit: 25 } }).items[0]!;
    const artifact = reading.repository.recordingPrints.get({ recordingId: seed.recordingId, artifactId: job.artifactId! }).artifact;
    const totalRecords = records.list({ page: { offset: 0, limit: 25 } }).total;
    const operations: [string, () => unknown][] = [
      ['recordList', () => records.list({ page: { offset: 0, limit: 25 } })],
      ['queryLastPage', () => records.list({ page: { offset: Math.max(0, totalRecords - 25), limit: 25 } })],
      ['queryChinese', () => records.list({ page: { offset: 0, limit: 25 }, filter: { query: '长中文曲序及归档检索' } })],
      ['queryMissing', () => records.list({ page: { offset: 0, limit: 25 }, filter: { query: 'never-matches-capacity-query' } })],
      ['queryPhysical', () => records.list({ page: { offset: 0, limit: 25 }, filter: { physicalId: seed.completedPhysicalId } })],
      ['emptyPoll', () => reading.repository.recordingPrints.claim({ workerId: randomUUID() })],
      ['pdf', () => reading.repository.recordingPrints.pdf({ recordingId: seed.recordingId, artifactId: artifact.id, expectedPdfSha256: artifact.pdfSha256 })],
      ['photo', () => records.visual({ recordingId: seed.recordingId, attachmentId: attachment.state === 'captured' ? attachment.attachments[0]!.id : '' })],
    ];
    for (const [metric, action] of operations) {
      const expected = action();
      for (let i = 0; i < plan.readRoundsPerOperation; ++i) {
        const started = performance.now(); let actual: unknown, outcome: CapacitySample['outcome'] = 'ok';
        try { actual = action(); } catch { outcome = 'failed'; }
        const durationMs = performance.now() - started;
        try { assert.deepEqual(actual, expected); } catch { outcome = 'failed'; }
        if (outcome !== 'ok') readingOutcome = 'failed';
        sample(metric, durationMs, i < 5, outcome);
      }
    }
    const db = new DatabaseSync(reading.filePath, { readOnly: true }); try { json('end-budget.json', readCapacityBudget(db)); } finally { db.close(); }
  } catch (error) { readingOutcome = 'failed'; throw error; }
  finally {
    appendCapacityMeasureStage(output, 'read', 'round-fsync', { completedSamples: allSamples.length - readingStart,
      expectedSamples: plan.readOperations * plan.readRoundsPerOperation });
    records.close(); reading.auditDb.close(); reading.repository.close();
    if (readingOutcome === 'ok') finishCapacityClone(reading.clone, { outcome: 'ok', resourcesClosed: true, samples: allSamples.slice(readingStart),
      onPhase: (phaseName, details) => appendCapacityMeasureStage(output, 'read', phaseName, details) });
  }
  assert.equal(allSamples.length, plan.totalSamples, '正式measure样本必须精确拼接为1575条');
  const metrics = Object.fromEntries([...grouped].map(([name, values]) => [name, summarizeCapacitySamples(values)]));
  const limits: Record<string, { max: number; p95?: number }> = {
    progress: { max: 100, p95: 50 }, signalAborted: { max: 100 }, driverStopInvoked: { max: 100 }, receiptSettled: { max: 2000, p95: 500 },
    driverCloseResolved: { max: 250 }, recordList: { max: 1000, p95: 250 }, queryMissing: { max: 1000, p95: 250 }, queryPhysical: { max: 1000, p95: 250 },
    queryLastPage: { max: 1000, p95: 250 }, queryChinese: { max: 1000, p95: 250 },
    emptyPoll: { max: 50 }, pdf: { max: 1000, p95: 250 }, photo: { max: 1000, p95: 250 },
  };
  const verdict = Object.fromEntries(Object.entries(limits).map(([metric, limit]) => { const stats = metrics[metric]!;
    return [metric, stats.complete && stats.max !== null && stats.max <= limit.max && (limit.p95 === undefined || stats.p95 !== null && stats.p95 <= limit.p95)]; }));
  json('summary.json', { metrics, verdict, limits, allMeasuredPassed: Object.values(verdict).every(Boolean), fullR023Passed: false,
    reason: '只覆盖明确profile和本入口指标；最大规模、排队、新进程冷开及实际设备未通过此入口。', peakRssBytes: process.resourceUsage().maxRSS * 1024 });
  assert.ok(Object.values(verdict).every(Boolean), '所测软件指标存在超限或失败，原始样本已保留');
});
