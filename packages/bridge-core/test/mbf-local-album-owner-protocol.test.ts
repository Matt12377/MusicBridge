import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { isDatasetOwnerRequest, isDatasetOwnerResponse, type DatasetOwnerRequest } from '../src/collection/dataset-owner-protocol.js'

test('专辑Owner协议：明确三类读取的请求和回复都登记同一操作，跨库与未知前缀拒绝', () => {
  const request: DatasetOwnerRequest = { version: 1, type: 'request', epoch: randomUUID(), requestId: randomUUID(), sequence: 1,
    operation: 'localAlbumRead', expectedDatasetId: randomUUID(), album: { command: 'localAlbum.query', payload: { query: '', rootId: null, filter: 'all', offset: 0, limit: 60 } } }
  assert.ok(isDatasetOwnerRequest(request))
  assert.equal(isDatasetOwnerRequest({ ...request, expectedDatasetId: '/目录不是工作库身份' }), false)
  assert.equal(isDatasetOwnerRequest({ ...request, album: { command: 'localAlbum.apply', payload: {} } }), false)
  const response = { version: 1, type: 'response', epoch: request.epoch, requestId: request.requestId, operation: 'localAlbumRead', ok: true, result: {} }
  // 外层只登记operation；最终DTO和原分页回显须由Client已保存请求再次核验。
  assert.ok(isDatasetOwnerResponse(response))
  assert.equal(isDatasetOwnerResponse({ ...response, operation: 'localAlbumAnything' }), false)
})


// Node ALS及安全codec组件；不用SQL/Worker/Native证明实际读者。
test('专辑私有Trace：并发原上下文互不串首拒，getter/Proxy原错误不执行，快照闭核保首拒', async () => {
  const { runLocalAlbumContext, localAlbumPhase, localAlbumReject, localAlbumSafeError, snapshotLocalAlbumReadTrace, localAlbumTraceSha } = await import('../src/shared/local-album-read-trace-node.js')
  const { copyLocalAlbumReadTraceSnapshot } = await import('../src/shared/library-read-trace.js')
  const left = randomUUID(), right = randomUUID(); let release!: () => void; const held = new Promise<void>(resolve => { release = resolve })
  const leftWork = runLocalAlbumContext(left, null, 'worker.receive', async () => { await held; localAlbumPhase('owner.sql'); localAlbumReject(Object.assign(new Error('原秘密message'), { code: 'UNAVAILABLE', name: 'LocalAlbumReadError' })) })
  await runLocalAlbumContext(right, null, 'worker.receive', async () => { localAlbumPhase('owner.refresh'); localAlbumReject(Object.assign(new Error('另一原秘密stack'), { code: 'SNAPSHOT_CHANGED', name: 'LocalAlbumReadError' })); release() })
  await leftWork; const snapshot = snapshotLocalAlbumReadTrace(); assert.ok(copyLocalAlbumReadTraceSnapshot(snapshot))
  assert.equal(snapshot.firstRejects.find(value => value.traceSha256 === localAlbumTraceSha(left))?.firstStage, 'owner.sql')
  assert.equal(snapshot.firstRejects.find(value => value.traceSha256 === localAlbumTraceSha(right))?.firstStage, 'owner.refresh')
  assert.equal(JSON.stringify(snapshot).includes('原秘密'), false)
  let getters = 0; const source = {}; Object.defineProperty(source, 'code', { get() { getters++; return 'UNAVAILABLE' } }); Object.defineProperty(source, 'name', { get() { getters++; return 'Error' } })
  assert.deepEqual(localAlbumSafeError(source), { code: 'UNKNOWN', name: 'UNKNOWN' }); assert.equal(getters, 0)
  const proxy = new Proxy({}, { getOwnPropertyDescriptor() { getters++; throw new Error('不应触发') } }); assert.deepEqual(localAlbumSafeError(proxy), { code: 'UNKNOWN', name: 'UNKNOWN' }); assert.equal(getters, 0)
  assert.equal(copyLocalAlbumReadTraceSnapshot({ ...snapshot, authorization: true }), null)
})

// 仅私有安全codec/Node ALS组件；不证明实际Supervisor、Utility、Owner或Source读取。
test('专辑context Trace：27固定阶段跨安全流保SHA关联，任意phase/附加字段和错误关联拒绝', async () => {
  const { createHash } = await import('node:crypto')
  const { copyLocalAlbumSafeTrace, createLocalAlbumSafeTraceReader, readLocalAlbumPrivateFailure, localAlbumTraceIdSha256, emptyLocalAlbumTraceMatches, LOCAL_ALBUM_TRACE_PREFIX } = await import('../src/shared/library-read-trace.js')
  const child = randomUUID(), parent = randomUUID(), childSha = createHash('sha256').update(child).digest('hex'), parentSha = createHash('sha256').update(parent).digest('hex')
  assert.equal(localAlbumTraceIdSha256(child), childSha); assert.equal(localAlbumTraceIdSha256(parent), parentSha)
  const stages = [
    'context.supervisor.route', 'context.supervisor.ready', 'context.supervisor.budget', 'context.supervisor.cancel',
    'context.supervisor.send', 'context.supervisor.response', 'context.supervisor.dto', 'context.supervisor.receive.route', 'context.supervisor.receive.failure',
    'context.utility.receive', 'context.utility.ready', 'context.utility.endpoint', 'context.utility.prepare', 'context.utility.owner', 'context.utility.budget',
    'context.client.send', 'context.client.response', 'context.client.dto', 'context.client.ready', 'context.client.route', 'context.client.budget', 'context.client.cancel',
    'context.worker.receive', 'context.worker.ready', 'context.worker.owner', 'context.worker.dto', 'context.worker.reply',
  ] as const
  const received: unknown[] = [], consume = createLocalAlbumSafeTraceReader(safe => received.push(safe))
  const base = { version: 1, traceSha256: childSha, parentSha256: parentSha, code: 'NOT_READY', name: 'CoreIpcError', mappedCode: 'NOT_READY', elapsedMs: 1,
    outcome: 'reject', matches: emptyLocalAlbumTraceMatches(), preloadAssociated: true }
  for (const stage of stages) {
    const raw = { ...base, stage, firstStage: stage }, safe = copyLocalAlbumSafeTrace(raw); assert.ok(safe)
    const line = LOCAL_ALBUM_TRACE_PREFIX + JSON.stringify(safe) + '\n'; consume(line.slice(0, 13)); consume(line.slice(13))
    const failure = { version: 1, type: 'local-album-private-failure', correlationId: child, trace: safe }
    assert.deepEqual(readLocalAlbumPrivateFailure(failure, child, childSha)?.trace, safe)
    assert.equal(readLocalAlbumPrivateFailure(failure, parent, childSha), null)
    assert.equal(readLocalAlbumPrivateFailure(failure, child, parentSha), null)
    assert.equal(copyLocalAlbumSafeTrace({ ...raw, authorization: true }), null)
  }
  assert.equal(received.length, 27)
  for (const phase of ['context.anything', 'context.supervisor.receive', 'context.worker.reply.extra', 'context.utility.budget/secret', 'context.client.send\u0000']) {
    assert.equal(copyLocalAlbumSafeTrace({ ...base, stage: phase, firstStage: phase }), null)
    consume(LOCAL_ALBUM_TRACE_PREFIX + JSON.stringify({ ...base, stage: phase, firstStage: phase }) + '\n')
  }
  let converted = 0; assert.equal(copyLocalAlbumSafeTrace({ ...base, stage: { toString() { converted++; return 'context.worker.reply' } }, firstStage: null }), null)
  assert.equal(converted, 0); assert.equal(received.length, 27)
})

test('专辑context Trace：静默成功只执行一次并保原值/Promise，失败才保原own错误且sink失败不改业务', async () => {
  const { runLocalAlbumContext, localAlbumPhase, localAlbumReject, localAlbumTerminal, emitLocalAlbumNodeTrace, snapshotLocalAlbumReadTrace, localAlbumTraceSha } = await import('../src/shared/local-album-read-trace-node.js')
  const silent = randomUUID(), promised = randomUUID(), failed = randomUUID(), parentSha = localAlbumTraceSha(randomUUID())
  const value = Object.freeze({ owned: true }), originalPromise = Promise.resolve(value), lines: unknown[][] = [], originalInfo = console.info
  let calls = 0, privateReads = 0
  const originalError = Object.defineProperties({ name: 'CoreIpcError', code: 'NOT_READY' }, {
    message: { get() { privateReads++; throw new Error('不能读取原message') } },
    stack: { get() { privateReads++; throw new Error('不能读取原stack') } },
  })
  try {
    console.info = (...args: unknown[]) => { lines.push(args) }
    const result = runLocalAlbumContext(silent, parentSha, 'context.utility.receive', () => { calls++; emitLocalAlbumNodeTrace('begin'); emitLocalAlbumNodeTrace('ok'); return value }, true, false)
    assert.equal(result, value); assert.equal(calls, 1)
    const samePromise = runLocalAlbumContext(promised, parentSha, 'context.worker.receive', () => { calls++; emitLocalAlbumNodeTrace('ok'); return originalPromise }, true, false)
    assert.equal(samePromise, originalPromise); assert.equal(calls, 2); assert.deepEqual(lines, [])
    const before = snapshotLocalAlbumReadTrace()
    assert.ok(!before.records.some(row => [localAlbumTraceSha(silent), localAlbumTraceSha(promised)].includes(row.traceSha256)))
    console.info = () => { throw new Error('自有诊断sink故障') }
    let failureCalls = 0
    assert.throws(() => runLocalAlbumContext(failed, parentSha, 'context.client.send', () => {
      failureCalls++
      try { throw originalError } catch (error) {
        localAlbumPhase('context.client.response'); localAlbumReject(error, 'UNAVAILABLE')
        localAlbumPhase('context.client.dto'); localAlbumReject({ name: 'Error', code: 'UNAVAILABLE' }, 'UNAVAILABLE')
        const terminal = localAlbumTerminal('reject', 'UNAVAILABLE'); assert.ok(terminal)
        assert.equal(terminal.firstStage, 'context.client.response'); assert.equal(terminal.code, 'NOT_READY'); assert.equal(terminal.name, 'CoreIpcError')
        throw error
      }
    }, true, false), error => error === originalError)
    assert.equal(failureCalls, 1); assert.equal(privateReads, 0)
    const after = snapshotLocalAlbumReadTrace(), original = after.firstRejects.find(row => row.traceSha256 === localAlbumTraceSha(failed))
    assert.ok(original); assert.equal(original.parentSha256, parentSha); assert.equal(original.firstStage, 'context.client.response')
    assert.equal(original.code, 'NOT_READY'); assert.equal(original.name, 'CoreIpcError'); assert.equal(original.mappedCode, 'UNAVAILABLE')
    assert.ok(after.records.filter(row => row.traceSha256 === localAlbumTraceSha(failed)).every(row => row.outcome === 'reject'))
  } finally { console.info = originalInfo }
  assert.equal(await originalPromise, value)
})

test('专辑context Trace：诊断SHA或ALS前后故障只降级原工作一次，原同步throw和拒绝Promise不被替换', async () => {
  const { AsyncLocalStorage } = await import('node:async_hooks')
  const { runLocalAlbumContext } = await import('../src/shared/local-album-read-trace-node.js')
  const value = Object.freeze({ original: true }), originalError = Object.freeze({ originalFailure: true })
  let shaCalls = 0
  assert.equal(runLocalAlbumContext(null as unknown as string, null, 'context.utility.ready', () => { shaCalls++; return value }, false, false), value)
  assert.equal(shaCalls, 1)
  let shaFailureCalls = 0
  assert.throws(() => runLocalAlbumContext(null as unknown as string, null, 'context.utility.ready', () => { shaFailureCalls++; throw originalError }, false, false), error => error === originalError)
  assert.equal(shaFailureCalls, 1)
  const prototype = AsyncLocalStorage.prototype, descriptor = Object.getOwnPropertyDescriptor(prototype, 'run')!
  assert.equal(typeof descriptor.value, 'function')
  const actualRun = descriptor.value as (this: object, ...args: unknown[]) => unknown
  for (const boundary of ['before', 'after'] as const) {
    const diagnosticError = new Error('仅自有ALS诊断故障'), originalPromise = Promise.resolve(value), originalRejected = Promise.reject(originalError)
    let calls = 0, failureCalls = 0, promiseCalls = 0, rejectionCalls = 0
    const injected = { run(this: object, ...args: unknown[]): unknown {
      if (boundary === 'before') throw diagnosticError
      try { return Reflect.apply(actualRun, this, args) } finally { throw diagnosticError }
    } }.run
    Object.defineProperty(injected, 'length', { value: descriptor.value.length }); Object.defineProperty(injected, 'name', { value: descriptor.value.name })
    try {
      Object.defineProperty(prototype, 'run', { ...descriptor, value: injected })
      assert.equal(runLocalAlbumContext(randomUUID(), null, 'context.worker.ready', () => { calls++; return value }, false, false), value)
      assert.throws(() => runLocalAlbumContext(randomUUID(), null, 'context.worker.owner', () => { failureCalls++; throw originalError }, false, false), error => error === originalError)
      assert.equal(runLocalAlbumContext(randomUUID(), null, 'context.worker.reply', () => { promiseCalls++; return originalPromise }, false, false), originalPromise)
      assert.equal(runLocalAlbumContext(randomUUID(), null, 'context.worker.reply', () => { rejectionCalls++; return originalRejected }, false, false), originalRejected)
      assert.deepEqual([calls, failureCalls, promiseCalls, rejectionCalls], [1, 1, 1, 1])
    } finally { Object.defineProperty(prototype, 'run', descriptor); assert.deepEqual(Object.getOwnPropertyDescriptor(prototype, 'run'), descriptor) }
    assert.equal(await originalPromise, value); await assert.rejects(originalRejected, error => error === originalError)
  }
})

test('LP950 私有整组物化仅固定Owner操作和原请求锚点，截断错来源与getter均拒', async () => {
  const { isLocalAlbumOwnerReadRequest, isLocalAlbumOwnerReadResult } = await import('../src/collection/local-album-browser/owner-protocol.js')
  const datasetId = randomUUID(), rootId = randomUUID(), trackId = randomUUID(), assetId = randomUUID()
  const selection: import('@music-bridge/contracts').LocalPlayRequest = { schema_version: '1.2', request_id: randomUUID(), route: 'roon_audio_input', source_kind: 'local_file',
    local_track_id: trackId, asset_id: assetId, expected_asset_revision: '1', target: { core_id: 'owned-core', zone_id: 'owned-zone' }, action: 'PLAY_NOW',
    album: { datasetId, albumKey: 'directory:owned-950', rootId, revision: 'owned-950', kind: 'source-directory', editionId: null, trackCount: 1 } }
  const request: import('../src/collection/local-album-browser/owner-protocol.js').LocalAlbumOwnerReadRequest = { command: 'localAlbum.materializeQueue', payload: { selection, expiresAtMs: Date.now() + 2000 } }
  const outer = { version: 1, type: 'request', epoch: randomUUID(), requestId: randomUUID(), sequence: 1, operation: 'localAlbumRead', expectedDatasetId: datasetId, album: request }
  assert.ok(isDatasetOwnerRequest(outer)); assert.ok(isLocalAlbumOwnerReadRequest(request))
  for (const value of [{ ...request, command: 'localAlbum.materializeAnything' }, { ...request, payload: { ...request.payload, offset: 1 } },
    { ...request, payload: { ...request.payload, expiresAtMs: NaN } }, { ...request, payload: { ...request.payload, selection: { ...selection, action: 'APPEND_MB_QUEUE' } } }]) assert.equal(isLocalAlbumOwnerReadRequest(value), false)
  const source = { kind: 'local_file', edition: null, snapshot: { sourceKind: 'local_file', trackId, assetId, libraryRootId: rootId, sourceRootId: randomUUID(),
    rootRevision: '1', fileRevision: '1', locationRevision: '1', selectionRevision: '1', segment: null } }
  const result = { album: selection.album, sources: [source], edition: null, startIndex: 0 }
  assert.ok(isLocalAlbumOwnerReadResult(result, request))
  for (const value of [{ ...result, sources: [] }, { ...result, startIndex: 1 }, { ...result, album: { ...selection.album, datasetId: randomUUID() } },
    { ...result, sources: [{ ...source, snapshot: { ...source.snapshot, assetId: randomUUID() } }] }, { ...result, sources: [{ ...source, snapshot: { ...source.snapshot, libraryRootId: randomUUID() } }] },
    { ...result, path: '/not-a-permission' }]) assert.equal(isLocalAlbumOwnerReadResult(value, request), false)
  let reads = 0; const accessor = [source]; Object.defineProperty(accessor, '0', { enumerable: true, get() { reads++; return source } })
  assert.equal(isLocalAlbumOwnerReadResult({ ...result, sources: accessor }, request), false); assert.equal(reads, 0)
})


test('LP950 Main公开专辑仍仅三读取，Owner私有整组请求和快照不能越界为公开返回',async()=>{
  const {isLocalAlbumMainRequest,isLocalAlbumMainResponse,localAlbumMainFailure}=await import('../src/collection/local-album-browser/main-protocol.js')
  const {isLocalAlbumOwnerReadRequest,isLocalAlbumOwnerReadResult}=await import('../src/collection/local-album-browser/owner-protocol.js')
  const datasetId=randomUUID(),rootId=randomUUID(),trackId=randomUUID(),assetId=randomUUID()
  const selection:import('@music-bridge/contracts').LocalPlayRequest={schema_version:'1.2',request_id:randomUUID(),route:'roon_audio_input',source_kind:'local_file',
    local_track_id:trackId,asset_id:assetId,expected_asset_revision:'1',target:{core_id:'owned-core',zone_id:'owned-zone'},action:'PLAY_NOW',
    album:{datasetId,albumKey:'directory:boundary950',rootId,revision:'boundary950',kind:'source-directory',editionId:null,trackCount:1}}
  const privateRead:import('../src/collection/local-album-browser/owner-protocol.js').LocalAlbumQueueRequest={command:'localAlbum.materializeQueue',payload:{selection,expiresAtMs:Date.now()+2000}}
  const privateResult={album:selection.album,sources:[{kind:'local_file',edition:null,snapshot:{sourceKind:'local_file',trackId,assetId,libraryRootId:rootId,sourceRootId:randomUUID(),
    rootRevision:'1',fileRevision:'1',locationRevision:'1',selectionRevision:'1',segment:null}}],edition:null,startIndex:0}
  assert.ok(isLocalAlbumOwnerReadRequest(privateRead));assert.ok(isLocalAlbumOwnerReadResult(privateResult,privateRead))
  assert.equal(isLocalAlbumMainRequest({version:1,type:'local-album-main-request',id:randomUUID(),datasetId,request:privateRead}),false)
  const publicReads:import('../src/collection/local-album-browser/owner-protocol.js').LocalAlbumOwnerPublicReadRequest[]=[
    {command:'localAlbum.query',payload:{query:'',rootId:null,filter:'all',offset:0,limit:60}},
    {command:'localAlbum.tracks',payload:{albumKey:'directory:boundary950',rootId,offset:0,limit:200}},
    {command:'localAlbum.artwork',payload:{albumKey:'directory:boundary950',rootId,editionId:null,representativeTrackId:trackId,revision:'boundary950'}},
  ]
  for(const request of publicReads){
    const call:import('../src/collection/local-album-browser/main-protocol.js').LocalAlbumMainRequest={version:1,type:'local-album-main-request',id:randomUUID(),datasetId,request}
    assert.ok(isLocalAlbumMainRequest(call));assert.ok(isLocalAlbumMainResponse(localAlbumMainFailure(call,'UNAVAILABLE'),call))
    const reply: Record<string, unknown> = {version:1,type:'local-album-main-response',id:call.id,datasetId,command:request.command,ok:true,result:privateResult}
    assert.equal(isLocalAlbumMainResponse(reply,call),false)
    assert.equal(isLocalAlbumMainResponse({...reply,command:'localAlbum.materializeQueue'},call),false)
  }
  const query:import('../src/collection/local-album-browser/main-protocol.js').LocalAlbumMainRequest={version:1,type:'local-album-main-request',id:randomUUID(),datasetId,
    request:{command:'localAlbum.query',payload:{query:'',rootId:null,filter:'all',offset:0,limit:60}}}
  const page={query:'',rootId:null,filter:'all',offset:0,limit:60,total:0,hasMore:false,
    counts:{all:0,'missing-artwork':0,'has-artwork':0,'cue-unsplit':0,'metadata-issue':0,'parse-failed':0,'loose-audio':0,'track-named-audio':0,'missing-lyrics':0},items:[]}
  const reply={version:1,type:'local-album-main-response',id:query.id,datasetId,command:'localAlbum.query',ok:true,result:page}
  assert.ok(isLocalAlbumMainResponse(reply,query));assert.equal(isLocalAlbumMainResponse({...reply,result:{...page,total:1}},query),false)
  let reads=0;const accessor={};Object.defineProperty(accessor,'command',{enumerable:true,get(){reads++;return 'localAlbum.materializeQueue'}})
  Object.defineProperty(accessor,'payload',{enumerable:true,value:privateRead.payload})
  assert.equal(isLocalAlbumMainRequest({...query,request:accessor}),false);assert.equal(reads,0)
})
