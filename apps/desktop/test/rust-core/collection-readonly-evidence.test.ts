import test from 'node:test'
import assert from 'node:assert/strict'
import { acceptCollectionReadonlyEvidence, validateCollectionReadonlyRuntimeLayerEvidence, validateCollectionReadonlySqliteLayerEvidence } from '../helpers/collection-readonly-evidence.js'
for (const [name,report,expected] of [
 ['缺报告',null,{}],['空报告',{},{}],['缺独立身份',{schemaVersion:1,task:'RUST-014',state:'PASS'},{}],
 ['错误任务',{task:'RUST-012'},{}],['混入未知字段',{schemaVersion:1,unexpected:true},{}],
 ['预期身份为报告自指',{sourceCommit:'0'.repeat(40)},{sourceCommit:'0'.repeat(40)}],
 ['未观察Renderer DTO冒称完整验收',{rendererFullDtoObservation:'OBSERVED'},{}],
 ['运行期模式选择',{mode:'rust'},{}],
] as const) test(name,()=>assert.throws(()=>acceptCollectionReadonlyEvidence(report,expected)))

import { chmodSync, constants, copyFileSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { rendererDigest, rendererExternalPath } from '../helpers/rust-packaged-renderer-cost.js'
function actualInputs():{report:any;expected:any;directory:string} {
 const reportPath=process.env.MUSIC_BRIDGE_COLLECTION_READONLY_REPORT,expectedPath=process.env.MUSIC_BRIDGE_COLLECTION_READONLY_EXPECTED_IDENTITY
 assert.ok(reportPath&&expectedPath,'缺实际签名包报告与独立身份，不能skip或构造实际positive。')
 rendererExternalPath(reportPath);rendererExternalPath(expectedPath)
 const parent=path.join(path.dirname(path.dirname(reportPath)),'author-c');mkdirSync(parent,{recursive:true,mode:0o700})
 return {report:JSON.parse(readFileSync(reportPath,'utf8')),expected:JSON.parse(readFileSync(expectedPath,'utf8')),directory:mkdtempSync(path.join(parent,'actual-refusal-'))}
}
function saveArtifact(directory:string,name:string,value:any):any {
 const file=path.join(directory,name),bytes=Buffer.from(JSON.stringify(value,null,2)+'\n');writeFileSync(file,bytes,{flag:'wx',mode:0o600})
 return {path:file,sha256:rendererDigest(bytes),bytes:bytes.length}
}
// 所有重封装路径先以未改语义的实际输入证明PASS，再做单独目标变异。
function repackageRuntimeGraph(input:any,mutate:(runtime:any)=>void,runKey='rust-cold') {
 const report=structuredClone(input.report),expected=structuredClone(input.expected),runtime=report.runs[runKey].receipt
 mutate(runtime)
 const directory=mkdtempSync(path.join(input.directory,'raw-')),raw=Buffer.from(runtime.events.map((e:any)=>'RUST014_EVIDENCE '+JSON.stringify(e)+'\n').join('')),file=path.join(directory,'raw-evidence.jsonl')
 writeFileSync(file,raw,{flag:'wx',mode:0o600});runtime.rawEvidence={path:file,sha256:rendererDigest(raw),bytes:raw.length}
 const identity=saveArtifact(directory,'runtime-evidence.json',runtime);report.runs[runKey].evidence=identity;expected.runs[runKey]=identity
 if(runKey==='rust-fresh'){
  const cold=report.runs['rust-cold'].receipt;cold.launch.priorReceiptPath=identity.path;cold.launch.priorReceiptSha256=identity.sha256;cold.priorReceiptSha256=identity.sha256
  const coldIdentity=saveArtifact(directory,'dependent-cold-runtime-evidence.json',cold);report.runs['rust-cold'].evidence=coldIdentity;expected.runs['rust-cold']=coldIdentity
 }
 const sql=JSON.parse(readFileSync(report.sqliteReferences.rust.path,'utf8'))
 sql.stages[0].runtimeEvidence=report.runs['rust-fresh'].evidence;sql.stages[1].runtimeEvidence=report.runs['rust-cold'].evidence
 const sqlIdentity=saveArtifact(directory,'rust-closed-sqlite-reference.json',sql)
 report.sqliteReferences.rust=sqlIdentity;expected.sqliteReferences.rust=sqlIdentity
 // 同一实际输入的SQL/runtime依赖必须全部重绑，单层拒绝避免被旧hash掩盖。
 return {report,expected,runtime,directory}
}
function sqlRuntimeInputs(input:any) {
 return {runtimes:Object.fromEntries(Object.entries(input.report.runs).map(([key,run]:[string,any])=>[key,run.receipt])),runtimeIdentities:input.expected.runs}
}
function physicalIdentity(file:string) {const bytes=readFileSync(file);return {path:file,sha256:rendererDigest(bytes),bytes:bytes.length}}
function physicalSqlRows(files:any[]):any {
 const result=spawnSync('/usr/bin/python3',['-c',`import json,sqlite3,sys,pathlib
files=json.loads(sys.argv[1]);result={}
for name in ('collection.v1.sqlite','command-outbox.v1.sqlite'):
 p=next(x['path'] for x in files if pathlib.Path(x['path']).name==name);db=sqlite3.connect(pathlib.Path(p).as_uri()+'?mode=ro&immutable=1',uri=True);db.row_factory=sqlite3.Row
 queries=[('models','SELECT rowid,id,descriptor,policy,minimum_sealed,revision FROM collection_models ORDER BY rowid DESC'),('lots','SELECT rowid,* FROM inventory_lots ORDER BY rowid'),('skus','SELECT rowid,* FROM collection_skus ORDER BY rowid'),('ledger','SELECT rowid,* FROM inventory_ledger ORDER BY rowid')] if name=='collection.v1.sqlite' else [('outbox','SELECT e.rowid,e.id,e.command_id,e.request_json,s.state,s.updated_at,s.acknowledged,s.error_code,s.result_json FROM outbox_entries e JOIN outbox_states s ON s.id=e.id ORDER BY e.rowid')]
 for key,sql in queries:result[key]=[dict(r) for r in db.execute(sql)]
 db.close()
print(json.dumps(result,ensure_ascii=False))`,JSON.stringify(files)],{encoding:'utf8',timeout:15_000,maxBuffer:8*1024*1024,env:{PATH:'/usr/bin:/bin',TMPDIR:path.dirname(files[0].path)}})
 assert.equal(result.status,0,result.stderr);assert.equal(result.error,undefined);return JSON.parse(result.stdout)
}
/** 单独复制合成库和证据构成测试图，不声称复制profile曾实际启动App。 */
function cloneSqlGraph(input:any,mutation:'none'|'minutes'|'quantity') {
 const report=structuredClone(input.report),expected=structuredClone(input.expected),directory=mkdtempSync(path.join(input.directory,'physical-sql-'))
 const tmp=path.join(directory,'runtime-tmp-clone'),profile=path.join(tmp,'musicbridge-ui-diagnostics-clone'),data=path.join(profile,'data')
 mkdirSync(data,{recursive:true,mode:0o700})
 const oldProfile=report.runs['node-cold'].receipt.profileDirectory
 for(const marker of ['rust014-profile.json','rust014-completed.json']){copyFileSync(path.join(oldProfile,marker),path.join(profile,marker),constants.COPYFILE_EXCL);chmodSync(path.join(profile,marker),0o600)}
 const observedProfile=lstatSync(profile,{bigint:true}),profileFields={profileDirectory:profile,profileDev:String(observedProfile.dev),profileIno:String(observedProfile.ino)}
 const sql=JSON.parse(readFileSync(report.sqliteReferences.node.path,'utf8'))
 for(const identity of sql.stages[1].sourceFilesAfter){const destination=path.join(data,path.basename(identity.path));copyFileSync(identity.path,destination,constants.COPYFILE_EXCL);chmodSync(destination,0o600)}
 for(const key of ['node-fresh','node-cold']){
  const runtime=report.runs[key].receipt;Object.assign(runtime,profileFields,{tmpDirectory:tmp,markerPath:path.join(profile,'rust014-profile.json')})
  runtime.actualLaunch.env.TMPDIR=tmp;runtime.actualLaunch.env.MUSIC_BRIDGE_UI_E2E_USER_DATA_DIR=profile
  for(const event of runtime.events){
   if(event.event==='main.profileValidated')Object.assign(event.data,profileFields)
   if(event.event==='main.screenshot'){
    const destination=path.join(profile,path.relative(oldProfile,event.data.path));mkdirSync(path.dirname(destination),{recursive:true,mode:0o700});copyFileSync(event.data.path,destination,constants.COPYFILE_EXCL);chmodSync(destination,0o600);event.data.path=destination
   }
  }
  if(key==='node-cold'){runtime.launch.priorReceiptPath=report.runs['node-fresh'].evidence.path;runtime.launch.priorReceiptSha256=report.runs['node-fresh'].evidence.sha256;runtime.priorReceiptSha256=report.runs['node-fresh'].evidence.sha256}
  const rawFile=path.join(directory,key+'-raw.jsonl'),raw=Buffer.from(runtime.events.map((event:any)=>'RUST014_EVIDENCE '+JSON.stringify(event)+'\n').join(''))
  writeFileSync(rawFile,raw,{flag:'wx',mode:0o600});runtime.rawEvidence={path:rawFile,sha256:rendererDigest(raw),bytes:raw.length}
  const identity=saveArtifact(directory,key+'-runtime.json',runtime);report.runs[key].evidence=identity;expected.runs[key]=identity
 }
 for(const [at,stage] of sql.stages.entries()){
  const frozenDir=path.join(directory,at===0?'fresh-sql':'cold-sql');mkdirSync(frozenDir,{mode:0o700})
  const files=stage.frozenFilesBefore.map((identity:any)=>{const destination=path.join(frozenDir,path.basename(identity.path));copyFileSync(identity.path,destination,constants.COPYFILE_EXCL);chmodSync(destination,0o600);return physicalIdentity(destination)})
  if(mutation!=='none'){
   const file=files.find((identity:any)=>path.basename(identity.path)==='collection.v1.sqlite').path,modelId=stage.fullModels.find((model:any)=>model.name==='RUST014 合成型号 02').id
   const changed=spawnSync('/usr/bin/python3',['-c',`import sqlite3,sys
p,model,kind=sys.argv[1:];db=sqlite3.connect(p)
if kind=='minutes':db.execute('UPDATE collection_skus SET minutes=45 WHERE model_id=?',(model,))
else:db.execute('UPDATE inventory_lots SET quantity_adjustment=1,opened=2 WHERE sku_id IN (SELECT id FROM collection_skus WHERE model_id=?)',(model,))
db.commit();db.close()`,file,modelId,mutation],{encoding:'utf8',timeout:15_000,env:{PATH:'/usr/bin:/bin',TMPDIR:frozenDir}})
   assert.equal(changed.status,0,changed.stderr)
  }
  stage.frozenFilesBefore=files.map((identity:any)=>physicalIdentity(identity.path));stage.frozenFilesAfter=structuredClone(stage.frozenFilesBefore)
  Object.assign(stage,physicalSqlRows(stage.frozenFilesBefore))
  stage.profileDirectory=profile;stage.runtimeEvidence=report.runs[at===0?'node-fresh':'node-cold'].evidence
  // fresh历史身份与自己的frozen副本对应；冷启后当前source按cold副本验证。
  stage.sourceFilesBefore=stage.frozenFilesBefore.map((identity:any)=>({...identity,path:path.join(data,path.basename(identity.path))}));stage.sourceFilesAfter=structuredClone(stage.sourceFilesBefore)
 }
 // 只覆盖本测试独占复制，原candidate/profile数据库均不写。
 for(const identity of sql.stages[1].frozenFilesBefore)copyFileSync(identity.path,path.join(data,path.basename(identity.path)))
 const sqlIdentity=saveArtifact(directory,'node-sql-reference.json',sql);report.sqliteReferences.node=sqlIdentity;expected.sqliteReferences.node=sqlIdentity
 return {report,expected,sql,bindings:sqlRuntimeInputs({report,expected}),directory}
}
test('实际签名包准入与重算hash串改拒绝矩阵',async t=>{
 const input=actualInputs();assert.equal(acceptCollectionReadonlyEvidence(input.report,input.expected).state,'PASS')
 await t.test('fresh刷新证据及cold依赖重封装无变更PASS控制',()=>{
  const fixture=repackageRuntimeGraph(input,()=>{},'rust-fresh');assert.equal(validateCollectionReadonlyRuntimeLayerEvidence(fixture.runtime,'rust-fresh',input.expected.packages['rust-controls'].candidateIdentity).state,'RUNTIME_LAYER_VALIDATED');assert.equal(acceptCollectionReadonlyEvidence(fixture.report,fixture.expected).state,'PASS')
 })
 for(const mutation of ['early-settled','wrong-action'] as const)await t.test(`详情刷新完成关联拒绝：${mutation}`,()=>{
  const fixture=repackageRuntimeGraph(input,runtime=>{
   const action=runtime.events.find((e:any)=>e.event==='main.domAction'&&e.data.control==='refresh'),list=runtime.events.find((e:any)=>e.event==='main.request'&&e.data.actionId===action.data.actionId&&e.data.request.command==='collection.list'&&e.data.request.payload.page.limit===24)
   if(mutation==='wrong-action')list.data.actionId='dom-001-navigate'
   else{
    const at=runtime.events.findIndex((e:any)=>e.event==='main.domSettled'&&e.data.actionId===action.data.actionId),[settled]=runtime.events.splice(at,1),target=runtime.events.indexOf(list),prior=runtime.events.slice(0,target).findLast((e:any)=>e.actor==='main')
    settled.elapsedMs=(prior.elapsedMs+list.elapsedMs)/2;runtime.events.splice(target,0,settled);let sequence=0;for(const e of runtime.events)if(e.actor==='main')e.sequence=++sequence
   }
  },'rust-fresh')
  assert.throws(()=>validateCollectionReadonlyRuntimeLayerEvidence(fixture.runtime,'rust-fresh',input.expected.packages['rust-controls'].candidateIdentity));assert.throws(()=>acceptCollectionReadonlyEvidence(fixture.report,fixture.expected))
 })
 for(const [name,mutate] of [
  ['sourceCommit漂移',(r:any)=>r.sourceCommit='0'.repeat(40)],
  ['sourceSHA漂移',(r:any)=>r.sourceSha256='0'.repeat(64)],
  ['base漂移',(r:any)=>r.baseCommit='0'.repeat(40)],
  ['Renderer完整DTO冒称观察',(r:any)=>r.rendererFullDtoObservation='OBSERVED'],
  ['业务writer漂移',(r:any)=>r.businessDatabaseWriter='Rust'],
  ['Main账本writer漂移',(r:any)=>r.mainOutboxWriter='Node'],
  ['共享Renderer资产缺项',(r:any)=>r.packages['rust-controls'].originalAssets.asar.pop()],
  ['原Node作者源漂移',(r:any)=>r.packages['node-controls'].originalAssets.sources[0].sha256='0'.repeat(64)],
  ['签名缺实际验证',(r:any)=>r.packages['rust-controls'].verification.bundleSignature.verified=false],
  ['inspect fuse启用',(r:any)=>r.packages['rust-controls'].candidateIdentity.fuses['3']=49],
  ['ASARonly fuse禁用',(r:any)=>r.packages['rust-controls'].candidateIdentity.fuses['5']=48],
  ['清单pin漂移',(r:any)=>r.packages['rust-controls'].compile.manifestPin='0'.repeat(64)],
  ['运行期route字段',(r:any)=>r.runs['rust-fresh'].receipt.actualLaunch.env.MUSIC_BRIDGE_CORE_BACKEND='rust'],
 ] as const)await t.test(name,()=>{const report=structuredClone(input.report);mutate(report);assert.throws(()=>acceptCollectionReadonlyEvidence(report,input.expected))})
 await t.test('物理SQL两时点及profile复制无变更PASS控制',()=>{
  const fixture=cloneSqlGraph(input,'none')
  assert.equal(validateCollectionReadonlySqliteLayerEvidence(fixture.sql,'node',fixture.bindings.runtimes,fixture.bindings.runtimeIdentities).state,'SQLITE_LAYER_VALIDATED')
  assert.equal(acceptCollectionReadonlyEvidence(fixture.report,fixture.expected).state,'PASS')
 })
 for(const mutation of ['minutes','quantity'] as const)await t.test(`物理非目标02同改fresh/cold/profile且重绑hash：${mutation}`,()=>{
  const fixture=cloneSqlGraph(input,mutation)
  assert.throws(()=>validateCollectionReadonlySqliteLayerEvidence(fixture.sql,'node',fixture.bindings.runtimes,fixture.bindings.runtimeIdentities))
  assert.throws(()=>acceptCollectionReadonlyEvidence(fixture.report,fixture.expected))
 })
 const mutations:[string,(runtime:any)=>void][]=[
  ['错普通公开状态',(r:any)=>{const reply=r.events.find((e:any)=>e.event==='main.ipcReply'&&e.data.channel==='collection:readonly-settings');reply.data.result.enabled=false}],
  ['隐藏诊断刷新',(r:any)=>r.events.push({...r.events.at(-1),event:'core.explicitRefreshCompleted',data:{ordinal:1,mode:'rust'}})],
  ['错原控件',r=>r.events.find((e:any)=>e.event==='main.domAction').data.control='direct-api'],
  ['假trusted输入',r=>r.events.find((e:any)=>e.event==='main.domAction').data.isTrusted=true],
  ['窗口不可见',r=>r.events.find((e:any)=>e.event==='main.window').data.visible=false],
  ['不可信Renderer',r=>r.events.find((e:any)=>e.event==='main.ipcRequest').data.sender.trusted=false],
  ['错RendererPID',r=>r.events.find((e:any)=>e.event==='main.ipcRequest').data.sender.rendererPid++],
  ['错完整MainDTO',r=>r.events.find((e:any)=>e.event==='main.response'&&e.data.command==='collection.list').data.reply.result.total++],
  ['错Core请求id',r=>r.events.find((e:any)=>e.event==='core.publicRequest').data.request.id='00000000-0000-4000-8000-000000000000'],
  ['wire版本伪作资源1',r=>r.events.find((e:any)=>e.event==='rust.request').data.frame.protocolVersion=1],
  ['dispatch请求漂移',r=>r.events.find((e:any)=>e.event==='rust.request'&&e.data.frame.operation==='dispatch').data.frame.payload.request.payload.page.limit=23],
  ['完整ACK缺readOnly',r=>delete r.events.find((e:any)=>e.event==='rust.validated-reply'&&e.data.frame.operation==='prepare').data.frame.result.readOnly],
  ['closeACK伪成功',r=>r.events.find((e:any)=>e.event==='rust.exit').data.closeAcknowledged=false],
  ['Node自然exit非0',r=>r.events.find((e:any)=>e.event==='node.exit').data.code=1],
  ['Main强制收口',r=>r.forceKilled=true],
  ['退出pending残留',r=>r.events.find((e:any)=>e.event==='rust.exit').data.pendingRequests=1],
  ['错误固定argv',r=>r.actualLaunch.argv.push('--inspect=0')],
  ['原关闭偏序漂移',r=>{const e=r.events.find((e:any)=>e.event==='main.lifecycle'&&e.data.event==='outbox-close-end');e.data.event='outbox-close-timeout';r.lifecycle.find((e:any)=>e.phase==='outbox-close-end').phase='outbox-close-timeout'}],
 ]
 await t.test('raw/receipt/SQL完全不变重封装PASS控制',()=>{
  const fixture=repackageRuntimeGraph(input,()=>{})
  assert.equal(validateCollectionReadonlyRuntimeLayerEvidence(fixture.runtime,'rust-cold',input.expected.packages['rust-controls'].candidateIdentity).state,'RUNTIME_LAYER_VALIDATED')
  assert.equal(acceptCollectionReadonlyEvidence(fixture.report,fixture.expected).state,'PASS')
 })
 for(const [name,mutate] of mutations)await t.test(`actual JSONL/receipt重算SHA：${name}`,()=>{
  const fixture=repackageRuntimeGraph(input,mutate)
  assert.throws(()=>validateCollectionReadonlyRuntimeLayerEvidence(fixture.runtime,'rust-cold',input.expected.packages['rust-controls'].candidateIdentity))
  assert.throws(()=>acceptCollectionReadonlyEvidence(fixture.report,fixture.expected))
 })
 await t.test('SQL aggregate完全不变重封装PASS控制',()=>{
  const report=structuredClone(input.report),expected=structuredClone(input.expected),sql=JSON.parse(readFileSync(report.sqliteReferences.node.path,'utf8'))
  const identity=saveArtifact(input.directory,'sql-unchanged-control.json',sql);report.sqliteReferences.node=identity;expected.sqliteReferences.node=identity
  const bindings=sqlRuntimeInputs(input)
  assert.equal(validateCollectionReadonlySqliteLayerEvidence(sql,'node',bindings.runtimes,bindings.runtimeIdentities).state,'SQLITE_LAYER_VALIDATED')
  assert.equal(acceptCollectionReadonlyEvidence(report,expected).state,'PASS')
 })
 for(const [name,mutate] of [
  ['SQLite行伪造',(sql:any)=>sql.stages[0].models[0].revision++],
  ['完整query oracle串改',(sql:any)=>sql.stages[0].queryReferences[0].oracle.total++],
  ['领域ledger写数串改',(sql:any)=>sql.stages[0].ledger.pop()],
  ['Main ACK账本串改',(sql:any)=>sql.stages[0].outbox[0].acknowledged=0],
 ] as const)await t.test(`actualSQL JSON重算SHA：${name}`,()=>{
  const report=structuredClone(input.report),expected=structuredClone(input.expected),sql=JSON.parse(readFileSync(report.sqliteReferences.node.path,'utf8'))
  mutate(sql);const identity=saveArtifact(input.directory,`${name}.json`,sql);report.sqliteReferences.node=identity;expected.sqliteReferences.node=identity
  const bindings=sqlRuntimeInputs(input)
  assert.throws(()=>validateCollectionReadonlySqliteLayerEvidence(sql,'node',bindings.runtimes,bindings.runtimeIdentities))
  assert.throws(()=>acceptCollectionReadonlyEvidence(report,expected))
 })
})
