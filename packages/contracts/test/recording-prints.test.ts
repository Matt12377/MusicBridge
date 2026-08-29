import assert from 'node:assert/strict';
import test from 'node:test';
import * as c from '../src/index.js';
const id = (n: number): string => `20000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const date = '2026-08-28T00:00:00.000Z', end = '2026-08-29T00:00:00.000Z', hash = (s: string): string => s.repeat(64);
function planFixture() {
  const technical = { container: 'WAV', codec: 'PCM', sampleRate: 48000, channels: 2, bitsPerSample: 16, durationMs: 1000, lossless: true, sampleFrames: 48000, frameEvidence: 'container-declared' as const };
  const binding: c.SourceBinding = { id: id(4), rootId: id(5), fileName: '合成.wav', acquisition: 'userFileBind', verification: 'fileHashVerified', preservation: 'externalReferenceOnly', availability: 'ONLINE', sha256: hash('a'), size: 192044, modifiedAt: date, verifiedAt: date, technical, userConfirmed: true, sourceLockEligible: true };
  const master: c.MasterVersion = { id: id(2), draftId: id(1), sequence: 1, title: '合成母版', createdAt: date, content: { programType: 'compilation', tracks: [{ trackId: id(3), metadata: { title: '合成曲目', durationMs: 1000 }, source: { sha256: binding.sha256, size: binding.size, technical }, transitionAfterMs: 0, keepWithNext: false }] }, contentHash: hash('b'), sourceEvidence: [{ trackId: id(3), binding }], status: 'frozen' };
  const capacityFrames = 1440000;
  const layout: c.LayoutVersion = { id: id(6), draftId: master.draftId, masterVersionId: master.id, sequence: 1, planId: id(7), createdAt: date, spec: { format: 'cassette', splitAfter: 1, leadInMs: 0, tailMs: 0, defaultGapMs: 5000, rules: [], compatibility: { confirmed: true, cassetteTypes: ['II'], dat: false } }, lengthMinutes: 1, reservation: { physicalId: 'MB-C-00001', modelId: id(8), skuId: id(9), packaging: 'opened' }, timeline: { timebase: 'sample-frames', sampleRate: 48000, rounding: 'nearest-half-up-v1', sides: [{ name: 'A', capacityFrames, leadInFrames: 0, tailFrames: 0, totalFrames: 48000, tracks: [{ trackId: id(3), sourceBindingId: binding.id, sourceSampleRate: 48000, sourceFrames: 48000, startFrame: 0, endFrame: 48000, gapAfterFrames: 0 }] }, { name: 'B', capacityFrames, leadInFrames: 0, tailFrames: 0, totalFrames: 0, tracks: [] }] }, timelineHash: hash('c'), status: 'frozen', executionReady: false };
  const profile: c.RecordingProfileVersion = { id: id(10), profileId: id(11), sequence: 1, createdAt: date, contentHash: hash('d'), content: { name: '合成录音配置', signalChain: [{ id: id(12), kind: 'audio-interface', label: '未认证合成设备' }], defaults: { noiseReduction: 'Off', calibration: null, recordLevel: null, preRollMs: 1000 }, compatibility: layout.spec.compatibility, executionFormat: { sampleRate: 48000, channelCount: 2, channelLayout: 'stereo', internalProcessingPrecision: 'integer-bit-copy', outputSampleFormat: 'pcm-s16le', resamplerImplementation: 'none', resamplerVersion: 'not-applied', ditherPolicy: 'none', channelMapping: 'identity', outputBackend: { id: 'synthetic-unverified', version: '1' } } } };
  const settings: c.ResolvedRecordingSettings = { profile, overrides: {}, effective: c.effectiveRecordingSettings(profile, {}), format: { ...profile.content.executionFormat, outputProfileVersion: profile.id }, fingerprint: hash('e') };
  const recipe: c.ExecutionRecipe = { schemaVersion: 1, mode: 'direct', compiler: 'musicbridge-pcm-copy-v1', masterVersionId: master.id, layoutVersionId: layout.id, contentHash: master.contentHash, plannedTimelineHash: layout.timelineHash, format: settings.format, side: 'A', capacityFrames, totalFrames: 48000, segments: [{ kind: 'source', trackId: id(3), input: { sha256: binding.sha256, size: binding.size, sampleRate: 48000, channelCount: 2, bitsPerSample: 16, totalFrames: 48000 }, startFrame: 0, endFrame: 48000 }], formalReady: false };
  const receipt: c.ExecutionAudioReceipt = { recipe, recipeHash: hash('f'), origin: 'compiled', audio: { sha256: hash('a'), pcmSha256: hash('b'), size: 192044, frameCount: 48000, dataOffset: 44 }, formalReady: false };
  const material = { master, layout, execution: { assetId: id(13), manifestHash: hash('d'), mode: 'direct' as const, compiledSettings: settings, recipes: [recipe, { ...recipe, side: 'B' as const, totalFrames: 0, segments: [] }], audio: [receipt] }, physicalCopy: { physicalId: layout.reservation.physicalId, lotId: id(14), skuId: layout.reservation.skuId, lengthMinutes: 1, packaging: 'opened' as const, usage: 'reserved' as const, available: true, origin: 'blank-pool' as const, revision: 2 }, mediaPlanRevision: 2, profileSnapshot: { sessionRevision: 3, settings: { ...settings, overrides: { noiseReduction: null }, effective: c.effectiveRecordingSettings(profile, { noiseReduction: null }), fingerprint: hash('f') } }, archive: { operationId: id(15), rootId: id(16), sourcePolicy: 'reference-dependent' as const, manifestHash: hash('a'), phase: 'FINALIZED' as const, objectCount: 3, copyBytes: 192500 }, retentionPolicy: 'f01-permanent-execution-v1' as const, onlineFallback: false as const, formalReady: false as const };
  const selection = { assetId: material.execution.assetId, archiveOperationId: material.archive.operationId };
  const proposal = { ...material, draftId: master.draftId, selection, checkedAt: date, proposalFingerprint: hash('c') };
  const plan = { ...material, id: id(17), draftId: master.draftId, sequence: 1, createdAt: date, contentHash: hash('e'), status: 'frozen' as const };
  return { material, selection, proposal, plan };
}
function recordFixture(): c.RecordingRecord {
  const { plan } = planFixture(), receipt = plan.execution.audio[0]!;
  return { schemaVersion: 1, id: id(50), createdAt: end, contentHash: hash('a'), completion: {
    kind: 'formal', id: id(51), draftId: plan.draftId, planVersionId: plan.id, planContentHash: plan.contentHash, executionAssetId: plan.execution.assetId, physicalId: plan.physicalCopy.physicalId,
    revision: 7, createdAt: date, updatedAt: end, endedAt: end, status: 'completed', phase: 'finished', softwarePlaybackComplete: true, physicalRecordingConfirmedAt: end, finalVerificationCompleteAt: end,
    sides: [{ side: 'A', phase: 'complete', frameCount: receipt.audio.frameCount, recipeHash: receipt.recipeHash, audioSha256: receipt.audio.sha256, pcmSha256: receipt.audio.pcmSha256, runId: id(52), sourceFramesRead: 48000, submittedFrames: 48000, consumedFrames: 48000, sourceEof: true, backendDrained: true, engineStoppedSubmitting: true, stopAcknowledged: false, cleanupQuiescent: false, startedAt: date, endedAt: end, physicalStopConfirmedAt: end }],
  }, media: { snapshotSource: 'completion', modelId: plan.layout.reservation.modelId, lotId: plan.physicalCopy.lotId, skuId: plan.physicalCopy.skuId, lengthMinutes: 1, origin: 'blank-pool', descriptor: { brand: '合成', name: '系列', edition: '', year: null, format: 'cassette', tapeType: 'II', identification: 'unidentified' } },
  visuals: { artwork: { state: 'not-captured', reason: 'not-provided' }, jCard: { state: 'not-captured', reason: 'not-implemented' }, photos: { state: 'not-captured', reason: 'not-provided' } } };
}
function stateFixture(): c.PhysicalRecordingState { return { physicalId: 'MB-C-00001', revision: 1, physicalRevision: 3, knowledge: { state: 'confirmed-recording', recordingId: id(50), confirmedAt: end, evidence: { kind: 'completed-attempt', attemptId: id(51), revision: 7 } }, latestAttempt: { id: id(51), revision: 7, status: 'completed' }, activeRerecordPermit: null }; }

const image={dataUrl:'data:image/jpeg;base64,/9j/2Q==',width:1,height:1};
const artwork=()=>({id:id(81),masterVersionId:id(2),sequence:1,createdAt:date,sha256:hash('a'),size:4,width:1,height:1,mimeType:'image/jpeg' as const});
const facts=()=>({schemaVersion:1 as const,recordingId:id(50),recordingContentHash:hash('a'),planVersionId:id(17),planContentHash:hash('e'),physicalId:'MB-C-00001',title:'合成母版',spine:'合成母版',completedAt:end,displayDateUtc:'2026-08-29',tapeModel:{state:'known' as const,descriptor:recordFixture().media.descriptor!},sides:[{side:'A' as const,frameCount:48000,sampleRate:48000,durationMs:1000,tracks:[{position:1,trackId:id(3),title:'合成曲目'}]},{side:'B' as const,frameCount:0,sampleRate:48000,durationMs:0,tracks:[]}],artwork:{state:'not-captured' as const,reason:'not-provided' as const}});
const request=()=>({id:id(82),recordingId:id(50),recordingContentHash:hash('a'),planVersionId:id(17),planContentHash:hash('e'),origin:'completion' as const,templateId:'jp0-basic-v1' as const,templateHash:hash('c'),factsHash:hash('d'),inputHash:hash('e'),createdAt:end});
const job=()=>({id:id(83),request:request(),state:'pending' as const,revision:1,createdAt:end,updatedAt:end,artifactId:null,errorCode:null});
const lease=()=>({leaseId:id(84),workerId:id(85),jobId:id(83),requestId:id(82),inputHash:hash('e'),facts:facts(),artworkImage:null,templateId:'jp0-basic-v1' as const});
const artifact=()=>({id:id(86),requestId:id(82),recordingId:id(50),createdAt:end,inputHash:hash('e'),templateId:'jp0-basic-v1' as const,templateHash:hash('c'),rendererVersion:'musicbridge-jp0-electron-v1',pdfSha256:hash('f'),size:100,pageCount:2,geometry:c.RECORDING_PRINT_GEOMETRY,previewSha256:hash('a'),previewSize:4,artwork:facts().artwork});
const pdf=Buffer.from('%PDF-1.4\nsynthetic-contract-only\n%%EOF').toString('base64');
test('Artwork不可变版本限JPEG/1MiB/1200，拒绝角色偷换与未知键',()=>{
 assert.equal(typeof c.isMasterArtworkVersion,'function');assert.equal(c.isMasterArtworkVersion(artwork()),true);
 for(const patch of [{size:1048577},{width:1201},{mimeType:'image/png'},{sequence:0},{id:id(81)+'\n'},{physicalId:'MB-C-00001'}])assert.equal(c.isMasterArtworkVersion({...artwork(),...patch}),false);
 assert.equal(c.isRecordingArtworkSnapshot({state:'captured',version:artwork()}),true);assert.equal(c.isRecordingArtworkSnapshot({state:'captured',photoId:id(81)}),false);
})
test('Artwork请求CAS严格且取消不造selected/保存',()=>{
 const save={commandId:id(90),masterVersionId:id(2),expectedVersionId:null,image,userConfirmed:true};assert.equal(c.isSaveMasterArtworkRequest(save),true);
 for(const patch of [{expectedVersionId:undefined},{image:{...image,path:'/private'}},{userConfirmed:false},{masterVersionId:[id(2)]}])assert.equal(c.isSaveMasterArtworkRequest({...save,...patch}),false);
 assert.equal(c.isPickMasterArtworkResult({state:'cancelled'}),true);assert.equal(c.isPickMasterArtworkResult({state:'cancelled',image}),false);
 assert.equal(c.isMasterArtworkResult({masterVersionId:id(2),currentVersion:artwork(),version:artwork(),image}),true);assert.equal(c.isMasterArtworkResult({masterVersionId:id(3),currentVersion:artwork(),version:artwork(),image}),false);
 assert.equal(c.isMasterArtworkResult({masterVersionId:id(2),currentVersion:null,version:null,image}),false);
})
test('Recordv1原样严格，v2要求Cassette请求ID与历史Artwork，DAT无卡片',()=>{
 const old=recordFixture();assert.equal(c.isRecordingRecord(old),true);assert.equal(c.isRecordingRecord({...old,printRequestId:id(82)}),false);assert.equal(c.isRecordingRecord({...old,visuals:{...old.visuals,artwork:{state:'captured',version:artwork()}}}),false);
 const v2={...old,schemaVersion:2,printRequestId:id(82),visuals:{...old.visuals,artwork:{state:'captured',version:artwork()},jCard:{state:'not-captured',reason:'not-provided'}}};assert.equal(c.isRecordingRecord(v2),true);
 for(const patch of [{printRequestId:null},{printRequestId:undefined},{media:{...v2.media,snapshotSource:'legacy-plan-only'}},{visuals:{...v2.visuals,jCard:{state:'captured',id:id(1)}}}])assert.equal(c.isRecordingRecord({...v2,...patch}),false);
 const detail={record:v2,plan:planFixture().plan,current:stateFixture()};assert.equal(c.isRecordingRecordDetail(detail),true);assert.equal(c.isRecordingRecordDetail({...detail,record:{...v2,visuals:{...v2.visuals,artwork:{state:'captured',version:{...artwork(),masterVersionId:id(99)}}}}}),false);
 const dat={...v2,printRequestId:null,completion:{...v2.completion,physicalId:'MB-D-00001',sides:[{...v2.completion.sides[0],side:'Program'}]},media:{...v2.media,descriptor:{...v2.media.descriptor,format:'dat',tapeType:'dat'}},visuals:{...v2.visuals,jCard:{state:'not-captured',reason:'not-applicable'}}};assert.equal(c.isRecordingRecord(dat),true);assert.equal(c.isRecordingRecord({...dat,printRequestId:id(82)}),false);
})
test('PrintFacts精确A/B/实际整面时长/UTC/曲序，无逐曲伪实际时长',()=>{
 assert.equal(c.isRecordingPrintFacts(facts()),true);
 for(const patch of [{displayDateUtc:'2026-08-28'},{physicalId:'MB-D-00001'},{title:''},{sides:[facts().sides[0]]},{sides:[facts().sides[1],facts().sides[0]]},{sides:[{...facts().sides[0],durationMs:999},facts().sides[1]]},{sides:[{...facts().sides[0],tracks:[{position:2,trackId:id(3),title:'曲目',durationMs:1000}]},facts().sides[1]]}])assert.equal(c.isRecordingPrintFacts({...facts(),...patch}),false);
 assert.equal(c.isRecordingPrintFacts({...facts(),tapeModel:{state:'unknown'}}),true);assert.equal(c.isRecordingPrintFacts({...facts(),tapeModel:{state:'unknown',descriptor:facts().tapeModel.descriptor}}),false);
})
test('打印Job阶段/Artifact/错误互斥，列表25与唯一ID',()=>{
 assert.equal(c.isRecordingPrintJob(job()),true);assert.equal(c.isRecordingPrintJob({...job(),state:'failed',errorCode:'LAYOUT_OVERFLOW'}),true);assert.equal(c.isRecordingPrintJob({...job(),state:'ready',artifactId:id(86)}),true);
 for(const patch of [{state:'ready'},{state:'pending',artifactId:id(86)},{state:'failed'},{errorCode:'raw stack'},{revision:0},{updatedAt:date}])assert.equal(c.isRecordingPrintJob({...job(),...patch}),false);
 const page={items:[job()],offset:0,limit:25,total:1,hasMore:false};assert.equal(c.isRecordingPrintsPage(page),true);assert.equal(c.isRecordingPrintsPage({...page,limit:26}),false);assert.equal(c.isRecordingPrintsPage({...page,items:[job(),job()],total:2}),false);
})
test('Artifact与预览严格预算/固定几何/归属，未打印不造printedAt',()=>{
 assert.equal(c.isPrintedArtifact(artifact()),true);for(const patch of [{pageCount:25},{size:4194305},{previewSize:1048577},{printedAt:end},{geometry:{...c.RECORDING_PRINT_GEOMETRY,widthMm:100}}])assert.equal(c.isPrintedArtifact({...artifact(),...patch}),false);
 assert.equal(c.isRecordingPrintResult({artifact:artifact(),facts:facts(),preview:image}),true);assert.equal(c.isRecordingPrintResult({artifact:{...artifact(),recordingId:id(99)},facts:facts(),preview:image}),false);
})
test('八公开API与私有请求严格未知键且不进outbox',()=>{
 const cases:Record<string,unknown>={'masterArtwork.get':{masterVersionId:id(2)},'masterArtwork.save':{commandId:id(90),masterVersionId:id(2),expectedVersionId:null,image,userConfirmed:true},'recordingPrints.list':{recordingId:id(50),page:{offset:0,limit:25}},'recordingPrints.request':{commandId:id(90),recordingId:id(50),expectedRecordHash:hash('a'),templateId:'jp0-basic-v1',userConfirmed:true},'recordingPrints.retry':{commandId:id(90),jobId:id(83),expectedRevision:1,userConfirmed:true},'recordingPrints.get':{recordingId:id(50),artifactId:id(86)},'recordingPrintWorker.claim':{workerId:id(85)},'recordingPrintWorker.complete':{leaseId:id(84),workerId:id(85),jobId:id(83),inputHash:hash('e'),pdfBase64:pdf,pdfSha256:hash('f'),preview:image,pageCount:2,rendererVersion:'musicbridge-jp0-electron-v1'},'recordingPrintWorker.fail':{leaseId:id(84),workerId:id(85),jobId:id(83),inputHash:hash('e'),errorCode:'RENDER_FAILED'},'recordingPrintWorker.pdf':{recordingId:id(50),artifactId:id(86),expectedPdfSha256:hash('f')}};
 for(const [command,payload] of Object.entries(cases)){assert.equal(c.validateIpcRequest({version:1,id:'print',command,payload}).ok,true,command);assert.equal(c.validateIpcRequest({version:1,id:'print',command,payload:{...payload as object,path:'/private'}}).ok,false,command);assert.equal(c.isCommandOutboxCommand(command),false)}
 assert.equal(c.isExportRecordingPrintRequest(cases['recordingPrintWorker.pdf']),true);assert.equal(c.isExportRecordingPrintResult({state:'cancelled'}),true);assert.equal(c.isExportRecordingPrintResult({state:'cancelled',artifactId:id(86)}),false);
})
test('私有Lease与PDF结果不通过公共response validator，PDF有界语法',()=>{
 assert.equal(c.isRecordingPrintLease(lease()),true);assert.equal(c.isRecordingPrintLease({...lease(),artworkImage:image}),false);
 const internal={version:1,id:'print',ok:true,result:{lease:lease()}};assert.equal(c.validateIpcInternalResponseForCommand(internal,'recordingPrintWorker.claim' as c.IpcInternalCommand).ok,true);assert.equal(c.validateIpcResponseForCommand(internal,'recordingPrintWorker.claim' as c.IpcCommand).ok,false);
 const complete={leaseId:id(84),workerId:id(85),jobId:id(83),inputHash:hash('e'),pdfBase64:pdf,pdfSha256:hash('f'),preview:image,pageCount:2,rendererVersion:'musicbridge-jp0-electron-v1'};
 assert.equal(c.isCompleteRecordingPrintRequest(complete),true);for(const pdfBase64 of ['not base64',Buffer.from('not PDF').toString('base64'),pdf+'\n'])assert.equal(c.isCompleteRecordingPrintRequest({...complete,pdfBase64}),false);
})

test('所有新增有限标识拒尾换行，字段顺序不改变有效Artwork身份',()=>{
 assert.equal(c.isRecordingPrintFacts({...facts(),physicalId:'MB-C-00001\n'}),false);
 assert.equal(c.isPrintedArtifact({...artifact(),rendererVersion:'musicbridge-v1\n'}),false);
 const reordered=Object.fromEntries(Object.entries(artwork()).reverse());assert.equal(c.isMasterArtworkResult({masterVersionId:id(2),currentVersion:artwork(),version:reordered,image}),true);
})
test('v2未来Artwork不可冒充完成时快照，照片仍只能同实体photo',()=>{
 const old=recordFixture(),v2={...old,schemaVersion:2,printRequestId:id(82),visuals:{...old.visuals,artwork:{state:'captured',version:{...artwork(),createdAt:'2026-08-30T00:00:00.000Z'}},jCard:{state:'not-captured',reason:'not-provided'}}};assert.equal(c.isRecordingRecord(v2),false);
 assert.equal(c.isRecordingPrintFacts({...facts(),sides:[{...facts().sides[0],tracks:Array.from({length:201},(_,index)=>({position:index+1,trackId:id(100+index),title:'曲目'}))},facts().sides[1]]}),false);
 assert.equal(c.isCompleteRecordingPrintRequest({leaseId:id(84),workerId:id(85),jobId:id(83),inputHash:hash('e'),pdfBase64:pdf,pdfSha256:hash('f'),preview:image,pageCount:25,rendererVersion:'test-v1'}),false);
})

test('R023字段拆分：未验payload保持unknown，公开完整guard仍拒绝坏图像和PDF',()=>{
 const complete={leaseId:id(84),workerId:id(85),jobId:id(83),inputHash:hash('e'),pdfBase64:pdf,pdfSha256:hash('f'),preview:image,pageCount:2,rendererVersion:'test-v1'};
 const save={commandId:id(90),masterVersionId:id(2),expectedVersionId:null,image,userConfirmed:true};
 for(const value of [null,undefined,'wrong',{},12]){
  assert.equal(c.isCompleteRecordingPrintRequestFields({...complete,pdfBase64:value,preview:value}),true);
  assert.equal(c.isCompleteRecordingPrintRequest({...complete,pdfBase64:value,preview:value}),false);
  assert.equal(c.isSaveMasterArtworkRequestFields({...save,image:value}),true);
  assert.equal(c.isSaveMasterArtworkRequest({...save,image:value}),false);
 }
 for(const patch of [{leaseId:id(84)+'\n'},{workerId:''},{jobId:null},{inputHash:'A'.repeat(64)},{pdfSha256:'wrong'},{pageCount:0},{pageCount:25},{pageCount:1.5},{rendererVersion:'bad\n'},{rendererVersion:''},{trusted:true}]){
  assert.equal(c.isCompleteRecordingPrintRequestFields({...complete,...patch}),false);assert.equal(c.isCompleteRecordingPrintRequest({...complete,...patch}),false);
 }
 for(const patch of [{commandId:''},{masterVersionId:null},{expectedVersionId:'bad'},{userConfirmed:false},{trusted:true}]){
  assert.equal(c.isSaveMasterArtworkRequestFields({...save,...patch}),false);assert.equal(c.isSaveMasterArtworkRequest({...save,...patch}),false);
 }
 assert.equal(c.isCompleteRecordingPrintRequest(complete),true);assert.equal(c.isSaveMasterArtworkRequest(save),true);
});
test('R023尺寸共享：原JPEG编码长度与Artwork实际字节界限不合并收紧',()=>{
 for(const width of [0,1,1200,1201,1.5,NaN,'1',null])for(const height of [0,1,1200,1201]){
  assert.equal(c.isCollectionPhotoDimensions(width,height),typeof width==='number'&&Number.isSafeInteger(width)&&width>=1&&width<=1200&&height>=1&&height<=1200);
  assert.equal(c.isCollectionPhotoImage({...image,width,height}),c.isCollectionPhotoDimensions(width,height));
 }
 for(const size of [c.MAX_COLLECTION_PHOTO_BYTES-1,c.MAX_COLLECTION_PHOTO_BYTES,c.MAX_COLLECTION_PHOTO_BYTES+1,c.MAX_COLLECTION_PHOTO_BYTES+2,c.MAX_COLLECTION_PHOTO_BYTES+3]){
  const bytes=Buffer.alloc(size);bytes.set([255,216,255]);const value={...image,dataUrl:'data:image/jpeg;base64,'+bytes.toString('base64')};
  assert.equal(c.isCollectionPhotoImage(value),Math.ceil(size/3)*4<=Math.ceil(c.MAX_COLLECTION_PHOTO_BYTES/3)*4);
  assert.equal(c.isMasterArtworkImage(value),size<=c.MAX_MASTER_ARTWORK_BYTES);
 }
});
