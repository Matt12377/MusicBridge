import assert from 'node:assert/strict';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import { createMobilePlaybackStateCodec } from '../../src/main/mobile-playback-state-codec-client.js';
import { encodePlaybackStorage, decodePlaybackStorage, type PlaybackStorageWithBase, type DecodedPlaybackStorage } from '../../../../packages/bridge-core/src/mobile/playback-state-codec.js';
import { capacityHistory, CAPACITY_SERVER as SERVER, CAPACITY_DATASET as DATASET, CAPACITY_ORIGIN as ORIGIN } from '../../../../packages/bridge-core/test/mbm002/playback-state-capacity-fixture.js';
import { deltaContext, deltaSession, deltaCandidate, deltaCreate, deltaPublish } from '../../../../packages/bridge-core/test/mbm002/playback-state-delta-fixture.js';
import { MOBILE_PLAYBACK_DEFAULT_LIMITS as limits } from '../../../../packages/bridge-core/src/mobile/playback-types.js';

// 合成全历史；真实本代production entry，没有真实Owner数据或凭据。
test('v6 Worker：512/64/4与空环境下冷读及session/UNKNOWN/publish真实补丁等价，关闭等待实际退出', {timeout:120_000}, async t => {
  const entry=process.env.MUSIC_BRIDGE_PLAYBACK_CODEC_TEST_ENTRY;
  assert.ok(typeof entry==='string'&&entry.startsWith('/Volumes/LifeWeave/'));
  const file=entry;
  let worker:Worker|undefined, exited:number|undefined;
  const port=createMobilePlaybackStateCodec({workerFactory:()=>{
    worker=new Worker(pathToFileURL(file),{execArgv:[],env:{},name:'mobile-playback-codec',
      resourceLimits:{maxOldGenerationSizeMb:512,maxYoungGenerationSizeMb:64,stackSizeMb:4}});
    const actual=worker.resourceLimits;assert.ok(actual);
    assert.equal(actual.maxOldGenerationSizeMb,512);
    assert.equal(actual.maxYoungGenerationSizeMb,64);
    assert.equal(actual.stackSizeMb,4);
    worker.once('exit',code=>{exited=code;});return worker;
  }});t.after(()=>port.close());
  const measured:{stage:string;elapsedMs:number;bytes:number;rssBytes:number;sha256:string}[]=[];
  let state=capacityHistory({sessions:52,resources:588,receipts:1600});
  for(const row of state.resources)row.source!.processing.reason='合成原字节'.repeat(10);
  for(const row of state.receipts)if(row.reply&&row.reply.status<400&&row.operation!=='createSession')
    (row.reply.body as {processing:{reason:string}}).processing.reason='合成原字节'.repeat(10);
  async function timed<T extends {canonical:string;format:string}>(stage:string,body:()=>Promise<T>):Promise<T>{
    const at=performance.now(),value=await body();
    measured.push({stage,elapsedMs:performance.now()-at,bytes:Buffer.byteLength(value.canonical),rssBytes:process.memoryUsage().rss,
      sha256:createHash('sha256').update(value.canonical).digest('hex')});assert.equal(value.format,'v6');return value;
  }
  let encoded=await timed('encode',()=>port.encode(state,deltaContext(state)));assert.deepEqual(encoded.state,state);
  const cold=await timed('decode',()=>port.decode(new Uint8Array(encoded.bytes),deltaContext(state))) as PlaybackStorageWithBase<DecodedPlaybackStorage>;assert.deepEqual(cold.state,state);
  let base=cold.base!;
  for(const [i,kind]of ['createSession','createResource','publishResource'].entries()){
    const patch=kind==='createSession'?deltaSession(state,970):kind==='createResource'?deltaCreate(state,971):deltaPublish(state,971);
    const candidate=deltaCandidate(state,patch,i+1),expected=encodePlaybackStorage(candidate,SERVER,DATASET,ORIGIN,limits);
    if(kind==='publishResource'){
      const at=performance.now(),reply=await port.derivePatch(base,patch,deltaContext(candidate));
      assert.equal(reply.format,'v6');assert.equal(reply.canonical,expected.canonical);assert.deepEqual(reply.bytes,expected.bytes);
      assert.deepEqual(structuredClone(reply.patch),patch);base=reply.base;
      measured.push({stage:'publishResource.derive-patch',elapsedMs:performance.now()-at,bytes:reply.bytes.length,
        rssBytes:process.memoryUsage().rss,sha256:createHash('sha256').update(reply.bytes).digest('hex')});
    }else{
      const result=await timed(kind+'.derive',()=>port.derive(base,patch,deltaContext(candidate)));
      assert.equal(result.canonical,expected.canonical);assert.deepEqual(result.state,candidate);base=result.base!;
    }
    assert.deepEqual(decodePlaybackStorage(expected.bytes,SERVER,DATASET,ORIGIN,limits).state,candidate);state=candidate;
  }
  await port.close();assert.equal(exited,0);
  // RSS为主进程与Worker线程共享进程观测，不能冒称Worker独立heap或手机时延。
  t.diagnostic(JSON.stringify({schema:1,scope:'合成production Worker，同进程RSS；非手机或独占稳态',measurements:measured}));
});
