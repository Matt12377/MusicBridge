import { randomUUID } from 'node:crypto';
import * as dto from '@music-bridge/contracts';
import { mediaFingerprint } from './media-store.js';
import { acquireRecordingOutputInputLease, verifyRecordingOutputDependencies, type RecordingOutputInputLease, type RecordingOutputProviderInput } from './output-input.js';
import { AttemptError, AttemptNotAcceptedError, attemptFail, validAttemptRequest, type AttemptCommand, type AttemptRequest } from './attempt-integrity.js';
import { isRecordingAttemptEvent, type RecordingAttemptEvent } from './attempt-state.js';
import type { RecordingAttemptStore } from './attempt-store.js';

export interface RecordingAttemptDriver { stop(): Promise<void>; /** 只有真实停止派发并关闭资源后resolve；ACK不能替代此承诺。 */ close(): Promise<void> }
export interface RecordingAttemptDriverRequest {
  attempt: dto.RecordingAttempt; side: dto.RenderSide; runId: string; signal: AbortSignal;
  /** Core持有只读FD租期；provider仅获只读帧视图，不得在close完成后保留或重用。 */
  input: RecordingOutputProviderInput;
  onEvent(event: RecordingAttemptEvent): void;
}
/** 当前只供合成测试构造器注入；正式Runtime不提供该能力，不存在环境/IPC认证开关。 */
export interface RecordingAttemptAdmissionProvider {
  authorize(request: { plan: dto.RecordingPlanVersion; side: dto.RenderSide; signal: AbortSignal }): Promise<void>;
  start(request: RecordingAttemptDriverRequest): Promise<RecordingAttemptDriver>;
}
interface Options {
  store: RecordingAttemptStore; admissionProvider?: RecordingAttemptAdmissionProvider; assertCurrent?: () => void; assertReplicaIdle?: () => void;
  /** 仅受控构造器测试注入；生产始终使用Core私有只读FD租期。 */
  acquireInputLease?: typeof acquireRecordingOutputInputLease;
  operationTimeoutMs?: number; closeTimeoutMs?: number;
}
type CleanupType = 'engine-cutoff' | 'stop-ack' | 'cleanup-quiescent';
type CleanupEvent = { type: CleanupType; side: dto.RenderSide; runId: string; at: string };
interface Slot { controller: AbortController; attemptId?: string; side?: dto.RenderSide; runId?: string; handle?: RecordingAttemptDriver; inputLease?: RecordingOutputInputLease; pendingInputLease?: Promise<RecordingOutputInputLease>; barrierPending?: boolean; wantsClose: boolean; closing?: Promise<void>; pendingStart?: Promise<RecordingAttemptDriver>; stopCleanup?: Map<CleanupType, CleanupEvent>; terminalPersisted?: boolean }

export function createRecordingAttemptCoordinator({ store, admissionProvider, assertCurrent = () => {}, assertReplicaIdle = () => {}, acquireInputLease = acquireRecordingOutputInputLease, operationTimeoutMs = 30 * 60_000, closeTimeoutMs = 5_000 }: Options) {
  if (!Number.isSafeInteger(operationTimeoutMs) || operationTimeoutMs < 1 || operationTimeoutMs > 30 * 60_000 || !Number.isSafeInteger(closeTimeoutMs) || closeTimeoutMs < 1 || closeTimeoutMs > 5_000) return attemptFail('INVALID_REQUEST');
  let closed = false, slot: Slot | undefined, closing: Promise<void> | undefined, cleanupError: unknown;
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
    // 先锁存关闭Promise；driver.stop可能同步回报事件并再次进入finishHandle。
    let resolveClose!: () => void, rejectClose!: (error: unknown) => void;
    current.closing = new Promise<void>((resolve, reject) => { resolveClose = resolve; rejectClose = reject; });
    current.closing.catch(error => { cleanupError = error; });
    const finish = async () => {
      let handle: RecordingAttemptDriver | undefined;
      let startError: unknown, releaseError: unknown, startFailed = false, releaseFailed = false, releaseResult: 'verified' | 'cancelled' | undefined;
      try { handle = current.handle ?? await current.pendingStart; } catch (error) { startFailed = true; startError = error; }
      if (!handle && current.pendingInputLease) {
        // close/Stop可在announce之前或Promise已resolve但尚未赋给slot时先到。
        try { current.inputLease ??= await current.pendingInputLease; }
        catch { /* 取得FD前失败，原租期自身负责收口。 */ }
      }
      if (handle) {
        current.handle = handle;
        // stop请求失败也必须尝试close；没有静止证明前继续持有slot。
        try { await bounded(handle.stop(), closeTimeoutMs); } catch { /* close仍需执行。 */ }
        try { await handle.close(); }
        catch (error) {
          // 没有软件静止证明绝不释放仍可能在用的FD，slot也必须继续占用。
          if (current.barrierPending && current.attemptId && current.side && current.runId) {
            store.settleOutputRun(current.attemptId, current.side, current.runId, 'failed', 'DRIVER_CLOSE_FAILED');
            if (store.get({ attemptId: current.attemptId }).attempt?.status === 'in-progress') {
              const interrupted = store.event(current.attemptId, { type: 'interrupt', side: current.side, runId: current.runId,
                reason: 'backend-failure', at: eventTime(current.attemptId) });
              if (interrupted.status === 'in-progress') throw new AttemptError('BACKEND_FAILURE');
            }
          }
          throw error;
        }
      }
      // 只有driver.close证明软件静止后才允许末Hash与FD关闭。
      try { releaseResult = await current.inputLease?.release(); } catch (error) { releaseFailed = true; releaseError = error; }
      // 已提交的用户Stop终态无需重读热Attempt；仍在下方持久结算本次run的失败barrier。
      const observed = current.attemptId && !current.terminalPersisted ? store.get({ attemptId: current.attemptId }).attempt : null;
      const observedSide = observed?.sides.find(side => side.side === current.side && side.runId === current.runId);
      const verified = !!handle && !startFailed && !releaseFailed && releaseResult === 'verified'
        && !current.controller.signal.aborted && !current.inputLease?.signal.aborted
        && observed?.status === 'in-progress' && observedSide?.sourceEof === true && observedSide.backendDrained === true;
      if (current.barrierPending && current.attemptId && current.side && current.runId) {
        if (verified) store.settleOutputRun(current.attemptId, current.side, current.runId, 'verified');
        else {
          const reason = current.controller.signal.aborted || releaseResult === 'cancelled' ? 'CANCELLED'
            : startFailed ? 'START_FAILED'
            : observed && observed.status !== 'in-progress' ? 'BACKEND_FAILURE'
            : releaseError instanceof Error && 'code' in releaseError && releaseError.code === 'INPUT_CHANGED' ? 'INPUT_CHANGED' : 'INPUT_UNAVAILABLE';
          // failed先提交；即使随后interrupt写失败，最终确认在同一事务内仍被阻断。
          store.settleOutputRun(current.attemptId, current.side, current.runId, 'failed', reason);
          const state = current.terminalPersisted ? null : store.get({ attemptId: current.attemptId }).attempt;
          if (state?.status === 'in-progress') {
            const interrupted = store.event(current.attemptId, { type: 'interrupt', side: current.side, runId: current.runId,
              reason: reason === 'INPUT_CHANGED' ? 'source-read-failed' : 'backend-failure', at: eventTime(current.attemptId) });
            if (interrupted.status === 'in-progress') throw new AttemptError('BACKEND_FAILURE');
          }
        }
      }
      // 末核验失败未持久化时会在上方抛出，不能先清slot再补写失败。
      if (slot === current) slot = undefined;
      if (startFailed) throw startError ?? new AttemptError('BACKEND_FAILURE');
      if (releaseFailed) throw releaseError ?? new AttemptError('BACKEND_FAILURE');
    };
    void finish().then(resolveClose, rejectClose); return current.closing;
  }
  function interrupt(current: Slot, reason: 'backend-failure' | 'protocol-error' | 'backend-timeout' | 'plan-changed'): void {
    if (!current.attemptId || !current.side || !current.runId) return;
    try { assertCurrent(); store.event(current.attemptId, { type: 'interrupt', side: current.side, runId: current.runId, reason, at: eventTime(current.attemptId) }); } catch { /* 不把持久化失败当作成功；slot仍保留直到驱动关闭。 */ }
    current.controller.abort(); void finishHandle(current);
  }
  function onEvent(current: Slot, event: RecordingAttemptEvent): void {
    if (!current.attemptId || slot !== current) return;
    const valid = isRecordingAttemptEvent(event);
    // 安全停止已派发时，只接收清理证据；同步驱动故障不能抢占即将登记的用户停止。
    if (current.controller.signal.aborted && (!valid || !['engine-cutoff', 'stop-ack', 'cleanup-quiescent'].includes(event.type))) return;
    if (!valid || !('runId' in event) || event.type === 'begin-side') { interrupt(current, 'protocol-error'); return; }
    if (event.runId !== current.runId || event.side !== current.side) return;
    if (current.stopCleanup && (event.type === 'engine-cutoff' || event.type === 'stop-ack' || event.type === 'cleanup-quiescent')) {
      // 三种单调事实各保留首个合法回报和到达顺序，不让同步abort监听先进入持久审计。
      if (!current.stopCleanup.has(event.type)) current.stopCleanup.set(event.type, { ...event } as CleanupEvent);
      return;
    }
    try {
      assertCurrent();
      const state = store.event(current.attemptId, event);
      if (state.status !== 'in-progress' || event.type === 'backend-drained') void finishHandle(current);
    } catch { if (!current.controller.signal.aborted) interrupt(current, 'protocol-error'); }
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
    // 先前软件收口失败即使已清slot，也不能让新run绕过失败锁存；已提交命令回执仍由perform提前重放。
    if (cleanupError) return attemptFail('BACKEND_FAILURE');
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
      current.pendingInputLease = acquireInputLease(input, current.controller.signal, () => checked(current));
      current.inputLease = await current.pendingInputLease;
      if (current.inputLease.signal.aborted) current.controller.abort(new AttemptError('BACKEND_FAILURE'));
      else current.inputLease.signal.addEventListener('abort', () => {
        // 文件漂移/授权撤销可在没有新readFrames时发生，立即停止已启动provider。
        if (slot === current && !current.controller.signal.aborted) interrupt(current, 'backend-failure');
      }, { once: true });
      checked(current);
      const runId = randomUUID();
      const attempt = side ? store.command('beginSide', request as dto.BeginRecordingAttemptSideRequest, { type: 'begin-side', side, runId, at: eventTime((request as dto.BeginRecordingAttemptSideRequest).attemptId) }) : store.begin(request as dto.BeginRecordingAttemptRequest, input, runId);
      current.attemptId = attempt.id; current.side = input.receipt.recipe.side; current.runId = runId;
      store.registerOutputRun(attempt, current.side, runId);
      current.barrierPending = true;
      checked(current); // 持久化后的执行前再次核工作库；失败保留已知开始边界，绝不输出。
      // 先建立Promise，再进入外部provider，覆盖start内部同步事件与stop先到的窗口。
      current.pendingStart = Promise.resolve().then(() => {
        checked(current);
        return admissionProvider.start({ attempt, side: current.side!, runId, signal: AbortSignal.any([current.controller.signal, current.inputLease!.signal]), input: current.inputLease!.provider, onEvent: event => onEvent(current, event) });
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
      // Begin提交失败也可能已取得输入租期；等其末核验/释放后才允许同命令重试。
      // 真正的close若超时或失败，finishHandle保留slot，后续Begin继续被阻断。
      let cleanupConfirmed = false;
      try { await bounded(finishHandle(current), closeTimeoutMs); cleanupConfirmed = slot !== current; }
      catch { /* 保留原命令错误；收口失败由slot和cleanupError持续阻断新输出。 */ }
      if (closed) return attemptFail('CLOSED');
      if (!side) {
        // 回执丢失后须新鲜读取持久事实；已有Attempt（包括持久失败）优先返回当前记录。
        // 仅在无任何未来可受理的异步开始、资源确实收口且receipt明确缺席时签发未受理。
        let noReceipt = false;
        try {
          const prior = current.attemptId
            ? store.get({ attemptId: current.attemptId }).attempt
            : store.cached('begin', request as dto.BeginRecordingAttemptRequest);
          if (prior) {
            const latest = store.get({ attemptId: prior.id }).attempt;
            if (latest) return latest;
          } else if (!current.attemptId) noReceipt = true;
        } catch { /* 读取异常=unknown，绝不转为明确未受理。 */ }
        if (noReceipt && cleanupConfirmed && !current.attemptId && !current.pendingStart && slot !== current)
          throw new AttemptNotAcceptedError(error);
      }
      if (error instanceof AttemptError) throw error; return attemptFail('BACKEND_FAILURE');
    } finally { clearTimeout(timer); }
  }
  return {
    /** 只检查内部生命周期槽；不会请求停止、推断设备静止或启动输出。 */
    assertExecutionIdle(): void { open(); if (cleanupError) return attemptFail('BACKEND_FAILURE'); if (slot) return attemptFail('ATTEMPT_CONFLICT'); },
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
        let observedCleanup: CleanupEvent[] = [];
        // perform已核scope、DTO和命令身份；仅停止精确绑定的自建slot，不等待同步全链审计。
        const active = slot?.attemptId === current.attemptId ? slot : undefined;
        if (active) {
          const cleanup = new Map<CleanupType, CleanupEvent>();
          active.stopCleanup = cleanup;
          try { active.controller.abort(); void finishHandle(active); }
          finally {
            // 已有句柄此时已调用stop；无句柄时仍由finishHandle等待并关闭迟到的start。
            delete active.stopCleanup; observedCleanup = [...cleanup.values()];
          }
        }
        const at = observedCleanup.reduce((latest, event) => event.at > latest ? event.at : latest, eventTime(current.attemptId));
        try {
          const result = store.stop(current, { type: 'abort', reason: 'user-stop', at }, observedCleanup);
          if (active && result.status !== 'in-progress') active.terminalPersisted = true;
          return result;
        }
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
        if (current.attemptId && !current.terminalPersisted) {
          try {
            assertCurrent();
            if (store.get({ attemptId: current.attemptId }).attempt?.status === 'in-progress') {
              store.event(current.attemptId, { type: 'recover', at: eventTime(current.attemptId) });
            }
          } catch { /* 安全关闭继续，不能伪造持久化成功。 */ }
        }
      }
      closing = bounded(Promise.allSettled([...commands.values()].map(value => value.promise)).then(async () => { if (current) await finishHandle(current); }), closeTimeoutMs);
      return closing;
    },
  };
}
export type RecordingAttemptCoordinator = ReturnType<typeof createRecordingAttemptCoordinator>;
