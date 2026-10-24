import {connect as tlsConnect} from 'node:tls'
import {once} from 'node:events'
import {Socket} from 'node:net'
import {createMobileBackend} from '../../src/main/mobile-backend.js'
import type {Mobile002Backend} from '../../src/main/mobile-playback-backend.js'
import type {MobileMediaReply} from '../../src/main/mobile-media-response.js'
import {createMobileHttpSocketGate,canReuseMobileHttp,mobileHttpConnectionHeaders} from '../../src/main/mobile-http-reuse.js'
import {Agent} from 'node:https'
import assert from 'node:assert/strict'
import test, { before, after } from 'node:test'
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { request as httpsRequest } from 'node:https'
import type { ClientRequest } from 'node:http'
import { checkServerIdentity, type ConnectionOptions } from 'node:tls'
import { mkdtemp, rm } from 'node:fs/promises'
import { deflateSync } from 'node:zlib'
import os from 'node:os'
import path from 'node:path'
import { MOBILE_JSON_REQUEST_MAX_BYTES, MOBILE_API_RESPONSE_MAX_BYTES } from '@music-bridge/contracts'
import { MobileServiceError, type Mobile001Backend, type Mobile001BackendReply, type Mobile001Operation } from '../../../../packages/bridge-core/src/mobile/types.js'
import { createMobileHttpsServer, MOBILE_HTTPS_LIMITS, MobileHttpsServerError } from '../../src/main/mobile-https-server.js'
import { loadOrCreateMobileIdentity, type MobileTlsIdentity } from '../../src/main/mobile-tls-identity.js'

/** 实际 TLS/HTTP/原 wire decoder，backend 是受控叶接口，不声称实际 Owner/Auth 服务采用。 */
let identity: MobileTlsIdentity, owned = ''
before(async () => {
  const parent = process.env.TMPDIR ?? (process.platform === 'darwin' ? '/Volumes/LifeWeave/Developer/CommandLine/tmp' : os.tmpdir())
  if (process.platform === 'darwin' && !parent.startsWith('/Volumes/LifeWeave/Developer/CommandLine/')) throw new Error('合成材料必须使用外置目录。')
  owned = await mkdtemp(path.join(parent, 'mbm001-https-'))
  const key = randomBytes(32)
  identity = await loadOrCreateMobileIdentity({ directory: path.join(owned, 'identity'), hosts: ['127.0.0.1'], secretProtector: {
    encryptString(value) {
      const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv)
      const body = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
      return Buffer.concat([iv, cipher.getAuthTag(), body])
    },
    decryptString(value) {
      const decipher = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12)); decipher.setAuthTag(value.subarray(12, 28))
      return Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString('utf8')
    },
  } })
})
after(async () => { if (owned) await rm(owned, { recursive: true, force: true }) })
const digest = (value: Buffer | Uint8Array) => createHash('sha256').update(value).digest('hex')
function serverInfo(displayName = '合成 HTTPS 目录') {
  return { serverId: identity.serverId, displayName, contractVersion: '0.1.0', environment: 'development' }
}
function jsonReply(body: unknown, status = 200): Mobile001BackendReply {
  const bytes = new TextEncoder().encode(JSON.stringify(body))
  return { status, headers: [['Content-Type', 'application/json'], ['Content-Length', String(bytes.byteLength)]], body: bytes }
}
function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
async function fixture(t: test.TestContext, backend: Mobile001Backend, port = 0, playback?:Mobile002Backend, expectedCloseFailure = false) {
  const server = createMobileHttpsServer({ tls: { key: identity.privateKeyPEM, cert: identity.certificatePEM }, host: '127.0.0.1', port, backend, ...(playback?{playback}:{}) })
  t.after(() => expectedCloseFailure ? assert.rejects(server.close(),e=>e instanceof MobileHttpsServerError&&e.code==='CLOSED') : server.close())
  const listening = await server.start()
  return { server, ...listening }
}
interface Result { socket: unknown; reused:boolean; status: number; body: Buffer; rawHeaders: string[] }
interface ClientOptions {
  method?: string; headers?: readonly string[]; body?: Buffer; servername?: string; agent?:Agent
  checkServerIdentity?: ConnectionOptions['checkServerIdentity']
}
function client(base: string, target: string, options: ClientOptions = {}): { request: ClientRequest; result: Promise<Result> } {
  const url = new URL(base), headers = ['Host', url.host, ...(options.headers ?? []), ...((options.headers??[]).some(x=>x.toLowerCase()==='connection')?[]:['Connection','keep-alive'])]
  if (options.body !== undefined && !headers.some((value, index) => index % 2 === 0 && value.toLowerCase() === 'content-length')) headers.push('Content-Length', String(options.body.length))
  let request!: ClientRequest
  const result = new Promise<Result>((resolve, reject) => {
    request = httpsRequest({ hostname: url.hostname, port: url.port, path: target, method: options.method ?? 'GET', headers,
      ca: identity.certificatePEM, agent: options.agent ?? false,
      ...(options.servername ? { servername: options.servername } : {}),
      ...(options.checkServerIdentity ? { checkServerIdentity: options.checkServerIdentity } : {}),
    }, response => {
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)))
      response.once('end', () => resolve({ socket:request.socket,reused:request.reusedSocket,status: response.statusCode ?? 0, body: Buffer.concat(chunks), rawHeaders: [...response.rawHeaders] }))
      response.once('error', reject); response.once('aborted', () => reject(new Error('合成响应已关闭。')))
    })
    request.once('error', reject); request.setTimeout(5000, () => request.destroy(new Error('合成请求等待已结束。')))
    request.end(options.body)
  })
  return { request, result }
}
const read = (base: string, target: string, options?: ClientOptions) => client(base, target, options).result
function png(size: number): Buffer {
  const chunk = (name: string, value: Buffer) => {
    const body = Buffer.concat([Buffer.from(name), value]); let crc = 0xffffffff
    for (const byte of body) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ crc >>> 1 : crc >>> 1 }
    const length = Buffer.alloc(4), sum = Buffer.alloc(4); length.writeUInt32BE(value.length); sum.writeUInt32BE((crc ^ 0xffffffff) >>> 0)
    return Buffer.concat([length, body, sum])
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.alloc((size * 4 + 1) * size))), chunk('IEND', Buffer.alloc(0))])
}

test('M29有效RED：两个完整成功GET应同一个TLS socket且第二次fresh backend',async t=>{
 let calls=0;const h=await fixture(t,{async dispatch(){calls++;return jsonReply(serverInfo());}});
 const agent=new Agent({keepAlive:true,maxSockets:1,agentKeepAliveTimeoutBuffer:0});t.after(()=>agent.destroy());
 const a=await read(h.baseUrl,'/mobile/v1/server',{agent}),b=await read(h.baseUrl,'/mobile/v1/server',{agent});
 assert.equal(calls,2);assert.equal(a.status,200);assert.equal(b.status,200);assert.ok(a.socket===b.socket,'两个响应必须来自同一个实际TLS socket');
});

const pooled=()=>new Agent({keepAlive:true,maxSockets:1,agentKeepAliveTimeoutBuffer:0});
const header=(r:Result,name:string)=>{const i=r.rawHeaders.findIndex((v,i)=>i%2===0&&v.toLowerCase()===name.toLowerCase());return i<0?undefined:r.rawHeaders[i+1];};
const mediaPath='/mobile/v1/media/resource.synthetic/file?ticket=synthetic-ticket-0000000001';
function mediaFactory(beforeClose:()=>Promise<void>=async()=>{},beforeSend:()=>Promise<void>=async()=>{}){
 let closes=0,dispatches=0;
 const playback:Mobile002Backend={resourceCapabilities:async()=>{throw new Error('未调用资源写入口');},async dispatch(){
  dispatches++;let read=false;
  return {kind:'media',operation:'getMediaAsset',status:206,headers:[['Content-Type','audio/wav'],['Content-Length','3'],['Content-Range','bytes 0-2/8'],['Accept-Ranges','bytes']],
   expectedBodyBytes:3,fullContentLength:8,rangeRequested:'bytes=0-2',ticketExpiresAtMs:Date.now()+60000,resourceAbortSignal:new AbortController().signal,
   beforeSend,reader:{async read(){if(read)return null;read=true;return new Uint8Array([1,2,3]);},async close(){closes++;await beforeClose();}}};
 }};return {playback,counts:()=>({closes,dispatches})};
}
async function raw(t:test.TestContext,base:string){
 const url=new URL(base),socket=tlsConnect({host:url.hostname,port:Number(url.port),ca:identity.certificatePEM});
 t.after(()=>socket.destroy());await once(socket,'secureConnect');let text='';socket.on('data',x=>{text+=String(x);});
 const closed=new Promise<void>((resolve,reject)=>{socket.once('close',()=>resolve());socket.once('error',reject);});
 // 未await前就登记错误消费，避免合成客户端主动取消时产生未处理拒绝。
 void closed.catch(()=>{});return {socket,closed,text:()=>text,host:url.host};
}
const requestText=(host:string,path='/mobile/v1/server',connection='keep-alive')=>`GET ${path} HTTP/1.1\r\nHost: ${host}\r\nConnection: ${connection}\r\n\r\n`;
async function bounded<T>(promise:Promise<T>,ms=3000):Promise<T>{let timer:ReturnType<typeof setTimeout>;try{return await Promise.race([promise,new Promise<T>((_,reject)=>{timer=setTimeout(()=>reject(new Error('合成事件未在deadline内达到。')),ms);})]);}finally{clearTimeout(timer!);}}

test('M29同socket protected capabilities第二次必须fresh鉴权：撤销及epoch变化仍拒绝并close',async t=>{
 for(const mode of ['revoke','epoch'] as const)await t.test(mode,async t=>{
  let current=true;const datasetId='50000000-0000-4000-8000-000000000001';let saved:any={kind:'missing',datasetId,revision:0};
  const service=createMobileBackend({serverId:identity.serverId,datasetId:'50000000-0000-4000-8000-000000000001',authKey:new Uint8Array(32).fill(7),displayName:'合成认证',environment:'development',
   assertCurrent(){if(!current)throw new MobileServiceError(503,'BUSY');},requestOwner:async request=>{if(request.kind==='load')return structuredClone(saved);if(request.kind==='save'){const q=request.request;assert.equal(q.expectedRevision,saved.revision);saved={kind:'sealed',datasetId,revision:q.expectedRevision+1,commitId:q.commitId,sealed:new Uint8Array(q.sealed)};return {kind:'saved',datasetId,revision:saved.revision,commitId:q.commitId};}throw new Error('不执行内容Owner读取');},resizeArtwork(){throw new Error('不读封面');}});
  t.after(()=>service.close());const permit=await service.auth.issuePairing();
  const pair=await service.auth.claim({pairingSecret:permit.pairingSecret,installationId:'installation.reuse',deviceName:'合成设备'},'reuse.original.intent');
  const h=await fixture(t,service.backend),agent=pooled();t.after(()=>agent.destroy());
  const options={agent,headers:['Authorization',`Bearer ${pair.accessToken}`]},first=await read(h.baseUrl,'/mobile/v1/capabilities',options);assert.equal(first.status,200);
  if(mode==='revoke')await service.auth.revokeDevice(pair.deviceId);else current=false;
  const second=await read(h.baseUrl,'/mobile/v1/capabilities',options);assert.ok(first.socket===second.socket,'第二次必须确实沿同socket读取新鉴权/代际');
  assert.equal(second.status,mode==='revoke'?401:503);assert.equal(header(second,'connection'),'close');
 });
});
test('M29连续16成功请求同TLS socket，第16条close，第17请求换socket而非放宽上限',async t=>{
 let calls=0;const h=await fixture(t,{async dispatch(){calls++;return jsonReply(serverInfo());}}),agent=pooled();t.after(()=>agent.destroy());
 let initial:unknown;
 for(let i=1;i<=16;i++){const x=await read(h.baseUrl,'/mobile/v1/server',{agent});if(i===1)initial=x.socket;assert.ok(initial===x.socket);assert.equal(x.status,200);assert.equal(header(x,'connection'),i===16?'close':'keep-alive');}
 const next=await read(h.baseUrl,'/mobile/v1/server',{agent});assert.ok(next.socket!==initial);assert.equal(calls,17);
});
test('M29真实pipeline17请求最多16backend，Node越限503不当业务BUSY',async t=>{
 let calls=0;const h=await fixture(t,{async dispatch(){calls++;return jsonReply(serverInfo());}}),x=await raw(t,h.baseUrl);
 x.socket.write(Array.from({length:17},()=>requestText(x.host)).join(''));await bounded(x.closed);
 assert.equal(calls,16);assert.equal((x.text().match(/HTTP\/1\.1 200/g)||[]).length,16);assert.equal((x.text().match(/HTTP\/1\.1 503/g)||[]).length,1);
});
test('M29原idle属性1秒自然回收，未将空闲连接永久保留',async t=>{
 const h=await fixture(t,{async dispatch(){return jsonReply(serverInfo());}}),agent=pooled();t.after(()=>agent.destroy());
 const x=await read(h.baseUrl,'/mobile/v1/server',{agent});assert.match(header(x,'keep-alive')??'',/^timeout=1,/);
 await bounded(once(x.socket as Socket,'close'),3500);assert.equal((x.socket as Socket).destroyed,true);
});
test('M29所有错误及客户端Connection close继续强制关连接',async t=>{
 const cases=[ [400,'INVALID_REQUEST'],[401,'UNAUTHORIZED'],[403,'DEVICE_REVOKED'],[409,'SOURCE_CHANGED'],[410,'RESOURCE_EXPIRED'],[413,'CONTENT_LIMIT_EXCEEDED'],[429,'RESOURCE_BUSY'],[503,'BUSY'] ] as const;
 for(const [status,code] of cases)await t.test(String(status),async t=>{
  const h=await fixture(t,{async dispatch(){throw new MobileServiceError(status,code);}}),agent=pooled();t.after(()=>agent.destroy());
  const x=await read(h.baseUrl,'/mobile/v1/server',{agent});assert.equal(x.status,status);assert.equal(header(x,'connection'),'close');
 });
 const h=await fixture(t,{async dispatch(){return jsonReply(serverInfo());}}),agent=pooled();t.after(()=>agent.destroy());
 const x=await read(h.baseUrl,'/mobile/v1/server',{agent,headers:['Connection','close']});assert.equal(x.status,200);assert.equal(header(x,'connection'),'close');
});
test('M29失败pipeline不能凭前request资格继续dispatch，未知错误正文也不泄漏',async t=>{
 let calls=0;const h=await fixture(t,{async dispatch(){calls++;throw new Error('PRIVATE_SYNTHETIC_MUST_NOT_ESCAPE');}}),x=await raw(t,h.baseUrl);
 x.socket.write(requestText(x.host)+requestText(x.host));await bounded(x.closed);assert.equal(calls,1);assert.doesNotMatch(x.text(),/PRIVATE_SYNTHETIC/);
});
test('M29未读完/超界/坏framing body继续close，后缀请求不作已授权业务',async t=>{
 for(const mode of ['oversize','length-and-te','partial'] as const)await t.test(mode,async t=>{
  let calls=0;const h=await fixture(t,{async dispatch(){calls++;return jsonReply(serverInfo());}}),x=await raw(t,h.baseUrl);
  const cl=mode==='oversize'?'999999999':'20';const extra=mode==='length-and-te'?'Transfer-Encoding: chunked\r\n':'';
  x.socket.write(`POST /mobile/v1/auth/refresh HTTP/1.1\r\nHost: ${x.host}\r\nConnection: keep-alive\r\nContent-Length: ${cl}\r\n${extra}\r\nx`);
  if(mode==='partial')x.socket.end();await bounded(x.closed);assert.equal(calls,0);
 });
});
test('M29两个精确Range仅一TLS socket，原beforeSend/真实close仍每请求执行',async t=>{
 let checks=0;const m=mediaFactory(async()=>{},async()=>{checks++;}),h=await fixture(t,{async dispatch(){return jsonReply(serverInfo());}},0,m.playback),agent=pooled();t.after(()=>agent.destroy());
 const opts={agent,headers:['Range','bytes=0-2']},a=await read(h.baseUrl,mediaPath,opts),b=await read(h.baseUrl,mediaPath,opts);
 assert.equal(a.status,206);assert.equal(b.status,206);assert.deepEqual(a.body,Buffer.from([1,2,3]));assert.ok(a.socket===b.socket);assert.deepEqual(m.counts(),{closes:2,dispatches:2});assert.ok(checks>=4);
});
test('M29真实media close held时，同socket后续业务不开始，其他socket可前进',async t=>{
 const held=deferred<void>(),entered=deferred<void>(),m=mediaFactory(async()=>{entered.resolve();await held.promise;}),getEntered=deferred<void>(),secondEntered=deferred<void>();let gets=0;
 t.after(()=>held.resolve());
 const h=await fixture(t,{async dispatch(){gets++;getEntered.resolve();if(gets===2)secondEntered.resolve();return jsonReply(serverInfo());}},0,m.playback),x=await raw(t,h.baseUrl);
 x.socket.write(requestText(x.host,mediaPath));await bounded(entered.promise);
 if(!x.text())await bounded(once(x.socket,'data'));
 assert.match(x.text(),/HTTP\/1\.1 206/); // 已进入真实close，完整CL body可能已给客户端。
 x.socket.write(requestText(x.host));
 // 同一TLS流上的后续可观测到达，通过gate状态由独立单元测试精确证明；其他socket真实可前进。
 const elsewhere=await read(h.baseUrl,'/mobile/v1/server');assert.equal(elsewhere.status,200);assert.equal(gets,1);
 held.resolve();await bounded(getEntered.promise);await bounded(secondEntered.promise);
 assert.equal(gets,2);assert.equal(m.counts().closes,1);x.socket.end();
});
test('M29media cleanup失败关闭socket且同socket排队业务零dispatch',async t=>{
 const entered=deferred<void>(),release=deferred<void>();let gets=0;
 t.after(()=>release.resolve());
 const m=mediaFactory(async()=>{entered.resolve();await release.promise;throw new Error('合成close失败');}),h=await fixture(t,{async dispatch(){gets++;return jsonReply(serverInfo());}},0,m.playback,true),x=await raw(t,h.baseUrl);
 x.socket.write(requestText(x.host,mediaPath));await bounded(entered.promise);x.socket.write(requestText(x.host));release.resolve();await bounded(x.closed.catch(error=>{assert.equal(error.code,'ECONNRESET');}));assert.equal(x.socket.destroyed,true);assert.equal(gets,0);assert.equal(m.counts().closes,1);
});
test('M29媒体416及真实read/authority错误不启用成功复用',async t=>{
 for(const mode of ['range','authority'] as const)await t.test(mode,async t=>{
  const m=mediaFactory(async()=>{},async()=>{if(mode==='authority')throw new MobileServiceError(410,'RESOURCE_EXPIRED');});
  const original=m.playback.dispatch;m.playback.dispatch=async input=>{const result=await original(input);if(mode==='range'&&result.kind==='media')return {...result,status:416,rangeRequested:'bytes=99-100',expectedBodyBytes:0,headers:[['Content-Length','0'],['Content-Range','bytes */8']]};return result;};
  const h=await fixture(t,{async dispatch(){return jsonReply(serverInfo());}},0,m.playback),agent=pooled();t.after(()=>agent.destroy());
  const result=await read(h.baseUrl,mediaPath,{agent,headers:['Range',mode==='range'?'bytes=99-100':'bytes=0-2']});assert.equal(result.status,mode==='range'?416:410);assert.equal(header(result,'connection'),'close');assert.equal(m.counts().closes,1);
 });
});
test('M29gate等待取消只清本项，失败状态至socket关闭，最多16且不同socket不串行',async t=>{
 const gate=createMobileHttpSocketGate(),socket=new Socket(),other=new Socket(),a=new AbortController(),b=new AbortController(),c=new AbortController();t.after(()=>{socket.destroy();other.destroy();});
 const one=gate.enter(socket,a.signal);await one.ready;const two=gate.enter(socket,b.signal),three=gate.enter(socket,c.signal);let started=false;void three.ready.then(()=>{started=true;});
 b.abort();await assert.rejects(two.ready);two.finish(false);assert.equal(started,false);
 const independent=gate.enter(other,new AbortController().signal);await independent.ready;independent.finish(true);
 one.finish(true);await three.ready;assert.equal(started,true);three.finish(false);assert.throws(()=>gate.enter(socket,new AbortController().signal));
 const fullSocket=new Socket();t.after(()=>fullSocket.destroy());const slots=[];
 for(let i=0;i<16;i++){const s=gate.enter(fullSocket,new AbortController().signal);void s.ready.catch(()=>{});slots.push(s);}assert.throws(()=>gate.enter(fullSocket,new AbortController().signal));slots[0]!.finish(false);
});

test('M29controls与media仍各16在途且互不借额度，另一lane可继续',async t=>{
 for(const lane of ['controls','media'] as const)await t.test(lane,async t=>{
  const release=deferred<void>(),entered=deferred<void>();let count=0;t.after(()=>release.resolve());
  const held=async()=>{count++;if(count===16)entered.resolve();await release.promise;};
  const m=mediaFactory();const actual=m.playback.dispatch;m.playback.dispatch=async input=>{if(lane==='media')await held();return actual(input);};
  const h=await fixture(t,{async dispatch(){if(lane==='controls')await held();return jsonReply(serverInfo());}},0,m.playback);
  const path=lane==='controls'?'/mobile/v1/server':mediaPath,other=lane==='controls'?mediaPath:'/mobile/v1/server';
  const requests=Array.from({length:16},()=>read(h.baseUrl,path));for(const request of requests)void request.catch(()=>{});
  await bounded(entered.promise);const blocked=await read(h.baseUrl,path);assert.equal(blocked.status,429);assert.equal(header(blocked,'connection'),'close');
  const allowed=await read(h.baseUrl,other);assert.equal(allowed.status,lane==='controls'?206:200);assert.equal(count,16);
  release.resolve();const responses=await Promise.all(requests);assert.ok(responses.every(x=>x.status===(lane==='controls'?200:206)));
 });
});
test('M29复用资格缺少body/end/complete/取消任一证明即关闭，默认sender不能授予复用',()=>{
 const request={complete:true,readableEnded:true,aborted:false} as Parameters<typeof canReuseMobileHttp>[0],signal=new AbortController();
 assert.equal(canReuseMobileHttp(request,true,signal.signal),true);assert.equal(canReuseMobileHttp(request,false,signal.signal),false);
 for(const key of ['complete','readableEnded'])assert.equal(canReuseMobileHttp({...request,[key]:false} as typeof request,true,signal.signal),false);
 assert.equal(canReuseMobileHttp({...request,aborted:true} as typeof request,true,signal.signal),false);signal.abort();assert.equal(canReuseMobileHttp(request,true,signal.signal),false);
 const response={shouldKeepAlive:false};assert.deepEqual(mobileHttpConnectionHeaders(response,200,true),[]);assert.equal(response.shouldKeepAlive,false);
 const error={shouldKeepAlive:true};assert.deepEqual(mobileHttpConnectionHeaders(error,503,true),['Connection','close']);assert.equal(error.shouldKeepAlive,false);
});

test('M29前response原写timeout不会误杀复用socket上下一次已在途请求',async t=>{
 const entered=deferred<void>();let calls=0;
 const h=await fixture(t,{async dispatch(){calls++;if(calls===2){entered.resolve();await new Promise<void>(resolve=>setTimeout(resolve,5200));}return jsonReply(serverInfo());}}),agent=pooled();t.after(()=>agent.destroy());
 const first=await read(h.baseUrl,'/mobile/v1/server',{agent});
 // 第二个合成客户端只放宽自身观察等待，不改变服务端15s请求预算。
 const url=new URL(h.baseUrl);const second=new Promise<Result>((resolve,reject)=>{
  let req:ClientRequest;req=httpsRequest({hostname:url.hostname,port:url.port,path:'/mobile/v1/server',ca:identity.certificatePEM,agent,headers:{Connection:'keep-alive'}},response=>{
   const chunks:Buffer[]=[];response.on('data',x=>chunks.push(Buffer.from(x)));response.once('end',()=>resolve({socket:req.socket,reused:req.reusedSocket,status:response.statusCode!,rawHeaders:response.rawHeaders,body:Buffer.concat(chunks)}));response.once('error',reject);
  });req.once('error',reject);req.end();
 });
 await bounded(entered.promise);const next=await bounded(second,6500);assert.ok(first.socket===next.socket);assert.equal(next.status,200);
});
