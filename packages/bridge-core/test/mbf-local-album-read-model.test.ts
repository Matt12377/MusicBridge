import assert from 'node:assert/strict'
import test from 'node:test'
import type { AlbumEdition, AlbumEditionTrack, LocalAlbumArtworkRequest, LocalAlbumQuery, LocalAlbumSummary, LocalArtworkImage, LocalLibraryTrackDetail, LocalMetadata, LocalRootView, VersionNameToken } from '@music-bridge/contracts'
import { groupLocalAlbumSnapshot, isLocalAlbumPrivateRelative, validateLocalAlbumSnapshot, LocalAlbumReadError, LOCAL_ALBUM_MAX_EDITION_LINKS, LOCAL_ALBUM_MAX_SCAN_FACTS, LOCAL_ALBUM_MAX_TRACKS } from '../src/collection/local-album-browser/grouping.js'
import { createLocalAlbumReadService } from '../src/collection/local-album-browser/read-service.js'
import type { LocalAlbumArtworkReadContext, LocalAlbumArtworkReadResult, LocalAlbumReadSnapshot, LocalAlbumSnapshotBudget, LocalAlbumSnapshotPort, LocalAlbumTrackFact } from '../src/collection/local-album-browser/types.js'

// 仅内存合成 port 和原事实；不读文件、不打开数据库、不扫描，不调用播放器。
const id = (n: number): string => `11111111-1111-4111-8111-${String(n).padStart(12, '0')}`
const rootId = id(1), otherRootId = id(2)
function root(n: number, availability: LocalRootView['availability'] = 'ONLINE'): LocalRootView {
  return { root: { id: id(n), sourceRootId: id(100 + n), role: 'library', revision: '1' }, label: `合成来源 ${n}`, availability }
}
function track(n: number, relative: string, changes: { rootId?: string; raw?: LocalMetadata; effective?: LocalMetadata; tokens?: VersionNameToken[]; artworkState?: LocalAlbumTrackFact['artworkState'] } = {}): LocalAlbumTrackFact {
  const rootIdentity = changes.rootId ?? rootId, raw = changes.raw ?? { title: `原始曲目 ${n}`, artist: '合成艺人', album: '同名专辑', year: '2000', disc: '1', track: String(n) }
  const state = changes.artworkState ?? 'unknown'
  return { relative, summary: { track: { id: id(1_000 + n), assetId: id(10_000 + n), selectionRevision: '2', segment: null },
    asset: { id: id(10_000 + n), libraryRootId: rootIdentity, sourceRootId: rootIdentity === rootId ? id(101) : id(102), rootRevision: '1', fileRevision: '3', locationRevision: '4', sampleFrames: null, timebaseHz: null },
    metadata: { ...(changes.effective ?? raw) }, versionTokens: changes.tokens ?? [] }, rawMetadata: { ...raw },
    hasArtwork: state === 'available', artworkRevision: state === 'available' ? 'image-1' : null, artworkState: state }
}
function snapshot(tracks: readonly LocalAlbumTrackFact[] = [], changes: Partial<LocalAlbumReadSnapshot> = {}): LocalAlbumReadSnapshot {
  return { revision: 'snapshot-1', roots: [root(1), root(2)], tracks, editions: [], editionLinks: [], rejected: [], cues: [], nameEnhancements: [], ...changes }
}
const edition = (n: number): AlbumEdition => ({ id: id(20_000 + n), title: '同名专辑', edition: `独立发行 ${n}`, revision: '1' })
const link = (n: number, value: AlbumEdition, fact: LocalAlbumTrackFact, sequence = 1): AlbumEditionTrack => ({ id: id(30_000 + n), editionId: value.id, trackId: fact.summary.track.id, disc: 1, trackNumber: sequence, sequence, revision: '1', active: true })
function detail(fact: LocalAlbumTrackFact, editions: readonly AlbumEdition[] = []): LocalLibraryTrackDetail {
  return { track: structuredClone(fact.summary.track), asset: structuredClone(fact.summary.asset), metadata: { raw: { ...fact.rawMetadata }, override: null, effective: { ...fact.summary.metadata } },
    versionTokens: structuredClone(fact.summary.versionTokens), editions: structuredClone([...editions]), fileParameters: { container: 'FLAC', codec: 'FLAC', lossless: true, sampleRateHz: 48_000, channels: 2, bitsPerSample: 24, durationMs: 123_000, evidence: 'bounded-parser-reported' } }
}
const query = (changes: Partial<LocalAlbumQuery> = {}): LocalAlbumQuery => ({ query: '', rootId: null, filter: 'all', offset: 0, limit: 200, ...changes })
const artworkRequest = (album: LocalAlbumSummary): LocalAlbumArtworkRequest => ({ albumKey: album.id, rootId: album.rootId, editionId: album.editionId, representativeTrackId: album.representativeTrackId, revision: album.revision })
const image = (): LocalArtworkImage => ({ original: { mime: 'image/png', bytes: 4, sha256: 'a'.repeat(64), width: 32, height: 32 }, display: { mime: 'image/jpeg', bytes: 3, sha256: 'b'.repeat(64), width: 16, height: 16, dataUrl: 'data:image/jpeg;base64,/9j/' } })
const errorCode = (code: LocalAlbumReadError['code']) => (error: unknown): boolean => error instanceof LocalAlbumReadError && error.code === code
function memoryPort(initial: LocalAlbumReadSnapshot) {
  let current = initial, snapshots = 0, details = 0, artworks = 0
  const detailRequests: string[][] = [], artworkRequests: Array<{ request: LocalAlbumArtworkRequest; context: LocalAlbumArtworkReadContext }> = [], budgets: LocalAlbumSnapshotBudget[] = []
  let readDetails = (ids: readonly string[]): readonly LocalLibraryTrackDetail[] => ids.map(trackId => {
    const fact = current.tracks.find(item => item.summary.track.id === trackId); assert.ok(fact)
    const editionIds = current.editionLinks.filter(item => item.active && item.trackId === trackId).map(item => item.editionId)
    return detail(fact, current.editions.filter(item => editionIds.includes(item.id)))
  })
  let readArtwork = (_request: LocalAlbumArtworkRequest, _context: LocalAlbumArtworkReadContext): LocalAlbumArtworkReadResult | Promise<LocalAlbumArtworkReadResult> => ({ image: image(), status: 'ready' })
  const port: LocalAlbumSnapshotPort = {
    readRevision: () => current.revision,
    readSnapshot(budget) { snapshots++; budgets.push({ ...budget }); return current },
    readTrackDetails(ids) { details++; detailRequests.push([...ids]); return readDetails(ids) },
    readArtwork(request, context) { artworks++; artworkRequests.push({ request, context }); return readArtwork(request, context) },
  }
  return { port, detailRequests, artworkRequests, budgets, get snapshots() { return snapshots }, get details() { return details }, get artworks() { return artworks },
    setSnapshot(value: LocalAlbumReadSnapshot) { current = value }, setDetails(value: typeof readDetails) { readDetails = value }, setArtwork(value: typeof readArtwork) { readArtwork = value } }
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(accept => { resolve = accept }); return { promise, resolve } }

test('MBF分组：同名不同根、目录、原始版本与真实发行不合并，MB更正只改变显示和修订', () => {
  const a = track(1, '来源甲/01.flac'), b = track(2, '来源乙/01.flac'), c = track(3, '来源甲/01.flac', { rootId: otherRootId })
  const version = { raw: 'SACD', source: 'album' as const, kind: 'format' as const, start: 0, end: 4 }
  const d = track(4, '来源甲/02.flac', { tokens: [version] }), e = track(5, '发行甲/01.flac'), f = track(6, '发行乙/01.flac'), first = edition(1), second = edition(2)
  const facts = snapshot([a, b, c, d, e, f], { editions: [first, second], editionLinks: [link(1, first, e), link(2, second, f)] })
  const before = groupLocalAlbumSnapshot(facts)
  assert.equal(before.groups.length, 6); assert.equal(new Set(before.groups.map(group => group.summary.id)).size, 6)
  const original = before.groups.find(group => group.members.some(member => member.fact.summary.track.id === a.summary.track.id))!
  assert.doesNotMatch(original.summary.id, /来源甲|同名专辑/u)
  const corrected = track(1, a.relative, { raw: a.rawMetadata, effective: { ...a.rawMetadata, album: 'MB更正标题', artist: 'MB更正艺人' } })
  const after = groupLocalAlbumSnapshot(snapshot([corrected, b, c, d, e, f], { revision: 'snapshot-2', editions: [first, second], editionLinks: facts.editionLinks }))
  const modified = after.groups.find(group => group.summary.id === original.summary.id)!
  assert.equal(modified.summary.title, 'MB更正标题'); assert.notEqual(modified.summary.revision, original.summary.revision)
  assert.equal(modified.members[0]!.fact.rawMetadata.album, '同名专辑')
})

test('MBF分组：仅root直属未归发行音频组成散落组，艺人摘要不会拒绝完整逐轨事实', () => {
  const tracks = Array.from({ length: 40 }, (_, index) => track(index + 1, `${index + 1}.flac`, { raw: { title: `曲目${index + 1}`, artist: `艺人${index + 1}`, album: `原专辑${index + 1}` },
    tokens: [{ raw: `版本${index + 1}-${'x'.repeat(32)}`, source: 'album', kind: 'edition', start: 0, end: 40 }] }))
  const grouped = groupLocalAlbumSnapshot(snapshot(tracks)), loose = grouped.groups[0]!
  assert.equal(grouped.groups.length, 1); assert.equal(loose.summary.trackCount, 40); assert.equal(loose.summary.title, '散落音频')
  assert.deepEqual(loose.summary.artists, ['多位艺人']); assert.ok(loose.summary.statuses.includes('loose-audio'))
  assert.equal(loose.summary.versionLabel, '多个版本'); assert.equal(new Set(loose.members.map(member => member.fact.summary.versionTokens[0]!.raw)).size, 40)
  assert.equal(new Set(loose.members.map(member => member.fact.summary.metadata.artist)).size, 40)
})

test('MBF分组：未知封面与来源不可用不计缺图，实际图与实际缺图分别计数', () => {
  const values = [track(1, '未知/01.flac'), track(2, '缺图/01.flac', { artworkState: 'missing' }), track(3, '有图/01.flac', { artworkState: 'available' }), track(4, '不可用/01.flac', { artworkState: 'source-unavailable' })]
  const groups = groupLocalAlbumSnapshot(snapshot(values)).groups
  assert.equal(groups.filter(group => group.summary.statuses.includes('missing-artwork')).length, 1)
  assert.equal(groups.filter(group => group.summary.statuses.includes('has-artwork')).length, 1)
  for (const state of ['unknown', 'source-unavailable']) {
    const album = groups.find(group => group.summary.artworkState === state)!.summary
    assert.equal(album.artworkAvailable, false); assert.deepEqual(album.statuses, [])
  }
  const offline = groupLocalAlbumSnapshot(snapshot([track(5, '离线/01.flac')], { roots: [root(1, 'SOURCE_ROOT_OFFLINE')] })).groups[0]!
  assert.equal(offline.summary.artworkState, 'source-unavailable'); assert.deepEqual(offline.summary.statuses, [])
})

test('MBF分组：CUE-only与拒收目录允许零轨，缺字段与真实元数据读取失败分开，AI取消不算失败', () => {
  const accepted = track(1, '缺字段/01.flac', { raw: { title: '只有标题' } })
  const facts = snapshot([accepted], { rejected: [
    { rootId, relative: '拒收/01.bin', revision: 'reject-1', metadataReadFailed: false },
    { rootId, relative: '读失败/01.flac', revision: 'reject-2', metadataReadFailed: true }],
    cues: [{ rootId, relative: 'CUE目录/album.cue', revision: 'cue-1', status: 'failed', audioAssetIds: [], alreadySplit: false }],
    nameEnhancements: [{ rootId, directory: '拒收', revision: 'name-1', state: 'cancelled' }, { rootId, directory: 'CUE目录', revision: 'name-2', state: 'not-run' }] })
  const groups = groupLocalAlbumSnapshot(facts).groups
  assert.equal(groups.length, 4); assert.equal(groups.filter(group => group.summary.statuses.includes('metadata-issue')).length, 1)
  assert.equal(groups.filter(group => group.summary.statuses.includes('parse-failed')).length, 0)
  const incomplete = groups.find(group => group.members.length)!
  assert.equal(incomplete.issues[0]!.kind, 'missing-metadata'); assert.equal(incomplete.summary.statuses.includes('metadata-issue'), false)
  for (const group of groups.filter(group => !group.members.length)) { assert.equal(group.summary.trackCount, 0); assert.equal(group.summary.representativeTrackId, null); assert.equal(group.summary.artworkState, 'unknown') }
  assert.ok(groups.find(group => group.directory === 'CUE目录')!.summary.statuses.includes('cue-unsplit'))
})

test('MBF分组：AI名称失败只标实际目录，CUE只标真实未分轨资产，Track命名保留原判据', () => {
  const a = track(1, '名称失败/Track01.flac'), b = track(2, '正常/Track.flac'), segmented = track(3, '正常/Track 01.flac')
  segmented.summary.track.segment = { id: id(40_001), startFrame: '0', endFrameExclusive: '48', timebaseHz: 48_000 }
  const release = edition(1), facts = snapshot([a, b, segmented], { editions: [release], editionLinks: [link(1, release, a), link(2, release, b, 2), link(3, release, segmented, 3)],
    nameEnhancements: [{ rootId, directory: '名称失败', revision: 'name-1', state: 'failed' }, { rootId, directory: '正常', revision: 'name-2', state: 'ready' }],
    cues: [{ rootId, relative: '正常/album.cue', revision: 'cue-1', status: 'ready', audioAssetIds: [b.summary.asset.id, segmented.summary.asset.id], alreadySplit: false }] })
  const group = groupLocalAlbumSnapshot(facts).groups[0]!
  assert.ok(group.summary.statuses.includes('parse-failed')); assert.ok(group.summary.statuses.includes('cue-unsplit')); assert.ok(group.summary.statuses.includes('track-named-audio'))
  assert.ok(group.members[0]!.statuses.includes('parse-failed')); assert.equal(group.members[1]!.statuses.includes('parse-failed'), false)
  assert.ok(group.members[1]!.statuses.includes('cue-unsplit')); assert.equal(group.members[2]!.statuses.includes('cue-unsplit'), false)
  assert.ok(group.members[0]!.statuses.includes('track-named-audio')); assert.ok(group.members[1]!.statuses.includes('track-named-audio')); assert.equal(group.members[2]!.statuses.includes('track-named-audio'), false)
})

test('MBF分组：发行按真实关系的盘号曲序，普通目录不从文件名伪造曲序', () => {
  const a = track(1, '目录/99.flac', { raw: { title: '曲目甲', artist: '合成艺人', album: '同名专辑', disc: '2/2', track: '1/3' } }), b = track(2, '目录/01.flac', { raw: { title: '曲目乙', artist: '合成艺人', album: '同名专辑', disc: '1', track: '2' } }), c = track(3, '无标签/01.flac', { raw: { title: '曲目丙', artist: '合成艺人', album: '另一专辑' } })
  const ordinary = groupLocalAlbumSnapshot(snapshot([a, b, c])).groups.find(group => group.members.length === 2)!
  assert.deepEqual(ordinary.members.map(member => member.fact.summary.track.id), [b.summary.track.id, a.summary.track.id])
  const noOrdinal = groupLocalAlbumSnapshot(snapshot([c])).groups[0]!.members[0]!
  assert.equal(noOrdinal.trackNumber, null); assert.equal(noOrdinal.disc, null)
  const release = edition(1), first = link(1, release, a, 2), second = link(2, release, b, 1)
  const grouped = groupLocalAlbumSnapshot(snapshot([a, b], { editions: [release], editionLinks: [first, second] })).groups[0]!
  assert.deepEqual(grouped.members.map(member => member.fact.summary.track.id), [b.summary.track.id, a.summary.track.id]); assert.deepEqual(grouped.members.map(member => member.editionLink), [second, first])
})

test('MBF分组：闭集事实、相对目录、重复身份及行数字节预算拒绝，不返回伪截断全集', () => {
  const facts = snapshot([track(1, '目录/01.flac')])
  for (const relative of ['/绝对/01.flac', '../01.flac', '目录//01.flac', '目录/../01.flac', 'C:\\媒体\\01.flac']) assert.equal(isLocalAlbumPrivateRelative(relative), false)
  assert.equal(isLocalAlbumPrivateRelative('', true), true)
  assert.throws(() => groupLocalAlbumSnapshot(snapshot([track(1, '../01.flac')])), errorCode('UNAVAILABLE'))
  assert.throws(() => groupLocalAlbumSnapshot(snapshot([facts.tracks[0]!, facts.tracks[0]!])), errorCode('UNAVAILABLE'))
  assert.throws(() => groupLocalAlbumSnapshot(facts, { maxTracks: 0 }), errorCode('CONTENT_LIMIT_EXCEEDED'))
  assert.throws(() => groupLocalAlbumSnapshot(facts, { maxBytes: 1 }), errorCode('CONTENT_LIMIT_EXCEEDED'))
  assert.throws(() => groupLocalAlbumSnapshot(facts, { expectedRevision: 'snapshot-new' }), errorCode('SNAPSHOT_CHANGED'))
  let getterCalls = 0
  const unexpected = { ...facts, absolutePath: 'file:///合成内部路径' } as unknown as LocalAlbumReadSnapshot
  Object.defineProperty(unexpected, 'revision', { enumerable: true, get() { getterCalls++; return 'snapshot-1' } })
  assert.throws(() => groupLocalAlbumSnapshot(unexpected), errorCode('UNAVAILABLE')); assert.equal(getterCalls, 0)
})

test('MBF拒收归属：同目录多原标签组只给独立目录组完整拒收事实，不制造trackId', () => {
  const a = track(1, '混合/01.flac', { raw: { title: '甲', artist: '艺人', album: '原甲' } }), b = track(2, '混合/02.flac', { raw: { title: '乙', artist: '艺人', album: '原乙' } })
  const rejected = [{ rootId, relative: '混合/unsupported.bin', revision: 'reject-1', metadataReadFailed: false }, { rootId, relative: '混合/failed.bin', revision: 'reject-2', metadataReadFailed: true }]
  const groups = groupLocalAlbumSnapshot(snapshot([a, b], { rejected })).groups, zero = groups.find(group => group.members.length === 0)!
  assert.deepEqual(zero.rejectedFiles, rejected.map(({ relative, revision }) => ({ relative, revision })))
  assert.equal(zero.summary.representativeTrackId, null); assert.ok(zero.summary.statuses.includes('metadata-issue')); assert.equal(zero.summary.statuses.includes('parse-failed'), false)
  for (const group of groups.filter(group => group.members.length > 0)) assert.deepEqual(group.rejectedFiles, [])
})

test('MBF关系预算：发行关系独立保留120万域，小域4倍边界不会受scan/CUE上限限制', () => {
  const a = track(1, '目录/01.flac'), b = track(2, '目录/02.flac'), releases = [edition(1), edition(2)]
  const links = Array.from({ length: 9 }, (_, index) => link(index + 1, releases[index % 2]!, index % 2 ? b : a, index + 1))
  const budget = { expectedRevision: 'snapshot-1', maxTracks: 2, maxScanFacts: 1, maxBytes: 1024 * 1024 }
  const legal = snapshot([a, b], { editions: releases, editionLinks: links.slice(0, 8) })
  // 这里验证关系域配置；仅分配8/9个闭集关系，不制造60万条完整DTO。
  assert.equal(LOCAL_ALBUM_MAX_EDITION_LINKS, 1_200_000)
  assert.doesNotThrow(() => validateLocalAlbumSnapshot(legal, budget))
  assert.throws(() => validateLocalAlbumSnapshot({ ...legal, editionLinks: links }, budget), errorCode('CONTENT_LIMIT_EXCEEDED'))
  const rejected = [1, 2].map(n => ({ rootId, relative: `拒收/${n}.bin`, revision: `reject-${n}`, metadataReadFailed: false }))
  assert.throws(() => validateLocalAlbumSnapshot({ ...legal, rejected }, budget), errorCode('CONTENT_LIMIT_EXCEEDED'))
})

test('MBF只读服务：修订lease复用紧凑快照，翻页不读详情封面，默认保留30万轨与60万扫描域', t => {
  const fake = memoryPort(snapshot([track(1, '甲/01.flac'), track(2, '乙/01.flac'), track(3, '丙/01.flac')])), service = createLocalAlbumReadService({ port: fake.port }); t.after(service.dispose)
  const first = service.queryAlbums(query({ limit: 2 })), second = service.queryAlbums(query({ offset: 2, limit: 2 }))
  assert.equal(first.total, 3); assert.equal(first.hasMore, true); assert.equal(second.items.length, 1); assert.equal(second.hasMore, false)
  assert.equal(fake.snapshots, 1); assert.equal(fake.details, 0); assert.equal(fake.artworks, 0)
  assert.equal(fake.budgets[0]!.maxTracks, 300_000); assert.equal(fake.budgets[0]!.maxScanFacts, 600_000)
  assert.equal(LOCAL_ALBUM_MAX_TRACKS, 300_000); assert.equal(LOCAL_ALBUM_MAX_SCAN_FACTS, 600_000)
  fake.setSnapshot(snapshot([track(4, '新/01.flac')], { revision: 'snapshot-2' })); assert.equal(service.queryAlbums(query()).total, 1); assert.equal(fake.snapshots, 2)
})

test('MBF只读服务：搜索、root作用域和完整七类计数独立分页，空结果是确认空', t => {
  const a = track(1, '甲/Track01.flac', { artworkState: 'available' }), b = track(2, '乙/01.flac', { artworkState: 'missing' }), c = track(3, '丙/01.flac', { rootId: otherRootId })
  const fake = memoryPort(snapshot([a, b, c], { nameEnhancements: [{ rootId, directory: '甲', revision: 'name-1', state: 'failed' }] })), service = createLocalAlbumReadService({ port: fake.port }); t.after(service.dispose)
  const filtered = service.queryAlbums(query({ rootId, filter: 'track-named-audio' }))
  assert.equal(filtered.total, 1); assert.equal(filtered.counts.all, 2); assert.equal(filtered.counts['track-named-audio'], 1); assert.equal(filtered.counts['parse-failed'], 1)
  assert.equal(filtered.counts['missing-artwork'], 1); assert.equal(filtered.counts['has-artwork'], 1)
  assert.deepEqual(Object.keys(filtered.counts), ['all', 'missing-artwork', 'has-artwork', 'cue-unsplit', 'metadata-issue', 'parse-failed', 'loose-audio', 'track-named-audio', 'missing-lyrics'])
  assert.equal(filtered.counts['missing-lyrics'], 0, '未提供歌词inventory是unknown，不能计为缺歌词')
  assert.equal(service.queryAlbums(query({ rootId, filter: 'missing-lyrics' })).total, 0)
  assert.equal(service.queryAlbums(query({ rootId: otherRootId })).total, 1)
  const empty = service.queryAlbums(query({ query: '没有这个合成名字' })); assert.equal(empty.total, 0); assert.deepEqual(empty.items, []); assert.equal(empty.hasMore, false)
  assert.equal(service.queryAlbums(query({ query: '同名专辑' })).total, 3)
  assert.equal(service.queryAlbums(query({ query: '丙/01.flac' })).total, 0, '作者内部relative不成为公开搜索索引')
})

test('MBF只读服务：详情只取当前页真实ID并保持资产/元数据/文件参数，未知track不会冒充结果', t => {
  const tracks = Array.from({ length: 205 }, (_, index) => track(index + 1, `目录/${index + 1}.flac`)), fake = memoryPort(snapshot(tracks)), service = createLocalAlbumReadService({ port: fake.port }); t.after(service.dispose)
  const album = service.queryAlbums(query()).items[0]!, request = { albumKey: album.id, rootId, offset: 200, limit: 200 }, page = service.queryAlbumTracks(request)
  assert.equal(page.total, 205); assert.equal(page.items.length, 5); assert.equal(page.hasMore, false)
  assert.deepEqual(fake.detailRequests[0], tracks.slice(200).map(fact => fact.summary.track.id)); assert.equal(fake.snapshots, 1)
  assert.equal(page.items[0]!.facts.metadata.raw.title, '原始曲目 201'); assert.equal(page.items[0]!.facts.asset.fileRevision, '3'); assert.equal(page.items[0]!.facts.fileParameters!.bitsPerSample, 24)
  assert.throws(() => service.queryAlbumTracks({ ...request, albumKey: 'directory-unknown' }), errorCode('SNAPSHOT_CHANGED'))
  fake.setDetails(ids => ids.map(() => detail(tracks[0]!)))
  assert.throws(() => service.queryAlbumTracks(request), errorCode('UNAVAILABLE'))
})

test('MBF只读服务：零轨详情不造ID或读详情，未知目录封面仍传可信内部目录', async t => {
  const fake = memoryPort(snapshot([], { cues: [{ rootId, relative: 'CUE目录/album.cue', revision: 'cue-1', status: 'failed', audioAssetIds: [], alreadySplit: false }] })), service = createLocalAlbumReadService({ port: fake.port }); t.after(service.dispose)
  const album = service.queryAlbums(query()).items[0]!, page = service.queryAlbumTracks({ albumKey: album.id, rootId, offset: 0, limit: 100 })
  assert.equal(album.representativeTrackId, null); assert.deepEqual(page.items, []); assert.equal(fake.details, 0)
  const reply = await service.getArtwork(artworkRequest(album)); assert.equal(reply.image!.display.mime, 'image/jpeg'); assert.equal(reply.status, 'ready')
  assert.equal(fake.artworkRequests[0]!.context.directory, 'CUE目录'); assert.equal(fake.artworkRequests[0]!.context.representative, null)
  assert.doesNotMatch(JSON.stringify(reply), /CUE目录|"relative"|"directory"/u)
})

test('MBF可信inspect：捕获全成员冻结范围并核根/修订，不经公开详情分页或读取全库detail', t => {
  const tracks = Array.from({ length: 205 }, (_, index) => track(index + 1, `目录/${index + 1}.flac`)), fake = memoryPort(snapshot(tracks)), service = createLocalAlbumReadService({ port: fake.port }); t.after(service.dispose)
  const album = service.queryAlbums(query()).items[0]!, request = { albumKey: album.id, rootId, revision: album.revision }, scope = service.inspectAlbum(request)
  assert.equal(scope.members.length, 205); assert.equal(scope.summary.trackCount, 205); assert.equal(fake.details, 0); assert.equal(fake.snapshots, 1)
  assert.equal(scope, service.inspectAlbum(request)); assert.equal(Object.isFrozen(scope), true); assert.equal(Object.isFrozen(scope.members[0]!.fact.summary.asset), true)
  assert.throws(() => service.inspectAlbum({ ...request, revision: 'stale' }), errorCode('SNAPSHOT_CHANGED'))
  assert.throws(() => service.inspectAlbum({ ...request, rootId: otherRootId }), errorCode('SNAPSHOT_CHANGED'))
  assert.throws(() => service.inspectAlbum({ ...request, relative: '越界/路径' } as typeof request), errorCode('INVALID_REQUEST'))
})

test('MBF只读服务：已证缺图不探测，unknown与source-unavailable按需读且不可用不伪装missing', async t => {
  const fake = memoryPort(snapshot([track(1, '缺图/01.flac', { artworkState: 'missing' }), track(2, '未知/01.flac'), track(3, '不可用/01.flac', { artworkState: 'source-unavailable' })])), service = createLocalAlbumReadService({ port: fake.port }); t.after(service.dispose)
  const albums = service.queryAlbums(query()).items, missing = albums.find(album => album.artworkState === 'missing')!, unknown = albums.find(album => album.artworkState === 'unknown')!, offline = albums.find(album => album.artworkState === 'source-unavailable')!
  assert.equal((await service.getArtwork(artworkRequest(missing))).image, null); assert.equal(fake.artworks, 0)
  fake.setArtwork(() => ({ status: 'source-unavailable', image: null }))
  assert.equal((await service.getArtwork(artworkRequest(unknown))).status, 'source-unavailable'); assert.equal((await service.getArtwork(artworkRequest(offline))).status, 'source-unavailable'); assert.equal(fake.artworks, 2)
  fake.setArtwork(() => ({ status: 'ready', image: null }))
  assert.deepEqual(await service.getArtwork(artworkRequest(unknown)), { ...artworkRequest(unknown), status: 'ready', image: null })
})

test('MBF只读服务：详情版本变化与await后的源修订变化都拒绝，错误不含内部路径或URL', async t => {
  const initial = snapshot([track(1, '目录/01.flac')]), fake = memoryPort(initial), service = createLocalAlbumReadService({ port: fake.port }); t.after(service.dispose)
  const album = service.queryAlbums(query()).items[0]!
  fake.setDetails(() => { const value = detail(initial.tracks[0]!); value.asset.fileRevision = '9'; return [value] })
  assert.throws(() => service.queryAlbumTracks({ albumKey: album.id, rootId, offset: 0, limit: 100 }), errorCode('SNAPSHOT_CHANGED'))
  const late = deferred<LocalAlbumArtworkReadResult>(); fake.setArtwork(() => late.promise)
  const reading = service.getArtwork(artworkRequest(album)); fake.setSnapshot(snapshot(initial.tracks, { revision: 'snapshot-2' })); late.resolve({ image: image(), status: 'ready' })
  await assert.rejects(reading, errorCode('SNAPSHOT_CHANGED'))
  fake.setArtwork(() => { throw new Error('file:///合成内部路径 token=合成内部原因') })
  const current = service.queryAlbums(query()).items[0]!
  await assert.rejects(service.getArtwork(artworkRequest(current)), error => { assert.ok(error instanceof LocalAlbumReadError); assert.equal(error.code, 'UNAVAILABLE'); assert.doesNotMatch(error.message, /file:|token=|内部路径/u); return true })
})

test('MBF只读服务：闭集请求拒绝跨root/旧revision/远程图/描述符，预算不足明确失败', async t => {
  const fake = memoryPort(snapshot([track(1, '目录/01.flac')])), service = createLocalAlbumReadService({ port: fake.port }); t.after(service.dispose)
  const album = service.queryAlbums(query()).items[0]!
  assert.throws(() => service.queryAlbums({ ...query(), absolutePath: 'file:///合成内部路径' } as LocalAlbumQuery), errorCode('INVALID_REQUEST'))
  assert.throws(() => service.queryAlbums(query({ rootId: id(99) })), errorCode('INVALID_REQUEST'))
  await assert.rejects(service.getArtwork({ ...artworkRequest(album), rootId: otherRootId }), errorCode('SNAPSHOT_CHANGED'))
  await assert.rejects(service.getArtwork({ ...artworkRequest(album), revision: 'old-revision' }), errorCode('SNAPSHOT_CHANGED'))
  fake.setArtwork(() => { const invalid = image(); invalid.display.dataUrl = 'https://example.invalid/cover.jpg'; return { image: invalid, status: 'ready' } })
  await assert.rejects(service.getArtwork(artworkRequest(album)), errorCode('UNAVAILABLE'))
  let getters = 0
  fake.setArtwork(() => Object.defineProperty({ image: null, status: 'ready' }, 'image', { enumerable: true, get() { getters++; return image() } }) as LocalAlbumArtworkReadResult)
  await assert.rejects(service.getArtwork(artworkRequest(album)), errorCode('UNAVAILABLE')); assert.equal(getters, 0)
  const bounded = createLocalAlbumReadService({ port: fake.port, maxBytes: 1 }); t.after(bounded.dispose)
  assert.throws(() => bounded.queryAlbums(query()), errorCode('CONTENT_LIMIT_EXCEEDED')); assert.equal(bounded.getCacheInfo().albumCount, 0)
})

test('MBF只读服务：作者对象和公开结果互不污染缓存，dispose丢弃迟到封面与后续操作', async () => {
  const fact = track(1, '目录/01.flac'), initial = snapshot([fact]), fake = memoryPort(initial), service = createLocalAlbumReadService({ port: fake.port })
  const first = service.queryAlbums(query()), album = first.items[0]!
  first.items[0]!.title = '调用方修改'; Reflect.set(first.counts, 'all', 99); fact.summary.metadata.album = '作者后来修改'
  const second = service.queryAlbums(query()); assert.equal(second.items[0]!.title, '同名专辑'); assert.equal(second.counts.all, 1)
  const late = deferred<LocalAlbumArtworkReadResult>(); fake.setArtwork(() => late.promise)
  const reading = service.getArtwork(artworkRequest(album)); service.dispose(); late.resolve({ image: image(), status: 'ready' })
  await assert.rejects(reading, errorCode('SNAPSHOT_CHANGED')); assert.equal(service.getCacheInfo().revision, null)
  assert.throws(() => service.queryAlbums(query()), errorCode('UNAVAILABLE'))
})
