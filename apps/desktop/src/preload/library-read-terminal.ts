import type { IpcCommandResults, LibraryReadCommand, LibraryReadPublicApi, LibraryReadRequest } from '@music-bridge/contracts'
import { libraryReadTraceFailure, type LibraryReadTerminalMetadata } from '../shared/library-read-trace.js'

/** 只回送本次具名读取的有限首尾信息；Renderer 得不到任意日志或 invoke 能力。 */
export function createLibraryReadTerminalClient(
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>,
  enabled: boolean,
): LibraryReadPublicApi {
  const pending = new Map<string, number>()
  const receipt = (id: string, metadata: LibraryReadTerminalMetadata): void => {
    if (!enabled) return
    try { void invoke('library:cancel-read', id, metadata).catch(() => undefined) }
    catch { /* 诊断回执不能覆盖原读取结果。 */ }
  }
  return {
    async readLibrary<C extends LibraryReadCommand>(request: LibraryReadRequest<C>): Promise<IpcCommandResults[C]> {
      const id = request && typeof request.id === 'string' && request.id.length > 0 && request.id.length <= 128 ? request.id : undefined
      if (enabled && id !== undefined && pending.size < 256) pending.set(id, request.deadlineAtMs)
      try {
        const result = await invoke('library:read', request, ...(enabled ? [{ __musicBridgeLibraryReadTrace: 1, stage: 'renderer.dispatch' } satisfies LibraryReadTerminalMetadata] : []))
        if (id !== undefined) receipt(id, { __musicBridgeLibraryReadTrace: 1, stage: 'renderer.return', outcome: 'ok' })
        return result as IpcCommandResults[C]
      } catch (error) {
        const failure = libraryReadTraceFailure(error)
        if (id !== undefined) receipt(id, { __musicBridgeLibraryReadTrace: 1, stage: 'renderer.return', outcome: failure.outcome, code: failure.code })
        throw error
      } finally { if (id !== undefined) pending.delete(id) }
    },
    async cancelLibraryRead(id: string): Promise<void> {
      const deadline = pending.get(id)
      await invoke('library:cancel-read', id, ...(enabled ? [{ __musicBridgeLibraryReadTrace: 1, stage: 'renderer.cancel', reason: deadline !== undefined && Date.now() >= deadline ? 'renderer-deadline' : 'renderer-cancel' } satisfies LibraryReadTerminalMetadata] : []))
    },
  }
}
