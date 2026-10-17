import assert from 'node:assert/strict'
import test from 'node:test'
import { closeSync, openSync, writeSync } from 'node:fs'
import { copyLocalPlaybackEvidence, createLocalPlaybackEvidenceCollector, writeLocalPlaybackGuardSync } from '../src/main/local-playback-evidence.js'

const base = {timestamp:'2026-10-14T10:00:00.000Z',level:'info',event:'local_playback_media_evidence',schemaVersion:1,component:'gateway',diagnosticId:'diag-local-'+'a'.repeat(64),stage:'transfer-terminal',currentOwned:true,staleCallback:false,
  requestSequence:1,method:'GET',routeClass:'local-file',rangeClass:'none',outcome:'body-completed',statusCode:200,pipelineBodyBytesObserved:100,observedBytesCapped:false,responseFinished:true,elapsedMs:10,completedPipelineBodyBytes:100}
test('私有媒体记录：完成计数只允许自然完成与相同body数量，异常不冒送达',()=>{
  assert.deepEqual(copyLocalPlaybackEvidence(base),base)
  for(const changes of [{outcome:'aborted'},{responseFinished:false},{observedBytesCapped:true},{completedPipelineBodyBytes:99},{method:'HEAD'},{pipelineBodyBytesObserved:NaN}]) assert.equal(copyLocalPlaybackEvidence({...base,...changes}),null)
  const {completedPipelineBodyBytes:_,...partial}=base
  assert.ok(copyLocalPlaybackEvidence({...partial,outcome:'aborted',responseFinished:false}))
})
test('私有媒体记录：HEAD零body与截断17均不签音频完成',()=>{
  const {completedPipelineBodyBytes:_,...head}=base
  assert.ok(copyLocalPlaybackEvidence({...head,method:'HEAD',outcome:'head-ended',pipelineBodyBytesObserved:0}))
  assert.equal(copyLocalPlaybackEvidence({...head,method:'HEAD',outcome:'head-ended',pipelineBodyBytesObserved:1}),null)
  const record={timestamp:base.timestamp,level:'info',event:base.event,schemaVersion:1,component:'gateway',diagnosticId:base.diagnosticId,stage:'truncated',currentOwned:false,staleCallback:true,requestSequence:17,method:'GET',routeClass:'local-file',rangeClass:'other',requestLimit:16}
  assert.ok(copyLocalPlaybackEvidence(record));assert.equal(copyLocalPlaybackEvidence({...record,requestSequence:18}),null)
})
test('私有媒体记录：拒绝URL、会话、UUID、未知字段及accessor且不读取getter',()=>{
  for(const key of ['url','token','sessionId','requestId','trackId','sourcePath','message','stack','extra']) assert.equal(copyLocalPlaybackEvidence({...base,[key]:'不可导出'}),null)
  let reads=0;const hostile={...base};Object.defineProperty(hostile,'diagnosticId',{enumerable:true,get(){reads++;throw Error('不能读取')}})
  assert.equal(copyLocalPlaybackEvidence(hostile),null);assert.equal(reads,0)
  assert.equal(copyLocalPlaybackEvidence({...base,diagnosticId:'原UUID'}),null)
})
test('私有媒体记录：当前owned与stale、会话确认及两个进度样本保持语义',()=>{
  assert.equal(copyLocalPlaybackEvidence({...base,currentOwned:true,staleCallback:true}),null)
  const position={timestamp:base.timestamp,level:'info',event:'local_playback_evidence',schemaVersion:1,component:'controller',diagnosticId:base.diagnosticId,stage:'position',currentOwned:true,staleCallback:false,sessionConfirmed:true,elapsedMs:1,sampleSequence:1,source:'audio-input',positionMs:0,positionAdvanced:false}
  assert.ok(copyLocalPlaybackEvidence(position));assert.ok(copyLocalPlaybackEvidence({...position,sampleSequence:2,positionMs:1000,positionAdvanced:true}))
  for(const changes of [{sessionConfirmed:false},{staleCallback:true},{currentOwned:false},{sampleSequence:3},{sampleSequence:1,positionAdvanced:true},{positionMs:-1}]) assert.equal(copyLocalPlaybackEvidence({...position,...changes}),null)
})
test('私有媒体记录：切分JSON、普通日志、超长行恢复与有限ring，snapshot互不改写',()=>{
  const reader=createLocalPlaybackEvidenceCollector(),line=JSON.stringify(base)+'\n'
  reader.consume(line.slice(0,40));assert.equal(reader.snapshot().length,0);reader.consume(line.slice(40));assert.equal(reader.snapshot().length,1)
  reader.consume('普通错误文本\n'+JSON.stringify({...base,url:'https://example.invalid'})+'\n');assert.equal(reader.snapshot().length,1)
  reader.consume('{'+ 'x'.repeat(9000));reader.consume('\n'+line);assert.equal(reader.snapshot().length,2)
  for(let i=0;i<300;i++)reader.consume(line);assert.equal(reader.snapshot().length,256)
  const before=reader.snapshot();assert.throws(()=>Object.assign(before[0],{outcome:'error'}));assert.equal(reader.snapshot()[0]!.outcome,'body-completed')
  reader.clear();assert.equal(reader.snapshot().length,0)
})

const requestGuard = {timestamp:base.timestamp,level:'info',event:'local_play_request_guard_evidence',schemaVersion:1,component:'controller',diagnosticId:'diag-local-'+'a'.repeat(64),requestFingerprintSha256:'b'.repeat(64),stage:'request-guard',operationStage:'SECOND_FACTS',firstStage:'SECOND_FACTS',phase:'failed',elapsedMs:10,code:'FACTS_CHANGED',errorClass:'LocalSourcePreparationError',httpStatus:409,cancelled:'not-observed',intentMatch:'match',targetMatch:'match',sourceMatch:'mismatch',fenceMatch:'not-checked',snapshotMatch:'match',factsMatch:'mismatch',differenceMask:16383}

test('PRIVATE_PLAY_GUARD_CARRIER：23字段、独立双hash与闭集边界',()=>{
  const copied=copyLocalPlaybackEvidence(requestGuard)
  assert.deepEqual(copied,requestGuard);assert.ok(Object.isFrozen(copied));assert.equal(Object.keys(copied!).length,23)
  for(const code of ['INVALID_REQUEST','TARGET_CHANGED','FACTS_CHANGED','UNAUTHORIZED_ROOT','SEGMENT_UNSUPPORTED','READ_CANCELLED','READ_DEADLINE','ROON_TRANSPORT_UNAVAILABLE','INVENTORY_UNAVAILABLE']) assert.equal(copyLocalPlaybackEvidence({...requestGuard,code})?.code,code)
  assert.ok(copyLocalPlaybackEvidence({...requestGuard,firstStage:'NONE',phase:'started',code:'NONE',errorClass:'NONE',httpStatus:0,differenceMask:0}))
  const invalid:Record<string,unknown>[]=[
    {diagnosticId:'diag-local-'+'a'.repeat(63)},{diagnosticId:'diag-local-'+'A'.repeat(64)},
    {requestFingerprintSha256:'b'.repeat(63)},{requestFingerprintSha256:'B'.repeat(64)},{requestFingerprintSha256:'diag-local-'+'b'.repeat(64)},
    {component:'gateway'},{stage:'unlisted'},{operationStage:'OTHER'},{firstStage:'OTHER'},{phase:'ready'},{code:'UNLISTED_CODE'},{errorClass:'TypeError'},{cancelled:true},
    {intentMatch:true},{targetMatch:'unknown'},{sourceMatch:null},{fenceMatch:0},{snapshotMatch:'yes'},{factsMatch:'no'},
    {httpStatus:201},{httpStatus:409.5},{elapsedMs:-1},{elapsedMs:86_400_001},{elapsedMs:NaN},{differenceMask:-1},{differenceMask:16384},{differenceMask:0.5},
    {timestamp:'2026-02-30T10:00:00.000Z'},{timestamp:'2026-10-14T10:00:00Z'},{timestamp:base.timestamp+'x'},
  ]
  for(const changes of invalid) assert.equal(copyLocalPlaybackEvidence({...requestGuard,...changes}),null)
})

test('PRIVATE_PLAY_GUARD_CARRIER：缺字段、额外私密载荷和accessor整条拒绝',()=>{
  for(const key of Object.keys(requestGuard)) {
    const missing:Record<string,unknown>={...requestGuard};delete missing[key]
    assert.equal(copyLocalPlaybackEvidence(missing),null)
    let reads=0;const hostile:Record<string,unknown>={...requestGuard}
    Object.defineProperty(hostile,key,{enumerable:true,get(){reads++;throw Error('不读取getter')}})
    assert.equal(copyLocalPlaybackEvidence(hostile),null);assert.equal(reads,0)
  }
  for(const key of ['url','path','target','session','requestId','trackId','token','message','stack','currentOwned','extra']) assert.equal(copyLocalPlaybackEvidence({...requestGuard,[key]:'合成毒字段'}),null)
  const hidden={...requestGuard};Object.defineProperty(hidden,'extra',{value:'合成隐藏值',enumerable:false})
  assert.equal(copyLocalPlaybackEvidence(hidden),null)
  assert.equal(copyLocalPlaybackEvidence({...requestGuard,[Symbol('extra')]:'合成值'}),null)
  assert.equal(copyLocalPlaybackEvidence(Object.assign(Object.create({}),requestGuard)),null)
  let stageReads=0
  const changing=new Proxy({...requestGuard},{getOwnPropertyDescriptor(value,key){const descriptor=Reflect.getOwnPropertyDescriptor(value,key);return key==='stage'&&descriptor?{...descriptor,value:stageReads++===0?'request-guard':'unlisted'}:descriptor}})
  assert.equal(copyLocalPlaybackEvidence(changing),null)
})

test('PRIVATE_PLAY_GUARD_CARRIER：同源分片、旧五形状和跨来源半行',()=>{
  const reader=createLocalPlaybackEvidenceCollector(),line=JSON.stringify(requestGuard)+'\n',forwarded:unknown[]=[]
  let firstOwned=true
  const first=(row:unknown)=>{if(!firstOwned)return false;forwarded.push(row)},second=(row:unknown)=>{forwarded.push(row)}
  reader.consume(line.slice(0,40),first);assert.equal(reader.snapshot().length,0)
  reader.consume(line.slice(40),first);assert.deepEqual(forwarded,[requestGuard]);assert.equal(reader.snapshot().length,1)
  reader.clear();forwarded.length=0
  reader.consume(line.slice(0,40),first);reader.consume(line.slice(40),second)
  assert.equal(reader.snapshot().length,0);assert.equal(forwarded.length,0)
  firstOwned=false
  reader.consume(line,second);assert.equal(reader.snapshot().length,1);assert.deepEqual(forwarded,[requestGuard])
  reader.consume(line.slice(40),first);assert.equal(reader.snapshot().length,1);assert.equal(forwarded.length,1)
  reader.consume(line,()=>false);assert.equal(reader.snapshot().length,1)
  const common={timestamp:base.timestamp,level:'info',schemaVersion:1,diagnosticId:base.diagnosticId,currentOwned:true,staleCallback:false}
  const oldRows=[
    {...common,event:'local_playback_evidence',component:'controller',stage:'roon-phase',sessionConfirmed:true,elapsedMs:1,phase:'PLAYING'},
    {...common,event:'local_playback_evidence',component:'controller',stage:'position',sessionConfirmed:true,elapsedMs:1,sampleSequence:1,source:'zone',positionMs:0,positionAdvanced:false},
    {...common,event:base.event,component:'gateway',stage:'request',requestSequence:1,method:'GET',routeClass:'local-file',rangeClass:'none'},
    {...common,event:base.event,component:'gateway',stage:'truncated',requestSequence:17,method:'GET',routeClass:'local-file',rangeClass:'none',requestLimit:16},
    base,
  ]
  let oldSinkCalls=0
  for(const row of oldRows) { assert.deepEqual(copyLocalPlaybackEvidence(row),row);reader.consume(JSON.stringify(row)+'\n',()=>{oldSinkCalls++;return false}) }
  assert.equal(oldSinkCalls,0);assert.equal(forwarded.length,1);assert.deepEqual(reader.snapshot().slice(1),oldRows)
  reader.consume('普通日志\n'+JSON.stringify({...requestGuard,url:'https://example.invalid'})+'\n',second)
  assert.equal(forwarded.length,1);assert.equal(reader.snapshot().length,6)
})

test('PRIVATE_PLAY_GUARD_CARRIER：超长恢复、256ring和sink失败不丢必要错误',()=>{
  const reader=createLocalPlaybackEvidenceCollector(),line=JSON.stringify(requestGuard)+'\n'
  let calls=0;const sink=()=>{calls++;if(calls===1)throw Error('合成日志写失败')}
  assert.doesNotThrow(()=>reader.consume(line+line,sink));assert.equal(calls,2);assert.equal(reader.snapshot().length,2)
  reader.consume('{'+ 'x'.repeat(8192),sink);reader.consume('\n'+line,sink)
  assert.equal(calls,3);assert.equal(reader.snapshot().length,3)
  for(let i=0;i<260;i++)reader.consume(line,sink)
  const failure={...requestGuard,operationStage:'SDK_SUBMIT',firstStage:'SDK_SUBMIT',code:'ROON_TRANSPORT_UNAVAILABLE',errorClass:'BridgeError',phase:'failed'}
  reader.consume(JSON.stringify(failure)+'\n',sink)
  assert.equal(calls,264);assert.equal(reader.snapshot().length,256);assert.deepEqual(reader.snapshot().at(-1),failure)
  const before=reader.snapshot();assert.throws(()=>Object.assign(before.at(-1)!,{code:'UNKNOWN'}));assert.equal(reader.snapshot().at(-1)?.code,'ROON_TRANSPORT_UNAVAILABLE')
  reader.clear();assert.equal(reader.snapshot().length,0)
  const readOnlyFd=openSync('/dev/null','r')
  try {
    assert.throws(()=>writeSync(readOnlyFd,'合成只读FD探针'),{code:'EBADF'})
    assert.equal(writeLocalPlaybackGuardSync(requestGuard,readOnlyFd),false)
    assert.doesNotThrow(()=>reader.consume(line,row=>{assert.equal(writeLocalPlaybackGuardSync(row,readOnlyFd),false)}))
    assert.deepEqual(reader.snapshot(),[requestGuard])
  } finally { closeSync(readOnlyFd) }
})
