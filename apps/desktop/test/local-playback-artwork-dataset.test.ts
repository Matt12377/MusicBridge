import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { computed, effectScope, isReadonly, nextTick, ref, shallowRef } from 'vue'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { useLocalLibrary } from '../src/renderer/src/composables/application/useLocalLibrary.js'
import { isLocalAlbumArtworkReply, isLocalAlbumTrackItem, isLocalPlaybackObservationLeaf } from '@music-bridge/contracts'
import type { LocalAlbumArtworkReply, LocalAlbumArtworkRequest, LocalAlbumSummary, LocalAlbumTrackItem, PlaybackSnapshot } from '@music-bridge/contracts'
import { useLocalPlaybackArtwork } from '../src/renderer/src/composables/application/useLocalPlaybackArtwork.js'

// 真实Vue叶组合函数+合成公开DTO；不冒充Source、Owner权限、IMG解码或物理音频输出。
const id = (value: number) => `33333333-3333-4333-8333-${String(value).padStart(12, '0')}`
function member(index: number, rootId = id(1)): LocalAlbumTrackItem {
  const metadata = { title: '同名曲目', artist: '合成作者', album: '同名专辑' }
  const value: LocalAlbumTrackItem = { facts: { track: { id: id(1000 + index), assetId: id(2000 + index), selectionRevision: '1', segment: null },
    asset: { id: id(2000 + index), libraryRootId: rootId, sourceRootId: id(2), rootRevision: '1', fileRevision: '1', locationRevision: '1', sampleFrames: null, timebaseHz: null },
    metadata: { raw: metadata, effective: metadata, override: null }, versionTokens: [], editions: [], fileParameters: null },
    disc: 1, trackNumber: index + 1, sequence: index + 1, statuses: ['has-artwork'] }
  assert.ok(isLocalAlbumTrackItem(value)); return value
}
function album(items: readonly LocalAlbumTrackItem[], changes: Partial<LocalAlbumSummary> = {}): LocalAlbumSummary {
  return { id: 'synthetic-playback-album', rootId: items[0]!.facts.asset.libraryRootId, kind: 'source-directory', editionId: null,
    representativeTrackId: items[0]!.facts.track.id, title: '同名专辑', artists: ['合成作者'], year: null, versionLabel: null,
    trackCount: items.length, revision: 'album-1', artworkAvailable: true, artworkState: 'available', statuses: ['has-artwork'], ...changes }
}
function playing(item: LocalAlbumTrackItem): PlaybackSnapshot {
  const { track, asset, metadata } = item.facts
  const local: NonNullable<PlaybackSnapshot['local']> = { schema_version: '1.2', request_id: id(60), attempt_id: id(61), intent_generation: '1', route: 'roon_audio_input',
    local_track_id: track.id, asset_id: asset.id, asset_revision: asset.fileRevision, target: { core_id: 'synthetic-core', zone_id: 'synthetic-zone' }, session_epoch: id(62),
    phase: 'PLAYING', ownership: 'MB_OWNED', queue_owner: 'MB', delivery_state: 'BYTES_SENT', roon_observation: { event: 'PLAYING', observed: true, correlation: 'ATTEMPT_CONFIRMED' },
    position_ms: 10, quality: { http_bytes: 'NOT_TESTED', signal_path: 'NOT_TESTED', digital_output: 'NOT_TESTED', gapless: 'NOT_TESTED' }, error_code: null }
  assert.ok(isLocalPlaybackObservationLeaf(local))
  return { state: 'playing', source: 'local_file', selectedZoneId: 'synthetic-zone', currentTrack: { id: track.id, title: metadata.effective.title!, artists: ['合成作者'], album: '同名专辑' },
    positionMs: 10, canPause: true, canResume: false, canStop: true, canNext: false, canPrevious: false, local,
    queue: { index: 0, hasNext: false, hasPrevious: false, items: [{ trackId: track.id, resolvedSource: 'local_file', qualityPreference: 'auto',
      local: { local_track_id: track.id, asset_id: asset.id, asset_revision: asset.fileRevision, selection_revision: track.selectionRevision, location_revision: asset.locationRevision, root_revision: asset.rootRevision } }] } }
}
function reply(request: LocalAlbumArtworkRequest, variant = false): LocalAlbumArtworkReply {
  const display = { mime: 'image/jpeg' as const, bytes: variant ? 4 : 3, sha256: (variant ? 'b' : 'a').repeat(64), width: 512, height: 512,
    dataUrl: variant ? 'data:image/jpeg;base64,/9j/AA==' : 'data:image/jpeg;base64,/9j/' }
  const value: LocalAlbumArtworkReply = { ...request, status: 'ready', image: { original: { mime: display.mime, bytes: display.bytes, sha256: display.sha256, width: 512, height: 512 }, display } }
  assert.ok(isLocalAlbumArtworkReply(value, request)); return value
}

async function drain() { for (let pass=0;pass<12;pass++){await Promise.resolve();await nextTick()} }
function latch() { let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done});return {promise,resolve} }
function fixture(t:TestContext) {
  const values=[member(0),member(1)],selectedAlbum=shallowRef<LocalAlbumSummary|null>(album(values)),tracks=shallowRef<readonly LocalAlbumTrackItem[]>(values)
  const snapshot=shallowRef<PlaybackSnapshot|null>(null),clock=ref<string|undefined>(),core=ref({runtime:'ready'}),sync=ref('ready')
  const workbenchState=shallowRef<import('@music-bridge/contracts').LocalLibraryManagementReadback|null>(null)
  const sourceTrack=computed(()=>snapshot.value?.currentTrack),scope=effectScope()
  const state={datasetId:id(90),outboxFails:false,malformed:false,outboxReads:0}
  const sends:import('@music-bridge/contracts').LocalPlayRequest[]=[],images:{request:LocalAlbumArtworkRequest;resolve(value:LocalAlbumArtworkReply):void;reject(error:Error):void}[]=[]
  let held:{entered:ReturnType<typeof latch>;release:ReturnType<typeof latch>}|null=null
  const heldReads:{entered:ReturnType<typeof latch>;release:ReturnType<typeof latch>}[]=[]
  const api={
    async getCommandOutbox(){
      state.outboxReads++;const read=held;held=null
      if(read){read.entered.resolve();await read.release.promise}
      if(state.outboxFails)throw new Error('合成Outbox读取失败')
      return {datasetId:state.datasetId,entries:state.malformed?[{}]:[]}
    },
    async listLocalLibraryRoots(){const a=values[0]!.facts.asset;return [{root:{id:a.libraryRootId,sourceRootId:a.sourceRootId,revision:a.rootRevision,role:'library'},label:'合成库',availability:'ONLINE'}]},
    async getLocalLibraryPlaybackTarget(){return {core_id:'synthetic-core',zone_id:'synthetic-zone'}},
    async getLocalLibraryTrackDetail(trackId:string){const found=values.find(value=>value.facts.track.id===trackId);assert.ok(found);return found.facts},
    async queryLocalLibraryTracks(query:import('@music-bridge/contracts').LocalLibraryQuery){return {...query,total:0,items:[],hasMore:false}},
  }
  const localLibrary=useLocalLibrary({api:api as unknown as import('@music-bridge/contracts').LocalLibraryPublicApi,
    getSelectedZone:()=>({zoneId:'synthetic-zone',displayName:'合成目标',selected:true}),getPlaybackAlbum:()=>selectedAlbum.value,getPlaybackSnapshot:()=>snapshot.value,
    play:async request=>{
      sends.push(structuredClone(request));const value=values.find(item=>item.facts.track.id===request.local_track_id);assert.ok(value)
      clock.value=`current-core:${request.request_id}`
      const next=playing(value);snapshot.value={...next,local:{...next.local!,request_id:request.request_id}}
      return {status:'accepted',request_id:request.request_id,action:request.action}
    },
  })
  const source=readFileSync(new URL('../src/renderer/src/App.vue',import.meta.url),'utf8')
  const begin=source.indexOf('const { currentTrack } = useLocalPlaybackArtwork({'),end=source.indexOf('\nconst workbenchPorts',begin)
  assert.ok(begin>=0&&end>begin,'必须执行正式App播放器图叶，不能复制dataset fallback表达式')
  const code=ts.transpileModule(source.slice(begin,end)+'\nreturn currentTrack;',{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText
  let datasetSelector!:()=>string|null
  const currentTrack=scope.run(()=>new Function('useLocalPlaybackArtwork','workbenchLibrary','localLibrary','coreState','playbackSyncStatus','playbackClockIdentity','playback','sourceCurrentTrack','albumBrowser','coverDropBrowser','readLocalArtworkWithFlow',code)(
    (options:Parameters<typeof useLocalPlaybackArtwork>[0])=>{datasetSelector=options.getDatasetId;return useLocalPlaybackArtwork(options)},
    {state:workbenchState},localLibrary,core,sync,clock,{playbackState:snapshot},sourceTrack,{selectedAlbum,tracks},{selectedAlbum:ref(null),tracks:ref([])},
    (request:LocalAlbumArtworkRequest)=>new Promise<LocalAlbumArtworkReply>((resolve,reject)=>images.push({request:structuredClone(request),resolve,reject})))) as import('vue').ComputedRef<import('@music-bridge/contracts').TrackSummary|undefined>
  t.after(async()=>{scope.stop();localLibrary.dispose();for(const hold of heldReads)hold.release.resolve();for(const image of images)image.resolve(reply(image.request));await drain()})
  const activate=()=>localLibrary.activate({deferTrackReads:true,deferContextReads:true})
  const holdOutbox=()=>{const gate={entered:latch(),release:latch()};heldReads.push(gate);held=gate;return gate}
  return {values,selectedAlbum,tracks,snapshot,clock,core,sync,workbenchState,localLibrary,state,sends,images,currentTrack,datasetSelector,activate,holdOutbox}
}

test('PLAYBACK_DISPLAY_DATASET 真点播captureDataset成功后WB仍null也立即读同专辑五元组图，ref只读且不改Core快照',async t=>{
  const f=fixture(t);await f.activate()
  assert.equal(f.localLibrary.displayDatasetId.value,null);assert.equal(f.state.outboxReads,0);assert.ok(isReadonly(f.localLibrary.displayDatasetId))
  await f.localLibrary.playTrack(f.values[0]!.facts.track.id);await drain()
  assert.equal(f.workbenchState.value,null);assert.equal(f.localLibrary.displayDatasetId.value,id(90));assert.equal(f.state.outboxReads,1)
  assert.equal(f.sends.length,1);assert.equal(f.images.length,1)
  const a=f.selectedAlbum.value!
  assert.deepEqual(f.images[0]!.request,{albumKey:a.id,rootId:a.rootId,editionId:a.editionId,representativeTrackId:a.representativeTrackId,revision:a.revision})
  const raw=JSON.stringify(f.snapshot.value);f.images[0]!.resolve(reply(f.images[0]!.request));await drain()
  assert.equal(f.currentTrack.value?.artworkUrl,reply(f.images[0]!.request).image!.display.dataUrl);assert.equal(JSON.stringify(f.snapshot.value),raw)
})

test('PLAYBACK_DISPLAY_DATASET session普通真实Outbox读也能提供提示；被动overview事件不能制造首次已确认身份',async t=>{
  const f=fixture(t);await f.activate();f.localLibrary.observeOutbox({datasetId:id(90),entries:[]})
  assert.equal(f.localLibrary.displayDatasetId.value,null);assert.equal(f.state.outboxReads,0)
  await f.localLibrary.refresh();assert.equal(f.localLibrary.displayDatasetId.value,id(90));assert.equal(f.state.outboxReads,1)
  assert.equal(f.sends.length,0);assert.equal(f.images.length,0)
})

test('PLAYBACK_DISPLAY_DATASET WB真实身份仍优先于session显示fallback，null时才使用session提示',async t=>{
  const f=fixture(t);await f.activate();await f.localLibrary.refresh()
  assert.equal(f.datasetSelector(),id(90))
  f.workbenchState.value={datasetId:id(91),revision:'1',scanConcurrency:12,libraries:[]};assert.equal(f.datasetSelector(),id(91))
  f.workbenchState.value=null;assert.equal(f.datasetSelector(),id(90));assert.equal(f.sends.length,0)
})

test('PLAYBACK_DISPLAY_DATASET Outbox真失败或无效DTO不发布显示身份，也不派发点播或图片',async t=>{
  for(const mode of ['failure','invalid'] as const)await t.test(mode,async sub=>{
    const f=fixture(sub);await f.activate();f.state.outboxFails=mode==='failure';f.state.malformed=mode==='invalid'
    await f.localLibrary.playTrack(f.values[0]!.facts.track.id);await drain()
    assert.equal(f.localLibrary.displayDatasetId.value,null);assert.equal(f.images.length,0);assert.equal(f.sends.length,0)
    assert.ok(f.localLibrary.actionError.value)
  })
})

test('PLAYBACK_DISPLAY_DATASET 已确认session遇实际不同dataset拒绝改绑并撤显示提示，原播放/队列不变',async t=>{
  const f=fixture(t);await f.activate();await f.localLibrary.playTrack(f.values[0]!.facts.track.id);await drain()
  f.images[0]!.resolve(reply(f.images[0]!.request));await drain();assert.ok(f.currentTrack.value?.artworkUrl)
  const raw=JSON.stringify(f.snapshot.value);f.state.datasetId=id(91);await f.localLibrary.refresh();await drain()
  assert.equal(f.localLibrary.displayDatasetId.value,null);assert.equal(f.currentTrack.value?.artworkUrl,undefined)
  assert.equal(f.sends.length,1);assert.equal(JSON.stringify(f.snapshot.value),raw)
})

test('PLAYBACK_DISPLAY_DATASET suspend/dispose后迟到capture不发布显示身份或点播',async t=>{
  for(const mode of ['suspend','dispose'] as const)await t.test(mode,async sub=>{
    const f=fixture(sub);await f.activate();const held=f.holdOutbox(),play=f.localLibrary.playTrack(f.values[0]!.facts.track.id)
    await held.entered.promise;f.localLibrary[mode]();held.release.resolve();await play;await drain()
    assert.equal(f.localLibrary.displayDatasetId.value,null);assert.equal(f.sends.length,0);assert.equal(f.images.length,0)
  })
})

test('PLAYBACK_DISPLAY_DATASET 离开专辑后session提示仍支持已核成员下一首，dispose才撤提示',async t=>{
  const f=fixture(t);await f.activate();await f.localLibrary.playTrack(f.values[0]!.facts.track.id);await drain()
  f.images[0]!.resolve(reply(f.images[0]!.request));await drain();f.localLibrary.suspend();f.selectedAlbum.value=null;f.tracks.value=[]
  f.clock.value='current-core:automatic-next';f.snapshot.value=playing(f.values[1]!);await drain()
  assert.equal(f.localLibrary.displayDatasetId.value,id(90));assert.equal(f.images.length,2)
  assert.equal(f.images[1]!.request.albumKey,album(f.values).id)
  f.localLibrary.dispose();await drain();assert.equal(f.localLibrary.displayDatasetId.value,null)
})

test('PLAYBACK_DISPLAY_DATASET 明确未ready撤旧图，旧成功不得复活；同代恢复仍走真实新图请求',async t=>{
  const f=fixture(t);await f.activate();await f.localLibrary.playTrack(f.values[0]!.facts.track.id);await drain()
  assert.equal(f.images.length,1);f.core.value={runtime:'starting'};f.images[0]!.resolve(reply(f.images[0]!.request));await drain()
  assert.equal(f.currentTrack.value?.artworkUrl,undefined)
  f.clock.value='new-core:accepted-clock';f.core.value={runtime:'ready'};await drain();assert.equal(f.images.length,2)
  f.images[1]!.resolve(reply(f.images[1]!.request,true));await drain();assert.equal(f.currentTrack.value?.artworkUrl,reply(f.images[1]!.request,true).image!.display.dataUrl)
})

test('PLAYBACK_DISPLAY_DATASET 图API拒绝保留原不自动重发，进度更新零额外读；真实ready恢复才再读',async t=>{
  const f=fixture(t);await f.activate();await f.localLibrary.playTrack(f.values[0]!.facts.track.id);await drain();f.images[0]!.reject(new Error('合成图片读失败'));await drain()
  for(let i=0;i<6;i++){f.snapshot.value={...f.snapshot.value!,positionMs:i+200};await drain()}
  assert.equal(f.images.length,1);assert.equal(f.sends.length,1)
  f.sync.value='suspended';f.sync.value='ready';await drain();assert.equal(f.images.length,2)
  f.images[1]!.resolve(reply(f.images[1]!.request));await drain();assert.ok(f.currentTrack.value?.artworkUrl)
})
