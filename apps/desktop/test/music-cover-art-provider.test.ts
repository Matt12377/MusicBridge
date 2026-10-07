import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { isCoverArtArchiveSource } from '../../../packages/contracts/src/local-artwork.js'
import { createMusicCoverArtProvider, type MusicCoverArtProviderOptions } from '../src/main/music-cover-art-provider.js'
import type { CommonsTransportResponse, PinnedArtworkTransport } from '../src/main/commons-artwork-provider.js'

// 已有合成PNG有完整IHDR/IDAT/IEND和CRC；这些Provider测试仍不调用native解码或真实网络。
const PNG = readFileSync(new URL('../../../packages/bridge-core/test/fixtures/mbrs003/audio/inputs/cover-small.png', import.meta.url))
const A = '76df3287-6cda-33eb-8e9a-044b5e15ffdd'
const B = 'a1111111-2222-4333-8444-555555555555'
const C = 'c1111111-2222-1333-8444-555555555555'
const D = 'd1111111-2222-5333-8444-555555555555'
const signal = () => new AbortController().signal
const flush = () => new Promise<void>(done => setImmediate(done))
function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
let clockValue = Date.now() + 86_400_000
function freshClock() {
  clockValue += 120_000
  const state = { value: clockValue, now: () => state.value, advance: (milliseconds: number) => { state.value += milliseconds; clockValue = Math.max(clockValue, state.value) } }
  return state
}
function response(bytes: Uint8Array, type = 'application/json', statusCode = 200, headers: Record<string, string | string[]> = {}): CommonsTransportResponse {
  return { statusCode, headers: { 'content-type': type, 'content-length': String(bytes.byteLength), ...headers }, body: (async function* () { yield bytes })(), destroy() {}, closed: Promise.resolve() }
}
const json = (value: unknown) => Buffer.from(JSON.stringify(value))
function release(id = A, changes: Record<string, unknown> = {}) {
  return { id, title: '合成同名专辑', 'artist-credit': [{ name: '合成歌手甲', joinphrase: ' & ' }, { artist: { name: '合成歌手乙' } }], date: '2026-10-07', country: 'CN', ...changes }
}
function image(id = '829521842', releaseId = A, changes: Record<string, unknown> = {}) {
  return { id, front: true, approved: true, image: `http://coverartarchive.org/release/${releaseId}/${id}.png`, ...changes }
}
function listing(releaseId: string, images: unknown[]) { return { release: `http://musicbrainz.org/release/${releaseId}`, images } }
function setup(releases: unknown[] = [release()], images: Record<string, unknown[]> = { [A]: [image()] }, options: { clock?: ReturnType<typeof freshClock>; files?: Record<string, Uint8Array>; missing?: Set<string> } = {}) {
  const requests: URL[] = [], clock = options.clock ?? freshClock()
  const transport: PinnedArtworkTransport = async url => {
    requests.push(new URL(url))
    if (url.hostname === 'musicbrainz.org') return response(json({ releases }))
    const parts = url.pathname.split('/'), releaseId = parts[2]!, filename = parts[3]
    if (!filename) return options.missing?.has(releaseId) ? response(Buffer.alloc(0), 'application/json', 404) : response(json(listing(releaseId, images[releaseId] ?? [])))
    if (options.missing?.has(`${releaseId}/${filename}`)) return response(Buffer.alloc(0), 'image/png', 404)
    return response(options.files?.[`${releaseId}/${filename}`] ?? PNG, filename.endsWith('.png') ? 'image/png' : 'image/jpeg')
  }
  const provider = createMusicCoverArtProvider({ transport, now: clock.now })
  return { provider, requests, clock }
}

test('关键词搜索固定发行接口，真实合成PNG保留完整来源与独立图片权利', async () => {
  const { provider, requests } = setup()
  const result = await provider.search('合成专辑 歌手', signal())
  assert.equal(requests.length, 3)
  const first = requests[0]!
  assert.equal(first.origin + first.pathname, 'https://musicbrainz.org/ws/2/release')
  assert.deepEqual([...first.searchParams], [['fmt', 'json'], ['limit', '5'], ['query', '(release:"合成专辑 歌手" OR artist:"合成专辑 歌手")']])
  assert.equal(requests[2]!.href, `https://coverartarchive.org/release/${A}/829521842.png`)
  assert.deepEqual(result, [{ bytes: PNG, source: {
    releaseId: A, imageId: '829521842', releaseTitle: '合成同名专辑', artist: '合成歌手甲 & 合成歌手乙', releaseDate: '2026-10-07', country: 'CN',
    releaseUrl: `https://musicbrainz.org/release/${A}`, front: true, approved: true, musicBrainzMetadataLicense: 'CC0-core', imageRights: 'unverified', imageVariant: 'original', policyVersion: '2026-10-07-caa-personal-v1',
  } }])
  assert.ok(isCoverArtArchiveSource(result[0]!.source))
  provider.close()
})

test('v1/v3/v4/v5发行UUID可用，同名发行和相同图字节不按标题或Hash合并', async () => {
  for (const id of [A, B, C, D]) {
    const { provider } = setup([release(id)], { [id]: [image('1', id)] })
    assert.equal((await provider.search('发行版本', signal()))[0]!.source.releaseId, id)
    provider.close()
  }
  const { provider, requests } = setup([release(A), release(B, { date: '1998', country: 'JP' })], { [A]: [image('1')], [B]: [image('2', B)] })
  const results = await provider.search('同名版本', signal())
  assert.deepEqual(results.map(value => [value.source.releaseId, value.source.releaseDate, value.source.country]), [[A, '2026-10-07', 'CN'], [B, '1998', 'JP']])
  assert.deepEqual(results[0]!.bytes, results[1]!.bytes)
  assert.equal(requests.length, 5)
  provider.close()
})

test('front再approved稳定排序，只返回两原图；审核false仍诚实标图片权利未知', async () => {
  const { provider, requests } = setup([release()], { [A]: [image('1', A, { front: false }), image('2', A, { approved: false }), image('3'), image('4')] })
  const results = await provider.search('排序', signal())
  assert.deepEqual(results.map(value => value.source.imageId), ['3', '4'])
  assert.equal(requests.length, 4)
  provider.close()
  const versions = setup([release(), release(B)], { [A]: [image('1', A, { front: false }), image('2', A, { approved: false })], [B]: [image('3', B)] })
  assert.deepEqual((await versions.provider.search('跨发行排序', signal())).map(value => [value.source.releaseId, value.source.imageId]), [[B, '3'], [A, '2']])
  versions.provider.close()
  const unapproved = setup([release(A, { 'artist-credit': undefined, date: undefined, country: undefined })], { [A]: [image('5', A, { approved: false })] })
  const source = (await unapproved.provider.search('无歌手', signal()))[0]!.source
  assert.deepEqual([source.artist, source.releaseDate, source.country, source.approved, source.imageRights], ['', null, null, false, 'unverified'])
  unapproved.provider.close()
})

test('无发行、空图列表、CAA404和原图404均有界返回缺图并继续下一发行', async () => {
  for (const p of [setup([]), setup([release()], { [A]: [] }), setup([release()], {}, { missing: new Set([A]) })]) {
    assert.deepEqual(await p.provider.search('缺图', signal()), []); p.provider.close()
  }
  const p = setup([release(), release(B)], { [A]: [image('1')], [B]: [image('2', B)] }, { missing: new Set([`${A}/1.png`]) })
  assert.deepEqual((await p.provider.search('第一版缺图', signal())).map(value => value.source.releaseId), [B])
  p.provider.close()
})

test('legacy归档image字段只作身份核验，实际先CAA并跟随同release/image的HTTPS归档节点', async () => {
  const requests: URL[] = [], clock = freshClock()
  const provider = createMusicCoverArtProvider({ now: clock.now, transport: async url => {
    requests.push(new URL(url))
    if (url.hostname === 'musicbrainz.org') return response(json({ releases: [release()] }))
    if (url.hostname === 'coverartarchive.org' && url.pathname === `/release/${A}`) return response(Buffer.alloc(0), 'application/json', 307, { location: `https://archive.org/download/mbid-${A}/index.json` })
    if (url.pathname.endsWith('/index.json')) return response(json(listing(A, [image('1', A, { image: `http://archive.org/download/mbid-${A}/mbid-${A}-1.png` })])))
    if (url.hostname === 'coverartarchive.org') return response(Buffer.alloc(0), 'image/png', 307, { location: `https://archive.org/download/mbid-${A}/mbid-${A}-1.png` })
    if (url.hostname === 'archive.org') return response(Buffer.alloc(0), 'image/png', 307, { location: `https://ia800501.us.archive.org/3/items/mbid-${A}/mbid-${A}-1.png` })
    return response(PNG, 'image/png')
  } })
  const result = await provider.search('归档', signal())
  assert.deepEqual(result[0]!.bytes, PNG)
  assert.equal(requests[3]!.href, `https://coverartarchive.org/release/${A}/1.png`)
  assert.equal(requests[5]!.hostname, 'ia800501.us.archive.org')
  assert.ok(requests.every(value => value.protocol === 'https:'))
  provider.close()
})

test('恶意关键词在任何transport调用前拒绝，Lucene引号按字面转义', async () => {
  const values = ['', ' 前后空格 ', '甲'.repeat(81), 'https://example.org/a', 'file:/音乐', 'data:image/png;base64,x', 'www.example.org', '/私有/音乐', '关键词\n', 'x\u0000y']
  for (const value of values) {
    let calls = 0
    const provider = createMusicCoverArtProvider({ now: freshClock().now, transport: async () => { calls++; return response(json({ releases: [] })) } })
    await assert.rejects(provider.search(value, signal()), /关键词/u); assert.equal(calls, 0); provider.close()
  }
  const { provider, requests } = setup([])
  await provider.search('A" OR title:* \\ B', signal())
  assert.equal(requests[0]!.searchParams.get('query'), '(release:"A\\" OR title:* \\\\ B" OR artist:"A\\" OR title:* \\\\ B")')
  provider.close()
})

test('图片URL必须与release/image绑定，外部主机、私网、端口、auth、缩略图和编码路径不进入图请求', async () => {
  const values = [
    `https://example.org/${A}/1.png`, `https://127.0.0.1/release/${A}/1.png`, `https://coverartarchive.org:443/release/${A}/1.png`,
    `https://u:p@coverartarchive.org/release/${A}/1.png`, `https://coverartarchive.org/release/${B}/1.png`, `https://coverartarchive.org/release/${A}/2.png`,
    `https://coverartarchive.org/release/${A}/1-250.png`, `https://coverartarchive.org/release/${A}/%31.png`, `https://coverartarchive.org/release/${A}/../${A}/1.png`,
    `https://coverartarchive.org/release/${A}/1.png?q=1`, `https://coverartarchive.org/release/${A}/1.png#x`,
    `http://s3.us.archive.org/mbid-${A}/mbid-${A}-1.png`, `https://ia80050.us.archive.org/3/items/mbid-${A}/mbid-${A}-1.png`,
  ]
  for (const value of values) {
    const { provider, requests } = setup([release()], { [A]: [image('1', A, { image: value })] })
    await assert.rejects(provider.search('恶意图片来源', signal()), /音乐封面|CAA|归档/u)
    assert.equal(requests.length, 2); provider.close()
  }
})

test('每跳重新绑定路由，HTTP/跨发行/任意archive子域/相对跳出/超过三跳均拒绝', async () => {
  const targets = [
    `http://archive.org/download/mbid-${A}/index.json`, `https://archive.org/download/mbid-${B}/index.json`,
    `https://evil.archive.org/download/mbid-${A}/index.json`, `https://archive.org:443/download/mbid-${A}/index.json`,
    '../其他/index.json', '//archive.org/download/x/index.json', `https://ia800501.eu.archive.org/3/items/mbid-${B}/index.json`,
  ]
  for (const location of targets) {
    let calls = 0
    const provider = createMusicCoverArtProvider({ now: freshClock().now, transport: async url => {
      calls++; return url.hostname === 'musicbrainz.org' ? response(json({ releases: [release()] })) : response(Buffer.alloc(0), 'application/json', 307, { location })
    } })
    await assert.rejects(provider.search('重定向拒绝', signal()), /安全|身份|主机/u); assert.equal(calls, 2); provider.close()
  }
  let calls = 0
  const provider = createMusicCoverArtProvider({ now: freshClock().now, transport: async url => {
    calls++; return url.hostname === 'musicbrainz.org' ? response(json({ releases: [release()] })) : response(Buffer.alloc(0), 'application/json', 307, { location: `https://archive.org/download/mbid-${A}/index.json` })
  } })
  await assert.rejects(provider.search('过多重定向', signal()), /重定向超过预算/u); assert.equal(calls, 5); provider.close()
})

test('错误JSON、发行及图像结构在抓图前拒绝，元数据数量和文本长度均有界', async () => {
  const badReleases: unknown[] = [
    undefined, {}, Array.from({ length: 6 }, (_, i) => release([A, B, C, D, A, B][i]!)), [release(), release()],
    [release(A, { id: '非UUID' })], [release(A, { title: '甲'.repeat(513) })], [release(A, { 'artist-credit': [{ name: '甲'.repeat(513) }] })],
    [release(A, { 'artist-credit': Array.from({ length: 33 }, () => ({ name: '甲' })) })], [release(A, { date: '2026-99-99' })], [release(A, { country: 'CHN' })],
  ]
  for (const releases of badReleases) {
    let calls = 0
    const provider = createMusicCoverArtProvider({ now: freshClock().now, transport: async () => { calls++; return response(json({ releases })) } })
    await assert.rejects(provider.search('错误发行', signal()), /MusicBrainz|元数据/u); assert.equal(calls, 1); provider.close()
  }
  const badListings = [
    { ...listing(A, []), release: `https://musicbrainz.org/release/${B}` }, listing(A, Array.from({ length: 33 }, (_, i) => image(String(i)))),
    listing(A, [image('1'), image('1')]), listing(A, [image('1', A, { approved: 'true' })]), listing(A, [image('1'.repeat(21))]),
    listing(A, [image('1', A, { id: Number.MAX_SAFE_INTEGER + 1 })]), listing(A, [image('1', A, { front: undefined })]),
  ]
  for (const body of badListings) {
    let calls = 0
    const provider = createMusicCoverArtProvider({ now: freshClock().now, transport: async url => { calls++; return response(json(url.hostname === 'musicbrainz.org' ? { releases: [release()] } : body)) } })
    await assert.rejects(provider.search('错误列表', signal()), /CAA/u); assert.equal(calls, 2); provider.close()
  }
  for (const bytes of [Buffer.from('{无效'), Buffer.from([255]), json({ error: '上游私密文本' })]) {
    const provider = createMusicCoverArtProvider({ now: freshClock().now, transport: async () => response(bytes) })
    await assert.rejects(provider.search('错误JSON', signal()), error => error instanceof Error && error.message === '音乐封面元数据不是有效 JSON 对象。'); provider.close()
  }
})

test('512KiB元数据声明超限不消费body，流中超限即停且不信任Content-Length', async () => {
  for (const declared of ['524289', '99999999999999999999999', '1x']) {
    let reads = 0, destroys = 0
    const provider = createMusicCoverArtProvider({ now: freshClock().now, transport: async () => ({ statusCode: 200, headers: { 'content-type': 'application/json', 'content-length': declared }, body: (async function* () { reads++; yield json({ releases: [] }) })(), destroy() { destroys++ }, closed: Promise.resolve() }) })
    await assert.rejects(provider.search('字节预算', signal()), /字节预算/u); assert.equal(reads, 0); assert.equal(destroys, 1); provider.close()
  }
  let reads = 0
  const provider = createMusicCoverArtProvider({ now: freshClock().now, transport: async () => ({ statusCode: 200, headers: { 'content-type': 'application/json' }, body: (async function* () { reads++; yield Buffer.alloc(300_000); reads++; yield Buffer.alloc(300_000); reads++; yield Buffer.alloc(1) })(), destroy() {}, closed: Promise.resolve() }) })
  await assert.rejects(provider.search('流预算', signal()), /字节预算/u); assert.equal(reads, 2); provider.close()
})

test('每图4MiB、最多两图总8MiB；错误MIME/编码/签名和长度不一致拒绝', async () => {
  const large = Buffer.alloc(4 * 1024 * 1024); PNG.copy(large)
  // 尾部填充只用于Provider压缩字节预算；完整Main结构校验会另行拒绝这种输入。
  const p = setup([release()], { [A]: [image('1'), image('2'), image('3')] }, { files: { [`${A}/1.png`]: large, [`${A}/2.png`]: large } })
  const results = await p.provider.search('压缩预算', signal())
  assert.equal(results.length, 2); assert.equal(results.reduce((n, value) => n + value.bytes.byteLength, 0), 8 * 1024 * 1024); assert.equal(p.requests.length, 4); p.provider.close()
  const cases = [
    response(Buffer.alloc(4 * 1024 * 1024 + 1), 'image/png'), response(PNG, 'text/html'), response(PNG, 'image/png', 200, { 'content-encoding': 'gzip' }),
    response(Buffer.from('非图片'), 'image/png'), response(PNG, 'image/png', 200, { 'content-length': String(PNG.length + 1) }), response(PNG, 'image/png', 200, { 'content-length': ['1', '2'] }),
  ]
  for (const result of cases) {
    const provider = createMusicCoverArtProvider({ now: freshClock().now, transport: async url => url.hostname === 'musicbrainz.org' ? response(json({ releases: [release()] })) : url.pathname === `/release/${A}` ? response(json(listing(A, [image('1')]))) : result })
    await assert.rejects(provider.search('无效原图', signal()), /音乐封面/u); provider.close()
  }
})

test('客户端取消及时返回，body迟到不返回候选，下一请求等真实closed才执行', async t => {
  const closed = deferred<void>(), next = deferred<IteratorResult<Uint8Array>>(), entered = deferred<void>()
  let calls = 0, destroys = 0
  const clock = freshClock(), controller = new AbortController()
  const transport: PinnedArtworkTransport = async () => {
    calls++; entered.resolve()
    if (calls > 1) return response(json({ releases: [] }))
    return { statusCode: 200, headers: { 'content-type': 'application/json' }, body: { [Symbol.asyncIterator]: () => ({ next: () => next.promise }) }, destroy() { destroys++ }, closed: closed.promise }
  }
  const first = createMusicCoverArtProvider({ transport, now: clock.now }), second = createMusicCoverArtProvider({ transport, now: clock.now })
  t.after(() => { first.close(); second.close(); next.resolve({ done: true, value: undefined }); closed.resolve() })
  const old = first.search('旧查询', controller.signal)
  await entered.promise; controller.abort()
  await assert.rejects(old, /取消/u)
  assert.ok(destroys >= 1)
  clock.advance(2000)
  const newer = second.search('新查询', signal())
  next.resolve({ done: false, value: json({ releases: [] }) }); await flush()
  assert.equal(calls, 1)
  closed.resolve()
  assert.deepEqual(await newer, []); assert.equal(calls, 2)
})

test('transport迟到和服务close保留收尾名额，全部实例最多四个搜索且不继续抓图', async t => {
  const delivered = deferred<CommonsTransportResponse>(), closed = deferred<void>(), entered = deferred<void>()
  let calls = 0, destroys = 0
  const clock = freshClock()
  const transport: PinnedArtworkTransport = async () => { calls++; entered.resolve(); return calls === 1 ? delivered.promise : response(json({ releases: [] })) }
  const providers = Array.from({ length: 5 }, () => createMusicCoverArtProvider({ transport, now: clock.now }))
  t.after(() => { for (const provider of providers) provider.close(); delivered.resolve({ ...response(json({ releases: [] })), destroy() { destroys++ }, closed: closed.promise }); closed.resolve() })
  const first = providers[0]!.search('延迟连接', signal()); await entered.promise
  providers[0]!.close(); await assert.rejects(first, /取消/u)
  const queued = providers.slice(1, 4).map(provider => provider.search('排队', signal()))
  await assert.rejects(providers[4]!.search('队列满', signal()), /队列已满/u)
  for (const provider of providers.slice(1, 4)) provider.close()
  await Promise.all(queued.map(work => assert.rejects(work, /取消/u)))
  delivered.resolve({ ...response(json({ releases: [] })), destroy() { destroys++ }, closed: closed.promise }); await flush()
  assert.equal(calls, 1); assert.equal(destroys, 1)
  await assert.rejects(providers[4]!.search('仍未关闭', signal()), /队列已满/u)
  closed.resolve(); await flush(); clock.advance(2000)
  assert.deepEqual(await providers[4]!.search('关闭后恢复', signal()), []); assert.equal(calls, 2)
  await assert.rejects(providers[0]!.search('已关闭', signal()), /已关闭/u)
})

test('固定30秒期限在await后拒绝迟到结果且destroy，已取消输入零请求', async () => {
  let calls = 0, destroys = 0
  const clock = freshClock()
  const provider = createMusicCoverArtProvider({ now: clock.now, transport: async () => { calls++; clock.advance(30_000); return { ...response(json({ releases: [] })), destroy() { destroys++ } } } })
  await assert.rejects(provider.search('超时', signal()), /取消或超时/u); assert.equal(calls, 1); assert.ok(destroys >= 1); provider.close()
  const controller = new AbortController(); controller.abort()
  const unused = createMusicCoverArtProvider({ now: freshClock().now, transport: async () => { calls++; return response(json({ releases: [] })) } })
  await assert.rejects(unused.search('已取消', controller.signal), /取消/u); assert.equal(calls, 1); unused.close()
})

test('MusicBrainz跨实例一秒门禁包含底层租约等待，不自动retry', async () => {
  const clock = freshClock()
  let calls = 0
  const options: MusicCoverArtProviderOptions = { now: clock.now, transport: async () => { calls++; if (calls === 1) clock.advance(10_000); return response(json({ releases: [] })) } }
  const a = createMusicCoverArtProvider(options), b = createMusicCoverArtProvider(options)
  await a.search('第一查', signal())
  await assert.rejects(b.search('过快', signal()), /至少一秒/u); assert.equal(calls, 1)
  clock.advance(1000); await b.search('一秒后', signal()); assert.equal(calls, 2)
  a.close(); b.close()
})

test('全部Music实例每分钟30请求门禁，窗口到期后恢复', async () => {
  const clock = freshClock(); let calls = 0
  const options: MusicCoverArtProviderOptions = { now: clock.now, transport: async () => { calls++; return response(json({ releases: [] })) } }
  const a = createMusicCoverArtProvider(options), b = createMusicCoverArtProvider(options)
  for (let i = 0; i < 30; i++) { await (i % 2 ? a : b).search('速率预算', signal()); clock.advance(1000) }
  await assert.rejects(a.search('第31次', signal()), /每分钟 30/u); assert.equal(calls, 30)
  clock.advance(30_000); await a.search('窗口回收', signal()); assert.equal(calls, 31)
  a.close(); b.close()
})

test('重定向和服务失败同样占用每分钟预算，不自动重发或追查额外发行', async () => {
  const clock = freshClock(); let calls = 0
  const provider = createMusicCoverArtProvider({ now: clock.now, transport: async url => {
    calls++
    if (url.hostname === 'musicbrainz.org') return response(json({ releases: [release()] }))
    if (url.hostname === 'coverartarchive.org') return response(Buffer.alloc(0), 'application/json', 307, { location: `https://archive.org/download/mbid-${A}/index.json` })
    return response(Buffer.from('上游失败'), 'text/plain', 500)
  } })
  for (let i = 0; i < 10; i++) { await assert.rejects(provider.search('有界失败', signal()), /暂时无法提供/u); clock.advance(1000) }
  assert.equal(calls, 30)
  await assert.rejects(provider.search('预算已用尽', signal()), /每分钟 30/u); assert.equal(calls, 30)
  provider.close()
})

test('429/503遵守跨实例Retry-After，不重试；其他失败不泄露上游文本', async () => {
  for (const status of [429, 503]) {
    const clock = freshClock(); let calls = 0
    const first = createMusicCoverArtProvider({ now: clock.now, transport: async () => { calls++; return response(Buffer.from('上游私密文本'), 'text/plain', status, { 'retry-after': '120' }) } })
    await assert.rejects(first.search('限流', signal()), /暂时繁忙/u); assert.equal(calls, 1)
    const next = createMusicCoverArtProvider({ now: clock.now, transport: async () => { calls++; return response(json({ releases: [] })) } })
    clock.advance(60_000); await assert.rejects(next.search('不可截短', signal()), /降低请求频率/u); assert.equal(calls, 1)
    clock.advance(60_000); assert.deepEqual(await next.search('等待后', signal()), []); assert.equal(calls, 2)
    first.close(); next.close()
  }
  const p = createMusicCoverArtProvider({ now: freshClock().now, transport: async () => { throw new Error('https://私密来源/?token=私密') } })
  await assert.rejects(p.search('传输失败', signal()), error => error instanceof Error && error.message === '音乐封面查询失败。'); p.close()
})
