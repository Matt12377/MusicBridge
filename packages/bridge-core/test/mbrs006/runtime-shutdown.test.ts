import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import type {IpcCommand,IpcResponse} from '@music-bridge/contracts';
import {runCoreUtilityProcess,type UtilityPort,type DatasetOwnerFactory} from '../../src/utility-main.js';
import {BridgeController} from '../../src/application/bridge-controller.js';
import {RoonAudioInputAdapter} from '../../src/roon/adapter.js';
import {StreamGateway} from '../../src/stream/gateway.js';
import {ControlServer} from '../../src/control/server.js';
import {LocalFileSourcePool,type AssetLease} from '../../src/stream/local-file-source.js';
import {catalogFixture} from './catalog-fixture.js';
import {eventually} from '../mbrs005/fixture.js';
import {tick} from './adapter-fixture.js';
class Port implements UtilityPort {
 messages:unknown[]=[];listener?: (event:{data:unknown})=>void;
 on(_event:'message',listener:(event:{data:unknown})=>void){this.listener=listener;}start(){}postMessage(message:unknown){this.messages.push(message);}
 request(command:IpcCommand,payload:unknown={}){const id=randomUUID();this.listener!({data:{version:1,id,command,payload}});return id;}
 async response(id:string){await eventually(()=>this.messages.some(m=>(m as {id?:string}).id===id),'实际utility请求回应');return this.messages.find(m=>(m as {id?:string}).id===id) as IpcResponse;}
}
for(const failClose of [false,true])test(`006默认Node utility并发关闭/Owner fatal等待实际FD quiet${failClose?'，关闭拒绝保持同一失败':''}`,async t=>{
 const f=await catalogFixture(t),exits:unknown[]=[],port=new Port();let fatal!:()=>void,parent!: (event:{data:unknown;ports:UtilityPort[]})=>void,lease!:AssetLease;
 const descriptor=Object.getOwnPropertyDescriptor(process,'parentPort'),oldCode=process.exitCode;
 t.mock.method(process,'exit',((code?:unknown)=>{exits.push(code);}) as typeof process.exit);Object.defineProperty(process,'parentPort',{configurable:true,value:{once(_event:string,listener:typeof parent){parent=listener;}}});
 t.after(()=>{if(descriptor)Object.defineProperty(process,'parentPort',descriptor);else Reflect.deleteProperty(process,'parentPort');process.exitCode=oldCode;});
 for(const method of ['start','shutdown','stop'] as const)t.mock.method(RoonAudioInputAdapter.prototype,method,async()=>{});
 t.mock.method(RoonAudioInputAdapter.prototype,'getState',()=>({status:'ready',selectedZoneId:'synthetic-zone',transportState:'playing'}));
 t.mock.method(RoonAudioInputAdapter.prototype,'captureLocalTarget',()=>({target:f.requests[0]!.target,isCurrent:()=>true}));
 t.mock.method(RoonAudioInputAdapter.prototype,'play',async(request:Parameters<RoonAudioInputAdapter['play']>[0])=>{request.onDispatch?.();for(const event of ['SESSION','PLAYING'] as const)request.onLocalSession?.({event,generation:1,sessionId:'controlled-owned-session',isConfirmed:()=>true,isOwned:()=>true});});
 for(const method of ['start','stop'] as const){t.mock.method(StreamGateway.prototype,method,async()=>{});t.mock.method(ControlServer.prototype,method,async()=>{});}
 t.mock.method(StreamGateway.prototype,'localStreamUrl',()=> 'http://127.0.0.1:38502/local_stream/controlled-fixture');
 t.mock.method(StreamGateway.prototype,'iconUrl',()=> 'http://127.0.0.1:38502/assets/icon.png');
 const prepare=LocalFileSourcePool.prototype.prepare;t.mock.method(LocalFileSourcePool.prototype,'prepare',async function(this:LocalFileSourcePool,...args:Parameters<typeof prepare>){lease=await prepare.apply(this,args);return lease;});
 let failure:unknown;const playLocal=BridgeController.prototype.playLocal;t.mock.method(BridgeController.prototype,'playLocal',function(this:BridgeController,...args:Parameters<typeof playLocal>){return playLocal.apply(this,args).catch(error=>{failure={name:error.constructor.name,code:error.code,message:error.message};throw error;});});
 const factory:DatasetOwnerFactory=options=>{fatal=()=>options.onFatal('worker-exit');return {prepare:async()=>({epoch:f.epoch,datasetId:f.datasetId}),dispatch:async()=>{},commitBoot:async()=>{},close:async()=>{if(failClose)throw new Error('受控Owner关闭拒绝');},captureLocalSource:async request=>f.tickets.capture(request),revalidateLocalSource:async id=>f.tickets.revalidate(id),releaseLocalSource:async id=>f.tickets.release(id),isLocalSourceCurrent:()=>true,sealLocalSources:()=>f.tickets.seal()};};
 // 关闭Core test-mode：走真实createBridgeRuntime与实际Owner fatal handler；SDK/网络启动受控，不真退出或连接Roon。
 await runCoreUtilityProcess({MUSIC_BRIDGE_DATA_DIRECTORY:f.directory},undefined,undefined,undefined,undefined,factory);parent({data:{type:'musicbridge.core.port',playbackEventProtocol:'compact-v1'},ports:[port]});
 await eventually(()=>port.messages.some(m=>(m as {event?:string}).event==='core.ready'),'生产runtime已ready');const accepted=await port.response(port.request('localCatalog.prepare',f.requests[0]!));assert.equal(accepted.ok,true,JSON.stringify({accepted,failure}));
 let release!:()=>void,entered=false;const gate=new Promise<void>(resolve=>release=resolve),handle=(lease as unknown as {file:{handle:{read:(...args:unknown[])=>Promise<unknown>}}}).file.handle,read=handle.read;
 t.mock.method(handle,'read',async(...args:unknown[])=>{entered=true;await gate;return read.apply(handle,args);});
 const reading=lease.readSlice(0,f.bytes.length-1,new AbortController().signal).next();void reading.catch(()=>undefined);await eventually(()=>entered,'实际已打开FD的read被受控阻塞');
 const shutdownId=port.request('core.shutdown');await eventually(()=>lease.state==='CLOSING','正常shutdown正在join本地IO');
 try{fatal();await tick();await tick();assert.deepEqual(exits,[],'Owner fatal不得越过正常shutdown的固定FD quiet');assert.equal(lease.resourceSnapshot().activeIo,1);}
 finally{release();await reading.catch(()=>undefined);const result=await port.response(shutdownId);assert.equal(result.ok,!failClose);await eventually(()=>exits.includes(72),'FD quiet后实际fatal出口允许退出');}
 assert.equal(lease.state,'CLOSED');assert.equal(lease.resourceSnapshot().activeIo,0);
 const repeated=await port.response(port.request('core.shutdown'));assert.equal(repeated.ok,!failClose,'后续shutdown仍保留同一成功/拒绝收据');
});
