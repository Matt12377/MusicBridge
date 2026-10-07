import assert from 'node:assert/strict';
import test from 'node:test';
import { createLocalLibraryClient } from '../src/preload/local-library-client.js';
const id = '11111111-1111-4111-8111-111111111111';
test('009preload搜索与target复用固定dataset，写不进入普通IPC', async () => {
  const calls: any[] = [], writes: any[] = [];
  const client = createLocalLibraryClient(async (channel, body: any) => { calls.push({ channel, body }); return body.command === 'playback.localTarget' ? { core_id: 'core', zone_id: 'zone' } : { ...body.payload, total: 0, hasMore: false, items: [] }; }, async () => id, {
    chooseRoot: async () => null, confirm: async () => { throw new Error('无重定位'); }, relink: async () => { throw new Error('无根重关联'); },
    override: async (body: any) => { writes.push(body); return { trackId: id, revision: '1', fields: body.fields }; },
  } as any) as any;
  await client.queryLocalLibraryTracks({ query: '天空', rootId: null, offset: 0, limit: 100 });
  assert.deepEqual(await client.getLocalLibraryPlaybackTarget(), { core_id: 'core', zone_id: 'zone' });
  await client.overrideLocalLibraryMetadata({ commandId: id, trackId: id, expectedRevision: null, fields: { title: '仅展示名' } });
  assert.equal(calls.length, 2); assert.ok(calls.every(call => call.body.datasetId === id)); assert.equal(writes.length, 1);
});
test('009preload在clone前拒绝隐藏路径和过大搜索', async () => {
  let sent = 0;
  const client = createLocalLibraryClient(async () => { sent++; return null; }, async () => id, { chooseRoot: async () => null, confirm: async () => { throw 0; }, relink: async () => { throw 0; } }) as any;
  const query = { query: '', rootId: null, offset: 0, limit: 100 };
  await assert.rejects(client.queryLocalLibraryTracks(Object.defineProperty({ ...query }, 'path', { value: '/private' })));
  await assert.rejects(client.queryLocalLibraryTracks({ ...query, query: '曲'.repeat(257) })); assert.equal(sent, 0);
});
