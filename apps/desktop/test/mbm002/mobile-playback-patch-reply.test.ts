import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import type { Worker } from 'node:worker_threads';
import { createMobilePlaybackStateCodec } from '../../src/main/mobile-playback-state-codec-client.js';
import { createPlaybackStorageActor } from '../../../../packages/bridge-core/src/mobile/playback-state-codec.js';
import { MobilePlaybackError } from '../../../../packages/bridge-core/src/mobile/playback-types.js';
import type { MobilePlaybackStateCodecContext } from '../../../../packages/bridge-core/src/mobile/playback-types.js';
import type { PlaybackStorageBase } from '../../../../packages/bridge-core/src/mobile/playback-state-codec.js';
import { capacityHistory } from '../../../../packages/bridge-core/test/mbm002/playback-state-capacity-fixture.js';
import { deltaCreate,deltaCandidate,deltaContext } from '../../../../packages/bridge-core/test/mbm002/playback-state-delta-fixture.js';

class FakeWorker extends EventEmitter{
  readonly actor=createPlaybackStorageActor();results:unknown[]=[];tamper=false;
  postMessage(job:Record<string,unknown>){if(job.kind==='close'){this.actor.close();queueMicrotask(()=>this.emit('exit',0));return;}
    queueMicrotask(()=>{const ctx=job.context as MobilePlaybackStateCodecContext,input=job.input as {base:PlaybackStorageBase;patch:ReturnType<typeof deltaCreate>};
      const result=job.operation==='derive-patch'||job.operation==='derive'?this.actor.derive(input.base,input.patch,ctx):this.actor.encode(job.input,ctx);
      const value=job.operation==='derive-patch'?{canonical:result.canonical,format:result.format,bytes:result.bytes,base:result.base,previousBase:input.base,
        patch:{kind:input.patch.kind,clockFloor:result.state.clockFloor,resource:result.state.resources.at(-1),receipt:result.state.receipts.at(-1)}}:result;
      const reply=structuredClone(value);if(this.tamper&&'patch'in reply)reply.patch!.receipt!.deviceEpoch++;
      this.results.push(reply);this.emit('message',{protocol:job.protocol,kind:'result',id:job.id,operation:job.operation,binding:job.binding,result:reply});});}
  async terminate(){this.actor.close();queueMicrotask(()=>this.emit('exit',0));return 0;}
}
const busy=(error:unknown)=>error instanceof MobilePlaybackError&&error.code==='BUSY';
test('小回包：derive-patch只返回已验证新片段，不传完整历史，原输入及回包均隔离',async()=>{
  const fake=new FakeWorker(),port=createMobilePlaybackStateCodec({workerFactory:()=>fake as unknown as Worker}),state=capacityHistory({receipts:80});
  const seed=await port.encode(state,deltaContext(state)) as Awaited<ReturnType<typeof port.derive>>;
  const patch=deltaCreate(state),candidate=deltaCandidate(state,patch,1),derive=port.derivePatch?.bind(port)??port.derive.bind(port),result=await derive(seed.base,patch,deltaContext(candidate)) as Awaited<ReturnType<typeof port.derivePatch>>;
  assert.equal(Object.hasOwn(result,'state'),false);const {canonical,bytes,...tree}=fake.results[1] as typeof result;
  assert.equal(JSON.stringify(tree).includes('capacity.receipt.79'),false);assert.ok(canonical.includes('capacity.receipt.79'));assert.ok(bytes.length>0);
  assert.deepEqual(result.previousBase,seed.base);assert.deepEqual(structuredClone(result.patch),patch);assert.equal(result.base.revision,candidate.revision);
  const reply=fake.results[1] as typeof result;reply.patch.receipt.deviceEpoch++;assert.equal(result.patch.receipt.deviceEpoch,patch.receipt.deviceEpoch);await port.close();
});
test('小回包：Worker返回与原job不等的片段整口拒绝，坏patch不得成为Main mirror',async()=>{
  const fake=new FakeWorker(),port=createMobilePlaybackStateCodec({workerFactory:()=>fake as unknown as Worker}),state=capacityHistory({receipts:80});
  const seed=await port.encode(state,deltaContext(state)) as Awaited<ReturnType<typeof port.derive>>,patch=deltaCreate(state),candidate=deltaCandidate(state,patch,1);fake.tamper=true;
  await assert.rejects(port.derivePatch(seed.base,patch,deltaContext(candidate)),busy);await assert.rejects(port.close(),busy);
});
