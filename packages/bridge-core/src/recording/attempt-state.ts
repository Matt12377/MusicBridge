import { isCollectionId, isPhysicalId, isRecordingAttempt, type RecordingAttempt, type RecordingAttemptSide, type RecordingAttemptEndReason, type RecordingAttemptErrorCode, type RecordingPlanVersion, type RenderSide } from '@music-bridge/contracts';

/** 这里只构造领域事实；准入、Plan完整性、时钟、UUID和事务由调用Core负责，不触发输出。 */
export interface BeginRecordingAttemptInput {
  id: string; generation: string; startedAt: string;
  plan: Pick<RecordingPlanVersion, 'id' | 'draftId' | 'contentHash'> & {
    physicalCopy: Pick<RecordingPlanVersion['physicalCopy'], 'physicalId'>;
    execution: Pick<RecordingPlanVersion['execution'], 'assetId'> & {
      audio: readonly { recipe: { side: RenderSide }; recipeHash: string; audio: { frameCount: number; sha256: string; pcmSha256: string } }[];
    };
  };
}
type OutputIdentity = { side: RenderSide; runId: string; at: string };
type InterruptReason = Exclude<RecordingAttemptEndReason, 'user-stop' | 'backend-start-failed' | 'app-restarted'>;
/** 仅Core内部可信事件；不能注册为Renderer可提交的IPC。 */
export type RecordingAttemptEvent =
  | (OutputIdentity & { type: 'progress'; sourceFramesRead: number; submittedFrames: number; consumedFrames: number })
  | (OutputIdentity & { type: 'source-eof' | 'backend-drained' | 'engine-cutoff' | 'stop-ack' | 'cleanup-quiescent' })
  | (OutputIdentity & { type: 'interrupt'; reason: InterruptReason })
  | (OutputIdentity & { type: 'fail'; reason: 'backend-start-failed' })
  | { type: 'abort'; reason: 'user-stop'; at: string }
  | { type: 'recover'; at: string }
  | { type: 'begin-side'; side: 'B'; runId: string; at: string }
  | { type: 'confirm'; kind: 'physical-stop'; side: RenderSide; at: string }
  | { type: 'confirm'; kind: 'flip' | 'physical-recording' | 'final-verification'; at: string };

export class RecordingAttemptStateError extends Error {
  constructor(readonly code: Extract<RecordingAttemptErrorCode, 'INVALID_REQUEST' | 'INVALID_TRANSITION'>) {
    super(`录音状态转换未通过，已有事实保留。 [${code}]`);
  }
}
const invalid = (code: 'INVALID_REQUEST' | 'INVALID_TRANSITION' = 'INVALID_TRANSITION'): never => { throw new RecordingAttemptStateError(code); };
const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const keys = (v: Record<string, unknown>, allowed: readonly string[]) => Object.keys(v).every(k => allowed.includes(k));
const natural = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const date = (v: unknown): v is string => typeof v === 'string' && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
const hash = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/u.test(v);
const side = (v: unknown): v is RenderSide => v === 'A' || v === 'B' || v === 'Program';
const interrupts: readonly InterruptReason[] = ['backend-failure', 'external-track-change', 'zone-changed', 'device-lost', 'route-changed', 'format-changed', 'source-read-failed', 'underrun', 'backend-timeout', 'plan-changed', 'protocol-error'];

export function isRecordingAttemptEvent(v: unknown): v is RecordingAttemptEvent {
  if (!record(v) || !date(v.at)) return false;
  if (v.type === 'recover') return keys(v, ['type', 'at']);
  if (v.type === 'abort') return keys(v, ['type', 'at', 'reason']) && v.reason === 'user-stop';
  if (v.type === 'confirm') return v.kind === 'physical-stop'
    ? keys(v, ['type', 'at', 'kind', 'side']) && side(v.side)
    : keys(v, ['type', 'at', 'kind']) && (v.kind === 'flip' || v.kind === 'physical-recording' || v.kind === 'final-verification');
  if (!side(v.side) || !isCollectionId(v.runId)) return false;
  const identity = ['type', 'at', 'side', 'runId'];
  if (v.type === 'begin-side') return keys(v, identity) && v.side === 'B';
  if (v.type === 'progress') return keys(v, [...identity, 'sourceFramesRead', 'submittedFrames', 'consumedFrames'])
    && natural(v.sourceFramesRead) && natural(v.submittedFrames) && natural(v.consumedFrames)
    && v.consumedFrames <= v.submittedFrames && v.submittedFrames <= v.sourceFramesRead;
  if (v.type === 'fail') return keys(v, [...identity, 'reason']) && v.reason === 'backend-start-failed';
  if (v.type === 'interrupt') return keys(v, [...identity, 'reason']) && interrupts.includes(v.reason as InterruptReason);
  return ['source-eof', 'backend-drained', 'engine-cutoff', 'stop-ack', 'cleanup-quiescent'].includes(v.type as string) && keys(v, identity);
}

function checked(state: RecordingAttempt): RecordingAttempt {
  if (!isRecordingAttempt(state)) return invalid('INVALID_REQUEST');
  return state;
}
export function beginRecordingAttempt(input: BeginRecordingAttemptInput): RecordingAttempt {
  const { id, generation, startedAt, plan } = input;
  if (!isCollectionId(id) || !isCollectionId(generation) || !date(startedAt) || !plan
    || !isCollectionId(plan.id) || !isCollectionId(plan.draftId) || !hash(plan.contentHash)
    || !isPhysicalId(plan.physicalCopy?.physicalId) || !isCollectionId(plan.execution?.assetId)
    || !Array.isArray(plan.execution.audio)) return invalid('INVALID_REQUEST');
  const audio = plan.execution.audio;
  if (!(audio.length === 1 && (audio[0]?.recipe.side === 'A' || audio[0]?.recipe.side === 'Program')
    || audio.length === 2 && audio[0]?.recipe.side === 'A' && audio[1]?.recipe.side === 'B')
    || audio.some(a => !natural(a.audio.frameCount) || a.audio.frameCount < 1 || !hash(a.audio.sha256) || !hash(a.audio.pcmSha256) || !hash(a.recipeHash))) return invalid('INVALID_REQUEST');
  const sides: RecordingAttemptSide[] = audio.map((a, index) => ({
    side: a.recipe.side, frameCount: a.audio.frameCount, recipeHash: a.recipeHash, audioSha256: a.audio.sha256, pcmSha256: a.audio.pcmSha256,
    phase: index === 0 ? 'outputting' : 'pending', ...(index === 0 ? { runId: generation, startedAt } : {}),
    sourceFramesRead: 0, submittedFrames: 0, consumedFrames: 0, sourceEof: false, backendDrained: false,
    engineStoppedSubmitting: false, stopAcknowledged: false, cleanupQuiescent: false,
  }));
  return checked({ kind: 'formal', id, draftId: plan.draftId, planVersionId: plan.id, planContentHash: plan.contentHash,
    executionAssetId: plan.execution.assetId, physicalId: plan.physicalCopy.physicalId,
    revision: 1, createdAt: startedAt, updatedAt: startedAt, status: 'in-progress', phase: 'outputting', activeSide: sides[0]!.side,
    sides, softwarePlaybackComplete: false });
}

/** 不读取时间或调用driver；幂等回执/事件去重在store，同值单调事实在此不增revision。 */
export function reduceRecordingAttempt(current: RecordingAttempt, event: RecordingAttemptEvent): RecordingAttempt {
  checked(current);
  if (!isRecordingAttemptEvent(event)) return invalid('INVALID_REQUEST');
  const cleanup = event.type === 'engine-cutoff' || event.type === 'stop-ack' || event.type === 'cleanup-quiescent';
  const incoming = 'runId' in event && event.type !== 'begin-side' ? current.sides.find(s => s.side === event.side && s.runId === event.runId) : undefined;
  // 旧代际先失效，不能以它的时间、帧值或终因改变当前会话。
  if ('runId' in event && event.type !== 'begin-side' && !incoming) return current;
  const terminalPhysicalStop = current.status !== 'in-progress' && event.type === 'confirm' && event.kind === 'physical-stop';
  if (current.status !== 'in-progress' && !cleanup && !terminalPhysicalStop) {
    if (event.type === 'confirm' || event.type === 'begin-side') return invalid();
    return current;
  }
  if (incoming && !cleanup && current.status === 'in-progress') {
    const relevantSide = event.type === 'fail' || event.type === 'interrupt'
      ? current.activeSide ?? [...current.sides].reverse().find(s => s.runId !== undefined)?.side
      : current.activeSide;
    if (incoming.side !== relevantSide) return current;
  }
  if (Date.parse(event.at) < Date.parse(current.updatedAt)) return invalid('INVALID_REQUEST');
  const next = structuredClone(current), sides = next.sides as RecordingAttemptSide[];
  const active = next.activeSide === undefined ? undefined : sides.find(s => s.side === next.activeSide);
  const target = incoming ? sides.find(s => s.side === incoming.side)! : undefined;
  let changed = true;
  function finish(status: 'aborted' | 'failed' | 'interrupted', reason: RecordingAttemptEndReason): void {
    next.status = status; next.phase = 'finished'; next.reason = reason; next.endedAt = event.at;
    if (active && active.phase !== 'complete') { active.phase = status; active.reason = reason; active.endedAt = event.at; }
    delete next.activeSide;
  }
  if (cleanup) {
    const key = event.type === 'engine-cutoff' ? 'engineStoppedSubmitting' : event.type === 'stop-ack' ? 'stopAcknowledged' : 'cleanupQuiescent';
    if (!target || target[key]) return current;
    target[key] = true;
  } else if (terminalPhysicalStop && event.type === 'confirm' && event.kind === 'physical-stop') {
    const stopped = sides.find(s => s.side === event.side);
    if (!stopped?.runId || stopped.phase === 'pending') return invalid();
    if (stopped.physicalStopConfirmedAt) return current;
    // 人工实体停止只追加独立证据；不证明软件完成，也不重开或覆盖原终态。
    stopped.physicalStopConfirmedAt = event.at;
  } else if (event.type === 'recover') finish('interrupted', 'app-restarted');
  else if (event.type === 'abort') finish('aborted', 'user-stop');
  else if (event.type === 'fail' || event.type === 'interrupt') {
    // 已转入B的会话不会被A的迟到故障打断；待人工阶段仍可接收最后一个已开始侧的故障。
    const lastStarted = [...sides].reverse().find(s => s.runId !== undefined);
    if (!target || target !== (active ?? lastStarted)) return current;
    if (event.type === 'fail' && (target.submittedFrames !== 0 || target.phase !== 'outputting')) return invalid();
    finish(event.type === 'fail' ? 'failed' : 'interrupted', event.reason);
  } else if (event.type === 'begin-side') {
    const a = sides[0], b = sides[1];
    if (next.phase !== 'awaiting-side-b' || !next.flipConfirmedAt || a?.side !== 'A' || a.phase !== 'complete'
      || b?.side !== 'B' || b.phase !== 'pending' || sides.some(s => s.runId === event.runId)) return invalid();
    b.phase = 'outputting'; b.runId = event.runId; b.startedAt = event.at; next.activeSide = 'B'; next.phase = 'outputting';
  } else if (event.type === 'confirm') {
    if (event.kind === 'physical-stop') {
      if (next.phase !== 'awaiting-physical-stop' || active?.side !== event.side || !active.backendDrained || !active.engineStoppedSubmitting) return invalid();
      active.physicalStopConfirmedAt = event.at; active.endedAt = event.at; active.phase = 'complete'; delete next.activeSide;
      next.phase = active.side === 'A' && sides.length === 2 ? 'awaiting-flip' : 'final-verification';
    } else if (event.kind === 'flip') {
      if (next.phase !== 'awaiting-flip' || sides.length !== 2 || sides[0]?.phase !== 'complete' || sides[1]?.phase !== 'pending' || next.flipConfirmedAt) return invalid();
      next.flipConfirmedAt = event.at; next.phase = 'awaiting-side-b';
    } else if (event.kind === 'physical-recording') {
      if (next.phase !== 'final-verification' || !sides.every(s => s.phase === 'complete') || !next.softwarePlaybackComplete || next.physicalRecordingConfirmedAt) return invalid();
      next.physicalRecordingConfirmedAt = event.at;
    } else {
      if (next.phase !== 'final-verification' || !next.physicalRecordingConfirmedAt || !next.softwarePlaybackComplete || !sides.every(s => s.phase === 'complete')) return invalid();
      next.finalVerificationCompleteAt = event.at; next.status = 'completed'; next.phase = 'finished'; next.endedAt = event.at;
    }
  } else {
    if (!active || active !== target) return current;
    if (event.type === 'progress') {
      if (!['outputting', 'draining'].includes(active.phase) || event.sourceFramesRead > active.frameCount
        || event.sourceFramesRead < active.sourceFramesRead || event.submittedFrames < active.submittedFrames || event.consumedFrames < active.consumedFrames
        || (active.engineStoppedSubmitting && event.submittedFrames !== active.submittedFrames)) return invalid();
      changed = event.sourceFramesRead !== active.sourceFramesRead || event.submittedFrames !== active.submittedFrames || event.consumedFrames !== active.consumedFrames;
      active.sourceFramesRead = event.sourceFramesRead; active.submittedFrames = event.submittedFrames; active.consumedFrames = event.consumedFrames;
    } else if (event.type === 'source-eof') {
      if (active.sourceFramesRead !== active.frameCount || !['outputting', 'draining'].includes(active.phase)) return invalid();
      changed = !active.sourceEof; active.sourceEof = true; active.phase = 'draining'; next.phase = 'draining';
    } else if (event.type === 'backend-drained') {
      if (!active.sourceEof || active.submittedFrames !== active.frameCount || active.consumedFrames !== active.frameCount
        || !['draining', 'awaiting-physical-stop'].includes(active.phase)) return invalid();
      changed = !active.backendDrained; active.backendDrained = true; active.phase = 'awaiting-physical-stop'; next.phase = 'awaiting-physical-stop';
    }
    next.softwarePlaybackComplete = sides.every(s => s.sourceEof && s.backendDrained && s.submittedFrames === s.frameCount && s.consumedFrames === s.frameCount);
  }
  if (!changed) return current;
  if (!Number.isSafeInteger(current.revision + 1)) return invalid('INVALID_REQUEST');
  next.revision++; next.updatedAt = event.at;
  return checked(next);
}

export function recoverRecordingAttempt(current: RecordingAttempt, at: string): RecordingAttempt {
  return reduceRecordingAttempt(current, { type: 'recover', at });
}
