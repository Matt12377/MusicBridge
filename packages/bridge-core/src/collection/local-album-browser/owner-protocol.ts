import * as dto from '@music-bridge/contracts'

export type LocalAlbumOwnerPublicReadRequest = {
  [C in dto.LocalAlbumCommand]: { command: C; payload: dto.LocalAlbumCommandPayloads[C] }
}[dto.LocalAlbumCommand]
export type LocalAlbumQueueRequest = { command: 'localAlbum.materializeQueue'; payload: { selection: dto.LocalPlayRequest; expiresAtMs: number } }
export type LocalAlbumOwnerReadRequest = LocalAlbumOwnerPublicReadRequest | LocalAlbumQueueRequest
export interface LocalAlbumQueueSnapshot {
  album: dto.LocalPlayAlbum
  sources: readonly Extract<dto.MBQueueLogicalSource, { kind: 'local_file' }>[]
  edition: dto.AlbumEdition | null
  startIndex: number
}
export type LocalAlbumOwnerReadResult = dto.LocalAlbumCommandResults[dto.LocalAlbumCommand] | LocalAlbumQueueSnapshot

function closed(value: unknown, names: readonly string[]): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value))
    && Reflect.ownKeys(value).length === names.length && names.every(key => Object.getOwnPropertyDescriptor(value,key)?.enumerable === true
      && Object.hasOwn(Object.getOwnPropertyDescriptor(value,key)!, 'value'))
}
export function isLocalAlbumQueueSnapshot(value: unknown, selection: dto.LocalPlayRequest): value is LocalAlbumQueueSnapshot {
  if (!dto.isLocalPlayRequest(selection)) return false
  const album = selection.album
  if (!album || !closed(value,['album','sources','edition','startIndex']) || !dto.isLocalPlayAlbum(value.album)
    || !Array.isArray(value.sources) || value.sources.length !== album.trackCount || value.sources.length > dto.MAX_MB_QUEUE_ENTRIES
    || Object.getPrototypeOf(value.sources) !== Array.prototype || Reflect.ownKeys(value.sources).length !== value.sources.length + 1
    || !Number.isSafeInteger(value.startIndex) || Number(value.startIndex) < 0 || Number(value.startIndex) >= value.sources.length
    || !(album.kind === 'edition' ? dto.isAlbumEdition(value.edition) && value.edition.id === album.editionId : value.edition === null)) return false
  const actualAlbum = value.album, edition = value.edition as dto.AlbumEdition | null
  if (Object.entries(album).some(([key,entry]) => actualAlbum[key as keyof dto.LocalPlayAlbum] !== entry)) return false
  for (let index = 0; index < value.sources.length; index++) {
    const property = Object.getOwnPropertyDescriptor(value.sources,index)
    if (!property || !property.enumerable || !Object.hasOwn(property,'value')) return false
    const source: unknown = property.value
    if (!dto.isMBQueueLogicalSource(source) || source.kind !== 'local_file' || source.snapshot.libraryRootId !== album.rootId
      || (edition ? source.edition?.id !== edition.id || source.edition.revision !== edition.revision : source.edition !== null)) return false
  }
  const sources = value.sources as LocalAlbumQueueSnapshot['sources'], start = sources[Number(value.startIndex)]!.snapshot
  return start.trackId === selection.local_track_id && start.assetId === selection.asset_id && start.fileRevision === selection.expected_asset_revision
    && sources.filter(source=>source.snapshot.trackId===selection.local_track_id).length === 1
    && new Set(sources.map(source=>source.snapshot.sourceRootId)).size === 1
    && new Set(sources.map(source=>source.snapshot.rootRevision)).size === 1
    && (album.kind === 'edition' || new Set(sources.map(source=>source.snapshot.trackId)).size === sources.length)
    && dto.mbQueueSerializedBytes(value) <= dto.MAX_MB_QUEUE_JSON_BYTES
}

/** 新只读 RPC 独立闭集，不能以 localAlbum 前缀放行未知命令。 */
export function isLocalAlbumOwnerReadRequest(value: unknown): value is LocalAlbumOwnerReadRequest {
  if (value === null || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    || Reflect.ownKeys(value).length !== 2 || !['command', 'payload'].every(key => Object.getOwnPropertyDescriptor(value, key)?.enumerable === true
      && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, 'value'))) return false
  const request = value as Record<string, unknown>
  if (request.command === 'localAlbum.materializeQueue') return closed(request.payload,['selection','expiresAtMs'])
    && dto.isLocalPlayRequest(request.payload.selection) && request.payload.selection.action === 'PLAY_NOW' && request.payload.selection.album !== undefined
    && typeof request.payload.expiresAtMs === 'number' && Number.isSafeInteger(request.payload.expiresAtMs) && request.payload.expiresAtMs > 0
  return dto.LOCAL_ALBUM_COMMANDS.some(command => command === request.command)
    && dto.isLocalAlbumCommandPayload(request.command as dto.LocalAlbumCommand, request.payload)
}

/** Client保存完整原请求后复核；不能仅凭响应operation或命令名接受另一页。 */
export function isLocalAlbumOwnerReadResult(value: unknown, original: LocalAlbumOwnerReadRequest): value is LocalAlbumOwnerReadResult {
  if (!isLocalAlbumOwnerReadRequest(original)) return false
  if (original.command === 'localAlbum.materializeQueue') return isLocalAlbumQueueSnapshot(value, original.payload.selection)
  if (!dto.isLocalAlbumCommandResult(original.command, value)) return false
  switch (original.command) {
    case 'localAlbum.query': return dto.isLocalAlbumPage(value, original.payload)
    case 'localAlbum.tracks': return dto.isLocalAlbumTrackPage(value, original.payload, (value as dto.LocalAlbumTrackPage).album)
    case 'localAlbum.artwork': return dto.isLocalAlbumArtworkReply(value, original.payload)
  }
}
