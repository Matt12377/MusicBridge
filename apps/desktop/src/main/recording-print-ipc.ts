import { randomUUID } from 'node:crypto'
import { validateIpcRequest, type CollectionPhotoImage, type IpcCommand, type IpcCommandPayloads } from '@music-bridge/contracts'
import { CoreIpcError, type CoreSupervisor } from './core-supervisor.js'
import type { exportRecordingPrintPdf } from './recording-print-export.js'

const commands = ['masterArtwork.get', 'masterArtwork.save', 'recordingPrints.list', 'recordingPrints.request', 'recordingPrints.retry', 'recordingPrints.get'] as const
const invalid = () => new Error('[INVALID_IPC_REQUEST] Artwork 或 J-Card 请求无效，请核对明确版本与档案身份。')
const scopeFailure = () => new Error('[OUTBOX_SCOPE_MISMATCH] 工作库已改变；本次原生操作不会绑定到另一工作库。')
type ExportOptions = Omit<Parameters<typeof exportRecordingPrintPdf>[0], 'select'>

/** 公开面只有八个明确职责；私有worker和PDF字节没有Renderer handler。 */
export function installRecordingPrintHandlers<E>(options: {
  handle(channel: string, handler: (event: E, value?: unknown) => unknown): void
  requireTrusted(event: E): void
  supervisor: Pick<CoreSupervisor, 'request' | 'requestInternal'>
  getEpoch(): number
  pickArtwork(event: E): Promise<CollectionPhotoImage | null>
  exportPdf(value: ExportOptions, event: E): ReturnType<typeof exportRecordingPrintPdf>
}): void {
  let nativeBusy = false
  function envelope(value: unknown, command: IpcCommand) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw invalid()
    const { datasetId, payload } = value as Record<string, unknown>
    if (Object.keys(value).length !== 2 || typeof datasetId !== 'string' || datasetId.length !== 36
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(datasetId)) throw invalid()
    const parsed = validateIpcRequest({ version: 1, id: randomUUID(), command, payload })
    if (!parsed.ok) throw invalid()
    return { datasetId, payload: structuredClone(parsed.value.payload) }
  }
  function scoped(event: E, datasetId: string) {
    const epoch = options.getEpoch()
    const isCurrent = () => epoch === options.getEpoch()
    return { isCurrent, assertCurrent: async () => {
      options.requireTrusted(event)
      if (!isCurrent()) throw scopeFailure()
      const context = await options.supervisor.request('commandOutbox.context', {}, datasetId)
      if (!isCurrent() || context.datasetId !== datasetId) throw scopeFailure()
    } }
  }
  for (const command of commands) options.handle(command.replace('.', ':'), async (event, value) => {
    options.requireTrusted(event)
    const parsed = envelope(value, command)
    try { return await options.supervisor.request(command, parsed.payload as IpcCommandPayloads[typeof command], parsed.datasetId) }
    catch (error) {
      const code = error instanceof CoreIpcError ? error.code : 'INVENTORY_UNAVAILABLE'
      throw new Error(`[${code}] 印刷资料操作未获确认；原录音档案与历史 PDF 保持不变。`)
    }
  })
  options.handle('masterArtwork:pick', async (event, value) => {
    options.requireTrusted(event)
    const parsed = envelope(value, 'masterArtwork.get'), payload = parsed.payload as IpcCommandPayloads['masterArtwork.get']
    if (Object.keys(payload).length !== 1) throw invalid()
    if (nativeBusy) throw new Error('[NOT_READY] 已有印刷资料选择或导出对话框。')
    nativeBusy = true
    try {
      const scope = scoped(event, parsed.datasetId)
      await scope.assertCurrent()
      await options.supervisor.request('masterArtwork.get', payload, parsed.datasetId)
      const image = await options.pickArtwork(event)
      if (!image) return { state: 'cancelled' }
      await scope.assertCurrent()
      await options.supervisor.request('masterArtwork.get', payload, parsed.datasetId)
      return { state: 'selected', masterVersionId: payload.masterVersionId, image }
    } catch (error) {
      if (error instanceof Error && error.message.includes('OUTBOX_SCOPE_MISMATCH')) throw scopeFailure()
      throw new Error('[ARTWORK_PICK_UNCONFIRMED] Artwork 选择未获确认，尚未保存新的版本。')
    } finally { nativeBusy = false }
  })
  options.handle('recordingPrints:export', async (event, value) => {
    options.requireTrusted(event)
    const parsed = envelope(value, 'recordingPrintWorker.pdf'), request = parsed.payload as IpcCommandPayloads['recordingPrintWorker.pdf']
    if (nativeBusy) throw new Error('[NOT_READY] 已有印刷资料选择或导出对话框。')
    nativeBusy = true
    try {
      const scope = scoped(event, parsed.datasetId)
      return await options.exportPdf({ request, ...scope,
        readPdf: () => options.supervisor.requestInternal('recordingPrintWorker.pdf', request, parsed.datasetId),
      }, event)
    } catch { throw new Error('[PRINT_EXPORT_UNCONFIRMED] PDF 导出未获确认；历史印刷文件仍保留，请核对工作库与目标文件。') }
    finally { nativeBusy = false }
  })
}
