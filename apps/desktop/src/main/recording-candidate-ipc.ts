import { randomUUID } from 'node:crypto'
import { isCommandOutboxDatasetId, validateIpcRequest, type IpcCommandPayloads } from '@music-bridge/contracts'
import { CoreIpcError, type CoreSupervisor } from './core-supervisor.js'

type CandidateCommand = 'recordingCandidates.start' | 'recordingCandidates.get' | 'recordingCandidates.cancel'
const commands = new Set<CandidateCommand>(['recordingCandidates.start', 'recordingCandidates.get', 'recordingCandidates.cancel'])
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

/** 临时候选不入持久命令队列；每次读取仍固定在窗口打开时的工作库身份。 */
export function installRecordingCandidateHandlers<E>(options: {
  handle(channel: string, handler: (event: E, value?: unknown) => unknown): void
  requireTrusted(event: E): void
  supervisor: Pick<CoreSupervisor, 'request'>
}): void {
  options.handle('recordingCandidates:request', async (event, envelope) => {
    options.requireTrusted(event)
    const invalid = () => new Error('[INVALID_IPC_REQUEST] 候选扫描请求无效。')
    if (!record(envelope) || Object.keys(envelope).length !== 3) throw invalid()
    const { datasetId, command, payload } = envelope
    if (!isCommandOutboxDatasetId(datasetId) || typeof command !== 'string' || !commands.has(command as CandidateCommand)) throw invalid()
    const parsed = validateIpcRequest({ version: 1, id: randomUUID(), command, payload })
    if (!parsed.ok) throw invalid()
    try {
      switch (command) {
        case 'recordingCandidates.start': return await options.supervisor.request(command, parsed.value.payload as IpcCommandPayloads[typeof command], datasetId)
        case 'recordingCandidates.get': return await options.supervisor.request(command, parsed.value.payload as IpcCommandPayloads[typeof command], datasetId)
        case 'recordingCandidates.cancel': return await options.supervisor.request(command, parsed.value.payload as IpcCommandPayloads[typeof command], datasetId)
      }
    } catch (error) {
      const code = error instanceof CoreIpcError ? error.code : 'INVENTORY_UNAVAILABLE'
      throw new Error(`[${code}] 候选扫描未获确认，请核对当前工作库后重试。`)
    }
    throw invalid()
  })
}
