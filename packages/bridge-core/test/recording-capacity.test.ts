import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomUUID, type Hash, type BinaryLike } from 'node:crypto';
import { fork, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { DatabaseSync, backup } from 'node:sqlite';
import { isMasterArtworkImage, isRecordingPrintPdfBase64 } from '@music-bridge/contracts';
import { chmodSync, mkdtempSync, realpathSync, writeFileSync, existsSync, readFileSync, rmSync, mkdirSync, lstatSync, linkSync, readdirSync, renameSync, symlinkSync, truncateSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('容量对象使用合法JPEG段和PDF偏移，精确字节/不同身份/固定上限可复核', async () => {
  const api = await import('./helpers/recording-capacity-fixture.js');
  for (const bytes of [4096, 1024 * 1024]) {
    const a = api.capacityJpeg({ bytes, id: 'sample-a' }), b = api.capacityJpeg({ bytes, id: 'sample-b' });
    assert.equal(a.length, bytes); assert.notDeepEqual(a, b);
    assert.equal(isMasterArtworkImage({ dataUrl: `data:image/jpeg;base64,${a.toString('base64')}`, width: 1, height: 1 }), true);
  }
  for (const bytes of [4096, 4 * 1024 * 1024]) {
    const pdf = api.capacityPdf({ bytes, id: 'sample-a' }); assert.equal(pdf.length, bytes);
    assert.equal(isRecordingPrintPdfBase64(pdf.toString('base64')), true);
    const text = pdf.toString(), offset = Number(/startxref\n(\d+)\n%%EOF/u.exec(text)![1]);
    assert.equal(text.slice(offset, offset + 4), 'xref');
    assert.notEqual(createHash('sha256').update(pdf).digest('hex'), createHash('sha256').update(api.capacityPdf({ bytes, id: 'sample-b' })).digest('hex'));
  }
  assert.throws(() => api.capacityJpeg({ bytes: 1024 * 1024 + 1, id: 'too-large' }));
  assert.throws(() => api.capacityPdf({ bytes: 4 * 1024 * 1024 + 1, id: 'too-large' }));
});

test('规模描述及增长判定区分已达目标、联合边界与尚未达到，不改性能门槛', async () => {
  const api = await import('./helpers/recording-capacity-fixture.js');
  const profile = api.capacityProfile('objects-small');
  assert.equal(profile.records, 25); assert.equal(profile.photoBytes, 32 * 1024 ** 2); assert.equal(profile.printObjectBytes, 32 * 1024 ** 2);
  const budget = { attemptBytes: 0, planBytes: 0, recordBytes: 0, printBytes: 0, photoBytes: 0, printObjectBytes: 0, attempts: 0, events: 0, receipts: 0, records: 0, plans: 0, printJobs: 0, printReceipts: 0 };
  assert.equal(api.capacityGrowth(profile, budget).state, 'continue');
  assert.equal(api.capacityGrowth(profile, { ...budget, records: 25, photoBytes: profile.photoBytes, printObjectBytes: profile.printObjectBytes }).state, 'target-reached');
  assert.equal(api.capacityGrowth(profile, { ...budget, planBytes: Math.ceil(.9 * 128 * 1024 ** 2) }).state, 'joint-boundary');
  assert.throws(() => api.capacityProfile('invented' as never));
  assert.throws(() => api.capacityGrowth(profile, { ...budget, events: 100001 }));
  const history = api.capacityProfile('history-limit');
  assert.equal(history.generationLimitMs, 1_200_000);
  assert.equal(api.capacityGrowth(history, { ...budget, records: 1, attemptBytes: history.attemptBytes }).state, 'target-reached');
  assert.equal(api.capacityGrowth(history, { ...budget, records: 1 }, history.progressEvents).state, 'target-reached');
  for (const name of ['objects-limit', 'joint'] as const) {
    const value = api.capacityProfile(name);
    assert.equal(api.capacityGrowth(value, { ...budget, records: value.records, attemptBytes: value.attemptBytes,
      recordBytes: value.recordBytes, printBytes: value.printBytes,
      photoBytes: value.photoBytes, printObjectBytes: value.printObjectBytes }, value.progressEvents).state, 'target-reached');
    assert.equal(api.capacityGrowth(value, { ...budget, records: value.records, photoBytes: value.photoBytes - 1, printObjectBytes: value.printObjectBytes }, value.progressEvents).state, 'continue');
  }
});

test('joint六轴包含Record／Print元数据50%目标，任一未达继续且非目标硬边界优先停止', async () => {
  const api = await import('./helpers/recording-capacity-fixture.js');
  const profile = api.capacityProfile('joint');
  assert.deepEqual(api.capacityGenerationPlan(profile), {
    model: 'serial-single-output-plus-bounded-growth-v1', activeOutputMaximum: 1,
    finalAxisBytes: 1_275_068_416, activeOutputBytes: 1_275_068_416,
    activeRecordWorkspaceBytes: 16 * 1024 ** 2, evidenceAllowanceBytes: 128 * 1024 ** 2,
    plannedBytes: 2_701_131_776,
  });
  const plan = api.capacityGenerationPlan(profile);
  assert.deepEqual(api.capacityGenerationSnapshotProjection(plan, 1_000, 2_000), {
    plannedWriteBytes: 2_000 + 128 * 1024 ** 2,
    totalProjectedBytes: 3_000 + 128 * 1024 ** 2,
  });
  assert.throws(() => api.capacityGenerationSnapshotProjection(
    plan, plan.plannedBytes - plan.evidenceAllowanceBytes - 2_000 + 1, 2_000,
  ), /joint快照写入前投影超过冻结generation预算/u);
  const mib64 = 64 * 1024 ** 2;
  assert.equal(profile.progressEvents, 50_000); assert.equal(profile.attemptBytes, mib64);
  assert.equal(profile.recordBytes, mib64); assert.equal(profile.printBytes, mib64);
  assert.equal(profile.photoBytes, 512 * 1024 ** 2); assert.equal(profile.printObjectBytes, 512 * 1024 ** 2);
  const reached = { attemptBytes: profile.attemptBytes, planBytes: 0, recordBytes: profile.recordBytes, printBytes: profile.printBytes,
    photoBytes: profile.photoBytes, printObjectBytes: profile.printObjectBytes, attempts: 0, events: 0, receipts: 0,
    records: profile.records, plans: 0, printJobs: 0, printReceipts: 0 };
  assert.equal(api.capacityGrowth(profile, reached, profile.progressEvents - 1).state, 'continue');
  assert.equal(api.capacityGrowth(profile, { ...reached, attemptBytes: profile.attemptBytes - 1 }, profile.progressEvents).state, 'continue');
  assert.deepEqual(api.capacityGrowth(profile, { ...reached, recordBytes: profile.recordBytes - 1 }, profile.progressEvents).state, 'continue');
  assert.deepEqual(api.capacityGrowth(profile, { ...reached, printBytes: profile.printBytes - 1 }, profile.progressEvents).state, 'continue');
  const complete = api.capacityGrowth(profile, reached, profile.progressEvents);
  assert.equal(complete.state, 'target-reached');
  assert.deepEqual(complete.reached, { attemptEvents: true, attemptBytes: true, recordBytes: true, printBytes: true, photoBytes: true, printObjectBytes: true });
  assert.deepEqual(complete.structural, { records: true });
  const boundary = api.capacityGrowth(profile, { ...reached, planBytes: Math.ceil(.9 * 128 * 1024 ** 2) }, profile.progressEvents);
  assert.equal(boundary.state, 'joint-boundary'); assert.deepEqual(boundary.boundary, ['planBytes']);
  const objects = api.capacityProfile('objects-limit');
  const objectTargets = { ...reached, attemptBytes: 0, recordBytes: Math.ceil(.9 * 128 * 1024 ** 2), printBytes: 0,
    records: objects.records, photoBytes: objects.photoBytes, printObjectBytes: objects.printObjectBytes };
  assert.deepEqual(api.capacityGrowth(objects, objectTargets).boundary, ['recordBytes'], '未选择的metadata轴达到硬边界不能被零target豁免');
  assert.equal(api.capacityHistoryReached(profile, reached, profile.progressEvents - 1), false);
  assert.equal(api.capacityHistoryReached(profile, { ...reached, attemptBytes: profile.attemptBytes - 1 }, profile.progressEvents), false);
  assert.equal(api.capacityHistoryReached(profile, reached, profile.progressEvents), true);
  const history = api.capacityProfile('history-limit');
  assert.equal(api.capacityHistoryReached(history, { ...reached, attemptBytes: history.attemptBytes }, 0), true, 'history-limit维持先到者语义');
});

test('缩小对象流程：同库两次真实Completed保留不同照片及PDF，移除source照片不改变历史', { timeout: 60_000 }, async t => {
  const api = await import('./helpers/recording-capacity-fixture.js');
  const f = await api.createCapacityObjectProbe(t);
  assert.equal(f.manifest.classification, 'functional-object-probe/non-performance');
  assert.deepEqual(f.manifest.planPreparation,{strategy:'prebuilt-before-object-growth',prepared:3,beforeFirstAttempt:true});
  assert.equal(f.manifest.budget.records, 2); assert.equal(f.manifest.budget.plans, 3);
  assert.equal(f.manifest.growth.state, 'target-reached');
  assert.equal(f.manifest.removedSourcePhotos, 2);
  assert.equal(f.db.prepare('SELECT count(*) n FROM collection_photos').get()!.n, 0);
  assert.equal(f.db.prepare('SELECT count(DISTINCT sha256) n FROM recording_record_visuals').get()!.n, 2);
  assert.ok(f.manifest.budget.photoBytes + f.manifest.budget.printObjectBytes <= 16 * 1024);
  assert.equal(f.db.prepare("SELECT count(*) n FROM recording_attempts WHERE status='in-progress'").get()!.n, 0);
  assert.equal(f.manifest.integrity, 'passed');
});

test('R023 Repository自然接线：预建next plan后Print完成凭证可由下一Begin复用', {timeout:60_000},async t=>{
  const api=await import('./helpers/recording-capacity-fixture.js'),f=await api.createCapacityObjectLadder(t,3);
  const pdf=api.capacityPdf({bytes:4*1024**2,id:'record-2-pdf'}),prototype=Object.getPrototypeOf(createHash('sha256')) as {update:Hash['update']},update=prototype.update;let reads=0;
  t.mock.method(prototype,'update',function(this:Hash,value:BinaryLike,...rest:unknown[]){if(value instanceof Uint8Array&&Buffer.from(value).equals(pdf))++reads;return Reflect.apply(update,this,[value,...rest]);});
  const request={commandId:randomUUID(),planVersionId:f.nextPlan.id,planContentHash:f.nextPlan.contentHash,userConfirmed:true} as const;
  const attempt=await f.attempts.begin(request);assert.equal(reads,0,'Repository必须给Attempt/Print注入同一manager，下一Begin不得重读历史PDF BLOB');
  await f.attempts.stop({commandId:randomUUID(),attemptId:attempt.id});
});

test('缩小joint流程：manifest同时封存六轴target、actual与reached，不冒充正式容量成绩', { timeout: 60_000 }, async t => {
  const api = await import('./helpers/recording-capacity-fixture.js');
  const f = await api.createCapacityJointProbe(t);
  assert.equal(f.manifest.classification, 'functional-joint-probe/non-performance');
  const axes = ['attemptEvents', 'attemptBytes', 'recordBytes', 'printBytes', 'photoBytes', 'printObjectBytes'] as const;
  assert.deepEqual(Object.keys(f.manifest.axes.targets), axes);
  assert.deepEqual(Object.keys(f.manifest.axes.actual), axes);
  assert.deepEqual(Object.keys(f.manifest.axes.reached), axes);
  assert.deepEqual(f.manifest.axes.reached, f.manifest.growth.reached);
  assert.equal(f.manifest.axes.targets.attemptEvents, 4);
  assert.equal(f.manifest.axes.actual.attemptEvents, 4);
  assert.equal(f.manifest.axes.targets.attemptBytes, 0);
  assert.equal(f.manifest.axes.actual.attemptBytes, f.manifest.budget.attemptBytes);
  assert.deepEqual(f.manifest.structural, { records: { target: 2, actual: 2, reached: true } });
  assert.equal(f.manifest.growth.state, 'target-reached');
  assert.equal(f.manifest.targets.recordBytes, 1); assert.equal(f.manifest.targets.printBytes, 1);
  assert.ok(f.manifest.budget.recordBytes >= f.manifest.targets.recordBytes);
  assert.ok(f.manifest.budget.printBytes >= f.manifest.targets.printBytes);
  assert.equal(f.manifest.progressEvents, f.manifest.targets.progressEvents);
  assert.deepEqual(f.manifest.generationPlan, {
    model: 'serial-single-output-plus-bounded-growth-v1', activeOutputMaximum: 1,
    finalAxisBytes: 12_290, activeOutputBytes: 12_290,
    activeRecordWorkspaceBytes: 16 * 1024 ** 2, evidenceAllowanceBytes: 128 * 1024 ** 2,
    plannedBytes: 151_019_524,
  });
  assert.deepEqual(f.manifest.planPreparation, {
    strategy: 'serial-create-consume-one-active', prepared: 3, beforeFirstAttempt: true, preparedBeforeFirstAttempt: 1,
    activePlanMaximum: 1, unconsumedAtSeal: 1,
  });
  assert.equal(f.manifest.deviceOpened, false); assert.equal(f.manifest.formalReady, false);
});

test('容量clone仅在持久receipt及关闭后按owner删除；失败、错marker、空间不足均保留', async t => {
  const api = await import('./helpers/recording-capacity-fixture.js');
  const directory = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'musicbridge-capacity-safety-')));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const seed = path.join(directory, 'seed.sqlite'); writeFileSync(seed, 'synthetic');
  api.assertCapacitySpace({ availableBytes: 11 * 1024 ** 3, plannedBytes: 1024 ** 3, ownedBytes: 0 });
  assert.throws(() => api.assertCapacitySpace({ availableBytes: 11 * 1024 ** 3 - 1, plannedBytes: 1024 ** 3, ownedBytes: 0 }));
  assert.throws(() => api.assertCapacitySpace({ availableBytes: 100 * 1024 ** 3, plannedBytes: 1, ownedBytes: 16 * 1024 ** 3 }));
  const first = api.createCapacityClone(directory, 'success', seed);
  assert.throws(() => api.finishCapacityClone(first, { outcome: 'ok', resourcesClosed: false, samples: [{ durationMs: 3000 }] }));
  assert.equal(existsSync(first.directory), true);
  const receipt = api.finishCapacityClone(first, { outcome: 'ok', resourcesClosed: true, samples: [{ durationMs: 3000 }] });
  assert.equal(existsSync(first.directory), false); assert.equal(existsSync(seed), true);
  assert.equal(JSON.parse(readFileSync(receipt, 'utf8')).samples[0].durationMs, 3000, '慢成功样本不得删除');
  const failed = api.createCapacityClone(directory, 'failed', seed);
  api.finishCapacityClone(failed, { outcome: 'failed', resourcesClosed: true, samples: [] });
  assert.equal(existsSync(failed.directory), true);
  const changed = api.createCapacityClone(directory, 'changed', seed);
  writeFileSync(path.join(changed.directory, 'owner.json'), '{}');
  assert.throws(() => api.finishCapacityClone(changed, { outcome: 'ok', resourcesClosed: true, samples: [] }));
  assert.equal(existsSync(changed.directory), true);
  assert.throws(() => api.createCapacityClone(directory, '../outside', seed));
});

test('measure output aggregate预算写前及阶段复核，失败clone保留后禁止第二clone，超额稳定停止', async t => {
  const api = await import('./helpers/recording-capacity-fixture.js');
  const directory = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'musicbridge-capacity-aggregate-')));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const seed = path.join(directory, 'seed.sqlite'); writeFileSync(seed, 'aggregate-seed');
  const output = path.join(directory, 'output'); mkdirSync(output);
  const guard = api.createCapacityMeasureAggregateGuard(output, lstatSync(seed).size);
  const clone = api.createCapacityClone(output, 'group-progress', seed,
    api.capacityMeasureWorkingBytes(lstatSync(seed).size), guard);
  api.appendCapacityMeasureStage(output, 'progress', 'copy', { groupMarker: clone.marker }, guard);
  const audits = () => readFileSync(path.join(output, 'measure-aggregate-budget.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.ok(audits().some(row => row.checkpoint === 'clone-before-write' && row.plannedBytes > lstatSync(seed).size),
    'clone写前必须同时预留seed、owner与写后审计');
  assert.ok(audits().some(row => row.checkpoint === 'stage-copy-after-write'));
  assert.ok(audits().every(row => row.outputBytesBefore + row.plannedBytes <= row.limitBytes
    && row.limitBytes === api.capacityMeasureWorkingBytes(lstatSync(seed).size)), '每条审计都必须直接证明写前投影未越界');
  api.finishCapacityClone(clone, { outcome: 'failed', resourcesClosed: true, samples: [],
    onPhase: (phase, details) => api.appendCapacityMeasureStage(output, 'progress', phase, details, guard) });
  assert.equal(existsSync(clone.directory), true, '失败clone必须保留');
  const auditCount = audits().length;
  assert.throws(() => api.createCapacityClone(output, 'group-stop', seed,
    api.capacityMeasureWorkingBytes(lstatSync(seed).size), guard), /aggregate预算/u);
  assert.equal(existsSync(path.join(output, 'group-stop')), false, '失败clone存在时不得创建第二clone');
  assert.equal(audits().length, auditCount, '拒绝第二clone后不得继续写审计输出');

  const isolated = path.join(directory, 'over-limit'); mkdirSync(isolated);
  const isolatedGuard = api.createCapacityMeasureAggregateGuard(isolated, lstatSync(seed).size);
  const limit = api.capacityMeasureWorkingBytes(lstatSync(seed).size);
  const externalGrowth = path.join(isolated, 'external-growth.bin'); writeFileSync(externalGrowth, ''); truncateSync(externalGrowth, limit + 1);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    assert.throws(() => isolatedGuard.check({ group: 'read', checkpoint: 'stage-operation-before-write' }),
      /aggregate预算/u, '超过S+256MiB后每次都必须稳定停止');
  }
  assert.equal(readdirSync(isolated).length, 1, '超额guard不得再写审计或清理失败证据');

  const hardlinkOutput = path.join(directory, 'hardlink-output'); mkdirSync(hardlinkOutput);
  const hardlinkGuard = api.createCapacityMeasureAggregateGuard(hardlinkOutput, lstatSync(seed).size);
  linkSync(seed, path.join(hardlinkOutput, 'aliased.sqlite'));
  assert.throws(() => hardlinkGuard.check({ checkpoint: 'hardlink-probe' }), /aggregate预算/u,
    'aggregate逻辑字节不能接受同一inode通过硬链接重复计数');

  const identityOutput = path.join(directory, 'identity-output'); mkdirSync(identityOutput);
  const identitySeed = path.join(directory, 'identity-seed.sqlite'); writeFileSync(identitySeed, 'identity-seed');
  const identityGuard = api.createCapacityMeasureAggregateGuard(identityOutput, lstatSync(identitySeed).size);
  const identityClone = api.createCapacityClone(identityOutput, 'group-progress', identitySeed,
    api.capacityMeasureWorkingBytes(lstatSync(identitySeed).size), identityGuard);
  renameSync(identityClone.directory, `${identityClone.directory}-moved`); mkdirSync(identityClone.directory);
  const identityAudit = path.join(identityOutput, 'measure-aggregate-budget.jsonl');
  const identityAuditBytes = lstatSync(identityAudit).size;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    assert.throws(() => identityGuard.check({ group: 'progress', checkpoint: 'group-identity-probe' }), /aggregate预算/u,
      '活动group目录被替换后必须稳定停止');
  }
  assert.equal(identityGuard.stopped, true);
  assert.equal(lstatSync(identityAudit).size, identityAuditBytes, '身份漂移后不得继续写aggregate审计');

  const ownerOutput = path.join(directory, 'owner-output'); mkdirSync(ownerOutput);
  const ownerSeed = path.join(directory, 'owner-seed.sqlite'); writeFileSync(ownerSeed, 'owner-seed');
  const ownerGuard = api.createCapacityMeasureAggregateGuard(ownerOutput, lstatSync(ownerSeed).size);
  const ownerClone = api.createCapacityClone(ownerOutput, 'group-progress', ownerSeed,
    api.capacityMeasureWorkingBytes(lstatSync(ownerSeed).size), ownerGuard);
  const ownerAudit = path.join(ownerOutput, 'measure-aggregate-budget.jsonl');
  const ownerAuditBytes = lstatSync(ownerAudit).size, ownerDirectoryIdentity = lstatSync(ownerClone.directory);
  writeFileSync(path.join(ownerClone.directory, 'owner.json'), '{}\n');
  const ownerDirectoryAfterTamper = lstatSync(ownerClone.directory);
  assert.equal(ownerDirectoryAfterTamper.dev, ownerDirectoryIdentity.dev);
  assert.equal(ownerDirectoryAfterTamper.ino, ownerDirectoryIdentity.ino, '本用例只改变owner marker，不改变group目录身份');
  for (let attempt = 0; attempt < 2; attempt += 1) {
    assert.throws(() => ownerGuard.check({ group: 'progress', checkpoint: 'group-owner-probe' }), /aggregate预算/u,
      '活动group的owner marker变化后必须稳定停止');
  }
  assert.equal(ownerGuard.stopped, true);
  assert.equal(lstatSync(ownerAudit).size, ownerAuditBytes, 'owner marker漂移后不得继续写aggregate审计');
});

test('measure group生命周期固定为3次完整clone/hash，stop组105轮receipt与1575样本精确闭包', async t => {
  const api = await import('./helpers/recording-capacity-fixture.js');
  const snapshotBytes = 1_990_471_680;
  assert.equal(api.capacityMeasureWorkingBytes(snapshotBytes), snapshotBytes + 256 * 1024 ** 2,
    '三个group严格串行，最坏瞬时空间只能计一个clone与固定增长余量');
  for (const invalid of [-1, 0.5, Number.MAX_SAFE_INTEGER]) assert.throws(() => api.capacityMeasureWorkingBytes(invalid));
  const benchmark = readFileSync(new URL('./benchmarks/recording-capacity.ts', import.meta.url), 'utf8');
  const helper = readFileSync(new URL('./helpers/recording-capacity-fixture.ts', import.meta.url), 'utf8');
  assert.match(helper, /plannedBytes \?\? info\.size \* 3 \+ 64 \* 1024 \*\* 2/u,
    '非measure clone默认空间计划必须继续保留3*S+64MiB');
  assert.match(benchmark, /const stopGroup = openGroup\('stop'\)/u);
  assert.match(benchmark, /prepareCapacityStopPlans\(\s*stopGroup\.repository,\s*template,\s*plan\.stopRounds,\s*path\.join\(\s*stopGroup\.clone\.directory,\s*'group-stop-workspace'\s*\)\s*\)/u,
    '105轮必须在计时前经公开Core路径准备独立physical copy与frozen plan');
  assert.match(benchmark, /running\(stopGroup\.repository, stopPlans\[roundIndex - 1\]!\)/u, '每轮必须在同一长期Repository消费不同Plan');
  assert.equal(benchmark.match(/verifyRecordingPlanDatabase\(stopGroup\.auditDb\)/gu)?.length, 2, 'Stop计时前后都必须复核Plan DB');
  assert.equal(benchmark.match(/verifyRecordingAttemptDatabase\(stopGroup\.auditDb\)/gu)?.length, 2, 'Stop计时前后都必须复核Attempt DB');
  assert.equal(benchmark.match(/verifyRecordingRecordDatabase\(stopGroup\.auditDb\)/gu)?.length, 2, 'Stop计时前后都必须复核Record DB');
  assert.match(benchmark, /ownedWorkspace:\s*stopWorkspace/u, 'Stop final receipt必须绑定受控workspace后统一清理');
  assert.match(benchmark, /fixture-before\.json/u); assert.match(benchmark, /fixture-after\.json/u);
  assert.equal(benchmark.match(/createCapacityClone\(output, `group-\$\{group\}`, seedPath,/gu)?.length, 1,
    'benchmark只能从统一group入口创建clone');
  assert.match(benchmark, /createCapacityMeasureAggregateGuard\(output,\s*lstatSync\(measureSeedPath!\)\.size\)/u,
    '正式measure必须把S+256MiB绑定到output aggregate guard');
  assert.ok(benchmark.indexOf('createCapacityMeasureAggregateGuard(output, lstatSync(measureSeedPath!).size)')
    < benchmark.indexOf("json('source-before.json', initialPins)"), 'aggregate guard必须先于首个measure output写入建立');
  assert.doesNotMatch(benchmark, /sample-\$\{\+\+nextCopy\}/u, '不得退回每轮sample clone');
  assert.doesNotMatch(benchmark, /sha\(seedPath\)/u, '正式measure不得在authority已验证seed后再次做完整hash');
  assert.deepEqual(api.capacityMeasurePlan(), {
    groups: ['progress', 'stop', 'read'], progressRounds: 105, stopRounds: 105,
    readOperations: 8, readRoundsPerOperation: 105, stopMetricsPerRound: 6,
    totalSamples: 1575, warmupPerSeries: 5, formalPerSeries: 100,
  });
  const plan = api.capacityMeasurePlan();
  assert.equal(plan.progressRounds + plan.stopRounds * plan.stopMetricsPerRound
    + plan.readOperations * plan.readRoundsPerOperation, plan.totalSamples, 'group样本必须精确拼接');
  const directory = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'musicbridge-capacity-group-')));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const seed = path.join(directory, 'seed.sqlite'); writeFileSync(seed, 'synthetic group seed');
  const clone = api.createCapacityClone(directory, 'group-stop', seed);
  api.appendCapacityMeasureStage(directory, 'stop', 'copy', { clone: clone.marker });
  api.appendCapacityMeasureStage(directory, 'stop', 'open-audit', { inProgress: 0 });
  const seenAttempts = new Set<string>(), seenCommands = new Set<string>();
  const receipts = await api.runCapacityStopRounds(clone, 105, async roundIndex => {
    const attemptId = randomUUID(), commandId = randomUUID(); seenAttempts.add(attemptId); seenCommands.add(commandId);
    return { attemptId, commandId, inProgressBefore: 0 as const, inProgressAfter: 0 as const,
      attemptStatus: 'aborted' as const, attemptReason: 'user-stop' as const, coordinatorClosed: true as const, repositoryOpen: true as const,
      samples: ['signalAborted', 'driverStopInvoked', 'driverStopAck', 'driverCloseInvoked', 'driverCloseResolved', 'receiptSettled']
        .map(metric => ({ metric, durationMs: roundIndex, warmup: roundIndex <= 5, outcome: 'ok' as const, details: null })) };
  });
  assert.equal(receipts.length, 105); assert.equal(seenAttempts.size, 105); assert.equal(seenCommands.size, 105);
  for (let index = 1; index <= 105; index += 1) {
    const receipt = JSON.parse(readFileSync(path.join(directory, `group-stop.round-${String(index).padStart(3, '0')}.receipt.json`), 'utf8'));
    assert.deepEqual(Object.keys(receipt).sort(), ['attemptId', 'attemptReason', 'attemptStatus', 'commandId', 'coordinatorClosed',
      'group', 'groupMarker', 'inProgressAfter', 'inProgressBefore', 'recordedAt', 'repositoryOpen', 'roundIndex',
      'sampleCount', 'samples', 'schemaVersion', 'scope'].sort());
    assert.equal(receipt.roundIndex, index); assert.deepEqual(receipt.groupMarker, clone.marker);
    assert.equal(receipt.samples.length, 6); assert.equal(receipt.inProgressBefore, 0); assert.equal(receipt.inProgressAfter, 0);
  }
  api.finishCapacityClone(clone, { outcome: 'ok', resourcesClosed: true, samples: receipts.flatMap(value => value.samples),
    onPhase: (phase, details) => api.appendCapacityMeasureStage(directory, 'stop', phase, details) });
  assert.equal(existsSync(clone.directory), false);
  for (const group of ['progress', 'read'] as const) {
    const groupClone = api.createCapacityClone(directory, `group-${group}`, seed);
    api.appendCapacityMeasureStage(directory, group, 'copy', { clone: groupClone.marker });
    api.appendCapacityMeasureStage(directory, group, 'open-audit', { inProgress: 0 });
    api.appendCapacityMeasureStage(directory, group, 'operation', { complete: true });
    api.appendCapacityMeasureStage(directory, group, 'round-fsync', { complete: true });
    api.finishCapacityClone(groupClone, { outcome: 'ok', resourcesClosed: true, samples: [],
      onPhase: (phase, details) => api.appendCapacityMeasureStage(directory, group, phase, details) });
  }
  assert.equal(readdirSync(directory).filter(name => /^group-(progress|stop|read)\.receipt\.json$/u.test(name)).length, 3,
    '三个group各做一次完整hash/最终receipt，不能退回107次sample clone');
  const stages = readFileSync(path.join(directory, 'measure-stages.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.equal(stages.length, 18);
  for (const group of ['progress', 'stop', 'read']) assert.deepEqual(stages.filter(row => row.group === group).map(row => row.phase),
    ['copy', 'open-audit', 'operation', 'round-fsync', 'final-hash', 'cleanup']);
  assert.deepEqual([...new Set(stages.map(row => row.phase))], ['copy', 'open-audit', 'operation', 'round-fsync', 'final-hash', 'cleanup']);
});

test('measure stop group在单一clone内每轮都从合法隔离基线Begin，不复用已停止physical copy', { timeout: 60_000 }, async t => {
  const api = await import('./helpers/recording-capacity-fixture.js');
  const { createRecordingAttemptCoordinator } = await import('../src/recording/attempt-coordinator.js');
  const { createCollectionRepository } = await import('../src/collection/repository.js');
  const f = await api.createCapacityPilot(t);
  const directory = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'musicbridge-capacity-stop-workspace-')));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const seed = path.join(directory, 'seed.sqlite'); await backup(f.db, seed);
  const clone = api.createCapacityClone(directory, 'group-stop', seed), repository = createCollectionRepository({ filePath: clone.filePath });
  let repositoryClosed = false; t.after(() => { if (!repositoryClosed) repository.close(); });
  const sharedBefore = api.summarizeCapacityFixtureTree(f.directory), workspacePath = path.join(clone.directory, 'group-stop-workspace');
  assert.equal(sharedBefore.databaseContentSha256Verified, false, '共享fixture中的SQLite只能核身份，不能读取或hash');
  const template = repository.recordingPlans.version({ id: f.nextPlan.id }).plan!;
  const prepared = await api.prepareCapacityStopPlans(repository, template, 2, workspacePath), stopPlans = prepared.plans;
  assert.equal(realpathSync(prepared.workspace.path), workspacePath);
  assert.ok(repository.sources.roots().some(root => root.path === path.join(workspacePath, 'source')));
  assert.ok(repository.preparations.destinations().some(root => root.path === path.join(workspacePath, 'execution')));
  assert.ok(repository.archive.candidates().some(root => root.parent.path === path.join(workspacePath, 'archive')));
  const coordinator = () => createRecordingAttemptCoordinator({ store: repository.recordingAttempts, admissionProvider: {
    async authorize() {}, async start() { return { async stop() {}, async close() {} }; },
  } });
  const round = async (plan: typeof f.nextPlan) => {
    const service = coordinator();
    const attempt = await service.begin({ commandId: randomUUID(), planVersionId: plan.id,
      planContentHash: plan.contentHash, userConfirmed: true });
    await service.stop({ commandId: randomUUID(), attemptId: attempt.id });
    await service.close();
    return attempt;
  };
  const first = await round(stopPlans[0]!);
  const second = await round(stopPlans[1]!);
  assert.notEqual(first.id, second.id);
  assert.notEqual(first.physicalId, second.physicalId);
  const blocked = coordinator();
  await assert.rejects(blocked.begin({ commandId: randomUUID(), planVersionId: stopPlans[0]!.id,
    planContentHash: stopPlans[0]!.contentHash, userConfirmed: true }), { code: 'COPY_UNAVAILABLE' });
  await blocked.close();
  assert.deepEqual(api.summarizeCapacityFixtureTree(f.directory), sharedBefore, '预建和Stop不得改写封存seed fixture的任何身份或内容');
  assert.ok(readdirSync(workspacePath, { recursive: true }).length > 8, '新源、execution与archive文件必须只写入传入workspace');
  repository.close(); repositoryClosed = true;
  const receipt = api.finishCapacityClone(clone, { outcome: 'ok', resourcesClosed: true, samples: [], ownedWorkspace: prepared.workspace,
    onPhase: (phase, details) => api.appendCapacityMeasureStage(directory, 'stop', phase, details) });
  const final = JSON.parse(readFileSync(receipt, 'utf8'));
  assert.match(final.sqliteSha256, /^[0-9a-f]{64}$/u); assert.match(final.workspaceTreeSha256, /^[0-9a-f]{64}$/u);
  assert.equal(existsSync(path.join(directory, final.workspaceReceipt)), true, 'workspace树receipt必须在统一清理前持久化');
  assert.equal(existsSync(workspacePath), false, '最终group receipt持久化后workspace与clone统一清理');
});

test('stop workspace最终receipt写入故障时整体保留clone、SQLite与workspace', { timeout: 60_000 }, async t => {
  const api = await import('./helpers/recording-capacity-fixture.js');
  const { createCollectionRepository } = await import('../src/collection/repository.js');
  const f = await api.createCapacityPilot(t);
  const directory = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'musicbridge-capacity-stop-retention-')));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const seed = path.join(directory, 'seed.sqlite'); await backup(f.db, seed);
  const clone = api.createCapacityClone(directory, 'group-stop', seed), repository = createCollectionRepository({ filePath: clone.filePath });
  let repositoryClosed = false; t.after(() => { if (!repositoryClosed) repository.close(); });
  const template = repository.recordingPlans.version({ id: f.nextPlan.id }).plan!;
  const prepared = await api.prepareCapacityStopPlans(repository, template, 1, path.join(clone.directory, 'group-stop-workspace'));
  repository.close(); repositoryClosed = true;
  writeFileSync(path.join(directory, 'group-stop.receipt.json'), '故意占用最终receipt路径', { flag: 'wx' });
  assert.throws(() => api.finishCapacityClone(clone, { outcome: 'ok', resourcesClosed: true, samples: [], ownedWorkspace: prepared.workspace,
    onPhase: (phase, details) => api.appendCapacityMeasureStage(directory, 'stop', phase, details) }));
  assert.equal(existsSync(clone.filePath), true, 'final receipt失败必须保留SQLite');
  assert.equal(existsSync(prepared.workspace.path), true, 'final receipt失败必须保留整个workspace');
  assert.equal(existsSync(path.join(directory, 'group-stop.workspace.receipt.json')), true, '故障发生前的workspace树receipt保持可审计');
  symlinkSync(seed, path.join(prepared.workspace.path, 'unexpected-link'));
  assert.throws(() => api.finishCapacityClone(clone, { outcome: 'ok', resourcesClosed: true, samples: [], ownedWorkspace: prepared.workspace }), /异常对象/u);
  assert.equal(existsSync(clone.filePath), true, 'workspace异常对象不得触发递归清理');
});

test('measure CLI只接受显式规范TASK078 runtime-root，generate拒绝该参数', t => {
  const candidateRoot = realpathSync(new URL('../../../', import.meta.url).pathname);
  const benchmark = new URL('./benchmarks/recording-capacity.ts', import.meta.url).pathname;
  const temporary = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'musicbridge-capacity-runtime-root-')));
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  const task078 = path.join(temporary, 'task-078-v3-acceptance');
  const runtime = path.join(task078, 'reports/runtime/task-078-v3-acceptance');
  mkdirSync(runtime, { recursive: true });
  const symlink = path.join(temporary, 'runtime-link'); symlinkSync(runtime, symlink, 'dir');
  const base = ['--import', 'tsx', benchmark, '--phase', 'measure', '--profile', 'objects-limit',
    '--label', 'runtime-root-red', '--seed-label', 'objects-seed', '--window', 'window-red'];
  const invoke = (args: string[]) => spawnSync(process.execPath, args, { cwd: candidateRoot, encoding: 'utf8' });
  const rejected = [
    { args: base, error: /measure必须显式提供TASK078 runtime-root/u },
    { args: [...base, '--runtime-root', 'reports/runtime/task-078-v3-acceptance'], error: /runtime-root必须是绝对规范目录/u },
    { args: [...base, '--runtime-root', symlink], error: /runtime-root不得是符号链接/u },
    { args: [...base, '--runtime-root', temporary], error: /runtime-root结构必须绑定TASK078/u },
    { args: [...base, '--runtime-root', candidateRoot], error: /runtime-root不得等于TASK079 candidate root/u },
  ];
  for (const item of rejected) {
    const result = invoke(item.args);
    assert.notEqual(result.status, 0, `非法runtime不得启动measure: ${item.args.at(-1)}`);
    assert.match(`${result.stdout}\n${result.stderr}`, item.error);
  }
  const generated = invoke(['--import', 'tsx', benchmark, '--phase', 'generate', '--profile', 'pilot',
    '--label', 'generate-runtime-red', '--runtime-root', runtime]);
  assert.notEqual(generated.status, 0);
  assert.match(`${generated.stdout}\n${generated.stderr}`, /generate不得接受runtime-root/u);
  assert.equal(existsSync(path.join(runtime, 'runtime-root-red')), false, 'runtime拒绝必须发生在创建输出目录之前');
});

test('stop group第30轮故障保留clone、前29个durable receipts与partial samples，不伪写成功终态', async t => {
  const api = await import('./helpers/recording-capacity-fixture.js');
  const directory = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'musicbridge-capacity-group-failure-')));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const seed = path.join(directory, 'seed.sqlite'); writeFileSync(seed, 'synthetic failure seed');
  const clone = api.createCapacityClone(directory, 'group-stop', seed), samples = path.join(directory, 'samples.jsonl');
  await assert.rejects(api.runCapacityStopRounds(clone, 105, async roundIndex => {
    if (roundIndex === 30) throw new Error('ROUND_30_FAULT');
    const rows = ['signalAborted', 'driverStopInvoked', 'driverStopAck', 'driverCloseInvoked', 'driverCloseResolved', 'receiptSettled']
      .map(metric => ({ metric, durationMs: roundIndex, warmup: roundIndex <= 5, outcome: 'ok' as const, details: null }));
    return { attemptId: randomUUID(), commandId: randomUUID(), inProgressBefore: 0 as const, inProgressAfter: 0 as const,
      attemptStatus: 'aborted' as const, attemptReason: 'user-stop' as const,
      coordinatorClosed: true as const, repositoryOpen: true as const, samples: rows };
  }, receipt => writeFileSync(samples, receipt.samples.map(row => JSON.stringify(row)).join('\n') + '\n', { flag: 'a' })), /ROUND_30_FAULT/u);
  assert.equal(readdirSync(directory).filter(name => /^group-stop\.round-\d{3}\.receipt\.json$/u.test(name)).length, 29);
  assert.equal(existsSync(clone.directory), true); assert.equal(readFileSync(samples, 'utf8').trim().split('\n').length, 29 * 6);
  assert.equal(existsSync(path.join(directory, 'group-stop.receipt.json')), false, '失败group不能伪造完整hash/成功终态receipt');
  const stages = readFileSync(path.join(directory, 'measure-stages.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(stages.map(row => row.phase), ['operation', 'round-fsync']); assert.equal(stages[1].details.completedRounds, 29);
  assert.equal(existsSync(path.join(directory, 'summary.json')), false); assert.equal(existsSync(path.join(directory, 'exit.json')), false);
});

test('容量统计使用nearest-rank并保留失败/超时，少量样本不伪报P99', async () => {
  const api = await import('./helpers/recording-capacity-fixture.js');
  const values = Array.from({ length: 100 }, (_, i) => ({ durationMs: i + 1, outcome: 'ok' as const }));
  assert.deepEqual(api.summarizeCapacitySamples(values), { attempts: 100, successes: 100, failures: 0, timeouts: 0, p50: 50, p95: 95, p99: 99, max: 100, complete: true });
  const partial = api.summarizeCapacitySamples([...values.slice(0, 9), { durationMs: 1000, outcome: 'timeout' }]);
  assert.equal(partial.attempts, 10); assert.equal(partial.timeouts, 1); assert.equal(partial.p99, null); assert.equal(partial.complete, false);
  for (const durationMs of [NaN, Infinity, -1]) assert.throws(() => api.summarizeCapacitySamples([{ durationMs, outcome: 'ok' }]));
  assert.throws(() => api.summarizeCapacitySamples([]));
});

test('联合预算按UTF8实际合计，不把三个独立行上限误当可同时达顶', async () => {
  const api = await import('./helpers/recording-capacity-fixture.js');
  const empty = { attemptBytes: 0, planBytes: 0, recordBytes: 0, printBytes: 0, photoBytes: 0, printObjectBytes: 0, attempts: 0, events: 0, receipts: 0, records: 0, plans: 0, printJobs: 0, printReceipts: 0 };
  api.assertCapacityBudget(empty);
  assert.throws(() => api.assertCapacityBudget({ ...empty, attemptBytes: 128 * 1024 * 1024 + 1 }));
  assert.throws(() => api.assertCapacityBudget({ ...empty, events: 100001 }));
  assert.throws(() => api.assertCapacityBudget({ ...empty, printObjectBytes: 1024 * 1024 * 1024 + 1 }));
  assert.throws(() => api.assertCapacityBudget({ ...empty, records: -1 }));
});

test('functional-pilot：正式完成+独立冻结Plan和100条真实进度，联合预算及历史闭包合法', { timeout: 60_000 }, async t => {
  const api = await import('./helpers/recording-capacity-fixture.js');
  const f = await api.createCapacityPilot(t);
  t.diagnostic(JSON.stringify(f.manifest));
  assert.equal(f.manifest.classification, 'functional-pilot/non-performance');
  assert.equal(f.manifest.budget.records, 1); assert.equal(f.manifest.budget.plans, 2);
  assert.equal(f.manifest.progressEvents, 100);
  assert.notEqual(f.manifest.completedPhysicalId, f.manifest.nextPhysicalId);
  assert.ok(f.manifest.budget.photoBytes + f.manifest.budget.printObjectBytes <= 4 * 1024 * 1024);
  assert.equal(f.manifest.integrity, 'passed');
  assert.equal(f.manifest.formalReady, false); assert.equal(f.manifest.deviceOpened, false);
});

// 此短进程只验证传输监督，不把合成receipt冒充真实cold业务。
const transportPrelude = `process.once('message', message => {
  const base = { version: 1, requestId: message.requestId, childPid: process.pid };
  const ready = { ...base, type: 'ready' };
  const result = { kind: 'cold', planId: message.task.planId, planHash: message.task.planHash,
    budget: Object.fromEntries('attemptBytes,planBytes,recordBytes,printBytes,photoBytes,printObjectBytes,attempts,events,receipts,records,plans,printJobs,printReceipts'.split(',').map(k => [k, 0])),
    repositoryOpenMs: 1, fullAuditMs: 1, databaseCloseMs: 1, childMeasuredMs: 3,
    clock: 'child-relative', deviceOpened: false, formalReady: false, gateB: 'NOT_RUN' };
  const receipt = { ...base, type: 'receipt', result };
`;
async function processTransport(t: test.TestContext, script: string) {
  const { runCapacityCold } = await import('./helpers/recording-capacity-process.js');
  const { createCapacityClone } = await import('./helpers/recording-capacity-fixture.js');
  const directory = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'musicbridge-capacity-process-')));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const seed = path.join(directory, 'seed.sqlite'); writeFileSync(seed, '仅进程传输合成输入');
  const clone = createCapacityClone(directory, 'late-close', seed), file = path.join(directory, 'child.mjs');
  writeFileSync(file, transportPrelude + script + '\n});');
  let child: ReturnType<typeof fork> | undefined, actualClose = false;
  const launch: typeof fork = (_file, args) => {
    child = fork(file, Array.isArray(args) ? args : [], { execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    child.once('close', () => { actualClose = true; }); return child;
  };
  t.after(async () => { if (child && !actualClose) await once(child, 'close'); });
  return { directory, clone, launch, closed: () => actualClose, run: (limits: import('./helpers/recording-capacity-process.js').CapacityProcessOptions = {}) => runCapacityCold({ clone, planId: randomUUID(), planHash: 'a'.repeat(64) }, { ...limits, launch }) };
}

for (const code of [0, 7]) test(`进程设施：receipt先到仍等真实close，退出码${code}不被改写`, { timeout: 10_000 }, async t => {
  const f = await processTransport(t, `process.send(ready); process.send(receipt); setTimeout(() => { process.exitCode = ${code}; process.disconnect(); }, 120);`);
  const receipt = await f.run();
  assert.equal(f.closed(), true, '收到receipt仍须等待本次进程真实close');
  assert.equal(receipt.outcome, code === 0 ? 'ok' : 'failed'); assert.equal(receipt.code, code); assert.equal(receipt.signal, null);
  assert.equal(receipt.closed, true); assert.ok(receipt.forkToCloseMs - receipt.timings.receiptMs! >= 100);
  assert.equal(!!receipt.result, code === 0); assert.deepEqual(receipt.cleanup, { termSent: false, killSent: false });
  assert.equal(existsSync(f.clone.directory), true, '监督器不自动删除工作目录');
});

test('进程设施：执行期限涵盖receipt后的等待，超时无成功result且保留clone', { timeout: 10_000 }, async t => {
  const f = await processTransport(t, 'process.send(ready); process.send(receipt); setInterval(() => {}, 1000);');
  const receipt = await f.run({ executionTimeoutMs: 100, killGraceMs: 20, closeTimeoutMs: 100 });
  assert.equal(receipt.outcome, 'timeout'); assert.equal(receipt.failure, 'TIMEOUT'); assert.equal(receipt.result, undefined);
  assert.equal(receipt.cleanup.termSent, true); assert.equal(receipt.closed, true); assert.equal(existsSync(f.clone.directory), true);
});

test('进程设施：真实exit后stdio被短后代持有，close超时不kill已退出PID且不伪报closed', { timeout: 10_000 }, async t => {
  const f = await processTransport(t, `
    process.send(ready); process.send(receipt);
    Promise.all([import('node:child_process'), import('node:fs'), import('node:path'), import('node:url')]).then(([cp, fs, path, url]) => {
      const holder = cp.spawn(process.execPath, ['-e', 'setTimeout(() => {}, 250)'], { stdio: ['ignore', process.stdout, process.stderr] });
      fs.writeFileSync(path.join(path.dirname(url.fileURLToPath(import.meta.url)), 'holder-pid'), String(holder.pid));
      holder.unref(); process.disconnect();
    });`);
  const result = await f.run({ executionTimeoutMs: 2000, closeTimeoutMs: 20 });
  assert.equal(result.outcome, 'failed'); assert.equal(result.failure, 'CLOSE_TIMEOUT'); assert.equal(result.closed, false);
  assert.equal(result.code, 0); assert.equal(result.result, undefined); assert.deepEqual(result.cleanup, { termSent: false, killSent: false });
  // 只检查本fixture显式创建的短后代自然退出，不扫描/终止其他进程。
  const pid = Number(readFileSync(path.join(f.directory, 'holder-pid'), 'utf8'));
  const alive = () => { try { process.kill(pid, 0); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error; } };
  for (let i = 0; i < 100 && alive(); ++i) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(alive(), false); assert.equal(existsSync(f.clone.directory), true);
});

test('进程设施：限额不能放宽、spawn异常与无receipt退出均固定失败', { timeout: 10_000 }, async t => {
  const f = await processTransport(t, 'process.send(ready); process.disconnect();');
  for (const limits of [{ executionTimeoutMs: 50001 }, { killGraceMs: 1001 }, { closeTimeoutMs: 2001 }, { executionTimeoutMs: NaN }]) await assert.rejects(f.run(limits), /只能收紧/u);
  const result = await f.run(); assert.equal(result.failure, 'INVALID_PROTOCOL'); assert.equal(result.closed, true); assert.equal(result.result, undefined);
  const { runCapacityCold } = await import('./helpers/recording-capacity-process.js');
  const failed = await runCapacityCold({ clone: f.clone, planId: randomUUID(), planHash: 'a'.repeat(64) }, { launch: () => { throw new Error('不公开合成内部路径'); } });
  assert.equal(failed.failure, 'SPAWN_FAILED'); assert.equal(failed.closed, false); assert.equal(JSON.stringify(failed).includes('不公开合成内部路径'), false);
});

test('进程设施：私有任务严格拒绝尾换行UUID/hash、未知字段和非字符串格式', async t => {
  const api = await import('./helpers/recording-capacity-process.js');
  const f = await processTransport(t, 'process.disconnect();');
  const task = { kind: 'cold', clone: f.clone, planId: randomUUID(), planHash: 'a'.repeat(64), databaseSha256: 'b'.repeat(64) };
  assert.equal(api.isCapacityChildTask(task), true);
  for (const changed of [{ ...task, planId: task.planId + '\n' }, { ...task, planHash: task.planHash + '\n' }, { ...task, planHash: [task.planHash] }, { ...task, unexpected: true }]) {
    assert.equal(api.isCapacityChildTask(changed), false);
  }
});

for (const [name, script] of [
  ['旧request', "process.send({ ...ready, requestId: '00000000-0000-4000-8000-000000000000' });"],
  ['错误PID', 'process.send({ ...ready, childPid: process.pid + 1 });'],
  ['重复ready', 'process.send(ready); process.send(ready);'],
  ['缺ready', 'process.send(receipt);'],
  ['未知字段', "process.send({ ...ready, path: 'synthetic-private-path' });"],
  ['非法result', 'process.send(ready); process.send({ ...receipt, result: { ...result, formalReady: true } });'],
  ['重复receipt', 'process.send(ready); process.send(receipt); process.send(receipt);'],
  ['输出越界', "process.stdout.write('x'.repeat(16385));"],
] as const) test(`进程设施：${name}固定失败，不泄漏原始消息`, { timeout: 10_000 }, async t => {
  const f = await processTransport(t, script + ' setInterval(() => {}, 1000);');
  const receipt = await f.run({ executionTimeoutMs: 2000, killGraceMs: 20, closeTimeoutMs: 100 });
  assert.equal(receipt.outcome, 'failed'); assert.equal(receipt.failure, name === '输出越界' ? 'OUTPUT_LIMIT' : 'INVALID_PROTOCOL');
  assert.equal(receipt.result, undefined); assert.equal(JSON.stringify(receipt).includes('synthetic-private-path'), false); assert.equal(receipt.closed, true);
});

async function tinyCold(t: test.TestContext, active = false) {
  const { recordingAttemptFixture } = await import('./helpers/recording-attempt-fixture.js');
  const { createCapacityClone, hashCapacityFile } = await import('./helpers/recording-capacity-fixture.js');
  const f = await recordingAttemptFixture(t), plan = f.frozenPlan;
  if (active) await f.attempts.begin(f.beginRequest());
  const seed = path.join(f.directory, 'closed-seed.sqlite'), db = new DatabaseSync(f.filePath);
  try { db.prepare('VACUUM INTO ?').run(seed); } finally { db.close(); }
  const clone = createCapacityClone(f.directory, 'cold-child', seed);
  return { ...f, plan, clone, seed, seedHash: hashCapacityFile(seed) };
}
test('进程设施：真实新Node首次打开冻结Plan并完整核验闭包，关闭后才成功', { timeout: 20_000 }, async t => {
  const { runCapacityCold } = await import('./helpers/recording-capacity-process.js');
  const { hashCapacityFile } = await import('./helpers/recording-capacity-fixture.js');
  const f = await tinyCold(t), result = await runCapacityCold({ clone: f.clone, planId: f.plan.id, planHash: f.plan.contentHash });
  assert.equal(result.outcome, 'ok', JSON.stringify(result)); assert.notEqual(result.childPid, process.pid); assert.ok(result.childPid! > 0);
  assert.equal(result.closed, true); assert.equal(result.code, 0); assert.equal(result.signal, null);
  assert.equal(result.result?.kind, 'cold'); if (result.result?.kind !== 'cold') return;
  assert.equal(result.result.budget.plans, 1); assert.ok(result.result.repositoryOpenMs > 0); assert.ok(result.result.fullAuditMs > 0);
  assert.equal(result.result.planHash, f.plan.contentHash); assert.equal(result.result.formalReady, false);
  assert.equal(hashCapacityFile(f.seed), f.seedHash, '不打开/改写原关闭seed');
});

test('进程设施：原关闭快照含活动Attempt时拒绝，不让启动自动恢复掩盖前提', { timeout: 20_000 }, async t => {
  const { runCapacityCold } = await import('./helpers/recording-capacity-process.js');
  const { hashCapacityFile } = await import('./helpers/recording-capacity-fixture.js');
  const f = await tinyCold(t, true), before = hashCapacityFile(f.clone.filePath);
  const result = await runCapacityCold({ clone: f.clone, planId: f.plan.id, planHash: f.plan.contentHash });
  assert.equal(result.outcome, 'failed'); assert.equal(result.failure, 'AUDIT_FAILED'); assert.equal(result.result, undefined);
  assert.equal(hashCapacityFile(f.clone.filePath), before, '不能先自动恢复活动Attempt再当作合格cold样本');
});

for (const fault of ['plan-hash', 'database-tamper', 'owner-tamper'] as const) test(`进程设施：${fault}拒绝且保留原clone`, { timeout: 20_000 }, async t => {
  const { runCapacityCold } = await import('./helpers/recording-capacity-process.js');
  const f = await tinyCold(t);
  if (fault === 'database-tamper') {
    const db = new DatabaseSync(f.clone.filePath);
    try {
      const trigger = String(db.prepare("SELECT sql FROM sqlite_master WHERE name='recording_plan_versions_no_update'").get()!.sql);
      db.exec("DROP TRIGGER recording_plan_versions_no_update; UPDATE recording_plan_versions SET data='{}'"); db.exec(trigger);
    } finally { db.close(); }
  }
  if (fault === 'owner-tamper') writeFileSync(path.join(f.clone.directory, 'owner.json'), '{}');
  const result = await runCapacityCold({ clone: f.clone, planId: f.plan.id, planHash: fault === 'plan-hash' ? '0'.repeat(64) : f.plan.contentHash });
  assert.equal(result.outcome, 'failed'); assert.equal(result.result, undefined); assert.equal(existsSync(f.clone.filePath), true);
  assert.equal(result.failure, fault === 'owner-tamper' ? 'INPUT_INVALID' : 'AUDIT_FAILED');
});

test('进程设施：完整备份真实新进程复制音频对象并撤销旧路径权限，不激活', { timeout: 20_000 }, async t => {
  const { archiveBackupFixture } = await import('./helpers/archive-backup-fixture.js');
  const { runCapacityRecovery } = await import('./helpers/recording-capacity-process.js');
  const { hashCapacityFile } = await import('./helpers/recording-capacity-fixture.js');
  const f = await archiveBackupFixture(t), backup = await f.api.createArchiveBackup(f.backupRequest);
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'musicbridge-capacity-recovery-'))), id = randomUUID();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(path.join(root, 'owner.json'), JSON.stringify({ id, scope: 'musicbridge-capacity-recovery-only' }));
  const destinationPath = path.join(root, 'sample'); mkdirSync(destinationPath);
  const expected = { id: backup.manifest.id, manifestHash: hashCapacityFile(path.join(backup.directory.path, 'Backup.json')) };
  const result = await runCapacityRecovery({ backupPath: backup.directory.path, destinationPath, expected, owner: { root, id },
    protectedRootPaths: [...new Set([...f.repository.sources.roots(), ...f.repository.preparations.destinations(), f.root.root].map(r => r.path))] });
  assert.equal(result.outcome, 'ok', JSON.stringify(result)); assert.equal(result.closed, true); assert.equal(result.code, 0); assert.notEqual(result.childPid, process.pid);
  assert.equal(result.result?.kind, 'restore'); if (result.result?.kind !== 'restore') return;
  const receipt = result.result, target = path.join(destinationPath, receipt.id);
  assert.equal(receipt.state, 'isolated-pending-activation'); assert.equal(receipt.contentIncluded, true); assert.ok(receipt.objectCount > 0);
  assert.equal(receipt.objectCount, backup.manifest.objects.length); assert.equal(receipt.sourceManifestHash, expected.manifestHash);
  for (const object of backup.manifest.objects) assert.equal(hashCapacityFile(path.join(target, 'objects', object.sha256)), object.sha256);
  const db = new DatabaseSync(path.join(target, 'database', 'collection.sqlite'), { readOnly: true });
  try {
    assert.ok(Number(db.prepare('SELECT count(*) n FROM source_roots').get()!.n) > 0);
    assert.equal(db.prepare("SELECT count(*) n FROM source_roots WHERE json_extract(data,'$.authorized') IS NOT 0").get()!.n, 0);
    assert.equal(db.prepare('SELECT count(*) n FROM archive_roots WHERE authorized<>0').get()!.n, 0);
    assert.equal(db.prepare("SELECT count(*) n FROM prepared_selections WHERE json_extract(data,'$.root.authorized') IS NOT 0").get()!.n, 0);
  } finally { db.close(); }
  assert.equal(hashCapacityFile(path.join(backup.directory.path, 'Backup.json')), expected.manifestHash);
  assert.equal(existsSync(path.join(target, 'RestoreComplete.json')), true);
  // 独立空目标重试损坏包：不能只跑isolate而漏掉真实音频对象核验。
  const brokenTarget = path.join(root, 'broken'); mkdirSync(brokenTarget);
  writeFileSync(path.join(backup.directory.path, 'objects', backup.manifest.objects[0]!.sha256), '合成损坏音频对象');
  const broken = await runCapacityRecovery({ backupPath: backup.directory.path, destinationPath: brokenTarget, expected, owner: { root, id }, protectedRootPaths: [f.root.root.path] });
  assert.equal(broken.outcome, 'failed'); assert.equal(broken.failure, 'RESTORE_FAILED'); assert.equal(broken.result, undefined);
  assert.equal(existsSync(brokenTarget), true);
});

test('phase设施：没有窗口授权时拒绝，不能凭普通标签启动容量流程', async () => {
  const { runCapacityPhase } = await import('./helpers/recording-capacity-phases.js');
  await assert.rejects(runCapacityPhase({ phase: 'cold', profile: 'history-small', label: 'not-approved' } as never), /CAPACITY_PHASE_INVALID_INPUT/u);
});

test('phase设施：print-write实际25秒执行包络，其他phase仍保持通用50秒与53秒admission', async () => {
  const api = await import('./helpers/recording-capacity-phases.js');
  assert.deepEqual(api.capacityPhaseEffectiveOperationLimits('print-write'), { executionMs: 25_000, killGraceMs: 1_000, closeMs: 2_000, admissionReserveMs: 28_000 });
  for (const phase of ['prepare-backup','cold','full-recovery','queued-stop'] as const) {
    assert.deepEqual(api.capacityPhaseEffectiveOperationLimits(phase), { executionMs: 50_000, killGraceMs: 1_000, closeMs: 2_000, admissionReserveMs: 53_000 });
  }
});

// 外层协议测试只使用微型文字文件和受控operation，不运行真实seed或N10容量负载。
async function phaseFixture(t: test.TestContext, phase: import('./helpers/recording-capacity-phases.js').CapacityPhaseName = 'cold',
  printSamples: 10 | 105 = 105, selectedProfile?: import('./helpers/recording-capacity-phases.js').CapacityPhaseProfile) {
  const api = await import('./helpers/recording-capacity-phases.js');
  const runtime = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'musicbridge-phase-test-')));
  const fixture = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'musicbridge-version-')));
  t.after(() => { rmSync(runtime, { recursive: true, force: true }); rmSync(fixture, { recursive: true, force: true }); });
  const hash = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');
  const put = (file: string, value: unknown) => { writeFileSync(file, JSON.stringify(value)); return hash(file); };
  const seed = path.join(runtime, 'seed'), windowRoot = path.join(runtime, 'window'), output = path.join(windowRoot, 'run'); mkdirSync(seed); mkdirSync(windowRoot);
  const marker = { id: randomUUID(), scope: 'musicbridge-capacity-synthetic-only' }, id = randomUUID();
  put(path.join(fixture, 'capacity-owner.json'), marker); writeFileSync(path.join(seed, 'seed.sqlite'), '仅外层协议测试，不是SQLite容量seed');
  const profile = selectedProfile ?? (phase === 'queued-stop' || phase === 'print-write' ? 'objects-small' as const : 'history-small' as const);
  const jointTargets = { attemptEvents: 50_000, attemptBytes: 64 * 1024 ** 2, recordBytes: 64 * 1024 ** 2,
    printBytes: 64 * 1024 ** 2, photoBytes: 512 * 1024 ** 2, printObjectBytes: 512 * 1024 ** 2 };
  const jointGenerationPlan = { model: 'serial-single-output-plus-bounded-growth-v1', activeOutputMaximum: 1,
    finalAxisBytes: 1_275_068_416, activeOutputBytes: 1_275_068_416,
    activeRecordWorkspaceBytes: 16 * 1024 ** 2, evidenceAllowanceBytes: 128 * 1024 ** 2,
    plannedBytes: 2_701_131_776 };
  const metadata = { schema: 21, profile, fixtureDirectory: fixture, snapshotSha256: hash(path.join(seed, 'seed.sqlite')), marker,
    nextPlanId: randomUUID(), nextPlanHash: 'a'.repeat(64), integrity: 'passed',
    ...(['history-limit','objects-limit','joint'].includes(profile) ? { growth: { state: 'target-reached' } } : {}),
    ...(profile === 'joint' ? { generationPlan: jointGenerationPlan, axes: { targets: jointTargets, actual: jointTargets,
      reached: Object.fromEntries(Object.keys(jointTargets).map(key => [key, true])) } } : {}) };
  const metadataSha256 = put(path.join(seed, 'seed.json'), metadata);
  put(path.join(seed, 'exit.json'), { exit: 0 });
  put(path.join(windowRoot, 'owner.json'), { scope: 'musicbridge-capacity-phase-window', owner: 'root', id });
  const entry = (directory: string, relative: 'owner.json' | 'capacity-owner.json' | 'seed.json' | 'command.json' | 'r020-owner.json') => {
    const s = lstatSync(directory); return { path: directory, device: s.dev, inode: s.ino, marker: { relative, sha256: hash(path.join(directory, relative)) } };
  };
  const inventory: import('./helpers/recording-capacity-phases.js').CapacityOwnedManifest = { schemaVersion: 1, scope: 'musicbridge-capacity-owned-roots', access: 'count-only', windowId: id,
    roots: [entry(windowRoot, 'owner.json'), entry(seed, 'seed.json'), entry(fixture, 'capacity-owner.json')] };
  const sourceSha = put(path.join(windowRoot, 'source-pins.json'), api.capacityPhaseSourcePins());
  let at = Date.now();
  const w: import('./helpers/recording-capacity-phases.js').CapacityPhaseWindow = { schemaVersion: 1, scope: 'musicbridge-capacity-phase-window', owner: 'root', id, state: 'approved',
    phase, profile, label: 'run', seed: { label: 'seed', metadataSha256, snapshotSha256: metadata.snapshotSha256 }, n: phase === 'queued-stop' ? 105 : phase === 'print-write' ? printSamples : 10,
    issuedAt: new Date(at - 1000).toISOString(), deadlineAt: new Date(at + (phase === 'queued-stop' || phase === 'print-write' && printSamples === 105 ? 899000 : 800000)).toISOString(), limits: { ...api.CAPACITY_PHASE_LIMITS },
    ownedManifest: { file: 'owned-roots.json', sha256: '' }, sourceManifest: { file: 'source-pins.json', sha256: sourceSha } };
  const args: import('./helpers/recording-capacity-phases.js').CapacityPhaseArguments = { phase, profile, label: 'run', seedLabel: 'seed',
    windowPath: path.join(windowRoot, 'window.json'), windowSha256: '', ownedRootsPath: path.join(windowRoot, 'owned-roots.json'), ownedRootsSha256: '' };
  const seal = () => { w.ownedManifest.sha256 = put(args.ownedRootsPath, inventory); args.ownedRootsSha256 = w.ownedManifest.sha256; args.windowSha256 = put(args.windowPath, w); };
  seal();
  const options = { runtimeRoot: runtime, now: () => at, availableBytes: () => 100 * 1024 ** 3 };
  let fakePid = 98765;
  const coldResult = (input: import('./helpers/recording-capacity-process.js').CapacityColdInput): import('./helpers/recording-capacity-process.js').CapacityProcessResult => ({
    outcome: 'ok', requestId: randomUUID(), childPid: ++fakePid, code: 0, signal: null, closed: true, cleanup: { termSent: false, killSent: false }, forkToCloseMs: 10, phase: 'exited', timings: {},
    result: { kind: 'cold', planId: input.planId, planHash: input.planHash, budget: { attemptBytes: 0, planBytes: 0, recordBytes: 0, printBytes: 0, photoBytes: 0, printObjectBytes: 0, attempts: 0, events: 0, receipts: 0, records: 0, plans: 0, printJobs: 0, printReceipts: 0 },
      repositoryOpenMs: 1, fullAuditMs: 1, databaseCloseMs: 1, childMeasuredMs: 3, clock: 'child-relative', deviceOpened: false, formalReady: false, gateB: 'NOT_RUN' } });
  const queuedResult = (input: import('./helpers/recording-capacity-process.js').CapacityQueuedStopInput, values: Partial<{
    progressMs: number; abortMs: number; invokeMs: number; ackMs: number; receiptMs: number; parentReceiptMs: number; closeInvokedMs: number; closeResolvedMs: number;
  }> = {}): import('./helpers/recording-capacity-process.js').CapacityProcessResult => {
    const childPid = ++fakePid, progressMs = values.progressMs ?? 10, closeResolvedMs = values.closeResolvedMs ?? 20;
    return { outcome: 'ok', requestId: randomUUID(), childPid, code: 0, signal: null, closed: true,
      cleanup: { termSent: false, killSent: false }, forkToCloseMs: 30, phase: 'exited',
      timings: { clock: 'parent-relative', readyMs: 5, receiptMs: 20, exitMs: 25, sendStopToReceiptMs: values.parentReceiptMs ?? 12, receiptToChildCloseMs: 5 },
      processGroup: { pgid: childPid, managed: true, groupEmpty: true, zombies: [] },
      result: { kind: 'queue', planId: input.planId, planHash: input.planHash, attemptId: randomUUID(), order: ['progress', 'stop'], progressFrames: 1,
        fullAuditMs: 3, beginMs: 4, progressMs, abortObserved: true, driverStopInvoked: true, driverStopAcknowledged: true,
        stopReceivedToAbortMs: values.abortMs ?? 1, stopReceivedToDriverStopInvokedMs: values.invokeMs ?? 2,
        stopReceivedToDriverStopAckMs: values.ackMs ?? 3, stopReceivedToReceiptMs: values.receiptMs ?? 15,
        driverCloseInvoked: true, driverCloseResolved: true, stopReceivedToDriverCloseInvokedMs: values.closeInvokedMs ?? 16,
        stopReceivedToDriverCloseResolvedMs: closeResolvedMs, childMeasuredMs: Math.max(progressMs, closeResolvedMs) + 5, clock: 'child-relative',
        deviceOpened: false, formalReady: false, gateB: 'NOT_RUN' } };
  };
  const printResult = (input: import('./helpers/recording-capacity-process.js').CapacityPrintWriteInput, values: Partial<{ claimMs: number; completeMs: number }> = {}): import('./helpers/recording-capacity-process.js').CapacityProcessResult => {
    const childPid = ++fakePid, attemptId = randomUUID(), recordingId = randomUUID(), jobId = randomUUID(), requestId = randomUUID(), leaseId = randomUUID(), workerId = randomUUID(), artifactId = randomUUID();
    const inputHash = 'b'.repeat(64), pdfSha256 = 'c'.repeat(64), previewSha256 = 'd'.repeat(64), claimMs = values.claimMs ?? 20, completeMs = values.completeMs ?? 30;
    return { outcome: 'ok', requestId: randomUUID(), childPid, code: 0, signal: null, closed: true, cleanup: { termSent: false, killSent: false }, forkToCloseMs: 100,
      phase: 'exited', timings: {}, processGroup: { pgid: childPid, managed: true, groupEmpty: true, zombies: [] },
      result: { kind: 'print-write', planId: input.planId, planHash: input.planHash, attemptId, recordingId, jobId, requestId, inputHash,
        events: [{ revision: 1, kind: 'create' }, { revision: 2, kind: 'claim' }, { revision: 3, kind: 'complete' }],
        lease: { leaseId, workerId, jobId, requestId, inputHash }, job: { id: jobId, requestId, inputHash, state: 'ready', revision: 3, artifactId },
        artifact: { id: artifactId, requestId, recordingId, inputHash, pdfSha256, previewSha256, size: 4096, previewSize: 1024, pageCount: 1 },
        completeReceipt: { id: `lease:${leaseId}`, kind: 'complete', fingerprint: 'e'.repeat(64) },
        pdf: { sha256: pdfSha256, size: 4096, mime: 'application/pdf', width: null, height: null },
        preview: { sha256: previewSha256, size: 1024, mime: 'image/jpeg', width: 1, height: 1 },
        claimMs, completeMs, idempotent: true, childMeasuredMs: claimMs + completeMs + 10, clock: 'child-relative', deviceOpened: false, formalReady: false, gateB: 'NOT_RUN' } };
  };
  return { api, runtime, fixture, seed, output, windowRoot, inventory, args, w, seal, put, hash, entry, options, coldResult, queuedResult, printResult, advance: (ms: number) => { at += ms; } };
}

function configureExact75V2Recovery(f: Awaited<ReturnType<typeof phaseFixture>>, rootCount: number, remapped = true) {
  const outer = f.w as unknown as Record<string, unknown>, seed = outer.seed as Record<string, unknown>;
  outer.scope = 'musicbridge-capacity-queued-stop-window';
  outer.issuerFailureCarryoverCount = 1; outer.prechildFailureCarryoverCount = 1;
  outer.processFailureCarryoverCount = 1; outer.seedLabel = 'seed';
  seed.fixtureOwnerSha256 = f.hash(path.join(f.fixture, 'capacity-owner.json'));
  const snapshotBytes = lstatSync(path.join(f.seed, 'seed.sqlite')).size;
  outer.queuedStopPlan = { warmupCount: 5, formalCount: 100, sampleCount: 105, activeCloneMaximum: 1,
    snapshotBytes, evidenceAllowanceBytes: 256 * 1024 ** 2, plannedBytes: snapshotBytes + 256 * 1024 ** 2,
    model: 'serial-single-clone-plus-bounded-growth-v1', aggregateAudit: 'queued-stop-aggregate-budget.jsonl' };
  outer.supervisor = { path: path.join(f.windowRoot, 'supervisor.py'), sha256: '1'.repeat(64) };
  const gitRoot = path.join(f.runtime, 'git-fixture'); mkdirSync(gitRoot);
  const candidate = path.join(gitRoot, 'candidate'), upstream = path.join(gitRoot, 'upstream.git');
  mkdirSync(candidate);
  const gitEnvironment = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
    GIT_OPTIONAL_LOCKS: '0', GIT_NO_LAZY_FETCH: '1' };
  const git = (directory: string, args: string[]) => {
    const result = spawnSync('/usr/bin/git', args, { cwd: directory, encoding: 'utf8', env: gitEnvironment });
    assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`); return result.stdout.trim();
  };
  git(gitRoot, ['init', '--bare', upstream]); git(candidate, ['init', '-b', 'codex/exact75-test']);
  git(candidate, ['config', 'user.name', 'MusicBridge Test']); git(candidate, ['config', 'user.email', 'musicbridge-test@example.invalid']);
  const recoveryRelative = 'scripts/ci/create-v3-capacity-measure-root-recovery.py';
  const recoveryTool = path.join(candidate, recoveryRelative); mkdirSync(path.dirname(recoveryTool), { recursive: true });
  writeFileSync(recoveryTool, '#!/usr/bin/env python3\nprint("exact75 test tool")\n');
  git(candidate, ['add', recoveryRelative]); git(candidate, ['commit', '-m', 'test: freeze recovery tool']);
  git(candidate, ['remote', 'add', 'origin', upstream]); git(candidate, ['push', '-u', 'origin', 'HEAD']);
  const candidateHead = git(candidate, ['rev-parse', 'HEAD^{commit}']);
  outer.candidateRepository = { root: candidate, branch: 'codex/exact75-test', head: candidateHead };
  outer.toolchain = { node: { path: '/test/node', sha256: '5'.repeat(64) }, tsxLoader: { path: '/test/tsx-loader.mjs', sha256: '6'.repeat(64) },
    consumerPython: { path: '/test/python', sha256: '7'.repeat(64) } };
  const lostRoots = [f.inventory.roots.find(root => root.path === f.fixture)!];
  for (let index = 1; index < 7; index += 1) {
    const directory = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'musicbridge-version-')));
    f.put(path.join(directory, 'capacity-owner.json'), { id: randomUUID(), scope: 'musicbridge-capacity-synthetic-only' });
    lostRoots.push(f.entry(directory, 'capacity-owner.json')); rmSync(directory, { recursive: true });
  }
  rmSync(f.fixture, { recursive: true });
  const liveRoots = [f.inventory.roots.find(root => root.path === f.seed)!];
  for (let index = 1; index < 63; index += 1) {
    const directory = path.join(f.runtime, `measure-live-${String(index).padStart(2, '0')}`); mkdirSync(directory);
    f.put(path.join(directory, 'owner.json'), { scope: 'musicbridge-capacity-measure-live', index });
    liveRoots.push(f.entry(directory, 'owner.json'));
  }
  const currentDevice = lstatSync(f.runtime).dev;
  const historicalDevice = remapped ? currentDevice + 1 : currentDevice;
  const historicalRoots = [...liveRoots, ...lostRoots].map(root => ({ ...root, device: historicalDevice }));
  const historicalLostRoots = historicalRoots.slice(63);
  const recoveryDirectory = path.join(f.runtime, 'measure-root-recovery-v1'); mkdirSync(recoveryDirectory);
  const mappings = historicalLostRoots.map((historicalRoot, index) => {
    const directory = path.join(recoveryDirectory, `replacement-${String(index + 1).padStart(3, '0')}`); mkdirSync(directory);
    f.put(path.join(directory, 'owner.json'), { schemaVersion: 1, scope: 'musicbridge-capacity-historical-control-only',
      id: randomUUID(), role: 'historical-control-only', recovered: false, historicalRoot });
    chmodSync(directory, 0o700); chmodSync(path.join(directory, 'owner.json'), 0o400);
    const identity = f.entry(directory, 'owner.json');
    const replacementRoot = { ...identity, role: 'historical-control-only' as const };
    return { historicalRoot, state: 'LOST' as const, recovered: false as const, replacementRoot };
  });
  const historicalDirectory = path.join(f.runtime, 'measure'); mkdirSync(historicalDirectory); const historicalWindowId = randomUUID();
  const historicalManifest = path.join(historicalDirectory, 'owned-roots.json');
  f.put(historicalManifest, { schemaVersion: 1, scope: 'musicbridge-capacity-owned-roots', access: 'count-only',
    windowId: historicalWindowId, roots: historicalRoots, futureRoots: [path.join(f.runtime, 'measure-output')] });
  const recovery = path.join(recoveryDirectory, 'recovery.json');
  f.put(recovery, { schemaVersion: 1, scope: 'musicbridge-capacity-measure-root-recovery', access: 'read-only', state: 'PUBLISHED',
    model: 'exact75-v2-replacement-closure', windowId: historicalWindowId,
    historicalManifest: { path: historicalManifest, sha256: f.hash(historicalManifest) },
    repository: { root: candidate, branch: 'codex/exact75-test', head: candidateHead, clean: true, pushedHead: true },
    recoveryTool: { path: recoveryTool, relativePath: recoveryRelative,
      workingSha256: f.hash(recoveryTool), gitBlobSha256: f.hash(recoveryTool) }, mappings,
    liveDeviceRemap: { mode: remapped ? 'REMAPPED' : 'UNCHANGED', historicalDevice, currentDevice, liveRootCount: 63 },
    activeBenchmarkInput: { model: 'durable-seed-snapshot', path: path.join(f.seed, 'seed.sqlite'), sha256: f.hash(path.join(f.seed, 'seed.sqlite')) },
    contentRecovered: false, historicalManifestRewritten: false, deviceOpened: false, formalReady: false, gateB: 'NOT_RUN' });
  chmodSync(recoveryDirectory, 0o700); chmodSync(recovery, 0o400);
  const measureOutput = path.join(f.runtime, 'measure-output'); mkdirSync(measureOutput);
  f.put(path.join(measureOutput, 'command.json'), { scope: 'musicbridge-capacity-measure-output', label: 'measure-output' });
  const issuerCarryover = path.join(f.runtime, 'issuer-carryover'); mkdirSync(issuerCarryover);
  f.put(path.join(issuerCarryover, 'owner.json'), { scope: 'musicbridge-capacity-issuer-failure' });
  const prechildCarryover = path.join(f.runtime, 'prechild-carryover'); mkdirSync(prechildCarryover);
  f.put(path.join(prechildCarryover, 'owner.json'), { scope: 'musicbridge-capacity-prechild-failure' });
  const proof = (name: string) => ({ path: path.join(f.runtime, name), sha256: '3'.repeat(64) });
  outer.measureCarryover = { window: { ...proof('measure/window.json'), id: historicalWindowId }, close: proof('measure/close.json'),
    ownedManifest: { path: historicalManifest, sha256: f.hash(historicalManifest) }, sourceManifest: proof('measure/source-pins.json'),
    supervision: proof('measure/supervision/supervisor.json'), supervisor: proof('measure/supervisor.py'),
    output: { path: measureOutput, label: 'measure-output', commandSha256: f.hash(path.join(measureOutput, 'command.json')) },
    measureRootRecovery: { path: recovery, sha256: f.hash(recovery) } };
  const baseRoots = [...liveRoots, ...mappings.map(value => {
    const { role: _role, ...root } = value.replacementRoot; return root;
  }), f.entry(measureOutput, 'command.json'), f.entry(issuerCarryover, 'owner.json'), f.entry(prechildCarryover, 'owner.json')];
  assert.equal(baseRoots.length, 73);
  type ProcessNodeFixture = {
    root: string; id: string; label: string; pid: number; issuedMs: number; predecessor?: ProcessNodeFixture;
    stderrPid?: number; supervisorBytes?: number; mutate?: (documents: Record<string, any>) => void; row?: Record<string, any>;
  };
  const processTimestamp = (milliseconds: number, microseconds = false) => {
    const value = new Date(milliseconds).toISOString().replace(/Z$/u, '+00:00');
    return microseconds ? value.replace(/(\.\d{3})\+00:00$/u, '$1000+00:00') : value;
  };
  let nextProcessPid = 31_000;
  const makeProcessNode = (name: string, predecessor?: ProcessNodeFixture, issuedOffsetMs = -120_000): ProcessNodeFixture => {
    const root = path.join(f.runtime, name); mkdirSync(root); mkdirSync(path.join(root, 'issuer-identity')); mkdirSync(path.join(root, 'supervision'));
    return { root, id: randomUUID(), label: `${name}-run`, pid: nextProcessPid++,
      issuedMs: Date.parse(String(outer.issuedAt)) + issuedOffsetMs, ...(predecessor ? { predecessor } : {}) };
  };
  const sealProcessNode = (node: ProcessNodeFixture): Record<string, any> => {
    const predecessorRow = node.predecessor ? sealProcessNode(node.predecessor) : undefined;
    const issuerIdentity = path.join(node.root, 'issuer-identity'), supervisionRoot = path.join(node.root, 'supervision');
    const ownerPath = path.join(node.root, 'owner.json'), supervisorPath = path.join(node.root, 'supervisor.py');
    f.put(ownerPath, { scope: outer.scope, owner: 'root', id: node.id });
    writeFileSync(supervisorPath, '#!/usr/bin/env python3\n# process failure fixture\n'.padEnd(node.supervisorBytes ?? 48, '#'));
    const sourceManifestPath = path.join(node.root, 'source-pins.json'); f.put(sourceManifestPath, f.api.capacityPhaseSourcePins());
    const nodeIssuerFact = {
      schemaVersion: 1, scope: 'musicbridge-capacity-queued-stop-authority-issuer', windowId: node.id,
      issuerRepository: { root: candidate, branch: 'codex/exact75-test', head: candidateHead, relativePath: recoveryRelative, sha256: f.hash(recoveryTool) },
      candidateRepository: outer.candidateRepository, supervisorSource: { path: supervisorPath, sha256: f.hash(supervisorPath) }, toolchain: outer.toolchain,
      buildHelper: { path: recoveryTool, relativePath: recoveryRelative, sha256: f.hash(recoveryTool) },
      buildToolchain: { node: outer.toolchain, nodeLibrary: outer.toolchain, typescriptCompiler: outer.toolchain, typescriptLibraryManifestSha256: 'a'.repeat(64) },
      build: {}, issuerFailureCarryover: [{ root: issuerCarryover }], prechildFailureCarryover: [{ root: prechildCarryover }],
      ...(predecessorRow ? { processFailureCarryover: [predecessorRow] } : {}), measureCarryover: outer.measureCarryover,
    };
    const issuerFactPath = path.join(issuerIdentity, 'owner.json'); f.put(issuerFactPath, nodeIssuerFact);
    const ownedManifestPath = path.join(node.root, 'owned-roots.json');
    const nodeRoots = [...baseRoots, ...(node.predecessor ? [f.entry(node.predecessor.root, 'owner.json')] : []),
      f.entry(node.root, 'owner.json'), f.entry(issuerIdentity, 'owner.json')];
    f.put(ownedManifestPath, { schemaVersion: 1, scope: 'musicbridge-capacity-owned-roots', access: 'count-only', windowId: node.id, roots: nodeRoots });
    const nodeWindow: Record<string, any> = {
      schemaVersion: 1, scope: outer.scope, owner: 'root', id: node.id, state: 'approved', phase: 'queued-stop', profile: 'objects-limit', label: node.label,
      seedLabel: 'seed', seed: outer.seed, n: 105, issuerFailureCarryoverCount: 1, prechildFailureCarryoverCount: 1,
      ...(node.predecessor ? { processFailureCarryoverCount: 1 } : {}),
      issuedAt: processTimestamp(node.issuedMs), deadlineAt: processTimestamp(node.issuedMs + 900_000), limits: outer.limits,
      ownedManifest: { file: 'owned-roots.json', sha256: f.hash(ownedManifestPath) }, sourceManifest: { file: 'source-pins.json', sha256: f.hash(sourceManifestPath) },
      queuedStopPlan: outer.queuedStopPlan, supervisor: { path: supervisorPath, sha256: f.hash(supervisorPath) }, candidateRepository: outer.candidateRepository,
      toolchain: outer.toolchain, issuer: { path: recoveryTool, sha256: f.hash(recoveryTool), fact: { path: issuerFactPath, sha256: f.hash(issuerFactPath) } },
      measureCarryover: outer.measureCarryover,
    };
    const windowPath = path.join(node.root, 'window.json');
    const stdoutPath = path.join(supervisionRoot, 'stdout.log'), stderrPath = path.join(supervisionRoot, 'stderr.log');
    writeFileSync(stdoutPath, '');
    writeFileSync(stderrPath, `CAPACITY_PHASE_OPERATION_FAILED\n(node:${node.stderrPid ?? node.pid}) ExperimentalWarning: SQLite is an experimental feature and might change at any time\n(Use \`node --trace-warnings ...\` to show where the warning was created)\n`);
    const outputDirectory = path.join(node.root, node.label), elapsedMs = 650.25;
    const logFact = (file: string) => ({ path: file, exists: true, size: lstatSync(file).size, sha256: f.hash(file) });
    const queuedStop = { outputDirectory, verifiedComplete: false, verifiedPassed: false, fileCount: 0, sampleCount: 0,
      uniqueChildPids: 0, aggregateBudgetValid: false, unexpectedEntries: [] };
    const documents: Record<string, any> = { owner: JSON.parse(readFileSync(ownerPath, 'utf8')), issuerFact: nodeIssuerFact,
      ownedManifest: JSON.parse(readFileSync(ownedManifestPath, 'utf8')), window: nodeWindow,
      supervisorStart: { pid: node.pid, pgid: node.pid, command: ['/test/node','--import','/test/tsx-loader.mjs',path.join(candidate, 'packages/bridge-core/test/benchmarks/recording-capacity-process.ts'),
        '--phase','queued-stop','--profile','objects-limit','--label',node.label,'--seed-label','seed','--window',path.join(node.root, 'window.json'),
        '--window-sha256','0'.repeat(64),'--owned-roots',path.join(node.root, 'owned-roots.json'),'--owned-roots-sha256','0'.repeat(64)],
        managedProcessGroup: true, startedMonotonic: 100, deadlineMonotonic: 1_000, cwd: candidate,
        environmentKeys: ['CI','LANG','LC_ALL','PATH','TMPDIR','TZ'], environment: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'C', LC_ALL: 'C', TZ: 'UTC', CI: '1', TMPDIR: os.tmpdir() },
        stdin: 'DEVNULL', stdout: stdoutPath, stderr: stderrPath },
      supervision: { passed: false, failure: 'PROCESS_EXIT', pid: node.pid, pgid: node.pid, code: 1, exitSignal: null, signals: [], groupEmpty: true, zombies: [],
        elapsedMs, managedProcessGroup: true, stdout: logFact(stdoutPath), stderr: logFact(stderrPath), queuedStop },
    };
    node.mutate?.(documents);
    f.put(issuerFactPath, documents.issuerFact); f.put(ownedManifestPath, documents.ownedManifest);
    documents.window.ownedManifest.sha256 = f.hash(ownedManifestPath); documents.window.issuer.fact.sha256 = f.hash(issuerFactPath); f.put(windowPath, documents.window);
    documents.supervisorStart.command[15] = f.hash(windowPath);
    documents.supervisorStart.command[19] = f.hash(ownedManifestPath);
    const startPath = path.join(supervisionRoot, 'supervisor-start.json'); f.put(startPath, documents.supervisorStart);
    const supervisionPath = path.join(supervisionRoot, 'supervisor.json'); f.put(supervisionPath, documents.supervision);
    const closePath = path.join(node.root, 'close.json');
    const close = { schemaVersion: 1, scope: 'musicbridge-capacity-queued-stop-window-close', windowId: node.id, profile: 'objects-limit', label: node.label,
      seedLabel: 'seed', closedAt: processTimestamp(node.issuedMs + elapsedMs, true), state: 'failed', failure: 'PROCESS_EXIT', pid: node.pid, pgid: node.pid,
      managedProcessGroup: true, code: 1, exitSignal: null, signals: [], groupEmpty: true, zombies: [], elapsedMs,
      windowSha256: f.hash(windowPath), sourceManifestSha256: f.hash(sourceManifestPath), ownedManifestSha256: f.hash(ownedManifestPath), seed: outer.seed,
      measureCarryover: outer.measureCarryover, authorityAdmission: {}, authorityTerminal: {}, queuedStop,
      supervisorSha256: f.hash(supervisionPath), stdout: logFact(stdoutPath), stderr: logFact(stderrPath), deviceOpened: false, formalReady: false,
      gateB: 'NOT_RUN', replayPolicy: 'terminal-window-id-and-label-never-reuse' };
    f.put(closePath, close); chmodSync(node.root, 0o700); chmodSync(issuerIdentity, 0o700);
    const binding = (relative: string) => ({ path: path.join(node.root, relative), sha256: f.hash(path.join(node.root, relative)) });
    node.row = { root: node.root, windowId: node.id, windowDirName: path.basename(node.root), label: node.label, failure: 'PROCESS_EXIT', code: 1,
      sampleCount: 0, deviceOpened: false, formalReady: false, gateB: 'NOT_RUN', files: { owner: binding('owner.json'), supervisor: binding('supervisor.py'),
        issuerFact: binding('issuer-identity/owner.json'), sourceManifest: binding('source-pins.json'), ownedManifest: binding('owned-roots.json'),
        window: binding('window.json'), close: binding('close.json'), supervision: binding('supervision/supervisor.json'),
        supervisorStart: binding('supervision/supervisor-start.json'), stdout: binding('supervision/stdout.log'), stderr: binding('supervision/stderr.log') } };
    return node.row;
  };
  const processCarryover = path.join(f.runtime, 'process-carryover');
  const leafProcess = makeProcessNode('process-carryover'); const processRow = sealProcessNode(leafProcess);
  f.put(path.join(f.windowRoot, 'owner.json'), { scope: outer.scope, owner: 'root', id: outer.id });
  const issuerIdentity = path.join(f.windowRoot, 'issuer-identity'); mkdirSync(issuerIdentity);
  const issuerFact = {
    schemaVersion: 1, scope: 'musicbridge-capacity-queued-stop-authority-issuer', windowId: outer.id,
    issuerRepository: { root: candidate, branch: 'codex/exact75-test', head: candidateHead, relativePath: recoveryRelative, sha256: f.hash(recoveryTool) },
    candidateRepository: outer.candidateRepository, supervisorSource: outer.supervisor, toolchain: outer.toolchain,
    buildHelper: { path: recoveryTool, relativePath: recoveryRelative, sha256: f.hash(recoveryTool) },
    buildToolchain: { node: outer.toolchain, nodeLibrary: outer.toolchain, typescriptCompiler: outer.toolchain, typescriptLibraryManifestSha256: 'a'.repeat(64) },
    build: {}, issuerFailureCarryover: [{ root: issuerCarryover }], prechildFailureCarryover: [{ root: prechildCarryover }],
    processFailureCarryover: [processRow],
    measureCarryover: outer.measureCarryover,
  };
  const issuerFactPath = path.join(issuerIdentity, 'owner.json'); const issuerFactSha256 = f.put(issuerFactPath, issuerFact);
  outer.issuer = { path: recoveryTool, sha256: f.hash(recoveryTool), fact: { path: issuerFactPath, sha256: issuerFactSha256 } };
  chmodSync(f.windowRoot, 0o700); chmodSync(issuerIdentity, 0o700);
  f.inventory.roots = [...baseRoots, f.entry(processCarryover, 'owner.json'),
  f.entry(f.windowRoot, 'owner.json'), f.entry(issuerIdentity, 'owner.json')];
  if (rootCount < f.inventory.roots.length) f.inventory.roots.splice(rootCount);
  if (rootCount > f.inventory.roots.length) {
    assert.equal(rootCount, 77, '仅77-root负例可增加一条任意root');
    const directory = path.join(f.runtime, 'arbitrary-count-padding'); mkdirSync(directory);
    f.put(path.join(directory, 'owner.json'), { scope: 'arbitrary-count-padding' });
    f.inventory.roots.push(f.entry(directory, 'owner.json'));
  }
  const setProcessHead = (head: ProcessNodeFixture) => {
    const row = sealProcessNode(head), fact = JSON.parse(readFileSync(issuerFactPath, 'utf8')); fact.processFailureCarryover = [row];
    const sha256 = f.put(issuerFactPath, fact); (outer.issuer as Record<string, any>).fact.sha256 = sha256;
    f.inventory.roots[f.inventory.roots.length - 3] = f.entry(head.root, 'owner.json');
    f.inventory.roots[f.inventory.roots.length - 1] = f.entry(issuerIdentity, 'owner.json');
  };
  return { outer, seed, recovery, recoveryDirectory, mappings, historicalManifest, historicalRoots, liveRoots,
    historicalDevice, currentDevice,
    measureOutput, issuerCarryover, prechildCarryover, processCarryover, leafProcess, makeProcessNode, sealProcessNode, setProcessHead,
    candidate, candidateHead, recoveryTool, git };
}

test('phase设施：新入口参数严格，未知/重复/缺少窗口hash不接受', async () => {
  const { parseCapacityPhaseArguments } = await import('./helpers/recording-capacity-phases.js');
  for (const args of [[], ['--phase','cold'], ['--phase','cold','--phase','cold'], ['--invented','yes'], ['--phase']]) assert.throws(() => parseCapacityPhaseArguments(args), /CAPACITY_PHASE_INVALID_INPUT/u);
});

test('phase设施：UTC毫秒时间同时接受Z与Python +00:00，并拒绝非UTC或缺少毫秒', async t => {
  const accepted = await phaseFixture(t);
  accepted.w.issuedAt = accepted.w.issuedAt.replace(/Z$/u, '+00:00');
  accepted.w.deadlineAt = accepted.w.deadlineAt.replace(/Z$/u, '+00:00');
  accepted.seal(); let calls = 0;
  const summary = await accepted.api.runCapacityPhase(accepted.args, { ...accepted.options,
    cold: async input => { ++calls; return accepted.coldResult(input); } });
  assert.equal(calls, 10); assert.equal(summary.state, 'passed');

  for (const [name, mutate] of [
    ['non-utc', (value: string) => value.replace(/Z$/u, '+08:00')],
    ['missing-milliseconds', (value: string) => value.replace(/\.\d{3}Z$/u, 'Z')],
    ['missing-zone', (value: string) => value.replace(/Z$/u, '')],
  ] as const) await t.test(name, async () => {
    const rejected = await phaseFixture(t);
    rejected.w.issuedAt = mutate(rejected.w.issuedAt); rejected.seal(); let rejectedCalls = 0;
    await assert.rejects(rejected.api.runCapacityPhase(rejected.args, { ...rejected.options,
      cold: async input => { ++rejectedCalls; return rejected.coldResult(input); } }), /CAPACITY_PHASE_WINDOW_INVALID/u);
    assert.equal(rejectedCalls, 0); assert.equal(existsSync(rejected.output), false);
  });
});

for (const fault of ['owner','purpose','n','limit','expired','window-hash','inventory-hash','source-pins','seed-hash','symlink'] as const) test(`phase设施：${fault}前置拒绝且不建输出`, async t => {
  const f = await phaseFixture(t); let calls = 0;
  if (fault === 'owner') f.put(path.join(f.windowRoot, 'owner.json'), { scope: f.w.scope, owner: 'other', id: f.w.id });
  if (fault === 'purpose') f.w.phase = 'prepare-backup';
  if (fault === 'n') (f.w as unknown as { n: number }).n = 9;
  if (fault === 'limit') (f.w.limits as unknown as { executionMs: number }).executionMs = 50001;
  if (fault === 'expired') f.advance(900000);
  if (fault === 'source-pins') { const source = f.api.capacityPhaseSourcePins(); delete source.files['package.json']; f.w.sourceManifest.sha256 = f.put(path.join(f.windowRoot, 'source-pins.json'), source); }
  if (fault === 'seed-hash') writeFileSync(path.join(f.seed, 'seed.sqlite'), '已变更');
  if (fault === 'symlink') symlinkSync(f.seed, path.join(f.windowRoot, 'linked'));
  f.seal();
  if (fault === 'window-hash') f.args.windowSha256 = '0'.repeat(64);
  if (fault === 'inventory-hash') f.args.ownedRootsSha256 = '0'.repeat(64);
  await assert.rejects(f.api.runCapacityPhase(f.args, { ...f.options, cold: async input => { ++calls; return f.coldResult(input); } }));
  assert.equal(calls, 0); assert.equal(existsSync(f.output), false);
});

test('phase设施：N10固定、不补抽，raw及单样本回执落盘后才清理cold clone', async t => {
  const f = await phaseFixture(t); let calls = 0;
  const summary = await f.api.runCapacityPhase(f.args, { ...f.options, cold: async input => {
    ++calls;
    if (calls > 1) { const previous = `sample-${String(calls - 1).padStart(2, '0')}`; assert.equal(existsSync(path.join(f.output, previous)), false); assert.equal(existsSync(path.join(f.output, previous + '.json')), true); assert.equal(existsSync(path.join(f.output, previous + '.receipt.json')), true); }
    assert.equal(existsSync(input.clone.filePath), true); return f.coldResult(input);
  } });
  assert.equal(calls, 10); assert.equal(summary.state, 'passed'); assert.equal(summary.successes, 10); assert.equal(summary.p99, null);
  assert.equal(readFileSync(path.join(f.output, 'samples.jsonl'), 'utf8').trim().split('\n').length, 10);
  assert.equal(readdirSync(f.output).some(name => /^sample-\d\d$/u.test(name)), false);
  assert.equal(existsSync(path.join(f.seed, 'seed.sqlite')), true, 'inventory计费不赋删除权限');
});

for (const failure of ['timeout','unknown-close','over-limit','throw'] as const) test(`phase设施：${failure}保留失败目录与不完整结果，不补抽`, async t => {
  const f = await phaseFixture(t); let calls = 0;
  const summary = await f.api.runCapacityPhase(f.args, { ...f.options, cold: async input => {
    ++calls; if (failure === 'throw') throw new Error('不公开内部错误');
    const r = f.coldResult(input);
    if (failure === 'timeout') { r.outcome = 'timeout'; r.failure = 'TIMEOUT'; delete r.result; }
    if (failure === 'unknown-close') r.closed = false;
    if (failure === 'over-limit') r.forkToCloseMs = 50001;
    return r;
  } });
  assert.equal(calls, 1); assert.equal(summary.state, 'incomplete'); assert.equal(summary.attempted, 1); assert.equal(summary.unrun, 9);
  assert.equal(existsSync(path.join(f.output, 'sample-01', 'sample.sqlite')), true);
  assert.equal(existsSync(path.join(f.output, 'sample-01.json')), true);
  assert.equal(JSON.stringify(summary).includes('不公开内部错误'), false);
});

test('phase设施：窗口不足下一完整50s及清理余量时停止，剩余样本不伪完成', async t => {
  const f = await phaseFixture(t); let calls = 0;
  const summary = await f.api.runCapacityPhase(f.args, { ...f.options, cold: async input => { ++calls; f.advance(750000); return f.coldResult(input); } });
  assert.equal(calls, 1); assert.equal(summary.attempted, 1); assert.equal(summary.state, 'incomplete'); assert.equal(summary.failure, 'CAPACITY_PHASE_DEADLINE');
});

test('phase设施：当前operation返回时窗口已到期，失败clone不得清理', async t => {
  const f = await phaseFixture(t);
  const summary = await f.api.runCapacityPhase(f.args, { ...f.options, cold: async input => { f.advance(900000); return f.coldResult(input); } });
  assert.notEqual(summary.state, 'passed'); assert.equal(summary.attempted, 1);
  assert.equal(existsSync(path.join(f.output, 'sample-01', 'sample.sqlite')), true);
});

test('phase设施：单样本回执持久化失败时保留clone，不能先清理再报错', async t => {
  const f = await phaseFixture(t);
  const summary = await f.api.runCapacityPhase(f.args, { ...f.options, cold: async input => { f.put(path.join(f.output, 'sample-01.json'), { collision: true }); return f.coldResult(input); } });
  assert.notEqual(summary.state, 'passed'); assert.equal(summary.attempted, 1);
  assert.equal(existsSync(path.join(f.output, 'sample-01', 'sample.sqlite')), true);
  assert.deepEqual(JSON.parse(readFileSync(path.join(f.output, 'sample-01.json'), 'utf8')), { collision: true });
});

test('phase设施：磁盘余量不足立即拒绝，旧inventory保持只读', async t => {
  const f = await phaseFixture(t), before = f.hash(path.join(f.seed, 'seed.sqlite'));
  await assert.rejects(f.api.runCapacityPhase(f.args, { ...f.options, availableBytes: () => 10 * 1024 ** 3, cold: async input => f.coldResult(input) }), /CAPACITY_PHASE_SPACE/u);
  assert.equal(existsSync(f.output), false); assert.equal(f.hash(path.join(f.seed, 'seed.sqlite')), before);
});

async function phaseBackup(f: Awaited<ReturnType<typeof phaseFixture>>, databaseBytes = 64) {
  const previous = path.join(f.runtime, 'prior-window'), output = path.join(previous, 'backup-run'), backupPath = path.join(output, 'backup', randomUUID());
  mkdirSync(backupPath, { recursive: true }); f.put(path.join(previous, 'command.json'), { synthetic: true });
  const manifestHash = f.put(path.join(backupPath, 'Backup.json'), { synthetic: '仅外层核验测试，不是正式备份包' });
  const receipt = { schemaVersion: 1, kind: 'capacity-full-backup', state: 'verified', mode: 'archive-content', contentIncluded: true,
    id: randomUUID(), backupPath, manifestHash, databaseSha256: 'd'.repeat(64), databaseBytes, objectCount: 1, objectBytes: 16, manifestBytes: 16, preparationMs: 1,
    protectedRootPaths: [f.fixture, f.seed], seedLabel: f.args.seedLabel, seedSha256: f.w.seed.snapshotSha256, profile: f.args.profile, sourceManifestSha256: f.w.sourceManifest.sha256 };
  const receiptSha256 = f.put(path.join(output, 'backup-receipt.json'), receipt);
  f.inventory.roots.push(f.entry(previous, 'command.json')); f.args.backupLabel = 'backup-run'; f.w.backup = { label: 'backup-run', outputDirectory: output, receiptSha256 }; f.seal();
  return receipt;
}

test('phase设施：十份恢复树预检总投影超16GiB时不启动第一份', async t => {
  const f = await phaseFixture(t, 'full-recovery'); await phaseBackup(f, 1024 ** 3); let calls = 0;
  await assert.rejects(f.api.runCapacityPhase(f.args, { ...f.options, recovery: async () => { ++calls; throw new Error(); } }), /CAPACITY_PHASE_SPACE/u);
  assert.equal(calls, 0); assert.equal(existsSync(f.output), false);
});

test('phase设施：恢复N10完整树全部保留，准备耗时不跨时钟扣减', async t => {
  const f = await phaseFixture(t, 'full-recovery'), backup = await phaseBackup(f); let calls = 0;
  const summary = await f.api.runCapacityPhase(f.args, { ...f.options, recovery: async input => {
    ++calls; writeFileSync(path.join(input.destinationPath, 'retained'), '合成外层恢复操作');
    return { outcome: 'ok', requestId: randomUUID(), childPid: 98765 + calls, closed: true, code: 0, signal: null, cleanup: { termSent: false, killSent: false }, forkToCloseMs: 100, phase: 'exited', timings: {},
      result: { kind: 'restore', id: randomUUID(), sourceBackupId: backup.id, sourceManifestHash: backup.manifestHash, state: 'isolated-pending-activation', contentIncluded: true,
        objectCount: 1, objectBytes: 16, databaseSha256: 'd'.repeat(64), verifyBackupMs: 1, restoreMs: 1, verifyRestoredMs: 1, childMeasuredMs: 3, clock: 'child-relative', deviceOpened: false, formalReady: false, gateB: 'NOT_RUN' } };
  } });
  assert.equal(calls, 10); assert.equal(summary.state, 'passed');
  for (let i = 1; i <= 10; ++i) { const name = `sample-${String(i).padStart(2, '0')}`; assert.equal(existsSync(path.join(f.output, 'restores', name, 'retained')), true); assert.ok(JSON.parse(readFileSync(path.join(f.output, name + '.json'), 'utf8')).preparationMs >= 0); }
});

for (const mode of ['success','throw','deleted-protection','source-changed','seed-changed'] as const) test(`phase设施：prepare-backup ${mode}仅执行一次且不发布partial`, async t => {
  const f = await phaseFixture(t, 'prepare-backup'); let calls = 0;
  const summary = await f.api.runCapacityPhase(f.args, { ...f.options, prepare: async input => {
    ++calls; assert.equal(existsSync(input.clone.filePath), true);
    if (mode === 'throw') throw new Error('合成备份失败，内部细节不可输出');
    const id = randomUUID(), backupPath = path.join(input.output, 'backup', id); mkdirSync(backupPath, { recursive: true });
    const manifestHash = f.put(path.join(backupPath, 'Backup.json'), { synthetic: '仅外层测试' });
    if (mode === 'source-changed') f.put(path.join(f.windowRoot, 'source-pins.json'), { changed: true });
    if (mode === 'seed-changed') writeFileSync(path.join(f.seed, 'seed.sqlite'), '采样期间身份已变化');
    return { id, backupPath, manifestHash, databaseSha256: 'd'.repeat(64), databaseBytes: 64, objectCount: 1, objectBytes: 16, manifestBytes: 16, preparationMs: 1,
      protectedRootPaths: mode === 'deleted-protection' ? [input.clone.directory] : [f.fixture, f.seed] };
  } });
  assert.equal(calls, 1); assert.equal(summary.state, mode === 'success' ? 'prepared' : 'failed');
  assert.equal(existsSync(path.join(f.output, 'backup-receipt.json')), mode === 'success');
  assert.equal(existsSync(path.join(f.output, 'backup-source')), mode !== 'success');
  assert.equal(existsSync(path.join(f.seed, 'seed.sqlite')), true);
});

for (const phase of ['cold','full-recovery'] as const) for (const changed of ['source','seed'] as const) test(`phase设施：${phase}采样期间身份${changed}变化立即失败并保留当前样本`, async t => {
  const f = await phaseFixture(t, phase), backup = phase === 'full-recovery' ? await phaseBackup(f) : undefined; let calls = 0;
  const mutate = () => {
    ++calls;
    if (changed === 'source') f.put(path.join(f.windowRoot, 'source-pins.json'), { changed: true });
    else writeFileSync(path.join(f.seed, 'seed.sqlite'), '采样期间身份已变化');
  };
  const summary = await f.api.runCapacityPhase(f.args, { ...f.options,
    cold: async input => { mutate(); return f.coldResult(input); },
    recovery: async input => {
      mutate(); writeFileSync(path.join(input.destinationPath, 'retained'), '合成外层恢复操作');
      return { outcome: 'ok', requestId: randomUUID(), childPid: 98765 + calls, closed: true, code: 0, signal: null, cleanup: { termSent: false, killSent: false }, forkToCloseMs: 100, phase: 'exited', timings: {},
        result: { kind: 'restore', id: randomUUID(), sourceBackupId: backup!.id, sourceManifestHash: backup!.manifestHash, state: 'isolated-pending-activation', contentIncluded: true,
          objectCount: 1, objectBytes: 16, databaseSha256: 'd'.repeat(64), verifyBackupMs: 1, restoreMs: 1, verifyRestoredMs: 1, childMeasuredMs: 3, clock: 'child-relative', deviceOpened: false, formalReady: false, gateB: 'NOT_RUN' } };
    }
  });
  assert.equal(calls, 1); assert.equal(summary.state, 'incomplete'); assert.equal(summary.attempted, 1); assert.equal(summary.failures, 1); assert.equal(summary.successes, 0); assert.equal(summary.unrun, 9);
  assert.equal(summary.failure, changed === 'source' ? 'CAPACITY_PHASE_SOURCE_CHANGED' : 'CAPACITY_PHASE_SEED_INVALID');
  assert.equal(existsSync(path.join(f.output, ...(phase === 'cold' ? ['sample-01','sample.sqlite'] : ['restores','sample-01','retained']))), true);
  const rows = readFileSync(path.join(f.output, 'samples.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.equal(rows.length, 1); assert.equal(rows[0].outcome, 'failed'); assert.equal(rows[0].result.result, undefined);
  assert.equal(JSON.parse(readFileSync(path.join(f.output, 'sample-01.json'), 'utf8')).outcome, 'failed');
});

test('phase设施：相同child PID不能被计作十个独立新进程', async t => {
  const f = await phaseFixture(t); let calls = 0;
  const summary = await f.api.runCapacityPhase(f.args, { ...f.options, cold: async input => { ++calls; return { ...f.coldResult(input), childPid: 98765 }; } });
  assert.equal(calls, 2); assert.equal(summary.state, 'incomplete'); assert.equal(summary.successes, 1); assert.equal(summary.failures, 1);
  assert.equal(existsSync(path.join(f.output, 'sample-02')), true);
});

test('queued-stop phase：仅objects-small及三种大档、固定5预热+100正式900秒窗口可进入', async t => {
  for (const profile of ['objects-small','history-limit','objects-limit','joint'] as const) {
    const accepted = await phaseFixture(t, 'queued-stop', 105, profile);
    assert.deepEqual(accepted.api.parseCapacityPhaseArguments([
      '--phase', 'queued-stop', '--profile', profile, '--label', accepted.args.label, '--seed-label', accepted.args.seedLabel,
      '--window', accepted.args.windowPath, '--window-sha256', accepted.args.windowSha256,
      '--owned-roots', accepted.args.ownedRootsPath, '--owned-roots-sha256', accepted.args.ownedRootsSha256,
    ]), accepted.args, '正式CLI应通过同一严格参数解析器进入queued-stop phase');
    if (profile !== 'objects-small') {
      let calls = 0;
      const summary = await accepted.api.runCapacityPhase(accepted.args, { ...accepted.options, queuedStop: async () => { ++calls; throw new Error('受控首样本失败'); } });
      assert.equal(calls, 1, `${profile}须越过schema验证进入首样本`);
      assert.equal(summary.state, 'incomplete'); assert.equal(summary.attempted, 1); assert.equal(summary.unrun, 104);
    }
  }
  for (const phase of ['prepare-backup','cold'] as const) {
    const rejected = await phaseFixture(t, phase, 105, 'joint');
    assert.throws(() => rejected.api.parseCapacityPhaseArguments([
      '--phase', phase, '--profile', 'joint', '--label', rejected.args.label, '--seed-label', rejected.args.seedLabel,
      '--window', rejected.args.windowPath, '--window-sha256', rejected.args.windowSha256,
      '--owned-roots', rejected.args.ownedRootsPath, '--owned-roots-sha256', rejected.args.ownedRootsSha256,
    ]), /CAPACITY_PHASE_INVALID_INPUT/u, `${phase}不得因union扩展而顺带开放大档`);
  }
  for (const fault of ['profile', 'n', 'duration', 'missing-growth', 'missing-generation-plan', 'wrong-generation-plan', 'missing-axes', 'axis-not-reached'] as const) {
    const f = await phaseFixture(t, 'queued-stop', 105, 'joint'); let calls = 0;
    if (fault === 'profile') { f.args.profile = 'history-small'; f.w.profile = 'history-small'; }
    else if (fault === 'n') (f.w as unknown as { n: number }).n = 104;
    else if (fault === 'duration') f.w.deadlineAt = new Date(Date.parse(f.w.deadlineAt) - 1).toISOString();
    else if (fault === 'missing-growth') {
      const metadataPath = path.join(f.seed, 'seed.json'), metadata = JSON.parse(readFileSync(metadataPath, 'utf8'));
      delete metadata.growth; f.w.seed.metadataSha256 = f.put(metadataPath, metadata);
      f.inventory.roots.find(root => root.path === f.seed)!.marker.sha256 = f.w.seed.metadataSha256;
    } else {
      const metadataPath = path.join(f.seed, 'seed.json'), metadata = JSON.parse(readFileSync(metadataPath, 'utf8'));
      if (fault === 'missing-generation-plan') delete metadata.generationPlan;
      else if (fault === 'wrong-generation-plan') metadata.generationPlan.plannedBytes = 6_140_461_056;
      else if (fault === 'missing-axes') delete metadata.axes;
      else metadata.axes.reached.printBytes = false;
      f.w.seed.metadataSha256 = f.put(metadataPath, metadata);
      f.inventory.roots.find(root => root.path === f.seed)!.marker.sha256 = f.w.seed.metadataSha256;
    }
    f.seal();
    await assert.rejects(f.api.runCapacityPhase(f.args, { ...f.options, queuedStop: async input => { ++calls; return f.queuedResult(input); } }),
      ['missing-growth','missing-generation-plan','wrong-generation-plan','missing-axes','axis-not-reached'].includes(fault)
        ? /CAPACITY_PHASE_SEED_INVALID/u : /CAPACITY_PHASE_(?:INVALID_INPUT|WINDOW_INVALID)/u);
    assert.equal(calls, 0); assert.equal(existsSync(f.output), false);
  }
});

test('queued-stop successor：按三类failure carryover精确接受76 roots', async t => {
  for (const [rootCount, prechildCount, processCount, accepted] of [
    [76, undefined, 1, false], [76, 0, 1, false], [76, 1, undefined, false], [76, 1, 0, false],
    [75, 1, 1, false], [76, 1, 1, true], [77, 1, 1, false],
  ] as const) {
    const f = await phaseFixture(t, 'queued-stop', 105, 'objects-limit');
    const { outer } = configureExact75V2Recovery(f, rootCount);
    if (prechildCount === undefined) delete outer.prechildFailureCarryoverCount;
    else outer.prechildFailureCarryoverCount = prechildCount;
    if (processCount === undefined) delete outer.processFailureCarryoverCount;
    else outer.processFailureCarryoverCount = processCount;
    f.seal(); let calls = 0;
    if (accepted) {
      const summary = await f.api.runCapacityPhase(f.args, { ...f.options, queuedStop: async () => { ++calls; throw new Error('受控停止'); } });
      assert.equal(calls, 1); assert.equal(summary.state, 'incomplete');
    } else {
      await assert.rejects(f.api.runCapacityPhase(f.args, { ...f.options, queuedStop: async () => { ++calls; throw new Error('不应调用'); } }),
        /CAPACITY_PHASE_(?:WINDOW_INVALID|INVENTORY_INVALID)/u);
      assert.equal(calls, 0); assert.equal(existsSync(f.output), false);
    }
  }
});

test('queued-stop successor：真实CLI无runtime override时从受控window绝对路径解析runtime root', async t => {
  const f = await phaseFixture(t, 'queued-stop', 105, 'objects-limit');
  configureExact75V2Recovery(f, 76);
  f.seal();
  const { runtimeRoot: _runtimeRoot, ...cliOptions } = f.options;
  let calls = 0;
  const summary = await f.api.runCapacityPhase(f.args, {
    ...cliOptions,
    queuedStop: async () => { ++calls; throw new Error('受控首样本停止'); },
  });
  assert.equal(calls, 1);
  assert.equal(summary.state, 'incomplete');
  assert.equal(summary.attempted, 1);
});

test('queued-stop successor：current outer只接受exact1 process head与固定76 direct roots', async t => {
  const f = await phaseFixture(t, 'queued-stop', 105, 'objects-limit');
  const configured = configureExact75V2Recovery(f, 76);
  const second = configured.makeProcessNode('process-second'); const secondRow = configured.sealProcessNode(second);
  const issuerFactPath = path.join(f.windowRoot, 'issuer-identity', 'owner.json');
  const issuerFact = JSON.parse(readFileSync(issuerFactPath, 'utf8'));
  issuerFact.processFailureCarryover = [configured.leafProcess.row, secondRow]; configured.outer.processFailureCarryoverCount = 2;
  const issuerFactSha256 = f.put(issuerFactPath, issuerFact); (configured.outer.issuer as Record<string, any>).fact.sha256 = issuerFactSha256;
  f.inventory.roots.splice(f.inventory.roots.length - 2, 0, f.entry(second.root, 'owner.json'));
  f.inventory.roots[f.inventory.roots.length - 1] = f.entry(path.join(f.windowRoot, 'issuer-identity'), 'owner.json');
  f.seal(); let calls = 0;
  await assert.rejects(f.api.runCapacityPhase(f.args, { ...f.options,
    queuedStop: async input => { ++calls; return f.queuedResult(input); } }), /CAPACITY_PHASE_(?:WINDOW|INVENTORY)_INVALID/u);
  assert.equal(calls, 0); assert.equal(existsSync(f.output), false);
});

test('queued-stop successor：递归PROCESS_EXIT单链接受latest head并拒绝嵌套漂移、重排、环、分叉与orphan', async t => {
  const run = async (fault: 'none' | 'nested-window' | 'reordered-roots' | 'cycle' | 'fork' | 'orphan' | 'stderr-pid' | 'time-order' | 'duplicate-id' | 'duplicate-label') => {
    const f = await phaseFixture(t, 'queued-stop', 105, 'objects-limit');
    const configured = configureExact75V2Recovery(f, 76);
    const linked = configured.makeProcessNode('process-linked', configured.leafProcess, -60_000);
    if (fault === 'nested-window') configured.leafProcess.mutate = documents => { documents.window.id = randomUUID(); };
    if (fault === 'reordered-roots') linked.mutate = documents => {
      [documents.ownedManifest.roots[0], documents.ownedManifest.roots[1]] = [documents.ownedManifest.roots[1], documents.ownedManifest.roots[0]];
    };
    if (fault === 'fork') linked.mutate = documents => { documents.issuerFact.processFailureCarryover.push(configured.leafProcess.row); };
    if (fault === 'orphan') configured.sealProcessNode(configured.makeProcessNode('process-orphan', undefined, -90_000));
    if (fault === 'stderr-pid') configured.leafProcess.stderrPid = configured.leafProcess.pid + 1;
    if (fault === 'time-order') configured.leafProcess.issuedMs = linked.issuedMs + 10_000;
    if (fault === 'duplicate-id') linked.id = configured.leafProcess.id;
    if (fault === 'duplicate-label') linked.label = configured.leafProcess.label;
    if (fault === 'cycle') {
      configured.sealProcessNode(linked);
      linked.mutate = documents => { documents.issuerFact.processFailureCarryover = [linked.row]; };
    }
    configured.setProcessHead(linked); f.seal(); let calls = 0;
    const execution = f.api.runCapacityPhase(f.args, { ...f.options,
      queuedStop: async () => { ++calls; throw new Error(fault === 'none' ? '受控停止' : '不应调用'); } });
    if (fault === 'none') {
      const summary = await execution; assert.equal(calls, 1); assert.equal(summary.state, 'incomplete');
    } else {
      await assert.rejects(execution, /CAPACITY_PHASE_(?:WINDOW|INVENTORY)_INVALID/u);
      assert.equal(calls, 0); assert.equal(existsSync(f.output), false);
    }
  };
  for (const fault of ['none','nested-window','reordered-roots','cycle','fork','orphan','stderr-pid','time-order','duplicate-id','duplicate-label'] as const) {
    await t.test(fault, () => run(fault));
  }
});

test('queued-stop successor：ownedBytes计入direct roots与递归可达process ancestors的union', async t => {
  const f = await phaseFixture(t, 'queued-stop', 105, 'objects-limit');
  const configured = configureExact75V2Recovery(f, 76);
  configured.leafProcess.supervisorBytes = 1024 * 1024;
  const linked = configured.makeProcessNode('process-linked', configured.leafProcess, -60_000);
  configured.setProcessHead(linked); f.seal();
  const capacity = await import('./helpers/recording-capacity-fixture.js');
  const roots = f.inventory.roots.map(root => root.path);
  const direct = [...new Set(roots)].sort().filter(root => !roots.some(other => other !== root && root.startsWith(other + path.sep)))
    .reduce((total, root) => total + capacity.capacityDirectoryBytes(root), 0);
  const inherited = capacity.capacityDirectoryBytes(configured.leafProcess.root);
  let calls = 0;
  const summary = await f.api.runCapacityPhase(f.args, { ...f.options,
    queuedStop: async () => { ++calls; throw new Error('受控停止'); } });
  assert.equal(calls, 1); assert.equal(summary.state, 'incomplete');
  const input = JSON.parse(readFileSync(path.join(f.output, 'input.json'), 'utf8'));
  assert.equal(input.initialSpace.ownedBytes, direct + inherited);
});

test('queued-stop successor：process failure fact语义、shape、文件及root身份漂移时不进入样本', async t => {
  for (const fault of ['missing', 'count', 'row-extra', 'failure', 'code', 'files-extra', 'file-sha', 'file-path',
    'nested-root', 'inode-drift'] as const) {
    const f = await phaseFixture(t, 'queued-stop', 105, 'objects-limit');
    const { outer, processCarryover } = configureExact75V2Recovery(f, 76);
    const issuerIdentity = path.join(f.windowRoot, 'issuer-identity');
    const issuerFactPath = path.join(issuerIdentity, 'owner.json');
    const issuerFact = JSON.parse(readFileSync(issuerFactPath, 'utf8'));
    if (fault === 'missing') delete issuerFact.processFailureCarryover;
    else if (fault === 'count') issuerFact.processFailureCarryover = [];
    else {
      const row = issuerFact.processFailureCarryover[0];
      if (fault === 'row-extra') row.extra = true;
      if (fault === 'failure') row.failure = 'OTHER';
      if (fault === 'code') row.code = 0;
      if (fault === 'files-extra') row.files.extra = row.files.owner;
      if (fault === 'file-sha') row.files.owner.sha256 = '4'.repeat(64);
      if (fault === 'file-path') row.files.owner.path = row.files.close.path;
      if (fault === 'nested-root') {
        const nestedParent = path.join(f.runtime, 'nested-process-history'); mkdirSync(nestedParent);
        const nestedRoot = path.join(nestedParent, path.basename(processCarryover));
        renameSync(processCarryover, nestedRoot); row.root = nestedRoot;
        for (const binding of Object.values(row.files) as Array<{ path: string }>) {
          binding.path = path.join(nestedRoot, path.relative(processCarryover, binding.path));
        }
        const inventoryRoot = f.inventory.roots.find(root => root.path === processCarryover)!;
        const info = lstatSync(nestedRoot); inventoryRoot.path = nestedRoot; inventoryRoot.device = info.dev; inventoryRoot.inode = info.ino;
      }
      if (fault === 'inode-drift') f.inventory.roots.find(root => root.path === processCarryover)!.inode += 1;
    }
    const issuerFactSha256 = f.put(issuerFactPath, issuerFact);
    (outer.issuer as Record<string, unknown>).fact = { path: issuerFactPath, sha256: issuerFactSha256 };
    f.inventory.roots.find(root => root.path === issuerIdentity)!.marker.sha256 = issuerFactSha256;
    f.seal(); let calls = 0;
    await assert.rejects(f.api.runCapacityPhase(f.args, { ...f.options,
      queuedStop: async () => { ++calls; throw new Error('不应调用'); } }), /CAPACITY_PHASE_(?:WINDOW|INVENTORY)_INVALID/u);
    assert.equal(calls, 0); assert.equal(existsSync(f.output), false);
  }
});

test('queued-stop successor：未发生st_dev重映射时使用UNCHANGED合同', async t => {
  const f = await phaseFixture(t, 'queued-stop', 105, 'objects-limit');
  configureExact75V2Recovery(f, 76, false);
  f.seal(); let calls = 0;
  const summary = await f.api.runCapacityPhase(f.args, { ...f.options, queuedStop: async () => { ++calls; throw new Error('受控停止'); } });
  assert.equal(calls, 1); assert.equal(summary.state, 'incomplete');
});

test('queued-stop successor：70根冻结manifest按63 live、7 replacement、output、三类carryover及parent/issuer闭包', async t => {
  for (const fault of ['arbitrary-replaces-live', 'arbitrary-replaces-output', 'live-root-absent', 'mapping-not-in-manifest'] as const) {
    await t.test(fault, async () => {
      const f = await phaseFixture(t, 'queued-stop', 105, 'objects-limit');
      const configured = configureExact75V2Recovery(f, 76);
      assert.equal(configured.historicalRoots.length, 70); assert.equal(configured.liveRoots.length, 63);
      const arbitrary = path.join(f.runtime, `arbitrary-${fault}`); mkdirSync(arbitrary);
      f.put(path.join(arbitrary, 'owner.json'), { scope: 'arbitrary-count-padding', fault });
      if (fault === 'arbitrary-replaces-live') {
        const index = f.inventory.roots.findIndex(root => root.path === configured.liveRoots[1]!.path);
        f.inventory.roots[index] = f.entry(arbitrary, 'owner.json');
      } else if (fault === 'arbitrary-replaces-output') {
        const index = f.inventory.roots.findIndex(root => root.path === configured.measureOutput);
        f.inventory.roots[index] = f.entry(arbitrary, 'owner.json');
      } else if (fault === 'live-root-absent') {
        rmSync(configured.liveRoots[1]!.path, { recursive: true });
      } else {
        const receipt = JSON.parse(readFileSync(configured.recovery, 'utf8'));
        const mapping = receipt.mappings[1], replacement = mapping.replacementRoot;
        mapping.historicalRoot = { ...mapping.historicalRoot,
          path: path.join(os.tmpdir(), `musicbridge-version-${randomUUID().replaceAll('-', '')}`) };
        const ownerPath = path.join(replacement.path, 'owner.json'); chmodSync(ownerPath, 0o600);
        const owner = JSON.parse(readFileSync(ownerPath, 'utf8')); owner.historicalRoot = mapping.historicalRoot;
        replacement.marker.sha256 = f.put(ownerPath, owner); chmodSync(ownerPath, 0o400);
        const inventoryRoot = f.inventory.roots.find(root => root.path === replacement.path)!;
        inventoryRoot.marker.sha256 = replacement.marker.sha256;
        chmodSync(configured.recovery, 0o600); const recoverySha = f.put(configured.recovery, receipt); chmodSync(configured.recovery, 0o400);
        (configured.outer.measureCarryover as Record<string, Record<string, unknown>>).measureRootRecovery!.sha256 = recoverySha;
      }
      f.seal(); let calls = 0;
      await assert.rejects(f.api.runCapacityPhase(f.args, { ...f.options, queuedStop: async () => { ++calls; throw new Error('RED sentinel'); } }),
        /CAPACITY_PHASE_(?:WINDOW_INVALID|INVENTORY_INVALID)/u);
      assert.equal(calls, 0); assert.equal(existsSync(f.output), false);
    });
  }
});

test('queued-stop successor：只接受全量一致的live st_dev挂载代际映射', async t => {
  for (const fault of ['mode-conflict', 'current-device-third', 'live-count', 'missing-field', 'mixed-historical-device', 'inventory-noncurrent-device'] as const) {
    await t.test(fault, async () => {
      const f = await phaseFixture(t, 'queued-stop', 105, 'objects-limit');
      const configured = configureExact75V2Recovery(f, 76);
      const receipt = JSON.parse(readFileSync(configured.recovery, 'utf8'));
      if (fault === 'mode-conflict') receipt.liveDeviceRemap.mode = 'UNCHANGED';
      if (fault === 'current-device-third') receipt.liveDeviceRemap.currentDevice += 1;
      if (fault === 'live-count') receipt.liveDeviceRemap.liveRootCount = 62;
      if (fault === 'missing-field') delete receipt.liveDeviceRemap;
      if (fault === 'mixed-historical-device') {
        const manifest = JSON.parse(readFileSync(configured.historicalManifest, 'utf8'));
        manifest.roots[1].device += 1;
        const manifestSha = f.put(configured.historicalManifest, manifest);
        receipt.historicalManifest.sha256 = manifestSha;
        (configured.outer.measureCarryover as Record<string, Record<string, unknown>>).ownedManifest!.sha256 = manifestSha;
      }
      if (fault === 'inventory-noncurrent-device') {
        const output = f.inventory.roots.find(root => root.path === configured.measureOutput)!;
        output.device = configured.historicalDevice;
      }
      chmodSync(configured.recovery, 0o600);
      const recoverySha = f.put(configured.recovery, receipt);
      chmodSync(configured.recovery, 0o400);
      (configured.outer.measureCarryover as Record<string, Record<string, unknown>>).measureRootRecovery!.sha256 = recoverySha;
      f.seal(); let calls = 0;
      await assert.rejects(f.api.runCapacityPhase(f.args, { ...f.options, queuedStop: async () => { ++calls; throw new Error('RED sentinel'); } }),
        /CAPACITY_PHASE_(?:WINDOW_INVALID|INVENTORY_INVALID)/u);
      assert.equal(calls, 0); assert.equal(existsSync(f.output), false);
    });
  }
});

test('queued-stop successor：live Git/blob及recovery直接条目权限在admission和windowCheck中拒绝漂移', async t => {
  for (const fault of ['git-blob', 'head', 'upstream', 'dirty', 'branch-after-admission', 'recovery-mode-after-admission', 'recovery-entry-after-admission'] as const) {
    await t.test(fault, async () => {
      const f = await phaseFixture(t, 'queued-stop', 105, 'objects-limit');
      const configured = configureExact75V2Recovery(f, 76);
      if (fault === 'git-blob') {
        configured.git(configured.candidate, ['update-index', '--assume-unchanged',
          'scripts/ci/create-v3-capacity-measure-root-recovery.py']);
        writeFileSync(configured.recoveryTool, '#!/usr/bin/env python3\nprint("working tree drift hidden from status")\n');
        const receipt = JSON.parse(readFileSync(configured.recovery, 'utf8'));
        receipt.recoveryTool.workingSha256 = f.hash(configured.recoveryTool);
        receipt.recoveryTool.gitBlobSha256 = receipt.recoveryTool.workingSha256;
        chmodSync(configured.recovery, 0o600); const recoverySha = f.put(configured.recovery, receipt); chmodSync(configured.recovery, 0o400);
        (configured.outer.measureCarryover as Record<string, Record<string, unknown>>).measureRootRecovery!.sha256 = recoverySha;
      } else if (fault === 'head') {
        configured.git(configured.candidate, ['commit', '--allow-empty', '-m', 'test: head drift']);
      } else if (fault === 'upstream') {
        configured.git(configured.candidate, ['commit', '--allow-empty', '-m', 'test: upstream drift source']);
        const driftHead = configured.git(configured.candidate, ['rev-parse', 'HEAD^{commit}']);
        configured.git(configured.candidate, ['reset', '--hard', configured.candidateHead]);
        configured.git(configured.candidate, ['update-ref', 'refs/remotes/origin/codex/exact75-test', driftHead]);
      } else if (fault === 'dirty') {
        writeFileSync(path.join(configured.candidate, 'untracked-drift'), 'dirty');
      }
      f.seal(); let calls = 0;
      const run = f.api.runCapacityPhase(f.args, { ...f.options, queuedStop: async input => {
        ++calls;
        if (calls > 1) throw new Error('RED sentinel');
        if (calls === 1 && fault === 'branch-after-admission') configured.git(configured.candidate, ['checkout', '-b', 'codex/drift']);
        if (calls === 1 && fault === 'recovery-mode-after-admission') chmodSync(configured.recovery, 0o600);
        if (calls === 1 && fault === 'recovery-entry-after-admission') writeFileSync(path.join(configured.recoveryDirectory, 'unexpected'), 'drift');
        return f.queuedResult(input);
      } });
      if (['git-blob', 'head', 'upstream', 'dirty'].includes(fault)) {
        await assert.rejects(run, /CAPACITY_PHASE_WINDOW_INVALID/u); assert.equal(calls, 0);
      } else {
        const summary = await run;
        assert.equal(calls, 1); assert.equal(summary.state, 'incomplete'); assert.equal(summary.failure, 'CAPACITY_PHASE_WINDOW_INVALID');
      }
    });
  }
});

test('queued-stop successor：consumer持续拒绝旧根重现、recovery漂移及replacement冒充fixture', async t => {
  for (const fault of ['historical-reappeared', 'receipt-drift', 'replacement-marker-drift', 'replacement-as-fixture'] as const) {
    await t.test(fault, async () => {
      const f = await phaseFixture(t, 'queued-stop', 105, 'objects-limit');
      const configured = configureExact75V2Recovery(f, 76);
      if (fault === 'historical-reappeared') {
        const original = configured.mappings[0]!.historicalRoot; mkdirSync(original.path);
        f.put(path.join(original.path, 'capacity-owner.json'), { id: randomUUID(), scope: 'musicbridge-capacity-synthetic-only' });
        t.after(() => rmSync(original.path, { recursive: true, force: true }));
      } else if (fault === 'receipt-drift') {
        const receipt = JSON.parse(readFileSync(configured.recovery, 'utf8')); receipt.contentRecovered = true;
        chmodSync(configured.recovery, 0o600);
        f.put(configured.recovery, receipt);
      } else if (fault === 'replacement-marker-drift') {
        const replacement = configured.mappings[0]!.replacementRoot;
        chmodSync(path.join(replacement.path, 'owner.json'), 0o600);
        f.put(path.join(replacement.path, 'owner.json'), { scope: 'drift' });
      } else {
        const metadataPath = path.join(f.seed, 'seed.json'), metadata = JSON.parse(readFileSync(metadataPath, 'utf8'));
        metadata.fixtureDirectory = configured.mappings[0]!.replacementRoot.path;
        const metadataSha256 = f.put(metadataPath, metadata);
        configured.outer.seed = { ...(configured.outer.seed as Record<string, unknown>), metadataSha256 };
        f.inventory.roots.find(root => root.path === f.seed)!.marker.sha256 = metadataSha256;
      }
      f.seal(); let calls = 0;
      await assert.rejects(f.api.runCapacityPhase(f.args, { ...f.options, queuedStop: async input => { ++calls; return f.queuedResult(input); } }),
        /CAPACITY_PHASE_(?:INVALID_INPUT|WINDOW_INVALID|INVENTORY_INVALID|SEED_INVALID)/u);
      assert.equal(calls, 0); assert.equal(existsSync(f.output), false);
    });
  }
});

test('legacy queued-stop窗口保持旧空间模型且不生成successor aggregate', async t => {
  const f = await phaseFixture(t, 'queued-stop'); let calls = 0;
  const summary = await f.api.runCapacityPhase(f.args, { ...f.options, queuedStop: async () => { ++calls; throw new Error('受控停止'); } });
  assert.equal(calls, 1); assert.equal(summary.state, 'incomplete');
  const input = JSON.parse(readFileSync(path.join(f.output, 'input.json'), 'utf8'));
  assert.equal(input.initialSpace.plannedBytes, 3 * lstatSync(path.join(f.seed, 'seed.sqlite')).size + 64 * 1024 ** 2);
  assert.equal(existsSync(path.join(f.output, 'queued-stop-aggregate-budget.jsonl')), false);
});

test('queued-stop phase：105个独立clone先固化raw回执/hash再清理，预热不进入正式分布', { timeout: 30_000 }, async t => {
  const f = await phaseFixture(t, 'queued-stop', 105, 'objects-limit'), markers = new Set<string>(); let calls = 0;
  configureExact75V2Recovery(f, 76);
  f.seal();
  const summary = await f.api.runCapacityPhase(f.args, { ...f.options, queuedStop: async input => {
    ++calls; markers.add(input.clone.marker.id);
    if (calls > 1) {
      const previous = `sample-${String(calls - 1).padStart(3, '0')}`;
      assert.equal(existsSync(path.join(f.output, previous)), false);
      const receipt = path.join(f.output, `${previous}-raw-receipt.json`), hashFile = path.join(f.output, `${previous}-raw-receipt.sha256.json`);
      assert.equal(existsSync(receipt), true); assert.equal(JSON.parse(readFileSync(hashFile, 'utf8')).sha256, f.hash(receipt));
      assert.equal(existsSync(path.join(f.output, `${previous}.receipt.json`)), true);
    }
    return f.queuedResult(input, { progressMs: calls <= 5 ? 80 : 10 });
  } });
  assert.equal(calls, 105); assert.equal(markers.size, 105); assert.equal(summary.state, 'passed');
  assert.equal(summary.planned, 105); assert.equal(summary.attempted, 105); assert.equal(summary.successes, 105); assert.equal(summary.unrun, 0);
  assert.deepEqual(summary.queuedStop?.counts, { warmup: 5, formal: 100 });
  assert.deepEqual(summary.queuedStop?.childProgressMs, { n: 100, p50: 10, p95: 10, p99: 10, max: 10, limitP95: 50, limitMax: 100, passed: true });
  assert.equal(summary.queuedStop?.stopReceivedToAbortMs.max, 1);
  assert.equal(summary.queuedStop?.stopReceivedToDriverStopInvokedMs.max, 2);
  assert.equal(summary.queuedStop?.stopReceivedToDriverStopAckMs.max, 3, 'ACK须与receipt/close分列');
  assert.equal(summary.queuedStop?.stopReceivedToReceiptMs.max, 15);
  assert.equal(summary.queuedStop?.parentSendStopToReceiptMs.max, 12);
  assert.equal(summary.queuedStop?.driverCloseResolvedMs.max, 20);
  assert.equal(summary.queuedStop?.passed, true);
  assert.equal(readFileSync(path.join(f.output, 'samples.jsonl'), 'utf8').trim().split('\n').length, 105);
  const aggregate = readFileSync(path.join(f.output, 'queued-stop-aggregate-budget.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.ok(aggregate.length >= 4 * 105, '每轮clone创建、业务落盘与清理都必须进入aggregate审计');
  assert.ok(aggregate.every(row => row.scope === 'musicbridge-capacity-queued-stop-aggregate-budget'
    && row.snapshotBytes === lstatSync(path.join(f.seed, 'seed.sqlite')).size
    && row.limitBytes === row.snapshotBytes + 256 * 1024 ** 2
    && row.outputBytesBefore <= row.limitBytes
    && row.plannedBytes <= row.limitBytes - row.outputBytesBefore));
  assert.equal(Math.max(...aggregate.map(row => row.activeClone === null ? 0 : 1)), 1);
  assert.equal(readdirSync(f.output).some(name => /^sample-\d{3}$/u.test(name)), false);
});

test('queued-stop phase：正式阈值失败保留完整100样本分布且不伪报PASS', { timeout: 30_000 }, async t => {
  const f = await phaseFixture(t, 'queued-stop'); let calls = 0;
  const summary = await f.api.runCapacityPhase(f.args, { ...f.options, queuedStop: async input => {
    ++calls; return calls === 6
      ? f.queuedResult(input, { progressMs: 101, abortMs: 101, invokeMs: 102, ackMs: 103, receiptMs: 2001, parentReceiptMs: 2001, closeInvokedMs: 2002, closeResolvedMs: 2003 })
      : f.queuedResult(input);
  } });
  assert.equal(calls, 105); assert.equal(summary.attempted, 105); assert.equal(summary.state, 'failed');
  assert.equal(summary.queuedStop?.childProgressMs.max, 101); assert.equal(summary.queuedStop?.childProgressMs.p95, 10);
  assert.equal(summary.queuedStop?.childProgressMs.passed, false); assert.equal(summary.queuedStop?.passed, false);
  assert.equal(summary.queuedStop?.stopReceivedToAbortMs.passed, false);
  assert.equal(summary.queuedStop?.stopReceivedToDriverStopInvokedMs.passed, false);
  assert.equal(summary.queuedStop?.stopReceivedToReceiptMs.passed, false);
  assert.equal(summary.queuedStop?.parentSendStopToReceiptMs.passed, false);
  assert.equal(summary.queuedStop?.driverCloseResolvedMs.passed, false);
  assert.equal(summary.failure, 'CAPACITY_PHASE_THRESHOLD_FAILED');
});

for (const mode of ['timeout', 'not-natural', 'zombie', 'identity-drift', 'persistence'] as const) test(`queued-stop phase：${mode}首错即停并保留当前clone`, async t => {
  const f = await phaseFixture(t, 'queued-stop'); let calls = 0;
  const summary = await f.api.runCapacityPhase(f.args, { ...f.options, queuedStop: async input => {
    ++calls;
    if (mode === 'identity-drift') f.put(path.join(f.windowRoot, 'source-pins.json'), { changed: true });
    if (mode === 'persistence') f.put(path.join(f.output, 'sample-001-raw-receipt.json'), { collision: true });
    const result = f.queuedResult(input);
    if (mode === 'timeout') { result.outcome = 'timeout'; result.failure = 'TIMEOUT'; result.cleanup.termSent = true; delete result.result; }
    if (mode === 'not-natural') result.processGroup!.groupEmpty = false;
    if (mode === 'zombie') result.processGroup!.zombies = [result.childPid!];
    return result;
  } });
  assert.equal(calls, 1); assert.equal(summary.attempted, 1); assert.equal(summary.unrun, 104); assert.equal(summary.state, 'incomplete');
  assert.equal(existsSync(path.join(f.output, 'sample-001', 'sample.sqlite')), true);
  assert.equal(JSON.stringify(summary).includes('设备静音'), false); assert.equal(summary.formalReady, false); assert.equal(summary.gateB, 'NOT_RUN');
});

test('print-write phase：只允许objects-small且pilot10与formal 5+100窗口身份分离', async t => {
  for (const count of [10, 105] as const) {
    const f = await phaseFixture(t, 'print-write', count);
    assert.deepEqual(f.api.parseCapacityPhaseArguments([
      '--phase', 'print-write', '--profile', 'objects-small', '--label', f.args.label, '--seed-label', f.args.seedLabel,
      '--window', f.args.windowPath, '--window-sha256', f.args.windowSha256, '--owned-roots', f.args.ownedRootsPath, '--owned-roots-sha256', f.args.ownedRootsSha256,
    ]), f.args);
    assert.equal(f.w.n, count);
  }
  const wrong = await phaseFixture(t, 'print-write', 10); wrong.args.profile = 'history-small'; wrong.w.profile = 'history-small'; wrong.seal();
  await assert.rejects(wrong.api.runCapacityPhase(wrong.args, { ...wrong.options, printWrite: async input => wrong.printResult(input) }), /CAPACITY_PHASE_(?:INVALID_INPUT|WINDOW_INVALID)/u);
});

test('print-write pilot：10个独立clone与新PID全成功，但不冒充formal阈值判定', async t => {
  const f = await phaseFixture(t, 'print-write', 10), markers = new Set<string>(), limits: unknown[] = []; let calls = 0;
  const seedBefore = f.hash(path.join(f.seed, 'seed.sqlite'));
  const summary = await f.api.runCapacityPhase(f.args, { ...f.options, printWrite: async (input, options) => { ++calls; markers.add(input.clone.marker.id); limits.push(options); return f.printResult(input, { claimMs: 2100, completeMs: 2200 }); } });
  assert.equal(calls, 10); assert.equal(markers.size, 10); assert.equal(summary.state, 'passed');
  assert.equal(limits.length, 10); for (const value of limits) assert.deepEqual(value, { executionTimeoutMs: 25_000, killGraceMs: 1_000, closeTimeoutMs: 2_000 });
  assert.deepEqual(JSON.parse(readFileSync(path.join(f.output, 'input.json'), 'utf8')).effectiveOperationLimits,
    { executionMs: 25_000, killGraceMs: 1_000, closeMs: 2_000, admissionReserveMs: 28_000 });
  assert.deepEqual(summary.printWrite?.counts, { pilot: 10, warmup: 0, formal: 0 }); assert.equal(summary.printWrite?.mode, 'pilot');
  assert.equal(summary.printWrite?.claimMs.n, 10); assert.equal(summary.printWrite?.claimMs.max, 2100); assert.equal(summary.printWrite?.claimMs.passed, null);
  assert.equal(summary.printWrite?.completeMs.passed, null); assert.equal(summary.printWrite?.passed, null);
  assert.equal(f.hash(path.join(f.seed, 'seed.sqlite')), seedBefore);
  assert.equal(readFileSync(path.join(f.output, 'samples.jsonl'), 'utf8').trim().split('\n').length, 10);
  assert.equal(readdirSync(f.output).some(name => /^sample-\d{3}$/u.test(name)), false);
});

test('print-write formal：5预热不入正式分布，100个claim/complete max各自不超过2000ms', { timeout: 30_000 }, async t => {
  const f = await phaseFixture(t, 'print-write', 105); let calls = 0;
  const summary = await f.api.runCapacityPhase(f.args, { ...f.options, printWrite: async input => {
    ++calls; return f.printResult(input, calls <= 5 ? { claimMs: 5000, completeMs: 6000 } : { claimMs: 100, completeMs: 200 });
  } });
  assert.equal(calls, 105); assert.equal(summary.state, 'passed'); assert.equal(summary.planned, 105);
  assert.deepEqual(summary.printWrite?.counts, { pilot: 0, warmup: 5, formal: 100 }); assert.equal(summary.printWrite?.mode, 'formal');
  assert.deepEqual(summary.printWrite?.claimMs, { n: 100, p50: 100, p95: 100, p99: 100, max: 100, limitMax: 2000, passed: true });
  assert.deepEqual(summary.printWrite?.completeMs, { n: 100, p50: 200, p95: 200, p99: 200, max: 200, limitMax: 2000, passed: true });
  assert.equal(summary.printWrite?.passed, true);
});

test('print-write formal：剩余执行加kill grace加close预算再多1ms时允许启动，不额外硬编码2秒', { timeout: 30_000 }, async t => {
  const f = await phaseFixture(t, 'print-write', 105); let calls = 0;
  const minimum = 25_000 + f.api.CAPACITY_PHASE_LIMITS.killGraceMs + f.api.CAPACITY_PHASE_LIMITS.closeMs;
  assert.equal(minimum, 28_000);
  // formal窗口从fixture当前时刻尚余899000ms；推进后精确保留28001ms。
  f.advance(870999);
  const summary = await f.api.runCapacityPhase(f.args, { ...f.options, printWrite: async input => { ++calls; f.advance(2); return f.printResult(input); } });
  assert.equal(calls, 1); assert.equal(summary.attempted, 1); assert.equal(summary.state, 'incomplete'); assert.equal(summary.failure, 'CAPACITY_PHASE_DEADLINE');
  const raw = path.join(f.output, 'sample-001-raw-receipt.json');
  assert.deepEqual(JSON.parse(readFileSync(path.join(f.output, 'sample-001-raw-receipt.sha256.json'), 'utf8')), { sha256: f.hash(raw) });
  assert.equal(existsSync(path.join(f.output, 'sample-001-retention.json')), true); assert.equal(existsSync(path.join(f.output, 'sample-001.receipt.json')), true);
  assert.equal(existsSync(path.join(f.output, 'sample-002-intent.json')), false);
});

test('print-write formal：剩余时间恰好等于执行加kill grace加close预算时拒绝启动', async t => {
  const f = await phaseFixture(t, 'print-write', 105); let calls = 0;
  f.advance(871000); // 精确保留28000ms；边界必须fail closed。
  await assert.rejects(f.api.runCapacityPhase(f.args, { ...f.options, printWrite: async input => { ++calls; return f.printResult(input); } }), /CAPACITY_PHASE_DEADLINE/u);
  assert.equal(calls, 0); assert.equal(existsSync(f.output), false);
});

test('print-write phase：自然成功回执超过实际25秒执行包络仍首错停止并保留clone', async t => {
  const f = await phaseFixture(t, 'print-write', 10); let calls = 0;
  const summary = await f.api.runCapacityPhase(f.args, { ...f.options, printWrite: async input => {
    ++calls; const result = f.printResult(input); result.forkToCloseMs = 25_001; return result;
  } });
  assert.equal(calls, 1); assert.equal(summary.state, 'incomplete'); assert.equal(summary.attempted, 1); assert.equal(summary.unrun, 9);
  assert.equal(summary.failure, 'CAPACITY_PHASE_OPERATION_FAILED');
  assert.equal(existsSync(path.join(f.output, 'sample-001', 'sample.sqlite')), true);
  assert.equal(existsSync(path.join(f.output, 'sample-001-raw-receipt.json')), true);
  assert.equal(existsSync(path.join(f.output, 'sample-002-intent.json')), false);
});

test('print-write formal：业务全成功但任一正式max超2秒仍保留105分布并判FAIL', { timeout: 30_000 }, async t => {
  const f = await phaseFixture(t, 'print-write', 105); let calls = 0;
  const summary = await f.api.runCapacityPhase(f.args, { ...f.options, printWrite: async input => { ++calls; return f.printResult(input, calls === 6 ? { completeMs: 2001 } : {}); } });
  assert.equal(calls, 105); assert.equal(summary.state, 'failed'); assert.equal(summary.successes, 105);
  assert.equal(summary.printWrite?.completeMs.max, 2001); assert.equal(summary.printWrite?.completeMs.passed, false); assert.equal(summary.printWrite?.passed, false);
  assert.equal(summary.failure, 'CAPACITY_PHASE_THRESHOLD_FAILED');
});

for (const mode of ['failed', 'not-natural', 'pg-not-empty', 'identity-drift'] as const) test(`print-write phase：${mode}首错即停并保留当前clone`, async t => {
  const f = await phaseFixture(t, 'print-write', 10); let calls = 0;
  const summary = await f.api.runCapacityPhase(f.args, { ...f.options, printWrite: async input => {
    ++calls; const result = f.printResult(input);
    if (mode === 'failed') { result.outcome = 'failed'; result.failure = 'PRINT_WRITE_FAILED'; delete result.result; }
    if (mode === 'not-natural') result.cleanup.termSent = true;
    if (mode === 'pg-not-empty') result.processGroup!.groupEmpty = false;
    if (mode === 'identity-drift') f.put(path.join(f.windowRoot, 'source-pins.json'), { changed: true });
    return result;
  } });
  assert.equal(calls, 1); assert.equal(summary.attempted, 1); assert.equal(summary.unrun, 9); assert.equal(summary.state, 'incomplete');
  assert.equal(existsSync(path.join(f.output, 'sample-001', 'sample.sqlite')), true);
});

test('print-write phase：retention证据碰撞时必须在清理前首错停止并保留当前clone', async t => {
  const f = await phaseFixture(t, 'print-write', 10); let calls = 0;
  const collision = { collision: true };
  const summary = await f.api.runCapacityPhase(f.args, { ...f.options, printWrite: async input => {
    ++calls;
    f.put(path.join(f.output, 'sample-001-retention.json'), collision);
    return f.printResult(input);
  } });
  assert.equal(calls, 1); assert.equal(summary.attempted, 1); assert.equal(summary.unrun, 9); assert.equal(summary.state, 'incomplete');
  assert.equal(existsSync(path.join(f.output, 'sample-001', 'sample.sqlite')), true);
  assert.equal(summary.failure, 'CAPACITY_PHASE_PERSISTENCE_FAILED');
  const rawReceipt = path.join(f.output, 'sample-001-raw-receipt.json');
  assert.equal(existsSync(rawReceipt), true);
  assert.deepEqual(JSON.parse(readFileSync(path.join(f.output, 'sample-001-raw-receipt.sha256.json'), 'utf8')), { sha256: f.hash(rawReceipt) });
  assert.deepEqual(JSON.parse(readFileSync(path.join(f.output, 'sample-001-retention.json'), 'utf8')), collision);
  assert.equal(existsSync(path.join(f.output, 'sample-002-intent.json')), false);
});
