import assert from 'node:assert/strict';
import { isLocalLibraryTrackDetail, type LocalLibraryTrackDetail } from '@music-bridge/contracts';
import type { CollectionRepository } from '../../src/collection/repository.js';
import type { LocalAlbumSqlMobileQuery, LocalAlbumSqlMobileRow } from '../../src/collection/local-album-browser/sql-types.js';
import { createMobileLocalAlbumProjection, type MobileLocalAlbums } from '../../src/mobile/local-album-projection.js';
import { mobileGroupHash, mobileTrackId } from '../../src/mobile/local-album-identity.js';
import type { MobileOwnerCatalogRequest } from '../../src/mobile/types.js';

export const DURATION_DATASET = '81000000-0000-4000-8000-000000000001';
const ROOT = '81000000-0000-4000-8000-000000000002';
const SOURCE = '81000000-0000-4000-8000-000000000003';
const ALBUM = `directory-${'d'.repeat(64)}`;
const uuid = (n: number) => `82000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

/** 仅合成当前目录事实；不读取数据库、源音频、封面或真实凭据。 */
export function unknownDurationFixture(count = 401) {
  let revision = 'scope:1', authorized = true, queries = 0, playbackChecks = 0;
  let playbackAvailable = false;
  const details: LocalLibraryTrackDetail[] = Array.from({ length: count }, (_, i) => {
    const fields = { title: `合成曲目${i + 1}`, artist: '合成作者' };
    return { track: { id: uuid(i + 1), assetId: uuid(i + 1001), selectionRevision: '1', segment: null },
      asset: { id: uuid(i + 1001), libraryRootId: ROOT, sourceRootId: SOURCE, rootRevision: '1', fileRevision: '1', locationRevision: '1', sampleFrames: null, timebaseHz: null },
      metadata: { raw: fields, override: null, effective: fields }, versionTokens: [], editions: [],
      fileParameters: { container: 'FLAC', codec: 'flac', lossless: true, sampleRateHz: 44100, channels: 2, bitsPerSample: 16, durationMs: 1000, evidence: 'bounded-parser-reported' } };
  });
  assert.ok(details.every(isLocalLibraryTrackDetail));
  const indices = new Map(details.map((d, i) => [d.track.id, i]));
  const detail = (id: string) => { const i = indices.get(id); assert.notEqual(i, undefined); return details[i!]!; };
  const collection = { localCatalog: {
    trackDetail: detail, root: () => ({ id: ROOT, sourceRootId: SOURCE, role: 'library', revision: '1' }),
    privateAssetLocator() { throw new Error('未知时长展示不能新增源文件读取。'); },
  }, sources: { root: () => ({ authorized }) },
    localScan: { privateDisplayFileParameters: (id: string) => detail(id).fileParameters },
  } as unknown as CollectionRepository;
  const groupHash = mobileGroupHash(ROOT, ALBUM);
  const row = (index: number): LocalAlbumSqlMobileRow => {
    const d = details[index]!;
    return { album: { id: ALBUM, rootId: ROOT, title: '合成专辑', artists: [], versionLabel: null, trackCount: count, artworkState: 'missing' },
      groupHash, artworkSourceRevision: 'a'.repeat(64), member: { fact: { relative: `合成目录/曲目${index + 1}.flac`,
        summary: { track: d.track, asset: d.asset, metadata: d.metadata.effective, versionTokens: [] },
        rawMetadata: d.metadata.raw, hasArtwork: false, artworkRevision: null },
        disc: null, trackNumber: null, sequence: index + 1, editionLink: null, statuses: [] } } as unknown as LocalAlbumSqlMobileRow;
  };
  const localAlbums = { privateMobile: { async refresh() {}, revision: () => revision,
    current(request: LocalAlbumSqlMobileQuery) {
      queries++;
      if (request.kind === 'groups') return { revision, total: 1, items: request.offset === 0 ? [row(0)] : [] };
      const selected = request.trackId === null ? [...indices.values()] : [indices.get(request.trackId)].filter((v): v is number => v !== undefined);
      return { revision, total: selected.length, items: selected.slice(request.offset, request.offset + request.limit).map(row) };
    } }, async getArtwork() { throw new Error('未知时长展示不读取封面。'); } } as unknown as MobileLocalAlbums;
  const projection = createMobileLocalAlbumProjection({ collection, localAlbums, datasetId: DURATION_DATASET,
    ownerEpoch: 'owner.synthetic.duration', assertCurrent() {}, playbackAvailable() { playbackChecks++; return playbackAvailable; } });
  const request = (overrides: Partial<MobileOwnerCatalogRequest> = {}): MobileOwnerCatalogRequest => ({
    operation: 'listTracks', serverId: 'server.duration', offset: 0, limit: 100, q: '', albumId: null, itemId: null, expectedRevision: null, ...overrides,
  });
  return { collection, localAlbums, details, request, page: (overrides: Partial<MobileOwnerCatalogRequest> = {}) => projection.catalog(request(overrides)),
    id: (index: number) => mobileTrackId(DURATION_DATASET, details[index]!.track.id, groupHash),
    setDuration(index: number, durationMs: number | null) {
      const d = details[index]!; assert.ok(d.fileParameters); details[index] = { ...d, fileParameters: { ...d.fileParameters, durationMs } };
      assert.ok(isLocalLibraryTrackDetail(details[index]));
    },
    setRevision: (v: string) => { revision = v; }, setAuthorized: (v: boolean) => { authorized = v; },
    setPlaybackAvailable: (v: boolean) => { playbackAvailable = v; }, counts: () => ({ queries, playbackChecks }),
  };
}
