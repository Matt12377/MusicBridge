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
