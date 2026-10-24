import assert from 'node:assert/strict'
import test from 'node:test'
import {createHash} from 'node:crypto'
import {DatabaseSync} from 'node:sqlite'
import {mkdtempSync,rmSync} from 'node:fs'
import path from 'node:path'
import * as catalog from '../../src/collection/local-catalog-store.js'
import {createLocalAlbumSqlReader} from '../../src/collection/local-album-browser/sql-read.js'
import type {LocalAlbumSqlSource} from '../../src/collection/local-album-browser/sql-types.js'
import {createCollectionRepository} from '../../src/collection/repository.js'
import {largeMobileFixture,mobileMembers,syntheticId} from './local-album-mobile-large-fixture.js'

// 旧实现不存在getter时仍实际执行原SQL，RED落在真实后缀工作量而非导入错误。
const observationSource=(db:Parameters<typeof catalog.verifyLocalCatalogDatabase>[0])=>(catalog as unknown as {localCatalogLibraryObservationSourceForDatabase?:(db:Parameters<typeof catalog.verifyLocalCatalogDatabase>[0])=>Partial<LocalAlbumSqlSource>|undefined}).localCatalogLibraryObservationSourceForDatabase?.(db)

test('8.2万轨/十万合法后缀：完整冷核后的旧观察ordinal索引不再逐页全扫ledger', {timeout:180000},t=>{
  const f=largeMobileFixture({observations:true,auditedHistory:true});t.after(()=>f.close())
  const insert=f.db.prepare('INSERT INTO local_catalog_observations VALUES(?,?,?)')
  const anchor=Number(f.db.prepare('SELECT max(rowid) n FROM local_catalog_ledger').get()!.n)
  for(let n=1;n<=100;n++)f.raw.get(syntheticId(1000000+n))!.ordinal=anchor
  f.db.exec('BEGIN')
  try{
    for(let n=1;n<=100000;n++){
      const trackId=syntheticId(1000000+f.tracks-999+(n-1)%1000),fields={title:'合成后续观察'+String(n).padStart(8,'0')+'x'.repeat(450),artist:'合成后续艺人'+'y'.repeat(450)}
      const result={id:syntheticId(600000000+n),trackId,revision:String(2+Math.floor((n-1)/1000)),source:'synthetic',parserVersion:'synthetic-history-v1',fields}
      f.appendLegal('observe-metadata',{trackId,source:'synthetic',parserVersion:'synthetic-history-v1',fields},result)
      insert.run(result.id,trackId,JSON.stringify(result))
    }
    f.db.exec('COMMIT')
  }catch(error){f.db.exec('ROLLBACK');throw error}
  const auditStarted=performance.now();f.verifyHistory();const auditMs=performance.now()-auditStarted
  let visits=0
  f.db.function('mb_history_index_visit',{deterministic:false},()=>{visits++;return 1})
  const instrument=(sql:string)=>sql.includes('mb_history_index_visit()')?sql:sql.replaceAll("AND l.operation='observe-metadata'","AND mb_history_index_visit()=1 AND l.operation='observe-metadata'")
  f.source.projectionSql=instrument(f.source.projectionSql)
  let reader=f.makeReader();reader.queryMobile(mobileMembers({kind:'groups'}));f.reset();visits=0
  const beforeStarted=performance.now(),before=reader.queryMobile(mobileMembers()),beforeMs=performance.now()-beforeStarted,beforeVisits=visits
  const indexed=observationSource(f.db)
  if(indexed)Object.assign(f.source,indexed)
  // 同一真实生产SQL常量继续计数；快路为惰性时不应执行旧后缀。
  f.source.projectionSql=instrument(f.source.projectionSql)
  reader=f.makeReader();reader.queryMobile(mobileMembers({kind:'groups'}));f.reset();visits=0
  const afterStarted=performance.now(),after=reader.queryMobile(mobileMembers()),afterMs=performance.now()-afterStarted
  assert.deepEqual(after,before);assert.equal(after.items.length,100);assert.equal(after.total,82000)
  const result={synthetic:true,tracks:f.tracks,albums:10000,suffix:100000,auditMs,beforeMs,afterMs,beforeVisits,afterVisits:visits,indexActivated:indexed!==undefined,counters:{...f.counters},outputSha256:createHash('sha256').update(JSON.stringify(after)).digest('hex')}
  t.diagnostic(JSON.stringify(result))
  assert.ok(beforeVisits>=100000,'原43须实际执行后缀范围，不能用无效fixture制造性能通过')
  assert.ok(visits<=100,'完整历史已核且同DB水位未变，不应为旧观察再扫十万ledger')
  assert.ok(f.counters.source>0&&f.counters.track>=100&&f.counters.scan>=100&&f.counters.asset>=100,'每页Source/Scan/实体codec仍实际执行')
})

function observe(f:ReturnType<typeof largeMobileFixture>,track:number,revision:number,fields:Record<string,string>,rowId?:number){
  const trackId=syntheticId(1000000+track),id=syntheticId(650000000+track*1000+revision),result={id,trackId,revision:String(revision),source:'synthetic',parserVersion:'synthetic-history-v1',fields}
  const ordinal=f.appendLegal('observe-metadata',{trackId,source:'synthetic',parserVersion:'synthetic-history-v1',fields},result)
  if(rowId===undefined)f.db.prepare('INSERT INTO local_catalog_observations VALUES(?,?,?)').run(id,trackId,JSON.stringify(result))
  else f.db.prepare('INSERT INTO local_catalog_observations(rowid,id,track_id,data) VALUES(?,?,?,?)').run(rowId,id,trackId,JSON.stringify(result))
  return ordinal
}
function indexedSource(f:ReturnType<typeof largeMobileFixture>):LocalAlbumSqlSource{
  const indexed=observationSource(f.db);assert.ok(indexed,'必须由真实完整冷核发放，不可只预填lookup')
  return {...f.source,...indexed}
}
function page(f:ReturnType<typeof largeMobileFixture>,source:LocalAlbumSqlSource){const reader=createLocalAlbumSqlReader(f.db,source,f.codec,f.scope);reader.queryMobile(mobileMembers({kind:'groups'}));return reader.queryMobile(mobileMembers())}

test('逐Source序号/部分字段/无Source/override及原rowid顺序与43完全一致',t=>{
  const f=largeMobileFixture({groups:24,singles:0,members:5,observations:true,auditedHistory:true});t.after(()=>f.close())
  const a=observe(f,1,2,{title:'先ledger后rowid'},1001),b=observe(f,1,3,{title:'后ledger先rowid',artist:'后来的艺人'},1000)
  f.raw.get(syntheticId(1000001))!.ordinal=a-1
  f.raw.get(syntheticId(1000002))!.ordinal=b
  f.raw.get(syntheticId(1000002))!.fields={title:'Source覆盖旧观察',album:'Album 0'}
  f.raw.delete(syntheticId(1000003))
  const result={trackId:syntheticId(1000004),revision:'1',fields:{title:'人工覆盖'}}
  f.appendLegal('override-metadata',{trackId:result.trackId,expectedRevision:null,fields:result.fields},result)
  f.db.prepare('INSERT INTO local_catalog_overrides VALUES(?,?)').run(result.trackId,JSON.stringify(result))
  assert.equal(observationSource(f.db),undefined);f.verifyHistory()
  const expected=page(f,f.source),actual=page(f,indexedSource(f));assert.deepEqual(actual,expected)
  const first=actual.items.find(row=>row.member?.fact.summary.track.id===syntheticId(1000001))!.member!.fact
  assert.equal(first.rawMetadata.title,'先ledger后rowid');assert.equal(first.rawMetadata.artist,'后来的艺人')
  assert.ok(f.counters.source>0&&f.counters.scan>=100)
})

test('未知/跨DB句柄不能替代ledger；同ID不同ordinal仍取本DB事实',t=>{
  const a=largeMobileFixture({groups:1,singles:0,members:1,roots:6,observations:true,auditedHistory:true}),b=largeMobileFixture({groups:1,singles:0,members:1,roots:5,observations:true,auditedHistory:true});t.after(()=>{a.close();b.close()})
  a.verifyHistory();b.verifyHistory();const foreign=observationSource(a.db);assert.ok(foreign)
  b.raw.get(syntheticId(1000001))!.ordinal=8;b.raw.get(syntheticId(1000001))!.fields={title:'本DB Source覆盖',album:'Album 0'}
  const expected=page(b,b.source),cross=page(b,{...b.source,...foreign});assert.deepEqual(cross,expected)
  const forged={...b.source,...foreign,observationHistory:new Proxy({}, {get(){throw new Error('不得读取外部句柄')}})} as unknown as LocalAlbumSqlSource
  assert.deepEqual(page(b,forged),expected)
})

test('SQLite变更/新冷核作者/读中撤销均不复用旧事实，失败后仍读原SQL',t=>{
  const f=largeMobileFixture({groups:24,singles:0,members:5,observations:true,auditedHistory:true});t.after(()=>f.close());f.verifyHistory()
  const source=indexedSource(f),before=page(f,source)
  observe(f,1,2,{title:'本次真实新观察'})
  assert.equal(observationSource(f.db),undefined)
  const expected=page(f,f.source),stale=page(f,source);assert.deepEqual(stale,expected);assert.notDeepEqual(stale,before)
  f.verifyHistory();const current=indexedSource(f);assert.notEqual(current.observationHistory,source.observationHistory)
  assert.deepEqual(page(f,source),page(f,current))
  const reader=createLocalAlbumSqlReader(f.db,current,f.codec,f.scope);reader.queryMobile(mobileMembers({kind:'groups'}));let changed=false
  f.afterSource(()=>{if(!changed){changed=true;observe(f,2,2,{title:'SQL执行中改变'})}})
  assert.throws(()=>reader.queryMobile(mobileMembers()),{code:'SNAPSHOT_CHANGED'});f.afterSource()
  assert.deepEqual(page(f,current),page(f,f.source))
  f.revoke();assert.throws(()=>page(f,current),{code:'UNAVAILABLE'})
})

test('每曲第202候选仍回原43；冷核关系不改变200读取预算或原Source裁旧',t=>{
  const f=largeMobileFixture({groups:1,singles:0,members:1,observations:true,auditedHistory:true});t.after(()=>f.close())
  let anchor=0;for(let revision=2;revision<=202;revision++)anchor=observe(f,1,revision,{title:'合法历史'+revision})
  f.raw.get(syntheticId(1000001))!.ordinal=anchor;f.raw.get(syntheticId(1000001))!.fields={title:'Source裁旧后标题',album:'Album 0'}
  f.verifyHistory();const source=indexedSource(f),expected=page(f,f.source);f.reset();assert.deepEqual(page(f,source),expected)
  assert.equal(f.udf.mb_album_observation_after!>0,true)
})

test('零/负/不安全rowid保持合法原读取并仅对该曲回退',t=>{
  for(const rowId of [0,-1,9007199254740992]){
    const f=largeMobileFixture({groups:1,members:1,singles:0,observations:true,auditedHistory:true});t.after(()=>f.close())
    observe(f,1,2,{title:'原rowid顺序'},rowId);f.verifyHistory()
    const source=indexedSource(f),expected=page(f,f.source);f.reset();assert.deepEqual(page(f,source),expected)
    assert.ok(f.udf.mb_album_observation_after!>0,'仍实际选择已冷核作者；unsupported rowid仅在闭集函数中回原43')
  }
})

test('32MiB共享结构超限即全局fallback，不因118k真实首观察提高预算', {timeout:120000},t=>{
  const f=largeMobileFixture({groups:10000,members:13,singles:1000,observations:true,auditedHistory:true});t.after(()=>f.close())
  assert.equal(f.tracks,118000);f.verifyHistory();assert.equal(observationSource(f.db),undefined)
  const actual=page(f,f.source);assert.equal(actual.items.length,100);assert.equal(actual.total,118000)
  assert.ok(f.counters.source>0&&f.counters.scan>=100)
})

test('Source关闭临时只读冷核不能发布跨事务作者',t=>{
  assert.ok(process.env.TMPDIR?.startsWith('/Volumes/LifeWeave/Developer/CommandLine/tmp/'))
  const directory=mkdtempSync(path.join(process.env.TMPDIR!,'observation-closing-')),file=path.join(directory,'synthetic.sqlite')
  const f=largeMobileFixture({databasePath:file,groups:1,members:1,singles:0,observations:true,auditedHistory:true});t.after(()=>{f.close();rmSync(directory,{recursive:true,force:true})});f.verifyHistory()
  const access={read<T>(read:(db:DatabaseSync)=>T){return read(f.db)},sources:{root(){return {authorized:true} as never}},conflict(message:string):never{throw new Error(message)}}
  const store=catalog.createLocalCatalogStore(access),identity={datasetId:syntheticId(999),assertCurrent(){}};store.privateBindWorkbenchDataset(identity)
  const other=new DatabaseSync(file);other.exec('CREATE TABLE extra_synthetic(value INTEGER)');other.close()
  let temporary:Partial<LocalAlbumSqlSource>|undefined
  assert.equal(store.privateSourceWritesClosingRead(identity,()=>{temporary=observationSource(f.db);assert.ok(temporary);return true}),true)
  assert.ok(temporary);assert.equal(observationSource(f.db),undefined)
  f.db.exec('BEGIN');try{assert.deepEqual(page(f,{...f.source,...temporary}),page(f,f.source))}finally{f.db.exec('ROLLBACK')}
})

test('启动COMMIT恰一次衔接；rollback/提交失败/恢复写及旁注失败均不发布作者',t=>{
  const make=()=>largeMobileFixture({groups:1,members:1,singles:0,observations:true,auditedHistory:true})
  const f=make();t.after(()=>f.close());const nativeExec=f.db.exec;let commits=0
  f.db.exec=function(sql:string){if(sql==='COMMIT')commits++;return nativeExec.call(f.db,sql)}
  f.db.exec('BEGIN IMMEDIATE');f.verifyHistory();const inside=observationSource(f.db);assert.ok(inside)
  catalog.commitLocalCatalogStartupAudit(f.db);assert.equal(commits,1);assert.equal(f.db.isTransaction,false)
  const outside=indexedSource(f);assert.notEqual(outside.observationHistory,inside.observationHistory)
  assert.deepEqual(page(f,outside),page(f,f.source))
  assert.throws(()=>catalog.commitLocalCatalogStartupAudit(f.db));assert.equal(commits,2,'失败提交也只尝试原COMMIT一次');assert.equal(observationSource(f.db),undefined)
  f.db.exec('BEGIN');f.verifyHistory();f.db.exec('ROLLBACK');assert.equal(observationSource(f.db),undefined)
  f.db.exec('BEGIN');f.verifyHistory();f.db.prepare('INSERT INTO source_roots VALUES(?)').run(syntheticId(987654321));catalog.commitLocalCatalogStartupAudit(f.db)
  assert.equal(observationSource(f.db),undefined,'恢复阶段即使仅写其他表，也不能迁移total_changes作者')
  for(const failAt of [1,2]){
    f.db.exec('BEGIN');f.verifyHistory();const prepare=f.db.prepare;let pointReads=0
    f.db.prepare=function(sql:string){if(sql.startsWith('SELECT total_changes() AS changes')&&++pointReads===failAt)throw new Error('合成缓存旁注失败');return prepare.call(f.db,sql)} as DatabaseSync['prepare']
    const before:number=commits
    try{catalog.commitLocalCatalogStartupAudit(f.db)}finally{f.db.prepare=prepare}
    assert.equal(commits,before+1);assert.equal(f.db.isTransaction,false);assert.equal(observationSource(f.db),undefined)
  }
  f.db.exec('CREATE TABLE synthetic_commit_parent(id INTEGER PRIMARY KEY);CREATE TABLE synthetic_commit_child(parent INTEGER REFERENCES synthetic_commit_parent(id) DEFERRABLE INITIALLY DEFERRED)')
  f.db.exec('BEGIN');f.verifyHistory();f.db.exec('INSERT INTO synthetic_commit_child VALUES(1)');const before=commits
  assert.throws(()=>catalog.commitLocalCatalogStartupAudit(f.db),/FOREIGN KEY/);assert.equal(commits,before+1);assert.equal(f.db.isTransaction,true)
  f.db.exec('ROLLBACK');assert.equal(observationSource(f.db),undefined)
})

test('启动作者在外部连接写或新schema后失活，原SQL继续读取新鲜事实',t=>{
  assert.ok(process.env.TMPDIR?.startsWith('/Volumes/LifeWeave/Developer/CommandLine/tmp/'))
  const directory=mkdtempSync(path.join(process.env.TMPDIR!,'observation-external-')),file=path.join(directory,'synthetic.sqlite')
  const f=largeMobileFixture({databasePath:file,groups:1,members:1,singles:0,observations:true,auditedHistory:true});t.after(()=>{f.close();rmSync(directory,{recursive:true,force:true})})
  f.db.exec('BEGIN');f.verifyHistory();catalog.commitLocalCatalogStartupAudit(f.db);const old=indexedSource(f)
  const other=new DatabaseSync(file);try{other.prepare('INSERT INTO source_roots VALUES(?)').run(syntheticId(987654322))}finally{other.close()}
  assert.equal(observationSource(f.db),undefined);assert.deepEqual(page(f,old),page(f,f.source))
  f.verifyHistory();const current=indexedSource(f);f.db.exec('CREATE TABLE synthetic_schema_change(value INTEGER)')
  assert.equal(observationSource(f.db),undefined);assert.deepEqual(page(f,current),page(f,f.source))
})

test('原repository测试钩子冷开不迁移作者；无钩子正常冷开可以激活',t=>{
  assert.ok(process.env.TMPDIR?.startsWith('/Volumes/LifeWeave/Developer/CommandLine/tmp/'))
  const directory=mkdtempSync(path.join(process.env.TMPDIR!,'observation-startup-')),file=path.join(directory,'synthetic.sqlite');t.after(()=>rmSync(directory,{recursive:true,force:true}))
  const first=createCollectionRepository({filePath:file});try{assert.ok(first.localCatalog.privateRead(db=>observationSource(db)))}finally{first.close()}
  let hooks=0;const hooked=createCollectionRepository({filePath:file,requireCurrentSchema:true,beforeCommit(action){assert.equal(action,'recover-recording-attempts');hooks++}})
  try{assert.equal(hooked.localCatalog.privateRead(db=>observationSource(db)),undefined);assert.equal(hooks,1)}finally{hooked.close()}
  const normal=createCollectionRepository({filePath:file,requireCurrentSchema:true});try{assert.ok(normal.localCatalog.privateRead(db=>observationSource(db)))}finally{normal.close()}
})
