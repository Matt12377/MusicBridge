import assert from 'node:assert/strict'
import test from 'node:test'
import { validateCollectionScaleRunOptions, parseCollectionScaleEvent, collectionScalePriorClosed } from '../../scripts/collection-scale-runtime.mjs'

test('实际App启动前闭集参数拒绝路径/运行期selector/非法规模', async () => {
  for (const input of [{}, { executable: '/Users/yihe/user.app', expectedExecutableSha256: '0'.repeat(64), evidenceDirectory: '/tmp/a', kind: 'scale-100', launch: { type: 'fresh' } }, { executable: '/tmp/a', expectedExecutableSha256: '0'.repeat(64), evidenceDirectory: '/tmp/a', kind: 'scale-100', launch: { type: 'fresh' }, mode: 'rust' }]) {
    await assert.rejects(validateCollectionScaleRunOptions(input as never))
  }
})
test('实际事件仅数据闭集，拒绝凭据字段和伪clock', () => {
  const event = { schemaVersion: 1, actor: 'core', pid: 1, sequence: 1, elapsedMs: 0, event: 'core.cost', data: { stage: 'routerDispatch', durationMs: 1 } }
  assert.deepEqual(parseCollectionScaleEvent(event), event)
  assert.throws(() => parseCollectionScaleEvent({ ...event, elapsedMs: -1 }))
  assert.throws(() => parseCollectionScaleEvent({ ...event, data: { cookie: 'REJECT' } }))
  assert.throws(() => parseCollectionScaleEvent({ ...event, data: Object.defineProperty({}, 'x', { get: () => 1, enumerable: true }) }))
})
test('冷启不可用局部ready替代真实Node/原outbox/关闭ACK', () => {
  assert.equal(collectionScalePriorClosed({ schemaVersion: 1, kind: 'scale-0', launch: { type: 'fresh' }, completion: 'closed', mainExit: { code: 0, signal: null }, events: [] }, 'scale-0'), false)
  assert.equal(collectionScalePriorClosed({ schemaVersion: 1, kind: 'scale-100', launch: { type: 'fresh' }, completion: 'closed', mainExit: { code: 0, signal: null }, events: [{ event: 'main.rendererProbeComplete', data: { phase: 'fresh' } }] }, 'scale-100'), false)
})

test('未知事件、错actor和嵌套访问器不能借外层JSON字段准入', () => {
 const base={schemaVersion:1,actor:'core',pid:1,sequence:1,elapsedMs:0,event:'core.cost',data:{stage:'routerDispatch',durationMs:1}}
 assert.throws(()=>parseCollectionScaleEvent({...base,event:'core.fabricatedEvidence'}))
 assert.throws(()=>parseCollectionScaleEvent({...base,actor:'main'}))
 assert.throws(()=>parseCollectionScaleEvent({...base,data:{...base.data,claim:'PASS'}}))
 assert.throws(()=>parseCollectionScaleEvent({...base,event:'node.reply',data:{requestId:'id',command:'collection.list',result:Object.defineProperty({},'items',{get(){throw new Error('不应调用')},enumerable:true})}}))
})

// 执行原Main早期配置/路径初始化，模拟真实runner给予的TMPDIR；不启动Electron。
test('默认startup与六诊断profile须由原Main guard在同一os.tmpdir内准入', async()=>{
 const {mkdtempSync,mkdirSync,realpathSync}=await import('node:fs'),path=await import('node:path'),os=await import('node:os')
 const {readStartupTestConfiguration,initializeStartupTestPaths}=await import('../../src/main/startup-test-config.js')
 const {COLLECTION_SCALE_PROFILE_PREFIXES}=await import('../../scripts/collection-scale-runtime.mjs')
 const directory='/Volumes/LifeWeave/Developer/CommandLine/tmp/mb-rust-core-015-i0qxwbi7/author-c';mkdirSync(directory,{recursive:true,mode:0o700});const temp=mkdtempSync(path.join(directory,'startup-guard-')),previous=process.env.TMPDIR
 try { process.env.TMPDIR=temp;assert.equal(realpathSync(os.tmpdir()),realpathSync(temp))
  for(const [kind,prefix] of Object.entries(COLLECTION_SCALE_PROFILE_PREFIXES)){
   const profile=mkdtempSync(path.join(temp,prefix)),defaultRun=kind==='default-node'
   const env=defaultRun?{MUSIC_BRIDGE_STARTUP_TEST:'1',MUSIC_BRIDGE_STARTUP_USER_DATA_DIR:profile}:{MUSIC_BRIDGE_UI_E2E:'1',MUSIC_BRIDGE_UI_E2E_OFFLINE:'1',MUSIC_BRIDGE_UI_E2E_USER_DATA_DIR:profile}
   const config=readStartupTestConfiguration(env),writes:any[]=[];assert.equal(config.isStartupTest,defaultRun)
   assert.equal(initializeStartupTestPaths(config,!defaultRun,{isReady:()=>false,setPath:(name,value)=>{writes.push([name,value])}}),realpathSync(profile));assert.deepEqual(writes,[['userData',realpathSync(profile)],['sessionData',realpathSync(profile)]])
  }
  const wrong=mkdtempSync(path.join(temp,'musicbridge-ui-diagnostics-'));assert.throws(()=>readStartupTestConfiguration({MUSIC_BRIDGE_STARTUP_TEST:'1',MUSIC_BRIDGE_STARTUP_USER_DATA_DIR:wrong}),/invalid temporary directory name/u)
  const outside=mkdtempSync(path.join(directory,'musicbridge-task036-startup-'));assert.throws(()=>readStartupTestConfiguration({MUSIC_BRIDGE_STARTUP_TEST:'1',MUSIC_BRIDGE_STARTUP_USER_DATA_DIR:outside}),/below the system temp directory/u)
 } finally {if(previous===undefined)delete process.env.TMPDIR;else process.env.TMPDIR=previous}
})

test('实际Core拒绝保存原Buffer身份闭集，错误不升级为成功',()=>{
 const base={schemaVersion:1,actor:'main',pid:17,sequence:1,elapsedMs:1,event:'main.coreEvidenceRejected',data:{reason:'INVALID_JSON',rawBytes:3,rawSha256:'1'.repeat(64),rawLinePath:'/Volumes/LifeWeave/Developer/CommandLine/tmp/mb-rust-core-015-i0qxwbi7/tmp/musicbridge-ui-diagnostics-local/rust015-core-rejected-11111111-1111-4111-8111-111111111111-17-1.bin',rawSaved:true}}
 assert.deepEqual(parseCollectionScaleEvent(base),base)
 for(const reason of ['INVALID_JSON','FORWARD_FAILED','INCOMPLETE_FRAGMENT'])assert.deepEqual(parseCollectionScaleEvent({...base,data:{...base.data,reason,rawSaved:false,rawLinePath:null}}).data.reason,reason)
 for(const mutate of [(v:any)=>v.data.reason='PASS',(v:any)=>v.data.rawBytes=16*1024*1024+1,(v:any)=>v.data.rawSha256='bad',(v:any)=>v.data.rawLinePath='/Users/yihe/private.bin',(v:any)=>v.data.rawLinePath=v.data.rawLinePath.replace('-17-1.bin','-18-1.bin'),(v:any)=>v.data.rawLinePath=v.data.rawLinePath.replace('-17-1.bin','-17-5.bin'),(v:any)=>v.data.rawSaved=false,(v:any)=>v.data.extra=true,(v:any)=>delete v.data.rawSaved]){const copy=structuredClone(base);mutate(copy);assert.throws(()=>parseCollectionScaleEvent(copy))}
})
test('实际RSS producer将零读分列保留且正样本不混入0',async()=>{
 const {recordCollectionScaleRssReading}=await import('../../scripts/collection-scale-runtime.mjs'),rss:any={samples:[],zeroReadings:[]}
 recordCollectionScaleRssReading(rss,{pid:17,elapsedMs:100,rssKiB:4096,psStatus:0});recordCollectionScaleRssReading(rss,{pid:17,elapsedMs:200,rssKiB:0,psStatus:0})
 assert.deepEqual(rss,{samples:[{pid:17,elapsedMs:100,rssKiB:4096}],zeroReadings:[{pid:17,elapsedMs:200,rssKiB:0,psStatus:0}]})
 for(const reading of [{pid:17,elapsedMs:100,rssKiB:-1,psStatus:0},{pid:17,elapsedMs:100,rssKiB:NaN,psStatus:0},{pid:17,elapsedMs:600001,rssKiB:1,psStatus:0},{pid:17,elapsedMs:100,rssKiB:0,psStatus:1},{pid:0,elapsedMs:100,rssKiB:0,psStatus:0}])assert.throws(()=>recordCollectionScaleRssReading(rss as never,reading))
})

// 只验证Source09新增观察闭集，不启动App或伪造真实签包通过。
test('Source09原UI drain闭集五字段和settings选择六字段准入',()=>{
 const base={schemaVersion:1,actor:'main',pid:17,sequence:1,elapsedMs:1,event:'main.rendererIpcDrained',data:{scope:'before-original-quit',pendingCount:0,requestCount:7,replyCount:7,rejectedCount:0}}
 assert.deepEqual(parseCollectionScaleEvent(base),base)
 for(const mutate of [(v:any)=>delete v.data.replyCount,(v:any)=>v.data.extra=0,(v:any)=>v.data.pendingCount=1,(v:any)=>v.data.requestCount=-1,(v:any)=>v.data.replyCount=NaN,(v:any)=>v.data.rejectedCount=1,(v:any)=>v.data.scope='after-quit']){const v=structuredClone(base);mutate(v);assert.throws(()=>parseCollectionScaleEvent(v))}
 const settled={...base,event:'main.domSettled',data:{actionId:'a',pollCount:1,durationMs:1,scope:'engineering-poll-wait',snapshot:{},settingsStatusSelection:null as any}}
 assert.deepEqual(parseCollectionScaleEvent(settled),settled)
 settled.data.settingsStatusSelection={observationId:'renderer-1',generation:1,invokeId:'ipc-1',requestId:'00000000-0000-4000-8000-000000000001',paintRendererSequence:7}
 assert.deepEqual(parseCollectionScaleEvent(settled),settled)
 for(const mutate of [(v:any)=>delete v.data.settingsStatusSelection,(v:any)=>v.data.settingsStatusSelection.extra=true,(v:any)=>v.data.settingsStatusSelection.generation=0,(v:any)=>v.data.settingsStatusSelection.paintRendererSequence=-1,(v:any)=>v.data.settingsStatusSelection.requestId='invalid',(v:any)=>delete v.data.settingsStatusSelection.invokeId]){const v=structuredClone(settled);mutate(v);assert.throws(()=>parseCollectionScaleEvent(v))}
})
