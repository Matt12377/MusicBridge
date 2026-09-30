import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { RecordingOutputSelection, RecordingPlanVersion } from '@music-bridge/contracts';
import { createRecordingAttemptCoordinator } from '../src/recording/attempt-coordinator.js';
import { createFormalDeviceAttemptProvider } from '../src/recording/formal-device-attempt-provider.js';
import { beginRecordingAttempt, type RecordingAttemptEvent } from '../src/recording/attempt-state.js';
import type { RecordingAttemptDriverRequest } from '../src/recording/attempt-coordinator.js';
import { acquireRecordingOutputInputLease } from '../src/recording/output-input.js';
import type { PinnedDeviceOutputHelper } from '../src/recording/bundled-device-output-helper.js';
import type { DeviceOutputHeader } from '../src/recording/device-output-protocol.js';
import { DeviceOutputRunError } from '../src/recording/device-output-runner.js';
import type { GateBAdmission, GateBLiveObservation } from '../src/recording/gate-b-admission.js';
import { recordingPlanFixture } from './helpers/recording-plan-fixture.js';

const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
async function fakePin(): Promise<PinnedDeviceOutputHelper> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'musicbridge-formal-provider-'));
  const helper = path.join(directory, 'helper'), manifest = path.join(directory, 'manifest.json');
  const helperBytes = Buffer.from('受控测试文件，不会执行HAL'), manifestBytes = Buffer.from('{}');
  await writeFile(helper, helperBytes); await chmod(helper, 0o755); await writeFile(manifest, manifestBytes);
  return { path: helper, sha256: digest(helperBytes), manifestPath: manifest, manifestSha256: digest(manifestBytes),
    sourceSha256: 'a'.repeat(64), drainAlgorithmId: 'hal-sample-zero-cover-v1' };
}
function admissionFixture(plan: RecordingPlanVersion, pin: PinnedDeviceOutputHelper, now: number) {
  const binding = plan.outputBinding!, format = plan.profileSnapshot.settings.format;
  const selection: RecordingOutputSelection = { endpointId: binding.endpointId, selectionGeneration: randomUUID() };
  const observed: GateBLiveObservation = { endpointId: binding.endpointId, uid: binding.deviceUid,
    sampleRate: format.sampleRate, channelCount: format.channelCount, format: format.outputSampleFormat,
    physicalFormat: format.outputSampleFormat, bufferFrames: binding.bufferFrames,
    backendId: binding.backendId, backendVersion: binding.backendVersion,
    configurationFingerprintSha256: binding.configurationFingerprintSha256,
    selectionGeneration: selection.selectionGeneration, alive: true, hasOutput: true };
  const admission: GateBAdmission = { recordSha256: 'b'.repeat(64), configurationFingerprintSha256: binding.configurationFingerprintSha256,
    endpointId: binding.endpointId, uid: binding.deviceUid, selectionGeneration: selection.selectionGeneration,
    validUntil: new Date(now + 60_000).toISOString(), helperSha256: pin.sha256,
    route: { endpointId: binding.endpointId, uid: binding.deviceUid, sampleRate: format.sampleRate,
      channelCount: format.channelCount, format: format.outputSampleFormat, physicalFormat: format.outputSampleFormat,
      bufferFrames: binding.bufferFrames }, drainAlgorithmId: pin.drainAlgorithmId,
    drain: { tailFrames: binding.bufferFrames, minimumZeroCallbacks: 2, capacityFrames: binding.bufferFrames * 2 } };
  return { selection, observed, admission };
}
function driverRequest(plan: RecordingPlanVersion, onEvent: (event: RecordingAttemptEvent) => void): RecordingAttemptDriverRequest {
  const receipt = plan.execution.audio[0]!, runId = randomUUID();
  return { attempt: beginRecordingAttempt({ id: randomUUID(), generation: runId,
    startedAt: new Date().toISOString(), plan }), side: receipt.recipe.side, runId,
    signal: new AbortController().signal, onEvent,
    input: { signal: new AbortController().signal, audio: receipt.audio, format: plan.profileSnapshot.settings.format,
      consumer: { descriptor: { dataOffset: receipt.audio.dataOffset, frameCount: receipt.audio.frameCount,
        channelCount: plan.profileSnapshot.settings.format.channelCount,
        sampleFormat: plan.profileSnapshot.settings.format.outputSampleFormat },
      async readFrames() { assert.fail('Fake runner 不得读取真实文件或HAL'); } },
      checkOperation() {} } };
}

test('无完整Gate B或当前设备绑定时拒绝Formal准入，不启动输出', async t => {
  const f = await recordingPlanFixture(t), plan = await f.plans.freeze(await f.planRequest());
  const pin = await fakePin(), now = Date.now(), facts = admissionFixture(plan, pin, now);
  let starts = 0, selected: RecordingOutputSelection | null = facts.selection;
  const provider = createFormalDeviceAttemptProvider({ pin, now: () => now,
    deviceSelection: { current: () => selected, async verify() { return facts.observed; } },
    gateB: { async verify() { return null; } },
    async run() { ++starts; assert.fail('未认证不得启动输出'); },
  });
  await assert.rejects(provider.authorize({ plan, side: plan.execution.audio[0]!.recipe.side,
    signal: new AbortController().signal }), { code: 'BACKEND_NOT_CERTIFIED' });
  selected = null;
  await assert.rejects(provider.authorize({ plan, side: plan.execution.audio[0]!.recipe.side,
    signal: new AbortController().signal }), { code: 'BACKEND_NOT_CERTIFIED' });
  assert.equal(starts, 0);
});

test('Formal启动先落精确租约并把fd交给Runner；Fake不执行HAL', async t => {
  const f = await recordingPlanFixture(t), plan = await f.plans.freeze(await f.planRequest());
  const pin = await fakePin(), now = Date.now(), facts = admissionFixture(plan, pin, now);
  const directory = await mkdtemp(path.join(os.tmpdir(), 'musicbridge-formal-lease-'));
  const databaseFile = path.join(directory, 'collection.v1.sqlite'), datasetId = randomUUID();
  await writeFile(databaseFile, Buffer.from('仅供租约身份测试的合成工作库'));
  const receipt = plan.execution.audio[0]!;
  let leasePath = '', starts = 0;
  const provider = createFormalDeviceAttemptProvider({ pin, leaseScope: { databaseFile, datasetId }, now: () => now,
    deviceSelection: { current: () => facts.selection, async verify() { return facts.observed; } },
    gateB: { async verify() { return facts.admission; } },
    async run(_pin, _input, options) {
      ++starts;
      assert.ok(options?.lease, '正式Runner必须收到已落盘的租约fd');
      assert.ok(Number.isSafeInteger(options.lease.fd) && options.lease.fd >= 0);
      leasePath = `${databaseFile}.output-run-${_input.header.runId}.lease`;
      const bytes = await readFile(leasePath);
      assert.equal(bytes.length, 288);
      assert.equal(bytes.toString('ascii', 0, 4), 'MBRL');
      assert.equal(bytes[6], 1);
      assert.equal(bytes.subarray(8, 24).toString('hex'), _input.header.runId.replaceAll('-', ''));
      assert.equal(bytes.subarray(80, 96).toString('hex'), datasetId.replaceAll('-', ''));
      assert.equal(bytes.subarray(112, 144).toString('hex'), plan.contentHash);
      assert.equal(bytes.subarray(144, 176).toString('hex'), receipt.audio.sha256);
      assert.equal(bytes.subarray(176, 208).toString('hex'), receipt.audio.pcmSha256);
      assert.equal(bytes.subarray(240, 272).toString('hex'), facts.admission.recordSha256);
      await options.lease.close();
      return { async stop() {}, async close() {} };
    },
  });
  await provider.authorize({ plan, side: receipt.recipe.side, signal: new AbortController().signal });
  const request = driverRequest(plan, () => {});
  const handle = await provider.start(request);
  await handle.close();
  assert.equal(starts, 1);
  assert.equal(leasePath, `${databaseFile}.output-run-${request.runId}.lease`);
});

test('租约创建失败只发布软件cutoff/quiescent，绝不启动Runner或补原生ACK', async t => {
  const f = await recordingPlanFixture(t), plan = await f.plans.freeze(await f.planRequest());
  const pin = await fakePin(), now = Date.now(), facts = admissionFixture(plan, pin, now);
  const directory = await mkdtemp(path.join(os.tmpdir(), 'musicbridge-formal-lease-missing-'));
  const databaseFile = path.join(directory, 'missing.sqlite');
  const events: RecordingAttemptEvent[] = [];
  const provider = createFormalDeviceAttemptProvider({ pin,
    leaseScope: { databaseFile, datasetId: randomUUID() }, now: () => now,
    deviceSelection: { current: () => facts.selection, async verify() { return facts.observed; } },
    gateB: { async verify() { return facts.admission; } },
    async run() { assert.fail('租约未建立不得进入Runner'); },
  });
  await provider.authorize({ plan, side: plan.execution.audio[0]!.recipe.side, signal: new AbortController().signal });
  await assert.rejects(provider.start(driverRequest(plan, event => events.push(event))), { code: 'BACKEND_NOT_CERTIFIED' });
  assert.deepEqual(events.map(event => event.type), ['engine-cutoff', 'cleanup-quiescent']);
});

test('首次start身份或输入receipt失配仍收口精确run，重放旧授权不补事件', async t => {
  const f = await recordingPlanFixture(t), plan = await f.plans.freeze(await f.planRequest());
  const pin = await fakePin(), facts = admissionFixture(plan, pin, Date.now());
  let starts = 0;
  const provider = createFormalDeviceAttemptProvider({ pin,
    deviceSelection: { current: () => facts.selection, async verify() { return facts.observed; } },
    gateB: { async verify() { return facts.admission; } },
    async run() { ++starts; assert.fail('身份或receipt不匹配不能委托Runner'); },
  });
  for (const mode of ['identity', 'receipt'] as const) {
    await provider.authorize({ plan, side: plan.execution.audio[0]!.recipe.side, signal: new AbortController().signal });
    const events: RecordingAttemptEvent[] = [], request = driverRequest(plan, event => events.push(event));
    const changed = mode === 'identity'
      ? { ...request, attempt: { ...request.attempt, planVersionId: randomUUID() } }
      : { ...request, input: { ...request.input, audio: { ...request.input.audio, pcmSha256: 'd'.repeat(64) } } };
    await assert.rejects(provider.start(changed), { code: mode === 'identity' ? 'BACKEND_NOT_CERTIFIED' : 'PLAN_CHANGED' });
    assert.deepEqual(events.map(event => event.type), ['engine-cutoff', 'cleanup-quiescent']);
    assert.ok(events.every(event => 'runId' in event && event.runId === request.runId));
    const replayEvents: RecordingAttemptEvent[] = [];
    await assert.rejects(provider.start({ ...request, onEvent: event => replayEvents.push(event) }), { code: 'BACKEND_NOT_CERTIFIED' });
    assert.deepEqual(replayEvents, []);
  }
  assert.equal(starts, 0);
});

test('每Side授权只用一次；等待后记录、设备代际或期限变化均阻断旧启动', async t => {
  const f = await recordingPlanFixture(t), plan = await f.plans.freeze(await f.planRequest());
  const pin = await fakePin(); let now = Date.now(); const facts = admissionFixture(plan, pin, now);
  let current: RecordingOutputSelection | null = facts.selection, currentAdmission = facts.admission, starts = 0;
  const provider = createFormalDeviceAttemptProvider({ pin, now: () => now,
    deviceSelection: { current: () => current, async verify() { return facts.observed; } },
    gateB: { async verify() { return currentAdmission; } },
    async run() { ++starts; assert.fail('旧准入不得启动输出'); },
  });
  const side = plan.execution.audio[0]!.recipe.side, signal = new AbortController().signal;
  await provider.authorize({ plan, side, signal });
  currentAdmission = { ...facts.admission, recordSha256: 'c'.repeat(64) };
  const staleEvents: RecordingAttemptEvent[] = [];
  await assert.rejects(provider.start(driverRequest(plan, event => staleEvents.push(event))), { code: 'BACKEND_NOT_CERTIFIED' });
  assert.deepEqual(staleEvents.map(event => event.type), ['engine-cutoff', 'cleanup-quiescent']);
  currentAdmission = facts.admission;
  const replayEvents: RecordingAttemptEvent[] = [];
  await assert.rejects(provider.start(driverRequest(plan, event => replayEvents.push(event))), { code: 'BACKEND_NOT_CERTIFIED' }, '授权不得再次消费');
  assert.deepEqual(replayEvents, [], '重复消费旧授权不能对新的请求身份补造收口事实');
  await provider.authorize({ plan, side, signal });
  current = { ...facts.selection, selectionGeneration: randomUUID() };
  const changedEvents: RecordingAttemptEvent[] = [];
  await assert.rejects(provider.start(driverRequest(plan, event => changedEvents.push(event))), { code: 'BACKEND_NOT_CERTIFIED' });
  assert.deepEqual(changedEvents.map(event => event.type), ['engine-cutoff', 'cleanup-quiescent']);
  current = facts.selection;
  await provider.authorize({ plan, side, signal });
  now = Date.parse(facts.admission.validUntil);
  const expiredEvents: RecordingAttemptEvent[] = [];
  await assert.rejects(provider.start(driverRequest(plan, event => expiredEvents.push(event))), { code: 'BACKEND_NOT_CERTIFIED' });
  assert.deepEqual(expiredEvents.map(event => event.type), ['engine-cutoff', 'cleanup-quiescent']);
  assert.equal(starts, 0);
});

for (const mode of ['expired', 'selection-generation', 'second-verify'] as const) {
  test(`Formal持久Attempt首帧前${mode}拒绝仍留下可核实的软件静止事实`, async t => {
    const f = await recordingPlanFixture(t), plan = await f.plans.freeze(await f.planRequest());
    const pin = await fakePin(), facts = admissionFixture(plan, pin, Date.now());
    let now = Date.now(), selected: RecordingOutputSelection = facts.selection, verifications = 0, starts = 0;
    const provider = createFormalDeviceAttemptProvider({ pin, now: () => now,
      deviceSelection: { current: () => selected, async verify() { return facts.observed; } },
      gateB: { async verify() { ++verifications; return mode === 'second-verify' && verifications === 2 ? null : facts.admission; } },
      async run() { ++starts; assert.fail('首帧前拒绝不能委托Runner或HAL'); },
    });
    const coordinator = createRecordingAttemptCoordinator({ store: f.repository.recordingAttempts,
      admissionProvider: provider,
      async acquireInputLease(input, signal, check) {
        const lease = await acquireRecordingOutputInputLease(input, signal, check);
        if (mode === 'expired') now = Date.parse(facts.admission.validUntil);
        if (mode === 'selection-generation') selected = { ...facts.selection, selectionGeneration: randomUUID() };
        return lease;
      },
    });
    f.registerDependentCleanup(() => coordinator.close());
    const failed = await coordinator.begin({ commandId: randomUUID(), planVersionId: plan.id,
      planContentHash: plan.contentHash, userConfirmed: true });
    assert.equal(failed.status, 'failed');
    const attempt = coordinator.list({ page: { offset: 0, limit: 1 } }).items[0]!;
    assert.equal(starts, 0);
    assert.deepEqual(failed, attempt);
    assert.equal(attempt.status, 'failed');
    assert.equal(attempt.reason, 'backend-start-failed');
    assert.deepEqual(attempt.sides.map(side => ({ cutoff: side.engineStoppedSubmitting,
      quiescent: side.cleanupQuiescent, ack: side.stopAcknowledged, eof: side.sourceEof, drained: side.backendDrained })),
    [{ cutoff: true, quiescent: true, ack: false, eof: false, drained: false },
      ...attempt.sides.slice(1).map(() => ({ cutoff: false, quiescent: false, ack: false, eof: false, drained: false }))]);
    const confirmed = await coordinator.confirm({ commandId: randomUUID(), attemptId: attempt.id,
      expectedRevision: attempt.revision, kind: 'physical-stop', side: attempt.sides[0]!.side, userConfirmed: true });
    assert.ok(confirmed.sides[0]!.physicalStopConfirmedAt, '实体停止仍须由Owner另行核实，软件静止事实不能代替');
  });
}

test('受控Runner完成回报映射为真实Side事实，候选drain不提前发布完成', async t => {
  const f = await recordingPlanFixture(t), plan = await f.plans.freeze(await f.planRequest());
  const pin = await fakePin(), now = Date.now(), facts = admissionFixture(plan, pin, now);
  const events: RecordingAttemptEvent[] = []; let header: DeviceOutputHeader | undefined, launches = 0;
  let finish!: () => void;
  const completed = new Promise<void>(resolve => { finish = resolve; });
  const provider = createFormalDeviceAttemptProvider({ pin, now: () => now,
    deviceSelection: { current: () => facts.selection, async verify() { return facts.observed; } },
    gateB: { async verify() { return facts.admission; } },
    async run(_pin, input) {
      launches += 1; header = input.header;
      input.callbacks.onProgress({ suppliedFrames: 4, consumedFrames: 2, zeroFilledFrames: 0 });
      input.callbacks.onProgress({ suppliedFrames: input.header.frameCount, consumedFrames: input.header.frameCount, zeroFilledFrames: 0 });
      input.callbacks.onSourceEof(); input.callbacks.onDrainObserved();
      assert.deepEqual(events.map(event => event.type), ['progress', 'progress', 'source-eof']);
      input.callbacks.onCleanup({ engineCutoff: true, stopAcknowledged: true, cleanupQuiescent: true,
        terminal: { kind: 'completed', suppliedFrames: input.header.frameCount, consumedFrames: input.header.frameCount } });
      input.callbacks.onComplete();
      return { async stop() {}, async close() {} };
    },
  });
  const side = plan.execution.audio[0]!.recipe.side;
  await provider.authorize({ plan, side, signal: new AbortController().signal });
  const request = driverRequest(plan, event => { events.push(event); if (event.type === 'backend-drained') finish(); });
  const handle = await provider.start(request);
  await completed; await handle.close();
  assert.equal(launches, 1);
  assert.equal(header?.scope, 'formal-recording');
  assert.equal(header?.recordSha256, facts.admission.recordSha256);
  assert.equal(header?.uid, facts.admission.uid);
  assert.equal(header?.runId, request.runId);
  assert.deepEqual(events.map(event => event.type),
    ['progress', 'progress', 'source-eof', 'engine-cutoff', 'stop-ack', 'cleanup-quiescent', 'backend-drained']);
  assert.ok(events.every(event => 'runId' in event && event.runId === request.runId));
});

test('120分钟10Hz受控帧流仅约1Hz持久事件，EOF/排空冲刷终帧且不补造进度', async t => {
  const f = await recordingPlanFixture(t), plan = await f.plans.freeze(await f.planRequest());
  const pin = await fakePin(), now = Date.now(), facts = admissionFixture(plan, pin, now);
  let progressAt = 0, finish!: () => void;
  const completed = new Promise<void>(resolve => { finish = resolve; });
  const events: RecordingAttemptEvent[] = [];
  const provider = createFormalDeviceAttemptProvider({ pin, now: () => now, progressNow: () => progressAt,
    deviceSelection: { current: () => facts.selection, async verify() { return facts.observed; } },
    gateB: { async verify() { return facts.admission; } },
    async run(_pin, input) {
      for (let index = 1; index <= 72_000; index++) {
        progressAt = index * 100;
        const frame = Math.floor(input.header.frameCount * index / 72_000);
        input.callbacks.onProgress({ suppliedFrames: frame, consumedFrames: frame, zeroFilledFrames: 0 });
      }
      input.callbacks.onSourceEof(); input.callbacks.onDrainObserved();
      input.callbacks.onCleanup({ engineCutoff: true, stopAcknowledged: true, cleanupQuiescent: true,
        terminal: { kind: 'completed', suppliedFrames: input.header.frameCount, consumedFrames: input.header.frameCount } });
      input.callbacks.onComplete();
      return { async stop() {}, async close() {} };
    },
  });
  const side = plan.execution.audio[0]!.recipe.side;
  await provider.authorize({ plan, side, signal: new AbortController().signal });
  const request = driverRequest(plan, event => { events.push(event); if (event.type === 'backend-drained') finish(); });
  const handle = await provider.start(request);
  await completed; await handle.close();
  const progress = events.filter((event): event is Extract<RecordingAttemptEvent, { type: 'progress' }> => event.type === 'progress');
  assert.ok(progress.length <= 7_202, `120分钟只允许有界真实进度，实际 ${progress.length}`);
  assert.ok(progress.length >= 7_000, '不能把长节目进度完全吞掉');
  assert.ok(progress.every((event, index) => index === 0 || event.consumedFrames >= progress[index - 1]!.consumedFrames));
  assert.equal(progress.at(-1)?.consumedFrames, request.input.audio.frameCount);
  assert.deepEqual(events.slice(-5).map(event => event.type),
    ['source-eof', 'engine-cutoff', 'stop-ack', 'cleanup-quiescent', 'backend-drained']);
});

test('helper关闭后的Gate B复核失效不能发完成；用户停止先派发，进度接收抛错也不挡stop', async t => {
  const f = await recordingPlanFixture(t), plan = await f.plans.freeze(await f.planRequest());
  const pin = await fakePin(), now = Date.now(), facts = admissionFixture(plan, pin, now);
  let calls = 0, finish!: () => void, stopped = 0;
  const settled = new Promise<void>(resolve => { finish = resolve; });
  const events: RecordingAttemptEvent[] = [];
  const provider = createFormalDeviceAttemptProvider({ pin, now: () => now,
    deviceSelection: { current: () => facts.selection, async verify() { return facts.observed; } },
    gateB: { async verify() { return ++calls === 3 ? null : facts.admission; } },
    async run(_pin, input) {
      input.callbacks.onProgress({ suppliedFrames: input.header.frameCount, consumedFrames: input.header.frameCount, zeroFilledFrames: 0 });
      input.callbacks.onSourceEof(); input.callbacks.onDrainObserved();
      input.callbacks.onCleanup({ engineCutoff: true, stopAcknowledged: true, cleanupQuiescent: true,
        terminal: { kind: 'completed', suppliedFrames: input.header.frameCount, consumedFrames: input.header.frameCount } });
      input.callbacks.onComplete();
      return { async stop() { ++stopped; }, async close() {} };
    },
  });
  const side = plan.execution.audio[0]!.recipe.side;
  await provider.authorize({ plan, side, signal: new AbortController().signal });
  const request = driverRequest(plan, event => { events.push(event); if (event.type === 'interrupt') finish(); });
  const handle = await provider.start(request);
  await settled;
  assert.equal(calls, 3);
  assert.equal(events.some(event => event.type === 'backend-drained'), false);
  assert.equal(events.at(-1)?.type, 'interrupt');
  await handle.stop(); assert.equal(stopped, 1);
  await handle.close();

  // 第二个受控Provider只验证Stop的无进度事务路径；领域进度写入抛错不应被Stop前置等待。
  let progress!: (value: { suppliedFrames: number; consumedFrames: number; zeroFilledFrames: number }) => void;
  const stopProvider = createFormalDeviceAttemptProvider({ pin, now: () => now,
    deviceSelection: { current: () => facts.selection, async verify() { return facts.observed; } },
    gateB: { async verify() { return facts.admission; } },
    async run(_pin, input) { progress = input.callbacks.onProgress;
      return { async stop() { ++stopped; }, async close() {} }; },
  });
  await stopProvider.authorize({ plan, side, signal: new AbortController().signal });
  const stopRequest = driverRequest(plan, () => { throw new Error('模拟进度持久化失败'); });
  const stopHandle = await stopProvider.start(stopRequest);
  assert.throws(() => progress({ suppliedFrames: 1, consumedFrames: 1, zeroFilledFrames: 0 }), /模拟进度持久化失败/);
  await stopHandle.stop();
  assert.equal(stopped, 2);
});

for (const nativeStopAcknowledged of [false, true]) {
  test(`失败输出收口独立发布cutoff/quiescent，原生Stop ACK=${nativeStopAcknowledged}不推断EOF/drain`, async t => {
    const f = await recordingPlanFixture(t), plan = await f.plans.freeze(await f.planRequest());
    const pin = await fakePin(), now = Date.now(), facts = admissionFixture(plan, pin, now);
    const events: RecordingAttemptEvent[] = [];
    const provider = createFormalDeviceAttemptProvider({ pin, now: () => now,
      deviceSelection: { current: () => facts.selection, async verify() { return facts.observed; } },
      gateB: { async verify() { return facts.admission; } },
      async run(_pin, input) {
        input.callbacks.onCleanup({ engineCutoff: true, stopAcknowledged: nativeStopAcknowledged, cleanupQuiescent: true,
          terminal: { kind: nativeStopAcknowledged ? 'cancelled' : 'failed', suppliedFrames: 0, consumedFrames: 0 } });
        input.callbacks.onFailure(new DeviceOutputRunError('BACKEND_FAILURE'));
        return { async stop() {}, async close() {} };
      },
    });
    const side = plan.execution.audio[0]!.recipe.side;
    await provider.authorize({ plan, side, signal: new AbortController().signal });
    const handle = await provider.start(driverRequest(plan, event => events.push(event)));
    await handle.close();
    assert.deepEqual(events.map(event => event.type), nativeStopAcknowledged
      ? ['engine-cutoff', 'stop-ack', 'cleanup-quiescent', 'interrupt']
      : ['engine-cutoff', 'cleanup-quiescent', 'interrupt']);
    assert.equal(events.some(event => event.type === 'source-eof' || event.type === 'backend-drained'), false);
  });
}
