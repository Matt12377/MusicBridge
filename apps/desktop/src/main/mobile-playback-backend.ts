import { mobileResourceCapacityFailure } from '../../../../packages/bridge-core/src/mobile/resource-capacity-trace.js';
import { mobileRangeWindowObserve } from '../../../../packages/bridge-core/src/mobile/range-window-observer.js';
import { createHmac } from 'node:crypto';
import { mobilePreparationAsync, mobilePreparationSync } from '../../../../packages/bridge-core/src/mobile/capability-trace.js';
import {
  encodeMobileJsonReply, MOBILE_OPERATION_TABLE, MOBILE_UNKNOWN_DURATION_FEATURE, mobileDataSnapshot, mobileRecord,
  type MobileCatalogFeatures, type MobileDecodedRequest, type MobileHeaderPairs, type MobileReplyMap,
  type MobileResourceCodecContext, type MobileResourceSemanticContext,
} from '@music-bridge/contracts';
import { createMobileAuthCrypto } from '../../../../packages/bridge-core/src/mobile/auth-crypto.js';
import { createMobilePlaybackService, createMobilePlaybackReadComposition } from '../../../../packages/bridge-core/src/mobile/playback-service.js';
import { createMobilePlaybackStateCodec } from './mobile-playback-state-codec-client.js';
import {
  MOBILE002_CONTROL_OPERATIONS, MobilePlaybackError, type MobilePlaybackControlOperation,
  type MobilePlaybackMediaOperation, type MobilePlaybackService, type MobilePlaybackSourcePort,
  type MobilePlaybackReadComposition, type MobilePlaybackReadBoundaries,
} from '../../../../packages/bridge-core/src/mobile/playback-types.js';
import {
  MOBILE_PLAYBACK_ACTIVITY_ACQUIRE_MS, MOBILE_PLAYBACK_ACTIVITY_LEASE_MS, MobileAuthPersistenceError, MobileServiceError, type MobileAuthPersistence, type MobileAuthService,
  type Mobile001BackendReply, type MobileOwnerPrivateRequest, type MobileOwnerPrivateResult,
} from '../../../../packages/bridge-core/src/mobile/types.js';
import { isMobileOwnerPrivateResult } from '../../../../packages/bridge-core/src/mobile/owner-protocol.js';
import { capturePlaybackHistoryReply } from '../../../../packages/bridge-core/src/mobile/playback-history-protocol.js';
import type { MobilePlaybackHistoryPort } from '../../../../packages/bridge-core/src/mobile/playback-history-types.js';
import { captureMobileMediaReadBudget } from '../../../../packages/bridge-core/src/mobile/media-read-budget.js';
import type { MobileOwnerSourceRequest, MobileOwnerSourceResult } from '../../../../packages/bridge-core/src/mobile/source-protocol.js';
import type { MobileMediaReply } from './mobile-media-response.js';
import type { createMainMobileContentPort } from './mobile-content-port.js';
import type { MobileContentScope } from '../../../../packages/bridge-core/src/mobile/content-types.js';

export const MOBILE002_OPERATIONS = [...MOBILE002_CONTROL_OPERATIONS, 'getMediaAsset', 'headMediaAsset'] as const;
export type Mobile002Operation = MobilePlaybackControlOperation | MobilePlaybackMediaOperation;
export type Mobile002BackendReply = (Mobile001BackendReply & { kind: 'buffered'; resourceContext?: MobileResourceSemanticContext })
  | (MobileMediaReply & { kind: 'media' });
export interface Mobile002Backend {
  dispatch(input: { operation: Mobile002Operation; request: MobileDecodedRequest<unknown>; accessToken: string | null;
    signal: AbortSignal; origin: string; headers: MobileHeaderPairs }): Promise<Mobile002BackendReply>;
  resourceCapabilities(accessToken: string | null, sessionId: string, origin: string, signal: AbortSignal): Promise<MobileResourceCodecContext>;
}
const controlSet = new Set<string>(MOBILE002_CONTROL_OPERATIONS);
/** 目录协商仅属于HTTP上下文；播放业务仍独立校验原闭集字段，不执行调用者getter。 */
function playbackBusinessRequest(operation: Mobile002Operation, raw: MobileDecodedRequest<unknown>): {
  request: MobileDecodedRequest<unknown>; catalogFeatures?: MobileCatalogFeatures;
} {
  const captured = mobileDataSnapshot(raw);
  if (!captured.ok || !mobileRecord(captured.value)) throw new MobileServiceError(400, 'INVALID_REQUEST');
  const { catalogFeatures, ...request } = captured.value;
  if (catalogFeatures !== undefined && (catalogFeatures !== MOBILE_UNKNOWN_DURATION_FEATURE
    || !Object.hasOwn(MOBILE_OPERATION_TABLE, operation) || MOBILE_OPERATION_TABLE[operation].method !== 'GET')) {
    throw new MobileServiceError(400, 'INVALID_REQUEST');
  }
  return { request: request as unknown as MobileDecodedRequest<unknown>,
    ...(catalogFeatures === undefined ? {} : { catalogFeatures }) };
}
/** 仅将已定义的播放故障交给原安全 HTTP 错误映射。 */
export function safeMobilePlaybackFailure(error: unknown): MobileServiceError {
  if (error instanceof MobileServiceError) return error;
  if (error instanceof MobilePlaybackError) return new MobileServiceError(error.status, error.code, error.retryable, error.retryAfterMs);
  return new MobileServiceError(503, 'BUSY', true);
}

/** Main 的会话作者；FD、源身份和统一读锁始终留在原 Dataset Owner。 */
export function createMobilePlaybackBackend(options: {
  serverId: string; datasetId: string; authKey: Uint8Array; auth: MobileAuthService;
  requestOwner(request: MobileOwnerPrivateRequest): Promise<MobileOwnerPrivateResult>;
  assertCurrent(): void;
  /** 可信生产组合显式采用003；旧001/002组合不向Owner申请DSD能力。 */
  enableDsd?: boolean;
  contentPort?: ReturnType<typeof createMainMobileContentPort>;
}) {
  const key = new Uint8Array(createHmac('sha256', options.authKey).update('musicbridge-mobile-playback-v1').digest());
  let service: MobilePlaybackService | undefined, origin: string | undefined, closing = false;
  let closeFlight: Promise<void> | undefined;
  let warmFlight: Promise<void> | undefined;
  let readComposition: MobilePlaybackReadComposition | undefined;
  const cleanupFlights = new Set<Promise<void>>();
  const activityClose = new AbortController(), activityReleases = new Set<() => void>();
  const current = (): void => { if (closing) throw new MobileServiceError(503, 'BUSY'); options.assertCurrent(); };
  async function owner(request: MobileOwnerPrivateRequest): Promise<MobileOwnerPrivateResult> {
    current(); const reply = await options.requestOwner(request); current();
    if (!isMobileOwnerPrivateResult(reply, request)) throw new MobileAuthPersistenceError('unknown');
    if ('kind' in reply && reply.kind === 'mobile-error') {
      if (reply.outcome) throw new MobileAuthPersistenceError(reply.outcome);
      throw new MobilePlaybackError(reply.status as MobilePlaybackError['status'], reply.code as MobilePlaybackError['code'],
        reply.retryable, reply.status === 429 || reply.status === 503 ? 1000 : undefined);
    }
    return reply;
  }
  /** 私有RAM提示可跨dispatch/beforeSend；业务、权限和Owner持久提交仍沿原路径。 */
  async function acquireControlActivity(signal: AbortSignal): Promise<() => void> {
    current(); signal.throwIfAborted();
    let release: (() => void) | undefined;
    let finished = false;
    let timer: ReturnType<typeof setTimeout> | undefined, lifetime: ReturnType<typeof setTimeout> | undefined;
    let interrupt!: () => void;
    const interrupted = new Promise<void>(resolve => { interrupt = resolve; });
    const finish = () => {
      if (finished) return;
      finished = true;
      if (timer) { clearTimeout(timer); timer = undefined; }
      if (lifetime) { clearTimeout(lifetime); lifetime = undefined; }
      signal.removeEventListener('abort', finish); activityClose.signal.removeEventListener('abort', finish);
      release?.(); interrupt();
    };
    const begin: MobileOwnerPrivateRequest = { kind: 'playback-activity', datasetId: options.datasetId, request: { operation: 'begin' } };
    const started = Promise.resolve().then(() => options.requestOwner(begin)).then(reply => {
      if (!isMobileOwnerPrivateResult(reply, begin) || !('kind' in reply) || reply.kind !== 'playback-activity' || reply.leaseId === null) return;
      const leaseId = reply.leaseId, ownerEpoch = reply.ownerEpoch;
      let released = false;
      const releaseOwner = () => {
        if (released) return
        released = true; activityReleases.delete(releaseOwner);
        const end: MobileOwnerPrivateRequest = { kind: 'playback-activity', datasetId: options.datasetId,
          request: { operation: 'end', ownerEpoch, leaseId } };
        // 仅归还RAM调度提示；不等待它来发布业务ACK，也不覆盖原UNKNOWN/CAS错误。
        void Promise.resolve().then(() => options.requestOwner(end)).catch(() => {});
      };
      release = releaseOwner; activityReleases.add(releaseOwner);
      if (finished || closing || signal.aborted) releaseOwner();
    }).catch(() => { /* 提示失败仍沿原业务守门；Owner租约到期不会冻结后台。 */ });
    signal.addEventListener('abort', finish, { once: true });
    activityClose.signal.addEventListener('abort', finish, { once: true });
    // 未消费beforeSend的调用亦不能无限持有Main提示；期限不续租、不取消原业务。
    try { lifetime = setTimeout(finish, MOBILE_PLAYBACK_ACTIVITY_LEASE_MS); lifetime.unref(); }
    catch { finish(); }
    // 只限制新RAM提示的等待；丢ACK不能把业务停在原prepare期限之外。
    const admission = new Promise<void>(resolve => {
      try { timer = setTimeout(resolve, MOBILE_PLAYBACK_ACTIVITY_ACQUIRE_MS); }
      catch { resolve(); }
    });
    try {
      await Promise.race([started, interrupted, admission]);
      if (timer) { clearTimeout(timer); timer = undefined; }
      current(); signal.throwIfAborted();
      return finish;
    } catch (error) { finish(); throw error; }
  }
  async function withControlActivity<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
    const release = await acquireControlActivity(signal);
    try { return await work(); } finally { release(); }
  }
  async function source(request: MobileOwnerSourceRequest, cleanup = false): Promise<MobileOwnerSourceResult> {
    const input = { kind: 'media-source' as const, datasetId: options.datasetId, request };
    // 关闭期间只准入原句柄的静止收尾；绝不重新prepare或读取。
    const reply = cleanup ? await options.requestOwner(input) : await owner(input);
    if (!isMobileOwnerPrivateResult(reply, input)) throw new MobileAuthPersistenceError('unknown');
    if ('kind' in reply && reply.kind === 'mobile-error') throw new MobilePlaybackError(reply.status as MobilePlaybackError['status'],
      reply.code as MobilePlaybackError['code'], reply.retryable, reply.status === 429 || reply.status === 503 ? 1000 : undefined);
    return reply as MobileOwnerSourceResult;
  }
  function cleanup(request: MobileOwnerSourceRequest): Promise<void> {
    const task = source(request, true).then(() => undefined); cleanupFlights.add(task);
    void task.then(() => cleanupFlights.delete(task), () => { /* 保留失败的原收尾供close核验。 */ });
    return task;
  }
  const persistence: MobileAuthPersistence = {
    load: async datasetId => await owner({ kind: 'playback-load', datasetId }) as Awaited<ReturnType<MobileAuthPersistence['load']>>,
    save: async request => await owner({ kind: 'playback-save', datasetId: options.datasetId, request }) as Awaited<ReturnType<MobileAuthPersistence['save']>>,
  };
  const history: MobilePlaybackHistoryPort = {
    async dispatch(request) {
      current();
      if (request.serverId !== options.serverId || request.datasetId !== options.datasetId) throw new MobileAuthPersistenceError('not-sent');
      const reply = await owner({ kind: 'playback-history', datasetId: options.datasetId, request });
      current(); return capturePlaybackHistoryReply(reply, request);
    },
  };
  const sourceCapabilities = async (): Promise<Readonly<{ resourceDsdToPcm: boolean }>> => {
    current();
    if (options.enableDsd !== true) return { resourceDsdToPcm: false };
    const result = await source({ operation: 'capabilities' });
    if (result.kind !== 'mobile-source-capabilities') throw new MobilePlaybackError(503, 'BUSY');
    return { resourceDsdToPcm: result.resourceDsdToPcm };
  };
  const sourcePort: MobilePlaybackSourcePort = {
    capabilities: sourceCapabilities,
    async prepare(selection, signal) {
      const release = () => { void cleanup({ operation: 'release', handle: selection.resourceId }).catch(() => undefined); };
      signal.addEventListener('abort', release, { once: true });
      try {
        signal.throwIfAborted(); const result = await source({ operation: 'prepare', selection });
        if (result.kind !== 'mobile-source-prepared' && result.kind !== 'mobile-source-preparing') throw new MobilePlaybackError(503, 'BUSY');
        if (result.kind === 'mobile-source-preparing' && options.enableDsd !== true) throw new MobilePlaybackError(409, 'UNSUPPORTED_FORMAT');
        if (signal.aborted) { await cleanup({ operation: 'release', handle: selection.resourceId }); signal.throwIfAborted(); }
        return result.source;
      } catch (error) {
        // 原ID的release具有tombstone；即使prepare回包未知也不能迟到重开FD。
        await cleanup({ operation: 'release', handle: selection.resourceId }); throw error;
      } finally { signal.removeEventListener('abort', release); }
    },
    async status(handle, signal) {
      const release = () => { void cleanup({ operation: 'release', handle }).catch(() => undefined); };
      signal.addEventListener('abort', release, { once: true });
      try {
        signal.throwIfAborted(); const result = await source({ operation: 'status', handle });
        if (result.kind !== 'mobile-source-prepared' && result.kind !== 'mobile-source-preparing') throw new MobilePlaybackError(503, 'BUSY');
        if (result.kind === 'mobile-source-preparing' && options.enableDsd !== true) throw new MobilePlaybackError(409, 'UNSUPPORTED_FORMAT');
        signal.throwIfAborted(); return result.source;
      } catch (error) {
        if (signal.aborted) await cleanup({ operation: 'release', handle });
        throw error;
      } finally { signal.removeEventListener('abort', release); }
    },
    verify: async handle => { await mobileRangeWindowObserve('source.verify.composite', () => source({ operation: 'verify', handle })); },
    renew: async handle => { await source({ operation: 'renew', handle }); },
    async read(handle, readId, start, maxBytes, signal) {
      const cancel = () => { void cleanup({ operation: 'close-read', handle, readId }).catch(() => undefined); };
      signal.addEventListener('abort', cancel, { once: true });
      try {
        signal.throwIfAborted(); const result = await source({ operation: 'read', handle, readId, start, maxBytes });
        if (result.kind !== 'mobile-source-read') throw new MobilePlaybackError(503, 'BUSY');
        signal.throwIfAborted(); return new Uint8Array(result.bytes);
      } finally { signal.removeEventListener('abort', cancel); }
    },
    closeRead: (handle, readId) => mobileRangeWindowObserve('cleanup.close-read.composite', () => cleanup({ operation: 'close-read', handle, readId }), 'cleanup', 'close-read'),
    release: handle => cleanup({ operation: 'release', handle }),
  };
  if (options.contentPort) {
    const content = options.contentPort;
    interface Binding { scope: Readonly<MobileContentScope>; source: 'local' | 'netease' | undefined; releaseFlight?: Promise<void>;
      readFlights: Map<string, Promise<unknown>> }
    const bindings = new Map<string, Binding>();
    // 只计Main原content.source Promise；真实FD静止另依赖原close-read/release ACK。
    let pendingReadCalls = 0;
    const binding = (handle: string): Binding => {
      const bound = bindings.get(handle); if (!bound) throw new MobilePlaybackError(410, 'RESOURCE_EXPIRED'); return bound;
    };
    const actualSource = async (bound: Binding, request: MobileOwnerSourceRequest, signal: AbortSignal, isCleanup = false,
      authority?:Readonly<MobilePlaybackReadBoundaries>) => {
      if(authority&&request.operation!=='read')throw new MobilePlaybackError(503,'BUSY');
      if (!isCleanup) { current(); signal.throwIfAborted(); await (request.operation === 'read'
        ? mobileRangeWindowObserve('source.read.authority.before', () => authority?authority.before():options.auth.assertDeviceCurrent(bound.scope.deviceId, bound.scope.deviceEpoch))
        : options.auth.assertDeviceCurrent(bound.scope.deviceId, bound.scope.deviceEpoch));current();signal.throwIfAborted(); }
      try {
        const mediaBudget = request.operation === 'read' ? captureMobileMediaReadBudget() : undefined;
        mediaBudget?.assertCurrent();
        const readSource = () => {
          if (!mediaBudget || request.operation !== 'read') return content.source(bound.scope, request, signal);
          if (bound.releaseFlight || bound.readFlights.has(request.readId) || pendingReadCalls >= 32) throw new MobilePlaybackError(429, 'RESOURCE_BUSY', true, 1_000);
          const ioController = new AbortController(), started = performance.now();
          const abort = () => ioController.abort();
          signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
          const actual = Promise.resolve().then(() => {
            ioController.signal.throwIfAborted(); return content.source(bound.scope, request, ioController.signal);
          });
          pendingReadCalls++; bound.readFlights.set(request.readId, actual);
          const quiet = () => {
            signal.removeEventListener('abort', abort); pendingReadCalls--;
            if (bound.readFlights.get(request.readId) === actual) bound.readFlights.delete(request.readId);
          };
          void actual.then(quiet, quiet);
          // 精确content.source这一次I/O独立五秒；不包含前后fresh授权，也不重放源read。
          return new Promise<Awaited<typeof actual>>((resolve, reject) => {
            const timer = setTimeout(() => { ioController.abort(); reject(new MobilePlaybackError(429, 'RESOURCE_BUSY', true, 1_000)); }, Math.min(5_000, mediaBudget.remainingMs()));
            void actual.then(result => {
              clearTimeout(timer);
              try {
                signal.throwIfAborted(); mediaBudget.assertCurrent();
                if (performance.now() - started >= 5_000) { ioController.abort(); throw new MobilePlaybackError(429, 'RESOURCE_BUSY', true, 1_000); }
                resolve(result);
              } catch (error) { reject(error); }
            }, error => { clearTimeout(timer); reject(error); });
          });
        };
        const result = await readSource();
        if (bound.source !== undefined && result.source !== bound.source) throw new MobilePlaybackError(409, 'SOURCE_CHANGED');
        bound.source = result.source;
        if (!isCleanup) { await (request.operation === 'read'
          ? mobileRangeWindowObserve('source.read.authority.after', () => authority?authority.after():options.auth.assertDeviceCurrent(bound.scope.deviceId, bound.scope.deviceEpoch))
          : options.auth.assertDeviceCurrent(bound.scope.deviceId, bound.scope.deviceEpoch)); current(); signal.throwIfAborted(); }
        return result.result;
      } catch (error) {
        if (error instanceof MobileServiceError) throw new MobilePlaybackError(error.status as MobilePlaybackError['status'],
          error.code as MobilePlaybackError['code'], false);
        throw error;
      }
    };
    const release = (handle: string): Promise<void> => {
      const bound = bindings.get(handle); if (!bound) return Promise.resolve();
      if (!bound.releaseFlight) {
        const flight = actualSource(bound, { operation: 'release', handle }, new AbortController().signal, true).then(async result => {
          if (result.kind !== 'mobile-source-ack' || result.operation !== 'release' || !result.quiet) throw new MobileAuthPersistenceError('unknown');
          await Promise.allSettled([...bound.readFlights.values()]);
          bindings.delete(handle);
        });
        bound.releaseFlight = flight; cleanupFlights.add(flight);
        void flight.then(() => cleanupFlights.delete(flight), () => {});
      }
      return bound.releaseFlight;
    };
    const closeRead = (handle: string, readId: string): Promise<void> => {
      const bound = bindings.get(handle); if (!bound) return Promise.resolve();
      const actualRead = bound.readFlights.get(readId);
      const task = mobileRangeWindowObserve('cleanup.close-read.composite', () => actualSource(bound, { operation: 'close-read', handle, readId }, new AbortController().signal, true).then(async result => {
        if (result.kind !== 'mobile-source-ack' || result.operation !== 'close-read' || !result.quiet) throw new MobileAuthPersistenceError('unknown');
        await Promise.allSettled(actualRead ? [actualRead] : []);
      }), 'cleanup', 'close-read');
      cleanupFlights.add(task); void task.then(() => cleanupFlights.delete(task), () => {}); return task;
    };
    const captureSource = (bound: Binding, result: MobileOwnerSourceResult) => {
      if (result.kind !== 'mobile-source-prepared' && result.kind !== 'mobile-source-preparing') throw new MobilePlaybackError(503, 'BUSY');
      if (result.kind === 'mobile-source-preparing') {
        if (bound.source !== 'local' || options.enableDsd !== true) throw new MobilePlaybackError(409, 'UNSUPPORTED_FORMAT');
        return result.source;
      }
      if (bound.source === 'netease') {
        if (bound.scope.providerEpoch === null || result.source.processing.mode !== 'direct') throw new MobilePlaybackError(409, 'SOURCE_CHANGED');
        return { ...result.source, catalogSource: 'netease' as const, providerBinding: Object.freeze({ accountDomain: bound.scope.accountDomain,
          providerEpoch: bound.scope.providerEpoch, ownerEpoch: bound.scope.ownerEpoch }) };
      }
      return result.source;
    };
    // 显式004组合只接带真实设备身份的入口；旧组合仍完整保留原 local prepare。
    sourcePort.prepare = async () => { throw new MobilePlaybackError(409, 'UNSUPPORTED_FORMAT'); };
    sourcePort.prepareBound = async (selection, device, signal) => {
      current(); signal.throwIfAborted(); await options.auth.assertDeviceCurrent(device.deviceId, device.deviceEpoch);
      const actual = await content.scopeForIdentity({ serverId: options.serverId, datasetId: options.datasetId,
        deviceId: device.deviceId, deviceEpoch: device.deviceEpoch, accessGeneration: device.accessGeneration }, signal);
      await options.auth.assertDeviceCurrent(device.deviceId, device.deviceEpoch); current(); signal.throwIfAborted();
      if (bindings.has(selection.resourceId)) throw new MobilePlaybackError(409, 'IDEMPOTENCY_CONFLICT');
      if (bindings.size >= 8) return mobileResourceCapacityFailure('capacity.desktop.bindings-full', () => { throw new MobilePlaybackError(429, 'BUSY'); });
      const bound: Binding = { scope: actual.scope, source: undefined, readFlights: new Map() }; bindings.set(selection.resourceId, bound);
      const aborted = () => { void release(selection.resourceId).catch(() => {}); };
      signal.addEventListener('abort', aborted, { once: true }); if (signal.aborted) aborted();
      try {
        const result = await actualSource(bound, { operation: 'prepare', selection }, signal);
        if (signal.aborted) { await release(selection.resourceId); signal.throwIfAborted(); }
        return captureSource(bound, result);
      } catch (error) { await release(selection.resourceId); throw error; }
      finally { signal.removeEventListener('abort', aborted); }
    };
    sourcePort.status = async (handle, signal) => {
      const bound = binding(handle), aborted = () => { void release(handle).catch(() => {}); };
      signal.addEventListener('abort', aborted, { once: true });
      try { return captureSource(bound, await actualSource(bound, { operation: 'status', handle }, signal)); }
      catch (error) { if (signal.aborted) await release(handle); throw error; }
      finally { signal.removeEventListener('abort', aborted); }
    };
    sourcePort.verify = async handle => { await mobileRangeWindowObserve('source.verify.composite', () => actualSource(binding(handle), { operation: 'verify', handle }, new AbortController().signal)); };
    sourcePort.renew = async handle => { await actualSource(binding(handle), { operation: 'renew', handle }, new AbortController().signal); };
    const readBound=async(handle:string,readId:string,start:number,maxBytes:number,signal:AbortSignal,authority?:Readonly<MobilePlaybackReadBoundaries>)=>{
      const bound = binding(handle), aborted = () => { void closeRead(handle, readId).catch(() => {}); };
      signal.addEventListener('abort', aborted, { once: true }); if (signal.aborted) aborted();
      try {
        const result = await actualSource(bound, { operation: 'read', handle, readId, start, maxBytes }, signal,false,authority);
        if (result.kind !== 'mobile-source-read') throw new MobilePlaybackError(503, 'BUSY');
        signal.throwIfAborted(); return new Uint8Array(result.bytes);
      } finally { signal.removeEventListener('abort', aborted); }
    };
    sourcePort.read=readBound;
    readComposition=createMobilePlaybackReadComposition(options.auth,sourcePort,async(request,authority)=>{
      const bound=binding(request.handle);
      const same=()=>{current();request.signal.throwIfAborted();
        if(request.serverId!==options.serverId||request.datasetId!==options.datasetId||binding(request.handle)!==bound
          ||bound.scope.serverId!==request.serverId||bound.scope.datasetId!==request.datasetId
          ||bound.scope.deviceId!==request.deviceId||bound.scope.deviceEpoch!==request.deviceEpoch)throw new MobilePlaybackError(401,'TICKET_REVOKED');};
      same();return readBound(request.handle,request.readId,request.start,request.maxBytes,request.signal,{
        before:async()=>{same();await authority.before();same();},after:async()=>{same();await authority.after();same();}});
    });
    sourcePort.closeRead = closeRead;
    sourcePort.release = release;
  }
  const requireService = (requestOrigin: string): MobilePlaybackService => {
    current(); if (!service || requestOrigin !== origin) throw new MobileServiceError(503, 'BUSY'); return service;
  };
  const backend: Mobile002Backend = {
    async resourceCapabilities(accessToken, sessionId, requestOrigin, signal) {
      requireService(requestOrigin); signal.throwIfAborted();
      if (!accessToken) throw new MobileServiceError(401, 'UNAUTHORIZED');
      const principal = await options.auth.authenticate(accessToken); signal.throwIfAborted();
      const capabilities = await sourceCapabilities(); signal.throwIfAborted();
      return { scope: { serverId: options.serverId, deviceId: principal.deviceId, sessionId }, responseOrigin: requestOrigin,
        now: new Date().toISOString(), resourceFormatBitDepth: true,
        ...(options.enableDsd === true ? { resourceDsdToPcm: capabilities.resourceDsdToPcm } : {}),
        capabilityVersion: '1.0.0', capabilitySnapshotIdentity: options.enableDsd === true
          ? `mbm003:${options.serverId}:dsd:${capabilities.resourceDsdToPcm ? 1 : 0}` : `mbm002:${options.serverId}` };
    },
    async dispatch(input) {
      const playback = mobilePreparationSync('preparation.main.service', () => requireService(input.origin));
      try {
        if (controlSet.has(input.operation)) {
          if (!input.accessToken) throw new MobileServiceError(401, 'UNAUTHORIZED');
          const principal = await mobilePreparationAsync('preparation.main.auth', () => options.auth.authenticate(input.accessToken!));
          const { request, catalogFeatures } = playbackBusinessRequest(input.operation, input.request);
          const reply = await mobilePreparationAsync('preparation.main.control', () => withControlActivity(input.signal,
            () => playback.control(input.operation as MobilePlaybackControlOperation, request, principal, input.signal)));
          const operation = input.operation as MobilePlaybackControlOperation;
          const encoded = mobilePreparationSync('preparation.main.encode', () => {
            const encoded = encodeMobileJsonReply(operation, { status: reply.status, category: reply.status >= 400 ? 'error' : reply.status === 204 ? 'empty' : 'success', body: reply.body } as MobileReplyMap[typeof operation],
              { responseOrigin: input.origin, requestPath: request.path, ...(catalogFeatures === undefined ? {} : { catalogFeatures }),
                ...(reply.resourceContext ? { resource: reply.resourceContext } : {}) });
            if (!encoded.ok) throw new MobileServiceError(503, 'BUSY');
            return encoded.value;
          });
          return { kind: 'buffered', ...encoded, headers: [...encoded.headers, ['Cache-Control', 'private, no-store']] as MobileHeaderPairs,
            ...(reply.resourceContext ? { resourceContext: reply.resourceContext } : {}), beforeSend: async () => {
              try {
                mobilePreparationSync('preparation.main.beforeSend.current', () => { current(); input.signal.throwIfAborted(); });
                await mobilePreparationAsync('preparation.main.beforeSend.auth', () => options.auth.assertCurrent(principal));
                await mobilePreparationAsync('preparation.main.beforeSend.reply', () => reply.beforeSend());
              }
              catch (error) { throw safeMobilePlaybackFailure(error); }
            } };
        }
        const operation = input.operation as MobilePlaybackMediaOperation;
        const { request } = playbackBusinessRequest(input.operation, input.request);
        const range = input.headers.find(([name]) => name.toLowerCase() === 'range')?.[1];
        const ifRange = input.headers.find(([name]) => name.toLowerCase() === 'if-range')?.[1];
        const reply = await playback.openMedia(operation, request, input.signal, { ...(range === undefined ? {} : { range }), ...(ifRange === undefined ? {} : { ifRange }) });
        const expectedBodyBytes = operation === 'headMediaAsset' || reply.start === null || reply.end === null ? 0 : reply.end - reply.start + 1;
        return { kind: 'media', operation, status: reply.status, headers: reply.headers, expectedBodyBytes,
          fullContentLength: reply.totalBytes, ticketExpiresAtMs: reply.ticketExpiresAtMs, resourceAbortSignal: reply.resourceAbortSignal,
          ...(range !== undefined && ifRange === undefined ? { rangeRequested: range } : {}),
          beforeSend: async () => { try { current(); input.signal.throwIfAborted(); await reply.beforeSend(); } catch (error) { throw safeMobilePlaybackFailure(error); } },
          reader: { read: async (maxBytes, signal) => {
            signal.throwIfAborted(); if (!reply.reader) return null;
            const block = await reply.reader.read(maxBytes); signal.throwIfAborted(); return block.byteLength ? new Uint8Array(block) : null;
          }, close: () => reply.close() } };
      } catch (error) { throw safeMobilePlaybackFailure(error); }
    },
  };
  return { backend,
    get enabled(): boolean { return !!service && !closing; },
    async dsdCapabilities(requestOrigin: string, signal: AbortSignal): Promise<Readonly<{ resourceDsdToPcm: boolean }>> {
      requireService(requestOrigin); signal.throwIfAborted();
      const capabilities = await sourceCapabilities(); signal.throwIfAborted(); current(); return capabilities;
    },
    activate(listeningOrigin: string): void {
      current(); if (service || origin) throw new MobileServiceError(409, 'INVALID_REQUEST');
      const parsed = new URL(listeningOrigin);
      if (parsed.protocol !== 'https:' || parsed.origin !== listeningOrigin || parsed.username || parsed.password) throw new MobileServiceError(400, 'INVALID_REQUEST');
      origin = listeningOrigin;
      service = createMobilePlaybackService({ serverId: options.serverId, datasetId: options.datasetId, responseOrigin: origin,
        auth: options.auth, persistence, history, crypto: createMobileAuthCrypto(key), sourcePort, stateCodec: createMobilePlaybackStateCodec(),
        ...(readComposition?{readComposition}:{}) });
      // activate已通过原Core/Owner就绪围栏；只沿原enqueue冷恢复一次，不轮询或创建意图。
      warmFlight=service.initialize();void warmFlight.catch(()=>{});
    },
    acquireControlActivity,
    revokeDevice: async (deviceId: string) => { await service?.revokeDevice(deviceId); },
    snapshot: () => service?.resourceSnapshot(),
    close(): Promise<void> {
      if (closeFlight) return closeFlight;
      closing = true;
      activityClose.abort(); for (const release of activityReleases) release();
      closeFlight = (async () => {
        const failures: unknown[] = [];
        try { await service?.close(); } catch (error) { failures.push(error); }
        // 等待原预热落定；其历史业务失败不是资源关闭失败。
        // service.close 与真实清理仍分别确认静止，拒绝照常保留。
        await warmFlight?.catch(() => {});
        for (const result of await Promise.allSettled([...cleanupFlights])) if (result.status === 'rejected') failures.push(result.reason);
        key.fill(0);
        if (failures.length) throw new AggregateError(failures, '移动播放收尾尚未确认。');
      })();
      return closeFlight;
    },
  };
}
