import test from 'node:test'
import assert from 'node:assert/strict'
import { deriveRustPackagedRendererCostEvidence, acceptRustPackagedRendererCostEvidence } from '../helpers/rust-packaged-renderer-cost.js'
for (const [name,value] of [['缺真实输入',null],['空输入',{}],['伪大规模',{models:2000}],['非有限耗时',{durationMs:NaN}]] as const)
 test(name,()=>assert.throws(()=>acceptRustPackagedRendererCostEvidence(value,{} as any)))
test('四个原控件run缺失不能产生成本证据',()=>assert.throws(()=>deriveRustPackagedRendererCostEvidence({} as any)))

import { rendererMedian, rendererJsonDigest, RENDERER_RUN_KEYS } from '../helpers/rust-packaged-renderer-cost.js'
import { projectCollectionFilter } from '../../../../packages/bridge-core/src/rust-core/collection-query.js'
// 这些是纯计算样本；不作为签名App或真实26型号证据。
function calculationRuns():any {
 return Object.fromEntries(RENDERER_RUN_KEYS.map((key,at)=>{
  const request={version:1,id:`00000000-0000-4000-8000-${String(at+1).padStart(12,'0')}`,command:'collection.list',payload:{page:{offset:0,limit:24}}}
  const reply={version:1,id:request.id,ok:true,result:{items:[],offset:0,limit:24,total:0,hasMore:false}}
  const main=(sequence:number,event:string,data:any,elapsedMs:number)=>({schemaVersion:1,actor:'main',sequence,event,data,elapsedMs,pid:100+at})
  return [key,{mainPid:100+at,events:[main(1,'main.probePhase',{phase:key.endsWith('cold')?'cold':'matrix'},0),
   main(2,'main.domSettled',{actionId:'unit',pollCount:1,elapsedMs:3,snapshot:{}},0.1),
   main(3,'main.request',{actionId:'unit',request,requestJsonBytes:Buffer.byteLength(JSON.stringify(request)),requestSha256:rendererJsonDigest(request)},1),
   main(4,'main.response',{actionId:'unit',reply,requestId:request.id,command:request.command,durationMs:2,replyJsonBytes:Buffer.byteLength(JSON.stringify(reply)),replySha256:rendererJsonDigest(reply)},4),
   {actor:'core',event:'core.publicReply',data:{reply}}, {actor:'core',event:'node.reply',data:{requestId:request.id,command:request.command,result:reply.result}}]}]
 }))
}
test('纯计算：奇偶中位数保持原样本',()=>{const values=[9,1,3];assert.equal(rendererMedian(values),3);assert.deepEqual(values,[9,1,3]);assert.equal(rendererMedian([1,5]),3)})
test('纯计算：非有限与空耗时拒绝',()=>{assert.throws(()=>rendererMedian([]));assert.throws(()=>rendererMedian([NaN]));assert.throws(()=>rendererMedian([-1]))})
test('纯计算：四run实际字段配对、字节和Main时钟',()=>{const cost=deriveRustPackagedRendererCostEvidence(calculationRuns());assert.equal(cost.samples.length,4);assert.equal(cost.summary.length,4);assert.equal(cost.samples[0]!.clockId,'main:100');assert.equal(cost.summary[0]!.medianMs,2);assert.equal(cost.driverWait[0]!.elapsedMs,3)})
for(const [name,mutate] of [
 ['错请求字节',(runs:any)=>runs['node-fresh'].events[2].data.requestJsonBytes++],
 ['错回复摘要',(runs:any)=>runs['node-fresh'].events[3].data.replySha256='0'.repeat(64)],
 ['超出同Main观察跨度',(runs:any)=>runs['node-fresh'].events[3].data.durationMs=100],
 ['改Main进程',(runs:any)=>runs['node-fresh'].events[3].pid++],
 ['错Core完整DTO',(runs:any)=>runs['node-fresh'].events[4].data.reply.result.total=1],
 ['缺Node或Rust实际路线',(runs:any)=>runs['node-fresh'].events.pop()],
 ['重复请求id',(runs:any)=>runs['node-fresh'].events.splice(3,0,{...runs['node-fresh'].events[2],sequence:4,elapsedMs:2})],
] as const)test(`纯计算拒绝：${name}`,()=>{const runs=calculationRuns();mutate(runs);assert.throws(()=>deriveRustPackagedRendererCostEvidence(runs))})
test('纯计算：增长阶段读取不计成本',()=>{const runs=calculationRuns();runs['node-fresh'].events[0].data.phase='fresh';assert.throws(()=>deriveRustPackagedRendererCostEvidence(runs))})
function nativeCalculationRuns():any {
 const runs=calculationRuns()
 for(const key of ['rust-fresh','rust-cold']) {
  const events=runs[key].events,request=events[2].data.request,reply=events[3].data.reply
  const owner={epoch:'00000000-0000-4000-8000-000000000100',datasetId:'00000000-0000-4000-8000-000000000101'}
  const frame={protocolVersion:2,requestId:'00000000-0000-4000-8000-000000000102',...owner,snapshotId:'00000000-0000-4000-8000-000000000103',sequence:3,operation:'dispatch',payload:{request:{...structuredClone(request),expectedDatasetId:owner.datasetId},filterProjection:projectCollectionFilter({})}}
  events.pop()
  events.push({actor:'core',pid:200,sequence:1,event:'node.prepared',data:{identity:owner}},
   {actor:'core',pid:200,sequence:2,event:'rust.request',data:{pid:300,frame}},
   {actor:'core',pid:200,sequence:3,event:'rust.validated-reply',data:{pid:300,frame:{...frame,payload:undefined,ok:true,result:reply.result}}})
  delete events.at(-1).data.frame.payload
 }
 return runs
}
test('纯计算：公共IPC id与native transport id分别绑定唯一请求及完整ACK',()=>{
 const cost=deriveRustPackagedRendererCostEvidence(nativeCalculationRuns())
 assert.deepEqual(cost.samples.map(sample=>sample.route),['Node','Node','Rust','Rust'])
})
for(const [name,mutate] of [
 ['公共请求id漂移',(r:any)=>r[6].data.frame.payload.request.id='00000000-0000-4000-8000-000000000999'],
 ['transport ACK id漂移',(r:any)=>r[7].data.frame.requestId=r[2].data.request.id],
 ['Owner dataset漂移',(r:any)=>r[5].data.identity.datasetId='00000000-0000-4000-8000-000000000999'],
 ['Owner epoch漂移',(r:any)=>r[5].data.identity.epoch='00000000-0000-4000-8000-000000000999'],
 ['完整dispatch payload漂移',(r:any)=>r[6].data.frame.payload.request.payload.page.limit=23],
 ['wire版本漂移',(r:any)=>r[7].data.frame.protocolVersion=1],
 ['ACK Core进程漂移',(r:any)=>r[7].pid++],
 ['ACK Rust进程漂移',(r:any)=>r[7].data.pid++],
] as const)test(`纯计算双id拒绝：${name}`,()=>{const runs=nativeCalculationRuns();mutate(runs['rust-cold'].events);assert.throws(()=>deriveRustPackagedRendererCostEvidence(runs))})

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { rendererDigest, rendererExternalPath } from '../helpers/rust-packaged-renderer-cost.js'
test('实际Main成本artifact准入与重算hash串改',async t=>{
 const reportPath=process.env.MUSIC_BRIDGE_RUST_PACKAGED_RENDERER_COST,expectedPath=process.env.MUSIC_BRIDGE_RUST_PACKAGED_RENDERER_COST_EXPECTED_IDENTITY
 assert.ok(reportPath&&expectedPath,'缺实际成本及独立runtime身份，不能skip或构造PASS。');rendererExternalPath(reportPath);rendererExternalPath(expectedPath)
 const report=JSON.parse(readFileSync(reportPath,'utf8')),expected=JSON.parse(readFileSync(expectedPath,'utf8'))
 assert.equal(acceptRustPackagedRendererCostEvidence(report,expected),true)
 const parent=path.join(path.dirname(path.dirname(reportPath)),'author-c');mkdirSync(parent,{recursive:true,mode:0o700});const dir=mkdtempSync(path.join(parent,'actual-cost-'))
 await t.test('成本artifact完全不变重封装PASS控制',()=>{
  const file=path.join(dir,'cost-unchanged-control.json'),bytes=Buffer.from(JSON.stringify(report,null,2)+'\n');writeFileSync(file,bytes,{flag:'wx',mode:0o600})
  const binding=structuredClone(expected);binding.artifact={path:file,sha256:rendererDigest(bytes),bytes:bytes.length}
  assert.equal(acceptRustPackagedRendererCostEvidence(report,binding),true)
 })
 for(const [name,mutate] of [
  ['样本耗时',(r:any)=>r.samples[0].durationMs++],['进程时钟',(r:any)=>r.samples[0].clockId='renderer:1'],
  ['DTO摘要',(r:any)=>r.samples[0].dtoSha256='0'.repeat(64)],['实际路线',(r:any)=>r.samples[0].route=r.samples[0].route==='Node'?'Rust':'Node'],
  ['JSON字节',(r:any)=>r.samples[0].replyJsonBytes++],['中位数',(r:any)=>r.summary[0].medianMs++],
  ['人为等待混成本',(r:any)=>r.samples[0].durationMs+=r.driverWait[0].elapsedMs+100],['DOM等待冒充0',(r:any)=>r.driverWait[0].elapsedMs=0],
  ['fixture规模冒称2000',(r:any)=>r.models=2000],['增长阶段样本混入',(r:any)=>r.samples.push({...r.samples[0],requestId:'伪造增长读取'})],
 ] as const)await t.test(name,()=>{
  const altered=structuredClone(report),binding=structuredClone(expected);mutate(altered)
  const file=path.join(dir,`${name}.json`),bytes=Buffer.from(JSON.stringify(altered,null,2)+'\n');writeFileSync(file,bytes,{flag:'wx',mode:0o600});binding.artifact={path:file,sha256:rendererDigest(bytes),bytes:bytes.length}
  assert.throws(()=>acceptRustPackagedRendererCostEvidence(altered,binding))
 })
})
