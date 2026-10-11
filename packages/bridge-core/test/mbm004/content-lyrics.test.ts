import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeMobileRequest, mobileCanonicalJson, mobileDataSnapshot } from '@music-bridge/contracts';
import type { MobileContentReadContext, MobileLyricsContent, MobileSource } from '@music-bridge/contracts';
import { createMobileContentLyricsPort } from '../../src/mobile/content-lyrics.js';
import { captureMobileContentReply } from '../../src/mobile/content-protocol.js';
import type { MobileContentOperation, MobileContentPort, MobileContentScope, MobileContentServiceInput } from '../../src/mobile/content-types.js';
import { MobileServiceError } from '../../src/mobile/types.js';

const SCOPE: Readonly<MobileContentScope> = { serverId: 'server.lyrics', datasetId: 'dataset.lyrics', deviceId: 'device.lyrics',
  deviceEpoch: 1, accessGeneration: 1, ownerEpoch: 'owner.lyrics', accountDomain: 'account.lyrics', providerEpoch: 'provider.lyrics' };
const ORIGIN = 'https://127.0.0.1:9443';
function fixture(source: MobileSource, status: 'ready' | 'missing' | 'instrumental' = 'ready') {
  const selection = { trackId: `${source}:track.1`, source, versionId: `${source}:version.1`, contentRevision: 'content.1' };
  const path = `/mobile/v1/ui/tracks/${encodeURIComponent(selection.trackId)}/lyrics`;
  const request = decodeMobileRequest('getExactTrackLyrics', { method: 'GET', path, headers: [], body: new Uint8Array(),
    query: [['source', source], ['versionId', selection.versionId], ['contentRevision', selection.contentRevision]] },
  { responseOrigin: ORIGIN, requestPath: path });
  assert.ok(request.ok);
  const context: MobileContentReadContext = { serverId: SCOPE.serverId, deviceId: SCOPE.deviceId, accountDomain: SCOPE.accountDomain, source, selection };
  const body: MobileLyricsContent = status === 'ready' ? { ...selection, status, lyricRevision: 'lyrics.1', synchronized: true,
    lines: [{ id: 'line.1', text: '合成歌词第一行', secondaryText: '第一段译文', startMs: 0 },
      { id: 'line.2', text: '完整 Unicode 歌词 🎵', secondaryText: null, startMs: 1_234 }] }
    : { ...selection, status, synchronized: false, lines: [] };
  return { body, context, request: request.value,
    input: (signal = new AbortController().signal): MobileContentServiceInput<'getExactTrackLyrics'> =>
      ({ operation: 'getExactTrackLyrics', request: request.value, scope: SCOPE, signal }) };
}
function canonical(raw: unknown): string {
  const captured = mobileDataSnapshot(raw); assert.ok(captured.ok); return mobileCanonicalJson(captured.value);
}
function deferred() {
  let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve };
}
function port(source: MobileSource, bodyOverride?: unknown,
  mutate?: (context: MobileContentReadContext) => void, beforeSend = async () => undefined): MobileContentPort {
  return { async dispatch<O extends MobileContentOperation>(input: MobileContentServiceInput<O>) {
    if (input.operation !== 'getExactTrackLyrics') throw new MobileServiceError(400, 'INVALID_REQUEST');
    const data = fixture(source), context = structuredClone(data.context); mutate?.(context);
    const result = captureMobileContentReply(input.operation, input.request, input.scope,
      { status: 200, category: 'success', body: bodyOverride === undefined ? data.body : bodyOverride }, context);
    return { operation: input.operation, scope: input.scope, ...result, beforeSend };
  } };
}
function refuses(promise: Promise<unknown>, status: number, code: string) {
  return assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof MobileServiceError); assert.equal(error.status, status); assert.equal(error.code, code);
    assert.equal(error.message, '移动服务当前无法完成请求。'); return true;
  });
}

test('完整歌词按精确四元组走唯一原来源，Unicode 与同步时刻不截断或回退', async t => {
  const calls: string[] = [], sends: string[] = [];
  const counted = (source: MobileSource): MobileContentPort => ({ async dispatch<O extends MobileContentOperation>(input: MobileContentServiceInput<O>) {
    calls.push(source); assert.equal(canonical(input.request), canonical(fixture(source).request));
    const result = await port(source, undefined, undefined, async () => { sends.push(source); }).dispatch(input); return result;
  } });
  const lyrics = createMobileContentLyricsPort({ local: counted('local'), provider: counted('netease'), assertCurrent: () => undefined });
  t.after(() => lyrics.close());
  for (const source of ['local', 'netease'] as const) {
    const data = fixture(source), result = await lyrics.dispatch(data.input()); await result.beforeSend();
    assert.equal(canonical(result.reply.body), canonical(data.body)); assert.equal(canonical(result.context.selection), canonical(data.context.selection));
  }
  assert.deepEqual(calls, ['local', 'netease']); assert.deepEqual(sends, ['local', 'netease']);
});

test('missing 和 instrumental 是来源明确的完整成功，不把认证或网络失败投影为空歌词', async t => {
  for (const status of ['missing', 'instrumental'] as const) {
    const data = fixture('local', status); let providerCalls = 0;
    const lyrics = createMobileContentLyricsPort({ local: port('local', data.body), provider: { async dispatch() { providerCalls++; throw new Error('不可回退'); } },
      assertCurrent: () => undefined });
    t.after(() => lyrics.close()); const result = await lyrics.dispatch(data.input()); await result.beforeSend();
    assert.equal(result.reply.status, 200); assert.equal(result.reply.body.status, status);
    assert.equal(result.reply.body.synchronized, false); assert.equal(result.reply.body.lines.length, 0);
    assert.equal(canonical(result.reply.body), canonical(data.body)); assert.equal(providerCalls, 0);
  }
});

test('正文或独立 context 的原 track/source/version/content 任何一轴不符都拒绝', async t => {
  const data = fixture('local');
  for (const [key, value] of [['trackId', 'local:other'], ['source', 'netease'], ['versionId', 'local:other-version'], ['contentRevision', 'content.next']] as const) {
    const wrong = { ...data.body, [key]: value };
    const lyrics = createMobileContentLyricsPort({ local: port('local', wrong), provider: port('netease'), assertCurrent: () => undefined });
    t.after(() => lyrics.close()); await assert.rejects(lyrics.dispatch(data.input()), MobileServiceError);
    const badContext = createMobileContentLyricsPort({ local: port('local', undefined, context => {
      assert.ok(context.selection); context.selection = { ...context.selection, [key]: value };
    }), provider: port('netease'), assertCurrent: () => undefined });
    t.after(() => badContext.close()); await assert.rejects(badContext.dispatch(data.input()), MobileServiceError);
  }
});

test('ready 空行、无完整修订、超量与部分歌词不被包装成合法 missing', async t => {
  const data = fixture('local'); assert.equal(data.body.status, 'ready');
  for (const body of [{ ...data.body, lines: [] }, { ...data.body, lyricRevision: null },
    { ...data.body, lines: Array.from({ length: 2_001 }, (_, index) => ({ id: `line.${index}`, text: '完整行', startMs: index })) }]) {
    const lyrics = createMobileContentLyricsPort({ local: port('local', body), provider: port('netease'), assertCurrent: () => undefined });
    t.after(() => lyrics.close()); await refuses(lyrics.dispatch(data.input()), 503, 'BUSY');
  }
});

test('401、繁忙与证书类内部失败保持安全错误，来源不匹配不触发另一端口', async t => {
  for (const failure of [new MobileServiceError(401, 'UNAUTHORIZED'), new MobileServiceError(503, 'BUSY', true, 1000),
    new MobileServiceError(503, 'CONTENT_LIMIT_EXCEEDED'), new Error('合成证书链内部细节')]) {
    let localCalls = 0, providerCalls = 0;
    const lyrics = createMobileContentLyricsPort({ local: { async dispatch() { localCalls++; throw failure; } },
      provider: { async dispatch() { providerCalls++; throw new Error('不可回退'); } }, assertCurrent: () => undefined });
    t.after(() => lyrics.close());
    await refuses(lyrics.dispatch(fixture('local').input()), failure instanceof MobileServiceError ? failure.status : 503,
      failure instanceof MobileServiceError ? failure.code : 'BUSY');
    assert.equal(localCalls, 1); assert.equal(providerCalls, 0);
  }
});

test('取消与账号切换围住歌词迟到回包和发送前复核，close 不接纳新查询', async t => {
  const entered = deferred(), release = deferred(); let current = true, aborted = false;
  const held: MobileContentPort = { async dispatch<O extends MobileContentOperation>(input: MobileContentServiceInput<O>) {
    input.signal.addEventListener('abort', () => { aborted = true; }, { once: true }); entered.resolve(); await release.promise;
    return port('netease').dispatch(input);
  } };
  const lyrics = createMobileContentLyricsPort({ local: port('local'), provider: held,
    assertCurrent: () => { if (!current) throw new MobileServiceError(409, 'SOURCE_CHANGED'); } });
  t.after(async () => { release.resolve(); await lyrics.close(); });
  const controller = new AbortController(), request = lyrics.dispatch(fixture('netease').input(controller.signal));
  const rejected = refuses(request, 503, 'BUSY'); await entered.promise; controller.abort(); await rejected; assert.equal(aborted, true);
  release.resolve(); const local = await lyrics.dispatch(fixture('local').input()); current = false;
  await refuses(local.beforeSend(), 409, 'SOURCE_CHANGED'); await lyrics.close();
  await refuses(lyrics.dispatch(fixture('local').input()), 503, 'BUSY');
});
