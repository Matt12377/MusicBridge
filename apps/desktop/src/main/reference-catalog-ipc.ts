import { randomUUID } from 'node:crypto'
import { validateIpcRequest, type IpcCommandPayloads } from '@music-bridge/contracts'
import { CoreIpcError, type CoreSupervisor } from './core-supervisor.js'

const reads = ['referenceCatalog.sources', 'referenceCatalog.source', 'referenceCatalog.history',
  'referenceCatalog.revision', 'referenceCatalog.previewRevision', 'referenceCatalog.snapshot'] as const

/** 目录只读与纯预览入口；三个写操作仅经持久outbox进入Core。 */
export function installReferenceCatalogReads<E>(options: {
  handle(channel: string, handler: (event: E, value?: unknown) => unknown): void
  requireTrusted(event: E): void
  supervisor: Pick<CoreSupervisor, 'request'>
}): void {
  for (const command of reads) options.handle(command.replace('.', ':'), async (event, payload) => {
    options.requireTrusted(event)
    const parsed = validateIpcRequest({ version: 1, id: randomUUID(), command, payload })
    if (!parsed.ok) throw new Error('[INVALID_IPC_REQUEST] 参考目录请求无效，请核对版本和输入。')
    try { return await options.supervisor.request(command, parsed.value.payload as IpcCommandPayloads[typeof command]) }
    catch (error) { throw new Error(`[${error instanceof CoreIpcError ? error.code : 'INVENTORY_UNAVAILABLE'}] 参考目录暂时不可用，已有资料和历史保留。`) }
  })
}
