import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  isLocalLibraryTrackDetail, mapMobileFileAudioParameters, mobileCatalogResponseSnapshot,
  type LocalLibraryTrackDetail, type MobileAlbum, type MobileTrack,
} from '@music-bridge/contracts';
import type { CollectionRepository } from '../collection/repository.js';
import type { LocalAlbumOwnerService } from '../collection/local-album-browser/owner-port.js';
import type { LocalAlbumSqlMobileQuery, LocalAlbumSqlMobileRow } from '../collection/local-album-browser/sql-types.js';
import { LocalAlbumReadError } from '../collection/local-album-browser/grouping.js';
import {
  mobileAlbumId, mobileArtworkId, mobileArtworkRevisionHash, mobileGroupHash, mobileLocalContentDigest,
  mobileTrackId, parseMobileAlbumId, parseMobileArtworkId, parseMobileTrackId,
} from './local-album-identity.js';
import { MobileServiceError, type MobileOwnerArtworkSnapshot, type MobileOwnerCatalogRequest, type MobileOwnerCatalogSnapshot } from './types.js';
import { projectMobileOwnerLocalTrack } from './catalog-service.js';

export type MobileLocalAlbums = Pick<LocalAlbumOwnerService, 'privateMobile' | 'getArtwork'>;
const missing = (): never => { throw new MobileServiceError(404, 'INVALID_REQUEST'); };
const changed = (): never => { throw new MobileServiceError(409, 'SOURCE_CHANGED'); };
const unavailable = (): never => { throw new MobileServiceError(503, 'BUSY'); };
const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const same = isDeepStrictEqual;
const query = (value: Partial<LocalAlbumSqlMobileQuery>): LocalAlbumSqlMobileQuery => ({
  kind: 'groups', offset: 0, limit: 1, query: '', rootId: null, albumKey: null, trackId: null, editionId: null, groupHash: null, ...value,
});

/** 复用原SQL、Root scope和成员事实；派生身份不写发行关系，也不构造另一份业务目录。 */
export function createMobileLocalAlbumProjection(options: {
  collection: CollectionRepository; datasetId: string; ownerEpoch: string; assertCurrent(): void;
  localAlbums: MobileLocalAlbums; playbackAvailable?(detail: LocalLibraryTrackDetail): boolean; dsdToPcmAvailable?: () => boolean;
}) {
  const { collection, datasetId, ownerEpoch, localAlbums } = options;
  function guarded<T>(action: () => T): T {
    try { options.assertCurrent(); const result = action(); options.assertCurrent(); return result; }
    catch (error) {
      if (error instanceof LocalAlbumReadError) {
        if (error.code === 'SNAPSHOT_CHANGED') return changed();
        if (error.code === 'INVALID_REQUEST') return missing();
        if (error.code === 'CONTENT_LIMIT_EXCEEDED') throw new MobileServiceError(503, 'CONTENT_LIMIT_EXCEEDED');
        return unavailable();
      }
      throw error;
    }
  }
  async function refresh(): Promise<void> {
    options.assertCurrent();
    try { await localAlbums.privateMobile.refresh(); }
    catch (error) { guarded(() => { throw error; }); }
    options.assertCurrent();
  }
  const read = (request: LocalAlbumSqlMobileQuery) => guarded(() => {
    const page = localAlbums.privateMobile.current(request);
    if (page.total > 300000) throw new MobileServiceError(503, 'CONTENT_LIMIT_EXCEEDED');
    return page;
  });
  function single(request: LocalAlbumSqlMobileQuery): LocalAlbumSqlMobileRow {
    const page = read({ ...request, offset: 0, limit: 2 });
    if (page.total > 1) return changed();
    if (page.total !== 1 || page.items.length !== 1) return missing();
    const row = page.items[0]!;
    if (row.groupHash !== mobileGroupHash(row.album.rootId, row.album.id)) return changed();
    return row;
  }
  function group(id: string): { row: LocalAlbumSqlMobileRow; legacyEditionId: string | null } {
    const identity = parseMobileAlbumId(id, datasetId); if (!identity) return missing();
    if (identity.kind === 'canonical') return { row: single(query({ rootId: identity.rootId, albumKey: identity.albumKey })), legacyEditionId: null };
    const row = single(query({ editionId: identity.editionId }));
    if (row.album.editionId !== identity.editionId) return changed();
    return { row, legacyEditionId: identity.editionId };
  }
  function detailFor(row: LocalAlbumSqlMobileRow, legacyEditionId: string | null): LocalLibraryTrackDetail {
    const member = row.member; if (!member) return changed();
    const fact = member.fact.summary, detail = collection.localCatalog.trackDetail(fact.track.id);
    if (!isLocalLibraryTrackDetail(detail) || !same(detail.track, fact.track) || !same(detail.asset, fact.asset)
      || !same(detail.metadata.effective, fact.metadata) || detail.track.assetId !== detail.asset.id
      || detail.asset.libraryRootId !== row.album.rootId) return changed();
    const root = collection.localCatalog.root(row.album.rootId), source = collection.sources.root(root.sourceRootId);
    if (root.role !== 'library' || root.revision !== detail.asset.rootRevision || !source.authorized
      || detail.asset.sourceRootId !== root.sourceRootId) return changed();
    if (legacyEditionId !== null && (row.album.editionId !== legacyEditionId || !member.editionLink
      || member.editionLink.editionId !== legacyEditionId || member.editionLink.trackId !== detail.track.id
      || !detail.editions.some(edition => edition.id === legacyEditionId))) return changed();
    options.assertCurrent(); return detail;
  }
  function resolveTrack(id: string) {
    return guarded(() => {
      const identity = parseMobileTrackId(id, datasetId); if (!identity) return missing();
      const legacy = identity.kind === 'legacy' ? identity.editionId : null;
      const selected = identity.kind === 'canonical'
        ? query({ kind: 'members', trackId: identity.trackId, groupHash: identity.groupHash })
        : (() => {
          // 先证明旧发行只对应一个实际分组，再核该组中的原成员关系。
          const album = single(query({ editionId: identity.editionId }));
          return query({ kind: 'members', rootId: album.album.rootId, albumKey: album.album.id,
            trackId: identity.trackId, editionId: identity.editionId });
        })();
      const row = single(selected), detail = detailFor(row, legacy);
      return { row, detail, legacyEditionId: legacy };
    });
  }
  function cover(row: LocalAlbumSqlMobileRow): string | undefined {
    return row.album.artworkState === 'missing' || row.album.artworkState === 'source-unavailable' ? undefined
      : mobileArtworkId(datasetId, row.album.id, row.artworkSourceRevision);
  }
  function album(row: LocalAlbumSqlMobileRow, legacyEditionId: string | null = null): MobileAlbum {
    const artworkId = cover(row), summary = row.album;
    const result = mobileCatalogResponseSnapshot('album', {
      id: legacyEditionId === null ? mobileAlbumId(datasetId, summary.rootId, summary.id) : `la:${datasetId}:${legacyEditionId}`,
      title: summary.title, artists: [...summary.artists], source: 'local', editionLabel: summary.versionLabel ?? '',
      trackCount: summary.trackCount, ...(artworkId === undefined ? {} : { artworkId }),
    });
    if (!result.ok) return unavailable(); return result.value;
  }
  function track(row: LocalAlbumSqlMobileRow, enabled: boolean, legacyEditionId: string | null = null): MobileTrack {
    const original = detailFor(row, legacyEditionId);
    const detail = { ...original, fileParameters: enabled
      ? collection.localScan.privateDisplayFileParameters(original.track.id, original.asset, 'mobile-catalog')
      : collection.localScan.privateDisplayFileParameters(original.track.id, original.asset) };
    if (!detail.fileParameters || !detail.metadata.effective.title) return unavailable();
    let durationMs = detail.fileParameters.durationMs;
    const segment = detail.track.segment;
    if (segment !== null) {
      if (detail.asset.sampleFrames === null || detail.asset.timebaseHz !== segment.timebaseHz) return unavailable();
      const start = BigInt(segment.startFrame), end = BigInt(segment.endFrameExclusive), rate = BigInt(segment.timebaseHz);
      if (start >= end || end > BigInt(detail.asset.sampleFrames)) return unavailable();
      const duration = ((end - start) * 1000n + rate / 2n) / rate;
      if (duration > BigInt(Number.MAX_SAFE_INTEGER)) return unavailable(); durationMs = Number(duration);
    }
    if (durationMs === null) return unavailable();
    const audio = mapMobileFileAudioParameters(detail.fileParameters); if (!audio.ok) return unavailable();
    const content = mobileLocalContentDigest(datasetId, detail), artworkId = cover(row);
    if (legacyEditionId !== null) {
      const edition = detail.editions.find(value => value.id === legacyEditionId); if (!edition) return changed();
      // 旧引用保留公共mapper原有发行/修订守门；目录分支不向detail.editions补造关系。
      return projectMobileOwnerLocalTrack({ detail, binding: {
        localTrackId: detail.track.id, assetId: detail.asset.id, fileRevision: detail.asset.fileRevision,
        selectionRevision: detail.track.selectionRevision, segmentId: segment?.id ?? null,
        editionId: legacyEditionId, editionRevision: edition.revision,
        trackId: `lt:${datasetId}:${detail.track.id}:${legacyEditionId}`, sourceItemId: `ls:${datasetId}:${detail.asset.id}`,
        albumId: `la:${datasetId}:${legacyEditionId}`, versionId: `lv:${content}`, contentRevision: `lc:${content}`,
      }, projection: { title: detail.metadata.effective.title, artists: detail.metadata.effective.artist ? [detail.metadata.effective.artist] : [],
        editionLabel: edition.edition, availability: enabled && options.playbackAvailable?.(detail) === true ? 'available' : 'unavailable',
        ...(artworkId === undefined ? {} : { artworkId }) } });
    }
    const result = mobileCatalogResponseSnapshot('track', {
      id: legacyEditionId === null ? mobileTrackId(datasetId, detail.track.id, row.groupHash) : `lt:${datasetId}:${detail.track.id}:${legacyEditionId}`,
      title: detail.metadata.effective.title, artists: detail.metadata.effective.artist ? [detail.metadata.effective.artist] : [],
      albumId: legacyEditionId === null ? mobileAlbumId(datasetId, row.album.rootId, row.album.id) : `la:${datasetId}:${legacyEditionId}`,
      source: 'local', sourceItemId: `ls:${datasetId}:${detail.asset.id}`, versionId: `lv:${content}`, contentRevision: `lc:${content}`,
      editionLabel: row.album.versionLabel ?? '', durationMs, audio: audio.value,
      availability: enabled && options.playbackAvailable?.(detail) === true ? 'available' : 'unavailable',
      ...(artworkId === undefined ? {} : { artworkId }),
    });
    if (!result.ok) return unavailable(); return result.value;
  }
  const revision = (scopeRevision: string, enabled: boolean): string => 'mr:' + hash([
    datasetId, ownerEpoch, scopeRevision, 'MOBILE_DIRECTORY_V1', enabled, options.dsdToPcmAvailable?.() === true,
  ]);
  function catalog(request: MobileOwnerCatalogRequest): MobileOwnerCatalogSnapshot {
    return guarded(() => {
      const enabled = request.catalogPlaybackEnabled === true, initial = read(query({})).revision, start = revision(initial, enabled);
      if (request.expectedRevision !== null && request.expectedRevision !== start) return changed();
      const albums = request.operation === 'listAlbums' || request.operation === 'getAlbum';
      let filter = query({ kind: albums ? 'groups' : 'members', offset: request.offset, limit: request.limit, query: request.q });
      let legacyEditionId: string | null = null;
      if (request.albumId !== null || request.operation === 'getAlbum') {
        const selected = group(request.operation === 'getAlbum' ? request.itemId! : request.albumId!);
        filter = { ...filter, rootId: selected.row.album.rootId, albumKey: selected.row.album.id };
        legacyEditionId = selected.legacyEditionId;
      }
      if (request.operation === 'getTrack') {
        const selected = resolveTrack(request.itemId!);
        filter = { ...filter, rootId: selected.row.album.rootId, albumKey: selected.row.album.id, trackId: selected.detail.track.id };
        legacyEditionId = selected.legacyEditionId;
      }
      const page = read(filter);
      if (request.operation.startsWith('get') && page.total !== 1) return missing();
      const items = page.items.map(row => albums ? album(row, legacyEditionId) : track(row, enabled, legacyEditionId));
      if (page.revision !== initial || read(query({})).revision !== initial) return changed();
      return { datasetId, ownerEpoch, libraryRevision: start, operation: request.operation,
        offset: request.offset, limit: request.limit, total: page.total, items };
    });
  }
  async function artwork(request: { serverId: string; artworkId: string }): Promise<MobileOwnerArtworkSnapshot> {
    const identity = parseMobileArtworkId(request.artworkId, datasetId); if (!identity) return missing();
    await refresh(); const initial = read(query({})).revision;
    const row = single(query({ albumKey: identity.albumKey }));
    if (mobileArtworkRevisionHash(row.artworkSourceRevision) !== identity.artworkRevisionHash) return changed();
    const summary = row.album;
    // 原Owner异步display路径持有原2槽/2秒与撤销范围；这里没有额外Native或放宽预算。
    let result: Awaited<ReturnType<MobileLocalAlbums['getArtwork']>>;
    try { result = await localAlbums.getArtwork({ albumKey: summary.id, rootId: summary.rootId, editionId: summary.editionId,
      representativeTrackId: summary.representativeTrackId, revision: summary.revision }); }
    catch (error) { return guarded(() => { throw error; }); }
    const latest = single(query({ rootId: summary.rootId, albumKey: summary.id }));
    if (latest.artworkSourceRevision !== row.artworkSourceRevision || read(query({})).revision !== initial) return changed();
    if (result.status === 'source-unavailable') return unavailable();
    if (!result.image) return missing();
    const display = result.image.display, bytes = Buffer.from(display.dataUrl.slice(23), 'base64');
    if (bytes.length !== display.bytes || bytes.length > 1024 * 1024 || bytes.length < 4
      || bytes.toString('base64') !== display.dataUrl.slice(23) || createHash('sha256').update(bytes).digest('hex') !== display.sha256
      || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[bytes.length - 2] !== 0xff || bytes[bytes.length - 1] !== 0xd9) return unavailable();
    options.assertCurrent();
    return { datasetId, ownerEpoch, libraryRevision: revision(initial, false), artworkId: request.artworkId,
      selectionRevision: 'ar:' + hash([row.artworkSourceRevision, result.image.original.sha256, display.sha256]),
      contentType: 'image/jpeg', bytes: new Uint8Array(bytes) };
  }
  return { refresh, catalog, resolveTrack, resolveAlbum: group, artwork };
}
