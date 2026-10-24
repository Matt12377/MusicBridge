import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import type { MobileTrack } from '@music-bridge/contracts';
import {
  captureMobileDirectoryPage, captureMobileDirectoryQuery,
  type MobileDirectoryPage, type MobileDirectoryQuery,
} from '../../src/mobile/directory-rpc.js';
import {
  captureMobileContentCoreRequest, captureMobileContentCoreResponse,
  type MobileContentCoreRequest, type MobileContentCoreResponse,
} from '../../src/mobile/content-rpc.js';
import { createMobileContentRpcPort, type MobileContentRpcPortOptions } from '../../src/mobile/content-rpc-port.js';
import type { MobileContentScope } from '../../src/mobile/content-types.js';
import { MobileServiceError } from '../../src/mobile/types.js';

const scope: Readonly<MobileContentScope> = Object.freeze({ serverId: 'server.directory.fixture', datasetId: 'dataset.directory.fixture',
  ownerEpoch: 'owner.directory.fixture', deviceId: 'device.directory.fixture', deviceEpoch: 1, accessGeneration: 1,
  accountDomain: 'account.directory.fixture', providerEpoch: 'provider.directory.fixture' });
const signal = () => new AbortController().signal;
const base = () => ({ type: 'mobile-content-core-request' as const, id: randomUUID() });
const query = (extra: Partial<MobileDirectoryQuery> = {}): MobileDirectoryQuery => ({ kind: 'artists', query: '合成艺人',
  artistId: null, offset: 0, limit: 10, expectedRevision: null, ...extra });
const artist = () => ({ id: '17', name: '合成艺人', source: 'netease' as const, albumCount: 2, trackCount: 3 });
function page(input = query()): MobileDirectoryPage {
  return { kind: input.kind, items: [artist()], offset: input.offset, limit: input.limit,
    total: input.offset + 1, revision: 'nr:directory-fixture', nextOffset: null };
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
function failure(response: MobileContentCoreResponse, code: string): void {
  assert.ok('kind' in response && response.kind === 'error'); assert.equal(response.code, code);
  assert.equal(response.retryable, false);
  assert.doesNotMatch(JSON.stringify(response), /https?:|credential|cookie|upstream|stack/iu);
}
async function fixture(t: TestContext, extra: Partial<MobileContentRpcPortOptions> = {}) {
  const rpc = createMobileContentRpcPort({ initialize: async () => {}, invalidateDevice: async () => {},
    resolveScope: async () => scope, assertScope: () => {},
    content: { async dispatch() { throw new Error('目录测试不调用旧内容写入。'); } },
    source: async () => { throw new Error('目录测试不打开媒体。'); }, readDirectory: async (_scope, input) => page(input), ...extra });
  t.after(() => rpc.close());
  const initialized = await rpc.request({ ...base(), action: 'initialize', serverId: scope.serverId, datasetId: scope.datasetId,
    key: new Uint8Array(32).fill(23) }, signal());
  assert.ok(initialized.action === 'initialize' && 'ok' in initialized && initialized.ok);
  const directory = (input = query(), parent = signal()) => {
    const request: MobileContentCoreRequest = { ...base(), action: 'directory', scope, query: input };
    return { request, promise: rpc.request(request, parent) };
  };
  return { rpc, directory };
}

test('4.1目录私有查询闭集、有界且不求值访问器', () => {
  assert.deepEqual(captureMobileDirectoryQuery(query()), query());
  for (const input of [query({ offset: -1 }), query({ limit: 101 }), query({ artistId: 'https://synthetic.invalid/17' }),
    query({ expectedRevision: '无效 修订' }), { ...query(), credential: '合成扩展' }, query({ query: '' })]) {
    assert.throws(() => captureMobileDirectoryQuery(input), MobileServiceError);
  }
  assert.equal(captureMobileDirectoryQuery(query({ artistId: '17', query: '' })).artistId, '17');
  let reads = 0;
  const accessed = Object.defineProperty(query(), 'query', { enumerable: true, get() { reads++; return '不应求值'; } });
  assert.throws(() => captureMobileDirectoryQuery(accessed), MobileServiceError); assert.equal(reads, 0);
});

test('4.1目录空结果是完整零页，混合来源、重复身份和修订错配均拒绝', () => {
  const input = query(), empty = { ...page(input), items: [], total: 0 };
  assert.deepEqual(captureMobileDirectoryPage(empty, input).items, []);
  for (const value of [{ ...page(input), items: [{ ...artist(), source: 'local' }] },
    { ...page(input), items: [artist(), artist()], total: 2 }, { ...page(input), nextOffset: 1 },
    { ...page(input), items: [], total: 1, nextOffset: 0 }, { ...page(input), upstreamUrl: 'https://synthetic.invalid/private' }]) {
    assert.throws(() => captureMobileDirectoryPage(value, input), MobileServiceError);
  }
  assert.throws(() => captureMobileDirectoryPage(page(input), query({ expectedRevision: 'nr:other' })), MobileServiceError);
});

test('4.1目录曲目拒绝嵌套audio扩展，原未知音频目录事实仍可返回', () => {
  const input = query({ kind: 'tracks' });
  const track: MobileTrack = { id: 'nt:synthetic:901', title: '合成曲目', artists: ['合成艺人'], albumId: 'na:synthetic:902',
    source: 'netease', sourceItemId: '901', versionId: 'nv:synthetic', contentRevision: 'nr:synthetic', editionLabel: '',
    durationMs: 1000, audio: { codec: 'unknown', container: 'unknown' }, availability: 'available' };
  const candidate = { ...page(input), items: [track] };
  assert.equal(captureMobileDirectoryPage(candidate, input).items.length, 1);
  for (const extra of [{ upstreamUrl: 'https://synthetic.invalid/private' }, { requestHeaders: { authorization: '合成扩展' } }]) {
    assert.throws(() => captureMobileDirectoryPage({ ...candidate, items: [{ ...track, audio: { ...track.audio, ...extra } }] }, input), MobileServiceError);
  }
});

test('4.1目录RPC捕获绑定原完整scope、查询与分页修订', () => {
  const request: MobileContentCoreRequest = { ...base(), action: 'directory', scope, query: query() };
  const captured = captureMobileContentCoreRequest(request); assert.equal(captured.action, 'directory');
  const response = { type: 'mobile-content-core-response', id: request.id, action: 'directory', kind: 'directory', scope, page: page() };
  assert.equal(captureMobileContentCoreResponse(response, request).action, 'directory');
  assert.throws(() => captureMobileContentCoreResponse({ ...response, scope: { ...scope, accessGeneration: 2 } }, request));
  assert.throws(() => captureMobileContentCoreResponse({ ...response, page: { ...page(), offset: 1 } }, request));
  assert.throws(() => captureMobileContentCoreRequest({ ...request, scope: { ...scope, providerEpoch: null } }), MobileServiceError);
});

test('4.1目录RPC读取前与读取后各复核scope，过期结果不能发布', async t => {
  let alive = true, reads = 0;
  const f = await fixture(t, { assertScope: () => { if (!alive) throw new MobileServiceError(409, 'SOURCE_CHANGED'); },
    readDirectory: async (_scope, input) => { reads++; alive = false; return page(input); } });
  failure(await f.directory().promise, 'SOURCE_CHANGED'); assert.equal(reads, 1);
  failure(await f.directory().promise, 'SOURCE_CHANGED'); assert.equal(reads, 1);
});

test('4.1目录取消封输出并等待原读取静止，迟到结果不提前释放槽位', async t => {
  const entered = deferred(), release = deferred(); let aborted = false, reads = 0;
  const f = await fixture(t, { maxInflight: 2, readDirectory: async (_scope, input, owned) => {
    reads++; owned.addEventListener('abort', () => { aborted = true; }, { once: true }); entered.resolve();
    await release.promise; return page(input);
  } });
  try {
    const controller = new AbortController(), pending = f.directory(query(), controller.signal);
    await entered.promise; controller.abort(); failure(await pending.promise, 'BUSY'); assert.equal(aborted, true);
    failure(await f.directory().promise, 'BUSY'); assert.equal(reads, 1);
    let quiet = false;
    const cancelled = f.rpc.request({ ...base(), action: 'cancel', requestId: pending.request.id, snapshotId: null, scope }, signal())
      .then(value => { quiet = true; return value; });
    await Promise.resolve(); assert.equal(quiet, false);
    release.resolve(); const result = await cancelled;
    assert.ok(result.action === 'cancel' && 'kind' in result && result.kind === 'cancelled' && result.quiet);
    assert.equal(reads, 1);
  } finally { release.resolve(); }
});

test('4.1目录设备撤权覆盖新action，旧epoch不能在迟到结果后重新读取', async t => {
  const entered = deferred(), release = deferred(), invalidated = deferred(); let reads = 0;
  const f = await fixture(t, { invalidateDevice: async () => { invalidated.resolve(); },
    readDirectory: async (_scope, input) => { reads++; entered.resolve(); await release.promise; return page(input); } });
  try {
    const pending = f.directory(); await entered.promise;
    const revocation = f.rpc.request({ ...base(), action: 'invalidate-device', serverId: scope.serverId, datasetId: scope.datasetId,
      deviceId: scope.deviceId, deviceEpoch: scope.deviceEpoch }, signal());
    await invalidated.promise; failure(await f.directory().promise, 'UNAUTHORIZED');
    release.resolve(); const ack = await revocation;
    assert.ok(ack.action === 'invalidate-device' && 'ok' in ack && ack.ok);
    failure(await pending.promise, 'BUSY'); failure(await f.directory().promise, 'UNAUTHORIZED'); assert.equal(reads, 1);
  } finally { release.resolve(); }
});
