import type { MobileProjectionRow, MobileProjectionPage } from '../collection/local-album-browser/mobile-structure.js';
import type { LocalAlbumSourceMemberIdentity } from '../collection/local-album-browser/source-member-identity.js';
import { catalogTraceStep, catalogTraceEvent } from './catalog-private-trace.js';
import { createHash } from 'node:crypto';
import { localMetadataArtists } from '../library/local-artist-fields.js';
import { isDeepStrictEqual } from 'node:util';
import { setTimeout as waitOwner, setImmediate as yieldOwner } from 'node:timers/promises';
import {
  isLocalLibraryTrackDetail, isLocalCatalogText, mapMobileFileAudioParameters, mobileCatalogResponseSnapshot, mobileDataSnapshot,
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
import { MobileServiceError, type MobileOwnerArtworkSnapshot, type MobileOwnerCatalogRequest, type MobileOwnerCatalogSnapshot,
  type MobileOwnerCatalogSelectedRequest, type MobileOwnerCatalogSelectedSnapshot } from './types.js';
import { isMobileOwnerCatalogSelectedRequest } from './owner-protocol.js';
import { projectMobileOwnerLocalTrack } from './catalog-service.js';

type ProjectionRow = LocalAlbumSqlMobileRow | MobileProjectionRow;
type GroupHeader = Pick<ProjectionRow, 'album' | 'groupHash' | 'artworkSourceRevision'>;
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
  localAlbums: MobileLocalAlbums; playbackAvailable?(detail: LocalLibraryTrackDetail): boolean; dsdToPcmAvailable?: () => boolean; isPlaybackBusy?: () => boolean;
}) {
  const { collection, datasetId, ownerEpoch, localAlbums } = options;
  // 只约束跨yield暂存的纯准备量；超界回原同步整页，不改变任何公开容量。
  const preparationLimit = 2 * 1024 * 1024, preparationFull = Symbol('mobile-catalog-preparation-full');
  let preparationBytes = 0;
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
  const currentRevision = () => guarded(() => localAlbums.privateMobile.revision());
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
  function detailFor(row: ProjectionRow, legacyEditionId: string | null): LocalLibraryTrackDetail {
    const member = row.member; if (!member) return changed();
    return detailForMember(row.album.rootId, row.album.editionId, member.fact, member.editionLink, legacyEditionId);
  }
  function detailForMember(rootId: string, editionId: string | null, original: LocalAlbumSourceMemberIdentity['fact'],
    editionLink: LocalAlbumSourceMemberIdentity['editionLink'], legacyEditionId: string | null): LocalLibraryTrackDetail {
    const fact = original.summary, detail = collection.localCatalog.trackDetail(fact.track.id);
    if (!isLocalLibraryTrackDetail(detail) || !same(detail.track, fact.track) || !same(detail.asset, fact.asset)
      || !same(detail.metadata.effective, fact.metadata) || detail.track.assetId !== detail.asset.id
      || detail.asset.libraryRootId !== rootId) return changed();
    const root = collection.localCatalog.root(rootId), source = collection.sources.root(root.sourceRootId);
    if (root.role !== 'library' || root.revision !== detail.asset.rootRevision || !source.authorized
      || detail.asset.sourceRootId !== root.sourceRootId) return changed();
    if (legacyEditionId !== null && (editionId !== legacyEditionId || !editionLink
      || editionLink.editionId !== legacyEditionId || editionLink.trackId !== detail.track.id
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
  function resolveSourceTrack(id: string): { detail: LocalLibraryTrackDetail } {
    return guarded(() => {
      const identity = parseMobileTrackId(id, datasetId); if (!identity) return missing();
      const reader = localAlbums.privateMobile.memberIdentity;
      if (!reader) return { detail: resolveTrack(id).detail };
      const result = reader({ trackId: identity.trackId, groupHash: identity.kind === 'canonical' ? identity.groupHash : null,
        editionId: identity.kind === 'legacy' ? identity.editionId : null });
      // 组织或全scope容量无法用窄作者证明时，保留原精确行为，不把合法库改成拒绝。
      if (result === null) return { detail: resolveTrack(id).detail };
      if (identity.kind === 'legacy') {
        if (result.legacyGroupCount !== 0 && result.legacyGroupCount !== 1) return changed();
        if (result.legacyGroupCount !== 1) return missing();
      }
      if (result.items.length > 1) return changed();
      if (result.items.length !== 1) return missing();
      const member = result.items[0]!;
      if (member.fact.summary.track.id !== identity.trackId || member.groupHash !== mobileGroupHash(member.rootId,member.albumKey)
        || (identity.kind === 'canonical' ? member.groupHash !== identity.groupHash : member.editionId !== identity.editionId)) return changed();
      return { detail: detailForMember(member.rootId,member.editionId,member.fact,member.editionLink,
        identity.kind === 'legacy' ? identity.editionId : null) };
    });
  }
  function cover(row: GroupHeader): string | undefined {
    return row.album.artworkState === 'missing' || row.album.artworkState === 'source-unavailable' ? undefined
      : mobileArtworkId(datasetId, row.album.id, row.artworkSourceRevision);
  }
  function album(row: GroupHeader, legacyEditionId: string | null = null): MobileAlbum {
    const artworkId = cover(row), summary = row.album;
    const result = mobileCatalogResponseSnapshot('album', {
      id: legacyEditionId === null ? mobileAlbumId(datasetId, summary.rootId, summary.id) : `la:${datasetId}:${legacyEditionId}`,
      title: summary.title, artists: [...summary.artists], source: 'local', editionLabel: summary.versionLabel ?? '',
      trackCount: summary.trackCount, ...(artworkId === undefined ? {} : { artworkId }),
    });
    if (!result.ok) return unavailable(); return result.value;
  }
  function prepareTrack(row: ProjectionRow, enabled: boolean, legacyEditionId: string | null = null,
    rowOrdinal: number|null = null, retain?: (value: unknown) => void): () => MobileTrack {
    const original = catalogTraceStep('owner.item.detail', () => detailFor(row, legacyEditionId), rowOrdinal);
    return prepareTrackFact(row, row.member?.fact.relative, original, enabled, legacyEditionId, rowOrdinal, retain);
  }
  function prepareTrackFact(row: GroupHeader, relative: string | undefined, original: LocalLibraryTrackDetail, enabled: boolean,
    legacyEditionId: string | null, rowOrdinal: number | null, retain?: (value: unknown) => void): () => MobileTrack {
    const detail = { ...original, fileParameters: catalogTraceStep('owner.item.file-parameters', () => {
      const parameters = enabled ? collection.localScan.privateDisplayFileParameters(original.track.id, original.asset, 'mobile-catalog')
        : collection.localScan.privateDisplayFileParameters(original.track.id, original.asset);
      if (!parameters) return unavailable(); return parameters;
    }, rowOrdinal) };
    const title = catalogTraceStep('owner.item.title', () => {
      if (detail.metadata.effective.title) return detail.metadata.effective.title;
      // 只借原同scope页内位置的末组件展示，不读取源文件或把回退写回元数据/内容身份。
      if (typeof relative === 'string') {
        const name = relative.slice(relative.lastIndexOf('/') + 1), dot = name.lastIndexOf('.');
        const stem = dot < 0 ? name : name.slice(0, dot);
        if (isLocalCatalogText(stem) && !/[\u0080-\u009f\\]/u.test(stem) && stem !== '.' && stem !== '..') return stem;
      }
      return '来源未提供标题';
    }, rowOrdinal);
    let durationMs = detail.fileParameters.durationMs;
    const segment = detail.track.segment;
    if (segment !== null) durationMs = catalogTraceStep('owner.item.segment', () => {
      if (detail.asset.sampleFrames === null || detail.asset.timebaseHz !== segment.timebaseHz) return unavailable();
      const start = BigInt(segment.startFrame), end = BigInt(segment.endFrameExclusive), rate = BigInt(segment.timebaseHz);
      if (start >= end || end > BigInt(detail.asset.sampleFrames)) return unavailable();
      const duration = ((end - start) * 1000n + rate / 2n) / rate;
      if (duration > BigInt(Number.MAX_SAFE_INTEGER)) return unavailable(); return Number(duration);
    }, rowOrdinal);
    // 没有准确时长时保留本地展示行，不补零、不按文件大小猜测，也不授予播放资格。
    const duration = catalogTraceStep('owner.item.duration', () => durationMs, rowOrdinal);
    const audio = catalogTraceStep('owner.item.audio-map', () => { const mapped = mapMobileFileAudioParameters(detail.fileParameters); if (!mapped.ok) return unavailable(); return mapped; }, rowOrdinal);
    const content = catalogTraceStep('owner.item.dto', () => mobileLocalContentDigest(datasetId, detail), rowOrdinal),
      artworkId = catalogTraceStep('owner.item.artwork', () => cover(row), rowOrdinal);
    const rootId = row.album.rootId, albumKey = row.album.id, groupHash = row.groupHash, versionLabel = row.album.versionLabel;
    retain?.({ detail, rootId, albumKey, groupHash, versionLabel, title, duration, audio: audio.value,
      content, artworkId: artworkId ?? null, enabled, legacyEditionId, rowOrdinal });
    const availability = () => catalogTraceStep('owner.item.availability', () => duration !== null && enabled && options.playbackAvailable?.(detail) === true ? 'available' as const : 'unavailable' as const, rowOrdinal);
    return () => {
    if (legacyEditionId !== null) {
      const edition = detail.editions.find(value => value.id === legacyEditionId); if (!edition) return changed();
      // 旧引用保留公共mapper原有发行/修订守门；目录分支不向detail.editions补造关系。
      return catalogTraceStep('owner.item.dto-validation', () => projectMobileOwnerLocalTrack({ detail, binding: {
        localTrackId: detail.track.id, assetId: detail.asset.id, fileRevision: detail.asset.fileRevision,
        selectionRevision: detail.track.selectionRevision, segmentId: segment?.id ?? null,
        editionId: legacyEditionId, editionRevision: edition.revision,
        trackId: `lt:${datasetId}:${detail.track.id}:${legacyEditionId}`, sourceItemId: `ls:${datasetId}:${detail.asset.id}`,
        albumId: `la:${datasetId}:${legacyEditionId}`, versionId: `lv:${content}`, contentRevision: `lc:${content}`,
      }, projection: { title, artists: localMetadataArtists(detail.metadata.effective),
        editionLabel: edition.edition, availability: availability(),
        ...(artworkId === undefined ? {} : { artworkId }) } }), rowOrdinal);
    }
    const result = catalogTraceStep('owner.item.dto-validation', () => mobileCatalogResponseSnapshot('track', {
      id: legacyEditionId === null ? mobileTrackId(datasetId, detail.track.id, groupHash) : `lt:${datasetId}:${detail.track.id}:${legacyEditionId}`,
      title, artists: localMetadataArtists(detail.metadata.effective),
      albumId: legacyEditionId === null ? mobileAlbumId(datasetId, rootId, albumKey) : `la:${datasetId}:${legacyEditionId}`,
      source: 'local', sourceItemId: `ls:${datasetId}:${detail.asset.id}`, versionId: `lv:${content}`, contentRevision: `lc:${content}`,
      editionLabel: versionLabel ?? '', durationMs: duration, audio: audio.value,
      availability: availability(),
      ...(artworkId === undefined ? {} : { artworkId }),
    }), rowOrdinal);
    return catalogTraceStep('owner.item.dto', () => { if (!result.ok) return unavailable(); return result.value; }, rowOrdinal);
    };
  }
  const track = (row: ProjectionRow, enabled: boolean, legacyEditionId: string | null = null, rowOrdinal: number|null = null): MobileTrack =>
    prepareTrack(row, enabled, legacyEditionId, rowOrdinal)();
  const revision = (scopeRevision: string, enabled: boolean): string => 'mr:' + hash([
    datasetId, ownerEpoch, scopeRevision, 'MOBILE_DIRECTORY_V1', enabled, options.dsdToPcmAvailable?.() === true,
  ]);
  // 与目录 DTO 共用唯一修订作者；内容围栏不为取得水位执行整页 SQL。
  const catalogRevision = (enabled = false): string => guarded(() => revision(currentRevision(), enabled));
  function catalogPage(request: MobileOwnerCatalogRequest) {
      const enabled = request.catalogPlaybackEnabled === true, initial = catalogTraceStep('owner.revision', currentRevision), start = revision(initial, enabled);
      catalogTraceStep('owner.revision', () => { if (request.expectedRevision !== null && request.expectedRevision !== start) return changed(); });
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
      const page = catalogTraceStep('owner.sql-page', () => read(filter));
      catalogTraceEvent('owner.sql-page','ok',{count:page.items.length});
      if (request.operation.startsWith('get') && page.total !== 1) return missing();
      return { enabled, initial, start, albums, legacyEditionId, page };
  }
  function withParametersFrame<T>(read: () => T): T {
    return typeof collection.localScan.privateWithDisplayFileParametersRead === 'function'
      ? collection.localScan.privateWithDisplayFileParametersRead(read) : read();
  }
  /** 同一原作者水位下最多100项；索引不提供元数据、播放资格或文件身份。 */
  async function selected(input: MobileOwnerCatalogSelectedRequest): Promise<MobileOwnerCatalogSelectedSnapshot> {
    const captured = mobileDataSnapshot(input, undefined, 'request');
    if (!captured.ok || !isMobileOwnerCatalogSelectedRequest(captured.value)) throw new MobileServiceError(400, 'INVALID_REQUEST');
    const request = captured.value, enabled = request.catalogPlaybackEnabled === true;
    const initial = currentRevision(), stamp = collection.readonlySnapshotStamp(), start = revision(initial, enabled);
    const check = (): void => guarded(() => {
      if (currentRevision() !== initial || request.sourceRevision !== initial || !same(collection.readonlySnapshotStamp(), stamp)) return changed();
    });
    check();
    let held = 0;
    const retain = (value: unknown): number => {
      const bytes = Buffer.byteLength(JSON.stringify(value));
      if (preparationBytes + bytes > preparationLimit) throw new MobileServiceError(503, 'CONTENT_LIMIT_EXCEEDED');
      preparationBytes += bytes; held += bytes; return bytes;
    };
    const release = (bytes: number): void => { preparationBytes -= bytes; held -= bytes; };
    type SelectedGroup = { row: ProjectionRow; legacyEditionId: string | null };
    const structure = localAlbums.privateMobile.structure, headers = new Map<string, SelectedGroup>();
    async function isolatedOne(filter: LocalAlbumSqlMobileQuery): Promise<MobileProjectionRow> {
      let page: MobileProjectionPage;
      try { page = await structure!({ ...filter, offset: 0, limit: 2 }); }
      catch (error) { check(); return guarded(() => { throw error; }); }
      check();
      if (page.revision !== initial || page.total > 1) return changed();
      if (page.total !== 1 || page.items.length !== 1) return missing();
      const row = page.items[0]!;
      if (row.groupHash !== mobileGroupHash(row.album.rootId, row.album.id)) return changed();
      return row;
    }
    async function header(id: string): Promise<SelectedGroup> {
      const saved = headers.get(id); if (saved) return saved;
      let value: SelectedGroup;
      if (!structure) value = guarded(() => group(id));
      else {
        const identity = parseMobileAlbumId(id, datasetId); if (!identity) return missing();
        const row = await isolatedOne(query(identity.kind === 'canonical'
          ? { rootId: identity.rootId, albumKey: identity.albumKey } : { editionId: identity.editionId }));
        if (identity.kind === 'legacy' && row.album.editionId !== identity.editionId) return changed();
        value = { row, legacyEditionId: identity.kind === 'legacy' ? identity.editionId : null };
      }
      check(); retain(value); headers.set(id, value); return value;
    }
    async function exactTrack(id: string): Promise<SelectedGroup> {
      if (!structure) return guarded(() => resolveTrack(id));
      const identity = parseMobileTrackId(id, datasetId); if (!identity) return missing();
      const legacy = identity.kind === 'legacy' ? await header(`la:${datasetId}:${identity.editionId}`) : null;
      const row = await isolatedOne(query(identity.kind === 'canonical'
        ? { kind: 'members', trackId: identity.trackId, groupHash: identity.groupHash }
        : { kind: 'members', rootId: legacy!.row.album.rootId, albumKey: legacy!.row.album.id,
          trackId: identity.trackId, editionId: identity.editionId }));
      return { row, legacyEditionId: legacy?.legacyEditionId ?? null };
    }
    const items: Array<MobileAlbum | MobileTrack> = [];
    try {
      for (let index = 0; index < request.ids.length; index++) {
        check();
        const id = request.ids[index]!;
        let item: MobileAlbum | MobileTrack;
        if (request.kind === 'albums') {
          const value = await header(id); check(); item = guarded(() => album(value.row, value.legacyEditionId));
        } else {
          const identity = parseMobileTrackId(id, datasetId); if (!identity) return missing();
          const member = guarded(() => {
            const result = localAlbums.privateMobile.memberIdentity?.({ trackId: identity.trackId,
              groupHash: identity.kind === 'canonical' ? identity.groupHash : null, editionId: identity.kind === 'legacy' ? identity.editionId : null });
            if (result === undefined || result === null) return null;
            if (identity.kind === 'legacy') {
              if (result.legacyGroupCount !== 0 && result.legacyGroupCount !== 1) return changed();
              if (result.legacyGroupCount !== 1) return missing();
            }
            if (result.items.length > 1) return changed();
            if (result.items.length !== 1) return missing();
            const fact = result.items[0]!;
            if (fact.fact.summary.track.id !== identity.trackId || fact.groupHash !== mobileGroupHash(fact.rootId, fact.albumKey)
              || (identity.kind === 'canonical' ? fact.groupHash !== identity.groupHash : fact.editionId !== identity.editionId)) return changed();
            return fact;
          });
          if (member === null) {
            // 窄证明不足仍读原精确成员；生产在隔离SQL中执行，不能阻塞原Owner重建整库。
            const value = await exactTrack(id); check();
            item = guarded(() => withParametersFrame(() => prepareTrack(value.row, enabled, value.legacyEditionId, index + 1)()));
          } else {
            const temporaryBytes = retain(member);
            try {
              const value = await header(identity.kind === 'canonical' ? mobileAlbumId(datasetId, member.rootId, member.albumKey)
                : `la:${datasetId}:${identity.editionId}`);
              check();
              item = guarded(() => {
                if (value.row.groupHash !== member.groupHash || value.row.album.rootId !== member.rootId
                  || value.row.album.id !== member.albumKey || value.row.album.editionId !== member.editionId) return changed();
                // await后从真实Owner重读detail和资格，不能把窄成员当完整投影行。
                const detail = detailForMember(member.rootId, member.editionId, member.fact, member.editionLink, value.legacyEditionId);
                return withParametersFrame(() => prepareTrackFact(value.row, member.fact.relative, detail, enabled, value.legacyEditionId, index + 1)());
              });
            } finally { release(temporaryBytes); }
          }
        }
        if (item.id !== id) return changed();
        retain(item); items.push(item);
        if (index + 1 < request.ids.length) await yieldOwner();
      }
      check();
      return { datasetId, ownerEpoch, sourceRevision: initial, libraryRevision: start, kind: request.kind, items };
    } finally { preparationBytes -= held; }
  }
  function sealCatalog(request: MobileOwnerCatalogRequest, selected: { page: { revision: string; total: number }; initial: string; start: string }, items: Array<MobileAlbum | MobileTrack>): MobileOwnerCatalogSnapshot {
    const { page, initial, start } = selected;
    catalogTraceStep('owner.page-seal', () => { if (page.revision !== initial || currentRevision() !== initial) return changed(); });
    return { datasetId, ownerEpoch, libraryRevision: start, operation: request.operation,
      offset: request.offset, limit: request.limit, total: page.total, items };
  }
  function catalog(request: MobileOwnerCatalogRequest): MobileOwnerCatalogSnapshot {
    return guarded(() => {
      const selected = catalogPage(request), { page, enabled, albums, legacyEditionId } = selected;
      const mapItems = () => page.items.map((row,index) => albums ? album(row, legacyEditionId) : track(row, enabled, legacyEditionId,index+1));
      // 旧只读注入端口仍走原逐项核验；真实Store只为同步曲目页建立解析帧。
      const items = !albums ? withParametersFrame(mapItems) : mapItems();
      return sealCatalog(request, selected, items);
    });
  }
  async function catalogIsolated(request: MobileOwnerCatalogRequest): Promise<MobileOwnerCatalogSnapshot> {
    const structure = localAlbums.privateMobile.structure!;
    const enabled = request.catalogPlaybackEnabled === true, initial = currentRevision(), start = revision(initial, enabled);
    if (request.expectedRevision !== null && request.expectedRevision !== start) return changed();
    const readPage = async (filter: LocalAlbumSqlMobileQuery): Promise<MobileProjectionPage> => {
      try { const page = await structure(filter); return guarded(() => page); }
      catch (error) { return guarded(() => { throw error; }); }
    };
    const one = async (filter: LocalAlbumSqlMobileQuery): Promise<MobileProjectionRow> => {
      const page = await readPage({ ...filter, offset: 0, limit: 2 });
      if (page.total > 1) return changed();
      if (page.total !== 1 || page.items.length !== 1) return missing();
      return page.items[0]!;
    };
    const selectAlbum = async (id: string) => {
      const identity = parseMobileAlbumId(id, datasetId); if (!identity) return missing();
      if (identity.kind === 'canonical') return { row: await one(query({ rootId: identity.rootId, albumKey: identity.albumKey })), legacyEditionId: null };
      const row = await one(query({ editionId: identity.editionId }));
      if (row.album.editionId !== identity.editionId) return changed();
      return { row, legacyEditionId: identity.editionId };
    };
    const albums = request.operation === 'listAlbums' || request.operation === 'getAlbum';
    let filter = query({ kind: albums ? 'groups' : 'members', offset: request.offset, limit: request.limit, query: request.q });
    let legacyEditionId: string | null = null;
    if (request.albumId !== null || request.operation === 'getAlbum') {
      const selected = await selectAlbum(request.operation === 'getAlbum' ? request.itemId! : request.albumId!);
      filter = { ...filter, rootId: selected.row.album.rootId, albumKey: selected.row.album.id }; legacyEditionId = selected.legacyEditionId;
    }
    if (request.operation === 'getTrack') {
      const identity = parseMobileTrackId(request.itemId!, datasetId); if (!identity) return missing();
      let row: MobileProjectionRow;
      if (identity.kind === 'canonical') row = await one(query({ kind: 'members', trackId: identity.trackId, groupHash: identity.groupHash }));
      else {
        const selected = await one(query({ editionId: identity.editionId }));
        row = await one(query({ kind: 'members', rootId: selected.album.rootId, albumKey: selected.album.id,
          trackId: identity.trackId, editionId: identity.editionId })); legacyEditionId = identity.editionId;
      }
      const detail = guarded(() => detailFor(row, legacyEditionId));
      filter = { ...filter, rootId: row.album.rootId, albumKey: row.album.id, trackId: detail.track.id };
    }
    const page = await readPage(filter);
    if (request.operation.startsWith('get') && page.total !== 1) return missing();
    let held = 0;
    const retain = (value: unknown): number => {
      const bytes = Buffer.byteLength(JSON.stringify(value));
      if (preparationBytes + bytes > preparationLimit) throw new MobileServiceError(503, 'CONTENT_LIMIT_EXCEEDED');
      preparationBytes += bytes; held += bytes; return bytes;
    };
    try {
      retain(page);
      const items = guarded(() => albums ? page.items.map(row => album(row, legacyEditionId))
        : withParametersFrame(() => page.items.map((row, index) => prepareTrack(row, enabled, legacyEditionId, index + 1)())));
      return guarded(() => sealCatalog(request, { page, initial, start }, items));
    } finally { preparationBytes -= held; }
  }
  /** 直接目录及内容读取共用隔离路径；旧同步调用仍保留 catalog。
   * 解析帧在任何await前结束；逐行原facts/FD闭环不中断，最后仍按原水位整页收口。
   */
  async function catalogAsync(input: MobileOwnerCatalogRequest): Promise<MobileOwnerCatalogSnapshot> {
    if (localAlbums.privateMobile.structure) return catalogIsolated({ ...input });
    if (input.operation !== 'listTracks') return catalog(input);
    const request = { ...input };
    const backgroundContinuation = request.offset > 0 && request.albumId === null && request.q === '';
    // 一页共用两秒让步预算；持续播放到期只回原完整处理，不制造新的BUSY或无限暂停。
    let remainingWaitMs = 2_000;
    async function waitForPlayback(): Promise<void> {
      options.assertCurrent();
      if (!backgroundContinuation || !options.isPlaybackBusy || remainingWaitMs <= 0) return;
      while (options.isPlaybackBusy()) {
        options.assertCurrent();
        const started = performance.now();
        await waitOwner(Math.min(20, remainingWaitMs));
        options.assertCurrent();
        remainingWaitMs -= Math.max(0, performance.now() - started);
        if (remainingWaitMs <= 0) return;
      }
    }
    let held = 0, prepared: Array<() => MobileTrack> = [];
    let temporaryPage: ReturnType<typeof catalogPage> | undefined;
    const release = () => { temporaryPage = undefined; prepared = []; preparationBytes -= held; held = 0; };
    const retain = (value: unknown): number => {
      const bytes = Buffer.byteLength(JSON.stringify(value));
      if (preparationBytes + bytes > preparationLimit) throw preparationFull;
      preparationBytes += bytes; held += bytes; return bytes;
    };
    try {
      let selected: ReturnType<typeof catalogPage>;
      try {
        if (backgroundContinuation) {
          // SQL前先经过poll，让已排队的真实播放活动消息先落地；这里只持有有界请求。
          await yieldOwner(); await yieldOwner();
        }
        await waitForPlayback();
        temporaryPage = guarded(() => catalogPage(request));
        // SQL页与准备闭包共用原逻辑预算；超界仍同步整页，不把原始页无界跨yield持有。
        const pageBytes = retain(temporaryPage);
        // 两个check轮次之间经过poll，给SQL期间已到达的Owner消息处理机会；解析帧尚未建立。
        await yieldOwner(); await yieldOwner();
        await waitForPlayback();
        selected = guarded(() => {
          const result = temporaryPage!;
          prepared = withParametersFrame(() => result.page.items.map((row, index) => prepareTrack(row, result.enabled,
            result.legacyEditionId, index + 1, retain)));
          // 跨yield只保留已计费的准备闭包及seal所需水位/总数，不额外持有原SQL整页树。
          return { ...result, page: { revision: result.page.revision, total: result.page.total, items: [] } };
        });
        temporaryPage = undefined; preparationBytes -= pageBytes; held -= pageBytes;
      } catch (error) {
        if (error !== preparationFull) throw error;
        release();
        await waitForPlayback();
        catalogTraceEvent('owner.catalog.prepare-fallback', 'ok', { matched: false, count: 1 });
        return catalog(request);
      }
      const items: MobileTrack[] = [];
      for (let index = 0; index < prepared.length; index++) {
        await waitForPlayback();
        items.push(guarded(prepared[index]!));
        if (index + 1 < prepared.length) await yieldOwner();
      }
      return guarded(() => sealCatalog(request, selected, items));
    } finally { release(); }
  }
  async function artwork(request: { serverId: string; artworkId: string }): Promise<MobileOwnerArtworkSnapshot> {
    const identity = parseMobileArtworkId(request.artworkId, datasetId); if (!identity) return missing();
    await refresh(); const initial = currentRevision();
    const row = single(query({ albumKey: identity.albumKey }));
    if (mobileArtworkRevisionHash(row.artworkSourceRevision) !== identity.artworkRevisionHash) return changed();
    const summary = row.album;
    // 原Owner异步display路径持有原2槽/2秒与撤销范围；这里没有额外Native或放宽预算。
    let result: Awaited<ReturnType<MobileLocalAlbums['getArtwork']>>;
    try { result = await localAlbums.getArtwork({ albumKey: summary.id, rootId: summary.rootId, editionId: summary.editionId,
      representativeTrackId: summary.representativeTrackId, revision: summary.revision }); }
    catch (error) { return guarded(() => { throw error; }); }
    const latest = single(query({ rootId: summary.rootId, albumKey: summary.id }));
    if (latest.artworkSourceRevision !== row.artworkSourceRevision || currentRevision() !== initial) return changed();
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
  return { refresh, catalogRevision, catalog, catalogAsync, selected, resolveTrack, resolveSourceTrack, resolveAlbum: group, artwork };
}
