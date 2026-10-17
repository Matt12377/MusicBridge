import * as dto from '@music-bridge/contracts'
import { groupLocalAlbumSnapshot, LocalAlbumReadError, LOCAL_ALBUM_MAX_BYTES, LOCAL_ALBUM_MAX_SCAN_FACTS, LOCAL_ALBUM_MAX_TRACKS } from './grouping.js'
import type { LocalAlbumGroup, LocalAlbumGroupedSnapshot, LocalAlbumInspectRequest, LocalAlbumReadServiceOptions } from './types.js'

const filters = ['all', ...dto.LOCAL_ALBUM_STATUSES] as const
const invalidRequest = (): never => { throw new LocalAlbumReadError('INVALID_REQUEST', '本地专辑请求无效，请重新选择。') }
const changed = (): never => { throw new LocalAlbumReadError('SNAPSHOT_CHANGED', '音乐库信息已变化，请重新读取专辑。') }
const unavailable = (): never => { throw new LocalAlbumReadError('UNAVAILABLE', '本地专辑暂时无法读取，请重试。') }
function option(value: number | undefined, fallback: number, maximum: number): number { return Number.isSafeInteger(value) && value! > 0 && value! <= maximum ? value! : fallback }
function freeze<T>(value: T): T { if (value && typeof value === 'object' && !Object.isFrozen(value)) { for (const child of Object.values(value)) freeze(child); Object.freeze(value) }; return value }
function equal(left: unknown, right: unknown): boolean {
  if (left === right) return true
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object' || Array.isArray(left) !== Array.isArray(right)) return false
  const keys = Object.keys(left)
  return keys.length === Object.keys(right).length && keys.every(key => Object.hasOwn(right, key) && equal((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]))
}

/** 缓存只保留紧凑公开事实与作者内部目录身份；详情按页读，封面按需读。 */
export function createLocalAlbumReadService(options: LocalAlbumReadServiceOptions) {
  const maxTracks = option(options.maxTracks, LOCAL_ALBUM_MAX_TRACKS, LOCAL_ALBUM_MAX_TRACKS)
  const maxScanFacts = option(options.maxScanFacts, LOCAL_ALBUM_MAX_SCAN_FACTS, LOCAL_ALBUM_MAX_SCAN_FACTS)
  const maxBytes = option(options.maxBytes, LOCAL_ALBUM_MAX_BYTES, 512 * 1024 * 1024)
  let cache: LocalAlbumGroupedSnapshot | undefined, disposed = false
  let groupsById = new Map<string, LocalAlbumGroup>(), roots = new Set<string>()
  const queryCache = new Map<string, { scoped: readonly LocalAlbumGroup[]; counts: dto.LocalAlbumFilterCounts }>()
  function protect<T>(action: () => T): T {
    try { if (disposed) return unavailable(); return action() } catch (error) { if (error instanceof LocalAlbumReadError) throw error; return unavailable() }
  }
  function lease(): LocalAlbumGroupedSnapshot {
    const revision = options.port.readRevision()
    if (typeof revision !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:@-]{0,255}$/u.test(revision)) return unavailable()
    if (cache?.revision === revision) return cache
    const snapshot = options.port.readSnapshot({ expectedRevision: revision, maxTracks, maxScanFacts, maxBytes })
    const grouped = groupLocalAlbumSnapshot(snapshot, { expectedRevision: revision, maxTracks, maxScanFacts, maxBytes })
    if (options.port.readRevision() !== revision) return changed()
    // 克隆只发生于快照修订变化；翻页和封面读取不重新装载全库。
    cache = freeze(structuredClone(grouped)); groupsById = new Map(cache.groups.map(group => [group.summary.id, group])); roots = new Set(snapshot.roots.filter(view => view.root.role === 'library').map(view => view.root.id)); queryCache.clear()
    return cache
  }
  function groupFor(albumKey: string, rootId: string): LocalAlbumGroup { lease(); const group = groupsById.get(albumKey); return group?.summary.rootId === rootId ? group : changed() }
  function inspectAlbum(request: LocalAlbumInspectRequest): LocalAlbumGroup {
    return protect(() => {
      if (request === null || typeof request !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(request))
        || !['albumKey', 'rootId'].every(key => Object.hasOwn(request, key)) || !Reflect.ownKeys(request).every(key => typeof key === 'string' && ['albumKey', 'rootId', 'revision'].includes(key)
          && Object.getOwnPropertyDescriptor(request, key)?.enumerable === true && Object.hasOwn(Object.getOwnPropertyDescriptor(request, key)!, 'value'))
        || !dto.isLocalAlbumTrackQuery({ albumKey: request.albumKey, rootId: request.rootId, offset: 0, limit: 1 })
        || Object.hasOwn(request, 'revision') && (typeof request.revision !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:@-]{0,255}$/u.test(request.revision))) return invalidRequest()
      const group = groupFor(request.albumKey, request.rootId)
      if (request.revision !== undefined && request.revision !== group.summary.revision || options.port.readRevision() !== cache!.revision) return changed()
      return group
    })
  }
  function queryAlbums(request: dto.LocalAlbumQuery): dto.LocalAlbumPage {
    return protect(() => {
      if (!dto.isLocalAlbumQuery(request)) return invalidRequest()
      const current = lease()
      if (request.rootId !== null && !roots.has(request.rootId)) return invalidRequest()
      const key = JSON.stringify([request.rootId, request.query]), normalized = request.query.toLocaleLowerCase('zh')
      let selection = queryCache.get(key)
      if (!selection) {
        const scoped = current.groups.filter(group => (request.rootId === null || group.summary.rootId === request.rootId)
          && (!normalized || [group.summary.title, ...group.summary.artists, group.summary.year ?? '', group.summary.versionLabel ?? '', group.summary.sourceLabel ?? ''].join(' ').toLocaleLowerCase('zh').includes(normalized)))
        const counts = Object.fromEntries(filters.map(filter => [filter, filter === 'all' ? scoped.length : scoped.filter(group => group.summary.statuses.includes(filter)).length])) as unknown as dto.LocalAlbumFilterCounts
        selection = { scoped, counts }; queryCache.set(key, selection)
        if (queryCache.size > 8) queryCache.delete(queryCache.keys().next().value!)
      } else { queryCache.delete(key); queryCache.set(key, selection) }
      const filtered = request.filter === 'all' ? selection.scoped : selection.scoped.filter(group => group.summary.statuses.includes(request.filter as dto.LocalAlbumStatus))
      const items = filtered.slice(request.offset, request.offset + request.limit).map(group => group.summary)
      const result: dto.LocalAlbumPage = { ...request, total: filtered.length, hasMore: request.offset + items.length < filtered.length, counts: selection.counts, items }
      if (!dto.isLocalAlbumPage(result, request)) return unavailable()
      return structuredClone(result)
    })
  }
  function queryAlbumTracks(request: dto.LocalAlbumTrackQuery): dto.LocalAlbumTrackPage {
    return protect(() => {
      if (!dto.isLocalAlbumTrackQuery(request)) return invalidRequest()
      const group = groupFor(request.albumKey, request.rootId), revision = cache!.revision
      const selected = group.members.slice(request.offset, request.offset + request.limit), ids = selected.map(member => member.fact.summary.track.id)
      const facts = ids.length ? options.port.readTrackDetails(ids) : []
      if (!Array.isArray(facts) || facts.length !== ids.length || !facts.every(dto.isLocalLibraryTrackDetail) || new Set(facts.map(detail => detail.track.id)).size !== facts.length) return unavailable()
      const byId = new Map(facts.map(detail => [detail.track.id, detail]))
      const items: dto.LocalAlbumTrackItem[] = selected.map(member => {
        const detail = byId.get(member.fact.summary.track.id), summary = member.fact.summary
        if (!detail || !equal(detail.track, summary.track) || !equal(detail.asset, summary.asset) || !equal(detail.metadata.effective, summary.metadata)
          || !equal(detail.metadata.raw, member.fact.rawMetadata) || !equal(detail.versionTokens, summary.versionTokens)) return changed()
        return { facts: detail, disc: member.disc, trackNumber: member.trackNumber, sequence: member.sequence, statuses: member.statuses }
      })
      if (options.port.readRevision() !== revision) return changed()
      const result: dto.LocalAlbumTrackPage = { ...request, album: group.summary, total: group.members.length, hasMore: request.offset + items.length < group.members.length, items }
      if (!dto.isLocalAlbumTrackPage(result, request, group.summary)) return unavailable()
      return structuredClone(result)
    })
  }
  async function getArtwork(request: dto.LocalAlbumArtworkRequest): Promise<dto.LocalAlbumArtworkReply> {
    return protect(() => {
      if (!dto.isLocalAlbumArtworkRequest(request)) return invalidRequest()
      const group = groupFor(request.albumKey, request.rootId), revision = cache!.revision, album = group.summary
      if (request.revision !== album.revision || request.editionId !== album.editionId || request.representativeTrackId !== album.representativeTrackId) return changed()
      return (async () => {
        try {
          let image: dto.LocalArtworkImage | null = null, status: 'ready' | 'source-unavailable' = 'ready'
          if (album.artworkState !== 'missing' && !(album.artworkState === undefined && !album.artworkAvailable)) {
            const read = await options.port.readArtwork(request, { album, directory: group.directory, representative: group.members[0]?.fact ?? null })
            if (read === null || typeof read !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(read)) || Reflect.ownKeys(read).length !== 2
              || !['image', 'status'].every(key => Object.getOwnPropertyDescriptor(read, key)?.enumerable === true && Object.hasOwn(Object.getOwnPropertyDescriptor(read, key)!, 'value'))
              || (read.status !== 'ready' && read.status !== 'source-unavailable') || read.image !== null && !dto.isLocalArtworkImage(read.image) || read.status === 'source-unavailable' && read.image !== null) return unavailable()
            image = read.image; status = read.status
          }
          const result = { ...request, image, status }
          if (disposed || options.port.readRevision() !== revision) return changed()
          if (!dto.isLocalAlbumArtworkReply(result, request)) return unavailable()
          return structuredClone(result)
        } catch (error) { if (error instanceof LocalAlbumReadError) throw error; return unavailable() }
      })()
    })
  }
  function invalidate(): void { cache = undefined; groupsById.clear(); roots.clear(); queryCache.clear() }
  function dispose(): void { invalidate(); disposed = true }
  return { queryAlbums, queryAlbumTracks, getArtwork, inspectAlbum, invalidate, dispose,
    getCacheInfo: () => ({ revision: cache?.revision ?? null, albumCount: cache?.groups.length ?? 0, trackCount: cache?.trackCount ?? 0, bytes: cache?.bytes ?? 0 }) }
}
