import { randomUUID } from 'node:crypto'
import { lstat, realpath } from 'node:fs/promises'
import path from 'node:path'
import { isCollectionId, isCommandOutboxDatasetId, validateIpcRequest, type IpcCommandPayloads } from '@music-bridge/contracts'
import { CoreIpcError, type CoreSupervisor } from './core-supervisor.js'

type ZipCommand = 'recordingPreparationZip.preview' | 'recordingPreparationZip.start' | 'recordingPreparationZip.list' | 'recordingPreparationZip.job' | 'recordingPreparationZip.receipt' | 'recordingPreparationZip.cancel'
const commands = new Set<ZipCommand>(['recordingPreparationZip.preview', 'recordingPreparationZip.start', 'recordingPreparationZip.list', 'recordingPreparationZip.job', 'recordingPreparationZip.receipt', 'recordingPreparationZip.cancel'])
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
class SafeZipError extends Error {}
const safeError = (code: string, message: string): SafeZipError => new SafeZipError(`[${code}] ${message}`)

async function inspectTarget(absolute: string): Promise<{ parentPath: string; parentDev: string; parentIno: string }> {
  const parentPath = path.dirname(absolute), canonical = await realpath(parentPath)
  const parent = await lstat(parentPath, { bigint: true })
  if (canonical !== parentPath || !parent.isDirectory() || parent.isSymbolicLink()) throw safeError('INVALID_IPC_REQUEST', 'ZIP 目标目录身份无效。')
  try { await lstat(absolute); throw safeError('INVENTORY_CONFLICT', '目标文件已存在，请改用新的 ZIP 文件名。') }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  return { parentPath, parentDev: String(parent.dev), parentIno: String(parent.ino) }
}

interface WindowScope { id: number; onInvalidated(listener: () => void): () => void }
interface ActiveScope { windowId: number; scopeId: string; datasetId: string; generation: number; targetId?: string; choosing: boolean; unlisten: () => void }

/** 另存路径只在 Main/Core 中传递；窗口导航、关闭或切库后立即撤销短时目标。 */
export function installPreparationZipHandlers<E>(options: {
  handle(channel: string, handler: (event: E, value?: unknown) => unknown): void
  windowFor(event: E): WindowScope
  choose(event: E, suggestedName: string): Promise<string | null>
  inspectTarget?: typeof inspectTarget
  supervisor: Pick<CoreSupervisor, 'request' | 'requestInternal'>
}): void {
  const scopes = new Map<number, ActiveScope>()
  const invalid = () => safeError('INVALID_IPC_REQUEST', 'Logic ZIP 请求无效，请重新选择工作区与另存目标。')
  const assertDataset = (value: unknown): string => {
    if (!isCommandOutboxDatasetId(value)) throw invalid()
    return value
  }
  const errorMessage = (error: unknown): Error => new Error(`[${error instanceof CoreIpcError ? error.code : 'INVENTORY_UNAVAILABLE'}] Logic ZIP 操作未获确认；请核对原命令回执，不会自动覆盖目标文件。`)
  const revoke = (scope: ActiveScope): void => {
    scope.unlisten()
    if (scopes.get(scope.windowId) === scope) scopes.delete(scope.windowId)
    void options.supervisor.requestInternal('recordingPreparationZip.invalidateScope', { scopeId: scope.scopeId }, scope.datasetId).catch(() => undefined)
  }
  function current(window: WindowScope, datasetId: string): ActiveScope {
    const existing = scopes.get(window.id)
    if (existing && existing.datasetId !== datasetId) { revoke(existing); throw safeError('OUTBOX_SCOPE_MISMATCH', '工作库已改变，请重新加载录音窗口。') }
    if (existing) return existing
    const scopeId = randomUUID()
    const scope: ActiveScope = { windowId: window.id, scopeId, datasetId, generation: 0, choosing: false, unlisten: () => undefined }
    scope.unlisten = window.onInvalidated(() => revoke(scope))
    scopes.set(window.id, scope)
    return scope
  }
  options.handle('recordingPreparationZip:choose', async (event, envelope) => {
    const window = options.windowFor(event)
    if (!record(envelope) || Object.keys(envelope).length !== 2 || !isCollectionId(envelope.workspaceId)) throw invalid()
    const datasetId = assertDataset(envelope.datasetId), scope = current(window, datasetId)
    if (scope.choosing) throw invalid()
    scope.choosing = true
    try {
      const absolute = await options.choose(event, `MusicBridge-Preparation-${String(envelope.workspaceId).slice(0, 8)}.zip`)
      if (scopes.get(window.id) !== scope) throw safeError('OUTBOX_SCOPE_MISMATCH', '窗口已改变，请重新选择目标。')
      if (absolute === null) return null
      if (!path.isAbsolute(absolute) || path.basename(absolute).length > 240 || !/\.zip$/iu.test(path.basename(absolute)) || absolute.includes('\0')) throw invalid()
      const { parentPath, parentDev, parentIno } = await (options.inspectTarget ?? inspectTarget)(absolute)
      if (scopes.get(window.id) !== scope) throw safeError('OUTBOX_SCOPE_MISMATCH', '窗口已改变，请重新选择目标。')
      const generation = scope.generation + 1, targetId = randomUUID()
      const payload: IpcCommandPayloads['recordingPreparationZip.authorizeTarget'] = {
        targetId, absolute, parentPath, parentDev, parentIno,
        datasetId, scopeId: scope.scopeId, generation, expiresAt: new Date(Date.now() + 4 * 60_000).toISOString(),
      }
      const result = await options.supervisor.requestInternal('recordingPreparationZip.authorizeTarget', payload, datasetId)
      if (scopes.get(window.id) !== scope) throw safeError('OUTBOX_SCOPE_MISMATCH', '窗口已改变，请重新选择目标。')
      scope.generation = generation; scope.targetId = targetId
      return result
    } catch (error) { throw error instanceof SafeZipError ? error : errorMessage(error) }
    finally { scope.choosing = false }
  })
  options.handle('recordingPreparationZip:request', async (event, envelope) => {
    const window = options.windowFor(event)
    if (!record(envelope) || Object.keys(envelope).length !== 3) throw invalid()
    const datasetId = assertDataset(envelope.datasetId), { command, payload } = envelope
    if (typeof command !== 'string' || !commands.has(command as ZipCommand)) throw invalid()
    const parsed = validateIpcRequest({ version: 1, id: randomUUID(), command, payload })
    if (!parsed.ok) throw invalid()
    const scope = current(window, datasetId)
    if ((command === 'recordingPreparationZip.preview' || command === 'recordingPreparationZip.start')
      && (!scope.targetId || !record(payload) || payload.targetId !== scope.targetId)) throw invalid()
    try {
      switch (command) {
        case 'recordingPreparationZip.preview': return await options.supervisor.request(command, parsed.value.payload as IpcCommandPayloads[typeof command], datasetId)
        case 'recordingPreparationZip.start': return await options.supervisor.request(command, parsed.value.payload as IpcCommandPayloads[typeof command], datasetId)
        case 'recordingPreparationZip.list': return await options.supervisor.request(command, parsed.value.payload as IpcCommandPayloads[typeof command], datasetId)
        case 'recordingPreparationZip.job': return await options.supervisor.request(command, parsed.value.payload as IpcCommandPayloads[typeof command], datasetId)
        case 'recordingPreparationZip.receipt': return await options.supervisor.request(command, parsed.value.payload as IpcCommandPayloads[typeof command], datasetId)
        case 'recordingPreparationZip.cancel': return await options.supervisor.request(command, parsed.value.payload as IpcCommandPayloads[typeof command], datasetId)
      }
    } catch (error) { throw errorMessage(error) }
    throw invalid()
  })
}
