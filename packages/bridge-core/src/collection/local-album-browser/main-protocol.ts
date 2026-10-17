import * as dto from '@music-bridge/contracts'
import { isDatasetOwnerProjectionRequest, isDatasetOwnerProjectionResponse, isDatasetProjectionResult, type DatasetOwnerProjectionRequest, type DatasetOwnerProjectionResponse } from '../dataset-owner-protocol.js'
import { isLocalAlbumOwnerReadRequest, isLocalAlbumOwnerReadResult, type LocalAlbumOwnerPublicReadRequest } from './owner-protocol.js'

/** 只在可信 Main→utility 使用；不扩展原任意 IPC dispatch，也不携带文件许可。 */
export interface LocalAlbumMainRequest {
  version: 1
  type: 'local-album-main-request'
  id: string
  datasetId: string
  request: LocalAlbumOwnerPublicReadRequest
}
export type LocalAlbumMainFailureCode = 'INVALID_REQUEST' | 'NOT_READY' | 'UNAVAILABLE' | 'SNAPSHOT_CHANGED' | 'CONTENT_LIMIT_EXCEEDED'
const messages: Readonly<Record<LocalAlbumMainFailureCode, string>> = {
  INVALID_REQUEST: '本地专辑请求无效，请重新选择。',
  NOT_READY: '本地音乐库尚未就绪，请稍后重试。',
  UNAVAILABLE: '本地专辑暂时无法读取，请重试。',
  SNAPSHOT_CHANGED: '来源或音乐库已变化，请重新读取。',
  CONTENT_LIMIT_EXCEEDED: '专辑读取超过预算，请缩小范围后重试。',
}
export type LocalAlbumMainResponse = {
  version: 1
  type: 'local-album-main-response'
  id: string
  datasetId: string
  command: dto.LocalAlbumCommand
} & ({ ok: true; result: dto.LocalAlbumCommandResults[dto.LocalAlbumCommand] }
  | { ok: false; error: { code: LocalAlbumMainFailureCode; message: string } })

function closed(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value))
    && Reflect.ownKeys(value).length === keys.length && keys.every(key => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      return descriptor?.enumerable === true && Object.hasOwn(descriptor, 'value')
    })
}
export function isLocalAlbumMainRequest(value: unknown): value is LocalAlbumMainRequest {
  return closed(value, ['version', 'type', 'id', 'datasetId', 'request']) && value.version === 1 && value.type === 'local-album-main-request'
    && dto.isCollectionId(value.id) && dto.isCommandOutboxDatasetId(value.datasetId) && isLocalAlbumOwnerReadRequest(value.request)
    && (value.request.command === 'localAlbum.query' || value.request.command === 'localAlbum.tracks' || value.request.command === 'localAlbum.artwork')
}
export function isLocalAlbumMainResponse(value: unknown, original: LocalAlbumMainRequest): value is LocalAlbumMainResponse {
  if (!isLocalAlbumMainRequest(original) || value === null || typeof value !== 'object') return false
  const ok = Object.getOwnPropertyDescriptor(value, 'ok')
  if (!ok || !Object.hasOwn(ok, 'value') || typeof ok.value !== 'boolean'
    || !closed(value, ['version', 'type', 'id', 'datasetId', 'command', 'ok', ok.value ? 'result' : 'error'])
    || value.version !== 1 || value.type !== 'local-album-main-response' || value.id !== original.id
    || value.datasetId !== original.datasetId || value.command !== original.request.command) return false
  if (!value.ok) {
    return closed(value.error, ['code', 'message']) && typeof value.error.code === 'string' && Object.hasOwn(messages, value.error.code)
      && value.error.message === messages[value.error.code as LocalAlbumMainFailureCode]
  }
  return isLocalAlbumOwnerReadResult(value.result, original.request)
}
export function localAlbumMainFailure(original: LocalAlbumMainRequest, code: LocalAlbumMainFailureCode): LocalAlbumMainResponse {
  if (!isLocalAlbumMainRequest(original) || !Object.hasOwn(messages, code)) throw new Error('本地专辑私有调用身份无效。')
  return { version: 1, type: 'local-album-main-response', id: original.id, datasetId: original.datasetId,
    command: original.request.command, ok: false, error: { code, message: messages[code] } }
}


/** 原 normalizeLocalAlbumArtwork 的可信 Main 反向信封；不进入 Renderer 或公开 command。 */
export interface LocalAlbumArtworkMainRequest {
  version: 1; type: 'local-album-artwork-main-request'; id: string; sequence: number
  datasetId: string; expiresAtMs: number; projection: DatasetOwnerProjectionRequest
}
export interface LocalAlbumArtworkMainReply {
  version: 1; type: 'local-album-artwork-main-response'; id: string; sequence: number
  datasetId: string; expiresAtMs: number; projection: DatasetOwnerProjectionResponse
}
export interface LocalAlbumArtworkMainCancel {
  version: 1; type: 'local-album-artwork-main-cancel'; id: string; sequence: number
  datasetId: string; expiresAtMs: number; epoch: string
}
export function isLocalAlbumArtworkMainRequest(value: unknown): value is LocalAlbumArtworkMainRequest {
  return closed(value, ['version','type','id','sequence','datasetId','expiresAtMs','projection'])
    && value.version === 1 && value.type === 'local-album-artwork-main-request' && dto.isCollectionId(value.id)
    && Number.isSafeInteger(value.sequence) && (value.sequence as number) > 0 && dto.isCommandOutboxDatasetId(value.datasetId)
    && Number.isSafeInteger(value.expiresAtMs) && (value.expiresAtMs as number) > 0
    && isDatasetOwnerProjectionRequest(value.projection) && value.projection.command === 'normalizeLocalAlbumArtwork'
    && value.projection.projectionRequestId === value.id
}
export function localAlbumArtworkMainCancel(request: LocalAlbumArtworkMainRequest): LocalAlbumArtworkMainCancel {
  if (!isLocalAlbumArtworkMainRequest(request)) throw new Error('原专辑封面反向身份无效。')
  return {version:1,type:'local-album-artwork-main-cancel',id:request.id,sequence:request.sequence,datasetId:request.datasetId,expiresAtMs:request.expiresAtMs,epoch:request.projection.epoch}
}
export function isLocalAlbumArtworkMainCancel(value: unknown): value is LocalAlbumArtworkMainCancel {
  return closed(value,['version','type','id','sequence','datasetId','expiresAtMs','epoch'])
    && value.version === 1 && value.type === 'local-album-artwork-main-cancel' && dto.isCollectionId(value.id)
    && Number.isSafeInteger(value.sequence) && (value.sequence as number)>0 && dto.isCommandOutboxDatasetId(value.datasetId)
    && Number.isSafeInteger(value.expiresAtMs) && (value.expiresAtMs as number)>0 && dto.isCollectionId(value.epoch)
}
/** 超时墓碑只保留原完整回声与缺图语义，不持有最多 8 MiB 的图片副本。 */
export interface LocalAlbumArtworkMainReference {
  version: 1; id:string; sequence:number; datasetId:string; expiresAtMs:number
  epoch:string; sourceStatus:'ready'|'source-unavailable'; hasItems:boolean
}
export function localAlbumArtworkMainReference(original:LocalAlbumArtworkMainRequest):LocalAlbumArtworkMainReference {
  if(!isLocalAlbumArtworkMainRequest(original))throw new Error('原专辑封面反向身份无效。')
  const copies=(original.projection.payload as {copies:dto.LocalArtworkSourceCopies}).copies
  return {version:1,id:original.id,sequence:original.sequence,datasetId:original.datasetId,expiresAtMs:original.expiresAtMs,epoch:original.projection.epoch,sourceStatus:copies.status,hasItems:copies.items.length>0}
}
export function isLocalAlbumArtworkMainReply(value: unknown, original: LocalAlbumArtworkMainRequest|LocalAlbumArtworkMainReference): value is LocalAlbumArtworkMainReply {
  const ref=isLocalAlbumArtworkMainRequest(original)?localAlbumArtworkMainReference(original):original
  if(!closed(ref,['version','id','sequence','datasetId','expiresAtMs','epoch','sourceStatus','hasItems'])||ref.version!==1
    ||!dto.isCollectionId(ref.id)||!dto.isCommandOutboxDatasetId(ref.datasetId)||!dto.isCollectionId(ref.epoch)
    ||!Number.isSafeInteger(ref.sequence)||ref.sequence<=0||!Number.isSafeInteger(ref.expiresAtMs)||ref.expiresAtMs<=0
    ||!['ready','source-unavailable'].includes(ref.sourceStatus)||typeof ref.hasItems!=='boolean')return false

  if (!closed(value,['version','type','id','sequence','datasetId','expiresAtMs','projection'])
    || value.version!==1 || value.type!=='local-album-artwork-main-response' || value.id!==ref.id || value.sequence!==ref.sequence
    || value.datasetId!==ref.datasetId || value.expiresAtMs!==ref.expiresAtMs || !isDatasetOwnerProjectionResponse(value.projection)
    || value.projection.epoch!==ref.epoch || value.projection.projectionRequestId!==ref.id) return false
  if (!value.projection.ok) return value.projection.failure.id === ref.id
  if (!isDatasetProjectionResult('normalizeLocalAlbumArtwork',value.projection.result)) return false
  const result=value.projection.result as {image:dto.LocalArtworkImage|null;status:'ready'|'source-unavailable'}
  return result.status === ref.sourceStatus && (result.status==='source-unavailable' || (ref.hasItems ? result.image!==null : result.image===null))
}
