import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { createMobileNeteaseArtwork, mobileNeteaseArtworkURL, MOBILE_NETEASE_ARTWORK_MAX_BYTES } from '../../src/netease/mobile-artwork.js';
import { captureMobileContentCoreRequest, captureMobileContentCoreResponse } from '../../src/mobile/content-rpc.js';
import { createMobileContentRpcPort } from '../../src/mobile/content-rpc-port.js';
import { captureMobileArtworkBytes } from '../../src/mobile/artwork-bytes.js';
import type { MobileNeteaseScope } from '../../src/mobile/netease-source-types.js';
import { MobileServiceError } from '../../src/mobile/types.js';

const scope: MobileNeteaseScope = { serverId: 'server.art', datasetId: 'dataset.art', ownerEpoch: 'owner.art',
  deviceId: 'device.art', deviceEpoch: 1, accessGeneration: 1, accountDomain: 'nc:account.art', providerEpoch: 'provider.art' };
const url = 'https://p1.music.126.net/synthetic-cover.jpg', image = new Uint8Array([255,216,1,2,3,4,255,217]);
const signal = () => new AbortController().signal;
const error = (status: number) => (value: unknown) => value instanceof MobileServiceError && value.status === status;
const base = () => ({ type: 'mobile-content-core-request' as const, id: randomUUID() });

test('手机封面ID：来源账户代际绑定且只有Mac解析URL，旧账号和旧URL不能复用', async () => {
  let downloads = 0;
  const service = createMobileNeteaseArtwork({ ...scope, namespace: 'abc123', key: new Uint8Array(32).fill(7), fetch: async (target, init) => {
    downloads++; assert.equal(target, url); assert.equal(init.redirect, 'manual'); assert.equal(init.credentials, 'omit');
    const headers = new Headers(init.headers); assert.equal(headers.get('cookie'), null); assert.equal(headers.get('authorization'), null);
    return new Response(image, { headers: { 'content-type': 'image/jpeg', 'content-length': String(image.length) } });
  } });
  try {
    const id = service.bind(scope, 'a', '12', url); assert.ok(id); assert.ok(id.length <= 160); assert.doesNotMatch(id, /https|music\.126/iu);
    const read = await service.read(scope, id, signal(), async (kind, item) => { assert.equal(kind, 'a'); assert.equal(item, '12'); return url; });
    assert.deepEqual(read.bytes, image); assert.equal(await service.assert(scope, id, signal(), async () => url), read.revision);
    await assert.rejects(service.read({ ...scope, accountDomain: 'nc:other' }, id, signal(), async () => url), error(409));
    await assert.rejects(service.read({ ...scope, providerEpoch: 'other.epoch' }, id, signal(), async () => url), error(409));
    await assert.rejects(service.read(scope, id, signal(), async () => url + '?changed=1'), error(409));
    assert.equal(downloads, 2);
    service.invalidate(); await assert.rejects(service.read(scope, id, signal(), async () => url), error(409));
    assert.notEqual(service.bind(scope, 'a', '12', url), id);
    for (const raw of ['https://127.0.0.1/x', 'https://169.254.169.254/x', 'https://music.126.net.evil.test/x',
      'https://u:p@p1.music.126.net/x', 'https://p1.music.126.net:8443/x', url + '#secret', 'file:///etc/passwd'])
      assert.equal(mobileNeteaseArtworkURL(raw), null);
    assert.equal(mobileNeteaseArtworkURL('http://p1.music.126.net/x'), 'https://p1.music.126.net/x');
  } finally { service.close(); }
});

test('手机封面HTTP：200也要类型魔数长度预算，重定向不能离开CDN或把BUSY当永久无图', async () => {
  const cases: Array<{ response: () => Response; status: number }> = [
    { response: () => new Response('html', { headers: { 'content-type': 'text/html' } }), status: 503 },
    { response: () => new Response(new Uint8Array(8), { headers: { 'content-type': 'image/jpeg' } }), status: 503 },
    { response: () => new Response(image, { headers: { 'content-type': 'image/png' } }), status: 503 },
    { response: () => new Response(image, { headers: { 'content-type': 'image/jpeg', 'content-length': '9' } }), status: 503 },
    { response: () => new Response(image, { headers: { 'content-type': 'image/jpeg', 'content-encoding': 'gzip' } }), status: 503 },
    { response: () => new Response(image, { headers: { 'content-type': 'image/jpeg', 'content-length': String(MOBILE_NETEASE_ARTWORK_MAX_BYTES + 1) } }), status: 413 },
    { response: () => new Response(new Uint8Array(MOBILE_NETEASE_ARTWORK_MAX_BYTES + 1), { headers: { 'content-type': 'image/jpeg' } }), status: 413 },
    { response: () => new Response(null, { status: 302, headers: { location: 'https://127.0.0.1/private' } }), status: 503 },
    { response: () => new Response(null, { status: 302, headers: { location: 'https://other.example.test/image.jpg' } }), status: 503 },
    { response: () => new Response(null, { status: 404 }), status: 404 },
    { response: () => new Response(null, { status: 503 }), status: 503 },
  ];
  for (const row of cases) {
    let calls = 0;
    const service = createMobileNeteaseArtwork({ ...scope, namespace: 'abc123', key: new Uint8Array(32).fill(7), fetch: async () => { calls++; return row.response(); } });
    try { const id = service.bind(scope, 'a', '12', url)!;
      await assert.rejects(service.read(scope, id, signal(), async () => url), error(row.status)); assert.equal(calls, 1);
    } finally { service.close(); }
  }
  let release!: () => void, entered!: () => void;
  const hold = new Promise<void>(r => { release = r; }), started = new Promise<void>(r => { entered = r; });
  const service = createMobileNeteaseArtwork({ ...scope, namespace: 'abc123', key: new Uint8Array(32).fill(7), fetch: async () => {
    entered(); await hold; return new Response(image, { headers: { 'content-type': 'image/jpeg' } });
  } });
  const late = assert.rejects(service.read(scope, service.bind(scope, 's', '1', url)!, signal(), async () => url));
  await started; service.invalidate(); release(); await late; service.close();
});

test('手机封面私有RPC：闭集及独占字节拒绝extra/getter/Shared，真实clone后重新捕获', () => {
  const request = captureMobileContentCoreRequest({ ...base(), action: 'artwork', operation: 'read', scope,
    artworkId: 'naw:fixture', expectedRevision: null });
  assert.equal(request.action, 'artwork');
  const response = { type: 'mobile-content-core-response', id: request.id, action: 'artwork', kind: 'artwork', scope,
    artworkId: 'naw:fixture', revision: 'nar:fixture', contentType: 'image/jpeg', bytes: image };
  const captured = captureMobileContentCoreResponse(response, request); assert.ok(captured.action === 'artwork' && captured.kind === 'artwork');
  assert.notEqual(captured.bytes.buffer, image.buffer); assert.equal(Object.isExtensible(captured.bytes), false);
  const clone = structuredClone(captured); assert.ok(clone.action === 'artwork' && clone.kind === 'artwork');
  assert.equal(Object.isExtensible(clone.bytes), true);
  const recaptured = captureMobileContentCoreResponse(clone, request); assert.ok(recaptured.action === 'artwork' && recaptured.kind === 'artwork');
  assert.notEqual(recaptured.bytes.buffer, clone.bytes.buffer);
  const backing = new Uint8Array(16); backing.set(image, 4);
  const ownView = captureMobileArtworkBytes(backing.subarray(4, 12));
  backing.fill(0); structuredClone(backing, { transfer: [backing.buffer] });
  assert.deepEqual(ownView, image);
  let reads = 0; const extra = new Uint8Array(8); Object.defineProperty(extra, Symbol('extra'), { value: true });
  const getter = new Uint8Array(8); Object.defineProperty(getter, 'hidden', { get() { reads++; return true; } });
  const detached = new Uint8Array(8); structuredClone(detached, { transfer: [detached.buffer] });
  for (const bytes of [extra, getter, detached, new Uint8Array(new SharedArrayBuffer(8)), Buffer.alloc(8), new Proxy(image, {})])
    assert.throws(() => captureMobileArtworkBytes(bytes));
  assert.equal(reads, 0);
  assert.throws(() => captureMobileContentCoreRequest({ ...request, extra: true }));
  assert.throws(() => captureMobileContentCoreResponse({ ...response, extra: true }, request));
  assert.throws(() => captureMobileContentCoreResponse({ ...response, scope: { ...scope, providerEpoch: 'another' } }, request));
  const init = { ...base(), action: 'initialize', serverId: scope.serverId, datasetId: scope.datasetId, key: new Uint8Array(32) };
  assert.equal(Object.hasOwn(captureMobileContentCoreRequest(init), 'privateProviderDiagnostics'), false);
  const enabled = captureMobileContentCoreRequest({ ...init, privateProviderDiagnostics: true });
  assert.ok(enabled.action === 'initialize' && enabled.privateProviderDiagnostics === true);
  for (const forged of [false, null, 1, 'true']) assert.throws(() => captureMobileContentCoreRequest({ ...init, privateProviderDiagnostics: forged }));
});

test('手机封面实际RPC端口：取图和发送前再验都保留scope撤销，旧图不会迟到发布', async () => {
  let epoch = scope.providerEpoch, reads = 0;
  const rpc = createMobileContentRpcPort({ initialize: async () => {}, invalidateDevice: async () => {},
    resolveScope: async principal => ({ ...scope, ...principal }),
    assertScope: current => { if (current.providerEpoch !== epoch) throw new MobileServiceError(409, 'SOURCE_CHANGED'); },
    content: { async dispatch() { throw new Error('此夹具不读取JSON内容'); } },
    source: async () => { throw new Error('此夹具不读取媒体'); },
    readArtwork: async (_scope, artworkId) => { reads++; return { artworkId, revision: 'nar:fixture', contentType: 'image/jpeg', bytes: image }; },
    assertArtwork: async () => 'nar:fixture',
  });
  try {
    await rpc.request({ ...base(), action: 'initialize', serverId: scope.serverId, datasetId: scope.datasetId, key: new Uint8Array(32).fill(1) }, signal());
    const read = await rpc.request({ ...base(), action: 'artwork', operation: 'read', scope, artworkId: 'naw:fixture', expectedRevision: null }, signal());
    assert.ok(read.action === 'artwork' && read.kind === 'artwork'); assert.equal(reads, 1);
    epoch = 'replaced';
    const refused = await rpc.request({ ...base(), action: 'artwork', operation: 'revalidate', scope,
      artworkId: 'naw:fixture', expectedRevision: read.revision }, signal());
    assert.ok('kind' in refused && refused.kind === 'error'); assert.equal(refused.status, 409);
  } finally { await rpc.close(); }
});
