import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isLocalLibraryTrackDetail, mobileCatalogResponseSnapshot,
  type LocalLibraryTrackDetail, type MobileTrack,
} from '@music-bridge/contracts';
import type { CollectionRepository } from '../../src/collection/repository.js';
import type { LocalAlbumSqlMobileQuery, LocalAlbumSqlMobileRow } from '../../src/collection/local-album-browser/sql-types.js';
import { createMobileLocalAlbumProjection, type MobileLocalAlbums } from '../../src/mobile/local-album-projection.js';
import { mobileGroupHash, mobileTrackId } from '../../src/mobile/local-album-identity.js';
import { MobileServiceError, type MobileOwnerCatalogRequest } from '../../src/mobile/types.js';

const DATASET = '71000000-0000-4000-8000-000000000001';
const ROOT = '71000000-0000-4000-8000-000000000002';
const SOURCE = '71000000-0000-4000-8000-000000000003';
const ALBUM = `directory-${'c'.repeat(64)}`;
const uuid = (n: number): string => `72000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const FALLBACK = '来源未提供标题';
const AFFECTED = 313;

/** 所有曲目、路径和SQL页均为合成；调用真实投影，不打开源文件或真实目录。 */
function fixture(count = 401) {
  let revision = 'scope:1', queryCount = 0, locatorReads = 0;
  let technical: 'normal' | 'missing' | 'invalid-audio' = 'normal';
  const details: LocalLibraryTrackDetail[] = Array.from({ length: count }, (_, i) => {
    const fields = { title: `合成曲目${i + 1}`, artist: '合成作者' };
    return { track: { id: uuid(i + 1), assetId: uuid(i + 1001), selectionRevision: '1', segment: null },
      asset: { id: uuid(i + 1001), libraryRootId: ROOT, sourceRootId: SOURCE, rootRevision: '1', fileRevision: '1', locationRevision: '1', sampleFrames: null, timebaseHz: null },
      metadata: { raw: fields, override: null, effective: fields }, versionTokens: [], editions: [],
      fileParameters: { container: 'FLAC', codec: 'flac', lossless: true, sampleRateHz: 44100, channels: 2, bitsPerSample: 16, durationMs: 1000, evidence: 'bounded-parser-reported' } };
  });
  const relatives = details.map((_, i) => `不可公开父目录/子目录/合成文件${i + 1}.flac`);
  const groupHash = mobileGroupHash(ROOT, ALBUM);
  const byId = (id: string) => { const value = details.find(d => d.track.id === id); assert.ok(value); return value; };
  const collection = { localCatalog: {
    trackDetail: byId,
    root: () => ({ id: ROOT, sourceRootId: SOURCE, role: 'library', revision: '1' }),
    privateAssetLocator() { locatorReads++; throw new Error('标题回退不能新增位置读取。'); },
  }, sources: { root: () => ({ authorized: true }) },
  localScan: { privateDisplayFileParameters(id: string) {
    if (technical === 'missing') return null;
    const parameters = byId(id).fileParameters!;
    return technical === 'invalid-audio' ? { ...parameters, codec: '含非法空格编码' } : parameters;
  } } } as unknown as CollectionRepository;
  const row = (index: number): LocalAlbumSqlMobileRow => {
    const detail = details[index]!;
    return { album: { id: ALBUM, rootId: ROOT, title: '合成专辑', artists: [], versionLabel: null, trackCount: count, artworkState: 'missing' },
      groupHash, artworkSourceRevision: 'a'.repeat(64), member: { fact: { relative: relatives[index]!,
        summary: { track: detail.track, asset: detail.asset, metadata: detail.metadata.effective, versionTokens: [] },
        rawMetadata: detail.metadata.raw, hasArtwork: false, artworkRevision: null },
        disc: null, trackNumber: null, sequence: index + 1, editionLink: null, statuses: [] } } as unknown as LocalAlbumSqlMobileRow;
  };
  const localAlbums = { privateMobile: { async refresh() {}, revision: () => revision,
    current(request: LocalAlbumSqlMobileQuery) {
      queryCount++;
      if (request.kind === 'groups') return { revision, total: 1, items: request.offset === 0 ? [row(0)] : [] };
      const indices = details.map((_, i) => i).filter(i => request.trackId === null || details[i]!.track.id === request.trackId);
      return { revision, total: indices.length, items: indices.slice(request.offset, request.offset + request.limit).map(row) };
    } }, async getArtwork() { throw new Error('标题回退不读取封面。'); } } as unknown as MobileLocalAlbums;
  const projection = createMobileLocalAlbumProjection({ collection, localAlbums, datasetId: DATASET, ownerEpoch: 'owner.synthetic', assertCurrent() {} });
  const request = (overrides: Partial<MobileOwnerCatalogRequest> = {}): MobileOwnerCatalogRequest => ({
    operation: 'listTracks', serverId: 'server.synthetic', offset: 0, limit: 100, q: '', albumId: null, itemId: null, expectedRevision: null, ...overrides,
  });
  const page = (overrides: Partial<MobileOwnerCatalogRequest> = {}) => projection.catalog(request(overrides));
  const tracks = (overrides: Partial<MobileOwnerCatalogRequest> = {}): MobileTrack[] => page(overrides).items.map(item => {
    const parsed = mobileCatalogResponseSnapshot('track', item); assert.ok(parsed.ok); return parsed.value;
  });
  return { page, tracks, details, relatives, counts: () => ({ queryCount, locatorReads }),
    setTitle(index: number, title: string | undefined) {
      const previous = details[index]!, fields = { ...previous.metadata.raw };
      if (title === undefined) delete fields.title; else fields.title = title;
      details[index] = { ...previous, metadata: { raw: fields, override: null, effective: fields } };
      assert.ok(isLocalLibraryTrackDetail(details[index]));
    },
    setTechnical(value: typeof technical) { technical = value; },
    setRevision(value: string) { revision = value; },
    id: (index: number) => mobileTrackId(DATASET, details[index]!.track.id, groupHash),
  };
}

test('M27标题回退：offset300第14项缺失可选title仍保完整100项及401总数', () => {
  const f = fixture(); f.setTitle(AFFECTED, undefined);
  const result = f.page({ offset: 300 });
  assert.equal(result.offset, 300); assert.equal(result.limit, 100); assert.equal(result.total, 401); assert.equal(result.items.length, 100);
  assert.equal(result.items[13]!.title, '合成文件314');
  assert.deepEqual(result.items.map(item => item.id), Array.from({ length: 100 }, (_, i) => f.id(300 + i)));
  assert.deepEqual(f.counts(), { queryCount: 1, locatorReads: 0 });
});

test('M27标题回退：全量五页不丢曲、不重造游标修订，专辑成员与详情同一标题', () => {
  const f = fixture(); f.setTitle(AFFECTED, '');
  const items: MobileTrack[] = []; let revision: string | null = null;
  for (let offset = 0; offset < 401; offset += 100) {
    const page = f.page({ offset, expectedRevision: revision }); revision ??= page.libraryRevision;
    assert.equal(page.libraryRevision, revision); assert.equal(page.total, 401);
    assert.equal(page.items.length, Math.min(100, 401 - offset));
    for (const item of page.items) { const value = mobileCatalogResponseSnapshot('track', item); assert.ok(value.ok); items.push(value.value); }
  }
  assert.equal(items.length, 401); assert.equal(new Set(items.map(item => item.id)).size, 401);
  const affected = items[AFFECTED]!;
  assert.equal(affected.title, '合成文件314');
  const detail = f.tracks({ operation: 'getTrack', itemId: affected.id, limit: 1 })[0]!;
  assert.deepEqual(detail, affected);
  const album = f.page({ operation: 'listAlbums', limit: 1 }).items[0]!;
  assert.deepEqual(f.tracks({ albumId: album.id, offset: 300 })[13], affected);
  assert.equal(f.counts().locatorReads, 0);
});

test('M27标题回退：保留合法原title，basename仅显示末组件且不新增源读取', () => {
  const f = fixture(1); const original = '  合法原题目 · Version 2  ';
  f.setTitle(0, original); f.relatives[0] = '不可公开父目录/禁止暴露子目录/无关文件.flac';
  assert.equal(f.tracks()[0]!.title, original);
  f.setTitle(0, ''); f.relatives[0] = '不可公开父目录/禁止暴露子目录/安全曲名.混音.flac';
  const track = f.tracks()[0]!; assert.equal(track.title, '安全曲名.混音');
  assert.doesNotMatch(JSON.stringify(track), /不可公开父目录|禁止暴露子目录|\.flac|\//u);
  assert.equal(f.counts().locatorReads, 0);
});

test('M27标题回退：空名与不安全basename只回固定桌面文案，不把坏候选放进DTO', async t => {
  for (const candidate of ['', '/', '父目录/', '父目录/.flac', '父目录/   .flac', `父目录/${'长'.repeat(513)}.flac`,
    '父目录/含\u0000控制.flac', '父目录/含\u0085控制.flac', '父目录/token=合成敏感值.flac', '父目录/cookie:合成敏感值.flac']) {
    await t.test(`合成不安全候选类别${candidate.length}`, () => {
      const f = fixture(1); f.setTitle(0, undefined); f.relatives[0] = candidate;
      assert.equal(f.tracks()[0]!.title, FALLBACK); assert.equal(f.counts().locatorReads, 0);
    });
  }
});

test('M27标题回退：展示变化不改变内容身份，真实file/selection修订仍更换内容版本', () => {
  const f = fixture(1); f.setTitle(0, undefined); f.relatives[0] = '父目录/安全回退.flac';
  const first = f.tracks()[0]!, scope = f.page().libraryRevision;
  f.relatives[0] = '另一个父目录/另一个安全回退.flac'; const moved = f.tracks()[0]!;
  const identity = (value: MobileTrack) => [value.id, value.sourceItemId, value.versionId, value.contentRevision];
  assert.deepEqual(identity(moved), identity(first)); assert.equal(f.page().libraryRevision, scope);
  f.setTitle(0, '后来真实元数据'); f.setRevision('scope:2'); const titled = f.tracks()[0]!;
  assert.equal(titled.title, '后来真实元数据'); assert.deepEqual(identity(titled), identity(first));
  assert.notEqual(f.page().libraryRevision, scope);
  const detail = f.details[0]!; f.details[0] = { ...detail, asset: { ...detail.asset, fileRevision: '2' } };
  const fileChanged = f.tracks()[0]!; assert.notEqual(fileChanged.contentRevision, first.contentRevision);
  f.details[0] = { ...f.details[0]!, track: { ...detail.track, selectionRevision: '2' } };
  assert.notEqual(f.tracks()[0]!.contentRevision, fileChanged.contentRevision);
});

test('M27标题回退：畸形真实title、音频事实缺失、非法编码与旧修订仍按原守门拒绝', () => {
  const f = fixture(1), original = f.details[0]!;
  const fields = { title: '真标题\u0000非法', artist: '合成作者' };
  f.details[0] = { ...original, metadata: { raw: fields, override: null, effective: fields } };
  assert.throws(() => f.page(), (e: unknown) => e instanceof MobileServiceError && e.code === 'SOURCE_CHANGED');
  f.details[0] = original; f.setTitle(0, undefined); f.setTechnical('missing');
  assert.throws(() => f.page(), (e: unknown) => e instanceof MobileServiceError && e.code === 'BUSY' && e.status === 503);
  f.setTechnical('invalid-audio');
  assert.throws(() => f.page(), (e: unknown) => e instanceof MobileServiceError && e.code === 'BUSY' && e.status === 503);
  f.setTechnical('normal'); const revision = f.page().libraryRevision; f.setRevision('scope:2');
  assert.throws(() => f.page({ expectedRevision: revision }), (e: unknown) => e instanceof MobileServiceError && e.code === 'SOURCE_CHANGED');
});
