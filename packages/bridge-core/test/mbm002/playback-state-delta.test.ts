import assert from 'node:assert/strict';
import test from 'node:test';
import { createPlaybackStorageActor,encodePlaybackStorage } from '../../src/mobile/playback-state-codec.js';
import { playbackCopy } from '../../src/mobile/playback-state.js';
import { MobilePlaybackError,MOBILE_PLAYBACK_DEFAULT_LIMITS } from '../../src/mobile/playback-types.js';
import { capacityHistory,capacityLogicalBoundary,CAPACITY_SERVER as SERVER,CAPACITY_DATASET as DATASET,CAPACITY_ORIGIN as ORIGIN } from './playback-state-capacity-fixture.js';
import { deltaContext,deltaCreate,deltaPublish,deltaCandidate,deltaSession } from './playback-state-delta-fixture.js';

const rejected=(code='BUSY')=>(error:unknown)=>error instanceof MobilePlaybackError&&error.code===code;
test('闭集增量：1139历史的UNKNOWN→201及UNKNOWN→202→ready与全量逐字节差分，跨八代折叠不改原键',()=>{
  const actor=createPlaybackStorageActor();let state=capacityHistory(),encoded=actor.encode(state,deltaContext(state)),serial=0;
  const history=JSON.stringify(state.receipts);
  assert.throws(()=>{encoded.state.receipts[0]!.id='不得变更';},TypeError);
  for(let n=1;n<=5;n++)for(const phase of ['create',...(n===2?['preparing']:[]),'ready']){
    const patch=phase==='create'?deltaCreate(state,n):deltaPublish(state,n,phase==='preparing');
    const candidate=deltaCandidate(state,patch,++serial),expected=encodePlaybackStorage(candidate,SERVER,DATASET,ORIGIN,MOBILE_PLAYBACK_DEFAULT_LIMITS);
    const next=actor.derive(encoded.base,patch,deltaContext(candidate));assert.equal(next.canonical,expected.canonical);assert.equal(next.format,expected.format);
    assert.deepEqual(next.bytes,expected.bytes);assert.deepEqual(next.state,expected.state);assert.equal(JSON.stringify(next.state.receipts.slice(0,1139)),history);
    assert.equal(next.base.revision,candidate.revision);expected.bytes.fill(0);encoded.bytes.fill(0);state=playbackCopy(next.state);encoded=next;
  }
  assert.equal(state.receipts.find(row=>row.id==='delta.receipt.2')!.reply!.status,202);actor.close();encoded.bytes.fill(0);
});
test('闭集增量：错误handle/scope/revision/limits、全局重复键及历史改写均拒绝，未ACK候选不挤掉原base',()=>{
  const actor=createPlaybackStorageActor(),state=capacityHistory({receipts:80}),seed=actor.encode(state,deltaContext(state)),patch=deltaCreate(state),candidate=deltaCandidate(state,patch,1),ctx=deltaContext(candidate);
  for(const base of [{...seed.base,handle:'base.wrong'},{...seed.base,revision:seed.base.revision+1},{...seed.base,commitId:'wrong.commit'}])assert.throws(()=>actor.derive(base,patch,ctx),rejected());
  for(const change of [{generation:'wrong.generation'},{datasetId:'wrong.dataset'},{responseOrigin:'https://127.0.0.1:9444'}, {limits:{...ctx.limits,stateBytes:ctx.limits.stateBytes-1}}])assert.throws(()=>actor.derive(seed.base,patch,{...ctx,...change}),rejected());
  const duplicate=playbackCopy(patch),old=state.receipts.find(row=>row.operation==='createResource')!,oldKey=old.request.idempotencyKey;assert.ok(typeof oldKey==='string');duplicate.receipt.request.idempotencyKey=oldKey;duplicate.receipt.keyHash=old.keyHash;
  assert.throws(()=>actor.derive(seed.base,duplicate,ctx),rejected());
  let getterCalls=0;const getter=Object.defineProperty(playbackCopy(patch),'resource',{enumerable:true,get(){getterCalls++;return patch.resource;}});
  assert.throws(()=>actor.derive(seed.base,getter,ctx),rejected());assert.equal(getterCalls,0);
  for(let n=0;n<4;n++)actor.derive(seed.base,patch,{...ctx,commitId:`unacknowledged.${n}`}).bytes.fill(0);
  const created=actor.derive(seed.base,patch,ctx),ready=deltaPublish(created.state),readyCandidate=deltaCandidate(created.state,ready,2),published=actor.derive(created.base,ready,deltaContext(readyCandidate));
  const rewrite=deltaPublish(published.state);rewrite.receipt.reply!.status=202;
  assert.throws(()=>actor.derive(published.base,rewrite,{...deltaContext(published.state),revision:published.state.revision+1,commitId:'invalid.rewrite'}),rejected());
  actor.close();assert.throws(()=>actor.derive(seed.base,patch,ctx),rejected());
});
test('闭集增量：近1m的新增片段仍逐引用计费且终态reserve不借base免除',()=>{
  const state=capacityLogicalBoundary().inside,actor=createPlaybackStorageActor(),seed=actor.encode(state,deltaContext(state));
  const patch=deltaCreate(state),candidate=deltaCandidate(state,patch,1);
  assert.throws(()=>encodePlaybackStorage(candidate,SERVER,DATASET,ORIGIN,MOBILE_PLAYBACK_DEFAULT_LIMITS),rejected('RESOURCE_BUSY'));
  assert.throws(()=>actor.derive(seed.base,patch,deltaContext(candidate)),rejected('RESOURCE_BUSY'));actor.close();
});

test('闭集增量：新增session与原全量逐字节一致，重复session身份及跨scope原键拒绝',()=>{
  const actor=createPlaybackStorageActor(),state=capacityHistory(),seed=actor.encode(state,deltaContext(state));
  const patch=deltaSession(state),candidate=deltaCandidate(state,patch,1),expected=encodePlaybackStorage(candidate,SERVER,DATASET,ORIGIN,MOBILE_PLAYBACK_DEFAULT_LIMITS);
  const result=actor.derive(seed.base,patch,deltaContext(candidate));assert.equal(result.canonical,expected.canonical);assert.deepEqual(result.state,expected.state);
  const duplicate=deltaSession(result.state);assert.throws(()=>actor.derive(result.base,duplicate,{...deltaContext(result.state),revision:result.state.revision+1,commitId:'duplicate.session'}),rejected());
  const bad=deltaSession(result.state,2);bad.receipt.deviceEpoch++;assert.throws(()=>actor.derive(result.base,bad,{...deltaContext(result.state),revision:result.state.revision+1,commitId:'wrong.epoch'}),rejected());actor.close();
});
