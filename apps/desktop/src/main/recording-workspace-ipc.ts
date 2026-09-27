import { randomUUID } from 'node:crypto'
import { isCommandOutboxDatasetId, validateIpcRequest, type IpcCommandPayloads } from '@music-bridge/contracts'
import { CoreIpcError, type CoreSupervisor } from './core-supervisor.js'

/** 工作台读取固定窗口打开时的工作库；写入只能走持久命令队列。 */
export function installRecordingWorkspaceRead<E>(options: {
  handle(channel: string, handler: (event: E, value?: unknown) => unknown): void
  requireTrusted(event: E): void
  supervisor: Pick<CoreSupervisor, 'request'>
}): void {
  options.handle('recordingWorkspace:get', async (event, envelope) => {
    options.requireTrusted(event)
    const invalid = () => new Error('[INVALID_IPC_REQUEST] 工作台读取请求无效。')
    if (typeof envelope !== 'object' || envelope === null || Array.isArray(envelope)) throw invalid()
    const { datasetId, payload } = envelope as Record<string, unknown>
    if (Object.keys(envelope).length !== 2 || !isCommandOutboxDatasetId(datasetId)) throw invalid()
    const parsed = validateIpcRequest({ version: 1, id: randomUUID(), command: 'recordingWorkspace.get', payload })
    if (!parsed.ok) throw invalid()
    try { return await options.supervisor.request('recordingWorkspace.get', parsed.value.payload as IpcCommandPayloads['recordingWorkspace.get'], datasetId) }
    catch (error) {
      const code = error instanceof CoreIpcError ? error.code : 'INVENTORY_UNAVAILABLE'
      throw new Error(`[${code}] 工作台读取未获确认，请重新加载当前工作库。`)
    }
  })
  options.handle('collection:copy', async (event, envelope) => {
    options.requireTrusted(event)
    const invalid = () => new Error('[INVALID_IPC_REQUEST] 实体副本读取请求无效。')
    if (typeof envelope !== 'object' || envelope === null || Array.isArray(envelope)) throw invalid()
    const { datasetId, payload } = envelope as Record<string, unknown>
    if (Object.keys(envelope).length !== 2 || !isCommandOutboxDatasetId(datasetId)) throw invalid()
    const parsed = validateIpcRequest({ version: 1, id: randomUUID(), command: 'collection.copy', payload })
    if (!parsed.ok) throw invalid()
    try { return await options.supervisor.request('collection.copy', parsed.value.payload as IpcCommandPayloads['collection.copy'], datasetId) }
    catch (error) {
      const code = error instanceof CoreIpcError ? error.code : 'INVENTORY_UNAVAILABLE'
      throw new Error(code === 'INVENTORY_CONFLICT'
        ? '[INVENTORY_CONFLICT] 实体副本不存在或已改变，请刷新收藏。'
        : `[${code}] 实体副本读取未获确认，请重新加载当前工作库。`)
    }
  })
}
