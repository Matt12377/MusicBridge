import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, mkdir, writeFile, readFile, stat, rm } from 'node:fs/promises'
import path from 'node:path'
import * as dto from '@music-bridge/contracts'
import { createCollectionRepository, CollectionError } from '../src/collection/repository.js'
import { createLocalAlbumOwnerService } from '../src/collection/local-album-browser/owner-port.js'
import { albumCatalogRevision, albumScanRevision } from '../src/collection/local-album-browser/owner-store.js'
import { captureLocalAlbumCaptureWrite, localAlbumScanPath, localAlbumScanPoint } from '../src/collection/local-album-browser/scan-delta.js'
import { createLocalWorkbenchReadService } from '../src/collection/local-library-workbench/read-service.js'
import { createLocalLibraryManagementBatchEvents, localLibraryManagementLedgerRow, localLibraryManagementDigest,
  type LocalLibraryManagementCaptureRecord, type LocalLibraryManagementBindingRecord, type LocalLibraryManagementOperationRecord } from '../src/collection/local-library-workbench/owner-journal.js'
import { authorizeSourceDirectory, sourceRootAvailability } from '../src/recording/source-files.js'
import type { ScanPreparedBatch, ScanPreparedItem } from '../src/collection/local-scan-store.js'
import { readLibraryOperationLine, type LibraryOperationEvent } from '../src/shared/library-operation-log.js'

const emptyPath={directories:[],cues:[]}
const point=(db:DatabaseSync)=>{const value=localAlbumScanPoint(db);assert.ok(value);return value}
const pair=(db:DatabaseSync)=>({catalog:albumCatalogRevision(db),scan:albumScanRevision(db)})
const coldPair=(file:string)=>{const db=new DatabaseSync(file);try{return pair(db)}finally{db.close()}}

/** 原真实Repository、审批Source账本、完整Scan批和catalog组织，全部位于外置合成目录。 */
async function fixture(t:test.TestContext,{members=2,beforeCommit}:{members?:number;beforeCommit?:(action:string)=>void}={}){
  const temporary=process.env.TMPDIR
  assert.ok(temporary); assert.ok(temporary.startsWith('/Volumes/LifeWeave/Developer/CommandLine/'))
  const directory=await mkdtemp(path.join(temporary,'mbf-capture-delta-')),media=path.join(directory,'source'),file=path.join(directory,'catalog.sqlite')
  await mkdir(media);await mkdir(path.join(media,'专辑'))
  const repository=createCollectionRepository({filePath:file,...(beforeCommit?{beforeCommit}:{})}),datasetId=randomUUID();let alive=true
  const identity={datasetId,assertCurrent(){assert.equal(alive,true)}};repository.localCatalog.privateBindWorkbenchDataset(identity)
  const source=repository.sources.authorize(randomUUID(),await authorizeSourceDirectory(media)),catalog=repository.localCatalog,scan=repository.localScan
  const root=catalog.registerRoot({commandId:randomUUID(),sourceRootId:source.id,role:'library'}),items:ScanPreparedItem[]=[],originals:{relative:string;bytes:Buffer}[]=[]
  for(let index=0;index<members;index++){
    const relative='专辑/原音轨'+index+'.flac',bytes=Buffer.from('自有合成捕获原件-'+index);await writeFile(path.join(media,relative),bytes);originals.push({relative,bytes})
    const info=await stat(path.join(media,relative),{bigint:true})
    items.push({relative,signature:[info.dev,info.ino,info.size,info.mtimeNs,info.ctimeNs].join(':'),parserVersion:'capture-delta-v1',outcome:'accepted',
      fields:{title:'原曲'+index,artist:'合成作者',album:'完整合成专辑',track:String(index+1)},failureCode:null,reused:false,
      readFacts:{technical:{container:'FLAC',codec:'FLAC',lossless:true,sampleRateHz:44100,channels:2,bitsPerSample:16,durationSeconds:2,evidence:'bounded-parser-reported'},coverEvidence:[],
        readEvidence:{bytesRead:32,readCalls:1,maxReadBytes:32,allocationBytes:32,elapsedMs:1,wholeAudioHash:false,wholeAudioDecode:false}}})
  }
  const started=scan.start({commandId:randomUUID(),datasetId,libraryRootId:root.id,expectedRootRevision:root.revision,parserVersion:'capture-delta-v1'}).job
  const running=scan.resume({commandId:randomUUID(),jobId:started.jobId,expectedRevision:started.jobRevision})
  catalog.privateScanSettingsStore(identity).freeze(identity,{schema:1,datasetId,eventId:randomUUID(),commandId:randomUUID(),kind:'launch',frozen:{jobId:running.jobId,settingsRevision:'1',albumConcurrency:12,readerConcurrency:1}})
  const batch:ScanPreparedBatch={batchId:randomUUID(),jobId:running.jobId,expectedJobRevision:running.jobRevision,checkpointBefore:running.checkpointRef,items,frontier:[],completed:true}
  scan.privatePrepareBatch({commandId:randomUUID(),jobId:running.jobId,batch});scan.privateCommitBatch({commandId:randomUUID(),jobId:running.jobId,batchId:batch.batchId,expectedRevision:running.jobRevision})
  const commandId=randomUUID(),operation:LocalLibraryManagementOperationRecord={schema:1,kind:'operation',datasetId,key:commandId,revision:1,
    original:{command:'library.import.confirm',request:{commandId,choiceId:'controlled-source-choice',role:'catalog'}},originalSha256:'',
    receipt:{commandId,kind:'library.import.confirm',state:'succeeded',libraryIds:[root.id],message:null}}
  operation.originalSha256=localLibraryManagementDigest(operation.original)
  const binding:LocalLibraryManagementBindingRecord={schema:1,kind:'binding',datasetId,key:root.id,revision:1,libraryId:root.id,sourceRootId:source.id,rootRevision:root.revision,
    role:'catalog',name:'原合成库',active:true,watchEnabled:false,operationId:commandId}
  catalog.privateLibraryManagementCompareAndSwap(identity,[{record:binding,expectedRevision:null},{record:operation,expectedRevision:null}])
  const roots=async():Promise<dto.LocalRootView[]>=>{const current=catalog.root(root.id),capability=repository.sources.root(current.sourceRootId);return [{root:current,label:capability.label,availability:await sourceRootAvailability(capability)}]}
  const owner=createLocalAlbumOwnerService({repository,datasetId,assertCurrent:()=>identity.assertCurrent(),readRootViews:roots,
    readLibraryOrganizations:()=>catalog.privateLibraryManagementOrganizations(identity),readArtwork:async()=>({image:null,status:'ready'})})
  const workbench=createLocalWorkbenchReadService({datasetId,repository,localAlbums:owner,assertCurrent:()=>identity.assertCurrent(),readRootViews:roots,
    readAuthorRevision:()=>catalog.privateWorkbenchMBOnlyAuthorRevision(identity)})
  const database=catalog.privateRead(db=>db)
  t.after(async()=>{workbench.close();owner.close();repository.close();alive=false;for(const original of originals)assert.deepEqual(await readFile(path.join(media,original.relative)),original.bytes);await rm(directory,{recursive:true})})
  const query={rootId:root.id,query:'',filter:'all' as const,offset:0,limit:200}
  return {repository,catalog,scan,identity,datasetId,source,root,owner,workbench,database,file,query,members}
}
type Fixture=Awaited<ReturnType<typeof fixture>>
/** 同真正remember的完整正文构造；复用真实readUnleasedAlbum，不复制捕获/授权实现。 */
async function capture(f:Fixture):Promise<LocalLibraryManagementCaptureRecord>{
  const page=await f.owner.queryAlbums(f.query),album=page.items[0]!;assert.ok(album)
  const ref={albumId:album.id,rootId:album.rootId,revision:album.revision},resolved=await f.workbench.readUnleasedAlbum(ref)
  const key=resolved.capture.readToken,pin={libraryId:f.root.id,sourceRootId:f.source.id,rootRevision:f.root.revision}
  const original:LocalLibraryManagementCaptureRecord['original']={mode:'albums',request:{albums:[ref]},captureId:key,watermark:resolved.datasetRevision,
    catalogRevision:f.catalog.privateAlbumBrowserRevision(),scanRevision:f.scan.privateAlbumBrowserRevision(),libraries:[pin],albumRefs:[ref],albums:[{...pin,resolved:structuredClone(resolved)}]}
  return {schema:1,kind:'capture',datasetId:f.datasetId,key,revision:1,original,originalSha256:localLibraryManagementDigest(original)}
}
function cloneCapture(value:LocalLibraryManagementCaptureRecord):LocalLibraryManagementCaptureRecord{
  const key=randomUUID(),original={...value.original,captureId:key}
  return {...value,key,original,originalSha256:localLibraryManagementDigest(original)}
}
function rows(record:LocalLibraryManagementCaptureRecord){return createLocalLibraryManagementBatchEvents([{record,previous:null}]).map(localLibraryManagementLedgerRow)}
function insertRows(db:DatabaseSync,values:readonly Record<string,string>[]){for(const row of values)db.prepare('INSERT INTO local_catalog_ledger VALUES(?,?,?,?,?,?)').run(row.command_id!,row.fingerprint!,row.operation!,row.request!,row.result!,row.created_at!)}
function probe(t:test.TestContext,f:Fixture){
  const calls={catalog:0,scan:0,barrier:0},prepare=f.database.prepare.bind(f.database)
  t.mock.method(f.database,'prepare',(sql:string)=>{const statement=prepare(sql),aggregate=sql.startsWith('SELECT count(*) n, coalesce(max(rowid),0) last FROM '),barrier=sql==='SELECT total_changes() n'||sql==='PRAGMA data_version'||sql==='PRAGMA schema_version'
    if(aggregate||barrier){const get=statement.get.bind(statement);Object.defineProperty(statement,'get',{value(...args:Parameters<typeof get>){if(aggregate)calls[/FROM (?:local_scan_|local_cue_sources)/u.test(sql)?'scan':'catalog']++;if(barrier)calls.barrier++;return get(...args)}})}return statement})
  return {calls,snapshot:()=>({...calls}),read:()=>pair(f.database),guarded:()=>({catalog:f.catalog.privateAlbumBrowserRevision(),scan:f.scan.privateAlbumBrowserRevision()})}
}
function notRecomputed(p:ReturnType<typeof probe>,before:ReturnType<ReturnType<typeof probe>['snapshot']>){assert.equal(p.calls.catalog,before.catalog);assert.equal(p.calls.scan,before.scan);assert.ok(p.calls.barrier>before.barrier)}
function recomputed(p:ReturnType<typeof probe>,before:ReturnType<ReturnType<typeof probe>['snapshot']>){assert.ok(p.calls.catalog>before.catalog);assert.ok(p.calls.scan>before.scan)}
function logs(t:test.TestContext){const events:LibraryOperationEvent[]=[];t.mock.method(console,'info',(...args:unknown[])=>{for(const line of args)if(typeof line==='string'&&line.startsWith('[MB_LIBRARY_OPERATION] ')){const event=readLibraryOperationLine(line);assert.ok(event);events.push(event)}});return events}

test('捕获提交证书：真实CAS后catalog/scan零聚合重算，下一页保持原Compact和完整成员',async t=>{
  const f=await fixture(t),p=probe(t,f),events=logs(t),initial=await f.owner.queryAlbums(f.query),baseline=p.guarded()
  assert.ok(p.calls.catalog>0&&p.calls.scan>0);assert.equal(events.filter(e=>e.code==='COMPACT_BUILT').length,1)
  for(let index=0;index<3;index++){
    const value=await capture(f),before=point(f.database),counts=p.snapshot(),saved=f.catalog.privateLibraryManagementCompareAndSwap(f.identity,[{record:value,expectedRevision:null}]),after=point(f.database)
    assert.ok(after.changes>before.changes);assert.equal(saved.records.length,1);assert.deepEqual(saved.records[0]!.record,value)
    assert.deepEqual(localAlbumScanPath(f.database,before,after),emptyPath)
    assert.deepEqual(localAlbumScanPath(f.database,before,after,{revisionStableOnly:true}),emptyPath)
    assert.equal(localAlbumScanPath(f.database,before,after,{queueOnly:true}),null,'capture绝不冒充原队列证书')
    assert.deepEqual(p.guarded(),baseline);notRecomputed(p,counts)
    const page=await f.owner.queryAlbums(f.query);assert.deepEqual(page,initial)
    assert.equal(events.filter(e=>e.code==='COMPACT_BUILT').length,1,'capture不能使下一次浏览重建全根')
    assert.equal(value.original.albums[0]!.resolved.group.members.length,f.members)
  }
  assert.deepEqual(coldPair(f.file),baseline)
})

test('捕获提交证书：未知前置写留缺链，beforeCommit附加写或回滚不发布任何capture段',async t=>{
  for(const mode of ['before','inside','rollback'] as const)await t.test(mode,async t=>{
    let injected:(()=>void)|undefined
    const f=await fixture(t,{beforeCommit:action=>{if(action==='local-library-management:cas')injected?.()}}),p=probe(t,f)
    f.database.exec('CREATE TABLE owned_capture_noise(n INTEGER NOT NULL); INSERT INTO owned_capture_noise VALUES(0)')
    const value=await capture(f),baseline=p.guarded(),before=point(f.database),counts=p.snapshot()
    const change=()=>f.database.exec('UPDATE owned_capture_noise SET n=n+1')
    if(mode==='before')change()
    else injected=mode==='inside'?change:()=>{throw new CollectionError('INVENTORY_CONFLICT','合成capture提交前回滚')}
    if(mode==='before')f.catalog.privateLibraryManagementCompareAndSwap(f.identity,[{record:value,expectedRevision:null}])
    else assert.throws(()=>f.catalog.privateLibraryManagementCompareAndSwap(f.identity,[{record:value,expectedRevision:null}]))
    injected=undefined;const after=point(f.database);assert.ok(after.changes>before.changes);assert.equal(f.database.isTransaction,false)
    assert.equal(localAlbumScanPath(f.database,before,after,{revisionStableOnly:true}),null)
    if(mode!=='before')assert.equal(f.catalog.privateLibraryManagementRead(f.identity,'capture',value.key),null)
    assert.deepEqual(p.guarded(),baseline);recomputed(p,counts);assert.deepEqual(coldPair(f.file),baseline)
  })
})

test('捕获提交证书：混入真实operation不认证，普通空scan段仍改变scan修订',async t=>{
  const f=await fixture(t),p=probe(t,f),value=await capture(f),baseline=p.guarded(),before=point(f.database),commandId=randomUUID()
  const operation:LocalLibraryManagementOperationRecord={schema:1,kind:'operation',datasetId:f.datasetId,key:commandId,revision:1,
    original:{command:'library.watch.set',request:{commandId,libraryId:f.root.id,enabled:false}},originalSha256:'',
    receipt:{commandId,kind:'library.watch.set',state:'running',libraryIds:[f.root.id],message:null}}
  operation.originalSha256=localLibraryManagementDigest(operation.original)
  f.catalog.privateLibraryManagementCompareAndSwap(f.identity,[{record:value,expectedRevision:null},{record:operation,expectedRevision:null}])
  const counts=p.snapshot(),after=point(f.database);assert.equal(localAlbumScanPath(f.database,before,after,{revisionStableOnly:true}),null)
  const mixed=p.guarded();assert.notEqual(mixed.catalog,baseline.catalog);assert.equal(mixed.scan,baseline.scan);recomputed(p,counts)
  const started=f.scan.start({commandId:randomUUID(),datasetId:f.datasetId,libraryRootId:f.root.id,expectedRootRevision:f.root.revision,parserVersion:'capture-delta-v1'}).job
  const running=f.scan.resume({commandId:randomUUID(),jobId:started.jobId,expectedRevision:started.jobRevision})
  f.catalog.privateScanSettingsStore(f.identity).freeze(f.identity,{schema:1,datasetId:f.datasetId,eventId:randomUUID(),commandId:randomUUID(),kind:'launch',frozen:{jobId:running.jobId,settingsRevision:'1',albumConcurrency:12,readerConcurrency:1}})
  const batch:ScanPreparedBatch={batchId:randomUUID(),jobId:running.jobId,expectedJobRevision:running.jobRevision,checkpointBefore:running.checkpointRef,items:[],frontier:[],completed:true}
  f.scan.privatePrepareBatch({commandId:randomUUID(),jobId:running.jobId,batch})
  const prior=p.guarded(),scanBefore=point(f.database)
  f.scan.privateCommitBatch({commandId:randomUUID(),jobId:running.jobId,batchId:batch.batchId,expectedRevision:running.jobRevision})
  assert.deepEqual(localAlbumScanPath(f.database,scanBefore,point(f.database)),emptyPath)
  assert.equal(localAlbumScanPath(f.database,scanBefore,point(f.database),{revisionStableOnly:true}),null)
  const scanCounts=p.snapshot(),current=p.guarded();assert.equal(current.catalog,prior.catalog);assert.notEqual(current.scan,prior.scan);recomputed(p,scanCounts)
  assert.deepEqual(coldPair(f.file),current)
})

test('捕获提交证书：外部真实提交/schema与显式事务保原聚合和首末屏障',async t=>{
  for(const mode of ['external','schema','transaction'] as const)await t.test(mode,async t=>{
    const f=await fixture(t),p=probe(t,f);f.database.exec('CREATE TABLE owned_capture_external(n INTEGER NOT NULL); INSERT INTO owned_capture_external VALUES(0)')
    const value=await capture(f);f.catalog.privateLibraryManagementCompareAndSwap(f.identity,[{record:value,expectedRevision:null}]);const baseline=p.guarded(),before=point(f.database)
    if(mode==='external'){const other=new DatabaseSync(f.file);try{other.exec('UPDATE owned_capture_external SET n=n+1')}finally{other.close()};assert.notEqual(point(f.database).version,before.version)}
    else if(mode==='schema'){f.database.exec('CREATE TABLE owned_capture_schema(value TEXT)');assert.notEqual(point(f.database).schema,before.schema)}
    else f.database.exec('BEGIN')
    try{let counts=p.snapshot();assert.deepEqual(p.read(),baseline);recomputed(p,counts)
      if(mode==='transaction'){counts=p.snapshot();assert.deepEqual(p.read(),baseline);recomputed(p,counts)}}finally{if(f.database.isTransaction)f.database.exec('ROLLBACK')}
    assert.deepEqual(coldPair(f.file),baseline)
  })
})

test('捕获提交证书：真实回读不符、缺commit、hash不符和approve后写入均不补空链',async t=>{
  for(const mode of ['readback','truncated','hash','after-approve','rollback','nested'] as const)await t.test(mode,async t=>{
    const f=await fixture(t),value=await capture(f);f.database.exec('CREATE TABLE owned_capture_post(n INTEGER NOT NULL); INSERT INTO owned_capture_post VALUES(0)')
    let actual=rows(value)
    if(mode==='truncated')actual=actual.slice(0,-1)
    if(mode==='hash')actual=createLocalLibraryManagementBatchEvents([{record:value,previous:null}]).map(event=>localLibraryManagementLedgerRow({...event,frameSha256:'0'.repeat(64)}))
    const before=point(f.database)
    if(mode==='nested')f.database.exec('BEGIN')
    const certificate=captureLocalAlbumCaptureWrite(f.database,f.datasetId)
    if(!f.database.isTransaction)f.database.exec('BEGIN IMMEDIATE')
    insertRows(f.database,actual)
    const expected=mode==='readback'?actual.map(row=>({...row,created_at:'2026-01-01T00:00:00.000Z'})):actual
    certificate.approve(expected)
    if(mode==='after-approve')f.database.exec('UPDATE owned_capture_post SET n=n+1')
    f.database.exec(mode==='rollback'?'ROLLBACK':'COMMIT');certificate.publish()
    assert.equal(localAlbumScanPath(f.database,before,point(f.database)),null)
    assert.equal(localAlbumScanPath(f.database,before,point(f.database),{revisionStableOnly:true}),null)
  })
})

test('捕获提交证书：超过单证书字节预算的原合法完整capture仍持久化，只弃派生证明',async t=>{
  const f=await fixture(t,{members:8}),p=probe(t,f),original=await capture(f),records=Array.from({length:80},()=>cloneCapture(original))
  const encoded=createLocalLibraryManagementBatchEvents(records.map(record=>({record,previous:null}))).map(localLibraryManagementLedgerRow)
  assert.ok(encoded.reduce((sum,row)=>sum+Object.values(row).reduce((n,value)=>n+Buffer.byteLength(value),0),0)>1024*1024,'fixture必须真正超1MiB')
  const baseline=p.guarded(),before=point(f.database)
  const saved=f.catalog.privateLibraryManagementCompareAndSwap(f.identity,records.map(record=>({record,expectedRevision:null})))
  assert.equal(saved.records.length,records.length);assert.deepEqual(saved.records.map(v=>v.record),records)
  assert.equal(localAlbumScanPath(f.database,before,point(f.database),{revisionStableOnly:true}),null)
  const counts=p.snapshot();assert.deepEqual(p.guarded(),baseline);recomputed(p,counts)
  for(const record of records)assert.ok(f.catalog.privateLibraryManagementRead(f.identity,'capture',record.key))
  assert.deepEqual(coldPair(f.file),baseline)
})

test('捕获提交证书：滑窗逐出旧完整起点，近期consumer仍能跨窗续读，队列原标记不串用',async t=>{
  const f=await fixture(t),p=probe(t,f),original=await capture(f),baseline=p.guarded(),old=point(f.database)
  // 直接对原真实SQLite执行固定capture行，用于独立检验私有证书滑窗；业务正例已走原CAS。
  const commit=()=>{const record=cloneCapture(original),certificate=captureLocalAlbumCaptureWrite(f.database,f.datasetId),before=point(f.database),values=rows(record);f.database.exec('BEGIN IMMEDIATE');insertRows(f.database,values);certificate.approve(values);f.database.exec('COMMIT');certificate.publish();return {before,after:point(f.database)}}
  for(let index=0;index<129;index++)commit()
  assert.equal(localAlbumScanPath(f.database,old,point(f.database),{revisionStableOnly:true}),null)
  let counts=p.snapshot();assert.deepEqual(p.read(),baseline);recomputed(p,counts)
  for(let index=0;index<140;index++){
    const edge=commit();assert.deepEqual(localAlbumScanPath(f.database,edge.before,edge.after,{revisionStableOnly:true}),emptyPath)
    assert.equal(localAlbumScanPath(f.database,edge.before,edge.after,{queueOnly:true}),null)
    counts=p.snapshot();assert.deepEqual(p.read(),baseline);notRecomputed(p,counts)
  }
  assert.deepEqual(coldPair(f.file),baseline)
})
