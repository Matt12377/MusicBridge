import { randomUUID } from 'node:crypto'
import { validateIpcRequest, type IpcCommandPayloads } from '@music-bridge/contracts'
import { CoreIpcError, type CoreSupervisor } from './core-supervisor.js'

const commands = ['recordingDevice.candidates', 'recordingDevice.select'] as const

/** 设备候选与显式选择固定当前窗口工作库；Main不接受UID或配置指纹。 */
export function installRecordingDeviceHandlers<E>(options: {
  handle(channel: string, handler: (event: E, value?: unknown) => unknown): void
  requireTrusted(event: E): void
  supervisor: Pick<CoreSupervisor, 'request'>
}): void {
  for (const command of commands) options.handle(command.replace('.', ':'), async (event, envelope) => {
    options.requireTrusted(event)
    const invalid = () => new Error('[INVALID_IPC_REQUEST] 输出设备请求无效，请重新读取候选。')
    if (typeof envelope !== 'object' || envelope === null || Array.isArray(envelope)) throw invalid()
    const { datasetId, payload } = envelope as Record<string, unknown>
    if (Object.keys(envelope).length !== 2 || typeof datasetId !== 'string' || datasetId.length !== 36
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(datasetId)) throw invalid()
    const parsed = validateIpcRequest({ version: 1, id: randomUUID(), command, payload })
    if (!parsed.ok) throw invalid()
    try { return await options.supervisor.request(command, parsed.value.payload as IpcCommandPayloads[typeof command], datasetId) }
    catch (error) {
      const code = error instanceof CoreIpcError ? error.code : 'INVENTORY_UNAVAILABLE'
      throw new Error(`[${code}] 输出设备候选或选择未获确认，请重新读取；不会自动切换默认设备。`)
    }
  })
}
