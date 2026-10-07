import { randomUUID } from 'node:crypto'
import * as dto from '@music-bridge/contracts'
import { CoreIpcError, type CoreSupervisor } from './core-supervisor.js'

const ordinary = ['localLegacyLinks.read', 'localLegacyLinks.history', 'localLegacyLinks.preview'] as const
/** 只读与具体预览使用闭集入口；三种保存命令只由原持久 outbox 执行。 */
export function installLocalLegacyLinksHandlers<E>(options: {
  handle(channel: string, handler: (event: E, value?: unknown) => unknown): void
  requireTrusted(event: E): void
  supervisor: Pick<CoreSupervisor, 'request'>
}): void {
  options.handle('localLegacyLinks:request', async (event, value) => {
    options.requireTrusted(event)
    try { value = dto.localLegacyLinksDataSnapshot(value, 16384, 2048, 100) }
    catch { throw new Error('[INVALID_IPC_REQUEST] 本地关联合同无效。') }
    if (!dto.localLegacyRecord(value, ['datasetId', 'command', 'payload']) || !dto.isCommandOutboxDatasetId(value.datasetId)
      || typeof value.command !== 'string' || !(ordinary as readonly string[]).includes(value.command)) {
      throw new Error('[INVALID_IPC_REQUEST] 本地关联合同无效。')
    }
    const command = value.command as typeof ordinary[number]
    if (!dto.isLocalLegacyLinksCommandPayload(command, value.payload) || value.payload.datasetId !== value.datasetId) {
      throw new Error('[INVALID_IPC_REQUEST] 本地关联范围或字段无效。')
    }
    const request = dto.validateIpcRequest({ version: dto.IPC_VERSION, id: randomUUID(), command, payload: value.payload, expectedDatasetId: value.datasetId })
    if (!request.ok) throw new Error('[INVALID_IPC_REQUEST] 本地关联逻辑请求无效。')
    try {
      const result = dto.localLegacyLinksDataSnapshot(await options.supervisor.request(command, request.value.payload as dto.LocalLegacyLinksCommandPayloads[typeof command], value.datasetId), dto.LOCAL_LEGACY_LINKS_BUDGET.publicPageBytes, 32768, 100)
      if (!dto.isLocalLegacyLinksCommandResult(command, result) || result.datasetId !== value.datasetId) {
        throw new Error('[INVALID_IPC_RESPONSE] 本地关联回执身份无效。')
      }
      return result
    } catch (error) {
      if (error instanceof CoreIpcError && error.code === 'INVENTORY_CONFLICT') {
        throw new Error('[INVENTORY_CONFLICT] 关联端点、修订或源证据已变化，请重新读取并预览。')
      }
      throw new Error('[INVENTORY_UNAVAILABLE] 本地关联暂时无法核对，已有记录保留；请重新读取。')
    }
  })
}
