import { randomUUID } from 'node:crypto'
import { validateIpcRequest, type IpcCommandPayloads } from '@music-bridge/contracts'
import { CoreIpcError, type CoreSupervisor } from './core-supervisor.js'

const reads = ['spreadsheetImports.sources', 'spreadsheetImports.source', 'spreadsheetImports.sourceRows', 'spreadsheetImports.preview',
  'spreadsheetImports.revision', 'spreadsheetImports.history', 'spreadsheetImports.adjustmentPreview', 'spreadsheetImports.adjustments'] as const

/** 原生选择与写命令走持久outbox；此处只有分页读取和纯预览。 */
export function installSpreadsheetImportReads<E>(options: {
  handle(channel: string, handler: (event: E, value?: unknown) => unknown): void
  requireTrusted(event: E): void
  supervisor: Pick<CoreSupervisor, 'request'>
}): void {
  for (const command of reads) options.handle(command.replace('.', ':'), async (event, payload) => {
    options.requireTrusted(event)
    const parsed = validateIpcRequest({ version: 1, id: randomUUID(), command, payload })
    if (!parsed.ok) throw new Error('[INVALID_IPC_REQUEST] Excel请求无效，请核对输入和页面版本。')
    try { return await options.supervisor.request(command, parsed.value.payload as IpcCommandPayloads[typeof command]) }
    catch (error) { throw new Error(`[${error instanceof CoreIpcError ? error.code : 'INVENTORY_UNAVAILABLE'}] Excel来源暂时不可用，已有库存和导入记录保留。`) }
  })
}
