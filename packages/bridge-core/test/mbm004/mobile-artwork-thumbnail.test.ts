import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { createHash, createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import type { ClientRequest, IncomingMessage } from 'node:http';
import type { RequestOptions } from 'node:https';
import { createMobileNeteaseArtwork, MOBILE_NETEASE_ARTWORK_MAX_BYTES } from '../../src/netease/mobile-artwork.js';
import { createMobileArtworkFetch, type MobileArtworkTransportLeaves } from '../../src/netease/mobile-artwork-transport.js';
import { MobileServiceError } from '../../src/mobile/types.js';

const scope = { serverId: 'server.thumbnail', datasetId: 'dataset.thumbnail', ownerEpoch: 'owner.thumbnail',
  deviceId: 'device.thumbnail', deviceEpoch: 1, accessGeneration: 1, accountDomain: 'nc:thumbnail', providerEpoch: 'provider.thumbnail' };
const image = Uint8Array.from(readFileSync(new URL('../fixtures/mbrs012-source/owned-cover-16.jpg', import.meta.url)));
const raw = 'https://p3.music.126.net/synthetic-thumbnail.jpg';
const signal = () => new AbortController().signal;
const error = (status: number) => (value: unknown) => value instanceof MobileServiceError && value.status === status;
const options = { ...scope, namespace: 'thumbnail', key: new Uint8Array(32).fill(9) };
const jpeg = () => new Response(image, { headers: { 'content-type': 'image/jpeg', 'content-length': String(image.length) } });
const originalTooLarge = () => new Response(image, { headers: { 'content-type': 'image/jpeg', 'content-length': String(MOBILE_NETEASE_ARTWORK_MAX_BYTES + 1) } });

test('网易缩略图：原图超过4MiB时直接请求512px，原身份与每次发送前实际重读保持', async () => {
  const source = raw + '?stamp=a%2fb+raw&keep=~&param=8192y8192&%70aram=2048y2048';
  const expected = raw + '?stamp=a%2fb+raw&keep=~&param=512y512';
  const targets: string[] = []; let resolutions = 0;
  const service = createMobileNeteaseArtwork({ ...options, fetch: async (target, init) => {
    targets.push(target);
    assert.equal(init.redirect, 'manual'); assert.equal(init.credentials, 'omit');
    const headers = new Headers(init.headers); assert.equal(headers.get('cookie'), null); assert.equal(headers.get('authorization'), null);
    return target === expected ? jpeg() : originalTooLarge();
  } });
  try {
    const id = service.bind(scope, 'p', '42', source)!;
    const resolve = async () => { resolutions++; return source; };
    const selected = await service.read(scope, id, signal(), resolve);
    assert.deepEqual(selected.bytes, image);
    assert.equal(await service.assert(scope, id, signal(), resolve), selected.revision);
    assert.equal(resolutions, 2); assert.deepEqual(targets, [expected, expected]);
    assert.equal(service.bind(scope, 'p', '42', source), id);
    assert.equal(service.bind(scope, 'p', '42', expected), id);
    const updated = await service.read(scope, id, signal(), async () => expected);
    assert.equal(updated.revision, selected.revision);
    assert.deepEqual(targets, [expected, expected, expected]);
  } finally { service.close(); }
});

interface NativeAnswer { status: number; headers: string[]; bytes?: Uint8Array }
function nativeImages(answer: (options: RequestOptions) => NativeAnswer) {
  const requests: RequestOptions[] = []; let responseClosed = 0;
  const request: NonNullable<MobileArtworkTransportLeaves['request']> = (value, respond) => {
    requests.push(value); const emitter = new EventEmitter(); let closed = false, message: IncomingMessage | undefined;
    const close = () => { if (!closed) { closed = true; emitter.emit('close'); } };
    const stub = Object.assign(emitter, {
      maxHeadersCount: 0,
      end() {
        queueMicrotask(() => {
          const selected = answer(value), stream = new PassThrough();
          message = Object.assign(stream, { statusCode: selected.status, rawHeaders: selected.headers }) as unknown as IncomingMessage;
          stream.once('close', () => { responseClosed++; close(); }); respond(message); stream.end(selected.bytes);
        });
        return stub;
      },
      destroy() { message?.destroy(); queueMicrotask(close); return stub; },
    });
    return stub as unknown as ClientRequest;
  };
  const fetch = createMobileArtworkFetch({ request, resolver: () => ({
    async resolve4() { return ['8.8.8.8']; }, async resolve6() { return []; }, cancel() {},
  }) });
  return { fetch, requests, closed: () => responseClosed };
}

test('网易缩略图：每次合法CDN跳转都固定512px，原生连接继续固定公网地址及TLS主机', async () => {
  const native = nativeImages(value => String(value.path).startsWith('/synthetic-thumbnail.jpg')
    ? { status: 302, headers: ['Location', 'https://p7.music.126.net/redirected.jpg?keep=a%20b&param=9000y9000'] }
    : { status: 200, bytes: image, headers: ['Content-Type', 'image/jpeg', 'Content-Length',
      String(String(value.path) === '/redirected.jpg?keep=a%20b&param=512y512' ? image.length : MOBILE_NETEASE_ARTWORK_MAX_BYTES + 1)] });
  const service = createMobileNeteaseArtwork({ ...options, fetch: native.fetch });
  try {
    const selected = await service.read(scope, service.bind(scope, 'p', '42', raw)!, signal(), async () => raw);
    assert.deepEqual(selected.bytes, image); assert.equal(native.requests.length, 2); assert.equal(native.closed(), 2);
    assert.equal(native.requests[0]!.path, '/synthetic-thumbnail.jpg?param=512y512');
    assert.equal(native.requests[1]!.path, '/redirected.jpg?keep=a%20b&param=512y512');
    for (const [index, host] of ['p3.music.126.net', 'p7.music.126.net'].entries()) {
      const request = native.requests[index]!;
      assert.equal(request.hostname, '8.8.8.8'); assert.equal(request.servername, host);
      assert.equal(request.rejectUnauthorized, true); assert.equal(request.agent, false);
      assert.equal(typeof request.checkServerIdentity, 'function');
      assert.deepEqual(request.headers, { Host: host, Accept: 'image/jpeg,image/png', 'Accept-Encoding': 'identity' });
    }
  } finally { service.close(); }
});

test('网易缩略图：CDN忽略缩图时字节、分块及MIME预算仍拒绝，原生超限也不交付', async t => {
  const cases = [
    { name: '声明超过4MiB', status: 413, response: originalTooLarge },
    { name: '未声明但实际超过4MiB', status: 413, response: () => new Response(new Uint8Array(MOBILE_NETEASE_ARTWORK_MAX_BYTES + 1), { headers: { 'content-type': 'image/jpeg' } }) },
    { name: '超过4096分块', status: 413, response: () => { let count = 0; return new Response(new ReadableStream<Uint8Array>({
      pull(controller) { if (count++ < 4097) controller.enqueue(new Uint8Array(8)); else controller.close(); },
    }), { headers: { 'content-type': 'image/jpeg' } }); } },
    { name: 'HTML不能作为缩图', status: 503, response: () => new Response('synthetic-body', { headers: { 'content-type': 'text/html' } }) },
    { name: '内容编码仍禁用', status: 503, response: () => new Response(image, { headers: { 'content-type': 'image/jpeg', 'content-encoding': 'gzip' } }) },
  ];
  for (const row of cases) await t.test(row.name, async () => {
    const service = createMobileNeteaseArtwork({ ...options, fetch: async () => row.response() });
    try { await assert.rejects(service.read(scope, service.bind(scope, 'p', '42', raw)!, signal(), async () => raw), error(row.status)); }
    finally { service.close(); }
  });
  const native = nativeImages(() => ({ status: 200, headers: ['Content-Type', 'image/jpeg'], bytes: new Uint8Array(MOBILE_NETEASE_ARTWORK_MAX_BYTES + 1) }));
  const service = createMobileNeteaseArtwork({ ...options, fetch: native.fetch });
  try {
    await assert.rejects(service.read(scope, service.bind(scope, 'p', '42', raw)!, signal(), async () => raw), error(413));
    assert.equal(native.requests.length, 1); assert.equal(native.closed(), 1);
  } finally { service.close(); }
});

test('网易缩略图：来源身份、账号代际和重定向白名单先于转换，不能把不同查询或SSRF目标变为合法', async () => {
  let calls = 0, resolutions = 0;
  const service = createMobileNeteaseArtwork({ ...options, fetch: async () => { calls++; return jpeg(); } });
  try {
    const id = service.bind(scope, 'p', '42', raw)!;
    for (const current of [{ ...scope, accountDomain: 'nc:other' }, { ...scope, providerEpoch: 'provider.other' }])
      await assert.rejects(service.read(current, id, signal(), async () => { resolutions++; return raw; }), error(409));
    assert.equal(resolutions, 0);
    for (const source of [raw + '?signature=changed&param=512y512', 'https://127.0.0.1/image.jpg?param=512y512', 'https://p3.music.126.net.evil.test/image.jpg'])
      await assert.rejects(service.read(scope, id, signal(), async () => source), error(source.startsWith(raw) ? 409 : 404));
    assert.equal(calls, 0);
    service.invalidate(); await assert.rejects(service.read(scope, id, signal(), async () => raw), error(409));
  } finally { service.close(); }
  for (const target of ['https://127.0.0.1/private', 'http://169.254.169.254/private', 'https://p3.music.126.net.evil.test/private']) {
    let redirects = 0;
    const redirecting = createMobileNeteaseArtwork({ ...options, fetch: async () => { redirects++; return new Response(null, { status: 302, headers: { location: target } }); } });
    try {
      await assert.rejects(redirecting.read(scope, redirecting.bind(scope, 'p', '42', raw)!, signal(), async () => raw), error(503));
      assert.equal(redirects, 1);
    } finally { redirecting.close(); }
  }
});

test('M25缩图param按实际请求归一，非param原字节和账号隔离继续生效', async () => {
  const targets: string[] = [];
  const service = createMobileNeteaseArtwork({ ...options, fetch: async target => { targets.push(target); return jpeg(); } });
  const source = raw + '?sig=a%2fb+raw&param=120y120&%70aram=80y80&keep=~';
  const equivalent = raw.replace('p3.', 'p7.') + '?sig=a%2fb+raw&keep=~&param=640y640';
  try {
    const id = service.bind(scope, 'a', '42', source)!;
    assert.equal(service.bind(scope, 'a', '42', equivalent), id);
    const first = await service.read(scope, id, signal(), async () => equivalent);
    assert.equal(targets[0], raw.replace('p3.', 'p7.') + '?sig=a%2fb+raw&keep=~&param=512y512');
    assert.equal(first.artworkId, id);
    for (const changed of [
      equivalent.replace('a%2fb+raw', 'a%2Fb+raw'),
      equivalent.replace('a%2fb+raw', 'changed'),
      equivalent.replace('sig=a%2fb+raw&keep=~', 'keep=~&sig=a%2fb+raw'),
      equivalent.replace('synthetic-thumbnail', 'different-cover'),
      equivalent.replace('param=640y640', 'Param=640y640'),
      equivalent.replace('param=640y640', '%zz=640y640'),
      equivalent.replace('p7.', 'p10.'),
    ]) {
      assert.notEqual(service.bind(scope, 'a', '42', changed), id);
      await assert.rejects(service.read(scope, id, signal(), async () => changed), error(409));
    }
    for (const current of [{ ...scope, accountDomain: 'nc:other' }, { ...scope, providerEpoch: 'provider.other' },
      { ...scope, ownerEpoch: 'owner.other' }]) {
      assert.notEqual(service.bind(current, 'a', '42', equivalent), id);
      await assert.rejects(service.read(current, id, signal(), async () => { assert.fail('授权拒绝不得读取来源'); }), error(409));
    }
    assert.equal(targets.length, 1);
  } finally { service.close(); }
});


test('M25原签名param仍精确校验，不能借新归一放宽旧授权且空查询项不丢失', async () => {
  const source = raw + '?param=120y120', targets: string[] = [];
  const digest = createHash('sha256').update(source).digest('hex');
  const mac = createHmac('sha256', options.key).update(JSON.stringify([
    scope.serverId, scope.datasetId, scope.ownerEpoch, scope.accountDomain, scope.providerEpoch, 0, 'a', '42', digest,
  ])).digest('hex').slice(0, 32);
  const oldId = `naw:${options.namespace}:a:42:${digest}:${mac}`;
  const service = createMobileNeteaseArtwork({ ...options, fetch: async target => { targets.push(target); return jpeg(); } });
  try {
    await service.read(scope, oldId, signal(), async () => source);
    await assert.rejects(service.read(scope, oldId, signal(), async () => raw + '?param=640y640'), error(409));
    const emptyPart = service.bind(scope, 'a', '42', raw + '?param=120y120&')!;
    assert.equal(service.bind(scope, 'a', '42', raw + '?&param=640y640'), emptyPart);
    assert.notEqual(service.bind(scope, 'a', '42', raw), emptyPart);
    await service.read(scope, emptyPart, signal(), async () => raw + '?&param=640y640');
    assert.deepEqual(targets, [raw + '?param=512y512', raw + '?&param=512y512']);
  } finally { service.close(); }
});
