import assert from 'node:assert/strict';
import test from 'node:test';
import type { LocalArtistTrackItem, LocalPlayRequest } from '@music-bridge/contracts';
import { materializeLocalSearchQueue } from '../../src/collection/mb-queue-materializer.js';
import { isLocalArtistSearchQueueSnapshot } from '../../src/collection/local-album-browser/owner-protocol.js';
import type { CollectionRepository } from '../../src/collection/repository.js';
import type { LocalArtistSearchService } from '../../src/collection/local-artist-search.js';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
function fixture(count = 241, changePage = false) {
  const root = { id: id(900001), sourceRootId: id(900002), role: 'library' as const, revision: '1' };
  const items: LocalArtistTrackItem[] = Array.from({ length: Math.min(count, 5001) }, (_, n) => ({
    track: { id: id(n + 1), assetId: id(n + 10001), selectionRevision: '1', segment: null },
    asset: { id: id(n + 10001), libraryRootId: root.id, sourceRootId: root.sourceRootId, rootRevision: '1', fileRevision: '1', locationRevision: '1', sampleFrames: null, timebaseHz: null },
    metadata: { title: `曲目${n}` }, versionTokens: [], rootId: root.id, albumKey: `album-${n}`,
  }));
  let pages = 0;
  const querySearchTracks = async ({ query, offset, limit }: { query: string; offset: number; limit: number }) => {
    pages++; const selected = items.slice(offset, offset + limit);
    return { query, offset, limit, total: count, hasMore: offset + selected.length < count, revision: changePage && offset > 0 ? 'changed' : 'revision-1', items: selected };
  };
  const artists = { querySearchTracks, revision: async () => 'revision-1' } as unknown as LocalArtistSearchService;
  const repository = { localCatalog: { track: (key: string) => items.find(item => item.track.id === key)!.track,
    asset: (key: string) => items.find(item => item.asset.id === key)!.asset, root: () => root }, sources: { root: () => ({ authorized: true }) } } as unknown as CollectionRepository;
  const selected = items[Math.min(220, items.length - 1)]!;
  const request: LocalPlayRequest = { schema_version: '1.2', request_id: '原请求身份', route: 'roon_audio_input', source_kind: 'local_file',
    local_track_id: selected.track.id, asset_id: selected.asset.id, expected_asset_revision: '1', action: 'PLAY_NOW', target: { core_id: 'core', zone_id: 'zone' },
    context: { kind: 'search', query: '曲目', revision: 'revision-1' } };
  return { repository, artists, request, pages: () => pages };
}
test('搜索点击材料化完整241条并保留原点击位置与request_id，不止首200条', async () => {
  const f = fixture(); const result = await materializeLocalSearchQueue(f.repository, f.artists, f.request, Date.now() + 10000, () => {});
  assert.equal(result.sources.length, 241); assert.equal(result.startIndex, 220); assert.equal(f.pages(), 2);
  assert.equal(f.request.request_id, '原请求身份'); assert.ok(isLocalArtistSearchQueueSnapshot(result, f.request));
});
test('中途revision改变整件拒绝，不把旧页与新页拼成队列', async () => {
  const f = fixture(241, true);
  await assert.rejects(materializeLocalSearchQueue(f.repository, f.artists, f.request, Date.now() + 10000, () => {}), { code: 'QUEUE_CONFLICT' });
});
test('5001条命中明确拒绝，不静默截断成合法5000条', async () => {
  const f = fixture(5001);
  await assert.rejects(materializeLocalSearchQueue(f.repository, f.artists, f.request, Date.now() + 10000, () => {}), { code: 'QUEUE_INVALID' });
  assert.equal(f.pages(), 1);
});
