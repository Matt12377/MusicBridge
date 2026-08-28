import { randomUUID } from 'node:crypto'
import { validateIpcRequest, type IpcCommandPayloads } from '@music-bridge/contracts'
import { CoreIpcError, type CoreSupervisor } from './core-supervisor.js'

const reads = ['recordingOutput.status', 'recordingOutput.check', 'recordingOutput.cancel'] as const

/** 仅无设备合成核验；不能经此入口授权设备、认证后端或写入outbox。 */
export function installRecordingOutputReads<E>(options: {
  handle(channel: string, handler: (event: E, value?: unknown) => unknown): void
  requireTrusted(event: E): void
  supervisor: Pick<CoreSupervisor, 'request'>
}): void {
  for (const command of reads) options.handle(command.replace('.', ':'), async (event, payload) => {
    options.requireTrusted(event)
    const parsed = validateIpcRequest({ version: 1, id: randomUUID(), command, payload })
    if (!parsed.ok) throw new Error('[INVALID_IPC_REQUEST] 输出核验请求无效，请核对计划和面选择。')
    try { return await options.supervisor.request(command, parsed.value.payload as IpcCommandPayloads[typeof command]) }
    catch (error) { throw new Error(`[${error instanceof CoreIpcError ? error.code : 'INVENTORY_UNAVAILABLE'}] 输出核验暂时不可用；未授予设备访问或正式录音权限。`) }
  })
}
