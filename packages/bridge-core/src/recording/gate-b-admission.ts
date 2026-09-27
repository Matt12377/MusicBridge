import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { isCollectionId, type RecordingPlanVersion } from '@music-bridge/contracts';
import { DEVICE_OUTPUT_BACKEND_ID, DEVICE_OUTPUT_BACKEND_VERSION, DEVICE_OUTPUT_DRAIN_ALGORITHM_ID } from './device-output-protocol.js';

/** B15仅是配置身份子证书；这里要求同一配置族的完整B01～B15审计记录。 */
const GATE_B_SCOPES = Array.from({ length: 15 }, (_, index) => `B-${String(index + 1).padStart(2, '0')}`);
/** 仅能经独立审计、代码复审和重新构建添加。当前没有真实完整Gate B记录。 */
const PRODUCTION_TRUSTED_COMPLETE_RECORD_SHA256: readonly string[] = Object.freeze([]);
const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
const hash = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value);
const gitHash = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{40}$/u.test(value);
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const exact = (value: Record<string, unknown>, keys: readonly string[]): boolean => Object.keys(value).length === keys.length && Object.keys(value).every(key => keys.includes(key));
const utc = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const endpoint = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/u.test(value);
const uid = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 128 && !value.includes('\0');
const format = (value: unknown): value is GateBPcmFormat => ['pcm-s16le', 'pcm-s24le', 'pcm-s32le', 'pcm-f32le'].includes(String(value));

export type GateBPcmFormat = 'pcm-s16le' | 'pcm-s24le' | 'pcm-s32le' | 'pcm-f32le';
export interface GateBCandidateIdentity { commit: string; tree: string; sourceSha256: string; manifestSha256: string; helperSha256: string }
export interface GateBRoute {
  endpointId: string; uid: string; sampleRate: number; channelCount: 1 | 2;
  format: GateBPcmFormat; physicalFormat: GateBPcmFormat; bufferFrames: number;
}
export interface GateBDrainPolicy { tailFrames: number; minimumZeroCallbacks: number; capacityFrames: number }
export interface GateBPlanBinding {
  endpointId: string; deviceUid: string; backendId: string; backendVersion: string;
  bufferFrames: number; configurationFingerprintSha256: string; drainAlgorithmId: typeof DEVICE_OUTPUT_DRAIN_ALGORITHM_ID;
}
export interface GateBCompleteRecord {
  schemaVersion: 1; kind: 'musicbridge-gate-b-complete'; scope: 'formal-recording';
  candidate: GateBCandidateIdentity; backend: { id: string; version: string }; configurationFingerprintSha256: string;
  drainAlgorithmId: typeof DEVICE_OUTPUT_DRAIN_ALGORITHM_ID; drain: GateBDrainPolicy; route: GateBRoute;
  issuedAt: string; validUntil: string;
  cases: readonly { scopeId: string; receiptId: string; receiptSha256: string; configurationFingerprintSha256: string; verdict: 'passed' }[];
}
/** 由独立Probe/配置观测器返回；不得从认证记录复制字段构造。 */
export interface GateBLiveObservation extends GateBRoute {
  selectionGeneration: string; backendId: string; backendVersion: string;
  configurationFingerprintSha256: string; alive: boolean; hasOutput: boolean;
}
export interface GateBAdmission {
  recordSha256: string; configurationFingerprintSha256: string; endpointId: string; uid: string;
  selectionGeneration: string; validUntil: string; helperSha256: string; route: GateBRoute;
  drainAlgorithmId: typeof DEVICE_OUTPUT_DRAIN_ALGORITHM_ID; drain: GateBDrainPolicy;
}
export interface GateBAdmissionSource {
  verify(plan: RecordingPlanVersion | null, signal: AbortSignal): Promise<GateBAdmission | null>;
}

function validCandidate(value: unknown): value is GateBCandidateIdentity {
  return object(value) && exact(value, ['commit', 'tree', 'sourceSha256', 'manifestSha256', 'helperSha256'])
    && gitHash(value.commit) && gitHash(value.tree) && hash(value.sourceSha256) && hash(value.manifestSha256) && hash(value.helperSha256);
}
function validBackend(value: unknown): value is { id: string; version: string } {
  return object(value) && exact(value, ['id', 'version']) && value.id === DEVICE_OUTPUT_BACKEND_ID && value.version === DEVICE_OUTPUT_BACKEND_VERSION;
}
function validPlanBinding(value: unknown): value is GateBPlanBinding {
  return object(value) && exact(value, ['endpointId', 'deviceUid', 'backendId', 'backendVersion', 'bufferFrames', 'configurationFingerprintSha256', 'drainAlgorithmId'])
    && endpoint(value.endpointId) && uid(value.deviceUid) && value.backendId === DEVICE_OUTPUT_BACKEND_ID && value.backendVersion === DEVICE_OUTPUT_BACKEND_VERSION
    && typeof value.bufferFrames === 'number' && Number.isSafeInteger(value.bufferFrames) && value.bufferFrames >= 16 && value.bufferFrames <= 4096
    && (value.bufferFrames & (value.bufferFrames - 1)) === 0 && hash(value.configurationFingerprintSha256)
    && value.drainAlgorithmId === DEVICE_OUTPUT_DRAIN_ALGORITHM_ID;
}
function validRoute(value: unknown): value is GateBRoute {
  return object(value) && exact(value, ['endpointId', 'uid', 'sampleRate', 'channelCount', 'format', 'physicalFormat', 'bufferFrames'])
    && endpoint(value.endpointId) && uid(value.uid)
    && typeof value.sampleRate === 'number' && [44100, 48000, 88200, 96000, 176400, 192000].includes(value.sampleRate)
    && (value.channelCount === 1 || value.channelCount === 2) && format(value.format) && value.physicalFormat === value.format
    && typeof value.bufferFrames === 'number' && Number.isSafeInteger(value.bufferFrames) && value.bufferFrames >= 16 && value.bufferFrames <= 4096
    && (value.bufferFrames & (value.bufferFrames - 1)) === 0;
}
function validDrain(value: unknown, bufferFrames: number): value is GateBDrainPolicy {
  return object(value) && exact(value, ['tailFrames', 'minimumZeroCallbacks', 'capacityFrames'])
    && typeof value.tailFrames === 'number' && Number.isSafeInteger(value.tailFrames) && value.tailFrames >= bufferFrames && value.tailFrames <= 3840000
    && typeof value.minimumZeroCallbacks === 'number' && Number.isSafeInteger(value.minimumZeroCallbacks)
    && value.minimumZeroCallbacks >= 1 && value.minimumZeroCallbacks <= 128
    && typeof value.capacityFrames === 'number' && Number.isSafeInteger(value.capacityFrames)
    && value.capacityFrames >= bufferFrames && value.capacityFrames <= 16384;
}
/** 仅验证记录的严格结构与完整性；受信来源还必须通过编译期Hash白名单。 */
export function parseGateBCompleteRecord(bytes: Buffer): GateBCompleteRecord | null {
  if (bytes.length < 1 || bytes.length > 256 * 1024) return null;
  let value: unknown;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { return null; }
  if (!object(value) || !exact(value, ['schemaVersion', 'kind', 'scope', 'candidate', 'backend', 'configurationFingerprintSha256', 'drainAlgorithmId', 'drain', 'route', 'issuedAt', 'validUntil', 'cases'])
    || value.schemaVersion !== 1 || value.kind !== 'musicbridge-gate-b-complete' || value.scope !== 'formal-recording'
    || !validCandidate(value.candidate) || !validBackend(value.backend) || !hash(value.configurationFingerprintSha256) || !validRoute(value.route)
    || value.drainAlgorithmId !== DEVICE_OUTPUT_DRAIN_ALGORITHM_ID || !validDrain(value.drain, value.route.bufferFrames)
    || !utc(value.issuedAt) || !utc(value.validUntil) || Date.parse(value.validUntil) <= Date.parse(value.issuedAt)
    || !Array.isArray(value.cases) || value.cases.length !== GATE_B_SCOPES.length) return null;
  const cases = value.cases as unknown[];
  for (let index = 0; index < GATE_B_SCOPES.length; index++) {
    const item = cases[index];
    if (!object(item) || !exact(item, ['scopeId', 'receiptId', 'receiptSha256', 'configurationFingerprintSha256', 'verdict'])
      || item.scopeId !== GATE_B_SCOPES[index] || !endpoint(item.receiptId) || !hash(item.receiptSha256)
      || item.configurationFingerprintSha256 !== value.configurationFingerprintSha256 || item.verdict !== 'passed') return null;
  }
  if (new Set(cases.map(item => (item as Record<string, unknown>).receiptId)).size !== cases.length
    || new Set(cases.map(item => (item as Record<string, unknown>).receiptSha256)).size !== cases.length) return null;
  return value as unknown as GateBCompleteRecord;
}

async function readPinnedRegularFile(file: string, signal: AbortSignal): Promise<Buffer | null> {
  if (!path.isAbsolute(file)) return null;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    signal.throwIfAborted();
    if (await realpath(file) !== file) return null;
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size < 1n || before.size > 256n * 1024n || (before.mode & 0o022n) !== 0n) return null;
    const bytes = Buffer.alloc(Number(before.size));
    for (let position = 0; position < bytes.length;) {
      signal.throwIfAborted();
      const { bytesRead } = await handle.read(bytes, position, Math.min(bytes.length - position, 64 * 1024), position);
      if (!bytesRead) return null;
      position += bytesRead;
    }
    const after = await handle.stat({ bigint: true }), named = await lstat(file, { bigint: true });
    if (!named.isFile() || [after, named].some(value => ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'nlink', 'mode'].some(key => before[key as keyof typeof before] !== value[key as keyof typeof value]))) return null;
    if (await realpath(file) !== file) return null;
    signal.throwIfAborted(); return bytes;
  } catch { if (signal.aborted) throw signal.reason; return null; }
  finally { await handle?.close(); }
}

/**
 * 只供Core私有构造器调用；trustedHashes必须来自编译期审计清单，而非IPC、环境变量或普通配置。
 * 输入缺失/被替换/过期、只含B15或观测漂移都返回null，不签发任何新认证。
 */
export async function readTrustedGateBRecord(input: {
  file: string; trustedHashes: readonly string[]; candidate: GateBCandidateIdentity; now: number; signal: AbortSignal;
}): Promise<{ record: GateBCompleteRecord; recordSha256: string } | null> {
  if (!input.trustedHashes.length || !input.trustedHashes.every(hash) || !validCandidate(input.candidate) || !Number.isFinite(input.now)) return null;
  const bytes = await readPinnedRegularFile(input.file, input.signal);
  if (!bytes) return null;
  const recordSha256 = sha256(bytes);
  if (!input.trustedHashes.includes(recordSha256)) return null;
  const record = parseGateBCompleteRecord(bytes);
  if (!record || record.candidate.commit !== input.candidate.commit || record.candidate.tree !== input.candidate.tree
    || record.candidate.sourceSha256 !== input.candidate.sourceSha256
    || record.candidate.manifestSha256 !== input.candidate.manifestSha256 || record.candidate.helperSha256 !== input.candidate.helperSha256
    || input.now < Date.parse(record.issuedAt) || input.now >= Date.parse(record.validUntil)) return null;
  return { record, recordSha256 };
}

/** 软件身份判断；调用方只能传入已通过受信Hash白名单的记录与独立实时观测。 */
export function matchGateBAdmission(input: {
  trusted: { record: GateBCompleteRecord; recordSha256: string };
  plan: RecordingPlanVersion | null; observed: GateBLiveObservation | null; now: number;
}): GateBAdmission | null {
  const { record, recordSha256 } = input.trusted;
  if (!Number.isFinite(input.now) || input.now < Date.parse(record.issuedAt) || input.now >= Date.parse(record.validUntil)) return null;
  if (input.plan) {
    const expected = input.plan.profileSnapshot.settings.format;
    // 旧计划未冻结精确输出身份，不得由认证记录或当前设备反填后升级为可执行。
    const binding: unknown = (input.plan as RecordingPlanVersion & { outputBinding?: unknown }).outputBinding;
    if (!validPlanBinding(binding) || binding.endpointId !== record.route.endpointId || binding.deviceUid !== record.route.uid
      || binding.backendId !== record.backend.id || binding.backendVersion !== record.backend.version
      || binding.bufferFrames !== record.route.bufferFrames || binding.configurationFingerprintSha256 !== record.configurationFingerprintSha256
      || binding.drainAlgorithmId !== record.drainAlgorithmId) return null;
    if (expected.sampleRate !== record.route.sampleRate || expected.channelCount !== record.route.channelCount
      || expected.outputSampleFormat !== record.route.format || expected.outputBackend.id !== record.backend.id
      || expected.outputBackend.version !== record.backend.version) return null;
  }
  const observed = input.observed;
  if (!observed || !observed.alive || !observed.hasOutput || !isCollectionId(observed.selectionGeneration)
    || observed.configurationFingerprintSha256 !== record.configurationFingerprintSha256
    || observed.backendId !== record.backend.id || observed.backendVersion !== record.backend.version
    || observed.endpointId !== record.route.endpointId || observed.uid !== record.route.uid
    || observed.sampleRate !== record.route.sampleRate || observed.channelCount !== record.route.channelCount
    || observed.format !== record.route.format || observed.physicalFormat !== record.route.physicalFormat
    || observed.bufferFrames !== record.route.bufferFrames) return null;
  return { recordSha256, configurationFingerprintSha256: record.configurationFingerprintSha256,
    endpointId: record.route.endpointId, uid: record.route.uid, selectionGeneration: observed.selectionGeneration,
    validUntil: record.validUntil, helperSha256: record.candidate.helperSha256, route: structuredClone(record.route),
    drainAlgorithmId: record.drainAlgorithmId, drain: structuredClone(record.drain) };
}

/** 生产信任根当前为空；仅重新审计、更新源码白名单并重建后才可接入完整记录。 */
export function createProductionGateBAdmission(options: {
  recordPath: string; candidate: GateBCandidateIdentity | null;
  observeExact(uid: string, signal: AbortSignal): Promise<GateBLiveObservation | null>;
  now?: () => number;
}): GateBAdmissionSource {
  const { recordPath, candidate, observeExact, now = Date.now } = options;
  return {
    async verify(plan, signal) {
      signal.throwIfAborted();
      if (!candidate) return null;
      const trusted = await readTrustedGateBRecord({ file: recordPath, trustedHashes: PRODUCTION_TRUSTED_COMPLETE_RECORD_SHA256, candidate, now: now(), signal });
      if (!trusted) return null;
      const observed = await observeExact(trusted.record.route.uid, signal);
      signal.throwIfAborted();
      return matchGateBAdmission({ trusted, plan, observed, now: now() });
    },
  };
}
