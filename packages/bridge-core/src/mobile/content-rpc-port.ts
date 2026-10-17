import { createHash, randomUUID } from 'node:crypto';
import { mobileCanonicalJson, type MobileJsonValue } from '@music-bridge/contracts';
import { captureMobileContentReply } from './content-protocol.js';
import { captureMobileContentScope, type MobileContentPort, type MobileContentScope, type MobileContentSnapshot } from './content-types.js';
import { assertMobileContentRequestScope, sameMobileContentScope } from './content-service.js';
import {
  captureMobileContentCoreRequest, captureMobileContentCoreResponse, captureMobileContentMainPrincipal,
  mobileContentPrincipalMatches, mobileContentRpcClosed, mobileContentRpcFailure, MOBILE_CONTENT_RPC_BOUNDS,
  type MobileContentCoreRequest, type MobileContentCoreResponse, type MobileContentMainPrincipal,
} from './content-rpc.js';
import type { MobileOwnerSourceRequest, MobileOwnerSourceResult } from './source-protocol.js';
import { MobileAuthPersistenceError, MobileServiceError } from './types.js';
import type { MobileNeteaseArtworkData } from '../netease/mobile-artwork.js';
import {
  createMobileCapabilityContext, withMobileCapabilityContext, mobileCapabilityAsync,
  mobileCapabilityReject, mobileCapabilityCache, mobileCapabilityRequestSha, closeMobileCapabilityContext,
  mobileContentDiagnosticAsync, mobileContentDiagnosticSync, mobileContentDiagnosticReject,
} from './capability-trace.js';

export interface MobileContentRpcPortOptions {
  initialize(input: { serverId: string; datasetId: string; key: Uint8Array; privateProviderDiagnostics?: true }, signal: AbortSignal): Promise<void>;
  invalidateDevice(input: { serverId: string; datasetId: string; deviceId: string; deviceEpoch: number }, signal: AbortSignal): Promise<void>;
  content: MobileContentPort;
  resolveScope(principal: Readonly<MobileContentMainPrincipal>, signal: AbortSignal): Promise<Readonly<MobileContentScope>>;
  assertScope(scope: Readonly<MobileContentScope>, stage: 'acquire' | 'lease', signal: AbortSignal): void | Promise<void>;
  source(scope: Readonly<MobileContentScope>, request: MobileOwnerSourceRequest, signal: AbortSignal): Promise<{
    source: 'local' | 'netease'; result: MobileOwnerSourceResult;
  }>;
  neteasePlaybackQualified?(scope: Readonly<MobileContentScope>, signal: AbortSignal): boolean | Promise<boolean>;
  readArtwork?(scope: Readonly<MobileContentScope>, artworkId: string, signal: AbortSignal): Promise<MobileNeteaseArtworkData>;
  assertArtwork?(scope: Readonly<MobileContentScope>, artworkId: string, signal: AbortSignal): Promise<string>;
  requestMs?: number;
  maxInflight?: number;
  maxSnapshots?: number;
  closeMs?: number;
}
export interface MobileContentRpcPort {
  request(input: unknown, signal: AbortSignal): Promise<MobileContentCoreResponse>;
  close(): Promise<void>;
}
interface Active {
  request: MobileContentCoreRequest;
  controller: AbortController;
  flight: Promise<MobileContentCoreResponse>;
}
interface Snapshot {
  request: Extract<MobileContentCoreRequest, { action: 'dispatch' }>;
  raw: MobileContentSnapshot;
  beforeSend: () => Promise<void>;
  fingerprint: string;
  controller: AbortController;
  timer: ReturnType<typeof setTimeout>;
  unlink(): void;
  validating: Promise<void> | undefined;
  cancelled: boolean;
}
const busy = () => new MobileServiceError(503, 'BUSY');
const changed = () => new MobileServiceError(409, 'SOURCE_CHANGED');
function bound(value: number | undefined, maximum: number): number {
  const actual = value ?? maximum;
  if (!Number.isSafeInteger(actual) || actual < 1 || actual > maximum) throw new MobileServiceError(400, 'INVALID_REQUEST');
  return actual;
}
function digest(value: unknown): string {
  return createHash('sha256').update(mobileCanonicalJson(value as MobileJsonValue)).digest('hex');
}
function cleanupRequest(request: MobileContentCoreRequest): boolean {
  return request.action === 'source' && (request.request.operation === 'release' || request.request.operation === 'close-read');
}
function principalOf(request: MobileContentCoreRequest): Readonly<MobileContentMainPrincipal> | null {
  if (request.action === 'scope') return request.principal;
  if (request.action === 'dispatch' || request.action === 'source' || request.action === 'revalidate' || request.action === 'artwork') {
    const scope = request.scope;
    return captureMobileContentMainPrincipal({ serverId: scope.serverId, datasetId: scope.datasetId,
      deviceId: scope.deviceId, deviceEpoch: scope.deviceEpoch, accessGeneration: scope.accessGeneration });
  }
  return null;
}

/** 单一可信 Main 端口。取消只封输出；真实工作静止前不释放槽位或制造撤销回执。 */
export function createMobileContentRpcPort(options: MobileContentRpcPortOptions): MobileContentRpcPort {
  const requestMs = bound(options.requestMs, MOBILE_CONTENT_RPC_BOUNDS.requestMs);
  const maxInflight = bound(options.maxInflight, MOBILE_CONTENT_RPC_BOUNDS.inflight);
  const maxSnapshots = bound(options.maxSnapshots, MOBILE_CONTENT_RPC_BOUNDS.snapshots);
  const closeMs = bound(options.closeMs, MOBILE_CONTENT_RPC_BOUNDS.closeMs);
  const active = new Map<string, Active>(), snapshots = new Map<string, Snapshot>();
  const revokedEpochs = new Map<string, number>();
  let closing = false, closeFlight: Promise<void> | undefined;
  let privateDispatchDiagnostics = false, privateDispatchClaims = 0;
  const privateFeeds = new Set(['getNeteaseDailyRecommendations','getNeteasePersonalFM','listNeteaseNewAlbums','listNeteaseCharts','listNeteaseRecommendedPlaylists']);
  let identity: { serverId: string; datasetId: string; keyHash: string } | undefined;
  let initialization: { serverId: string; datasetId: string; keyHash: string; flight: Promise<void> } | undefined;
  let initializationTrace: { state: 'pending' | 'fulfilled' | 'rejected'; requestSha256: string | null } | undefined;
  const current = (signal: AbortSignal): void => { if (closing || signal.aborted) throw busy(); };
  const response = <A extends MobileContentCoreRequest['action']>(request: { id: string; action: A }) =>
    ({ type: 'mobile-content-core-response' as const, id: request.id, action: request.action });
  function boundIdentity(request: MobileContentCoreRequest): void {
    if (!identity) throw busy();
    const principal = principalOf(request);
    if (principal && (principal.serverId !== identity.serverId || principal.datasetId !== identity.datasetId)
      || request.action === 'invalidate-device' && (request.serverId !== identity.serverId || request.datasetId !== identity.datasetId)) throw changed();
    if (principal && !cleanupRequest(request) && principal.deviceEpoch <= (revokedEpochs.get(principal.deviceId) ?? 0)) throw new MobileServiceError(401, 'UNAUTHORIZED');
  }
  function discard(id: string): void {
    const entry = snapshots.get(id);
    if (!entry) return;
    entry.cancelled = true; entry.controller.abort(busy()); clearTimeout(entry.timer); entry.unlink();
    if (!entry.validating) snapshots.delete(id);
  }
  function capture(entry: Snapshot) {
    const raw = entry.raw, input = entry.request;
    if (entry.cancelled || entry.controller.signal.aborted
      || !mobileContentRpcClosed(raw, ['operation', 'scope', 'reply', 'context', 'beforeSend'])
      || raw.operation !== input.operation || raw.beforeSend !== entry.beforeSend
      || !sameMobileContentScope(captureMobileContentScope(raw.scope), input.scope)) throw busy();
    const captured = captureMobileContentReply(input.operation, input.request, input.scope, raw.reply, raw.context);
    if (digest(captured) !== entry.fingerprint) throw busy();
    return captured;
  }
  async function assertScope(scope: Readonly<MobileContentScope>, stage: 'acquire' | 'lease', signal: AbortSignal): Promise<void> {
    current(signal); await options.assertScope(scope, stage, signal); current(signal);
  }
  async function execute(request: MobileContentCoreRequest, signal: AbortSignal, controller: AbortController,
    parentSignal: AbortSignal): Promise<MobileContentCoreResponse> {
    current(signal);
    if (request.action === 'initialize') {
      const keyHash = createHash('sha256').update(request.key).digest('hex');
      if (identity) {
        request.key.fill(0);
        if (identity.serverId !== request.serverId || identity.datasetId !== request.datasetId || identity.keyHash !== keyHash) throw changed();
        mobileCapabilityCache('core.rpc.initialize.cache', 'reuse-fulfilled', initializationTrace?.requestSha256 ?? null);
        return { ...response(request), ok: true };
      }
      const reused = initialization !== undefined;
      if (!initialization) {
        const key = new Uint8Array(request.key);
        const trace: NonNullable<typeof initializationTrace> = { state: 'pending', requestSha256: mobileCapabilityRequestSha('content', request.id) };
        initializationTrace = trace;
        const flight = Promise.resolve().then(async () => {
          try {
            try { await options.initialize({ serverId: request.serverId, datasetId: request.datasetId, key,
              ...(request.privateProviderDiagnostics ? { privateProviderDiagnostics: true as const } : {}) }, signal); current(signal);
              identity = { serverId: request.serverId, datasetId: request.datasetId, keyHash };
              privateDispatchDiagnostics = request.privateProviderDiagnostics === true; }
            finally { key.fill(0); }
          } catch (error) {
            trace.state = 'rejected'; mobileCapabilityCache('core.rpc.initialize.cache', 'rejected', trace.requestSha256); throw error;
          }
          trace.state = 'fulfilled'; mobileCapabilityCache('core.rpc.initialize.cache', 'fulfilled', trace.requestSha256);
        });
        initialization = { serverId: request.serverId, datasetId: request.datasetId, keyHash, flight };
        mobileCapabilityCache('core.rpc.initialize.cache', 'new-pending', trace.requestSha256);
      }
      request.key.fill(0);
      if (initialization.serverId !== request.serverId || initialization.datasetId !== request.datasetId || initialization.keyHash !== keyHash) throw changed();
      if (reused) {
        const state = initializationTrace?.state;
        mobileCapabilityCache('core.rpc.initialize.cache', state === 'rejected' ? 'reuse-rejected' : state === 'fulfilled' ? 'reuse-fulfilled' : 'reuse-pending', initializationTrace?.requestSha256 ?? null);
      }
      await mobileCapabilityAsync('core.rpc.initialize.wait', () => initialization!.flight); current(signal);
      return { ...response(request), ok: true };
    }
    if (request.action === 'dispatch') mobileContentDiagnosticSync('core.dispatch.scope.before', () => boundIdentity(request));
    else boundIdentity(request);
    switch (request.action) {
      case 'scope': {
        const scope = await mobileCapabilityAsync('core.rpc.scope.resolve', async () => {
          const value = captureMobileContentScope(await options.resolveScope(request.principal, signal));
          if (!mobileContentPrincipalMatches(request.principal, value)) throw changed(); return value;
        });
        await mobileCapabilityAsync('core.rpc.scope.assert.before', () => assertScope(scope, 'acquire', signal));
        const qualified = await mobileCapabilityAsync('core.rpc.scope.qualified', async () => {
          const value = options.neteasePlaybackQualified ? await options.neteasePlaybackQualified(scope, signal) : false;
          if (typeof value !== 'boolean') throw busy(); return value;
        });
        await mobileCapabilityAsync('core.rpc.scope.assert.after', () => assertScope(scope, 'acquire', signal));
        return { ...response(request), kind: 'scope', scope, neteasePlayback: scope.providerEpoch !== null && qualified };
      }
      case 'invalidate-device': {
        // 先同步调用可信撤权回调，再等待实际端口静止；不能让旧 Provider 等待迟到发布。
        if (!revokedEpochs.has(request.deviceId) && revokedEpochs.size >= 16) throw busy();
        revokedEpochs.set(request.deviceId, Math.max(revokedEpochs.get(request.deviceId) ?? 0, request.deviceEpoch));
        let revoked: Promise<void>;
        try { revoked = options.invalidateDevice({ serverId: request.serverId, datasetId: request.datasetId,
          deviceId: request.deviceId, deviceEpoch: request.deviceEpoch }, signal); }
        catch (error) { revoked = Promise.reject(error); }
        void revoked.catch(() => {});
        const sameDevice = (principal: Readonly<MobileContentMainPrincipal> | null) => principal?.deviceId === request.deviceId
          && principal.deviceEpoch === request.deviceEpoch && principal.serverId === request.serverId && principal.datasetId === request.datasetId;
        const waiting: Promise<unknown>[] = [];
        for (const entry of active.values()) if (sameDevice(principalOf(entry.request)) && !cleanupRequest(entry.request)) {
          entry.controller.abort(busy()); waiting.push(entry.flight);
        }
        for (const [id, entry] of snapshots) if (sameDevice(principalOf(entry.request))) {
          discard(id); if (entry.validating) waiting.push(entry.validating);
        }
        await revoked; await Promise.allSettled(waiting); current(signal);
        return { ...response(request), ok: true };
      }
      case 'dispatch': {
        if (snapshots.size >= maxSnapshots) {
          const error = busy(); mobileContentDiagnosticReject('core.dispatch.admission.snapshots-full', error); throw error;
        }
        mobileContentDiagnosticSync('core.dispatch.scope.before', () => assertMobileContentRequestScope(request.operation, request.request, request.scope));
        await mobileContentDiagnosticAsync('core.dispatch.scope.before', () => assertScope(request.scope, 'acquire', signal));
        const raw = await mobileContentDiagnosticAsync('core.dispatch.content', () => options.content.dispatch({ operation: request.operation, request: request.request, scope: request.scope, signal }));
        await mobileContentDiagnosticAsync('core.dispatch.scope.after', () => assertScope(request.scope, 'acquire', signal));
        const captured = mobileContentDiagnosticSync('core.dispatch.snapshot.capture', () => {
        if (!mobileContentRpcClosed(raw, ['operation', 'scope', 'reply', 'context', 'beforeSend'])
          || raw.operation !== request.operation || typeof raw.beforeSend !== 'function'
          || !sameMobileContentScope(captureMobileContentScope(raw.scope), request.scope)) throw busy();
        return captureMobileContentReply(request.operation, request.request, request.scope, raw.reply, raw.context);
        });
        if (snapshots.size >= maxSnapshots) {
          const error = busy(); mobileContentDiagnosticReject('core.dispatch.admission.snapshots-full', error); throw error;
        }
        const snapshotId = randomUUID(), onAbort = () => discard(snapshotId);
        const entry: Snapshot = { request, raw, beforeSend: raw.beforeSend, fingerprint: digest(captured), controller,
          cancelled: false, validating: undefined, timer: setTimeout(onAbort, requestMs),
          unlink: () => parentSignal.removeEventListener('abort', onAbort) };
        snapshots.set(snapshotId, entry); parentSignal.addEventListener('abort', onAbort, { once: true });
        if (parentSignal.aborted) onAbort();
        capture(entry); current(signal);
        return { ...response(request), kind: 'snapshot', snapshotId, operation: request.operation, scope: request.scope, ...captured };
      }
      case 'revalidate': {
        const entry = snapshots.get(request.snapshotId);
        if (!entry || entry.validating || !sameMobileContentScope(request.scope, entry.request.scope)) throw changed();
        const revoke = () => discard(request.snapshotId);
        signal.addEventListener('abort', revoke, { once: true });
        const verifying = Promise.resolve().then(async () => {
          capture(entry); await assertScope(request.scope, 'acquire', signal);
          await entry.beforeSend(); await assertScope(request.scope, 'acquire', signal); capture(entry);
        });
        entry.validating = verifying;
        try { await verifying; current(signal); return { ...response(request), kind: 'validated', snapshotId: request.snapshotId, scope: request.scope }; }
        finally {
          signal.removeEventListener('abort', revoke); clearTimeout(entry.timer); entry.unlink(); snapshots.delete(request.snapshotId);
        }
      }
      case 'artwork': {
        await assertScope(request.scope, 'acquire', signal);
        if (request.operation === 'read') {
          if (!options.readArtwork) throw busy();
          const image = await options.readArtwork(request.scope, request.artworkId, signal);
          await assertScope(request.scope, 'acquire', signal);
          return captureMobileContentCoreResponse({ ...response(request), kind: 'artwork', scope: request.scope, ...image }, request);
        }
        if (!options.assertArtwork) throw busy();
        const revision = await options.assertArtwork(request.scope, request.artworkId, signal);
        await assertScope(request.scope, 'acquire', signal);
        if (revision !== request.expectedRevision) throw changed();
        return captureMobileContentCoreResponse({ ...response(request), kind: 'artwork-validated', scope: request.scope,
          artworkId: request.artworkId, revision }, request);
      }
      case 'source': {
        if (!cleanupRequest(request)) await assertScope(request.scope, request.request.operation === 'prepare' ? 'acquire' : 'lease', signal);
        const selected = await options.source(request.scope, request.request, signal);
        if (!cleanupRequest(request)) await assertScope(request.scope, request.request.operation === 'prepare' ? 'acquire' : 'lease', signal);
        return captureMobileContentCoreResponse({ ...response(request), kind: 'source', scope: request.scope, ...selected }, request);
      }
      case 'cancel': {
        if (request.requestId === request.id) throw changed();
        const pending = active.get(request.requestId), snapshot = request.snapshotId === null ? undefined : snapshots.get(request.snapshotId);
        if (pending && pending.request.action !== 'initialize' && pending.request.action !== 'invalidate-device') {
          const original = principalOf(pending.request);
          if (!original || !request.scope && pending.request.action !== 'scope'
            || request.scope && !mobileContentPrincipalMatches(original, request.scope)) throw changed();
          if ('scope' in pending.request && pending.request.scope) {
            if (request.scope === null || !sameMobileContentScope(pending.request.scope, request.scope)) throw changed();
          }
          if (!cleanupRequest(pending.request)) pending.controller.abort(busy());
        } else if (pending) throw changed();
        if (snapshot) {
          if (snapshot.request.id !== request.requestId || !request.scope || !sameMobileContentScope(snapshot.request.scope, request.scope)) throw changed();
          discard(request.snapshotId!);
        }
        if (pending) await Promise.allSettled([pending.flight]);
        if (snapshot?.validating) await Promise.allSettled([snapshot.validating]);
        current(signal);
        return { ...response(request), kind: 'cancelled', requestId: request.requestId, snapshotId: request.snapshotId, quiet: true };
      }
    }
  }
  const port: MobileContentRpcPort = {
    async request(raw, parentSignal) {
      const request = captureMobileContentCoreRequest(raw);
      const privateDispatch = privateDispatchDiagnostics && request.action === 'dispatch' && privateFeeds.has(request.operation) && privateDispatchClaims < 8;
      if (privateDispatch) privateDispatchClaims++;
      const contextFor = (signal?: AbortSignal) => {
        if (!(privateDispatch || request.action === 'initialize' || request.action === 'scope' || request.action === 'cancel')) return undefined;
        const context = createMobileCapabilityContext(request.id, 'core', 'content', undefined, signal);
        if (context && privateDispatch) context.privateContentDiagnostic = true;
        return context;
      };
      const failure = (error: unknown): MobileContentCoreResponse => {
        mobileCapabilityReject('core.rpc.failure', error, request.action === 'cancel' ? 'cleanup' : 'business');
        return mobileContentRpcFailure(request, error);
      };
      const earlyFailure = (error: unknown, stage: 'core.dispatch.admission' | 'core.dispatch.admission.active-full' = 'core.dispatch.admission'): MobileContentCoreResponse => {
        const context = contextFor(parentSignal instanceof AbortSignal ? parentSignal : undefined);
        return withMobileCapabilityContext(context, () => {
          try { mobileContentDiagnosticReject(stage, error); return failure(error); } finally { closeMobileCapabilityContext(context); }
        });
      };
      if (!(parentSignal instanceof AbortSignal) || closing || parentSignal.aborted) {
        if (request.action === 'initialize') request.key.fill(0);
        return earlyFailure(busy());
      }
      // 为撤权/取消保留一格，但总量不超过原16；满额普通工作不能挡住控制收口。
      const control = request.action === 'cancel' || request.action === 'invalidate-device' || request.action === 'revalidate' || cleanupRequest(request);
      if (active.has(request.id)) {
        if (request.action === 'initialize') request.key.fill(0);
        return earlyFailure(new MobileAuthPersistenceError('unknown'));
      }
      const admission = control ? maxInflight : Math.max(1, maxInflight - 1);
      if (active.size >= admission) {
        if (request.action === 'initialize') request.key.fill(0);
        return earlyFailure(busy(), 'core.dispatch.admission.active-full');
      }
      const controller = new AbortController(), cancel = () => controller.abort(busy());
      const context = contextFor(controller.signal);
      return withMobileCapabilityContext(context, async () => {
        mobileContentDiagnosticSync('core.dispatch.admission', () => undefined);
        parentSignal.addEventListener('abort', cancel, { once: true }); if (parentSignal.aborted) cancel();
        const timer = setTimeout(cancel, requestMs);
        let abort!: (error: unknown) => void;
        const aborted = new Promise<never>((_, reject) => { abort = reject; });
        const onAbort = () => abort(new MobileAuthPersistenceError('unknown'));
        controller.signal.addEventListener('abort', onAbort, { once: true }); if (controller.signal.aborted) onAbort();
        const flight = Promise.resolve().then(() => execute(request, controller.signal, controller, parentSignal))
          .then(result => mobileContentDiagnosticSync('core.dispatch.reply.capture', () => captureMobileContentCoreResponse(result, request))).catch(failure);
        active.set(request.id, { request, controller, flight });
        void flight.then(() => {
          try {
            active.delete(request.id); clearTimeout(timer); parentSignal.removeEventListener('abort', cancel);
            controller.signal.removeEventListener('abort', onAbort); if (request.action === 'initialize') request.key.fill(0);
          } catch (error) {
            mobileCapabilityReject('core.rpc.failure', error, 'cleanup'); throw error;
          } finally { closeMobileCapabilityContext(context); }
        });
        try { return await Promise.race([flight, aborted]); }
        catch (error) { return failure(error); }
      });
    },
    close() {
      if (closeFlight) return closeFlight;
      closing = true;
      for (const id of snapshots.keys()) discard(id);
      for (const entry of active.values()) entry.controller.abort(busy());
      const quiet = Promise.allSettled([...active.values()].map(entry => entry.flight)).then(() => {
        identity = undefined; initialization = undefined; initializationTrace = undefined; revokedEpochs.clear();
      });
      closeFlight = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new MobileAuthPersistenceError('unknown')), closeMs);
        void quiet.then(() => { clearTimeout(timer); resolve(); }, () => { clearTimeout(timer); reject(new MobileAuthPersistenceError('unknown')); });
      });
      return closeFlight;
    },
  };
  return port;
}
