import assert from 'node:assert/strict';
import test from 'node:test';
import { privatePathFixture,turns } from './playback-private-path-fixture.js';
import { MOBILE_PLAYBACK_DEFAULT_LIMITS as limits } from '../../src/mobile/playback-types.js';
import { createPlaybackStorageActor } from '../../src/mobile/playback-state-codec.js';
import { capacityHistory } from './playback-state-capacity-fixture.js';
import { deltaSession,deltaCandidate,deltaContext } from './playback-state-delta-fixture.js';

test('direct150ms窗口：100ms内verify+renew成功只UNKNOWN＋ready两次ACK，不生成202或重prepare',async t=>{
  for(const elapsed of [30,100,149])await t.test(String(elapsed),async child=>{child.mock.timers.enable({apis:['setTimeout']});const f=privatePathFixture(child),s=await f.session(),before=f.saved.length;f.holdVerify();const flight=f.resource(s.id);
  await f.verifyEntered.promise;await turns();child.mock.timers.tick(elapsed);await turns();f.verifyReleased.resolve();const reply=await flight;
  assert.equal(reply.status,201);assert.equal(f.saved.length-before,2);assert.equal(f.saved.some(v=>v.receipts.some(r=>r.reply?.status===202)),false);assert.equal(f.prepares(),1);
  assert.equal((await f.resource(s.id)).status,201);assert.equal(f.saved.length-before,2);await reply.beforeSend();});
});
test('direct150ms窗口：T+1仍202且后续ready保原回执，显式更小窗口照旧生效',async t=>{
  for(const wait of [undefined,10])await t.test(String(wait),async child=>{child.mock.timers.enable({apis:['setTimeout']});const f=privatePathFixture(child,wait===undefined?{}:{limits:{readyWaitMs:wait}}),s=await f.session(),before=f.saved.length;
    f.holdVerify();const flight=f.resource(s.id);await f.verifyEntered.promise;await turns();child.mock.timers.tick((wait??150)+1);await turns();const reply=await flight;assert.equal(reply.status,202);
    f.verifyReleased.resolve();await turns();assert.equal(f.saved.length-before,3);assert.deepEqual((await f.resource(s.id)).body,reply.body);assert.equal(f.prepares(),1);
  });
});
test('direct150ms窗口：DSD缓存ready仍原25ms而非新direct窗口',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const f=privatePathFixture(t,{dsd:true}),s=await f.session();f.holdVerify();const flight=f.resource(s.id);
  await f.verifyEntered.promise;await turns();t.mock.timers.tick(26);await turns();const reply=await flight;assert.equal(reply.status,202);f.verifyReleased.resolve();await turns();
  assert.equal((await f.resource(s.id)).status,202);assert.equal(f.prepares(),1);
});
test('direct150ms窗口：全limits绑定包含readyWait，旧base不同窗口不能derive，150+1仍拒绝',()=>{
  assert.equal(limits.readyWaitMs,150);const actor=createPlaybackStorageActor(),state=capacityHistory({sessions:1,resources:1,receipts:2}),seed=actor.encode(state,deltaContext(state));
  const patch=deltaSession(state,1),ctx=deltaContext(deltaCandidate(state,patch,1));assert.throws(()=>actor.derive(seed.base,patch,{...ctx,limits:{...ctx.limits,readyWaitMs:25}}));
  assert.throws(()=>actor.derive(seed.base,patch,{...ctx,limits:{...ctx.limits,readyWaitMs:151}}));seed.bytes.fill(0);actor.close();
});
test('direct150ms窗口：verify/renew错误立即记录原失败，close立即取消等待但不假报来源quiet',async t=>{
  for(const stage of ['verify','renew']as const)await t.test(stage,async child=>{child.mock.timers.enable({apis:['setTimeout']});const f=privatePathFixture(child),s=await f.session(),before=f.saved.length;f.holdVerify();f.failVerification(stage);
    const flight=f.resource(s.id);await f.verifyEntered.promise;await turns();child.mock.timers.tick(10);f.verifyReleased.resolve();const reply=await flight;
    assert.equal(reply.status,409);assert.equal(f.saved.length-before,2);assert.equal(f.saved.some(v=>v.receipts.some(r=>r.reply?.status===202)),false);assert.equal(f.prepares(),1);
  });
  const f=privatePathFixture(t),s=await f.session(),before=f.saved.length;t.mock.timers.enable({apis:['setTimeout']});f.holdVerify();let rejected=false;
  const failure=assert.rejects(f.resource(s.id)).then(()=>{rejected=true;});await f.verifyEntered.promise;await turns();let closed=false;const close=f.service.close().then(()=>{closed=true;});
  await turns();assert.equal(rejected,true);assert.equal(closed,false);assert.equal(f.saved.length-before,1);f.verifyReleased.resolve();await failure;await close;
});
