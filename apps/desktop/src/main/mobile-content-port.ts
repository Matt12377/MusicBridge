import { mobileRangeWindowRpc } from '../../../../packages/bridge-core/src/mobile/range-window-observer.js';
import { randomUUID } from 'node:crypto';
import { captureMobileCapabilityContext, createMobileCapabilityContext, withMobileCapabilityContext, mobileCapabilityAsync, mobileCapabilitySync, mobileCapabilityReject, mobileCapabilityCache, mobileCapabilityRequestSha, closeMobileCapabilityContext } from '../../../../packages/bridge-core/src/mobile/capability-trace.js';
import { captureMobileContentReply } from '../../../../packages/bridge-core/src/mobile/content-protocol.js';
import { captureMobileContentScope, type MobileContentOperation, type MobileContentPort, type MobileContentScope } from '../../../../packages/bridge-core/src/mobile/content-types.js';
import { sameMobileContentScope } from '../../../../packages/bridge-core/src/mobile/content-service.js';
import {
  captureMobileContentCoreRequest, captureMobileContentCoreResponse, captureMobileContentMainPrincipal,
  mobileContentPrincipalFields, mobileContentRpcFailure, throwMobileContentRpcFailure, MOBILE_CONTENT_RPC_BOUNDS,
  type MobileContentCoreRequest, type MobileContentCoreResponse, type MobileContentCoreFailure, type MobileContentMainPrincipal,
} from '../../../../packages/bridge-core/src/mobile/content-rpc.js';
import type { MobileOwnerSourceRequest, MobileOwnerSourceResult } from '../../../../packages/bridge-core/src/mobile/source-protocol.js';
import { MobileAuthPersistenceError, MobileServiceError, type MobilePrincipal } from '../../../../packages/bridge-core/src/mobile/types.js';

export interface MainMobileContentPortOptions {
  serverId: string;
  datasetId: string;
  /** 由组合根的原 authKey 分域派生；只复制到此 Main 内存。 */
  key: Uint8Array;
  privateProviderDiagnostics?: boolean;
  requestRpc(request: MobileContentCoreRequest, signal: AbortSignal): Promise<MobileContentCoreResponse>;
  assertCurrent(): void;
  requestMs?: number;
  closeMs?: number;
}
type Success = Exclude<MobileContentCoreResponse, MobileContentCoreFailure>;
type ScopedRequest = Extract<MobileContentCoreRequest, { action: 'dispatch' | 'source' | 'revalidate' }>;
const busy = () => new MobileServiceError(503, 'BUSY');
function success(response: MobileContentCoreResponse): Success {
  if ('kind' in response && response.kind === 'error') throwMobileContentRpcFailure(response);
  return response as Success;
}
function bound(input: number | undefined, maximum: number): number {
  const value = input ?? maximum;
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new MobileServiceError(400, 'INVALID_REQUEST');
  return value;
}

/** 同一可信 Core 通道；只重建本地 beforeSend，不把回调或认证 token 跨线程复制。 */
export function createMainMobileContentPort(options: MainMobileContentPortOptions) {
  const requestMs = bound(options.requestMs, MOBILE_CONTENT_RPC_BOUNDS.requestMs), closeMs = bound(options.closeMs, MOBILE_CONTENT_RPC_BOUNDS.closeMs);
  const init = captureMobileContentCoreRequest({ type: 'mobile-content-core-request', id: randomUUID(), action: 'initialize',
    serverId: options.serverId, datasetId: options.datasetId, key: options.key,
    ...(options.privateProviderDiagnostics ? { privateProviderDiagnostics: true as const } : {}) });
  if (init.action !== 'initialize') throw new MobileServiceError(400, 'INVALID_REQUEST');
  const key = init.key;
  const active = new Map<string, { request: MobileContentCoreRequest; controller: AbortController; flight: Promise<Success> }>();
  const cleanup = new Map<string, Promise<void>>(), held = new Map<string, { cancel(): Promise<void>; unlink(): void }>();
  const knownEpochs = new Map<string, Set<number>>();
  const revokedEpochs = new Map<string, number>();
  let closing = false, closeFlight: Promise<void> | undefined, initialization: Promise<void> | undefined;
  let initializationState: 'pending' | 'fulfilled' | 'rejected' = 'pending', initializationSha: string | null = null;
  const current = () => { if (closing) throw busy(); options.assertCurrent(); };
  const base = () => ({ type: 'mobile-content-core-request' as const, id: randomUUID() });
  function remember(principal: Readonly<MobileContentMainPrincipal>): void {
    if (principal.serverId !== options.serverId || principal.datasetId !== options.datasetId) throw new MobileServiceError(409, 'SOURCE_CHANGED');
    if (principal.deviceEpoch <= (revokedEpochs.get(principal.deviceId) ?? 0)) throw new MobileServiceError(401, 'UNAUTHORIZED');
    const epochs = knownEpochs.get(principal.deviceId) ?? new Set<number>();
    if (!knownEpochs.has(principal.deviceId) && knownEpochs.size >= 16 || !epochs.has(principal.deviceEpoch) && epochs.size >= 16) throw busy();
    epochs.add(principal.deviceEpoch); knownEpochs.set(principal.deviceId, epochs);
  }
  function cancelOriginal(request: MobileContentCoreRequest, snapshotId: string | null = null): Promise<void> {
    if (request.action === 'initialize' || request.action === 'invalidate-device' || request.action === 'cancel') return Promise.resolve();
    const cleanupId = request.id + ':' + (snapshotId ?? 'pending');
    const previous = cleanup.get(cleanupId); if (previous) return previous;
    const scope = 'scope' in request ? request.scope : null;
    const packet: MobileContentCoreRequest = { ...base(), action: 'cancel', requestId: request.id, snapshotId, scope };
    const task = exchange(packet, new AbortController().signal, true).then(result => {
      mobileCapabilitySync('content.rpc.cancel', () => {
        if (result.action !== 'cancel' || result.kind !== 'cancelled') throw new MobileAuthPersistenceError('unknown');
      }, 'cleanup');
    });
    cleanup.set(cleanupId, task);
    // 没有真实 quiet ACK 的失败保留，不用删除 Promise 冒充已收口。
    void task.then(() => cleanup.delete(cleanupId), () => {});
    return task;
  }
  async function exchange(input: MobileContentCoreRequest, parentSignal: AbortSignal, isCleanup = false): Promise<Success> {
    if (!isCleanup) current();
    const request = captureMobileContentCoreRequest(input);
    const parentContext = captureMobileCapabilityContext();
    const stage = request.action === 'initialize' ? 'content.rpc.initialize' : request.action === 'scope' ? 'content.rpc.scope'
      : request.action === 'cancel' ? 'content.rpc.cancel'
        : options.privateProviderDiagnostics === true ? request.action === 'dispatch' ? 'content.rpc.dispatch'
          : request.action === 'revalidate' ? 'content.rpc.revalidate' : request.action === 'artwork' ? 'content.rpc.artwork'
            : request.action === 'source' ? 'content.rpc.source' : 'content.rpc.other' : 'content.rpc.other';
    const role = isCleanup ? 'cleanup' : 'business';
    const admission = isCleanup ? MOBILE_CONTENT_RPC_BOUNDS.inflight : MOBILE_CONTENT_RPC_BOUNDS.inflight - 1;
    if (!(parentSignal instanceof AbortSignal) || parentSignal.aborted || active.size >= admission) {
      if (request.action === 'initialize') request.key.fill(0);
      const error = busy();
      const context = parentContext ? createMobileCapabilityContext(request.id, 'main', 'content', parentContext.requestSha256, parentSignal, parentContext.sink) : undefined;
      withMobileCapabilityContext(context, () => mobileCapabilityReject(stage, error, role)); closeMobileCapabilityContext(context);
      throw error;
    }
    const rangeRpc = mobileRangeWindowRpc(request.id, request.action === 'source' ? request.request.operation : request.action, role);
    const controller = new AbortController();
    const context = parentContext ? createMobileCapabilityContext(request.id, 'main', 'content', parentContext.requestSha256, controller.signal, parentContext.sink) : undefined;
    const cancel = () => controller.abort(new MobileAuthPersistenceError('unknown'));
    parentSignal.addEventListener('abort', cancel, { once: true }); if (parentSignal.aborted) cancel();
    const timer = setTimeout(cancel, requestMs);
    let reject!: (error: unknown) => void;
    const aborted = new Promise<never>((_, fail) => { reject = fail; });
    const onAbort = () => {
      const error = new MobileServiceError(503, 'BUSY');
      Object.defineProperty(error, 'outcome', { value: 'unknown', enumerable: true });
      withMobileCapabilityContext(context, () => mobileCapabilityReject(stage, error, role));
      reject(error);
      if (!isCleanup) void withMobileCapabilityContext(parentContext, () => cancelOriginal(request)).catch(() => {});
    };
    controller.signal.addEventListener('abort', onAbort, { once: true }); if (controller.signal.aborted) onAbort();
    const flight = Promise.resolve().then(() => withMobileCapabilityContext(context, () => mobileCapabilityAsync(stage, async () => {
      try {
        const response = captureMobileContentCoreResponse(await options.requestRpc(request, controller.signal), request);
        if (controller.signal.aborted || closing && !isCleanup) {
          if (response.action === 'dispatch' && 'kind' in response && response.kind === 'snapshot') {
            void withMobileCapabilityContext(parentContext, () => cancelOriginal(request, response.snapshotId)).catch(() => {});
          }
          throw new MobileAuthPersistenceError('unknown');
        }
        return success(response);
      } catch (error) {
        mobileCapabilityReject(stage, error, role);
        const failure = mobileContentRpcFailure(request, error instanceof MobileServiceError || error instanceof MobileAuthPersistenceError
          ? error : new MobileAuthPersistenceError('unknown'));
        if (failure.outcome === 'unknown' && !isCleanup) void withMobileCapabilityContext(parentContext, () => cancelOriginal(request)).catch(() => {});
        throwMobileContentRpcFailure(failure);
      }
    }, role)));
    void flight.then(() => rangeRpc?.settle(request.id), error => rangeRpc?.settle(request.id, true, error));
    active.set(request.id, { request, controller, flight });
    const quiet = () => {
      active.delete(request.id); clearTimeout(timer); parentSignal.removeEventListener('abort', cancel);
      controller.signal.removeEventListener('abort', onAbort); if (request.action === 'initialize') request.key.fill(0);
      closeMobileCapabilityContext(context);
    };
    void flight.then(quiet, quiet);
    return Promise.race([flight, aborted]);
  }
  async function initialize(signal: AbortSignal): Promise<void> {
    current(); signal.throwIfAborted();
    if (!initialization) {
      const request: MobileContentCoreRequest = { ...base(), action: 'initialize', serverId: options.serverId, datasetId: options.datasetId, key };
      const context = captureMobileCapabilityContext();
      initializationSha = mobileCapabilityRequestSha('content', request.id);
      mobileCapabilityCache('content.initialize.cache', 'new-pending', initializationSha);
      initialization = exchange(request, new AbortController().signal).then(result => {
        if (result.action !== 'initialize' || result.ok !== true) throw new MobileAuthPersistenceError('unknown');
      });
      // 仅旁观原Promise；拒绝仍留在原缓存，不清理、不替换，也不增发initialize。
      void initialization.then(() => {
        initializationState = 'fulfilled';
        withMobileCapabilityContext(context, () => mobileCapabilityCache('content.initialize.cache', 'fulfilled', initializationSha));
      }, () => {
        initializationState = 'rejected';
        withMobileCapabilityContext(context, () => mobileCapabilityCache('content.initialize.cache', 'rejected', initializationSha));
      });
    } else mobileCapabilityCache('content.initialize.cache', initializationState === 'pending' ? 'reuse-pending'
      : initializationState === 'fulfilled' ? 'reuse-fulfilled' : 'reuse-rejected', initializationSha);
    await mobileCapabilityAsync('content.initialize.wait', () => initialization!); current(); signal.throwIfAborted();
  }
  async function scopeForIdentity(input: Readonly<MobileContentMainPrincipal>, signal: AbortSignal) {
    const principal = captureMobileContentMainPrincipal(input); remember(principal);
    await initialize(signal);
    const result = await exchange({ ...base(), action: 'scope', principal }, signal);
    if (result.action !== 'scope' || result.kind !== 'scope') throw new MobileAuthPersistenceError('unknown');
    return { scope: result.scope, neteasePlayback: result.neteasePlayback };
  }
  const content: MobileContentPort = {
    async dispatch<O extends MobileContentOperation>(input: import('../../../../packages/bridge-core/src/mobile/content-types.js').MobileContentServiceInput<O>) {
      const scope = captureMobileContentScope(input.scope); await initialize(input.signal);
      const request: ScopedRequest = { ...base(), action: 'dispatch', operation: input.operation, scope, request: input.request };
      const result = await exchange(request, input.signal);
      if (result.action !== 'dispatch' || result.kind !== 'snapshot' || result.operation !== input.operation) throw new MobileAuthPersistenceError('unknown');
      const captured = captureMobileContentReply(input.operation, input.request, scope, result.reply, result.context);
      let validation: Promise<void> | undefined;
      const dispose = () => { clearTimeout(timer); input.signal.removeEventListener('abort', onAbort); held.delete(result.snapshotId); };
      const cancel = () => {
        dispose(); return cancelOriginal(request, result.snapshotId);
      };
      const onAbort = () => { void cancel().catch(() => {}); };
      const timer = setTimeout(onAbort, requestMs);
      input.signal.addEventListener('abort', onAbort, { once: true });
      held.set(result.snapshotId, { cancel, unlink: dispose });
      if (input.signal.aborted) onAbort();
      return Object.freeze({ operation: input.operation, scope, ...captured,
        beforeSend: () => {
          if (!validation) validation = (async () => {
            current(); input.signal.throwIfAborted();
            const ack = await exchange({ ...base(), action: 'revalidate', snapshotId: result.snapshotId, scope }, input.signal);
            if (ack.action !== 'revalidate' || ack.kind !== 'validated') throw new MobileAuthPersistenceError('unknown');
          })().finally(dispose);
          return validation;
        } });
    },
  };
  return {
    content,
    async artwork(principal: MobilePrincipal, artworkId: string, signal: AbortSignal) {
      const identity = mobileContentPrincipalFields(principal), selected = await scopeForIdentity(identity, signal), scope = selected.scope;
      if (scope.providerEpoch === null) throw new MobileServiceError(403, 'RESOURCE_REVOKED');
      const result = await exchange({ ...base(), action: 'artwork', operation: 'read', scope, artworkId, expectedRevision: null }, signal);
      if (result.action !== 'artwork' || result.kind !== 'artwork') throw new MobileAuthPersistenceError('unknown');
      return { bytes: result.bytes, contentType: result.contentType, beforeSend: async () => {
        current(); signal.throwIfAborted();
        const latest = await scopeForIdentity(identity, signal);
        if (!sameMobileContentScope(scope, latest.scope)) throw new MobileServiceError(409, 'SOURCE_CHANGED');
        const checked = await exchange({ ...base(), action: 'artwork', operation: 'revalidate', scope,
          artworkId, expectedRevision: result.revision }, signal);
        if (checked.action !== 'artwork' || checked.kind !== 'artwork-validated') throw new MobileAuthPersistenceError('unknown');
        current(); signal.throwIfAborted();
      } };
    },
    async resolveScope(principal: MobilePrincipal, signal: AbortSignal): Promise<Readonly<MobileContentScope>> {
      return (await scopeForIdentity(mobileContentPrincipalFields(principal), signal)).scope;
    },
    scopeForIdentity,
    async assertScope(scope: Readonly<MobileContentScope>): Promise<void> {
      const latest = await scopeForIdentity(captureMobileContentMainPrincipal({ serverId: scope.serverId, datasetId: scope.datasetId,
        deviceId: scope.deviceId, deviceEpoch: scope.deviceEpoch, accessGeneration: scope.accessGeneration }), new AbortController().signal);
      if (!sameMobileContentScope(scope, latest.scope)) throw new MobileServiceError(409, 'SOURCE_CHANGED');
    },
    async neteasePlaybackQualified(principal: MobilePrincipal, signal: AbortSignal): Promise<boolean> {
      return (await scopeForIdentity(mobileContentPrincipalFields(principal), signal)).neteasePlayback;
    },
    async source(scope: Readonly<MobileContentScope>, request: MobileOwnerSourceRequest, signal: AbortSignal): Promise<{
      source: 'local' | 'netease'; result: MobileOwnerSourceResult;
    }> {
      const captured = captureMobileContentScope(scope);
      const isCleanup = request.operation === 'release' || request.operation === 'close-read';
      if (!isCleanup) await initialize(signal);
      const result = await exchange({ ...base(), action: 'source', scope: captured, request }, signal, isCleanup);
      if (result.action !== 'source' || result.kind !== 'source') throw new MobileAuthPersistenceError('unknown');
      return { source: result.source, result: result.result };
    },
    async invalidateDevice(deviceId: string): Promise<void> {
      const epochs = knownEpochs.get(deviceId);
      if (!epochs?.size) return;
      revokedEpochs.set(deviceId, Math.max(revokedEpochs.get(deviceId) ?? 0, ...epochs));
      const signal = new AbortController().signal; await initialize(signal);
      for (const deviceEpoch of [...epochs]) {
        const ack = await exchange({ ...base(), action: 'invalidate-device', serverId: options.serverId,
          datasetId: options.datasetId, deviceId, deviceEpoch }, signal, true);
        if (ack.action !== 'invalidate-device' || ack.ok !== true) throw new MobileAuthPersistenceError('unknown');
        epochs.delete(deviceEpoch);
      }
      if (!epochs.size) knownEpochs.delete(deviceId);
    },
    close(): Promise<void> {
      if (closeFlight) return closeFlight;
      closing = true; key.fill(0);
      for (const snapshot of held.values()) void snapshot.cancel().catch(() => {});
      for (const pending of active.values()) if (pending.request.action !== 'cancel' && pending.request.action !== 'invalidate-device') pending.controller.abort(busy());
      const quiet = (async () => {
        while (active.size) await Promise.allSettled([...active.values()].map(entry => entry.flight));
        await Promise.all([...cleanup.values()]);
        knownEpochs.clear(); revokedEpochs.clear();
      })();
      closeFlight = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new MobileAuthPersistenceError('unknown')), closeMs);
        void quiet.then(() => { clearTimeout(timer); resolve(); }, error => { clearTimeout(timer); reject(error); });
      });
      return closeFlight;
    },
  };
}
