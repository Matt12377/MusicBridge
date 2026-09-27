import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import * as dto from '@music-bridge/contracts';
import { createRecordingReplicaCoordinator, type RecordingReplicaProvider, type RecordingReplicaDriverRequest } from '../src/recording/replica-coordinator.js';
import type { ReplicaInput, ReplicaVerifiedInput } from '../src/recording/replica-input.js';
import { RecordingReplicaError } from '../src/recording/replica-error.js';
import { createRecordingAttemptCoordinator } from '../src/recording/attempt-coordinator.js';
import { recordingAttemptFixture } from './helpers/recording-attempt-fixture.js';
import { createReadonlyAudioConsumer } from '../src/recording/readonly-audio-consumer.js';
import { createReplicaDeviceOutputProvider } from '../src/recording/replica-device-output-provider.js';
import { createReplicaDeviceSessionCoordinator } from '../src/recording/replica-device-session.js';
import { DeviceOutputRunError, type DeviceOutputRunCallbacks } from '../src/recording/device-output-runner.js';

function deferred<T>() { let resolve!: (value: T) => void, reject!: (reason: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
async function until(check: () => boolean) {
  // 并发CI中I/O回调与setImmediate轮数无稳定比例，按单调时钟给出真正的有界等待。
  const deadline = performance.now() + 2_000;
  while (!check()) {
    if (performance.now() > deadline) assert.fail('有界等待未达到预期状态');
    await new Promise(resolve => setTimeout(resolve, 1));
  }
}
type Session = Extract<dto.RecordingReplicaRun, { kind: 'session' }>;
function session(service: ReturnType<typeof createRecordingReplicaCoordinator>, runId: string): Session {
  const value = service.get({ runId }).run; assert.ok(value && value.kind === 'session'); assert.equal(dto.isRecordingReplicaRun(value), true); return value;
}
async function fixture(t: test.TestContext, options: { beforeInput?: () => Promise<void>; afterInput?: () => Promise<void>; beforeClose?: () => Promise<void>; releaseUnverified?: boolean } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'musicbridge-replica-session-'));
  const pcm = Buffer.alloc(64, 3), bytes = Buffer.alloc(108); bytes.write('RIFF'); bytes.writeUInt32LE(100, 4); bytes.write('WAVEfmt ', 8); bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(2, 22); bytes.writeUInt32LE(48000, 24); bytes.writeUInt32LE(192000, 28); bytes.writeUInt16LE(4, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(64, 40); pcm.copy(bytes, 44);
  const file = path.join(directory, 'synthetic.wav'); await writeFile(file, bytes);
  t.after(() => rm(directory, { recursive: true, force: true }));
  const audio: dto.ReplicaAudioIdentity = { target: 'actual-execution', executionAssetId: randomUUID(), recipeHash: 'b'.repeat(64), pcmHashEvidence: 'frozen-execution', fileSha256: createHash('sha256').update(bytes).digest('hex'), pcmSha256: createHash('sha256').update(pcm).digest('hex'), size: bytes.length, frameCount: 16, format: { container: 'wav', sampleRate: 48000, channelCount: 2, sampleFormat: 'pcm-s16le' } };
  const inspection: dto.RecordingReplicaInspection = { readId: randomUUID(), recordingId: randomUUID(), recordingContentHash: 'a'.repeat(64), planVersionId: randomUUID(), planContentHash: 'b'.repeat(64), archiveOperationId: randomUUID(), archiveManifestHash: 'c'.repeat(64), checkedAt: new Date().toISOString(), fingerprint: 'd'.repeat(64), targets: [{ target: 'actual-execution', side: 'A', state: 'verified', audio }, { target: 'actual-execution', side: 'B', state: 'empty', frameCount: 0 }], playback: 'blocked', deviceOpened: false, formalReady: false, gateB: 'NOT_RUN' };
  assert.equal(dto.isRecordingReplicaInspection(inspection), true);
  let opened = 0, closed = 0, inspectCount = 0;
  const internalAbort = new AbortController();
  // 仅替代已核验输入边界；使用真实只读FD检验会话所有权，字节解析/恢复由input套件独立覆盖。
  const input: ReplicaInput = {
    async inspect(request, signal, check) { ++inspectCount; await options.beforeInput?.(); check(); signal.throwIfAborted(); return { ...inspection, ...request }; },
    async withInput(request, signal, check, consume, onLeaseEvent) {
      await options.beforeInput?.(); check(); signal.throwIfAborted();
      if (request.expectedFingerprint !== inspection.fingerprint) throw new RecordingReplicaError('IDENTITY_MISMATCH');
      const handle = await open(file, 'r'); ++opened; onLeaseEvent?.('acquired');
      const linked = AbortSignal.any([signal, internalAbort.signal]);
      const current = () => { check(); linked.throwIfAborted(); };
      const consumer = createReadonlyAudioConsumer(handle, { dataOffset: 44, frameCount: audio.frameCount, channelCount: audio.format.channelCount, sampleFormat: audio.format.sampleFormat }, linked, current);
      try { const result = await consume({ handle, audio, dataOffset: 44, consumer, inspection, signal: linked, checkOperation: current }); await options.afterInput?.(); current(); return result; }
      finally {
        consumer.revoke(); await options.beforeClose?.(); await handle.close(); ++closed;
        onLeaseEvent?.(options.releaseUnverified ? 'release-unverified' : 'released');
        if (options.releaseUnverified) throw new Error('合成关闭结果未证实');
      }
    },
  };
  const calls: RecordingReplicaDriverRequest[] = [], completion = deferred<dto.ReplicaProgress & { pcmSha256: string }>(), quiescent = deferred<void>();
  let stops = 0, closes = 0;
  const provider: RecordingReplicaProvider = { evidence: 'synthetic-only', async start(request) { calls.push(request); return { completion: completion.promise, async stop() { ++stops; }, async close() { ++closes; await quiescent.promise; } }; } };
  const request = (): dto.StartRecordingReplicaRequest => ({ runId: randomUUID(), recordingId: inspection.recordingId, target: 'actual-execution', side: 'A', expectedFingerprint: inspection.fingerprint, userConfirmed: true });
  const success = { sourceFramesRead: 16, submittedFrames: 16, consumedFrames: 16, sourceEof: true, backendDrained: true, pcmSha256: audio.pcmSha256 };
  return { input, provider, request, inspection, audio, calls, completion, quiescent, internalAbort, success, counts: () => ({ opened, closed, inspectCount, stops, closes }) };
}

test('生产没有provider时拒绝启动且零会话、零输入读取，不把合成核验冒充播放', async () => {
  const module = await import('../src/recording/replica-coordinator.js').catch(() => ({}));
  assert.ok('createRecordingReplicaCoordinator' in module, '缺少历史Replica会话协调器');
  let reads = 0;
  const input = { async inspect() { ++reads; throw new Error('不应读取'); }, async withInput() { ++reads; throw new Error('不应打开音频'); } };
  const service = (module as typeof import('../src/recording/replica-coordinator.js')).createRecordingReplicaCoordinator({ input });
  const request = { runId: randomUUID(), recordingId: randomUUID(), target: 'actual-execution' as const, side: 'A' as const, expectedFingerprint: 'a'.repeat(64), userConfirmed: true as const };
  try {
    assert.equal(service.status().playback, 'blocked');
    assert.throws(() => service.start(request), { code: 'BACKEND_UNAVAILABLE' });
    assert.deepEqual(service.get({ runId: request.runId }), { run: null });
    assert.equal(reads, 0);
  } finally { await service.close(); }
});

test('start立即返回starting；同请求不重启、异体和并发拒绝，完整close末验后才finished', async t => {
  const after = deferred<void>(), f = await fixture(t, { afterInput: () => after.promise });
  const service = createRecordingReplicaCoordinator({ input: f.input, provider: f.provider });
  t.after(() => service.close());
  const request = f.request(), initial = service.start(request);
  assert.equal(initial.state, 'starting'); assert.equal(f.calls.length, 0); assert.deepEqual(service.start(request), initial);
  assert.throws(() => service.start({ ...request, side: 'B' }), { code: 'RUN_CONFLICT' });
  assert.throws(() => service.start(f.request()), { code: 'RUN_CONFLICT' });
  await until(() => f.calls.length === 1); f.completion.resolve(f.success);
  await until(() => f.counts().closes === 1); assert.equal(session(service, request.runId).state, 'draining'); assert.equal(f.counts().closed, 0);
  f.quiescent.resolve(); await tick(); assert.notEqual(session(service, request.runId).state, 'finished');
  after.resolve(); await until(() => session(service, request.runId).state === 'finished');
  assert.deepEqual(f.counts(), { opened: 1, closed: 1, inspectCount: 0, stops: 0, closes: 1 });
  const result = session(service, request.runId); assert.equal(result.evidence, 'synthetic-only'); assert.equal(result.deviceOpened, false); assert.equal(result.cleanupQuiescent, true);
  assert.deepEqual(service.start(request), result); assert.deepEqual(service.stop({ runId: request.runId }), result);
});

test('取消先到只留tombstone，固定ID上限不驱逐后复活，默认无provider也不创建假会话', async t => {
  const f = await fixture(t), service = createRecordingReplicaCoordinator({ input: f.input, provider: f.provider, maxRunIds: 1 });
  t.after(() => service.close()); const request = f.request();
  const cancelled = service.stop({ runId: request.runId }); assert.equal(cancelled.kind, 'cancelled-before-start');
  assert.deepEqual(service.start(request), cancelled); assert.throws(() => service.start(f.request()), { code: 'RUN_LIMIT' });
  assert.deepEqual(service.start(request), cancelled); assert.equal(f.calls.length, 0); assert.equal(f.counts().opened, 0);
});

test('stop ACK不是静止，首个取消原因不被迟到成功覆盖，FD保持到真正close', async t => {
  const f = await fixture(t), service = createRecordingReplicaCoordinator({ input: f.input, provider: f.provider }); t.after(() => service.close());
  const request = f.request(); service.start(request); await until(() => f.calls.length === 1);
  const stopped = service.stop({ runId: request.runId }); assert.equal(stopped.state, 'stopping'); assert.equal(stopped.cleanupQuiescent, false);
  await until(() => f.counts().closes === 1); assert.equal(f.counts().closed, 0); assert.throws(() => service.start(f.request()), { code: 'RUN_CONFLICT' });
  f.completion.resolve(f.success); await tick(); assert.equal(session(service, request.runId).reason, 'CANCELLED');
  f.quiescent.resolve(); await until(() => session(service, request.runId).state === 'cancelled');
  assert.equal(session(service, request.runId).cleanupQuiescent, true); assert.equal(f.counts().closed, 1);
});

test('关闭期间迟到start句柄必须停止并等待close，超时不能释放输入或伪终态', async t => {
  const f = await fixture(t, { beforeClose: () => new Promise(resolve => setTimeout(resolve, 10)) }), late = deferred<Awaited<ReturnType<RecordingReplicaProvider['start']>>>();
  let started = 0, stopped = 0, closed = 0;
  const provider: RecordingReplicaProvider = { evidence: 'synthetic-only', async start() { ++started; return late.promise; } };
  const service = createRecordingReplicaCoordinator({ input: f.input, provider, closeTimeoutMs: 5 });
  const request = f.request(); service.start(request); await until(() => started === 1);
  await assert.rejects(service.close(), { code: 'TIMEOUT' }); assert.equal(f.counts().closed, 0);
  late.resolve({ completion: f.completion.promise, async stop() { ++stopped; }, async close() { ++closed; await f.quiescent.promise; } });
  await until(() => closed === 1); assert.equal(stopped, 1); assert.equal(f.counts().closed, 0);
  f.quiescent.resolve(); await until(() => f.counts().closed === 1);
  assert.throws(() => service.get({ runId: request.runId }), { code: 'CLOSED' });
});

test('输入内部撤权signal直达provider，scope检查失败不允许迟到成功', async t => {
  const f = await fixture(t); let current = true;
  const service = createRecordingReplicaCoordinator({ input: f.input, provider: f.provider, assertCurrent() { if (!current) throw new Error('合成旧scope'); } });
  const request = f.request(); service.start(request); await until(() => f.calls.length === 1);
  f.internalAbort.abort(new RecordingReplicaError('AUTHORIZATION_REVOKED')); await until(() => f.counts().closes === 1);
  assert.equal(f.calls[0]!.input.signal.aborted, true); assert.equal(session(service, request.runId).reason, 'AUTHORIZATION_REVOKED');
  f.quiescent.resolve(); await until(() => session(service, request.runId).state === 'failed');
  current = false; assert.throws(() => service.start(f.request()), { code: 'SCOPE_CHANGED' }); current = true; await service.close();
});

test('同run精确帧与单调进度核验，错代际忽略，超帧或错误PCM hash不能finished', async t => {
  const f = await fixture(t), service = createRecordingReplicaCoordinator({ input: f.input, provider: f.provider }); t.after(() => service.close());
  const request = f.request(); service.start(request); await until(() => f.calls.length === 1);
  const driver = f.calls[0]!;
  driver.onProgress({ runId: randomUUID(), target: request.target, side: request.side, progress: { sourceFramesRead: 99, submittedFrames: 99, consumedFrames: 99, sourceEof: true, backendDrained: true } });
  assert.equal(session(service, request.runId).state, 'consuming');
  driver.onProgress({ runId: request.runId, target: request.target, side: request.side, progress: { sourceFramesRead: 17, submittedFrames: 17, consumedFrames: 17, sourceEof: true, backendDrained: true } });
  await until(() => f.counts().closes === 1); f.quiescent.resolve(); await until(() => session(service, request.runId).state === 'failed');
  assert.equal(session(service, request.runId).reason, 'FRAME_MISMATCH');
});

test('inspect共享相同readId结果，取消先到和读ID预算不驱逐；关闭等待真实读取结束', async t => {
  const gate = deferred<void>(), f = await fixture(t, { beforeInput: () => gate.promise });
  const service = createRecordingReplicaCoordinator({ input: f.input, maxReadIds: 2, closeTimeoutMs: 5 });
  const request = { readId: randomUUID(), recordingId: f.inspection.recordingId };
  const pending = service.inspect(request); const second = service.inspect(request);
  await assert.rejects(service.inspect({ ...request, recordingId: randomUUID() }), { code: 'READ_CONFLICT' });
  const cancelled = randomUUID(); service.cancelRead({ readId: cancelled });
  await assert.rejects(service.inspect({ ...request, readId: cancelled }), { code: 'CANCELLED' });
  await assert.rejects(service.inspect({ ...request, readId: randomUUID() }), { code: 'READ_LIMIT' });
  await assert.rejects(service.close(), { code: 'TIMEOUT' }); gate.resolve();
  await assert.rejects(pending, { code: 'CLOSED' }); await assert.rejects(second, { code: 'CLOSED' }); assert.equal(f.counts().inspectCount, 1);
});

test('已完成的inspect保留ID回执但释放并发名额，第三次显式新核验正常执行', async t => {
  const f = await fixture(t), service = createRecordingReplicaCoordinator({ input: f.input }); t.after(() => service.close());
  for (let i = 0; i < 3; ++i) {
    const request = { readId: randomUUID(), recordingId: f.inspection.recordingId };
    const first = await service.inspect(request); assert.deepEqual(await service.inspect(request), first);
  }
  assert.equal(f.counts().inspectCount, 3);
});

test('关闭拒绝或停止应答失败不能提前释放FD；显式重试关闭后才进入首因终态', async t => {
  const f = await fixture(t); let closes = 0;
  const provider: RecordingReplicaProvider = { evidence: 'synthetic-only', async start() { return { completion: f.completion.promise, async stop() { throw new Error('合成停止应答丢失'); }, async close() { if (++closes === 1) throw new Error('合成静止未知'); } }; } };
  const service = createRecordingReplicaCoordinator({ input: f.input, provider }); t.after(() => service.close());
  const request = f.request(); service.start(request); await until(() => session(service, request.runId).started);
  service.stop({ runId: request.runId }); await until(() => closes === 1); await tick();
  assert.equal(f.counts().closed, 0); assert.equal(session(service, request.runId).reason, 'CANCELLED'); assert.equal(session(service, request.runId).state, 'stopping');
  service.stop({ runId: request.runId }); await until(() => session(service, request.runId).state === 'cancelled');
  assert.equal(closes, 2); assert.equal(f.counts().closed, 1);
});

test('消费超时保持TIMEOUT首因，迟到完成或后来用户stop不能改成成功/取消', async t => {
  const f = await fixture(t), service = createRecordingReplicaCoordinator({ input: f.input, provider: f.provider, operationTimeoutMs: 10 }); t.after(() => service.close());
  const request = f.request(); service.start(request); await until(() => f.calls.length === 1);
  await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(session(service, request.runId).reason, 'TIMEOUT');
  service.stop({ runId: request.runId }); f.completion.resolve(f.success); f.quiescent.resolve();
  await until(() => session(service, request.runId).state === 'failed'); assert.equal(session(service, request.runId).reason, 'TIMEOUT');
});

test('完整帧计数不足以证明成功：错误PCM hash与末验变化分别失败', async t => {
  for (const changed of [false, true]) {
    const f = await fixture(t, { afterInput: async () => { if (changed) throw new RecordingReplicaError('INPUT_CHANGED'); } });
    const service = createRecordingReplicaCoordinator({ input: f.input, provider: f.provider });
    const request = f.request(); service.start(request); await until(() => f.calls.length === 1);
    f.completion.resolve({ ...f.success, pcmSha256: changed ? f.audio.pcmSha256 : 'f'.repeat(64) }); f.quiescent.resolve();
    await until(() => session(service, request.runId).state === 'failed'); assert.equal(session(service, request.runId).reason, changed ? 'INPUT_CHANGED' : 'FRAME_MISMATCH');
    assert.equal(f.counts().closed, 1); await service.close();
  }
});

test('Replica执行槽只阻断Attempt新准入，历史get与Stop仍可用，双向不并发输出', async t => {
  const a = await recordingAttemptFixture(t), f = await fixture(t);
  let attempts!: ReturnType<typeof createRecordingAttemptCoordinator>;
  const service = createRecordingReplicaCoordinator({ input: f.input, provider: f.provider, assertAttemptIdle: () => attempts.assertExecutionIdle() });
  attempts = createRecordingAttemptCoordinator({ store: a.repository.recordingAttempts, admissionProvider: a.provider, assertReplicaIdle: () => service.assertExecutionIdle() });
  const request = f.request(); service.start(request); await until(() => f.calls.length === 1);
  try {
    await assert.rejects(attempts.begin(a.beginRequest()), { code: 'ATTEMPT_CONFLICT' }); assert.equal(a.starts.length, 0);
    assert.deepEqual(attempts.get({ attemptId: randomUUID() }), { attempt: null });
    service.stop({ runId: request.runId }); f.quiescent.resolve(); await until(() => session(service, request.runId).state === 'cancelled');
    const active = await attempts.begin(a.beginRequest()); assert.equal(a.starts.length, 1);
    assert.throws(() => service.start(f.request()), { code: 'RUN_CONFLICT' });
    const stopped = await attempts.stop({ commandId: randomUUID(), attemptId: active.id }); assert.equal(stopped.status, 'aborted');
  } finally { f.quiescent.resolve(); await service.close(); await attempts.close(); }
});

test('正常消费后的close超过期限必须显示stopping且保留FD，静止之后才TIMEOUT终态', async t => {
  const f = await fixture(t), service = createRecordingReplicaCoordinator({ input: f.input, provider: f.provider, closeTimeoutMs: 5 });
  const request = f.request(); service.start(request); await until(() => f.calls.length === 1); f.completion.resolve(f.success);
  await until(() => f.counts().closes === 1); await new Promise(resolve => setTimeout(resolve, 15));
  const observed = session(service, request.runId);
  f.quiescent.resolve(); await until(() => f.counts().closed === 1); await service.close();
  assert.equal(observed.state, 'stopping'); assert.equal(observed.reason, 'TIMEOUT'); assert.equal(observed.cleanupQuiescent, false);
});

test('取消先于迟到句柄时仍观察completion拒绝，关闭后不会出现未处理拒绝', async t => {
  const f = await fixture(t), late = deferred<Awaited<ReturnType<RecordingReplicaProvider['start']>>>(); let entered = false;
  const provider: RecordingReplicaProvider = { evidence: 'synthetic-only', async start() { entered = true; return late.promise; } };
  const service = createRecordingReplicaCoordinator({ input: f.input, provider });
  const request = f.request(); service.start(request); await until(() => entered); service.stop({ runId: request.runId });
  late.resolve({ completion: f.completion.promise, async stop() {}, async close() { await f.quiescent.promise; } });
  await until(() => session(service, request.runId).started);
  f.completion.reject(new Error('合成取消后的消费拒绝')); await tick();
  f.quiescent.resolve(); await until(() => f.counts().closed === 1);
  assert.equal(session(service, request.runId).state, 'cancelled'); await service.close();
});

test('provider交还句柄前的合法进度暂存，starting快照不冒充已启动或变成非法DTO', async t => {
  const f = await fixture(t), gate = deferred<void>(); let entered = false;
  const progress: dto.ReplicaProgress = { sourceFramesRead: 8, submittedFrames: 4, consumedFrames: 2, sourceEof: false, backendDrained: false };
  const provider: RecordingReplicaProvider = { evidence: 'synthetic-only', async start(request) {
    entered = true; request.onProgress({ runId: request.runId, target: 'actual-execution', side: 'A', progress }); await gate.promise;
    return { completion: f.completion.promise, async stop() {}, async close() { await f.quiescent.promise; } };
  } };
  const service = createRecordingReplicaCoordinator({ input: f.input, provider }), request = f.request();
  service.start(request); await until(() => entered);
  let initial: Session | undefined, caught: unknown;
  try { initial = session(service, request.runId); } catch (error) { caught = error; }
  gate.resolve(); await tick(); await until(() => session(service, request.runId).started);
  assert.deepEqual(session(service, request.runId).progress, progress);
  f.completion.resolve(f.success); f.quiescent.resolve(); await until(() => session(service, request.runId).state === 'finished'); await service.close();
  assert.equal(caught, undefined); assert.equal(initial?.state, 'starting'); assert.equal(initial?.started, false); assert.equal(initial?.progress?.submittedFrames, 0);
});

test('设备Replica保持一个逻辑run：pause收口、seek修订、resume新segment，完整末验才finished', async t => {
  const f = await fixture(t);
  const directory = await mkdtemp(path.join(os.tmpdir(), 'musicbridge-replica-device-session-'));
  const helper = path.join(directory, 'helper'), manifest = path.join(directory, 'manifest.json');
  const helperBytes = Buffer.from('受控Fake不执行HAL'), manifestBytes = Buffer.from('{}');
  await writeFile(helper, helperBytes); await chmod(helper, 0o755); await writeFile(manifest, manifestBytes);
  t.after(() => rm(directory, { recursive: true, force: true }));
  const pin = { path: helper, sha256: createHash('sha256').update(helperBytes).digest('hex'),
    manifestPath: manifest, manifestSha256: createHash('sha256').update(manifestBytes).digest('hex'),
    sourceSha256: 'a'.repeat(64), drainAlgorithmId: 'hal-sample-zero-cover-v1' as const };
  const outputSelection = { endpointId: 'dev_1234567890', selectionGeneration: randomUUID() };
  const observed = { ...outputSelection, uid: 'fake-device', sampleRate: 48000, channelCount: 2 as const,
    format: 'pcm-s16le' as const, physicalFormat: 'pcm-s16le' as const, bufferFrames: 16,
    backendId: 'musicbridge-coreaudio-hal', backendVersion: '0.2.0', configurationFingerprintSha256: '1'.repeat(64),
    alive: true, hasOutput: true };
  const calls: Array<{ runId: string; callbacks: DeviceOutputRunCallbacks; stop(): Promise<void> }> = [];
  const provider = createReplicaDeviceOutputProvider({ pin,
    deviceSelection: { current: () => outputSelection, async verify() { return observed; } },
    async run(_pin, request) {
      let stopped = false;
      const call = { runId: request.header.runId, callbacks: request.callbacks,
        async stop() {
          if (stopped) return; stopped = true;
          request.callbacks.onCleanup({ engineCutoff: true, stopAcknowledged: true, cleanupQuiescent: true,
            terminal: { kind: 'cancelled', suppliedFrames: 8, consumedFrames: 7 } });
          request.callbacks.onFailure(new DeviceOutputRunError('CANCELLED'));
        } };
      calls.push(call);
      return { stop: call.stop, async close() {} };
    },
  });
  const deviceSession = createReplicaDeviceSessionCoordinator({ input: f.input, provider,
    currentSelection: () => outputSelection });
  const service = createRecordingReplicaCoordinator({ input: f.input, deviceSession });
  t.after(() => service.close());
  const request = { ...f.request(), mode: 'device-output' as const, outputSelection };
  assert.equal(service.status().gateB, 'NOT_RUN');
  const first = service.start(request);
  assert.equal(first.kind, 'device-session'); assert.equal(first.state, 'starting');
  await until(() => calls.length === 1 && service.get({ runId: request.runId }).run?.state === 'outputting');
  const firstSegment = calls[0]!;
  firstSegment.callbacks.onProgress({ suppliedFrames: 8, consumedFrames: 6, zeroFilledFrames: 0 });
  const pauseId = randomUUID();
  const pausing = service.control({ runId: request.runId, commandId: pauseId,
    expectedControlRevision: 0, operation: 'pause' });
  assert.equal(pausing.kind, 'device-session'); assert.equal(pausing.state, 'pausing');
  assert.deepEqual(service.control({ runId: request.runId, commandId: pauseId,
    expectedControlRevision: 0, operation: 'pause' }), pausing, '同命令重试不得重复派发');
  await until(() => service.get({ runId: request.runId }).run?.state === 'paused');
  const paused = service.get({ runId: request.runId }).run;
  assert.ok(paused?.kind === 'device-session'); assert.equal(paused.cursorFrame, 7,
    '暂停游标只取验证终态，不能用漏掉末次消费的周期进度6');
  assert.equal(paused.segmentId, null); assert.equal(paused.segmentQuiescent, true);
  assert.equal(f.counts().closed, 1, '对外发布paused前必须完成第一段末验并释放FD');
  assert.throws(() => service.control({ runId: request.runId, commandId: randomUUID(),
    expectedControlRevision: 0, operation: 'seek', frame: 4 }), { code: 'CONTROL_CONFLICT' });
  const seeked = service.control({ runId: request.runId, commandId: randomUUID(),
    expectedControlRevision: 1, operation: 'seek', frame: 4 });
  assert.equal(seeked.kind, 'device-session'); assert.equal(seeked.cursorFrame, 4);
  const resumed = service.control({ runId: request.runId, commandId: randomUUID(),
    expectedControlRevision: 2, operation: 'resume' });
  assert.equal(resumed.kind, 'device-session'); assert.notEqual(resumed.segmentId, firstSegment.runId);
  await until(() => calls.length === 2 && service.get({ runId: request.runId }).run?.state === 'outputting');
  const second = calls[1]!;
  second.callbacks.onProgress({ suppliedFrames: 12, consumedFrames: 12, zeroFilledFrames: 16 });
  second.callbacks.onSourceEof(); second.callbacks.onDrainObserved();
  second.callbacks.onCleanup({ engineCutoff: true, stopAcknowledged: true, cleanupQuiescent: true,
    terminal: { kind: 'completed', suppliedFrames: 12, consumedFrames: 12 } });
  second.callbacks.onComplete();
  await until(() => service.get({ runId: request.runId }).run?.state === 'finished');
  const finished = service.get({ runId: request.runId }).run;
  assert.ok(finished?.kind === 'device-session'); assert.equal(dto.isRecordingReplicaRun(finished), true);
  assert.equal(finished.controlRevision, 3); assert.equal(finished.cursorFrame, 16);
  assert.equal(finished.receipt?.fromFrame, 4); assert.equal(finished.receipt?.frameCount, 12);
  assert.equal(finished.receipt?.gateB, 'NOT_RUN'); assert.equal(finished.formalReady, false);
  assert.equal(f.counts().closed, 2, 'resume必须重新取得精确输入，两个segment分别末验并释放FD');
});

async function deviceFixture(t: test.TestContext, inputOptions: Parameters<typeof fixture>[1] = {}) {
  const f = await fixture(t, inputOptions), directory = await mkdtemp(path.join(os.tmpdir(), 'musicbridge-replica-device-fake-'));
  const helper = path.join(directory, 'helper'), manifest = path.join(directory, 'manifest.json');
  const helperBytes = Buffer.from('受控Fake不执行HAL'), manifestBytes = Buffer.from('{}');
  await writeFile(helper, helperBytes); await chmod(helper, 0o755); await writeFile(manifest, manifestBytes);
  t.after(() => rm(directory, { recursive: true, force: true }));
  const pin = { path: helper, sha256: createHash('sha256').update(helperBytes).digest('hex'),
    manifestPath: manifest, manifestSha256: createHash('sha256').update(manifestBytes).digest('hex'),
    sourceSha256: 'a'.repeat(64), drainAlgorithmId: 'hal-sample-zero-cover-v1' as const };
  const outputSelection = { endpointId: 'dev_1234567890', selectionGeneration: randomUUID() };
  const observed = { ...outputSelection, uid: 'fake-device', sampleRate: 48000, channelCount: 2 as const,
    format: 'pcm-s16le' as const, physicalFormat: 'pcm-s16le' as const, bufferFrames: 16,
    backendId: 'musicbridge-coreaudio-hal', backendVersion: '0.2.0', configurationFingerprintSha256: '1'.repeat(64),
    alive: true, hasOutput: true };
  const calls: Array<{ callbacks: DeviceOutputRunCallbacks; closeCount: number; stopCount: number }> = [];
  const provider = createReplicaDeviceOutputProvider({ pin,
    deviceSelection: { current: () => outputSelection, async verify() { return observed; } },
    async run(_pin, request) {
      const call = { callbacks: request.callbacks, closeCount: 0, stopCount: 0 }; calls.push(call);
      return { async stop() {
        if (++call.stopCount !== 1) return;
        call.callbacks.onCleanup({ engineCutoff: true, stopAcknowledged: true, cleanupQuiescent: true,
          terminal: { kind: 'cancelled', suppliedFrames: 8, consumedFrames: 7 } });
        call.callbacks.onFailure(new DeviceOutputRunError('CANCELLED'));
      }, async close() { ++call.closeCount; } };
    },
  });
  const deviceSession = createReplicaDeviceSessionCoordinator({ input: f.input, provider,
    currentSelection: () => outputSelection, closeTimeoutMs: 10 });
  const service = createRecordingReplicaCoordinator({ input: f.input, deviceSession });
  const request = { ...f.request(), mode: 'device-output' as const, outputSelection };
  return { ...f, calls, deviceSession, service, request };
}

test('设备Replica暂停须等输入末验和FD释放；末验失败仅在释放后释放执行槽', async t => {
  const release = deferred<void>(), f = await deviceFixture(t, { afterInput: () => release.promise });
  f.service.start(f.request);
  await until(() => f.calls.length === 1 && f.service.get({ runId: f.request.runId }).run?.state === 'outputting');
  f.calls[0]!.callbacks.onProgress({ suppliedFrames: 8, consumedFrames: 6, zeroFilledFrames: 0 });
  f.service.control({ runId: f.request.runId, commandId: randomUUID(), expectedControlRevision: 0, operation: 'pause' });
  await until(() => f.calls[0]!.closeCount === 1);
  assert.equal(f.service.get({ runId: f.request.runId }).run?.state, 'pausing');
  assert.equal(f.counts().closed, 0);
  assert.throws(() => f.service.start({ ...f.request, runId: randomUUID() }), { code: 'RUN_CONFLICT' });
  release.resolve();
  await until(() => f.service.get({ runId: f.request.runId }).run?.state === 'paused');
  assert.equal(f.counts().closed, 1);
  const stopped = f.service.control({ runId: f.request.runId, commandId: randomUUID(), expectedControlRevision: 1, operation: 'stop' });
  assert.equal(stopped.state, 'stopping');
  await until(() => f.service.get({ runId: f.request.runId }).run?.state === 'cancelled');
  await f.service.close();
  const changed = await deviceFixture(t, { afterInput: async () => { throw new RecordingReplicaError('INPUT_CHANGED'); } });
  changed.service.start(changed.request);
  await until(() => changed.calls.length === 1 && changed.service.get({ runId: changed.request.runId }).run?.state === 'outputting');
  const done = changed.calls[0]!.callbacks;
  done.onProgress({ suppliedFrames: 16, consumedFrames: 16, zeroFilledFrames: 16 }); done.onSourceEof(); done.onDrainObserved();
  done.onCleanup({ engineCutoff: true, stopAcknowledged: true, cleanupQuiescent: true,
    terminal: { kind: 'completed', suppliedFrames: 16, consumedFrames: 16 } }); done.onComplete();
  await until(() => changed.service.get({ runId: changed.request.runId }).run?.state === 'failed');
  const failed = changed.service.get({ runId: changed.request.runId }).run;
  assert.ok(failed?.kind === 'device-session'); assert.equal(failed.reason, 'INPUT_CHANGED');
  assert.equal(changed.counts().closed, 1);
  assert.doesNotThrow(() => changed.service.start({ ...changed.request, runId: randomUUID() }));
  await changed.service.close();
});

test('输入FD释放未知时保留最后run和执行槽，不把拒绝冒充cleanup', async t => {
  const f = await deviceFixture(t, { releaseUnverified: true });
  f.service.start(f.request);
  await until(() => f.calls.length === 1 && f.service.get({ runId: f.request.runId }).run?.state === 'outputting');
  const done = f.calls[0]!.callbacks;
  done.onProgress({ suppliedFrames: 16, consumedFrames: 16, zeroFilledFrames: 16 }); done.onSourceEof(); done.onDrainObserved();
  done.onCleanup({ engineCutoff: true, stopAcknowledged: true, cleanupQuiescent: true,
    terminal: { kind: 'completed', suppliedFrames: 16, consumedFrames: 16 } }); done.onComplete();
  await until(() => f.service.get({ runId: f.request.runId }).run?.state === 'stopping');
  const run = f.service.get({ runId: f.request.runId }).run;
  assert.equal(run?.cleanupQuiescent, false); assert.equal(run?.kind, 'device-session');
  assert.equal(f.counts().closed, 1, '测试Fake实际释放FD，但报告未知必须按未知处理');
  assert.throws(() => f.service.start({ ...f.request, runId: randomUUID() }), { code: 'RUN_CONFLICT' });
  await assert.rejects(f.service.close(), { code: 'TIMEOUT' });
});

test('缺少native cleanup事实即使close返回也不放开执行槽；路由失败有cleanup才安全失败', async t => {
  const unknown = await deviceFixture(t);
  unknown.service.start(unknown.request);
  await until(() => unknown.calls.length === 1 && unknown.service.get({ runId: unknown.request.runId }).run?.state === 'outputting');
  unknown.calls[0]!.callbacks.onFailure(new DeviceOutputRunError('PROTOCOL'));
  await until(() => unknown.service.get({ runId: unknown.request.runId }).run?.state === 'stopping');
  assert.equal(unknown.counts().closed, 1);
  assert.throws(() => unknown.service.start({ ...unknown.request, runId: randomUUID() }), { code: 'RUN_CONFLICT' });
  await assert.rejects(unknown.service.close(), { code: 'TIMEOUT' });

  const route = await deviceFixture(t);
  route.service.start(route.request);
  await until(() => route.calls.length === 1 && route.service.get({ runId: route.request.runId }).run?.state === 'outputting');
  const callback = route.calls[0]!.callbacks;
  callback.onCleanup({ engineCutoff: true, stopAcknowledged: false, cleanupQuiescent: true,
    terminal: { kind: 'failed', suppliedFrames: 4, consumedFrames: 3 } });
  callback.onFailure(new DeviceOutputRunError('ROUTE_CHANGED'));
  await until(() => route.service.get({ runId: route.request.runId }).run?.state === 'failed');
  const failed = route.service.get({ runId: route.request.runId }).run;
  assert.ok(failed?.kind === 'device-session'); assert.equal(failed.reason, 'ROUTE_CHANGED');
  assert.equal(route.counts().closed, 1); await route.service.close();
});

test('设备Stop携带修订与命令ID幂等，静止前不能关闭或新开run', async t => {
  const release = deferred<void>(), f = await deviceFixture(t, { beforeClose: () => release.promise });
  f.service.start(f.request);
  await until(() => f.calls.length === 1 && f.service.get({ runId: f.request.runId }).run?.state === 'outputting');
  const command = { runId: f.request.runId, commandId: randomUUID(), expectedControlRevision: 0, operation: 'stop' as const };
  const stopping = f.service.control(command);
  assert.deepEqual(f.service.control(command), stopping);
  assert.equal(f.calls[0]!.stopCount, 1);
  await until(() => f.calls[0]!.closeCount === 1);
  assert.equal(f.service.get({ runId: f.request.runId }).run?.state, 'stopping');
  assert.throws(() => f.service.start({ ...f.request, runId: randomUUID() }), { code: 'RUN_CONFLICT' });
  release.resolve();
  await until(() => f.service.get({ runId: f.request.runId }).run?.state === 'cancelled');
  const result = f.service.get({ runId: f.request.runId }).run;
  assert.ok(result?.kind === 'device-session'); assert.equal(result.cleanupQuiescent, true);
  await f.service.close();
});

test('优先Stop绕过失回执pause修订，仍等真实输入释放才终结', async t => {
  const release = deferred<void>(), f = await deviceFixture(t, { beforeClose: () => release.promise });
  f.service.start(f.request);
  await until(() => f.calls.length === 1 && f.service.get({ runId: f.request.runId }).run?.state === 'outputting');
  const pause = f.service.control({ runId: f.request.runId, commandId: randomUUID(), expectedControlRevision: 0, operation: 'pause' });
  assert.equal(pause.state, 'pausing');
  const stopped = f.service.stop({ runId: f.request.runId });
  assert.equal(stopped.kind, 'device-session'); assert.equal(stopped.state, 'stopping');
  assert.deepEqual(f.service.stop({ runId: f.request.runId }), stopped, '按runId重试Stop不依赖旧pause修订');
  assert.equal(f.counts().closed, 0); assert.throws(() => f.service.start({ ...f.request, runId: randomUUID() }), { code: 'RUN_CONFLICT' });
  release.resolve();
  await until(() => f.service.get({ runId: f.request.runId }).run?.state === 'cancelled');
  const final = f.service.get({ runId: f.request.runId }).run;
  assert.ok(final?.kind === 'device-session'); assert.equal(final.cleanupQuiescent, true);
  await f.service.close();
});

test('启动回执未知时原runId优先Stop建立tombstone，晚到同ID start不可复活', async t => {
  const f = await deviceFixture(t), stopped = f.service.stop({ runId: f.request.runId });
  assert.equal(stopped.kind, 'cancelled-before-start'); assert.equal(stopped.cleanupQuiescent, true);
  assert.deepEqual(f.service.stop({ runId: f.request.runId }), stopped);
  assert.deepEqual(f.service.start(f.request), stopped);
  assert.deepEqual(f.service.get({ runId: f.request.runId }).run, stopped);
  assert.equal(f.calls.length, 0); assert.equal(f.counts().opened, 0);
  await f.service.close();
});
