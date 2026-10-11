import { MOBILE_SAFE_ERROR_CODES, isMobileId, mobileInteger } from '@music-bridge/contracts';
import type { MobileContentReadContext } from '@music-bridge/contracts';
import {
  captureMobileContentPrivateRequest, captureMobileContentReply,
} from './content-protocol.js';
import { captureMobileContentScope, type MobileContentOperation, type MobileContentScope,
  type MobileContentSuccessReply } from './content-types.js';
import { sameMobileContentScope } from './content-service.js';
import { isMobileOwnerSourceRequest, isMobileOwnerSourceResult,
  type MobileOwnerSourceRequest, type MobileOwnerSourceResult } from './source-protocol.js';
import { MobileAuthPersistenceError, MobileServiceError, type MobilePrincipal } from './types.js';
import { MobilePlaybackError } from './playback-types.js';

/** 只来自 Main 已认证的原 principal；没有 token、账号显示名或 Provider 凭据。 */
export type MobileContentMainPrincipal = Pick<MobileContentScope,
  'serverId' | 'datasetId' | 'deviceId' | 'deviceEpoch' | 'accessGeneration'>;
interface RequestBase { type: 'mobile-content-core-request'; id: string }
export type MobileContentCoreRequest =
  | (RequestBase & { action: 'initialize'; serverId: string; datasetId: string; key: Uint8Array })
  | (RequestBase & { action: 'invalidate-device'; serverId: string; datasetId: string; deviceId: string; deviceEpoch: number })
  | (RequestBase & { action: 'scope'; principal: Readonly<MobileContentMainPrincipal> })
  | (RequestBase & { action: 'dispatch'; operation: MobileContentOperation;
    scope: Readonly<MobileContentScope>; request: import('@music-bridge/contracts').MobileRequestMap[MobileContentOperation] })
  | (RequestBase & { action: 'revalidate'; snapshotId: string; scope: Readonly<MobileContentScope> })
  | (RequestBase & { action: 'source'; scope: Readonly<MobileContentScope>; request: MobileOwnerSourceRequest })
  | (RequestBase & { action: 'cancel'; requestId: string; snapshotId: string | null; scope: Readonly<MobileContentScope> | null });
interface ResponseBase { type: 'mobile-content-core-response'; id: string; action: MobileContentCoreRequest['action'] }
export interface MobileContentCoreFailure extends ResponseBase {
  kind: 'error'; status: MobileServiceError['status']; code: MobileServiceError['code'];
  retryable: false; outcome: 'not-sent' | 'unknown' | null;
}
export type MobileContentCoreResponse = MobileContentCoreFailure
  | (ResponseBase & { action: 'initialize'; ok: true })
  | (ResponseBase & { action: 'invalidate-device'; ok: true })
  | (ResponseBase & { action: 'scope'; kind: 'scope'; scope: Readonly<MobileContentScope>; neteasePlayback: boolean })
  | (ResponseBase & { action: 'dispatch'; kind: 'snapshot'; snapshotId: string; operation: MobileContentOperation;
    scope: Readonly<MobileContentScope>; reply: MobileContentSuccessReply<MobileContentOperation>; context: MobileContentReadContext })
  | (ResponseBase & { action: 'revalidate'; kind: 'validated'; snapshotId: string; scope: Readonly<MobileContentScope> })
  | (ResponseBase & { action: 'source'; kind: 'source'; scope: Readonly<MobileContentScope>; source: 'local' | 'netease'; result: MobileOwnerSourceResult })
  | (ResponseBase & { action: 'cancel'; kind: 'cancelled'; requestId: string; snapshotId: string | null; quiet: true });

const principalKeys = ['serverId', 'datasetId', 'deviceId', 'deviceEpoch', 'accessGeneration'] as const;
const statusCodes: readonly number[] = [400, 401, 403, 404, 409, 410, 413, 429, 503];
const safeCodes: readonly string[] = MOBILE_SAFE_ERROR_CODES;
export const MOBILE_CONTENT_RPC_BOUNDS = Object.freeze({ inflight: 16, snapshots: 16, requestMs: 10_000, closeMs: 10_000 });
export const mobileContentRpcUuid = (value: unknown): value is string => typeof value === 'string'
  && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(value);
export function mobileContentRpcClosed(raw: unknown, keys: readonly string[]): raw is Record<string, unknown> {
  try {
    if (!raw || typeof raw !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(raw))) return false;
    const descriptors = Object.getOwnPropertyDescriptors(raw);
    return Reflect.ownKeys(descriptors).length === keys.length && keys.every(key =>
      descriptors[key]?.enumerable === true && Object.hasOwn(descriptors[key]!, 'value'));
  } catch { return false; }
}
function invalid(): never { throw new MobileServiceError(400, 'INVALID_REQUEST'); }
function unavailable(): never { throw new MobileAuthPersistenceError('unknown'); }
export function captureMobileContentMainPrincipal(raw: unknown): Readonly<MobileContentMainPrincipal> {
  if (!mobileContentRpcClosed(raw, principalKeys)
    || !['serverId', 'datasetId', 'deviceId'].every(key => isMobileId(raw[key]))
    || !mobileInteger(raw.deviceEpoch, 1) || !mobileInteger(raw.accessGeneration, 1)) return invalid();
  return Object.freeze({ serverId: String(raw.serverId), datasetId: String(raw.datasetId), deviceId: String(raw.deviceId),
    deviceEpoch: Number(raw.deviceEpoch), accessGeneration: Number(raw.accessGeneration) });
}
/** 认证真实性由原 auth 核；此函数只剥离不能跨线程的 brand 与秘密字段。 */
export function mobileContentPrincipalFields(principal: MobilePrincipal): Readonly<MobileContentMainPrincipal> {
  return captureMobileContentMainPrincipal({ serverId: principal.serverId, datasetId: principal.datasetId,
    deviceId: principal.deviceId, deviceEpoch: principal.deviceEpoch, accessGeneration: principal.generation });
}
export function mobileContentPrincipalMatches(principal: Readonly<MobileContentMainPrincipal>, scope: Readonly<MobileContentScope>): boolean {
  return principalKeys.every(key => principal[key] === scope[key]);
}
function secretKey(raw: unknown): Uint8Array {
  try {
    if (!(raw instanceof Uint8Array) || Object.getPrototypeOf(raw) !== Uint8Array.prototype
      || !(raw.buffer instanceof ArrayBuffer) || raw.byteLength !== 32
      || Reflect.ownKeys(raw).length !== 32) return invalid();
    return new Uint8Array(raw);
  } catch { return invalid(); }
}

/** 同一个闭集信封可以 clone；原 Source guard 与块上限没有变更。 */
export function captureMobileContentCoreRequest(raw: unknown): MobileContentCoreRequest {
  if (!raw || typeof raw !== 'object') return invalid();
  let action: unknown;
  try { action = Object.getOwnPropertyDescriptor(raw, 'action')?.value; } catch { return invalid(); }
  const keys = action === 'initialize' ? ['type', 'id', 'action', 'serverId', 'datasetId', 'key']
    : action === 'invalidate-device' ? ['type', 'id', 'action', 'serverId', 'datasetId', 'deviceId', 'deviceEpoch']
    : action === 'scope' ? ['type', 'id', 'action', 'principal']
      : action === 'dispatch' ? ['type', 'id', 'action', 'operation', 'scope', 'request']
        : action === 'revalidate' ? ['type', 'id', 'action', 'snapshotId', 'scope']
          : action === 'source' ? ['type', 'id', 'action', 'scope', 'request']
            : action === 'cancel' ? ['type', 'id', 'action', 'requestId', 'snapshotId', 'scope'] : null;
  if (!keys || !mobileContentRpcClosed(raw, keys) || raw.type !== 'mobile-content-core-request' || !mobileContentRpcUuid(raw.id)) return invalid();
  const base = { type: 'mobile-content-core-request' as const, id: raw.id };
  if (action === 'initialize') {
    if (!isMobileId(raw.serverId) || !isMobileId(raw.datasetId)) return invalid();
    return { ...base, action, serverId: raw.serverId, datasetId: raw.datasetId, key: secretKey(raw.key) };
  }
  if (action === 'invalidate-device') {
    if (!isMobileId(raw.serverId) || !isMobileId(raw.datasetId) || !isMobileId(raw.deviceId) || !mobileInteger(raw.deviceEpoch, 1)) return invalid();
    return { ...base, action, serverId: raw.serverId, datasetId: raw.datasetId, deviceId: raw.deviceId, deviceEpoch: raw.deviceEpoch };
  }
  if (action === 'scope') return { ...base, action, principal: captureMobileContentMainPrincipal(raw.principal) };
  if (action === 'dispatch') {
    const input = captureMobileContentPrivateRequest({ type: 'mobile-content-main-request', id: raw.id,
      operation: raw.operation, scope: raw.scope, request: raw.request });
    return { ...base, action, operation: input.operation, scope: input.scope, request: input.request };
  }
  if (action === 'revalidate') {
    if (!mobileContentRpcUuid(raw.snapshotId)) return invalid();
    return { ...base, action, snapshotId: raw.snapshotId, scope: captureMobileContentScope(raw.scope) };
  }
  if (action === 'source') {
    if (!isMobileOwnerSourceRequest(raw.request)) return invalid();
    const request: unknown = structuredClone(raw.request);
    if (!isMobileOwnerSourceRequest(request)) return invalid();
    return { ...base, action, scope: captureMobileContentScope(raw.scope), request };
  }
  if (action === 'cancel' && mobileContentRpcUuid(raw.requestId)
    && (raw.snapshotId === null || mobileContentRpcUuid(raw.snapshotId))) {
    return { ...base, action, requestId: raw.requestId, snapshotId: raw.snapshotId,
      scope: raw.scope === null ? null : captureMobileContentScope(raw.scope) };
  }
  return invalid();
}

/** 接收端重核原 request/id/action；不接受额外栈、路径或错误详情。 */
function captureResponse(raw: unknown, expected: MobileContentCoreRequest): MobileContentCoreResponse {
  if (!raw || typeof raw !== 'object') return unavailable();
  let kind: unknown;
  try { kind = Object.getOwnPropertyDescriptor(raw, 'kind')?.value; } catch { return unavailable(); }
  if (kind === 'error') {
    if (!mobileContentRpcClosed(raw, ['type', 'id', 'action', 'kind', 'status', 'code', 'retryable', 'outcome'])
      || typeof raw.status !== 'number' || !statusCodes.includes(raw.status)
      || typeof raw.code !== 'string' || !safeCodes.includes(raw.code) || raw.retryable !== false
      || ![null, 'not-sent', 'unknown'].includes(raw.outcome as null | string)) return unavailable();
  } else {
    const keys = expected.action === 'initialize' || expected.action === 'invalidate-device' ? ['type', 'id', 'action', 'ok']
      : expected.action === 'scope' ? ['type', 'id', 'action', 'kind', 'scope', 'neteasePlayback']
        : expected.action === 'dispatch' ? ['type', 'id', 'action', 'kind', 'snapshotId', 'operation', 'scope', 'reply', 'context']
          : expected.action === 'revalidate' ? ['type', 'id', 'action', 'kind', 'snapshotId', 'scope']
            : expected.action === 'source' ? ['type', 'id', 'action', 'kind', 'scope', 'source', 'result']
              : ['type', 'id', 'action', 'kind', 'requestId', 'snapshotId', 'quiet'];
    if (!mobileContentRpcClosed(raw, keys)) return unavailable();
  }
  if (!mobileContentRpcClosed(raw, Reflect.ownKeys(raw).filter((key): key is string => typeof key === 'string'))
    || raw.type !== 'mobile-content-core-response' || raw.id !== expected.id || raw.action !== expected.action) return unavailable();
  const base = { type: 'mobile-content-core-response' as const, id: expected.id, action: expected.action };
  if (kind === 'error') return { ...base, kind, status: raw.status as MobileServiceError['status'],
    code: raw.code as MobileServiceError['code'], retryable: false, outcome: raw.outcome as MobileContentCoreFailure['outcome'] };
  switch (expected.action) {
    case 'initialize':
    case 'invalidate-device':
      if (raw.ok !== true) return unavailable();
      return expected.action === 'initialize'
        ? { ...base, action: 'initialize', ok: true }
        : { ...base, action: 'invalidate-device', ok: true };
    case 'scope': {
      const scope = captureMobileContentScope(raw.scope);
      if (kind !== 'scope' || typeof raw.neteasePlayback !== 'boolean' || !mobileContentPrincipalMatches(expected.principal, scope)) return unavailable();
      return { ...base, action: expected.action, kind, scope, neteasePlayback: raw.neteasePlayback };
    }
    case 'dispatch': {
      const scope = captureMobileContentScope(raw.scope);
      if (kind !== 'snapshot' || !mobileContentRpcUuid(raw.snapshotId) || raw.operation !== expected.operation
        || !sameMobileContentScope(scope, expected.scope)) return unavailable();
      const captured = captureMobileContentReply(expected.operation, expected.request, scope, raw.reply, raw.context as MobileContentReadContext);
      return { ...base, action: expected.action, kind, snapshotId: raw.snapshotId, operation: expected.operation, scope, ...captured };
    }
    case 'revalidate': {
      const scope = captureMobileContentScope(raw.scope);
      if (kind !== 'validated' || raw.snapshotId !== expected.snapshotId || !sameMobileContentScope(scope, expected.scope)) return unavailable();
      return { ...base, action: expected.action, kind, snapshotId: expected.snapshotId, scope };
    }
    case 'source': {
      const scope = captureMobileContentScope(raw.scope);
      if (kind !== 'source' || !sameMobileContentScope(scope, expected.scope) || raw.source !== 'local' && raw.source !== 'netease'
        || !isMobileOwnerSourceResult(raw.result, expected.request)) return unavailable();
      if (raw.source === 'netease' && scope.providerEpoch === null) return unavailable();
      const result: unknown = structuredClone(raw.result);
      if (!isMobileOwnerSourceResult(result, expected.request)) return unavailable();
      return { ...base, action: expected.action, kind, scope, source: raw.source, result };
    }
    case 'cancel':
      if (kind !== 'cancelled' || raw.requestId !== expected.requestId || raw.snapshotId !== expected.snapshotId || raw.quiet !== true) return unavailable();
      return { ...base, action: expected.action, kind, requestId: expected.requestId, snapshotId: expected.snapshotId, quiet: true };
  }
}

export function captureMobileContentCoreResponse(raw: unknown, expected: MobileContentCoreRequest): MobileContentCoreResponse {
  try { return captureResponse(raw, expected); } catch { return unavailable(); }
}

export function mobileContentRpcFailure(expected: Pick<MobileContentCoreRequest, 'id' | 'action'>, error: unknown): MobileContentCoreFailure {
  const outcome = error instanceof MobileAuthPersistenceError ? error.outcome
    : error instanceof MobileServiceError && ['not-sent', 'unknown'].includes(String(Object.getOwnPropertyDescriptor(error, 'outcome')?.value))
      ? Object.getOwnPropertyDescriptor(error, 'outcome')!.value as 'not-sent' | 'unknown' : null;
  const safeError = error instanceof MobileServiceError || error instanceof MobilePlaybackError;
  const status = safeError && statusCodes.includes(error.status) ? error.status : 503;
  const code = safeError && safeCodes.includes(error.code) ? error.code : 'BUSY';
  return { type: 'mobile-content-core-response', id: expected.id, action: expected.action,
    kind: 'error', status, code, retryable: false, outcome };
}
export function throwMobileContentRpcFailure(response: MobileContentCoreFailure): never {
  const error = new MobileServiceError(response.status, response.code, false);
  if (response.outcome !== null) Object.defineProperty(error, 'outcome', { value: response.outcome, enumerable: true });
  throw error;
}
