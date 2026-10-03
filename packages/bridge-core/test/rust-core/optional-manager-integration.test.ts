import assert from 'node:assert/strict';
import { createHash,randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp,stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { Worker } from 'node:worker_threads';
import type { CollectionModel,IpcRequest,Page } from '@music-bridge/contracts';
import { createDatasetOwnerClient } from '../../src/collection/dataset-owner-client.js';
import { createOptionalRustReadonlyManager } from '../../src/rust-core/optional-readonly-manager.js';
import { RustSidecarError, type RustSidecarObservation } from '../../src/rust-core/readonly-sidecar.js';
import { seedRustCollection } from '../helpers/rust-core-collection-fixture.js';
const binary={path:process.env.MUSIC_BRIDGE_RUST_BINARY??'',sha256:process.env.MUSIC_BRIDGE_RUST_SHA256??''};
assert.ok(path.isAbsolute(binary.path)&&/^[a-f0-9]{64}$/.test(binary.sha256),'实际014 Gate必须提供冻结二进制身份，不允许跳过。');
assert.equal(createHash('sha256').update(readFileSync(binary.path)).digest('hex'),binary.sha256);
const request=(command:IpcRequest['command'],payload:unknown,datasetId:string):IpcRequest=>({version:1,id:randomUUID(),command,payload,expectedDatasetId:datasetId});
async function until(check:()=>boolean){const deadline=performance.now()+5000;while(!check()){if(performance.now()>deadline)throw new Error('实际生命周期证据未及时到达');await new Promise<void>(resolve=>setImmediate(resolve));}}
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(yes=>{resolve=yes});return {promise,resolve}}
async function fixture(t:test.TestContext,killDispatch=false){
 const external='/Volumes/LifeWeave/Developer/CommandLine/tmp';assert.ok(os.tmpdir()===external||os.tmpdir().startsWith(external+path.sep));assert.notEqual((await stat('/Volumes/LifeWeave')).dev,(await stat('/')).dev);
 const directory=await mkdtemp(path.join(os.tmpdir(),'rust014-optional-'));const worker=new Worker(new URL('../helpers/dataset-owner-version-fixture.ts',import.meta.url),{execArgv:['--import',new URL('../../node_modules/tsx/dist/loader.mjs',import.meta.url).pathname],workerData:{dataDirectory:directory}});
 let nodeExit:number|undefined;worker.once('exit',code=>{nodeExit=code});const fatals:string[]=[],source=createDatasetOwnerClient({worker,onFatal:code=>fatals.push(code)});const observations:RustSidecarObservation[]=[];let killed=false;let factories=0;const calls={prepare:0,boot:0,close:0,probe:0,export:0,dispatch:0};
 let heldExport:ReturnType<typeof deferred<void>>|undefined,releaseExport:(()=>void)|undefined,exportEntered=false;
 const observed={...source,prepare(){calls.prepare++;return source.prepare()},commitBoot(){calls.boot++;return source.commitBoot()},close(){calls.close++;return source.close()},getCollectionSnapshotVersion(){calls.probe++;return source.getCollectionSnapshotVersion()},async exportVersionedCollectionSnapshot(){calls.export++;if(heldExport){const held=heldExport;heldExport=undefined;exportEntered=true;await held.promise}return source.exportVersionedCollectionSnapshot()},dispatch(input:IpcRequest){calls.dispatch++;return source.dispatch(input)}};
 const manager=createOptionalRustReadonlyManager({createOptions:async()=>{factories++;return {binary,snapshotProfile:'v2-2000',onObservation:value=>{observations.push(value);if(killDispatch&&!killed&&value.event==='request'&&value.frame.operation==='dispatch'&&value.pid){killed=true;process.kill(value.pid,'SIGKILL')}}}}});const endpoint=manager.decorate(observed);const identity=await endpoint.prepare();await endpoint.commitBoot();const database=path.join(directory,'collection.v1.sqlite');seedRustCollection(database,26);
 const list=request('collection.list',{page:{offset:0,limit:100}},identity.datasetId);const nodePage=await source.dispatch(list) as Page<CollectionModel>;
 t.after(async()=>{await endpoint.close().catch(()=>{});if(nodeExit===undefined)await until(()=>nodeExit!==undefined)});
 return {manager,endpoint,source,calls,observations,list,nodePage,identity,directory,database,holdNextExport(){const gate=deferred<void>();heldExport=gate;exportEntered=false;releaseExport=()=>gate.resolve()},releaseExport(){releaseExport?.()},get exportEntered(){return exportEntered},get factories(){return factories},get nodeExit(){return nodeExit},fatals};
}

test('实际原Node默认零能力→ON Rust→原写失效→普通刷新→OFF/ON，自然收口与两库持久事实', {timeout:30000},async t=>{
 const f=await fixture(t);assert.deepEqual(await f.endpoint.dispatch(f.list),f.nodePage);assert.equal(f.factories,0);assert.equal(f.calls.probe,0);assert.equal(f.calls.export,0);assert.equal(f.observations.length,0);
 assert.equal((await f.manager.setEnabled(true)).mode,'rust');assert.equal(f.factories,1);assert.equal(f.observations.filter(v=>v.event==='spawn').length,1);assert.deepEqual(await f.endpoint.dispatch(f.list),f.nodePage);
 const first=f.nodePage.items[0]!;await f.endpoint.dispatch(request('collection.setPolicy',{commandId:randomUUID(),modelId:first.id,expectedRevision:first.revision,collectorPolicy:'collector',minimumSealedReserve:1},f.identity.datasetId));assert.equal(f.manager.getStatus().state,'stale');assert.equal(f.manager.getStatus().mode,'node');const after=await f.endpoint.dispatch(f.list) as Page<CollectionModel>;assert.equal(after.items[0]!.collectorPolicy,'collector');assert.equal(after.items[0]!.revision,2);
 const refresh=f.manager.refresh();assert.equal(refresh,f.manager.refresh());assert.equal((await refresh).refreshed,true);assert.deepEqual(await f.endpoint.dispatch(f.list),after);
 const off=f.manager.setEnabled(false);assert.equal(f.manager.getStatus().mode,'node');assert.equal((await off).state,'off');assert.equal((await f.manager.setEnabled(true)).mode,'rust');assert.deepEqual(await f.endpoint.dispatch(f.list),after);
 const close=f.endpoint.close();assert.equal(close,f.endpoint.close());await close;await until(()=>f.nodeExit!==undefined);assert.equal(f.nodeExit,0);assert.deepEqual(f.fatals,[]);assert.deepEqual({prepare:f.calls.prepare,boot:f.calls.boot,close:f.calls.close},{prepare:1,boot:1,close:1});
 const exits=f.observations.filter(v=>v.event==='exit');assert.equal(exits.length,3);assert.ok(exits.every(v=>v.event==='exit'&&v.code===0&&v.signal===null&&v.closeAcknowledged&&v.pendingRequests===0));assert.equal(f.observations.filter(v=>v.event==='kill-request').length,0);
 const db=new DatabaseSync(f.database,{readOnly:true});try{assert.equal((db.prepare('SELECT COUNT(*) AS amount FROM collection_models').get() as {amount:number}).amount,26);assert.equal((db.prepare('SELECT revision FROM collection_models WHERE id=?').get(first.id) as {revision:number}).revision,2);}finally{db.close()}
 assert.ok((await stat(path.join(f.directory,'backup-maintenance.v1.sqlite'))).isFile());t.diagnostic(JSON.stringify({schemaVersion:1,binarySha256:binary.sha256,directory:f.directory,nodeNaturalExit:f.nodeExit,actualNativeExits:exits,calls:f.calls,factories:f.factories,realServices:'NOT_RUN',App:'NOT_RUN',Owner:'NOT_RUN'}));
});

test('实际非自然Rust退出永久blocked，Node继续查询，endpointclose失败不可第二次改成功', {timeout:30000},async t=>{
 const f=await fixture(t);assert.equal((await f.manager.setEnabled(true)).mode,'rust');const spawn=f.observations.find(v=>v.event==='spawn');assert.ok(spawn&&spawn.event==='spawn'&&spawn.pid);process.kill(spawn.pid,'SIGKILL');await until(()=>f.observations.some(v=>v.event==='exit'));assert.equal(f.manager.getStatus().state,'blocked');assert.equal((await f.manager.setEnabled(true)).state,'blocked');assert.equal(f.factories,1);assert.deepEqual(await f.endpoint.dispatch(f.list),f.nodePage);
 const close=f.endpoint.close();assert.equal(close,f.endpoint.close());await assert.rejects(close);await assert.rejects(f.endpoint.close());await until(()=>f.nodeExit!==undefined);assert.equal(f.nodeExit,0);assert.equal(f.calls.close,1);assert.equal(f.observations.filter(v=>v.event==='spawn').length,1);t.diagnostic(JSON.stringify({binarySha256:binary.sha256,nodeNaturalExit:f.nodeExit,nativeNegativeExit:f.observations.filter(v=>v.event==='exit'),newSpawnAfterFailure:false,realServices:'NOT_RUN',App:'NOT_RUN',Owner:'NOT_RUN'}));
});


test('实际已发Rust读取遇进程退出保留原PROCESS_EXIT，不透明重投Node', {timeout:30000},async t=>{
 const f=await fixture(t,true);assert.equal((await f.manager.setEnabled(true)).mode,'rust');const nodeReads=f.calls.dispatch;
 await assert.rejects(f.endpoint.dispatch(f.list),error=>error instanceof RustSidecarError&&error.code==='PROCESS_EXIT');assert.equal(f.calls.dispatch,nodeReads);assert.equal(f.manager.getStatus().state,'blocked');assert.equal(f.factories,1);
 assert.deepEqual(await f.endpoint.dispatch(f.list),f.nodePage);assert.equal(f.calls.dispatch,nodeReads+1);await assert.rejects(f.endpoint.close());await until(()=>f.nodeExit!==undefined);assert.equal(f.nodeExit,0);assert.equal(f.calls.close,1);
 t.diagnostic(JSON.stringify({binarySha256:binary.sha256,firstRustFailure:'PROCESS_EXIT',transparentNodeRetry:0,nextNodeRead:1,nodeNaturalExit:f.nodeExit,nativeNegativeExit:f.observations.filter(v=>v.event==='exit'),App:'NOT_RUN',realServices:'NOT_RUN',Owner:'NOT_RUN'}));
});


test('实际延迟版本快照导出期间OFF同步撤权，新ON等旧router真实收口并建立新快照', {timeout:30000},async t=>{
 const f=await fixture(t);assert.equal((await f.manager.setEnabled(true)).mode,'rust');f.holdNextExport();const stale=f.manager.refresh();await until(()=>f.exportEntered);const off=f.manager.setEnabled(false);assert.equal(f.manager.getStatus().mode,'node');assert.equal((await f.manager.refresh()).refreshed,false);assert.deepEqual(await f.endpoint.dispatch(f.list),f.nodePage);const on=f.manager.setEnabled(true);
 await new Promise<void>(resolve=>setImmediate(resolve));assert.equal(f.factories,1);assert.equal(f.observations.filter(v=>v.event==='spawn').length,1);f.releaseExport();assert.equal((await stale).refreshed,false);await off;assert.equal((await on).mode,'rust');assert.equal(f.factories,2);assert.equal(f.calls.export,3);assert.deepEqual(await f.endpoint.dispatch(f.list),f.nodePage);
 await f.endpoint.close();await until(()=>f.nodeExit!==undefined);assert.equal(f.nodeExit,0);assert.deepEqual({prepare:f.calls.prepare,boot:f.calls.boot,close:f.calls.close},{prepare:1,boot:1,close:1});const exits=f.observations.filter(v=>v.event==='exit');assert.equal(exits.length,2);assert.ok(exits.every(v=>v.event==='exit'&&v.code===0&&v.signal===null&&v.closeAcknowledged&&v.pendingRequests===0));t.diagnostic(JSON.stringify({binarySha256:binary.sha256,delayedVersionedExport:true,oldRefreshPublished:false,newOnFreshSnapshot:true,nodeNaturalExit:f.nodeExit,nativeNaturalExits:exits,calls:f.calls,App:'NOT_RUN',Owner:'NOT_RUN',realServices:'NOT_RUN'}));
});
