import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { link, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { RecordingPlanVersion } from '@music-bridge/contracts';
import { createProductionGateBAdmission, matchGateBAdmission, parseGateBCompleteRecord, readTrustedGateBRecord, type GateBCompleteRecord, type GateBLiveObservation } from '../src/recording/gate-b-admission.js';

const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const candidate = { commit: 'a'.repeat(40), tree: 'b'.repeat(40), sourceSha256: 'f'.repeat(64), manifestSha256: 'c'.repeat(64), helperSha256: 'd'.repeat(64) };
function syntheticCompleteRecord(): GateBCompleteRecord {
  return {
    schemaVersion: 1, kind: 'musicbridge-gate-b-complete', scope: 'formal-recording', candidate,
    backend: { id: 'musicbridge-coreaudio-hal', version: '0.2.0' },
    configurationFingerprintSha256: 'e'.repeat(64),
    drainAlgorithmId: 'hal-sample-zero-cover-v1', drain: { tailFrames: 2048, minimumZeroCallbacks: 2, capacityFrames: 4096 },
    route: { endpointId: 'synthetic-output-01', uid: 'synthetic-uid-01', sampleRate: 48000, channelCount: 2, format: 'pcm-s16le', physicalFormat: 'pcm-s16le', bufferFrames: 256 },
    issuedAt: '2026-09-27T00:00:00.000Z', validUntil: '2026-09-28T00:00:00.000Z',
    cases: Array.from({ length: 15 }, (_, index) => ({ scopeId: `B-${String(index + 1).padStart(2, '0')}`, receiptId: `synthetic-b${index + 1}`, receiptSha256: String(index + 1).padStart(2, '0').repeat(32), configurationFingerprintSha256: 'e'.repeat(64), verdict: 'passed' as const })),
  };
}
const bytes = (record: unknown) => Buffer.from(`${JSON.stringify(record)}\n`);
const syntheticNow = Date.parse('2026-09-27T12:00:00.000Z');
function syntheticPlan(record: GateBCompleteRecord): RecordingPlanVersion {
  // 只测输出准入身份比较；Plan自身的持久完整性由plan-store/plan-integrity套件证明。
  return { profileSnapshot: { settings: { format: { sampleRate: record.route.sampleRate, channelCount: record.route.channelCount,
    outputSampleFormat: record.route.format, outputBackend: record.backend } } },
    outputBinding: { endpointId: record.route.endpointId, deviceUid: record.route.uid, backendId: record.backend.id,
      backendVersion: record.backend.version, bufferFrames: record.route.bufferFrames, configurationFingerprintSha256: record.configurationFingerprintSha256,
      drainAlgorithmId: record.drainAlgorithmId } } as unknown as RecordingPlanVersion;
}
function syntheticObservation(record: GateBCompleteRecord): GateBLiveObservation {
  return { ...record.route, selectionGeneration: randomUUID(), backendId: record.backend.id, backendVersion: record.backend.version,
    configurationFingerprintSha256: record.configurationFingerprintSha256, alive: true, hasOutput: true };
}

test('完整B01～B15受控结构可解析；缺项、重复、B15单项或配置跨族一律拒绝', () => {
  const original = syntheticCompleteRecord();
  assert.deepEqual(parseGateBCompleteRecord(bytes(original)), original);
  assert.equal(parseGateBCompleteRecord(bytes({ ...original, cases: original.cases.slice(14) })), null);
  assert.equal(parseGateBCompleteRecord(bytes({ ...original, cases: original.cases.slice(0, 14) })), null);
  assert.equal(parseGateBCompleteRecord(bytes({ ...original, cases: [...original.cases.slice(0, 14), original.cases[0]] })), null);
  assert.equal(parseGateBCompleteRecord(bytes({ ...original, cases: original.cases.map((item, index) => index === 4 ? { ...item, configurationFingerprintSha256: 'f'.repeat(64) } : item) })), null);
  assert.equal(parseGateBCompleteRecord(bytes({ ...original, issuedAt: '2026-09-27T00:00:00Z' })), null);
  assert.equal(parseGateBCompleteRecord(bytes({ ...original, route: { ...original.route, sampleRate: '48000' } })), null);
  assert.equal(parseGateBCompleteRecord(bytes({ ...original, drainAlgorithmId: 'other-drain' })), null);
  assert.equal(parseGateBCompleteRecord(bytes({ ...original, drain: { ...original.drain, minimumZeroCallbacks: 0 } })), null);
  assert.equal(parseGateBCompleteRecord(bytes({ ...original, route: { ...original.route, physicalFormat: 'pcm-f32le' } })), null);
});

test('完整受信记录仍需冻结计划绑定及独立实时观测；同PCM错后端/端点/UID/缓冲和等待中过期均拒绝', () => {
  const record = syntheticCompleteRecord(), recordSha256 = digest(bytes(record));
  const trusted = { record, recordSha256 }, observed = syntheticObservation(record), plan = syntheticPlan(record);
  const binding = plan.outputBinding!;
  const match = (nextPlan: RecordingPlanVersion | null, nextObserved: GateBLiveObservation | null, now = syntheticNow) =>
    matchGateBAdmission({ trusted, plan: nextPlan, observed: nextObserved, now });
  assert.equal(match(plan, observed)?.recordSha256, recordSha256);
  const legacy = structuredClone(plan); delete legacy.outputBinding;
  assert.equal(match(legacy, observed), null, '旧计划不能从证书补输出身份');
  assert.equal(match({ ...plan, profileSnapshot: { ...plan.profileSnapshot, settings: { ...plan.profileSnapshot.settings,
    format: { ...plan.profileSnapshot.settings.format, outputBackend: { id: 'other-backend', version: '0.1.0' } } } } }, observed), null);
  assert.equal(match({ ...plan, outputBinding: { ...binding, endpointId: 'other-endpoint' } }, observed), null);
  assert.equal(match({ ...plan, outputBinding: { ...binding, deviceUid: 'other-uid' } }, observed), null);
  const wrongDrain = structuredClone(plan); Reflect.set(wrongDrain.outputBinding!, 'drainAlgorithmId', 'other-drain');
  assert.equal(match(wrongDrain, observed), null);
  assert.equal(match(plan, { ...observed, endpointId: 'other-endpoint' }), null);
  assert.equal(match(plan, { ...observed, uid: 'other-uid' }), null);
  assert.equal(match(plan, { ...observed, physicalFormat: 'pcm-f32le' }), null);
  assert.equal(match(plan, { ...observed, selectionGeneration: 'not-a-uuid' }), null);
  assert.equal(match(plan, { ...observed, bufferFrames: 512 }), null);
  assert.equal(match(plan, observed, Date.parse(record.validUntil)), null, 'await观测后认证到期不能发表准入');
});

test('只读受信来源逐次核对文件身份、编译期Hash、候选/期限；生产空信任根不观测设备', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'musicbridge-gate-b-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, `${randomUUID()}.json`), record = syntheticCompleteRecord(), raw = bytes(record), trustedHashes = [digest(raw)];
  await writeFile(file, raw);
  const signal = new AbortController().signal;
  const read = (overrides: Partial<Parameters<typeof readTrustedGateBRecord>[0]> = {}) => readTrustedGateBRecord({ file, trustedHashes, candidate, now: syntheticNow, signal, ...overrides });
  assert.equal((await read())?.recordSha256, trustedHashes[0]);
  assert.equal(await read({ trustedHashes: [] }), null);
  assert.equal(await read({ candidate: { ...candidate, helperSha256: '1'.repeat(64) } }), null);
  assert.equal(await read({ candidate: { ...candidate, sourceSha256: '1'.repeat(64) } }), null);
  assert.equal(await read({ now: Date.parse(record.validUntil) }), null);
  assert.equal(await read({ now: Date.parse(record.issuedAt) - 1 }), null);
  await writeFile(file, bytes({ ...record, scope: 'replica-playback' }));
  assert.equal(await read(), null, '允许Hash不能覆盖任何字节漂移');
  const linked = path.join(directory, 'linked.json'); await symlink(file, linked);
  assert.equal(await read({ file: linked }), null, '符号链接不可作为记录来源');
  await writeFile(file, raw); const hard = path.join(directory, 'hard.json'); await link(file, hard);
  assert.equal(await read(), null, '多硬链接记录不进入受信来源');
  let observed = 0;
  const production = createProductionGateBAdmission({ recordPath: file, candidate, now: () => syntheticNow, async observeExact() { ++observed; throw new Error('生产空根不得观测'); } });
  assert.equal(await production.verify(null, signal), null);
  assert.equal(observed, 0);
});
