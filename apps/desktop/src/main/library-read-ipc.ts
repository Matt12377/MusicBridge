import { IPC_VERSION, isLibraryReadCommand, validateIpcRequest, type LibraryReadRequest } from '@music-bridge/contracts'
import { CoreIpcError, type CoreSupervisor } from './core-supervisor.js'

/** 窗口独占自己的 readId；同一个 ID 不允许同时覆盖旧请求。 */
export function createLibraryReadBroker(supervisor: Pick<CoreSupervisor, 'request'>) {
  const pending = new Map<string, { owner: number; controller: AbortController }>()
  function cancel(owner: number, id: unknown): void {
    if (typeof id !== 'string' || !id.trim() || id.length > 128) throw new CoreIpcError('INVALID_IPC_REQUEST', '读取 ID 无效')
    const read = pending.get(id)
    if (read && read.owner !== owner) throw new CoreIpcError('INVALID_IPC_REQUEST', '不能取消其他窗口的读取')
    read?.controller.abort()
  }
  async function read(owner: number, input: unknown): Promise<unknown> {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new CoreIpcError('INVALID_IPC_REQUEST', '读取请求无效')
    const value = input as LibraryReadRequest
    if (Object.keys(value).some(key => !['id', 'command', 'payload', 'deadlineAtMs', 'cacheMode'].includes(key)) || !isLibraryReadCommand(value.command)) throw new CoreIpcError('INVALID_IPC_REQUEST', '只读命令无效')
    const parsed = validateIpcRequest({ version: IPC_VERSION, id: value.id, command: value.command, payload: value.payload, readContext: { deadlineAtMs: value.deadlineAtMs,
      ...(value.cacheMode !== undefined ? { cacheMode: value.cacheMode } : {}) } })
    if (!parsed.ok) throw new CoreIpcError(parsed.error.code, parsed.error.message)
    if (pending.has(value.id) || pending.size >= 256) throw new CoreIpcError('INVALID_IPC_REQUEST', '读取 ID 冲突或预算已满')
    const owned = { owner, controller: new AbortController() }
    pending.set(value.id, owned)
    try { return await supervisor.request(value.command, value.payload, undefined, { signal: owned.controller.signal, deadlineAtMs: value.deadlineAtMs,
      ...(value.cacheMode !== undefined ? { cacheMode: value.cacheMode } : {}) }) }
    finally { if (pending.get(value.id) === owned) pending.delete(value.id) }
  }
  function cancelOwner(owner: number): void {
    for (const value of pending.values()) if (value.owner === owner) value.controller.abort()
  }
  return { read, cancel, cancelOwner }
}
