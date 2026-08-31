import { randomUUID } from 'node:crypto'
import { validateIpcRequest, type IpcCommandPayloads } from '@music-bridge/contracts'
import { CoreIpcError, type CoreSupervisor } from './core-supervisor.js'

const reads = ['recordingPlans.list', 'recordingPlans.version', 'recordingPlans.preview', 'recordingPlans.preflight', 'recordingPlans.cancelRead'] as const

/** 计划冻结只能通过持久outbox；读取和取消读取不写计划或库存。 */
export function installRecordingPlanReads<E>(options: {
  handle(channel: string, handler: (event: E, value?: unknown) => unknown): void
  requireTrusted(event: E): void
  supervisor: Pick<CoreSupervisor, 'request'>
}): void {
  for (const command of reads) options.handle(command.replace('.', ':'), async (event, payload) => {
    options.requireTrusted(event)
    const parsed = validateIpcRequest({ version: 1, id: randomUUID(), command, payload })
    if (!parsed.ok) throw new Error('[INVALID_IPC_REQUEST] 录音计划请求无效，请核对输入和页面版本。')
    try { return await options.supervisor.request(command, parsed.value.payload as IpcCommandPayloads[typeof command]) }
    catch (error) { throw new Error(`[${error instanceof CoreIpcError ? error.code : 'INVENTORY_UNAVAILABLE'}] 录音计划暂时不可用，已有计划和历史记录保留。`) }
  })
}
