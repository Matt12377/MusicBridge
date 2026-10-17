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

const image = new Uint8Array([255,216,1,2,3,4,255,217]);
const url = 'https://p1.music.126.net/synthetic-cover.jpg';
const init = (signal: AbortSignal): RequestInit => ({ method: 'GET', redirect: 'manual', credentials: 'omit', signal });
const busy = (error: unknown) => error instanceof MobileServiceError && error.code === 'BUSY';
const deferred = () => { let done!: () => void; const promise = new Promise<void>(resolve => { done = resolve; }); return { promise, done }; };

/** 原生请求/响应叶的受控替身；DNS及固定地址/TLS选项仍由实际生产函数生成。 */
function nativeFixture(mode: 'image' | 'connect-hold' | 'body-hold' | 'redirect' = 'image') {
  const options: RequestOptions[] = [], entered = deferred(); let requestDestroyed = 0, responseClosed = 0, payload = image;
  const request: NonNullable<MobileArtworkTransportLeaves['request']> = (value, respond) => {
    options.push(value); const emitter = new EventEmitter(); let closed = false, message: IncomingMessage | undefined;
    const close = () => { if (closed) return; closed = true; emitter.emit('close'); };
    const stub = Object.assign(emitter, {
      maxHeadersCount: 0,
      end(): EventEmitter {
        entered.done(); if (mode === 'connect-hold') return stub;
        queueMicrotask(() => {
          const stream = new PassThrough();
          message = Object.assign(stream, { statusCode: mode === 'redirect' ? 302 : 200,
            rawHeaders: mode === 'redirect' ? ['Location','https://p2.music.126.net/next.jpg'] : ['Content-Type','image/jpeg','Content-Length',String(payload.length)] }) as unknown as IncomingMessage;
          stream.once('close', () => { responseClosed++; close(); }); respond(message);
          if (mode === 'image') stream.end(payload);
        });
        return stub;
      },
      destroy(): EventEmitter { requestDestroyed++; message?.destroy(); queueMicrotask(close); return stub; },
    });
    return stub as unknown as ClientRequest;
  };
  return { request, options, entered: entered.promise, setImage(value: Uint8Array<ArrayBuffer>) { payload = value; }, counts: () => ({ requestDestroyed, responseClosed }) };
}

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
