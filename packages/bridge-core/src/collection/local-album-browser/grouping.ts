import { createHash } from 'node:crypto'
import { Buffer } from 'node:buffer'
import * as dto from '@music-bridge/contracts'
import type { LocalAlbumGroup, LocalAlbumGroupedSnapshot, LocalAlbumGroupMember, LocalAlbumIssue, LocalAlbumReadSnapshot, LocalAlbumSnapshotBudget, LocalAlbumTrackFact } from './types.js'

export const LOCAL_ALBUM_MAX_TRACKS = 300_000
export const LOCAL_ALBUM_MAX_SCAN_FACTS = 600_000
export const LOCAL_ALBUM_MAX_EDITION_LINKS = 1_200_000
export const LOCAL_ALBUM_MAX_BYTES = 128 * 1024 * 1024
export class LocalAlbumReadError extends Error {
  constructor(readonly code: 'INVALID_REQUEST' | 'SNAPSHOT_CHANGED' | 'CONTENT_LIMIT_EXCEEDED' | 'UNAVAILABLE', message: string) { super(message); this.name = 'LocalAlbumReadError' }
}
const invalid = (): never => { throw new LocalAlbumReadError('UNAVAILABLE', '专辑来源事实无效，请刷新音乐库信息。') }
const overBudget = (): never => { throw new LocalAlbumReadError('CONTENT_LIMIT_EXCEEDED', '音乐库专辑读取超过安全预算，本次未返回截断结果。') }
const opaqueRevision = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:@-]{0,255}$/u.test(value)
export function isLocalAlbumPrivateRelative(value: unknown, directory = false): value is string {
  return typeof value === 'string' && (directory && value === '' || value.length > 0 && value.length <= 4096
    && !/[\u0000-\u001f\u007f\\]/u.test(value) && !value.startsWith('/') && !/^[a-z]:/iu.test(value)
    && value.split('/').every(part => part !== '' && part !== '.' && part !== '..'))
}
function closed(value: unknown, names: readonly string[], optional: readonly string[] = []): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false
  const keys = Reflect.ownKeys(value)
  return names.every(key => Object.hasOwn(value, key)) && keys.every(key => typeof key === 'string' && [...names, ...optional].includes(key)
    && Object.getOwnPropertyDescriptor(value, key)?.enumerable === true && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, 'value'))
}
function array(value: unknown, max: number): value is unknown[] {
  return Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype && value.length <= max && Reflect.ownKeys(value).length === value.length + 1
    && Reflect.ownKeys(value).every(key => key === 'length' || typeof key === 'string' && /^(0|[1-9][0-9]*)$/u.test(key)
      && Number(key) < value.length && Object.getOwnPropertyDescriptor(value, key)?.enumerable === true && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, 'value'))
}
function unique(values: readonly string[]): boolean { return new Set(values).size === values.length }
function metadata(value: unknown): value is dto.LocalMetadata {
  if (value === null || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false
  return Reflect.ownKeys(value).every(key => typeof key === 'string' && ['title', 'artist', 'album', 'disc', 'track', 'year', 'albumArtist', 'artists', 'albumArtists'].includes(key)
    && Object.getOwnPropertyDescriptor(value, key)?.enumerable === true && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, 'value')) && dto.isLocalMetadata(value)
}
export function validateLocalAlbumSnapshot(snapshot: unknown, budget: LocalAlbumSnapshotBudget): asserts snapshot is LocalAlbumReadSnapshot {
  if (!closed(snapshot, ['revision', 'roots', 'tracks', 'editions', 'editionLinks', 'rejected', 'cues', 'nameEnhancements']) || !opaqueRevision(snapshot.revision)) return invalid()
  if (snapshot.revision !== budget.expectedRevision) throw new LocalAlbumReadError('SNAPSHOT_CHANGED', '音乐库信息已变化，请重新读取专辑。')
  const maxEditionLinks = Math.min(LOCAL_ALBUM_MAX_EDITION_LINKS, budget.maxTracks * 4)
  for (const [name, max] of [['tracks', budget.maxTracks], ['editions', budget.maxTracks], ['editionLinks', maxEditionLinks], ['rejected', budget.maxScanFacts], ['cues', budget.maxScanFacts], ['nameEnhancements', budget.maxScanFacts]] as const) {
    if (Array.isArray(snapshot[name]) && snapshot[name].length > max) return overBudget()
    if (!array(snapshot[name], max)) return invalid()
  }
  if (!array(snapshot.roots, 100) || !snapshot.roots.every(value => closed(value, ['root', 'label', 'availability']) && closed(value.root, ['id', 'sourceRootId', 'role', 'revision']) && dto.isLocalRootView(value))) return invalid()
  const rootViews = snapshot.roots as dto.LocalRootView[]
  const roots = new Set(rootViews.map(value => value.root.id))
  if (roots.size !== snapshot.roots.length) return invalid()
  const tracks = snapshot.tracks as unknown[]
  if (!tracks.every(value => closed(value, ['relative', 'summary', 'rawMetadata', 'hasArtwork', 'artworkRevision'], ['artworkState']) && isLocalAlbumPrivateRelative(value.relative)
    && dto.isLocalLibraryTrackSummary(value.summary) && roots.has(value.summary.asset.libraryRootId) && metadata(value.rawMetadata)
    && typeof value.hasArtwork === 'boolean' && (value.artworkRevision === null || opaqueRevision(value.artworkRevision))
    && (!Object.hasOwn(value, 'artworkState') || (['available', 'missing', 'unknown', 'source-unavailable'] as readonly unknown[]).includes(value.artworkState)
      && value.hasArtwork === (value.artworkState === 'available')))) return invalid()
  const editions = snapshot.editions as unknown[], links = snapshot.editionLinks as unknown[]
  if (!editions.every(value => closed(value, ['id', 'title', 'edition', 'revision']) && dto.isAlbumEdition(value))
    || !links.every(value => closed(value, ['id', 'editionId', 'trackId', 'disc', 'trackNumber', 'sequence', 'revision', 'active']) && dto.isAlbumEditionTrack(value))) return invalid()
  if (!unique((tracks as LocalAlbumTrackFact[]).map(value => value.summary.track.id)) || !unique((editions as dto.AlbumEdition[]).map(value => value.id)) || !unique((links as dto.AlbumEditionTrack[]).map(value => value.id))) return invalid()
  const trackIds = new Set((tracks as LocalAlbumTrackFact[]).map(value => value.summary.track.id)), editionIds = new Set((editions as dto.AlbumEdition[]).map(value => value.id))
  if ((links as dto.AlbumEditionTrack[]).some(value => value.active && (!trackIds.has(value.trackId) || !editionIds.has(value.editionId)))) return invalid()
  const rejected = snapshot.rejected as unknown[], cues = snapshot.cues as unknown[], enhancements = snapshot.nameEnhancements as unknown[]
  if (rejected.length + cues.length + enhancements.length > budget.maxScanFacts) return overBudget()
  if (!rejected.every(value => closed(value, ['rootId', 'relative', 'revision', 'metadataReadFailed']) && dto.isCollectionId(value.rootId) && roots.has(value.rootId) && isLocalAlbumPrivateRelative(value.relative)
    && opaqueRevision(value.revision) && typeof value.metadataReadFailed === 'boolean')) return invalid()
  if (!cues.every(value => closed(value, ['rootId', 'relative', 'revision', 'status', 'audioAssetIds', 'alreadySplit']) && dto.isCollectionId(value.rootId) && roots.has(value.rootId) && isLocalAlbumPrivateRelative(value.relative)
    && opaqueRevision(value.revision) && (['ready', 'failed', 'unresolved'] as readonly unknown[]).includes(value.status) && array(value.audioAssetIds, 100) && value.audioAssetIds.every(dto.isCollectionId)
    && unique(value.audioAssetIds as string[]) && typeof value.alreadySplit === 'boolean')) return invalid()
  if (!enhancements.every(value => closed(value, ['rootId', 'directory', 'revision', 'state']) && dto.isCollectionId(value.rootId) && roots.has(value.rootId) && isLocalAlbumPrivateRelative(value.directory, true)
    && opaqueRevision(value.revision) && (['failed', 'ready', 'cancelled', 'not-run'] as readonly unknown[]).includes(value.state))) return invalid()
  let bytes = 0
  for (const values of [snapshot.roots, tracks, editions, links, rejected, cues, enhancements]) for (const value of values) { bytes += Buffer.byteLength(JSON.stringify(value)); if (bytes > budget.maxBytes) return overBudget() }
}
const parent = (relative: string): string => relative.includes('/') ? relative.slice(0, relative.lastIndexOf('/')) : ''
const basename = (relative: string): string => relative.slice(relative.lastIndexOf('/') + 1)
const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const safeLabel = (value: string, fallback: string): string => dto.isLocalCatalogText(value) ? value : fallback
const ordinal = (value: string | undefined): number | null => {
  const number = /^(?:[1-9]\d*)(?:\/[1-9]\d*)?$/u.test(value?.trim() ?? '') ? Number(value!.trim().split('/')[0]) : NaN
  return Number.isSafeInteger(number) && number > 0 && number <= 1_000_000 ? number : null
}
const trackNamed = (relative: string): boolean => /^track(?:\d+)?$/iu.test(basename(relative).replace(/\.[^.]+$/u, ''))
const rawVersion = (fact: LocalAlbumTrackFact): string[] => [...new Set(fact.summary.versionTokens.filter(token => token.source === 'album' && (token.kind === 'edition' || token.kind === 'format')).map(token => token.raw))].sort()
interface Draft { id: string; rootId: string; edition: dto.AlbumEdition | null; directory: string | null; identityTitle: string; members: Array<{ fact: LocalAlbumTrackFact; link: dto.AlbumEditionTrack | null }>; memberIds: Set<string>; issues: LocalAlbumIssue[]; rejectedFiles: Array<{ relative: string; revision: string }>; revisions: unknown[]; cueAssets: Set<string>; failedNameDirectories: Set<string>; unsplitCue: boolean; nameFailed: boolean; readFailed: boolean }

/** 对已捕获事实分组；不读文件、不建发行、不按同名跨目录合并。 */
export function groupLocalAlbumSnapshot(snapshot: LocalAlbumReadSnapshot, suppliedBudget: Partial<LocalAlbumSnapshotBudget> = {}): LocalAlbumGroupedSnapshot {
  if (!closed(snapshot, ['revision', 'roots', 'tracks', 'editions', 'editionLinks', 'rejected', 'cues', 'nameEnhancements'])) return invalid()
  const budget = { expectedRevision: suppliedBudget.expectedRevision ?? snapshot.revision, maxTracks: suppliedBudget.maxTracks ?? LOCAL_ALBUM_MAX_TRACKS, maxScanFacts: suppliedBudget.maxScanFacts ?? LOCAL_ALBUM_MAX_SCAN_FACTS, maxBytes: suppliedBudget.maxBytes ?? LOCAL_ALBUM_MAX_BYTES }
  validateLocalAlbumSnapshot(snapshot, budget)
  const roots = new Map(snapshot.roots.filter(view => view.root.role === 'library').map(view => [view.root.id, view]))
  const editions = new Map(snapshot.editions.map(edition => [edition.id, edition])), linksByTrack = new Map<string, dto.AlbumEditionTrack[]>()
  for (const link of snapshot.editionLinks) if (link.active) { const links = linksByTrack.get(link.trackId) ?? []; links.push(link); linksByTrack.set(link.trackId, links) }
  const drafts = new Map<string, Draft>(), byDirectory = new Map<string, Set<string>>(), byAsset = new Map<string, Set<string>>()
  const directoryKey = (rootId: string, directory: string): string => JSON.stringify([rootId, directory])
  function draft(rootId: string, directory: string | null, edition: dto.AlbumEdition | null, identityTitle = '', version: readonly string[] = []): Draft {
    const id = edition ? `edition-${hash([rootId, edition.id])}` : `directory-${hash([rootId, directory, directory === '' ? '' : identityTitle, directory === '' ? [] : version])}`
    let value = drafts.get(id)
    if (!value) { value = { id, rootId, directory, edition, identityTitle, members: [], memberIds: new Set(), issues: [], rejectedFiles: [], revisions: [], cueAssets: new Set(), failedNameDirectories: new Set(), unsplitCue: false, nameFailed: false, readFailed: false }; drafts.set(id, value) }
    return value
  }
  function attachDirectory(value: Draft, directory: string): void {
    const key = directoryKey(value.rootId, directory), groups = byDirectory.get(key) ?? new Set(); groups.add(value.id); byDirectory.set(key, groups)
  }
  for (const fact of snapshot.tracks) {
    const rootId = fact.summary.asset.libraryRootId
    if (!roots.has(rootId)) continue
    const directory = parent(fact.relative), activeLinks = linksByTrack.get(fact.summary.track.id) ?? []
    const destinations = activeLinks.length ? activeLinks.map(link => ({ value: draft(rootId, null, editions.get(link.editionId)!), link }))
      : [{ value: draft(rootId, directory, null, fact.rawMetadata.album?.trim() ?? '', rawVersion(fact)), link: null }]
    for (const { value, link } of destinations) {
      if (value.memberIds.has(fact.summary.track.id)) return invalid()
      value.memberIds.add(fact.summary.track.id); value.members.push({ fact, link }); attachDirectory(value, directory)
      const assetKey = JSON.stringify([rootId, fact.summary.asset.id]), groups = byAsset.get(assetKey) ?? new Set(); groups.add(value.id); byAsset.set(assetKey, groups)
      const fields = (['title', 'artist', 'album'] as const).filter(field => !fact.rawMetadata[field]?.trim())
      if (fields.length) value.issues.push({ kind: 'missing-metadata', trackId: fact.summary.track.id, fields })
    }
  }
  function directoryDestinations(rootId: string, directory: string): Draft[] {
    const ids = byDirectory.get(directoryKey(rootId, directory))
    if (ids?.size === 1) { const existing = drafts.get([...ids][0]!)!; if (!existing.edition) return [existing] }
    const value = draft(rootId, directory, null); attachDirectory(value, directory); return [value]
  }
  for (const rejected of snapshot.rejected) if (roots.has(rejected.rootId)) for (const value of directoryDestinations(rejected.rootId, parent(rejected.relative))) {
    value.rejectedFiles.push({ relative: rejected.relative, revision: rejected.revision })
    value.revisions.push(['rejected', rejected.relative, rejected.revision, rejected.metadataReadFailed])
    if (rejected.metadataReadFailed) { value.readFailed = true; value.issues.push({ kind: 'metadata-read-failed', relative: rejected.relative }) }
  }
  for (const cue of snapshot.cues) {
    if (!roots.has(cue.rootId)) continue
    const ids = new Set(cue.audioAssetIds.flatMap(assetId => [...(byAsset.get(JSON.stringify([cue.rootId, assetId])) ?? [])]))
    const destinations = ids.size ? [...ids].map(id => drafts.get(id)!) : directoryDestinations(cue.rootId, parent(cue.relative))
    for (const value of destinations) {
      value.issues.push({ kind: 'cue', relative: cue.relative, status: cue.status }); value.revisions.push(['cue', cue.relative, cue.revision, cue.status, cue.alreadySplit])
      if (!cue.alreadySplit) { value.unsplitCue = true; for (const assetId of cue.audioAssetIds) value.cueAssets.add(assetId) }
    }
  }
  for (const enhancement of snapshot.nameEnhancements) {
    if (!roots.has(enhancement.rootId) || enhancement.state !== 'failed') continue
    const ids = byDirectory.get(directoryKey(enhancement.rootId, enhancement.directory))
    const destinations = ids?.size ? [...ids].map(id => drafts.get(id)!) : directoryDestinations(enhancement.rootId, enhancement.directory)
    for (const value of destinations) { value.nameFailed = true; value.failedNameDirectories.add(enhancement.directory); value.revisions.push(['name-failed', enhancement.revision]); value.issues.push({ kind: 'name-enhancement-failed', revision: enhancement.revision }) }
  }
  let bytes = 0
  const groups: LocalAlbumGroup[] = [...drafts.values()].map(value => {
    const ordered = value.members.map(member => ({ ...member, disc: member.link?.disc ?? ordinal(member.fact.summary.metadata.disc), trackNumber: member.link?.trackNumber ?? ordinal(member.fact.summary.metadata.track) }))
      .sort((left, right) => (left.disc ?? Number.MAX_SAFE_INTEGER) - (right.disc ?? Number.MAX_SAFE_INTEGER) || (left.trackNumber ?? Number.MAX_SAFE_INTEGER) - (right.trackNumber ?? Number.MAX_SAFE_INTEGER)
        || (left.link?.sequence ?? Number.MAX_SAFE_INTEGER) - (right.link?.sequence ?? Number.MAX_SAFE_INTEGER) || left.fact.relative.localeCompare(right.fact.relative, 'en', { numeric: true }) || left.fact.summary.track.id.localeCompare(right.fact.summary.track.id))
    const distinctArtists = [...new Set(ordered.map(member => member.fact.summary.metadata.artist?.trim()).filter((artist): artist is string => !!artist))]
    // 卡片只作摘要；多艺人标记不改变任何逐轨元数据或发行身份。
    const artists = distinctArtists.length > 32 ? ['多位艺人'] : distinctArtists
    const titleCandidates = [...new Set(ordered.map(member => member.fact.summary.metadata.album?.trim()).filter(Boolean))]
    const title = value.edition?.title ?? (value.directory === '' ? ordered.length ? '散落音频' : '根目录待处理记录' : titleCandidates.length === 1 ? titleCandidates[0]! : value.identityTitle || basename(value.directory ?? '') || '来源目录')
    const years = [...new Set(ordered.map(member => member.fact.summary.metadata.year?.trim()).filter((year): year is string => !!year))]
    const versions = [...new Set(ordered.flatMap(member => rawVersion(member.fact)))]
    const versionDescription = value.edition?.edition || versions.join(' · ') || null
    const versionLabel = versionDescription === null || dto.isLocalCatalogText(versionDescription) ? versionDescription : '多个版本'
    const states = ordered.map(member => member.fact.artworkState ?? (member.fact.hasArtwork ? 'available' : 'missing'))
    const artworkState = states.includes('available') ? 'available' : roots.get(value.rootId)!.availability !== 'ONLINE' || states.includes('source-unavailable') ? 'source-unavailable'
      : !states.length || states.includes('unknown') ? 'unknown' : 'missing'
    const hasArtwork = artworkState === 'available'
    const groupStatuses: dto.LocalAlbumStatus[] = artworkState === 'available' ? ['has-artwork'] : artworkState === 'missing' ? ['missing-artwork'] : []
    if (value.unsplitCue) groupStatuses.push('cue-unsplit')
    if (value.readFailed) groupStatuses.push('metadata-issue')
    if (value.nameFailed) groupStatuses.push('parse-failed')
    if (value.directory === '' && ordered.length) groupStatuses.push('loose-audio')
    if (ordered.some(member => trackNamed(member.fact.relative))) groupStatuses.push('track-named-audio')
    const members: LocalAlbumGroupMember[] = ordered.map((member, index) => ({ fact: member.fact, editionLink: member.link, disc: member.disc, trackNumber: member.trackNumber, sequence: index + 1,
      statuses: [...(member.fact.hasArtwork ? ['has-artwork' as const] : (member.fact.artworkState ?? 'missing') === 'missing' ? ['missing-artwork' as const] : []), ...(value.unsplitCue && !member.fact.summary.track.segment && (!value.cueAssets.size || value.cueAssets.has(member.fact.summary.asset.id)) ? ['cue-unsplit' as const] : []),
        ...(value.failedNameDirectories.has(parent(member.fact.relative)) ? ['parse-failed' as const] : []), ...(value.directory === '' ? ['loose-audio' as const] : []), ...(trackNamed(member.fact.relative) ? ['track-named-audio' as const] : [])] }))
    const revision = hash([value.rootId, roots.get(value.rootId)!, value.edition, members.map(member => [member.fact.summary, member.fact.rawMetadata, member.fact.artworkRevision, member.fact.hasArtwork, member.fact.artworkState ?? null, member.editionLink]), value.revisions])
    const summary: dto.LocalAlbumSummary = { id: value.id, kind: value.edition ? 'edition' : 'source-directory', rootId: value.rootId, editionId: value.edition?.id ?? null, title: safeLabel(title, '来源目录'),
      artists, year: years.length === 1 ? years[0]! : null, versionLabel, sourceLabel: safeLabel(roots.get(value.rootId)!.label, '本地来源'),
      trackCount: members.length, representativeTrackId: members[0]?.fact.summary.track.id ?? null, revision, artworkAvailable: hasArtwork, artworkState, statuses: groupStatuses }
    if (!dto.isLocalAlbumSummary(summary)) return invalid()
    const group = { summary, members, directory: value.directory, issues: value.issues, rejectedFiles: value.rejectedFiles }
    bytes += Buffer.byteLength(JSON.stringify({ summary, issues: value.issues, rejectedFiles: value.rejectedFiles })) + members.length * 64
    if (bytes > budget.maxBytes) return overBudget()
    return group
  }).sort((left, right) => left.summary.title.localeCompare(right.summary.title, 'zh', { numeric: true }) || left.summary.id.localeCompare(right.summary.id))
  let sourceBytes = 0
  for (const values of [snapshot.roots, snapshot.tracks, snapshot.editions, snapshot.editionLinks, snapshot.rejected, snapshot.cues, snapshot.nameEnhancements]) for (const value of values) sourceBytes += Buffer.byteLength(JSON.stringify(value))
  if (sourceBytes + bytes > budget.maxBytes) return overBudget()
  return { revision: snapshot.revision, groups, bytes: sourceBytes + bytes, trackCount: snapshot.tracks.length }
}
