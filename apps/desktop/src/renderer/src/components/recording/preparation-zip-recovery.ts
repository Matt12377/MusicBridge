import { isCollectionId, isPreparationZipReceiptRequest, type PreparationZipReceiptRequest } from '@music-bridge/contracts'

export type PendingPreparationZipOperation = PreparationZipReceiptRequest & { draftId: string; workspaceId: string; windowEpoch: string }

export interface ZipRecoveryStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

const key = (datasetId: string, draftId: string): string => `musicbridge.preparationZip.pending.v1.${datasetId}.${draftId}`
const epochKey = 'musicbridge.preparationZip.windowEpoch.v1'
export function zipWindowEpoch(storage: ZipRecoveryStorage, createId: () => string): string {
  const existing = storage.getItem(epochKey)
  if (existing && isCollectionId(existing)) return existing
  const epoch = createId()
  if (!isCollectionId(epoch)) throw new Error('ZIP 窗口身份无效。')
  storage.setItem(epochKey, epoch)
  return epoch
}
const valid = (value: unknown, draftId: string): value is PendingPreparationZipOperation => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  if (Object.keys(record).sort().join(',') !== 'draftId,kind,request,windowEpoch,workspaceId' || record.draftId !== draftId || !isCollectionId(record.workspaceId) || !isCollectionId(record.windowEpoch)
    || !isPreparationZipReceiptRequest({ kind: record.kind, request: record.request })) return false
  return record.kind !== 'start' || (record.request as { workspaceId: string }).workspaceId === record.workspaceId
}

/** 仅存不含路径的原命令；工作库和草稿双重绑定，不能从其他库借用目标授权。 */
export function loadPendingPreparationZip(storage: ZipRecoveryStorage, datasetId: string, draftId: string): PendingPreparationZipOperation | undefined {
  if (!isCollectionId(datasetId) || !isCollectionId(draftId)) throw new Error('ZIP 恢复范围无效。')
  const encoded = storage.getItem(key(datasetId, draftId))
  if (encoded === null) return undefined
  if (encoded.length > 2048) throw new Error('ZIP 原命令记录无效，请保留任务历史并人工核验。')
  let parsed: unknown
  try { parsed = JSON.parse(encoded) } catch { throw new Error('ZIP 原命令记录无效，请保留任务历史并人工核验。') }
  if (!valid(parsed, draftId)) throw new Error('ZIP 原命令记录无效，请保留任务历史并人工核验。')
  return parsed
}

export function savePendingPreparationZip(storage: ZipRecoveryStorage, datasetId: string, value: PendingPreparationZipOperation): void {
  if (!isCollectionId(datasetId) || !valid(value, value.draftId)) throw new Error('ZIP 原命令记录无效。')
  storage.setItem(key(datasetId, value.draftId), JSON.stringify(value))
}

export function clearPendingPreparationZip(storage: ZipRecoveryStorage, datasetId: string, draftId: string): void {
  if (!isCollectionId(datasetId) || !isCollectionId(draftId)) throw new Error('ZIP 恢复范围无效。')
  storage.removeItem(key(datasetId, draftId))
}

/** 这些回复代表请求被明确拒绝；超时、进程断线与存储错误仍须留作未知。 */
export function isPreparationZipRejection(error: unknown): boolean {
  return error instanceof Error && /^\[(?:INVALID_IPC_REQUEST|INVENTORY_CONFLICT|OUTBOX_SCOPE_MISMATCH)\]/u.test(error.message)
}
