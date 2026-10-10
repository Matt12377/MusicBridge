import { createHash } from 'node:crypto';
import { isLocalArtworkSelection, isMobileId, isMobileDsdSourceAudio, type LocalArtworkSelection, type LocalLibraryTrackDetail, type MobileAlbum, type MobileTrack } from '@music-bridge/contracts';
import { captureLocalFactsByIdentityReadonly } from '../application/local-source-resolver.js';
import type { CollectionRepository } from '../collection/repository.js';
import { readonlySourceCatalogFileAvailable, SourceCatalogReleaseError } from '../recording/source-files.js';
import { mobileOwnerDirectPlaybackKind, projectMobileOwnerLocalTrack } from './catalog-service.js';
import { isMobileOwnerPrivateRequest, isMobileOwnerPrivateResult } from './owner-protocol.js';
import { createMobileSealedStateStore } from './sealed-state-store.js';
import { MobileAuthPersistenceError, MobileServiceError, type MobileOwnerArtworkSnapshot, type MobileOwnerCatalogRequest, type MobileOwnerCatalogSnapshot, type MobileOwnerPrivateRequest, type MobileOwnerPrivateResult } from './types.js';

const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const unavailable = (): never => { throw new MobileServiceError(503, 'BUSY'); };
const missing = (): never => { throw new MobileServiceError(404, 'INVALID_REQUEST'); };

/** 同一个现有 Owner/连接的只读投影及私有密文作者。没有源文件写入或新增 DDL。 */
export function createMobileOwnerService(options: {
  collection: CollectionRepository; datasetId: string; ownerEpoch: string; assertCurrent(): void;
  /** 原 Owner 的同一真实缓存资格；不能由 Renderer 或请求 bool 授予。 */
  dsdToPcmAvailable?: () => boolean;
}) {
  const { collection, datasetId, ownerEpoch } = options;
  let state: ReturnType<typeof createMobileSealedStateStore> | undefined;
  let playbackState: ReturnType<typeof createMobileSealedStateStore> | undefined;
  const current = (): void => options.assertCurrent();
  const revision = (catalogPlaybackEnabled = false): string => { current(); const stamp = collection.readonlySnapshotStamp(); current(); return 'mr:' + digest([datasetId, ownerEpoch, stamp.dataVersion, stamp.totalChanges, catalogPlaybackEnabled, ...(options.dsdToPcmAvailable?.() === true ? ['MBM003_DSD_AVAILABLE'] : [])]); };
  function identifiers(id: string, kind: 'la' | 'lt' | 'aw', count: number): string[] {
    const parts = id.split(':');
    if (parts.length !== count + 2 || parts[0] !== kind || parts[1] !== datasetId || parts.slice(2, kind === 'aw' ? -1 : undefined).some(part => !uuid.test(part))) return missing();
    return parts.slice(2);
  }
  function selection(editionId: string): LocalArtworkSelection | null {
    if (!collection.privateMobileCatalogAccess) return unavailable();
    return collection.privateMobileCatalogAccess(db => {
      const row = db.prepare('SELECT data FROM local_artwork_selections WHERE edition_id=?').get(editionId);
      if (!row) return null;
      if (typeof row.data !== 'string' || Buffer.byteLength(row.data) > 2 * 1024 * 1024) return unavailable();
      const value: unknown = JSON.parse(row.data);
      if (!isLocalArtworkSelection(value) || value.editionId !== editionId) return unavailable();
      return value;
    });
  }
  const artworkId = (value: LocalArtworkSelection | null): string | undefined => {
    if (!value?.candidate) return undefined;
    const id = `aw:${datasetId}:${value.id}:${value.revision}`;
    if (!isMobileId(id)) return unavailable(); return id;
  };
  function playbackAvailable(detail: LocalLibraryTrackDetail): boolean {
    if (detail.track.segment !== null || !detail.fileParameters) return false;
    const dsd = options.dsdToPcmAvailable?.() === true && ['DSF', 'DFF'].includes(detail.fileParameters.container)
      && /^dsd(?:_[a-z_]+)?$/iu.test(detail.fileParameters.codec) && detail.fileParameters.durationMs !== null
      && isMobileDsdSourceAudio({ codec:'dsd',container:detail.fileParameters.container.toLowerCase(),sampleRateHz:detail.fileParameters.sampleRateHz,
        bitsPerSample:detail.fileParameters.bitsPerSample,channels:detail.fileParameters.channels });
    const kind = dsd ? 'encoded' : mobileOwnerDirectPlaybackKind(detail.fileParameters);
    if (kind === null) return false;
    try {
      current();
      const selected = { local_track_id: detail.track.id, asset_id: detail.asset.id, expected_asset_revision: detail.asset.fileRevision };
      const before = captureLocalFactsByIdentityReadonly(selected, collection);
      if (JSON.stringify(before.track) !== JSON.stringify(detail.track) || JSON.stringify(before.asset) !== JSON.stringify(detail.asset)
        || before.root.role !== 'library' || !before.observation) return false;
      if (!readonlySourceCatalogFileAvailable(before.sourceRoot, before.relative, before.observation.signature, kind === 'encoded' ? undefined : kind)) return false;
      const after = captureLocalFactsByIdentityReadonly(selected, collection);
      current(); return JSON.stringify(before) === JSON.stringify(after);
    } catch (error) {
      if (error instanceof SourceCatalogReleaseError) throw new MobileServiceError(503, 'BUSY');
      return false;
    }
  }
  function track(trackId: string, editionId: string, catalogPlaybackEnabled: boolean): MobileTrack {
    current();
    const original = collection.localCatalog.trackDetail(trackId), edition = original.editions.find(item => item.id === editionId);
    if (!edition) return missing();
    const root = collection.localCatalog.root(original.asset.libraryRootId), source = collection.sources.root(root.sourceRootId);
    if (root.role !== 'library' || !source.authorized || root.revision !== original.asset.rootRevision) return unavailable();
    const detail = { ...original, fileParameters: catalogPlaybackEnabled
      ? collection.localScan.privateDisplayFileParameters(trackId, original.asset, 'mobile-catalog')
      : collection.localScan.privateDisplayFileParameters(trackId, original.asset) };
    if (!detail.fileParameters || detail.track.segment === null && detail.fileParameters.durationMs === null || !detail.metadata.effective.title) return unavailable();
    const identity = [datasetId, detail.asset.id, detail.asset.fileRevision, detail.track.selectionRevision, detail.track.segment];
    const cover = artworkId(selection(editionId));
    return projectMobileOwnerLocalTrack({ detail, binding: {
      localTrackId: trackId, assetId: detail.asset.id, fileRevision: detail.asset.fileRevision,
      selectionRevision: detail.track.selectionRevision, segmentId: detail.track.segment?.id ?? null,
      editionId, editionRevision: edition.revision, trackId: `lt:${datasetId}:${trackId}:${editionId}`,
      sourceItemId: `ls:${datasetId}:${detail.asset.id}`, albumId: `la:${datasetId}:${editionId}`,
      versionId: 'lv:' + digest(identity), contentRevision: 'lc:' + digest(identity),
    }, projection: { title: detail.metadata.effective.title, artists: detail.metadata.effective.artist ? [detail.metadata.effective.artist] : [],
      // 001 保持只读；002 开启只允许真实当前资格投影，不提前签发媒体读取资源。
      editionLabel: edition.edition, availability: catalogPlaybackEnabled && playbackAvailable(detail) ? 'available' : 'unavailable', ...(cover ? { artworkId: cover } : {}) } });
  }
  function album(editionId: string, representativeTrack: string): MobileAlbum {
    const edition = collection.localCatalog.edition(editionId), detail = collection.localCatalog.trackDetail(representativeTrack);
    const tracks = collection.localCatalog.privateMobileCandidates({ kind: 'tracks', offset: 0, limit: 1, query: '', editionId, trackId: null });
    if (tracks.total > 300000) throw new MobileServiceError(503, 'CONTENT_LIMIT_EXCEEDED');
    const cover = artworkId(selection(editionId));
    return { id: `la:${datasetId}:${editionId}`, title: edition.title, artists: detail.metadata.effective.artist ? [detail.metadata.effective.artist] : [],
      source: 'local', editionLabel: edition.edition, trackCount: tracks.total, ...(cover ? { artworkId: cover } : {}) };
  }
  function read(request: MobileOwnerCatalogRequest): MobileOwnerCatalogSnapshot {
    const catalogPlaybackEnabled = request.catalogPlaybackEnabled === true;
    current(); const start = revision(catalogPlaybackEnabled);
    if (request.expectedRevision !== null && request.expectedRevision !== start) throw new MobileServiceError(409, 'SOURCE_CHANGED');
    const albums = request.operation === 'listAlbums' || request.operation === 'getAlbum';
    let editionId = request.albumId === null ? null : identifiers(request.albumId, 'la', 1)[0]!, trackId: string | null = null;
    if (request.operation === 'getAlbum') editionId = identifiers(request.itemId!, 'la', 1)[0]!;
    if (request.operation === 'getTrack') { const ids = identifiers(request.itemId!, 'lt', 2); trackId = ids[0]!; editionId = ids[1]!; }
    const candidates = collection.localCatalog.privateMobileCandidates({ kind: albums ? 'albums' : 'tracks', offset: request.offset, limit: request.limit, query: request.q, editionId, trackId });
    if (candidates.total > 300000) throw new MobileServiceError(503, 'CONTENT_LIMIT_EXCEEDED');
    if (request.operation.startsWith('get') && candidates.total !== 1) return missing();
    const items = candidates.items.map(item => albums ? album(item.editionId, item.trackId) : track(item.trackId, item.editionId, catalogPlaybackEnabled));
    current(); if (revision(catalogPlaybackEnabled) !== start) throw new MobileServiceError(409, 'SOURCE_CHANGED');
    return { datasetId, ownerEpoch, libraryRevision: start, operation: request.operation, offset: request.offset, limit: request.limit, total: candidates.total, items };
  }
  function artwork(request: { serverId: string; artworkId: string }): MobileOwnerArtworkSnapshot {
    current(); const start = revision(), [selectionId, selectionRevision] = identifiers(request.artworkId, 'aw', 2);
    if (!selectionRevision || !/^[1-9][0-9]*$/u.test(selectionRevision) || !collection.privateMobileCatalogAccess) return missing();
    const selected = collection.privateMobileCatalogAccess(db => {
      const row = db.prepare("SELECT edition_id FROM local_artwork_selections WHERE json_extract(data,'$.id')=?").get(selectionId!);
      return row ? selection(String(row.edition_id)) : null;
    });
    if (!selected?.candidate) return missing();
    if (selected.revision !== selectionRevision || artworkId(selected) !== request.artworkId) throw new MobileServiceError(409, 'SOURCE_CHANGED');
    const permitted = collection.localCatalog.privateMobileCandidates({ kind: 'tracks', offset: 0, limit: 1, query: '', editionId: selected.editionId, trackId: null });
    if (!permitted.total) return unavailable();
    const display = selected.candidate.display, bytes = Buffer.from(display.dataUrl.slice(23), 'base64');
    if (bytes.length !== display.bytes || bytes.toString('base64') !== display.dataUrl.slice(23) || createHash('sha256').update(bytes).digest('hex') !== display.sha256) return unavailable();
    current(); if (revision() !== start) throw new MobileServiceError(409, 'SOURCE_CHANGED');
    return { datasetId, ownerEpoch, libraryRevision: start, artworkId: request.artworkId, selectionRevision, contentType: 'image/jpeg', bytes: new Uint8Array(bytes) };
  }
  return {
    dispatch(input: MobileOwnerPrivateRequest): MobileOwnerPrivateResult {
      try {
        current(); if (!isMobileOwnerPrivateRequest(input) || input.datasetId !== datasetId) throw new MobileAuthPersistenceError('not-sent');
        let result: MobileOwnerPrivateResult;
        if (input.kind === 'catalog') result = read(input.request);
        else if (input.kind === 'artwork') result = artwork(input.request);
        else if (input.kind === 'load' || input.kind === 'save' || input.kind === 'playback-load' || input.kind === 'playback-save') {
          const directory = collection.privateMobileDataDirectory?.(); if (!directory) throw new MobileAuthPersistenceError('not-sent');
          const isPlayback = input.kind.startsWith('playback-');
          const store = isPlayback ? (playbackState ??= createMobileSealedStateStore({ directory, datasetId, assertCurrent: current, namespace: 'playback' }))
            : (state ??= createMobileSealedStateStore({ directory, datasetId, assertCurrent: current }));
          result = input.kind === 'load' || input.kind === 'playback-load' ? store.load(datasetId) : store.save(input.request);
        } else throw new MobileServiceError(400, 'INVALID_REQUEST');
        current(); if (!isMobileOwnerPrivateResult(result, input)) throw new MobileAuthPersistenceError('unknown'); return result;
      } catch (error) {
        return { kind: 'mobile-error', status: error instanceof MobileServiceError ? error.status : 503,
          code: error instanceof MobileServiceError ? error.code : 'BUSY', retryable: false,
          outcome: error instanceof MobileAuthPersistenceError ? error.outcome : null };
      }
    },
  };
}
