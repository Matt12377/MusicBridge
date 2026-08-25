import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createRoonLibraryService,
  summarizeRoonBrowsePayload,
  type RoonBrowseApi,
  type RoonImageApi,
} from '../src/roon/library.js';
import { RoonActionBlockedError } from '../src/roon/action-policy.js';

const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

test('RoonLibraryService 通过 Browse + load 读取 Albums 分页，并保留真实存在的字段', async () => {
  const browseCalls: Array<Record<string, unknown>> = [];
  const loadCalls: Array<Record<string, unknown>> = [];
  const browse: RoonBrowseApi = {
    browse(options, callback) {
      browseCalls.push(options);
      callback(false, {
        action: 'list',
        list: { level: 0, count: 3, title: 'Albums' },
      });
    },
    load(options, callback) {
      loadCalls.push(options);
      callback(false, {
        offset: options.offset,
        items: [
          {
            title: 'Private Album',
            subtitle: 'Private Artist',
            item_key: 'album:1',
            image_key: 'image:1',
            hint: 'list',
            year: 2024,
          },
        ],
      });
    },
  };
  const image: RoonImageApi = {
    get_image(_imageKey, _options, callback) {
      callback(false, 'image/jpeg', Buffer.from('image-bytes'));
    },
  };

  const service = createRoonLibraryService({ browse, image });
  const page = await service.browseAlbums({ offset: 1, limit: 1 });

  assert.deepEqual(browseCalls, [{
    hierarchy: 'albums',
    multi_session_key: browseCalls[0]?.multi_session_key,
    pop_all: true,
  }]);
  assert.equal(typeof browseCalls[0]?.multi_session_key, 'string');
  assert.deepEqual(loadCalls, [{
    hierarchy: 'albums',
    multi_session_key: browseCalls[0]?.multi_session_key,
    level: 0,
    offset: 1,
    count: 1,
  }]);
  const album = page.items[0];
  assert.ok(album?.browseContext);
  const { browseContext: _browseContext, ...publicFields } = album;
  assert.deepEqual({ ...page, items: [publicFields] }, {
    items: [{
      kind: 'album',
      hierarchy: 'albums',
      title: 'Private Album',
      subtitle: 'Private Artist',
      itemKey: 'album:1',
      imageKey: 'image:1',
      hint: 'list',
      year: 2024,
    }],
    offset: 1,
    level: 0,
    total: 3,
    hasMore: true,
  });
  assert.deepEqual(
    {
      hierarchy: album.browseContext.hierarchy,
      multiSessionKey: album.browseContext.multiSessionKey,
      level: album.browseContext.level,
      itemKey: album.browseContext.itemKey,
      kind: album.browseContext.kind,
    },
    {
      hierarchy: 'albums',
      multiSessionKey: browseCalls[0]?.multi_session_key,
      level: 0,
      itemKey: 'album:1',
      kind: 'album',
    },
  );
  assert.match(album.browseContext.parentReference ?? '', /^[0-9a-f]{64}$/u);
  assert.match(album.browseContext.pathSignature, /^[0-9a-f]{64}$/u);
});

test('RoonLibraryService 使用 Album 来源 Browse Context 进入曲目层', async () => {
  const calls: Array<Record<string, unknown>> = [];
  let browseIndex = 0;
  let loadIndex = 0;
  const browse: RoonBrowseApi = {
    browse(options, callback) {
      calls.push(options);
      callback(false, browseIndex++ === 0
        ? { action: 'list', list: { level: 0, count: 1, title: 'Albums' } }
        : { action: 'list', list: { level: 1, count: 1, title: 'Tracks' } });
    },
    load(options, callback) {
      callback(false, loadIndex++ === 0
        ? {
            offset: options.offset,
            items: [{
              title: 'Private Album',
              item_key: 'album:1',
              image_key: 'image:album',
              hint: 'list',
            }],
          }
        : {
            offset: options.offset,
            items: [{
              title: 'Private Track',
              subtitle: 'Private Artist',
              item_key: 'track:1',
              hint: 'action_list',
              duration: 243,
            }],
          });
    },
  };
  const service = createRoonLibraryService({
    browse,
    image: { get_image: () => undefined },
  });

  const albums = await service.browseAlbums({ offset: 0, limit: 100 });
  const album = albums.items[0];
  assert.ok(album);
  const page = await service.browseAlbum(album, { offset: 0, limit: 100 });

  assert.deepEqual(calls[1], {
    hierarchy: 'albums',
    multi_session_key: calls[0]?.multi_session_key,
    item_key: 'album:1',
  });
  const track = page.items[0];
  assert.ok(track?.browseContext);
  const { browseContext: _browseContext, ...trackFields } = track;
  assert.deepEqual(trackFields, {
    kind: 'track',
    hierarchy: 'albums',
    title: 'Private Track',
    subtitle: 'Private Artist',
    itemKey: 'track:1',
    imageKey: 'image:album',
    hint: 'action_list',
    durationSeconds: 243,
  });
  assert.deepEqual(
    {
      hierarchy: track.browseContext.hierarchy,
      multiSessionKey: track.browseContext.multiSessionKey,
      level: track.browseContext.level,
      itemKey: track.browseContext.itemKey,
      kind: track.browseContext.kind,
      parentReference: track.browseContext.parentReference,
    },
    {
      hierarchy: 'albums',
      multiSessionKey: calls[0]?.multi_session_key,
      level: 1,
      itemKey: 'track:1',
      kind: 'track',
      parentReference: album.browseContext?.pathSignature,
    },
  );
});

test('RoonLibraryService Image seam 只接受显式 key 和受限尺寸格式', async () => {
  const calls: Array<{ imageKey: string; options: Record<string, unknown> }> = [];
  const summaries: Array<Record<string, unknown>> = [];
  const image: RoonImageApi = {
    get_image(imageKey, options, callback) {
      calls.push({ imageKey, options });
      callback(false, 'image/png', PNG_BYTES);
    },
  };
  const service = createRoonLibraryService({
    browse: {
      browse: () => undefined,
      load: () => undefined,
    },
    image,
    onImageShape: (summary) => summaries.push(summary as unknown as Record<string, unknown>),
  });

  const result = await service.getImage('image:1', {
    width: 256,
    height: 256,
    scale: 'fit',
    format: 'image/png',
  });

  assert.deepEqual(calls, [{
    imageKey: 'image:1',
    options: { width: 256, height: 256, scale: 'fit', format: 'image/png' },
  }]);
  assert.equal(result.contentType, 'image/png');
  assert.deepEqual(result.body, PNG_BYTES);
  assert.deepEqual(summaries, [{
    layer: 'roon-callback',
    contentType: 'image/png',
    byteLength: 8,
    magic8: '89504e470d0a1a0a',
    bodyType: 'Buffer',
    isBuffer: true,
    isUint8Array: true,
    isArrayBuffer: false,
    valid: true,
  }]);
});

test('RoonLibraryService 拒绝非图片 content type、MIME 魔数不符和超过 4 MiB 的图片响应', async () => {
  const browse: RoonBrowseApi = {
    browse: () => undefined,
    load: () => undefined,
  };
  const htmlService = createRoonLibraryService({
    browse,
    image: {
      get_image(_imageKey, _options, callback) {
        callback(false, 'text/html', Buffer.from('<html>private upstream error</html>'));
      },
    },
  });
  await assert.rejects(
    htmlService.getImage('image:html'),
    (error: unknown) => (error as { code?: unknown }).code === 'ROON_IMAGE_REQUEST_FAILED',
  );

  const mismatchedService = createRoonLibraryService({
    browse,
    image: {
      get_image(_imageKey, _options, callback) {
        callback(false, 'image/jpeg', PNG_BYTES);
      },
    },
  });
  await assert.rejects(
    mismatchedService.getImage('image:mismatched'),
    (error: unknown) => (error as { code?: unknown }).code === 'ROON_IMAGE_REQUEST_FAILED',
  );

  const malformedService = createRoonLibraryService({
    browse,
    image: {
      get_image(_imageKey, _options, callback) {
        callback(false, 'image/jpeg', Buffer.from('not-an-image'));
      },
    },
  });
  await assert.rejects(
    malformedService.getImage('image:malformed'),
    (error: unknown) => (error as { code?: unknown }).code === 'ROON_IMAGE_REQUEST_FAILED',
  );

  const oversizedService = createRoonLibraryService({
    browse,
    image: {
      get_image(_imageKey, _options, callback) {
        callback(false, 'image/jpeg', Buffer.alloc(4 * 1024 * 1024 + 1));
      },
    },
  });
  await assert.rejects(
    oversizedService.getImage('image:oversized'),
    (error: unknown) => (error as { code?: unknown }).code === 'ROON_IMAGE_REQUEST_FAILED',
  );
});

test('RoonLibraryService 对永久不回调的 Browse 和 Image 请求执行有界超时', async () => {
  const service = createRoonLibraryService({
    browse: {
      browse: () => undefined,
      load: () => undefined,
    },
    image: { get_image: () => undefined },
    requestTimeoutMs: 1,
  });

  const browseResult = await Promise.race([
    service.browseAlbums({ offset: 0, limit: 20 }).then(
      () => 'resolved' as const,
      (error: unknown) => error,
    ),
    new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 20)),
  ]);
  assert.notEqual(browseResult, 'pending');
  assert.ok(browseResult instanceof Error);
  assert.equal((browseResult as { code?: unknown }).code, 'ROON_LIBRARY_REQUEST_FAILED');

  const imageResult = await Promise.race([
    service.getImage('image:timeout').then(
      () => 'resolved' as const,
      (error: unknown) => error,
    ),
    new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 20)),
  ]);
  assert.notEqual(imageResult, 'pending');
  assert.ok(imageResult instanceof Error);
  assert.equal((imageResult as { code?: unknown }).code, 'ROON_IMAGE_REQUEST_FAILED');
});

test('RoonLibraryService 把规范化后的搜索词传给受控 Browse prompt', async () => {
  const browseCalls: Array<Record<string, unknown>> = [];
  const service = createRoonLibraryService({
    browse: {
      browse(options, callback) {
        browseCalls.push(options);
        callback(false, { action: 'list', list: { level: 0, count: 4 } });
      },
      load(_options, callback) {
        callback(false, {
          offset: 0,
          items: [
            { title: 'Tracks', hint: 'header' },
            { title: 'Result A', item_key: 'track:a', hint: 'action_list' },
            { title: 'Album Result', item_key: 'album:a', hint: 'list' },
            { title: 'Result B', item_key: 'track:b', hint: 'action_list' },
          ],
        });
      },
    },
    image: { get_image: () => undefined },
    zoneOrOutputId: () => 'zone:1',
  });

  const page = await service.searchLibrary('  Beatles  ', { offset: 0, limit: 20 });

  assert.deepEqual(page.items.map((item) => item.title), ['Result A', 'Result B']);
  assert.deepEqual(page.items.map((item) => item.kind), ['track', 'track']);
  assert.equal(page.total, 2);
  assert.deepEqual(browseCalls, [{
    hierarchy: 'search',
    multi_session_key: browseCalls[0]?.multi_session_key,
    pop_all: true,
    input: 'Beatles',
    zone_or_output_id: 'zone:1',
  }]);
});

test('RoonLibraryService 只下钻 Search 的 Tracks 分组并复用查询 Session 分页', async () => {
  const browseCalls: Array<Record<string, unknown>> = [];
  let location: 'root' | 'tracks' = 'root';
  const service = createRoonLibraryService({
    browse: {
      browse(options, callback) {
        browseCalls.push(options);
        if (options.pop_all === true) {
          location = 'root';
          callback(false, { action: 'list', list: { level: 0, count: 3 } });
          return;
        }
        if (options.item_key === 'group:tracks') {
          location = 'tracks';
          callback(false, { action: 'list', list: { level: 1, count: 2 } });
          return;
        }
        callback('unexpected search drill-down', undefined);
      },
      load(options, callback) {
        callback(false, location === 'root'
          ? {
              offset: options.offset,
              items: [
                { title: 'Results', hint: 'header' },
                { title: 'Tracks', item_key: 'group:tracks', hint: 'list' },
                { title: 'Album Result', item_key: 'album:result', hint: 'list' },
              ],
            }
          : {
              offset: options.offset,
              items: [
                { title: 'Track A', item_key: 'track:a', hint: 'action_list' },
                { title: 'Track B', item_key: 'track:b', hint: 'action_list' },
              ],
            });
      },
    },
    image: { get_image: () => undefined },
  });

  const first = await service.searchLibrary('归零', { offset: 0, limit: 1 });
  const second = await service.searchLibrary('归零', { offset: 1, limit: 1 });

  assert.deepEqual(first.items.map((item) => item.title), ['Track A']);
  assert.deepEqual(second.items.map((item) => item.title), ['Track B']);
  assert.equal(first.total, 2);
  assert.deepEqual(browseCalls.map((call) => call.item_key), [undefined, 'group:tracks']);
  assert.equal(browseCalls.some((call) => call.item_key === 'album:result'), false);
  assert.equal(browseCalls[0]?.multi_session_key, browseCalls[1]?.multi_session_key);
});

test('RoonLibraryService 同一 hierarchy 分页复用 session，不同 hierarchy 仍隔离', async () => {
  const browseCalls: Array<Record<string, unknown>> = [];
  const service = createRoonLibraryService({
    browse: {
      browse(options, callback) {
        browseCalls.push(options);
        callback(false, { action: 'list', list: { level: 0, count: 0 } });
      },
      load(options, callback) {
        callback(false, { offset: options.offset, items: [] });
      },
    },
    image: { get_image: () => undefined },
  });

  await service.browseAlbums({ offset: 0, limit: 20 });
  await service.browseAlbums({ offset: 20, limit: 20 });
  await service.browseArtists({ offset: 0, limit: 20 });

  assert.equal(browseCalls.length, 2);
  assert.deepEqual(browseCalls.map((call) => call.hierarchy), ['albums', 'artists']);
  assert.notEqual(browseCalls[0]?.multi_session_key, browseCalls[1]?.multi_session_key);
});

test('RoonLibraryService 专辑曲目层只接受 action_list，不把 header、action 或普通项强制映射为 Track', async () => {
  let browseIndex = 0;
  let loadIndex = 0;
  const service = createRoonLibraryService({
    browse: {
      browse(_options, callback) {
        callback(false, browseIndex++ === 0
          ? { action: 'list', list: { level: 0, count: 1 } }
          : { action: 'list', list: { level: 1, count: 5 } });
      },
      load(options, callback) {
        callback(false, loadIndex++ === 0
          ? {
              offset: options.offset,
              items: [{ title: 'Album', item_key: 'album:1', hint: 'list' }],
            }
          : {
              offset: options.offset,
              items: [
                { title: 'Disc 1', hint: 'header' },
                { title: 'Delete from Library', item_key: 'action:delete', hint: 'action' },
                { title: 'Play Album', item_key: 'action:play-album', hint: 'action_list' },
                { title: 'Track 1', subtitle: 'Artist', item_key: 'track:1', hint: 'action_list' },
                { title: 'Unclassified Result', item_key: 'unknown:1' },
              ],
            });
      },
    },
    image: { get_image: () => undefined },
  });

  const albums = await service.browseAlbums({ offset: 0, limit: 20 });
  const album = albums.items[0];
  assert.ok(album);
  const tracks = await service.browseAlbum(album, { offset: 0, limit: 20 });

  assert.equal(tracks.total, 1);
  assert.deepEqual(tracks.items.map((item) => [item.kind, item.title]), [['track', 'Track 1']]);
});

test('RoonLibraryService 打开相邻专辑前先回退到共同父层级', async () => {
  const browseCalls: Array<Record<string, unknown>> = [];
  let location: 'root' | 'album:1' | 'album:2' = 'root';
  const service = createRoonLibraryService({
    browse: {
      browse(options, callback) {
        browseCalls.push(options);
        if (options.pop_all === true || options.pop_levels === 1) {
          location = 'root';
          callback(false, { action: 'list', list: { level: 0, count: 2 } });
          return;
        }
        if (options.item_key === 'album:1' || options.item_key === 'album:2') {
          location = options.item_key;
          callback(false, { action: 'list', list: { level: 1, count: 1 } });
          return;
        }
        callback('unexpected browse', undefined);
      },
      load(options, callback) {
        callback(false, location === 'root'
          ? {
              offset: options.offset,
              items: [
                { title: 'Album 1', item_key: 'album:1', hint: 'list' },
                { title: 'Album 2', item_key: 'album:2', hint: 'list' },
              ],
            }
          : {
              offset: options.offset,
              items: [{
                title: location === 'album:1' ? 'Track 1' : 'Track 2',
                item_key: location === 'album:1' ? 'track:1' : 'track:2',
                hint: 'action_list',
              }],
            });
      },
    },
    image: { get_image: () => undefined },
  });

  const albums = await service.browseAlbums({ offset: 0, limit: 20 });
  assert.ok(albums.items[0]);
  assert.ok(albums.items[1]);
  await service.browseAlbum(albums.items[0], { offset: 0, limit: 20 });
  await service.browseAlbum(albums.items[1], { offset: 0, limit: 20 });

  assert.deepEqual(browseCalls.map((call) => ({
    itemKey: call.item_key,
    popAll: call.pop_all,
    popLevels: call.pop_levels,
  })), [
    { itemKey: undefined, popAll: true, popLevels: undefined },
    { itemKey: 'album:1', popAll: undefined, popLevels: undefined },
    { itemKey: undefined, popAll: undefined, popLevels: 1 },
    { itemKey: 'album:2', popAll: undefined, popLevels: undefined },
  ]);
});

test('RoonLibraryService 有界下钻多碟专辑并保持 Disc/Track 顺序', async () => {
  const browseCalls: Array<Record<string, unknown>> = [];
  let location: 'root' | 'album' | 'disc:1' | 'disc:2' = 'root';
  const service = createRoonLibraryService({
    browse: {
      browse(options, callback) {
        browseCalls.push(options);
        if (options.pop_all === true) {
          location = 'root';
          callback(false, { action: 'list', list: { level: 0, count: 1 } });
          return;
        }
        if (options.pop_levels === 1) {
          location = 'album';
          callback(false, { action: 'list', list: { level: 1, count: 2 } });
          return;
        }
        if (options.item_key === 'album:multi') {
          location = 'album';
          callback(false, { action: 'list', list: { level: 1, count: 2 } });
          return;
        }
        if (options.item_key === 'disc:1' || options.item_key === 'disc:2') {
          location = options.item_key;
          callback(false, { action: 'list', list: { level: 2, count: 2 } });
          return;
        }
        callback('unexpected browse', undefined);
      },
      load(options, callback) {
        if (location === 'root') {
          callback(false, {
            offset: options.offset,
            items: [{ title: 'Multi Disc', item_key: 'album:multi', hint: 'list' }],
          });
          return;
        }
        if (location === 'album') {
          callback(false, {
            offset: options.offset,
            items: [
              { title: 'Disc 1', item_key: 'disc:1', hint: 'list' },
              { title: 'Disc 2', item_key: 'disc:2', hint: 'list' },
            ],
          });
          return;
        }
        const discNumber = location === 'disc:1' ? 1 : 2;
        callback(false, {
          offset: options.offset,
          items: [1, 2].map((trackNumber) => ({
            title: `D${discNumber} Track ${trackNumber}`,
            subtitle: 'Artist',
            item_key: `track:${discNumber}:${trackNumber}`,
            hint: 'action_list',
            track_number: trackNumber,
          })),
        });
      },
    },
    image: { get_image: () => undefined },
  });

  const albums = await service.browseAlbums({ offset: 0, limit: 20 });
  const album = albums.items[0];
  assert.ok(album);
  const tracks = await service.browseAlbum(album, { offset: 0, limit: 20 });

  assert.equal(tracks.total, 4);
  assert.deepEqual(tracks.items.map((track) => ({
    title: track.title,
    discNumber: track.discNumber,
    trackNumber: track.trackNumber,
  })), [
    { title: 'D1 Track 1', discNumber: 1, trackNumber: 1 },
    { title: 'D1 Track 2', discNumber: 1, trackNumber: 2 },
    { title: 'D2 Track 1', discNumber: 2, trackNumber: 1 },
    { title: 'D2 Track 2', discNumber: 2, trackNumber: 2 },
  ]);
  assert.equal(browseCalls.filter((call) => call.pop_levels === 1).length, 1);
});

test('RoonLibraryService 从最终 Track 的明确 CD1/CD2 标签补全多碟顺序', async () => {
  let browseIndex = 0;
  let loadIndex = 0;
  const service = createRoonLibraryService({
    browse: {
      browse(_options, callback) {
        callback(false, browseIndex++ === 0
          ? { action: 'list', list: { level: 0, count: 1 } }
          : { action: 'list', list: { level: 1, count: 2 } });
      },
      load(options, callback) {
        callback(false, loadIndex++ === 0
          ? {
              offset: options.offset,
              items: [{ title: 'Two CD Album', item_key: 'album:2cd', hint: 'list' }],
            }
          : {
              offset: options.offset,
              items: [
                { title: 'Archive [CD1]', subtitle: 'Artist', item_key: 'track:cd1', hint: 'action_list' },
                { title: 'Archive [CD2]', subtitle: 'Artist', item_key: 'track:cd2', hint: 'action_list' },
              ],
            });
      },
    },
    image: { get_image: () => undefined },
  });

  const albums = await service.browseAlbums({ offset: 0, limit: 20 });
  const album = albums.items[0];
  assert.ok(album);
  const tracks = await service.browseAlbum(album, { offset: 0, limit: 20 });

  assert.deepEqual(tracks.items.map((track) => track.discNumber), [1, 2]);
});

test('RoonLibraryService 对疑似整库回流的超大专辑层 fail closed', async () => {
  let loadCalls = 0;
  let browseIndex = 0;
  const service = createRoonLibraryService({
    browse: {
      browse(_options, callback) {
        callback(false, browseIndex++ === 0
          ? { action: 'list', list: { level: 0, count: 1 } }
          : { action: 'list', list: { level: 1, count: 8_491 } });
      },
      load(options, callback) {
        loadCalls += 1;
        callback(false, {
          offset: options.offset,
          items: [{ title: 'Album', item_key: 'album:1', hint: 'list' }],
        });
      },
    },
    image: { get_image: () => undefined },
  });

  const albums = await service.browseAlbums({ offset: 0, limit: 20 });
  const album = albums.items[0];
  assert.ok(album);
  await assert.rejects(
    service.browseAlbum(album, { offset: 0, limit: 20 }),
    (error: unknown) => (error as { code?: unknown }).code === 'ROON_LIBRARY_RESPONSE_INVALID',
  );
  assert.equal(loadCalls, 1);
});

test('Roon Browse 诊断只记录有界结构，不记录标题、item_key 或输入值', async () => {
  const summaries: unknown[] = [];
  const service = createRoonLibraryService({
    browse: {
      browse: (_options, callback) => callback(false, {
        action: 'list',
        list: { level: 0, count: 2, title: 'Private Albums' },
      }),
      load: (_options, callback) => callback(false, {
        offset: 0,
        items: [
          {
            title: 'Private Album',
            subtitle: 'Private Artist',
            item_key: 'private:item:key',
            image_key: 'private:image:key',
            hint: 'list',
          },
          {
            title: 'Search',
            item_key: 'private:prompt:key',
            input_prompt: { prompt: 'Private Search' },
          },
        ],
      }),
    },
    image: { get_image: () => undefined },
    onBrowseShape: (summary: unknown) => summaries.push(summary),
  } as Parameters<typeof createRoonLibraryService>[0] & {
    onBrowseShape(summary: unknown): void;
  });

  await service.browseAlbums({ offset: 0, limit: 20 });

  assert.deepEqual(summaries, [
    {
      operation: 'browse',
      hierarchy: 'albums',
      bodyType: 'object',
      bodyKeys: ['action', 'list'],
      action: 'list',
      level: 0,
      count: 2,
      listHint: 'generic',
      listKeys: ['count', 'level', 'title'],
    },
    {
      operation: 'load',
      hierarchy: 'albums',
      bodyType: 'object',
      bodyKeys: ['items', 'offset'],
      offset: 0,
      itemCount: 2,
      itemKeys: ['hint', 'image_key', 'input_prompt', 'item_key', 'subtitle', 'title'],
      itemKeyCount: 2,
      imageKeyCount: 1,
      subtitleCount: 1,
      inputPromptCount: 1,
      hintCounts: {
        generic: 1,
        list: 1,
        actionList: 0,
        action: 0,
        header: 0,
        unknown: 0,
      },
    },
  ]);
  assert.doesNotMatch(
    JSON.stringify(summaries),
    /Private|private:|Search/u,
  );
});

test('Roon Browse 诊断可识别搜索 replacement prompt 但不记录其内容', () => {
  const summary = summarizeRoonBrowsePayload('browse', {
    hierarchy: 'search',
    multi_session_key: 'private-session',
    item_key: 'private-entry',
  }, {
    action: 'replace_item',
    item: {
      title: 'Private Search',
      item_key: 'private-prompt',
      hint: 'action',
      input_prompt: { prompt: 'Private prompt' },
    },
  });

  assert.deepEqual(summary, {
    operation: 'browse',
    hierarchy: 'search',
    bodyType: 'object',
    bodyKeys: ['action', 'item'],
    action: 'replace_item',
    replacementKeys: ['hint', 'input_prompt', 'item_key', 'title'],
    replacementItemKeyPresent: true,
    replacementInputPromptPresent: true,
    replacementHint: 'action',
  });
  assert.doesNotMatch(JSON.stringify(summary), /Private|private-/u);
});

test('RoonLibraryService keeps the originating hierarchy through artist album drill-down', async () => {
  const browseCalls: Array<Record<string, unknown>> = [];
  let level = 0;
  const service = createRoonLibraryService({
    browse: {
      browse(options, callback) {
        browseCalls.push(options);
        if (options.pop_all === true) level = 0;
        else if (options.item_key === 'artist:1') level = 1;
        else if (options.item_key === 'artist-album:1') level = 2;
        callback(false, { action: 'list', list: { level, count: level === 2 ? 0 : 1 } });
      },
      load(options, callback) {
        callback(false, {
          offset: options.offset,
          items: level === 0
            ? [{ title: 'Artist', item_key: 'artist:1', hint: 'list' }]
            : level === 1
              ? [{ title: 'Artist Album', item_key: 'artist-album:1', hint: 'list' }]
              : [],
        });
      },
    },
    image: { get_image: () => undefined },
  });

  const artists = await service.browseArtists({ offset: 0, limit: 20 });
  const artist = artists.items[0];
  assert.ok(artist);
  const albums = await service.browseArtist(artist, { offset: 0, limit: 20 });
  const album = albums.items[0];
  assert.ok(album);
  await service.browseAlbum(album, { offset: 0, limit: 20 });

  assert.deepEqual(browseCalls.map((call) => call.hierarchy), ['artists', 'artists', 'artists']);
});

test('RoonLibraryService 只下钻 Artist 的 Albums 分组，不把 Top Tracks 导航映射成 Album', async () => {
  const browseCalls: Array<Record<string, unknown>> = [];
  let location: 'root' | 'artist' | 'albums' = 'root';
  const service = createRoonLibraryService({
    browse: {
      browse(options, callback) {
        browseCalls.push(options);
        if (options.pop_all === true) {
          location = 'root';
          callback(false, { action: 'list', list: { level: 0, count: 1 } });
          return;
        }
        if (options.item_key === 'artist:1') {
          location = 'artist';
          callback(false, { action: 'list', list: { level: 1, count: 2 } });
          return;
        }
        if (options.item_key === 'group:albums') {
          location = 'albums';
          callback(false, { action: 'list', list: { level: 2, count: 2 } });
          return;
        }
        callback('unexpected artist drill-down', undefined);
      },
      load(options, callback) {
        if (location === 'root') {
          callback(false, {
            offset: options.offset,
            items: [{ title: 'Artist', item_key: 'artist:1', hint: 'list' }],
          });
          return;
        }
        if (location === 'artist') {
          callback(false, {
            offset: options.offset,
            items: [
              { title: 'Albums', item_key: 'group:albums', hint: 'list' },
              { title: 'Top Tracks', item_key: 'group:tracks', hint: 'list' },
            ],
          });
          return;
        }
        callback(false, {
          offset: options.offset,
          items: [
            { title: 'Album A', item_key: 'album:a', hint: 'list' },
            { title: 'Album B', item_key: 'album:b', hint: 'list' },
          ],
        });
      },
    },
    image: { get_image: () => undefined },
  });

  const artists = await service.browseArtists({ offset: 0, limit: 20 });
  const artist = artists.items[0];
  assert.ok(artist);
  const first = await service.browseArtist(artist, { offset: 0, limit: 1 });
  const second = await service.browseArtist(artist, { offset: 1, limit: 1 });

  assert.deepEqual(first.items.map((item) => item.title), ['Album A']);
  assert.deepEqual(second.items.map((item) => item.title), ['Album B']);
  assert.equal(first.total, 2);
  assert.deepEqual(browseCalls.map((call) => call.item_key), [undefined, 'artist:1', 'group:albums']);
  assert.equal(browseCalls.some((call) => call.item_key === 'group:tracks'), false);
});

test('RoonLibraryService 不会把未知 Browse hint 当作可进入层级执行', async () => {
  let browseCalls = 0;
  const service = createRoonLibraryService({
    browse: {
      browse: (_options, callback) => {
        browseCalls += 1;
        callback(false, { list: { level: 1 } });
      },
      load: () => undefined,
    },
    image: { get_image: () => undefined },
  });

  await assert.rejects(
    service.browseAlbum({
      kind: 'album',
      title: 'Unknown Album',
      itemKey: 'album:unknown',
      hint: 'action',
    }, { offset: 0, limit: 1 }),
    (error: unknown) => error instanceof RoonActionBlockedError && error.reason === 'unknown',
  );
  assert.equal(browseCalls, 0);
});

test('RoonLibraryService 只通过 typed Play/Queue action 播放或排队 Track', async () => {
  const calls: Array<{ operation: 'browse' | 'load'; options: Record<string, unknown> }> = [];
  let location: 'root' | 'album' | 'track-actions' = 'root';
  let albumLoads = 0;
  const browse: RoonBrowseApi = {
    browse(options, callback) {
      calls.push({ operation: 'browse', options });
      if (options.pop_all === true) {
        location = 'root';
        callback(false, { action: 'list', list: { level: 0, count: 1 } });
        return;
      }
      if (options.item_key === 'album:1' || options.pop_levels === 1) {
        location = 'album';
        callback(false, { action: 'list', list: { level: 1, count: 1 } });
        return;
      }
      if (options.item_key === 'track:fresh') {
        location = 'track-actions';
        callback(false, { action: 'list', list: { level: 2, count: 3 } });
        return;
      }
      if (options.item_key === 'action:play' || options.item_key === 'action:queue') {
        callback(false, { action: 'none' });
        return;
      }
      callback('unexpected browse', undefined);
    },
    load(options, callback) {
      calls.push({ operation: 'load', options });
      if (location === 'root') {
        callback(false, {
          offset: options.offset,
          items: [{ title: 'Album', item_key: 'album:1', hint: 'list' }],
        });
        return;
      }
      if (location === 'album') {
        albumLoads += 1;
        callback(false, {
          offset: options.offset,
          items: [{
            title: 'Private Track',
            subtitle: 'Private Artist',
            item_key: albumLoads === 1 ? 'track:old' : 'track:fresh',
            hint: 'action_list',
            duration: 243,
          }],
        });
        return;
      }
      callback(false, {
        offset: options.offset,
        items: [
          { title: 'Delete from Library', item_key: 'action:delete', hint: 'action' },
          { title: 'Play Now', item_key: 'action:play', hint: 'action' },
          { title: 'Add Next', item_key: 'action:queue', hint: 'action' },
        ],
      });
    },
  };
  const service = createRoonLibraryService({
    browse,
    image: { get_image: () => undefined },
  });
  const albums = await service.browseAlbums({ offset: 0, limit: 20 });
  const album = albums.items[0];
  assert.ok(album);
  const tracks = await service.browseAlbum(album, { offset: 0, limit: 20 });
  const track = tracks.items[0];
  assert.ok(track);

  await service.playTrack(track, 'zone:1');
  await service.queueTrack(track, 'zone:1');

  const sessionKeys = calls
    .map((call) => call.options.multi_session_key)
    .filter((value): value is string => typeof value === 'string');
  assert.equal(new Set(sessionKeys).size, 1);
  assert.equal(calls.some((call) => call.options.item_key === 'track:old'), false);
  assert.equal(calls.filter((call) => call.options.item_key === 'track:fresh').length, 2);
  assert.deepEqual(
    calls
      .filter((call) => call.options.item_key === 'action:play' || call.options.item_key === 'action:queue')
      .map((call) => ({ itemKey: call.options.item_key, zone: call.options.zone_or_output_id })),
    [
      { itemKey: 'action:play', zone: 'zone:1' },
      { itemKey: 'action:queue', zone: 'zone:1' },
    ],
  );
});
