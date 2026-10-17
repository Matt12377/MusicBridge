import { randomUUID } from 'node:crypto'
import { types } from 'node:util'
import { localAlbumTraceUUID, copyLocalAlbumSafeTrace, type LocalAlbumPrivateFailure } from '../../../../../packages/bridge-core/src/shared/library-read-trace.js'
import { runLocalAlbumContext, localAlbumTraceSha, localAlbumPhase, localAlbumMatch, localAlbumReject, localAlbumTerminal } from '../../../../../packages/bridge-core/src/shared/local-album-read-trace-node.js'
import * as dto from '@music-bridge/contracts'

type ReadRequest = { [C in dto.LocalAlbumCommand]: { command: C; payload: dto.LocalAlbumCommandPayloads[C] } }[dto.LocalAlbumCommand]
interface LocalAlbumEvent { senderFrame?: { url?: string } | null }
export interface LocalAlbumIpcOptions {
  ipcMain: { handle(channel: string, handler: (event: LocalAlbumEvent, value: unknown) => Promise<unknown>): void }
  assertTrusted(event: LocalAlbumEvent): void
  assertDataset(datasetId: string): void | Promise<void>
  read(request: ReadRequest, datasetId: string): Promise<dto.LocalAlbumCommandResults[dto.LocalAlbumCommand]>
}

/** 公共入口仅转发三种已验证只读命令；数据集切换前后都核对。 */
export function registerLocalAlbumIpc(options: LocalAlbumIpcOptions): void {
  options.ipcMain.handle('localAlbum:request', async (event, value) => {
    localAlbumPhase('main.trusted'); options.assertTrusted(event); localAlbumMatch('trusted', true)
    localAlbumPhase('main.envelope')
    if (value === null || typeof value !== 'object' || types.isProxy(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
      || ![3, 4].includes(Reflect.ownKeys(value).length) || Reflect.ownKeys(value).length === 4 && correlation(value) === null || !['datasetId', 'command', 'payload'].every(key => Object.getOwnPropertyDescriptor(value, key)?.enumerable === true
        && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, 'value'))) throw new Error('本地专辑读取请求无效。')
    const request = value as Record<string, unknown>
    if (!dto.isCommandOutboxDatasetId(request.datasetId) || !dto.LOCAL_ALBUM_COMMANDS.some(command => command === request.command)
      || !dto.isLocalAlbumCommandPayload(request.command as dto.LocalAlbumCommand, request.payload)) throw new Error('本地专辑读取请求无效。')
    const datasetId = request.datasetId, command = request.command as dto.LocalAlbumCommand
    localAlbumPhase('main.dataset'); await options.assertDataset(datasetId); localAlbumMatch('dataset', true)
    localAlbumPhase('main.trusted'); options.assertTrusted(event); localAlbumMatch('trusted', true)
    localAlbumPhase('main.dispatch'); const result = await options.read(structuredClone({ command, payload: request.payload }) as ReadRequest, datasetId)
    localAlbumPhase('main.trusted'); options.assertTrusted(event); localAlbumMatch('trusted', true); localAlbumPhase('main.dataset'); await options.assertDataset(datasetId); localAlbumMatch('dataset', true)
    localAlbumPhase('main.trusted'); options.assertTrusted(event); localAlbumMatch('trusted', true)
    localAlbumPhase('main.dto')
    if (!dto.isLocalAlbumCommandResult(command, result)
      || command === 'localAlbum.query' && !dto.isLocalAlbumPage(result, request.payload as dto.LocalAlbumQuery)
      || command === 'localAlbum.tracks' && !dto.isLocalAlbumTrackPage(result, request.payload as dto.LocalAlbumTrackQuery, (result as dto.LocalAlbumTrackPage).album)
      || command === 'localAlbum.artwork' && !dto.isLocalAlbumArtworkReply(result, request.payload as dto.LocalAlbumArtworkRequest)) throw new Error('本地专辑读取结果无效。')
    return structuredClone(result)
  })
}

/** 关联只使用内部UUID；不参与可信frame/Author/dataset的准入。 */
function correlation(value: unknown): string | null {
  try {
    if (!value || typeof value !== 'object' || types.isProxy(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) || Reflect.ownKeys(value).length !== 4) return null
    const keys = ['datasetId', 'command', 'payload', 'correlationId']
    if (!keys.every(key => { const d = Object.getOwnPropertyDescriptor(value, key); return d?.enumerable === true && Object.hasOwn(d, 'value') })) return null
    const id = Object.getOwnPropertyDescriptor(value, 'correlationId')!.value
    return localAlbumTraceUUID(id) ? id : null
  } catch { return null }
}
/** 必须包住Main第一次trusted/Author检查，旧三字段仍保持原reject语义。 */
export function runLocalAlbumMainRead<T>(value: unknown, action: () => Promise<T>): Promise<T | LocalAlbumPrivateFailure> {
  const correlationId = correlation(value), id = randomUUID()
  return runLocalAlbumContext(id, correlationId ? localAlbumTraceSha(correlationId) : null, 'main.receive', async () => {
    try { return await action() } catch (error) {
      localAlbumReject(error)
      const original = localAlbumTerminal('reject')
      if (!correlationId || !original) throw error
      const trace = copyLocalAlbumSafeTrace({ ...original, traceSha256: localAlbumTraceSha(correlationId), parentSha256: original.traceSha256 })
      if (!trace) throw error
      return { version: 1 as const, type: 'local-album-private-failure' as const, correlationId, trace }
    }
  }, correlationId !== null)
}
