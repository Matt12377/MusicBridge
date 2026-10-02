import assert from 'node:assert/strict'
import test from 'node:test'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'

import { NeteaseClient } from '../src/netease/client.js'
import type { NeteaseRequestOptions } from '../src/netease/types.js'

test('NeteaseClient adapts QR login API responses and verifies before configuring', async () => {
  const calls: string[] = []
  const api = {
    async song_detail() {
      return { body: { code: 200 } }
    },
    async song_url_v1() {
      return { body: { code: 200 } }
    },
    async login_qr_key() {
      calls.push('key')
      return { body: { code: 200, data: { unikey: 'synthetic-qr-key' } } }
    },
    async login_qr_create() {
      calls.push('create')
      return {
        body: {
          code: 200,
          data: { qrimg: 'data:image/png;base64,synthetic-qr' },
        },
      }
    },
    async login_qr_check() {
      calls.push('check')
      return { body: { code: 803, cookie: 'synthetic-credential' } }
    },
    async login_status(params: Record<string, unknown>) {
      assert.equal(params.cookie, 'synthetic-credential')
      calls.push('status')
      return {
        body: {
          data: {
            code: 200,
            profile: { userId: 1 },
            account: { id: 1 },
          },
        },
      }
    },
    async logout(params: Record<string, unknown>) {
      assert.equal(params.cookie, 'synthetic-credential')
      calls.push('logout')
      return { body: { code: 200 } }
    },
  }

  const client = new NeteaseClient(undefined, api)
  assert.equal(client.configured, false)
  assert.deepEqual(await client.createQr(), {
    key: 'synthetic-qr-key',
    qrImage: 'data:image/png;base64,synthetic-qr',
  })
  assert.deepEqual(await client.checkQr('synthetic-qr-key'), {
    code: 803,
    credential: 'synthetic-credential',
  })
  assert.equal(await client.verifyCredential('synthetic-credential'), true)

  client.setCredential('synthetic-credential')
  assert.equal(client.configured, true)
  await client.logout()
  assert.equal(client.configured, false)
  assert.deepEqual(calls, ['key', 'create', 'check', 'status', 'logout'])
})

test('NeteaseClient clears the local session when remote logout fails', async () => {
  const api = {
    async song_detail() {
      return { body: { code: 200 } }
    },
    async song_url_v1() {
      return { body: { code: 200 } }
    },
    async login_qr_key() {
      return { body: { code: 200, data: { unikey: 'synthetic-qr-key' } } }
    },
    async login_qr_create() {
      return {
        body: {
          code: 200,
          data: { qrimg: 'data:image/png;base64,synthetic-qr' },
        },
      }
    },
    async login_qr_check() {
      return { body: { code: 801 } }
    },
    async login_status() {
      return { body: { code: 200, data: { profile: { userId: 1 } } } }
    },
    async logout() {
      throw new Error('synthetic remote logout failure')
    },
  }

  const client = new NeteaseClient('synthetic-credential', api)
  await assert.rejects(() => client.logout())
  assert.equal(client.configured, false)
})

test('NeteaseClient prepares the API runtime before resolving an audio URL', async () => {
  const events: string[] = []
  const api = {
    async song_detail() {
      return { body: { code: 200 } }
    },
    async song_url_v1(params: Record<string, unknown>) {
      events.push(`song_url:${String(params.level)}`)
      return {
        body: {
          code: 200,
          data: [{ id: 303, url: 'https://audio.example.invalid/synthetic.flac', level: 'lossless' }],
        },
      }
    },
    async login_qr_key() {
      return { body: { code: 200, data: { unikey: 'synthetic-qr-key' } } }
    },
    async login_qr_create() {
      return { body: { code: 200, data: { qrimg: 'data:image/png;base64,synthetic-qr' } } }
    },
    async login_qr_check() {
      return { body: { code: 801 } }
    },
    async login_status() {
      return { body: { code: 200, data: { profile: { userId: 1 } } } }
    },
    async logout() {
      return { body: { code: 200 } }
    },
  }

  const client = new NeteaseClient('synthetic-credential', api, async () => {
    events.push('prepare')
  })

  const stream = await client.resolveStream('303', 'lossless')

  assert.equal(stream.upstreamUrl, 'https://audio.example.invalid/synthetic.flac')
  assert.deepEqual(events, ['prepare', 'song_url:lossless'])
})

test('NeteaseClient distinguishes authorized, expired and unavailable credential checks', async () => {
  let mode: 'authorized' | 'expired' | 'unavailable' = 'authorized'
  const api = {
    async song_detail() { return { body: { code: 200 } } },
    async song_url_v1() { return { body: { code: 200 } } },
    async login_qr_key() { return { body: { code: 200, data: { unikey: 'synthetic-key' } } } },
    async login_qr_create() { return { body: { code: 200, data: { qrimg: 'data:image/png;base64,synthetic' } } } },
    async login_qr_check() { return { body: { code: 801 } } },
    async login_status() {
      if (mode === 'unavailable') throw new Error('synthetic network timeout')
      if (mode === 'expired') return { body: { code: 301 } }
      return { body: { data: { code: 200, profile: { userId: 1 } } } }
    },
    async logout() { return { body: { code: 200 } } },
  }
  const client = new NeteaseClient(undefined, api)

  assert.equal(await client.verifyCredentialStatus('fixture-credential'), 'authorized')
  mode = 'expired'
  assert.equal(await client.verifyCredentialStatus('fixture-credential'), 'expired')
  mode = 'unavailable'
  assert.equal(await client.verifyCredentialStatus('fixture-credential'), 'unavailable')
})

test('MBP-002：网易云账户换代拒绝旧搜索并阻止旧元数据缓存写回', async () => {
  let finish!: (value: unknown) => void; let details = 0;
  const api = { search: async () => await new Promise(resolve => { finish = resolve; }),
    song_detail: async () => { details++; return { body: { code: 200, songs: [{ id: 1, name: '新账户数据', ar: [{ name: '艺人' }], al: { name: '专辑' }, dt: 60000 }] } }; },
  } as unknown as NonNullable<ConstructorParameters<typeof NeteaseClient>[1]>;
  const client = new NeteaseClient('synthetic-A', api); const old = client.searchTracks('query', { offset: 0, limit: 24 });
  const rejected = assert.rejects(old, { code: 'READ_CANCELLED' }); await new Promise(resolve => setImmediate(resolve));
  client.setCredential('synthetic-B'); finish({ body: { code: 200, result: { songCount: 1, songs: [{ id: 1, name: '旧账户数据', artists: [{ name: '艺人' }], album: { name: '专辑' } }] } } });
  await rejected; assert.equal((await client.getTrack('1')).title, '新账户数据'); assert.equal(details, 1);
});

const nextRequestTurn = () => new Promise<void>(resolve => setImmediate(resolve));
function requestSong(id: string, title = `歌曲${id}`) {
  return { body: { code: 200, songs: [{ id: Number(id), name: title, ar: [{ name: '艺人' }], al: { name: '专辑' }, dt: 60000 }] } };
}
function requestFixture(options: ConstructorParameters<typeof NeteaseClient>[3] = {}) {
  const calls: Array<{ id: string; params: Record<string, unknown>; finish(value?: unknown): void }> = [];
  let held = true;
  const api = { song_detail: (params: Record<string, unknown>) => {
    const id = String(params.ids);
    if (!held) { calls.push({ id, params, finish: () => undefined }); return Promise.resolve(requestSong(id)); }
    return new Promise(resolve => calls.push({ id, params, finish: (value = requestSong(id)) => resolve(value) }));
  } } as unknown as NonNullable<ConstructorParameters<typeof NeteaseClient>[1]>;
  const client = new NeteaseClient('synthetic-request-A', api, undefined, options);
  return { client, calls, finishAll: () => { held = false; for (const call of calls) call.finish(); } };
}
const isRequestReason = (error: unknown, reason: string): boolean => {
  const value = error as { code?: string; details?: { reason?: string } };
  return value.code === 'NETEASE_REQUEST_FAILED' && value.details?.reason === reason;
};

test('网易云请求：20项后台补全有界并为当前播放留出物理容量', async () => {
  const h = requestFixture();
  const background = Array.from({ length: 20 }, (_, i) => h.client.getTrack(String(i + 1), { priority: 'background' }));
  const ended = Promise.allSettled(background);
  let playback: Promise<unknown> | undefined;
  try {
    await nextRequestTurn(); assert.equal(h.calls.length, 2);
    playback = h.client.getTrack('999', { priority: 'playback' });
    const played = Promise.allSettled([playback]);
    await nextRequestTurn(); assert.deepEqual(h.calls.map(call => call.id), ['1', '2', '999']);
    h.calls[2]!.finish(); assert.equal((await playback as { id: string }).id, '999'); await played;
  } finally { h.finishAll(); await ended; await playback?.catch(() => undefined); }
});

test('网易云请求：9次快切取消等待但不假释放物理槽位，最新意图排队后继续', async () => {
  const h = requestFixture(), cancelled: string[] = [];
  const controllers = Array.from({ length: 8 }, () => new AbortController());
  const previous = controllers.map((controller, i) => h.client.getTrack(String(i + 1), { signal: controller.signal, priority: 'playback' }).catch(error => { cancelled.push(error.code); throw error; }));
  const ended = Promise.allSettled(previous);
  let latest: Promise<unknown> | undefined;
  try {
    await nextRequestTurn(); assert.equal(h.calls.length, 8);
    controllers.forEach(controller => controller.abort()); await nextRequestTurn();
    assert.deepEqual(cancelled, Array.from({ length: 8 }, () => 'READ_CANCELLED'));
    latest = h.client.getTrack('9', { priority: 'playback' }); const result = Promise.allSettled([latest]);
    await nextRequestTurn(); assert.equal(h.calls.length, 8);
    h.calls[0]!.finish(); await nextRequestTurn(); assert.equal(h.calls.length, 9); assert.equal(h.calls[8]!.id, '9');
    h.calls[8]!.finish(); assert.equal((await latest as { id: string }).id, '9'); await result;
  } finally { h.finishAll(); await ended; await latest?.catch(() => undefined); }
});

test('网易云请求：旧物理请求到期释放后，最新播放仍获得完整请求期限', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
  const calls: Array<{ id: string; timeout: unknown }> = [];
  const api = { song_detail: (params: Record<string, unknown>) => {
    const id = String(params.ids); calls.push({ id, timeout: params.timeout });
    return new Promise(resolve => setTimeout(() => resolve(requestSong(id)), id === '9' ? 20 : Number(params.timeout)));
  } } as unknown as NonNullable<ConstructorParameters<typeof NeteaseClient>[1]>;
  const client = new NeteaseClient('synthetic-request', api, undefined, { requestTimeoutMs: 50 });
  const controllers = Array.from({ length: 8 }, () => new AbortController());
  const old = controllers.map((controller, i) => client.getTrack(String(i + 1), { priority: 'playback', signal: controller.signal }));
  const oldEnd = Promise.allSettled(old); await nextRequestTurn(); assert.equal(calls.length, 8);
  controllers.forEach(controller => controller.abort()); await oldEnd; t.mock.timers.tick(5);
  const fresh = client.getTrack('9', { priority: 'playback' }).catch(error => error);
  try {
    await nextRequestTurn(); assert.equal(calls.length, 8);
    t.mock.timers.tick(45); await nextRequestTurn(); assert.equal(calls.length, 9); assert.equal(calls[8]!.timeout, 50);
    t.mock.timers.tick(20); await nextRequestTurn(); assert.equal((await fresh).id, '9');
  } finally { t.mock.timers.tick(100); await nextRequestTurn(); await fresh; }
});

test('网易云请求：取消中的旧元数据回包不能污染后来的缓存', async () => {
  const h = requestFixture(), controller = new AbortController();
  const old = h.client.getTrack('1', { signal: controller.signal }).catch(error => error);
  let fresh: Promise<unknown> | undefined;
  try {
    await nextRequestTurn(); controller.abort(); await nextRequestTurn();
    fresh = h.client.getTrack('1'); await nextRequestTurn();
    assert.equal(h.calls.length, 2); h.calls[1]!.finish(requestSong('1', '新意图'));
    assert.equal((await fresh as { title: string }).title, '新意图');
    h.calls[0]!.finish(requestSong('1', '旧意图')); assert.equal((await old).code, 'READ_CANCELLED');
    await nextRequestTurn(); assert.equal((await h.client.getTrack('1')).title, '新意图'); assert.equal(h.calls.length, 2);
  } finally { h.finishAll(); await old; await fresh?.catch(() => undefined); }
});

test('网易云请求：账户换代移除旧排队工作，旧物理请求仍占用后台额度', async () => {
  const h = requestFixture(), failures: string[] = [];
  const old = Array.from({ length: 4 }, (_, i) => h.client.getTrack(String(i + 1), { priority: 'background' }).catch(error => { failures.push(error.code); throw error; }));
  const ended = Promise.allSettled(old);
  let fresh: Promise<unknown> | undefined;
  try {
    await nextRequestTurn(); assert.equal(h.calls.length, 2); h.client.setCredential('synthetic-request-B');
    await nextRequestTurn(); assert.deepEqual(failures, Array.from({ length: 4 }, () => 'READ_CANCELLED'));
    fresh = h.client.getTrack('999', { priority: 'background' }); const result = Promise.allSettled([fresh]);
    await nextRequestTurn(); assert.equal(h.calls.length, 2);
    h.calls[0]!.finish(); await nextRequestTurn(); assert.deepEqual(h.calls.map(call => call.id), ['1', '2', '999']);
    h.calls[2]!.finish(); assert.equal((await fresh as { id: string }).id, '999'); await result;
  } finally { h.finishAll(); await ended; await fresh?.catch(() => undefined); }
});

test('网易云请求：等待队列有界、播放保留排队位置，超时不释放未结束的物理请求', async () => {
  const h = requestFixture({ requestMaximumQueued: 3, requestTimeoutMs: 40 });
  const active = ['1', '2'].map(id => h.client.getTrack(id, { priority: 'background' }));
  const ended = Promise.allSettled(active);
  let queued: Promise<unknown> | undefined, playback: Promise<unknown> | undefined, next: Promise<unknown> | undefined;
  try {
    await nextRequestTurn(); assert.equal(h.calls.length, 2);
    queued = h.client.getTrack('3', { priority: 'background' }); const queuedEnd = Promise.allSettled([queued]);
    await assert.rejects(h.client.getTrack('4', { priority: 'background' }), error => isRequestReason(error, 'request-budget'));
    playback = h.client.getTrack('999', { priority: 'playback' }); const playbackEnd = Promise.allSettled([playback]);
    await nextRequestTurn(); assert.equal(h.calls.length, 3); h.calls[2]!.finish(); await playback; await playbackEnd;
    for (const outcome of await ended) { assert.equal(outcome.status, 'rejected'); if (outcome.status === 'rejected') assert.ok(isRequestReason(outcome.reason, 'request-timeout')); }
    const [outcome] = await queuedEnd; assert.equal(outcome?.status, 'rejected'); if (outcome?.status === 'rejected') assert.ok(isRequestReason(outcome.reason, 'request-timeout'));
    next = h.client.getTrack('5', { priority: 'background' }); const nextEnd = Promise.allSettled([next]);
    await nextRequestTurn(); assert.equal(h.calls.length, 3);
    h.calls[0]!.finish(); await nextRequestTurn(); assert.equal(h.calls.length, 4); assert.equal(h.calls[3]!.id, '5');
    h.calls[3]!.finish(); await next; await nextEnd;
  } finally { h.finishAll(); await ended; await queued?.catch(() => undefined); await playback?.catch(() => undefined); await next?.catch(() => undefined); }
});

test('网易云请求：元数据与音频URL均向SDK传实际超时，取消准备不会派发音频请求', async () => {
  const calls: Array<Record<string, unknown>> = [];
  const api = {
    song_detail: async (params: Record<string, unknown>) => { calls.push(params); return requestSong(String(params.ids)); },
    song_url_v1: async (params: Record<string, unknown>) => { calls.push(params); return { body: { code: 200, data: [{ id: Number(params.id), url: 'https://audio.example.invalid/synthetic.flac', level: params.level }] } }; },
  } as unknown as NonNullable<ConstructorParameters<typeof NeteaseClient>[1]>;
  const client = new NeteaseClient('synthetic-request', api, undefined, { requestTimeoutMs: 1000 });
  await client.getTrack('1', { timeoutMs: 200 }); await client.resolveStream('1', 'lossless', { timeoutMs: 300 });
  assert.equal(calls.length, 2);
  assert.ok(typeof calls[0]!.timeout === 'number' && calls[0]!.timeout > 0 && calls[0]!.timeout <= 200);
  assert.ok(typeof calls[1]!.timeout === 'number' && calls[1]!.timeout > 0 && calls[1]!.timeout <= 300);
  assert.equal(calls[0]!.signal, undefined); assert.equal(calls[1]!.signal, undefined);
  let prepare!: () => void;
  const delayed = new NeteaseClient('synthetic-request', api, () => new Promise<void>(resolve => { prepare = resolve; }));
  const controller = new AbortController(), options: NeteaseRequestOptions = { signal: controller.signal, priority: 'playback' };
  const pending = delayed.resolveStream('2', 'lossless', options).catch(error => error);
  await nextRequestTurn(); controller.abort(); prepare(); assert.equal((await pending).code, 'READ_CANCELLED'); assert.equal(calls.length, 2);
});

test('网易云请求：取消排队条目立即移除，释放后台槽位后不派发旧意图', async () => {
  const h = requestFixture(), controller = new AbortController();
  const active = ['1', '2'].map(id => h.client.getTrack(id, { priority: 'background' }));
  const ended = Promise.allSettled(active);
  let cancelled: Promise<unknown> | undefined, fresh: Promise<unknown> | undefined;
  try {
    await nextRequestTurn();
    cancelled = h.client.getTrack('3', { priority: 'background', signal: controller.signal }).catch(error => error);
    fresh = h.client.getTrack('4', { priority: 'background' }); const result = Promise.allSettled([fresh]);
    await nextRequestTurn(); assert.equal(h.calls.length, 2); controller.abort();
    assert.equal((await cancelled as { code: string }).code, 'READ_CANCELLED');
    h.calls[0]!.finish(); await nextRequestTurn(); assert.deepEqual(h.calls.map(call => call.id), ['1', '2', '4']);
    h.calls[2]!.finish(); await fresh; await result;
  } finally { h.finishAll(); await ended; await cancelled; await fresh?.catch(() => undefined); }
});

test('网易云请求：总物理八槽满时，当前播放先于旧后台排队请求派发', async () => {
  const h = requestFixture();
  const active = [
    ...['1', '2'].map(id => h.client.getTrack(id, { priority: 'background' })),
    ...['3', '4', '5', '6', '7', '8'].map(id => h.client.getTrack(id, { priority: 'playback' })),
  ];
  const ended = Promise.allSettled(active);
  let background: Promise<unknown> | undefined, playback: Promise<unknown> | undefined;
  try {
    await nextRequestTurn(); assert.equal(h.calls.length, 8);
    background = h.client.getTrack('20', { priority: 'background' }); const backEnd = Promise.allSettled([background]);
    playback = h.client.getTrack('999', { priority: 'playback' }); const playEnd = Promise.allSettled([playback]);
    await nextRequestTurn(); assert.equal(h.calls.length, 8);
    h.calls[0]!.finish(); await nextRequestTurn(); assert.equal(h.calls[8]!.id, '999'); assert.equal(h.calls.length, 9);
    h.calls[8]!.finish(); await playback; await playEnd; await nextRequestTurn(); assert.equal(h.calls[9]!.id, '20');
    h.calls[9]!.finish(); await background; await backEnd;
  } finally { h.finishAll(); await ended; await background?.catch(() => undefined); await playback?.catch(() => undefined); }
});

test('网易云请求：歌词归入后台限额，不抢占当前播放的预留容量', async () => {
  const calls: string[] = [], replies: Array<() => void> = [];
  let held = true;
  const lyrics = { body: { code: 200, lrc: { lyric: '[00:01.00]合成歌词' } } };
  const api = {
    song_detail: async (params: Record<string, unknown>) => { calls.push(`song:${String(params.ids)}`); return requestSong(String(params.ids)); },
    lyric_new: (params: Record<string, unknown>) => {
      calls.push(`lyric:${String(params.id)}`);
      return held ? new Promise(resolve => replies.push(() => resolve(lyrics))) : Promise.resolve(lyrics);
    },
  } as unknown as NonNullable<ConstructorParameters<typeof NeteaseClient>[1]>;
  const client = new NeteaseClient('synthetic-request', api);
  const background = Array.from({ length: 9 }, (_, i) => client.getLyrics(String(i + 1))), ended = Promise.allSettled(background);
  try {
    await nextRequestTurn(); assert.deepEqual(calls, ['lyric:1', 'lyric:2']);
    assert.equal((await client.getTrack('999')).id, '999'); assert.deepEqual(calls, ['lyric:1', 'lyric:2', 'song:999']);
  } finally { held = false; replies.forEach(reply => reply()); await ended; }
});

test('网易云请求：失败原因只保留安全枚举，取消的调用不能命中缓存', async () => {
  let fail = false;
  const api = { song_detail: async (params: Record<string, unknown>) => {
    if (fail) throw { body: { msg: 'synthetic-private-cookie', signedUrl: 'https://audio.invalid/?token=synthetic-private' } };
    assert.ok(typeof params.timeout === 'number' && params.timeout <= 10000); return requestSong(String(params.ids));
  } } as unknown as NonNullable<ConstructorParameters<typeof NeteaseClient>[1]>;
  const client = new NeteaseClient('synthetic-request', api);
  await client.getTrack('1', { timeoutMs: 999999 });
  await assert.rejects(client.getTrack('1', { signal: AbortSignal.abort() }), { code: 'READ_CANCELLED' });
  fail = true;
  await assert.rejects(client.getTrack('2'), error => {
    assert.ok(isRequestReason(error, 'upstream-response'));
    assert.deepEqual((error as { details: unknown }).details, { reason: 'upstream-response' }); return true;
  });
});

test('网易云请求：准备失败单独分类，本地准备超时不冒充Provider响应失败', async () => {
  let streams = 0;
  const api = {
    song_detail: async (params: Record<string, unknown>) => requestSong(String(params.ids)),
    song_url_v1: async () => { streams++; return {}; },
  } as unknown as NonNullable<ConstructorParameters<typeof NeteaseClient>[1]>;
  const failed = new NeteaseClient('synthetic-request', api, async () => { throw new Error('synthetic-private-prepare-context'); });
  await assert.rejects(failed.resolveStream('1', 'lossless'), error => {
    assert.ok(isRequestReason(error, 'runtime-prepare'));
    assert.deepEqual((error as { details: unknown }).details, { reason: 'runtime-prepare' }); return true;
  });
  assert.equal((await failed.getTrack('1')).id, '1');
  const held = new NeteaseClient('synthetic-request', api, () => new Promise<void>(() => undefined));
  await assert.rejects(held.resolveStream('1', 'lossless', { timeoutMs: 30 }), error => isRequestReason(error, 'request-timeout'));
  assert.equal(streams, 0);
});

test('固定SDK：Owner取消仅撤等待，真实Axios到合成loopback的物理请求由timeout终止', async t => {
  const require = createRequire(import.meta.url);
  const sdk = require('@neteasecloudmusicapienhanced/api') as { song_detail(params: Record<string, unknown>): Promise<unknown> };
  let closed = false, finishClosed!: () => void;
  const physicallyClosed = new Promise<void>(resolve => { finishClosed = resolve; });
  const server = createServer((_request, response) => {
    response.socket!.once('close', () => { closed = true; finishClosed(); });
    // 故意不回响应，只观察真实SDK/Axios的超时关闭；不连接任何Provider。
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const physical: Promise<unknown>[] = [];
  const api = { song_detail: (params: Record<string, unknown>) => {
    const work = sdk.song_detail({ ...params, cookie: 'MUSIC_U=synthetic-loopback-only', domain: `http://127.0.0.1:${address.port}` });
    physical.push(work); return work;
  } } as unknown as NonNullable<ConstructorParameters<typeof NeteaseClient>[1]>;
  const client = new NeteaseClient('synthetic-loopback-only', api), controller = new AbortController();
  // SDK会输出自己的合成超时对象；本测试只保留断言结果。
  t.mock.method(console, 'log', () => undefined);
  const received = once(server, 'request', { signal: AbortSignal.timeout(2000) });
  const pending = client.getTrack('1', { signal: controller.signal, timeoutMs: 250 }).catch(error => error);
  try {
    await received; assert.equal(physical.length, 1); controller.abort();
    assert.equal((await pending).code, 'READ_CANCELLED'); await nextRequestTurn(); assert.equal(closed, false);
    await assert.rejects(physical[0]!, error => (error as { status?: number }).status === 502);
    await physicallyClosed; assert.equal(closed, true);
  } finally {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    await pending; await Promise.allSettled(physical);
  }
});
