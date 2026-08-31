import { randomUUID } from 'node:crypto'
import { validateIpcRequest, type IpcCommandPayloads } from '@music-bridge/contracts'
import { CoreIpcError, type CoreSupervisor } from './core-supervisor.js'

const reads = ['collectionProgress.wants', 'collectionProgress.wantHistory', 'collectionProgress.current',
  'collectionProgress.snapshots', 'collectionProgress.snapshot', 'collectionProgress.modelLengths'] as const

/** 求购和快照写命令走持久outbox；这些入口只读，不产生历史记录。 */
export function installCollectionProgressReads<E>(options: {
  handle(channel: string, handler: (event: E, value?: unknown) => unknown): void
  requireTrusted(event: E): void
  supervisor: Pick<CoreSupervisor, 'request'>
}): void {
  for (const command of reads) options.handle(command.replace('.', ':'), async (event, payload) => {
    options.requireTrusted(event)
    const parsed = validateIpcRequest({ version: 1, id: randomUUID(), command, payload })
    if (!parsed.ok) throw new Error('[INVALID_IPC_REQUEST] 求购或完成度请求无效，请核对输入和页面版本。')
    try { return await options.supervisor.request(command, parsed.value.payload as IpcCommandPayloads[typeof command]) }
    catch (error) { throw new Error(`[${error instanceof CoreIpcError ? error.code : 'INVENTORY_UNAVAILABLE'}] 收藏完成度暂时不可用，已有目标和历史记录保留。`) }
  })
}
