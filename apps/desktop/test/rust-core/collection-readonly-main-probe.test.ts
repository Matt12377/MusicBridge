import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import {mkdirSync,mkdtempSync,writeFileSync,readFileSync} from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { collectionReadonlyDomExpression } from '../../src/main/collection-readonly-dom-driver.js'
import { validateCollectionReadonlyRunOptions } from '../../scripts/collection-readonly-runtime.mjs'
import { createCollectionReadonlyEvidenceWriter, createCollectionReadonlyMainProbe, observeCollectionReadonlyIpc, collectionReadonlyRefreshSettled } from '../../src/main/collection-readonly-main-probe.js'
function diagnosticEnv() {
 Object.defineProperty(globalThis,'__MUSIC_BRIDGE_COLLECTION_READONLY_DIAGNOSTICS__',{value:true,configurable:true,writable:true})
 const base='/Volumes/LifeWeave/Developer/CommandLine/tmp/mb-rust-core-014-w08_nmgh/author-c';mkdirSync(base,{recursive:true,mode:0o700});const profile=mkdtempSync(path.join(base,'musicbridge-ui-diagnostics-'));writeFileSync(path.join(profile,'rust014-profile.json'),JSON.stringify({schemaVersion:1,kind:'rust014-synthetic-profile',nonce:randomUUID()}),{flag:'wx',mode:0o600})
 const prior={...process.env};Object.assign(process.env,{MUSIC_BRIDGE_UI_E2E:'1',MUSIC_BRIDGE_UI_E2E_OFFLINE:'1',MUSIC_BRIDGE_UI_E2E_USER_DATA_DIR:profile});delete process.env.MUSIC_BRIDGE_STARTUP_TEST
 return ()=>{for(const key of Object.keys(process.env))if(!(key in prior))delete process.env[key];Object.assign(process.env,prior)}
}
test('Main纯观察writer隔离输出异常并保留单actor序号',()=>{
 const lines:string[]=[],emit=createCollectionReadonlyEvidenceWriter('main',line=>{lines.push(line);if(lines.length===1)throw new Error('sink')});emit('main.diagnosticsInstalled');emit('main.coreReady')
 const events=lines.map(line=>JSON.parse(line.slice('RUST014_EVIDENCE '.length)));assert.deepEqual(events.map(x=>x.sequence),[1,2]);assert.ok(events.every(x=>x.pid===process.pid&&x.actor==='main'));assert.ok(events[1].elapsedMs>=events[0].elapsedMs)
})
test('Main观察child不增加端口、不改bootstrap或原postMessage返回',()=>{
 const restore=diagnosticEnv();try{
  const lines:string[]=[],probe=createCollectionReadonlyMainProbe({sink:line=>lines.push(line)}),child=new EventEmitter() as any,stdout=new EventEmitter();let posted:unknown
  child.pid=123;child.stdout=stdout;const original=(value:unknown,ports:unknown[])=>{posted={value,ports};return '原返回'};child.postMessage=original;child.kill=()=>true
  probe.observeChild(child,'/fixed/core.js',[]);assert.equal(child.postMessage,original);child.emit('spawn')
  const message={type:'musicbridge.core.port'},port={};assert.equal(child.postMessage(message,[port]),'原返回');assert.deepEqual(posted,{value:message,ports:[port]});child.pid=null;child.emit('exit',0)
  const events=lines.map(line=>JSON.parse(line.slice('RUST014_EVIDENCE '.length)));assert.deepEqual(events.map(x=>x.event),['main.diagnosticsInstalled','main.coreFork','main.coreSpawn','main.coreExit']);assert.equal(events.at(-1).data.pid,123)
 }finally{restore()}
})
test('普通三API IPC保持原Promise身份及boolean参数，不安装控制器',async()=>{
 const result=Promise.resolve({schemaVersion:1,enabled:true,mode:'node',state:'failed',errorCode:'RUST_UNAVAILABLE'}),events:any[]=[],sender={webContentsId:1,rendererPid:2,frameUrl:'musicbridge://app/index.html',trusted:true as const};let args:unknown[]=[]
 const listener=observeCollectionReadonlyIpc({channel:'collection:set-readonly-enabled',listener:(_event:unknown,...values:unknown[])=>{args=values;return result},trustedSender:()=>sender,observe:(event,data)=>events.push({event,data})})
 assert.equal(listener({},true),result);assert.deepEqual(args,[true]);await result;await Promise.resolve();assert.deepEqual(events.map(x=>x.event),['main.ipcRequest','main.ipcReply']);assert.deepEqual(events[0].data.args,[true]);assert.equal(events[1].data.result.enabled,true)
})
test('可信sender无效仍由原listener拒绝，观察不吞原异常',()=>{
 const error=new Error('原信任拒绝'),events:any[]=[],listener=observeCollectionReadonlyIpc({channel:'collection:refresh',listener:()=>{throw error},trustedSender:()=>undefined,observe:(...args)=>events.push(args)})
 assert.throws(()=>listener({}),value=>value===error);assert.deepEqual(events,[])
})
test('Main public request/reply保持原数据且记录真实同PID往返',()=>{
 const restore=diagnosticEnv();try{
  const lines:string[]=[],probe=createCollectionReadonlyMainProbe({sink:line=>lines.push(line)}),port=new EventEmitter() as any;let posted:unknown;port.postMessage=(value:unknown)=>{posted=value};probe.observePublicPort(port)
  const request={version:1,id:randomUUID(),command:'collection.list',payload:{page:{offset:0,limit:24}}};port.postMessage(request);assert.equal(posted,request)
  const reply={version:1,id:request.id,ok:true,result:{items:[],offset:0,limit:24,total:0,hasMore:false}};port.emit('message',{data:reply});const events=lines.map(line=>JSON.parse(line.slice('RUST014_EVIDENCE '.length)))
  const observed=events.find(x=>x.event==='main.response');assert.deepEqual(observed.data.reply,reply);assert.equal(observed.data.requestId,request.id);assert.ok(observed.data.durationMs>=0)
 }finally{restore()}
})

function domFixture() {
 const calls:string[]=[],checkbox={checked:false,disabled:false,getClientRects:()=>[{}],matches:(selector:string)=>selector===':disabled'&&checkbox.disabled,scrollIntoView:()=>{},click:()=>{checkbox.checked=!checkbox.checked;calls.push('checkbox.click')}},refresh={textContent:'刷新库存',getClientRects:()=>[{}],matches:()=>false,scrollIntoView:()=>{},click:()=>calls.push('refresh.click')}
 const state={dataset:{enabled:'false',mode:'node',state:'off'}},root={getClientRects:()=>[{}],matches:()=>false,scrollIntoView:()=>{},querySelector:()=>null,querySelectorAll:(selector:string)=>selector==='button'?[refresh]:[]}
 const document={readyState:'complete',querySelector:(selector:string)=>selector==='[data-testid="collection-readonly-state"]'?state:selector==='#collection-panel-tapes'?root:null,querySelectorAll:(selector:string)=>selector==='input[type="checkbox"][aria-label="Rust 收藏查询"]'?[checkbox]:selector==='#collection-panel-tapes'?[root]:[]}
 const sandbox={document,location:{href:'musicbridge://app/index.html'},getComputedStyle:()=>({visibility:'visible',display:'block'}),setTimeout,window:new Proxy({}, {get(){throw new Error('禁止访问窗口API')}})}
 return {calls,checkbox,document,run:(operation:any)=>vm.runInNewContext(collectionReadonlyDomExpression(operation),sandbox)}
}
test('原DOM开关仅实际click，重复ON和禁用状态不产生操作',async()=>{
 const fixture=domFixture();await fixture.run('readonly-on');assert.equal(fixture.checkbox.checked,true);assert.deepEqual(fixture.calls,['checkbox.click'])
 await assert.rejects(fixture.run('readonly-on'),/不是一次真实状态变化/u);assert.equal(fixture.calls.length,1)
 fixture.checkbox.disabled=true;await assert.rejects(fixture.run('readonly-off'),/尚不可用/u);assert.equal(fixture.calls.length,1)
 fixture.checkbox.disabled=false;await fixture.run('readonly-off');assert.equal(fixture.checkbox.checked,false);assert.deepEqual(fixture.calls,['checkbox.click','checkbox.click'])
})
test('库存刷新通过原可见按钮click，不访问窗口API',async()=>{
 const fixture=domFixture(),snapshot=await fixture.run('refresh');assert.deepEqual(fixture.calls,['refresh.click']);assert.equal(snapshot.readonlySettings.mode,'node');assert.equal(snapshot.readonlySettings.enabled,false)
})
test('DOM固定参数拒绝外部动作与型号注入',()=>{
 for(const args of [['direct-api'],['readonly-on',0],['receive-save'],['detail-open',26]] as any[])assert.throws(()=>collectionReadonlyDomExpression(args[0],args[1]),/参数无效/u)
})
test('实际Vue侧栏打开设置与原application tab按DOM结构完成导航',async()=>{
 const sidebar=readFileSync(new URL('../../src/renderer/src/components/sidebar/SidebarSettingsFooter.vue',import.meta.url),'utf8'),settings=readFileSync(new URL('../../src/renderer/src/components/settings/SettingsView.vue',import.meta.url),'utf8')
 const aria=/aria-label="([^"]+)"/u.exec(sidebar)?.[1];assert.equal(aria,'打开设置')
 assert.match(settings,/:id="'settings-tab-' \+ category"/u);assert.match(settings,/application: '应用'/u)
 const calls:string[]=[];let screen='inventory',category='account'
 const element=(click:()=>void,text='')=>({textContent:text,getClientRects:()=>[{}],matches:()=>false,scrollIntoView:()=>{},click})
 const footer=element(()=>{screen='settings';calls.push('sidebar.open')}),application=element(()=>{category='application';calls.push('tab.application')},'应用')
 const document={readyState:'complete',querySelector:(selector:string)=>selector==='[data-testid="collection-readonly-state"]'&&screen==='settings'&&category==='application'?{dataset:{enabled:'false',mode:'node',state:'off'}}:null,
 querySelectorAll:(selector:string)=>selector===`button[aria-label="${aria}"]`?[footer]:screen==='settings'&&(selector==='#settings-tab-application'||selector==='button')?[application]:[]}
 const snapshot=await vm.runInNewContext(collectionReadonlyDomExpression('settings-open'),{document,location:{href:'musicbridge://app/index.html'},getComputedStyle:()=>({visibility:'visible',display:'block'}),setTimeout,window:new Proxy({}, {get(){throw new Error('禁止访问窗口API')}})})
 assert.deepEqual(calls,['sidebar.open','tab.application']);assert.equal(snapshot.readonlySettings.state,'off')
})
test('运行wrapper拒绝运行期入口/二进制/参数选择与越界路径，未启动App',async()=>{
 const base={executable:'/Volumes/LifeWeave/Developer/CommandLine/tmp/nonexistent.app/Contents/MacOS/Nonexistent',expectedExecutableSha256:'a'.repeat(64),evidenceDirectory:'/Volumes/LifeWeave/Developer/CommandLine/tmp/nonexistent-evidence',kind:'rust-controls',launch:{type:'fresh'}}
 for(const value of [{...base,mode:'rust'},{...base,args:['--inspect']},{...base,binary:'/selected'},{...base,kind:'rust-renderer'},{...base,executable:'/Users/yihe/App.app/Contents/MacOS/App'},{...base,evidenceDirectory:'/Volumes/LifeWeave/Developer/CommandLine/tmp/../escape'},{...base,launch:{type:'fresh',enabled:true}},{...base,kind:'pin-rejected',launch:{type:'cold',priorReceiptPath:'/Volumes/LifeWeave/Developer/CommandLine/tmp/prior.json',priorReceiptSha256:'a'.repeat(64)}}])await assert.rejects(validateCollectionReadonlyRunOptions(value as any))
})
test('详情刷新须同动作列表及详情普通IPC真实完成，不能仅接受刷新ACK',()=>{
 const actionId='dom-refresh',modelId=randomUUID(),snapshot:any={inventoryLoading:false,detail:{modelId}},controlReplies=[{actionId,channel:'collection:refresh',args:[],result:{refreshed:true}}]
 const base={actionId,expectation:'rust' as const,snapshot,expectedDetailId:modelId,controlReplies,readReplies:[] as any[]}
 assert.equal(collectionReadonlyRefreshSettled(base),false)
 const list={actionId,channel:'collection:list',args:[{offset:0,limit:24}],result:{limit:24}},detail={actionId,channel:'collection:detail',args:[modelId,{offset:0,limit:20}],result:{model:{id:modelId}}}
 assert.equal(collectionReadonlyRefreshSettled({...base,readReplies:[list]}),false)
 assert.equal(collectionReadonlyRefreshSettled({...base,readReplies:[list,{...detail,actionId:'旧动作'}]}),false)
 assert.equal(collectionReadonlyRefreshSettled({...base,readReplies:[list,{...detail,result:{model:{id:randomUUID()}}}]}),false)
 assert.equal(collectionReadonlyRefreshSettled({...base,readReplies:[list,detail]}),true)
 assert.equal(collectionReadonlyRefreshSettled({...base,snapshot:{...snapshot,inventoryLoading:true},readReplies:[list,detail]}),false)
 for(const expectation of ['node','pin'] as const)assert.equal(collectionReadonlyRefreshSettled({...base,expectation,controlReplies:[{...controlReplies[0]!,result:{refreshed:false}}],readReplies:[list,detail]}),true)
 assert.equal(collectionReadonlyRefreshSettled({...base,expectation:'node',expectedDetailId:null,snapshot:{inventoryLoading:false,detail:null} as any,controlReplies:[{...controlReplies[0]!,result:{refreshed:false}}],readReplies:[list]}),true)
})
test('详情DOM刷新中字样保持inventoryLoading直到原控件完成',async()=>{
 const fixture=domFixture(),button={textContent:'刷新中…',getClientRects:()=>[{}]};fixture.document.querySelector=(selector:string)=>selector==='#collection-panel-tapes'?{querySelector:()=>null,querySelectorAll:(selector:string)=>selector==='button'?[button]:[]} as any:null
 const snapshot=await fixture.run('snapshot');assert.equal(snapshot.inventoryLoading,true)
 button.textContent='刷新库存';assert.equal((await fixture.run('snapshot')).inventoryLoading,false)
})
