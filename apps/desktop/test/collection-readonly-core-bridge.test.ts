import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { installCollectionReadonlyCoreBridge, type CollectionReadonlyCorePort } from '../src/main/collection-readonly-core-bridge.js'
import { isCollectionReadonlyControlRequest, isCollectionReadonlyControlResponse, isCollectionReadonlyPortMessage, isOptionalReadonlyStatus } from '../src/main/collection-readonly-control-protocol.js'
import type { OptionalReadonlyStatus, OptionalRustReadonlyManager } from '../../../packages/bridge-core/src/rust-core/optional-readonly-manager.js'
const status: OptionalReadonlyStatus={schemaVersion:1,enabled:false,mode:'node',state:'off'}
class Port extends EventEmitter { messages:unknown[]=[];started=0;closed=0;postMessage(data:unknown){this.messages.push(data)}start(){this.started++}close(){this.closed++;this.emit('close')} asPort(){return this as unknown as CollectionReadonlyCorePort} }
async function until(check:()=>boolean){const end=performance.now()+2000;while(!check()){if(performance.now()>end)throw new Error('私有端口未及时收口');await new Promise<void>(resolve=>setImmediate(resolve))}}
function fixture(){ const parent=new EventEmitter(),calls:boolean[]=[];const m:OptionalRustReadonlyManager={decorate:owner=>owner,getStatus:()=>status,async setEnabled(enabled){calls.push(enabled);return {...status,enabled}},async refresh(){return {refreshed:false,status}}};installCollectionReadonlyCoreBridge(m,parent);const publicPort=new Port();parent.emit('message',{data:{type:'musicbridge.core.port'},ports:[publicPort]});const bind=(port:Port,extra={})=>parent.emit('message',{data:{type:'musicbridge.collection-readonly.port',schemaVersion:1,generationNonce:nonce,...extra},ports:[port]});const nonce=randomUUID();return {parent,calls,m,publicPort,bind,nonce}; }
const header=()=>({schemaVersion:1 as const,generationNonce:randomUUID(),requestId:randomUUID()});
test('私有闭集拒绝额外字段、非UUID、getter、proxy与对象转换，不触发getter',()=>{
 const base={...header(),type:'status'};assert.equal(isCollectionReadonlyControlRequest(base),true);assert.equal(isCollectionReadonlyControlRequest({...base,enabled:false}),false);assert.equal(isCollectionReadonlyControlRequest({...base,path:'/bad'}),false);assert.equal(isCollectionReadonlyControlRequest({...base,requestId:'wrong'}),false);assert.equal(isCollectionReadonlyControlRequest({...base,type:'setEnabled',enabled:false}),true);assert.equal(isCollectionReadonlyControlRequest({...base,type:'setEnabled',enabled:'false'}),false);
 let sideEffects=0;const getter={...base};Object.defineProperty(getter,'type',{enumerable:true,get(){sideEffects++;return 'status'}});assert.equal(isCollectionReadonlyControlRequest(getter),false);assert.equal(isCollectionReadonlyControlRequest(new Proxy(base,{ownKeys(){sideEffects++;return []}})),false);assert.equal(isOptionalReadonlyStatus({...status,mode:{toString(){sideEffects++;return 'node'}}}),false);assert.equal(sideEffects,0);
 assert.equal(isCollectionReadonlyPortMessage({type:'musicbridge.collection-readonly.port',schemaVersion:1,generationNonce:base.generationNonce}),true);assert.equal(isCollectionReadonlyPortMessage({...base,type:'musicbridge.collection-readonly.port'}),false);
 assert.equal(isCollectionReadonlyControlResponse({...base,ok:true,status}),true);assert.equal(isCollectionReadonlyControlResponse({...base,ok:true,status:{...status,pid:123}}),false);assert.equal(isCollectionReadonlyControlResponse({...base,type:'refresh',ok:true,result:{refreshed:false,status}}),true);assert.equal(isCollectionReadonlyControlResponse({...base,ok:false,errorCode:'RUST_UNAVAILABLE',stack:'bad'}),false);
});
test('第二父消息只在原ready后绑定，一Core一端口，默认零set/refresh',async()=>{
 const f=fixture();f.publicPort.postMessage({event:'core.ready'});const port=new Port();f.bind(port);assert.equal(port.started,1);assert.deepEqual(f.calls,[]);const request={schemaVersion:1,generationNonce:f.nonce,requestId:randomUUID(),type:'status'};port.emit('message',{data:request});await until(()=>port.messages.length===1);assert.deepEqual(port.messages[0],{...request,ok:true,status});const second=new Port();f.bind(second);assert.equal(second.started,0);assert.equal(second.closed,1);assert.deepEqual(f.calls,[false]);
});
test('ready前绑定被拒并撤权，不能靠重连创建Rust',()=>{
 const f=fixture(),first=new Port();f.bind(first);assert.equal(first.started,0);assert.equal(first.closed,1);f.publicPort.postMessage({event:'core.ready'});const second=new Port();f.bind(second);assert.equal(second.started,0);assert.deepEqual(f.calls,[false]);
});
test('错nonce/重复request撤销Rust；端口close撤权，迟到结果不发',async()=>{
 const f=fixture();f.publicPort.postMessage({event:'core.ready'});const port=new Port();f.bind(port);port.emit('message',{data:{...header(),type:'status'}});assert.equal(port.closed,1);assert.deepEqual(f.calls,[false]);assert.equal(port.messages.length,0);
 const g=fixture();g.publicPort.postMessage({event:'core.ready'});const p=new Port();g.bind(p);let release!:(value:OptionalReadonlyStatus)=>void;g.m.setEnabled=enabled=>{g.calls.push(enabled);return enabled?new Promise(resolve=>{release=resolve}):Promise.resolve(status)};p.emit('message',{data:{schemaVersion:1,generationNonce:g.nonce,requestId:randomUUID(),type:'setEnabled',enabled:true}});p.close();release({...status,enabled:true});await new Promise<void>(resolve=>setImmediate(resolve));assert.deepEqual(g.calls,[true,false]);assert.equal(p.messages.length,0);
});
test('OFF并发先于迟到ON完成，桥不串行排队',async()=>{
 const f=fixture();f.publicPort.postMessage({event:'core.ready'});const p=new Port();f.bind(p);let release!:(value:OptionalReadonlyStatus)=>void;f.m.setEnabled=enabled=>{f.calls.push(enabled);return enabled?new Promise(resolve=>{release=resolve}):Promise.resolve(status)};
 const send=(enabled:boolean)=>p.emit('message',{data:{schemaVersion:1,generationNonce:f.nonce,requestId:randomUUID(),type:'setEnabled',enabled}});send(true);send(false);await until(()=>p.messages.length===1);assert.deepEqual(f.calls,[true,false]);release(status);await until(()=>p.messages.length===2);
});
