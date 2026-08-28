import { randomUUID } from 'node:crypto';
import * as dto from '@music-bridge/contracts';
import { mediaFingerprint } from './media-store.js';
import { verifyRecordingOutputDependencies } from './output-input.js';
import { AttemptError, attemptFail, validAttemptRequest, type AttemptCommand, type AttemptRequest } from './attempt-integrity.js';
import { isRecordingAttemptEvent, type RecordingAttemptEvent } from './attempt-state.js';
import type { RecordingAttemptStore } from './attempt-store.js';

export interface RecordingAttemptDriver { stop(): Promise<void>; /** 只有真实停止派发并关闭资源后resolve；ACK不能替代此承诺。 */ close(): Promise<void> }
export interface RecordingAttemptDriverRequest {
  attempt: dto.RecordingAttempt; side: dto.RenderSide; runId: string; signal: AbortSignal;
  onEvent(event: RecordingAttemptEvent): void;
}
/** 当前只供合成测试构造器注入；正式Runtime不提供该能力，不存在环境/IPC认证开关。 */
export interface RecordingAttemptAdmissionProvider {
  authorize(request: { plan: dto.RecordingPlanVersion; side: dto.RenderSide; signal: AbortSignal }): Promise<void>;
  start(request: RecordingAttemptDriverRequest): Promise<RecordingAttemptDriver>;
}
interface Options {
  store: RecordingAttemptStore; admissionProvider?: RecordingAttemptAdmissionProvider; assertCurrent?: () => void; assertReplicaIdle?: () => void;
  operationTimeoutMs?: number; closeTimeoutMs?: number;
}
interface Slot { controller: AbortController; attemptId?: string; side?: dto.RenderSide; runId?: string; handle?: RecordingAttemptDriver; wantsClose: boolean; closing?: Promise<void>; pendingStart?: Promise<RecordingAttemptDriver> }

export function createRecordingAttemptCoordinator({ store, admissionProvider, assertCurrent = () => {}, assertReplicaIdle = () => {}, operationTimeoutMs = 30 * 60_000, closeTimeoutMs = 5_000 }: Options) {
  if (!Number.isSafeInteger(operationTimeoutMs) || operationTimeoutMs < 1 || operationTimeoutMs > 30 * 60_000 || !Number.isSafeInteger(closeTimeoutMs) || closeTimeoutMs < 1 || closeTimeoutMs > 5_000) return attemptFail('INVALID_REQUEST');
  let closed = false, slot: Slot | undefined, closing: Promise<void> | undefined;
  const commands = new Map<string, { fingerprint: string; promise: Promise<dto.RecordingAttempt> }>();
  const open = () => { if (closed) return attemptFail('CLOSED'); assertCurrent(); };
  const now = () => new Date().toISOString();
  const eventTime = (attemptId: string) => { const previous = store.get({ attemptId }).attempt?.updatedAt; const at = now(); return previous && previous > at ? previous : at; };
  function bounded<T>(promise: Promise<T>, timeout: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout>;
    return Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new AttemptError('BACKEND_FAILURE')), timeout); })]).finally(() => clearTimeout(timer));
  }
  function checked(current: Slot): void { open(); if (slot !== current || current.controller.signal.aborted) return attemptFail('CLOSED'); }
  function finishHandle(current: Slot): Promise<void> {
    current.wantsClose = true;
    if (current.closing) return current.closing;
    const finish = async () => {
      const handle = current.handle ?? await current.pendingStart;
      if (handle) {
        current.handle = handle;
        // stop请求失败也必须尝试close；没有静止证明前继续持有slot。
        try { await bounded(Promise.resolve().then(() => handle.stop()), closeTimeoutMs); } catch { /* close仍需执行。 */ }
        await handle.close();
      }
      if (slot === current) slot = undefined;
    };
    current.closing = finish(); current.closing.catch(() => undefined); return current.closing;
  }
  function interrupt(current: Slot, reason: 'backend-failure' | 'protocol-error' | 'backend-timeout' | 'plan-changed'): void {
    if (!current.attemptId || !current.side || !current.runId) return;
    try { assertCurrent(); store.event(current.attemptId, { type: 'interrupt', side: current.side, runId: current.runId, reason, at: eventTime(current.attemptId) }); } catch { /* 不把持久化失败当作成功；slot仍保留直到驱动关闭。 */ }
    current.controller.abort(); void finishHandle(current);
  }
  function onEvent(current: Slot, event: RecordingAttemptEvent): void {
    if (!current.attemptId || slot !== current) return;
    if (!isRecordingAttemptEvent(event) || !('runId' in event) || event.type === 'begin-side') { interrupt(current, 'protocol-error'); return; }
    if (event.runId !== current.runId || event.side !== current.side) return;
    try {
      assertCurrent();
      const state = store.event(current.attemptId, event);
      if (state.status !== 'in-progress' || event.type === 'backend-drained') void finishHandle(current);
    } catch { interrupt(current, 'protocol-error'); }
  }
  function perform(action: AttemptCommand, value: AttemptRequest, fn: (request: AttemptRequest) => Promise<dto.RecordingAttempt>): Promise<dto.RecordingAttempt> {
    try { open(); if (!validAttemptRequest(action, value)) return Promise.reject(new AttemptError('INVALID_REQUEST')); }
    catch (error) { return Promise.reject(error); }
    const request = structuredClone(value), fingerprint = mediaFingerprint({ action, request }), pending = commands.get(request.commandId);
    if (pending) return pending.fingerprint === fingerprint ? pending.promise : Promise.reject(new AttemptError('COMMAND_CONFLICT'));
    try { const prior = store.cached(action, request); if (prior) return Promise.resolve(prior); } catch (error) { return Promise.reject(error); }
    const promise = Promise.resolve().then(() => { open(); return fn(request); });
    commands.set(request.commandId, { fingerprint, promise });
    promise.finally(() => commands.delete(request.commandId)).catch(() => undefined); return promise;
  }
  async function execute(request: dto.BeginRecordingAttemptRequest | dto.BeginRecordingAttemptSideRequest, side?: 'B'): Promise<dto.RecordingAttempt> {
    open(); if (!admissionProvider) return attemptFail('BACKEND_NOT_CERTIFIED');
    if (slot) return attemptFail('ATTEMPT_CONFLICT');
    try { assertReplicaIdle(); } catch { return attemptFail('ATTEMPT_CONFLICT'); }
    const previous = 'attemptId' in request ? store.get({ attemptId: request.attemptId }).attempt ?? attemptFail('ATTEMPT_NOT_FOUND') : undefined;
    if (previous && ('expectedRevision' in request && previous.revision !== request.expectedRevision)) return attemptFail('VERSION_MISMATCH');
    if (previous && (previous.phase !== 'awaiting-side-b' || previous.status !== 'in-progress')) return attemptFail('INVALID_TRANSITION');
    const input = store.capture(previous?.planVersionId ?? (request as dto.BeginRecordingAttemptRequest).planVersionId, previous?.planContentHash ?? (request as dto.BeginRecordingAttemptRequest).planContentHash, side);
    const current: Slot = { controller: new AbortController(), wantsClose: false }; slot = current;
    const timer = setTimeout(() => { current.controller.abort(); interrupt(current, 'backend-timeout'); }, operationTimeoutMs);
    try {
      await bounded((async () => {
        await verifyRecordingOutputDependencies(input, current.controller.signal, () => checked(current));
        checked(current); await admissionProvider.authorize({ plan: input.plan, side: input.receipt.recipe.side, signal: current.controller.signal });
      })(), operationTimeoutMs);
      checked(current);
      if (store.capture(input.plan.id, input.plan.contentHash, input.receipt.recipe.side).facts.identity !== input.facts.identity) return attemptFail('PLAN_CHANGED');
      const runId = randomUUID();
      const attempt = side ? store.command('beginSide', request as dto.BeginRecordingAttemptSideRequest, { type: 'begin-side', side, runId, at: eventTime((request as dto.BeginRecordingAttemptSideRequest).attemptId) }) : store.begin(request as dto.BeginRecordingAttemptRequest, input, runId);
      current.attemptId = attempt.id; current.side = input.receipt.recipe.side; current.runId = runId;
      checked(current); // 持久化后的执行前再次核工作库；失败保留已知开始边界，绝不输出。
      // 先建立Promise，再进入外部provider，覆盖start内部同步事件与stop先到的窗口。
      current.pendingStart = Promise.resolve().then(() => {
        checked(current);
        return admissionProvider.start({ attempt, side: current.side!, runId, signal: current.controller.signal, onEvent: event => onEvent(current, event) });
      });
      try { current.handle = await bounded(current.pendingStart, operationTimeoutMs); }
      catch (error) {
        try {
          assertCurrent(); const state = store.get({ attemptId: attempt.id }).attempt, active = state?.sides.find(value => value.side === current.side);
          if (!closed && !current.controller.signal.aborted && state?.status === 'in-progress' && active?.phase === 'outputting' && active.submittedFrames === 0) store.event(attempt.id, { type: 'fail', reason: 'backend-start-failed', side: current.side!, runId, at: eventTime(attempt.id) });
        } catch { /* 仍需保守停止，不能因失败分类写入失败而漏掉资源关闭。 */ }
        interrupt(current, 'backend-failure'); throw error;
      }
      if (current.wantsClose || current.controller.signal.aborted || closed) void finishHandle(current);
      open(); // 关闭或切库期间迟到的start不能再向调用方发布成功。
      return attempt;
    } catch (error) {
      current.controller.abort();
      if (current.attemptId) interrupt(current, 'backend-failure');
      else if (slot === current) slot = undefined;
      if (error instanceof AttemptError) throw error; return attemptFail('BACKEND_FAILURE');
    } finally { clearTimeout(timer); }
  }
  return {
    /** 只检查内部生命周期槽；不会请求停止、推断设备静止或启动输出。 */
    assertExecutionIdle(): void { open(); if (slot) return attemptFail('ATTEMPT_CONFLICT'); },
    list(request: dto.ListRecordingAttemptsRequest) { open(); return store.list(request); },
    get(request: dto.RecordingAttemptIdRequest) { open(); return store.get(request); },
    begin(request: dto.BeginRecordingAttemptRequest) { return perform('begin', request, value => execute(value as dto.BeginRecordingAttemptRequest)); },
    beginSide(request: dto.BeginRecordingAttemptSideRequest) { return perform('beginSide', request, value => execute(value as dto.BeginRecordingAttemptSideRequest, 'B')); },
    confirm(request: dto.ConfirmRecordingAttemptRequest) {
      return perform('confirm', request, async value => {
        const current = value as dto.ConfirmRecordingAttemptRequest;
        return store.command('confirm', current, { type: 'confirm', kind: current.kind, ...(current.kind === 'physical-stop' ? { side: current.side } : {}), at: eventTime(current.attemptId) } as RecordingAttemptEvent);
      });
    },
    stop(request: dto.StopRecordingAttemptRequest) {
      return perform('stop', request, async value => {
        const current = value as dto.StopRecordingAttemptRequest;
        try { return store.command('stop', current, { type: 'abort', reason: 'user-stop', at: eventTime(current.attemptId) }); }
        catch (error) { if (slot?.attemptId === current.attemptId) interrupt(slot, 'backend-failure'); throw error; }
        finally {
          // 数据库拒写不能挡住安全停止；回执失败与真实driver停止各自保留事实。
          if (slot?.attemptId === current.attemptId) { slot.controller.abort(); void finishHandle(slot); }
        }
      });
    },
    close(): Promise<void> {
      if (closing) return closing;
      closed = true;
      const current = slot;
      if (current) {
        current.controller.abort();
        if (current.attemptId) {
          try { assertCurrent(); store.event(current.attemptId, { type: 'recover', at: eventTime(current.attemptId) }); } catch { /* 安全关闭继续，不能伪造持久化成功。 */ }
        }
      }
      closing = bounded(Promise.allSettled([...commands.values()].map(value => value.promise)).then(async () => { if (current) await finishHandle(current); }), closeTimeoutMs);
      return closing;
    },
  };
}
export type RecordingAttemptCoordinator = ReturnType<typeof createRecordingAttemptCoordinator>;
