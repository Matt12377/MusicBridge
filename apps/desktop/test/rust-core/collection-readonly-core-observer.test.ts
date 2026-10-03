import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { assertCollectionReadonlyCoreObserverEnvironment, installCollectionReadonlyCoreObserver } from '../../src/main/collection-readonly-core-observer.js'
const stage='/Volumes/LifeWeave/Developer/CommandLine/tmp/mb-rust-core-014-w08_nmgh/author-c'
mkdirSync(stage,{recursive:true,mode:0o700})
function fixture() {
 const profile=mkdtempSync(path.join(stage,'musicbridge-ui-diagnostics-'));mkdirSync(path.join(profile,'data'),{mode:0o700})
 writeFileSync(path.join(profile,'rust014-profile.json'),JSON.stringify({schemaVersion:1,kind:'rust014-synthetic-profile',nonce:randomUUID()}),{flag:'wx',mode:0o600})
 return {env:{MUSIC_BRIDGE_CORE_TEST_MODE:'1',MUSIC_BRIDGE_UI_E2E:'1',MUSIC_BRIDGE_DATA_DIRECTORY:path.join(profile,'data')},profile}
}
const flag='__MUSIC_BRIDGE_COLLECTION_READONLY_DIAGNOSTICS__'
function compiled(value:boolean){Object.defineProperty(globalThis,flag,{value,writable:true,configurable:true})}
test('Core观察只接受编译true和原合成环境/profile nonce',()=>{
 const {env}=fixture();compiled(false);assert.throws(()=>assertCollectionReadonlyCoreObserverEnvironment(env));compiled(true)
 assert.doesNotThrow(()=>assertCollectionReadonlyCoreObserverEnvironment(env))
 for(const key of ['MUSIC_BRIDGE_CORE_TEST_MODE','MUSIC_BRIDGE_UI_E2E'])assert.throws(()=>assertCollectionReadonlyCoreObserverEnvironment({...env,[key]:'0'}))
 assert.throws(()=>assertCollectionReadonlyCoreObserverEnvironment({...env,MUSIC_BRIDGE_DATA_DIRECTORY:'/Users/yihe/Library/data'}))
})
test('原public首port保持一份bootstrap；OFF观察不提供控制/资源工厂',()=>{
 compiled(true);const {env}=fixture(),parent=new EventEmitter(),port=new EventEmitter(),posted:unknown[]=[],lines:string[]=[]
 Object.assign(port,{postMessage:(value:unknown)=>posted.push(value),start:()=>{}})
 const hooks=installCollectionReadonlyCoreObserver({env,parent:parent as any,getStatus:()=>({schemaVersion:1,enabled:false,mode:'node',state:'off'}),sink:line=>lines.push(line)})
 assert.deepEqual(Object.keys(hooks).sort(),['dependencies','emit','onObservation','onResourceValidated'])
 const bootstrap={data:{type:'musicbridge.core.port'},ports:[port]};parent.emit('message',bootstrap);assert.equal(bootstrap.ports.length,1)
 const request={version:1,id:randomUUID(),command:'collection.list',payload:{page:{offset:0,limit:24}}};port.emit('message',{data:request})
 const reply={version:1,id:request.id,ok:true,result:{items:[],offset:0,limit:24,total:0,hasMore:false}};(port as any).postMessage(reply)
 assert.equal(posted[0],reply);assert.equal(lines.some(x=>x.includes('controller')),false)
 assert.deepEqual(lines.map(line=>JSON.parse(line.slice('RUST014_EVIDENCE '.length)).event),['core.diagnosticsInstalled','core.publicPortObserved','core.publicRequest','core.publicReply'])
})
test('被动Owner保留原Promise/错误/私有快照能力且不会新增调用',async()=>{
 compiled(true);const {env}=fixture(),parent=new EventEmitter(),events:string[]=[]
 const hooks=installCollectionReadonlyCoreObserver({env,parent:parent as any,getStatus:()=>({schemaVersion:1,enabled:false,mode:'node',state:'off'}),sink:line=>events.push(JSON.parse(line.slice('RUST014_EVIDENCE '.length)).event)})
 const identity={epoch:randomUUID(),datasetId:randomUUID()},prepare=Promise.resolve(identity),boot=Promise.resolve(),closed=Promise.resolve(),result=Promise.resolve({items:[],offset:0,limit:24,total:0,hasMore:false}),version=Promise.resolve({...identity,revision:randomUUID()})
 const source:any={prepare:()=>prepare,commitBoot:()=>boot,close:()=>closed,dispatch:()=>result,getCollectionSnapshotVersion:()=>version}
 const wrapped=hooks.dependencies.decorateDatasetOwner!(source)
 assert.equal(events.length,1);assert.equal(wrapped.prepare(),prepare);assert.equal(wrapped.commitBoot(),boot)
 const request:any={version:1,id:randomUUID(),command:'collection.list',payload:{page:{offset:0,limit:24}}};assert.equal(wrapped.dispatch(request),result);assert.equal((wrapped as any).getCollectionSnapshotVersion(),version);assert.equal(wrapped.close(),closed)
 await Promise.resolve();assert.equal(events.filter(x=>x==='node.prepare').length,1);assert.equal(events.filter(x=>x==='node.closeCompleted').length,1)
 const error=new Error('原拒绝'),rejection=Promise.reject(error);source.dispatch=()=>rejection
 assert.equal(wrapped.dispatch(request),rejection);await assert.rejects(rejection,value=>value===error)
})
test('输出失败不能改变原公有postMessage或Owner回执',async()=>{
 compiled(true);const {env}=fixture(),parent=new EventEmitter(),port=new EventEmitter();let actual:unknown
 Object.assign(port,{postMessage:(value:unknown)=>{actual=value}})
 const hooks=installCollectionReadonlyCoreObserver({env,parent:parent as any,getStatus:()=>({schemaVersion:1,enabled:false,mode:'node',state:'off'}),sink:()=>{throw new Error('固定观察失败')}})
 parent.emit('message',{data:{type:'musicbridge.core.port'},ports:[port]});const ready={version:1,event:'core.ready',payload:{}};(port as any).postMessage(ready);assert.equal(actual,ready)
 const close=Promise.resolve(),wrapped=hooks.dependencies.decorateDatasetOwner!({prepare:()=>Promise.resolve({epoch:randomUUID(),datasetId:randomUUID()}),commitBoot:()=>Promise.resolve(),dispatch:()=>Promise.resolve({} as any),close:()=>close});assert.equal(wrapped.close(),close);await close
})
