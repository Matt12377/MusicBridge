import assert from 'node:assert/strict';
import test from 'node:test';
import type { IpcRequest } from '@music-bridge/contracts';
import { LibraryReadRegistry } from '../src/shared/library-read-registry.js';
import { createRoonLibraryService } from '../src/roon/library.js';

const turn = () => new Promise<void>(resolve => setImmediate(resolve));
const request = (id: string): IpcRequest => ({ version: 1, id, command: 'roon.library.albums', payload: { page: { offset: 0, limit: 24 } }, readContext: { deadlineAtMs: Date.now() + 1000 } });
type Event = Record<string, unknown> & { stage: string };
function harness(hint: unknown = 'list', hold = false) {
  const events: Event[] = [];
  let scope = JSON.stringify([false, 0, 'private-read-scope', 'private-zone']);
  let callback!: (error: string | false, body: unknown) => void;
  const service = createRoonLibraryService({ browse: {
    browse(_options, reply) { if (hold) callback = reply; else reply(false, { action: 'list', list: { level: 0, count: 1 } }); },
    load(options, reply) { reply(false, { offset: options.offset, items: [{ title: '不应进入日志的专辑名', item_key: 'private-item-key', hint, subtitle: 'private-subtitle', image_key: 'private-image-key' }] }); },
  }, image: { get_image() {} } });
  const registry = new LibraryReadRegistry(() => scope, Date.now, 64, 256, event => events.push(event));
  return { events, registry, read: (id: string) => registry.read(request(id), () => service.browseAlbums({ offset: 0, limit: 24 })),
    changeScope: () => { scope = JSON.stringify([false, 1, 'next-private-scope', 'private-zone']); },
    reply: () => callback(false, { action: 'list', list: { level: 0, count: 1 } }), };
}

test('逐请求诊断：成功贯穿 registry、SDK 与映射，最后订阅释放不冒充失败取消', async () => {
  const h = harness(); const result = await h.read('successful-read'); await turn();
  assert.equal((result as { items: unknown[] }).items.length, 1);
  for (const stage of ['core.receive', 'core.flight.start', 'sdk.dispatch', 'sdk.callback', 'core.map', 'core.finish', 'core.flight.close']) assert.ok(h.events.some(event => event.stage === stage), stage);
  assert.equal(h.events.filter(event => event.stage === 'core.finish').length, 1);
  assert.equal(h.events.find(event => event.stage === 'core.finish')?.outcome, 'ok');
  assert.equal(h.events.find(event => event.stage === 'core.flight.close')?.reason, 'last-subscriber-release');
  assert.equal(h.events.filter(event => event.outcome === 'cancelled').length, 0);
});

test('逐请求诊断：明确取消有来源与终态，迟到 SDK 成功不能再出现第二个读取终态', async () => {
  const h = harness('list', true); const waiting = h.read('cancelled-read');
  const rejected = assert.rejects(waiting, error => (error as { code?: string }).code === 'READ_CANCELLED'); await turn();
  h.registry.cancel('cancelled-read', 'main-cancel'); await rejected; h.reply(); await turn();
  const finished = h.events.filter(event => event.stage === 'core.finish');
  assert.equal(finished.length, 1); assert.equal(finished[0]?.outcome, 'cancelled'); assert.equal(finished[0]?.reason, 'main-cancel');
  assert.ok(h.events.some(event => event.stage === 'sdk.callback' && event.late === true));
});

test('逐请求诊断：scope 变化只输出原因布尔量，不能输出原 scope 或 Zone', async () => {
  const h = harness('list', true); const waiting = h.read('scope-read');
  const rejected = assert.rejects(waiting, error => (error as { code?: string }).code === 'READ_CANCELLED'); await turn(); h.changeScope(); h.reply(); await rejected; await turn();
  assert.ok(h.events.some(event => event.stage === 'core.scope' && event.scopeChanged === true && event.serviceChanged === true && event.readScopeChanged === true));
  assert.equal(h.events.find(event => event.stage === 'core.finish')?.reason, 'scope-changed');
  assert.doesNotMatch(JSON.stringify(h.events), /private-read-scope|next-private-scope|private-zone/u);
});

test('逐请求诊断：raw 非空但 hint 被过滤保留真实计数，不记录媒体或 SDK 身份', async () => {
  const h = harness(null); const result = await h.read('filtered-read'); await turn();
  assert.equal((result as { items: unknown[]; total: number }).items.length, 0); assert.equal((result as { total: number }).total, 1);
  assert.ok(h.events.some(event => event.stage === 'core.map' && event.rawCount === 1 && event.mappedCount === 0 && event.total === 1));
  const callback = h.events.find(event => event.stage === 'sdk.callback' && event.operation === 'load');
  assert.equal(callback?.itemCount, 1); assert.equal(callback?.itemKeyCount, 1);
  assert.doesNotMatch(JSON.stringify(h.events), /不应进入日志|private-item-key|private-subtitle|private-image-key|multi_session_key|item_key/u);
});
