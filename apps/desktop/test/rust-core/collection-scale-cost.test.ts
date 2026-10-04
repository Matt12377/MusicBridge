import { historicalScaleFragment } from '../helpers/historical-scale-fragments.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import { COLLECTION_SCALE_RUN_KEYS, deriveCollectionScaleCostEvidence } from '../helpers/collection-scale-evidence.js'
import { parseCollectionScaleEvent } from '../../scripts/collection-scale-runtime.mjs'
test('成本缺真实十三run不得给空样本PASS',()=>{
 assert.throws(()=>deriveCollectionScaleCostEvidence({}))
 const runs=Object.fromEntries(COLLECTION_SCALE_RUN_KEYS.map(key=>[key,{receipt:{events:[]},evidence:{path:'/tmp/fabricated',sha256:'0'.repeat(64),bytes:1}}]));assert.throws(()=>deriveCollectionScaleCostEvidence(runs))
})
test('成本不准负数/无穷值/另一actor时钟冒充包围值',()=>{
 const base={schemaVersion:1,actor:'core',pid:1,sequence:1,elapsedMs:1,event:'core.cost',data:{stage:'nativeRpc',durationMs:1,outcome:'fulfilled',snapshotProfile:'v2-2000'}}
 assert.deepEqual(parseCollectionScaleEvent(base),base)
 for(const durationMs of [-1,Infinity,NaN])assert.throws(()=>parseCollectionScaleEvent({...base,data:{...base.data,durationMs}}))
 assert.throws(()=>parseCollectionScaleEvent({...base,actor:'renderer'}))
})
test('工程execute观察闭集准入且不准冒称Renderer产品时间',()=>{
 const base={schemaVersion:1,actor:'main',pid:1,sequence:1,elapsedMs:1,event:'main.domExecution',data:{actionId:'00000000-0000-4000-8000-000000000000',durationMs:1,scope:'engineering-execute-and-control-ready-wait'}}
 assert.deepEqual(parseCollectionScaleEvent(base),base)
 assert.throws(()=>parseCollectionScaleEvent({...base,actor:'renderer'}));assert.throws(()=>parseCollectionScaleEvent({...base,data:{...base.data,productPaintMs:1}}))
})
test('省略清除必须有原无筛选24limit回执，工程execute因果独立校验',async()=>{
 const {assertCollectionScaleEngineeringObservations}=await import('../helpers/collection-scale-evidence.js')
 const id='00000000-0000-4000-8000-000000000000',snapshot={frameUrl:'musicbridge://app/index.html',readyState:'complete',total:0,page:null,rows:[],detail:null,readonlySettings:null,dialog:false,inventoryLoading:false,errorCount:0,filterClearVisible:false}
 const event=(sequence:number,event:string,data:any)=>({schemaVersion:1,actor:'main',pid:1,sequence,elapsedMs:sequence,event,data})
 const valid=[event(1,'main.domAction',{actionId:id}),event(2,'main.ipcRequest',{invokeId:'ipc-1',channel:'collection:list',args:[{offset:0,limit:24},{}]}),event(3,'main.ipcReply',{invokeId:'ipc-1',channel:'collection:list'}),event(4,'main.domExecution',{actionId:id,durationMs:1,scope:'engineering-execute-and-control-ready-wait'}),event(5,'main.domSettled',{actionId:id,snapshot}),event(6,'main.domResetSkipped',{reason:'original-clear-control-absent-in-unfiltered-state'})]
 assertCollectionScaleEngineeringObservations(valid)
 const emptyStrings=structuredClone(valid);emptyStrings[1].data.args[1]={query:'',brand:''};assertCollectionScaleEngineeringObservations(emptyStrings)
 for(const mutate of [(v:any[])=>v[1].data.args[1]={query:'实际非空'},(v:any[])=>v[1].data.args[0].limit=100,(v:any[])=>v[4].data.snapshot.filterClearVisible=true,(v:any[])=>delete v[4].data.snapshot.filterClearVisible,(v:any[])=>v[3].data.scope='renderer-paint',(v:any[])=>v[3].sequence=7,(v:any[])=>v[3].data.actionId='another']){const copy=structuredClone(valid);mutate(copy);assert.throws(()=>assertCollectionScaleEngineeringObservations(copy))}
})

// 仅测试关联算法的局部事件夹具；不是实际包、成本样本或十三run正例。
function selectionFixture():{events:any[];warm:any} {
 const actionId='11111111-1111-4111-8111-111111111111',events:any[]=[],seq:any={main:0,renderer:0,core:0},pid:any={main:1,renderer:2,core:3},reply={items:[],offset:0,limit:24,total:0,hasMore:false}
 const emit=(actor:string,event:string,data:any)=>{const e={schemaVersion:1,actor,pid:pid[actor],sequence:++seq[actor],elapsedMs:seq[actor],event,data};events.push(e);return e}
 emit('main','main.domAction',{actionId,operation:'workload',workload:'all',iteration:0,mode:'node'})
 const read=(ordinal:number,trigger:any,paint:boolean)=>{
  const requestId=`00000000-0000-4000-8000-${String(ordinal).padStart(12,'0')}`,invokeId=`ipc-${ordinal}`,observationId=`renderer-${ordinal}`,page={offset:0,limit:24},filter={query:'',brand:''},identity={actionId,observationId,generation:ordinal+1,layer:'catalog',triggerSequence:trigger.sequence,triggerDomEvent:trigger.data.domEvent,catalogOrdinal:ordinal,request:{page,filter}}
  emit('renderer','renderer.begin',identity)
  emit('main','main.ipcRequest',{actionId,invokeId,catalogOrdinal:ordinal,channel:'collection:list',args:[page,filter]})
  const request={id:requestId,command:'collection.list',payload:{page,filter}},publicReply={id:requestId,ok:true,result:reply}
  emit('main','main.request',{actionId,invokeId,catalogOrdinal:ordinal,request})
  emit('core','core.publicReply',{requestId,reply:publicReply,durationMs:1});emit('core','node.reply',{requestId,result:reply})
  emit('main','main.response',{actionId,invokeId,catalogOrdinal:ordinal,requestId,command:request.command,reply:publicReply,durationMs:1})
  emit('main','main.ipcReply',{actionId,invokeId,catalogOrdinal:ordinal,channel:'collection:list',result:reply})
  emit('renderer','renderer.invokeReply',{...identity,result:reply,durationMs:1});emit('renderer','renderer.commit',{...identity,result:reply,durationMs:2})
  let painted:any;if(paint){emit('renderer','renderer.nextTick',{...identity,durationMs:3});painted=emit('renderer','renderer.paint',{...identity,durationMs:4,scope:'paint-opportunity-after-latest-commit'})}
  return {...identity,invokeId,requestId,paintRendererSequence:painted?.sequence}
 }
 const first=emit('renderer','renderer.trigger',{actionId,domEvent:'change'});read(1,first,false)
 const second=emit('renderer','renderer.trigger',{actionId,domEvent:'change'});read(2,second,true)
 // 原页面背景needs-review计数不参与24limit目录ordinal或暖样本。
 emit('main','main.request',{actionId,invokeId:'ipc-aux',catalogOrdinal:null,request:{id:'00000000-0000-4000-8000-000000000004',command:'collection.list',payload:{page:{offset:0,limit:1},filter:{stockState:'needs-review'}}}})
 const submit=emit('renderer','renderer.trigger',{actionId,domEvent:'submit',target:'FORM'}),selected=read(3,submit,true)
 const selection={finalSubmitRendererSequence:submit.sequence,observationId:selected.observationId,generation:selected.generation,catalogOrdinal:3,invokeId:selected.invokeId,requestId:selected.requestId,paintRendererSequence:selected.paintRendererSequence}
 const warm=emit('main','main.warmSample',{actionId,workload:'all',iteration:0,mode:'node',warmup:false,reply,selection});return {events,warm}
}
test('成本最终submit选择保留多次早读/早paint和背景读取，仅最新paint计暖样本',async()=>{
 const {selectCollectionScaleWarmObservation}=await import('../helpers/collection-scale-evidence.js')
 const fixture=selectionFixture(),result=selectCollectionScaleWarmObservation(fixture.events,fixture.warm)
 assert.equal(result.request.id,fixture.warm.data.selection.requestId);assert.deepEqual(result.engineeringReadCounts,{catalogRequests:3,allListRequests:4,paintedCatalogReads:2,selectedWarmReads:1})
})
const selectionMutations:Record<string,(events:any[],warm:any)=>void>={
 '选择早期paint':(events,warm)=>{const early=events.find(e=>e.event==='renderer.paint');Object.assign(warm.data.selection,{observationId:early.data.observationId,generation:early.data.generation,catalogOrdinal:early.data.catalogOrdinal,paintRendererSequence:early.sequence})},
 '错generation':(_events,warm)=>warm.data.selection.generation++,
 '非FORM的submit':events=>events.find(e=>e.event==='renderer.trigger'&&e.data.domEvent==='submit').data.target='BUTTON',
 '非submit触发':events=>events.filter(e=>e.data.observationId==='renderer-3').forEach(e=>e.data.triggerDomEvent='change'),
 '非最后submit':(events,warm)=>warm.data.selection.finalSubmitRendererSequence=events.find(e=>e.event==='renderer.trigger').sequence,
 '伪造paint身份':(_events,warm)=>warm.data.selection.paintRendererSequence--,
 'ALS错invokeId':events=>events.find(e=>e.event==='main.request'&&e.data.catalogOrdinal===3).data.invokeId='ipc-2',
 '公共reply错ordinal':events=>events.find(e=>e.event==='main.response'&&e.data.catalogOrdinal===3).data.catalogOrdinal=2,
 '原filter非空':events=>events.find(e=>e.event==='main.request'&&e.data.catalogOrdinal===3).data.request.payload.filter.query='非空',
 '未知filter字段':events=>events.find(e=>e.event==='renderer.begin').data.request.filter.unknown='',
 '重复warm':(events,warm)=>events.push(structuredClone(warm)),
 '晚于选中代的begin':events=>{const final=structuredClone(events.find(e=>e.event==='renderer.begin'&&e.data.catalogOrdinal===3));final.sequence=999;final.data.generation++;events.push(final)},
 '早于reply的warm':(_events,warm)=>warm.sequence=1,
}
for(const [label,mutate] of Object.entries(selectionMutations))test(`成本最终submit关联串改拒绝：${label}`,async()=>{
 const {selectCollectionScaleWarmObservation}=await import('../helpers/collection-scale-evidence.js');const {events,warm}=selectionFixture();mutate(events,warm);assert.throws(()=>selectCollectionScaleWarmObservation(events,warm))
})
test('成本空filter只允许原query/brand空串等价，原payload保持',async()=>{
 const {normalizeCollectionScaleObservedFilter}=await import('../helpers/collection-scale-evidence.js');const raw={query:'',brand:''};assert.deepEqual(normalizeCollectionScaleObservedFilter(raw),{});assert.deepEqual(raw,{query:'',brand:''})
 for(const filter of [{unknown:''},{query:1},{brand:null},{decade:''},{stockState:''}])assert.throws(()=>normalizeCollectionScaleObservedFilter(filter))
 assert.deepEqual(normalizeCollectionScaleObservedFilter({query:' ',brand:'甲'}),{query:' ',brand:'甲'})
})
test('成本05实际失败前缀固定原SHA，三次目录读/两次paint不能当单读',async()=>{
 const own=historicalScaleFragment('source05-multi-read-fragment.json').events,catalog=own.filter((e:any)=>e.event==='main.request'&&e.data.request.command==='collection.list'&&e.data.request.payload.page.limit===24),paint=own.filter((e:any)=>e.event==='renderer.paint'&&e.data.layer==='catalog')
 assert.equal(catalog.length,3);assert.equal(paint.length,2);assert.equal(own.filter((e:any)=>e.event==='main.request'&&e.data.request.payload?.page?.limit===1).length,2)
 for(const request of catalog)assert.deepEqual(request.data.request.payload.filter,{query:'',brand:''})
 // 历史单读约束对真实原UI必失败；当前新私有身份并未补造进旧样本。
 assert.throws(()=>assert.equal(catalog.length,1));assert.equal(own.filter((e:any)=>e.event==='main.warmSample').length,0)
})
test('成本最新submit私有身份闭集与早期discarded元数据可解析',()=>{
 const {events,warm}=selectionFixture();assert.deepEqual(parseCollectionScaleEvent(warm),warm)
 const discarded=structuredClone(events.find(e=>e.event==='renderer.commit'));discarded.event='renderer.discarded';delete discarded.data.result;assert.deepEqual(parseCollectionScaleEvent(discarded),discarded)
 for(const mutate of [(v:any)=>delete v.data.selection,(v:any)=>v.data.selection.extra=true,(v:any)=>v.data.selection.catalogOrdinal=0]){const copy=structuredClone(warm);mutate(copy);assert.throws(()=>parseCollectionScaleEvent(copy))}
})
test('成本05实际reset片段应排除背景limit1后绑定最近原24limit回执',async()=>{
 const {assertCollectionScaleEngineeringObservations}=await import('../helpers/collection-scale-evidence.js')
 for(const name of ['source05-reset-1-fragment.json','source05-reset-2-fragment.json'] as const){
  const fragment=historicalScaleFragment(name).events
  assert.equal(fragment.length,6);assert.equal(fragment.filter(e=>e.event==='main.domResetSkipped').length,1)
  assert.equal(fragment.filter(e=>e.event==='main.ipcRequest'&&e.data.args[0].limit===1).length,1)
  assertCollectionScaleEngineeringObservations(fragment)
  for(const change of [(v:any[])=>{v.find(e=>e.event==='main.ipcRequest'&&e.data.args[0].limit===24).data.args[1]={query:'非空'}},(v:any[])=>{v.find(e=>e.event==='main.ipcRequest'&&e.data.args[0].limit===24).data.args[0].limit=1},(v:any[])=>{v.find(e=>e.event==='main.ipcRequest'&&e.data.args[0].limit===24).data.args[1]={unknown:''}}]){const copy=structuredClone(fragment);change(copy);assert.throws(()=>assertCollectionScaleEngineeringObservations(copy))}
 }
})
test('成本RSS零读严格owned PID/600秒边界且不进入正样本分布',async()=>{
 const {assertCollectionScaleRssEvidence}=await import('../helpers/collection-scale-evidence.js'),rss={intervalMs:100,scope:'bounded-runtime-ps-sampling',clock:'runtime-performance',samples:[{pid:1,elapsedMs:100,rssKiB:4096}],zeroReadings:[{pid:1,elapsedMs:200,rssKiB:0,psStatus:0}],errors:[]}
 assertCollectionScaleRssEvidence(rss,new Set([1]))
 for(const mutate of [(v:any)=>v.samples[0].rssKiB=0,(v:any)=>v.zeroReadings[0].pid=2,(v:any)=>v.zeroReadings[0].elapsedMs=1e15,(v:any)=>v.zeroReadings[0].elapsedMs=-1,(v:any)=>v.zeroReadings[0].elapsedMs=NaN,(v:any)=>v.zeroReadings[0].rssKiB=-1,(v:any)=>v.zeroReadings[0].rssKiB=1,(v:any)=>v.zeroReadings[0].psStatus=1,(v:any)=>v.zeroReadings[0].terminalCause='zombie',(v:any)=>delete v.zeroReadings,(v:any)=>v.errors.push({pid:1,code:'PS_FAILED'})]){const copy=structuredClone(rss);mutate(copy);assert.throws(()=>assertCollectionScaleRssEvidence(copy,new Set([1])))}
})

// 复用只在同步derive内部；公开入口在同raw对象后续变更后仍须完整独立拒绝。
test('成本公共暖选择重复调用保留所有早读原件，不信外部cache参数',async()=>{
 const {selectCollectionScaleWarmObservation}=await import('../helpers/collection-scale-evidence.js'),fixture=selectionFixture()
 const first=selectCollectionScaleWarmObservation(fixture.events,fixture.warm),second=selectCollectionScaleWarmObservation(fixture.events,fixture.warm)
 assert.deepEqual(second,first);assert.deepEqual(second.engineeringReadCounts,{catalogRequests:3,allListRequests:4,paintedCatalogReads:2,selectedWarmReads:1})
 const cached=first.renderer;fixture.events.find(e=>e.event==='renderer.paint'&&e.data.observationId===fixture.warm.data.selection.observationId).data.generation++
 assert.throws(()=>selectCollectionScaleWarmObservation(fixture.events,fixture.warm))
 assert.throws(()=>(selectCollectionScaleWarmObservation as (...args:any[])=>any)(fixture.events,fixture.warm,[cached]),'第三参数不得作为外部可信cache绕过实际raw')
})
test('成本公共暖选择再次调用必须拒绝未选早期读取完整DTO漂移',async()=>{
 const {selectCollectionScaleWarmObservation}=await import('../helpers/collection-scale-evidence.js'),fixture=selectionFixture()
 selectCollectionScaleWarmObservation(fixture.events,fixture.warm)
 const early=fixture.events.find(e=>e.event==='renderer.commit'&&e.data.catalogOrdinal===1);early.data.result={...early.data.result,total:99}
 assert.throws(()=>selectCollectionScaleWarmObservation(fixture.events,fixture.warm),'最新选中读取没有变化，但早期原件仍需完整验证')
})
