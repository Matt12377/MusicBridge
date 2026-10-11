import { encodeMobileJsonReply, mobileCanonicalJson, mobileDataSnapshot } from '@music-bridge/contracts';
import type { MobileCodecLimits, MobileContentReadContext, MobileDecodedRequest, MobileHeaderPairs, MobileReplyMap } from '@music-bridge/contracts';
import { captureMobileContentRequest, captureMobileContentReply } from '../../../../packages/bridge-core/src/mobile/content-protocol.js';
import {
  captureMobileContentScope, isMobileContentOperation, type MobileContentOperation,
  type MobileContentPort, type MobileContentScope,
} from '../../../../packages/bridge-core/src/mobile/content-types.js';
import {
  assertMobileContentOperationKind, assertMobileContentRequestScope, MOBILE_CONTENT_SERVICE_BOUNDS, safeMobileContentFailure, sameMobileContentScope,
} from '../../../../packages/bridge-core/src/mobile/content-service.js';
import { MobileServiceError, type Mobile001BackendReply, type MobileAuthService,
  type MobilePrincipal } from '../../../../packages/bridge-core/src/mobile/types.js';

export interface MobileContentBackendReply extends Mobile001BackendReply {
  kind: 'buffered';
  contentContext: MobileContentReadContext;
  beforeSend(): Promise<void>;
}
export interface MobileContentBackend {
  dispatch(input: { operation: MobileContentOperation; request: MobileDecodedRequest<unknown>;
    accessToken: string | null; signal: AbortSignal; origin: string }): Promise<MobileContentBackendReply>;
  close(): Promise<void>;
}
export interface MobileContentBackendOptions {
  /** 组合根注入原有同一 branded auth；本门面不创建、不关闭另一份认证状态。 */
  auth: MobileAuthService;
  content: MobileContentPort;
  resolveScope(principal: MobilePrincipal, signal: AbortSignal): Promise<Readonly<MobileContentScope>>;
  assertScope(scope: Readonly<MobileContentScope>): void | Promise<void>;
  assertCurrent?(): void;
  limits?: MobileCodecLimits;
  /** 与原短 Main 请求同上限，只允许下调；不扩大 HTTPS 的元数据预算。 */
  requestMs?: number;
  maxInflight?: number;
  closeMs?: number;
}

function principalMatches(scope: Readonly<MobileContentScope>, principal: MobilePrincipal): boolean {
  return scope.serverId === principal.serverId && scope.datasetId === principal.datasetId
    && scope.deviceId === principal.deviceId && scope.deviceEpoch === principal.deviceEpoch
    && scope.accessGeneration === principal.generation;
}
function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}
function closedData(raw: unknown, keys: readonly string[]): raw is Record<string, unknown> {
  try {
    if (!raw || typeof raw !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(raw))) return false;
    return Reflect.ownKeys(raw).length === keys.length && keys.every(key => {
      const descriptor = Object.getOwnPropertyDescriptor(raw, key);
      return descriptor?.enumerable === true && Object.hasOwn(descriptor, 'value');
    });
  } catch { return false; }
}
function bound(raw: number | undefined, maximum: number): number {
  const value = raw ?? maximum;
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new MobileServiceError(400, 'INVALID_REQUEST');
  return value;
}

/** 独立候选门面；HTTPS 路由、能力声明和 Owner 接线由正式组合根另行装载。 */
export function createMobileContentBackend(options: MobileContentBackendOptions): MobileContentBackend {
  let closing = false, closeFlight: Promise<void> | undefined;
  const lifecycle = new AbortController(), active = new Set<Promise<unknown>>(), controllers = new Set<AbortController>();
  const requestMs = bound(options.requestMs, MOBILE_CONTENT_SERVICE_BOUNDS.requestMs);
  const maxInflight = bound(options.maxInflight, MOBILE_CONTENT_SERVICE_BOUNDS.inflight);
  const closeMs = bound(options.closeMs, MOBILE_CONTENT_SERVICE_BOUNDS.closeMs);
  const codecOptions = options.limits === undefined ? {} : { limits: options.limits };
  function current(signal: AbortSignal): void {
    if (closing || signal.aborted) throw new MobileServiceError(503, 'BUSY');
    options.assertCurrent?.();
  }
  async function verify(principal: MobilePrincipal, scope: Readonly<MobileContentScope>, signal: AbortSignal): Promise<void> {
    current(signal); await options.auth.assertCurrent(principal); current(signal);
    await options.assertScope(scope); current(signal);
    const latest = captureMobileContentScope(await options.resolveScope(principal, signal)); current(signal);
    if (!principalMatches(latest, principal) || !sameMobileContentScope(scope, latest)) throw new MobileServiceError(409, 'SOURCE_CHANGED');
    await options.auth.assertCurrent(principal); current(signal);
  }
  async function owned<T>(parentSignal: AbortSignal, task: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (closing || parentSignal.aborted || active.size >= maxInflight) throw new MobileServiceError(503, 'BUSY');
    const controller = new AbortController(); controllers.add(controller);
    const cancel = () => controller.abort(new MobileServiceError(503, 'BUSY'));
    parentSignal.addEventListener('abort', cancel, { once: true });
    if (parentSignal.aborted) cancel();
    const signal = AbortSignal.any([controller.signal, lifecycle.signal]);
    const timer = setTimeout(cancel, requestMs);
    let rejectAbort!: (error: unknown) => void;
    const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
    const onAbort = () => rejectAbort(new MobileServiceError(503, 'BUSY'));
    signal.addEventListener('abort', onAbort, { once: true }); if (signal.aborted) onAbort();
    const flight = Promise.resolve().then(async () => { current(signal); return task(signal); }); active.add(flight);
    // 调用超时之后仍保留原工作，直到认证或端口确实返回；不能通过换请求释放容量。
    void flight.then(() => active.delete(flight), () => active.delete(flight));
    try { return await Promise.race([flight, aborted]); }
    catch (error) { throw safeMobileContentFailure(error); }
    finally {
      clearTimeout(timer); signal.removeEventListener('abort', onAbort);
      parentSignal.removeEventListener('abort', cancel); controllers.delete(controller);
    }
  }
  const backend: MobileContentBackend = {
    async dispatch(input) {
      if (!closedData(input, ['operation', 'request', 'accessToken', 'signal', 'origin'])
        || !isMobileContentOperation(input.operation) || !(input.signal instanceof AbortSignal)) throw new MobileServiceError(400, 'INVALID_REQUEST');
      const operation = input.operation, originText = input.origin, accessToken = input.accessToken, parentSignal = input.signal;
      const request = captureMobileContentRequest(operation, input.request, codecOptions);
      return owned(parentSignal, async signal => {
        current(signal);
        let origin: URL;
        try { origin = new URL(originText); } catch { throw new MobileServiceError(400, 'INVALID_REQUEST'); }
        if (origin.protocol !== 'https:' || origin.origin !== originText || origin.username || origin.password) throw new MobileServiceError(400, 'INVALID_REQUEST');
        if (!accessToken) throw new MobileServiceError(401, 'UNAUTHORIZED');
        const principal = await options.auth.authenticate(accessToken); current(signal);
        await options.auth.assertCurrent(principal); current(signal);
        const scope = captureMobileContentScope(await options.resolveScope(principal, signal)); current(signal);
        if (!principalMatches(scope, principal)) throw new MobileServiceError(409, 'SOURCE_CHANGED');
        await options.assertScope(scope); current(signal);
        assertMobileContentRequestScope(operation, request, scope);
        // 请求正文只用于核验原身份；不能签发 accountDomain 或新的 Scope。
        const snapshot = await options.content.dispatch({ operation, request, scope, signal });
        await verify(principal, scope, signal);
        const capture = () => {
          if (!closedData(snapshot, ['operation', 'scope', 'reply', 'context', 'beforeSend']) || typeof snapshot.beforeSend !== 'function'
            || snapshot.operation !== operation
            || !sameMobileContentScope(scope, captureMobileContentScope(snapshot.scope))) throw new MobileServiceError(503, 'BUSY');
          const facts = captureMobileContentReply(operation, request, scope, snapshot.reply, snapshot.context, codecOptions);
          assertMobileContentOperationKind(operation, facts.reply.body);
          const encoded = encodeMobileJsonReply(operation, facts.reply as MobileReplyMap[typeof operation], { responseOrigin: originText,
            requestPath: request.path, content: facts.context, ...codecOptions });
          if (!encoded.ok) throw new MobileServiceError(503, 'BUSY');
          return { ...encoded.value, context: facts.context };
        };
        const encoded = capture(), originalBytes = new Uint8Array(encoded.body), originalStatus = encoded.status;
        const beforeSend = snapshot.beforeSend;
        const contextCapture = mobileDataSnapshot(encoded.context, options.limits);
        if (!contextCapture.ok) throw new MobileServiceError(503, 'BUSY');
        const originalContext = mobileCanonicalJson(contextCapture.value);
        const validateUnchanged = () => {
          const latest = capture(), context = mobileDataSnapshot(latest.context, options.limits);
          if (snapshot.beforeSend !== beforeSend || latest.status !== originalStatus
            || !sameBytes(latest.body, originalBytes) || !context.ok
            || mobileCanonicalJson(context.value) !== originalContext) throw new MobileServiceError(503, 'BUSY');
        };
        const headers: MobileHeaderPairs = [...encoded.headers, ['Cache-Control', 'private, no-store']];
        return { kind: 'buffered', status: encoded.status,
          headers, body: new Uint8Array(originalBytes),
          contentContext: encoded.context,
          beforeSend: () => owned(parentSignal, async sendSignal => {
            await verify(principal, scope, sendSignal);
            validateUnchanged(); await beforeSend(); await verify(principal, scope, sendSignal);
            validateUnchanged();
          }),
        };
      });
    },
    close(): Promise<void> {
      if (closeFlight) return closeFlight;
      closing = true; lifecycle.abort(new MobileServiceError(503, 'BUSY'));
      for (const controller of controllers) controller.abort(new MobileServiceError(503, 'BUSY'));
      // 到期限只报告未静止，不丢原工作；也不关闭 Root 持有的认证服务和内容 Owner。
      const quiet = Promise.allSettled([...active]);
      closeFlight = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new MobileServiceError(503, 'BUSY')), closeMs);
        void quiet.then(() => { clearTimeout(timer); resolve(); }, () => { clearTimeout(timer); reject(new MobileServiceError(503, 'BUSY')); });
      });
      return closeFlight;
    },
  };
  return backend;
}
