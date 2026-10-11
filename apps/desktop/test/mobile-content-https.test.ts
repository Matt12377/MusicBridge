import assert from 'node:assert/strict';
import test, { before, after } from 'node:test';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { request as httpsRequest } from 'node:https';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { MobileContentReadContext, MobileHeaderPairs, MobileWireCodecContext } from '@music-bridge/contracts';
import { createMobileHttpsServer } from '../src/main/mobile-https-server.js';
import { loadOrCreateMobileIdentity, type MobileTlsIdentity } from '../src/main/mobile-tls-identity.js';
import type { Mobile002Backend } from '../src/main/mobile-playback-backend.js';
import type { Mobile003Backend } from '../src/main/mobile-backend.js';
import type { MobileContentBackend } from '../src/main/mobile-content-backend.js';
import { MOBILE_CONTENT_OPERATIONS } from '../../../packages/bridge-core/src/mobile/content-types.js';
import { MobileServiceError, type Mobile001Backend } from '../../../packages/bridge-core/src/mobile/types.js';

// 真TLS/HTTP/原完整wire codec，内容端口仅为封存合同fixture；不冒充Auth/Owner/账号/设备证据。
interface BodyFile { fileName:string;bytes:number;sha256:string }
interface Row { operationId:string;role:string;context:string;method:string;path:string;
  request:{headers:MobileHeaderPairs;query:MobileHeaderPairs;body:BodyFile|null};response:{status:number;body:BodyFile} }
let identity:MobileTlsIdentity, owned='', manifest:{cases:Row[];contexts:Record<string,MobileWireCodecContext>};
const fixtures=new URL('../../../packages/contracts/mobile/fixtures/',import.meta.url);
before(async()=>{const parent=process.env.TMPDIR??os.tmpdir();if(process.platform==='darwin'&&!parent.startsWith('/Volumes/LifeWeave/Developer/CommandLine/tmp/'))throw new Error('测试必须使用外置临时目录。');
  owned=await mkdtemp(path.join(parent,'mbm004-https-'));const key=randomBytes(32);
  identity=await loadOrCreateMobileIdentity({directory:path.join(owned,'identity'),hosts:['127.0.0.1'],secretProtector:{
    encryptString(value){const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv),body=Buffer.concat([cipher.update(value,'utf8'),cipher.final()]);return Buffer.concat([iv,cipher.getAuthTag(),body]);},
    decryptString(value){const cipher=createDecipheriv('aes-256-gcm',key,value.subarray(0,12));cipher.setAuthTag(value.subarray(12,28));return Buffer.concat([cipher.update(value.subarray(28)),cipher.final()]).toString('utf8');}
  }});
  manifest=JSON.parse(await readFile(new URL('manifest.json',fixtures),'utf8'));
});
after(async()=>{if(owned)await rm(owned,{recursive:true,force:true});});
async function whole(file:BodyFile|null){if(!file)return Buffer.alloc(0);assert.match(file.fileName,/^bodies\/[A-Za-z0-9_.-]+$/u);
  const bytes=await readFile(new URL(file.fileName,fixtures));assert.equal(bytes.length,file.bytes);assert.equal(createHash('sha256').update(bytes).digest('hex'),file.sha256);return bytes;}
const unsupported=async()=>{throw new MobileServiceError(401,'UNAUTHORIZED');};
const backend:Mobile001Backend={dispatch:unsupported},playback:Mobile002Backend={dispatch:unsupported,resourceCapabilities:unsupported},dsd:Mobile003Backend={dispatch:unsupported};
async function read(base:string,row:Row){const url=new URL(base),body=await whole(row.request.body),query=new URLSearchParams(row.request.query.map(([k,v])=>[k,v]));
  return new Promise<{status:number;body:Buffer}>((resolve,reject)=>{const request=httpsRequest({hostname:url.hostname,port:url.port,
    path:row.path+(query.size?'?'+query.toString():''),method:row.method,ca:identity.certificatePEM,agent:false,
    headers:['Host',url.host,...row.request.headers.flat(),'Connection','close',...(body.length&&!row.request.headers.some(([k])=>k.toLowerCase()==='content-length')?['Content-Length',String(body.length)]:[])]},response=>{
      const chunks:Buffer[]=[];response.on('data',(b:Buffer)=>chunks.push(Buffer.from(b)));response.once('end',()=>resolve({status:response.statusCode??0,body:Buffer.concat(chunks)}));response.once('error',reject);});
    request.once('error',reject);request.setTimeout(5000,()=>request.destroy(new Error('合成HTTPS读取超时。')));request.end(body);});}
const paged=new Set(['listRecentlyAddedAlbums','listNeteaseLikedPlaylistTracks','listFavoriteAlbums','listFavoriteAlbumTracks','listPersonalPlaylists','listPersonalPlaylistTracks','listNeteaseRecommendedPlaylists','listNeteaseNewAlbums','listNeteaseCharts','getNeteaseDiscoveryCollectionTracks']);
test('十九内容路由在实际HTTPS注册，逐件保持封存请求与完整原响应',async t=>{let sends=0,calls=0;
  const content:MobileContentBackend={async dispatch(input){calls++;const row=manifest.cases.find(v=>v.operationId===input.operation&&v.role==='DECLARED_SUCCESS');assert.ok(row);
    assert.equal(input.request.path,row.path);const original=manifest.contexts[row.context]?.content;assert.ok(original);
    const context:MobileContentReadContext={...original,...(paged.has(input.operation)?{pageOffset:0}:{}),
      ...(['listNeteaseRecommendedPlaylists','listNeteaseCharts'].includes(input.operation)?{source:'netease' as const}:{})};
    const body=await whole(row.response.body);return{kind:'buffered',status:row.response.status,headers:[['Content-Type','application/json'],['Content-Length',String(body.length)]],
      body,contentContext:context,async beforeSend(){sends++;}};},async close(){}};
  const server=createMobileHttpsServer({tls:{key:identity.privateKeyPEM,cert:identity.certificatePEM},host:'127.0.0.1',port:0,backend,playback,dsd,content});t.after(()=>server.close());
  const listening=await server.start();for(const operation of MOBILE_CONTENT_OPERATIONS){const row=manifest.cases.find(v=>v.operationId===operation&&v.role==='DECLARED_SUCCESS');assert.ok(row);
    const reply=await read(listening.baseUrl,row);assert.equal(reply.status,row.response.status,operation);assert.deepEqual(JSON.parse(reply.body.toString('utf8')),JSON.parse((await whole(row.response.body)).toString('utf8')));}
  assert.equal(calls,19);assert.equal(sends,19);
});
test('旧001组合不开放内容，错排行榜kind不会由HTTPS重新包装成成功',async t=>{
  const row=manifest.cases.find(v=>v.operationId==='listNeteaseCharts'&&v.role==='DECLARED_SUCCESS');assert.ok(row);
  const old=createMobileHttpsServer({tls:{key:identity.privateKeyPEM,cert:identity.certificatePEM},host:'127.0.0.1',port:0,backend});t.after(()=>old.close());
  assert.equal((await read((await old.start()).baseUrl,row)).status,404);
  const context=manifest.contexts[row.context]?.content;assert.ok(context);
  const body=JSON.parse((await whole(row.response.body)).toString('utf8')) as {items:{kind:string}[]};body.items[0]!.kind='playlist';const bytes=Buffer.from(JSON.stringify(body));let sends=0;
  const content:MobileContentBackend={async dispatch(){return{kind:'buffered',status:200,headers:[['Content-Type','application/json'],['Content-Length',String(bytes.length)]],body:bytes,
    contentContext:{...context,source:'netease',pageOffset:0},async beforeSend(){sends++;}};},async close(){}};
  const server=createMobileHttpsServer({tls:{key:identity.privateKeyPEM,cert:identity.certificatePEM},host:'127.0.0.1',port:0,backend,playback,dsd,content});t.after(()=>server.close());
  const reply=await read((await server.start()).baseUrl,row);assert.equal(reply.status,503);assert.equal(sends,0);
});
