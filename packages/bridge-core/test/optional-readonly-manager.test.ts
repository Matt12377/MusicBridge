import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import type { IpcRequest } from '@music-bridge/contracts';
import type { DatasetOwnerVersionedSnapshotEndpoint } from '../src/collection/dataset-owner-protocol.js';
import { createOptionalRustReadonlyManager } from '../src/rust-core/optional-readonly-manager.js';
import type { RustReadonlyCollectionRouter, RustReadonlyCollectionRouterOptions } from '../src/rust-core/readonly-router.js';
import { RustSidecarError } from '../src/rust-core/readonly-sidecar.js';

function deferred<T>() { let resolve!: (value:T)=>void, reject!: (error:unknown)=>void; const promise = new Promise<T>((yes,no)=>{resolve=yes;reject=no}); return {promise,resolve,reject}; }
async function until(check:()=>boolean) { const deadline=performance.now()+2000; while(!check()) { if(performance.now()>deadline) throw new Error('受控等待超时'); await new Promise<void>(resolve=>setImmediate(resolve)); } }
const request: IpcRequest = { version:1,id:randomUUID(),command:'collection.list',payload:{page:{offset:0,limit:25}} };
function owner() {
  const calls={prepare:0,boot:0,close:0,dispatch:0,probe:0,export:0}; const version={epoch:randomUUID(),datasetId:randomUUID(),revision:randomUUID()};
  const source:DatasetOwnerVersionedSnapshotEndpoint={
    async prepare(){calls.prepare++;return version}, async commitBoot(){calls.boot++}, async close(){calls.close++},
    async dispatch(){calls.dispatch++;return 'node'}, async getCollectionSnapshotVersion(){calls.probe++;return version},
    async exportCollectionSnapshot(){calls.export++;return { ...version,snapshotId:randomUUID(),models:[] }},
    async exportVersionedCollectionSnapshot(){calls.export++;return {version,snapshot:{...version,snapshotId:randomUUID(),models:[]}}},
  }; return {source,calls};
}
function router(overrides:Partial<RustReadonlyCollectionRouter>={}) {
  let phase:'node'|'refreshing'|'rust'|'stale'|'failed'|'closed'='node'; const calls={refresh:0,close:0,invalidate:0,dispatch:0};
  const endpoint:RustReadonlyCollectionRouter={async dispatch(){calls.dispatch++;return 'rust'},async refresh(){calls.refresh++;phase='rust'},invalidate(){calls.invalidate++;phase='stale'}, getStatus(){return {phase,generation:1,epoch:randomUUID(),datasetId:randomUUID()}},async close(){calls.close++;phase='closed'},...overrides};
  return {endpoint,calls};
}
const options = { binary:{path:'/synthetic/pinned',sha256:'a'.repeat(64)},snapshotProfile:'v2-2000' as const };
async function fixture(createRouter?: (options:RustReadonlyCollectionRouterOptions)=>Promise<RustReadonlyCollectionRouter>, createOptions=async()=>options) {
  const o=owner();const manager=createOptionalRustReadonlyManager({createOptions, ...(createRouter?{createRouter}:{})}); const endpoint=manager.decorate(o.source); await endpoint.prepare();await endpoint.commitBoot();return {...o,manager,endpoint};
}

test('默认OFF零工厂/探测/导出，透明保留私有快照能力及唯一原作者生命周期',async()=>{
  let factories=0;const f=await fixture(undefined,async()=>{factories++;return options});
  assert.equal(await f.endpoint.dispatch(request),'node'); assert.equal(factories,0);assert.deepEqual(f.calls,{prepare:1,boot:1,close:0,dispatch:1,probe:0,export:0});
  assert.equal(typeof f.endpoint.exportVersionedCollectionSnapshot,'function');await f.endpoint.getCollectionSnapshotVersion();assert.equal(f.calls.probe,1);
  const close=f.endpoint.close();assert.equal(close,f.endpoint.close());await close;assert.equal(f.calls.close,1);
});
test('boot完成之前ON不能抢先解析能力；启用失败保留原Node读写',async()=>{
  const o=owner();let factories=0;const m=createOptionalRustReadonlyManager({createOptions:async()=>{factories++;throw new Error('合成准入拒绝')}});const e=m.decorate(o.source);
  assert.equal((await m.setEnabled(true)).state,'failed');assert.equal(factories,0);await e.prepare();await e.commitBoot();assert.equal((await m.setEnabled(true)).state,'failed');assert.equal(factories,1);
  assert.equal(await e.dispatch(request),'node');assert.equal(o.calls.close,0);await e.close();assert.equal(o.calls.close,1);
});
test('首次ON惰性factory和真实refresh；相同刷新单航班',async()=>{
  const r=router();let factories=0;const f=await fixture(async()=>r.endpoint,async()=>{factories++;return options});assert.equal((await f.manager.setEnabled(true)).mode,'rust');assert.equal(factories,1);assert.equal(r.calls.refresh,1);
  const a=f.manager.refresh();assert.equal(a,f.manager.refresh());assert.equal((await a).refreshed,true);assert.equal(r.calls.refresh,2);assert.equal(await f.endpoint.dispatch(request),'rust');await f.endpoint.close();
});
test('OFF同步撤权，等待close证明；再ON前禁止新factory，原Node仍可用',async()=>{
  const close=deferred<void>(),r=router({close(){r.calls.close++;return close.promise}});let creates=0;const f=await fixture(async()=>{creates++;return r.endpoint});await f.manager.setEnabled(true);
  const off=f.manager.setEnabled(false);assert.equal(f.manager.getStatus().mode,'node');assert.equal(r.calls.invalidate,1);assert.equal(await f.endpoint.dispatch(request),'node');const on=f.manager.setEnabled(true);await new Promise<void>(resolve=>setImmediate(resolve));assert.equal(creates,1);
  close.resolve();await off;await on;assert.equal(creates,2);await f.endpoint.close();assert.equal(f.calls.prepare,1);assert.equal(f.calls.boot,1);assert.equal(f.calls.close,1);
});
test('迟到factory不会在OFF后探测/建立，后续ON等旧登记完成',async()=>{
  const gate=deferred<typeof options>();let factories=0,creates=0;const f=await fixture(async()=>{creates++;return router().endpoint},async()=>{factories++;return gate.promise});const on=f.manager.setEnabled(true);await until(()=>factories===1);const off=f.manager.setEnabled(false);assert.equal(f.manager.getStatus().mode,'node');gate.resolve(options);await Promise.all([on,off]);assert.equal(creates,0);assert.equal(f.manager.getStatus().state,'off');await f.endpoint.close();
});
test('迟到router登记并自然关闭，迟到ON不能恢复发布权',async()=>{
  const gate=deferred<RustReadonlyCollectionRouter>(),r=router();let creates=0;const f=await fixture(async()=>{creates++;return gate.promise});const on=f.manager.setEnabled(true);await until(()=>creates===1);const off=f.manager.setEnabled(false);gate.resolve(r.endpoint);await Promise.all([on,off]);assert.equal(r.calls.close,1);assert.equal(r.calls.refresh,0);assert.equal(f.manager.getStatus().mode,'node');await f.endpoint.close();
});
test('关闭失败本Core永久blocked，重复endpoint.close仍同失败且Node只close一次',async()=>{
  const failure=new RustSidecarError('PROCESS_EXIT'),r=router({async close(){r.calls.close++;throw failure}});let creates=0;const f=await fixture(async()=>{creates++;return r.endpoint});await f.manager.setEnabled(true);assert.equal((await f.manager.setEnabled(false)).state,'blocked');assert.equal((await f.manager.setEnabled(true)).state,'blocked');assert.equal(creates,1);assert.equal(await f.endpoint.dispatch(request),'node');
  const close=f.endpoint.close();assert.equal(close,f.endpoint.close());await assert.rejects(close,error=>error===failure);await assert.rejects(f.endpoint.close(),error=>error===failure);assert.equal(r.calls.close,1);assert.equal(f.calls.close,1);
});
test('factory超时保留未确认任务并blocked，不重建；OFF仍立即node',async()=>{
  const never=deferred<typeof options>();let factories=0;const o=owner();const m=createOptionalRustReadonlyManager({operationTimeoutMs:20,createOptions:()=>{factories++;return never.promise}});const e=m.decorate(o.source);await e.prepare();await e.commitBoot();assert.equal((await m.setEnabled(true)).state,'blocked');assert.equal(factories,1);assert.equal((await m.setEnabled(true)).state,'blocked');assert.equal(m.getStatus().mode,'node');never.resolve(options);await m.setEnabled(false);await assert.rejects(e.close());assert.equal(o.calls.close,1);
});
test('OFF先于挂起refresh完成撤权，刷新结果不得冒充true',async()=>{
  const gate=deferred<void>();let refreshes=0;const r=router({async refresh(){refreshes++;if(refreshes>1)await gate.promise}});const f=await fixture(async()=>r.endpoint);await f.manager.setEnabled(true);const refresh=f.manager.refresh();const off=f.manager.setEnabled(false);assert.equal(f.manager.getStatus().mode,'node');gate.resolve();assert.equal((await refresh).refreshed,false);await off;await f.endpoint.close();
});
test('已经发送的Rust请求失败不透明重放Node',async()=>{
  const failure=new RustSidecarError('PROCESS_EXIT'),r=router({async dispatch(){throw failure}});const f=await fixture(async()=>r.endpoint);await f.manager.setEnabled(true);await assert.rejects(f.endpoint.dispatch(request),error=>error===failure);assert.equal(f.calls.dispatch,0);await f.endpoint.close();
});


test('工厂未spawn的准入失败可重新ON，Node作者身份与生命周期不重建', async()=>{
  let factories=0;const r=router();const f=await fixture(async()=>r.endpoint,async()=>{factories++;if(factories===1)throw new Error('合成资源暂不可用');return options});
  const first=await f.manager.setEnabled(true);assert.equal(first.state,'failed');assert.equal(first.enabled,true);assert.equal(first.mode,'node');assert.equal(r.calls.refresh,0);assert.equal(f.calls.close,0);
  const next=await f.manager.setEnabled(true);assert.equal(next.mode,'rust');assert.equal(factories,2);assert.equal(r.calls.refresh,1);assert.equal(f.calls.prepare,1);assert.equal(f.calls.boot,1);await f.endpoint.close();assert.equal(f.calls.close,1);
});


test('旧代延迟刷新不借给OFF后新ON；旧flight收口不清新代单航班',async()=>{
 const oldGate=deferred<void>(),newGate=deferred<void>();const old=router(),fresh=router();let oldRefreshes=0,newRefreshes=0,creates=0;
 const oldRefresh=old.endpoint.refresh.bind(old.endpoint);old.endpoint.refresh=async()=>{oldRefreshes++;if(oldRefreshes===1)return oldRefresh();await oldGate.promise};
 const freshRefresh=fresh.endpoint.refresh.bind(fresh.endpoint);fresh.endpoint.refresh=async()=>{newRefreshes++;if(newRefreshes===1)return freshRefresh();await newGate.promise};
 const f=await fixture(async()=>++creates===1?old.endpoint:fresh.endpoint);await f.manager.setEnabled(true);const stale=f.manager.refresh();await until(()=>oldRefreshes===2);await f.manager.setEnabled(false);assert.equal((await f.manager.refresh()).refreshed,false);
 assert.equal((await f.manager.setEnabled(true)).mode,'rust');assert.equal(creates,2);assert.equal(newRefreshes,1);const current=f.manager.refresh();assert.notEqual(current,stale);assert.equal(current,f.manager.refresh());await until(()=>newRefreshes===2);
 oldGate.resolve();assert.equal((await stale).refreshed,false);assert.equal(current,f.manager.refresh(),'旧flight finally不得清掉新flight');newGate.resolve();assert.equal((await current).refreshed,true);await f.endpoint.close();
});
