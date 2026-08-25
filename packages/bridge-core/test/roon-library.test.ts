import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createRoonLibraryService,
  type RoonBrowseApi,
  type RoonImageApi,
} from '../src/roon/library.js';
import { RoonActionBlockedError } from '../src/roon/action-policy.js';

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
  assert.deepEqual(page, {
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
});

test('RoonLibraryService 只通过受控 item_key 进入 Album，未知 hint 不会被猜测执行', async () => {
  const calls: Array<Record<string, unknown>> = [];
  const browse: RoonBrowseApi = {
    browse(options, callback) {
      calls.push(options);
      callback(false, {
        action: 'list',
        list: { level: 1, count: 1, title: 'Tracks' },
      });
    },
    load(options, callback) {
      callback(false, {
        offset: options.offset,
        items: [{
          title: 'Private Track',
          item_key: 'track:1',
          hint: 'list',
          duration: 243,
        }],
      });
    },
  };
  const service = createRoonLibraryService({
    browse,
    image: { get_image: () => undefined },
  });

  const page = await service.browseAlbum({
    kind: 'album',
    title: 'Private Album',
    itemKey: 'album:1',
    hint: 'list',
  }, { offset: 0, limit: 100 });

  assert.deepEqual(calls[0], {
    hierarchy: 'albums',
    multi_session_key: calls[0]?.multi_session_key,
    item_key: 'album:1',
  });
  assert.equal(typeof calls[0]?.multi_session_key, 'string');
  assert.deepEqual(page.items, [{
    kind: 'track',
    hierarchy: 'albums',
    title: 'Private Track',
    itemKey: 'track:1',
    hint: 'list',
    durationSeconds: 243,
  }]);
});

test('RoonLibraryService Image seam 只接受显式 key 和受限尺寸格式', async () => {
  const calls: Array<{ imageKey: string; options: Record<string, unknown> }> = [];
  const image: RoonImageApi = {
    get_image(imageKey, options, callback) {
      calls.push({ imageKey, options });
      callback(false, 'image/png', Buffer.from('png'));
    },
  };
  const service = createRoonLibraryService({
    browse: {
      browse: () => undefined,
      load: () => undefined,
    },
    image,
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
  assert.deepEqual(result.body, Buffer.from('png'));
});

test('RoonLibraryService 拒绝非图片 content type 和超过 4 MiB 的图片响应', async () => {
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
  let browseIndex = 0;
  let loadIndex = 0;
  const service = createRoonLibraryService({
    browse: {
      browse(options, callback) {
        browseCalls.push(options);
        callback(false, browseIndex++ === 0
          ? { action: 'list', list: { level: 0, count: 1 } }
          : { action: 'list', list: { level: 1, count: 1 } });
      },
      load(_options, callback) {
        callback(false, loadIndex++ === 0
          ? {
              offset: 0,
              items: [{
                title: 'Search',
                item_key: 'search:prompt',
                input_prompt: { prompt: 'Search' },
              }],
            }
          : {
              offset: 0,
              items: [{ title: 'Result', item_key: 'track:result', hint: 'list' }],
            });
      },
    },
    image: { get_image: () => undefined },
  });

  const page = await service.searchLibrary('  Beatles  ', { offset: 0, limit: 20 });

  assert.equal(page.items[0]?.title, 'Result');
  assert.deepEqual(browseCalls[1], {
    hierarchy: 'search',
    multi_session_key: browseCalls[0]?.multi_session_key,
    item_key: 'search:prompt',
    input: 'Beatles',
  });
});

test('RoonLibraryService 为并发 Browse 操作分配彼此隔离的 session', async () => {
  const sessionKeys: string[] = [];
  const service = createRoonLibraryService({
    browse: {
      browse(options, callback) {
        sessionKeys.push(String(options.multi_session_key));
        callback(false, { action: 'list', list: { level: 0, count: 0 } });
      },
      load(options, callback) {
        callback(false, { offset: options.offset, items: [] });
      },
    },
    image: { get_image: () => undefined },
  });

  await Promise.all([
    service.browseAlbums({ offset: 0, limit: 20 }),
    service.browseAlbums({ offset: 0, limit: 20 }),
  ]);

  assert.equal(sessionKeys.length, 2);
  assert.notEqual(sessionKeys[0], sessionKeys[1]);
});

test('RoonLibraryService keeps the originating hierarchy through artist album drill-down', async () => {
  const browseCalls: Array<Record<string, unknown>> = [];
  const service = createRoonLibraryService({
    browse: {
      browse(options, callback) {
        browseCalls.push(options);
        callback(false, { action: 'list', list: { level: 1, count: 0 } });
      },
      load(options, callback) {
        callback(false, { offset: options.offset, items: [] });
      },
    },
    image: { get_image: () => undefined },
  });

  await service.browseAlbum({
    kind: 'album',
    title: 'Artist Album',
    itemKey: 'artist-album:1',
    hint: 'list',
    hierarchy: 'artists',
  }, { offset: 0, limit: 20 });

  assert.equal(browseCalls[0]?.hierarchy, 'artists');
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
  const calls: Array<Record<string, unknown>> = [];
  const browse: RoonBrowseApi = {
    browse(options, callback) {
      calls.push(options);
      if (calls.length === 1) {
        callback(false, { action: 'list', list: { level: 2, count: 3 } });
        return;
      }
      callback(false, { action: 'none' });
    },
    load(options, callback) {
      calls.push(options);
      callback(false, {
        offset: 0,
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
  const track = { kind: 'track' as const, title: 'Private Track', itemKey: 'track:1', hint: 'list' };

  await service.playTrack(track, 'zone:1');
  assert.deepEqual(calls, [
    {
      hierarchy: 'albums',
      multi_session_key: calls[0]?.multi_session_key,
      item_key: 'track:1',
    },
    {
      hierarchy: 'albums',
      multi_session_key: calls[0]?.multi_session_key,
      level: 2,
      offset: 0,
      count: 32,
    },
    {
      hierarchy: 'albums',
      multi_session_key: calls[0]?.multi_session_key,
      item_key: 'action:play',
      zone_or_output_id: 'zone:1',
    },
  ]);

  calls.length = 0;
  await service.queueTrack(track, 'zone:1');
  assert.equal(calls[2]?.item_key, 'action:queue');
  assert.equal(calls[2]?.zone_or_output_id, 'zone:1');
});
