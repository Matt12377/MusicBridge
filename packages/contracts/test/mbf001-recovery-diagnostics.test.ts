import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import {
  DiagnosticRingBuffer,
  LOCAL_PLAY_REJECTIONS,
  ROON_DIAGNOSTIC_ERROR_CLASSES,
  ROON_DIAGNOSTIC_EVENTS,
  ROON_DIAGNOSTIC_GATEWAY_STAGES,
  assertDiagnosticExportSafe,
  buildDiagnosticReport,
  isCommandOutboxExecute,
  isLocalPlayReceipt,
  isRoonDiagnosticStage,
  validateIpcInternalRequest,
  validateIpcRequest,
  validateIpcResponseForCommand,
  type DiagnosticComponentSnapshot,
  type DiagnosticRecordInput,
  type DiagnosticTimelineEvent,
  type LocalPlayRequest,
  type RoonDiagnosticStage,
} from '../src/index.js';

const request: LocalPlayRequest = {
  schema_version: '1.2', request_id: 'synthetic-original-request',
  route: 'roon_audio_input', source_kind: 'local_file',
  local_track_id: 'synthetic-track', asset_id: 'synthetic-asset', expected_asset_revision: '1',
  target: { core_id: 'synthetic-core', zone_id: 'synthetic-zone' }, action: 'PLAY_NOW',
};
const response = (result: unknown) => ({ version: 1, id: 'synthetic-read', ok: true, result });
const stage = (changes: Partial<RoonDiagnosticStage> = {}): RoonDiagnosticStage => ({
  phase: 'awaiting_playing', eventName: 'Playing', elapsedMs: 25,
  gatewayStage: 'completed', errorClass: 'none', staleCallback: false, ...changes,
});
const event = (roonStage: RoonDiagnosticStage = stage()): DiagnosticTimelineEvent => ({
  at: '2026-10-11T00:00:00.000Z', component: 'core', level: 'info',
  event: 'roon_play_event', diagnosticId: 'diag-local-1', roonStage,
});
function snapshot(component: 'main' | 'core', timeline: readonly DiagnosticTimelineEvent[] = []): DiagnosticComponentSnapshot {
  return {
    component,
    health: { runtime: 'ready', roon: 'ready', provider: 'missing', activeStreamCount: 0, activePlaybackPresent: false },
    timeline,
    memory: { rssBytes: 1, heapUsedBytes: 2, heapTotalBytes: 3, externalBytes: 4 },
    counters: { queueItemCount: 0, activeStreamCount: 0, activePlaybackCount: 0, activeSessionCount: 0, activeTokenCount: 0, listenerCount: 0, timerCount: 0 },
    latency: {}, gates: [{ name: 'synthetic', status: 'pass' }],
  };
}
const platform = { platform: 'darwin', arch: 'arm64', appVersion: '0.1.0-beta.2', electronVersion: '43.4.0', nodeVersion: '22.23.2' };

test('MBF001-B 回执四态与失败闭集：受理 result 必须匹配原 request_id 和 action', () => {
  const identity = { request_id: request.request_id, action: request.action };
  const accepted = { status: 'accepted', ...identity };
  const valid: unknown[] = [
    { status: 'missing', ...identity }, { status: 'pending', ...identity },
    { status: 'received', ...identity, result: accepted },
    ...['TARGET_AUTHORITY_UNAVAILABLE', 'LOCAL_PLAYBACK_PROTOCOL_UNSUPPORTED', 'LOCAL_SEGMENT_UNSUPPORTED'].map(reason => ({
      status: 'received', ...identity, result: { status: 'unsupported', reason },
    })),
    ...LOCAL_PLAY_REJECTIONS.map(reason => ({ status: 'rejected', ...identity, reason })),
  ];
  for (const receipt of valid) {
    assert.equal(isLocalPlayReceipt(receipt), true);
    assert.equal(validateIpcResponseForCommand(response(receipt), 'localCatalog.playReceipt').ok, true);
  }
  const invalid: unknown[] = [
    { status: 'unknown', ...identity }, accepted,
    { status: 'received', ...identity },
    { status: 'received', ...identity, result: { ...accepted, request_id: 'another-request' } },
    { status: 'received', ...identity, result: { ...accepted, action: 'APPEND_MB_QUEUE' } },
    { status: 'received', ...identity, result: { ...accepted, session_id: 'private-session' } },
    { status: 'received', ...identity, result: { status: 'unsupported', reason: 'RAW_SOURCE_ERROR' } },
    { status: 'rejected', ...identity, reason: 'SOURCE_UNAVAILABLE', message: '/Users/synthetic/private.wav' },
    { status: 'rejected', ...identity, reason: 'https://synthetic.invalid/private' },
    { status: 'missing', ...identity, result: accepted },
    { status: 'pending', ...identity, reason: 'ROON_TIMEOUT' },
    { status: 'received', ...identity, result: { status: 'Playing' } },
    { status: 'pending', ...identity, action: 'RETRY' },
    { status: 'pending', ...identity, request_id: '' },
  ];
  for (const receipt of invalid) {
    assert.equal(isLocalPlayReceipt(receipt), false);
    assert.equal(validateIpcResponseForCommand(response(receipt), 'localCatalog.playReceipt').ok, false);
  }
  for (const action of ['PLAY_NOW', 'APPEND_MB_QUEUE', 'PLAY_NEXT_MB_QUEUE'] as const) {
    const receipt = { status: 'received', request_id: request.request_id, action, result: { status: 'accepted', request_id: request.request_id, action } };
    assert.equal(isLocalPlayReceipt(receipt), true);
  }
});

test('MBF001-B 回执 IPC 要求 expectedDatasetId 和原九字段 body，不能进入 Outbox 重放', () => {
  const datasetId = randomUUID();
  const envelope = { version: 1, id: 'synthetic-query', command: 'localCatalog.playReceipt', payload: request, expectedDatasetId: datasetId };
  for (const validate of [validateIpcRequest, validateIpcInternalRequest]) {
    const accepted = validate(envelope);
    assert.equal(accepted.ok, true);
    if (accepted.ok) assert.equal(accepted.value.expectedDatasetId, datasetId);
    for (const invalid of [
      { ...envelope, expectedDatasetId: undefined },
      { ...envelope, expectedDatasetId: '' },
      { ...envelope, expectedDatasetId: 'wrong-dataset-identity' },
      { ...envelope, payload: { ...request, datasetId } },
      { ...envelope, payload: { ...request, path: '/Users/synthetic/private.wav' } },
      { ...envelope, payload: { ...request, target: { ...request.target, session_id: 'private-session' } } },
      { ...envelope, payload: { ...request, expected_asset_revision: '01' } },
      { ...envelope, payload: { ...request, attempt_id: 'private-attempt' } },
      { ...envelope, readContext: {} },
      { ...envelope, trusted: true },
    ]) assert.equal(validate(invalid).ok, false);
  }
  assert.equal(isCommandOutboxExecute({ commandId: randomUUID(), datasetId, command: 'localCatalog.playReceipt', payload: request }), false);
  const { expectedDatasetId: _omitted, ...missingDataset } = envelope;
  assert.equal(validateIpcRequest(missingDataset).ok, false);
});

test('MBF001-B roonStage 是有限枚举与毫秒闭集，原始 SDK event、响应正文和身份字段拒绝', () => {
  assert.equal(isRoonDiagnosticStage(stage({ elapsedMs: 0 })), true);
  assert.equal(isRoonDiagnosticStage(stage({ elapsedMs: 86_400_000 })), true);
  for (const phase of ['awaiting_session', 'awaiting_playing'] as const) assert.equal(isRoonDiagnosticStage(stage({ phase })), true);
  for (const eventName of ROON_DIAGNOSTIC_EVENTS) assert.equal(isRoonDiagnosticStage(stage({ eventName })), true);
  for (const gatewayStage of ROON_DIAGNOSTIC_GATEWAY_STAGES) assert.equal(isRoonDiagnosticStage(stage({ gatewayStage })), true);
  for (const errorClass of ROON_DIAGNOSTIC_ERROR_CLASSES) assert.equal(isRoonDiagnosticStage(stage({ errorClass })), true);
  const { eventName: _omitted, ...withoutEvent } = stage();
  assert.equal(isRoonDiagnosticStage(withoutEvent), true);
  const invalid: unknown[] = [
    null, [], {}, { ...stage(), phase: 'playing' }, { ...stage(), eventName: 'Time' },
    { ...stage(), eventName: 'RawSdkEvent' }, { ...stage(), eventName: undefined },
    { ...stage(), gatewayStage: 'http://synthetic.invalid/audio' },
    { ...stage(), errorClass: 'raw private error' }, { ...stage(), staleCallback: 'false' },
    ...[-1, 0.5, 86_400_001, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1].map(elapsedMs => ({ ...stage(), elapsedMs })),
    ...['media_url', 'path', 'session_id', 'track_id', 'responseBody', 'stackTrace'].map(field => ({ ...stage(), [field]: 'private' })),
    { ...stage(), [Symbol('private')]: 'private' },
  ];
  for (const value of invalid) assert.equal(isRoonDiagnosticStage(value), false);
  for (const field of ['phase', 'elapsedMs', 'gatewayStage', 'errorClass', 'staleCallback'] as const) {
    const value: Record<string, unknown> = { ...stage() };
    delete value[field];
    assert.equal(isRoonDiagnosticStage(value), false);
  }
});

test('MBF001-B core.getDiagnostics 接受闭集阶段，拒绝多余字段、私有 stage 和第 201 条事件', () => {
  const valid = snapshot('core', [event(), event(stage({ phase: 'awaiting_session', gatewayStage: 'none', errorClass: 'invalid_icon', staleCallback: true }))]);
  assert.equal(validateIpcResponseForCommand(response(valid), 'core.getDiagnostics').ok, true);
  const bounded = snapshot('core', Array.from({ length: 200 }, () => event()));
  assert.equal(validateIpcResponseForCommand(response(bounded), 'core.getDiagnostics').ok, true);
  const invalidTimelines = [
    [...bounded.timeline, event()],
    [{ ...event(), rawResponse: 'private' }],
    [{ ...event(), roonStage: { ...stage(), path: '/Users/synthetic/private.wav' } }],
    [{ ...event(), roonStage: { ...stage(), eventName: 'Time' } }],
    [{ ...event(), roonStage: { ...stage(), errorClass: 'private-stack' } }],
    [{ ...event(), roonStage: { ...stage(), gatewayStage: 'https://synthetic.invalid/audio' } }],
    [{ ...event(), roonStage: { ...stage(), elapsedMs: -1 } }],
  ];
  for (const timeline of invalidTimelines) {
    assert.equal(validateIpcResponseForCommand(response({ ...valid, timeline }), 'core.getDiagnostics').ok, false);
  }
});

test('MBF001-B Ring 与 report 对 roonStage 做安全副本，外部改动不污染保存事件', () => {
  const buffer = new DiagnosticRingBuffer(2);
  const originalStage = stage();
  buffer.record(event(originalStage));
  originalStage.gatewayStage = 'error';
  originalStage.eventName = 'MediaError';
  assert.deepEqual(buffer.snapshot()[0]!.roonStage, stage());
  const copy = buffer.snapshot()[0]!;
  copy.roonStage!.errorClass = 'other';
  copy.roonStage!.staleCallback = true;
  assert.deepEqual(buffer.snapshot()[0]!.roonStage, stage());

  const core = snapshot('core', buffer.snapshot());
  const report = buildDiagnosticReport({ platform, main: snapshot('main'), core, generatedAt: '2026-10-11T00:00:00.000Z' });
  core.timeline[0]!.roonStage!.phase = 'awaiting_session';
  assert.deepEqual(report.core.timeline[0]!.roonStage, stage());
  report.core.timeline[0]!.roonStage!.elapsedMs = 999;
  assert.equal(buffer.snapshot()[0]!.roonStage!.elapsedMs, 25);

  buffer.record({ ...event(), event: 'second', roonStage: stage({ staleCallback: true }) });
  buffer.record({ ...event(), event: 'third', roonStage: stage({ eventName: 'Unknown' }) });
  assert.deepEqual(buffer.snapshot().map(item => item.event), ['second', 'third']);
  assert.equal(buffer.snapshot()[0]!.roonStage?.staleCallback, true);
  assert.equal(buffer.snapshot()[1]!.roonStage?.eventName, 'Unknown');
});

test('MBF001-B 诊断 copy/export 丢弃额外输入和私有 stage，安全扫描拒绝公开字符串泄漏', () => {
  const buffer = new DiagnosticRingBuffer();
  buffer.record({
    ...event(), privatePath: '/Users/synthetic/private.wav', responseBody: 'private raw response',
  } as DiagnosticRecordInput);
  buffer.record({
    ...event(), event: 'invalid_stage_omitted',
    roonStage: { ...stage(), media_url: 'https://synthetic.invalid/audio?token=hidden', stackTrace: 'private stack' },
  } as DiagnosticRecordInput);
  const timeline = buffer.snapshot();
  assert.deepEqual(timeline[0]!.roonStage, stage());
  assert.equal(timeline[1]!.roonStage, undefined);
  const report = buildDiagnosticReport({ platform, main: snapshot('main'), core: snapshot('core', timeline) });
  const serialized = JSON.stringify(report);
  assertDiagnosticExportSafe(serialized);
  assert.doesNotMatch(serialized, /privatePath|responseBody|media_url|stackTrace|https?:\/\/|\/Users\//u);
  for (const privateValue of [
    'https://synthetic.invalid/private?token=hidden',
    '/Users/synthetic/private.wav',
    'Cookie: synthetic-private-value',
    'stackTrace: synthetic private stack',
  ]) {
    assert.throws(() => buildDiagnosticReport({
      platform, main: snapshot('main'), core: snapshot('core', [{ ...event(), event: privateValue }]),
    }), (error: Error) => {
      assert.equal(error.message, 'Diagnostic export rejected by secret scan');
      assert.ok(!error.message.includes(privateValue));
      return true;
    });
  }
});
