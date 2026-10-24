import assert from 'node:assert/strict';
import test from 'node:test';
import { privatePathFixture,mediaRequest,principal,turns } from './playback-private-path-fixture.js';

test('可信64KiB组合：单HTTP256KiB仍四次原读与双水位，只去重同边界Owner授权25→17，写前逐片新验',async t=>{
  const f=privatePathFixture(t),{resource}=await f.ready();f.reset();const media=await f.service.openMedia('getMediaAsset',mediaRequest(resource),new AbortController().signal,{range:'bytes=0-262143'});
  await media.beforeSend();const chunks=[];for(let n=0;n<4;n++){chunks.push(await media.reader!.read(65536));await media.beforeSend();}
  assert.deepEqual(Buffer.concat(chunks),Buffer.from(f.data));assert.equal(f.auth(),17);assert.deepEqual(f.watermarks(),[4,4]);assert.equal(f.reads.length,4);
  assert.equal(new Set(f.reads.map(v=>v.readId)).size,1);assert.deepEqual(f.reads.map(v=>[v.start,v.maxBytes]),[[0,65536],[65536,65536],[131072,65536],[196608,65536]]);await media.close();
});
test('可信64KiB组合：bare资格或错auth/source能力不能免验，普通端口原25次授权保持',async t=>{
  for(const composition of ['bare','wrong-auth','wrong-source']as const)await t.test(composition,async child=>{const f=privatePathFixture(child,{composition}),{resource}=await f.ready();f.reset();
    const media=await f.service.openMedia('getMediaAsset',mediaRequest(resource),new AbortController().signal);await media.beforeSend();for(let n=0;n<4;n++){await media.reader!.read();await media.beforeSend();}
    assert.equal(f.auth(),25);assert.deepEqual(f.watermarks(),[4,4]);await media.close();});
});
test('可信64KiB组合：漏掉、重复或乱序边界回调不得输出字节，旧读回调也不能复用',async t=>{
  for(const sequence of ['omit-before','omit-after','twice-before','after-first']as const)await t.test(sequence,async child=>{const f=privatePathFixture(child,{sequence}),{resource}=await f.ready();
    const media=await f.service.openMedia('getMediaAsset',mediaRequest(resource),new AbortController().signal);await assert.rejects(media.reader!.read());await media.close();});
  const f=privatePathFixture(t),{resource}=await f.ready(),media=await f.service.openMedia('getMediaAsset',mediaRequest(resource),new AbortController().signal);await media.reader!.read();
  const before=f.auth();await assert.rejects(f.boundary()!.before());await assert.rejects(f.boundary()!.after());assert.equal(f.auth(),before);await media.close();
});
test('可信64KiB组合：before/source/after与写前撤销均拒绝晚字节，close仍等待原在途工作',async t=>{
  for(const stage of ['before','source','after','write']as const)await t.test(stage,async child=>{const f=privatePathFixture(child),{resource}=await f.ready();
    const media=await f.service.openMedia('getMediaAsset',mediaRequest(resource),new AbortController().signal);f.reset();
    if(stage==='before')f.holdAuth(1);if(stage==='source')f.holdRead();if(stage==='after')f.holdAuth(2);
    if(stage==='write'){await media.reader!.read();f.revoke();await assert.rejects(media.beforeSend());}
    else{const reading=media.reader!.read(),rejected=assert.rejects(reading);await(stage==='source'?f.readEntered.promise:f.authEntered.promise);f.revoke();
      f.readReleased.resolve();f.authReleased.resolve();await rejected;}await media.close();
  });
  const f=privatePathFixture(t),{resource}=await f.ready(),media=await f.service.openMedia('getMediaAsset',mediaRequest(resource),new AbortController().signal);f.holdRead();
  const reading=media.reader!.read(),rejected=assert.rejects(reading);await f.readEntered.promise;const closing=f.service.close();let closed=false;void closing.then(()=>{closed=true;});await turns();assert.equal(closed,false);
  f.readReleased.resolve();await rejected;await closing;assert.equal(f.reads.length,1);assert.equal(f.service.resourceSnapshot().readers,0);assert.equal(principal.deviceEpoch,1);
});
test('可信64KiB组合：普通ACK在途原reader继续，UNKNOWN或CAS后立即拒绝，不新增全局publication等待',async t=>{
  for(const fault of ['unknown','conflict']as const)await t.test(fault,async child=>{const f=privatePathFixture(child),{session,resource}=await f.ready();
    const media=await f.service.openMedia('getMediaAsset',mediaRequest(resource),new AbortController().signal);f.holdSave(fault);
    const observed=f.service.control('reportObservation',{path:`/mobile/v1/sessions/${session.id}/observation`,pathParameters:{sessionId:session.id},query:{},
      body:{sequence:1,playerGeneration:1,queueItemId:'queue.private',resourceId:resource.id,trackId:resource.trackId,positionMs:100,state:'playing'}},principal,new AbortController().signal);
    const rejected=assert.rejects(observed);await f.saveEntered.promise;await media.beforeSend();assert.deepEqual(await media.reader!.read(16),f.data.slice(0,16));
    f.saveReleased.resolve();await rejected;await assert.rejects(media.reader!.read(16));assert.equal(f.reads.length,1);await media.close();
  });
});
test('可信64KiB组合：原open等待publication结束后必须再freshAuth，等待前资格不能跨撤销',async t=>{
  const f=privatePathFixture(t),{session,resource}=await f.ready();f.holdSave();const observed=f.service.control('reportObservation',{
    path:`/mobile/v1/sessions/${session.id}/observation`,pathParameters:{sessionId:session.id},query:{},
    body:{sequence:1,playerGeneration:1,queueItemId:'queue.private',resourceId:resource.id,trackId:resource.trackId,positionMs:100,state:'playing'}},principal,new AbortController().signal);
  await f.saveEntered.promise;let settled=false;const opening=f.service.openMedia('getMediaAsset',mediaRequest(resource),new AbortController().signal);
  const rejected=assert.rejects(opening).then(()=>{settled=true;});await turns();assert.equal(settled,false);f.revoke();f.saveReleased.resolve();await observed;await rejected;assert.equal(f.reads.length,0);
});
