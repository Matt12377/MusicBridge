import assert from 'node:assert/strict';
import { AsyncResource } from 'node:async_hooks';
import test from 'node:test';
import { createRoonLibraryService, type RoonBrowseApi, type RoonImageApi } from '../src/roon/library.js';
import { withLibraryRead, type LibraryReadLifetime } from '../src/shared/library-read-lifetime.js';

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
const turn = () => new Promise<void>(resolve => setImmediate(resolve));

function lifetime(controller: AbortController): LibraryReadLifetime {
  return { signal: controller.signal, deadlineAtMs: Date.now() + 10_000, now: Date.now, isCurrent: () => true };
}

/** 共享 SDK 传输资源的上下文属于先前读取，不属于后来的请求。 */
function abandonedSdkResource(): AsyncResource {
  const controller = new AbortController();
  const resource = withLibraryRead(lifetime(controller), () => new AsyncResource('合成 Roon SDK 传输'));
  controller.abort();
  return resource;
}

function fixture(operation: 'browse' | 'image', resource: AsyncResource) {
  const callbacks: Array<() => void> = [];
  const sessionKeys: unknown[] = [];
  const browse: RoonBrowseApi = {
    browse(options, callback) {
      sessionKeys.push(options.multi_session_key);
      callbacks.push(() => resource.runInAsyncScope(callback, undefined, false, { action: 'list', list: { level: 0, count: 1 } }));
    },
    load(options, callback) {
      resource.runInAsyncScope(callback, undefined, false, { offset: options.offset, items: [{ title: '合成专辑', item_key: '合成专辑引用', hint: 'list' }] });
    },
  };
  const image: RoonImageApi = {
    get_image(_key, _options, callback) {
      callbacks.push(() => resource.runInAsyncScope(callback, undefined, false, 'image/jpeg', JPEG));
    },
  };
  const service = createRoonLibraryService({ browse, image });
  return {
    sessionKeys,
    read: () => operation === 'browse' ? service.browseAlbums({ offset: 0, limit: 1 }) : service.getImage('合成图片引用'),
    release() { const callback = callbacks.shift(); assert.ok(callback, '必须已有真实派发的合成 SDK 回调'); callback(); },
  };
}

for (const operation of ['browse', 'image'] as const) {
  test(`Roon ${operation}：无关已取消上下文中的成功回调仍完成自身有效读取`, async () => {
    const resource = abandonedSdkResource();
    try {
      const f = fixture(operation, resource), controller = new AbortController();
      const result = withLibraryRead(lifetime(controller), f.read);
      const accepted = assert.doesNotReject(result);
      await turn(); f.release(); await accepted;
      assert.equal(controller.signal.aborted, false);
      const value = await result;
      assert.equal('items' in value ? value.items.length : value.body.equals(JPEG), operation === 'browse' ? 1 : true);
    } finally { resource.emitDestroy(); }
  });

  test(`Roon ${operation}：自身真实取消仍拒绝，迟到回调不恢复，后续读取可成功`, async () => {
    const resource = abandonedSdkResource();
    try {
      const f = fixture(operation, resource), controller = new AbortController();
      const old = withLibraryRead(lifetime(controller), f.read);
      const rejected = assert.rejects(old, { code: 'READ_CANCELLED' });
      await turn(); controller.abort(); await rejected;
      f.release();
      const current = withLibraryRead(lifetime(new AbortController()), f.read);
      const accepted = assert.doesNotReject(current);
      await turn(); f.release(); await accepted;
      if (operation === 'browse') assert.notEqual(f.sessionKeys[0], f.sessionKeys[1], '取消后的 SDK 会话必须隔离');
    } finally { resource.emitDestroy(); }
  });

  test(`Roon ${operation}：无读取作用域的调用不受 SDK 资源旧取消上下文污染`, async () => {
    const resource = abandonedSdkResource();
    try {
      const f = fixture(operation, resource), result = f.read();
      const accepted = assert.doesNotReject(result);
      await turn(); f.release(); await accepted;
    } finally { resource.emitDestroy(); }
  });

  test(`Roon ${operation}：成功 SDK 回调仍检查自身作用域及期限`, async () => {
    const resource = new AsyncResource('合成无读取上下文 SDK 传输');
    try {
      for (const reason of ['scope', 'deadline'] as const) {
        const f = fixture(operation, resource), read = lifetime(new AbortController());
        let current = true, now = Date.now();
        read.isCurrent = () => current; read.now = () => now;
        const result = withLibraryRead(read, f.read);
        const rejected = assert.rejects(result, { code: reason === 'scope' ? 'READ_CANCELLED' : 'READ_DEADLINE' });
        await turn();
        if (reason === 'scope') current = false;
        else now = read.deadlineAtMs;
        f.release(); await rejected;
      }
    } finally { resource.emitDestroy(); }
  });
}
