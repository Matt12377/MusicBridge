import { IPC_VERSION, isLibraryReadCommand, validateIpcRequest, type LibraryReadRequest } from '@music-bridge/contracts'
import { CoreIpcError, type CoreSupervisor } from './core-supervisor.js'
import { emitLibraryReadTrace, libraryReadTraceFailure, readLibraryReadTerminalMetadata, type LibraryReadTraceReason, type LibraryReadTraceSink } from '../shared/library-read-trace.js'

/** 窗口独占自己的 readId；同一个 ID 不允许同时覆盖旧请求。 */
export function createLibraryReadBroker(supervisor: Pick<CoreSupervisor, 'request'>, options: { trace?: LibraryReadTraceSink } = {}) {
  const pending = new Map<string, { owner: number; controller: AbortController; command: LibraryReadRequest['command'] }>()
  const recent = new Map<string, { owner: number; command: LibraryReadRequest['command']; at: number }>()
  const emit = (stage: string, id: string, command: LibraryReadRequest['command'], fields: Record<string, unknown> = {}): void => emitLibraryReadTrace(options.trace, { stage, rendererReadId: id, command, ...fields })
  function cancel(owner: number, id: unknown, metadata?: unknown): void {
    if (typeof id !== 'string' || !id.trim() || id.length > 128) throw new CoreIpcError('INVALID_IPC_REQUEST', '读取 ID 无效')
    const read = pending.get(id)
    if (read && read.owner !== owner) throw new CoreIpcError('INVALID_IPC_REQUEST', '不能取消其他窗口的读取')
    const closed = recent.get(id)
    if (closed && closed.owner !== owner) throw new CoreIpcError('INVALID_IPC_REQUEST', '读取诊断仅允许原窗口')
    const trace = metadata === undefined ? undefined : readLibraryReadTerminalMetadata(metadata)
    if (metadata !== undefined && (!trace || trace.stage === 'renderer.dispatch')) throw new CoreIpcError('INVALID_IPC_REQUEST', '读取诊断阶段无效')
    if (trace?.stage === 'renderer.return') {
      // 回执只属于已知读取，不执行取消；历史有界且不保留业务参数。
      if (read || closed && Date.now() - closed.at <= 30_000) emit(trace.stage, id, (read ?? closed)!.command, { ...(trace.outcome ? { outcome: trace.outcome } : {}), ...(trace.code ? { code: trace.code } : {}) })
      return
    }
    if (read) {
      const reason = trace?.reason ?? 'renderer-cancel'
      if (trace) emit('renderer.cancel', id, read.command, { reason })
      emit('main.cancel', id, read.command, { reason })
      read.controller.abort(Object.assign(new CoreIpcError('CANCELLED', '读取已取消'), { libraryReadSource: reason }))
    }
  }
  async function read(owner: number, input: unknown, metadata?: unknown): Promise<unknown> {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new CoreIpcError('INVALID_IPC_REQUEST', '读取请求无效')
    const value = input as LibraryReadRequest
    if (Object.keys(value).some(key => !['id', 'command', 'payload', 'deadlineAtMs', 'cacheMode'].includes(key)) || !isLibraryReadCommand(value.command)) throw new CoreIpcError('INVALID_IPC_REQUEST', '只读命令无效')
    const parsed = validateIpcRequest({ version: IPC_VERSION, id: value.id, command: value.command, payload: value.payload, readContext: { deadlineAtMs: value.deadlineAtMs,
      ...(value.cacheMode !== undefined ? { cacheMode: value.cacheMode } : {}) } })
    if (!parsed.ok) throw new CoreIpcError(parsed.error.code, parsed.error.message)
    const trace = metadata === undefined ? undefined : readLibraryReadTerminalMetadata(metadata)
    if (metadata !== undefined && trace?.stage !== 'renderer.dispatch') throw new CoreIpcError('INVALID_IPC_REQUEST', '读取诊断阶段无效')
    if (pending.has(value.id) || pending.size >= 256) throw new CoreIpcError('INVALID_IPC_REQUEST', '读取 ID 冲突或预算已满')
    const owned = { owner, controller: new AbortController(), command: value.command }
    pending.set(value.id, owned)
    if (trace) emit('renderer.dispatch', value.id, value.command)
    emit('main.receive', value.id, value.command)
    try {
      const result = await supervisor.request(value.command, value.payload, undefined, { signal: owned.controller.signal, deadlineAtMs: value.deadlineAtMs,
        ...(options.trace ? { trace: { rendererReadId: value.id } } : {}), ...(value.cacheMode !== undefined ? { cacheMode: value.cacheMode } : {}) })
      emit('main.finish', value.id, value.command, { outcome: 'ok' })
      return result
    } catch (error) { emit('main.finish', value.id, value.command, libraryReadTraceFailure(error)); throw error }
    finally {
      if (pending.get(value.id) === owned) pending.delete(value.id)
      if (recent.size >= 256) recent.delete(recent.keys().next().value!)
      recent.set(value.id, { owner, command: value.command, at: Date.now() })
    }
  }
  function cancelOwner(owner: number, source: LibraryReadTraceReason = 'owner-destroyed'): void {
    for (const [id, value] of pending) if (value.owner === owner) {
      emit('main.cancel', id, value.command, { reason: source })
      value.controller.abort(Object.assign(new CoreIpcError('CANCELLED', '读取已取消'), { libraryReadSource: source }))
    }
  }
  return { read, cancel, cancelOwner }
}
