import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import type { ArtistQuery, IpcCommand, LocalArtistSummary, LocalArtistTrackItem, LocalPlayRequest, NeteaseArtistProfile } from '@music-bridge/contracts'
import { createArtistCatalogService } from '../src/main/artist-catalog-service.js'
import type { CoreSupervisor } from '../src/main/core-supervisor.js'

const id = (number: number): string => `00000000-0000-4000-8000-${number.toString(16).padStart(12, '0')}`
const dataset = id(1), otherDataset = id(2), artistId = `local-artist:${'a'.repeat(64)}`, rootId = id(3)
const artist: LocalArtistSummary = { id: artistId, name: '合成艺人', source: 'local', albumCount: 1, trackCount: 2 }
const profile = (remoteId = '12', name = artist.name): NeteaseArtistProfile => ({ id: remoteId, name, albumCount: 1, trackCount: 2, biography: '合成资料', artworkUrl: 'https://example.invalid/portrait.jpg' })
function track(number: number): LocalArtistTrackItem {
  return { rootId, albumKey: 'album-synthetic', track: { id: id(1000 + number), assetId: id(10000 + number), selectionRevision: '1', segment: null },
    asset: { id: id(10000 + number), libraryRootId: rootId, sourceRootId: id(4), rootRevision: '1', fileRevision: '2', locationRevision: '1', sampleFrames: null, timebaseHz: null },
    metadata: { title: `合成歌曲${number}`, album: '合成专辑', artist: artist.name }, versionTokens: [] }
}
function localTracks(window: { offset: number; limit: number }, total = 2, revision = 'r1') {
  return { ...window, artistId, revision, total, hasMore: window.offset + window.limit < total,
    items: Array.from({ length: Math.min(window.limit, Math.max(0, total - window.offset)) }, (_, index) => track(window.offset + index)) }
}
function artistPage(window: ArtistQuery) { return { ...window, revision: 'r1', total: 1, hasMore: window.offset === 0 && window.limit < 1, items: window.offset ? [] : [artist] } }
function searchPage(window: ArtistQuery) {
  const { artistId: _artistId, ...tracks } = localTracks(window)
  return { query: window.query, revision: 'r1', artists: artistPage(window), albums: { ...window, revision: 'r1', total: 0, hasMore: false, items: [] },
    tracks: { ...tracks, query: window.query } }
}
function gate<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes }); return { promise, resolve } }
const turn = () => new Promise<void>(resolve => setImmediate(resolve))
const failed = (code: string) => Object.assign(new Error('合成来源异常'), { code })
type Handler = (payload: any) => unknown

async function fixture(t: test.TestContext, overrides: Partial<Record<IpcCommand, Handler>> = {}) {
  const directory = await mkdtemp('/Volumes/LifeWeave/Developer/CommandLine/tmp/mousa41-artist-catalog-test-')
  const state = { datasetId: dataset, now: 1000 }
  const calls: { command: IpcCommand; payload: any; datasetId?: string }[] = []
  const handlers: Partial<Record<IpcCommand, Handler>> = {
    'localArtist.get': () => ({ ...artist }), 'localArtist.list': artistPage, 'localArtist.search': searchPage,
    'localArtist.tracks': window => localTracks(window),
    'localArtist.albums': window => ({ ...window, revision: 'r1', total: 1, hasMore: false, items: [{ id: 'album-synthetic', kind: 'source-directory', rootId,
      editionId: null, title: '合成专辑', artists: [artist.name], year: null, versionLabel: null, trackCount: 2,
      representativeTrackId: track(0).track.id, revision: 'r1', artworkAvailable: false, statuses: [] }] }),
    'library.searchArtists': ({ page }) => ({ ...page, total: 1, hasMore: false, items: [{ id: '12', name: artist.name }] }),
    'library.artistProfile': ({ artistId }) => profile(artistId),
    'library.artistAlbums': ({ page }) => ({ ...page, total: 1, hasMore: false, items: [{ id: '31', name: '合成专辑', artistName: artist.name }] }),
    'library.artist': ({ page }) => ({ id: '12', name: artist.name, tracks: { ...page, total: 2, hasMore: false,
      items: [0, 1].map(number => ({ id: String(number + 1), title: `合成歌曲${number}`, artists: [artist.name], album: '合成专辑' })) } }),
    'localCatalog.prepare': (request: LocalPlayRequest) => ({ status: 'accepted', request_id: request.request_id, action: request.action }), ...overrides,
  }
  const supervisor = { request: async (command: IpcCommand, payload: unknown, expectedDatasetId?: string) => {
    calls.push({ command, payload: structuredClone(payload), datasetId: expectedDatasetId })
    if (expectedDatasetId && expectedDatasetId !== state.datasetId) throw failed('SOURCE_CHANGED')
    if (command === 'commandOutbox.context') return { datasetId: state.datasetId }
    const handler = handlers[command]; if (!handler) throw new Error(`未准备合成命令：${command}`)
    return handler(payload)
  } } as unknown as Pick<CoreSupervisor, 'request'>
  const create = () => createArtistCatalogService({ supervisor, directory, now: () => state.now })
  const service = create(), api = service.forDataset(dataset)
  t.after(async () => { await service.close(); await rm(directory, { recursive: true, force: true }) })
  return { directory, service, api, create, calls, state, handlers }
}

test('4.1 艺术家列表和搜索只读本地及缓存，不逐人请求网易云', async t => {
  const f = await fixture(t)
  await f.api.listArtists({ query: '', offset: 0, limit: 24 })
  await f.api.search({ query: '合成', offset: 0, limit: 24 })
  assert.deepEqual(f.calls.filter(call => call.command.startsWith('library.')), [])
  assert.ok(f.calls.every(call => call.datasetId === dataset))
})

test('4.1 自动关联须唯一严格姓名和作品证据，列表随后复用已证人物资料', async t => {
  const f = await fixture(t)
  const result = await f.api.getArtist({ artistId })
  assert.equal(result.linkedNeteaseId, '12'); assert.equal(result.linkState, 'automatic')
  assert.equal(result.credit, '人物资料来自网易云'); assert.equal(result.artworkUrl, profile().artworkUrl)
  const networkBefore = f.calls.filter(call => call.command.startsWith('library.')).length
  assert.equal((await f.api.listArtists({ query: '', offset: 0, limit: 24 })).items[0]?.linkedNeteaseId, '12')
  assert.equal(f.calls.filter(call => call.command.startsWith('library.')).length, networkBefore)
})

test('4.1 同名多候选、仅同名无作品和资料身份变化均不能自动合并', async t => {
  for (const reason of ['同名多候选', '作品不符', '资料改名']) {
    const f = await fixture(t, reason === '同名多候选' ? { 'library.searchArtists': ({ page }) => ({ ...page, total: 2, hasMore: false, items: [{ id: '12', name: artist.name }, { id: '13', name: artist.name }] }) }
      : reason === '资料改名' ? { 'library.artistProfile': () => profile('12', '另一位艺人') }
      : { 'library.artistAlbums': ({ page }) => ({ ...page, total: 0, hasMore: false, items: [] }), 'library.artist': ({ page }) => ({ id: '12', name: artist.name, tracks: { ...page, total: 0, hasMore: false, items: [] } }) })
    assert.equal((await f.api.getArtist({ artistId })).linkedNeteaseId, undefined, reason)
  }
})

test('4.1 Provider失败仍返回本地详情，过期portrait保留而候选入口报告真实失败', async t => {
  const f = await fixture(t, { 'library.searchArtists': () => { throw failed('AUTH_REQUIRED') } })
  assert.equal((await f.api.getArtist({ artistId })).id, artistId)
  await assert.rejects(f.api.artistMatches({ artistId }), error => (error as { code: string }).code === 'AUTH_REQUIRED')
  await f.api.bindArtist({ artistId, neteaseArtistId: '12' })
  f.state.now += 25 * 60 * 60 * 1000
  f.handlers['library.artistProfile'] = () => { throw failed('AUTH_EXPIRED') }
  const cached = await f.api.getArtist({ artistId })
  assert.equal(cached.artworkUrl, profile().artworkUrl); assert.equal(cached.linkState, 'manual'); assert.equal(cached.biography, '合成资料')
  f.handlers['library.artistProfile'] = () => { throw failed('NOT_READY') }
  await assert.rejects(f.api.getArtist({ artistId }), error => (error as { code: string }).code === 'NOT_READY')
})

test('4.1 人工关联与解绑持久化、按dataset隔离，解绑不会触发重新自动关联', async t => {
  const f = await fixture(t)
  await f.api.bindArtist({ artistId, neteaseArtistId: '13' }); await f.service.close()
  const second = f.create(); t.after(() => second.close())
  assert.equal((await second.forDataset(dataset).getArtist({ artistId })).linkedNeteaseId, '13')
  await second.forDataset(dataset).bindArtist({ artistId, neteaseArtistId: null })
  const before = f.calls.filter(call => call.command.startsWith('library.')).length
  assert.equal((await second.forDataset(dataset).getArtist({ artistId })).linkState, 'unlinked')
  assert.equal(f.calls.filter(call => call.command.startsWith('library.')).length, before)
  f.state.datasetId = otherDataset
  const other = await second.forDataset(otherDataset).listArtists({ query: '', offset: 0, limit: 24 })
  assert.equal(other.items[0]?.linkedNeteaseId, undefined)
})

test('4.1 晚回自动关联不能覆盖期间明确的人工解绑', async t => {
  const held = gate<NeteaseArtistProfile>(), entered = gate<void>()
  const f = await fixture(t, { 'library.artistProfile': () => { entered.resolve(); return held.promise } })
  const automatic = f.api.getArtist({ artistId }); await entered.promise
  await f.api.bindArtist({ artistId, neteaseArtistId: null })
  held.resolve(profile()); assert.equal((await automatic).linkedNeteaseId, undefined)
  assert.equal((await f.api.getArtist({ artistId })).linkState, 'unlinked')
})

test('4.1 await前固定原参数，数据集切换拒绝晚回包且close阻断新请求', async t => {
  const held = gate<ReturnType<typeof artistPage>>()
  const f = await fixture(t, { 'localArtist.list': () => held.promise })
  const request = { query: '原查询', offset: 0, limit: 24 }, pending = f.api.listArtists(request)
  request.query = '新表单'; await turn()
  assert.equal(f.calls.find(call => call.command === 'localArtist.list')?.payload.query, '原查询')
  f.state.datasetId = otherDataset; held.resolve(artistPage({ ...request, query: '原查询' }))
  await assert.rejects(pending, error => (error as { code: string }).code === 'SOURCE_CHANGED')
  await f.service.close()
  await assert.rejects(f.api.listArtists({ query: '', offset: 0, limit: 24 }), error => (error as { code: string }).code === 'NOT_READY')
  assert.throws(() => f.service.forDataset(dataset), /NOT_READY/u)
})

test('4.1 PLAY_NOW完整固定revision分页后只提交一次原requestId，选曲不存在或换代不提交', async t => {
  const f = await fixture(t, { 'localArtist.tracks': window => localTracks(window, 450) })
  const request = { requestId: id(99), context: { kind: 'artist' as const, artistId, revision: 'r1' }, startTrackId: track(337).track.id,
    target: { core_id: 'core', zone_id: 'zone' }, action: 'PLAY_NOW' as const }
  const result = await f.api.playLocalSelection(request)
  assert.equal(result.status, 'accepted')
  assert.deepEqual(f.calls.filter(call => call.command === 'localArtist.tracks').map(call => call.payload.offset), [0, 200, 400])
  const prepared = f.calls.filter(call => call.command === 'localCatalog.prepare')
  assert.equal(prepared.length, 1); assert.equal(prepared[0]?.payload.request_id, request.requestId)
  assert.equal(prepared[0]?.payload.local_track_id, request.startTrackId); assert.deepEqual(prepared[0]?.payload.context, request.context)
  f.calls.length = 0
  await assert.rejects(f.api.playLocalSelection({ ...request, startTrackId: id(999999) }), /不在原集合/u)
  assert.equal(f.calls.filter(call => call.command === 'localCatalog.prepare').length, 0)
  f.handlers['localArtist.tracks'] = window => localTracks(window, 450, window.offset ? 'r2' : 'r1')
  await assert.rejects(f.api.playLocalSelection(request), /原歌曲集合已经变化/u)
  assert.equal(f.calls.filter(call => call.command === 'localCatalog.prepare').length, 0)
})

test('4.1 加入队列只提交选中单曲，不附完整context也不因大集合拒绝', async t => {
  const f = await fixture(t, { 'localArtist.tracks': window => localTracks(window, 6000) })
  await f.api.playLocalSelection({ requestId: id(100), context: { kind: 'artist', artistId, revision: 'r1' }, startTrackId: track(5).track.id,
    target: { core_id: 'core', zone_id: 'zone' }, action: 'APPEND_MB_QUEUE' })
  assert.equal(f.calls.filter(call => call.command === 'localArtist.tracks').length, 1)
  const prepared = f.calls.find(call => call.command === 'localCatalog.prepare')!.payload
  assert.equal(prepared.action, 'APPEND_MB_QUEUE'); assert.equal(Object.hasOwn(prepared, 'context'), false)
})

test('4.1 损坏或夹入未知字段的持久缓存不被静默覆盖', async t => {
  const f = await fixture(t)
  await f.api.bindArtist({ artistId, neteaseArtistId: '12' }); await f.service.close()
  const filename = path.join(f.directory, createHash('sha256').update(dataset).digest('hex'), 'catalog.v1.json')
  const stored = JSON.parse(await readFile(filename, 'utf8')); stored.profiles['12'].profile.unexpected = '不能保留的字段'
  const before = JSON.stringify(stored); await writeFile(filename, before)
  const second = f.create(); t.after(() => second.close())
  await assert.rejects(second.forDataset(dataset).listArtists({ query: '', offset: 0, limit: 24 }), /缓存尚未通过校验/u)
  assert.equal(await readFile(filename, 'utf8'), before)
})

test('4.1 分页预读失败明确not-sent，真正发送及发送后scope错误均不能宣称未发送', async t => {
  const f = await fixture(t, { 'localArtist.tracks': () => { throw failed('SOURCE_CHANGED') } })
  const request = { requestId: id(101), context: { kind: 'artist' as const, artistId, revision: 'r1' }, startTrackId: track(0).track.id,
    target: { core_id: 'core', zone_id: 'zone' }, action: 'PLAY_NOW' as const }
  const outcome = (error: unknown) => error && typeof error === 'object' ? Object.getOwnPropertyDescriptor(error, 'outcome')?.value : undefined
  await assert.rejects(f.api.playLocalSelection(request), error => outcome(error) === 'not-sent' && (error as { code: string }).code === 'SOURCE_CHANGED')
  assert.equal(f.calls.filter(call => call.command === 'localCatalog.prepare').length, 0)
  f.handlers['localArtist.tracks'] = window => localTracks(window)
  f.handlers['localCatalog.prepare'] = () => { throw Object.assign(failed('SOURCE_CHANGED'), { outcome: 'not-sent' }) }
  await assert.rejects(f.api.playLocalSelection(request), error => outcome(error) === undefined && (error as { code: string }).code === 'SOURCE_CHANGED')
  assert.equal(f.calls.filter(call => call.command === 'localCatalog.prepare').length, 1)
  f.handlers['localCatalog.prepare'] = () => { f.state.datasetId = otherDataset; return { status: 'accepted', request_id: request.requestId, action: request.action } }
  await assert.rejects(f.api.playLocalSelection(request), error => outcome(error) === undefined && (error as { code: string }).code === 'SOURCE_CHANGED')
  assert.equal(f.calls.filter(call => call.command === 'localCatalog.prepare').length, 2)
})
