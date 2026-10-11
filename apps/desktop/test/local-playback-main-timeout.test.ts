import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { setTimeout as wait } from 'node:timers/promises';
import { IPC_VERSION, type LocalPlayRequest } from '@music-bridge/contracts';
import { CoreIpcError, CoreSupervisor, type CoreChildProcess, type CoreMessagePort } from '../src/main/core-supervisor.js';

// 受控Main/原IPC的期限与原回执围栏；不代表实际App、Roon提交或发声。
class Port implements CoreMessagePort {
  sent: unknown[] = []; listener?: (event: {data:unknown}) => void;
  on(_event: 'message', listener: (event:{data:unknown})=>void):void { this.listener=listener; }
  start():void {} close():void {} postMessage(message:unknown):void { this.sent.push(message); }
  receive(data:unknown):void { this.listener?.({data}); }
}
class Child implements CoreChildProcess {
  listeners: ((code:number)=>void)[] = [];
  postMessage():void {}
  once(_event:'exit',listener:(code:number)=>void):void {this.listeners.push(listener);}
  kill():boolean {this.exit();return true;}
  exit():void {for(const listener of this.listeners.splice(0))listener(0);}
}
async function harness(t:TestContext) {
  const channel={port1:new Port(),port2:new Port()},child=new Child();
  const supervisor=new CoreSupervisor({entryPath:new URL('../../../packages/bridge-core/dist/utility-main.js',import.meta.url).pathname,
    cwd:new URL('../../../packages/bridge-core/',import.meta.url).pathname,
    dependencies:{createChannel:()=>channel,fork:()=>child}});
  const starting=supervisor.start();
  channel.port2.receive({version:IPC_VERSION,event:'core.ready',payload:{state:{runtime:'ready',roon:'disconnected',provider:'missing',
    activeStreamCount:0,activePlaybackPresent:false}}});
  await starting;
  t.after(async()=>{const closing=supervisor.shutdown();child.exit();await closing;});
  return{supervisor,port:channel.port2,datasetId:randomUUID()};
}
const selection=():LocalPlayRequest=>({schema_version:'1.2',request_id:randomUUID(),route:'roon_audio_input',source_kind:'local_file',
  local_track_id:randomUUID(),asset_id:randomUUID(),expected_asset_revision:'1',target:{core_id:'owned.synthetic.core',zone_id:'owned.synthetic.zone'},action:'PLAY_NOW'});
const flush=()=>new Promise<void>(resolve=>setImmediate(resolve));
const last=(port:Port)=>port.sent.at(-1) as {id:string;command:string;payload:unknown;expectedDatasetId:string};

test('MBF001-A：本地点播超过两秒的原回执仍正常接收，原selection和请求ID不变',async t=>{
  const f=await harness(t),request=selection();let settled=false;
  const pending=f.supervisor.request('localCatalog.prepare',request,f.datasetId).then(result=>{settled=true;return{result};},error=>{settled=true;return{error};});
  const sent=last(f.port);assert.equal(sent.command,'localCatalog.prepare');assert.deepEqual(sent.payload,request);assert.equal(sent.expectedDatasetId,f.datasetId);
  await wait(2150);
  assert.equal(settled,false,'本地点播准备不能被普通两秒窗口提前判未知。');
  f.port.receive({version:IPC_VERSION,id:sent.id,ok:true,result:{status:'accepted',request_id:request.request_id,action:request.action}});
  assert.deepEqual(await pending,{result:{status:'accepted',request_id:request.request_id,action:request.action}});
  assert.equal(f.port.sent.filter(message=>(message as {command?:string}).command==='localCatalog.prepare').length,1);
});

test('MBF001-A：普通目录请求保留两秒期限，失败不提升为播放成功',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const f=await harness(t);
  const pending=f.supervisor.request('localCatalog.asset',{assetId:randomUUID()},f.datasetId).catch(error=>error);
  t.mock.timers.tick(2001);await flush();
  const result:unknown=await pending;assert.ok(result instanceof CoreIpcError);assert.equal(result.code,'TIMEOUT');
});

test('MBF001-A：原播放期限仍有界，错ID和超时后迟到成功不复活或重投',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const f=await harness(t),request=selection();let settled=false;
  const pending=f.supervisor.request('localCatalog.prepare',request,f.datasetId).then(result=>{settled=true;return{result};},error=>{settled=true;return{error};});
  const sent=last(f.port),result={status:'accepted',request_id:request.request_id,action:request.action};
  f.port.receive({version:IPC_VERSION,id:randomUUID(),ok:true,result});await flush();assert.equal(settled,false);
  t.mock.timers.tick(59999);await flush();assert.equal(settled,false);
  t.mock.timers.tick(2);await flush();const outcome=await pending;
  assert.ok('error' in outcome&&outcome.error instanceof CoreIpcError);assert.equal(outcome.error.code,'TIMEOUT');
  f.port.receive({version:IPC_VERSION,id:sent.id,ok:true,result});await flush();
  assert.ok('error' in outcome&&outcome.error instanceof CoreIpcError);
  assert.deepEqual(sent.payload,request);assert.equal(f.port.sent.filter(message=>(message as {command?:string}).command==='localCatalog.prepare').length,1);
});
