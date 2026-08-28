import type { RenderSide } from './prepared-render.js';

export const MAX_RECORDING_REPLICA_TARGETS = 4;
export const MAX_RECORDING_REPLICA_IDS = 1000;
export const MAX_RECORDING_REPLICA_DURATION_MS = 21_600_000;
export type ReplicaTarget = 'actual-execution' | 'original-render';
export interface ReplicaSelection { recordingId: string; target: ReplicaTarget; side: RenderSide }
export interface ReplicaPcmFormat { container: 'wav'; sampleRate: number; channelCount: 1 | 2; sampleFormat: 'pcm-s16le' | 'pcm-s24le' | 'pcm-s32le' | 'pcm-f32le' }
export type ReplicaAudioIdentity = {
  fileSha256: string; size: number; frameCount: number; format: ReplicaPcmFormat; pcmSha256: string;
} & (
  { target: 'actual-execution'; executionAssetId: string; recipeHash: string; pcmHashEvidence: 'frozen-execution' }
  | { target: 'original-render'; preparedVersionId: string; renderAssetId: string; pcmHashEvidence: 'verified-render-bytes' }
);
export type ReplicaIssue = 'ARCHIVE_UNAVAILABLE' | 'ARCHIVE_CHANGED' | 'RESTORE_UNAVAILABLE' | 'AUTHORIZATION_REVOKED' | 'AUDIO_UNAVAILABLE' | 'AUDIO_CHANGED' | 'UNSUPPORTED_FORMAT' | 'IDENTITY_MISMATCH' | 'DEPENDENCY_UNAVAILABLE' | 'DURATION_LIMIT';
export type ReplicaTargetView = { target: ReplicaTarget; side: RenderSide } & (
  { state: 'verified'; audio: ReplicaAudioIdentity }
  | { state: 'unavailable'; reason: ReplicaIssue }
  | { state: 'empty'; frameCount: 0 }
);
export interface RecordingReplicaStatus { playback: 'blocked'; reason: 'BACKEND_UNAVAILABLE'; deviceAccess: 'not-authorized'; deviceOpened: false; formalReady: false; gateB: 'NOT_RUN' }
export interface InspectRecordingReplicaRequest { readId: string; recordingId: string }
export interface RecordingReplicaReadIdRequest { readId: string }
export interface RecordingReplicaRunIdRequest { runId: string }
export interface ReplicaHistoricalIdentity { recordingId: string; recordingContentHash: string; planVersionId: string; planContentHash: string; archiveOperationId: string; archiveManifestHash: string }
export interface RecordingReplicaInspection extends ReplicaHistoricalIdentity {
  readId: string; checkedAt: string; fingerprint: string; targets: readonly ReplicaTargetView[];
  playback: 'blocked'; deviceOpened: false; formalReady: false; gateB: 'NOT_RUN';
}
export interface StartRecordingReplicaRequest extends ReplicaSelection { runId: string; expectedFingerprint: string; userConfirmed: true }
export interface ReplicaRunIdentity extends ReplicaHistoricalIdentity { target: ReplicaTarget; side: RenderSide; fingerprint: string; audio: ReplicaAudioIdentity }
export interface ReplicaProgress { sourceFramesRead: number; submittedFrames: number; consumedFrames: number; sourceEof: boolean; backendDrained: boolean }
export type ReplicaRunReason = 'CANCELLED' | 'CLOSED' | 'SCOPE_CHANGED' | 'INPUT_INVALID' | 'PROVIDER_FAILED' | 'IDENTITY_MISMATCH' | 'INPUT_UNAVAILABLE' | 'INPUT_CHANGED' | 'AUTHORIZATION_REVOKED' | 'UNSUPPORTED_FORMAT' | 'BACKEND_UNAVAILABLE' | 'FRAME_MISMATCH' | 'TIMEOUT' | 'DURATION_LIMIT';
export type RecordingReplicaRun =
  | { kind: 'cancelled-before-start'; runId: string; state: 'cancelled'; started: false; stopRequested: true; cleanupQuiescent: true; evidence: 'none'; deviceOpened: false; formalReady: false; gateB: 'NOT_RUN' }
  | { kind: 'session'; runId: string; request: StartRecordingReplicaRequest; revision: number; createdAt: string; updatedAt: string;
      state: 'starting' | 'consuming' | 'draining' | 'stopping' | 'finished' | 'cancelled' | 'failed';
      identity: ReplicaRunIdentity | null; progress: ReplicaProgress | null; started: boolean; startedAt?: string; endedAt?: string; reason?: ReplicaRunReason;
      stopRequested: boolean; cleanupQuiescent: boolean; evidence: 'none' | 'synthetic-only'; deviceOpened: false; formalReady: false; gateB: 'NOT_RUN';
    };
export interface RecordingReplicaReadCancellation { readId: string; cancelRequested: true }
export type RecordingReplicaStopResult = RecordingReplicaRun;
export interface RecordingReplicaPublicApi {
  getRecordingReplicaStatus(): Promise<RecordingReplicaStatus>;
  inspectRecordingReplica(request: InspectRecordingReplicaRequest): Promise<RecordingReplicaInspection>;
  cancelRecordingReplicaRead(readId: string): Promise<RecordingReplicaReadCancellation>;
  startRecordingReplica(request: StartRecordingReplicaRequest): Promise<RecordingReplicaRun>;
  getRecordingReplicaRun(runId: string): Promise<{ run: RecordingReplicaRun | null }>;
  stopRecordingReplica(runId: string): Promise<RecordingReplicaStopResult>;
}


const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const keys = (v: Record<string, unknown>, allowed: readonly string[]): boolean => Object.keys(v).every(key => allowed.includes(key));
const uuid = (v: unknown): v is string => typeof v === 'string' && v.length === 36 && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(v);
const hash = (v: unknown): v is string => typeof v === 'string' && v.length === 64 && /^[a-f0-9]{64}$/u.test(v);
const integer = (v: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max;
const date = (v: unknown): v is string => typeof v === 'string' && v.length === 24 && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
const target = (v: unknown): v is ReplicaTarget => v === 'actual-execution' || v === 'original-render';
const side = (v: unknown): v is RenderSide => v === 'A' || v === 'B' || v === 'Program';
const safetyKeys = ['deviceOpened', 'formalReady', 'gateB'];
const safe = (v: Record<string, unknown>): boolean => v.deviceOpened === false && v.formalReady === false && v.gateB === 'NOT_RUN';
const issues: readonly ReplicaIssue[] = ['ARCHIVE_UNAVAILABLE', 'ARCHIVE_CHANGED', 'RESTORE_UNAVAILABLE', 'AUTHORIZATION_REVOKED', 'AUDIO_UNAVAILABLE', 'AUDIO_CHANGED', 'UNSUPPORTED_FORMAT', 'IDENTITY_MISMATCH', 'DEPENDENCY_UNAVAILABLE', 'DURATION_LIMIT'];
const reasons: readonly ReplicaRunReason[] = ['CANCELLED', 'CLOSED', 'SCOPE_CHANGED', 'INPUT_INVALID', 'PROVIDER_FAILED', 'IDENTITY_MISMATCH', 'INPUT_UNAVAILABLE', 'INPUT_CHANGED', 'AUTHORIZATION_REVOKED', 'UNSUPPORTED_FORMAT', 'BACKEND_UNAVAILABLE', 'FRAME_MISMATCH', 'TIMEOUT', 'DURATION_LIMIT'];
const historyKeys = ['recordingId', 'recordingContentHash', 'planVersionId', 'planContentHash', 'archiveOperationId', 'archiveManifestHash'];
function historical(v: Record<string, unknown>): boolean {
  return ['recordingId', 'planVersionId', 'archiveOperationId'].every(key => uuid(v[key])) && ['recordingContentHash', 'planContentHash', 'archiveManifestHash'].every(key => hash(v[key]));
}
function selected(v: Record<string, unknown>): boolean { return uuid(v.recordingId) && target(v.target) && side(v.side); }
export function isReplicaPcmFormat(v: unknown): v is ReplicaPcmFormat {
  return record(v) && keys(v, ['container', 'sampleRate', 'channelCount', 'sampleFormat']) && v.container === 'wav' && integer(v.sampleRate, 8000, 384000)
    && (v.channelCount === 1 || v.channelCount === 2) && typeof v.sampleFormat === 'string' && ['pcm-s16le', 'pcm-s24le', 'pcm-s32le', 'pcm-f32le'].includes(v.sampleFormat);
}
/** 这里只验证有界形状与数学关系，文件Hash、授权及实际FD由Core复核。 */
export function isReplicaAudioIdentity(v: unknown): v is ReplicaAudioIdentity {
  if (!record(v) || !hash(v.fileSha256) || !hash(v.pcmSha256) || !integer(v.size, 44, 0xffffffff + 8) || !integer(v.frameCount, 1) || !isReplicaPcmFormat(v.format)) return false;
  const bytes = v.format.sampleFormat === 'pcm-s16le' ? 2 : v.format.sampleFormat === 'pcm-s24le' ? 3 : 4;
  if (BigInt(v.frameCount) * 1000n > BigInt(v.format.sampleRate) * BigInt(MAX_RECORDING_REPLICA_DURATION_MS)
    || BigInt(v.frameCount) * BigInt(v.format.channelCount * bytes) + 44n > BigInt(v.size)) return false;
  const common = ['target', 'fileSha256', 'size', 'frameCount', 'format', 'pcmSha256', 'pcmHashEvidence'];
  if (v.target === 'actual-execution') return keys(v, [...common, 'executionAssetId', 'recipeHash']) && uuid(v.executionAssetId) && hash(v.recipeHash) && v.pcmHashEvidence === 'frozen-execution';
  return v.target === 'original-render' && keys(v, [...common, 'preparedVersionId', 'renderAssetId']) && uuid(v.preparedVersionId) && uuid(v.renderAssetId) && v.pcmHashEvidence === 'verified-render-bytes';
}
export function isReplicaTargetView(v: unknown): v is ReplicaTargetView {
  if (!record(v) || !target(v.target) || !side(v.side)) return false;
  if (v.state === 'verified') return keys(v, ['target', 'side', 'state', 'audio']) && isReplicaAudioIdentity(v.audio) && v.audio.target === v.target;
  if (v.state === 'empty') return keys(v, ['target', 'side', 'state', 'frameCount']) && v.side === 'B' && v.frameCount === 0;
  return v.state === 'unavailable' && keys(v, ['target', 'side', 'state', 'reason']) && issues.includes(v.reason as ReplicaIssue);
}
export function isRecordingReplicaStatus(v: unknown): v is RecordingReplicaStatus {
  return record(v) && keys(v, ['playback', 'reason', 'deviceAccess', ...safetyKeys]) && v.playback === 'blocked' && v.reason === 'BACKEND_UNAVAILABLE' && v.deviceAccess === 'not-authorized' && safe(v);
}
export function isInspectRecordingReplicaRequest(v: unknown): v is InspectRecordingReplicaRequest { return record(v) && keys(v, ['readId', 'recordingId']) && uuid(v.readId) && uuid(v.recordingId); }
export function isRecordingReplicaReadIdRequest(v: unknown): v is RecordingReplicaReadIdRequest { return record(v) && keys(v, ['readId']) && uuid(v.readId); }
export function isRecordingReplicaRunIdRequest(v: unknown): v is RecordingReplicaRunIdRequest { return record(v) && keys(v, ['runId']) && uuid(v.runId); }
export function isStartRecordingReplicaRequest(v: unknown): v is StartRecordingReplicaRequest {
  return record(v) && keys(v, ['runId', 'recordingId', 'target', 'side', 'expectedFingerprint', 'userConfirmed']) && uuid(v.runId) && selected(v) && hash(v.expectedFingerprint) && v.userConfirmed === true;
}
export function isRecordingReplicaInspection(v: unknown): v is RecordingReplicaInspection {
  if (!record(v) || !keys(v, [...historyKeys, 'readId', 'checkedAt', 'fingerprint', 'targets', 'playback', ...safetyKeys]) || !historical(v) || !uuid(v.readId)
    || !date(v.checkedAt) || !hash(v.fingerprint) || v.playback !== 'blocked' || !safe(v) || !Array.isArray(v.targets) || v.targets.length < 1 || v.targets.length > MAX_RECORDING_REPLICA_TARGETS || !v.targets.every(isReplicaTargetView)) return false;
  const values = v.targets, actual = values.filter(item => item.target === 'actual-execution'), original = values.filter(item => item.target === 'original-render');
  const topology = (items: readonly ReplicaTargetView[]): boolean => items.length === 1 && items[0]!.side === 'Program' || items.length === 2 && items[0]!.side === 'A' && items[1]!.side === 'B';
  return topology(actual) && (original.length === 0 || topology(original) && original.length === actual.length && original.every((item, index) => item.side === actual[index]!.side && (item.state === 'empty') === (actual[index]!.state === 'empty')))
    && values.every((item, index) => item === [...actual, ...original][index]);
}
export function isReplicaRunIdentity(v: unknown): v is ReplicaRunIdentity {
  return record(v) && keys(v, [...historyKeys, 'target', 'side', 'fingerprint', 'audio']) && historical(v) && target(v.target) && side(v.side) && hash(v.fingerprint) && isReplicaAudioIdentity(v.audio) && v.audio.target === v.target;
}
function progress(v: unknown, frameCount: number): v is ReplicaProgress {
  return record(v) && keys(v, ['sourceFramesRead', 'submittedFrames', 'consumedFrames', 'sourceEof', 'backendDrained']) && integer(v.sourceFramesRead, 0, frameCount)
    && integer(v.submittedFrames, 0, v.sourceFramesRead) && integer(v.consumedFrames, 0, v.submittedFrames) && typeof v.sourceEof === 'boolean' && typeof v.backendDrained === 'boolean'
    && (!v.sourceEof || v.sourceFramesRead === frameCount) && (!v.backendDrained || v.sourceEof && v.submittedFrames === frameCount && v.consumedFrames === frameCount);
}
/** 合成完成不是用户播放；当前公开合同无设备输出或认证成功分支。 */
export function isRecordingReplicaRun(v: unknown): v is RecordingReplicaRun {
  if (!record(v) || !uuid(v.runId) || !safe(v)) return false;
  if (v.kind === 'cancelled-before-start') return keys(v, ['kind', 'runId', 'state', 'started', 'stopRequested', 'cleanupQuiescent', 'evidence', ...safetyKeys]) && v.state === 'cancelled' && v.started === false && v.stopRequested === true && v.cleanupQuiescent === true && v.evidence === 'none';
  if (v.kind !== 'session' || !keys(v, ['kind', 'runId', 'request', 'revision', 'createdAt', 'updatedAt', 'state', 'identity', 'progress', 'started', 'startedAt', 'endedAt', 'reason', 'stopRequested', 'cleanupQuiescent', 'evidence', ...safetyKeys])
    || !isStartRecordingReplicaRequest(v.request) || v.request.runId !== v.runId || !integer(v.revision, 1) || !date(v.createdAt) || !date(v.updatedAt) || v.updatedAt < v.createdAt
    || typeof v.started !== 'boolean' || typeof v.stopRequested !== 'boolean' || typeof v.cleanupQuiescent !== 'boolean' || !['none', 'synthetic-only'].includes(String(v.evidence))) return false;
  if (v.identity !== null && (!isReplicaRunIdentity(v.identity) || v.identity.recordingId !== v.request.recordingId || v.identity.target !== v.request.target || v.identity.side !== v.request.side || v.identity.fingerprint !== v.request.expectedFingerprint)) return false;
  const identity = v.identity as ReplicaRunIdentity | null;
  if (v.progress !== null && (!identity || !progress(v.progress, identity.audio.frameCount))) return false;
  const facts = v.progress as ReplicaProgress | null;
  if (v.started) {
    if (!identity || !facts || !date(v.startedAt) || v.startedAt < v.createdAt || v.startedAt > v.updatedAt || v.evidence !== 'synthetic-only') return false;
  } else if (v.startedAt !== undefined || v.evidence !== 'none' || facts && (facts.sourceFramesRead !== 0 || facts.submittedFrames !== 0 || facts.consumedFrames !== 0 || facts.sourceEof || facts.backendDrained)) return false;
  const terminal = v.state === 'finished' || v.state === 'cancelled' || v.state === 'failed';
  if (terminal) {
    if (!v.cleanupQuiescent || !date(v.endedAt) || v.endedAt < v.createdAt || v.endedAt > v.updatedAt || v.startedAt !== undefined && v.endedAt < String(v.startedAt)) return false;
  } else if (v.endedAt !== undefined || v.cleanupQuiescent) return false;
  if (v.state === 'finished') return v.started && !v.stopRequested && v.reason === undefined && !!facts && facts.sourceEof && facts.backendDrained && facts.consumedFrames === identity!.audio.frameCount;
  if (v.state === 'cancelled') return v.stopRequested && v.reason === 'CANCELLED';
  if (v.state === 'failed') return reasons.includes(v.reason as ReplicaRunReason) && v.reason !== 'CANCELLED';
  if (v.state === 'stopping') return v.stopRequested && reasons.includes(v.reason as ReplicaRunReason);
  if (v.reason !== undefined || v.stopRequested) return false;
  if (v.state === 'starting') return !v.started;
  if (v.state === 'consuming') return v.started;
  return v.state === 'draining' && v.started && !!facts && facts.sourceEof && facts.submittedFrames === identity!.audio.frameCount;
}
export function isRecordingReplicaReadCancellation(v: unknown): v is RecordingReplicaReadCancellation { return record(v) && keys(v, ['readId', 'cancelRequested']) && uuid(v.readId) && v.cancelRequested === true; }
