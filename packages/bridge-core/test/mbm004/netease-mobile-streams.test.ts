import assert from 'node:assert/strict';
import test from 'node:test';
import { NeteaseClient } from '../../src/netease/client.js';
import type { NeteaseMobileReadRequest, QualityLevel } from '../../src/netease/types.js';
import { BridgeError } from '../../src/shared/errors.js';

const signal = () => new AbortController().signal;
const plain = (value: unknown): unknown => JSON.parse(JSON.stringify(value));
const denied = (error: unknown): boolean => error instanceof BridgeError && error.code === 'NETEASE_REQUEST_FAILED';
const cancelled = (error: unknown): boolean => error instanceof BridgeError && error.code === 'READ_CANCELLED';
const media = (id = 701) => ({ id, code: 200, freeTrialInfo: null, md5: 'a'.repeat(32), size: 4096,
  expi: 60, url: 'https://music-source.invalid/private-audio.flac', level: 'hires', type: 'flac', br: 1500000 });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
function clientFor(method: (params: Record<string, unknown>) => unknown, prepare = async () => undefined) {
  const unexpected = async (): Promise<never> => { throw new Error('夹具不得调用未声明能力。'); };
  return new NeteaseClient('synthetic-mobile-batch-credential', { song_url_v1: method, playlist_detail: method, user_playlist: method,
    song_detail: unexpected, login_qr_key: unexpected, login_qr_create: unexpected, login_qr_check: unexpected,
    login_status: unexpected, logout: unexpected } as NonNullable<ConstructorParameters<typeof NeteaseClient>[1]>, prepare);
}
async function read(client: NeteaseClient, request: unknown) {
  try { return await client.mobileRead(request as NeteaseMobileReadRequest, { signal: signal(), timeoutMs: 10000 }); }
  finally { await client.awaitMobileQuiet(); }
}

test('批量取流只调用一次 SDK，1 至 100 个有序 ID 与四种音质按原参数传递，单曲参数不变', async () => {
  const calls: Record<string, unknown>[] = [], client = clientFor(params => { calls.push(params); return { code: 200, data: [media()] }; });
  for (const quality of ['standard', 'exhigh', 'lossless', 'hires'] satisfies QualityLevel[]) {
    for (const count of [1, 100]) {
      const ids = Array.from({ length: count }, (_, i) => String(900 - i));
      const before = calls.length; await read(client, { operation: 'streams', ids, quality });
      assert.equal(calls.length, before + 1); assert.equal(calls.at(-1)!.id, ids.join(','));
      assert.equal(calls.at(-1)!.level, quality); assert.ok(Number(calls.at(-1)!.timeout) > 0 && Number(calls.at(-1)!.timeout) <= 10000);
      assert.equal(Object.hasOwn(calls.at(-1)!, 'ids'), false);
    }
  }
  await read(client, { operation: 'stream', id: '701', quality: 'hires' });
  assert.equal(calls.at(-1)!.id, '701'); assert.equal(calls.at(-1)!.level, 'hires');
});

test('批量请求空集、超过上限、重复或非法 ID、非法音质及额外字段均在 SDK 前拒绝，访问器不执行', async () => {
  let calls = 0, getters = 0;
  const client = clientFor(() => { calls++; return { code: 200, data: [media()] }; });
  const invalid: unknown[] = [[], Array.from({ length: 101 }, (_, i) => String(i + 1)), ['701', '701'],
    ['0'], ['01'], ['1\n'], ['-1'], ['1'.repeat(33)], [701], ['701', null]]
    .map(ids => ({ operation: 'streams', ids, quality: 'hires' }));
  invalid.push({ operation: 'streams', ids: ['701'], quality: 'unknown' },
    { operation: 'streams', ids: ['701'], quality: 'hires', url: 'https://sensitive.invalid/' },
    { operation: 'stream', id: ['701'], quality: 'hires' });
  const accessor = { operation: 'streams', quality: 'hires' };
  Object.defineProperty(accessor, 'ids', { enumerable: true, get() { getters++; throw new Error('不应执行'); } });
  invalid.push(accessor, new Proxy({ operation: 'streams', ids: ['701'], quality: 'hires' }, { ownKeys() { throw new Error('受控代理拒绝'); } }));
  for (const request of invalid) await assert.rejects(read(client, request), denied);
  assert.equal(calls, 0); assert.equal(getters, 0);
});

test('批量响应沿用单曲投影与 100 行预算，不求值私有扩展，SDK 包装和裸响应等价', async () => {
  let wrapped = false, getters = 0;
  const rows = Array.from({ length: 100 }, (_, i) => media(701 + i));
  for (const row of rows) Object.defineProperty(row, 'privateExtension', { enumerable: true, get() { getters++; throw new Error('不应读取'); } });
  const client = clientFor(() => wrapped ? { body: { code: 200, data: rows }, cookie: ['合成私有包装'] } : { code: 200, data: rows });
  const single = await read(client, { operation: 'stream', id: '701', quality: 'hires' }); wrapped = true;
  const batch = await read(client, { operation: 'streams', ids: ['701'], quality: 'hires' });
  assert.deepEqual(batch, single); assert.deepEqual(plain((batch.response as { data: unknown[] }).data), rows.map((_, i) => media(701 + i)));
  assert.equal(getters, 0); assert.doesNotMatch(JSON.stringify(batch), /synthetic-mobile-batch-credential|合成私有包装|privateExtension/u);
});

test('批量和单曲均拒绝 101 行、非安全 size 和实际字段访问器，不扩大旧响应资格', async () => {
  let packet: unknown;
  const client = clientFor(() => packet);
  for (const operation of ['stream', 'streams'] as const) {
    const request = operation === 'stream' ? { operation, id: '701', quality: 'hires' } : { operation, ids: ['701'], quality: 'hires' };
    for (const data of [Array.from({ length: 101 }, () => media()), [{ ...media(), size: Number.MAX_SAFE_INTEGER + 1 }]]) {
      packet = { code: 200, data }; await assert.rejects(read(client, request), denied);
    }
    const row = media(); Object.defineProperty(row, 'md5', { enumerable: true, get() { throw new Error('实际字段访问器不得执行'); } });
    packet = { code: 200, data: [row] }; await assert.rejects(read(client, request), denied);
  }
});

test('批量取流准备阶段取消不会进入 SDK，也不接纳迟到准备结果', async () => {
  const gate = deferred<void>(), started = deferred<void>(); let calls = 0;
  const client = clientFor(() => { calls++; return { code: 200, data: [media()] }; }, async () => { started.resolve(); await gate.promise; });
  const controller = new AbortController(), work = client.mobileRead({ operation: 'streams', ids: ['701'], quality: 'hires' }, { signal: controller.signal });
  const refusal = assert.rejects(work, cancelled); await started.promise; controller.abort(); await refusal; gate.resolve();
  await client.awaitMobileQuiet(); assert.equal(calls, 0);
});

test('批量取流在途取消或身份改变立即拒绝，但真实 SDK Promise 落定前不宣称 quiet', async () => {
  for (const mode of ['cancel', 'identity'] as const) {
    const started = deferred<void>(), gate = deferred<unknown>();
    const client = clientFor(() => { started.resolve(); return gate.promise; });
    const controller = new AbortController(), work = client.mobileRead({ operation: 'streams', ids: ['701'], quality: 'hires' }, { signal: controller.signal });
    const refusal = assert.rejects(work, cancelled); await started.promise;
    if (mode === 'cancel') controller.abort(); else client.setCredential('synthetic-next-batch-credential');
    await refusal; let quiet = false; const wait = client.awaitMobileQuiet().then(() => { quiet = true; });
    await Promise.resolve(); assert.equal(quiet, false); gate.resolve({ code: 200, data: [media()] }); await wait; assert.equal(quiet, true);
  }
});

test('批量 SDK 超时仍等待底层落定，不返回迟到响应或提前 quiet', async () => {
  const started = deferred<void>(), gate = deferred<unknown>(), client = clientFor(() => { started.resolve(); return gate.promise; });
  const work = client.mobileRead({ operation: 'streams', ids: ['701'], quality: 'hires' }, { signal: signal(), timeoutMs: 20 });
  const refusal = assert.rejects(work, denied); await started.promise; await refusal;
  let quiet = false; const wait = client.awaitMobileQuiet().then(() => { quiet = true; }); await Promise.resolve(); assert.equal(quiet, false);
  gate.resolve({ code: 200, data: [media()] }); await wait; assert.equal(quiet, true);
});

test('歌单缺失 trackIds 保留为缺失供实际端口拒绝，不补空列表；显式非数组仍拒绝', async () => {
  let packet: unknown = { code: 200, playlist: { id: 701, name: '合成歌单', trackCount: 1 } };
  const client = clientFor(() => packet), request = { operation: 'playlist-detail', id: '701' } as const;
  const result = (await read(client, request)).response as { playlist: Record<string, unknown> };
  assert.equal(Object.hasOwn(result.playlist, 'trackIds'), false);
  packet = { code: 200, playlist: { id: 701, trackIds: null } }; await assert.rejects(read(client, request), denied);
  packet = { code: 200, playlist: { id: 701, trackIds: [] } };
  assert.deepEqual(plain(((await read(client, request)).response as { playlist: unknown }).playlist), { id: 701, trackIds: [] });
});

test('用户歌单仅新增保留顶层 userId，缺失不补值，不安全数字或访问器仍严格拒绝', async () => {
  let row: Record<string, unknown> = { id: 701, specialType: 5, userId: 700, creator: { userId: 700 } };
  const client = clientFor(() => ({ code: 200, more: false, playlist: [row] }));
  const request = { operation: 'user-playlists', userId: '700', offset: 0, limit: 100 } as const;
  assert.deepEqual(plain(((await read(client, request)).response as { playlist: unknown[] }).playlist), [row]);
  row = { id: 701, specialType: '5', userId: '700' };
  assert.deepEqual(plain(((await read(client, request)).response as { playlist: unknown[] }).playlist), [row]);
  row = { id: 701, specialType: 5 };
  const missing = ((await read(client, request)).response as { playlist: Record<string, unknown>[] }).playlist[0]!;
  assert.equal(Object.hasOwn(missing, 'userId'), false);
  row = { id: 701, userId: Number.MAX_SAFE_INTEGER + 1 }; await assert.rejects(read(client, request), denied);
  let getters = 0; row = { id: 701 };
  Object.defineProperty(row, 'userId', { enumerable: true, get() { getters++; throw new Error('归属访问器不应执行'); } });
  await assert.rejects(read(client, request), denied); assert.equal(getters, 0);
});
