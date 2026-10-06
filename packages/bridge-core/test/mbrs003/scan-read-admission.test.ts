import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { fstatSync } from 'node:fs';
import { createScanReadAdmission, ScanReadAdmissionError, type ScanReadAdmission, type ScanReadContext } from '../../src/library/scan-read-admission.js';
import { BridgeController } from '../../src/application/bridge-controller.js';
import { StreamGateway } from '../../src/stream/gateway.js';
import { StreamRegistry } from '../../src/stream/registry.js';
import { NeteaseClient } from '../../src/netease/client.js';
import { createBridgeRuntime } from '../../src/runtime.js';
import { RoonAudioInputAdapter } from '../../src/roon/adapter.js';
import { ControlServer } from '../../src/control/server.js';
import { createLocalFavoriteRepository } from '../../src/favorites/repository.js';
import type { RoonSdk } from '../../src/roon/sdk.js';
import { createLogger } from '../../src/shared/logger.js';
import { readonlySourceCandidateMetadata } from '../../src/recording/source-files.js';
import type { RoonPort, RoonState, RoonTerminalReason } from '../../src/roon/types.js';
import type { MetadataReaderLifecycle } from '../../src/library/metadata-reader-types.js';
import { audioFixture, loadFreshMetadataReader } from '../helpers/mbrs003-audio-fixtures.js';

const { createMetadataReader } = await loadFreshMetadataReader();
const context = (): ScanReadContext => ({ epoch: randomUUID(), datasetId: randomUUID() });
const permit = (admission: ScanReadAdmission, scope: ScanReadContext): string => {
  const result = admission.acquire(scope); assert.equal(result.status, 'granted');
  if (result.status !== 'granted') assert.fail('许可未发出'); return result.permitId;
};
const turn = (): Promise<void> => new Promise(resolve => setImmediate(resolve));
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }

test('MBRS003私有读取票据最多2个，撤销不提前扣槽，实际释放后才准新读', async () => {
  let busy = false; const admission = createScanReadAdmission({ isBusy: () => busy }), scope = context();
  const first = permit(admission,scope), second = permit(admission,scope), watch = admission.watchRevocation(scope,first);
  assert.deepEqual(admission.acquire(scope), { status: 'deferred' });
  busy = true; admission.observe(); assert.deepEqual(await watch, { reason: 'media-busy' });
  busy = false; assert.deepEqual(admission.acquire(scope), { status: 'deferred' });
  assert.equal(admission.resourceCounts().permits,2); admission.release(scope,first);
  const next = permit(admission,scope); admission.release(scope,next); admission.release(scope,second); admission.close();
  assert.deepEqual(admission.resourceCounts(), { permits:0,revoked:0,watches:0,timers:0,closed:true });
});
test('MBRS003 acquire与watch之间已经繁忙也撤销；旧epoch不能watch或release新票', async () => {
  let busy = false; const admission = createScanReadAdmission({ isBusy: () => busy }), scope = context(), id = permit(admission,scope);
  busy = true; assert.deepEqual(await admission.watchRevocation(scope,id), { reason:'media-busy' });
  const old = { ...scope,epoch:randomUUID() };
  assert.throws(() => admission.watchRevocation(old,id),ScanReadAdmissionError);
  assert.throws(() => admission.release(old,id),ScanReadAdmissionError);
  assert.equal(admission.resourceCounts().permits,1); admission.release(scope,id); admission.close();
});
test('MBRS003有限watch renew不撤销票据；release立即结束watch，不让每文件等一秒', async () => {
  const admission = createScanReadAdmission({ isBusy: () => false,watchTimeoutMs:1 }), scope = context(), id = permit(admission,scope);
  assert.deepEqual(await admission.watchRevocation(scope,id), { reason:'renew' });
  assert.equal(admission.resourceCounts().revoked,0);
  const watch = admission.watchRevocation(scope,id); assert.throws(() => admission.watchRevocation(scope,id),ScanReadAdmissionError);
  admission.release(scope,id); assert.deepEqual(await watch,{ reason:'permit-released' });
  assert.equal(admission.resourceCounts().timers,0); admission.release(scope,id); admission.close();
});
test('MBRS003关闭解决watch但未确认FD静止的许可保留，不超时归零', async () => {
  const admission = createScanReadAdmission({ isBusy: () => false }), scope = context(), id = permit(admission,scope);
  const watch = admission.watchRevocation(scope,id); admission.close();
  assert.deepEqual(await watch,{ reason:'admission-closed' }); assert.equal(admission.resourceCounts().permits,1);
  assert.equal(admission.resourceCounts().timers,0); assert.deepEqual(admission.acquire(scope),{ status:'deferred' });
  admission.release(scope,id); assert.equal(admission.resourceCounts().permits,0);
});
test('MBRS003繁忙权威采样异常拒绝新读并撤销在途，不把异常当idle', async () => {
  let broken=false;const admission=createScanReadAdmission({ isBusy:()=>{if(broken)throw new Error('合成观察失败');return false;} }),scope=context(),id=permit(admission,scope);
  const watch=admission.watchRevocation(scope,id);broken=true;admission.observe();
  assert.deepEqual(await watch,{ reason:'media-busy' });assert.deepEqual(admission.acquire(scope),{ status:'deferred' });
  admission.release(scope,id);admission.close();
});

/** 只替代外部Roon；真实Controller负责owner、pending与未知停止。 */
class SyntheticRoon implements RoonPort {
  state: RoonState = { status:'ready',selectedZoneId:'zone-1',transportState:'stopped',canPause:true,canResume:true };
  setTerminalHandler(_handler: (reason: RoonTerminalReason) => void): void {}
  async start(): Promise<void> {} async shutdown(): Promise<void> {}
  async play(): Promise<void> {} async stop(): Promise<void> {}
  async pause(): Promise<void> {} async resume(): Promise<void> {}
  getState(): RoonState { return { ...this.state }; }
}
function productionController() {
  const roon = new SyntheticRoon(), registry = new StreamRegistry(), logger = createLogger('error');
  let admission: ScanReadAdmission | undefined, failStop = false;
  const gateway = new StreamGateway({ host:'127.0.0.1',port:0,publicBaseUrl:'http://127.0.0.1:0',registry,logger });
  const controller = new BridgeController({ netease:new NeteaseClient(undefined),roon,registry,gateway,logger,
    onReadPriorityChanged: () => admission?.observe(),
    roonLibrary:{
      play: async (_reference,_zone,_track,options) => { options?.onDispatch?.(); roon.state={ ...roon.state,transportState:'playing' }; return { revision:1,zoneId:'zone-1',state:'playing' as const }; },
      stop: async () => { if (failStop) throw new Error('合成停止失败'); roon.state={ ...roon.state,transportState:'stopped' }; },
      pause: async () => { roon.state={ ...roon.state,transportState:'paused' }; },
      resume: async () => { roon.state={ ...roon.state,transportState:'playing' }; },
    },
  });
  admission=createScanReadAdmission({ isBusy: () => controller.hasPlaybackOwnership() });
  return { controller,admission,setStopFailure(value:boolean) { failStop=value; },
    start: () => controller.playRoon({ reference:'trusted-roon-track',zoneId:'zone-1',track:{ id:'123',title:'合成曲目',artists:['合成艺人'],album:'合成专辑' } }) };
}
test('MBRS003真实Controller受理pending即撤销，paused与unknown停止也阻断扫描', async t => {
  const f=productionController(),scope=context(),id=permit(f.admission,scope),watch=f.admission.watchRevocation(scope,id);
  t.after(async () => { f.setStopFailure(false); await f.controller.shutdown(); f.admission.close(); });
  const playing=f.start(); assert.equal(f.controller.hasPlaybackOwnership(),true);
  assert.deepEqual(await watch,{ reason:'media-busy' }); f.admission.release(scope,id); await playing;
  await f.controller.pause(); assert.equal(f.controller.getPlaybackState().state,'paused');
  assert.deepEqual(f.admission.acquire(scope),{ status:'deferred' });
  f.setStopFailure(true); await assert.rejects(f.controller.stop()); assert.equal(f.controller.getPlaybackState().state,'error');
  assert.deepEqual(f.admission.acquire(scope),{ status:'deferred' });
  f.setStopFailure(false); await f.controller.stop(); const after=permit(f.admission,scope); f.admission.release(scope,after);
});
test('MBRS003真实Controller触发compiled reader撤销，实际exit与原FD关闭后release，同文件重读成功', { timeout:20_000 }, async t => {
  const f=await audioFixture(t),core=productionController(),scope=context(),id=permit(core.admission,scope),events:MetadataReaderLifecycle[]=[],abort=new AbortController();
  let trustedYield=false,play:Promise<unknown>|undefined,readingSettled=false;
  const watch=core.admission.watchRevocation(scope,id).then(value => { if (value.reason==='media-busy') { trustedYield=true;abort.abort(); } return value; });
  const reader=createMetadataReader({ onLifecycle:event => { events.push(event);if(event.type==='worker-online')play=core.start(); } });
  t.after(async () => { await reader.close();await core.controller.shutdown();core.admission.close(); });
  const relative=f.entry('core-flac').file,expectedSignature=(await readonlySourceCandidateMetadata(f.root,relative)).signature;
  const result=await reader.read({ root:f.root,relative,expectedSignature },abort.signal);readingSettled=true;
  assert.equal(trustedYield,true);assert.equal(result.status,'failure');if(result.status==='failure')assert.equal(result.code,'CANCELLED');
  const acquired=events.find(e=>e.type==='lease-acquired');assert.ok(acquired && acquired.type==='lease-acquired');
  const exit=events.findIndex(e=>e.type==='worker-exit'),released=events.findIndex(e=>e.type==='lease-released'),complete=events.findIndex(e=>e.type==='read-complete');
  assert.equal(exit>=0 && released>exit && complete>released,true);
  assert.throws(()=>fstatSync(acquired.fd),(error:NodeJS.ErrnoException)=>error.code==='EBADF');
  assert.equal(core.admission.resourceCounts().permits,1);assert.equal(readingSettled,true);
  core.admission.release(scope,id);assert.deepEqual(await watch,{ reason:'media-busy' });await play;await core.controller.stop();
  const retry=permit(core.admission,scope);const retried=await reader.read({ root:f.root,relative,expectedSignature });
  assert.equal(retried.status,'ok');core.admission.release(scope,retry);await f.assertUnchanged();
  // 这项证明Core→真实reader取消与重读；库中不记坏文件由owner integration另行验证。
});

test('MBRS003真实Gateway preflight从upstream请求到body cancel全程阻断扫描', async () => {
  const entered=deferred<void>(),response=deferred<Response>(),scope=context();let admission:ScanReadAdmission|undefined;
  const gateway=new StreamGateway({ host:'127.0.0.1',port:0,publicBaseUrl:'http://127.0.0.1:0',registry:new StreamRegistry(),logger:createLogger('error'),
    fetcher:async()=>{entered.resolve();return response.promise;},onMediaReadActivityChanged:()=>admission?.observe() });
  admission=createScanReadAdmission({ isBusy:()=>gateway.getActiveMediaReadCount()>0 });const id=permit(admission,scope),watch=admission.watchRevocation(scope,id);
  let cancelled=false;
  const work=gateway.preflight({ trackId:'123',upstreamUrl:'https://cdn.example/audio.flac',requestedQuality:'lossless',actualQuality:'lossless',format:'flac' });
  await entered.promise;assert.deepEqual(await watch,{ reason:'media-busy' });assert.equal(gateway.getActiveMediaReadCount(),1);
  assert.deepEqual(admission.acquire(scope),{ status:'deferred' });
  response.resolve(new Response(new ReadableStream({ cancel(){cancelled=true;} }),{ status:206 }));await work;
  assert.equal(cancelled,true);assert.equal(gateway.getActiveMediaReadCount(),0);admission.release(scope,id);const next=permit(admission,scope);admission.release(scope,next);admission.close();
});
test('MBRS003真实Gateway HTTP pipeline存活阻断扫描，finish后资源归零', { timeout:10_000 }, async t => {
  const registry=new StreamRegistry(),scope=context();let admission:ScanReadAdmission|undefined,body!:ReadableStreamDefaultController<Uint8Array>;
  const gateway=new StreamGateway({ host:'127.0.0.1',port:0,publicBaseUrl:'http://127.0.0.1:0',registry,logger:createLogger('error'),
    fetcher:async()=>new Response(new ReadableStream<Uint8Array>({ start(controller){body=controller;controller.enqueue(new Uint8Array([1]));} }),{ status:200,headers:{ 'Content-Type':'audio/flac' } }),
    onMediaReadActivityChanged:()=>admission?.observe() });
  admission=createScanReadAdmission({ isBusy:()=>gateway.getActiveMediaReadCount()>0 });t.after(async()=>{
    admission?.close();try{body?.error(new Error('测试结束收口'));}catch{/* 已关闭的真实流无需再error。 */}await gateway.stop();
  });
  await gateway.start();const registration=registry.register({ metadata:{ id:'123',title:'合成曲目',artists:[],album:'合成' },requestedQuality:'lossless',
    resolve:async()=>({ trackId:'123',upstreamUrl:'https://cdn.example/audio.flac',requestedQuality:'lossless',actualQuality:'lossless',format:'flac' }) });
  const id=permit(admission,scope),watch=admission.watchRevocation(scope,id);
  const response=await fetch(`${gateway.localBaseUrl()}/stream/${registration.token}.flac`);assert.deepEqual(await watch,{ reason:'media-busy' });
  assert.equal(gateway.getActiveMediaReadCount(),1);assert.deepEqual(admission.acquire(scope),{ status:'deferred' });
  body.enqueue(new Uint8Array([2]));body.close();assert.deepEqual(new Uint8Array(await response.arrayBuffer()),new Uint8Array([1,2]));await turn();
  assert.equal(gateway.getActiveMediaReadCount(),0);admission.release(scope,id);const next=permit(admission,scope);admission.release(scope,next);
});
test('MBRS003 Gateway preflight真实fetch拒绝仍在finally释放计数', async () => {
  const gateway=new StreamGateway({ host:'127.0.0.1',port:0,publicBaseUrl:'http://127.0.0.1:0',registry:new StreamRegistry(),logger:createLogger('error'),
    fetcher:async()=>{throw new Error('合成上游读取失败');} });
  await assert.rejects(gateway.preflight({ trackId:'123',upstreamUrl:'https://cdn.example/audio.flac',requestedQuality:'lossless',actualQuality:'lossless',format:'flac' }));
  assert.equal(gateway.getActiveMediaReadCount(),0);assert.deepEqual(gateway.getDiagnosticResourceCounters(),{ listenerCount:0,timerCount:0 });
});
test('MBRS003真实runtime组合私有准入，Roon原生忙碌/失联/确认停止驱动撤销，shutdown保留未quiet许可', async t => {
  let state:RoonState={ status:'ready',selectedZoneId:'zone-1',transportState:'stopped' },notify=()=>{};
  // 只替代账号/设备与监听I/O，生产runtime和其扫描准入组合保留。
  t.mock.method(StreamGateway.prototype,'start',async()=>undefined);
  t.mock.method(ControlServer.prototype,'start',async()=>undefined);
  t.mock.method(RoonAudioInputAdapter.prototype,'start',async()=>undefined);
  t.mock.method(RoonAudioInputAdapter.prototype,'shutdown',async()=>undefined);
  t.mock.method(RoonAudioInputAdapter.prototype,'getState',()=>({ ...state }));
  t.mock.method(RoonAudioInputAdapter.prototype,'getSelectedZonePlaybackState',()=>state.transportState);
  t.mock.method(RoonAudioInputAdapter.prototype,'setStateHandler',(handler:()=>void)=>{notify=handler;});
  const sdk:RoonSdk={ audioInputService:class {},transportService:class {},
    createApi(){assert.fail('禁止真实Roon连接');},createSettings(){assert.fail('禁止真实Roon设置');},createStatus(){assert.fail('禁止真实Roon状态写入');} };
  const runtime=createBridgeRuntime({ env:{ LOG_LEVEL:'error',BRIDGE_CONTROL_HOST:'127.0.0.1',BRIDGE_STREAM_HOST:'127.0.0.1' },
    favoriteRepository:createLocalFavoriteRepository(),roonSdk:sdk,logger:createLogger('error') });
  t.after(()=>runtime.shutdown());const admission=runtime.getDatasetScanReadAdmission?.();assert.ok(admission);
  const scope=context();assert.deepEqual(admission.acquire(scope),{ status:'deferred' });await runtime.start();
  const id=permit(admission,scope),watch=admission.watchRevocation(scope,id);
  state={ ...state,transportState:'loading' };notify();assert.deepEqual(await watch,{ reason:'media-busy' });
  delete state.transportState;notify();assert.deepEqual(admission.acquire(scope),{ status:'deferred' });
  state={ ...state,transportState:'paused' };notify();assert.deepEqual(admission.acquire(scope),{ status:'deferred' });
  state={ ...state,transportState:'stopped' };notify();admission.release(scope,id);
  const next=permit(admission,scope),closing=admission.watchRevocation(scope,next);await runtime.shutdown();
  assert.deepEqual(await closing,{ reason:'admission-closed' });assert.equal(admission.resourceCounts().permits,1);
  admission.release(scope,next);assert.deepEqual(admission.resourceCounts(),{ permits:0,revoked:0,watches:0,timers:0,closed:true });
});
