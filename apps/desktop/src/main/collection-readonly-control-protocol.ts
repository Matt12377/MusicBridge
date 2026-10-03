import { types } from 'node:util'
import type { OptionalReadonlyStatus, OptionalReadonlyRefreshResult } from '../../../../packages/bridge-core/src/rust-core/optional-readonly-manager.js'

export const COLLECTION_READONLY_PORT_TYPE = 'musicbridge.collection-readonly.port' as const
export const COLLECTION_READONLY_CONTROL_SCHEMA_VERSION = 1 as const
/** 控制失败类型属于共享协议，设置与客户端均依赖这一层。 */
export class CollectionReadonlyControlError extends Error {
  constructor(readonly code: 'RUST_UNAVAILABLE' | 'RUST_BLOCKED') { super('收藏查询控制通道不可用。') }
}
export interface CollectionReadonlyPortMessage { type: typeof COLLECTION_READONLY_PORT_TYPE; schemaVersion: 1; generationNonce: string }
type Header = { schemaVersion: 1; generationNonce: string; requestId: string }
export type CollectionReadonlyControlRequest = Header & ({ type: 'status' | 'refresh' } | { type: 'setEnabled'; enabled: boolean })
export type CollectionReadonlyControlResponse = Header & (
  | { type: 'status' | 'setEnabled'; ok: true; status: OptionalReadonlyStatus }
  | { type: 'refresh'; ok: true; result: OptionalReadonlyRefreshResult }
  | { type: CollectionReadonlyControlRequest['type']; ok: false; errorCode: 'RUST_UNAVAILABLE' | 'RUST_BLOCKED' })

export function collectionReadonlyExactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || types.isProxy(value) || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null || Object.getOwnPropertySymbols(value).length) return false
  const descriptors = Object.getOwnPropertyDescriptors(value)
  return Object.keys(descriptors).length === keys.length && keys.every(key => descriptors[key]?.enumerable === true && Object.hasOwn(descriptors[key]!, 'value'))
}
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)
export function isCollectionReadonlyPortMessage(value: unknown): value is CollectionReadonlyPortMessage {
  return collectionReadonlyExactRecord(value, ['type', 'schemaVersion', 'generationNonce']) && value.type === COLLECTION_READONLY_PORT_TYPE && value.schemaVersion === 1 && uuid(value.generationNonce)
}
export function isCollectionReadonlyControlRequest(value: unknown): value is CollectionReadonlyControlRequest {
  if (!value || typeof value !== 'object' || types.isProxy(value)) return false
  const type = Object.getOwnPropertyDescriptor(value, 'type')?.value
  return collectionReadonlyExactRecord(value, ['schemaVersion', 'generationNonce', 'requestId', 'type', ...(type === 'setEnabled' ? ['enabled'] : [])])
    && value.schemaVersion === 1 && uuid(value.generationNonce) && uuid(value.requestId)
    && (type === 'status' || type === 'refresh' || type === 'setEnabled' && typeof value.enabled === 'boolean')
}
export function isOptionalReadonlyStatus(value: unknown): value is OptionalReadonlyStatus {
  if (!value || typeof value !== 'object' || types.isProxy(value)) return false
  const error = Object.getOwnPropertyDescriptor(value, 'errorCode')
  return collectionReadonlyExactRecord(value, ['schemaVersion', 'enabled', 'mode', 'state', ...(error ? ['errorCode'] : [])])
    && value.schemaVersion === 1 && typeof value.enabled === 'boolean' && typeof value.mode === 'string' && ['node', 'rust'].includes(value.mode)
    && typeof value.state === 'string' && ['off', 'enabling', 'ready', 'stale', 'refreshing', 'failed', 'blocked', 'closing'].includes(value.state)
    && (!error || typeof value.errorCode === 'string' && ['RUST_UNAVAILABLE', 'RUST_STALE', 'RUST_BLOCKED'].includes(value.errorCode))
}
export function isCollectionReadonlyControlResponse(value: unknown): value is CollectionReadonlyControlResponse {
  if (!value || typeof value !== 'object' || types.isProxy(value)) return false
  const descriptors = Object.getOwnPropertyDescriptors(value), type = descriptors.type?.value, ok = descriptors.ok?.value
  const fields = ok === false ? ['errorCode'] : type === 'refresh' ? ['result'] : ['status']
  if (!collectionReadonlyExactRecord(value, ['schemaVersion', 'generationNonce', 'requestId', 'type', 'ok', ...fields])
    || value.schemaVersion !== 1 || !uuid(value.generationNonce) || !uuid(value.requestId) || !['status', 'refresh', 'setEnabled'].includes(type)) return false
  if (ok === false) return value.errorCode === 'RUST_UNAVAILABLE' || value.errorCode === 'RUST_BLOCKED'
  if (ok !== true) return false
  return type === 'refresh' ? collectionReadonlyExactRecord(value.result, ['refreshed', 'status']) && typeof value.result.refreshed === 'boolean' && isOptionalReadonlyStatus(value.result.status) : isOptionalReadonlyStatus(value.status)
}
