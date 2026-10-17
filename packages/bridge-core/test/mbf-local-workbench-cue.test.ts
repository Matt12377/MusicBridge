import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { isLocalCueOutputRecord, createLocalCueOutputEvents, projectLocalCueOutputEvent, type LocalCueOutputRecord, type LocalCueOutputProjection } from '../src/collection/local-cue-output-protocol.js'
import { parseCueText } from '../src/library/cue-text-reader.js'
import { buildLocalCuePlan, createLocalCuePlanDraft, localCueCdFramesToPcm, selectLocalCueSourceOutputFormat } from '../src/collection/local-library-workbench/cue-plan.js'
import type { LocalCueAudioProbe, LocalCueFormatQualification, LocalWorkbenchAlbumCapture } from '../src/collection/local-library-workbench/types.js'

const reference = { assetId: 'asset-a', libraryRootId: 'root-a', sourceRootId: 'source-a', rootRevision: 'root-1', fileRevision: 'file-1', locationRevision: 'location-1' }
const sourceText = 'TITLE "合成专辑"\nPERFORMER "合成艺术家"\nFILE "合成.flac" WAVE\nTRACK 01 AUDIO\nTITLE "合成第一轨"\nINDEX 00 00:00:00\nINDEX 01 00:00:01\nTRACK 02 AUDIO\nTITLE "合成第二轨"\nINDEX 00 00:01:00\nINDEX 01 00:01:02\n'
const target = { choiceId: 'target-a', label: '合成独立输出', independent: true as const }
const format: LocalCueFormatQualification = { formatId: 'flac', revision: 'format-1', codec: 'flac', extension: 'flac', lossless: true, evidence: 'encoder-tag-audio-roundtrip', available: true }
function selection(text = sourceText) {
  const parsed = parseCueText(text, new Map([['合成.flac', [reference]]]))
  if (parsed.status !== 'ok') assert.fail('合成CUE预设解析失败')
  const album: LocalWorkbenchAlbumCapture = { albumId: 'album-a', readToken: 'read-a', revision: 'album-1', rootId: 'root-a', directoryId: 'directory-a', editionId: null,
    artistName: '合成艺术家', albumName: '合成专辑', directoryName: '合成目录', manualLocks: { artistName: false, albumName: false },
    members: [{ trackId: 'track-a', assetId: 'asset-a', fileName: '合成.flac', title: null, artist: null, album: null,
      rootRevision: 'root-1', fileRevision: 'file-1', locationRevision: 'location-1', metadataRevision: 'metadata-1' }] }
  const audio: LocalCueAudioProbe[] = [{ assetReference: reference, sourceLabel: '合成.flac', evidence: 'audio-pcm-read', readRevision: 'pcm-1', sampleRate: 44100, totalPcmFrames: 132300 }]
  return { album, cueId: 'cue-a', cueRevision: 'cue-1', parsed, audio }
}
const input = (item = selection()) => ({ selections: [item], target, format, pregapPolicy: 'append-to-previous' as const })

test('CUE纯计划消费实际解析CD75索引，保留原首轨/后轨pregap与末轨总帧语义', () => {
  const item = selection(), before = structuredClone(item), { draft, outputs } = buildLocalCuePlan(input(item))
  assert.equal(draft.scope, 'INDEPENDENT_OUTPUT'); assert.equal(draft.sourceDisposition, 'retain')
  assert.deepEqual(draft.tracks.map(track => [track.sequence, track.startFrame, track.frameCount, track.sampleRate]), [
    [1, 0, 45276, 44100], [2, 45276, 87024, 44100],
  ])
  assert.equal(draft.tracks[0]?.outputFormat, 'flac'); assert.equal(draft.target.choiceId, target.choiceId)
  assert.deepEqual(outputs.map(output => output.sourceAssetId), ['asset-a', 'asset-a'])
  assert.deepEqual(outputs.map(output => output.sourceReadRevision), ['pcm-1', 'pcm-1'])
  assert.deepEqual(item, before)
})

test('CUE无首轨INDEX00时不擅自纳入帧0音频；整数截断与固定原算法相同', () => {
  const item = selection(sourceText.replace('INDEX 00 00:00:00\n', '').replace('INDEX 01 00:00:01', 'INDEX 01 00:00:02'))
  assert.equal(createLocalCuePlanDraft(input(item)).tracks[0]?.startFrame, 1176)
  assert.equal(localCueCdFramesToPcm(1, 32000), 426); assert.equal(localCueCdFramesToPcm(76, 32000), 32426)
  assert.throws(() => localCueCdFramesToPcm(Number.MAX_SAFE_INTEGER, 768000), /安全整数/u)
})

test('CUE没有实际总PCM帧、采样率或只是时长估计时不能形成可执行计划', () => {
  for (const missing of [
    { totalPcmFrames: null }, { sampleRate: null }, { totalPcmFrames: 0 }, { sampleRate: 0 },
    { evidence: 'duration-estimate' },
  ]) {
    const item = selection(); item.audio[0] = { ...item.audio[0]!, ...missing } as unknown as LocalCueAudioProbe
    assert.throws(() => createLocalCuePlanDraft(input(item)), /实际总PCM帧/u)
  }
  const item = selection(); item.audio = []
  assert.throws(() => createLocalCuePlanDraft(input(item)), /实际总PCM帧/u)
})

test('CUE严格拒绝越界、空轨、重叠和非CD75时间基', () => {
  const outside = selection(sourceText.replace('INDEX 01 00:01:02', 'INDEX 01 00:09:00'))
  assert.throws(() => createLocalCuePlanDraft(input(outside)), /超过实际/u)
  // 保持每轨INDEX00/01自身有效，仅让后轨起点与前轨相同，准确触发跨轨重叠。
  const overlap = selection(); overlap.parsed.tracks[1]!.index00Frames = null; overlap.parsed.tracks[1]!.index01Frames = 1
  assert.throws(() => createLocalCuePlanDraft(input(overlap)), /重叠/u)
  const timebase = selection(); timebase.parsed.tracks[0] = { ...timebase.parsed.tracks[0]!, framesPerSecond: 100 } as unknown as typeof timebase.parsed.tracks[number]
  assert.throws(() => createLocalCuePlanDraft(input(timebase)), /CD75/u)
  const empty = selection(); empty.audio[0]!.totalPcmFrames = 45276
  assert.throws(() => createLocalCuePlanDraft(input(empty)), /超过实际/u)
})

test('CUE资格来自实际编码/标签/音频回读，未资格格式和错误扩展拒绝', () => {
  assert.throws(() => createLocalCuePlanDraft({ ...input(), format: { ...format, available: false } }), /没有实际编码/u)
  assert.throws(() => createLocalCuePlanDraft({ ...input(), format: { ...format, extension: 'mp3' } }), /没有实际编码/u)
  assert.throws(() => createLocalCuePlanDraft({ ...input(), format: { ...format, codec: 'mp3', extension: 'mp3', lossless: true } }), /没有实际编码/u)
  const mp3 = createLocalCuePlanDraft({ ...input(), format: { ...format, formatId: 'mp3', codec: 'mp3', extension: 'mp3', lossless: false } })
  assert.equal(mp3.tracks[0]?.outputFormat, 'mp3'); assert.match(mp3.tracks[0]!.outputName, /\.mp3$/u)
})

test('CUE拒绝变化修订/额外源/伪造目标，标签只描述新独立产物', () => {
  const changed = selection(); changed.album.members[0]!.fileRevision = 'file-2'
  assert.throws(() => createLocalCuePlanDraft(input(changed)), /源修订/u)
  const extra = selection(); extra.audio.push({ ...extra.audio[0]!, assetReference: { ...reference, assetId: 'unselected-asset' } })
  assert.throws(() => createLocalCuePlanDraft(input(extra)), /额外源/u)
  assert.throws(() => createLocalCuePlanDraft({ ...input(), target: { ...target, independent: false } as unknown as typeof target }), /独立输出/u)
  const draft = createLocalCuePlanDraft(input())
  assert.ok(draft.tracks.every(track => track.changes.every(change => change.before === null && change.reason === '标签写入新生成的独立分轨文件。')))
  assert.ok(draft.tracks.every(track => !/[\\/]/u.test(track.outputName)))
})

test('CUE不把声明endFrames:null当已验证PCM，也不通过复制抹掉隐藏授权字段', () => {
  const item = selection(); assert.equal(item.parsed.tracks[0]?.endFrames, null); assert.equal(item.parsed.tracks[0]?.playback, 'NOT_VERIFIED')
  item.audio[0]!.totalPcmFrames = null
  assert.throws(() => createLocalCuePlanDraft(input(item)), /实际总PCM帧/u)
  const hidden = input(); Object.defineProperty(hidden, 'sourceDisposition', { value: 'delete', enumerable: false })
  assert.throws(() => createLocalCuePlanDraft(hidden), /独立输出/u)
})


test('CUE465纯输出选择：保留现有源编码，输出未资格时只在FLAC与原精度资格内回退', () => {
  // 这里只构造选择规则字段；不构造encoder回包，也不授实际probe/输出资格。
  const mp3: LocalCueFormatQualification = { ...format, formatId: 'mp3', codec: 'mp3', extension: 'mp3', lossless: false }
  const alac: LocalCueFormatQualification = { ...format, formatId: 'alac', codec: 'alac', extension: 'm4a' }
  const pcm: LocalCueFormatQualification = { ...format, formatId: 'pcm-wav', codec: 'pcm-wav', extension: 'wav' }
  const source = { codec: 'alac', demuxer: 'mov' as const, sampleFormat: 's32', bitsPerSample: 24 }
  assert.equal(selectLocalCueSourceOutputFormat([source], [format, alac]).codec, 'alac')
  assert.equal(selectLocalCueSourceOutputFormat(Array.from({length:100},()=>({...source})), [format, alac]).codec, 'alac')
  assert.equal(selectLocalCueSourceOutputFormat([source], [format, { ...alac, available: false }]).codec, 'flac')
  assert.equal(selectLocalCueSourceOutputFormat([{ ...source, codec: 'mp3float', demuxer: 'mp3' }], [format, mp3]).codec, 'mp3')
  assert.equal(selectLocalCueSourceOutputFormat([{ ...source, codec: 'pcm_s24le', demuxer: 'wav' }], [format, pcm]).codec, 'pcm-wav')
  assert.equal(selectLocalCueSourceOutputFormat([source, { ...source, codec: 'mp3float', demuxer: 'mp3' }], [format, alac, mp3]).codec, 'flac')
  assert.throws(() => selectLocalCueSourceOutputFormat([source], [{ ...format, available: false }]), /真实资格/u)
  assert.throws(() => selectLocalCueSourceOutputFormat([{ ...source, codec: 'pcm_f64le', demuxer: 'wav', sampleFormat: 'dbl', bitsPerSample: 64 }], [format, pcm]), /不能静默降精度/u)
  assert.throws(() => selectLocalCueSourceOutputFormat([{ ...source, bitsPerSample: 32 }], [format, { ...alac, available: false }]), /不能静默降精度/u)
  assert.throws(() => selectLocalCueSourceOutputFormat([{ ...source, demuxer: 'aac' } as unknown as typeof source], [format]), /捕获/u)
})

test('CUE484冷门选择闭集：APE TTA TAK与有损MPC仅回退已资格FLAC，不放宽PCM浮点或精度', () => {
  // 字段选择行为；每族真实解码至EOF及输出资格必须另由当代Native证据证明。
  for(const demuxer of ['ape','tta','tak'] as const){
    const source={codec:demuxer,demuxer,sampleFormat:'s16',bitsPerSample:16};
    assert.equal(selectLocalCueSourceOutputFormat([source],[format]).codec,'flac');
    assert.throws(()=>selectLocalCueSourceOutputFormat([source],[{...format,available:false}]),/真实资格/u);
  }
  for(const [codec,demuxer]of [['musepack7','mpc'],['musepack8','mpc8']]as const){
    const source={codec,demuxer,sampleFormat:'s16p',bitsPerSample:16};
    assert.equal(selectLocalCueSourceOutputFormat([source],[format]).codec,'flac');
    assert.throws(()=>selectLocalCueSourceOutputFormat([{...source,bitsPerSample:64}],[format]),/不能静默降精度/u);
  }
  for(const source of [{codec:'pcm_f32le',demuxer:'wav' as const,sampleFormat:'flt',bitsPerSample:32},{codec:'ape',demuxer:'ape' as const,sampleFormat:'s32',bitsPerSample:32}])
    assert.throws(()=>selectLocalCueSourceOutputFormat([source],[format]),/不能静默降精度/u);
})

test('CUE465纯输出名：NFC和大小写冲突安全派生且预览原输入保持不变', () => {
  const item=selection(), before=structuredClone(item), ordinary=buildLocalCuePlan(input(item)).draft
  const original=ordinary.tracks[0]!.outputName, second=ordinary.tracks[1]!.outputName
  const occupied=[original.toUpperCase(), original.replace(/\.flac$/u, ' (2).flac'), second]
  const namesBefore=[...occupied], planned=buildLocalCuePlan(input(item),occupied).draft
  assert.equal(planned.tracks[0]!.outputName,original.replace(/\.flac$/u,' (3).flac'))
  assert.equal(planned.tracks[1]!.outputName,second.replace(/\.flac$/u,' (2).flac'))
  assert.equal(new Set([...occupied,...planned.tracks.map(t=>t.outputName)].map(n=>n.normalize('NFC').toLocaleLowerCase('en-US'))).size,occupied.length+planned.tracks.length)
  assert.deepEqual(item,before);assert.deepEqual(occupied,namesBefore)
  const unicode=selection(sourceText.replace('合成第一轨','Cafe\u0301'))
  const derived=buildLocalCuePlan(input(unicode),['01 - CAFE\u0301.FLAC']).draft.tracks[0]!.outputName
  assert.equal(derived,'01 - Café (2).flac');assert.ok(Buffer.byteLength(derived)<=240)
  assert.throws(()=>buildLocalCuePlan(input(item),['../外来.flac']),/完整名称观察/u)
})

test('CUE465完整多专辑纯计划：原选择顺序与每专辑轨顺序、源绑定逐件保留', () => {
  const first=selection(),second=structuredClone(first)
  second.album.albumId='album-b';second.album.readToken='read-b';second.album.directoryId='directory-b'
  second.album.members[0]!.assetId='asset-b'
  second.cueId='cue-b';second.cueRevision='cue-2'
  for(const fact of second.parsed.tracks)fact.assetReference={...fact.assetReference,assetId:'asset-b'}
  second.audio[0]!.assetReference={...second.audio[0]!.assetReference,assetId:'asset-b'};second.audio[0]!.readRevision='pcm-2'
  const selections=[second,first], before=structuredClone(selections)
  const result=buildLocalCuePlan({...input(),selections})
  assert.deepEqual(result.draft.albumIds,['album-b','album-a'])
  assert.deepEqual(result.draft.tracks.map(track=>[track.albumId,track.sequence]),[['album-b',1],['album-b',2],['album-a',1],['album-a',2]])
  assert.deepEqual(result.outputs.map(binding=>[binding.sourceAssetId,binding.sourceReadRevision]),[['asset-b','pcm-2'],['asset-b','pcm-2'],['asset-a','pcm-1'],['asset-a','pcm-1']])
  assert.ok(result.draft.tracks.slice(0,2).every(track=>track.outputName.startsWith('001.')))
  assert.ok(result.draft.tracks.slice(2).every(track=>track.outputName.startsWith('002.')))
  assert.deepEqual(selections,before)
})

test('CUE465取消持久协议：原published子集与逐项回执一致，pending不能伪physicalClosed', () => {
  // 仅验证record/CAS投影结构，下面的pins不是Native或真实文件证据。
  const request={commandId:randomUUID(),datasetId:randomUUID(),planId:randomUUID(),expectedRevision:'1',planHash:'a'.repeat(64),contextFingerprint:'b'.repeat(64),kind:'cue' as const}
  const receipt={commandId:request.commandId,datasetId:request.datasetId,planId:request.planId,planHash:request.planHash,state:'unknown' as const,
    items:[{itemId:'item-a',albumId:'album-a',label:'第一轨',state:'unknown' as const,message:null},{itemId:'item-b',albumId:'album-b',label:'第二轨',state:'unknown' as const,message:null}],message:null}
  const staged=['item-a','item-b'].map((itemId,index)=>({itemId,outputName:String(index+1)+'.flac',stageName:String(index).padStart(5,'0')+'.flac',bytes:1234,sha256:'c'.repeat(64),dev:'1',ino:String(index+10)}))
  const pending:LocalCueOutputRecord={schema:1,request,revision:0,phase:'cancelling',outputRoot:{id:randomUUID(),path:'/controlled-cue465-target',dev:'1',ino:'2',authorized:true,label:'纯结构独立目标'},
    stageDirectory:'.musicbridge-cue-'+request.commandId,staged,published:['item-a'],physicalClosed:false,receipt}
  assert.equal(isLocalCueOutputRecord(pending),true)
  assert.equal(isLocalCueOutputRecord({...pending,physicalClosed:true}),false)
  const closed:LocalCueOutputRecord={...pending,revision:1,phase:'cancelled',physicalClosed:true,receipt:{...receipt,state:'cancelled',items:receipt.items.map(item=>({...item,state:item.itemId==='item-a'?'applied':'cancelled'}))}}
  assert.equal(isLocalCueOutputRecord(closed),true)
  assert.equal(isLocalCueOutputRecord({...closed,published:[]}),false)
  assert.equal(isLocalCueOutputRecord({...closed,receipt:{...closed.receipt,items:closed.receipt.items.map(item=>({...item,state:'cancelled'}))}}),false)
  assert.equal(isLocalCueOutputRecord({...closed,phase:'failed',receipt:{...closed.receipt,state:'failed'}}),false)
  const failed:LocalCueOutputRecord={...closed,phase:'failed',receipt:{...closed.receipt,state:'failed',items:closed.receipt.items.map(item=>({...item,state:item.state==='applied'?'applied':'not-written'}))}}
  assert.equal(isLocalCueOutputRecord(failed),true)
  assert.equal(isLocalCueOutputRecord({...failed,physicalClosed:false}),false)
  assert.equal(isLocalCueOutputRecord({...pending,phase:'failing'}),true)
  const projection:LocalCueOutputProjection={latest:new Map(),pending:null};let sequence=0
  for(const event of createLocalCueOutputEvents(pending,null))projectLocalCueOutputEvent(projection,event,++sequence)
  for(const event of createLocalCueOutputEvents(closed,0))projectLocalCueOutputEvent(projection,event,++sequence)
  const recovered=projection.latest.get(request.commandId)!.record
  assert.deepEqual(recovered,closed);assert.deepEqual(recovered.published,['item-a'])
  assert.deepEqual(recovered.staged.map(({bytes,sha256,dev,ino})=>({bytes,sha256,dev,ino})),staged.map(({bytes,sha256,dev,ino})=>({bytes,sha256,dev,ino})))
  assert.equal(recovered.request.commandId,request.commandId)
})
