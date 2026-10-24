import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID, createHash, createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ClientRequest, IncomingMessage } from 'node:http';
import type { RequestOptions } from 'node:https';
import { createMobileNeteaseArtwork, mobileNeteaseArtworkURL, MOBILE_NETEASE_ARTWORK_MAX_BYTES } from '../../src/netease/mobile-artwork.js';
import { createMobileArtworkFetch, type MobileArtworkTransportLeaves } from '../../src/netease/mobile-artwork-transport.js';
import { captureMobileContentCoreRequest, captureMobileContentCoreResponse } from '../../src/mobile/content-rpc.js';
import { createMobileContentRpcPort } from '../../src/mobile/content-rpc-port.js';
import { captureMobileArtworkBytes } from '../../src/mobile/artwork-bytes.js';
import type { MobileNeteaseScope } from '../../src/mobile/netease-source-types.js';
import { MobileServiceError } from '../../src/mobile/types.js';
import { createMobileCapabilityContext, withMobileCapabilityContext, MOBILE_CAPABILITY_TRACE_PREFIX,
  type MobileCapabilityTraceRecord } from '../../src/mobile/capability-trace.js';

const scope: MobileNeteaseScope = { serverId: 'server.art', datasetId: 'dataset.art', ownerEpoch: 'owner.art',
  deviceId: 'device.art', deviceEpoch: 1, accessGeneration: 1, accountDomain: 'nc:account.art', providerEpoch: 'provider.art' };
const url = 'https://p1.music.126.net/synthetic-cover.jpg', image = new Uint8Array([255,216,1,2,3,4,255,217]);
const signal = () => new AbortController().signal;
const error = (status: number) => (value: unknown) => value instanceof MobileServiceError && value.status === status;
const base = () => ({ type: 'mobile-content-core-request' as const, id: randomUUID() });

// 按旧协议独立构造签名，不借用待修bind生成“旧ID”。全为固定合成资料。
function legacyArtworkId(raw: string, kind = 's', item = '12'): string {
  const digest = createHash('sha256').update(mobileNeteaseArtworkURL(raw)!).digest('hex');
  const mac = createHmac('sha256', new Uint8Array(32).fill(7)).update(JSON.stringify([
    scope.serverId, scope.datasetId, scope.ownerEpoch, scope.accountDomain, scope.providerEpoch, 0, kind, item, digest,
  ])).digest('hex').slice(0, 32);
  return `naw:abc123:${kind}:${item}:${digest}:${mac}`;
}

test('R17_ARTWORK_ALIAS 新身份仅合并精确九主机，旧签名先验且缩图保留实际观测主机路径', async () => {
  const targets: string[] = [];
  const service = createMobileNeteaseArtwork({ ...scope, namespace: 'abc123', key: new Uint8Array(32).fill(7), fetch: async target => {
    targets.push(target); return new Response(image, { headers: { 'content-type': 'image/jpeg' } });
  } });
  const hosts = Array.from({ length: 9 }, (_, i) => url.replace('p1.', `p${i + 1}.`));
  try {
    const ids = hosts.map(value => service.bind(scope, 's', '12', value)!);
    assert.equal(new Set(ids).size, 1);
    let revision: string | undefined;
    for (const observed of hosts) {
      const read = await service.read(scope, ids[0]!, signal(), async () => observed);
      assert.equal(targets.at(-1), observed + '?param=512y512'); assert.equal(read.artworkId, ids[0]);
      if (revision) assert.equal(read.revision, revision); else revision = read.revision;
    }
    for (const oldUrl of hosts) {
      const oldId = legacyArtworkId(oldUrl); let oldRevision: string | undefined;
      for (const observed of hosts) {
        const read = await service.read(scope, oldId, signal(), async () => observed);
        assert.equal(targets.at(-1), observed + '?param=512y512'); assert.equal(read.artworkId, oldId);
        if (oldRevision) assert.equal(read.revision, oldRevision); else oldRevision = read.revision;
      }
    }
    assert.equal(targets.length, 90);
    let resolutions = 0;
    const oldId = legacyArtworkId(hosts[8]!);
    const changedMac = oldId.slice(0, -1) + (oldId.endsWith('0') ? '1' : '0');
    for (const [actualScope, id] of [
      [scope, changedMac], [{ ...scope, accountDomain: 'nc:other' }, oldId], [{ ...scope, providerEpoch: 'other.epoch' }, oldId],
      [{ ...scope, ownerEpoch: 'other.owner' }, oldId],
    ] as const) await assert.rejects(service.read(actualScope, id, signal(), async () => { resolutions++; return hosts[0]; }), error(409));
    assert.equal(resolutions, 0); assert.equal(targets.length, 90);
    service.invalidate();
    await assert.rejects(service.read(scope, oldId, signal(), async () => { resolutions++; return hosts[0]; }), error(409));
    assert.equal(resolutions, 0);
  } finally { service.close(); }
});

test('R17_ARTWORK_ALIAS 路径查询和组外主机不等价，真实字节修订仍独立变化', async () => {
  const png = Uint8Array.from(readFileSync(new URL('../fixtures/mbrs012-source/owned-cover-16.png', import.meta.url)));
  const jpeg = Uint8Array.from(readFileSync(new URL('../fixtures/mbrs012-source/owned-cover-16.jpg', import.meta.url)));
  let body = png, type = 'image/png', calls = 0;
  const service = createMobileNeteaseArtwork({ ...scope, namespace: 'abc123', key: new Uint8Array(32).fill(7), fetch: async () => {
    calls++; return new Response(body, { headers: { 'content-type': type } });
  } });
  try {
    const id = service.bind(scope, 's', '12', url)!;
    for (const target of [url.replace('p1.', 'p2.') + '?changed=1', url.replace('cover', 'other'),
      url.replace('p1.', 'p0.'), url.replace('p1.', 'p10.'), url.replace('p1.', ''),
      url.replace('p1.', 'p2.') + '?b=2&a=1']) {
      assert.notEqual(service.bind(scope, 's', '12', target), id);
      await assert.rejects(service.read(scope, id, signal(), async () => target), error(409));
      await assert.rejects(service.read(scope, legacyArtworkId(url), signal(), async () => target), error(409));
    }
    const ordered = service.bind(scope, 's', '12', url + '?a=1&b=2')!;
    await assert.rejects(service.read(scope, ordered, signal(), async () => url.replace('p1.', 'p9.') + '?b=2&a=1'), error(409));
    assert.equal(calls, 0);
    const first = await service.read(scope, id, signal(), async () => url.replace('p1.', 'p3.'));
    body = jpeg; type = 'image/jpeg';
    const second = await service.read(scope, id, signal(), async () => url.replace('p1.', 'p9.'));
    assert.equal(first.artworkId, second.artworkId); assert.notEqual(first.revision, second.revision);
    assert.equal(await service.assert(scope, id, signal(), async () => url.replace('p1.', 'p2.')), second.revision);
    assert.equal(calls, 3);
  } finally { service.close(); }
});

test('封面magic分类：有限MIME按实际PNG或JPEG签名交付，其余字节保留闭集拒绝', async t => {
  const jpeg = Uint8Array.from(readFileSync(new URL('../fixtures/mbrs012-source/owned-cover-16.jpg', import.meta.url)));
  const png = Uint8Array.from(readFileSync(new URL('../fixtures/mbrs012-source/owned-cover-16.png', import.meta.url)));
  const append = (body: Uint8Array, tail: number[]) => Uint8Array.from([...body, ...tail]);
  const bodies = [
    { kind: 'png', bytes: png },
    { kind: 'jpeg-soi-final-eoi', bytes: jpeg },
    { kind: 'jpeg-soi-tail-zero', bytes: append(jpeg, [0, 0, 0]) },
    { kind: 'jpeg-soi-tail-whitespace', bytes: append(jpeg, [9, 10, 12, 13, 32]) },
    { kind: 'jpeg-soi-tail-other', bytes: append(jpeg, [80, 82, 73, 86, 65, 84, 69]) },
    { kind: 'jpeg-soi-no-eoi', bytes: jpeg.slice(0, -2) },
    { kind: 'webp', bytes: new Uint8Array([82, 73, 70, 70, 4, 0, 0, 0, 87, 69, 66, 80]) },
    { kind: 'other', bytes: new TextEncoder().encode('<html>private-body</html>') },
  ];
  const mimes = [
    { kind: 'png', value: 'image/png' }, { kind: 'jpeg', value: 'image/jpeg' },
    { kind: 'jpg', value: 'image/jpg' }, { kind: 'octet', value: 'application/octet-stream' },
  ];
  for (const mime of mimes) for (const body of bodies) await t.test(`${mime.kind}/${body.kind}`, async () => {
    const accepted = body.kind === 'png' || body.kind === 'jpeg-soi-final-eoi';
    let priorRevision: string | undefined;
    for (const enabled of [false, true]) {
      let calls = 0; const lines: string[] = [];
      const service = createMobileNeteaseArtwork({ ...scope, namespace: 'abc123', key: new Uint8Array(32).fill(7), fetch: async () => {
        calls++; return new Response(body.bytes, { headers: { 'content-type': mime.value, 'content-length': String(body.bytes.length) } });
      } });
      const context = createMobileCapabilityContext(randomUUID(), 'core', 'content', null, signal(), line => { lines.push(line); })!;
      if (enabled) context.privateContentDiagnostic = true;
      try {
        const id = service.bind(scope, 's', '12', url)!;
        await withMobileCapabilityContext(context, async () => {
          if (accepted) {
            const image = await service.read(scope, id, signal(), async () => url);
            assert.deepEqual(image.bytes, body.bytes);
            assert.equal(image.contentType, body.kind === 'png' ? 'image/png' : 'image/jpeg');
            if (priorRevision !== undefined) assert.equal(image.revision, priorRevision);
            priorRevision = image.revision;
          } else for (let repeat = 0; repeat < 2; repeat++) {
            await assert.rejects(service.read(scope, id, signal(), async () => url), value => {
              assert.ok(value instanceof MobileServiceError); assert.equal(value.status, 503);
              assert.equal(value.code, 'BUSY'); assert.equal(value.retryable, true); assert.equal(value.retryAfterMs, 1000);
              return true;
            });
          }
        });
        assert.equal(calls, accepted ? 1 : 2);
        assert.equal(lines.length, enabled && !accepted ? 1 : 0);
        if (lines.length) {
          const record = JSON.parse(lines[0]!.slice(MOBILE_CAPABILITY_TRACE_PREFIX.length)) as MobileCapabilityTraceRecord;
          assert.equal(record.stage, `provider.artwork.download.magic.${mime.kind}.${body.kind}`);
          assert.equal(record.code, 'BUSY'); assert.equal(record.aborted, false); assert.equal(Object.keys(record).length, 15);
        }
        assert.doesNotMatch(lines.join(''), /private-body|PRIVATE|synthetic-cover|https:|image\/|application\/|255,216|base64|ffd8/u);
      } finally { service.close(); }
    }
  });
});

test('封面MIME真实签名：交叉声明经过生产transport，canonical类型和字节修订一致且原生叶静止', async t => {
  const cases = [
    { name: 'jpg声明PNG', declared: 'image/jpg', type: 'image/png', file: 'owned-cover-16.png' },
    { name: 'jpeg声明PNG', declared: 'image/jpeg', type: 'image/png', file: 'owned-cover-16.png' },
    { name: 'png声明JPEG', declared: 'image/png', type: 'image/jpeg', file: 'owned-cover-16.jpg' },
  ];
  for (const row of cases) await t.test(row.name, async () => {
    const bytes = Uint8Array.from(readFileSync(new URL('../fixtures/mbrs012-source/' + row.file, import.meta.url)));
    const requests: RequestOptions[] = []; let declared = row.declared, responseClosed = 0, requestClosed = 0;
    const request: NonNullable<MobileArtworkTransportLeaves['request']> = (options, respond) => {
      requests.push(options); const emitter = new EventEmitter(); let closed = false, response: PassThrough | undefined;
      const close = () => { if (!closed) { closed = true; requestClosed++; emitter.emit('close'); } };
      const outgoing = Object.assign(emitter, { maxHeadersCount: 0,
        end(): EventEmitter {
          queueMicrotask(() => {
            response = new PassThrough();
            response.once('close', () => { responseClosed++; close(); });
            respond(Object.assign(response, { statusCode: 200,
              rawHeaders: ['Content-Type', declared, 'Content-Length', String(bytes.length)] }) as unknown as IncomingMessage);
            response.end(bytes);
          });
          return outgoing;
        },
        destroy(): EventEmitter { response?.destroy(); queueMicrotask(close); return outgoing; },
      });
      return outgoing as unknown as ClientRequest;
    };
    const fetch = createMobileArtworkFetch({ request, resolver: () => ({
      resolve4: async () => ['8.8.8.8'], resolve6: async () => [], cancel() {},
    }) });
    const service = createMobileNeteaseArtwork({ ...scope, namespace: 'abc123', key: new Uint8Array(32).fill(7), fetch });
    try {
      const id = service.bind(scope, 's', '12', url)!;
      const selected = await service.read(scope, id, signal(), async () => url);
      assert.equal(selected.artworkId, id); assert.equal(selected.contentType, row.type); assert.deepEqual(selected.bytes, bytes);
      assert.equal(requestClosed, 1); assert.equal(responseClosed, 1);
      declared = row.type;
      assert.equal(await service.assert(scope, id, signal(), async () => url), selected.revision);
      assert.equal(requests.length, 2); assert.equal(requestClosed, 2); assert.equal(responseClosed, 2);
      for (const options of requests) {
        assert.equal(options.hostname, '8.8.8.8'); assert.equal(options.servername, 'p1.music.126.net');
        assert.equal(options.rejectUnauthorized, true); assert.equal(options.agent, false);
        assert.deepEqual(options.headers, { Host: 'p1.music.126.net', Accept: 'image/jpeg,image/png', 'Accept-Encoding': 'identity' });
      }
    } finally { service.close(); }
  });
});

test('封面EOI尾部旁注：只认有限ASCII空白并以零优先，扫描命中不授予图片资格', async t => {
  const jpeg = Uint8Array.from(readFileSync(new URL('../fixtures/mbrs012-source/owned-cover-16.jpg', import.meta.url)));
  const cases = [
    { name: '单零', tail: [0], kind: 'jpeg-soi-tail-zero' },
    { name: '垂直制表不是许可空白', tail: [11], kind: 'jpeg-soi-tail-other' },
    { name: '非ASCII空白', tail: [194, 160], kind: 'jpeg-soi-tail-other' },
    { name: '零与空格混合', tail: [0, 32], kind: 'jpeg-soi-tail-other' },
    { name: '末次EOI后零', tail: [80, 255, 217, 0], kind: 'jpeg-soi-tail-zero' },
  ];
  for (const row of cases) await t.test(row.name, async () => {
    const body = Uint8Array.from([...jpeg, ...row.tail]), lines: string[] = [];
    let calls = 0;
    const service = createMobileNeteaseArtwork({ ...scope, namespace: 'abc123', key: new Uint8Array(32).fill(7), fetch: async () => {
      calls++; return new Response(body, { headers: { 'content-type': 'application/octet-stream' } });
    } });
    const context = createMobileCapabilityContext(randomUUID(), 'core', 'content', null, signal(), line => { lines.push(line); })!;
    context.privateContentDiagnostic = true;
    try {
      await withMobileCapabilityContext(context, () => assert.rejects(service.read(scope,
        service.bind(scope, 's', '12', url)!, signal(), async () => url), error(503)));
      assert.equal(calls, 1); assert.equal(lines.length, 1);
      assert.equal(JSON.parse(lines[0]!.slice(MOBILE_CAPABILITY_TRACE_PREFIX.length)).stage, `provider.artwork.download.magic.octet.${row.kind}`);
    } finally { service.close(); }
  });
});

test('封面MIME拒绝类别：只保留闭集旁注，默认关闭且任意header值不进入诊断', async t => {
  const jpeg = Uint8Array.from(readFileSync(new URL('../fixtures/mbrs012-source/owned-cover-16.jpg', import.meta.url)));
  const cases = [
    { type: null, category: 'missing' },
    { type: 'image/webp', category: 'webp' },
    { type: 'image/svg+xml', category: 'svg' },
    { type: 'text/html; charset=UTF-8', category: 'html' },
    { type: 'application/private-type; x-private=secret', category: 'other' },
    { type: 'image/jpeg; charset=UTF-8, image/png', category: 'combined' },
  ];
  for (const row of cases) await t.test(row.category, async () => {
    for (const enabled of [false, true]) {
      const lines: string[] = []; let calls = 0;
      const service = createMobileNeteaseArtwork({ ...scope, namespace: 'abc123', key: new Uint8Array(32).fill(7), fetch: async () => {
        calls++; return new Response(jpeg, { headers: row.type === null ? {} : { 'content-type': row.type } });
      } });
      const context = createMobileCapabilityContext(randomUUID(), 'core', 'content', null, signal(), line => { lines.push(line); })!;
      if (enabled) context.privateContentDiagnostic = true;
      try {
        const id = service.bind(scope, 's', '12', url)!;
        await withMobileCapabilityContext(context, async () => {
          await assert.rejects(service.read(scope, id, signal(), async () => url), error(503));
          await assert.rejects(service.read(scope, id, signal(), async () => url), error(503));
        });
        assert.equal(calls, 2); assert.equal(lines.length, enabled ? 1 : 0);
        if (enabled) {
          const record = JSON.parse(lines[0]!.slice(MOBILE_CAPABILITY_TRACE_PREFIX.length)) as MobileCapabilityTraceRecord;
          assert.equal(record.stage, 'provider.artwork.download.type.' + row.category);
          assert.equal(record.code, 'BUSY'); assert.equal(Object.keys(record).length, 15);
        }
        assert.doesNotMatch(lines.join(''), /private-type|secret|https:|image\/|text\/|application\//u);
      } finally { service.close(); }
    }
  });
});

test('封面MIME字节守卫：有限别名不接纳HTML、WebP或截断JPEG', async t => {
  const jpeg = Uint8Array.from(readFileSync(new URL('../fixtures/mbrs012-source/owned-cover-16.jpg', import.meta.url)));
  const html = new TextEncoder().encode('<html>private-body</html>');
  const webp = new Uint8Array([82, 73, 70, 70, 4, 0, 0, 0, 87, 69, 66, 80]);
  const cases = [
    { name: 'jpg不能声明HTML', type: 'image/jpg', bytes: html, stage: 'jpg.other' },
    { name: '通用二进制不能声明HTML', type: 'application/octet-stream', bytes: html, stage: 'octet.other' },
    { name: '通用二进制不能声明截断JPEG', type: 'application/octet-stream', bytes: jpeg.slice(0, -2), stage: 'octet.jpeg-soi-no-eoi' },
    { name: 'jpg不能声明WebP', type: 'image/jpg', bytes: webp, stage: 'jpg.webp' },
    { name: 'PNG声明仍不接纳HTML', type: 'image/png', bytes: html, stage: 'png.other' },
    { name: 'PNG声明仍不接纳截断JPEG', type: 'image/png', bytes: jpeg.slice(0, -2), stage: 'png.jpeg-soi-no-eoi' },
  ];
  for (const row of cases) await t.test(row.name, async () => {
    const lines: string[] = [];
    const service = createMobileNeteaseArtwork({ ...scope, namespace: 'abc123', key: new Uint8Array(32).fill(7), fetch: async () =>
      new Response(row.bytes, { headers: { 'content-type': row.type, 'content-length': String(row.bytes.length) } }) });
    const context = createMobileCapabilityContext(randomUUID(), 'core', 'content', null, signal(), line => { lines.push(line); })!;
    context.privateContentDiagnostic = true;
    try {
      await withMobileCapabilityContext(context, () => assert.rejects(service.read(scope,
        service.bind(scope, 's', '12', url)!, signal(), async () => url), error(503)));
      assert.equal(lines.length, 1);
      assert.equal(JSON.parse(lines[0]!.slice(MOBILE_CAPABILITY_TRACE_PREFIX.length)).stage, 'provider.artwork.download.magic.' + row.stage);
    } finally { service.close(); }
  });
});

test('私有封面分类：身份和来源拒绝保留原错误，只记录固定分类且同请求一次', async () => {
  let downloads = 0;
  const service = createMobileNeteaseArtwork({ ...scope, namespace: 'abc123', key: new Uint8Array(32).fill(7), fetch: async () => {
    downloads++; return new Response(image, { headers: { 'content-type': 'image/jpeg' } });
  } });
  try {
    const artworkId = service.bind(scope, 's', '12', url)!;
    const cases = [
      { stage: 'scope', status: 409, read: () => service.read({ ...scope, serverId: 'different.server' }, artworkId, signal(), async () => url) },
      { stage: 'identity', status: 404, read: () => service.read(scope, 'naw:invalid', signal(), async () => url) },
      { stage: 'signature', status: 409, read: () => service.read({ ...scope, accountDomain: 'nc:another.private-account' }, artworkId, signal(), async () => url) },
      { stage: 'url-missing', status: 404, read: () => service.read(scope, artworkId, signal(), async () => null) },
      { stage: 'url-changed', status: 409, read: () => service.read(scope, artworkId, signal(), async () => url + '?private-value=secret') },
      { stage: 'url-changed', status: 409, read: () => service.read(scope, artworkId, signal(), async () => url.replace('p1.', 'p10.')) },
    ];
    for (const row of cases) {
      const lines: string[] = [];
      const context = createMobileCapabilityContext(randomUUID(), 'core', 'content', null, signal(), line => { lines.push(line); })!;
      context.privateContentDiagnostic = true;
      await withMobileCapabilityContext(context, async () => {
        await assert.rejects(row.read(), error(row.status));
        await assert.rejects(row.read(), error(row.status));
      });
      const records = lines.map(line => JSON.parse(line.slice(MOBILE_CAPABILITY_TRACE_PREFIX.length)) as MobileCapabilityTraceRecord);
      assert.equal(records.length, 1); assert.equal(records[0]!.stage, 'provider.artwork.' + row.stage);
      assert.equal(records[0]!.code, row.status === 409 ? 'SOURCE_CHANGED' : 'RESOURCE_REVOKED');
      assert.equal(Object.keys(records[0]!).length, 15);
      assert.doesNotMatch(lines.join(''), /synthetic-cover|private-value|secret|private-account|naw:|https:/u);
    }
    assert.equal(downloads, 0);
  } finally { service.close(); }
});

test('封面下载首拒：HTTP/字节拒绝只有闭集阶段，原状态与请求次数保持不变', async () => {
  const cases: Array<{ stage: string; status: number; response: () => Response }> = [
    { stage: 'type.html', status: 503, response: () => new Response('private-body', { headers: { 'content-type': 'text/html' } }) },
    { stage: 'magic.jpeg.other', status: 503, response: () => new Response(new Uint8Array(8), { headers: { 'content-type': 'image/jpeg' } }) },
    { stage: 'length', status: 503, response: () => new Response(image, { headers: { 'content-type': 'image/jpeg', 'content-length': '9' } }) },
    { stage: 'encoding', status: 503, response: () => new Response(image, { headers: { 'content-type': 'image/jpeg', 'content-encoding': 'gzip' } }) },
    { stage: 'limit', status: 413, response: () => new Response(image, { headers: { 'content-type': 'image/jpeg', 'content-length': String(MOBILE_NETEASE_ARTWORK_MAX_BYTES + 1) } }) },
    { stage: 'redirect', status: 503, response: () => new Response(null, { status: 302, headers: { location: 'https://127.0.0.1/private' } }) },
    { stage: 'status', status: 404, response: () => new Response(null, { status: 404 }) },
  ];
  for (const row of cases) {
    let calls = 0; const lines: string[] = [];
    const service = createMobileNeteaseArtwork({ ...scope, namespace: 'abc123', key: new Uint8Array(32).fill(7),
      fetch: async () => { calls++; return row.response(); } });
    const context = createMobileCapabilityContext(randomUUID(), 'core', 'content', null, signal(), line => { lines.push(line); })!;
    context.privateContentDiagnostic = true;
    try {
      await withMobileCapabilityContext(context, () => assert.rejects(service.read(scope,
        service.bind(scope, 's', '12', url)!, signal(), async () => url), error(row.status)));
      assert.equal(calls, 1); assert.equal(lines.length, 1);
      const record = JSON.parse(lines[0]!.slice(MOBILE_CAPABILITY_TRACE_PREFIX.length)) as MobileCapabilityTraceRecord;
      assert.equal(record.stage, 'provider.artwork.download.' + row.stage); assert.equal(Object.keys(record).length, 15);
      assert.doesNotMatch(lines.join(''), /https:|private-body|127\.0|synthetic-cover|image\/jpeg/u);
    } finally { service.close(); }
  }
});

test('封面身份不会把不同路径或不同查询及组外主机当作九主机别名', async () => {
  let calls = 0;
  const service = createMobileNeteaseArtwork({ ...scope, namespace: 'abc123', key: new Uint8Array(32).fill(7),
    fetch: async () => { calls++; return new Response(image); } });
  try {
    const id = service.bind(scope, 's', '12', url)!;
    for (const target of [url.replace('p1.', 'p2.') + '?changed=1', url.replace('cover', 'another'), url.replace('p1.', 'p10.')]) {
      const lines: string[] = [], context = createMobileCapabilityContext(randomUUID(), 'core', 'content', null, signal(), line => { lines.push(line); })!;
      context.privateContentDiagnostic = true;
      await withMobileCapabilityContext(context, () => assert.rejects(service.read(scope, id, signal(), async () => target), error(409)));
      assert.equal(JSON.parse(lines[0]!.slice(MOBILE_CAPABILITY_TRACE_PREFIX.length)).stage, 'provider.artwork.url-changed');
    }
    assert.equal(calls, 0);
  } finally { service.close(); }
});

test('私有封面分类：默认关闭和观察器失败不改变读取次数及原拒绝', async () => {
  const service = createMobileNeteaseArtwork({ ...scope, namespace: 'abc123', key: new Uint8Array(32).fill(7) });
  try {
    const artworkId = service.bind(scope, 'a', '12', url)!;
    let calls = 0, lines = 0;
    const ordinary = createMobileCapabilityContext(randomUUID(), 'core', 'content', null, signal(), () => { lines++; })!;
    await withMobileCapabilityContext(ordinary, () => assert.rejects(service.read(scope, artworkId, signal(), async () => { calls++; return null; }), error(404)));
    assert.equal(calls, 1); assert.equal(lines, 0);
    const broken = createMobileCapabilityContext(randomUUID(), 'core', 'content', null, signal(), () => { throw new Error('observer failed'); })!;
    broken.privateContentDiagnostic = true;
    await withMobileCapabilityContext(broken, () => assert.rejects(service.read(scope, artworkId, signal(), async () => { calls++; return null; }), error(404)));
    assert.equal(calls, 2);
  } finally { service.close(); }
});

test('手机封面ID：来源账户代际绑定且只有Mac解析URL，旧账号和旧URL不能复用', async () => {
  let downloads = 0;
  const service = createMobileNeteaseArtwork({ ...scope, namespace: 'abc123', key: new Uint8Array(32).fill(7), fetch: async (target, init) => {
    downloads++; assert.equal(target, url + '?param=512y512'); assert.equal(init.redirect, 'manual'); assert.equal(init.credentials, 'omit');
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
    { response: () => new Response(image.slice(0, -2), { headers: { 'content-type': 'image/png' } }), status: 503 },
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
