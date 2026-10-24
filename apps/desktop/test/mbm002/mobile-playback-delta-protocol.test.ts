import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import type { Worker } from 'node:worker_threads';
import { createMobilePlaybackStateCodec } from '../../src/main/mobile-playback-state-codec-client.js';
import { createPlaybackStorageActor } from '../../../../packages/bridge-core/src/mobile/playback-state-codec.js';
import { MobilePlaybackError } from '../../../../packages/bridge-core/src/mobile/playback-types.js';
import { capacityHistory } from '../../../../packages/bridge-core/test/mbm002/playback-state-capacity-fixture.js';
import { deltaCreate,deltaCandidate,deltaContext } from '../../../../packages/bridge-core/test/mbm002/playback-state-delta-fixture.js';

class FakeWorker extends EventEmitter {
  jobs:Record<string,unknown>[]=[];tamper=false;readonly actor=createPlaybackStorageActor();
  postMessage(job:Record<string,unknown>){if(job.kind==='close'){this.actor.close();queueMicrotask(()=>this.emit('exit',0));return;}
    this.jobs.push(job);queueMicrotask(()=>{try{const ctx=job.context as Parameters<typeof this.actor.encode>[1],input=job.input as {base:unknown;patch:unknown};
      const result=job.operation==='derive'?this.actor.derive(input.base,input.patch,ctx):this.actor.encode(job.input,ctx);
      const reply=structuredClone(result);if(this.tamper)reply.base.revision++;
      this.emit('message',{protocol:job.protocol,kind:'result',id:job.id,operation:job.operation,binding:job.binding,result:reply});
    }catch(error){assert.ok(error instanceof MobilePlaybackError);this.emit('message',{protocol:job.protocol,kind:'failure',id:job.id,operation:job.operation,binding:job.binding,
      error:{status:error.status,code:error.code,retryable:error.retryable,retryAfterMs:error.retryAfterMs??null}});}});
  }
  async terminate(){this.actor.close();queueMicrotask(()=>this.emit('exit',0));return 0;}
}
const busy=(error:unknown)=>error instanceof MobilePlaybackError&&error.code==='BUSY';
test('增量协议：Main只复制新片段，拒绝getter不执行，post后修改原输入不改变候选',async()=>{
  const fake=new FakeWorker(),port=createMobilePlaybackStateCodec({workerFactory:()=>fake as unknown as Worker}),state=capacityHistory({receipts:80});
  const seed=await port.encode(state,deltaContext(state)) as Awaited<ReturnType<typeof port.derive>>;
  const patch=deltaCreate(state),candidate=deltaCandidate(state,patch,1);let calls=0;
  const getter=Object.defineProperty({...patch},'resource',{enumerable:true,get(){calls++;return patch.resource;}});
  await assert.rejects(port.derive(seed.base,getter,deltaContext(candidate)),busy);assert.equal(calls,0);assert.equal(fake.jobs.length,1);
  const flight=port.derive(seed.base,patch,deltaContext(candidate));patch.receipt.keyHash='0'.repeat(64);
  const result=await flight;assert.deepEqual(result.state,candidate);
  const sent=fake.jobs[1]!.input as {patch:Record<string,unknown>};assert.deepEqual(Object.keys(sent.patch).sort(),['clockFloor','kind','receipt','resource']);
  assert.equal(JSON.stringify(sent).includes('capacity.receipt.79'),false);await port.close();
});
test('增量协议：结果base与job revision不符时整口关闭，不采纳假资格',async()=>{
  const fake=new FakeWorker(),port=createMobilePlaybackStateCodec({workerFactory:()=>fake as unknown as Worker}),state=capacityHistory({receipts:80});
  const seed=await port.encode(state,deltaContext(state)) as Awaited<ReturnType<typeof port.derive>>,patch=deltaCreate(state),candidate=deltaCandidate(state,patch,1);fake.tamper=true;
  await assert.rejects(port.derive(seed.base,patch,deltaContext(candidate)),busy);await assert.rejects(port.close(),busy);
});
