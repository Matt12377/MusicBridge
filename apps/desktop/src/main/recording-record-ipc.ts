import { randomUUID } from 'node:crypto'
import { validateIpcRequest, type IpcCommandPayloads } from '@music-bridge/contracts'
import { CoreIpcError, type CoreSupervisor } from './core-supervisor.js'

const commands = ['recordingRecords.list', 'recordingRecords.get', 'recordingRecords.visual', 'recordingRecords.history', 'recordingRecords.previewDisposition', 'recordingRecords.applyDisposition'] as const

/** 六个档案入口固定原工作库；处置使用Core原子回执，不入自动outbox。 */
export function installRecordingRecordHandlers<E>(options: {
  handle(channel: string, handler: (event: E, value?: unknown) => unknown): void
  requireTrusted(event: E): void
  supervisor: Pick<CoreSupervisor, 'request'>
}): void {
  for (const command of commands) options.handle(command.replace('.', ':'), async (event, envelope) => {
    options.requireTrusted(event)
    const invalid = () => new Error('[INVALID_IPC_REQUEST] 录音档案请求无效，请核对实体编号、版本和处置意图。')
    if (typeof envelope !== 'object' || envelope === null || Array.isArray(envelope)) throw invalid()
    const { datasetId, payload } = envelope as Record<string, unknown>
    if (Object.keys(envelope).length !== 2 || typeof datasetId !== 'string' || datasetId.length !== 36
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(datasetId)) throw invalid()
    const parsed = validateIpcRequest({ version: 1, id: randomUUID(), command, payload })
    if (!parsed.ok) throw invalid()
    try { return await options.supervisor.request(command, parsed.value.payload as IpcCommandPayloads[typeof command], datasetId) }
    catch (error) {
      const code = error instanceof CoreIpcError ? error.code : 'INVENTORY_UNAVAILABLE'
      throw new Error(`[${code}] 档案操作未获确认，请刷新当前实体状态；历史档案不会因此改写。`)
    }
  })
}
