import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import type { ClientRequest, IncomingMessage } from 'node:http';
import type { RequestOptions } from 'node:https';
import type { DetailedPeerCertificate } from 'node:tls';
import { createMobileArtworkFetch, mobileArtworkPublicAddress, type MobileArtworkTransportLeaves } from '../../src/netease/mobile-artwork-transport.js';
import { createMobileNeteaseArtwork } from '../../src/netease/mobile-artwork.js';
import { MobileServiceError } from '../../src/mobile/types.js';
import { createMobileContentRpcPort } from '../../src/mobile/content-rpc-port.js';
import { captureMobileNeteaseScope } from '../../src/mobile/netease-source-types.js';
import { captureMobileContentScope } from '../../src/mobile/content-types.js';
import { sameMobileContentScope } from '../../src/mobile/content-service.js';
import { createMobileCapabilityContext, withMobileCapabilityContext, MOBILE_CAPABILITY_TRACE_PREFIX } from '../../src/mobile/capability-trace.js';

const image = new Uint8Array([255,216,1,2,3,4,255,217]);
const url = 'https://p1.music.126.net/synthetic-cover.jpg';
const init = (signal: AbortSignal): RequestInit => ({ method: 'GET', redirect: 'manual', credentials: 'omit', signal });
const busy = (error: unknown) => error instanceof MobileServiceError && error.code === 'BUSY';
const deferred = () => { let done!: () => void; const promise = new Promise<void>(resolve => { done = resolve; }); return { promise, done }; };

/** 原生请求/响应叶的受控替身；DNS及固定地址/TLS选项仍由实际生产函数生成。 */
function nativeFixture(mode: 'image' | 'connect-hold' | 'body-hold' | 'redirect' | 'forbidden' = 'image') {
  const options: RequestOptions[] = [], entered = deferred(); let requestDestroyed = 0, responseClosed = 0, payload = image;
  let contentTypes = ['image/jpeg'];
  const request: NonNullable<MobileArtworkTransportLeaves['request']> = (value, respond) => {
    options.push(value); const emitter = new EventEmitter(); let closed = false, message: IncomingMessage | undefined;
    const close = () => { if (closed) return; closed = true; emitter.emit('close'); };
    const stub = Object.assign(emitter, {
      maxHeadersCount: 0,
      end(): EventEmitter {
        entered.done(); if (mode === 'connect-hold') return stub;
        queueMicrotask(() => {
          const stream = new PassThrough();
          message = Object.assign(stream, { statusCode: mode === 'redirect' ? 302 : mode === 'forbidden' ? 403 : 200,
            rawHeaders: mode === 'redirect' ? ['Location','https://p2.music.126.net/next.jpg']
              : [...contentTypes.flatMap(type => ['Content-Type', type]), 'Content-Length', String(payload.length)] }) as unknown as IncomingMessage;
          stream.once('close', () => { responseClosed++; close(); }); respond(message);
          if (mode === 'image') stream.end(payload);
        });
        return stub;
      },
      destroy(): EventEmitter { requestDestroyed++; message?.destroy(); queueMicrotask(close); return stub; },
    });
    return stub as unknown as ClientRequest;
  };
  return { request, options, entered: entered.promise, setImage(value: Uint8Array<ArrayBuffer>) { payload = value; },
    setContentTypes(values: string[]) { contentTypes = [...values]; }, counts: () => ({ requestDestroyed, responseClosed }) };
}

test('封面MIME有限兼容：完整图片经过生产transport与service，别名只归一类型不改变字节修订', async t => {
  const cases = [
    { name: 'jpg实际JPEG', input: 'image/jpg', type: 'image/jpeg', file: 'owned-cover-16.jpg' },
    { name: '通用二进制实际JPEG', input: 'application/octet-stream', type: 'image/jpeg', file: 'owned-cover-16.jpg' },
    { name: '通用二进制实际PNG', input: 'application/octet-stream', type: 'image/png', file: 'owned-cover-16.png' },
  ];
  for (const row of cases) await t.test(row.name, async () => {
    const bytes = Uint8Array.from(readFileSync(new URL('../fixtures/mbrs012-source/' + row.file, import.meta.url)));
    const native = nativeFixture(); native.setImage(bytes); native.setContentTypes([row.input]);
    const transport = createMobileArtworkFetch({ request: native.request, resolver: () => ({
      async resolve4() { return ['8.8.8.8']; }, async resolve6() { return []; }, cancel() {},
    }) });
    const scope = { serverId: 'server.art', datasetId: 'dataset.art', ownerEpoch: 'owner.art',
      deviceId: 'device.art', deviceEpoch: 1, accessGeneration: 1, accountDomain: 'nc:account.art', providerEpoch: 'provider.art' };
    const service = createMobileNeteaseArtwork({ ...scope, namespace: 'abc123', key: new Uint8Array(32).fill(7), fetch: transport });
    try {
      const id = service.bind(scope, 's', '12', url)!;
      const selected = await service.read(scope, id, new AbortController().signal, async () => url);
      assert.equal(selected.contentType, row.type); assert.deepEqual(selected.bytes, bytes);
      native.setContentTypes([row.type]);
      assert.equal(await service.assert(scope, id, new AbortController().signal, async () => url), selected.revision);
      assert.equal(native.options.length, 2); assert.equal(native.counts().responseClosed, 2);
      assert.equal(native.options[0]!.hostname, native.options[1]!.hostname);
      assert.equal(native.options[0]!.path, native.options[1]!.path);
      assert.equal(native.options[0]!.servername, 'p1.music.126.net');
      assert.equal(native.options[0]!.rejectUnauthorized, true);
      assert.deepEqual(native.options[0]!.headers, { Host: 'p1.music.126.net', Accept: 'image/jpeg,image/png', 'Accept-Encoding': 'identity' });
    } finally { service.close(); }
  });
});

test('封面MIME传输拒绝：重复类型头不取首项，拒绝前等待原生请求响应关闭', async () => {
  const native = nativeFixture(); native.setContentTypes(['image/jpeg', 'image/png']);
  native.setImage(Uint8Array.from(readFileSync(new URL('../fixtures/mbrs012-source/owned-cover-16.jpg', import.meta.url))));
  const transport = createMobileArtworkFetch({ request: native.request, resolver: () => ({
    async resolve4() { return ['8.8.8.8']; }, async resolve6() { return []; }, cancel() {},
  }) });
  const scope = { serverId: 'server.art', datasetId: 'dataset.art', ownerEpoch: 'owner.art',
    deviceId: 'device.art', deviceEpoch: 1, accessGeneration: 1, accountDomain: 'nc:account.art', providerEpoch: 'provider.art' };
  const service = createMobileNeteaseArtwork({ ...scope, namespace: 'abc123', key: new Uint8Array(32).fill(7), fetch: transport });
  const lines: string[] = [], signal = new AbortController().signal;
  const context = createMobileCapabilityContext(randomUUID(), 'core', 'content', null, signal, line => { lines.push(line); })!;
  context.privateContentDiagnostic = true;
  try {
    await withMobileCapabilityContext(context, () => assert.rejects(service.read(scope,
      service.bind(scope, 's', '12', url)!, signal, async () => url), busy));
    assert.equal(lines.length, 1);
    assert.equal(JSON.parse(lines[0]!.slice(MOBILE_CAPABILITY_TRACE_PREFIX.length)).stage, 'provider.artwork.download.type.combined');
    assert.equal(native.options.length, 1); assert.equal(native.counts().responseClosed, 1);
  } finally { service.close(); }
});

test('封面MIME取消：通用二进制读体中止后不返回图片且原生请求响应静止', async () => {
  const native = nativeFixture('body-hold'); native.setContentTypes(['application/octet-stream']);
  const transport = createMobileArtworkFetch({ request: native.request, resolver: () => ({
    async resolve4() { return ['8.8.8.8']; }, async resolve6() { return []; }, cancel() {},
  }) });
  const scope = { serverId: 'server.art', datasetId: 'dataset.art', ownerEpoch: 'owner.art',
    deviceId: 'device.art', deviceEpoch: 1, accessGeneration: 1, accountDomain: 'nc:account.art', providerEpoch: 'provider.art' };
  const service = createMobileNeteaseArtwork({ ...scope, namespace: 'abc123', key: new Uint8Array(32).fill(7), fetch: transport });
  const controller = new AbortController();
  try {
    const reading = service.read(scope, service.bind(scope, 's', '12', url)!, controller.signal, async () => url);
    await native.entered; await new Promise<void>(resolve => setImmediate(resolve)); controller.abort();
    await assert.rejects(reading);
    assert.equal(native.options.length, 1); assert.equal(native.counts().responseClosed, 1);
    assert.ok(native.counts().requestDestroyed >= 1);
  } finally { service.close(); }
});

test('封面DNS首拒：解析错误/非法回答/非公网/空回答独立分类且零连接', async () => {
  for (const [stage, answer] of [
    ['dns-failure', async () => { throw Object.assign(new Error('private-dns-detail'), { code: 'ETIMEOUT' }); }],
    ['dns-answer', async () => Array<string>(33).fill('8.8.8.8')],
    ['dns-address', async () => ['127.0.0.1']],
    ['dns-empty', async () => []],
  ] as const) {
    const lines: string[] = [], native = nativeFixture(), signal = new AbortController().signal;
    const context = createMobileCapabilityContext(randomUUID(), 'core', 'content', null, signal, line => { lines.push(line); })!;
    context.privateContentDiagnostic = true;
    const fetch = createMobileArtworkFetch({ request: native.request, resolver: () => ({ resolve4: answer, resolve6: async () => [], cancel() {} }) });
    await withMobileCapabilityContext(context, () => assert.rejects(fetch(url, init(signal)), busy));
    assert.equal(native.options.length, 0); assert.equal(lines.length, 1);
    const record = JSON.parse(lines[0]!.slice(MOBILE_CAPABILITY_TRACE_PREFIX.length));
    assert.equal(record.stage, 'provider.artwork.transport.' + stage); assert.equal(Object.keys(record).length, 15);
    assert.doesNotMatch(lines.join(''), /private-dns|127\.0|8\.8|https:|synthetic-cover/u);
  }
});

test('封面HTTP首拒：真实请求响应close之后保持BUSY，外层下载不覆盖首拒', async () => {
  const native = nativeFixture('forbidden'), lines: string[] = [], signal = new AbortController().signal;
  const context = createMobileCapabilityContext(randomUUID(), 'core', 'content', null, signal, line => { lines.push(line); })!;
  context.privateContentDiagnostic = true;
  const fetch = createMobileArtworkFetch({ request: native.request,
    resolver: () => ({ resolve4: async () => ['8.8.8.8'], resolve6: async () => [], cancel() {} }) });
  const scope = { serverId: 'server.art', datasetId: 'dataset.art', ownerEpoch: 'owner.art',
    deviceId: 'device.art', deviceEpoch: 1, accessGeneration: 1, accountDomain: 'nc:account.art', providerEpoch: 'provider.art' };
  const service = createMobileNeteaseArtwork({ ...scope, namespace: 'abc123', key: new Uint8Array(32).fill(7), fetch });
  try {
    await withMobileCapabilityContext(context, () => assert.rejects(service.read(scope,
      service.bind(scope, 's', '12', url)!, signal, async () => url), busy));
    assert.equal(native.counts().responseClosed, 1); assert.equal(lines.length, 1);
    assert.equal(JSON.parse(lines[0]!.slice(MOBILE_CAPABILITY_TRACE_PREFIX.length)).stage, 'provider.artwork.transport.http-status');
  } finally { service.close(); }
});

test('封面TLS首拒：证书拒绝不输出底层文本，默认关闭不产生诊断', async () => {
  for (const enabled of [false, true]) {
    const lines: string[] = [], signal = new AbortController().signal; let closed = false;
    const context = createMobileCapabilityContext(randomUUID(), 'core', 'content', null, signal, line => { lines.push(line); })!;
    if (enabled) context.privateContentDiagnostic = true;
    const fetch = createMobileArtworkFetch({
      resolver: () => ({ resolve4: async () => ['8.8.8.8'], resolve6: async () => [], cancel() {} }),
      request: () => {
        const emitter = new EventEmitter();
        return Object.assign(emitter, { maxHeadersCount: 0, end() {
          emitter.emit('error', Object.assign(new Error('private-certificate-host'), { code: 'ERR_TLS_CERT_ALTNAME_INVALID' }));
          closed = true; emitter.emit('close'); return emitter;
        }, destroy() { closed = true; emitter.emit('close'); return emitter; } }) as unknown as ClientRequest;
      },
    });
    await withMobileCapabilityContext(context, () => assert.rejects(fetch(url, init(signal)), busy));
    assert.equal(closed, true); assert.equal(lines.length, enabled ? 1 : 0);
    if (enabled) assert.equal(JSON.parse(lines[0]!.slice(MOBILE_CAPABILITY_TRACE_PREFIX.length)).stage, 'provider.artwork.transport.tls');
    assert.doesNotMatch(lines.join(''), /private-certificate|https:|8\.8/u);
  }
});

test('封面生产transport选择：只连接首批已验IP，DNS随后变化不触发重解析且TLS仍核原CDN主机', async () => {
  let dns4 = 0, dns6 = 0; const native = nativeFixture();
  const transport = createMobileArtworkFetch({ request: native.request, resolver: () => ({
    async resolve4() { dns4++; return dns4 === 1 ? ['8.8.8.8'] : ['127.0.0.1']; },
    async resolve6() { dns6++; return []; }, cancel() {},
  }) });
  const response = await transport(url, init(new AbortController().signal));
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), image);
  assert.equal(dns4, 1); assert.equal(dns6, 1); assert.equal(native.options.length, 1);
  const selected = native.options[0]!;
  assert.equal(selected.hostname, '8.8.8.8'); assert.equal(selected.family, 4);
  assert.equal(selected.agent, false); assert.equal(selected.lookup, undefined);
  assert.equal(selected.servername, 'p1.music.126.net'); assert.equal(selected.rejectUnauthorized, true);
  assert.equal(selected.ca, undefined); assert.equal(selected.checkServerIdentity?.('8.8.8.8', { subjectaltname: 'DNS:p1.music.126.net' } as DetailedPeerCertificate), undefined);
  assert.ok(selected.checkServerIdentity?.('8.8.8.8', { subjectaltname: 'DNS:wrong.invalid' } as DetailedPeerCertificate) instanceof Error);
  assert.deepEqual(selected.headers, { Host: 'p1.music.126.net', Accept: 'image/jpeg,image/png', 'Accept-Encoding': 'identity' });
  assert.equal(native.counts().responseClosed, 1);
});

test('封面生产transport选择：私网/保留/IPv4映射IPv6及混合解析全拒，原生连接数为零', async () => {
  const blocked4 = ['0.0.0.0','10.0.0.1','100.64.0.1','127.0.0.1','169.254.169.254','172.16.0.1','192.168.1.1',
    '192.0.0.1','192.0.2.1','198.18.0.1','198.51.100.1','203.0.113.1','224.0.0.1','255.255.255.255'];
  const blocked6 = ['::','::1','fc00::1','fe80::1','ff02::1','::ffff:127.0.0.1','::ffff:10.0.0.1','::ffff:7f00:1',
    '0:0:0:0:0:ffff:7f00:1','64:ff9b::7f00:1','2001::7f00:1','2001:db8::1','2002:7f00:1::','3fff::1'];
  assert.ok(mobileArtworkPublicAddress('8.8.8.8',4)); assert.ok(mobileArtworkPublicAddress('2606:4700:4700::1111',6));
  for (const [family, values] of [[4,blocked4],[6,blocked6]] as const) for (const address of values) {
    assert.equal(mobileArtworkPublicAddress(address,family),false);
    const native = nativeFixture(); const transport = createMobileArtworkFetch({ request:native.request, resolver:()=>({
      async resolve4(){return family===4?['8.8.8.8',address]:['8.8.8.8'];}, async resolve6(){return family===6?[address]:[];}, cancel(){},
    }) });
    await assert.rejects(transport(url,init(new AbortController().signal)),busy);assert.equal(native.options.length,0);
  }
});

test('封面生产transport取消：DNS双查询取消并全部收口，连接及读体取消销毁请求响应', async t => {
  await t.test('dns', async () => {
    const start=deferred();let queries=0,settled=0,cancelled=0;const rejectors:Array<(error:Error)=>void>=[];
    const native=nativeFixture();const controller=new AbortController();
    const query=()=>{queries++;if(queries===2)start.done();return new Promise<string[]>((_resolve,reject)=>rejectors.push(reject)).finally(()=>{settled++;});};
    const transport=createMobileArtworkFetch({request:native.request,resolver:()=>({resolve4:query,resolve6:query,cancel(){cancelled++;for(const reject of rejectors)reject(Object.assign(new Error('合成DNS取消'),{code:'ECANCELLED'}));}})});
    const result=transport(url,init(controller.signal));await start.promise;controller.abort();await assert.rejects(result,busy);
    assert.equal(queries,2);assert.equal(settled,2);assert.ok(cancelled>=1);assert.equal(native.options.length,0);
  });
  for (const mode of ['connect-hold','body-hold'] as const) await t.test(mode, async () => {
    const native=nativeFixture(mode),controller=new AbortController();
    const transport=createMobileArtworkFetch({request:native.request,resolver:()=>({async resolve4(){return['8.8.8.8'];},async resolve6(){return[];},cancel(){}})});
    const result=transport(url,init(controller.signal));await native.entered;
    if(mode==='connect-hold'){controller.abort();await assert.rejects(result,busy);}
    else{const response=await result;const reading=response.arrayBuffer();controller.abort();await assert.rejects(reading,busy);assert.equal(native.counts().responseClosed,1);}
    assert.ok(native.counts().requestDestroyed>=1);
  });
});

test('封面生产transport每跳固定：同CDN重定向的新私网解析被拒，原响应先关闭且不建立第二连接', async () => {
  const native=nativeFixture('redirect');let dns4=0;
  const transport=createMobileArtworkFetch({request:native.request,resolver:()=>({
    async resolve4(host){dns4++;return host==='p1.music.126.net'?['8.8.8.8']:['127.0.0.1'];},async resolve6(){return[];},cancel(){},
  })});
  const scope={serverId:'server.art',datasetId:'dataset.art',ownerEpoch:'owner.art',deviceId:'device.art',deviceEpoch:1,
    accessGeneration:1,accountDomain:'nc:account.art',providerEpoch:'provider.art'};
  const service=createMobileNeteaseArtwork({...scope,namespace:'abc123',key:new Uint8Array(32).fill(7),fetch:transport});
  try{const id=service.bind(scope,'a','12',url)!;await assert.rejects(service.read(scope,id,new AbortController().signal,async()=>url),busy);
    assert.equal(dns4,2);assert.equal(native.options.length,1);assert.equal(native.counts().responseClosed,1);
  }finally{service.close();}
});

test('封面实际组合：同URL同scope第二次实际字节变化，生产选择路径重读后RPC拒绝旧图修订', async () => {
  const firstImage=Uint8Array.from(readFileSync(new URL('../fixtures/mbrs012-source/owned-cover-16.jpg',import.meta.url)));
  const secondImage=Uint8Array.from(readFileSync(new URL('../fixtures/mbrs012-source/owned-cover-32.jpg',import.meta.url)));
  assert.notDeepEqual(firstImage,secondImage);
  const native=nativeFixture();native.setImage(firstImage);const transport=createMobileArtworkFetch({request:native.request,resolver:()=>({
    async resolve4(){return['8.8.8.8'];},async resolve6(){return[];},cancel(){},
  })});
  const scope={serverId:'server.art',datasetId:'dataset.art',ownerEpoch:'owner.art',deviceId:'device.art',deviceEpoch:1,
    accessGeneration:1,accountDomain:'nc:account.art',providerEpoch:'provider.art'};
  const service=createMobileNeteaseArtwork({...scope,namespace:'abc123',key:new Uint8Array(32).fill(7),fetch:transport});
  const artworkId=service.bind(scope,'a','12',url)!;
  const expectedScope=captureMobileContentScope(scope);
  const rpc=createMobileContentRpcPort({initialize:async()=>{},invalidateDevice:async()=>{},resolveScope:async principal=>({...scope,...principal}),
    assertScope:current=>{
      if(!sameMobileContentScope(current,expectedScope))throw new MobileServiceError(409,'SOURCE_CHANGED');
      assert.deepEqual(current,expectedScope);
    },content:{async dispatch(){throw new Error('此夹具不读取JSON内容');}},
    source:async()=>{throw new Error('此夹具不读取音乐');},
    readArtwork:(current,id,signal)=>service.read(captureMobileNeteaseScope(current),id,signal,async()=>url),
    assertArtwork:(current,id,signal)=>service.assert(captureMobileNeteaseScope(current),id,signal,async()=>url),
  });
  const base=()=>({type:'mobile-content-core-request' as const,id:randomUUID()});const signal=()=>new AbortController().signal;
  try{
    await rpc.request({...base(),action:'initialize',serverId:scope.serverId,datasetId:scope.datasetId,key:new Uint8Array(32).fill(1)},signal());
    const original=await rpc.request({...base(),action:'artwork',operation:'read',scope,artworkId,expectedRevision:null},signal());
    assert.ok(original.action==='artwork'&&original.kind==='artwork');assert.deepEqual(original.bytes,firstImage);
    native.setImage(secondImage);
    const refused=await rpc.request({...base(),action:'artwork',operation:'revalidate',scope,artworkId,expectedRevision:original.revision},signal());
    assert.ok('kind' in refused&&refused.kind==='error');assert.equal(refused.status,409);assert.equal(refused.code,'SOURCE_CHANGED');
    assert.equal(native.options.length,2);assert.equal(native.counts().responseClosed,2);
    assert.equal(native.options[0]!.path,native.options[1]!.path);assert.equal(native.options[0]!.hostname,native.options[1]!.hostname);
    const wrongScope=await rpc.request({...base(),action:'artwork',operation:'read',scope:{...scope,providerEpoch:'provider.other'},artworkId,expectedRevision:null},signal());
    assert.ok('kind' in wrongScope&&wrongScope.kind==='error');assert.equal(wrongScope.status,409);
    assert.equal(native.options.length,2,'错误scope不得再取图');
  }finally{await rpc.close();service.close();}
});
