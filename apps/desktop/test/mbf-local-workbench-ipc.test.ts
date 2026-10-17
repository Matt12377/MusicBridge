import assert from 'node:assert/strict'
import test from 'node:test'
import * as dto from '@music-bridge/contracts'
import { createLocalWorkbenchClient } from '../src/preload/local-workbench-client.js'
import { registerLocalWorkbenchIpc, type LocalWorkbenchIpcOptions, type LocalWorkbenchMainEvent, type LocalWorkbenchMainRequest } from '../src/main/local-library-workbench/workbench-ipc.js'
import { createLocalWorkbenchRendererPorts, createLocalWorkbenchResultReaders } from '../src/renderer/src/composables/application/local-library-workbench/ports.js'
import type { LocalWorkbenchLyricsResultKey, LocalWorkbenchLibraryResultKey } from '../src/renderer/src/composables/application/local-library-workbench/types.js'

const datasetId = '11111111-1111-4111-8111-111111111111'
const otherDataset = '22222222-2222-4222-8222-222222222222'
const capabilities: dto.LocalWorkbenchCapabilitiesReply = { capabilities: { read: { available: true } }, artworkSources: [], artworkImportFormats: [], aiBackends: [], cueFormats: [], existingActions: {} }
const album: dto.LocalWorkbenchAlbumRef = { albumId: 'album-a', title: '合成专辑', artist: '合成艺人', trackIds: [], rootId: 'root-a' }
const readback: dto.LocalWorkbenchReadback = { datasetId, snapshotId: 'snapshot-a', albums: [{ album, capture: { albumId: album.albumId, readToken: 'read-a' }, availability: 'online', issues: [], currentArtwork: null, cueSheets: [] }] }
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve))

function resultReaders452() {
  const library={datasetId,libraryId:'33333333-3333-4333-8333-333333333333',captureId:'whole-library-original'}
  const key:LocalWorkbenchLyricsResultKey={jobId:'job-original',jobRevision:7,library,albumId:'album-original',category:'unknown'}
  const entry:dto.LocalLyricsJobOriginalEntry={scope:{datasetId,libraryId:library.libraryId,albumId:key.albumId,captureId:'entry-token-original'},sessionId:'session-original',saveRequest:{sessionId:'session-original',commandId:'save-original',embed:true}}
  let dataset=datasetId,generation=0,active=true
  const calls:{command:string;payload:unknown}[]=[]
  let job:dto.LocalLyricsJobSnapshot={jobId:key.jobId,library,state:'unknown',totalAlbums:1,processedAlbums:1,savedAlbums:0,reviewAlbumIds:[],failedAlbumIds:[],unknownAlbumIds:[key.albumId],sidecars:0,embedded:0,inspectionFailures:0,revision:7,originalEntry:entry}
  let reply:()=>Promise<dto.LocalLyricsJobSnapshot>=async()=>structuredClone(job)
  const summary:dto.LocalAlbumSummary={id:key.albumId,kind:'source-directory',rootId:library.libraryId,editionId:null,title:'原条目',artists:[],year:null,versionLabel:null,trackCount:0,representativeTrackId:null,revision:'original-revision',artworkAvailable:false,artworkState:'unknown',statuses:[]}
  assert.equal(dto.isLocalAlbumSummary(summary),true)
  const libraryKey:LocalWorkbenchLibraryResultKey={jobId:'management-original',captureId:'management-capture',kind:'cue',albumId:key.albumId}
  let management:dto.LocalLibraryBatchPage={jobId:libraryKey.jobId,captureId:libraryKey.captureId,kind:'cue',state:'unknown',totalAlbums:1,processedAlbums:1,succeededAlbums:0,failedAlbums:0,offset:0,items:[{albumId:key.albumId,state:'unknown',message:null}],
    originalEntry:{datasetId,album:{albumId:key.albumId,rootId:library.libraryId,title:summary.title,artist:'',trackIds:[],trackCount:0,revision:summary.revision},capture:{albumId:key.albumId,readToken:'management-entry-token'}}}
  const readers=createLocalWorkbenchResultReaders({api:{
    async localLibraryLyrics<C extends dto.LocalLyricsCommand>(command:C,payload:dto.LocalLyricsCommandPayloads[C]){calls.push({command,payload:structuredClone(payload)});assert.equal(command,'localLyrics.job.read');return await reply() as dto.LocalLyricsCommandResults[C]},
    async localLibraryManagement<C extends dto.LocalLibraryManagementMainCommand>(command:C,payload:dto.LocalLibraryManagementMainPayloads[C]){if(command==='library.import.cancel')throw Error('原结果读口不得取消未prepare目录');calls.push({command,payload:structuredClone(payload)});assert.equal(command,'library.job.read');return structuredClone(management) as dto.LocalLibraryManagementMainResults[C]},
    async getLocalAlbumTracks(query){calls.push({command:'localAlbum.tracks',payload:structuredClone(query)});return {...query,album:structuredClone(summary),total:0,hasMore:false,items:[]}},
  },datasetId:()=>dataset,generation:()=>generation,lyricsKeyCurrent:()=>active,libraryKeyCurrent:()=>active})
  return {readers,key,entry,libraryKey,calls,summary,get job(){return job},set job(value:dto.LocalLyricsJobSnapshot){job=value},get management(){return management},set management(value:dto.LocalLibraryBatchPage){management=value},
    setReply(value:typeof reply){reply=value},changeDataset(value:string){dataset=value;generation++},invalidate(){generation++},close(){active=false;generation++}}
}

test('原结果452 App读口只读原job与原四字段scope，库capture不同不重造session',async()=>{
  const f=resultReaders452(),context={signal:new AbortController().signal},before=structuredClone(f.job)
  const entry=await f.readers.readLyricsEntry(f.key,context);assert.deepEqual(entry,f.entry);assert.notEqual(entry!.scope.captureId,f.key.library.captureId)
  const facts=await f.readers.readLyricsFacts(f.key,entry!,context);assert.equal(facts.capture,null,'原scope与当前页不能构造专辑readToken')
  assert.deepEqual(f.calls,[{command:'localLyrics.job.read',payload:{jobId:f.key.jobId,albumId:f.key.albumId}},{command:'localAlbum.tracks',payload:{albumKey:f.key.albumId,rootId:f.entry.scope.libraryId,offset:0,limit:100}}])
  assert.deepEqual(f.job,before);assert.equal(entry!.saveRequest!.commandId,'save-original')
})

test('原结果452 App拒绝错job修订类别库和entry专辑，不查新session或借新捕获',async()=>{
  for(const patch of [{jobId:'other-job'},{revision:8},{unknownAlbumIds:[]},{library:{datasetId,libraryId:'other-root',captureId:'other-capture'}},{originalEntry:{scope:{datasetId,libraryId:'33333333-3333-4333-8333-333333333333',albumId:'other-album',captureId:'token-other'},sessionId:null,saveRequest:null}}]){
    const f=resultReaders452();f.job={...f.job,...patch};await assert.rejects(f.readers.readLyricsEntry(f.key,{signal:new AbortController().signal}));assert.equal(f.calls.length,1)
  }
})

test('原结果452 App等待原Promise收口，关闭和dataset-owner-capture ABA拒绝迟到结果',async()=>{
  for(const change of ['close','owner','dataset-aba','capture-aba','abort'] as const){
    const f=resultReaders452(),late=deferred<dto.LocalLyricsJobSnapshot>(),controller=new AbortController();f.setReply(()=>late.promise)
    let settled=false;const running=f.readers.readLyricsEntry(f.key,{signal:controller.signal}).finally(()=>{settled=true}),rejected=assert.rejects(running)
    await tick();assert.equal(settled,false)
    if(change==='close')f.close();else if(change==='dataset-aba'){f.changeDataset(otherDataset);f.changeDataset(datasetId)}else if(change==='abort')controller.abort();else{f.invalidate();if(change==='capture-aba')f.invalidate()}
    await tick();assert.equal(settled,false,'丢弃UI响应不能伪称后台关闭')
    late.resolve(structuredClone(f.job));await rejected;assert.equal(f.calls.length,1)
  }
})

test('原结果452 AI-CUE检查使用原job的库根和readToken，当前页面不提供定位事实',async()=>{
  const f=resultReaders452(),before=structuredClone(f.management),result=await f.readers.readLibraryResult(f.libraryKey,{signal:new AbortController().signal})
  assert.equal(result.capture.readToken,'management-entry-token');assert.notEqual(result.capture.readToken,f.libraryKey.captureId)
  assert.deepEqual(f.calls,[{command:'library.job.read',payload:{jobId:f.libraryKey.jobId,offset:0,limit:1,albumId:f.libraryKey.albumId}},{command:'localAlbum.tracks',payload:{albumKey:f.libraryKey.albumId,rootId:'33333333-3333-4333-8333-333333333333',offset:0,limit:100}}])
  assert.deepEqual(f.management,before)
  f.summary.revision='changed-source';await assert.rejects(f.readers.readLibraryResult(f.libraryKey,{signal:new AbortController().signal}));assert.deepEqual(f.management,before)
})

test('原结果452管理Preload和Owner拒绝跨dataset或非read投影，不产生第二作者',async()=>{
  const f=resultReaders452(),request={jobId:f.libraryKey.jobId,offset:0,limit:1,albumId:f.libraryKey.albumId},page=structuredClone(f.management)
  const {isDatasetWorkbenchResult}=await import('../../../packages/bridge-core/src/collection/dataset-owner-protocol.js')
  assert.equal(isDatasetWorkbenchResult({family:'management',command:'library.job.read',payload:request},page,datasetId),true)
  assert.equal(isDatasetWorkbenchResult({family:'management',command:'library.job.read',payload:request},page,otherDataset),false)
  assert.equal(isDatasetWorkbenchResult({family:'management',command:'library.job.stop',payload:{jobId:request.jobId}},page,datasetId),false)
  const client=createLocalWorkbenchClient(async()=>({...page,originalEntry:{...page.originalEntry!,datasetId:otherDataset}}),async()=>datasetId)
  await assert.rejects(client.localLibraryManagement('library.job.read',request),/身份无效/u)
})
function harness(request: LocalWorkbenchIpcOptions['request'], guards: Partial<Pick<LocalWorkbenchIpcOptions, 'assertTrusted' | 'assertDataset' | 'captureAuthor' | 'closeReadResources'>> = {}) {
  const handlers = new Map<string, (event: LocalWorkbenchMainEvent, value: unknown) => Promise<unknown>>()
  const makeEvent = (id: number): LocalWorkbenchMainEvent => ({ senderFrame: { url: 'app://musicbridge/index.html' }, sender: { id, isDestroyed: () => false } })
  const event = makeEvent(1)
  const ipc = registerLocalWorkbenchIpc({ ipcMain: { handle: (channel, handler) => { handlers.set(channel, handler) }, removeHandler: channel => { handlers.delete(channel) } },
    assertTrusted(value) { if (value.senderFrame?.url !== 'app://musicbridge/index.html') throw new Error('窗口来源不可信。') },
    assertDataset(value) { assert.equal(value, datasetId) }, ...guards, request })
  const invoke = async (channel: string, value: unknown) => {
    const handler = handlers.get(channel); assert.ok(handler); return handler(event, value)
  }
  return { ipc, invoke, handlers, event, makeEvent }
}

test('工作台Preload在复制前拒绝getter/隐藏字段，回包核工作库和原read身份', async () => {
  let calls = 0, getterCalls = 0, scope = datasetId
  const client = createLocalWorkbenchClient(async () => { calls++; return capabilities }, async () => scope)
  const payload = { requestId: 'read-1', command: 'localWorkbench.capabilities', payload: {} }
  Object.defineProperty(payload, 'authorization', { enumerable: false, get() { getterCalls++; return '多余能力' } })
  await assert.rejects(client.requestLocalWorkbenchRead(payload as dto.LocalWorkbenchReadRequestEnvelope), /无效/u)
  assert.equal(calls, 0); assert.equal(getterCalls, 0)
  await client.localWorkbenchCapabilities(); assert.equal(calls, 1)
  const changed = createLocalWorkbenchClient(async () => { scope = otherDataset; return readback }, async () => scope)
  await assert.rejects(changed.readLocalWorkbenchAlbums({ albums: [album] }), /工作库已改变/u)
  const wrong = createLocalWorkbenchClient(async () => ({ ...readback, datasetId: otherDataset }), async () => datasetId)
  await assert.rejects(wrong.readLocalWorkbenchAlbums({ albums: [album] }), /身份无效/u)
})

test('Main读取取消只命中同sender/数据集/nonce，实际Promise结束前仍保留租约', async () => {
  const physical = deferred<dto.LocalWorkbenchCapabilitiesReply>(), started = deferred<AbortSignal>()
  const h = harness(async (_request, context) => { started.resolve(context.signal); return physical.promise })
  const request = { datasetId, request: { requestId: 'read-cancel', command: 'localWorkbench.capabilities', payload: {} } }
  const running = h.invoke('localWorkbench:read', request), rejected = assert.rejects(running, /取消/u)
  const signal = await started.promise
  assert.equal(h.ipc.pendingReads(), 1)
  assert.deepEqual(await h.handlers.get('localWorkbench:cancelRead')!(h.makeEvent(2), { datasetId, request: { requestId: 'read-cancel' } }), { cancelled: true })
  assert.equal(signal.aborted, false, '另一窗口自己的取消记录不能关闭本窗口读取')
  assert.deepEqual(await h.invoke('localWorkbench:cancelRead', { datasetId, request: { requestId: 'read-cancel' } }), { cancelled: true })
  assert.equal(signal.aborted, true); assert.equal(h.ipc.pendingReads(), 1)
  let closed = false
  const closing = h.ipc.close().then(() => { closed = true })
  await tick(); assert.equal(closed, false, '确认cancel后仍等待原资源实际收口')
  physical.resolve(capabilities)
  await rejected; await closing
  assert.equal(h.ipc.pendingReads(), 0); assert.equal(closed, true)
})

test('Main先到取消、重复nonce、应用伪装读取及不可信窗口均不能执行', async () => {
  let calls = 0
  const h = harness(async () => { calls++; return capabilities })
  await h.invoke('localWorkbench:cancelRead', { datasetId, request: { requestId: 'read-early' } })
  await assert.rejects(h.invoke('localWorkbench:read', { datasetId, request: { requestId: 'read-early', command: 'localWorkbench.capabilities', payload: {} } }), /取消/u)
  await assert.rejects(h.invoke('localWorkbench:read', { datasetId, request: { requestId: 'read-early', command: 'localWorkbench.capabilities', payload: {} } }), /重复/u)
  await assert.rejects(h.invoke('localWorkbench:read', { datasetId, request: { requestId: 'read-fake', command: 'localWorkbench.plan.apply', payload: {} } }), /无效/u)
  await assert.rejects(h.handlers.get('localWorkbench:read')!({ ...h.event, senderFrame: { url: 'https://untrusted.example.invalid' } }, { datasetId, request: { requestId: 'read-foreign', command: 'localWorkbench.capabilities', payload: {} } }), /不可信/u)
  assert.equal(calls, 0); await h.ipc.close()
})

test('Renderer实际适配将abort送到Main，继续等待原读取，迟到成功不会交给面板', async () => {
  const physical = deferred<dto.LocalWorkbenchReadback>(), started = deferred<AbortSignal>()
  const h = harness(async (request, context) => { assert.equal(request.command, 'localWorkbench.read'); started.resolve(context.signal); return physical.promise })
  const api = createLocalWorkbenchClient(h.invoke, async () => datasetId)
  const ports = createLocalWorkbenchRendererPorts({ api, capabilities, makeRequestId: () => 'read-renderer' })
  const controller = new AbortController()
  let settled = false
  const read = ports.readAlbums!({ albums: [{ ...album, trackIds: ['track-a'] }] }, { signal: controller.signal }).finally(() => { settled = true })
  const rejection = assert.rejects(read, /取消/u), signal = await started.promise
  controller.abort(); await tick()
  assert.equal(signal.aborted, true); assert.equal(settled, false)
  physical.resolve(readback); await rejection
  assert.equal(settled, true); await h.ipc.close()
})

test('原应用和回执查询独立于读取消；后端内部URL不经Main错误回传', async () => {
  const original: dto.LocalWorkbenchApplyRequest = { commandId: 'command-a', datasetId, planId: 'plan-a', expectedRevision: '1', planHash: 'a'.repeat(64), contextFingerprint: 'b'.repeat(64), kind: 'ai' }
  const receipt: dto.LocalWorkbenchReceipt = { commandId: original.commandId, datasetId, planId: original.planId, planHash: original.planHash, state: 'unknown', items: [{ itemId: 'item-a', albumId: album.albumId, label: '合成操作', state: 'unknown', message: null }], message: '原结果尚未确认。' }
  const requests: string[] = []
  const h = harness(async (request, context) => {
    requests.push(request.command); assert.equal(context.signal.aborted, false)
    if (request.command === 'localWorkbench.plan.apply' || request.command === 'localWorkbench.plan.receipt') { assert.deepEqual(request.payload, original); return receipt }
    throw new Error('https://synthetic-private.example.invalid/owner-details')
  })
  const client = createLocalWorkbenchClient(h.invoke, async () => datasetId)
  assert.deepEqual(await client.applyLocalWorkbenchPlan(original), receipt)
  await client.cancelLocalWorkbenchRead({ requestId: 'command-a' })
  assert.deepEqual(await client.readLocalWorkbenchReceipt(original), receipt)
  await assert.rejects(client.requestLocalWorkbenchRead({ requestId: 'read-error', command: 'localWorkbench.capabilities', payload: {} }), error => error instanceof Error && /整理读取未完成/u.test(error.message) && !error.message.includes('https:'))
  assert.deepEqual(requests, ['localWorkbench.plan.apply', 'localWorkbench.plan.receipt', 'localWorkbench.capabilities'])
  await h.ipc.close()
})

test('读取在异步工作库核对完成前不得派发，普通读取入口也等待同一围栏', async t => {
  for (const channel of ['localWorkbench:read', 'localWorkbench:request']) await t.test(channel, async () => {
    const scope = deferred<void>()
    let calls = 0
    const h = harness(async () => { calls++; return capabilities }, { assertDataset: () => scope.promise })
    const value = channel === 'localWorkbench:read'
      ? { datasetId, request: { requestId: 'async-before-read', command: 'localWorkbench.capabilities', payload: {} } }
      : { datasetId, command: 'localWorkbench.capabilities', payload: {} }
    const running = h.invoke(channel, value)
    void running.catch(() => undefined)
    try {
      await tick()
      assert.equal(calls, 0, '实际工作库身份尚未核完，不能启动底层读取')
      scope.resolve()
      assert.deepEqual(await running, capabilities)
      assert.equal(calls, 1)
    } finally { scope.resolve(); await Promise.allSettled([running]); await h.ipc.close() }
  })
})

test('读取前异步工作库拒绝不启动请求', async () => {
  const scope = deferred<void>()
  void scope.promise.catch(() => undefined)
  let calls = 0
  const h = harness(async () => { calls++; return capabilities }, { assertDataset: () => scope.promise })
  const running = h.invoke('localWorkbench:read', { datasetId, request: { requestId: 'async-reject-before', command: 'localWorkbench.capabilities', payload: {} } })
  void running.catch(() => undefined)
  try {
    scope.reject(new Error('工作库已改变。'))
    await assert.rejects(running, /工作库已改变/u)
    assert.equal(calls, 0)
  } finally { scope.resolve(); await Promise.allSettled([running]); await h.ipc.close() }
})

test('读取回送前等待异步二次核对，工作库变化拒绝已有结果', async () => {
  const scope = deferred<void>()
  void scope.promise.catch(() => undefined)
  let checks = 0, settled = false, calls = 0
  const h = harness(async () => { calls++; return readback }, { assertDataset: () => { checks++; if (checks === 2) return scope.promise } })
  const running = h.invoke('localWorkbench:read', { datasetId, request: { requestId: 'async-after-read', command: 'localWorkbench.read', payload: { albums: [album] } } })
  void running.then(() => { settled = true }, () => { settled = true })
  try {
    await tick()
    assert.equal(calls, 1); assert.equal(checks, 2)
    assert.equal(settled, false, '旧结果不能抢在回送身份核对之前交给窗口')
    scope.reject(new Error('工作库已改变。'))
    await assert.rejects(running, /整理读取未完成/u)
  } finally { scope.resolve(); await Promise.allSettled([running]); await h.ipc.close() }
})

test('读取核对await期间页面失信、sender销毁或关闭均阻挡派发与回送', async t => {
  for (const phase of ['before', 'after']) for (const invalidation of ['trusted', 'destroyed', 'closing']) await t.test(`${phase}-${invalidation}`, async () => {
    const scope = deferred<void>()
    let checks = 0, calls = 0
    const h = harness(async () => { calls++; return capabilities }, { assertDataset: () => { checks++; if (checks === (phase === 'before' ? 1 : 2)) return scope.promise } })
    const running = h.invoke('localWorkbench:read', { datasetId, request: { requestId: `async-${phase}-${invalidation}`, command: 'localWorkbench.capabilities', payload: {} } })
    void running.catch(() => undefined)
    let closing: Promise<void> | undefined
    try {
      await tick()
      if (invalidation === 'trusted') h.event.senderFrame = { url: 'https://untrusted.example.invalid' }
      else if (invalidation === 'destroyed') h.event.sender.isDestroyed = () => true
      else closing = h.ipc.close()
      scope.resolve()
      const expected = phase === 'before' ? /不可信|关闭/u : invalidation === 'closing'
        ? (error: unknown) => error instanceof Error && error.name === 'AbortError' && error.message === '整理读取已取消。'
        : /整理读取未完成/u
      await assert.rejects(running, expected)
      assert.equal(calls, phase === 'before' ? 0 : 1)
    } finally { scope.resolve(); await Promise.allSettled([running]); await (closing ?? h.ipc.close()) }
  })
})

const asyncOriginal: dto.LocalWorkbenchApplyRequest = { commandId: 'async-command-a', datasetId, planId: 'async-plan-a', expectedRevision: '1', planHash: 'a'.repeat(64), contextFingerprint: 'b'.repeat(64), kind: 'ai' }
const asyncReceipt: dto.LocalWorkbenchReceipt = { commandId: asyncOriginal.commandId, datasetId, planId: asyncOriginal.planId, planHash: asyncOriginal.planHash, state: 'unknown', items: [{ itemId: 'async-item-a', albumId: album.albumId, label: '合成原操作', state: 'unknown', message: null }], message: '原结果尚未确认。' }

test('应用派发前等待异步工作库身份，核对拒绝时零写入', async () => {
  const scope = deferred<void>()
  void scope.promise.catch(() => undefined)
  let calls = 0
  const h = harness(async () => { calls++; return asyncReceipt }, { assertDataset: () => scope.promise })
  const running = h.invoke('localWorkbench:request', { datasetId, command: 'localWorkbench.plan.apply', payload: asyncOriginal })
  void running.catch(() => undefined)
  try {
    await tick()
    assert.equal(calls, 0)
    scope.reject(new Error('工作库已改变。'))
    await assert.rejects(running, /工作库已改变/u)
    assert.equal(calls, 0)
  } finally { scope.resolve(); await Promise.allSettled([running]); await h.ipc.close() }
})

test('应用回送前等待异步库核对，拒绝只保留原命令结果而不重放', async () => {
  const scope = deferred<void>()
  void scope.promise.catch(() => undefined)
  let checks = 0, settled = false
  const commands: LocalWorkbenchMainRequest[] = []
  const h = harness(async (request, context) => { commands.push(structuredClone(request)); assert.equal(context.signal.aborted, false); return asyncReceipt },
    { assertDataset: () => { checks++; if (checks === 2) return scope.promise } })
  const running = h.invoke('localWorkbench:request', { datasetId, command: 'localWorkbench.plan.apply', payload: asyncOriginal })
  void running.then(() => { settled = true }, () => { settled = true })
  try {
    await tick()
    assert.equal(commands.length, 1); assert.equal(settled, false)
    scope.reject(new Error('工作库已改变。'))
    await assert.rejects(running, /原操作结果尚未确认/u)
    assert.deepEqual(commands, [{ command: 'localWorkbench.plan.apply', payload: asyncOriginal }])
  } finally { scope.resolve(); await Promise.allSettled([running]); await h.ipc.close() }
})

test('应用核对await期间页面失信、sender销毁或关闭阻挡新写入和旧回送', async t => {
  for (const phase of ['before', 'after']) for (const invalidation of ['trusted', 'destroyed', 'closing']) await t.test(`${phase}-${invalidation}`, async () => {
    const scope = deferred<void>()
    let checks = 0, calls = 0
    const h = harness(async (_request, context) => { calls++; assert.equal(context.signal.aborted, false); return asyncReceipt },
      { assertDataset: () => { checks++; if (checks === (phase === 'before' ? 1 : 2)) return scope.promise } })
    const running = h.invoke('localWorkbench:request', { datasetId, command: 'localWorkbench.plan.apply', payload: asyncOriginal })
    void running.catch(() => undefined)
    let closing: Promise<void> | undefined
    try {
      await tick()
      if (invalidation === 'trusted') h.event.senderFrame = { url: 'https://untrusted.example.invalid' }
      else if (invalidation === 'destroyed') h.event.sender.isDestroyed = () => true
      else closing = h.ipc.close()
      scope.resolve()
      await assert.rejects(running, phase === 'before' ? /不可信|关闭/u : /原操作结果尚未确认/u)
      assert.equal(calls, phase === 'before' ? 0 : 1)
    } finally { scope.resolve(); await Promise.allSettled([running]); await (closing ?? h.ipc.close()) }
  })
})

test('已发起应用不被读取消或关闭撤回，原回执继续按同一命令读取', async () => {
  const physical = deferred<dto.LocalWorkbenchReceipt>(), started = deferred<AbortSignal>()
  const commands: LocalWorkbenchMainRequest[] = []
  const request: LocalWorkbenchIpcOptions['request'] = async (original, context) => {
    commands.push(structuredClone(original))
    if (original.command === 'localWorkbench.plan.apply') { started.resolve(context.signal); return physical.promise }
    assert.equal(original.command, 'localWorkbench.plan.receipt'); assert.deepEqual(original.payload, asyncOriginal)
    return asyncReceipt
  }
  const h = harness(request, { assertDataset: async () => { await tick() } })
  const running = h.invoke('localWorkbench:request', { datasetId, command: 'localWorkbench.plan.apply', payload: asyncOriginal })
  void running.catch(() => undefined)
  let closing: Promise<void> | undefined
  try {
    const signal = await started.promise
    await h.invoke('localWorkbench:cancelRead', { datasetId, request: { requestId: asyncOriginal.commandId } })
    assert.equal(signal.aborted, false)
    let closed = false
    closing = h.ipc.close().then(() => { closed = true })
    await tick(); assert.equal(closed, false); assert.equal(signal.aborted, false)
    physical.resolve(asyncReceipt)
    await assert.rejects(running, /原操作结果尚未确认/u)
    await closing; assert.equal(signal.aborted, false)
    const reopened = harness(request, { assertDataset: async () => { await tick() } })
    try {
      assert.deepEqual(await reopened.invoke('localWorkbench:request', { datasetId, command: 'localWorkbench.plan.receipt', payload: asyncOriginal }), asyncReceipt)
      assert.deepEqual(commands.map(value => value.command), ['localWorkbench.plan.apply', 'localWorkbench.plan.receipt'])
      assert.deepEqual(commands[0]?.payload, commands[1]?.payload)
    } finally { await reopened.ipc.close() }
  } finally { physical.resolve(asyncReceipt); await Promise.allSettled([running]); await (closing ?? h.ipc.close()) }
})

test('取消读取同样等待异步工作库核对，拒绝核对不能取消另一库读取', async () => {
  const scope = deferred<void>(), physical = deferred<dto.LocalWorkbenchCapabilitiesReply>(), started = deferred<AbortSignal>()
  void scope.promise.catch(() => undefined)
  let cancelling = false
  const h = harness(async (_request, context) => { started.resolve(context.signal); return physical.promise }, { assertDataset: () => cancelling ? scope.promise : undefined })
  const running = h.invoke('localWorkbench:read', { datasetId, request: { requestId: 'async-cancel-scope', command: 'localWorkbench.capabilities', payload: {} } })
  void running.catch(() => undefined)
  let cancel: Promise<unknown> | undefined
  try {
    const signal = await started.promise
    cancelling = true
    cancel = h.invoke('localWorkbench:cancelRead', { datasetId, request: { requestId: 'async-cancel-scope' } })
    void cancel.catch(() => undefined)
    await tick(); assert.equal(signal.aborted, false)
    scope.reject(new Error('工作库已改变。'))
    await assert.rejects(cancel, /工作库已改变/u)
    assert.equal(signal.aborted, false)
    cancelling = false; physical.resolve(capabilities)
    assert.deepEqual(await running, capabilities)
  } finally { cancelling = false; scope.resolve(); physical.resolve(capabilities); await Promise.allSettled([running, ...(cancel ? [cancel] : [])]); await h.ipc.close() }
})


test('Main原作者异步捕获期间nonce已登记，重复读取不派发且close等待原捕获自然结束', async () => {
  const capture = deferred<() => Promise<void>>()
  let calls = 0, captures = 0
  const h = harness(async () => { calls++; return capabilities }, { captureAuthor: async () => { captures++; return capture.promise } })
  const body = { datasetId, request: { requestId: 'original-author-read', command: 'localWorkbench.capabilities', payload: {} } }
  const running = h.invoke('localWorkbench:read',body), rejected = assert.rejects(running,/关闭|取消/u)
  await tick();assert.equal(h.ipc.pendingReads(),1)
  await assert.rejects(h.invoke('localWorkbench:read',body),/重复/u)
  assert.equal(captures,1);assert.equal(calls,0)
  let closed=false;const closing=h.ipc.close().then(()=>{closed=true});await tick();assert.equal(closed,false)
  capture.resolve(async()=>{});await rejected;await closing;assert.equal(closed,true);assert.equal(calls,0)
})

test('Main相同dataset的新Owner代不能接收旧读取迟到结果', async () => {
  let generation=1;const answer=deferred<dto.LocalWorkbenchCapabilitiesReply>(),started=deferred<void>()
  const h=harness(async()=>{started.resolve();return answer.promise},{captureAuthor:async()=>{const original=generation;return async()=>{if(generation!==original)throw Error('原作者已经换代。')}}})
  const running=h.invoke('localWorkbench:read',{datasetId,request:{requestId:'generation-read',command:'localWorkbench.capabilities',payload:{}}})
  const rejected=assert.rejects(running,/未完成/u);await started.promise;generation=2;answer.resolve(capabilities);await rejected;await h.ipc.close()
})

test('暖关闭467：Legacy IPC读取阶段先封新请求，已受理原写仍待Owner而最终关闭不能提前成功',async()=>{
  const started=deferred<AbortSignal>(),physical=deferred<dto.LocalWorkbenchReceipt>();let readClosures=0,calls=0;
  const h=harness(async(request,context)=>{calls++;assert.deepEqual(request.payload,asyncOriginal);started.resolve(context.signal);return physical.promise;},{async closeReadResources(){readClosures++;}});
  const running=h.invoke('localWorkbench:request',{datasetId,command:'localWorkbench.plan.apply',payload:asyncOriginal}),rejected=assert.rejects(running,/原操作结果尚未确认/u);const signal=await started.promise;
  const sealing=h.ipc.sealReads();assert.equal(h.ipc.sealReads(),sealing);await sealing;assert.equal(readClosures,1);assert.equal(h.handlers.size,0);assert.equal(signal.aborted,false);assert.equal(calls,1);
  let closed=false;const closing=h.ipc.close().then(()=>{closed=true;});await tick();assert.equal(closed,false);assert.equal(signal.aborted,false);physical.resolve(asyncReceipt);await rejected;await closing;assert.equal(closed,true);assert.equal(calls,1);assert.equal(readClosures,1);
});

test('Renderer仅按实际本地维护路由组合能力，Core能力与Finder原回包完整保留', async () => {
  const original: dto.LocalWorkbenchCapabilitiesReply = { ...structuredClone(capabilities), existingActions: { finder: { available: false, reason: 'Main未装配Finder' } }, cueFormats: [{ id: 'flac', label: 'FLAC', availability: { available: false, reason: 'Native资格未签' } }] }
  const before = structuredClone(original), api = createLocalWorkbenchClient(async () => { throw new Error('此例不能通过Main补造能力') }, async () => datasetId)
  let active = true, opened = false, calls = 0
  const ports = createLocalWorkbenchRendererPorts({ api, capabilities: original, openExistingAction: async request => { calls++; assert.equal(request.action, 'libraries'); return { opened: true } },
    localExistingRoutes: { datasetId: () => datasetId, generation: () => 1, current: () => active, availability: () => ({ available: true }), opened: () => opened } })
  assert.deepEqual(ports.capabilities, before.capabilities); assert.deepEqual(ports.cueFormats, before.cueFormats); assert.deepEqual(ports.existingActions!.finder, before.existingActions.finder); assert.deepEqual(original, before)
  assert.deepEqual(ports.existingActions!.libraries, { available: true }); active = false; assert.equal(ports.existingActions!.libraries!.available, false); active = true
  assert.equal((await ports.openExistingAction!({ action: 'libraries', albums: [album] })).opened, false, 'void或声明opened不能替代实际同选择面板')
  opened = true; assert.deepEqual(await ports.openExistingAction!({ action: 'libraries', albums: [album] }), { opened: true }); assert.equal(calls, 2)
})
test('Renderer维护打开前后核工作库和UI代际，ABA离页或关闭及错回复均不报opened', async () => {
  for (const invalidation of ['dataset', 'generation-ABA', 'closed', 'reply'] as const) {
    const pending = deferred<dto.LocalWorkbenchExistingReply>(), api = createLocalWorkbenchClient(async () => { throw new Error('不应走Main重复维护') }, async () => datasetId)
    let currentDataset = datasetId, generation = 1, active = true, calls = 0
    const ports = createLocalWorkbenchRendererPorts({ api, capabilities, openExistingAction: async () => { calls++; return pending.promise }, localExistingRoutes: {
      datasetId: () => currentDataset, generation: () => generation, current: () => active, availability: () => ({ available: true }), opened: () => true } })
    const request = { action: 'source-tags' as const, albums: [structuredClone(album)] }, opening = ports.openExistingAction!(request)
    assert.equal(calls, 1)
    if (invalidation === 'dataset') currentDataset = otherDataset
    else if (invalidation === 'generation-ABA') generation += 2
    else if (invalidation === 'closed') active = false
    pending.resolve(invalidation === 'reply' ? { opened: true, extra: true } as dto.LocalWorkbenchExistingReply : { opened: true })
    assert.equal((await opening).opened, false); assert.equal(calls, 1)
  }
  let calls = 0, reads = 0
  const api = createLocalWorkbenchClient(async () => { throw new Error('不应派发') }, async () => datasetId)
  const ports = createLocalWorkbenchRendererPorts({ api, capabilities, openExistingAction: async () => { calls++; return { opened: true } }, localExistingRoutes: {
    datasetId: () => datasetId, generation: () => 1, current: () => false, availability: () => ({ available: true }), opened: () => true } })
  assert.equal((await ports.openExistingAction!({ action: 'source-tags', albums: [album] })).opened, false)
  const request = Object.defineProperty({ action: 'libraries' as const, albums: [album] }, 'authorization', { enumerable: false, get() { reads++; return '假授权' } })
  assert.equal((await ports.openExistingAction!(request)).opened, false); assert.equal(reads, 0); assert.equal(calls, 0)
})

import { installTrustedDirectoryDrop, type TrustedDirectoryDropEvent } from '../src/preload/local-workbench-client.js'
// 受控DOM realm仅检验preload分发规则；真正isTrusted/File内部槽由Root实际Electron验证。
function dropCd01Harness() {
  class NativeFile { constructor(readonly nativePath: string) {} }
  class Element { available = true; connected = true; closest(selector: string) { assert.equal(selector, 'aside[data-musicbridge-native-directory-drop][data-musicbridge-native-directory-available="true"]'); return this.available ? this : null } }
  const element = new Element(), listeners = new Map<string, (event: unknown) => void>()
  class DropEvent {
    isTrusted = true; target = element; prevented = false; stopped = false
    dataTransfer: { files: unknown[]; items: { kind: string; getAsFile(): unknown }[]; types: string[]; dropEffect: string } | null
    constructor(file: unknown = new NativeFile('/原目录')) { this.dataTransfer = { files: [file], items: [{ kind: 'file', getAsFile: () => file }], types: ['Files'], dropEffect: 'none' } }
    preventDefault() { this.prevented = true } stopPropagation() { this.stopped = true }
  }
  const document = { defaultView: { DragEvent: DropEvent, File: NativeFile, Element }, contains(target: unknown) { return target === element && element.connected }, addEventListener(type: string, listener: (event: unknown) => void, capture: boolean) { assert.equal(capture, true); listeners.set(type, listener) }, removeEventListener(type: string, listener: (event: unknown) => void, capture: boolean) { assert.equal(capture, true); assert.equal(listeners.get(type), listener); listeners.delete(type) } } as unknown as Document
  const choice: dto.LocalLibraryImportChoice = { choiceId: 'original-choice-cd01', label: '原目录', suggestedRole: 'catalog', evidence: ['受控审批结果'] }
  const calls: { channel: string; value: unknown }[] = [], phases: TrustedDirectoryDropEvent[] = []
  let scope = datasetId, accept: boolean | void = true, paths = 0, response: () => Promise<unknown> = async () => choice
  const handle = installTrustedDirectoryDrop({ document, scope: async () => scope,
    getPathForFile(file) { paths++; if (!(file instanceof NativeFile)) throw new Error('无原File内部槽'); return file.nativePath },
    invoke: async (channel, value) => { calls.push({ channel, value }); return response() },
    deliver(event) { phases.push(structuredClone(event)); return event.phase === 'start' ? accept : undefined },
  })
  return { NativeFile, DropEvent, element, choice, calls, phases, listeners, handle, dispatch(event: unknown) { listeners.get('drop')?.(event) }, get pathReads() { return paths }, setScope(value: string) { scope = value }, setAccept(value: boolean | void) { accept = value }, setResponse(value: typeof response) { response = value } }
}
test('CD01：preload仅原可信单File且同步start接受后投私有path，finish只投原choice', async () => {
  const f = dropCd01Harness(), event = new f.DropEvent(); f.dispatch(event)
  assert.equal(f.pathReads, 1); assert.deepEqual(f.phases, [{ phase: 'start', id: 1 }]); assert.equal(f.calls.length, 0)
  assert.equal(event.prevented, true); assert.equal(event.stopped, true); await f.handle.join()
  assert.deepEqual(f.calls, [{ channel: 'localWorkbench:directoryDrop', value: { datasetId, path: '/原目录' } }])
  assert.deepEqual(f.phases, [{ phase: 'start', id: 1 }, { phase: 'finish', id: 1, choice: f.choice }])
  assert.equal(f.handle.pending(), 0); f.handle.dispose(); assert.equal(f.listeners.size, 0)
})
test('CD01：合成事件、伪File、字符串path、空native路径及错误目标不进入私有IPC', async () => {
  for (const kind of ['untrusted', 'plain', 'string', 'fake-file', 'empty', 'extra-item', 'wrong-target', 'disconnected'] as const) {
    const f = dropCd01Harness(), event = new f.DropEvent()
    if (kind === 'untrusted') event.isTrusted = false
    else if (kind === 'string') event.dataTransfer = { files: ['/伪路径'], items: [{ kind: 'file', getAsFile: () => '/伪路径' }], types: ['Files'], dropEffect: 'none' }
    else if (kind === 'fake-file') event.dataTransfer = { files: [{ path: '/伪路径' }], items: [{ kind: 'file', getAsFile: () => ({ path: '/伪路径' }) }], types: ['Files'], dropEffect: 'none' }
    else if (kind === 'empty') event.dataTransfer = { files: [new f.NativeFile('')], items: [{ kind: 'file', getAsFile: () => new f.NativeFile('') }], types: ['Files'], dropEffect: 'none' }
    else if (kind === 'extra-item') event.dataTransfer!.items.push({ kind: 'string', getAsFile: () => null })
    else if (kind === 'wrong-target') f.element.available = false
    else if (kind === 'disconnected') f.element.connected = false
    f.dispatch(kind === 'plain' ? { ...event } : event); await f.handle.join()
    assert.equal(f.calls.length, 0); assert.equal(f.phases.some(row => row.phase === 'start' || row.phase === 'finish'), false); f.handle.dispose()
  }
})
test('CD01：void或拒绝start不派发，并发、换工作库、dispose和坏choice均不交迟到许可', async () => {
  for (const acceptance of [undefined, false]) { const f = dropCd01Harness(); f.setAccept(acceptance); f.dispatch(new f.DropEvent()); await f.handle.join(); assert.equal(f.calls.length, 0); assert.deepEqual(f.phases, [{ phase: 'start', id: 1 }]); f.handle.dispose() }
  for (const change of ['scope', 'dispose', 'bad-choice'] as const) {
    const f = dropCd01Harness(), late = deferred<unknown>(); f.setResponse(() => late.promise); f.dispatch(new f.DropEvent()); await tick()
    assert.equal(f.calls.length, 1); f.dispatch(new f.DropEvent()); assert.equal(f.calls.length, 1); assert.equal(f.handle.pending(), 1)
    if (change === 'scope') f.setScope(otherDataset); else if (change === 'dispose') f.handle.dispose()
    late.resolve(change === 'bad-choice' ? { ...f.choice, path: '/不得交付' } : f.choice); await f.handle.join()
    assert.equal(f.phases.some(row => row.phase === 'finish'), false); assert.equal(f.handle.pending(), 0)
    assert.equal(JSON.stringify(f.phases).includes('/原目录'), false); assert.equal(JSON.stringify(f.phases).includes('/不得交付'), false); f.handle.dispose()
  }
})


test('Main-only取消525：Preload只传同dataset的choice闭集，错回包和路径字段拒且Owner39不扩', async () => {
  const choiceId = 'choice-public-525', payload = { choiceId }, calls: { channel: string; value: unknown }[] = []
  const client = createLocalWorkbenchClient(async (channel, value) => { calls.push({ channel, value: structuredClone(value) }); return { choiceId, released: true } }, async () => datasetId)
  assert.deepEqual(await client.localLibraryManagement('library.import.cancel', payload), { choiceId, released: true })
  assert.deepEqual(calls, [{ channel: 'localWorkbench:management', value: { datasetId, command: 'library.import.cancel', payload } }])
  assert.equal(dto.isLocalLibraryManagementCommand('library.import.cancel'), false); assert.equal(dto.isLocalLibraryManagementMainCommand('library.import.cancel'), true)
  const protocol = await import('../../../packages/bridge-core/src/collection/dataset-owner-protocol.js')
  assert.equal(Object.values(protocol.DATASET_WORKBENCH_COMMANDS).reduce((n, list) => n + list.length, 0), 39)
  assert.equal(protocol.isDatasetWorkbenchRequest({ family: 'management', command: 'library.import.cancel', payload }), false)
  for (const value of [{ choiceId, path: '/不应接收' }, { choiceId, commandId: '不应新建' }, Object.create({ choiceId })]) assert.equal(dto.isLocalLibraryManagementMainPayload('library.import.cancel', value), false)
  let reads = 0; const getter = { get choiceId() { reads++; return choiceId } }
  assert.equal(dto.isLocalLibraryManagementMainPayload('library.import.cancel', getter), false); assert.equal(reads, 0)
  for (const reply of [{ choiceId: 'other', released: true }, { choiceId, released: true, path: '/不应返回' }, { choiceId, released: 'true' }, null]) {
    const bad = createLocalWorkbenchClient(async () => reply, async () => datasetId)
    await assert.rejects(bad.localLibraryManagement('library.import.cancel', payload), /身份无效/u)
  }
})

test('Main-only取消525：Preload等待原取消回包期间跨dataset丢弃，不转新库或造released', async () => {
  let scope = datasetId; const reply = deferred<{ choiceId: string; released: boolean }>(), started = deferred<void>(), calls: unknown[] = []
  const payload = { choiceId: 'choice-public-525-old' }, client = createLocalWorkbenchClient(async (_channel, value) => { calls.push(structuredClone(value)); started.resolve(); return reply.promise }, async () => scope)
  const running = client.localLibraryManagement('library.import.cancel', payload), rejected = assert.rejects(running, /工作库|身份/u)
  await started.promise; scope = otherDataset; reply.resolve({ ...payload, released: true }); await rejected
  assert.deepEqual(calls, [{ datasetId, command: 'library.import.cancel', payload }])
})
