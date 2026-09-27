import type { CollectionCopyDetail, CollectionPublicApi, RecordingWorkspaceContext, RecordingWorkspacePublicApi } from '@music-bridge/contracts'
import { createCommandOutboxDatasetScope, type DatasetScope } from './command-outbox-client.js'

const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value)
const physicalId = (value: unknown): value is string => typeof value === 'string' && /^MB-[CD]-\d{5,9}$/u.test(value)
const positiveInteger = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 1
const keys = (value: Record<string, unknown>, allowed: readonly string[]): boolean => Object.keys(value).every(key => allowed.includes(key))

/** sandbox 预加载仅验证响应信封与交叉身份；CoreSupervisor 已按合同验证完整领域 DTO。 */
function workspaceContextEnvelope(value: unknown, draftId: string): value is RecordingWorkspaceContext {
  return record(value) && keys(value, ['draftId', 'draftRevision', 'contextRevision', 'selection', 'pagePosition', 'staleReasons'])
    && value.draftId === draftId && positiveInteger(value.draftRevision) && positiveInteger(value.contextRevision)
    && record(value.selection) && typeof value.pagePosition === 'string' && Array.isArray(value.staleReasons)
}

function copyDetailEnvelope(value: unknown, requestedPhysicalId: string): value is CollectionCopyDetail {
  if (!record(value) || !keys(value, ['modelId', 'copy', 'copyIndex']) || !uuid(value.modelId) || !record(value.copy)) return false
  const copy = value.copy
  return copy.physicalId === requestedPhysicalId && physicalId(copy.physicalId)
    && positiveInteger(copy.revision) && typeof copy.available === 'boolean'
    && typeof copy.usage === 'string' && ['blank', 'reserved', 'recorded', 'unknown', 'erased'].includes(copy.usage)
    && (value.copyIndex === undefined || Number.isSafeInteger(value.copyIndex) && Number(value.copyIndex) >= 0)
}

/** 读取与写入共用预加载时确定的工作库；激活另一工作库后旧窗口必须重载。 */
export function createRecordingWorkspaceClient(
  invoke: (channel: string, value?: unknown) => Promise<unknown>,
  put: RecordingWorkspacePublicApi['putRecordingWorkspaceContext'],
  getDatasetId: DatasetScope = createCommandOutboxDatasetScope(invoke),
): RecordingWorkspacePublicApi & Pick<CollectionPublicApi, 'getCollectionCopy'> {
  const failure = () => new Error('[OUTBOX_SCOPE_MISMATCH] 工作库身份未获确认，请重新加载录音窗口。')
  const scope = getDatasetId().catch(() => { throw failure() })
  void scope.catch(() => undefined)
  return {
    async getRecordingWorkspaceContext(draftId) {
      const result = await invoke('recordingWorkspace:get', { datasetId: await scope, payload: { draftId } })
      if (!record(result) || Object.keys(result).length !== 1 || !('context' in result)
        || result.context !== null && !workspaceContextEnvelope(result.context, draftId)) {
        throw new Error('[INVALID_IPC_RESPONSE] 工作台读取结果无效，请重新加载当前工作库。')
      }
      return result.context
    },
    async getCollectionCopy(physicalId) {
      if (!physicalId || !/^MB-[CD]-\d{5,9}$/u.test(physicalId)) throw new Error('[INVALID_IPC_REQUEST] 实体副本编号无效。')
      const result = await invoke('collection:copy', { datasetId: await scope, payload: { physicalId } })
      if (!copyDetailEnvelope(result, physicalId)) {
        throw new Error('[INVALID_IPC_RESPONSE] 实体副本读取结果无效，请重新加载当前工作库。')
      }
      return result
    },
    putRecordingWorkspaceContext: put,
  }
}
