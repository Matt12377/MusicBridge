import { lyricsPhysicalDigest, localLyricsPhysicalOperationId, type LocalLyricsPhysicalRecord, type LocalLyricsPhysicalGroup } from '../src/library/lyrics-source-format.js'
import { localLyricsIntentFingerprint } from '../src/collection/local-library-lyrics/save-coordinator.js'
import type { LocalLyricsSaveIntent, LocalLyricsSelectedBody } from '../src/collection/local-library-lyrics/types.js'
import path from 'node:path'
import { mkdir, mkdtemp, writeFile, readFile, stat } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import * as dto from '@music-bridge/contracts'
import { createCollectionRepository } from '../src/collection/repository.js'
import { authorizeSourceDirectory } from '../src/recording/source-files.js'
import { createLocalWorkbenchReadService } from '../src/collection/local-library-workbench/read-service.js'
import type { LocalAlbumGroup } from '../src/collection/local-album-browser/types.js'
import type { ScanPreparedItem } from '../src/collection/local-scan-store.js'
import { METADATA_PARSER_VERSION, CUE_HEADER_METADATA_PARSER_VERSION, CUE_INPUT_SCAN_VERSION } from '../src/library/metadata-reader-types.js'
import { LOCAL_LIBRARY_MANAGEMENT_OPERATION, localLibraryManagementDigest, captureLocalLibraryManagementRecord,
  createLocalLibraryManagementBatchEvents, localLibraryManagementLedgerRow, emptyLocalLibraryManagementProjection,
  projectLocalLibraryManagementEvent, assertLocalLibraryManagementComplete, readLocalLibraryManagementEvent,
  type LocalLibraryManagementOperationRecord, type LocalLibraryManagementBindingRecord, type LocalLibraryManagementCaptureRecord,
  type LocalLibraryManagementJobRecord, type LocalLibraryManagementRecord, type LocalLibraryManagementRecordKind,
} from '../src/collection/local-library-workbench/owner-journal.js'
import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createLocalWorkbenchPlanRegistry } from '../src/collection/local-library-workbench/plan-registry.js'
import {
  assertLocalWorkbenchJournalComplete, createLocalWorkbenchOwnerPersistence, createLocalWorkbenchSnapshotEvents,
  emptyLocalWorkbenchJournalProjection, isLocalWorkbenchJournalEvent, localWorkbenchJournalLedgerRow,
  projectLocalWorkbenchJournalEvent, readLocalWorkbenchJournalEvent,
  type LocalWorkbenchJournalEvent, type LocalWorkbenchOwnerJournalPort,
} from '../src/collection/local-library-workbench/owner-journal.js'
import { LocalWorkbenchPlanError, type LocalWorkbenchAlbumCapture, type LocalWorkbenchRegistrySnapshot, type LocalWorkbenchPlanCapture, type LocalWorkbenchPlanDraft, type LocalWorkbenchProtectedWriter } from '../src/collection/local-library-workbench/types.js'
import { createDatasetDomain } from '../src/collection/dataset-domain.js'
import { createBackupWorkflowStore } from '../src/recording/backup-workflow-store.js'
import { createCompletedScanSnapshotView } from '../src/collection/local-scan-snapshot-view.js'
import type { DatasetWorkbenchExecutionContext, DatasetWorkbenchRequest } from '../src/collection/dataset-owner-protocol.js'

/** 463只装配实际Root/同Owner SQLite/合成文件；扫描种子是已核私有准备批，未装配Main或Native。 */
async function removalFactoryFixture463(t:import('node:test').TestContext,readersOptions493:{hold?:boolean;failure?:'UNKNOWN'|'TIMEOUT'}={}){
  const temporary=process.env.TMPDIR;assert.ok(temporary);assert.ok(temporary.startsWith('/Volumes/LifeWeave/Developer/CommandLine/'))
  const directory=await mkdtemp(path.join(temporary,'library-remove463-')),file=path.join(directory,'collection.sqlite'),identityFile=path.join(directory,'identity.sqlite')
  await mkdir(path.join(directory,'staging'),{mode:0o700})
  let fault=false,casCalls=0,sourceSafetyCloses=0
  const repository=createCollectionRepository({filePath:file,stagingRoot:path.join(directory,'staging'),beforeCommit(action){
    if(fault&&action==='local-library-management:cas'&&++casCalls===2){fault=false;throw new Error('仅测试自有SQLite的清库最终COMMIT故障')}
  }}),state=createBackupWorkflowStore({filePath:identityFile})
  repository.localCatalog.roots();const identity=state.datasetIdentities.bind('default',file,false);repository.localCatalog.privateBindWorkbenchDataset(identity)
  const settings=repository.localCatalog.privateScanSettingsStore(identity),epoch=randomUUID()
  const roots:dto.LibraryRoot[]=[],files:{path:string;bytes:Buffer}[]=[],jobs:dto.ScanJobRecord[]=[],tracks:string[]=[]
  for(let index=0;index<2;index++){
    const sourcePath=path.join(directory,'library-'+index);await mkdir(sourcePath,{mode:0o700})
    const bytes=Buffer.alloc(44+800);bytes.write('RIFF');bytes.writeUInt32LE(bytes.length-8,4);bytes.write('WAVEfmt ',8);bytes.writeUInt32LE(16,16);bytes.writeUInt16LE(1,20);bytes.writeUInt16LE(2,22);bytes.writeUInt32LE(48000,24);bytes.writeUInt32LE(192000,28);bytes.writeUInt16LE(4,32);bytes.writeUInt16LE(16,34);bytes.write('data',36);bytes.writeUInt32LE(800,40)
    for(const [relative,body]of [['原曲目.wav',bytes],['cover.jpg',readFileSync(new URL('./fixtures/mbrs012-source/owned-cover-32.jpg',import.meta.url))],['原曲目.lrc',Buffer.from('[00:00.00]原歌词'+index+'\n')]] as const){
      const target=path.join(sourcePath,relative);await writeFile(target,body,{flag:'wx',mode:0o600});files.push({path:target,bytes:Buffer.from(body)})
    }
    const commandId=randomUUID(),source=repository.sources.authorize(commandId,await authorizeSourceDirectory(sourcePath)),root=repository.localCatalog.registerRoot({commandId,sourceRootId:source.id,role:'library'});roots.push(root)
    const original:LocalLibraryManagementOperationRecord['original']={command:'library.import.confirm',request:{commandId,choiceId:randomUUID(),role:'catalog'}}
    const operation:LocalLibraryManagementOperationRecord={schema:1,kind:'operation',datasetId:identity.datasetId,key:commandId,revision:1,original,originalSha256:localLibraryManagementDigest(original),receipt:{commandId,kind:'library.import.confirm',state:'succeeded',libraryIds:[root.id],message:null}}
    const binding:LocalLibraryManagementBindingRecord={schema:1,kind:'binding',datasetId:identity.datasetId,key:root.id,revision:1,libraryId:root.id,sourceRootId:root.sourceRootId,rootRevision:root.revision,role:'catalog',name:'原库'+index,active:true,watchEnabled:false,operationId:commandId}
    repository.localCatalog.privateLibraryManagementCompareAndSwap(identity,[{record:operation,expectedRevision:null},{record:binding,expectedRevision:null}])
  }
  async function seedCompleted(index:number){
    const root=roots[index]!,info=await stat(path.join(directory,'library-'+index,'原曲目.wav'),{bigint:true})
    const started=repository.localScan.start({commandId:randomUUID(),datasetId:identity.datasetId,libraryRootId:root.id,expectedRootRevision:root.revision,parserVersion:'controlled-c03-463'}).job,
      running=repository.localScan.resume({commandId:randomUUID(),jobId:started.jobId,expectedRevision:started.jobRevision})
    settings.freeze(identity,{schema:1,datasetId:identity.datasetId,eventId:randomUUID(),commandId:randomUUID(),kind:'launch',frozen:{jobId:started.jobId,settingsRevision:settings.read(identity).revision,albumConcurrency:settings.read(identity).albumConcurrency,readerConcurrency:1}})
    const item:ScanPreparedItem={relative:'原曲目.wav',signature:[info.dev,info.ino,info.size,info.mtimeNs,info.ctimeNs].join(':'),parserVersion:'controlled-c03-463',outcome:'accepted',fields:{title:'原曲目'+index,artist:'合成作者',album:'合成专辑'+index,track:'1'},failureCode:null,reused:false,
      readFacts:{technical:{container:'WAVE',codec:'PCM',lossless:true,sampleRateHz:48000,channels:2,bitsPerSample:16,durationSeconds:2,evidence:'bounded-parser-reported'},coverEvidence:[],readEvidence:{bytesRead:44,readCalls:1,maxReadBytes:44,allocationBytes:44,elapsedMs:1,wholeAudioHash:false,wholeAudioDecode:false}}}
    const batch={batchId:randomUUID(),jobId:started.jobId,expectedJobRevision:running.jobRevision,checkpointBefore:running.checkpointRef,items:[item],frontier:[],completed:true}
    repository.localScan.privatePrepareBatch({commandId:randomUUID(),jobId:started.jobId,batch});const done=repository.localScan.privateCommitBatch({commandId:randomUUID(),jobId:started.jobId,batchId:batch.batchId,expectedRevision:running.jobRevision})
    return done
  }
  for(let index=0;index<2;index++){jobs.push(await seedCompleted(index));tracks.push(repository.localCatalog.queryTracks({rootId:roots[index]!.id,query:'',offset:0,limit:1}).items[0]!.track.id)}
  const originalBytes=readFileSync(new URL('./fixtures/mbrs012-source/owned-cover-32.jpg',import.meta.url)),displayBytes=readFileSync(new URL('./fixtures/mbrs012-source/owned-cover-16.jpg',import.meta.url)),image:dto.LocalArtworkImage={
    original:{mime:'image/jpeg',bytes:originalBytes.length,sha256:digest(originalBytes),width:32,height:32},display:{mime:'image/jpeg',bytes:displayBytes.length,sha256:digest(displayBytes),width:16,height:16,dataUrl:'data:image/jpeg;base64,'+displayBytes.toString('base64')}}
  const own=repository.localCatalog.createEdition({commandId:randomUUID(),title:'库零专属发行',edition:''}),other=repository.localCatalog.createEdition({commandId:randomUUID(),title:'库一专属发行',edition:''}),shared=repository.localCatalog.createEdition({commandId:randomUUID(),title:'两库共享发行',edition:''})
  for(const [editionId,trackIndex]of [[own.id,0],[other.id,1],[shared.id,0],[shared.id,1]] as const)repository.localCatalog.linkEditionTrack({commandId:randomUUID(),editionId,trackId:tracks[trackIndex]!,disc:1,trackNumber:trackIndex+1,sequence:trackIndex+1})
  function stage(trackIndex:number,editionId:string,label:string){const target=repository.localArtwork.context({trackId:tracks[trackIndex]!,editionId}).target;assert.ok(target)
    const sourceIdentity=digest(Buffer.from(label)),result=repository.localArtwork.stage({target,origin:'manual',sourceIdentity,sourceLabel:label,image});const candidate=result.candidates.find(candidate=>candidate.sourceIdentity===sourceIdentity);assert.ok(candidate);return {candidate,target}
  }
  const selected=stage(0,own.id,'库零保存选图'),unreferenced=stage(0,own.id,'库零未选staging'),sharedCache=stage(0,shared.id,'共享发行未选staging'),otherCache=stage(1,other.id,'库一未选staging')
  const savedSelection=repository.localArtwork.apply({commandId:randomUUID(),target:selected.target,candidateId:selected.candidate.id,expectedSelectionRevision:null})
  const snapshots=createCompletedScanSnapshotView({repository,identity});for(const job of jobs)snapshots.captureCompleted(job.jobId)
  const readers493=removalReaders493(t,repository,identity,epoch,readersOptions493)
  const domain=createDatasetDomain({collectionRepository:repository,backupWorkflowStore:state,collectionDatasetIdentity:identity,localSourceEpoch:epoch,sourceWritesMainActor:readers493.actor})
  await domain.localSourceWrites.prepareRecoveryProtection();await domain.prepareWorkbench()
  const sharedSafety=domain.localSourceWrites.privateLyricsSafety().sourceSafety,originalClose=sharedSafety.close
  t.mock.method(sharedSafety,'close',function(){sourceSafetyCloses++;return originalClose.call(sharedSafety)})
  let closed=false
  async function close(){if(!closed){await domain.close();await readers493.close();closed=true}}
  t.after(async()=>{try{await close()}finally{if(!closed){repository.close();state.close()}}})
  function context():DatasetWorkbenchExecutionContext{return {identity:{epoch,datasetId:identity.datasetId},signal:new AbortController().signal,deadlineAtMs:performance.now()+2000}}
  async function manage<C extends dto.LocalLibraryManagementCommand>(command:C,payload:dto.LocalLibraryManagementPayloads[C]){
    return await domain.dispatchWorkbench!({family:'management',command,payload} as DatasetWorkbenchRequest,context()) as dto.LocalLibraryManagementResults[C]
  }
  function rows(){return repository.localCatalog.privateRead(db=>Object.fromEntries(['local_scan_jobs','local_scan_batches','local_scan_checkpoints','local_scan_receipts','local_scan_snapshot_commits','local_scan_snapshot_chunks','local_artwork_selections','local_artwork_ledger','source_roots','source_ledger'].map(table=>[table,db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]))) }
  function candidates(){return repository.localCatalog.privateRead(db=>db.prepare('SELECT id,data FROM local_artwork_candidates ORDER BY rowid').all())}
  return {directory,file,identityFile,repository,state,identity,roots,jobs,tracks,files,domain,readers493,epoch493:epoch,snapshots,selected,unreferenced,sharedCache,otherCache,savedSelection,stage,seedCompleted,manage,rows,candidates,close,
    failFinalCommit(){casCalls=0;fault=true},get sourceSafetyCloses(){return sourceSafetyCloses}}
}

test('C03实际Root463：同Owner撤库只清专属无引用staging，原媒体与他库保留，冷tombstone拒迟到CREATE和retry',async t=>{
  const f=await removalFactoryFixture463(t),before=f.rows(),otherAlbums=await f.domain.localAlbums!.queryAlbums({rootId:f.roots[1]!.id,query:'',filter:'all',offset:0,limit:200}),commandId=randomUUID()
  const receipt=await f.manage('library.remove',{commandId,libraryIds:[f.roots[0]!.id]});assert.equal(receipt.state,'succeeded');assert.ok(receipt.message)
  assert.equal(f.repository.localCatalog.privateLibraryManagementRead(f.identity,'binding',f.roots[0]!.id)?.record.active,false)
  const caches=f.candidates().map(row=>row.id);assert.equal(caches.includes(f.unreferenced.candidate.id),false)
  assert.ok(caches.includes(f.selected.candidate.id)&&caches.includes(f.sharedCache.candidate.id)&&caches.includes(f.otherCache.candidate.id))
  assert.deepEqual(f.rows(),before);assert.deepEqual(f.repository.localArtwork.context({trackId:f.tracks[0]!,editionId:f.savedSelection.editionId}).selection,f.savedSelection)
  assert.deepEqual((await f.domain.localAlbums!.queryAlbums({rootId:f.roots[1]!.id,query:'',filter:'all',offset:0,limit:200})).items.map(({revision,...album})=>album),otherAlbums.items.map(({revision,...album})=>album))
  assert.equal((await f.manage('library.read',{})).libraries.some(library=>library.libraryId===f.roots[0]!.id),false)
  assert.throws(()=>f.repository.localScan.start({commandId:randomUUID(),datasetId:f.identity.datasetId,libraryRootId:f.roots[0]!.id,expectedRootRevision:f.roots[0]!.revision,parserVersion:'late-create463'}))
  assert.throws(()=>f.repository.localCatalog.registerAsset({commandId:randomUUID(),libraryRootId:f.roots[0]!.id,expectedRootRevision:f.roots[0]!.revision,relative:'迟到.wav',sha256:null,sampleFrames:null,timebaseHz:null}))
  assert.throws(()=>f.repository.localCatalog.createTrack({commandId:randomUUID(),assetId:f.repository.localCatalog.track(f.tracks[0]!).assetId,segment:null}))
  assert.throws(()=>f.snapshots.retry(f.jobs[0]!.jobId));assert.equal(f.snapshots.load(f.roots[0]!.id).status,'unavailable')
  assert.deepEqual(await f.manage('library.operation.read',{commandId}),receipt);assert.equal(f.sourceSafetyCloses,0)
  for(const file of f.files)assert.deepEqual(await readFile(file.path),file.bytes)
  await f.close();assert.equal(f.sourceSafetyCloses,1)
  const coldRepository=createCollectionRepository({filePath:f.file,stagingRoot:path.join(f.directory,'staging')}),coldState=createBackupWorkflowStore({filePath:f.identityFile})
  try{coldRepository.localCatalog.roots();const identity=coldState.datasetIdentities.bind('default',f.file,false);assert.equal(identity.datasetId,f.identity.datasetId);coldRepository.localCatalog.privateBindWorkbenchDataset(identity)
    assert.equal(coldRepository.localCatalog.privateLibraryManagementRootAvailable(f.roots[0]!.id),false);assert.equal(coldRepository.localCatalog.privateLibraryManagementRootAvailable(f.roots[1]!.id),true)
    const cold=createCompletedScanSnapshotView({repository:coldRepository,identity});assert.equal(cold.load(f.roots[0]!.id).status,'unavailable');assert.throws(()=>cold.retry(f.jobs[0]!.jobId));cold.close()
    assert.equal(coldRepository.localScan.get(f.jobs[0]!.jobId).phase,'completed');assert.equal(coldRepository.sources.root(f.roots[0]!.sourceRootId).authorized,true)
  }finally{coldRepository.close();coldState.close()}
  t.diagnostic('实际Root/同SQL/实际合成文件；未装配Main MessagePort、Native、活跃Provider或watch进程，未宣称其join或Main2000ms。')
})

test('C03实际Root463：原完成snapshot独立retry不增scan/provider/writer，源签名改变拒旧retry而保原成功',async t=>{
  const f=await removalFactoryFixture463(t),previous=f.snapshots.load(f.roots[0]!.id).lastSuccess!,next=await f.seedCompleted(0)
  const failing=createCompletedScanSnapshotView({repository:f.repository,identity:f.identity,beforeCapture(){throw new Error('测试自有派生捕获故障')}}),failed=failing.captureCompleted(next.jobId);failing.close()
  assert.equal(failed.status,'failed');assert.deepEqual(failed.lastSuccess,previous)
  const before=f.rows(),scanRows=Object.fromEntries(Object.entries(before).filter(([name])=>name.startsWith('local_scan_')&&!name.startsWith('local_scan_snapshot_')))
  const retried=await f.manage('library.snapshot.retry',{commandId:randomUUID(),libraryId:f.roots[0]!.id});assert.equal(retried.state,'succeeded')
  assert.deepEqual(Object.fromEntries(Object.entries(f.rows()).filter(([name])=>name.startsWith('local_scan_')&&!name.startsWith('local_scan_snapshot_'))),scanRows)
  assert.deepEqual(f.rows().source_ledger,before.source_ledger);assert.equal(f.snapshots.load(f.roots[0]!.id).lastSuccess?.snapshot.job.jobId,next.jobId)
  const changed=await f.seedCompleted(0),fault=createCompletedScanSnapshotView({repository:f.repository,identity:f.identity,beforeCapture(){throw new Error('测试自有第二次派生故障')}}),originalFailure=fault.captureCompleted(changed.jobId);fault.close()
  const media=f.files.find(file=>file.path.endsWith('library-0/原曲目.wav'))!;await writeFile(media.path,Buffer.concat([media.bytes,Buffer.from('测试自有源变化')]))
  const failureRows=f.rows(),rejected=await f.manage('library.snapshot.retry',{commandId:randomUUID(),libraryId:f.roots[0]!.id});assert.equal(rejected.state,'unknown')
  assert.deepEqual(f.rows(),failureRows);assert.equal(f.snapshots.load(f.roots[0]!.id).latestAttempt?.attemptId,originalFailure.latestAttempt?.attemptId)
  assert.equal(f.sourceSafetyCloses,0)
  t.diagnostic('retry只核原根与真实文件metadata签名、同原SQL facts；未启动Scanner/Provider或源写，也没有用Fake Main callback计作Main proof。')
})

test('C03实际Root463：缺watch或冷running scan实际join及最终SQL故障均UNKNOWN，绑定和材料保留，原命令查询不重放',async t=>{
  const f=await removalFactoryFixture463(t),root=f.roots[0]!,old=f.repository.localCatalog.privateLibraryManagementRead(f.identity,'binding',root.id)!,commandId=randomUUID()
  const original:LocalLibraryManagementOperationRecord['original']={command:'library.watch.set',request:{commandId,libraryId:root.id,enabled:true}},operation:LocalLibraryManagementOperationRecord={schema:1,kind:'operation',datasetId:f.identity.datasetId,key:commandId,revision:1,original,originalSha256:localLibraryManagementDigest(original),receipt:{commandId,kind:'library.watch.set',state:'succeeded',libraryIds:[root.id],message:null}}
  f.repository.localCatalog.privateLibraryManagementCompareAndSwap(f.identity,[{record:{...old.record,revision:old.record.revision+1,operationId:commandId,watchEnabled:true},expectedRevision:old.record.revision},{record:operation,expectedRevision:null}])
  const before=f.rows(),caches=f.candidates(),removeId=randomUUID(),receipt=await f.manage('library.remove',{commandId:removeId,libraryIds:[root.id]})
  assert.equal(receipt.state,'unknown');assert.equal(f.repository.localCatalog.privateLibraryManagementRead(f.identity,'binding',root.id)?.record.active,true)
  assert.deepEqual(f.rows(),before);assert.deepEqual(f.candidates(),caches);assert.equal(f.repository.localCatalog.privateLibraryManagementRootAvailable(root.id),false)
  assert.equal((await f.manage('library.read',{})).libraries.some(library=>library.libraryId===root.id),true)
  const ledger=f.repository.localCatalog.privateRead(db=>db.prepare('SELECT * FROM local_catalog_ledger ORDER BY rowid').all())
  assert.deepEqual(await f.manage('library.operation.read',{commandId:removeId}),receipt);assert.deepEqual(await f.manage('library.remove',{commandId:removeId,libraryIds:[root.id]}),receipt)
  assert.deepEqual(f.repository.localCatalog.privateRead(db=>db.prepare('SELECT * FROM local_catalog_ledger ORDER BY rowid').all()),ledger)
  const g=await removalFactoryFixture463(t),originalRows=g.rows(),originalCaches=g.candidates();g.failFinalCommit();const failed=await g.manage('library.remove',{commandId:randomUUID(),libraryIds:[g.roots[0]!.id]})
  assert.equal(failed.state,'unknown');assert.equal(g.repository.localCatalog.privateLibraryManagementRead(g.identity,'binding',g.roots[0]!.id)?.record.active,true)
  assert.deepEqual(g.rows(),originalRows);assert.deepEqual(g.candidates(),originalCaches)
  for(const file of [...f.files,...g.files])assert.deepEqual(await readFile(file.path),file.bytes)
  assert.equal(g.sourceSafetyCloses,0)
  const h=await removalFactoryFixture463(t),queued=h.repository.localScan.start({commandId:randomUUID(),datasetId:h.identity.datasetId,libraryRootId:h.roots[0]!.id,expectedRootRevision:h.roots[0]!.revision,parserVersion:'controlled-cold-running463'}).job
  h.repository.localScan.resume({commandId:randomUUID(),jobId:queued.jobId,expectedRevision:queued.jobRevision});const runningRows=h.rows(),runningCaches=h.candidates()
  const coldRunning=await h.manage('library.remove',{commandId:randomUUID(),libraryIds:[h.roots[0]!.id]});assert.equal(coldRunning.state,'unknown');assert.equal(h.repository.localCatalog.privateLibraryManagementRead(h.identity,'binding',h.roots[0]!.id)?.record.active,true)
  assert.deepEqual(h.rows(),runningRows);assert.deepEqual(h.candidates(),runningCaches);assert.equal(h.repository.localScan.get(queued.jobId).phase,'running')
  t.diagnostic('没有注入watch.remove/join成功callback；真实工厂缺watch bundle时拒绝撤绑定，SQL故障仅施加于测试自有数据库。')
})

const datasetId = '11111111-1111-4111-8111-111111111111'
const otherDataset = '22222222-2222-4222-8222-222222222222'
const empty = (revision = 1): LocalWorkbenchRegistrySnapshot => ({ schemaVersion: 1, datasetId, revision, entries: [] })
const digest = (value: Uint8Array): string => createHash('sha256').update(value).digest('hex')
/** 真实纯registry生成合法大捕获；测试持久端口仅保存合成输入，不打开音乐或生产DB。 */
async function largeSnapshot(): Promise<LocalWorkbenchRegistrySnapshot> {
  let saved: LocalWorkbenchRegistrySnapshot | null = null
  const imageBytes = readFileSync(new URL('./fixtures/mbrs012-source/owned-cover-32.jpg', import.meta.url)), imageHash = digest(imageBytes)
  const displayBytes = readFileSync(new URL('./fixtures/mbrs012-source/owned-cover-16.jpg', import.meta.url)), displayHash = digest(displayBytes)
  assert.notEqual(imageHash, displayHash)
  const album: LocalWorkbenchAlbumCapture = { albumId: 'album-a', readToken: 'read-a', revision: 'album-1', rootId: 'root-a', directoryId: 'directory-a', editionId: null,
    artistName: '合成艺人', albumName: '合成专辑', directoryName: '合成目录', manualLocks: { artistName: false, albumName: false },
    members: Array.from({ length: 400 }, (_, index) => ({ trackId: 'track-' + index, assetId: 'asset-' + index, fileName: '合成曲目-' + index + '.flac', title: null, artist: null, album: null,
      rootRevision: 'root-1', fileRevision: 'file-1', locationRevision: 'location-1', metadataRevision: 'metadata-1' })) }
  const registry = await createLocalWorkbenchPlanRegistry({ datasetId,
    persistence: { load: async () => null, save: async (snapshot, expected) => { assert.equal(expected, 0); saved = structuredClone(snapshot) } },
    writer: { revalidate: async () => ({ valid: true }), readOriginalReceipt: async () => null, apply: async () => { throw new Error('本测试不应执行应用') } } })
  await registry.issuePlan({ kind: 'artwork', scope: 'MB_ONLY', relationship: 'create-on-apply', albumIds: [album.albumId], state: 'ready', blockers: [], items: [{ itemId: 'item-a', albumId: album.albumId, label: album.albumName, changes: [] }] },
    { datasetId, datasetRevision: 'dataset-1', albums: [album], artwork: [{ albumId: album.albumId, candidateId: 'candidate-a', revision: 'image-1', origin: 'manual', sourceLabel: '合成测试图', licenseLabel: '用户自有合成测试图',
      originalBase64: imageBytes.toString('base64'),
      image: { original: { mime: 'image/jpeg', bytes: imageBytes.length, sha256: imageHash, width: 32, height: 32 }, display: { mime: 'image/jpeg', bytes: displayBytes.length, sha256: displayHash, width: 16, height: 16, dataUrl: 'data:image/jpeg;base64,' + displayBytes.toString('base64') } } }] })
  assert.ok(saved); return saved
}

test('真实冻结大捕获分块遵守原ledger64KiB，完整commit后恢复同一图像/成员/计划', async () => {
  const snapshot = await largeSnapshot(), events = createLocalWorkbenchSnapshotEvents(snapshot, 0)
  assert.ok(events.length > 2)
  const projection = emptyLocalWorkbenchJournalProjection(datasetId)
  for (const [index, event] of events.entries()) {
    assert.ok(isLocalWorkbenchJournalEvent(event))
    const row = localWorkbenchJournalLedgerRow(event)
    assert.ok(Object.values(row).reduce((sum, value) => sum + Buffer.byteLength(value), 0) < 64 * 1024)
    const restored = readLocalWorkbenchJournalEvent(row)
    assert.deepEqual(restored, event)
    projectLocalWorkbenchJournalEvent(projection, restored, index + 1)
    if (event.kind === 'snapshot-chunk') assert.equal(projection.snapshot, null)
  }
  assertLocalWorkbenchJournalComplete(projection); assert.equal(projection.revision, 1)
  assert.deepEqual(projection.snapshot, snapshot)
  const artwork = projection.snapshot!.entries[0]!.capture.artwork![0]!
  const originalBytes = Buffer.from(artwork.originalBase64, 'base64')
  assert.equal(digest(originalBytes), artwork.image.original.sha256); assert.equal(originalBytes.length, artwork.image.original.bytes)
  assert.notEqual(artwork.image.original.sha256, artwork.image.display.sha256)
})

test('缺commit、缺块、乱序和重复不能当持久成功，不修尾部或跳过CAS', async () => {
  const events = createLocalWorkbenchSnapshotEvents(await largeSnapshot(), 0)
  const incomplete = emptyLocalWorkbenchJournalProjection(datasetId)
  for (const [index, event] of events.slice(0, -1).entries()) projectLocalWorkbenchJournalEvent(incomplete, event, index + 1)
  assert.equal(incomplete.snapshot, null); assert.throws(() => assertLocalWorkbenchJournalComplete(incomplete), /持久事实/u)
  const wrong = emptyLocalWorkbenchJournalProjection(datasetId)
  assert.throws(() => projectLocalWorkbenchJournalEvent(wrong, events[1]!, 1), /持久事实/u)
  const repeated = emptyLocalWorkbenchJournalProjection(datasetId)
  projectLocalWorkbenchJournalEvent(repeated, events[0]!, 1)
  assert.throws(() => projectLocalWorkbenchJournalEvent(repeated, events[0]!, 2), /持久事实/u)
  assert.throws(() => projectLocalWorkbenchJournalEvent(repeated, events.at(-1)!, events.length), /持久事实/u)
})

test('新快照必须续接同dataset/CAS水位，旧expectedRevision不能重置链', () => {
  const projection = emptyLocalWorkbenchJournalProjection(datasetId)
  const first = createLocalWorkbenchSnapshotEvents(empty(), 0)
  first.forEach((event, index) => projectLocalWorkbenchJournalEvent(projection, event, index + 1))
  const second = createLocalWorkbenchSnapshotEvents(empty(2), 1)
  second.forEach((event, index) => projectLocalWorkbenchJournalEvent(projection, event, first.length + index + 1))
  assert.equal(projection.revision, 2)
  assert.throws(() => projectLocalWorkbenchJournalEvent(projection, first[0]!, 5), /CAS/u)
  assert.throws(() => projectLocalWorkbenchJournalEvent(emptyLocalWorkbenchJournalProjection(otherDataset), first[0]!, 1), /CAS/u)
  assert.throws(() => createLocalWorkbenchSnapshotEvents(empty(2), 0), /CAS/u)
})

test('修改块/哈希/原ledger回执身份或无效UTF8不能恢复计划', () => {
  const events = createLocalWorkbenchSnapshotEvents(empty(), 0), first = events[0]!
  assert.equal(first.kind, 'snapshot-chunk')
  if (first.kind !== 'snapshot-chunk') throw new Error('合成事件类型错误')
  const row = localWorkbenchJournalLedgerRow(first)
  assert.throws(() => readLocalWorkbenchJournalEvent({ ...row, fingerprint: '0'.repeat(64) }), /持久事实/u)
  assert.throws(() => readLocalWorkbenchJournalEvent({ ...row, result: '{}' }), /持久事实/u)
  const projection = emptyLocalWorkbenchJournalProjection(datasetId), bytes = Buffer.from(first.payload, 'base64')
  bytes[0] = 255
  const changedHash = digest(bytes)
  const broken: LocalWorkbenchJournalEvent[] = [{ ...first, payload: bytes.toString('base64'), snapshotHash: changedHash }, { ...events[1]!, snapshotHash: changedHash }]
  projectLocalWorkbenchJournalEvent(projection, broken[0]!, 1)
  assert.throws(() => projectLocalWorkbenchJournalEvent(projection, broken[1]!, 2), /持久事实/u)
  assert.equal(projection.snapshot, null)
})

test('隐藏授权/getter和非规范base64在编码/恢复前拒绝，不靠clone洗白', () => {
  let accessed = 0
  const unsafe = empty()
  Object.defineProperty(unsafe, 'hidden', { get() { accessed++; return '未知能力' } })
  assert.throws(() => createLocalWorkbenchSnapshotEvents(unsafe, 0), /持久事实/u)
  assert.equal(accessed, 0)
  const event = createLocalWorkbenchSnapshotEvents(empty(), 0)[0]!
  assert.equal(isLocalWorkbenchJournalEvent({ ...event, payload: 'not base64' }), false)
  assert.equal(isLocalWorkbenchJournalEvent({ ...event, absolutePath: '/合成不可授权位置' }), false)
})

test('持久适配器必须提供同Owner CAS，失败不返回成功，不换库或另开fallback', async () => {
  assert.throws(() => createLocalWorkbenchOwnerPersistence(datasetId, {} as LocalWorkbenchOwnerJournalPort), /持久事实/u)
  let stored: LocalWorkbenchRegistrySnapshot | null = null, failed = false, writes = 0
  const port: LocalWorkbenchOwnerJournalPort = { privateWorkbenchSnapshot: () => stored === null ? null : structuredClone(stored),
    privateWorkbenchCompareAndSwap(requested, expected, events) {
      writes++; assert.equal(requested, datasetId); assert.equal(expected, stored?.revision ?? 0)
      if (failed) throw new Error('合成CAS提交失败')
      const projection = emptyLocalWorkbenchJournalProjection(datasetId)
      // 此测试端口重放已验证前缀；生产端口必须在原Owner事务中加载当前projection。
      if (stored) { projection.revision = stored.revision; projection.snapshot = stored }
      events.forEach((event, index) => projectLocalWorkbenchJournalEvent(projection, event, index + 1))
      assertLocalWorkbenchJournalComplete(projection); stored = projection.snapshot
    } }
  const persistence = createLocalWorkbenchOwnerPersistence(datasetId, port)
  assert.equal(await persistence.load(datasetId), null)
  await persistence.save(empty(), 0)
  assert.deepEqual(await persistence.load(datasetId), empty())
  const copy = await persistence.load(datasetId); copy!.revision = 999
  assert.equal((await persistence.load(datasetId))!.revision, 1)
  failed = true
  await assert.rejects(persistence.save(empty(2), 1), /合成CAS/u)
  assert.equal((await persistence.load(datasetId))!.revision, 1); assert.equal(writes, 2)
  await assert.rejects(persistence.load(otherDataset), /CAS/u)
})


/** 本组只开新鲜合成SQLite/文本文件；扫描事实来自受控输入，不宣称真实音频解析或Main授权。 */
type ManagementScanFormat540 = { parserVersion: string; technical: NonNullable<ScanPreparedItem['readFacts']>['technical'] }
async function managementFixture(t:import('node:test').TestContext,{albums=2,tracks=2,scanFormats540}: {albums?:number;tracks?:number;scanFormats540?:readonly ManagementScanFormat540[]}={}) {
  const temp=process.env.TMPDIR;assert.ok(temp);assert.ok(temp.startsWith('/Volumes/LifeWeave/Developer/CommandLine/'))
  const directory=await mkdtemp(path.join(temp,'library417-'))
  await mkdir(directory+'/source',{mode:0o700});await mkdir(directory+'/staging',{mode:0o700})
  let alive=true,failCommit=false,closed=0,failureCalls=0,failWorkbenchCommit552=false
  const file=directory+'/catalog.sqlite',dataId=randomUUID(),identity={datasetId:dataId,assertCurrent(){assert.equal(alive,true)}}
  // 冷开仍沿同一受控故障作者；不能在重建repository时静默丢掉beforeCommit。
  const openRepository=()=>createCollectionRepository({filePath:file,stagingRoot:directory+'/staging',beforeCommit(action){if(failCommit&&action==='local-library-management:cas'){failureCalls++;throw new Error('受控Library整批提交失败')}if(failWorkbenchCommit552&&action==='local-workbench:cas')throw new Error('552仅测试自有SQL原journal事务COMMIT故障')}})
  let repository=openRepository()
  repository.localCatalog.privateBindWorkbenchDataset(identity)
  const capability=await authorizeSourceDirectory(directory+'/source'),source=repository.sources.authorize(randomUUID(),capability)
  const root=repository.localCatalog.registerRoot({commandId:randomUUID(),sourceRootId:source.id,role:'library'})
  const media:readonly {relative:string;bytes:Buffer}[]=Array.from({length:albums*tracks},(_,i)=>({relative:`目录${Math.floor(i/tracks)}/歌曲${i}.flac`,bytes:Buffer.from('合成不可播放测试原字节'+i)}))
  for(let a=0;a<albums;a++)await mkdir(directory+'/source/目录'+a,{mode:0o700})
  if(scanFormats540)assert.equal(scanFormats540.length,media.length,'540受控事实必须覆盖每个原合成文件')
  const job=repository.localScan.start({commandId:randomUUID(),datasetId:dataId,libraryRootId:root.id,expectedRootRevision:root.revision,parserVersion:scanFormats540?CUE_INPUT_SCAN_VERSION:'controlled-library417/scan'}).job
  const running=repository.localScan.resume({commandId:randomUUID(),jobId:job.jobId,expectedRevision:job.jobRevision})
  const items:ScanPreparedItem[]=[]
  for(const [i,value]of media.entries()){
    await writeFile(directory+'/source/'+value.relative,value.bytes,{flag:'wx',mode:0o600});const info=await stat(directory+'/source/'+value.relative,{bigint:true})
    const format540=scanFormats540?.[i]
    items.push({relative:value.relative,signature:[info.dev,info.ino,info.size,info.mtimeNs,info.ctimeNs].join(':'),parserVersion:format540?.parserVersion??'controlled-library417/scan',outcome:'accepted',
      fields:format540?{}:{title:'原曲目'+i,artist:'原合成作者',album:'原合成专辑'+Math.floor(i/tracks),track:String(i%tracks+1)},failureCode:null,reused:false,
      readFacts:{technical:format540?structuredClone(format540.technical):{container:'FLAC',codec:'FLAC',lossless:true,sampleRateHz:44100,channels:2,bitsPerSample:16,durationSeconds:2,evidence:'bounded-parser-reported'},coverEvidence:[],
        readEvidence:{bytesRead:32,readCalls:1,maxReadBytes:32,allocationBytes:32,elapsedMs:1,wholeAudioHash:false,wholeAudioDecode:false}}})
  }
  const batch={batchId:randomUUID(),jobId:job.jobId,expectedJobRevision:running.jobRevision,checkpointBefore:running.checkpointRef,items,frontier:[],completed:true}
  repository.localScan.privatePrepareBatch({commandId:randomUUID(),jobId:job.jobId,batch});repository.localScan.privateCommitBatch({commandId:randomUUID(),jobId:job.jobId,batchId:batch.batchId,expectedRevision:running.jobRevision})
  function scope(){return {revision:localLibraryManagementDigest([repository.localCatalog.privateAlbumBrowserRevision(),repository.localScan.privateAlbumBrowserRevision()]),roots:[{root,label:source.label,availability:'ONLINE' as const}]}}
  async function capture(mode:'library'|'albums'='library'):Promise<LocalLibraryManagementCaptureRecord> {
    const page=repository.localCatalog.privateAlbumBrowserQuery({query:'',rootId:root.id,filter:'all',offset:0,limit:200},scope());assert.equal(page.items.length,page.total)
    const refs=page.items.map(item=>({albumId:item.id,rootId:item.rootId,revision:item.revision}))
    const service=createLocalWorkbenchReadService({datasetId:dataId,repository,assertCurrent:()=>identity.assertCurrent(),readRootViews:async()=>scope().roots,
      localAlbums:{inspectAlbum(request):LocalAlbumGroup{const p=repository.localCatalog.privateAlbumBrowserMembers({albumKey:request.albumKey,rootId:request.rootId,offset:0,limit:200},scope()),issues=repository.localCatalog.privateAlbumBrowserIssues({albumKey:request.albumKey,rootId:request.rootId,offset:0,limit:200},scope());assert.equal(p.items.length,p.total);return {summary:p.album,members:p.items,directory:p.directory,issues:issues.items,rejectedFiles:issues.rejectedFiles}}}})
    try{const read=await service.readAlbumTargets({albums:refs}),resolved=await Promise.all(read.albums.map(album=>service.resolveCapture({datasetId:dataId,capture:album.capture}))),captureId=randomUUID()
      const original:LocalLibraryManagementCaptureRecord['original']={...(mode==='library'?{mode:'library' as const,request:{libraryIds:[root.id]}}:{mode:'albums' as const,request:{albums:refs}}),captureId,watermark:resolved[0]!.datasetRevision,
        catalogRevision:repository.localCatalog.privateAlbumBrowserRevision(),scanRevision:repository.localScan.privateAlbumBrowserRevision(),libraries:[{libraryId:root.id,sourceRootId:root.sourceRootId,rootRevision:root.revision}],
        albumRefs:refs,albums:resolved.map(value=>({libraryId:root.id,sourceRootId:root.sourceRootId,rootRevision:root.revision,resolved:structuredClone(value)}))}
      return {schema:1,kind:'capture',datasetId:dataId,key:captureId,revision:1,original,originalSha256:localLibraryManagementDigest(original)}
    }finally{await service.close()}
  }
  function close(){if(alive){repository.close();alive=false;closed++}}
  function cold(){close();repository=openRepository();alive=true;repository.localCatalog.privateBindWorkbenchDataset(identity)}
  t.after(async()=>{close();for(const entry of media)assert.deepEqual(await readFile(directory+'/source/'+entry.relative),entry.bytes);assert.ok(closed>=1)})
  return {directory,file,identity,root,source,media,capture,cold,close,setFailure(value:boolean){failCommit=value},setWorkbenchFailure552(value:boolean){failWorkbenchCommit552=value},get repository(){return repository},get catalog(){return repository.localCatalog},get failureCalls(){return failureCalls}}
}
function operation(f:Awaited<ReturnType<typeof managementFixture>>,command:LocalLibraryManagementOperationRecord['original']['command'],request:LocalLibraryManagementOperationRecord['original']['request'],libraryIds:readonly string[],state:LocalLibraryManagementOperationRecord['receipt']['state']='succeeded'):LocalLibraryManagementOperationRecord{
  const original={command,request} as LocalLibraryManagementOperationRecord['original']
  return {schema:1,kind:'operation',datasetId:f.identity.datasetId,key:request.commandId,revision:1,original,originalSha256:localLibraryManagementDigest(original),receipt:{commandId:request.commandId,kind:command,state,libraryIds,message:null}}
}
function binding(f:Awaited<ReturnType<typeof managementFixture>>,op:LocalLibraryManagementOperationRecord):LocalLibraryManagementBindingRecord{
  return {schema:1,kind:'binding',datasetId:f.identity.datasetId,key:f.root.id,revision:1,libraryId:f.root.id,sourceRootId:f.source.id,rootRevision:f.root.revision,role:'catalog',name:'原合成库名',active:true,watchEnabled:false,operationId:op.key}
}
function jobRecord(f:Awaited<ReturnType<typeof managementFixture>>,capture:LocalLibraryManagementCaptureRecord):LocalLibraryManagementJobRecord {
  const start={command:'library.ai.start' as const,request:{commandId:randomUUID(),captureId:capture.key,backend:'ollama' as const,selection:'selected' as const,albumIds:capture.original.albumRefs.map(a=>a.albumId)}}
  const original={start,startSha256:localLibraryManagementDigest(start),captureId:capture.key,captureSha256:capture.originalSha256,expandedSelection:capture.original.albumRefs.map(a=>({...a,cueId:null}))}
  return {schema:1,kind:'job',datasetId:f.identity.datasetId,key:start.request.commandId,revision:1,original,originalSha256:localLibraryManagementDigest(original),checkpoint:{state:'queued',action:null,items:original.expandedSelection.map(a=>({albumId:a.albumId,state:'queued',message:null,planId:null,commandId:null,receipt:null}))}}
}
function managementRead(f:Awaited<ReturnType<typeof managementFixture>>,kind:LocalLibraryManagementRecordKind,key:string){return f.catalog.privateLibraryManagementRead(f.identity,kind,key)}

 test('Library真实同SQL绑定与原操作整批提交，冷开保留语义role且remove只撤绑定不删媒体',async t=>{
  const f=await managementFixture(t),commandId=randomUUID(),op=operation(f,'library.import.confirm',{commandId,choiceId:randomUUID(),role:'catalog'},[f.root.id]),first=binding(f,op)
  const saved=f.catalog.privateLibraryManagementCompareAndSwap(f.identity,[{record:first,expectedRevision:null},{record:op,expectedRevision:null}]);assert.equal(saved.records.length,2)
  assert.equal(f.catalog.root(f.root.id).role,'library');assert.equal(f.catalog.privateLibraryManagementBindings(f.identity)[0]!.record.role,'catalog')
  f.cold();assert.deepEqual(managementRead(f,'binding',f.root.id)?.record,first);assert.deepEqual(managementRead(f,'operation',commandId)?.record,op)
  const rename=operation(f,'library.rename',{commandId:randomUUID(),libraryId:f.root.id,name:'改名后的合成库'},[f.root.id]),renamed={...first,revision:2,name:'改名后的合成库',operationId:rename.key}
  f.catalog.privateLibraryManagementCompareAndSwap(f.identity,[{record:renamed,expectedRevision:1},{record:rename,expectedRevision:null}]);f.cold()
  const remove=operation(f,'library.remove',{commandId:randomUUID(),libraryIds:[f.root.id]},[f.root.id]),removed={...renamed,revision:3,active:false,watchEnabled:false,operationId:remove.key}
  f.catalog.privateLibraryManagementCompareAndSwap(f.identity,[{record:removed,expectedRevision:2},{record:remove,expectedRevision:null}]);f.cold()
  assert.deepEqual(managementRead(f,'binding',f.root.id)?.record,removed);assert.deepEqual(f.catalog.root(f.root.id),f.root)
  assert.equal(f.catalog.privateAlbumBrowserQuery({rootId:f.root.id,query:'',filter:'all',offset:0,limit:200},{revision:'controlled',roots:[{root:f.root,label:f.source.label,availability:'ONLINE'}]}).total,2)
 })
 test('Library整批失败与旧CAS或原command换body均不留半绑定，实际DatasetIdentity不能换对象或跨库',async t=>{
  const f=await managementFixture(t),op=operation(f,'library.import.confirm',{commandId:randomUUID(),choiceId:randomUUID(),role:'catalog'},[f.root.id]),first=binding(f,op)
  assert.throws(()=>f.catalog.privateLibraryManagementCompareAndSwap(f.identity,[{record:first,expectedRevision:null}]));f.cold()
  assert.equal(managementRead(f,'binding',first.key),null)
  f.setFailure(true);assert.throws(()=>f.catalog.privateLibraryManagementCompareAndSwap(f.identity,[{record:first,expectedRevision:null},{record:op,expectedRevision:null}]),/库存暂时不可用/u);assert.equal(f.failureCalls,1)
  assert.equal(managementRead(f,'binding',first.key),null);assert.equal(managementRead(f,'operation',op.key),null)
  f.setFailure(false);f.catalog.privateLibraryManagementCompareAndSwap(f.identity,[{record:first,expectedRevision:null},{record:op,expectedRevision:null}])
  assert.throws(()=>f.catalog.privateLibraryManagementCompareAndSwap(f.identity,[{record:first,expectedRevision:null},{record:op,expectedRevision:null}]),/CAS/u)
  const changed:LocalLibraryManagementOperationRecord={...op,revision:2,original:{command:'library.import.confirm',request:{commandId:op.key,choiceId:randomUUID(),role:'catalog'}},receipt:{...op.receipt,state:'running' as const}};changed.originalSha256=localLibraryManagementDigest(changed.original)
  assert.throws(()=>f.catalog.privateLibraryManagementCompareAndSwap(f.identity,[{record:changed,expectedRevision:1}]))
  assert.throws(()=>f.catalog.privateLibraryManagementRead({...f.identity},'operation',op.key));assert.throws(()=>f.catalog.privateLibraryManagementRead({datasetId:otherDataset,assertCurrent(){}},'operation',op.key))
  f.cold();assert.deepEqual(managementRead(f,'operation',op.key)?.record,op)
 })
 test('Library完整捕获真实read-service全成员与scan来源冷回读，漏整页整轨或旧水位拒绝',async t=>{
  const f=await managementFixture(t,{albums:2,tracks:30}),capture=await f.capture(),frozen=structuredClone(capture)
  assert.equal(capture.original.albums.length,2);assert.equal(capture.original.albums.reduce((n,a)=>n+a.resolved.capture.members.length,0),60)
  assert.deepEqual(captureLocalLibraryManagementRecord(capture),capture)
  const omitted=structuredClone(capture);omitted.key=randomUUID();omitted.original.captureId=omitted.key
  omitted.original.albums=omitted.original.albums.slice(0,1);omitted.original.albumRefs=omitted.original.albumRefs.slice(0,1);omitted.originalSha256=localLibraryManagementDigest(omitted.original)
  assert.throws(()=>f.catalog.privateLibraryManagementCompareAndSwap(f.identity,[{record:omitted,expectedRevision:null}]),/遗漏专辑|分页/u)
  const subset=structuredClone(capture),r=subset.original.albums[0]!.resolved;subset.key=randomUUID();subset.original.captureId=subset.key;r.capture.members=r.capture.members.slice(0,1);r.group.members=r.group.members.slice(0,1);r.group.summary.trackCount=1;r.provenance=r.provenance.slice(0,1)
  r.capture.revision=localLibraryManagementDigest([r.group.summary.revision,f.root,r.directoryFacts,r.provenance,r.capture.members,r.capture.nameSources]);subset.originalSha256=localLibraryManagementDigest(subset.original)
  assert.throws(()=>f.catalog.privateLibraryManagementCompareAndSwap(f.identity,[{record:subset,expectedRevision:null}]),/遗漏完整成员/u)
  const stale=structuredClone(capture);stale.original.catalogRevision='stale-watermark';stale.originalSha256=localLibraryManagementDigest(stale.original)
  assert.throws(()=>f.catalog.privateLibraryManagementCompareAndSwap(f.identity,[{record:stale,expectedRevision:null}]),/水位/u)
  const chunks=createLocalLibraryManagementBatchEvents([{record:capture,previous:null}]);assert.ok(chunks.filter(e=>e.kind==='chunk').length>1);assert.ok(chunks.every(e=>Object.values(localLibraryManagementLedgerRow(e)).reduce((n,v)=>n+Buffer.byteLength(v),0)<=64*1024))
  f.catalog.privateLibraryManagementCompareAndSwap(f.identity,[{record:capture,expectedRevision:null}]);f.cold()
  assert.deepEqual(managementRead(f,'capture',capture.key)?.record,frozen)
  const cloned=managementRead(f,'capture',capture.key)!.record as LocalLibraryManagementCaptureRecord;cloned.original.albums=[]
  assert.deepEqual(managementRead(f,'capture',capture.key)?.record,frozen)
 })
/** 540只提供合法私有prepared事实；原合成文本不冒作这13族音频，更不签Reader或Native资格。 */
function managementFormats540():readonly ManagementScanFormat540[] {
  type Technical540=ManagementScanFormat540['technical']
  const format=(container:Technical540['container'],codec:string,lossless:boolean,overrides:Partial<Omit<Technical540,'container'|'codec'|'lossless'|'evidence'>>={}):ManagementScanFormat540=>({
    parserVersion:container==='TTA'||container==='TAK'?CUE_HEADER_METADATA_PARSER_VERSION:METADATA_PARSER_VERSION,
    technical:{container,codec,lossless,sampleRateHz:44100,channels:2,bitsPerSample:16,durationSeconds:2,evidence:'bounded-parser-reported',...overrides},
  })
  return [format('FLAC','FLAC',true),format('MPEG','MPEG 1 Layer 3',false),format('MP4','ALAC',true),format('WAVE','PCM',true),format('AIFF','PCM',true),
    format('DSF','DSD',true,{sampleRateHz:2822400,bitsPerSample:1}),format('DFF','DSD',true,{sampleRateHz:2822400,bitsPerSample:1}),
    format('OGG','Vorbis',false,{sampleRateHz:48000,bitsPerSample:null,durationSeconds:null}),format('WAVPACK','PCM',true,{sampleRateHz:48000,bitsPerSample:24,durationSeconds:0.5}),
    format('APE','APE',true),format('TTA','TTA',true),format('MPC','musepack7',false,{durationSeconds:88704/44100}),format('TAK','TAK',true)]
}
/** 只重签受控record的原内层摘要，不换dataset、captureId、根、原签名或实际SQL行。 */
function resealManagementCapture540(value:LocalLibraryManagementCaptureRecord):void {
  for(const album of value.original.albums){const r=album.resolved
    for(const member of r.capture.members){
      assert.notEqual(member.trackId,null,'540夹具必须使用完整accepted成员')
      const file=r.directoryFacts.files.find(row=>row.value.trackId===member.trackId);assert.ok(file)
      member.scan={signature:file.value.signature,parserVersion:file.value.parserVersion,revision:localLibraryManagementDigest(file),failureCode:file.value.failureCode}
    }
    const root:dto.LibraryRoot={id:album.libraryId,sourceRootId:album.sourceRootId,role:'library',revision:album.rootRevision}
    r.capture.revision=localLibraryManagementDigest([r.group.summary.revision,root,r.directoryFacts,r.provenance,r.capture.members,r.capture.nameSources])
  }
  value.originalSha256=localLibraryManagementDigest(value.original)
}
/** 在拒绝断言前独立核完整摘要闭环；错误parser/容器不能因旧checksum未更新而假红。 */
function assertManagementCaptureResealed540(value:LocalLibraryManagementCaptureRecord):void {
  assert.equal(value.originalSha256,localLibraryManagementDigest(value.original))
  for(const album of value.original.albums){const r=album.resolved,root:dto.LibraryRoot={id:album.libraryId,sourceRootId:album.sourceRootId,role:'library',revision:album.rootRevision}
    assert.equal(r.capture.revision,localLibraryManagementDigest([r.group.summary.revision,root,r.directoryFacts,r.provenance,r.capture.members,r.capture.nameSources]))
    for(const member of r.capture.members){const file=r.directoryFacts.files.find(row=>row.value.trackId===member.trackId);assert.ok(file)
      assert.deepEqual(member.scan,{signature:file.value.signature,parserVersion:file.value.parserVersion,revision:localLibraryManagementDigest(file),failureCode:file.value.failureCode})
    }
  }
}

test('Library540完整合法13容器capture按真实parser角色编解原ledger且同SQL冷回读',async t=>{
  const formats=managementFormats540(),containers=formats.map(value=>value.technical.container)
  assert.deepEqual(containers,['FLAC','MPEG','MP4','WAVE','AIFF','DSF','DFF','OGG','WAVPACK','APE','TTA','MPC','TAK']);assert.equal(new Set(containers).size,13)
  const f=await managementFixture(t,{albums:formats.length,tracks:1,scanFormats540:formats}),capture=await f.capture(),frozen=structuredClone(capture)
  assert.equal(capture.original.albums.length,13);assertManagementCaptureResealed540(capture)
  for(const album of capture.original.albums){const files=album.resolved.directoryFacts.files;assert.equal(files.length,1)
    const file=files[0]!;assert.ok(file.value.readFacts);const expected=formats.find(value=>value.technical.container===file.value.readFacts!.technical.container);assert.ok(expected)
    assert.equal(file.value.parserVersion,expected.parserVersion);assert.deepEqual(file.value.readFacts.technical,expected.technical)
    assert.equal(file.value.readFacts.readEvidence.wholeAudioHash,false);assert.equal(file.value.readFacts.readEvidence.wholeAudioDecode,false)
    assert.deepEqual(album.resolved.provenance,[{trackId:file.value.trackId,override:null}])
  }
  assert.deepEqual(captureLocalLibraryManagementRecord(capture),capture)
  const projection=emptyLocalLibraryManagementProjection(f.identity.datasetId),events=createLocalLibraryManagementBatchEvents([{record:capture,previous:null}])
  for(const [index,event]of events.entries()){const row=localLibraryManagementLedgerRow(event)
    assert.ok(Object.values(row).reduce((bytes,value)=>bytes+Buffer.byteLength(value),0)<=64*1024)
    projectLocalLibraryManagementEvent(projection,readLocalLibraryManagementEvent(row),index+1)
  }
  assertLocalLibraryManagementComplete(projection);assert.deepEqual(projection.records.get('capture:'+capture.key)?.record,frozen)
  f.catalog.privateLibraryManagementCompareAndSwap(f.identity,[{record:capture,expectedRevision:null}]);f.cold()
  assert.deepEqual(managementRead(f,'capture',capture.key)?.record,frozen)
  t.diagnostic('受控prepared扫描事实→真实read-service→原capture codec/CAS/同SQL冷核；没有调用音频Reader、Main、Native或Provider，不授音质/Source资格。')
})

test('Library540新六容器错parser及未知container在重签完整摘要后仍拒，修回字段恢复同原合法record',async t=>{
  const formats=managementFormats540().slice(7),f=await managementFixture(t,{albums:formats.length,tracks:1,scanFormats540:formats}),capture=await f.capture(),frozen=structuredClone(capture)
  assert.deepEqual(captureLocalLibraryManagementRecord(capture),capture);assertManagementCaptureResealed540(capture)
  for(const format of formats){
    const wrongParsers=[format.parserVersion===METADATA_PARSER_VERSION?CUE_HEADER_METADATA_PARSER_VERSION:METADATA_PARSER_VERSION,CUE_INPUT_SCAN_VERSION,'foreign-parser540/v1']
    for(const wrongParser of wrongParsers){const bad=structuredClone(capture),album=bad.original.albums.find(value=>value.resolved.directoryFacts.files[0]!.value.readFacts!.technical.container===format.technical.container);assert.ok(album)
      const file=album.resolved.directoryFacts.files[0]!;file.value.parserVersion=wrongParser;resealManagementCapture540(bad);assertManagementCaptureResealed540(bad)
      assert.notEqual(bad.originalSha256,capture.originalSha256)
      assert.throws(()=>captureLocalLibraryManagementRecord(bad),error=>error instanceof LocalWorkbenchPlanError&&error.code==='PERSISTENCE_FAILED',format.technical.container+'/'+wrongParser)
      file.value.parserVersion=format.parserVersion;resealManagementCapture540(bad);assertManagementCaptureResealed540(bad)
      assert.deepEqual(bad,frozen,'只修回错误parser，全部原摘要和record应恢复');assert.deepEqual(captureLocalLibraryManagementRecord(bad),frozen)
    }
  }
  const unknown=structuredClone(capture),file=unknown.original.albums[0]!.resolved.directoryFacts.files[0]!;assert.ok(file.value.readFacts)
  const originalContainer=file.value.readFacts.technical.container
  Object.assign(file.value.readFacts.technical,{container:'UNREGISTERED540'});resealManagementCapture540(unknown);assertManagementCaptureResealed540(unknown)
  assert.notEqual(unknown.originalSha256,capture.originalSha256)
  assert.throws(()=>captureLocalLibraryManagementRecord(unknown),error=>error instanceof LocalWorkbenchPlanError&&error.code==='PERSISTENCE_FAILED')
  Object.assign(file.value.readFacts.technical,{container:originalContainer});resealManagementCapture540(unknown);assertManagementCaptureResealed540(unknown)
  assert.deepEqual(unknown,frozen);assert.deepEqual(captureLocalLibraryManagementRecord(unknown),frozen)
  assert.equal(f.catalog.privateLibraryManagementRevision(f.identity),'0','非法codec输入只供validator，不写原SQL账本')
  assert.deepEqual(capture,frozen)
  t.diagnostic('6族×交叉实际parser/job版本/任意text共18个重签负例，加未知container；修复控制保同原UUID/根/签名，未运行Native或Source资格链。')
})

/** 552真实自有SQL/原CAS/journal，writer仅提供受控协议回执；没有源写、Main或Native。 */
async function registryJournalFixture552(t:import('node:test').TestContext,initial:'running'|'unknown'='unknown') {
  const f=await managementFixture(t,{albums:2,tracks:1}),complete=await f.capture()
  const capture:LocalWorkbenchPlanCapture={datasetId:f.identity.datasetId,datasetRevision:complete.original.watermark,albums:complete.original.albums.map(album=>structuredClone(album.resolved.capture))}
  const draft:LocalWorkbenchPlanDraft={kind:'ai',scope:'MB_ONLY',albumIds:capture.albums.map(album=>album.albumId),candidateIds:capture.albums.map(()=>randomUUID()),state:'ready',blockers:[],
    items:capture.albums.map(album=>({itemId:randomUUID(),albumId:album.albumId,label:album.albumName,changes:[{field:'album',before:album.albumName,after:album.albumName+'候选',reason:'552受控回执测试，不执行媒体写入'}]}))}
  let casCalls=0,applyCalls=0,observed:dto.LocalWorkbenchReceipt|null=null
  const reads:dto.LocalWorkbenchApplyRequest[]=[]
  const port:LocalWorkbenchOwnerJournalPort={privateWorkbenchSnapshot:requested=>f.catalog.privateWorkbenchSnapshot(requested),
    privateWorkbenchCompareAndSwap(requested,expected,events){casCalls++;f.catalog.privateWorkbenchCompareAndSwap(requested,expected,events)}}
  const persistence=createLocalWorkbenchOwnerPersistence(f.identity.datasetId,port)
  const writer:LocalWorkbenchProtectedWriter={revalidate:async()=>({valid:true}),apply:async(request,plan)=>{applyCalls++
    observed={commandId:request.commandId,datasetId:request.datasetId,planId:request.planId,planHash:request.planHash,state:initial,message:'552原受控协议回执',
      items:plan.items.map(item=>({itemId:item.itemId,albumId:item.albumId,label:item.label,state:'unknown',message:'552原项未确认'}))};return structuredClone(observed)},
    readOriginalReceipt:async request=>{assert.ok(Object.isFrozen(request));reads.push(structuredClone(request));assert.ok(observed);return structuredClone(observed)}}
  const registry=await createLocalWorkbenchPlanRegistry({datasetId:f.identity.datasetId,persistence,writer}),plan=await registry.issuePlan(draft,capture)
  const original:dto.LocalWorkbenchApplyRequest={commandId:randomUUID(),datasetId:plan.datasetId,planId:plan.planId,expectedRevision:plan.revision,planHash:plan.planHash,contextFingerprint:plan.contextFingerprint,kind:plan.kind}
  const applied=await registry.apply(original);assert.equal(applied.state,initial);assert.equal(applyCalls,1)
  function rows(){return f.catalog.privateRead(db=>db.prepare('SELECT * FROM local_catalog_ledger ORDER BY rowid').all())}
  function current(){assert.ok(observed);return structuredClone(observed)}
  return {f,registry,plan,original,persistence,writer,reads,rows,current,setObserved(receipt:dto.LocalWorkbenchReceipt){assert.ok(dto.isLocalWorkbenchReceipt(receipt,original,plan));observed=structuredClone(receipt)},
    get casCalls(){return casCalls},get applyCalls(){return applyCalls}}
}

test('Registry552重复running与unknown同原writer查询不推进真实SQL CAS/journal',async t=>{
  for(const state of ['running','unknown'] as const){const g=await registryJournalFixture552(t,state),originalRows=g.rows(),revision=g.registry.inspect().revision,calls=g.casCalls,expected=g.current()
    for(let index=0;index<16;index++)assert.deepEqual(await g.registry.readOriginalReceipt(g.original),expected)
    const parallel=await Promise.all(Array.from({length:8},()=>g.registry.readOriginalReceipt(g.original)));for(const receipt of parallel)assert.deepEqual(receipt,expected)
    assert.equal(g.reads.length,24);assert.ok(g.reads.every(request=>JSON.stringify(request)===JSON.stringify(g.original)))
    assert.equal(g.applyCalls,1);assert.equal(g.casCalls,calls);assert.equal(g.registry.inspect().revision,revision);assert.deepEqual(g.rows(),originalRows)
    await assert.rejects(g.registry.readOriginalReceipt({...g.original,commandId:randomUUID()}),error=>error instanceof LocalWorkbenchPlanError&&error.code==='INVALID_REQUEST')
    assert.equal(g.reads.length,24);assert.deepEqual(g.rows(),originalRows)
  }
  t.diagnostic('每次原writer.read被实际调用；重复回执只免原SQL journal CAS，未跳过作者查询、加delay或删旧ledger。')
})

test('Registry552完整message/item/进度/终态变化仍落账，迟到unknown合并免写且冷只读原命令',async t=>{
  const g=await registryJournalFixture552(t)
  async function changed(next:dto.LocalWorkbenchReceipt){const calls=g.casCalls,revision=g.registry.inspect().revision,rows=g.rows();g.setObserved(next)
    assert.deepEqual(await g.registry.readOriginalReceipt(g.original),next);assert.equal(g.casCalls,calls+1);assert.equal(g.registry.inspect().revision,revision+1)
    const now=g.rows();assert.ok(now.length>rows.length);assert.deepEqual(now.slice(0,rows.length),rows)
    assert.deepEqual(g.f.catalog.privateWorkbenchSnapshot(g.original.datasetId)?.entries[0]!.receipt,next)
  }
  const topMessage=g.current();topMessage.message='552仅总message变化';await changed(topMessage)
  const itemMessage=g.current();itemMessage.items=itemMessage.items.map((item,index)=>index===1?{...item,message:'552仅单项message变化'}:item);await changed(itemMessage)
  const progress=g.current();progress.state='partial';progress.items=progress.items.map((item,index)=>index===0?{...item,state:'not-written',message:'552已核此项未写'}:item);await changed(progress)
  const late=g.current();late.items=late.items.map((item,index)=>index===0?{...item,state:'unknown',message:'552迟到未知不得覆盖已知'}:item);g.setObserved(late)
  const calls=g.casCalls,revision=g.registry.inspect().revision,rows=g.rows();assert.deepEqual(await g.registry.readOriginalReceipt(g.original),progress)
  assert.equal(g.casCalls,calls);assert.equal(g.registry.inspect().revision,revision);assert.deepEqual(g.rows(),rows)
  const terminal=structuredClone(progress);terminal.state='failed';terminal.message='552原协议终态确认未写';terminal.items=terminal.items.map(item=>({...item,state:'not-written',message:'552原终态未写'}));await changed(terminal)
  const finalRows=g.rows(),finalCalls=g.casCalls,finalReads=g.reads.length;g.f.cold()
  const cold=await createLocalWorkbenchPlanRegistry({datasetId:g.original.datasetId,persistence:g.persistence,writer:{...g.writer,apply:async()=>assert.fail('冷读取不得重新apply')},now:()=>Date.parse(g.plan.expiresAt)+1})
  assert.equal(cold.inspect().entries[0]!.original!.commandId,g.original.commandId);assert.deepEqual(cold.operations()[0]!.receipt,terminal)
  assert.deepEqual(await cold.readOriginalReceipt(g.original),terminal);assert.equal(g.reads.length,finalReads);assert.equal(g.casCalls,finalCalls);assert.equal(g.applyCalls,1);assert.deepEqual(g.rows(),finalRows)
  await assert.rejects(cold.apply({...g.original,commandId:randomUUID()}),error=>error instanceof LocalWorkbenchPlanError&&error.code==='ALREADY_DISPATCHED')
  assert.deepEqual(g.rows(),finalRows)
  t.diagnostic('总message/单项message/known进度/终态都保原CAS；终态和cold沿历史原command只读门，不补发或换UUID。')
})

test('Registry552实际CAS失败poisoned之后相同完整回执仍拒，冷恢复原记录不重发',async t=>{
  const g=await registryJournalFixture552(t),original=g.current(),rows=g.rows(),revision=g.registry.inspect().revision
  const changed=g.current();changed.message='552此变化应触发实际SQL事务故障';g.setObserved(changed);g.f.setWorkbenchFailure552(true)
  await assert.rejects(g.registry.readOriginalReceipt(g.original),error=>error instanceof LocalWorkbenchPlanError&&error.code==='PERSISTENCE_FAILED')
  g.f.setWorkbenchFailure552(false);g.f.cold();assert.deepEqual(g.rows(),rows);assert.equal(g.registry.inspect().revision,revision)
  const attempted=g.casCalls,readCount=g.reads.length;g.setObserved(original)
  await assert.rejects(g.registry.readOriginalReceipt(g.original),error=>error instanceof LocalWorkbenchPlanError&&error.code==='PERSISTENCE_FAILED')
  assert.equal(g.reads.length,readCount+1);assert.equal(g.casCalls,attempted);assert.equal(g.applyCalls,1);assert.deepEqual(g.rows(),rows)
  const restored=await createLocalWorkbenchPlanRegistry({datasetId:g.original.datasetId,persistence:g.persistence,writer:{...g.writer,apply:async()=>assert.fail('失败后冷作者不得重发apply')}})
  assert.deepEqual(restored.inspect().entries[0]!.original,g.original);assert.deepEqual(await restored.readOriginalReceipt(g.original),original)
  assert.equal(g.casCalls,attempted);assert.deepEqual(g.rows(),rows);assert.equal(g.applyCalls,1)
  t.diagnostic('故障落在原自有SQL beforeCommit，不是memory CAS；新免写分支仍精确保原poisoned拒绝，冷新registry只读原durable前缀。')
})

 test('Library原AI job固定selection与capture，状态delta冷续链且UNKNOWN只读不换UUID重发',async t=>{
  const f=await managementFixture(t),capture=await f.capture();f.catalog.privateLibraryManagementCompareAndSwap(f.identity,[{record:capture,expectedRevision:null}])
  const job=jobRecord(f,capture);f.catalog.privateLibraryManagementCompareAndSwap(f.identity,[{record:job,expectedRevision:null}])
  const running=structuredClone(job);running.revision=2;running.checkpoint.state='running';running.checkpoint.items=running.checkpoint.items.map(i=>({...i,state:'running',planId:randomUUID(),commandId:randomUUID()}))
  f.catalog.privateLibraryManagementCompareAndSwap(f.identity,[{record:running,expectedRevision:1}])
  const unknown=structuredClone(running);unknown.revision=3;unknown.checkpoint.state='unknown';unknown.checkpoint.items=unknown.checkpoint.items.map(i=>({...i,state:'unknown'}))
  f.catalog.privateLibraryManagementCompareAndSwap(f.identity,[{record:unknown,expectedRevision:2}]);f.cold();assert.deepEqual(managementRead(f,'job',job.key)?.record,unknown)
  const reset=structuredClone(unknown);reset.revision=4;reset.checkpoint.state='queued';reset.checkpoint.items=reset.checkpoint.items.map(i=>({...i,state:'queued',commandId:randomUUID()}))
  assert.throws(()=>f.catalog.privateLibraryManagementCompareAndSwap(f.identity,[{record:reset,expectedRevision:3}]))
  const changed=structuredClone(unknown);changed.revision=4;changed.original.expandedSelection=changed.original.expandedSelection.slice(0,1);if(changed.original.start.command!=='library.ai.start')assert.fail('本例必须保持原AI命令');changed.original.start.request.albumIds=[changed.original.expandedSelection[0]!.albumId];changed.original.startSha256=localLibraryManagementDigest(changed.original.start);changed.originalSha256=localLibraryManagementDigest(changed.original)
  assert.throws(()=>f.catalog.privateLibraryManagementCompareAndSwap(f.identity,[{record:changed,expectedRevision:3}]))
  assert.deepEqual(managementRead(f,'job',job.key)?.record,unknown)


  const retryJob=jobRecord(f,capture);f.catalog.privateLibraryManagementCompareAndSwap(f.identity,[{record:retryJob,expectedRevision:null}])
  const failed=structuredClone(retryJob);failed.revision=2;failed.checkpoint.state='failed';failed.checkpoint.items=failed.checkpoint.items.map(i=>({...i,state:'failed',message:'受控执行前失败'}));f.catalog.privateLibraryManagementCompareAndSwap(f.identity,[{record:failed,expectedRevision:1}])
  const retry=structuredClone(failed);retry.revision=3;retry.checkpoint.state='queued';retry.checkpoint.action={command:'library.job.retry',request:{jobId:retry.key,albumIds:[retry.checkpoint.items[0]!.albumId]}};retry.checkpoint.items=retry.checkpoint.items.map((i,index)=>index===0?{...i,state:'queued',message:null,planId:null,commandId:null,receipt:null}:i)
  f.catalog.privateLibraryManagementCompareAndSwap(f.identity,[{record:retry,expectedRevision:2}]);f.cold();assert.deepEqual(managementRead(f,'job',retry.key)?.record,retry)
  const wrongRetry=structuredClone(retry);wrongRetry.revision=4;wrongRetry.checkpoint.action={command:'library.job.retry',request:{jobId:wrongRetry.key,albumIds:[wrongRetry.checkpoint.items[0]!.albumId]}};assert.throws(()=>f.catalog.privateLibraryManagementCompareAndSwap(f.identity,[{record:wrongRetry,expectedRevision:3}]))
  const stopped=structuredClone(retry);stopped.revision=4;stopped.checkpoint.state='stopped';stopped.checkpoint.action={command:'library.job.stop',request:{jobId:stopped.key}};f.catalog.privateLibraryManagementCompareAndSwap(f.identity,[{record:stopped,expectedRevision:3}])
  const resumed=structuredClone(stopped);resumed.revision=5;resumed.checkpoint.state='queued';resumed.checkpoint.action={command:'library.job.resume',request:{jobId:resumed.key}};f.catalog.privateLibraryManagementCompareAndSwap(f.identity,[{record:resumed,expectedRevision:4}]);f.cold();assert.deepEqual(managementRead(f,'job',resumed.key)?.record,resumed)
  const cueStart={command:'library.cue.start' as const,request:{commandId:randomUUID(),captureId:capture.key,selection:'all-unsplit' as const,selections:[],outputFormat:'flac',target:{choiceId:randomUUID(),label:'受控独立输出',independent:true as const}}}
  const cueOriginal={start:cueStart,startSha256:localLibraryManagementDigest(cueStart),captureId:capture.key,captureSha256:capture.originalSha256,expandedSelection:[]}
  const cueJob:LocalLibraryManagementJobRecord={schema:1,kind:'job',datasetId:f.identity.datasetId,key:cueStart.request.commandId,revision:1,original:cueOriginal,originalSha256:localLibraryManagementDigest(cueOriginal),checkpoint:{state:'queued',action:null,items:[]}}
  f.catalog.privateLibraryManagementCompareAndSwap(f.identity,[{record:cueJob,expectedRevision:null}]);f.cold();assert.deepEqual(managementRead(f,'job',cueJob.key)?.record,cueJob)
  const invented=structuredClone(cueJob),ref=capture.original.albumRefs[0]!,cueId=randomUUID();invented.key=randomUUID();invented.original.start={command:'library.cue.start',request:{...cueStart.request,commandId:invented.key,selection:'selected',selections:[{albumId:ref.albumId,cueId}]}};invented.original.startSha256=localLibraryManagementDigest(invented.original.start);invented.original.expandedSelection=[{...ref,cueId}];invented.originalSha256=localLibraryManagementDigest(invented.original);invented.checkpoint.items=[{albumId:ref.albumId,state:'queued',message:null,planId:null,commandId:null,receipt:null}]
  assert.throws(()=>f.catalog.privateLibraryManagementCompareAndSwap(f.identity,[{record:invented,expectedRevision:null}]))
  f.close();const raw=new DatabaseSync(f.file);try{const rows=raw.prepare('SELECT request FROM local_catalog_ledger WHERE operation=? ORDER BY rowid').all(LOCAL_LIBRARY_MANAGEMENT_OPERATION).map(row=>JSON.parse(String(row.request)));assert.ok(rows.some(r=>r.encoding==='job-state-v1'));assert.ok(rows.filter(r=>r.key===job.key&&r.revision>1).every(r=>r.encoding==='job-state-v1'));}finally{raw.close()}
 })
 test('Library捕获冷验历史metadata而非最终覆盖，原job首次受理仍拒绝当前源漂移',async t=>{
  const f=await managementFixture(t),capture=await f.capture();f.catalog.privateLibraryManagementCompareAndSwap(f.identity,[{record:capture,expectedRevision:null}])
  const track=capture.original.albums[0]!.resolved.group.members[0]!.fact.summary.track
  f.catalog.overrideMetadata({commandId:randomUUID(),trackId:track.id,expectedRevision:null,fields:{album:'外部改变的专辑'}})
  f.cold();assert.deepEqual(managementRead(f,'capture',capture.key)?.record,capture)
  const job=jobRecord(f,capture);assert.throws(()=>f.catalog.privateLibraryManagementCompareAndSwap(f.identity,[{record:job,expectedRevision:null}]))
  assert.equal(managementRead(f,'job',job.key),null)
 })
 test('Library冷开拒绝自洽缺成员capture与不完整尾帧，保留原SQLite不修尾',async t=>{
  for(const incomplete of [false,true]){
    const f=await managementFixture(t),capture=await f.capture();const originalKey=capture.key
    if(!incomplete){const r=capture.original.albums[0]!.resolved;r.capture.members=r.capture.members.slice(0,1);r.group.members=r.group.members.slice(0,1);r.group.summary.trackCount=1;r.provenance=r.provenance.slice(0,1);r.capture.revision=localLibraryManagementDigest([r.group.summary.revision,f.root,r.directoryFacts,r.provenance,r.capture.members,r.capture.nameSources]);capture.originalSha256=localLibraryManagementDigest(capture.original)}
    const events=createLocalLibraryManagementBatchEvents([{record:capture,previous:null}]);f.close();const raw=new DatabaseSync(f.file)
    try{for(const event of incomplete?events.slice(0,-1):events){const row=localLibraryManagementLedgerRow(event);raw.prepare('INSERT INTO local_catalog_ledger VALUES(?,?,?,?,?,?)').run(row.command_id!,row.fingerprint!,row.operation!,row.request!,row.result!,row.created_at!)}}finally{raw.close()}
    const before=await readFile(f.file);assert.throws(()=>{f.cold();managementRead(f,'capture',capture.key)});assert.deepEqual(await readFile(f.file),before);assert.ok(originalKey)
  }
 })
 test('Library隐含getter或自由JSON拒绝且40KiB分块与完整batch尾保持原64KiB行预算',async t=>{
  const f=await managementFixture(t),capture=await f.capture();let accessed=0
  const getter=structuredClone(capture);Object.defineProperty(getter.original,'secret',{get(){accessed++;return '不能进入账本'},enumerable:true})
  assert.throws(()=>captureLocalLibraryManagementRecord(getter));assert.equal(accessed,0)
  const wrongType=structuredClone(capture);Object.assign(wrongType.original.albums[0]!,{rootRevision:1});wrongType.originalSha256=localLibraryManagementDigest(wrongType.original);assert.throws(()=>captureLocalLibraryManagementRecord(wrongType))
  assert.throws(()=>captureLocalLibraryManagementRecord({...capture,unexpectedDomain:{path:'/不接受自由JSON'}}))
  const overflow=structuredClone(capture);overflow.original.albums=Array.from({length:10001},()=>capture.original.albums[0]!);assert.throws(()=>captureLocalLibraryManagementRecord(overflow))

  /** 字段均保合同合法长度；只验证codec的32MiB，不声称这些新UUID是真实SQL成员。 */
  function codecCapture(count:number):LocalLibraryManagementCaptureRecord {
    const value=structuredClone(capture),album=structuredClone(value.original.albums[0]!),r=album.resolved,base=r.group.members[0]!,file=r.directoryFacts.files[0]!,originalMember=r.capture.members[0]!,word='量'.repeat(480)
    const raw:dto.LocalMetadata={title:word,artist:word,album:word}
    const ids=(i:number,prefix:string)=>prefix+'0000000-0000-4000-8000-'+i.toString(16).padStart(12,'0')
    r.group.members=Array.from({length:count},(_,i)=>{const member=structuredClone(base);member.fact.relative='目录0/预算'+i+'.flac';member.fact.summary.track.id=ids(i,'e');member.fact.summary.asset.id=ids(i,'d');member.fact.summary.track.assetId=member.fact.summary.asset.id;member.fact.rawMetadata={...raw};member.fact.summary.metadata={...raw};member.sequence=i+1;return member})
    r.group.summary.trackCount=count;r.group.summary.representativeTrackId=r.group.members[0]!.fact.summary.track.id;r.group.summary.title=word;r.group.summary.artists=[word]
    r.directoryFacts.files=r.group.members.map(member=>{const current=structuredClone(file);current.currentRelative=member.fact.relative;current.value.relative=member.fact.relative;current.value.trackId=member.fact.summary.track.id;current.value.assetId=member.fact.summary.asset.id;return current})
    r.provenance=r.group.members.map(member=>({trackId:member.fact.summary.track.id,override:null}))
    r.capture.members=r.group.members.map((member,i)=>{const current=structuredClone(originalMember);current.trackId=member.fact.summary.track.id;current.assetId=member.fact.summary.asset.id;current.fileName='预算'+i+'.flac';current.title=word;current.artist=word;current.album=word;current.metadataRevision=localLibraryManagementDigest({raw,override:null,effective:raw});const source=r.directoryFacts.files[i]!;current.scan={signature:source.value.signature,parserVersion:source.value.parserVersion,revision:localLibraryManagementDigest(source),failureCode:null};return current})
    r.capture.artistName=word;r.capture.albumName=word;r.capture.revision=localLibraryManagementDigest([r.group.summary.revision,f.root,r.directoryFacts,r.provenance,r.capture.members,r.capture.nameSources])
    value.original.albums=[album];value.original.albumRefs=value.original.albumRefs.slice(0,1);value.originalSha256=localLibraryManagementDigest(value.original);return value
  }
  assert.ok(captureLocalLibraryManagementRecord(codecCapture(100)));assert.throws(()=>captureLocalLibraryManagementRecord(codecCapture(2600)))

  assert.equal(f.catalog.privateLibraryManagementRevision(f.identity),'0')
  const op=operation(f,'library.import.confirm',{commandId:randomUUID(),choiceId:randomUUID(),role:'catalog'},[f.root.id]),b=binding(f,op)
  const events=createLocalLibraryManagementBatchEvents([{record:b,previous:null},{record:op,previous:null}]),projection=emptyLocalLibraryManagementProjection(f.identity.datasetId)
  const endFirst=events.findIndex(e=>e.kind==='commit')
  for(const [i,event]of events.slice(0,endFirst+1).entries()){const row=localLibraryManagementLedgerRow(event);assert.ok(Object.values(row).reduce((n,v)=>n+Buffer.byteLength(v),0)<=64*1024);projectLocalLibraryManagementEvent(projection,readLocalLibraryManagementEvent(row),i+1)}
  assert.throws(()=>assertLocalLibraryManagementComplete(projection));assert.equal(projection.records.size,0)
  for(const [i,event]of events.slice(endFirst+1).entries())projectLocalLibraryManagementEvent(projection,event,endFirst+2+i)
  assertLocalLibraryManagementComplete(projection);assert.equal(projection.records.size,2)
 })
 test('Library有限pending枚举冷开只回原CUE与物理记录，空库不虚构grant或第二连接',async t=>{
  const f=await managementFixture(t)
  assert.deepEqual(f.catalog.privateLyricsPhysicalPending(f.identity),[]);assert.deepEqual(f.catalog.privateCueOutputPending(f.identity),[]);assert.deepEqual(f.catalog.privateLyricsPhysicalPublications(f.identity,randomUUID()),[])

  const capture=await f.capture(),album=capture.original.albums[0]!,members=album.resolved.capture.members.filter(m=>m.trackId!==null)
  const group:LocalLyricsPhysicalGroup={members:[],resources:[]}
  const memberList:import('../src/library/lyrics-source-format.js').LocalLyricsPhysicalMember[]=[],resources:import('../src/library/lyrics-source-format.js').LocalLyricsPhysicalResource[]=[]
  for(const [i,m]of members.entries()){
    const fact=album.resolved.group.members.find(item=>item.fact.summary.track.id===m.trackId)!.fact,info=await stat(f.directory+'/source/'+fact.relative,{bigint:true}),bytes=await readFile(f.directory+'/source/'+fact.relative)
    memberList.push({trackId:m.trackId!,rootId:f.root.id,sourceRootId:f.source.id,fileId:m.assetId!,rootRevision:m.rootRevision,fileRevision:m.fileRevision!,locationRevision:m.locationRevision!,metadataRevision:m.metadataRevision!,resourceIndex:i})
    resources.push({rootId:f.source.id,relative:fact.relative,sha256:digest(bytes),bytes:bytes.length,signature:[info.dev,info.ino,info.size,info.mtimeNs,info.ctimeNs].join(':'),birthtimeNs:String(info.birthtimeNs),permissionMode:String(info.mode&0o7777n),uid:String(info.uid),gid:String(info.gid),dev:String(info.dev),ino:String(info.ino)})
  }
  group.members=memberList;group.resources=resources
  const first=memberList[0]!,lyricsRequest={commandId:randomUUID(),sessionId:randomUUID(),embed:false},body='[00:00.00]受控原歌词\n'
  const selected:LocalLyricsSelectedBody={track:{trackId:first.trackId,title:'受控曲目',artist:'合成作者',album:'合成专辑',language:'zh',version:'original',durationMs:2000,wholeTrack:false,format:'flac',rootRevision:first.rootRevision,fileRevision:first.fileRevision,locationRevision:first.locationRevision,metadataRevision:first.metadataRevision,lrc:'false',embedded:'false'},candidateId:randomUUID(),source:'lrclib',body,sha256:digest(Buffer.from(body))}
  const draft={request:lyricsRequest,scope:{datasetId:f.identity.datasetId,libraryId:f.root.id,albumId:album.resolved.capture.albumId,captureId:capture.key},captureFingerprint:lyricsPhysicalDigest(group),selected:[selected]},intent:LocalLyricsSaveIntent={...draft,fingerprint:localLyricsIntentFingerprint(draft)}
  f.catalog.privateLyricsCompareAndSwap(f.identity.datasetId,'save',{intent,receipt:{commandId:lyricsRequest.commandId,sessionId:lyricsRequest.sessionId,state:'running',cover:'saved',tracks:[{trackId:first.trackId,lrc:'pending',embed:'not-requested'}],snapshot:'not-requested'},revision:0,physicalClosed:false,discarded:false},null)
  const binding={datasetId:f.identity.datasetId,ownerEpoch:randomUUID(),commandId:lyricsRequest.commandId,sessionId:lyricsRequest.sessionId,intentFingerprint:intent.fingerprint,libraryId:f.root.id,albumId:intent.scope.albumId,captureId:capture.key,trackId:first.trackId,candidateId:selected.candidateId,bodySha256:selected.sha256,kind:'lrc' as const,rootRevision:first.rootRevision,fileRevision:first.fileRevision,locationRevision:first.locationRevision,metadataRevision:first.metadataRevision,
    originalIntentSha256:lyricsPhysicalDigest(intent),originalRequestSha256:lyricsPhysicalDigest(lyricsRequest),groupCaptureSha256:intent.captureFingerprint,protectionSha256:lyricsPhysicalDigest(group),memberCount:memberList.length,resourceCount:resources.length,targetCount:1}
  const physical:LocalLyricsPhysicalRecord={schema:1,operationId:localLyricsPhysicalOperationId(binding),binding,original:group,revision:1,currentOwnerEpoch:binding.ownerEpoch,phase:'PREPARED',grant:null,artifacts:{stage:null,backup:null,quarantine:null,target:null},fidelity:null,result:null,physicalClosed:false,protectionReleased:false,unresolved:false}
  const sequence=f.catalog.privateLyricsPhysicalCompareAndSwap(f.identity,physical,null);f.cold()
  assert.deepEqual(f.catalog.privateLyricsPhysicalPending(f.identity),[{record:physical,ledgerSequence:sequence}])
  assert.deepEqual(f.catalog.privateLyricsPhysicalPublications(f.identity,lyricsRequest.commandId),[{record:physical,ledgerSequence:sequence,publication:null,publicationSequence:null}]);assert.equal(f.catalog.privateLyricsPhysicalPending(f.identity)[0]!.record.grant,null)
  const failed:LocalLyricsPhysicalRecord={...physical,revision:2,phase:'FAILED',physicalClosed:true,protectionReleased:true,result:{state:'failed',bodySha256:binding.bodySha256}}
  f.catalog.privateLyricsPhysicalCompareAndSwap(f.identity,failed,1);f.cold();assert.deepEqual(f.catalog.privateLyricsPhysicalPending(f.identity),[]);assert.equal(f.catalog.privateLyricsPhysicalPublications(f.identity,lyricsRequest.commandId)[0]!.record.phase,'FAILED')
  const request={commandId:randomUUID(),datasetId:f.identity.datasetId,planId:randomUUID(),expectedRevision:'1',planHash:'1'.repeat(64),contextFingerprint:'2'.repeat(64),kind:'cue' as const}
  const cue={schema:1 as const,request,revision:0,phase:'prepared' as const,outputRoot:null,stageDirectory:null,staged:[],published:[],physicalClosed:false,receipt:{commandId:request.commandId,datasetId:request.datasetId,planId:request.planId,planHash:request.planHash,state:'running' as const,items:[{itemId:randomUUID(),albumId:'pending-cue-controlled',label:'受控CUE原记录',state:'not-written' as const,message:null}],message:null}}
  const committed=f.catalog.privateCueOutputCompareAndSwap(f.identity,cue,null);f.cold();assert.deepEqual(f.catalog.privateCueOutputPending(f.identity),[{record:cue,ledgerSequence:committed.ledgerSequence}])
  // 这里只验证同SQL记录规范；未打开Native/输出FD，不把受控terminal当实际物理join证据。
  const invalidClosed={...cue,revision:1,phase:'cancelled' as const,physicalClosed:true,receipt:{...cue.receipt,state:'cancelled' as const}}
  assert.throws(()=>f.catalog.privateCueOutputCompareAndSwap(f.identity,invalidClosed,0),{code:'INVALID'})
  assert.deepEqual(f.catalog.privateCueOutputRead(f.identity,request.commandId),{record:cue,ledgerSequence:committed.ledgerSequence})
  const cancelling={...cue,revision:1,phase:'cancelling' as const,receipt:{...cue.receipt,state:'unknown' as const,items:cue.receipt.items.map(item=>({...item,state:'unknown' as const}))}}
  const cancellingCommit=f.catalog.privateCueOutputCompareAndSwap(f.identity,cancelling,0);f.cold()
  assert.deepEqual(f.catalog.privateCueOutputPending(f.identity),[{record:cancelling,ledgerSequence:cancellingCommit.ledgerSequence}])
  const closed={...cancelling,revision:2,phase:'cancelled' as const,physicalClosed:true,receipt:{...cancelling.receipt,state:'cancelled' as const,items:cancelling.receipt.items.map(item=>({...item,state:'cancelled' as const}))}}
  f.catalog.privateCueOutputCompareAndSwap(f.identity,closed,1);f.cold();assert.deepEqual(f.catalog.privateCueOutputPending(f.identity),[])
  assert.throws(()=>f.catalog.privateCueOutputPending({...f.identity}));assert.throws(()=>f.catalog.privateLyricsPhysicalPublications({...f.identity},request.commandId))
 })


/** 426a只验证原import有限恢复，不回放已绿的旧Native/容量组。 */
test('426a原import先持久body，同SQL注册后一次绑定，冷开仍只读同一原回执',async t=>{
  const f=await managementFixture(t),commandId=randomUUID(),original=operation(f,'library.import.confirm',{commandId,choiceId:randomUUID(),role:'album'},[],'running')
  f.catalog.privateLibraryManagementCompareAndSwap(f.identity,[{record:original,expectedRevision:null}]);f.cold()
  const saved=managementRead(f,'operation',commandId);assert.deepEqual(saved?.record,original)
  const directory=f.directory+'/new-source';await mkdir(directory,{mode:0o700});const capability=await authorizeSourceDirectory(directory)
  const source=f.repository.sources.authorize(commandId,capability),root=f.catalog.registerRoot({commandId,sourceRootId:source.id,role:'library'})
  assert.equal(f.repository.sources.rootReceipt(commandId)?.id,source.id);assert.equal(f.catalog.receipt(commandId)?.operation,'register-root')
  const completed:LocalLibraryManagementOperationRecord={...original,revision:2,receipt:{...original.receipt,state:'succeeded',libraryIds:[root.id]}}
  const binding:LocalLibraryManagementBindingRecord={schema:1,kind:'binding',datasetId:f.identity.datasetId,key:root.id,revision:1,libraryId:root.id,sourceRootId:source.id,rootRevision:root.revision,role:'album',name:'实际合成目录',active:true,watchEnabled:false,operationId:commandId}
  const write=[{record:binding,expectedRevision:null},{record:completed,expectedRevision:1}];const before=f.catalog.privateLibraryManagementRevision(f.identity)
  const committed=f.catalog.privateLibraryManagementCompareAndSwap(f.identity,write);assert.notEqual(committed.ledgerSequence,before)
  assert.throws(()=>f.catalog.privateLibraryManagementCompareAndSwap(f.identity,write),/CAS/u)
  f.cold();assert.deepEqual(managementRead(f,'operation',commandId)?.record,completed);assert.deepEqual(managementRead(f,'binding',root.id)?.record,binding)
  assert.equal(f.repository.sources.rootReceipt(commandId)?.id,source.id);const receipt=f.catalog.receipt(commandId);assert.ok(receipt&&dto.isLibraryRoot(receipt.result));assert.equal(receipt.result.id,root.id)
})
test('426a失联UNKNOWN不换body，伪Root回执或仅半binding不能补成import成功',async t=>{
  const f=await managementFixture(t),commandId=randomUUID(),running=operation(f,'library.import.confirm',{commandId,choiceId:randomUUID(),role:'catalog'},[],'running')
  f.catalog.privateLibraryManagementCompareAndSwap(f.identity,[{record:running,expectedRevision:null}])
  const unknown:LocalLibraryManagementOperationRecord={...running,revision:2,receipt:{...running.receipt,state:'unknown'}}
  f.catalog.privateLibraryManagementCompareAndSwap(f.identity,[{record:unknown,expectedRevision:1}]);f.cold()
  const completed:LocalLibraryManagementOperationRecord={...unknown,revision:3,receipt:{...unknown.receipt,state:'succeeded',libraryIds:[f.root.id]}}
  const first={...binding(f,completed),revision:1},base=f.catalog.privateLibraryManagementRevision(f.identity)
  assert.throws(()=>f.catalog.privateLibraryManagementCompareAndSwap(f.identity,[{record:completed,expectedRevision:2},{record:first,expectedRevision:null}]));f.cold()
  assert.throws(()=>f.catalog.privateLibraryManagementCompareAndSwap(f.identity,[{record:first,expectedRevision:null}]));f.cold()
  assert.throws(()=>f.catalog.privateLibraryManagementCompareAndSwap(f.identity,[{record:completed,expectedRevision:2}]));f.cold()
  const changed=structuredClone(completed);changed.original={command:'library.import.confirm',request:{commandId,choiceId:randomUUID(),role:'catalog'}};changed.originalSha256=localLibraryManagementDigest(changed.original)
  assert.throws(()=>f.catalog.privateLibraryManagementCompareAndSwap(f.identity,[{record:first,expectedRevision:null},{record:changed,expectedRevision:2}]));f.cold()
  assert.equal(f.catalog.privateLibraryManagementRevision(f.identity),base);assert.deepEqual(managementRead(f,'operation',commandId)?.record,unknown);assert.equal(managementRead(f,'binding',f.root.id),null)
})
test('426a真实register-root的binding与成功回执在失败事务中均不半提交，冷完整链拒绝伪原command',async t=>{
  const f=await managementFixture(t),commandId=randomUUID(),running=operation(f,'library.import.confirm',{commandId,choiceId:randomUUID(),role:'container'},[],'running')
  f.catalog.privateLibraryManagementCompareAndSwap(f.identity,[{record:running,expectedRevision:null}])
  const directory=f.directory+'/owned-import';await mkdir(directory,{mode:0o700});const source=f.repository.sources.authorize(commandId,await authorizeSourceDirectory(directory)),root=f.catalog.registerRoot({commandId,sourceRootId:source.id,role:'library'})
  const completed:LocalLibraryManagementOperationRecord={...running,revision:2,receipt:{...running.receipt,state:'succeeded',libraryIds:[root.id]}}
  const bind:LocalLibraryManagementBindingRecord={schema:1,kind:'binding',datasetId:f.identity.datasetId,key:root.id,revision:1,libraryId:root.id,sourceRootId:source.id,rootRevision:root.revision,role:'container',name:'原容器',active:true,watchEnabled:false,operationId:commandId}
  const writes=[{record:bind,expectedRevision:null},{record:completed,expectedRevision:1}],before=f.catalog.privateLibraryManagementRevision(f.identity)
  f.setFailure(true);assert.throws(()=>f.catalog.privateLibraryManagementCompareAndSwap(f.identity,writes));assert.equal(f.failureCalls,1);f.cold();assert.equal(f.catalog.privateLibraryManagementRevision(f.identity),before);assert.equal(managementRead(f,'binding',root.id),null)
  assert.deepEqual(managementRead(f,'operation',commandId)?.record,running);f.setFailure(false);f.catalog.privateLibraryManagementCompareAndSwap(f.identity,writes);f.cold()
  assert.deepEqual(managementRead(f,'operation',commandId)?.record,completed)
  // 实际冷codec消费完整ledger；独立新鲜副本删除原注册回执，不能只看合法管理JSON。
  f.close();const duplicate=f.directory+'/tampered.sqlite';await __importCopy(f.file,duplicate)
  const db=new DatabaseSync(duplicate);db.exec('DROP TRIGGER local_catalog_ledger_no_delete');db.prepare('DELETE FROM local_catalog_ledger WHERE command_id=?').run(commandId);db.exec("CREATE TRIGGER local_catalog_ledger_no_delete BEFORE DELETE ON local_catalog_ledger BEGIN SELECT RAISE(ABORT,'本地目录身份保留'); END");db.close()
  const damaged=createCollectionRepository({filePath:duplicate,stagingRoot:f.directory+'/staging'});t.after(()=>damaged.close())
  const coldIdentity={datasetId:f.identity.datasetId,assertCurrent(){}}
  assert.throws(()=>{damaged.localCatalog.privateBindWorkbenchDataset(coldIdentity);damaged.localCatalog.privateLibraryManagementRead(coldIdentity,'operation',commandId)})
})
async function __importCopy(source:string,target:string):Promise<void>{await writeFile(target,await readFile(source),{flag:'wx',mode:0o600})}

import {MessageChannel as ReadersMessageChannel493,type MessagePort as ReadersMessagePort493} from 'node:worker_threads'
import {createSourceWritesMainActor as createReadersActor493,requestSourceWorkbenchReadersStop as requestReadersStop493,
  consumeSourceWorkbenchReadersReply as consumeReadersReply493,captureSourceWorkbenchReadersRequest as captureReadersRequest493,
  captureSourceWorkbenchReadersReply as captureReadersReply493,assertSourceWorkbenchReadersReplyForRequest as assertReadersReply493,
  type SourceWorkbenchReadersRequest as ReadersRequest493,type SourceWorkbenchReadersBinding as ReadersBinding493} from '../src/collection/source-writes-authority.js'
import {createUtilitySourceWritesBridge as createReadersUtility493,type SourceWritesUtilityPort as ReadersUtilityPort493} from '../src/shared/source-writes-utility-port.js'

const closedReadersPorts493=new WeakSet<ReadersMessagePort493>()
function readersPort493(port:ReadersMessagePort493){port.once('close',()=>closedReadersPorts493.add(port));return port}
async function readersClosed493(port:ReadersMessagePort493,close=false){
  if(closedReadersPorts493.has(port))return
  await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('原Node读取fence物理端口未闭493')),2000)
    port.once('close',()=>{clearTimeout(timer);resolve()});if(close)port.close()})
}
function readersDeferred493<T>(){let resolve!:(value:T)=>void;let reject!:(reason:unknown)=>void;const promise=new Promise<T>((a,b)=>{resolve=a;reject=b});return{promise,resolve,reject}}

/** 真实Node MessageChannel仅适配Electron消息事件外壳；不称实际UtilityProcess/Main资源factory。 */
class ReadersUtilityNode493 implements ReadersUtilityPort493{
  private readonly mapped=new Map<unknown,(data:unknown)=>void>()
  constructor(readonly port:ReadersMessagePort493){}
  on(event:'message',listener:(event:{data:unknown;ports?:readonly unknown[]})=>void):unknown
  on(event:'close'|'messageerror',listener:()=>void):unknown
  on(event:'message'|'close'|'messageerror',listener:((event:{data:unknown;ports?:readonly unknown[]})=>void)|(()=>void)):unknown{
    if(event==='message'){const forward=(data:unknown)=>(listener as (event:{data:unknown;ports?:readonly unknown[]})=>void)({data,ports:[]});this.mapped.set(listener,forward);return this.port.on('message',forward)}
    return this.port.on(event,listener as ()=>void)
  }
  off(event:'message',listener:(event:{data:unknown;ports?:readonly unknown[]})=>void):unknown
  off(event:'close'|'messageerror',listener:()=>void):unknown
  off(event:'message'|'close'|'messageerror',listener:((event:{data:unknown;ports?:readonly unknown[]})=>void)|(()=>void)):unknown{
    if(event==='message'){const forward=this.mapped.get(listener);if(forward){this.mapped.delete(listener);return this.port.off('message',forward)}return}
    return this.port.off(event,listener as ()=>void)
  }
  start(){this.port.start()}
  postMessage(value:unknown){this.port.postMessage(value)}
  close(){this.port.close()}
}
function readersEcho493(q:ReadersRequest493,failure:null|'UNKNOWN'|'TIMEOUT'=null){
  return captureReadersReply493({version:1,type:'workbench-readers-stop-reply',purpose:'WORKBENCH_READERS',requestId:q.requestId,sequence:q.sequence,authorityId:q.authorityId,
    requestSha256:lyricsPhysicalDigest(q),binding:q.binding,ok:failure===null,physicalClosed:failure!=='UNKNOWN',failure})
}
/** 493旧C03 fixture只补同SQL原running确认后的空Main资源回声，不假装完整Main/C03。 */
function removalReaders493(t:import('node:test').TestContext,repository:ReturnType<typeof createCollectionRepository>,identity:Parameters<typeof repository.localCatalog.privateBindWorkbenchDataset>[0],epoch:string,options:{hold?:boolean;failure?:'UNKNOWN'|'TIMEOUT'}){
  const channel=new ReadersMessageChannel493(),owner=readersPort493(channel.port1),main=readersPort493(channel.port2),actor=createReadersActor493(owner)
  const first=readersDeferred493<ReadersRequest493>(),gate=readersDeferred493<void>(),received:ReadersRequest493[]=[],replies:ReturnType<typeof captureReadersReply493>[]=[],consumed:ReturnType<typeof captureReadersReply493>[]=[],failures:unknown[]=[]
  if(!options.hold)gate.resolve()
  owner.on('message',raw=>{try{if(consumeReadersReply493(actor,raw))consumed.push(captureReadersReply493(raw))}catch(error){failures.push(error);owner.close()}})
  main.on('message',raw=>{void (async()=>{
    const q=captureReadersRequest493(raw),binding=q.binding,operation=repository.localCatalog.privateLibraryManagementRead(identity,'operation',binding.commandId),library=repository.localCatalog.privateLibraryManagementRead(identity,'binding',binding.libraryId)
    assert.ok(operation&&library);assert.equal(operation.record.revision,1);assert.equal(operation.record.receipt.state,'running');assert.equal(operation.record.original.command,'library.remove')
    assert.equal(operation.record.originalSha256,binding.originalSha256);assert.ok(operation.record.receipt.libraryIds.includes(binding.libraryId));assert.equal(library.record.active,true)
    assert.equal(binding.datasetId,identity.datasetId);assert.equal(binding.ownerEpoch,epoch);assert.equal(q.authorityId,actor.authorityId)
    received.push(q);first.resolve(q);await gate.promise
    const reply=readersEcho493(q,options.failure??null);assertReadersReply493(reply,q);replies.push(reply);main.postMessage(reply)
  })().catch(error=>{failures.push(error);first.reject(error);main.close()})})
  async function close(){gate.resolve();await Promise.all([readersClosed493(owner,true),readersClosed493(main,true)])}
  t.after(close)
  return{actor,first:first.promise,received,replies,consumed,failures,release(){gate.resolve()},close}
}

test('按库Main fence493：真实Node Actor经Utility往返只消费原完整绑定回声，串字段与克隆致失权并实际关闭派生端口',async t=>{
  const binding:ReadersBinding493={commandId:randomUUID(),originalSha256:'a'.repeat(64),libraryId:randomUUID(),datasetId:randomUUID(),ownerEpoch:randomUUID()}
  for(const bad of [null,'commandId','originalSha256','libraryId','datasetId','ownerEpoch'] as const){
    const channel=new ReadersMessageChannel493(),main=readersPort493(channel.port1),utility=readersPort493(channel.port2),bridge=createReadersUtility493(new ReadersUtilityNode493(utility)),owner=readersPort493(bridge.port),actor=createReadersActor493(owner)
    let original:ReadersRequest493|undefined,seen:unknown,consumed=0
    owner.on('message',raw=>{seen=raw;if(consumeReadersReply493(actor,raw))consumed++})
    main.on('message',raw=>{original=captureReadersRequest493(raw);const reply=readersEcho493(original)
      if(bad!==null)reply.binding={...reply.binding,[bad]:bad==='originalSha256'?'b'.repeat(64):randomUUID()}
      main.postMessage(reply)})
    const request=requestReadersStop493(actor,binding,{signal:new AbortController().signal,deadlineAtMs:performance.now()+2000})
    try{
      if(bad===null){await request;assert.ok(original&&seen);assert.equal(original.sequence,1);assert.equal(original.authorityId,actor.authorityId);assert.equal(Object.getPrototypeOf(original.binding),null);assert.deepEqual({...original.binding},binding)
        const reply=captureReadersReply493(seen);assertReadersReply493(reply,original);assert.equal(consumed,1);assert.equal(reply.ok,true);assert.equal(reply.physicalClosed,true)
        // 只有实际收到的同一对象有worker消费品牌；完整JSON克隆也不能签新的closed。
        assert.throws(()=>consumeReadersReply493(actor,structuredClone(seen)),{code:'GRANT_MISMATCH'})
      }else{await assert.rejects(request);assert.equal(consumed,0);assert.ok(original);assert.equal(Object.getPrototypeOf(original.binding),null);assert.deepEqual({...original.binding},binding)}
      await Promise.all([readersClosed493(owner),readersClosed493(utility),readersClosed493(main)]);assert.equal(actor.active,false)
    }finally{bridge.close();await Promise.all([readersClosed493(owner,true),readersClosed493(utility,true),readersClosed493(main,true)])}
  }
  t.diagnostic('真实Node端口/Utility relay/actor消费品牌组件；Main空资源受控回声不授实际Electron、Main2000ms或全C03资格。')
})
test('按库Main fence493：同SQLite原remove先running再等Main闭口，UNKNOWN与迟到closed保active且不重发原命令',async t=>{
  for(const mode of ['success','unknown','late'] as const){
    const f=await removalFactoryFixture463(t,{hold:true,...(mode==='unknown'?{failure:'UNKNOWN' as const}:mode==='late'?{failure:'TIMEOUT' as const}:{})})
    if(mode==='late')t.mock.timers.enable({apis:['Date','setTimeout'],now:Date.now()})
    try{
      const root=f.roots[0]!,commandId=randomUUID(),before=f.rows(),caches=f.candidates(),original={command:'library.remove' as const,request:{commandId,libraryIds:[root.id]}}
      let finished=false;const pending=f.manage('library.remove',original.request).then(value=>{finished=true;return value}),q=await f.readers493.first
      assert.equal(q.binding.commandId,commandId);assert.equal(q.binding.originalSha256,localLibraryManagementDigest(original));assert.equal(q.binding.libraryId,root.id);assert.equal(q.binding.datasetId,f.identity.datasetId);assert.equal(q.binding.ownerEpoch,f.epoch493)
      const operation=f.repository.localCatalog.privateLibraryManagementRead(f.identity,'operation',commandId)!;assert.equal(operation.record.revision,1);assert.equal(operation.record.receipt.state,'running')
      assert.equal(f.repository.localCatalog.privateLibraryManagementRead(f.identity,'binding',root.id)!.record.active,true);assert.equal(f.repository.localCatalog.privateLibraryManagementRootAvailable(root.id),false)
      assert.equal(finished,false);assert.equal(f.readers493.received.length,1);assert.deepEqual(f.rows(),before);assert.deepEqual(f.candidates(),caches)
      const running=await f.manage('library.operation.read',{commandId});assert.ok(running);assert.equal(running.state,'running');assert.equal((await f.manage('library.remove',original.request)).state,'running');assert.equal(f.readers493.received.length,1)
      if(mode==='late'){t.mock.timers.tick(2001);const unknown=await pending;assert.equal(unknown.state,'unknown');assert.equal(f.repository.localCatalog.privateLibraryManagementRead(f.identity,'binding',root.id)!.record.active,true);assert.equal(f.readers493.replies.length,0)}
      f.readers493.release();const receipt=await pending
      if(mode==='success'){assert.equal(receipt.state,'succeeded');assert.equal(f.repository.localCatalog.privateLibraryManagementRead(f.identity,'binding',root.id)!.record.active,false)}
      else{assert.equal(receipt.state,'unknown');assert.equal(f.repository.localCatalog.privateLibraryManagementRead(f.identity,'binding',root.id)!.record.active,true);assert.deepEqual(f.candidates(),caches)}
      const deadline=performance.now()+2000;while(!f.readers493.replies.length||!f.readers493.consumed.length){assert.ok(performance.now()<deadline);await new Promise<void>(resolve=>setImmediate(resolve))}
      const echoed=f.readers493.replies[0]!;assert.equal(f.readers493.consumed.length,1);assert.deepEqual(f.readers493.consumed[0],echoed);assertReadersReply493(echoed,q);assert.equal(echoed.ok,mode==='success');assert.equal(echoed.physicalClosed,mode!=='unknown');assert.equal(echoed.failure,mode==='success'?null:mode==='late'?'TIMEOUT':'UNKNOWN')
      assert.equal(f.repository.localCatalog.privateLibraryManagementRead(f.identity,'operation',commandId)!.record.revision,2);assert.equal(f.readers493.failures.length,0)
      const ledger=f.repository.localCatalog.privateRead(db=>db.prepare('SELECT * FROM local_catalog_ledger ORDER BY rowid').all())
      assert.deepEqual(await f.manage('library.operation.read',{commandId}),receipt);assert.deepEqual(await f.manage('library.remove',original.request),receipt);assert.equal(f.readers493.received.length,1)
      assert.deepEqual(f.repository.localCatalog.privateRead(db=>db.prepare('SELECT * FROM local_catalog_ledger ORDER BY rowid').all()),ledger)
      assert.equal(f.repository.localCatalog.privateLibraryManagementRead(f.identity,'binding',f.roots[1]!.id)!.record.active,true);assert.equal(f.repository.localCatalog.privateLibraryManagementRootAvailable(f.roots[1]!.id),true)
      for(const file of f.files)assert.deepEqual(await readFile(file.path),file.bytes);assert.equal(f.sourceSafetyCloses,0);assert.deepEqual(f.rows(),before)
    }finally{if(mode==='late')t.mock.timers.reset()}
  }
  t.diagnostic('同实际Domain/SQLite管理fence＋真实NodeActor端口；Main仅空资源受控producer，迟到窗口用原2000ms mock timer，不签完整Main两秒实测或全C03。')
})



import {Worker as SourceCloseWorker565} from 'node:worker_threads'
import {once as sourceCloseOnce565} from 'node:events'
import {open as sourceCloseOpen565,type FileHandle as SourceCloseHandle565} from 'node:fs/promises'
import {constants as sourceCloseFlags565} from 'node:fs'
import {createDatasetOwnerClient as createSourceCloseClient565} from '../src/collection/dataset-owner-client.js'
import {DatasetOwnerDispatchError as SourceCloseDispatchError565} from '../src/collection/dataset-owner-protocol.js'
import {openCollectionDataset as openSourceCloseDataset565} from '../src/recording/restore-dataset-runtime.js'
import {SOURCE_WRITES_OPERATION as SOURCE_CLOSE_OPERATION565,readSourceWritesEvent as readSourceCloseEvent565,sourceWritesLedgerRow as sourceClosingLedgerRow570} from '../src/collection/local-source-writes-journal.js'
import type {PublisherTarget as SourceCloseTarget565} from '../src/collection/source-writes-publisher.js'

async function sourceCloseDirectory565(){
  const temporary=process.env.TMPDIR
  assert.ok(temporary&&path.isAbsolute(temporary))
  if(process.platform==='darwin'&&process.env.GITHUB_ACTIONS!=='true')assert.ok(temporary.startsWith('/Volumes/LifeWeave/Developer/CommandLine/tmp/'))
  return await mkdtemp(path.join(temporary,'source-close565-'))
}
function sourceCloseReceive565():dto.CollectionReceiveRequest{
  return {commandId:randomUUID(),model:{brand:'关闭重核合成品牌',name:'原Owner型号',edition:'565合成版',year:1990,format:'cassette',tapeType:'II',identification:'verified'},
    lengthMinutes:90,quantities:{sealedBlank:1,openedBlank:0,legacyUsed:0,unclassified:0}}
}
/** 仅从测试自有库读取实际全部Source/catalog/scan表；不调用会改warm凭证的冷验证函数。 */
function sourceCloseTables565(file:string){
  const db=new DatabaseSync(file,{readOnly:true})
  try{
    db.exec('BEGIN')
    const names=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND (name LIKE 'source_%' OR name LIKE 'local_catalog_%' OR name LIKE 'local_scan_%') ORDER BY name").all()
    const value=Object.fromEntries(names.map(row=>{const name=String(row.name),quoted=name.replaceAll('"','""'),rows=db.prepare(`SELECT * FROM "${quoted}"`).all()
      return [name,rows.sort((left,right)=>JSON.stringify(left).localeCompare(JSON.stringify(right)))]}))
    db.exec('COMMIT');return value
  }finally{db.close()}
}
function sourceCloseLedger565(file:string){
  const db=new DatabaseSync(file,{readOnly:true})
  try{return db.prepare('SELECT rowid AS _ledger_rowid,* FROM local_catalog_ledger WHERE operation=? ORDER BY rowid').all(SOURCE_CLOSE_OPERATION565)}finally{db.close()}
}
function sourceCloseExternalUpdate565(file:string,modelId:string){
  const writer=new DatabaseSync(file)
  try{assert.equal(writer.prepare('UPDATE collection_models SET revision=revision+1 WHERE id=?').run(modelId).changes,1)}finally{writer.close()}
}
function sourceCloseFailureCodes565(error:unknown):string[]{
  if(error instanceof AggregateError)return error.errors.flatMap(sourceCloseFailureCodes565)
  if(error===null||typeof error!=='object')return []
  return ['code','issue'].flatMap(key=>{const value=Reflect.get(error,key);return typeof value==='string'?[value]:[]})
}

test('Source关闭重核565：另一连接无关collection提交后原Owner自然退出且Source原账不改',{concurrency:false},async t=>{
  const directory=await sourceCloseDirectory565(),file=path.join(directory,'collection.v1.sqlite'),raw:unknown[]=[],fatals:string[]=[]
  const worker=new SourceCloseWorker565(new URL('./helpers/dataset-owner-version-fixture.ts',import.meta.url),{execArgv:['--import','tsx'],workerData:{dataDirectory:directory}})
  worker.on('message',message=>raw.push(message))
  const naturalExit=sourceCloseOnce565(worker,'exit'),endpoint=createSourceCloseClient565({worker,onFatal:reason=>fatals.push(reason)})
  // 仅失败清理可强制终结本例自有线程；通过断言必须来自原ACK+实际exit0，不能用terminate签静止。
  t.after(async()=>{if(worker.threadId!==-1){const exitCode=await worker.terminate();t.diagnostic(`565失败清理：explicit terminate exit=${exitCode}，不授natural/quiet。`)}})
  const identity=await endpoint.prepare();await endpoint.commitBoot()
  const received=await endpoint.dispatch({version:1,id:randomUUID(),command:'collection.receive',payload:sourceCloseReceive565(),expectedDatasetId:identity.datasetId}) as dto.CollectionMutationResult
  const policyRequest:dto.SetLocalSourceWritesPolicy={datasetId:identity.datasetId,commandId:randomUUID(),expectedPolicyRevision:'1',enabled:false}
  const policy=await endpoint.dispatch({version:1,id:randomUUID(),command:'localSourceWrites.setPolicy',payload:policyRequest,expectedDatasetId:identity.datasetId}) as dto.LocalSourceWritesReceipt
  assert.equal(policy.outcome,'accepted');assert.equal(policy.policy?.enabled,false)
  const before=sourceCloseTables565(file),ledger=sourceCloseLedger565(file)
  assert.ok(ledger.length>0);for(const row of ledger)readSourceCloseEvent565(row)
  const version=await endpoint.getCollectionSnapshotVersion(),snapshot=await endpoint.exportVersionedCollectionSnapshot();assert.deepEqual(snapshot.version,version)
  sourceCloseExternalUpdate565(file,received.modelId)
  const next=await endpoint.getCollectionSnapshotVersion();assert.notEqual(next.revision,version.revision)
  const updated=await endpoint.exportVersionedCollectionSnapshot();assert.deepEqual(updated.version,next);assert.equal(updated.snapshot.models.find(model=>model.id===received.modelId)?.revision,2)
  // 只让关闭晚期重核；普通warm Source入口仍须拒绝已变的全连接凭证，不能把本例修成普遍放宽。
  await assert.rejects(endpoint.dispatch({version:1,id:randomUUID(),command:'localSourceWrites.get',
    payload:{datasetId:identity.datasetId,selector:{kind:'context',target:null}},expectedDatasetId:identity.datasetId}),
    error=>error instanceof SourceCloseDispatchError565&&error.failure.error.code==='INVENTORY_UNAVAILABLE')
  assert.deepEqual(sourceCloseTables565(file),before)
  const closing=endpoint.close();assert.equal(endpoint.close(),closing);await closing
  assert.deepEqual(await naturalExit,[0]);assert.equal(worker.threadId,-1);assert.deepEqual(fatals,[])
  const closeReplies=raw.filter((value):value is {type:string;operation:string;ok:boolean;result?:unknown}=>!!value&&typeof value==='object'&&Reflect.get(value,'type')==='response'&&Reflect.get(value,'operation')==='close')
  assert.equal(closeReplies.length,1);assert.equal(closeReplies[0]!.ok,true);assert.equal(closeReplies[0]!.result,undefined)
  assert.deepEqual(sourceCloseTables565(file),before);assert.deepEqual(sourceCloseLedger565(file),ledger)
  const read=new DatabaseSync(file,{readOnly:true})
  try{assert.equal(read.prepare('SELECT revision FROM collection_models WHERE id=?').get(received.modelId)?.revision,2)}finally{read.close()}
  await writeFile(path.join(directory,'close565-evidence.json'),JSON.stringify({kind:'ACTUAL_OWNER_WORKER_SOURCE_CLOSE_AFTER_UNRELATED_SQL',datasetId:identity.datasetId,
    sourceQualified:false,sourceRowsUnchanged:true,sourceEvents:ledger.length,ordinaryWarmSourceStillRefused:true,naturalExit:0,closeReplyCount:closeReplies.length,fatals,
    fullMainOrNativeProof:false},null,2)+'\n',{flag:'wx',mode:0o600})
  t.diagnostic(`565原Owner/Client/同两SQL/外部提交与natural exit0；证据保留 ${directory}。未授Native/Main2000ms或正式Source准入。`)
})

/** 真实默认两库+原持久identity组合；没有Fake Owner/provider/join回调。 */
async function sourceCloseDomain565(){
  const directory=await sourceCloseDirectory565(),dataset=await openSourceCloseDataset565(directory),epoch=randomUUID()
  const identity={datasetId:dataset.datasetId,assertCurrent:dataset.assertIdentity}
  const domain=createDatasetDomain({collectionRepository:dataset.repository,backupWorkflowStore:dataset.store,collectionDatasetIdentity:identity,localSourceEpoch:epoch,
    commitBoot:dataset.commit,closeConnections(){dataset.fail();dataset.close()}})
  await domain.localSourceWrites.prepareRecoveryProtection();await domain.localRelocationPlans.prepareRecoveryProtection();await domain.prepareWorkbench();await domain.commitBoot()
  const received=await domain.dispatch({version:1,id:randomUUID(),command:'collection.receive',payload:sourceCloseReceive565(),expectedDatasetId:dataset.datasetId}) as dto.CollectionMutationResult
  const request:dto.SetLocalSourceWritesPolicy={datasetId:dataset.datasetId,commandId:randomUUID(),expectedPolicyRevision:'1',enabled:false}
  const policy=domain.localSourceWrites.setPolicy(request);assert.equal(policy.outcome,'accepted')
  return {directory,dataset,domain,identity,request,received,safety:domain.localSourceWrites.privateLyricsSafety().sourceSafety}
}
test('Source关闭重核565：坏Source账本与未解SourceSafety实际FD均拒绝并保留原材料',{concurrency:false},async t=>{
  for(const mode of ['bad-ledger','held-safety-fd'] as const){
    const f=await sourceCloseDomain565();let fd:SourceCloseHandle565|undefined,reservation:Awaited<ReturnType<typeof f.safety.reserveLyrics>>|undefined
    const evidence=path.join(f.directory,'原保全材料565.txt'),body=Buffer.from('565原材料不删除，不重签关闭\n');await writeFile(evidence,body,{flag:'wx',mode:0o600})
    try{
      if(mode==='bad-ledger'){
        const original=sourceCloseLedger565(f.dataset.databaseFile);assert.equal(original.length,1);readSourceCloseEvent565(original[0]!)
        const writer=new DatabaseSync(f.dataset.databaseFile)
        try{
          const trigger=writer.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND name='local_catalog_ledger_no_update' AND tbl_name='local_catalog_ledger'").get()
          assert.ok(trigger&&typeof trigger.name==='string'&&typeof trigger.sql==='string')
          const triggerName=trigger.name,triggerSql=trigger.sql
          const update=()=>writer.prepare('UPDATE local_catalog_ledger SET fingerprint=? WHERE operation=? AND command_id=?').run('0'.repeat(64),SOURCE_CLOSE_OPERATION565,f.request.commandId)
          // 普通写先证明原append-only触发器仍有效；随后仅在本例自有SQL明确注入损坏，不冒充normal write。
          assert.throws(update,/本地目录历史不可改写/u)
          writer.exec('BEGIN IMMEDIATE')
          try{
            writer.exec(`DROP TRIGGER "${triggerName.replaceAll('"','""')}"`)
            assert.equal(update().changes,1)
            writer.exec(triggerSql);writer.exec('COMMIT')
          }catch(error){writer.exec('ROLLBACK');throw error}
          assert.deepEqual(writer.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND name='local_catalog_ledger_no_update'").get(),trigger)
        }finally{writer.close()}
        const broken=sourceCloseLedger565(f.dataset.databaseFile);assert.equal(broken.length,1)
        assert.deepEqual(broken.map(row=>({...row})),[{...original[0]!,fingerprint:'0'.repeat(64)}])
        assert.throws(()=>readSourceCloseEvent565(broken[0]!),{code:'RECOVERY_REQUIRED'})
      }else{
        const source=path.join(f.directory,'自有歌词来源565');await mkdir(source,{mode:0o700})
        const root=f.domain.collection.sources.authorize(randomUUID(),await authorizeSourceDirectory(source)),target:SourceCloseTarget565={operationId:randomUUID(),root,
          libraryRootPath:source,relative:'原歌词565.lrc',expected:null,attributes:null,change:null,replacementBytes:Buffer.from('[00:00.00]合成歌词565\n')}
        reservation=await f.safety.reserveLyrics([target],4096)
        const protectedFile=path.join(reservation.directory,'565未解保护原材料');await writeFile(protectedFile,body,{flag:'wx',mode:0o600})
        fd=await sourceCloseOpen565(protectedFile,sourceCloseFlags565.O_RDONLY|sourceCloseFlags565.O_NOFOLLOW);assert.ok(fd.fd>=0);await fd.stat()
        sourceCloseExternalUpdate565(f.dataset.databaseFile,f.received.modelId)
        const catalog=f.domain.collection.localCatalog,ordinaryWarm=()=>catalog.privateSourceWritesRead(()=>true),beforeClosingRead=sourceCloseTables565(f.dataset.databaseFile),
          expected=sourceCloseLedger565(f.dataset.databaseFile).map(({_ledger_rowid,...row})=>row),readStamp=f.domain.collection.readonlySnapshotStamp()
        assert.throws(ordinaryWarm,{code:'INVENTORY_UNAVAILABLE'})
        let judged=false
        const recoveryRequired=catalog.privateSourceWritesClosingRead(f.identity,projection=>{
          assert.deepEqual(projection.events.map(sourceClosingLedgerRow570),expected);judged=true;return false
        })
        assert.equal(judged,true);assert.equal(recoveryRequired,false)
        // 同一个原identity的专用只读核验成功后，普通warm仍应拒绝；不能升新cold凭证给五缓存普通入口。
        assert.throws(ordinaryWarm,{code:'INVENTORY_UNAVAILABLE'})
        assert.deepEqual(f.domain.collection.readonlySnapshotStamp(),readStamp);assert.deepEqual(sourceCloseTables565(f.dataset.databaseFile),beforeClosingRead)
        assert.ok(fd.fd>=0);await fd.stat()
      }
      const before=sourceCloseTables565(f.dataset.databaseFile),ledger=sourceCloseLedger565(f.dataset.databaseFile),stamp=f.domain.collection.readonlySnapshotStamp()
      const closing=f.domain.close();assert.equal(f.domain.close(),closing)
      await assert.rejects(closing,error=>sourceCloseFailureCodes565(error).some(code=>mode==='bad-ledger'?['RECOVERY_REQUIRED','INVENTORY_UNAVAILABLE'].includes(code):code==='RELEASE_UNKNOWN'))
      assert.doesNotThrow(()=>f.dataset.assertIdentity());assert.deepEqual(f.domain.collection.readonlySnapshotStamp(),stamp)
      assert.deepEqual(sourceCloseTables565(f.dataset.databaseFile),before);assert.deepEqual(sourceCloseLedger565(f.dataset.databaseFile),ledger);assert.deepEqual(await readFile(evidence),body)
      if(fd){assert.ok(fd.fd>=0);await fd.stat();assert.deepEqual(await readFile(path.join(reservation!.directory,'565未解保护原材料')),body)
        // 原消费者只在拒绝证据之后释放自有FD/预留；不能让晚释放把同原close改为成功。
        await fd.close();await assert.rejects(fd.stat(),{code:'EBADF'});reservation!.release()
      }
      assert.equal(f.domain.close(),closing);await assert.rejects(f.domain.close());assert.doesNotThrow(()=>f.dataset.assertIdentity())
      assert.deepEqual(sourceCloseTables565(f.dataset.databaseFile),before);assert.deepEqual(sourceCloseLedger565(f.dataset.databaseFile),ledger)
      await writeFile(path.join(f.directory,'close565-refused-'+mode+'.json'),JSON.stringify({kind:'ACTUAL_SQL_SOURCE_CLOSE_REFUSED',mode,datasetId:f.dataset.datasetId,
        sourceQualified:false,productionClose:'REFUSED',sourceRowsUnchanged:true,originalCloseRetained:true,naturalExit:'NOT_APPLICABLE_DIRECT_DOMAIN',
        protectedMaterialPreserved:true,physicalFdStayedOpenAtRefusal:mode==='held-safety-fd',fullMainOrNativeProof:false},null,2)+'\n',{flag:'wx',mode:0o600})
    }finally{
      // 仅测试结束清理自有句柄/连接；不删除材料，不调用新关闭承诺，不授production quiet。
      if(fd&&fd.fd>=0)await fd.close();reservation?.release();f.dataset.fail();f.dataset.close()
    }
    t.diagnostic(`565 ${mode} 真实两SQL/原Source账/共享Safety：productionClose拒绝，原材料保留 ${f.directory}；清理不计关闭成功。`)
  }
})

test('CD01角色候选：真实DatasetIdentity同SQL四角色绑定冷读保持旧记录并拒未知角色', async t => {
  const temp=process.env.TMPDIR
  assert.ok(temp?.startsWith('/Volumes/LifeWeave/Developer/CommandLine/'))
  const directory=await mkdtemp(path.join(temp!,'cd01-role-'))
  await mkdir(path.join(directory,'staging'),{mode:0o700})
  const file=path.join(directory,'collection.v1.sqlite')
  const state=createBackupWorkflowStore({filePath:path.join(directory,'backup-maintenance.v1.sqlite')})
  let repository=createCollectionRepository({filePath:file,stagingRoot:path.join(directory,'staging')})
  t.after(()=>{try{repository.close()}finally{state.close()}})
  repository.localCatalog.roots()
  let identity=state.datasetIdentities.bind('default',file,true)
  repository.localCatalog.privateBindWorkbenchDataset(identity)
  const expected:LocalLibraryManagementBindingRecord[]=[]
  for(const rawRole of ['catalog','artist','album','container'] as const){
    const sourcePath=path.join(directory,rawRole)
    await mkdir(sourcePath,{mode:0o700})
    const source=repository.sources.authorize(randomUUID(),await authorizeSourceDirectory(sourcePath))
    const root=repository.localCatalog.registerRoot({commandId:randomUUID(),sourceRootId:source.id,role:'library'})
    assert.equal(root.role,'library','目录组织角色不得改写原Source/recording分类')
    const request:unknown={commandId:randomUUID(),choiceId:randomUUID(),role:rawRole}
    assert.ok(dto.isLocalLibraryManagementPayload('library.import.confirm',request),'四个有限用户角色必须经原公开payload守卫')
    const original:LocalLibraryManagementOperationRecord['original']={command:'library.import.confirm',request}
    const operation:LocalLibraryManagementOperationRecord={schema:1,kind:'operation',datasetId:identity.datasetId,key:request.commandId,
      revision:1,original,originalSha256:localLibraryManagementDigest(original),
      receipt:{commandId:request.commandId,kind:'library.import.confirm',state:'succeeded',libraryIds:[root.id],message:null}}
    const record:LocalLibraryManagementBindingRecord={schema:1,kind:'binding',datasetId:identity.datasetId,key:root.id,revision:1,
      libraryId:root.id,sourceRootId:source.id,rootRevision:root.revision,role:request.role,name:'角色合成库'+rawRole,
      active:true,watchEnabled:false,operationId:operation.key}
    repository.localCatalog.privateLibraryManagementCompareAndSwap(identity,[{record,expectedRevision:null},{record:operation,expectedRevision:null}])
    expected.push(record)
    repository.close()
    repository=createCollectionRepository({filePath:file,stagingRoot:path.join(directory,'staging')})
    repository.localCatalog.roots()
    const coldIdentity=state.datasetIdentities.bind('default',file,false)
    assert.equal(coldIdentity.datasetId,identity.datasetId,'冷读不得铸造另一作者替代原身份')
    repository.localCatalog.privateBindWorkbenchDataset(coldIdentity)
    identity=coldIdentity
    for(const before of expected){
      const saved=repository.localCatalog.privateLibraryManagementRead(coldIdentity,'binding',before.key)
      assert.ok(saved)
      assert.deepEqual(saved.record,before)
      assert.equal(repository.localCatalog.root(before.libraryId).role,'library')
      assert.equal(repository.sources.root(before.sourceRootId).authorized,true)
    }
    assert.deepEqual(repository.localCatalog.privateLibraryManagementRead(coldIdentity,'operation',operation.key)?.record,operation)
    const ledgerBefore=repository.localCatalog.privateRead(db=>db.prepare('SELECT * FROM local_catalog_ledger ORDER BY rowid').all())
    for(const role of ['library','singer','Artist','',null]){
      assert.equal(dto.isLocalLibraryManagementPayload('library.import.confirm',{commandId:randomUUID(),choiceId:randomUUID(),role}),false)
      assert.throws(()=>captureLocalLibraryManagementRecord({...record,role}))
    }
    assert.deepEqual(repository.localCatalog.privateRead(db=>db.prepare('SELECT * FROM local_catalog_ledger ORDER BY rowid').all()),ledgerBefore)
  }
})

test('CD01 FD结构守卫：完整回显核原根与两层闭集，重复键及伪闭口拒绝且JSON不授Native品牌',async t=>{
  const {constants}=await import('node:fs'),{open}=await import('node:fs/promises')
  const probe=await import('../src/library/fsevents-library-monitor.js')
  const temp=process.env.TMPDIR;assert.ok(temp?.startsWith('/Volumes/LifeWeave/Developer/CommandLine/'))
  const directory=await mkdtemp(path.join(temp!,'cd01-fd-parser-')),child=path.join(directory,'专辑甲');await mkdir(child,{mode:0o700})
  const rootFd=await open(directory,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW),childFd=await open(child,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW)
  t.after(async()=>{await childFd.close();await assert.rejects(childFd.stat(),{code:'EBADF'});await rootFd.close();await assert.rejects(rootFd.stat(),{code:'EBADF'})})
  const fields=['dev','ino','birthtimeNs','mode','uid','gid'] as const
  const physical=(value:import('node:fs').BigIntStats)=>Object.fromEntries(fields.map(key=>[key,String(value[key])])) as unknown as import('../src/library/fsevents-library-monitor.js').LibraryDirectoryPhysical
  const original=physical(await rootFd.stat({bigint:true})),childPhysical=physical(await childFd.stat({bigint:true}))
  const value:import('../src/library/fsevents-library-monitor.js').LibraryDirectoryStructureFacts={schema:'musicbridge.directory-structure.fd.v1',bounds:{depth:2,entries:256,childFds:12},root:original,
    directories:[{...original,relative:'',entries:[{name:'专辑甲',kind:'directory'}]},{...childPhysical,relative:'专辑甲',entries:[{name:'曲目.wav',kind:'file'}]}],
    entriesRead:2,childDirectoriesOpened:1,bounded:false,physicalClosed:{inputFd:true,duplicateRootFd:true,childDirectoryFds:true,directoryStreams:true}}
  const raw=(input:unknown)=>Buffer.from(JSON.stringify(input)+'\n')
  assert.equal(JSON.stringify(probe.readLibraryDirectoryStructureBytes(raw(value),original)),JSON.stringify(value))
  const mutations:Array<(input:Record<string,unknown>)=>void>=[
    input=>{input.root={...original,ino:String(BigInt(original.ino)+1n)}},
    input=>{input.entriesRead=3},input=>{input.childDirectoriesOpened=2},input=>{input.extra=true},input=>{input.bounded=true},
    input=>{input.physicalClosed={...value.physicalClosed,childDirectoryFds:false}},
    input=>{input.directories=[value.directories[0],{...value.directories[1],relative:'未知父/专辑甲'}]},
    input=>{input.directories=[value.directories[0],{...value.directories[1],relative:'专辑甲/更深/目录'}]},
    input=>{input.directories=[{...value.directories[0],entries:[{name:'专辑甲',kind:'symlink'}]},value.directories[1]]},
    input=>{input.directories=[{...value.directories[0],entries:[{name:'../专辑甲',kind:'directory'}]},value.directories[1]]},
  ]
  for(const mutate of mutations){const input=structuredClone(value) as unknown as Record<string,unknown>;mutate(input);assert.throws(()=>probe.readLibraryDirectoryStructureBytes(raw(input),original))}
  const duplicate=Buffer.from(JSON.stringify(value).replace('"entriesRead":2','"entriesRead":2,"entriesRead":2')+'\n')
  assert.throws(()=>probe.readLibraryDirectoryStructureBytes(duplicate,original));assert.throws(()=>probe.readLibraryDirectoryStructureBytes(Buffer.concat([raw(value),raw(value)]),original))
  assert.throws(()=>probe.readLibraryDirectoryStructureBytes(Buffer.alloc(65537,32),original))
  let assertions=0
  await assert.rejects(probe.probeLibraryDirectoryStructure({root:directory,manifestSha256:'0'.repeat(64),programSha256:'0'.repeat(64),programBytes:1},
    {root:rootFd,signal:new AbortController().signal,deadlineAtMs:performance.now()+2000,assertCurrent(){assertions++}}),
    error=>error instanceof probe.LibraryDirectoryProbeError&&error.physicalClosed===true&&error.raw===null)
  assert.equal(assertions,0);assert.deepEqual(physical(await rootFd.stat({bigint:true})),original)
  t.diagnostic('本例只验证纯回显守卫与未品牌对象的启动拒绝；夹具JSON的关闭字段不是Native运行证明。')
})

test('CD01真实目录：已取消选择零登记，同原Main FD注册仅有界建议且撤销实际闭口，未安装后端保持手动OPEN',{timeout:30_000},async t=>{
  const {constants}=await import('node:fs'),fs=await import('node:fs/promises'),{MessageChannel}=await import('node:worker_threads')
  const authority=await import('../src/collection/source-writes-authority.js'),probe=await import('../src/library/fsevents-library-monitor.js')
  const {createCueSyntheticWave}=await import('../src/library/local-cue-format-qualification.js')
  const temp=process.env.TMPDIR;assert.ok(temp?.startsWith('/Volumes/LifeWeave/Developer/CommandLine/'))
  const directory=await mkdtemp(path.join(temp!,'cd01-directory-')),media=path.join(directory,'自有歌手'),album=path.join(media,'专辑甲'),outside=path.join(directory,'不在批准根')
  await mkdir(album,{recursive:true,mode:0o700});await mkdir(outside,{mode:0o700})
  const bytes=createCueSyntheticWave(4800).wave;await writeFile(path.join(album,'01.wav'),bytes,{flag:'wx',mode:0o600});await writeFile(path.join(outside,'外部.wav'),bytes,{flag:'wx',mode:0o600})
  await fs.symlink(outside,path.join(media,'不跟随的符号链'))
  const file=path.join(directory,'collection.v1.sqlite'),repository=createCollectionRepository({filePath:file}),state=createBackupWorkflowStore({filePath:path.join(directory,'backup-maintenance.v1.sqlite')})
  repository.localCatalog.roots();const identity=state.datasetIdentities.bind('default',file,true),epoch=randomUUID(),channel=new MessageChannel(),actor=authority.createSourceWritesMainActor(channel.port1)
  const choicePaths=new Map<string,string>(),extraMainFds:import('node:fs/promises').FileHandle[]=[]
  const failures:unknown[]=[],tasks=new Set<Promise<void>>(),closedPorts=new Set<import('node:worker_threads').MessagePort>()
  channel.port1.on('close',()=>closedPorts.add(channel.port1));channel.port2.on('close',()=>closedPorts.add(channel.port2))
  let requests=0,mainFd:import('node:fs/promises').FileHandle|undefined,prepared:ReturnType<typeof createDatasetDomain>|undefined
  const currentMainFd=():import('node:fs/promises').FileHandle|undefined=>mainFd
  const physicalKeys=['dev','ino','birthtimeNs','mode','uid','gid'] as const
  channel.port2.on('message',raw=>{const work=(async()=>{
    const request=authority.captureSourceWorkbenchDirectoryRequest(raw);requests++
    assert.equal(request.binding.datasetId,identity.datasetId);assert.equal(request.binding.ownerEpoch,epoch);assert.equal(request.binding.childGeneration,1)
    assert.equal(request.binding.kind,'library');assert.equal(request.ui.family,'management');assert.equal(request.ui.command,'library.import.prepare');assert.equal(request.command,'approve')
    assert.ok(Date.now()<request.expiresAtMs);assert.ok(Date.now()<request.binding.expiresAtMs)
    const chosen=choicePaths.get(request.binding.choiceId);assert.ok(chosen,'只批准本夹具的明确选择，不从RPC正文取路径')
    const acquired=await fs.open(chosen,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);if(chosen===media){assert.equal(mainFd,undefined);mainFd=acquired}else extraMainFds.push(acquired)
    const held=await acquired.stat({bigint:true}),named=await fs.lstat(chosen,{bigint:true});assert.equal(await fs.realpath(chosen),chosen);assert.ok(held.isDirectory()&&!named.isSymbolicLink())
    assert.ok(physicalKeys.every(key=>held[key]===named[key]));assert.ok(Date.now()<request.expiresAtMs)
    const physical=authority.captureSourceWorkbenchDirectoryPhysical({path:chosen,...Object.fromEntries(physicalKeys.map(key=>[key,String(held[key])]))})
    const reply=authority.captureSourceWorkbenchDirectoryReply({version:1,type:'workbench-directory-reply',purpose:'WORKBENCH_DIRECTORY',requestId:request.requestId,
      sequence:request.sequence,authorityId:request.authorityId,command:request.command,binding:request.binding,ui:request.ui,requestSha256:lyricsPhysicalDigest(request),
      decision:'approved',nonce:randomUUID(),validUntilMs:Math.min(request.expiresAtMs,request.binding.expiresAtMs),physical})
    authority.assertSourceWorkbenchDirectoryReplyForRequest(reply,request);channel.port2.postMessage(reply)
  })();tasks.add(work);void work.catch(error=>failures.push(error)).finally(()=>tasks.delete(work))})
  const closePort=async(port:import('node:worker_threads').MessagePort)=>{if(closedPorts.has(port))return;const done=new Promise<void>(resolve=>port.once('close',()=>resolve()));port.close();await done}
  t.after(async()=>{try{await prepared?.close()}finally{await Promise.allSettled([...tasks]);if(mainFd){await mainFd.close();await assert.rejects(mainFd.stat(),{code:'EBADF'})}
    for(const fd of extraMainFds){await fd.close();await assert.rejects(fd.stat(),{code:'EBADF'})}
    await closePort(channel.port1);await closePort(channel.port2);if(!prepared){repository.close();state.close()}}})
  const bundleRoot=process.env.MB_V39_WATCH_BUNDLE
  let native:import('../src/collection/dataset-owner-protocol.js').DatasetWorkbenchNativeConfiguration|undefined
  if(bundleRoot){assert.equal(process.platform,'darwin');assert.ok(path.isAbsolute(bundleRoot));const manifest=await readFile(path.join(bundleRoot,'manifest.json'));assert.ok(manifest.length<=65536)
    const manifestSha256=createHash('sha256').update(manifest).digest('hex'),bundle=await probe.loadLibraryWatchBundle(bundleRoot,manifestSha256)
    const rootFd=await fs.open(media,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW)
    try{const initial=await rootFd.stat({bigint:true}),result=await probe.probeLibraryDirectoryStructure(bundle,{root:rootFd,signal:new AbortController().signal,deadlineAtMs:performance.now()+2000,
      async assertCurrent(){const held=await rootFd.stat({bigint:true}),named=await fs.lstat(media,{bigint:true});assert.ok(physicalKeys.every(key=>held[key]===initial[key]&&held[key]===named[key]))}})
      assert.equal(result.raw.exitCode,0);assert.equal(result.raw.signal,null);assert.equal(result.raw.pidClosed,true);assert.equal(result.raw.stderr.length,0);assert.equal(result.raw.overflow,null)
      assert.equal(result.facts.bounded,false);assert.ok(result.facts.directories.some(row=>row.relative==='专辑甲'&&row.entries.some(entry=>entry.name==='01.wav'&&entry.kind==='file')))
      assert.ok(result.facts.directories[0]!.entries.some(entry=>entry.name==='不跟随的符号链'&&entry.kind==='symlink'));assert.ok(result.facts.directories.every(row=>!row.relative.includes('不跟随的符号链')&&!row.entries.some(entry=>entry.name==='外部.wav')))
      await writeFile(path.join(directory,'native-probe.stdout.log'),result.raw.stdout,{flag:'wx',mode:0o600});await writeFile(path.join(directory,'native-probe.stderr.log'),result.raw.stderr,{flag:'wx',mode:0o600})
      await writeFile(path.join(directory,'native-probe.json'),JSON.stringify({...result.raw,stdout:{bytes:result.raw.stdout.length,sha256:createHash('sha256').update(result.raw.stdout).digest('hex')},stderr:{bytes:result.raw.stderr.length,sha256:createHash('sha256').update(result.raw.stderr).digest('hex')},facts:result.facts,sourceQualified:false},null,2)+'\n',{flag:'wx',mode:0o600})
    }finally{await rootFd.close();await assert.rejects(rootFd.stat(),{code:'EBADF'})}
    native={cue:null,tags:null,watch:{root:bundleRoot,manifestSha256}}
  }
  prepared=createDatasetDomain({collectionRepository:repository,backupWorkflowStore:state,collectionDatasetIdentity:identity,localSourceEpoch:epoch,sourceWritesMainActor:actor,...(native?{localWorkbenchNative:native}:{})})
  await prepared.prepareWorkbench()
  const at=Date.now(),binding=authority.captureSourceWorkbenchDirectoryBinding({datasetId:identity.datasetId,ownerEpoch:epoch,childGeneration:1,kind:'library',choiceId:randomUUID(),revision:lyricsPhysicalDigest(['CD01',media,at]),issuedAtMs:at,expiresAtMs:at+600000,
    originalUi:authority.captureSourceWorkbenchDirectoryUi({family:'management',command:'library.import.prepare',commandId:null,requestSha256:lyricsPhysicalDigest({command:'library.import.prepare',payload:{}})})})
  choicePaths.set(binding.choiceId,media)
  const cancelled=new AbortController();cancelled.abort()
  await assert.rejects(prepared.registerWorkbenchDirectory(binding,{identity:{datasetId:identity.datasetId,epoch},mainActor:actor,signal:cancelled.signal,deadlineAtMs:performance.now()+2000}))
  assert.equal(requests,0);assert.equal(mainFd,undefined);assert.deepEqual(repository.localCatalog.roots(),[]);assert.deepEqual(repository.sources.roots(),[])
  const registration=await prepared.registerWorkbenchDirectory(binding,{identity:{datasetId:identity.datasetId,epoch},mainActor:actor,signal:new AbortController().signal,deadlineAtMs:performance.now()+2000})
  assert.equal(registration.kind,'library');assert.equal(requests,1);assert.deepEqual(failures,[]);const heldMain=currentMainFd();assert.ok(heldMain);await heldMain.stat()
  if(registration.kind!=='library')assert.fail('必须返回本次原library选择')
  const choice=registration.choice;assert.equal(choice.choiceId,binding.choiceId)
  if(native||process.platform==='linux')assert.equal(choice.suggestedRole,'artist')
  else{assert.equal(choice.suggestedRole,'catalog');assert.ok(choice.evidence.some(value=>value.includes('本次未作结构推断')))}
  assert.deepEqual(repository.localCatalog.roots(),[]);assert.deepEqual(repository.sources.roots(),[])
  const revoked=await prepared.revokeWorkbenchDirectory(binding,{identity:{datasetId:identity.datasetId,epoch},mainActor:actor,signal:new AbortController().signal,deadlineAtMs:performance.now()+2000})
  assert.deepEqual(revoked,{choiceId:binding.choiceId,revision:binding.revision,revoked:true,physicalClosed:true})
  await assert.rejects(prepared.registerWorkbenchDirectory(binding,{identity:{datasetId:identity.datasetId,epoch},mainActor:actor,signal:new AbortController().signal,deadlineAtMs:performance.now()+2000}));assert.equal(requests,1)
  if(native){
    const large=path.join(directory,'达到条目预算');await mkdir(large,{mode:0o700})
    for(let index=0;index<257;index++)await writeFile(path.join(large,String(index).padStart(3,'0')+'.wav'),bytes,{flag:'wx',mode:0o600})
    const bundle=await probe.loadLibraryWatchBundle(native.watch!.root,native.watch!.manifestSha256),fd=await fs.open(large,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW)
    const rejectedRaw:import('../src/library/fsevents-library-monitor.js').LibraryDirectoryProbeRaw[]=[]
    try{
      await assert.rejects(probe.probeLibraryDirectoryStructure(bundle,{root:fd,signal:new AbortController().signal,deadlineAtMs:performance.now()+2000,
        async assertCurrent(){identity.assertCurrent();const held=await fd.stat({bigint:true}),named=await fs.lstat(large,{bigint:true});assert.ok(physicalKeys.every(key=>held[key]===named[key]))}}),
        error=>{assert.ok(error instanceof probe.LibraryDirectoryProbeError);assert.equal(error.physicalClosed,true);assert.ok(error.raw)
          assert.equal(error.raw.exitCode,2);assert.equal(error.raw.signal,null);assert.equal(error.raw.pidClosed,true);assert.equal(error.raw.overflow,null);assert.equal(error.raw.stdout.length,0)
          assert.deepEqual(error.raw.stderr,Buffer.from('STRUCTURE_PROBE_ENTRY_BUDGET\n'));rejectedRaw.push(error.raw);return true})
      assert.equal(rejectedRaw.length,1);const rejected=rejectedRaw[0]!
      await writeFile(path.join(directory,'native-budget.stdout.log'),rejected.stdout,{flag:'wx',mode:0o600});await writeFile(path.join(directory,'native-budget.stderr.log'),rejected.stderr,{flag:'wx',mode:0o600})
      await writeFile(path.join(directory,'native-budget.json'),JSON.stringify({...rejected,stdout:{bytes:rejected.stdout.length,sha256:createHash('sha256').update(rejected.stdout).digest('hex')},stderr:{bytes:rejected.stderr.length,sha256:createHash('sha256').update(rejected.stderr).digest('hex')},nativeSuccess:false,sourceQualified:false},null,2)+'\n',{flag:'wx',mode:0o600})
    }finally{await fd.close();await assert.rejects(fd.stat(),{code:'EBADF'})}
    const largeAt=Date.now(),largeBinding=authority.captureSourceWorkbenchDirectoryBinding({...binding,choiceId:randomUUID(),revision:lyricsPhysicalDigest(['CD01',large,largeAt]),issuedAtMs:largeAt,expiresAtMs:largeAt+600000})
    choicePaths.set(largeBinding.choiceId,large)
    const manual=await prepared.registerWorkbenchDirectory(largeBinding,{identity:{datasetId:identity.datasetId,epoch},mainActor:actor,signal:new AbortController().signal,deadlineAtMs:performance.now()+2000})
    assert.equal(manual.kind,'library');if(manual.kind!=='library')assert.fail('大根只能返回本次library选择')
    assert.equal(manual.choice.suggestedRole,'catalog');assert.ok(manual.choice.evidence.some(value=>value.includes('未形成结构建议')));assert.equal(requests,2)
    assert.deepEqual(repository.localCatalog.roots(),[]);assert.deepEqual(repository.sources.roots(),[]);assert.deepEqual(failures,[])
    const closed=await prepared.revokeWorkbenchDirectory(largeBinding,{identity:{datasetId:identity.datasetId,epoch},mainActor:actor,signal:new AbortController().signal,deadlineAtMs:performance.now()+2000})
    assert.equal(closed.physicalClosed,true)
  }
  assert.deepEqual(await readFile(path.join(album,'01.wav')),bytes);assert.deepEqual(await readFile(path.join(outside,'外部.wav')),bytes)
  t.diagnostic(`实际默认Domain/MessageChannel/两个独立held根FD；只受控Node目录批准，不冒Electron UI或Source写许可。${native?'已消费Root指定当代Native；完整raw保留 '+directory:'未提供Native时仅手动或Linux FD路径组件；不授darwin结构完成。'}`)
})


// 使用本叶自有SQLite的完整原事实；只检验full-v1协议，不授DefaultOwner/Main/Native或性能资格。
test('Library full-v1大于1.3MB合法整件多chunk无别名回读，完整语义重签坏帧与旧修订仍拒绝',async t=>{
  const journal=await import('../src/collection/local-library-workbench/owner-journal.js')
  const {createLocalAlbumOwnerService}=await import('../src/collection/local-album-browser/owner-port.js')
  const {sourceRootAvailability}=await import('../src/recording/source-files.js')
  const f=await managementFixture(t,{albums:2,tracks:100}),catalog=f.catalog,tracks=catalog.queryTracks({rootId:f.root.id,query:'',offset:0,limit:200}).items
  assert.equal(tracks.length,200)
  for(const item of tracks)catalog.observeMetadata({commandId:randomUUID(),trackId:item.track.id,source:'synthetic',parserVersion:'full-v1-canonical514/synthetic',
    fields:{title:'题'.repeat(400),artist:'艺'.repeat(400),album:'专'.repeat(400)}})
  const roots=async()=>[{root:catalog.root(f.root.id),label:f.source.label,availability:await sourceRootAvailability(f.repository.sources.root(f.source.id))}]
  const albums=createLocalAlbumOwnerService({repository:f.repository,assertCurrent:()=>f.identity.assertCurrent(),readRootViews:roots,
    readArtwork:async()=>{assert.fail('full-v1协议夹具不启动封面读取。')}})
  const read=createLocalWorkbenchReadService({datasetId:f.identity.datasetId,repository:f.repository,localAlbums:albums,
    assertCurrent:()=>f.identity.assertCurrent(),readRootViews:roots})
  let capture:LocalLibraryManagementCaptureRecord
  try{
    const page=await albums.queryAlbums({rootId:f.root.id,query:'',filter:'all',offset:0,limit:200});assert.equal(page.total,2);assert.equal(page.hasMore,false)
    const refs=page.items.map(item=>({albumId:item.id,rootId:item.rootId,revision:item.revision})),resolved=[]
    for(const ref of refs)resolved.push(await read.readUnleasedAlbum(ref))
    assert.equal(new Set(resolved.map(value=>value.datasetRevision)).size,1)
    const captureId=randomUUID(),original:LocalLibraryManagementCaptureRecord['original']={mode:'library',request:{libraryIds:[f.root.id]},captureId,
      watermark:resolved[0]!.datasetRevision,catalogRevision:catalog.privateAlbumBrowserRevision(),scanRevision:f.repository.localScan.privateAlbumBrowserRevision(),
      libraries:[{libraryId:f.root.id,sourceRootId:f.root.sourceRootId,rootRevision:f.root.revision}],albumRefs:refs,
      albums:resolved.map(value=>({libraryId:f.root.id,sourceRootId:f.root.sourceRootId,rootRevision:f.root.revision,resolved:structuredClone(value)}))}
    capture={schema:1,kind:'capture',datasetId:f.identity.datasetId,key:captureId,revision:1,original,originalSha256:localLibraryManagementDigest(original)}
  }finally{read.close();albums.close()}
  const expected=structuredClone(capture),raw=Buffer.from(journal.localWorkbenchJournalCanonical(capture))
  assert.ok(raw.length>=1_300_000&&raw.length<journal.LOCAL_LIBRARY_MANAGEMENT_BYTES,'合法整件必须覆盖当前1.3MB尺寸层并保持原32MiB上限。')
  assert.deepEqual(captureLocalLibraryManagementRecord(capture),capture)
  const events=createLocalLibraryManagementBatchEvents([{record:capture,previous:null}]),chunks=events.filter(event=>event.kind==='chunk')
  assert.ok(chunks.length>30);assert.equal(chunks.length,Math.ceil(raw.length/journal.LOCAL_LIBRARY_MANAGEMENT_CHUNK_BYTES))
  for(const event of events)assert.ok(Object.values(localLibraryManagementLedgerRow(event)).reduce((n,value)=>n+Buffer.byteLength(value),0)<=64*1024)
  function replay(input:readonly typeof events[number][]){
    const projection=emptyLocalLibraryManagementProjection(f.identity.datasetId)
    for(const [index,event]of input.entries())projectLocalLibraryManagementEvent(projection,event,index+1)
    assertLocalLibraryManagementComplete(projection);return projection.records.get('capture:'+expected.key)!
  }
  // 真正的ledger行encode/decode后投影完整原件；不直接塞record到projection Map。
  const decoded=events.map(event=>readLocalLibraryManagementEvent(localLibraryManagementLedgerRow(event))),stored=replay(decoded)
  assert.deepEqual(stored.record,expected);assert.equal(stored.recordSha256,localLibraryManagementDigest(expected))
  assert.notEqual(stored.record,capture);assert.notEqual((stored.record as LocalLibraryManagementCaptureRecord).original,capture.original)
  capture.original.albums[0]!.resolved.capture.members[0]!.title='外部调用方改写'
  assert.deepEqual(stored.record,expected,'投影只能持有从原字节新建的私有frame。')
  const originalPayload=chunks[0]!.payload;chunks[0]!.payload=Buffer.from('外部改写chunk').toString('base64')
  assert.deepEqual(stored.record,expected);chunks[0]!.payload=originalPayload
  let traps=0
  const proxy=new Proxy(expected,{get(){traps++;throw new Error('不得读proxy')}})
  assert.throws(()=>captureLocalLibraryManagementRecord(proxy));assert.equal(traps,0)
  const getter=structuredClone(expected);Object.defineProperty(getter.original,'secret',{enumerable:true,get(){traps++;throw new Error('不得读getter')}})
  assert.throws(()=>captureLocalLibraryManagementRecord(getter));assert.equal(traps,0)
  const over=events.map(event=>({...event,bytes:journal.LOCAL_LIBRARY_MANAGEMENT_BYTES+1}))
  assert.throws(()=>replay(over),'原32MiB原帧边界不得放宽')
  const tampered=events.map(event=>({...event})),chunk=tampered.find(event=>event.kind==='chunk')!
  if(chunk.kind!=='chunk')assert.fail('原整件必须含chunk')
  const damaged=Buffer.from(chunk.payload,'base64');damaged[0]=(damaged[0]??0)^1;chunk.payload=damaged.toString('base64')
  assert.throws(()=>replay(tampered),'完整原frame SHA必须仍拒绝坏原字节')
  // 仅污染末record摘要：原字节/frame摘要和所有合法header均不变，必须在末闭核拒绝。
  const wrongRecordSha=events.map(event=>({...event,recordSha256:'0'.repeat(64)}))
  assert.ok(wrongRecordSha.every(journal.isLocalLibraryManagementEvent),'仅改合法record SHA不得先撞header形状')
  assert.deepEqual(wrongRecordSha.map((event,index)=>({...event,recordSha256:events[index]!.recordSha256})),events)
  assert.throws(()=>replay(wrongRecordSha),'原Buffer实算摘要必须另比recordSha，不能借frameSha通过末核')
  function reframe(bad:LocalLibraryManagementCaptureRecord){
    const bytes=Buffer.from(journal.localWorkbenchJournalCanonical(bad)),first=events[0]!
    const {kind,index,payload,...originalHeader}=first as Extract<typeof first,{kind:'chunk'}>
    const header={...originalHeader,recordSha256:localLibraryManagementDigest(bad),frameSha256:createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length,chunks:Math.ceil(bytes.length/journal.LOCAL_LIBRARY_MANAGEMENT_CHUNK_BYTES)}
    return [...Array.from({length:header.chunks},(_,index)=>({...header,kind:'chunk' as const,eventId:randomUUID(),index,
      payload:bytes.subarray(index*journal.LOCAL_LIBRARY_MANAGEMENT_CHUNK_BYTES,(index+1)*journal.LOCAL_LIBRARY_MANAGEMENT_CHUNK_BYTES).toString('base64')})),
      {...header,kind:'commit' as const,eventId:randomUUID()}]
  }
  for(const damage of ['original-sha','tail-member','old-revision'] as const){
    const bad=structuredClone(expected)
    if(damage==='original-sha')bad.originalSha256='0'.repeat(64)
    else if(damage==='tail-member'){const resolved=bad.original.albums.at(-1)!.resolved;resolved.capture.members=resolved.capture.members.slice(0,-1);bad.originalSha256=localLibraryManagementDigest(bad.original)}
    else Object.assign(bad,{revision:2})
    const badEvents=reframe(bad);assert.ok(badEvents.every(journal.isLocalLibraryManagementEvent),'重签闭集header本身必须合法')
    assert.throws(()=>replay(badEvents),'重新绑定完整frame/record SHA仍须拒绝完整record语义：'+damage)
  }
  // 对实际同SQL原库CAS/冷开也核整件相等，保当前live完整成员/水位认证。
  catalog.privateLibraryManagementCompareAndSwap(f.identity,[{record:expected,expectedRevision:null}]);f.cold()
  assert.deepEqual(managementRead(f,'capture',expected.key)?.record,expected)
})


/** 528只验证production Domain同SQL原names/read/MBOnly writer/registry；不是DefaultWorker/Main/模型或Native资格。 */
async function organizationDomainFixture528(t:import('node:test').TestContext,activeOrganization=true){
  const {createCueSyntheticWave}=await import('../src/library/local-cue-format-qualification.js')
  type OwnerCommand=import('../src/collection/dataset-owner-protocol.js').DatasetWorkbenchOwnerCommand
  type OwnerPayloads=import('../src/collection/dataset-owner-protocol.js').DatasetWorkbenchOwnerPayloads
  type OwnerResults=import('../src/collection/dataset-owner-protocol.js').DatasetWorkbenchOwnerResults
  const temporary=process.env.TMPDIR;assert.ok(temporary?.startsWith('/Volumes/LifeWeave/Developer/CommandLine/'))
  const directory=await mkdtemp(path.join(temporary!,'organization528-')),sourceDirectory=path.join(directory,'自有来源'),albumDirectory=path.join(sourceDirectory,'原专辑')
  await mkdir(albumDirectory,{recursive:true,mode:0o700});await mkdir(path.join(directory,'staging'),{mode:0o700})
  const wave=createCueSyntheticWave(4800).wave,sourceFile=path.join(albumDirectory,'01.wav');await writeFile(sourceFile,wave,{flag:'wx',mode:0o600})
  const file=path.join(directory,'collection.v1.sqlite'),repository=createCollectionRepository({filePath:file,stagingRoot:path.join(directory,'staging')}),state=createBackupWorkflowStore({filePath:path.join(directory,'backup-maintenance.v1.sqlite')})
  repository.localCatalog.roots();const identity=state.datasetIdentities.bind('default',file,false);repository.localCatalog.privateBindWorkbenchDataset(identity)
  const commandId=randomUUID(),source=repository.sources.authorize(commandId,await authorizeSourceDirectory(sourceDirectory)),root=repository.localCatalog.registerRoot({commandId,sourceRootId:source.id,role:'library'})
  const asset=repository.localCatalog.registerAsset({commandId:randomUUID(),libraryRootId:root.id,expectedRootRevision:root.revision,relative:'原专辑/01.wav',sha256:digest(wave),sampleFrames:null,timebaseHz:null})
  const track=repository.localCatalog.createTrack({commandId:randomUUID(),assetId:asset.id,segment:null})
  repository.localCatalog.observeMetadata({commandId:randomUUID(),trackId:track.id,source:'synthetic',parserVersion:'organization528-owned-metadata-v1',fields:{title:'原曲目',artist:'原歌手',album:'原专辑',track:'1',disc:'1'}})
  function importOrganization(library:dto.LibraryRoot,operationId:string){
    const original:LocalLibraryManagementOperationRecord['original']={command:'library.import.confirm',request:{commandId:operationId,choiceId:randomUUID(),role:'catalog'}}
    const operation:LocalLibraryManagementOperationRecord={schema:1,kind:'operation',datasetId:identity.datasetId,key:operationId,revision:1,original,originalSha256:localLibraryManagementDigest(original),receipt:{commandId:operationId,kind:'library.import.confirm',state:'succeeded',libraryIds:[library.id],message:null}}
    const binding:LocalLibraryManagementBindingRecord={schema:1,kind:'binding',datasetId:identity.datasetId,key:library.id,revision:1,libraryId:library.id,sourceRootId:library.sourceRootId,rootRevision:library.revision,role:'catalog',name:'原组织库',active:true,watchEnabled:false,operationId}
    repository.localCatalog.privateLibraryManagementCompareAndSwap(identity,[{record:operation,expectedRevision:null},{record:binding,expectedRevision:null}])
  }
  if(activeOrganization)importOrganization(root,commandId)
  const epoch=randomUUID(),domain=createDatasetDomain({collectionRepository:repository,backupWorkflowStore:state,collectionDatasetIdentity:identity,localSourceEpoch:epoch})
  t.after(async()=>{try{await domain.close()}finally{assert.deepEqual(await readFile(sourceFile),wave)}})
  await domain.localSourceWrites.prepareRecoveryProtection();await domain.localRelocationPlans.prepareRecoveryProtection();await domain.prepareWorkbench();await domain.commitBoot!()
  async function owner<C extends OwnerCommand>(command:C,payload:OwnerPayloads[C]):Promise<OwnerResults[C]>{
    const began=performance.now(),context:DatasetWorkbenchExecutionContext={identity:{datasetId:identity.datasetId,epoch},signal:new AbortController().signal,deadlineAtMs:began+2000}
    const result=await domain.dispatchWorkbenchOwner!({command,payload} as import('../src/collection/dataset-owner-protocol.js').DatasetWorkbenchOwnerRequest,context)
    assert.ok(performance.now()-began<2000,'原Owner调用不得用迟到结果补绿');return result as OwnerResults[C]
  }
  async function preview(){
    const albums=domain.localAlbums;assert.ok(albums,'必须使用production Domain原专辑作者')
    const page=await albums.queryAlbums({rootId:root.id,query:'',filter:'all',offset:0,limit:200});assert.equal(page.total,1);assert.equal(page.items.length,1)
    const summary=page.items[0]!;assert.equal(summary.representativeTrackId,track.id)
    const readback=await owner('read.albums',{albums:[{albumId:summary.id,rootId:root.id,title:summary.title,artist:summary.artists.join(' / '),trackIds:[track.id]}]})
    assert.equal(readback.albums.length,1);const reference=readback.albums[0]!.capture
    const preparation=await owner('read.prepareNameSuggestion',{datasetId:identity.datasetId,capture:reference,backend:'ollama'})
    // 受控文本输入原解析器；不调用后端，也不由测试制造AI origin品牌。
    const suggested=await owner('read.completeNameSuggestion',{preparationId:preparation.preparationId,response:{backend:'ollama',content:JSON.stringify({artistName:'528新歌手',albumName:'528新专辑',reason:'合成名称回归'})}})
    assert.equal(suggested.status,'ready');if(suggested.status!=='ready')assert.fail('原names未返回ready候选')
    const prepared=await owner('read.prepareNamePreview',{datasetId:identity.datasetId,captures:[reference],selections:[{albumId:reference.albumId,candidateId:suggested.candidate.candidateId}]})
    assert.equal(prepared.draft.state,'ready');assert.equal(prepared.capture.albums.length,1);assert.equal(prepared.capture.albums[0]!.members.length,1)
    const plan=await owner('registry.issuePlan',prepared);assert.equal(plan.kind,'ai');assert.equal(plan.scope,'MB_ONLY');assert.equal(plan.state,'ready')
    const original:dto.LocalWorkbenchApplyRequest={commandId:randomUUID(),datasetId:identity.datasetId,planId:plan.planId,expectedRevision:plan.revision,planHash:plan.planHash,contextFingerprint:plan.contextFingerprint,kind:plan.kind}
    const saved=repository.localCatalog.privateWorkbenchSnapshot(identity.datasetId)?.entries.find(entry=>entry.plan.planId===plan.planId);assert.ok(saved);assert.deepEqual(saved.capture,prepared.capture);assert.equal(saved.original,null);assert.equal(saved.receipt,null)
    return {plan,prepared,original}
  }
  function changeOrganization(kind:'name'|'active'){
    const current=repository.localCatalog.privateLibraryManagementRead(identity,'binding',root.id)?.record;assert.ok(current?.kind==='binding');if(current.kind!=='binding')assert.fail('组织必须为原binding')
    const commandId=randomUUID(),original:LocalLibraryManagementOperationRecord['original']=kind==='name'?{command:'library.rename',request:{commandId,libraryId:root.id,name:'真实修改后的组织名'}}:{command:'library.remove',request:{commandId,libraryIds:[root.id]}}
    const operation:LocalLibraryManagementOperationRecord={schema:1,kind:'operation',datasetId:identity.datasetId,key:commandId,revision:1,original,originalSha256:localLibraryManagementDigest(original),receipt:{commandId,kind:original.command,state:'succeeded',libraryIds:[root.id],message:null}}
    const next:LocalLibraryManagementBindingRecord={...current,revision:current.revision+1,operationId:commandId,...(kind==='name'?{name:'真实修改后的组织名'}:{active:false,watchEnabled:false})}
    repository.localCatalog.privateLibraryManagementCompareAndSwap(identity,[{record:operation,expectedRevision:null},{record:next,expectedRevision:current.revision}])
    assert.deepEqual(repository.localCatalog.privateLibraryManagementRead(identity,'binding',root.id)?.record,next)
  }
  const {LOCAL_WORKBENCH_MB_ONLY_OPERATION}=await import('../src/collection/local-library-workbench/owner-journal.js')
  const mbOnlyRows=()=>repository.localCatalog.privateRead(db=>db.prepare('SELECT rowid AS ordinal,* FROM local_catalog_ledger WHERE operation=? ORDER BY rowid').all(LOCAL_WORKBENCH_MB_ONLY_OPERATION))
  return {directory,sourceFile,wave,identity,repository,source,root,track,asset,domain,owner,preview,changeOrganization,mbOnlyRows}
}

test('组织528真实Domain：active组织fresh names原计划成功，空组织原兼容仍成功且同SQL持久回执保源',async t=>{
  for(const active of [true,false]){
    const f=await organizationDomainFixture528(t,active),organizations=f.repository.localCatalog.privateLibraryManagementOrganizations(f.identity)
    assert.equal(organizations.length,active?1:0)
    if(active){assert.equal(organizations[0]!.rootId,f.root.id);assert.equal(organizations[0]!.sourceRootId,f.source.id);assert.equal(organizations[0]!.role,'catalog')}
    const before=f.repository.localCatalog.metadata(f.track.id),asset=structuredClone(f.repository.localCatalog.asset(f.asset.id)),root=structuredClone(f.repository.localCatalog.root(f.root.id)),prepared=await f.preview()
    assert.deepEqual(f.repository.localCatalog.metadata(f.track.id),before,'原preview/issue不能修改名称')
    const mbRows=f.mbOnlyRows(),receipt=await f.owner('registry.apply',prepared.original);assert.equal(receipt.state,'succeeded');assert.ok(receipt.items.length===1&&receipt.items.every(item=>item.state==='applied'));assert.ok(f.mbOnlyRows().length>mbRows.length,'实际MBOnly账本必须落本次整组记录')
    const now=f.repository.localCatalog.metadata(f.track.id);assert.deepEqual(now.raw,before.raw);assert.equal(now.effective.artist,'528新歌手');assert.equal(now.effective.album,'528新专辑')
    assert.deepEqual(f.repository.localCatalog.asset(f.asset.id),asset);assert.deepEqual(f.repository.localCatalog.root(f.root.id),root);assert.deepEqual(await readFile(f.sourceFile),f.wave)
    const saved=f.repository.localCatalog.privateWorkbenchSnapshot(f.identity.datasetId)?.entries.find(entry=>entry.plan.planId===prepared.plan.planId);assert.ok(saved);assert.deepEqual(saved.original,prepared.original);assert.deepEqual(saved.receipt,receipt)
    assert.deepEqual(f.repository.localCatalog.privateWorkbenchMBOnlyReadReceipt(f.identity,prepared.original),receipt,'必须回读真实MBOnly durable记录')
    assert.deepEqual(await f.owner('registry.readOriginalReceipt',prepared.original),receipt)
  }
  t.diagnostic('旧Domain自动包装非空organization，原Catalog writer只核raw时首个active项应RED；测试没有镜像revision公式或假revalidate。')
})

test('组织528真实Domain：合法rename/remove与Source撤销后旧names原命令拒绝，完整MB事实和源不改',async t=>{
  for(const changed of ['name','active','source'] as const){
    const f=await organizationDomainFixture528(t),prepared=await f.preview(),before=f.repository.localCatalog.metadata(f.track.id),asset=structuredClone(f.repository.localCatalog.asset(f.asset.id))
    if(changed==='source')assert.equal(f.repository.sources.revoke({commandId:randomUUID(),id:f.source.id}).authorized,false)
    else f.changeOrganization(changed)
    const mbRows=f.mbOnlyRows(),receipt=await f.owner('registry.apply',prepared.original);assert.equal(receipt.state,'failed');assert.ok(receipt.items.length===1&&receipt.items.every(item=>item.state==='not-written'));assert.deepEqual(f.mbOnlyRows(),mbRows,'拒绝不得进入MBOnly写事务')
    assert.deepEqual(f.repository.localCatalog.metadata(f.track.id),before);assert.deepEqual(f.repository.localCatalog.asset(f.asset.id),asset);assert.deepEqual(await readFile(f.sourceFile),f.wave)
    const saved=f.repository.localCatalog.privateWorkbenchSnapshot(f.identity.datasetId)?.entries.find(entry=>entry.plan.planId===prepared.plan.planId);assert.ok(saved);assert.deepEqual(saved.original,prepared.original);assert.deepEqual(saved.capture,prepared.prepared.capture);assert.deepEqual(saved.receipt,receipt)
    assert.deepEqual(f.repository.localCatalog.privateWorkbenchMBOnlyReadReceipt(f.identity,prepared.original),receipt,'原Store可回落registry failed回执；不能把null当零writer证明')
    const operations=await f.owner('registry.operations',{});assert.equal(operations.length,1);assert.deepEqual(operations[0]!.request,prepared.original)
    assert.deepEqual(await f.owner('registry.readOriginalReceipt',prepared.original),receipt)
  }
  t.diagnostic('组织角色/root关联不可借rename改造；原类型与不可变CAS负例保留，不把非法fixture当合法角色迁移。')
})


// 内部正文品牌只省不可变计算；同SQL/原ledger回放仍逐次验证，不授作者或性能资格。
test('Library正文549：Owner捕获递归冻结，普通副本保持可变且frame与冷SQL不持调用方别名',async t=>{
  const journal=await import('../src/collection/local-library-workbench/owner-journal.js'),f=await managementFixture(t),input=await f.capture(),expected=structuredClone(input)
  const copy=captureLocalLibraryManagementRecord(input);assert.equal(copy.kind,'capture');if(copy.kind!=='capture')assert.fail('必须是完整capture')
  assert.equal(Reflect.set(copy.original.albums[0]!.resolved.capture.members[0]!,'title','普通副本可变'),true);assert.deepEqual(input,expected)
  const owned=journal.captureLocalLibraryManagementOwnerRecord(input);assert.equal(owned.kind,'capture');if(owned.kind!=='capture')assert.fail('必须是完整capture')
  assert.notEqual(owned,input);assert.equal(Object.isFrozen(owned),true);assert.equal(Object.isFrozen(owned.original.albums[0]!.resolved.group.members),true)
  assert.equal(Object.isFrozen(owned.original.albums[0]!.resolved.directoryFacts.files[0]!.value),true)
  assert.equal(Reflect.set(owned.original.albums[0]!.resolved.capture.members[0]!,'title','不能改Owner正文'),false)
  input.original.albums[0]!.resolved.capture.members[0]!.title='调用方迟到更改';assert.deepEqual(owned,expected)
  const events=createLocalLibraryManagementBatchEvents([{record:owned,previous:null}]),projection=emptyLocalLibraryManagementProjection(f.identity.datasetId)
  for(const [index,event]of events.entries())projectLocalLibraryManagementEvent(projection,readLocalLibraryManagementEvent(localLibraryManagementLedgerRow(event)),index+1)
  assertLocalLibraryManagementComplete(projection);const projected=projection.records.get('capture:'+owned.key)!.record
  assert.deepEqual(projected,expected);assert.notEqual(projected,owned)
  f.catalog.privateLibraryManagementCompareAndSwap(f.identity,[{record:owned,expectedRevision:null}]);f.cold()
  const cold=managementRead(f,'capture',owned.key)!.record;assert.deepEqual(cold,expected);assert.equal(cold.kind,'capture');if(cold.kind!=='capture')assert.fail('冷回读必须是完整capture')
  assert.equal(Reflect.set(cold.original.albums[0]!.resolved.capture.members[0]!,'title','冷返回副本可变'),true)
  assert.deepEqual(managementRead(f,'capture',owned.key)!.record,expected)
})
test('Library正文549：冻结或声明SHA不能伪造正文品牌，旧Owner正文仍拒当前SQL及异库',async t=>{
  const journal=await import('../src/collection/local-library-workbench/owner-journal.js'),f=await managementFixture(t),input=await f.capture(),owned=journal.captureLocalLibraryManagementOwnerRecord(input)
  let traps=0;const proxy=new Proxy(input,{get(){traps++;throw new Error('不应读取proxy')}})
  assert.throws(()=>journal.createLocalLibraryManagementEvents(proxy,null));assert.equal(traps,0)
  const imitation=structuredClone(input);Object.defineProperty(imitation.original,'secret',{enumerable:true,get(){traps++;throw new Error('不应调用getter')}});Object.freeze(imitation)
  assert.throws(()=>createLocalLibraryManagementBatchEvents([{record:imitation,previous:null}]));assert.equal(traps,0)
  assert.throws(()=>f.catalog.privateLibraryManagementCompareAndSwap({...f.identity,datasetId:randomUUID()},[{record:owned,expectedRevision:null}]))
  assert.equal(managementRead(f,'capture',owned.key),null)
  const trackId=input.original.albums[0]!.resolved.group.members[0]!.fact.summary.track.id
  f.catalog.overrideMetadata({commandId:randomUUID(),trackId,expectedRevision:null,fields:{title:'本库同SQL真实后继字段'}})
  assert.throws(()=>f.catalog.privateLibraryManagementCompareAndSwap(f.identity,[{record:owned,expectedRevision:null}]),/水位|已改变|已变化/u)
  assert.equal(managementRead(f,'capture',owned.key),null)
})


// 只证明同原完整正文的编码/回放约束，不授性能、Main、Native或Source资格。
test('Library规范串560：公共可变副本按新正文编码，Owner同对象不可变且Proxy或getter不能造品牌',async t=>{
  const journal=await import('../src/collection/local-library-workbench/owner-journal.js'),f=await managementFixture(t),input=await f.capture(),expected=structuredClone(input)
  const mutable=captureLocalLibraryManagementRecord(input),owned=journal.captureLocalLibraryManagementOwnerRecord(input)
  assert.equal(mutable.kind,'capture');if(mutable.kind!=='capture')assert.fail('公共回读必须保持完整capture')
  assert.equal(owned.kind,'capture');if(owned.kind!=='capture')assert.fail('Owner回读必须保持完整capture')
  const changedId=randomUUID();mutable.key=changedId;mutable.original.captureId=changedId;mutable.originalSha256=localLibraryManagementDigest(mutable.original)
  const events=createLocalLibraryManagementBatchEvents([{record:mutable,previous:null}]),projection=emptyLocalLibraryManagementProjection(f.identity.datasetId)
  const raw=Buffer.concat(events.flatMap(event=>event.kind==='chunk'?[Buffer.from(event.payload,'base64')]:[]))
  assert.deepEqual(JSON.parse(raw.toString('utf8')),mutable,'公共可变副本不得复用修改前的规范串')
  assert.ok(events.every(event=>event.frameSha256===createHash('sha256').update(raw).digest('hex')&&event.recordSha256===localLibraryManagementDigest(mutable)))
  for(const [index,event]of events.entries())projectLocalLibraryManagementEvent(projection,readLocalLibraryManagementEvent(localLibraryManagementLedgerRow(event)),index+1)
  assertLocalLibraryManagementComplete(projection);assert.deepEqual(projection.records.get('capture:'+changedId)!.record,mutable)
  assert.deepEqual(owned,expected);assert.deepEqual(input,expected)
  assert.equal(Reflect.set(owned.original.albums[0]!.resolved.capture.members[0]!,'title','不能改品牌正文'),false)
  mutable.original.albums[0]!.resolved.capture.members[0]!.title='已重签但与原raw元数据不一致';mutable.originalSha256=localLibraryManagementDigest(mutable.original)
  assert.throws(()=>createLocalLibraryManagementBatchEvents([{record:mutable,previous:null}]),error=>error instanceof LocalWorkbenchPlanError&&error.code==='PERSISTENCE_FAILED')
  let traps=0
  const proxy=new Proxy(owned,{get(){traps++;throw new Error('不允许借同对象代理读品牌')},ownKeys(){traps++;throw new Error('不允许枚举代理品牌')}})
  assert.throws(()=>journal.captureLocalLibraryManagementOwnerRecord(proxy));assert.throws(()=>journal.createLocalLibraryManagementEvents(proxy,null));assert.equal(traps,0)
  const imitation=structuredClone(expected);Object.defineProperty(imitation.original,'secret',{enumerable:true,get(){traps++;throw new Error('不允许getter洗成品牌')}});Object.freeze(imitation)
  assert.throws(()=>journal.captureLocalLibraryManagementOwnerRecord(imitation));assert.throws(()=>journal.createLocalLibraryManagementEvents(imitation,null));assert.equal(traps,0)
})
test('Library规范串560：Owner full-v1多chunk整件SHA与冷SQL一致，改raw或重签坏语义仍拒绝',async t=>{
  const journal=await import('../src/collection/local-library-workbench/owner-journal.js'),f=await managementFixture(t,{albums:2,tracks:12}),input=await f.capture(),expected=structuredClone(input)
  const owned=journal.captureLocalLibraryManagementOwnerRecord(input),events=createLocalLibraryManagementBatchEvents([{record:owned,previous:null}])
  const chunks=events.filter(event=>event.kind==='chunk');assert.ok(chunks.length>1,'回归必须经过真实多chunk协议')
  const raw=Buffer.concat(chunks.map(event=>Buffer.from(event.payload,'base64'))),rawSha=createHash('sha256').update(raw).digest('hex')
  assert.equal(raw.toString('utf8'),journal.localWorkbenchJournalCanonical(expected));assert.equal(rawSha,localLibraryManagementDigest(expected))
  assert.ok(events.every(event=>event.encoding==='full-v1'&&event.frameSha256===rawSha&&event.recordSha256===rawSha&&event.bytes===raw.length))
  function replay(inputEvents:readonly typeof events[number][]){
    const projection=emptyLocalLibraryManagementProjection(f.identity.datasetId)
    for(const [index,event]of inputEvents.entries())projectLocalLibraryManagementEvent(projection,readLocalLibraryManagementEvent(localLibraryManagementLedgerRow(event)),index+1)
    assertLocalLibraryManagementComplete(projection);return projection.records.get('capture:'+expected.key)!
  }
  const stored=replay(events);assert.deepEqual(stored.record,expected);assert.equal(stored.recordSha256,rawSha);assert.notEqual(stored.record,owned)
  const tampered=events.map(event=>({...event})),firstChunk=tampered.find(event=>event.kind==='chunk')!;if(firstChunk.kind!=='chunk')assert.fail('缺原chunk')
  const changed=Buffer.from(firstChunk.payload,'base64');changed[0]=(changed[0]??0)^1;firstChunk.payload=changed.toString('base64')
  assert.ok(tampered.every(journal.isLocalLibraryManagementEvent),'损坏仍须先满足原header和base64闭集')
  assert.throws(()=>replay(tampered),'必须逐次核实际完整raw SHA')
  function reframe(bytes:Buffer){
    const first=events[0]!;if(first.kind!=='chunk')assert.fail('原事件必须从chunk开始')
    const {kind:_kind,index:_index,payload:_payload,...originalHeader}=first,sha=createHash('sha256').update(bytes).digest('hex')
    const header={...originalHeader,recordSha256:sha,frameSha256:sha,bytes:bytes.length,chunks:Math.ceil(bytes.length/journal.LOCAL_LIBRARY_MANAGEMENT_CHUNK_BYTES)}
    const result=[...Array.from({length:header.chunks},(_,index)=>({...header,kind:'chunk' as const,eventId:randomUUID(),index,payload:bytes.subarray(index*journal.LOCAL_LIBRARY_MANAGEMENT_CHUNK_BYTES,(index+1)*journal.LOCAL_LIBRARY_MANAGEMENT_CHUNK_BYTES).toString('base64')})),{...header,kind:'commit' as const,eventId:randomUUID()}]
    assert.ok(result.every(journal.isLocalLibraryManagementEvent));return result
  }
  assert.throws(()=>replay(reframe(Buffer.from(' '+raw.toString('utf8')))),'合法JSON、实际SHA正确但非规范原字节仍须拒绝')
  const invalid=structuredClone(expected);invalid.original.albums.at(-1)!.resolved.capture.members=invalid.original.albums.at(-1)!.resolved.capture.members.slice(0,-1);invalid.originalSha256=localLibraryManagementDigest(invalid.original)
  assert.throws(()=>replay(reframe(Buffer.from(journal.localWorkbenchJournalCanonical(invalid)))),'重签原original/frame/record全部SHA仍须完整语义校验')
  f.catalog.privateLibraryManagementCompareAndSwap(f.identity,[{record:owned,expectedRevision:null}]);f.cold()
  assert.deepEqual(managementRead(f,'capture',owned.key)!.record,expected)
})

/** 570仅修新增大范围夹具的准备批；200上限/真实checkpoint及原scan验证均不放宽。 */
async function libraryHeaderScanFixture570(t:import('node:test').TestContext,albums:number){
  const {isScanPreparedBatch}=await import('../src/collection/local-scan-store.js')
  const temp=process.env.TMPDIR;assert.ok(temp?.startsWith('/Volumes/LifeWeave/Developer/CommandLine/'))
  const directory=await mkdtemp(path.join(temp!,'library-header570-'))
  await mkdir(directory+'/source',{mode:0o700});await mkdir(directory+'/staging',{mode:0o700})
  const file=directory+'/catalog.sqlite',dataId=randomUUID();let alive=true
  const identity={datasetId:dataId,assertCurrent(){assert.equal(alive,true)}}
  const repository=createCollectionRepository({filePath:file,stagingRoot:directory+'/staging'})
  repository.localCatalog.privateBindWorkbenchDataset(identity)
  const source=repository.sources.authorize(randomUUID(),await authorizeSourceDirectory(directory+'/source'))
  const root=repository.localCatalog.registerRoot({commandId:randomUUID(),sourceRootId:source.id,role:'library'})
  const media=Array.from({length:albums*2},(_,i)=>({relative:`目录${Math.floor(i/2)}/歌曲${i}.flac`,bytes:Buffer.from('合成不可播放测试原字节'+i)}))
  function close(){if(alive){repository.close();alive=false}}
  t.after(async()=>{close();for(const entry of media)assert.deepEqual(await readFile(directory+'/source/'+entry.relative),entry.bytes)})
  for(let album=0;album<albums;album++)await mkdir(directory+'/source/目录'+album,{mode:0o700})
  const parserVersion='controlled-library417/scan'
  const started=repository.localScan.start({commandId:randomUUID(),datasetId:dataId,libraryRootId:root.id,expectedRootRevision:root.revision,parserVersion}).job
  let running=repository.localScan.resume({commandId:randomUUID(),jobId:started.jobId,expectedRevision:started.jobRevision})
  const items:ScanPreparedItem[]=[]
  for(const [i,value]of media.entries()){
    await writeFile(directory+'/source/'+value.relative,value.bytes,{flag:'wx',mode:0o600})
    const info=await stat(directory+'/source/'+value.relative,{bigint:true})
    items.push({relative:value.relative,signature:[info.dev,info.ino,info.size,info.mtimeNs,info.ctimeNs].join(':'),parserVersion,outcome:'accepted',
      fields:{title:'原曲目'+i,artist:'原合成作者',album:'原合成专辑'+Math.floor(i/2),track:String(i%2+1)},failureCode:null,reused:false,
      readFacts:{technical:{container:'FLAC',codec:'FLAC',lossless:true,sampleRateHz:44100,channels:2,bitsPerSample:16,durationSeconds:2,evidence:'bounded-parser-reported'},coverEvidence:[],
        readEvidence:{bytesRead:32,readCalls:1,maxReadBytes:32,allocationBytes:32,elapsedMs:1,wholeAudioHash:false,wholeAudioDecode:false}}})
  }
  const committedSizes:number[]=[]
  for(let offset=0;offset<items.length;offset+=200){
    const batchItems=items.slice(offset,offset+200),remaining=items.slice(offset+batchItems.length)
    const batch={batchId:randomUUID(),jobId:started.jobId,expectedJobRevision:running.jobRevision,checkpointBefore:running.checkpointRef,items:batchItems,
      frontier:[...new Set(remaining.map(item=>path.posix.dirname(item.relative)))],completed:remaining.length===0}
    assert.equal(isScanPreparedBatch(batch),true);assert.ok(batchItems.length>0&&batchItems.length<=200)
    const beforeRevision=running.jobRevision,beforeCheckpoint=running.checkpointRef
    const prepared=repository.localScan.privatePrepareBatch({commandId:randomUUID(),jobId:started.jobId,batch})
    assert.equal(prepared.jobRevision,beforeRevision);assert.equal(prepared.checkpointRef,beforeCheckpoint)
    running=repository.localScan.privateCommitBatch({commandId:randomUUID(),jobId:started.jobId,batchId:batch.batchId,expectedRevision:beforeRevision})
    assert.notEqual(running.jobRevision,beforeRevision);assert.notEqual(running.checkpointRef,beforeCheckpoint)
    assert.equal(running.phase,batch.completed?'completed':'running');committedSizes.push(batchItems.length)
  }
  assert.deepEqual(committedSizes,[200,200,2]);assert.equal(running.progress.visited,'402')
  assert.equal(running.progress.accepted,'402');assert.equal(running.progress.rejected,'0');assert.equal(media.length,402)
  return {directory,file,identity,root,source,media,close,repository,catalog:repository.localCatalog}
}

/** 561实际SQL/目录prepared事实+原读取工厂；不执行Parser/Native/Provider，也不冒Main2s资格。 */
async function libraryHeaderFixture561(t:import('node:test').TestContext,albums=201){
  const f=albums*2>200?await libraryHeaderScanFixture570(t,albums):await managementFixture(t,{albums,tracks:2})
  const {createLocalAlbumOwnerService}=await import('../src/collection/local-album-browser/owner-port.js')
  const {createLocalLibraryManagementRuntime}=await import('../src/collection/local-library-workbench/read-service.js')
  const {sourceRootAvailability}=await import('../src/recording/source-files.js')
  const commandId=randomUUID(),original:LocalLibraryManagementOperationRecord['original']={command:'library.import.confirm',request:{commandId,choiceId:randomUUID(),role:'catalog'}}
  const operation:LocalLibraryManagementOperationRecord={schema:1,kind:'operation',datasetId:f.identity.datasetId,key:commandId,revision:1,original,originalSha256:localLibraryManagementDigest(original),receipt:{commandId,kind:'library.import.confirm',state:'succeeded',libraryIds:[f.root.id],message:null}}
  const binding:LocalLibraryManagementBindingRecord={schema:1,kind:'binding',datasetId:f.identity.datasetId,key:f.root.id,revision:1,libraryId:f.root.id,sourceRootId:f.root.sourceRootId,rootRevision:f.root.revision,role:'catalog',name:'561完整库',active:true,watchEnabled:false,operationId:commandId}
  f.catalog.privateLibraryManagementCompareAndSwap(f.identity,[{record:operation,expectedRevision:null},{record:binding,expectedRevision:null}])
  const check=()=>f.identity.assertCurrent(),views=async():Promise<readonly dto.LocalRootView[]>=>[{root:f.catalog.root(f.root.id),label:f.source.label,availability:await sourceRootAvailability(f.repository.sources.root(f.source.id))}]
  const localAlbums=createLocalAlbumOwnerService({repository:f.repository,assertCurrent:check,readRootViews:views,
    readLibraryOrganizations:()=>f.catalog.privateLibraryManagementOrganizations(f.identity),
    async readArtwork(){throw new Error('561只读歌词范围不发封面请求。')}})
  const workbench=createLocalWorkbenchReadService({datasetId:f.identity.datasetId,repository:f.repository,localAlbums,readRootViews:views,assertCurrent:check})
  const management=createLocalLibraryManagementRuntime({identity:f.identity,catalog:f.catalog,localScan:f.repository.localScan,workbench,localAlbums,readRootViews:views,assertAccepting:check,
    completedSnapshots:{load(){throw new Error('561不加载新快照。')},retry(){throw new Error('561不重试扫描。')}}})
  t.after(async()=>{await management.close();workbench.close();await localAlbums.close()})
  const complete=await management.execute('library.capture',{libraryIds:[f.root.id]})
  assert.equal(complete.lyricsLibraries.length,1)
  const library=complete.lyricsLibraries[0]!,stored=f.catalog.privateLibraryManagementRead(f.identity,'capture',complete.captureId)
  assert.ok(stored?.record.kind==='capture');if(!stored||stored.record.kind!=='capture')assert.fail('必须读取同SQL完整capture')
  const record=stored.record
  assert.equal(record.original.mode,'library');assert.equal(record.original.albums.length,albums)
  assert.equal(record.original.albumRefs.length,albums);assert.equal(new Set(record.original.albumRefs.map(ref=>ref.albumId)).size,albums)
  assert.equal(record.original.albums.reduce((n,album)=>n+album.resolved.capture.members.length,0),albums*2)
  const proof=await management.lyricsLibraryAuthor.capture(library)
  return {...f,management,workbench,localAlbums,library,record,proof}
}

test('歌词库原SHA轻头561：真实201专辑200+1页与402成员完整回读，后续不复制整capture',{concurrency:false},async t=>{
  const f=await libraryHeaderFixture561(t),author=f.management.lyricsLibraryAuthor
  const read=f.catalog.privateLibraryManagementRead.bind(f.catalog)
  let forbiddenFullReads=0
  const fence=t.mock.method(f.catalog,'privateLibraryManagementRead',((identity,kind,key)=>{
    if(kind==='capture'){forbiddenFullReads++;throw new Error('561后续不得为原SHA比较复制整capture')}
    return read(identity,kind,key)
  }) as typeof f.catalog.privateLibraryManagementRead)
  try{
    await author.assertCurrent(f.proof)
    const first=await author.page(f.proof,null),tail=await author.page(f.proof,first.next)
    assert.equal(first.total,201);assert.equal(first.scopes.length,200);assert.equal(first.next,'200')
    assert.equal(tail.total,201);assert.equal(tail.scopes.length,1);assert.equal(tail.next,null)
    assert.equal(first.watermark,f.proof.watermark);assert.equal(tail.watermark,f.proof.watermark)
    const scopes=[...first.scopes,...tail.scopes]
    assert.deepEqual(scopes.map(scope=>scope.albumId),f.record.original.albums.map(album=>album.resolved.capture.albumId))
    let members=0
    for(const scope of scopes){
      assert.equal(scope.datasetId,f.identity.datasetId);assert.equal(scope.libraryId,f.root.id);assert.equal(scope.captureId,f.library.captureId)
      const frozen=await f.management.readFrozenAlbum(scope)
      assert.equal(frozen.resolved.capture.members.length,2);members+=frozen.resolved.capture.members.length
      assert.equal(await author.readAlbumPresence(f.proof,scope),'unknown')
    }
    await author.assertCurrent(f.proof)
    assert.equal(members,402);assert.equal(new Set(scopes.map(scope=>scope.albumId)).size,201)
    assert.equal(forbiddenFullReads,0)
  }finally{fence.mock.restore()}
  // 普通可变完整读取仍独立复制；轻头不能把完整snapshot改成分页或暴露私有projection别名。
  const ordinary=f.catalog.privateLibraryManagementRead(f.identity,'capture',f.library.captureId)!
  assert.equal(ordinary.record.kind,'capture');if(ordinary.record.kind!=='capture')assert.fail('必须是capture')
  assert.equal(Reflect.set(ordinary.record.original.albums,'length',0),true)
  assert.equal((f.catalog.privateLibraryManagementRead(f.identity,'capture',f.library.captureId)!.record as LocalLibraryManagementCaptureRecord).original.albums.length,201)
})

test('歌词库原SHA轻头561：坏proof原SHA与dataset/epoch拒绝，同SQL metadata水位和外连接变化仍拒',{concurrency:false},async t=>{
  const f=await libraryHeaderFixture561(t,1),author=f.management.lyricsLibraryAuthor
  const scopes=(await author.page(f.proof,null)).scopes;assert.equal(scopes.length,1);const scope=scopes[0]!
  await author.resolveAlbumReadToken(scope)
  const originalHeader=f.catalog.privateLibraryManagementReadCaptureHeader(f.identity,f.library.captureId);assert.ok(originalHeader)
  assert.equal(originalHeader.originalSha256,f.record.originalSha256);assert.equal(originalHeader.original.watermark,f.proof.watermark)
  const changedHeader=originalHeader as {original:{watermark:string}};changedHeader.original.watermark='561仅污染返回副本'
  assert.equal(f.catalog.privateLibraryManagementReadCaptureHeader(f.identity,f.library.captureId)!.original.watermark,f.proof.watermark)
  assert.equal(f.catalog.privateLibraryManagementReadCaptureHeader(f.identity,randomUUID()),null)
  assert.throws(()=>f.catalog.privateLibraryManagementReadCaptureHeader({...f.identity},f.library.captureId))
  for(const bad of [
    {...f.proof,authorityRef:Object.freeze({})},
    {...f.proof,library:{...f.proof.library,datasetId:randomUUID()}},
    {...f.proof,library:{...f.proof.library,captureId:randomUUID()}},
    {...f.proof,watermark:'561错误原水位'},
    {...f.proof,deadlineAtMs:f.proof.deadlineAtMs+1},
  ])await assert.rejects(()=>author.assertCurrent(bad))
  // 仅私有已核头的故障注入；真正SQL与完整projection仍先读，检验旧SHA绝不变成新许可。
  const readHeader=f.catalog.privateLibraryManagementReadCaptureHeader.bind(f.catalog)
  const oldSha=t.mock.method(f.catalog,'privateLibraryManagementReadCaptureHeader',(identity:typeof f.identity,key:string)=>{const value=readHeader(identity,key);return value?{...value,originalSha256:'0'.repeat(64)}:null})
  try{await assert.rejects(()=>author.assertCurrent(f.proof))}finally{oldSha.mock.restore()}
  const trackId=f.record.original.albums[0]!.resolved.capture.members[0]!.trackId;assert.ok(trackId)
  const revision=f.catalog.privateAlbumBrowserRevision()
  const override=f.catalog.overrideMetadata({commandId:randomUUID(),trackId,expectedRevision:null,fields:{title:'561同Owner真实后继metadata'}})
  assert.notEqual(f.catalog.privateAlbumBrowserRevision(),revision)
  await assert.rejects(()=>author.resolveAlbumReadToken(scope))
  // 另连接修改真实metadata正文使data_version变化：普通certificate保持严格，不能靠原SHA授准入。
  const writer=new DatabaseSync(f.file)
  try{assert.equal(writer.prepare('UPDATE local_catalog_overrides SET data=? WHERE track_id=?').run(JSON.stringify({...override,fields:{...override.fields,title:'561外连接真实metadata变化'}}),trackId).changes,1)}finally{writer.close()}
  assert.throws(()=>f.catalog.privateLibraryManagementReadCaptureHeader(f.identity,f.library.captureId))
  await assert.rejects(()=>author.assertCurrent(f.proof))
  // 原production Domain入口保真实epoch/dataset与2000ms判断；不从轻头或模拟回调制造Owner。
  const actual=await organizationDomainFixture528(t)
  assert.ok(actual.domain.localAlbums)
  const actualPage=await actual.domain.localAlbums.queryAlbums({rootId:actual.root.id,query:'',filter:'all',offset:0,limit:200})
  assert.equal(actualPage.items.length,1);const actualAlbum=actualPage.items[0]!
  const payload={albums:[{albumId:actualAlbum.id,rootId:actual.root.id,title:actualAlbum.title,artist:actualAlbum.artists.join(' / '),trackIds:[actual.track.id]}]}
  await actual.owner('read.albums',payload)
  const request={command:'read.albums',payload} satisfies import('../src/collection/dataset-owner-protocol.js').DatasetWorkbenchOwnerRequest
  for(const datasetId of [actual.identity.datasetId,randomUUID()]){
    const context:DatasetWorkbenchExecutionContext={identity:{datasetId,epoch:randomUUID()},signal:new AbortController().signal,deadlineAtMs:performance.now()+2000}
    assert.throws(()=>actual.domain.dispatchWorkbenchOwner!(request,context),{code:'INVENTORY_UNAVAILABLE'})
  }
  await f.management.close();await assert.rejects(()=>author.assertCurrent(f.proof))
})

/** 653仅同Owner实际SQLite/全capture与自有FD组件：受控JobPort不是Main/Native工厂准入。 */
async function terminalJobFixture653(t:import('node:test').TestContext,port:import('../src/collection/local-library-workbench/read-service.js').LocalLibraryManagementJobPort){
  const f=await managementFixture(t,{albums:2,tracks:1})
  const imported=operation(f,'library.import.confirm',{commandId:randomUUID(),choiceId:randomUUID(),role:'catalog'},[f.root.id])
  f.catalog.privateLibraryManagementCompareAndSwap(f.identity,[{record:imported,expectedRevision:null},{record:binding(f,imported),expectedRevision:null}])
  const {createLocalAlbumOwnerService}=await import('../src/collection/local-album-browser/owner-port.js')
  const {createLocalLibraryManagementRuntime}=await import('../src/collection/local-library-workbench/read-service.js')
  const {sourceRootAvailability}=await import('../src/recording/source-files.js')
  let accepting=true
  function assemble(actualPort=port){
    const check=()=>f.identity.assertCurrent(),views=async():Promise<readonly dto.LocalRootView[]>=>[{root:f.catalog.root(f.root.id),label:f.source.label,availability:await sourceRootAvailability(f.repository.sources.root(f.source.id))}]
    const localAlbums=createLocalAlbumOwnerService({repository:f.repository,assertCurrent:check,readRootViews:views,readLibraryOrganizations:()=>f.catalog.privateLibraryManagementOrganizations(f.identity),async readArtwork(){assert.fail('653不读取封面或调用Native。')}})
    const workbench=createLocalWorkbenchReadService({datasetId:f.identity.datasetId,repository:f.repository,localAlbums,readRootViews:views,assertCurrent:check})
    const snapshots=createCompletedScanSnapshotView({repository:f.repository,identity:f.identity})
    const management=createLocalLibraryManagementRuntime({identity:f.identity,catalog:f.catalog,localScan:f.repository.localScan,workbench,localAlbums,readRootViews:views,completedSnapshots:snapshots,jobs:actualPort,
      assertAccepting(){check();if(!accepting)throw new LocalWorkbenchPlanError('INVALID_CAPTURE','653受控接受guard拒绝原操作。')}})
    let closed=false
    async function close(){if(closed)return;await management.close();await workbench.close();await localAlbums.close();snapshots.close();closed=true}
    return {management,close}
  }
  const warm=assemble();t.after(warm.close)
  const capture=await warm.management.execute('library.capture',{libraryIds:[f.root.id]})
  const record=f.catalog.privateLibraryManagementRead(f.identity,'capture',capture.captureId);assert.ok(record)
  assert.equal(record.record.original.albums.length,2);assert.equal(record.record.original.albums.reduce((n,a)=>n+a.resolved.capture.members.length,0),2)
  const commandId=randomUUID(),start={commandId,captureId:capture.captureId,backend:'ollama' as const,selection:'selected' as const,albumIds:record.record.original.albumRefs.map(a=>a.albumId)}
  return {...f,...warm,completeCapture:capture,start,assemble,setAccepting(value:boolean){accepting=value},get repository(){return f.repository},get catalog(){return f.catalog}}
}
function terminalGate653<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>{resolve=done});return {promise,resolve}}

 test('Library暖终态653：partial/failed原done和join后零写ACK，保全capture/回执/源与自有FD闭口',{concurrency:false},async t=>{
  for(const terminal of ['partial','failed'] as const){
    const {open}=await import('node:fs/promises'),{fstatSync}=await import('node:fs'),fdRoot=process.env.TMPDIR;assert.ok(fdRoot)
    const outputFile=path.join(await mkdtemp(path.join(fdRoot,'library653-fd-')),'owned-output'),held=await open(outputFile,'wx+'),output=Buffer.from('653原自有输出保留')
    await held.writeFile(output);const handle=held.fd,firstJoined=terminalGate653<void>(),entered=terminalGate653<void>(),released=terminalGate653<void>()
    let prepares=0,joins=0,joinedJob:string|null=null
    const f=await terminalJobFixture653(t,{
      async prepare(){if(terminal==='partial'&&prepares++===0)return null;throw new LocalWorkbenchPlanError('INVALID_CAPTURE','653原准备明确未受理。')},
      async run(){assert.fail('653原准备未受理，禁止伪造Source执行。')},async readOriginal(){assert.fail('653无原attempt，禁止新query。')},
      async join(job){if(joinedJob!==null)assert.equal(job.key,joinedJob);joinedJob=job.key
        if(++joins===1){await held.close();firstJoined.resolve()}else {entered.resolve();await released.promise}}
    })
    t.after(async()=>{released.resolve();await held.close().catch(()=>{})})
    await f.management.execute('library.ai.start',f.start);await firstJoined.promise;await f.management.joinJob(f.start.commandId)
    const before=f.catalog.privateLibraryManagementRead(f.identity,'job',f.start.commandId);assert.ok(before)
    assert.equal(before.record.checkpoint.state,terminal);assert.equal(before.record.checkpoint.items.length,2)
    const original=structuredClone(before),revision=f.catalog.privateLibraryManagementRevision(f.identity)
    await assert.rejects(()=>held.stat(),{code:'EBADF'});assert.ok(handle>=0);assert.throws(()=>fstatSync(handle),{code:'EBADF'})
    let settled=false;const stopping=f.management.execute('library.job.stop',{jobId:f.start.commandId});void stopping.then(()=>{settled=true},()=>{settled=true})
    try{
      await Promise.race([entered.promise,stopping.then(()=>assert.fail('653不能先于原join返回。'))]);assert.equal(settled,false)
      assert.deepEqual(f.catalog.privateLibraryManagementRead(f.identity,'job',f.start.commandId),original)
      released.resolve();const receipt=await stopping
      assert.equal(receipt.state,terminal);assert.equal(receipt.processedAlbums,2);assert.deepEqual(receipt.items.map(i=>i.state),before.record.checkpoint.items.map(i=>i.state))
      assert.deepEqual(f.catalog.privateLibraryManagementRead(f.identity,'job',f.start.commandId),original)
      assert.equal(f.catalog.privateLibraryManagementRevision(f.identity),revision);assert.equal(joins,2)
      assert.deepEqual(await readFile(outputFile),output);assert.deepEqual(f.catalog.privateLibraryManagementRead(f.identity,'capture',f.completeCapture.captureId)?.record.originalSha256,localLibraryManagementDigest(f.catalog.privateLibraryManagementRead(f.identity,'capture',f.completeCapture.captureId)!.record.original))
    }finally{released.resolve();await stopping.catch(()=>{});await f.close()}
  }
})

 test('Library暖终态653：旧stop等待join期间retry新run不被取消或借旧闭口，冷空join及接受guard仍拒',{concurrency:false},async t=>{
  const firstJoined=terminalGate653<void>(),stopEntered=terminalGate653<void>(),stopRelease=terminalGate653<void>(),retryEntered=terminalGate653<void>(),retryRelease=terminalGate653<void>()
  let initial=0,joins=0,retrySignal:AbortSignal|undefined
  const f=await terminalJobFixture653(t,{
    async prepare(input,context){if(input.action?.command==='library.job.retry'){retrySignal=context.signal;retryEntered.resolve();await retryRelease.promise;return null}
      if(initial++===0)return null;throw new LocalWorkbenchPlanError('INVALID_CAPTURE','653保原failed集合。')},
    async run(){assert.fail('653没有已受理attempt。')},async readOriginal(){assert.fail('653不新查无attempt。')},
    async join(){if(++joins===1)firstJoined.resolve();else if(joins===2){stopEntered.resolve();await stopRelease.promise}}
  })
  t.after(()=>{stopRelease.resolve();retryRelease.resolve();f.setAccepting(true)})
  await f.management.execute('library.ai.start',f.start);await firstJoined.promise;await f.management.joinJob(f.start.commandId)
  const old=f.catalog.privateLibraryManagementRead(f.identity,'job',f.start.commandId);assert.ok(old);assert.equal(old.record.checkpoint.state,'partial')
  f.setAccepting(false);await assert.rejects(()=>f.management.execute('library.job.stop',{jobId:f.start.commandId}),{code:'INVALID_CAPTURE'});f.setAccepting(true);assert.equal(joins,1)
  const stopping=f.management.execute('library.job.stop',{jobId:f.start.commandId});const stopped=assert.rejects(stopping,{code:'INVALID_CAPTURE'})
  try{
    await Promise.race([stopEntered.promise,stopping.then(()=>assert.fail('653旧stop不得跳过join。'))])
    const failed=old.record.checkpoint.items.filter(i=>i.state==='failed').map(i=>i.albumId);assert.equal(failed.length,1)
    await f.management.execute('library.job.retry',{jobId:f.start.commandId,albumIds:failed});await retryEntered.promise
    stopRelease.resolve();await stopped;assert.equal(retrySignal?.aborted,false)
    const live=f.catalog.privateLibraryManagementRead(f.identity,'job',f.start.commandId);assert.ok(live);assert.equal(live.record.originalSha256,old.record.originalSha256)
    assert.equal(live.record.checkpoint.state,'running');assert.equal(live.record.checkpoint.items.find(i=>i.albumId===failed[0])!.state,'queued')
    retryRelease.resolve();await f.management.joinJob(f.start.commandId);await f.close()
    // 真正关闭并冷开同SQLite；即使新的受控port.join返回，也不能从空Map恢复原物理quiet。
    f.cold();let coldJoins=0
    const originalJob=jobRecord(f,f.catalog.privateLibraryManagementRead(f.identity,'capture',f.completeCapture.captureId)!.record)
    f.catalog.privateLibraryManagementCompareAndSwap(f.identity,[{record:originalJob,expectedRevision:null}])
    const failedRecord:LocalLibraryManagementJobRecord={...structuredClone(originalJob),revision:2,checkpoint:{...structuredClone(originalJob.checkpoint),state:'failed',items:originalJob.checkpoint.items.map(i=>({...i,state:'failed',message:'653冷旧未受理失败'}))}}
    f.catalog.privateLibraryManagementCompareAndSwap(f.identity,[{record:failedRecord,expectedRevision:1}])
    const coldPort={async prepare(){assert.fail('653冷stop不得prepare')},async run(){assert.fail('653冷stop不得run')},async readOriginal(){assert.fail('653冷stop不得query')},async join(){coldJoins++}}
    // 同repo/identity实际冷作者；成功的空join仍不是旧producer物理事实。
    const cold=f.assemble(coldPort);try{const before=f.catalog.privateLibraryManagementRead(f.identity,'job',failedRecord.key)
      await assert.rejects(()=>cold.management.execute('library.job.stop',{jobId:failedRecord.key}),{code:'INVALID_CAPTURE'})
      assert.deepEqual(f.catalog.privateLibraryManagementRead(f.identity,'job',failedRecord.key),before);assert.equal(coldJoins,0)
    }finally{await cold.close()}
  }finally{stopRelease.resolve();retryRelease.resolve();f.setAccepting(true);await stopped;await f.close()}
})

 test('Library暖终态653：原producer join拒绝且自有FD仍活保UNKNOWN，不借终态文字或新UUID放行',{concurrency:false},async t=>{
  const {open}=await import('node:fs/promises'),{fstatSync}=await import('node:fs'),temporary=process.env.TMPDIR;assert.ok(temporary)
  const file=path.join(await mkdtemp(path.join(temporary,'library653-unknown-')),'owned-reader'),handle=await open(file,'wx+');await handle.writeFile('653实际未闭原FD')
  const originalFd=handle.fd;let joins=0,prepares=0;const firstJoined=terminalGate653<void>()
  const f=await terminalJobFixture653(t,{
    async prepare(){prepares++;throw new LocalWorkbenchPlanError('INVALID_CAPTURE','653明确未受理。')},
    async run(){assert.fail('653无attempt不run')},async readOriginal(){assert.fail('653无attempt不query')},
    async join(){joins++;await handle.stat();firstJoined.resolve();throw new LocalWorkbenchPlanError('INVALID_CAPTURE','653原FD闭口未确认。')}
  })
  t.after(async()=>{await handle.close();await assert.rejects(()=>handle.stat(),{code:'EBADF'});assert.throws(()=>fstatSync(originalFd),{code:'EBADF'})})
  await f.management.execute('library.ai.start',f.start);await firstJoined.promise;await f.management.joinJob(f.start.commandId)
  const unknown=f.catalog.privateLibraryManagementRead(f.identity,'job',f.start.commandId);assert.ok(unknown);assert.equal(unknown.record.checkpoint.state,'unknown')
  await assert.rejects(()=>f.management.execute('library.job.stop',{jobId:f.start.commandId}),{code:'INVALID_CAPTURE'})
  assert.deepEqual(f.catalog.privateLibraryManagementRead(f.identity,'job',f.start.commandId),unknown);assert.equal(joins,1);assert.equal(prepares,2)
  assert.ok((await handle.stat()).isFile());assert.deepEqual(await readFile(file),Buffer.from('653实际未闭原FD'));await f.close()
})
