import { historicalScaleFragment } from '../helpers/historical-scale-fragments.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { acceptCollectionScaleEvidence, deriveCollectionScaleCostEvidence, COLLECTION_SCALE_RUN_KEYS } from '../helpers/collection-scale-evidence.js'
const stage='/Volumes/LifeWeave/Developer/CommandLine/tmp/mb-rust-core-015-i0qxwbi7/author-c'
const hash=(bytes:string|Buffer)=>createHash('sha256').update(bytes).digest('hex')
const file=(location:string,value:any)=>{const bytes=JSON.stringify(value,null,2)+'\n';writeFileSync(location,bytes,{flag:'wx',mode:0o600});return {path:location,sha256:hash(bytes),bytes:Buffer.byteLength(bytes)}}
const clone=<T>(value:T):T=>JSON.parse(JSON.stringify(value))
function actual(){const report=process.env.MUSIC_BRIDGE_COLLECTION_SCALE_REPORT,expected=process.env.MUSIC_BRIDGE_COLLECTION_SCALE_EXPECTED_IDENTITY;assert.ok(report&&expected,'缺少真实签包报告与独立磁盘身份，不能跳过或构造正例。');return {report:JSON.parse(readFileSync(report,'utf8')),expected:JSON.parse(readFileSync(expected,'utf8'))}}
test('基础验收拒绝非闭集与虚构PASS，不访问用户路径',()=>{
 for(const [report,expected] of [[{},{}],[{schemaVersion:1,task:'RUST-015',state:'PASS'},{}],[{executable:'/Users/yihe/private.app'},{}]])assert.throws(()=>acceptCollectionScaleEvidence(report,expected))
 assert.throws(()=>deriveCollectionScaleCostEvidence({}))
})
// 每次raw变异都重绑stdout/rawJSONL/receipt/SQL运行输入/cost全图；原候选文件不写入。
function repack(input:{report:any;expected:any},mutate:(events:any[])=>void,key='scale-100-cold'){
 mkdirSync(stage,{recursive:true,mode:0o700});const dir=mkdtempSync(path.join(stage,'evidence-graph-')),report=clone(input.report),expected=clone(input.expected),run=report.runs[key],runtime=clone(run.receipt),old=runtime.events;mutate(runtime.events)
 runtime.evidenceDirectory=dir
 let index=0;const original=readFileSync(runtime.streams.stdout.path,'utf8');const stdout=original.split('\n').map(line=>line.startsWith('RUST015_EVIDENCE ')?'RUST015_EVIDENCE '+JSON.stringify(runtime.events[index++]):line).join('\n');assert.equal(index,old.length)
 const stderr=readFileSync(runtime.streams.stderr.path);for(const [name,bytes] of [['stdout',Buffer.from(stdout)],['stderr',stderr]] as const){const location=path.join(dir,name+'.log');writeFileSync(location,bytes,{flag:'wx',mode:0o600});runtime.streams[name]={path:location,sha256:hash(bytes),bytes:bytes.length};runtime[name+'Sha256']=hash(bytes);runtime[name+'Bytes']=bytes.length}
 const raw=Buffer.from(runtime.events.map((event:any)=>'RUST015_EVIDENCE '+JSON.stringify(event)+'\n').join('')),rawPath=path.join(dir,'raw-evidence.jsonl');writeFileSync(rawPath,raw,{flag:'wx',mode:0o600});runtime.rawEvidence={path:rawPath,sha256:hash(raw),bytes:raw.length}
 run.receipt=runtime;run.evidence=file(path.join(dir,'runtime-evidence.json'),runtime);expected.runs[key]=run.evidence
 const kind=key.replace(/-(?:fresh|cold)$/u,''),aggregate=JSON.parse(readFileSync(report.sqliteReferences[kind].path,'utf8'));aggregate.stages[key.endsWith('cold')?1:0].runtimeEvidence=run.evidence
 if(key.endsWith('fresh')){const cold=report.runs[kind+'-cold'];cold.receipt.launch.priorReceiptPath=run.evidence.path;cold.receipt.launch.priorReceiptSha256=run.evidence.sha256;cold.receipt.priorReceiptSha256=run.evidence.sha256;cold.evidence=file(path.join(dir,'cold-runtime-evidence.json'),cold.receipt);expected.runs[kind+'-cold']=cold.evidence;aggregate.stages[1].runtimeEvidence=cold.evidence}
 report.sqliteReferences[kind]=file(path.join(dir,'sqlite-reference.json'),aggregate);expected.sqliteReferences[kind]=report.sqliteReferences[kind]
 // 变异若被成本独立约束拒绝，也必须由同一无变更重封图先通过证明可归因。
 report.costEvidence=file(path.join(dir,'cost.json'),deriveCollectionScaleCostEvidence(report.runs));expected.costEvidence=report.costEvidence
 return {report,expected}
}
test('真实七签包十三run/十二闭库/Renderer完整DTO与成本接受',()=>{const input=actual();acceptCollectionScaleEvidence(input.report,input.expected)})
test('真实完全不变raw与依赖全图重封控制仍被接受',()=>{const input=repack(actual(),()=>{});acceptCollectionScaleEvidence(input.report,input.expected)})
for(const field of ['sourceCommit','sourceSha256','rendererFullDtoObservation','businessDatabaseWriter','mainOutboxWriter'] as const)test(`真实身份/claim串改拒绝：${field}`,()=>{const input=actual(),report=clone(input.report);report[field]=field==='sourceCommit'?'0'.repeat(40):field==='sourceSha256'?'0'.repeat(64):'UNSUPPORTED';assert.throws(()=>acceptCollectionScaleEvidence(report,input.expected))})
const mutations:Record<string,(events:any[])=>void>={
 'Node退出非自然0':events=>events.find(e=>e.event==='node.exit').data.code=1,
 'Node关闭ACK缺失':events=>events.find(e=>e.event==='node.closeCompleted').event='node.closeRejected',
 '公开Main完整DTO漂移':events=>{const r=events.find(e=>e.event==='main.response'&&e.data.command==='collection.list');r.data.reply.result.total++},
 'Core公开请求ID漂移':events=>{events.find(e=>e.event==='core.publicRequest').data.request.id='00000000-0000-4000-8000-000000000000'},
 'Renderer完整DTO漂移':events=>{events.find(e=>e.event==='renderer.commit'&&e.data.layer==='catalog').data.result.total++},
 'Renderer绘制机会早于提交':events=>{events.find(e=>e.event==='renderer.paint').data.durationMs=-1},
 '控制ACK代际漂移':events=>{events.find(e=>e.event==='main.controlReply').data.response.generationNonce='00000000-0000-4000-8000-000000000000'},
 'RSS采样外进程':events=>{events.find(e=>e.event==='main.coreSpawn').data.pid=999999},
}
for(const [label,mutate] of Object.entries(mutations))test(`真实raw重算SHA与依赖全图串改拒绝：${label}`,()=>{const original=actual();assert.throws(()=>{const input=repack(original,mutate);acceptCollectionScaleEvidence(input.report,input.expected)})})
test('03默认历史READY与Main自然0保留，旧RSSschema不得升作新实际PASS',async()=>{
 const {acceptCollectionScaleRuntimeEvidence}=await import('../helpers/collection-scale-evidence.js')
 const supplied=process.env.MUSIC_BRIDGE_COLLECTION_SCALE_REPORT
 if(supplied){const {report,expected}=actual();acceptCollectionScaleRuntimeEvidence(report.runs['default-node'].receipt,'default-node',report.packages['default-node'].candidateIdentity,report.runs['default-node'].evidence,expected.runs['default-node']);return}
 const base='/Volumes/LifeWeave/Developer/CommandLine/tmp/mb-rust-core-015-i0qxwbi7/candidate-015-03',receiptPath=path.join(base,'runs/default-node/runtime-evidence.json'),prepPath=path.join(base,'preparation.json'),bytes=readFileSync(receiptPath),prepBytes=readFileSync(prepPath)
 assert.equal(hash(bytes),'23db813f9084c1fa14b1d4b48a03b29aa732e4065aa2811b94a2be530c1b17f7');assert.equal(hash(prepBytes),'28d686c530bbab1ad4dce8027058447f52f78d79dd6c77909c51858d39154dc2')
 const receipt=JSON.parse(bytes.toString()),pkg=JSON.parse(prepBytes.toString()).packages['default-node'];assert.equal(pkg.compile.diagnostics,false);assert.equal(pkg.compile.rendererDiagnostics,false)
 assert.equal(receipt.startupReady,true);assert.deepEqual(receipt.mainExit,{code:0,signal:null});assert.deepEqual(receipt.events,[]);assert.deepEqual(receipt.lifecycle,[]);const ref={path:receiptPath,sha256:hash(bytes),bytes:bytes.length};assert.throws(()=>acceptCollectionScaleRuntimeEvidence(receipt,'default-node',pkg.candidateIdentity,ref,ref),'历史旧RSSschema不得补造zeroReadings或升作当前PASS')
})

test('真实暖样本fresh原件与cold先决收据/SQL/cost全图未改重封控制仍接受',()=>{const input=repack(actual(),()=>{},'scale-0-fresh');acceptCollectionScaleEvidence(input.report,input.expected)})
const warmMutations:Record<string,(events:any[])=>void>={
 '选早期paint或早于最新paint的序号':events=>{const warm=events.find(e=>e.event==='main.warmSample'),early=events.find(e=>e.event==='renderer.paint'&&e.data.actionId===warm.data.actionId&&e.data.layer==='catalog'&&e.data.observationId!==warm.data.selection.observationId);warm.data.selection.paintRendererSequence=early?.sequence??warm.data.selection.paintRendererSequence-1},
 '错代际':events=>events.find(e=>e.event==='main.warmSample').data.selection.generation++,
 'submit非原FORM':events=>{const warm=events.find(e=>e.event==='main.warmSample');events.find(e=>e.actor==='renderer'&&e.sequence===warm.data.selection.finalSubmitRendererSequence).data.target='BUTTON'},
 '非submit选择':events=>events.find(e=>e.event==='main.warmSample').data.selection.finalSubmitRendererSequence--,
 'ALS公共请求漂移':events=>{const warm=events.find(e=>e.event==='main.warmSample');events.find(e=>e.event==='main.request'&&e.data.request.id===warm.data.selection.requestId).data.invokeId='ipc-wrong'},
 '篡改原filter':events=>{const warm=events.find(e=>e.event==='main.warmSample');events.find(e=>e.event==='main.request'&&e.data.request.id===warm.data.selection.requestId).data.request.payload.filter.query='非空篡改'},
 '重复warm身份':events=>{const warms=events.filter(e=>e.event==='main.warmSample');assert.ok(warms.length>1);warms[1].data=structuredClone(warms[0].data)},
}
for(const [label,mutate] of Object.entries(warmMutations))test(`真实暖样本原件重算SHA/全依赖图串改拒绝：${label}`,()=>{const original=actual();assert.throws(()=>{const input=repack(original,mutate,'scale-0-fresh');acceptCollectionScaleEvidence(input.report,input.expected)})})
test('真实成本排除零读计数重封SHA仍须由raw独立重算一致',()=>{
 const input=actual(),report=clone(input.report),expected=clone(input.expected),cost=JSON.parse(readFileSync(report.costEvidence.path,'utf8'));cost.runs['scale-100-cold'].excludedZeroReadingCount++
 const dir=mkdtempSync(path.join(stage,'zero-count-cost-'));report.costEvidence=file(path.join(dir,'cost.json'),cost);expected.costEvidence=report.costEvidence;assert.throws(()=>acceptCollectionScaleEvidence(report,expected))
})

import { assertCollectionScaleRendererIpcDrain, assertCollectionScaleSettingsPaint } from '../helpers/collection-scale-evidence.js'
const event=(actor:string,sequence:number,event:string,data:any)=>({schemaVersion:1,actor,pid:actor==='main'?10:20,sequence,elapsedMs:sequence,event,data})
function drainFixture():any[]{return [
 event('main',1,'main.ipcRequest',{invokeId:'ipc-1',channel:'collection:list',actionId:'a',catalogOrdinal:null,args:[{offset:0,limit:1},{}],sender:{trusted:true}}),
 event('main',2,'main.request',{invokeId:'ipc-1',request:{id:'public-1'}}),
 event('main',3,'main.response',{invokeId:'ipc-1',requestId:'public-1'}),
 event('main',4,'main.ipcReply',{invokeId:'ipc-1',channel:'collection:list',actionId:'a',catalogOrdinal:null,result:{},durationMs:1}),
 event('main',5,'main.rendererIpcDrained',{scope:'before-original-quit',pendingCount:0,requestCount:1,replyCount:1,rejectedCount:0}),
 event('main',6,'main.rendererProbeComplete',{}),event('main',7,'main.lifecycle',{event:'before-quit'})]}
function settingsFixture():any[]{
 const identity={actionId:'a',observationId:'r1',generation:1,layer:'control',request:{operation:'status'},triggerSequence:null,triggerDomEvent:null,catalogOrdinal:null},status={schemaVersion:1,enabled:true,mode:'rust',state:'ready'},request={schemaVersion:1,requestId:'00000000-0000-4000-8000-000000000001',generationNonce:'00000000-0000-4000-8000-000000000002',type:'status'}
 return [event('main',1,'main.domAction',{actionId:'a',operation:'settings-open'}),event('renderer',1,'renderer.begin',identity),
 event('main',2,'main.ipcRequest',{invokeId:'ipc-1',actionId:'a',channel:'collection:readonly-settings',args:[],catalogOrdinal:null,sender:{rendererPid:20,trusted:true}}),
 event('main',3,'main.controlRequest',{actionId:'a',request}),event('main',4,'main.controlReply',{actionId:'a',requestId:'00000000-0000-4000-8000-000000000001',generationNonce:'00000000-0000-4000-8000-000000000002',response:{...request,ok:true,status},durationMs:1}),
 event('main',5,'main.ipcReply',{invokeId:'ipc-1',actionId:'a',channel:'collection:readonly-settings',result:status,catalogOrdinal:null,durationMs:1}),
 event('renderer',2,'renderer.invokeReply',{...identity,result:status,durationMs:1}),event('renderer',3,'renderer.commit',{...identity,result:status,durationMs:2}),
 event('renderer',4,'renderer.nextTick',{...identity,durationMs:3}),event('renderer',5,'renderer.paint',{...identity,durationMs:4,scope:'paint-opportunity-after-latest-commit'}),
 event('main',6,'main.domSettled',{actionId:'a',settingsStatusSelection:{observationId:'r1',generation:1,invokeId:'ipc-1',requestId:request.requestId,paintRendererSequence:5},snapshot:{readonlySettings:{enabled:true,mode:'rust',state:'ready'}}})]
}
test('Source09局部控制：原UI全部reply后drain与最新status完整paint链接受',()=>{assertCollectionScaleRendererIpcDrain(drainFixture());assertCollectionScaleSettingsPaint(settingsFixture())})
const drainMutations:Record<string,(e:any[])=>void>={
 '缺drain':e=>e.splice(4,1),'错invoke':e=>e[3].data.invokeId='wrong','错count':e=>e[4].data.requestCount++,
 '缺reply':e=>e.splice(3,1),'drain后request':e=>{e[0].sequence=5.5},'提前quit':e=>{e[6].sequence=4.5},
 'reply早于request':e=>{e[3].sequence=0},'重复reply':e=>e.push(clone(e[3])),'有rejected':e=>e.push(event('main',4.5,'main.ipcRejected',{invokeId:'ipc-1'})),
 'public-owned晚reply':e=>{e[2].sequence=5.5},'drain额外字段':e=>{e[4].data.extra=true},'ProbeComplete抢先':e=>{e[5].sequence=4.5}}
for(const [name,mutate] of Object.entries(drainMutations))test('Source09原UI收口独立拒绝：'+name,()=>{const e=drainFixture();mutate(e);assert.throws(()=>assertCollectionScaleRendererIpcDrain(e))})
const settingsMutations:Record<string,(e:any[])=>void>={
 '缺paint':e=>e.splice(9,1),'错paint代际':e=>e[9].data.generation++,'抢先DOM':e=>{e[10].sequence=4.5},
 '错invoke':e=>e[5].data.invokeId='wrong','DOM旧状态':e=>e[10].data.snapshot.readonlySettings.enabled=false,
 '私有reply完整DTO漂移':e=>e[4].data.response.status={...e[4].data.response.status,schemaVersion:2},
 'paint属后动作':e=>e[9].data.actionId='later','discarded代际':e=>e.push(event('renderer',6,'renderer.discarded',{...e[1].data})),
 '最新begin无paint':e=>e.splice(10,0,event('renderer',6,'renderer.begin',{...e[1].data,observationId:'newer',generation:2})),
 '错statusoperation':e=>e[1].data.request={operation:'setEnabled',enabled:true},'缺commit':e=>e.splice(7,1),'重复paint':e=>e.splice(10,0,clone(e[9]))}
for(const [name,mutate] of Object.entries(settingsMutations))test('Source09 settings最新status独立拒绝：'+name,()=>{const e=settingsFixture();mutate(e);assert.throws(()=>assertCollectionScaleSettingsPaint(e))})
test('Source08原settings先settled后discard实际原件必须拒绝，不能升级正例',()=>{const v=historicalScaleFragment('source08-settings-discard-fragment.json');const settled=v.events.find(e=>e.event==='main.domSettled');assert.equal(Object.hasOwn(settled.data,'settingsStatusSelection'),false);assert.equal(v.events.filter(e=>e.event==='renderer.paint').length,0);assert.equal(v.events.filter(e=>e.event==='renderer.discarded').length,1);assert.throws(()=>assertCollectionScaleSettingsPaint(v.events))})

test('Source09真实未改raw全图控制及最新状态/关闭选择串改拒绝',()=>{
 const original=actual(),control=repack(original,()=>{});acceptCollectionScaleEvidence(control.report,control.expected)
 const changes:Record<string,(events:any[])=>void>={
  'drain计数漂移':events=>{events.find(e=>e.event==='main.rendererIpcDrained').data.requestCount++},
  'drain提前':events=>{const drain=events.find(e=>e.event==='main.rendererIpcDrained'),request=events.find(e=>e.event==='main.ipcRequest');drain.sequence=request.sequence},
  'status选择错invoke':events=>{events.find(e=>e.event==='main.domSettled'&&e.data.settingsStatusSelection).data.settingsStatusSelection.invokeId='ipc-wrong'},
  'status选择早期paint':events=>{events.find(e=>e.event==='main.domSettled'&&e.data.settingsStatusSelection).data.settingsStatusSelection.paintRendererSequence--},
  'status选择错代':events=>{events.find(e=>e.event==='main.domSettled'&&e.data.settingsStatusSelection).data.settingsStatusSelection.generation++},
  'status原DOM投影漂移':events=>{const e=events.find(e=>e.event==='main.domSettled'&&e.data.settingsStatusSelection);e.data.snapshot.readonlySettings.enabled=!e.data.snapshot.readonlySettings.enabled},
 }
 for(const [name,mutate] of Object.entries(changes))assert.throws(()=>{const changed=repack(original,mutate);acceptCollectionScaleEvidence(changed.report,changed.expected)},name)
})

function latestSettingsFixture():any[]{
 const e=settingsFixture(),settled=e.pop()!,old=e[1].data,status=e[5].data.result,request={...e[3].data.request,requestId:'00000000-0000-4000-8000-000000000003'},identity={...old,observationId:'r2',generation:2}
 e.push(event('renderer',6,'renderer.begin',identity),event('main',6,'main.ipcRequest',{...e[2].data,invokeId:'ipc-2'}),event('main',7,'main.controlRequest',{actionId:'a',request}),event('main',8,'main.controlReply',{actionId:'a',requestId:request.requestId,generationNonce:request.generationNonce,response:{...request,ok:true,status},durationMs:1}),event('main',9,'main.ipcReply',{...e[5].data,invokeId:'ipc-2'}),event('renderer',7,'renderer.invokeReply',{...identity,result:status,durationMs:1}),event('renderer',8,'renderer.commit',{...identity,result:status,durationMs:2}),event('renderer',9,'renderer.nextTick',{...identity,durationMs:3}),event('renderer',10,'renderer.paint',{...identity,durationMs:4,scope:'paint-opportunity-after-latest-commit'}))
 settled.sequence=10;settled.data.settingsStatusSelection={observationId:'r2',generation:2,invokeId:'ipc-2',requestId:request.requestId,paintRendererSequence:10};e.push(settled);return e
}
test('Source09 settings同action较早status已paint仍仅接受最新普通status',()=>{const valid=latestSettingsFixture();assertCollectionScaleSettingsPaint(valid);const old=clone(valid);old.at(-1).data.settingsStatusSelection=settingsFixture().at(-1).data.settingsStatusSelection;assert.throws(()=>assertCollectionScaleSettingsPaint(old));const missing=clone(valid);missing.splice(missing.findIndex((e:any)=>e.event==='renderer.paint'&&e.data.observationId==='r2'),1);assert.throws(()=>assertCollectionScaleSettingsPaint(missing))})
test('Source09完整收口禁止late后台原UI invoke，但无invoke周期claim不冒称全局静止',()=>{const valid=drainFixture();valid.splice(4,0,event('main',4.5,'main.request',{invokeId:null,request:{id:'claim-1',command:'recordingPrintWorker.claim'}}));assertCollectionScaleRendererIpcDrain(valid);const missing=clone(valid);missing.push(event('main',4.6,'main.ipcRequest',{...missing[0].data,invokeId:'ipc-late'}));assert.throws(()=>assertCollectionScaleRendererIpcDrain(missing));const late=clone(valid);late.push(event('main',8,'main.ipcRequest',{...late[0].data,invokeId:'ipc-late'}));assert.throws(()=>assertCollectionScaleRendererIpcDrain(late))})

test('Source09 settings settled之后同action周期status保留，不追溯替代原选择',()=>{
 const e=latestSettingsFixture(),settled=e.pop()!;settled.sequence=6;settled.data.settingsStatusSelection=settingsFixture().at(-1).data.settingsStatusSelection
 for(const later of e.slice(10))if(later.actor==='main')later.sequence++
 e.splice(10,0,settled);assertCollectionScaleSettingsPaint(e)
 const premature=clone(e);premature.find((v:any)=>v.event==='main.ipcRequest'&&v.data.invokeId==='ipc-2').sequence=5.5;assert.throws(()=>assertCollectionScaleSettingsPaint(premature),'settled前未完成的最新status不能用旧paint放行')
})

// Source11只识别原probe首个ready工程wait；局部action-only片段仍不需要构造init。
function initializedSettingsFixture():any[]{
 const events=settingsFixture();for(const e of events)if(e.actor==='main'){e.sequence++;e.elapsedMs++}
 const snapshot={frameUrl:'musicbridge://app/index.html',readyState:'complete',total:null,page:null,rows:[],detail:null,readonlySettings:null,dialog:false,inventoryLoading:false,errorCount:0,filterClearVisible:false}
 return [event('main',1,'main.domSettled',{actionId:null,pollCount:1,durationMs:1,scope:'engineering-poll-wait',snapshot,settingsStatusSelection:null}),...events]
}
test('Source11初始化原工程wait与已actioned完整settings链并存接受',()=>{assertCollectionScaleSettingsPaint(initializedSettingsFixture());assertCollectionScaleSettingsPaint(settingsFixture())})
const initMutations:Record<string,(events:any[])=>void>={
 '重复null等待':e=>e.unshift(clone(e[0])),
 '晚到null等待':e=>{e[0].sequence=20},
 'null带status选择':e=>{e[0].data.settingsStatusSelection=clone(e.at(-1).data.settingsStatusSelection)},
 '初始ready未complete':e=>{e[0].data.snapshot.readyState='loading'},
 '初始快照缺字段':e=>{delete e[0].data.snapshot.filterClearVisible},
 '初始快照错误页面':e=>{e[0].data.snapshot.frameUrl='musicbridge://app/private.html'},
 '初始wait错scope':e=>{e[0].data.scope='product-paint'},
 'null隐藏settings等待':e=>{e.at(-1).data.actionId=null;e.at(-1).data.settingsStatusSelection=null},
 'settings动作ID漂移':e=>{e.at(-1).data.actionId='wrong'},
 '首settled不是初始化':e=>{const first=e.shift();e.splice(e.length,0,first)},
}
for(const [name,mutate] of Object.entries(initMutations))test('Source11初始化边界独立拒绝：'+name,()=>{const e=initializedSettingsFixture();mutate(e);assert.throws(()=>assertCollectionScaleSettingsPaint(e))})

test('真实初始化工程wait未改全图控制和null边界串改拒绝',()=>{
 const original=actual(),control=repack(original,()=>{});acceptCollectionScaleEvidence(control.report,control.expected)
 const changes:Record<string,(events:any[])=>void>={
  '初始null带selection':events=>{const first=events.find(e=>e.event==='main.domSettled'&&e.data.actionId===null),status=events.find(e=>e.event==='main.domSettled'&&e.data.settingsStatusSelection);first.data.settingsStatusSelection=clone(status.data.settingsStatusSelection)},
  '初始null错complete':events=>{events.find(e=>e.event==='main.domSettled'&&e.data.actionId===null).data.snapshot.readyState='loading'},
  '初始null缺失':events=>{events.find(e=>e.event==='main.domSettled'&&e.data.actionId===null).data.actionId='00000000-0000-4000-8000-000000000000'},
  'null隐藏settings':events=>{const status=events.find(e=>e.event==='main.domSettled'&&e.data.settingsStatusSelection);status.data.actionId=null;status.data.settingsStatusSelection=null},
 }
 for(const [name,mutate] of Object.entries(changes))assert.throws(()=>{const changed=repack(original,mutate);acceptCollectionScaleEvidence(changed.report,changed.expected)},name)
})

import { assertCollectionScaleActionReplies } from '../helpers/collection-scale-evidence.js'
function actionReplyFixture():any[]{
 const actionId='00000000-0000-4000-8000-000000000010',result=(limit:number)=>({hasMore:false,items:[],limit,offset:0,total:0})
 const read=(invokeId:string,id:string,ordinal:number|null,limit:number,start:number,end:number,filter:any)=>[
  event('main',start,'main.ipcRequest',{invokeId,actionId,channel:'collection:list',args:[{offset:0,limit},filter],catalogOrdinal:ordinal,sender:{trusted:true}}),
  event('main',start+0.1,'main.request',{actionId,invokeId,catalogOrdinal:ordinal,request:{version:1,id,command:'collection.list',payload:{page:{offset:0,limit},filter}}}),
  event('main',end-0.1,'main.response',{actionId,invokeId,catalogOrdinal:ordinal,requestId:id,command:'collection.list',reply:{version:1,id,ok:true,result:result(limit)}}),
  event('main',end,'main.ipcReply',{actionId,invokeId,catalogOrdinal:ordinal,channel:'collection:list',result:result(limit)})]
 return [event('main',1,'main.domAction',{actionId,operation:'clear'}),...read('ipc-catalog','00000000-0000-4000-8000-000000000011',1,24,2,3,{}),
 ...read('ipc-summary','00000000-0000-4000-8000-000000000012',null,1,4,6,{stockState:'needs-review'}),
 event('main',5,'main.domSettled',{actionId}),event('main',7,'main.rendererIpcDrained',{scope:'before-original-quit',pendingCount:0,requestCount:2,replyCount:2,rejectedCount:0})]
}
test('Source12局部Main边界：合法后台回执晚于settled但早于drain接受',()=>{const es=actionReplyFixture();assertCollectionScaleActionReplies(es,es[0],['collection:list'],0)})

const actionReplyMutations:Record<string,(e:any[])=>void>={
 '背景page额外键':e=>e[5].data.args[0].extra=1,'背景filter额外键':e=>e[5].data.args[1].query='',
 '背景非null ordinal':e=>{e[5].data.catalogOrdinal=2;e[6].data.catalogOrdinal=2;e[7].data.catalogOrdinal=2;e[8].data.catalogOrdinal=2},
 '未知limit':e=>e[5].data.args[0].limit=2,'未知offset':e=>e[5].data.args[0].offset=1,'未知filter':e=>e[5].data.args[1].stockState='sealed',
 '不可信sender':e=>e[5].data.sender.trusted=false,'错误invoke':e=>e[8].data.invokeId='wrong','缺invoke':e=>e.splice(5,1),'重复invoke':e=>e.push(clone(e[5])),
 '缺public请求':e=>e.splice(6,1),'重复public请求':e=>e.push(clone(e[6])),'public action漂移':e=>e[6].data.actionId='wrong','publicpayload漂移':e=>e[6].data.request.payload.filter={},
 '缺publicreply':e=>e.splice(7,1),'重复publicreply':e=>e.push(clone(e[7])),'publicid漂移':e=>e[7].data.requestId='wrong','public错误command':e=>e[7].data.command='collection.detail',
 '失败回执':e=>e[7].data.reply.ok=false,'完整DTO漂移':e=>e[8].data.result.total++,
 '仅后台无前台':e=>e.splice(1,4),'前台晚回执':e=>{e[4].sequence=6.1},'请求晚于settled':e=>e[5].sequence=5.1,
 '请求早于action':e=>e[5].sequence=0.9,'背景晚于drain':e=>e[8].sequence=7.1,'缺唯一drain':e=>e.splice(10,1),'重复drain':e=>e.push(clone(e[10])),
 '公开回复晚于IPC回复':e=>e[7].sequence=6.1,
}
for(const [name,mutate] of Object.entries(actionReplyMutations))test('Source12局部Main因果拒绝：'+name,()=>{const e=actionReplyFixture();mutate(e);assert.throws(()=>assertCollectionScaleActionReplies(e,e[0],['collection:list'],0))})
test('Source12局部Main边界：前台正常收口与refresh原语义保持',()=>{
 const e=actionReplyFixture();e[7].sequence=4.7;e[8].sequence=4.8;assertCollectionScaleActionReplies(e,e[0],['collection:list'],0)
 const action=event('main',1,'main.domAction',{actionId:'a',operation:'refresh'}),refresh=[action,event('main',2,'main.ipcRequest',{actionId:'a',invokeId:'refresh',channel:'collection:refresh',catalogOrdinal:null,sender:{trusted:true}}),event('main',3,'main.ipcReply',{actionId:'a',invokeId:'refresh',channel:'collection:refresh',catalogOrdinal:null,result:{refreshed:false}}),event('main',4,'main.domSettled',{actionId:'a'})]
 assertCollectionScaleActionReplies(refresh,action,['collection:refresh'],5000);const wrong=clone(refresh);wrong[2].data.result.refreshed=true;assert.throws(()=>assertCollectionScaleActionReplies(wrong,wrong[0],['collection:refresh'],5000));const late=clone(refresh);late[2].sequence=5;assert.throws(()=>assertCollectionScaleActionReplies(late,late[0],['collection:refresh'],5000))
})

test('Source12局部Main边界：非背景detail晚回复仍拒绝',()=>{const e=actionReplyFixture();for(const i of [5,8])e[i].data.channel='collection:detail';assert.throws(()=>assertCollectionScaleActionReplies(e,e[0],['collection:list','collection:detail'],0))})

test('当前合法settings完整选择仅注入discarded，精准拒绝同一代际',()=>{const e=settingsFixture();assertCollectionScaleSettingsPaint(e);e.push(event('renderer',6,'renderer.discarded',{...e[1].data}));assert.throws(()=>assertCollectionScaleSettingsPaint(e),/settings同代际已discarded/u)})
