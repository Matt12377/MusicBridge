import assert from 'node:assert/strict'
import test from 'node:test'
import type { ArtistCatalogArtist, ArtistCatalogPlayRequest } from '@music-bridge/contracts'
import { createArtistCatalogClient } from '../src/preload/artist-catalog-client.js'
import { installArtistCatalogHandlers } from '../src/main/artist-catalog-ipc.js'
import type { ArtistCatalogService } from '../src/main/artist-catalog-service.js'

const dataset = '11111111-1111-4111-8111-111111111111', otherDataset = '22222222-2222-4222-8222-222222222222'
const artistId = `local-artist:${'a'.repeat(64)}`
const artist = (): ArtistCatalogArtist => ({ id: artistId, name: '合成人物', source: 'local', albumCount: 1, trackCount: 2, linkState: 'unlinked' })
const playRequest = (): ArtistCatalogPlayRequest => ({ requestId: '原请求', context: { kind: 'artist', artistId, revision: 'r1' }, startTrackId: dataset,
  target: { core_id: 'core', zone_id: 'zone' }, action: 'PLAY_NOW' })
function gate<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes }); return { promise, resolve } }

test('4.1 专用Preload固定dataset与操作闭集，await前复制原表单', async () => {
  const scope = gate<string>(), calls: { channel: string; value: any }[] = []
  const client = createArtistCatalogClient(async (channel, value: any) => {
    calls.push({ channel, value }); return { ...value.payload, revision: 'r1', total: 0, hasMore: false, items: [] }
  }, () => scope.promise)
  const query = { query: '原表单', offset: 0, limit: 24 }, result = client.listArtists(query)
  query.query = '等待时改动'; scope.resolve(dataset)
  assert.equal((await result).query, '原表单')
  assert.deepEqual(calls, [{ channel: 'artistCatalog:request', value: { datasetId: dataset, operation: 'listArtists', payload: { query: '原表单', offset: 0, limit: 24 } } }])
})

test('4.1 Preload拒绝隐藏字段、稀疏候选/联想和非法可选人物身份', async () => {
  let calls = 0, response: unknown = artist()
  const client = createArtistCatalogClient(async () => { calls++; return response }, async () => dataset)
  await assert.rejects(client.getArtist(Object.defineProperty({ artistId }, 'path', { value: '/合成拒绝路径' })), /INVALID_IPC_REQUEST/u)
  assert.equal(calls, 0)
  for (const extra of [{ artworkId: '' }, { linkedNeteaseId: '' }, { artworkUrl: 'file:///合成图片' }, { linkState: '猜测' }, { token: '合成非法字段' }]) {
    response = { ...artist(), ...extra }; await assert.rejects(client.getArtist({ artistId }), /INVALID_IPC_REQUEST/u)
  }
  response = new Array(1); await assert.rejects(client.artistMatches({ artistId }), /INVALID_IPC_REQUEST/u)
  response = Object.assign(new Array(1), { unrelated: artist() }); await assert.rejects(client.artistMatches({ artistId }), /INVALID_IPC_REQUEST/u)
  response = { keywords: new Array(1) }; await assert.rejects(client.suggest({ query: '合成' }), /INVALID_IPC_REQUEST/u)
  response = { keywords: ['真实联想'] }; assert.deepEqual(await client.suggest({ query: '合成' }), response)
})

test('4.1 Preload拒绝晚回跨数据集、外来人物和外来点播回执，不重放写入', async () => {
  let scopeReads = 0, calls = 0
  const changed = createArtistCatalogClient(async () => { calls++; return artist() }, async () => ++scopeReads === 1 ? dataset : otherDataset)
  await assert.rejects(changed.getArtist({ artistId }), /SOURCE_CHANGED/u); assert.equal(calls, 1)
  const foreign = createArtistCatalogClient(async () => ({ ...artist(), id: `local-artist:${'b'.repeat(64)}` }), async () => dataset)
  await assert.rejects(foreign.getArtist({ artistId }), /INVALID_IPC_REQUEST/u)
  let writes = 0
  const player = createArtistCatalogClient(async () => { writes++; return { status: 'accepted', request_id: '另一个请求', action: 'PLAY_NOW' } }, async () => dataset)
  await assert.rejects(player.playLocalSelection(playRequest()), /INVALID_IPC_REQUEST/u); assert.equal(writes, 1)
  const failed = createArtistCatalogClient(async () => { writes++; throw new Error('[TIMEOUT] 合成未知结果') }, async () => dataset)
  await assert.rejects(failed.playLocalSelection(playRequest()), /TIMEOUT/u); assert.equal(writes, 2)
})

test('4.1 IPC只允许可信页面与九项操作，Provider错误保留安全状态且不泄露内部错误正文', async () => {
  let handler!: (event: boolean, value?: unknown) => unknown, reads = 0, code = 'AUTH_REQUIRED'
  const service = { forDataset: (id: string) => {
    assert.equal(id, dataset)
    return { getArtist: async () => { reads++; throw Object.assign(new Error('不应公开的合成内部错误'), { code }) } }
  }, close: async () => {} } as unknown as ArtistCatalogService
  installArtistCatalogHandlers<boolean>({ handle: (channel, registered) => { assert.equal(channel, 'artistCatalog:request'); handler = registered },
    requireTrusted: trusted => { if (!trusted) throw new Error('拒绝非可信页面') }, service })
  const envelope = { datasetId: dataset, operation: 'getArtist', payload: { artistId } }
  await assert.rejects(Promise.resolve().then(() => handler(false, envelope)), /拒绝非可信页面/u); assert.equal(reads, 0)
  for (const invalid of [{ ...envelope, operation: 'requestCore' }, { ...envelope, path: '非法字段' }, { ...envelope, payload: { artistId, provider: '非法字段' } }]) {
    await assert.rejects(Promise.resolve().then(() => handler(true, invalid)), /INVALID_IPC_REQUEST/u)
  }
  assert.equal(reads, 0)
  await assert.rejects(Promise.resolve().then(() => handler(true, envelope)), error => error instanceof Error && error.message.includes('[AUTH_REQUIRED]') && !error.message.includes('内部错误'))
  code = '不能公开的内部状态'
  await assert.rejects(Promise.resolve().then(() => handler(true, envelope)), error => error instanceof Error && error.message.includes('[ARTIST_CATALOG_UNAVAILABLE]') && !error.message.includes('内部错误'))
  assert.equal(reads, 2)
})

test('4.1 IPC与Preload只接受原dataset/requestId/action的明确not-sent闭集，不按错误码推断', async () => {
  let handler!: (event: boolean, value?: unknown) => unknown, sent = false
  const service = { forDataset: () => ({ playLocalSelection: async () => { throw Object.assign(new Error('合成播放故障'), { code: 'SOURCE_CHANGED', ...(!sent ? { outcome: 'not-sent' } : {}) }) } }), close: async () => {} } as unknown as ArtistCatalogService
  installArtistCatalogHandlers<boolean>({ handle: (_channel, registered) => { handler = registered }, requireTrusted: () => {}, service })
  const request = playRequest(), envelope = { datasetId: dataset, operation: 'playLocalSelection', payload: request }
  const response = await handler(true, envelope)
  assert.deepEqual(response, { ok: false, datasetId: dataset, requestId: request.requestId, action: request.action, code: 'SOURCE_CHANGED', outcome: 'not-sent' })
  const outcome = (error: unknown) => error && typeof error === 'object' ? Object.getOwnPropertyDescriptor(error, 'outcome')?.value : undefined
  let invokes = 0
  const client = createArtistCatalogClient(async () => { invokes++; return response }, async () => dataset)
  await assert.rejects(client.playLocalSelection(request), error => outcome(error) === 'not-sent'); assert.equal(invokes, 1)
  for (const invalid of [{ ...(response as object), requestId: '外来请求' }, { ...(response as object), datasetId: otherDataset }, { ...(response as object), outcome: 'unknown' }, { ...(response as object), extra: true }]) {
    const foreign = createArtistCatalogClient(async () => invalid, async () => dataset)
    await assert.rejects(foreign.playLocalSelection(request), error => outcome(error) === undefined)
  }
  sent = true
  const unknown = createArtistCatalogClient(async () => handler(true, envelope), async () => dataset)
  await assert.rejects(unknown.playLocalSelection(request), error => outcome(error) === undefined && error instanceof Error && error.message.includes('SOURCE_CHANGED'))
  const forged = createArtistCatalogClient(async () => { throw Object.assign(new Error('[SOURCE_CHANGED] 合成传输异常'), { outcome: 'not-sent' }) }, async () => dataset)
  await assert.rejects(forged.playLocalSelection(request), error => outcome(error) === undefined)
})

test('4.1 Preload发送前scope失败明确not-sent，原not-sent回包在scope切换后仍可证明未派发', async () => {
  let invokes = 0
  const outcome = (error: unknown) => error && typeof error === 'object' ? Object.getOwnPropertyDescriptor(error, 'outcome')?.value : undefined
  const unavailable = createArtistCatalogClient(async () => { invokes++; return null }, async () => { throw new Error('[NOT_READY] 合成scope未就绪') })
  await assert.rejects(unavailable.playLocalSelection(playRequest()), error => outcome(error) === 'not-sent'); assert.equal(invokes, 0)
  let reads = 0
  const request = playRequest(), changed = createArtistCatalogClient(async () => ({ ok: false, datasetId: dataset, requestId: request.requestId, action: request.action, outcome: 'not-sent', code: 'SOURCE_CHANGED' }), async () => ++reads === 1 ? dataset : otherDataset)
  await assert.rejects(changed.playLocalSelection(request), error => outcome(error) === 'not-sent')
})

test('4.1 专用准备状态经IPC与Preload保留闭集码，不泄露原错误或自动重发', async () => {
  let handler!: (event: boolean, value?: unknown) => unknown, reads = 0
  const service = { forDataset: () => ({ getArtist: async () => {
    reads++; throw Object.assign(new Error('不应公开的内部索引或路径'), { code: 'ARTIST_INDEX_PREPARING' })
  } }), close: async () => {} } as unknown as ArtistCatalogService
  installArtistCatalogHandlers<boolean>({ handle: (_channel, registered) => { handler = registered }, requireTrusted: () => {}, service })
  const client = createArtistCatalogClient(async (_channel, value) => handler(true, value), async () => dataset)
  await assert.rejects(client.getArtist({ artistId }), error => error instanceof Error
    && error.message.includes('[ARTIST_INDEX_PREPARING]') && error.message.includes('正在准备') && !error.message.includes('内部索引'))
  assert.equal(reads, 1)
})

test('4.1 准备状态的明确not-sent播放回执仍不自动重发写入', async () => {
  let invokes = 0
  const request = playRequest(), client = createArtistCatalogClient(async () => {
    invokes++; return { ok: false, datasetId: dataset, requestId: request.requestId, action: request.action, code: 'ARTIST_INDEX_PREPARING', outcome: 'not-sent' }
  }, async () => dataset)
  await assert.rejects(client.playLocalSelection(request), error => error instanceof Error && error.message.includes('ARTIST_INDEX_PREPARING')
    && Object.getOwnPropertyDescriptor(error, 'outcome')?.value === 'not-sent')
  assert.equal(invokes, 1)
})
