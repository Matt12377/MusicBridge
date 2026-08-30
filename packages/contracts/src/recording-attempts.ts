import { isCollectionId, isPhysicalId } from './collection.js';
import { isRenderSide, type RenderSide } from './prepared-render.js';
import type { Page, PageRequest } from './library.js';

export const MAX_RECORDING_ATTEMPT_PAGE_SIZE = 25;
export type RecordingAttemptStatus = 'in-progress' | 'completed' | 'aborted' | 'failed' | 'interrupted';
export type RecordingAttemptPhase = 'outputting' | 'draining' | 'awaiting-physical-stop' | 'awaiting-flip' | 'awaiting-side-b' | 'final-verification' | 'finished';
export type RecordingAttemptSidePhase = 'pending' | 'outputting' | 'draining' | 'awaiting-physical-stop' | 'complete' | 'aborted' | 'failed' | 'interrupted';
export type RecordingAttemptEndReason = 'user-stop' | 'backend-start-failed' | 'backend-failure' | 'external-track-change' | 'zone-changed' | 'device-lost' | 'route-changed' | 'format-changed' | 'source-read-failed' | 'underrun' | 'app-restarted' | 'backend-timeout' | 'plan-changed' | 'protocol-error';
/** 领域错误不是PublicErrorCode；IPC层必须映射到已有有界公开错误。 */
export type RecordingAttemptErrorCode = 'BACKEND_NOT_CERTIFIED' | 'INVALID_REQUEST' | 'PLAN_UNAVAILABLE' | 'PLAN_CHANGED' | 'COPY_UNAVAILABLE' | 'ATTEMPT_NOT_FOUND' | 'ATTEMPT_CONFLICT' | 'VERSION_MISMATCH' | 'INVALID_TRANSITION' | 'COMMAND_CONFLICT' | 'BUDGET_EXCEEDED' | 'CLOSED' | 'IO_ERROR' | 'BACKEND_FAILURE';
export type RecordingAttemptConfirmation = 'physical-stop' | 'flip' | 'physical-recording' | 'final-verification';

export interface RecordingAttemptSide {
  side: RenderSide; phase: RecordingAttemptSidePhase;
  frameCount: number; recipeHash: string; audioSha256: string; pcmSha256: string;
  runId?: string;
  sourceFramesRead: number; submittedFrames: number; consumedFrames: number;
  sourceEof: boolean; backendDrained: boolean;
  engineStoppedSubmitting: boolean; stopAcknowledged: boolean; cleanupQuiescent: boolean;
  startedAt?: string; endedAt?: string; physicalStopConfirmedAt?: string; reason?: RecordingAttemptEndReason;
}
/** 仅正式历史格式；结构有效不构成认证或新的执行准入。Setup/Test不得写入此历史。 */
export interface RecordingAttempt {
  kind: 'formal'; id: string; draftId: string; planVersionId: string; planContentHash: string;
  executionAssetId: string; physicalId: string;
  revision: number; createdAt: string; updatedAt: string; endedAt?: string;
  status: RecordingAttemptStatus; phase: RecordingAttemptPhase; activeSide?: RenderSide;
  sides: readonly RecordingAttemptSide[]; softwarePlaybackComplete: boolean;
  flipConfirmedAt?: string; physicalRecordingConfirmedAt?: string; finalVerificationCompleteAt?: string;
  reason?: RecordingAttemptEndReason;
}
export interface ListRecordingAttemptsRequest { page: PageRequest; draftId?: string; planVersionId?: string; physicalId?: string }
export interface RecordingAttemptIdRequest { attemptId: string }
export interface BeginRecordingAttemptRequest { commandId: string; planVersionId: string; planContentHash: string; userConfirmed: true }
export type ConfirmRecordingAttemptRequest = {
  commandId: string; attemptId: string; expectedRevision: number; userConfirmed: true;
} & ({ kind: 'physical-stop'; side: RenderSide } | { kind: 'flip' | 'physical-recording' | 'final-verification' });
export interface BeginRecordingAttemptSideRequest { commandId: string; attemptId: string; expectedRevision: number; side: 'B'; userConfirmed: true }
/** 不以运行进度revision挡住停止，也不能选择最新Attempt或替代设备。 */
export interface StopRecordingAttemptRequest { commandId: string; attemptId: string }
export type RecordingAttemptsPage = Page<RecordingAttempt>;
export interface RecordingAttemptsPublicApi {
  listRecordingAttempts(request: ListRecordingAttemptsRequest): Promise<RecordingAttemptsPage>;
  getRecordingAttempt(attemptId: string): Promise<{ attempt: RecordingAttempt | null }>;
  beginRecordingAttempt(request: BeginRecordingAttemptRequest): Promise<RecordingAttempt>;
  confirmRecordingAttempt(request: ConfirmRecordingAttemptRequest): Promise<RecordingAttempt>;
  beginRecordingAttemptSide(request: BeginRecordingAttemptSideRequest): Promise<RecordingAttempt>;
  stopRecordingAttempt(request: StopRecordingAttemptRequest): Promise<RecordingAttempt>;
}

const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const keys = (v: Record<string, unknown>, allowed: readonly string[]): boolean => Object.keys(v).every(key => allowed.includes(key));
const integer = (v: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max;
const uuid = (v: unknown): v is string => typeof v === 'string' && v.length === 36 && isCollectionId(v);
const physical = (v: unknown): v is string => typeof v === 'string' && v.trim() === v && isPhysicalId(v);
const hash = (v: unknown): v is string => typeof v === 'string' && v.length === 64 && /^[a-f0-9]{64}$/u.test(v);
const date = (v: unknown): v is string => typeof v === 'string' && v.length === 24 && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
const reasons: readonly RecordingAttemptEndReason[] = ['user-stop', 'backend-start-failed', 'backend-failure', 'external-track-change', 'zone-changed', 'device-lost', 'route-changed', 'format-changed', 'source-read-failed', 'underrun', 'app-restarted', 'backend-timeout', 'plan-changed', 'protocol-error'];
const reason = (v: unknown): v is RecordingAttemptEndReason => typeof v === 'string' && (reasons as readonly string[]).includes(v);
function terminalReason(status: unknown, value: unknown): boolean {
  return reason(value) && (status === 'aborted' ? value === 'user-stop' : status === 'failed' ? value === 'backend-start-failed'
    : status === 'interrupted' && value !== 'user-stop' && value !== 'backend-start-failed');
}
const activePhases = ['outputting', 'draining', 'awaiting-physical-stop'] as const;
const terminalSides = ['complete', 'aborted', 'failed', 'interrupted'] as const;
const boolKeys = ['sourceEof', 'backendDrained', 'engineStoppedSubmitting', 'stopAcknowledged', 'cleanupQuiescent'] as const;
const sideKeys = ['side', 'phase', 'frameCount', 'recipeHash', 'audioSha256', 'pcmSha256', 'runId', 'sourceFramesRead', 'submittedFrames', 'consumedFrames', ...boolKeys, 'startedAt', 'endedAt', 'physicalStopConfirmedAt', 'reason'];
const attemptKeys = ['kind', 'id', 'draftId', 'planVersionId', 'planContentHash', 'executionAssetId', 'physicalId', 'revision', 'createdAt', 'updatedAt', 'endedAt', 'status', 'phase', 'activeSide', 'sides', 'softwarePlaybackComplete', 'flipConfirmedAt', 'physicalRecordingConfirmedAt', 'finalVerificationCompleteAt', 'reason'];
function page(v: unknown): v is PageRequest { return record(v) && keys(v, ['offset', 'limit']) && integer(v.offset) && integer(v.limit, 1, MAX_RECORDING_ATTEMPT_PAGE_SIZE); }
const softwareComplete = (side: RecordingAttemptSide): boolean => side.sourceEof && side.backendDrained && side.submittedFrames === side.frameCount && side.consumedFrames === side.frameCount;

export function isListRecordingAttemptsRequest(v: unknown): v is ListRecordingAttemptsRequest {
  return record(v) && keys(v, ['page', 'draftId', 'planVersionId', 'physicalId']) && page(v.page)
    && (v.draftId === undefined || uuid(v.draftId)) && (v.planVersionId === undefined || uuid(v.planVersionId)) && (v.physicalId === undefined || physical(v.physicalId));
}
export function isRecordingAttemptIdRequest(v: unknown): v is RecordingAttemptIdRequest { return record(v) && keys(v, ['attemptId']) && uuid(v.attemptId); }
export function isBeginRecordingAttemptRequest(v: unknown): v is BeginRecordingAttemptRequest { return record(v) && keys(v, ['commandId', 'planVersionId', 'planContentHash', 'userConfirmed']) && uuid(v.commandId) && uuid(v.planVersionId) && hash(v.planContentHash) && v.userConfirmed === true; }
export function isConfirmRecordingAttemptRequest(v: unknown): v is ConfirmRecordingAttemptRequest {
  if (!record(v) || !uuid(v.commandId) || !uuid(v.attemptId) || !integer(v.expectedRevision, 1) || v.userConfirmed !== true) return false;
  const common = ['commandId', 'attemptId', 'expectedRevision', 'userConfirmed', 'kind'];
  return v.kind === 'physical-stop' ? keys(v, [...common, 'side']) && isRenderSide(v.side)
    : keys(v, common) && (v.kind === 'flip' || v.kind === 'physical-recording' || v.kind === 'final-verification');
}
export function isBeginRecordingAttemptSideRequest(v: unknown): v is BeginRecordingAttemptSideRequest { return record(v) && keys(v, ['commandId', 'attemptId', 'expectedRevision', 'side', 'userConfirmed']) && uuid(v.commandId) && uuid(v.attemptId) && integer(v.expectedRevision, 1) && v.side === 'B' && v.userConfirmed === true; }
export function isStopRecordingAttemptRequest(v: unknown): v is StopRecordingAttemptRequest { return record(v) && keys(v, ['commandId', 'attemptId']) && uuid(v.commandId) && uuid(v.attemptId); }

export function isRecordingAttemptSide(v: unknown): v is RecordingAttemptSide {
  if (!record(v) || !keys(v, sideKeys) || !isRenderSide(v.side) || !integer(v.frameCount, 1) || !hash(v.recipeHash) || !hash(v.audioSha256) || !hash(v.pcmSha256)
    || !integer(v.sourceFramesRead, 0, v.frameCount) || !integer(v.submittedFrames, 0, v.sourceFramesRead) || !integer(v.consumedFrames, 0, v.submittedFrames)
    || !boolKeys.every(key => typeof v[key] === 'boolean')) return false;
  if (v.sourceEof && v.sourceFramesRead !== v.frameCount || v.backendDrained && (!v.sourceEof || v.submittedFrames !== v.frameCount || v.consumedFrames !== v.frameCount)) return false;
  if (v.phase === 'pending') return !boolKeys.some(key => v[key]) && v.sourceFramesRead === 0 && v.submittedFrames === 0 && v.consumedFrames === 0
    && ['runId', 'startedAt', 'endedAt', 'physicalStopConfirmedAt', 'reason'].every(key => v[key] === undefined);
  if (!uuid(v.runId) || !date(v.startedAt) || (v.endedAt !== undefined && (!date(v.endedAt) || v.endedAt < v.startedAt))
    || (v.physicalStopConfirmedAt !== undefined && (!date(v.physicalStopConfirmedAt) || v.physicalStopConfirmedAt < v.startedAt))) return false;
  if ((activePhases as readonly unknown[]).includes(v.phase)) {
    if (v.reason !== undefined || v.endedAt !== undefined || v.physicalStopConfirmedAt !== undefined) return false;
    if (v.phase === 'outputting') return !v.sourceEof && !v.backendDrained;
    if (v.phase === 'draining') return v.sourceEof === true && v.backendDrained === false;
    return v.sourceEof === true && v.backendDrained === true;
  }
  if (!(terminalSides as readonly unknown[]).includes(v.phase) || !date(v.endedAt)) return false;
  if (v.phase === 'complete') return v.reason === undefined && v.sourceEof === true && v.backendDrained === true && v.engineStoppedSubmitting === true
    && date(v.physicalStopConfirmedAt) && v.physicalStopConfirmedAt <= v.endedAt;
  return terminalReason(v.phase, v.reason);
}

export function isRecordingAttempt(v: unknown): v is RecordingAttempt {
  if (!record(v) || !keys(v, attemptKeys) || v.kind !== 'formal' || !['id', 'draftId', 'planVersionId', 'executionAssetId'].every(key => uuid(v[key]))
    || !hash(v.planContentHash) || !physical(v.physicalId) || !integer(v.revision, 1) || !date(v.createdAt) || !date(v.updatedAt) || v.updatedAt < v.createdAt
    || !Array.isArray(v.sides) || v.sides.length < 1 || v.sides.length > 2 || !v.sides.every(isRecordingAttemptSide) || typeof v.softwarePlaybackComplete !== 'boolean') return false;
  const sides = v.sides, first = sides[0], second = sides[1];
  if (!first || !(sides.length === 1 && (first.side === 'A' || first.side === 'Program') || sides.length === 2 && first.side === 'A' && second?.side === 'B')) return false;
  const runs = sides.flatMap(side => side.runId ? [side.runId] : []);
  if (new Set(runs).size !== runs.length || first.phase === 'pending') return false;
  if (sides.some(side => [side.startedAt, side.endedAt, side.physicalStopConfirmedAt].some(time => time !== undefined && (time < v.createdAt! || time > v.updatedAt!)))) return false;
  for (const key of ['endedAt', 'flipConfirmedAt', 'physicalRecordingConfirmedAt', 'finalVerificationCompleteAt']) {
    const time = v[key]; if (time !== undefined && (!date(time) || time < v.createdAt || time > v.updatedAt)) return false;
  }
  if (v.flipConfirmedAt !== undefined && (!date(v.flipConfirmedAt) || !second || first.phase !== 'complete' || !first.physicalStopConfirmedAt || v.flipConfirmedAt < first.physicalStopConfirmedAt)) return false;
  if (second && second.phase !== 'pending' && (first.phase !== 'complete' || !date(v.flipConfirmedAt) || !second.startedAt || second.startedAt < v.flipConfirmedAt)) return false;
  if (v.softwarePlaybackComplete !== sides.every(softwareComplete)) return false;
  const allComplete = sides.every(side => side.phase === 'complete');
  if (v.physicalRecordingConfirmedAt !== undefined && (!allComplete || sides.some(side => side.endedAt! > v.physicalRecordingConfirmedAt!))) return false;
  if (v.finalVerificationCompleteAt !== undefined && (!date(v.finalVerificationCompleteAt) || !date(v.physicalRecordingConfirmedAt) || v.finalVerificationCompleteAt < v.physicalRecordingConfirmedAt)) return false;
  if (v.status === 'in-progress') {
    if (v.reason !== undefined || v.endedAt !== undefined || v.finalVerificationCompleteAt !== undefined) return false;
    if ((activePhases as readonly unknown[]).includes(v.phase)) {
      const active = sides.filter(side => (activePhases as readonly string[]).includes(side.phase));
      return active.length === 1 && active[0]!.side === v.activeSide && active[0]!.phase === v.phase
        && sides.every(side => side === active[0] || side.phase === 'pending' || side.phase === 'complete');
    }
    if (v.activeSide !== undefined) return false;
    if (v.phase === 'final-verification') return allComplete;
    if (v.phase === 'awaiting-flip' || v.phase === 'awaiting-side-b') return !!second && first.phase === 'complete' && second.phase === 'pending'
      && (v.phase === 'awaiting-flip' ? v.flipConfirmedAt === undefined : date(v.flipConfirmedAt));
    return false;
  }
  if (v.phase !== 'finished' || v.activeSide !== undefined || !date(v.endedAt) || sides.some(side => (activePhases as readonly string[]).includes(side.phase))) return false;
  if (sides.some(side => side.endedAt !== undefined && side.endedAt > v.endedAt!)) return false;
  if (v.status === 'completed') return allComplete && v.softwarePlaybackComplete === true && v.reason === undefined
    && date(v.physicalRecordingConfirmedAt) && date(v.finalVerificationCompleteAt) && v.endedAt >= v.finalVerificationCompleteAt;
  return terminalReason(v.status, v.reason) && sides.every(side => side.phase === 'pending' || side.phase === 'complete' || side.phase === v.status && side.reason === v.reason);
}

export function isRecordingAttemptsPage(v: unknown): v is RecordingAttemptsPage {
  if (!record(v) || !keys(v, ['items', 'offset', 'limit', 'total', 'hasMore']) || !page({ offset: v.offset, limit: v.limit }) || !integer(v.total)
    || !Array.isArray(v.items) || v.items.length > MAX_RECORDING_ATTEMPT_PAGE_SIZE || !v.items.every(isRecordingAttempt)) return false;
  const offset = v.offset as number, limit = v.limit as number;
  return v.items.length <= Math.min(limit, Math.max(0, v.total - offset)) && new Set(v.items.map(item => item.id)).size === v.items.length
    && v.hasMore === (offset < v.total && v.items.length < v.total - offset);
}
