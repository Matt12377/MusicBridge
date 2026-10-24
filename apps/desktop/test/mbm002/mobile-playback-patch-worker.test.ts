import assert from 'node:assert/strict';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { createMobilePlaybackStateCodec } from '../../src/main/mobile-playback-state-codec-client.js';
import { capacityHistory,capacityNodes } from '../../../../packages/bridge-core/test/mbm002/playback-state-capacity-fixture.js';
import { deltaCreate,deltaPublish,deltaSession,deltaCandidate,deltaContext } from '../../../../packages/bridge-core/test/mbm002/playback-state-delta-fixture.js';
import type { PlaybackStorageWithBase,EncodedPlaybackStorage,PlaybackStoragePatch } from '../../../../packages/bridge-core/src/mobile/playback-state-codec.js';
import { playbackCopy } from '../../../../packages/bridge-core/src/mobile/playback-state.js';

test('真实Worker小回包：默认512MiB三轮session/UNKNOWN/202/ready与旧整树回包逐字节相同，记录IPC复合耗时',{timeout:120000},async t=>{
  const entry=process.env.MUSIC_BRIDGE_PLAYBACK_CODEC_TEST_ENTRY;assert.ok(typeof entry==='string'&&entry.startsWith('/Volumes/LifeWeave/'));
  const port=createMobilePlaybackStateCodec({workerUrl:pathToFileURL(entry)});t.after(()=>port.close());
  let state=capacityHistory({sessions:39,resources:580,receipts:1231}),encoded=await port.encode(state,deltaContext(state)) as PlaybackStorageWithBase<EncodedPlaybackStorage>,serial=0;
  const rows:{round:number;phase:string;fullMs:number;patchMs:number;fullTreeNodes:number;patchTreeNodes:number;format:string}[]=[];
  for(let round=1;round<=3;round++)for(const phase of ['session','create','preparing','ready']){
    const patch:PlaybackStoragePatch=phase==='session'?deltaSession(state,round):phase==='create'?deltaCreate(state,round):deltaPublish(state,round,phase==='preparing');
    const candidate=deltaCandidate(state,patch,++serial),ctx=deltaContext(candidate);
    const began=performance.now(),full=await port.derive(encoded.base,patch,ctx),fullMs=performance.now()-began;
    const smallBegan=performance.now(),small=await port.derivePatch(encoded.base,patch,ctx),patchMs=performance.now()-smallBegan;
    assert.equal(Object.hasOwn(small,'state'),false);assert.equal(small.canonical,full.canonical);assert.equal(small.format,full.format);assert.deepEqual(small.bytes,full.bytes);
    assert.deepEqual(structuredClone(small.patch),patch);assert.deepEqual(small.previousBase,encoded.base);
    const {canonical:_canonical,bytes:_bytes,...tree}=small,fullTreeNodes=capacityNodes(full.state),patchTreeNodes=capacityNodes(tree);
    assert.ok(patchTreeNodes<fullTreeNodes/10);rows.push({round,phase,fullMs,patchMs,fullTreeNodes,patchTreeNodes,format:small.format});
    encoded.bytes.fill(0);full.bytes.fill(0);state=playbackCopy(full.state);encoded={...full,base:small.base,bytes:small.bytes};
  }
  console.log(JSON.stringify({synthetic:true,defaultWorkerOldMiB:512,timingIsNotRealAppAcceptance:true,rows}));encoded.bytes.fill(0);await port.close();
});
