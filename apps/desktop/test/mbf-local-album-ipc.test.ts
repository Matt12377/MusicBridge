import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import * as dto from '@music-bridge/contracts'
import { createLocalAlbumClient } from '../src/preload/local-album-client.js'
import { registerLocalAlbumIpc } from '../src/main/local-library-workbench/album-ipc.js'

const id = (n: number): string => `11111111-1111-4111-8111-${String(n).padStart(12, '0')}`
const query: dto.LocalAlbumQuery = { query: '', rootId: null, filter: 'all', offset: 0, limit: 60 }
const album: dto.LocalAlbumSummary = { id: 'directory:synthetic', kind: 'source-directory', rootId: id(2), editionId: null,
  title: '合成目录', artists: [], year: null, versionLabel: null, trackCount: 0, representativeTrackId: null,
  revision: 'synthetic-revision', artworkAvailable: false, artworkState: 'unknown', statuses: [] }
function page(request = query): dto.LocalAlbumPage {
  return { ...request, total: 1, hasMore: false, items: [album], counts: { all: 1, 'missing-artwork': 0, 'has-artwork': 0,
    'cue-unsplit': 0, 'metadata-issue': 0, 'parse-failed': 0, 'loose-audio': 0, 'track-named-audio': 0, 'missing-lyrics': 0 } }
}

test('本地专辑合同：未探测封面/离线不冒充缺图，未知字段与getter在读取前拒绝', () => {
  assert.equal(dto.isLocalAlbumSummary(album), true)
  assert.equal(dto.isLocalAlbumSummary({ ...album, artworkState: 'source-unavailable' }), true)
  assert.equal(dto.isLocalAlbumSummary({ ...album, statuses: ['missing-artwork'] }), false)
  assert.equal(dto.isLocalAlbumQuery({ ...query, rootPath: '/private/synthetic' }), false)
  let calls = 0
  const payload = { ...query }; Object.defineProperty(payload, 'query', { enumerable: true, get() { calls++; return '' } })
  assert.equal(dto.isLocalAlbumQuery(payload), false)
  const result = page(); Object.defineProperty(result, 'query', { enumerable: true, get() { calls++; return '' } })
  assert.equal(dto.isLocalAlbumCommandResult('localAlbum.query', result), false)
  assert.equal(calls, 0)
})

test('本地专辑 client：只调用固定读入口，闭集、分页回声及数据集变化逐项拒绝', async () => {
  const calls: unknown[] = []
  let dataset = id(1), reply: unknown = page()
  const client = createLocalAlbumClient(async (channel, payload) => { calls.push([channel, payload]); return reply }, async () => dataset)
  assert.deepEqual(await client.queryLocalAlbums(query), page())
  assert.deepEqual(calls[0], ['localAlbum:request', { datasetId: id(1), command: 'localAlbum.query', payload: query, correlationId: (calls[0] as [string, {correlationId:string}])[1].correlationId }]); assert.match((calls[0] as [string, {correlationId:string}])[1].correlationId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu)
  await assert.rejects(client.queryLocalAlbums({ ...query, limit: 201 }), /无效/u)
  assert.equal(calls.length, 1)
  reply = page({ ...query, offset: 1 }); await assert.rejects(client.queryLocalAlbums(query), /无效/u)
  reply = { ...page(), sourcePath: '/private/synthetic' }; await assert.rejects(client.queryLocalAlbums(query), /无效/u)
  const changing = createLocalAlbumClient(async () => { dataset = id(3); return page() }, async () => dataset)
  await assert.rejects(changing.queryLocalAlbums(query), /无效/u)
})

test('本地专辑 Main：未知命令不转发，可信 frame 与 dataset 在迟到结果前再次核对', async () => {
  let handler!: (event: {}, value: unknown) => Promise<unknown>
  let trusted = true, dataset = id(1), reads = 0, change = false
  registerLocalAlbumIpc({ ipcMain: { handle(channel, callback) { assert.equal(channel, 'localAlbum:request'); handler = callback } },
    assertTrusted() { if (!trusted) throw new Error('页面已失效') },
    assertDataset(value) { if (value !== dataset) throw new Error('数据集已变化') },
    async read(request, value) { reads++; assert.equal(value, dataset); assert.equal(request.command, 'localAlbum.query')
      if (change) dataset = id(3); return page() },
  })
  const request = { datasetId: id(1), command: 'localAlbum.query', payload: query }
  assert.deepEqual(await handler({}, request), page())
  await assert.rejects(handler({}, { ...request, command: 'localAlbum.apply' }), /无效/u)
  await assert.rejects(handler({}, { ...request, sourcePath: '/private/synthetic' }), /无效/u)
  assert.equal(reads, 1)
  trusted = false; await assert.rejects(handler({}, request), /页面已失效/u); assert.equal(reads, 1)
  trusted = true; change = true; await assert.rejects(handler({}, request), /数据集已变化/u)
})

test('本地专辑 Main：后端错回其他分页或目录身份时不会发给Renderer', async () => {
  let handler!: (event: {}, value: unknown) => Promise<unknown>
  registerLocalAlbumIpc({ ipcMain: { handle(_channel, callback) { handler = callback } }, assertTrusted() {}, assertDataset() {},
    async read() { return page({ ...query, query: '其他搜索' }) } })
  await assert.rejects(handler({}, { datasetId: id(1), command: 'localAlbum.query', payload: query }), /结果无效/u)
})

test('本地专辑 Main：等待实际异步工作库核对，返回前的切库拒绝原回复', async t => {
  let handler!: (event: {}, value: unknown) => Promise<unknown>
  let before!: () => void, after!: () => void
  const beforeCheck = new Promise<void>(resolve => { before = resolve })
  const afterCheck = new Promise<void>(resolve => { after = resolve })
  t.after(() => { before(); after() })
  let dataset = id(1), checks = 0, reads = 0, settled = false
  registerLocalAlbumIpc({ ipcMain: { handle(_channel, callback) { handler = callback } }, assertTrusted() {},
    async assertDataset(value) {
      checks++
      await (checks === 1 ? beforeCheck : afterCheck)
      if (value !== dataset) throw new Error('工作库已变化')
    },
    async read() { reads++; return page() },
  })
  const pending = handler({}, { datasetId: dataset, command: 'localAlbum.query', payload: query })
  void pending.then(() => { settled = true }, () => { settled = true })
  const tick = () => new Promise<void>(resolve => setImmediate(resolve))
  await tick()
  assert.equal(checks, 1)
  assert.equal(reads, 0)
  assert.equal(settled, false)
  before(); await tick()
  assert.equal(reads, 1)
  assert.equal(checks, 2)
  assert.equal(settled, false)
  dataset = id(3); after()
  await assert.rejects(pending, /工作库已变化/u)
})

// 原自有16×16 JPEG，整字节SHA；这里只验证公共DTO/渲染分支，不授Main实际decoder资格。
function publicArtworkFixture(): dto.LocalArtworkImage {
  const bytes = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgMCAgMDAgMDAwMDBAcFBAQEBAkGBwUHCgkLCwoJCgoMDREODAwQDAoKDhQPEBESExMTCw4UFhQSFhESExL/2wBDAQMDAwQEBAgFBQgSDAoMEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhL/wAARCAAQABADAREAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD5++FfwE/1P+jen8NbUZHmcO8Xbe8fVGj/AAZTRPBmqXkoa08qycJMoIKSMNqEEcj5ivPbrxX0GVyprEwlVaUIvmk5NKKjHWTbellFNu/Q/R8+8QVlnC+OxPtnCSpyUZK91OS5YW5dU+dxSfR6tpK657Qvj94D8OQ3A8NaRrHiCW2EZhnMIs7WfO0t875lXALDmLllwOCGr34eHeLwWCePzfEQw9CCbm23KUei0jpJydkkpXd0knL3T8G4D8NuIMZKl9brQoqV7q/PNb20XuO+n/LzRO71VjP+NP7VHjrX/Ad1p3grQdI8N6bqt1awwTGM3V3blSJWYu/7pwTEy4MQwH9QDX4rmEcv4nzGlhqc6n1WmnKUXaHtZbLnUW3GMG04xVRpyjzy3jGH7txx4fZBknBijj6k8RUrVIwfvckFq6ifKk57QS/iLV3va8X/AP/Z', 'base64'), sha256 = createHash('sha256').update(bytes).digest('hex');
  return { original: { mime: 'image/jpeg', bytes: bytes.length, sha256, width: 16, height: 16 },
    display: { mime: 'image/jpeg', bytes: bytes.length, sha256, width: 16, height: 16, dataUrl: `data:image/jpeg;base64,${bytes.toString('base64')}` } };
}

test('公共封面读取：实际client和Main接受合法小JPEG，逐字段错回声与RPC拒绝在图片解码前拒绝', async () => {
  const datasetId=id(1);
  let handler!: (event: {}, value: unknown) => Promise<unknown>;
  const request: dto.LocalAlbumArtworkRequest = {albumKey: album.id, rootId: album.rootId, editionId: album.editionId, representativeTrackId: album.representativeTrackId, revision: album.revision};
  const image = publicArtworkFixture(), original: dto.LocalAlbumArtworkReply = {...request, image, status:'ready'};
  assert.equal(dto.isLocalAlbumArtworkReply(original, request), true);
  let reply = original, reads = 0, rejectRpc = false; const trusted = Object.freeze({}), calls: unknown[] = [];
  registerLocalAlbumIpc({ipcMain:{handle(channel, callback){assert.equal(channel,'localAlbum:request');handler=callback}},
    assertTrusted(event){assert.equal(event,trusted)}, assertDataset(value){assert.equal(value,datasetId)},
    async read(body, dataset){reads++;assert.equal(dataset,datasetId);assert.equal(body.command,'localAlbum.artwork');assert.deepEqual(body.payload,request);if(rejectRpc)throw new Error('受控RPC拒绝');return reply;}});
  const client = createLocalAlbumClient(async(channel, value)=>{calls.push([channel, structuredClone(value)]);return handler(trusted,value)},async()=>datasetId);
  assert.deepEqual(await client.getLocalAlbumArtwork(request), original);
  assert.deepEqual(calls[0], ['localAlbum:request', {datasetId,command:'localAlbum.artwork',payload:request,correlationId:(calls[0] as [string,{correlationId:string}])[1].correlationId}]);assert.equal(reads,1);
  for (const patch of [{albumKey:'wrong-album'},{rootId:id(9)},{editionId:id(8)},{representativeTrackId:id(7)},{revision:'wrong-revision'}]) {
    reply={...original,...patch};await assert.rejects(client.getLocalAlbumArtwork(request),/结果无效/u);
  }
  reply={...original,image:{...image,display:{...image.display,dataUrl:'https://example.invalid/not-display.jpg'}}};
  await assert.rejects(client.getLocalAlbumArtwork(request),/结果无效/u);
  reply=original;rejectRpc=true;await assert.rejects(client.getLocalAlbumArtwork(request),/受控RPC拒绝/u);rejectRpc=false;
  // 单独穿过preload反例：不能只靠Main负例证明client的原请求回声核验。
  const wrongClient=createLocalAlbumClient(async()=>({...original,revision:'wrong-revision'}),async()=>datasetId);
  await assert.rejects(wrongClient.getLocalAlbumArtwork(request),/无效/u);
  reply={...request,image:null,status:'ready'};assert.deepEqual(await client.getLocalAlbumArtwork(request),reply);
  reply={...request,image:null,status:'source-unavailable'};assert.deepEqual(await client.getLocalAlbumArtwork(request),reply);
});


// 仅合成IPC组件；不授实际Owner/普通页面/Native或Source资格。
test('专辑私有Trace：闭四字段同次回执保安全首码，旧三字段与getter/多余字段仍拒绝或兼容', async () => {
  const { runLocalAlbumMainRead } = await import('../src/main/local-library-workbench/album-ipc.js')
  const { readLocalAlbumSafeMarker } = await import('../src/shared/library-read-trace.js')
  let handler!: (event: {}, value: unknown) => Promise<unknown>, calls = 0
  registerLocalAlbumIpc({ ipcMain: { handle(_channel, callback) { handler = callback } }, assertTrusted() {}, assertDataset() {}, async read() { calls++; throw Object.assign(new Error('不得进入诊断的路径/正文/内部栈'), { code: 'NOT_READY', name: 'CoreIpcError' }) } })
  const original = { datasetId: id(1), command: 'localAlbum.query', payload: query }
  await assert.rejects(handler({}, original), /不得进入诊断/u); assert.equal(calls, 1)
  let sent: Record<string, unknown> | undefined
  const client = createLocalAlbumClient(async (_channel, value) => { sent = value as Record<string, unknown>; return runLocalAlbumMainRead(value, () => handler({}, value)) }, async () => id(1))
  let failure: unknown
  try { await client.queryLocalAlbums(query) } catch (error) { failure = error }
  assert.equal(calls, 2); assert.ok(sent); assert.match(String(sent.correlationId), /^[0-9a-f-]{36}$/u)
  const safe = readLocalAlbumSafeMarker((failure as Error).message); assert.ok(safe); assert.equal(safe.code, 'NOT_READY'); assert.equal(safe.name, 'CoreIpcError'); assert.equal(safe.preloadAssociated, true); assert.equal(safe.firstStage, 'main.dispatch')
  assert.equal((failure as Error).message.includes('不得进入诊断'), false); assert.equal(Object.hasOwn(safe, 'message'), false); assert.equal(Object.hasOwn(safe, 'stack'), false)
  await assert.rejects(handler({}, { ...original, correlationId: 'not-a-uuid' }), /无效/u); assert.equal(calls, 2)
  await assert.rejects(handler({}, { ...original, correlationId: id(8), extra: true }), /无效/u); assert.equal(calls, 2)
  let getterCalls = 0; const getter = { ...original }; Object.defineProperty(getter, 'correlationId', { enumerable: true, get() { getterCalls++; return id(8) } })
  await assert.rejects(handler({}, getter), /无效/u); assert.equal(getterCalls, 0); assert.equal(calls, 2)
  await assert.rejects(handler({}, new Proxy({ ...original, correlationId: id(8) }, {})), /无效/u); assert.equal(calls, 2)
})

test('专辑私有Trace：错误correlation/SHA不能消费安全回执，伪字段和过长marker不穿桥', async () => {
  const { readLocalAlbumPrivateFailure, emptyLocalAlbumTraceMatches, localAlbumSafeMarker, readLocalAlbumSafeMarker } = await import('../src/shared/library-read-trace.js')
  const sha = createHash('sha256').update(id(1)).digest('hex')
  const trace = { version: 1 as const, traceSha256: sha, parentSha256: null, stage: 'main.author' as const, firstStage: 'main.author' as const, code: 'NOT_READY' as const, name: 'CoreIpcError' as const, mappedCode: null, elapsedMs: 1, outcome: 'reject' as const, matches: emptyLocalAlbumTraceMatches(), preloadAssociated: true }
  const body = { version: 1, type: 'local-album-private-failure', correlationId: id(1), trace }
  assert.ok(readLocalAlbumPrivateFailure(body, id(1), sha)); assert.equal(readLocalAlbumPrivateFailure(body, id(2), sha), null)
  assert.equal(readLocalAlbumPrivateFailure(body, id(1), '0'.repeat(64)), null); assert.equal(readLocalAlbumPrivateFailure({ ...body, path: '不得输出' }, id(1), sha), null)
  const marker = localAlbumSafeMarker(trace); assert.ok(marker); assert.deepEqual(readLocalAlbumSafeMarker(marker), trace)
  assert.equal(readLocalAlbumSafeMarker('Error invoking remote method: ' + marker), null); assert.equal(readLocalAlbumSafeMarker(marker + '0'.repeat(2048)), null)
  assert.equal(localAlbumSafeMarker({ ...trace, matches: { ...trace.matches, dto: 'pretend' } } as unknown as typeof trace), null)
})


// 仅合成Preload/IPC行为；调度执行后才可记结果，不授普通App或Source资格。
test('专辑私有Trace：有界UUID摘要与Node真实SHA一致，合法大小写和边界字符保原字节', async () => {
  const { localAlbumTraceIdSha256 } = await import('../src/shared/library-read-trace.js')
  for (const value of [id(1), '00000000-0000-4000-8000-000000000000', 'ffffffff-ffff-4fff-bfff-ffffffffffff', 'ABCDEF01-2345-4678-9ABC-DEF012345678']) {
    assert.equal(localAlbumTraceIdSha256(value), createHash('sha256').update(value, 'utf8').digest('hex'))
  }
  for (const value of ['', id(1) + '\n', id(1) + '0', '00000000-0000-0000-8000-000000000000', {}, null]) assert.equal(localAlbumTraceIdSha256(value), null)
})

test('专辑私有Trace：失效诊断不阻业务或改原拒绝，原单invoke与私有错SHA拒绝保持', async () => {
  const { withLocalAlbumPreparedTrace } = await import('../src/preload/local-album-client.js')
  const { readLocalAlbumSafeMarker, emptyLocalAlbumTraceMatches } = await import('../src/shared/library-read-trace.js')
  const originalCrypto = Object.getOwnPropertyDescriptor(globalThis, 'crypto'), originalInfo = console.info
  const lines: unknown[][] = []; let digestCalls = 0, errorPropertyReads = 0
  console.info = (...args: unknown[]) => { lines.push(args) }
  const originalError = new Proxy(Object.create(null) as object, {
    get() { errorPropertyReads++; throw new Error('不得读取原错误属性') },
    getOwnPropertyDescriptor() { errorPropertyReads++; throw new Error('不得枚举原错误属性') },
    ownKeys() { errorPropertyReads++; throw new Error('不得展开原错误字段') },
  })
  try {
    const unavailable = [undefined, { randomUUID() { throw new Error('受控CSPRNG失效') } }, { randomUUID() { return 'not-a-uuid' } }]
    const usable = [
      { randomUUID: () => id(1), subtle: { digest() { digestCalls++; return new Promise<ArrayBuffer>(() => {}) } } },
      { randomUUID: () => id(1), subtle: { digest() { digestCalls++; throw new Error('不得调用异步摘要') } } },
    ]
    for (const [index, crypto] of [...unavailable, ...usable].entries()) {
      Object.defineProperty(globalThis, 'crypto', { configurable: true, value: crypto })
      const calls: Record<string, unknown>[] = []; let reject = false
      const client = createLocalAlbumClient(async (channel, body) => {
        assert.equal(channel, 'localAlbum:request'); calls.push(body as Record<string, unknown>)
        if (reject) throw originalError
        return page()
      }, async () => id(1))
      assert.deepEqual(await client.queryLocalAlbums(query), page()); assert.equal(calls.length, 1)
      assert.deepEqual(Object.keys(calls[0]!), index < unavailable.length ? ['datasetId','command','payload'] : ['datasetId','command','payload','correlationId'])
      reject = true
      let caughtQuery: unknown; try { await client.queryLocalAlbums(query) } catch (error) { caughtQuery = error }; assert.ok(caughtQuery === originalError); assert.equal(calls.length, 2)
      let caughtPrepared: unknown; try { await withLocalAlbumPreparedTrace(client, async () => { throw originalError }) } catch (error) { caughtPrepared = error }; assert.ok(caughtPrepared === originalError)
      assert.equal(calls.length, 2)
    }
    assert.equal(digestCalls, 0); assert.equal(errorPropertyReads, 0)
    for (const args of lines) { assert.equal(args.length, 1); assert.equal(typeof args[0], 'string'); assert.equal((args[0] as string).includes('不得读取原错误属性'), false) }
    Object.defineProperty(globalThis, 'crypto', { configurable: true, value: { randomUUID: () => id(1) } })
    let invokes = 0, scopeCalls = 0
    const scopeError = Object.freeze({ name: '受控业务拒绝原对象' })
    const scoped = createLocalAlbumClient(async () => { invokes++; return page() }, async () => { scopeCalls++; throw scopeError })
    await assert.rejects(scoped.queryLocalAlbums(query), error => error === scopeError); assert.equal(invokes, 0); assert.equal(scopeCalls, 1)
    const sha = createHash('sha256').update(id(1)).digest('hex')
    const trace = { version: 1 as const, traceSha256: sha, parentSha256: null, stage: 'main.dispatch' as const, firstStage: 'main.dispatch' as const,
      code: 'UNAVAILABLE' as const, name: 'CoreIpcError' as const, mappedCode: null, elapsedMs: 1, outcome: 'reject' as const, matches: emptyLocalAlbumTraceMatches(), preloadAssociated: true }
    const privateFailure = { version: 1, type: 'local-album-private-failure', correlationId: id(1), trace }
    let reply: unknown = privateFailure
    const client = createLocalAlbumClient(async () => { invokes++; return reply }, async () => id(1))
    let received: unknown
    try { await client.queryLocalAlbums(query) } catch (error) { received = error }
    assert.equal(invokes, 1); assert.ok(received instanceof Error)
    const safe = readLocalAlbumSafeMarker(received.message); assert.ok(safe); assert.equal(safe.code, 'UNAVAILABLE')
    assert.equal(received.message.includes('[INVALID_IPC_REQUEST]'), false)
    reply = { ...privateFailure, trace: { ...trace, traceSha256: '0'.repeat(64) } }
    await assert.rejects(client.queryLocalAlbums(query), /无效/u); assert.equal(invokes, 2)
    reply = { ...privateFailure, correlationId: id(2) }
    await assert.rejects(client.queryLocalAlbums(query), /无效/u); assert.equal(invokes, 3)
  } finally {
    console.info = originalInfo
    if (originalCrypto) Object.defineProperty(globalThis, 'crypto', originalCrypto)
    else Reflect.deleteProperty(globalThis, 'crypto')
  }
})
