import assert from 'node:assert/strict';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { createMobilePlaybackStateCodec } from '../../src/main/mobile-playback-state-codec-client.js';
import { encodePlaybackStorage,type PlaybackStorageWithBase,type EncodedPlaybackStorage } from '../../../../packages/bridge-core/src/mobile/playback-state-codec.js';
import { MOBILE_PLAYBACK_DEFAULT_LIMITS,MobilePlaybackError } from '../../../../packages/bridge-core/src/mobile/playback-types.js';
import { playbackCopy } from '../../../../packages/bridge-core/src/mobile/playback-state.js';
import { capacityHistory,capacityLogicalBoundary,CAPACITY_SERVER as SERVER,CAPACITY_DATASET as DATASET,CAPACITY_ORIGIN as ORIGIN } from '../../../../packages/bridge-core/test/mbm002/playback-state-capacity-fixture.js';
import { deltaCreate,deltaPublish,deltaSession,deltaCandidate,deltaContext } from '../../../../packages/bridge-core/test/mbm002/playback-state-delta-fixture.js';

test('真实Worker增量：默认512MiB新增session/UNKNOWN/202/ready逐字节等价，近1m及错误资格拒绝后自然关闭',{timeout:120000},async t=>{
  const entry=process.env.MUSIC_BRIDGE_PLAYBACK_CODEC_TEST_ENTRY;assert.ok(typeof entry==='string'&&entry.startsWith('/Volumes/LifeWeave/'));
  const port=createMobilePlaybackStateCodec({workerUrl:pathToFileURL(entry)});t.after(()=>port.close());
  let state=capacityHistory(),encoded=await port.encode(state,deltaContext(state)) as PlaybackStorageWithBase<EncodedPlaybackStorage>;
  for(const [index,phase]of ['session','create','preparing','ready'].entries()){
    const patch=phase==='session'?deltaSession(state):phase==='create'?deltaCreate(state):deltaPublish(state,1,phase==='preparing');
    const candidate=deltaCandidate(state,patch,index+1),expected=encodePlaybackStorage(candidate,SERVER,DATASET,ORIGIN,MOBILE_PLAYBACK_DEFAULT_LIMITS);
    const next=await port.derive(encoded.base,patch,deltaContext(candidate));assert.equal(next.canonical,expected.canonical);assert.deepEqual(next.state,expected.state);assert.deepEqual(next.bytes,expected.bytes);
    encoded.bytes.fill(0);expected.bytes.fill(0);encoded=next;state=playbackCopy(next.state);
  }
  assert.equal(state.receipts.find(row=>row.id==='delta.receipt.1')!.reply!.status,202);
  const bad=deltaCreate(state,2),candidate=deltaCandidate(state,bad,5);
  await assert.rejects(port.derive({...encoded.base,handle:'base.wrong'},bad,deltaContext(candidate)),error=>error instanceof MobilePlaybackError&&error.code==='BUSY');
  const boundary=capacityLogicalBoundary().inside,large=await port.encode(boundary,deltaContext(boundary)) as PlaybackStorageWithBase<EncodedPlaybackStorage>;
  const extra=deltaCreate(boundary),excessive=deltaCandidate(boundary,extra,6);
  await assert.rejects(port.derive(large.base,extra,deltaContext(excessive)),error=>error instanceof MobilePlaybackError&&error.code==='RESOURCE_BUSY');
  const small=capacityHistory({receipts:80});assert.ok((await port.encode(small,deltaContext(small))).bytes.length>0);await port.close();
});
