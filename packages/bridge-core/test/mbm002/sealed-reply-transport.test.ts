import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { MessageChannel } from 'node:worker_threads';
import { randomUUID } from 'node:crypto';
import { encodeMobileSealedOwnerReply, encodeMobileSealedCoreReply, attachMobileSealedOwnerReplyReceiver,
  attachMobileSealedCoreReplyReceiver, captureMobileSealedReplyFromPort } from '../../src/mobile/sealed-request-transport.js';
import { captureMobileOwnerPrivateResult, captureMobileCorePrivateReply } from '../../src/mobile/owner-boundary-capture.js';
import { isMobileCorePrivateReply, isMobileOwnerPrivateResult, type MobileCorePrivateCall } from '../../src/mobile/owner-protocol.js';
import { allocateOwnedSealedBytes, ownedSealedByteLength } from '../../src/mobile/owned-sealed-bytes.js';
import { MOBILE_AUTH_SEALED_MAX_BYTES, type MobileOwnerPrivateResult } from '../../src/mobile/types.js';

const datasetId='50000000-0000-4000-8000-000000000052';
const call=():MobileCorePrivateCall=>({type:'mobile-main-request',id:randomUUID(),request:{kind:'load',datasetId}});
const sealed=(bytes:unknown)=>({kind:'sealed',datasetId,revision:1,commitId:randomUUID(),sealed:bytes});
const reply=(c:MobileCorePrivateCall,bytes:unknown)=>({type:'mobile-main-response',id:c.id,result:sealed(bytes)});
type Wire={type:string;id:string;result:{kind:string;datasetId:string;revision:number;commitId:string;sealed:{schema:string;buffer:ArrayBuffer;byteOffset:number;byteLength:number}}};
function wire(c=call()):Wire{return encodeMobileSealedCoreReply(reply(c,allocateOwnedSealedBytes(8)),c)as Wire;}
function emit(value:unknown,listener:(value:unknown)=>void){const events=new EventEmitter();attachMobileSealedCoreReplyReceiver({on(_event,receive){events.on('message',receive);}},event=>listener(event.data));events.emit('message',{data:value});}

test('M52旧raw完整资格不升级；新wire旧reader拒绝，缺失/error原形不变',()=>{
 const c=call();let getters=0,traps=0;
 const bad=[Object.assign(new Uint8Array(8),{extra:1}),Object.defineProperty(new Uint8Array(8),'extra',{get(){getters++;return 1;}}),new Proxy(new Uint8Array(8),{getPrototypeOf(){traps++;throw Error('不应调用');}}),new Uint8Array(new SharedArrayBuffer(8)),Buffer.alloc(8),new Uint8Array(0)];
 for(const bytes of bad){const value=reply(c,bytes);assert.equal(isMobileCorePrivateReply(value,c),false);assert.throws(()=>encodeMobileSealedCoreReply(value,c));emit(value,decoded=>assert.equal(captureMobileCorePrivateReply(decoded,c),null));}
 const value=wire(c);assert.equal(isMobileCorePrivateReply(value,c),false);assert.equal(captureMobileCorePrivateReply(value,c),null);assert.equal(captureMobileSealedReplyFromPort(value.result),null);
 const missing={type:'mobile-main-response',id:c.id,result:{kind:'missing',datasetId,revision:0}};assert.equal(encodeMobileSealedCoreReply(missing,c),missing);
 const error={type:'mobile-main-response',id:c.id,result:{kind:'mobile-error',status:503,code:'BUSY',retryable:false,outcome:'unknown'}};assert.equal(encodeMobileSealedCoreReply(error,c),error);
 assert.equal(getters,0);assert.equal(traps,0);
});

test('M52合法raw legacy仍完整复制，不能借已有对象品牌或共享底层存储',()=>{
 const c=call(),raw=new Uint8Array(8).fill(7),value=reply(c,raw);
 emit(value,decoded=>{const result=captureMobileCorePrivateReply(decoded,c);assert.ok(result&&'kind'in result.result&&result.result.kind==='sealed');raw.fill(0);assert.ok(result.result.sealed.every(n=>n===7));assert.equal(ownedSealedByteLength(result.result.sealed,MOBILE_AUTH_SEALED_MAX_BYTES),8);});
});

test('M52wire固定buffer严拒detach/Shared/resize/伪造/Proxy/getter/extra及越界，不执行访问器',()=>{
 let getters=0,traps=0;const detached=new ArrayBuffer(8);structuredClone(detached,{transfer:[detached]});
 const bad=[Object.create(ArrayBuffer.prototype),detached,new SharedArrayBuffer(8),Reflect.construct(ArrayBuffer,[8,{maxByteLength:16}]),new Proxy(new ArrayBuffer(8),{ownKeys(){traps++;throw Error('不应调用');}}),Object.assign(new ArrayBuffer(8),{extra:1}),Object.defineProperty(new ArrayBuffer(8),'byteLength',{get(){getters++;return 8;}}),new Uint8Array(8),new ArrayBuffer(0),new ArrayBuffer(MOBILE_AUTH_SEALED_MAX_BYTES+1)];
 for(const buffer of bad){const c=call(),v=wire(c);Object.defineProperty(v.result.sealed,'buffer',{value:buffer,enumerable:true});emit(v,x=>assert.equal(captureMobileCorePrivateReply(x,c),null));}
 for(const [key,value]of [['schema','错误'],['byteOffset',1],['byteOffset',-1],['byteLength',7],['byteLength',9],['byteLength',NaN]]as const){const c=call(),v=wire(c);Object.defineProperty(v.result.sealed,key,{value,enumerable:true});emit(v,x=>assert.equal(captureMobileCorePrivateReply(x,c),null));}
 for(const key of ['schema','buffer','byteOffset','byteLength']){const c=call(),v=wire(c);Object.defineProperty(v.result.sealed,key,{get(){getters++;return 8;},enumerable:true});emit(v,x=>assert.equal(captureMobileCorePrivateReply(x,c),null));}
 const c=call(),v=wire(c);Object.defineProperty(v.result.sealed,'extra',{value:1});emit(v,x=>assert.equal(captureMobileCorePrivateReply(x,c),null));
 assert.equal(getters,0);assert.equal(traps,0);
});

test('M52原metadata/真实pending绑定不被wire清洗：错dataset/id/revision/commit/extra拒绝',()=>{
 const mutations=[(v:Wire)=>{v.id=randomUUID();},(v:Wire)=>{v.result.datasetId='different.dataset';},(v:Wire)=>{v.result.revision=0;},(v:Wire)=>{v.result.commitId='invalid';},(v:Wire)=>{Object.defineProperty(v.result,'extra',{value:1});},(v:Wire)=>{Object.setPrototypeOf(v.result,{});},(v:Wire)=>{Object.defineProperty(v,'extra',{value:1});}];
 for(const mutate of mutations){const c=call(),v=wire(c);mutate(v);emit(v,x=>assert.equal(captureMobileCorePrivateReply(x,c),null));}
});

test('M52端口capture只一次且不能跨await/晚回收口；消费时重核buffer，复制不别名',async()=>{
 const c=call(),v=wire(c);new Uint8Array(v.result.sealed.buffer).fill(52);let kept:Uint8Array|undefined;
 emit(v,x=>{const p=captureMobileCorePrivateReply(x,c);assert.ok(p&&'kind'in p.result&&p.result.kind==='sealed');kept=p.result.sealed;assert.equal(kept.byteLength,8);assert.equal(Object.isExtensible(kept),false);new Uint8Array(v.result.sealed.buffer).fill(0);assert.ok(kept.every(n=>n===52));assert.equal(captureMobileCorePrivateReply(x,c),null);});
 let late:unknown;emit(wire(c),x=>{late=x;});await new Promise<void>(done=>setImmediate(done));assert.equal(captureMobileCorePrivateReply(late,c),null);
 const changing=wire(c);emit(changing,x=>{structuredClone(changing.result.sealed.buffer,{transfer:[changing.result.sealed.buffer]});assert.equal(captureMobileCorePrivateReply(x,c),null);});assert.ok(kept?.every(n=>n===52));
});

test('M52未命中pending时不分配大owned副本；listener退出即清理wire资格',()=>{
 const c=call(),bytes=allocateOwnedSealedBytes(90112),value=encodeMobileSealedCoreReply(reply(c,bytes),c);const original=Object.preventExtensions;let large=0,late:unknown;
 Object.preventExtensions=<T>(v:T):T=>{if(v instanceof Uint8Array&&v.byteLength===90112)large++;return original(v);};
 try{emit(value,x=>{late=x;/* 原handler没有命中pending，直接返回。 */});assert.equal(large,0);assert.equal(captureMobileCorePrivateReply(late,c),null);assert.equal(large,0);}finally{Object.preventExtensions=original;}
});

test('M52真实Owner端口严格捕获且detach listener后不再升级wire；legacy与新wire同时兼容',async()=>{
 const channel=new MessageChannel(),request={kind:'load'as const,datasetId},bytes=allocateOwnedSealedBytes(8);bytes.fill(64);
 const value={version:1,type:'response',epoch:randomUUID(),requestId:randomUUID(),operation:'mobileMain',ok:true,result:sealed(bytes)};
 const encoded=encodeMobileSealedOwnerReply(value,request);bytes.fill(0);let count=0;let finish!:(v:MobileOwnerPrivateResult)=>void;const ready=new Promise<MobileOwnerPrivateResult>(done=>{finish=done;});
 const detach=attachMobileSealedOwnerReplyReceiver(channel.port2,x=>{count++;assert.ok(x&&typeof x==='object'&&'result'in x);const result=captureMobileOwnerPrivateResult(x.result,request);assert.ok(result&&isMobileOwnerPrivateResult(result,request));finish(result);});
 try{channel.port1.postMessage(encoded);const result=await ready;assert.ok('kind'in result&&result.kind==='sealed');assert.ok(result.sealed.every(n=>n===64));detach();channel.port1.postMessage(encoded);await new Promise<void>(done=>setImmediate(done));assert.equal(count,1);}finally{channel.port1.close();channel.port2.close();}
});
