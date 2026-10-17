import test from 'node:test'
import assert from 'node:assert/strict'
import { LocalLyricsService } from '../src/collection/local-library-lyrics/service.js'
import type { LocalLyricsPorts, LocalLyricsCapture, LocalLyricsSaveRecord, LocalLyricsJobRecord } from '../src/collection/local-library-lyrics/types.js'
const raw = (v: unknown): Uint8Array => Buffer.from(JSON.stringify(v))
function fixture() {
  const scope = { datasetId: 'dataset', libraryId: 'library', albumId: 'album', captureId: 'capture' }
  const capture: LocalLyricsCapture = { scope, authorityRef: {}, epoch: 'epoch', fingerprint: 'original-fingerprint', online: true, tracks: [{ trackId: 'track', title: '歌曲', artist: '艺人', album: '专辑', language: '', version: 'original', durationMs: 120000, wholeTrack: false, format: 'flac', rootRevision: 'root', fileRevision: 'file', locationRevision: 'location', metadataRevision: 'metadata', lrc: 'false', embedded: 'false' }] }
  const saves = new Map<string, LocalLyricsSaveRecord>(), jobs = new Map<string, LocalLyricsJobRecord>()
  const calls = { provider: 0, writer: 0, journal: 0, snapshot: 0, joined: 0 }
  const control = { current: true, accepting: true, failQq: false, delayed: false }
  const library = { datasetId: 'dataset', libraryId: 'library', captureId: 'library-capture' }
  const lc = { library, authorityRef: {}, watermark: 'watermark', deadlineAtMs: Date.now() + 60000 }
  const ports: LocalLyricsPorts = {
    capture: { async capture() { return capture }, async assertCurrent(c) { assert.equal(c, capture); if (!control.current) throw new Error('stale private path') }, async captureLibrary() { return lc }, async assertLibraryCurrent() {}, async libraryPage() { return { scopes: [scope], next: null, total: 1, watermark: lc.watermark } } },
    journal: { async pendingSaves(scope) { return structuredClone([...saves.values()].filter(r => r.intent.scope.datasetId === scope.datasetId && r.intent.scope.libraryId === scope.libraryId && r.intent.scope.albumId === scope.albumId && (r.receipt.state !== 'complete' || r.receipt.snapshot === 'failed' || r.receipt.snapshot === 'pending' || !r.physicalClosed))) }, async readSave(id) { return structuredClone(saves.get(id) ?? null) }, async save(r, expected) { assert.equal(saves.get(r.intent.request.commandId)?.revision ?? null, expected); calls.journal++; saves.set(r.intent.request.commandId, structuredClone(r)) }, async readJob(id) { return structuredClone(jobs.get(id) ?? null) }, async checkpoint(r, expected) { assert.equal(jobs.get(r.snapshot.jobId)?.snapshot.revision ?? null, expected); jobs.set(r.snapshot.jobId, structuredClone(r)) } },
    providers: { async request(source, _op, input, signal) { calls.provider++; if (control.delayed) return new Promise((_resolve, reject) => { signal.addEventListener('abort', () => reject(new Error('abort')), { once: true }) }); if (source === 'qq' && control.failQq) throw new Error('https://private.invalid Cookie=secret'); const q = 'title' in input ? input : { title: '歌曲', artist: '艺人', album: '专辑' }; return raw(source === 'lrclib' ? [{ id: 1, trackName: q.title, artistName: q.artist, albumName: q.album, duration: 120, syncedLyrics: '[00:01.00]歌词' }] : source === 'netease' ? { result: { songs: [] } } : source === 'qq' ? { data: { song: { list: [] } } } : source === 'kugou' ? { data: { info: [] } } : { data: { list: [] } }) }, async join() { calls.joined++ } },
    writer: { async write(_kind, intent, selected) { assert.ok(saves.has(intent.request.commandId)); calls.writer++; return { state: 'saved', bodySha256: selected.sha256 } }, async retryFailed() { throw new Error('unexpected retry') }, async readOriginal() { return null }, async join() {} },
    cover: { async save() { return 'not-requested' }, async readOriginal() { return 'not-requested' }, async hasPending() { return false } },
    inventory: { async inspect(c) { return c.tracks.map(t => ({ trackId: t.trackId, fileRevision: t.fileRevision, lrc: t.lrc, embedded: t.embedded })) }, async persist() {}, async snapshot() { calls.snapshot++; return 'saved' }, async page() { return { total: 1, watermark: 'watermark', rows: [{ albumId: 'album', presence: 'false' }] } } },
    lifecycle: { assertAccepting() { if (!control.accepting) throw new Error('closed') }, now: () => Date.now(), async join() {} },
  }
  return { ports, scope, capture, saves, calls, control, service: new LocalLyricsService(ports) }
}
test('歌词查询先受理后只读轮询，候选预览选择零写', async t => {
  const f = fixture(); t.after(() => f.service.close())
  const accepted = await f.service.query({ scope: f.scope }); assert.equal(accepted.state, 'querying')
  await f.service.wait(accepted.sessionId)
  const session = await f.service.readSession({ sessionId: accepted.sessionId })
  assert.equal(session.state, 'ready'); assert.equal(session.tracks[0]?.match, 'recommended')
  const id = session.candidates[0]!.candidateId
  assert.equal((await f.service.detail({ sessionId: session.sessionId, candidateId: id })).body, '[00:01.00]歌词')
  await f.service.select({ sessionId: session.sessionId, trackId: 'track', candidateId: id })
  assert.deepEqual([f.calls.writer, f.calls.journal, f.calls.snapshot], [0, 0, 0])
  const count = f.calls.provider; await f.service.readSession({ sessionId: session.sessionId }); assert.equal(f.calls.provider, count)
  assert.equal(await f.service.canLeave(session.sessionId), false)
})
test('歌词已有本地歌词与整轨跳过，offline保unknown不伪未找到', async t => {
  const f = fixture(); t.after(() => f.service.close())
  f.capture.online = false
  f.capture.tracks = [...f.capture.tracks, { ...f.capture.tracks[0]!, trackId: 'existing', lrc: 'true' }, { ...f.capture.tracks[0]!, trackId: 'whole', wholeTrack: true }]
  const s = await f.service.query({ scope: f.scope }); await f.service.wait(s.sessionId)
  assert.deepEqual((await f.service.readSession({ sessionId: s.sessionId })).tracks.map(t => t.match), ['unknown', 'existing', 'whole-track'])
  assert.equal(f.calls.provider, 0)
})
test('歌词独立Provider失败仍保其他候选且公开无私密错误', async t => {
  const f = fixture(); t.after(() => f.service.close()); f.control.failQq = true
  const s = await f.service.query({ scope: f.scope }); await f.service.wait(s.sessionId)
  const view = await f.service.readSession({ sessionId: s.sessionId })
  assert.equal(view.candidates.length, 1); assert.equal(view.tracks[0]?.sources.find(p => p.source === 'qq')?.state, 'failed')
  assert.equal(JSON.stringify(view).includes('Cookie'), false)
})
test('歌词换root或epoch后迟到回调不能发布候选', async t => {
  const f = fixture(); t.after(() => f.service.close())
  const previous = f.ports.providers.request
  f.ports.providers.request = async (...args) => { const r = await previous(...args); f.control.current = false; return r }
  const s = await f.service.query({ scope: f.scope }); await f.service.wait(s.sessionId)
  const view = await f.service.readSession({ sessionId: s.sessionId })
  assert.equal(view.state, 'stale'); assert.deepEqual(view.candidates, [])
  await assert.rejects(f.service.select({ sessionId: s.sessionId, trackId: 'track', candidateId: 'forged' }))
  assert.equal(f.calls.writer, 0)
})
test('歌词cancel实际abort并join五请求，不能靠先返回取消状态', async t => {
  const f = fixture(); t.after(() => f.service.close()); f.control.delayed = true
  const s = await f.service.query({ scope: f.scope })
  const cancelled = await f.service.cancel({ sessionId: s.sessionId })
  assert.equal(cancelled.state, 'cancelled'); assert.equal(f.calls.joined, 5); assert.equal(f.calls.writer, 0)
})
test('歌词候选绑定原session与track，合法scope键顺序不影响身份', async t => {
  const f = fixture(); t.after(() => f.service.close())
  const s = await f.service.query({ scope: { captureId: 'capture', albumId: 'album', libraryId: 'library', datasetId: 'dataset' } }); await f.service.wait(s.sessionId)
  const view = await f.service.readSession({ sessionId: s.sessionId })
  await assert.rejects(f.service.select({ sessionId: s.sessionId, trackId: 'foreign', candidateId: view.candidates[0]!.candidateId }))
  await assert.rejects(f.service.detail({ sessionId: 'another', candidateId: view.candidates[0]!.candidateId }))
  assert.equal(f.calls.journal, 0)
})
test('歌词展示副本变更不污染原候选正文和durable写入body', async t => {
  const f = fixture(); t.after(() => f.service.close())
  const s = await f.service.query({ scope: f.scope }); await f.service.wait(s.sessionId)
  const c = (await f.service.readSession({ sessionId: s.sessionId })).candidates[0]!
  const detail = await f.service.detail({ sessionId: s.sessionId, candidateId: c.candidateId }); detail.body = '篡改'; detail.candidate.title = '篡改'
  await f.service.select({ sessionId: s.sessionId, trackId: 'track', candidateId: c.candidateId })
  await f.service.save({ sessionId: s.sessionId, commandId: 'save', embed: true }); await f.service.saves.wait('save')
  assert.equal(f.saves.get('save')?.intent.selected[0]?.body, '[00:01.00]歌词')
  assert.equal(await f.service.canLeave(s.sessionId), true)
})
test('歌词关闭门禁拒绝新query并保全部自然join', async () => {
  const f = fixture(); await f.service.close()
  await assert.rejects(f.service.query({ scope: f.scope }), /CLOSED/u)
  assert.equal(f.calls.provider, 0)
})
test('歌词等分歧义必须review且选择候选仍零写', async t => {
  const f = fixture(); t.after(() => f.service.close())
  const previous = f.ports.providers.request
  f.ports.providers.request = async (...args) => { const bytes = await previous(...args); if (args[0] !== 'lrclib') return bytes; const rows = JSON.parse(Buffer.from(bytes).toString('utf8')) as Record<string, unknown>[]; return raw([rows[0], { ...rows[0], id: 2, syncedLyrics: '[00:01.00]另一版本' }]) }
  const s = await f.service.query({ scope: f.scope }); await f.service.wait(s.sessionId)
  const view = await f.service.readSession({ sessionId: s.sessionId })
  assert.equal(view.tracks[0]?.match, 'review'); assert.equal(view.tracks[0]?.selectedCandidateId, null)
  await f.service.select({ sessionId: s.sessionId, trackId: 'track', candidateId: view.candidates[1]!.candidateId })
  assert.deepEqual([f.calls.journal, f.calls.writer, f.calls.snapshot], [0, 0, 0])
})

import {randomUUID,createHash} from 'node:crypto'
import {mkdtemp,mkdir,writeFile,readFile,stat} from 'node:fs/promises'
import path from 'node:path'
import * as dto from '@music-bridge/contracts'
import {createCollectionRepository} from '../src/collection/repository.js'
import {authorizeSourceDirectory} from '../src/recording/source-files.js'
import {createLocalWorkbenchReadService} from '../src/collection/local-library-workbench/read-service.js'
import {localLibraryManagementDigest,localLyricsRootCaptureKey,captureLocalLyricsRootRecord,type LocalLibraryManagementCaptureRecord,type LocalLyricsRootCaptureRecord,type LocalLyricsRootSnapshotRecord} from '../src/collection/local-library-workbench/owner-journal.js'
import {localLyricsIntentFingerprint} from '../src/collection/local-library-lyrics/save-coordinator.js'
import type {ScanPreparedItem} from '../src/collection/local-scan-store.js'
import {createCueSyntheticWave} from '../src/library/local-cue-format-qualification.js'

/** 同一个受控SQLite与自有源目录；这些纯SQL例不自签Native或Source写许可。 */
async function rootJournal430(t:import('node:test').TestContext){
  assert.ok(process.env.TMPDIR?.startsWith('/Volumes/LifeWeave/Developer/CommandLine/'))
  const dir=await mkdtemp(path.join(process.env.TMPDIR!,'lyrics-root430-'));for(const name of ['source','stage'])await mkdir(path.join(dir,name),{mode:0o700})
  const datasetId=randomUUID(),epoch=randomUUID(),file=dir+'/catalog.sqlite';let alive=true
  const identity={datasetId,assertCurrent(){assert.ok(alive)}};let repository=createCollectionRepository({filePath:file,stagingRoot:dir+'/stage'})
  repository.localCatalog.privateBindWorkbenchDataset(identity)
  const source=repository.sources.authorize(randomUUID(),await authorizeSourceDirectory(dir+'/source')),root=repository.localCatalog.registerRoot({commandId:randomUUID(),sourceRootId:source.id,role:'library'}),wave=createCueSyntheticWave(),items:ScanPreparedItem[]=[]
  for(let index=0;index<2;index++){
    const relative='歌曲'+index+'.wav';await writeFile(dir+'/source/'+relative,wave.wave,{flag:'wx',mode:0o600});const info=await stat(dir+'/source/'+relative,{bigint:true})
    items.push({relative,signature:[info.dev,info.ino,info.size,info.mtimeNs,info.ctimeNs].join(':'),parserVersion:'controlled-root430',outcome:'accepted',fields:{title:'歌曲'+index,artist:'合成作者',album:'合成专辑',disc:'1',track:String(index+1)},failureCode:null,reused:false,
      readFacts:{technical:{container:'WAVE',codec:'PCM',lossless:true,sampleRateHz:wave.sampleRate,channels:wave.channels,bitsPerSample:24,durationSeconds:wave.frames/wave.sampleRate,evidence:'bounded-parser-reported'},coverEvidence:[],readEvidence:{bytesRead:44,readCalls:1,maxReadBytes:44,allocationBytes:44,elapsedMs:1,wholeAudioHash:false,wholeAudioDecode:false}}})
  }
  const job=repository.localScan.start({commandId:randomUUID(),datasetId,libraryRootId:root.id,expectedRootRevision:root.revision,parserVersion:'controlled-root430'}).job,running=repository.localScan.resume({commandId:randomUUID(),jobId:job.jobId,expectedRevision:job.jobRevision}),batch={batchId:randomUUID(),jobId:job.jobId,expectedJobRevision:running.jobRevision,checkpointBefore:running.checkpointRef,items,frontier:[],completed:true}
  repository.localScan.privatePrepareBatch({commandId:randomUUID(),jobId:job.jobId,batch});repository.localScan.privateCommitBatch({commandId:randomUUID(),jobId:job.jobId,batchId:batch.batchId,expectedRevision:running.jobRevision})
  function sqlScope(){return {revision:localLibraryManagementDigest([datasetId,repository.localCatalog.privateAlbumBrowserRevision(),repository.localScan.privateAlbumBrowserRevision(),null]),roots:[{root:repository.localCatalog.root(root.id),label:'受控源',availability:'ONLINE' as const}]}}
  function reader(){return createLocalWorkbenchReadService({datasetId,repository,assertCurrent:()=>identity.assertCurrent(),readRootViews:async()=>sqlScope().roots,localAlbums:{inspectAlbum(request){
    const members=repository.localCatalog.privateAlbumBrowserMembers({albumKey:request.albumKey,rootId:request.rootId,offset:0,limit:200},sqlScope()),issues=repository.localCatalog.privateAlbumBrowserIssues({albumKey:request.albumKey,rootId:request.rootId,offset:0,limit:200},sqlScope());assert.equal(members.total,2);assert.equal(members.items.length,members.total)
    return {summary:members.album,members:members.items,directory:members.directory,issues:issues.items,rejectedFiles:issues.rejectedFiles}
  }}})}
  let workbench=reader();const album=repository.localCatalog.privateAlbumBrowserQuery({rootId:root.id,query:'',filter:'all',offset:0,limit:1},sqlScope()).items[0]!,readback=await workbench.readAlbumTarget({albumId:album.id,rootId:root.id,revision:album.revision}),resolved=await workbench.resolveCapture({datasetId,capture:readback.albums[0]!.capture})
  const pin={libraryId:root.id,sourceRootId:source.id,rootRevision:root.revision},ref={albumId:album.id,rootId:root.id,revision:album.revision},captureId=resolved.capture.readToken
  const original:LocalLibraryManagementCaptureRecord['original']={mode:'albums',request:{albums:[ref]},captureId,watermark:resolved.datasetRevision,catalogRevision:repository.localCatalog.privateAlbumBrowserRevision(),scanRevision:repository.localScan.privateAlbumBrowserRevision(),libraries:[pin],albumRefs:[ref],albums:[{...pin,resolved:structuredClone(resolved)}]}
  const management:LocalLibraryManagementCaptureRecord={schema:1,kind:'capture',datasetId,key:captureId,revision:1,original,originalSha256:localLibraryManagementDigest(original)}
  repository.localCatalog.privateLibraryManagementCompareAndSwap(identity,[{record:management,expectedRevision:null}])
  const scope={datasetId,libraryId:root.id,albumId:album.id,captureId},stored=repository.localCatalog.privateLibraryManagementRead(identity,'capture',captureId)!
  const record:LocalLyricsRootCaptureRecord={schema:1,kind:'original-capture',datasetId,key:localLyricsRootCaptureKey(scope),revision:1,scope,ownerEpoch:epoch,fingerprint:localLibraryManagementDigest([epoch,resolved.datasetRevision,resolved.capture]),resolved:structuredClone(resolved),managementCapture:{key:captureId,ledgerSequence:stored.ledgerSequence,recordSha256:stored.recordSha256,originalSha256:management.originalSha256,...pin},resources:resolved.group.members.map(m=>({rootId:source.id,relative:m.fact.relative,pin:null})),observations:resolved.group.members.map(m=>({trackId:m.fact.summary.track.id,fileRevision:m.fact.summary.asset.fileRevision,lrc:'unknown',embedded:'unknown'}))}
  function seedSave(){const request={sessionId:randomUUID(),commandId:randomUUID(),embed:false},track=record.resolved.capture.members[0]!;assert.ok(track.trackId&&track.assetId)
    const selected={track:{trackId:track.trackId,title:track.title??'',artist:track.artist??'',album:track.album??'',language:'',version:'unknown' as const,durationMs:Math.round(wave.frames/wave.sampleRate*1000),wholeTrack:false,format:'wav' as const,rootRevision:track.rootRevision,fileRevision:track.fileRevision,locationRevision:track.locationRevision,metadataRevision:track.metadataRevision,lrc:'false' as const,embedded:'false' as const},candidateId:randomUUID(),source:'lrclib' as const,body:'[00:00.00]合成歌词\n',sha256:createHash('sha256').update('[00:00.00]合成歌词\n').digest('hex')}
    const draft={request,scope,captureFingerprint:record.fingerprint,selected:[selected]},intent={...draft,fingerprint:localLyricsIntentFingerprint(draft)}
    const save:LocalLyricsSaveRecord={intent,receipt:{commandId:request.commandId,sessionId:request.sessionId,state:'running',cover:'not-requested',snapshot:'not-requested',tracks:[{trackId:track.trackId,lrc:'pending',embed:'not-requested'}]},revision:0,physicalClosed:false,discarded:false}
    repository.localCatalog.privateLyricsCompareAndSwap(datasetId,'save',save,null)
    const snapshot:LocalLyricsRootSnapshotRecord={schema:1,kind:'save-snapshot',datasetId,key:request.commandId,revision:1,original:{request,scope,intentSha256:localLibraryManagementDigest(intent),captureSha256:record.fingerprint,originalCaptureKey:record.key},attempts:[{attempt:1,phase:'PREPARED',publicationPins:[],observations:null,observationsSha256:null,resources:null,error:null}]}
    return {save,snapshot}
  }
  async function cold(){workbench.close();repository.close();alive=false;repository=createCollectionRepository({filePath:file,stagingRoot:dir+'/stage'});alive=true;repository.localCatalog.privateBindWorkbenchDataset(identity);workbench=reader()}
  t.after(async()=>{workbench.close();if(alive){repository.close();alive=false}for(const item of items)assert.deepEqual(await readFile(dir+'/source/'+item.relative),wave.wave)})
  return {dir,file,identity,root,source,record,management,scope,wave,seedSave,cold,get repository(){return repository},get workbench(){return workbench}}
}

test('430原完整捕获在同SQLite冷恢复，原Owner指纹与管理ledger pin不刷新',async t=>{
  const f=await rootJournal430(t);f.repository.localCatalog.privateLyricsRootCompareAndSwap(f.identity,f.record,null)
  assert.equal(f.record.resolved.group.members.length,2);assert.equal(f.record.resources.length,2)
  const before=f.repository.localCatalog.privateLyricsRootRead(f.identity,'original-capture',f.record.key);await f.cold()
  assert.deepEqual(f.repository.localCatalog.privateLyricsRootRead(f.identity,'original-capture',f.record.key),before)
  assert.equal(f.repository.localCatalog.privateLyricsRootRead(f.identity,'save-snapshot',randomUUID()),null)
  assert.throws(()=>f.repository.localCatalog.privateLyricsRootRead({datasetId:f.identity.datasetId,assertCurrent(){}},'original-capture',f.record.key))
  assert.throws(()=>f.repository.localCatalog.privateLyricsRootCompareAndSwap(f.identity,{...f.record,ownerEpoch:randomUUID()},null))
})

test('430原捕获拒绝选中子集、错误管理原件和getter，完整原字段改变不产生新事实',async t=>{
  const f=await rootJournal430(t),catalog=f.repository.localCatalog;let reads=0
  for(const patch of [{resources:f.record.resources.slice(0,1)},{resolved:{...f.record.resolved,group:{...f.record.resolved.group,members:f.record.resolved.group.members.slice(0,1)}}},{managementCapture:{...f.record.managementCapture,recordSha256:'0'.repeat(64)}},{scope:{...f.scope,captureId:randomUUID()}}])assert.throws(()=>catalog.privateLyricsRootCompareAndSwap(f.identity,{...f.record,...patch},null))
  const getter={...f.record};Object.defineProperty(getter,'resources',{enumerable:true,get(){reads++;return f.record.resources}});assert.throws(()=>captureLocalLyricsRootRecord(getter));assert.equal(reads,0)
  assert.throws(()=>captureLocalLyricsRootRecord(new Proxy(f.record,{})));assert.equal(catalog.privateLyricsRootRead(f.identity,'original-capture',f.record.key),null)
  const track=f.record.resolved.group.members[1]!.fact.summary.track.id;catalog.overrideMetadata({commandId:randomUUID(),trackId:track,expectedRevision:null,fields:{title:'外部实际新标题'}})
  assert.throws(()=>catalog.privateLyricsRootCompareAndSwap(f.identity,f.record,null));assert.equal(catalog.privateLyricsRootRead(f.identity,'original-capture',f.record.key),null)
})

test('430快照失败attempt冷留存，原command正文只读重试不借旧scan lastSuccess',async t=>{
  const f=await rootJournal430(t),catalog=f.repository.localCatalog;catalog.privateLyricsRootCompareAndSwap(f.identity,f.record,null)
  const {snapshot,save}=f.seedSave();catalog.privateLyricsRootCompareAndSwap(f.identity,snapshot,null)
  const failed:LocalLyricsRootSnapshotRecord={...snapshot,revision:2,attempts:[{...snapshot.attempts[0]!,phase:'FAILED',error:'UNAVAILABLE'}]};catalog.privateLyricsRootCompareAndSwap(f.identity,failed,1);await f.cold()
  assert.deepEqual(f.repository.localCatalog.privateLyricsRootRead(f.identity,'save-snapshot',snapshot.key),failed)
  const retry:LocalLyricsRootSnapshotRecord={...failed,revision:3,attempts:[...failed.attempts,{...snapshot.attempts[0]!,attempt:2}]};f.repository.localCatalog.privateLyricsRootCompareAndSwap(f.identity,retry,2)
  assert.deepEqual(f.repository.localCatalog.privateLyricsRootRead(f.identity,'save-snapshot',snapshot.key)?.attempts[0],failed.attempts[0])
  for(const change of [{key:randomUUID()},{original:{...retry.original,request:{...save.intent.request,embed:true}}},{attempts:retry.attempts.slice(1)}])assert.throws(()=>f.repository.localCatalog.privateLyricsRootCompareAndSwap(f.identity,{...retry,...change,revision:4},3))
  assert.deepEqual(f.repository.localCatalog.privateLyricsRootRead(f.identity,'save-snapshot',snapshot.key),retry)
})

test('430没有完整CLOSED物理发布及全成员盘点的快照不能SAVED',async t=>{
  const f=await rootJournal430(t),catalog=f.repository.localCatalog;catalog.privateLyricsRootCompareAndSwap(f.identity,f.record,null)
  const {snapshot}=f.seedSave();catalog.privateLyricsRootCompareAndSwap(f.identity,snapshot,null)
  const observations=f.record.observations.map(row=>({...row,lrc:'true' as const,embedded:'false' as const})),attempt={...snapshot.attempts[0]!,phase:'SAVED' as const,observations,observationsSha256:localLibraryManagementDigest(observations),resources:f.record.resources}
  assert.throws(()=>catalog.privateLyricsRootCompareAndSwap(f.identity,{...snapshot,revision:2,attempts:[attempt]},1))
  const wrongPin={operationId:'1'.repeat(64),revision:8,ledgerSequence:500,publicationSequence:499,recordSha256:'2'.repeat(64),publicationSha256:'3'.repeat(64)}
  assert.throws(()=>catalog.privateLyricsRootCompareAndSwap(f.identity,{...snapshot,revision:2,attempts:[{...attempt,publicationPins:[wrongPin]}]},1))
  assert.deepEqual(catalog.privateLyricsRootRead(f.identity,'save-snapshot',snapshot.key),snapshot)
})

test('430查询先返回原session再准备整组，准备完成前选择和保存拒绝且取消实际join',async t=>{
  const f=fixture();t.after(()=>f.service.close());let started=false,quiet=false
  f.ports.capture.prepareQuery=async(c,signal)=>{assert.equal(c,f.capture);started=true;return new Promise((_resolve,reject)=>{signal.addEventListener('abort',()=>{setTimeout(()=>{quiet=true;reject(new Error('受控Native准备实际settle'))},10)},{once:true})})}
  const session=await f.service.query({scope:f.scope});assert.equal(started,true);assert.equal(session.state,'querying');assert.equal(f.calls.provider,0)
  await assert.rejects(f.service.select({sessionId:session.sessionId,trackId:'track',candidateId:null}));await assert.rejects(f.service.save({sessionId:session.sessionId,commandId:'original-command',embed:false}))
  assert.equal(f.calls.journal,0);assert.equal((await f.service.cancel({sessionId:session.sessionId})).state,'cancelled');assert.equal(quiet,true);assert.equal(f.calls.provider,0)
})

test('430准备回显必须是原全集fileRevision，迟到成员漂移不会查询Provider',async t=>{
  for(const failure of ['missing','revision','mutation'] as const){const f=fixture();t.after(()=>f.service.close());f.ports.capture.prepareQuery=async c=>{
    if(failure==='mutation')c.tracks=[{...c.tracks[0]!,title:'偷偷换掉的原文'}]
    return failure==='missing'?[]:[{trackId:'track',fileRevision:failure==='revision'?'changed':'file',lrc:'false',embedded:'false'}]
  }
  const session=await f.service.query({scope:f.scope});await f.service.wait(session.sessionId);assert.equal((await f.service.readSession({sessionId:session.sessionId})).state,'stale');assert.equal(f.calls.provider,0);assert.equal(f.calls.writer,0)}
})
