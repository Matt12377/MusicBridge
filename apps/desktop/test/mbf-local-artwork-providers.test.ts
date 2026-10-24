import assert from 'node:assert/strict'
import test from 'node:test'
import { deflateSync } from 'node:zlib'
import { createPinnedArtworkTransport, type CommonsTransportResponse, type PinnedArtworkTransport } from '../src/main/commons-artwork-provider.js'
import { normalizeLocalArtwork } from '../src/main/local-artwork-image.js'
import type { PhotoDecoderImage } from '../src/main/collection-photos.js'
import { createLocalArtworkProviders, type LocalArtworkProviderCandidate } from '../src/main/local-library-workbench/providers/artwork-providers.js'
import { createLocalArtworkWebNavigation, isTrackedLocalArtworkWebNavigation, registerLocalArtworkNavigationPhysical, type LocalArtworkCapturedImage } from '../src/main/local-library-workbench/providers/artwork-web-navigation.js'
import { LocalProviderError } from '../src/main/local-library-workbench/providers/boundaries.js'

// 压缩容器、native decoder 与所有 transport 为受控合成；不连接真实图片来源或音乐库。
const signal = () => new AbortController().signal
function pngChunk(type: string, data = Buffer.alloc(0)): Buffer {
  const bytes = Buffer.alloc(data.length + 12)
  bytes.writeUInt32BE(data.length); bytes.write(type, 4, 'latin1'); data.copy(bytes, 8)
  let crc = 0xffffffff
  for (const byte of bytes.subarray(4, bytes.length - 4)) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1 }
  bytes.writeUInt32BE((crc ^ 0xffffffff) >>> 0, bytes.length - 4)
  return bytes
}
function png(): Buffer {
  const header = Buffer.alloc(13); header.writeUInt32BE(1); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 2
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk('IHDR', header), pngChunk('IDAT', deflateSync(Buffer.from([0, 10, 20, 30]))), pngChunk('IEND')])
}
function jpegSegment(marker: number, body: Buffer): Buffer { const header = Buffer.from([255, marker, 0, 0]); header.writeUInt16BE(body.length + 2, 2); return Buffer.concat([header, body]) }
function jpeg(): Buffer {
  const quantizer = Buffer.alloc(65, 1); quantizer[0] = 0
  const table = (info: number) => { const bytes = Buffer.alloc(18); bytes[0] = info; bytes[1] = 1; return bytes }
  return Buffer.concat([Buffer.from([255, 216]), jpegSegment(219, quantizer), jpegSegment(196, Buffer.concat([table(0), table(16)])), jpegSegment(192, Buffer.from([8, 0, 1, 0, 1, 1, 1, 17, 0])), jpegSegment(218, Buffer.from([1, 1, 0, 0, 63, 0])), Buffer.from([63, 255, 217])])
}
function decoder(): PhotoDecoderImage { return { isEmpty: () => false, getSize: () => ({ width: 1, height: 1 }), resize: () => decoder(), toJPEG: () => jpeg() } }
const normalize = (bytes: Uint8Array) => normalizeLocalArtwork(bytes, () => decoder())
const image = () => png()
const doubanImage = 'https://img9.doubanio.com/view/subject/m/public/s3737076.jpg'
const itunesImage = 'https://is1-ssl.mzstatic.com/image/thumb/Music115/v4/29/c1/2d/album.jpg/100x100bb.jpg'
function doubanRow(id = 1, overrides: Record<string, unknown> = {}) { return { id, title: '合成豆瓣专辑 / 外文名', abstract: '合成豆瓣作者 / 2000', cover_url: doubanImage, url: `https://music.douban.com/subject/${id}/`, ...overrides } }
function itunesRow(id = 2, overrides: Record<string, unknown> = {}) { return { collectionType: 'Album', collectionId: id, artistName: '合成 iTunes 作者', collectionName: '合成 iTunes 专辑', artworkUrl100: itunesImage, collectionViewUrl: `https://music.apple.com/cn/album/synthetic/${id}?uo=4`, ...overrides } }
const douban = (rows: ReturnType<typeof doubanRow>[] = [doubanRow()]) => Buffer.from(`<script>window.__DATA__ = ${JSON.stringify({ items: rows })};</script>`)
const itunes = (rows: ReturnType<typeof itunesRow>[] = [itunesRow()]) => Buffer.from(JSON.stringify({ results: rows }))
function response(bytes: Uint8Array, mime = 'application/json', statusCode = 200, headers: Record<string, string> = {}): CommonsTransportResponse {
  return { statusCode, headers: { 'content-type': mime, 'content-length': String(bytes.byteLength), ...headers }, body: (async function* () { yield bytes })(), destroy() {}, closed: Promise.resolve() }
}
function syntheticTransport(urls: URL[], overrides?: (url: URL) => CommonsTransportResponse | null): PinnedArtworkTransport {
  return async url => {
    urls.push(new URL(url.href))
    const replacement = overrides?.(url); if (replacement) return replacement
    return url.hostname === 'search.douban.com' ? response(douban(), 'text/html') : url.hostname === 'itunes.apple.com' ? response(itunes()) : response(image(), 'image/png')
  }
}
function deferred<T>() { let resolve!: (value: T | PromiseLike<T>) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }

test('异步封面规范化取消后，原操作join和close仍等待真实处理收口', async () => {
  const entered = deferred<void>(), released = deferred<void>(), parent = new AbortController()
  let processingSignal: AbortSignal | undefined
  const providers = createLocalArtworkProviders({ transport: async () => response(image(), 'image/png'),
    async normalize(bytes, signal) { processingSignal = signal; entered.resolve(); await released.promise; return normalize(bytes) } })
  const operation = providers.importRemoteSource({ url: 'https://images.example.com/source.png' }, parent.signal)
  const rejected = assert.rejects(operation, safe('cancelled'))
  await entered.promise
  let joined = false, closed = false
  const join = providers.cancelOriginal(operation).then(() => { joined = true })
  const close = providers.close().then(() => { closed = true })
  await rejected; await flush()
  assert.equal(processingSignal?.aborted, true)
  assert.equal(joined, false); assert.equal(closed, false)
  released.resolve(); await Promise.all([join, close])
  assert.equal(joined, true); assert.equal(closed, true)
})
const flush = () => new Promise<void>(resolve => setImmediate(resolve))
function safe(code?: string) {
  return (error: unknown) => {
    assert.ok(error instanceof LocalProviderError); if (code) assert.equal(error.code, code)
    assert.doesNotMatch(error.message + JSON.stringify(error), /images\.example|synthetic-secret|raw-location|Cookie|Authorization/u)
    assert.equal(Object.hasOwn(error, 'cause'), false); return true
  }
}
function publicOnly(candidate: LocalArtworkProviderCandidate): void {
  assert.match(candidate.candidateId, /^[0-9a-f-]{36}$/u)
  assert.match(candidate.previewUrl!, /^data:image\/jpeg;base64,/u)
  assert.doesNotMatch(JSON.stringify(candidate), /https?:|mzstatic|doubanio|imageUrl|providerId|sourcePageUrl|synthetic-secret|Cookie|Authorization/u)
  assert.equal(candidate.licenseLabel, '来源未提供授权信息')
}

test('聚合保持豆瓣/iTunes真实来源顺序、原地区查询协议与安全JPEG预览', async () => {
  const urls: URL[] = [], delay = deferred<void>()
  const transport: PinnedArtworkTransport = async url => {
    urls.push(new URL(url.href))
    if (url.hostname === 'search.douban.com') { await delay.promise; return response(douban(), 'text/html; charset=utf-8') }
    if (url.hostname === 'itunes.apple.com') { delay.resolve(); return response(itunes()) }
    return response(image(), 'image/png')
  }
  const providers = createLocalArtworkProviders({ normalize, transport })
  const result = await providers.search({ query: '合成 {专辑} & 艺人', country: 'jp', limit: 250 }, signal())
  assert.deepEqual(result.candidates.map(item => item.source), ['douban', 'itunes'])
  assert.deepEqual(result.sources.map(item => [item.source, item.status, item.candidateCount, item.previewFailureCount]), [['douban', 'ready', 1, 0], ['itunes', 'ready', 1, 0]])
  assert.equal(urls[0]!.pathname, '/music/subject_search'); assert.equal(urls[0]!.searchParams.get('cat'), '1003')
  const query = urls[1]!.searchParams
  assert.equal(query.get('term'), '合成 {专辑} & 艺人'); assert.equal(query.get('country'), 'JP'); assert.equal(query.get('media'), 'music'); assert.equal(query.get('entity'), 'album'); assert.equal(query.get('limit'), '200')
  assert.equal(urls[2]!.pathname, '/view/subject/l/public/s3737076.jpg'); assert.ok(urls[3]!.pathname.endsWith('/1200x1200bb.jpg'))
  for (const candidate of result.candidates) publicOnly(candidate)
  const privateCandidate = await providers.readCandidate(result.candidates[0]!.candidateId, signal())
  assert.deepEqual(privateCandidate.bytes, Uint8Array.from(image()))
  assert.equal(privateCandidate.source.providerId, 'douban-1'); assert.equal(privateCandidate.source.sourcePageUrl?.href, 'https://music.douban.com/subject/1/')
  assert.equal(privateCandidate.normalized.original.mime, 'image/png'); assert.equal(privateCandidate.normalized.display.mime, 'image/jpeg')
  providers.close()
})

test('豆瓣JSON字符串的括号/转义不破坏payload边界，文字与缺失作者准确展示', async () => {
  const urls: URL[] = []
  const providers = createLocalArtworkProviders({ normalize, transport: syntheticTransport(urls, url => url.hostname === 'search.douban.com' ? response(douban([doubanRow(1, { title: '<b>合成{专辑} "名字"</b> / 英文', abstract: null })]), 'text/html') : null) })
  const result = await providers.search({ query: '名称', source: 'douban' }, signal())
  assert.equal(result.candidates[0]!.albumName, '合成{专辑} "名字"'); assert.equal(result.candidates[0]!.artistName, '未知表演者'); publicOnly(result.candidates[0]!)
  providers.close()
})

test('单源失败保留另一个成功结果；两源确认空与两源失败分开', async () => {
  for (const kind of ['partial', 'empty', 'failed'] as const) {
    const urls: URL[] = []
    const providers = createLocalArtworkProviders({ normalize, transport: syntheticTransport(urls, url => {
      if (!['search.douban.com', 'itunes.apple.com'].includes(url.hostname)) return null
      if (kind === 'failed' || kind === 'partial' && url.hostname === 'search.douban.com') return response(Buffer.from('raw-location Cookie synthetic-secret'), 'text/html', 503)
      if (kind === 'empty') return url.hostname === 'search.douban.com' ? response(douban([]), 'text/html') : response(itunes([]))
      return null
    }) })
    const operation = providers.search({ query: '名称' }, signal()), result = await operation
    await providers.join(operation)
    if (kind === 'failed') {
      assert.deepEqual(result.candidates, [])
      assert.deepEqual(result.sources, ['douban', 'itunes'].map(source => ({ source, status: 'failed', candidateCount: 0, previewFailureCount: 0, truncated: false, error: new LocalProviderError('status').message })))
      assert.equal(urls.length, 2, '两源元数据均失败时不能创建候选或额外图片请求')
      assert.doesNotMatch(JSON.stringify(result), /raw-location|Cookie|synthetic-secret/u)
    } else {
      assert.deepEqual(result.candidates.map(item => item.source), kind === 'partial' ? ['itunes'] : [])
      assert.deepEqual(result.sources.map(item => item.status), kind === 'partial' ? ['failed', 'ready'] : ['ready', 'ready'])
      assert.doesNotMatch(JSON.stringify(result), /raw-location|Cookie|synthetic-secret/u)
    }
    providers.close()
  }
})

test('重复来源ID、非专辑、缺失名称与不安全图片地址不会发起图片请求', async () => {
  const urls: URL[] = []
  const invalid = [itunesRow(2), itunesRow(2), itunesRow(3, { collectionType: 'Song' }), itunesRow(4, { collectionName: null }), itunesRow(5, { artworkUrl100: 'https://127.0.0.1/a.jpg' }), itunesRow(6, { artworkUrl100: itunesImage.replace('https:', 'http:') }), itunesRow(7, { artworkUrl100: itunesImage.replace('.com/', '.com:443/') }), itunesRow(8, { artworkUrl100: itunesImage.replace('https://', 'https://user:synthetic-secret@') }), itunesRow(9, { artworkUrl100: itunesImage + '#x' }), itunesRow(10, { artworkUrl100: itunesImage.replace('mzstatic.com', 'mzstatic.com.evil.example.com') })]
  const providers = createLocalArtworkProviders({ normalize, transport: syntheticTransport(urls, url => url.hostname === 'itunes.apple.com' ? response(itunes(invalid)) : null) })
  const result = await providers.search({ query: '名称', source: 'itunes', limit: 0 }, signal())
  assert.equal(result.candidates.length, 1); assert.equal(urls.length, 2); assert.equal(urls[0]!.searchParams.get('limit'), '1'); publicOnly(result.candidates[0]!)
  providers.close()
})

test('候选预算保留truncated事实，不自动续页或批量拉取全部结果', async () => {
  const urls: URL[] = []
  const providers = createLocalArtworkProviders({ normalize, maxCandidates: 2, transport: syntheticTransport(urls, url => url.hostname === 'itunes.apple.com' ? response(itunes([itunesRow(1), itunesRow(2), itunesRow(3)])) : null) })
  const result = await providers.search({ query: '名称', source: 'itunes' }, signal())
  assert.equal(result.candidates.length, 2); assert.equal(result.sources[0]!.truncated, true); assert.equal(urls.length, 3)
  providers.close()
})

test('预览失败保留可重试opaque候选，与元数据来源失败区分', async () => {
  const urls: URL[] = []; let ready = false
  const providers = createLocalArtworkProviders({ normalize, transport: syntheticTransport(urls, url => url.hostname.includes('mzstatic') && !ready ? response(Buffer.from('raw-location'), 'text/html') : null) })
  const result = await providers.search({ query: '名称', source: 'itunes' }, signal()), candidate = result.candidates[0]!
  assert.equal(candidate.previewUrl, null); assert.equal(candidate.width, 0); assert.equal(result.sources[0]!.status, 'ready'); assert.equal(result.sources[0]!.previewFailureCount, 1)
  ready = true; publicOnly(await providers.readPreview(candidate.candidateId, signal())); assert.equal(urls.length, 3)
  providers.close()
})

test('图片MIME、魔术头、压缩编码、长度与响应预算在normalize前阻断', async () => {
  const cases = [
    response(image(), 'image/webp'), response(image(), 'text/html'), response(image(), 'image/jpeg'),
    response(image(), 'image/png', 200, { 'content-encoding': 'gzip' }), response(image(), 'image/png', 200, { 'content-length': '1' }),
    response(image(), 'image/png', 200, { 'content-length': String(4 * 1024 * 1024 + 1) }),
  ]
  for (const value of cases) {
    let normalizations = 0
    const providers = createLocalArtworkProviders({ normalize: bytes => { normalizations++; return normalize(bytes) }, transport: async () => value })
    await assert.rejects(providers.importRemoteSource({ url: 'https://images.example.com/source.png' }, signal()), safe())
    assert.equal(normalizations, 0); providers.close()
  }
  let destroyed = false
  const providers = createLocalArtworkProviders({ normalize, maxImageBytes: 16, transport: async () => ({ statusCode: 200, headers: { 'content-type': 'image/png' }, body: (async function* () { yield Buffer.alloc(17) })(), destroy() { destroyed = true }, closed: Promise.resolve() }) })
  await assert.rejects(providers.importRemoteSource({ url: 'https://images.example.com/source.png' }, signal()), safe('budget')); assert.equal(destroyed, true); providers.close()
})

test('normalizer不能把远程URL或原PNG冒充安全JPEG展示副本', async () => {
  for (const display of ['https://images.example.com/raw-location', 'data:image/png;base64,' + image().toString('base64')]) {
    const providers = createLocalArtworkProviders({ transport: async () => response(image(), 'image/png'), normalize: bytes => { const value = normalize(bytes); value.display.dataUrl = display; return value } })
    await assert.rejects(providers.importRemoteSource({ url: 'https://images.example.com/source.png' }, signal()), safe('candidate')); providers.close()
  }
})

test('显式远程导入只返回安全候选，token/定位信息与原图字节保持Main私有', async () => {
  const urls: URL[] = [], providers = createLocalArtworkProviders({ normalize, transport: syntheticTransport(urls) })
  const candidate = await providers.importRemoteSource({ url: 'https://images.example.com/selected.png?token=synthetic-secret', webSource: 'bing-images' }, signal())
  publicOnly(candidate); assert.equal(candidate.origin, 'manual'); assert.equal(candidate.sourceLabel, 'Bing 图片（手动导入）')
  const first = await providers.readCandidate(candidate.candidateId, signal())
  assert.match(first.source.imageUrl.href, /token=synthetic-secret/u); first.bytes[0] = 0; first.source.imageUrl.pathname = '/changed'
  const second = await providers.readCandidate(candidate.candidateId, signal())
  assert.equal(second.bytes[0], 137); assert.equal(second.source.imageUrl.pathname, '/selected.png'); assert.equal(urls.length, 1)
  providers.close()
})

test('远程手动输入拒绝HTTP、userinfo、端口、loopback/private/IP及伪造协议', async () => {
  let requests = 0
  const providers = createLocalArtworkProviders({ normalize, transport: async () => { requests++; return response(image(), 'image/png') } })
  for (const url of ['http://images.example.com/a.png', 'https://user:synthetic-secret@images.example.com/a.png', 'https://images.example.com:443/a.png', 'https://images.example.com:8443/a.png', 'https://127.0.0.1/a.png', 'https://10.0.0.1/a.png', 'https://192.168.1.1/a.png', 'https://[::1]/a.png', 'https://2130706433/a.png', 'https://localhost/a.png', 'https://host.local/a.png', 'file:///secret.png', 'data:image/png;base64,aA==', 'https://images.example.com/a.png#x', 'https://images.example.com/%2fsecret.png']) await assert.rejects(providers.importRemoteSource({ url }, signal()), safe('candidate'))
  assert.equal(requests, 0); providers.close()
})

test('现有pinned传输在发HTTPS前拒绝DNS私有答案，测试不进行真实DNS或网络', async () => {
  let lookups = 0
  const pinned = createPinnedArtworkTransport(async () => { lookups++; return [{ address: '10.0.0.8', family: 4 }] })
  const providers = createLocalArtworkProviders({ normalize, transport: pinned })
  await assert.rejects(providers.importRemoteSource({ url: 'https://images.example.com/source.png' }, signal()), safe('transport'))
  assert.equal(lookups, 1); providers.close()
})

test('远程导入重定向不跟随，不能借Location访问私有地址', async () => {
  let requests = 0, destroyed = 0
  const providers = createLocalArtworkProviders({ normalize, transport: async () => { requests++; return { ...response(Buffer.alloc(0), 'image/png', 302, { location: 'https://127.0.0.1/raw-location' }), destroy() { destroyed++ } } } })
  await assert.rejects(providers.importRemoteSource({ url: 'https://images.example.com/source.png' }, signal()), safe('status'))
  assert.equal(requests, 1); assert.equal(destroyed, 1); providers.close()
})

test('取消流后等待物理关闭证据，不把destroy调用或晚到响应冒充完成', async () => {
  const closing = deferred<void>(), parent = new AbortController(); let destroyed = false, settled = false
  const providers = createLocalArtworkProviders({ normalize, transport: async () => ({ statusCode: 200, headers: { 'content-type': 'image/png' }, body: (async function* () { yield image().subarray(0, 8); await new Promise<void>(() => {}) })(), destroy() { destroyed = true }, closed: closing.promise }) })
  const pending = providers.importRemoteSource({ url: 'https://images.example.com/source.png' }, parent.signal)
  const rejected = assert.rejects(pending, safe('cancelled')); void pending.then(() => { settled = true }, () => { settled = true })
  await flush(); parent.abort(); await flush(); assert.equal(destroyed, true); assert.equal(settled, false)
  closing.resolve(); await rejected; assert.equal(settled, true); providers.close()
  const late = deferred<CommonsTransportResponse>(); let lateDestroyed = false
  const lateProviders = createLocalArtworkProviders({ normalize, transport: () => late.promise })
  const latePending = lateProviders.importRemoteSource({ url: 'https://images.example.com/source.png' }, signal()), lateRejected = assert.rejects(latePending, safe('cancelled'))
  await flush(); lateProviders.close(); await lateRejected
  late.resolve({ ...response(image(), 'image/png'), destroy() { lateDestroyed = true } }); await flush(); assert.equal(lateDestroyed, true)
})

test('候选过期与close明确失效，展示缓存可按预算释放并从Main缓存重新读取', async () => {
  let clock = 1000
  const urls: URL[] = [], previewBytes = Buffer.byteLength(normalize(image()).display.dataUrl)
  const providers = createLocalArtworkProviders({ normalize, now: () => clock, candidateTtlMs: 100, maxPreviewBytes: previewBytes, transport: syntheticTransport(urls) })
  const first = await providers.importRemoteSource({ url: 'https://images.example.com/first.png' }, signal())
  await providers.importRemoteSource({ url: 'https://images.example.com/second.png' }, signal())
  publicOnly(await providers.readPreview(first.candidateId, signal())); assert.equal(urls.length, 2)
  clock += 100; await assert.rejects(providers.readCandidate(first.candidateId, signal()), safe('candidate'))
  providers.close(); await assert.rejects(providers.readCandidate(first.candidateId, signal()), safe('closed'))
})

test('同一候选并发读取共享一次受控图片请求，未能读取时不生成假预览', async () => {
  const loaded = deferred<CommonsTransportResponse>(); let requests = 0, retry = false
  const providers = createLocalArtworkProviders({ normalize, transport: async url => {
    if (url.hostname === 'itunes.apple.com') return response(itunes())
    requests++; return retry ? loaded.promise : response(Buffer.alloc(0), 'image/png', 503)
  } })
  const search = providers.search({ query: '名称', source: 'itunes' }, signal()), result = await search
  assert.equal(result.candidates[0]!.previewUrl, null); await providers.join(search)
  retry = true
  const preview = providers.readPreview(result.candidates[0]!.candidateId, signal()), privateBytes = providers.readCandidate(result.candidates[0]!.candidateId, signal())
  await flush(); assert.equal(requests, 2); loaded.resolve(response(image(), 'image/png'))
  publicOnly(await preview); assert.deepEqual((await privateBytes).bytes, Uint8Array.from(image()))
  await Promise.all([providers.join(preview), providers.join(privateBytes)]); await providers.close()
})

test('网页搜索保留应用内与显式外部两个端口，只导航固定来源和编码关键词', async () => {
  const navigated: URL[] = [], external: URL[] = []
  const navigation = createLocalArtworkWebNavigation({ navigate: url => { navigated.push(url) }, openExternal: url => { external.push(url) } })
  assert.deepEqual(await navigation.navigate({ source: 'douban-web', query: '合成专辑 & 作者' }), { opened: true })
  assert.deepEqual(await navigation.navigate({ source: 'bing-images', query: '合成专辑' }), { opened: true })
  assert.deepEqual(await navigation.openExternal({ source: 'google-images', query: '合成专辑' }), { opened: true })
  assert.equal(navigated[0]!.hostname, 'search.douban.com'); assert.equal(navigated[0]!.searchParams.get('search_text'), '合成专辑 & 作者')
  assert.equal(navigated[1]!.hostname, 'www.bing.com'); assert.equal(navigated[1]!.searchParams.get('q'), '合成专辑 封面')
  assert.equal(external[0]!.hostname, 'www.google.com'); assert.equal(external[0]!.searchParams.get('tbm'), 'isch'); assert.equal(external[0]!.searchParams.get('q'), '合成专辑 封面')
  await assert.rejects(navigation.navigate({ source: 'bing-images', query: 'https://127.0.0.1/secret' }), safe('input'))
  navigation.close(); await assert.rejects(navigation.navigate({ source: 'douban-web', query: '名称' }), safe('closed'))
  const disconnected = createLocalArtworkWebNavigation({})
  assert.deepEqual(await disconnected.navigate({ source: 'douban-web', query: '名称' }), { opened: false, reason: '应用内网页入口尚未接入。' })
  assert.deepEqual(await disconnected.openExternal({ source: 'douban-web', query: '名称' }), { opened: false, reason: '外部网页入口尚未接入。' }); disconnected.close()
})

// CD21捕获组件：仅受控原window/隔离world读取口；实际BrowserWindow拖图及Owner装配由Root另验。
const captureKeyA = 'a'.repeat(64), captureKeyB = 'b'.repeat(64)
const forgedCaptureId = '00000000-0000-4000-8000-000000000000'
const imageDragRef = (window: { captureId: string }, sequence = 1) => `${window.captureId}.${sequence}`
interface CapturedWindowFixture {
  captureId: string
  signal: AbortSignal
  closed: ReturnType<typeof deferred<void>>
  reads: number
  references: string[]
  aborts: number
}
function capturedWindowNavigation(read: (window: CapturedWindowFixture) => Promise<LocalArtworkCapturedImage | null>, autoClose = true) {
  const windows: CapturedWindowFixture[] = []
  const navigation = createLocalArtworkWebNavigation({
    navigate(_url, context) {
      const window: CapturedWindowFixture = { captureId: context.captureId, signal: context.signal, closed: deferred<void>(), reads: 0, references: [], aborts: 0 }
      windows.push(window)
      registerLocalArtworkNavigationPhysical(context.signal, { closed: window.closed.promise,
        abort() { window.aborts++; if (autoClose) window.closed.resolve() },
        readCapturedImage(dragRef) { window.reads++; window.references.push(dragRef); return read(window) } })
    },
  })
  return { navigation, windows, async open(key = captureKeyA) {
    const operation = navigation.navigate({ source: 'google-images', query: '合成捕获', originalCaptureKey: key })
    assert.deepEqual(await operation, { opened: true }); const window = windows.at(-1)!; assert.ok(window)
    assert.match(window.captureId, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u)
    return { operation, window }
  } }
}

test('CD21原图捕获：原UUID逐次drag各消费一次且可连续拖图，0至30秒沿原HTTPS资格', async () => {
  for (const ageMs of [0, 30_000]) {
    const fixture = capturedWindowNavigation(async () => ({ url: 'https://images.example.org/original.png', ageMs }))
    const { window } = await fixture.open()
    assert.equal(isTrackedLocalArtworkWebNavigation(fixture.navigation), true)
    assert.equal(window.reads, 0, '导航opened不自动读取或导入图片')
    await assert.rejects(fixture.navigation.consumeCapturedImage(captureKeyB, imageDragRef(window), signal()), safe('candidate'))
    await assert.rejects(fixture.navigation.consumeCapturedImage(captureKeyA, `${forgedCaptureId}.1`, signal()), safe('candidate'))
    assert.equal(window.reads, 0, '错key/伪UUID不能启动原读取口')
    assert.deepEqual(await fixture.navigation.consumeCapturedImage(captureKeyA, imageDragRef(window), signal()), { url: 'https://images.example.org/original.png', ageMs })
    assert.equal(window.reads, 1)
    await assert.rejects(fixture.navigation.consumeCapturedImage(captureKeyA, imageDragRef(window), signal()), safe('candidate'))
    assert.equal(window.reads, 1)
    assert.deepEqual(window.references, [imageDragRef(window)])
    assert.deepEqual(await fixture.navigation.consumeCapturedImage(captureKeyA, imageDragRef(window, 2), signal()), { url: 'https://images.example.org/original.png', ageMs })
    assert.equal(window.reads, 2); assert.deepEqual(window.references, [imageDragRef(window), imageDragRef(window, 2)])
    await assert.rejects(fixture.navigation.consumeCapturedImage(captureKeyA, imageDragRef(window), signal()), safe('candidate'))
    for (const invalid of [window.captureId, `${window.captureId}.0`, `${window.captureId}.01`, `${window.captureId}.1000000`])
      await assert.rejects(fixture.navigation.consumeCapturedImage(captureKeyA, invalid, signal()), safe('candidate'))
    assert.equal(window.reads, 2); await fixture.navigation.close()
  }
})

test('CD21原图捕获：稳定key的ABA替代不能接受旧UUID或迟到旧读取，乙key原window不撤销', async () => {
  const pending = deferred<LocalArtworkCapturedImage | null>()
  const fixture = capturedWindowNavigation(window => window === fixture.windows[0] ? pending.promise : Promise.resolve({ url: 'https://images.example.org/current.png', ageMs: 10 }), false)
  const first = await fixture.open(), reading = fixture.navigation.consumeCapturedImage(captureKeyA, imageDragRef(first.window), signal())
  const rejected = assert.rejects(reading, safe('cancelled')); await flush(); assert.equal(first.window.reads, 1)
  const other = await fixture.open(captureKeyB), replacement = await fixture.open(captureKeyA)
  assert.notEqual(first.window.captureId, replacement.window.captureId)
  assert.ok(first.window.signal.aborted); assert.equal(first.window.aborts, 1)
  assert.equal(other.window.signal.aborted, false); assert.equal(other.window.aborts, 0)
  await rejected
  await assert.rejects(fixture.navigation.consumeCapturedImage(captureKeyA, imageDragRef(first.window), signal()), safe('candidate'))
  let joined = false; const join = fixture.navigation.join(first.operation).then(() => { joined = true })
  first.window.closed.resolve(); await flush(); assert.equal(joined, false, '实际原closed后仍须等旧read producer settled')
  pending.resolve({ url: 'https://images.example.org/late-old.png', ageMs: 0 }); await join
  assert.deepEqual(await fixture.navigation.consumeCapturedImage(captureKeyA, imageDragRef(replacement.window), signal()), { url: 'https://images.example.org/current.png', ageMs: 10 })
  assert.deepEqual(await fixture.navigation.consumeCapturedImage(captureKeyB, imageDragRef(other.window), signal()), { url: 'https://images.example.org/current.png', ageMs: 10 })
  other.window.closed.resolve(); replacement.window.closed.resolve(); await fixture.navigation.close()
  for (const oldResult of [null, { url: 'https://images.example.org/late-first.png', ageMs: 1 }]) {
    const delayed = deferred<LocalArtworkCapturedImage | null>()
    const sameWindow = capturedWindowNavigation(window => window.reads === 1 ? delayed.promise : Promise.resolve({ url: 'https://images.example.org/second.png', ageMs: 2 }))
    const original = await sameWindow.open(), firstRead = sameWindow.navigation.consumeCapturedImage(captureKeyA, imageDragRef(original.window), signal())
    const firstRejected = assert.rejects(firstRead, safe('candidate')); await flush(); assert.equal(original.window.reads, 1)
    assert.deepEqual(await sameWindow.navigation.consumeCapturedImage(captureKeyA, imageDragRef(original.window, 2), signal()), { url: 'https://images.example.org/second.png', ageMs: 2 })
    delayed.resolve(oldResult); await firstRejected
    assert.equal(original.window.reads, 2); assert.deepEqual(original.window.references, [imageDragRef(original.window), imageDragRef(original.window, 2)])
    await sameWindow.navigation.close()
  }
})

test('CD21原图捕获：取消或原window关闭后不消费；cancelOriginal等待该window原读取producer', async () => {
  const pending = deferred<LocalArtworkCapturedImage | null>()
  const fixture = capturedWindowNavigation(() => pending.promise, false), first = await fixture.open()
  const reading = fixture.navigation.consumeCapturedImage(captureKeyA, imageDragRef(first.window), signal())
  const rejected = assert.rejects(reading, safe('cancelled')); await flush()
  let joined = false; const cancel = fixture.navigation.cancelOriginal(first.operation).then(() => { joined = true })
  await rejected; assert.equal(first.window.aborts, 1)
  await assert.rejects(fixture.navigation.consumeCapturedImage(captureKeyA, imageDragRef(first.window), signal()), safe('candidate'))
  first.window.closed.resolve(); await flush(); assert.equal(joined, false)
  pending.resolve(null); await cancel; assert.equal(joined, true); await fixture.navigation.close()
  const closedFixture = capturedWindowNavigation(async () => ({ url: 'https://images.example.org/unread.png', ageMs: 1 })), closedWindow = await closedFixture.open()
  closedWindow.window.closed.resolve(); await closedFixture.navigation.join(closedWindow.operation)
  await assert.rejects(closedFixture.navigation.consumeCapturedImage(captureKeyA, imageDragRef(closedWindow.window), signal()), safe('candidate'))
  assert.equal(closedWindow.window.reads, 0); await closedFixture.navigation.close()
})

test('CD21原图捕获：外部/无登记/无图片没有捕获授权，remote自造ID不替换原factory UUID', async () => {
  const fixture = capturedWindowNavigation(async () => null)
  const request = { source: 'google-images' as const, query: '无图', originalCaptureKey: captureKeyA, captureId: forgedCaptureId }
  const operation = fixture.navigation.navigate(request); await operation
  const window = fixture.windows[0]!; assert.notEqual(window.captureId, forgedCaptureId)
  assert.equal(await fixture.navigation.consumeCapturedImage(captureKeyA, imageDragRef(window), signal()), null)
  await assert.rejects(fixture.navigation.consumeCapturedImage(captureKeyA, imageDragRef(window), signal()), safe('candidate'))
  assert.equal(window.reads, 1); await fixture.navigation.close()
  let plainId = ''
  const plain = createLocalArtworkWebNavigation({ navigate(_url, context) {
    plainId = context.captureId; const done = deferred<void>()
    registerLocalArtworkNavigationPhysical(context.signal, { closed: done.promise, abort() { done.resolve() } })
  }, openExternal(_url, context) {
    assert.throws(() => registerLocalArtworkNavigationPhysical(context.signal, { closed: Promise.resolve(), abort() {}, readCapturedImage: async () => null }), safe('closed'))
  } })
  await plain.navigate({ source: 'bing-images', query: '无采集口', originalCaptureKey: captureKeyA })
  assert.equal(await plain.consumeCapturedImage(captureKeyA, `${plainId}.1`, signal()), null)
  await plain.openExternal({ source: 'bing-images', query: '外部', originalCaptureKey: captureKeyB })
  await assert.rejects(plain.consumeCapturedImage(captureKeyB, `${forgedCaptureId}.1`, signal()), safe('candidate'))
  await plain.close()
  const unknown = createLocalArtworkWebNavigation({ navigate() {} })
  const unregistered = unknown.navigate({ source: 'bing-images', query: '没有原window登记', originalCaptureKey: captureKeyA }); await unregistered
  await assert.rejects(unknown.consumeCapturedImage(captureKeyA, `${forgedCaptureId}.1`, signal()), safe('candidate'))
  await assert.rejects(unknown.join(unregistered), safe('closed')); await assert.rejects(unknown.close(), safe('closed'))
})

test('CD21原图捕获：过期/未来age及不合格HTTPS整组拒绝，原读取仅一次且错误不泄URL', async () => {
  const invalid: LocalArtworkCapturedImage[] = [
    ...[-1, 30_001, Number.NaN, Number.POSITIVE_INFINITY].map(ageMs => ({ url: 'https://images.example.org/input.png', ageMs })),
    ...['http://images.example.org/input.png', 'https://synthetic-secret@images.example.org/input.png', 'https://127.0.0.1/input.png',
      'file:///private/input.png', '/private/input.png', 'https://images.example.org:443/input.png', 'https://images.example.org/a/../input.png',
      'https://images.example.org/a%2fb.png', 'https://images.example.org/input.png#synthetic-secret'].map(url => ({ url, ageMs: 5 })),
  ]
  for (const image of invalid) {
    const fixture = capturedWindowNavigation(async () => image), { window } = await fixture.open()
    await assert.rejects(fixture.navigation.consumeCapturedImage(captureKeyA, imageDragRef(window), signal()), safe('candidate'))
    await assert.rejects(fixture.navigation.consumeCapturedImage(captureKeyA, imageDragRef(window), signal()), safe('candidate'))
    assert.equal(window.reads, 1); await fixture.navigation.close()
  }
})

test('CD21原图捕获：原请求parent取消与drop取消均拒迟到图，close只在原读取settled后完成', async () => {
  for (const cancelParent of [true, false]) {
    const pending = deferred<LocalArtworkCapturedImage | null>(), fixture = capturedWindowNavigation(() => pending.promise, false)
    const parent = new AbortController(), drop = new AbortController()
    const operation = fixture.navigation.navigate({ source: 'google-images', query: '原取消', originalCaptureKey: captureKeyA }, parent.signal); await operation
    const window = fixture.windows[0]!, reading = fixture.navigation.consumeCapturedImage(captureKeyA, imageDragRef(window), drop.signal)
    const rejected = assert.rejects(reading, safe('cancelled')); await flush(); assert.equal(window.reads, 1)
    if (cancelParent) parent.abort(); else drop.abort(); await rejected
    let quiet = false; const closing = fixture.navigation.close().then(() => { quiet = true })
    window.closed.resolve(); await flush(); assert.equal(quiet, false)
    pending.resolve({ url: 'https://images.example.org/late.png', ageMs: 1 }); await closing
    assert.equal(quiet, true); await assert.rejects(fixture.navigation.consumeCapturedImage(captureKeyA, imageDragRef(window), signal()), safe('candidate'))
  }
  const pendingReads = Array.from({ length: 24 }, () => deferred<LocalArtworkCapturedImage | null>())
  const bounded = capturedWindowNavigation(window => {
    const sequence = Number(window.references.at(-1)!.split('.')[1]); return pendingReads[sequence - 1]!.promise
  })
  const original = await bounded.open(), reads: Promise<LocalArtworkCapturedImage | Error | null>[] = []
  for (let sequence = 1; sequence <= 24; sequence++) {
    const read = bounded.navigation.consumeCapturedImage(captureKeyA, imageDragRef(original.window, sequence), signal())
    reads.push(read.catch((error: Error) => error)); await flush()
  }
  assert.equal(original.window.reads, 24)
  await assert.rejects(bounded.navigation.consumeCapturedImage(captureKeyA, imageDragRef(original.window, 25), signal()), safe('busy'))
  assert.equal(original.window.reads, 24, '第25个pending不能启动producer或推进最后sequence')
  for (const pending of pendingReads) pending.resolve({ url: 'https://images.example.org/latest.png', ageMs: 3 })
  const results = await Promise.all(reads)
  for (const result of results.slice(0, 23)) { assert.ok(result instanceof LocalProviderError); assert.equal(result.code, 'candidate') }
  assert.deepEqual(results[23], { url: 'https://images.example.org/latest.png', ageMs: 3 })
  await bounded.navigation.close()
})


test('私有资源可调用性：Provider核原动态transport和作者，缺状态/克隆/换代不授true且零网络', async () => {
  let transportCalls = 0, normalizeCalls = 0, alive = false, authorLive = true, authors = 0
  const transport: PinnedArtworkTransport = async () => { transportCalls++; throw new Error('状态读取不得发请求') }
  const context = { signal: signal(), assertCurrent() { authors++; if (!authorLive) throw new Error('原作者已换代') } }
  const bare = createLocalArtworkProviders({ transport, normalize })
  assert.equal((await bare.readAvailability('itunes', context)).available, false)
  const provider = createLocalArtworkProviders({ transport, normalize(bytes) { normalizeCalls++; return normalize(bytes) }, readTransportAvailability: () => alive })
  assert.equal((await provider.readAvailability('douban', context)).available, false)
  alive = true
  for (const source of ['douban', 'itunes', 'remote-import'] as const) assert.deepEqual(await provider.readAvailability(source, context), { available: true })
  assert.equal((await ({ ...provider }).readAvailability('itunes', context)).available, false)
  authorLive = false; assert.equal((await provider.readAvailability('itunes', context)).available, false)
  authorLive = true; const controller = new AbortController(); controller.abort()
  assert.equal((await provider.readAvailability('itunes', { ...context, signal: controller.signal })).available, false)
  assert.equal((await provider.readAvailability('unknown' as 'itunes', context)).available, false)
  assert.ok(authors >= 8); assert.equal(transportCalls, 0); assert.equal(normalizeCalls, 0)
  const stoppedBuiltin = createLocalArtworkProviders({ normalize, readTransportAvailability: () => false })
  assert.equal((await stoppedBuiltin.readAvailability('remote-import', context)).available, false); await stoppedBuiltin.close()
  const builtin = createLocalArtworkProviders({ normalize })
  assert.deepEqual(await builtin.readAvailability('remote-import', context), { available: true })
  await builtin.close(); assert.equal((await builtin.readAvailability('remote-import', context)).available, false)
  await provider.close(); await bare.close()
})

test('私有资源可调用性：Provider原关闭及physical UNKNOWN不能被迟到alive回报或空活动表覆盖', async () => {
  const reading = deferred<void>(), availability = deferred<boolean>(), context = { signal: signal(), assertCurrent() {} }
  const provider = createLocalArtworkProviders({ normalize, transport: syntheticTransport([]), readTransportAvailability: () => { reading.resolve(); return availability.promise } })
  const waiting = provider.readAvailability('itunes', context); await reading.promise
  const closing = provider.close(); availability.resolve(true)
  assert.equal((await waiting).available, false); await closing
  const broken = createLocalArtworkProviders({ normalize, readTransportAvailability: () => true, transport: async () => { const closed = Promise.reject<void>(new Error('原响应物理close失败')); void closed.catch(() => {}); return { ...response(image(), 'image/png'), closed } } })
  const operation = broken.importRemoteSource({ url: 'https://images.example.org/original.png' }, signal())
  await assert.rejects(operation); await assert.rejects(broken.join(operation))
  assert.equal((await broken.readAvailability('remote-import', context)).available, false)
  await assert.rejects(broken.close())
})

test('私有资源可调用性：网页逐端口核原资源状态/策略/作者，函数存在与未登记physical不授可调用', async () => {
  let openings = 0, alive = true, externalAlive = false, authorLive = true
  const context = { signal: signal(), assertCurrent() { if (!authorLive) throw new Error('原网页作者已换代') } }
  const bare = createLocalArtworkWebNavigation({ navigate() { openings++ } })
  assert.equal((await bare.readAvailability('navigate', 'bing-images', context)).available, false); await bare.close()
  const navigation = createLocalArtworkWebNavigation({ navigate() { openings++ }, openExternal() { openings++ }, readPortAvailability: mode => mode === 'navigate' ? alive : externalAlive })
  assert.deepEqual(await navigation.readAvailability('navigate', 'google-images', context), { available: true })
  assert.equal((await navigation.readAvailability('openExternal', 'google-images', context)).available, false)
  assert.equal((await ({ ...navigation }).readAvailability('navigate', 'google-images', context)).available, false)
  assert.equal((await navigation.readAvailability('navigate', 'unknown' as 'google-images', context)).available, false)
  authorLive = false; assert.equal((await navigation.readAvailability('navigate', 'bing-images', context)).available, false)
  authorLive = true; alive = false; assert.equal((await navigation.readAvailability('navigate', 'bing-images', context)).available, false)
  assert.equal(openings, 0)
  alive = true; const operation = navigation.navigate({ source: 'bing-images', query: '原资源闭口负例' }, signal())
  assert.deepEqual(await operation, { opened: true }); await assert.rejects(navigation.join(operation))
  assert.equal((await navigation.readAvailability('navigate', 'bing-images', context)).available, false)
  await assert.rejects(navigation.close())
})

test('私有资源可调用性：网页状态读取保原signal，close和作者换代拒迟到true而不打开window', async () => {
  const entered = deferred<void>(), ready = deferred<boolean>(), context = { signal: signal(), assertCurrent() {} }
  const navigation = createLocalArtworkWebNavigation({ navigate() { assert.fail('状态读取不得开window') }, readPortAvailability() { entered.resolve(); return ready.promise } })
  const reading = navigation.readAvailability('navigate', 'douban-web', context); await entered.promise
  const closing = navigation.close(); ready.resolve(true)
  assert.equal((await reading).available, false); await closing
  const controller = new AbortController(), pending = deferred<boolean>(), started = deferred<void>()
  const aborted = createLocalArtworkWebNavigation({ navigate() {}, readPortAvailability(_mode, actual) { assert.equal(actual, controller.signal); started.resolve(); return pending.promise } })
  const value = aborted.readAvailability('navigate', 'bing-images', { signal: controller.signal, assertCurrent() {} }); await started.promise; controller.abort()
  assert.equal((await value).available, false); pending.resolve(true); await aborted.close()
})

test('CD21刷新保原captureId/window/signal，旧document迟到读取拒绝且原window.closed仍由navigate持有', async () => {
  const closed = deferred<void>(), loaded = deferred<void>(), stale = deferred<LocalArtworkCapturedImage | null>(), parent = new AbortController(), key = 'a'.repeat(64)
  let captureId = '', originalSignal!: AbortSignal, opened = 0, reloads = 0, reads = 0
  const nav = createLocalArtworkWebNavigation({ readPortAvailability: () => true,
    navigate(_url, ctx) { opened++; captureId = ctx.captureId; originalSignal = ctx.signal; registerLocalArtworkNavigationPhysical(ctx.signal, { closed: closed.promise, abort: () => closed.resolve(), readCapturedImage: async ref => { reads++; return ref.endsWith('.1') ? stale.promise : { url: 'https://images.example.com/fresh.jpg', ageMs: 0 } } }) },
    refresh(_url, ctx) { reloads++; assert.equal(ctx.captureId, captureId); assert.equal(ctx.originalSignal, originalSignal); return loaded.promise },
  })
  const original = nav.navigate({ source: 'google-images', query: '同原查询', originalCaptureKey: key }, parent.signal); await original
  const old = nav.consumeCapturedImage(key, captureId + '.1', signal()), oldRejected = assert.rejects(old, safe('candidate')); await flush()
  const refreshing = nav.refresh({ source: 'google-images', query: '同原查询', originalCaptureKey: key }, signal()); await flush()
  assert.equal(opened, 1); assert.equal(reloads, 1); await assert.rejects(nav.consumeCapturedImage(key, captureId + '.2', signal()), safe('candidate'))
  loaded.resolve(); await refreshing; stale.resolve({ url: 'https://images.example.com/stale.jpg', ageMs: 0 }); await oldRejected; await nav.join(refreshing)
  assert.deepEqual(await nav.consumeCapturedImage(key, captureId + '.1025', signal()), { url: 'https://images.example.com/fresh.jpg', ageMs: 0 }); assert.equal(reads, 2)
  let quiet = false; const originalJoin = nav.join(original).then(() => { quiet = true }); await flush(); assert.equal(quiet, false)
  parent.abort(); await originalJoin; assert.equal(quiet, true); await nav.close()
})
test('CD21刷新拒跨原key/source/query和并发，cancel等原producer与原owned.closed，不以reload调用冒关闭', async () => {
  const closed = deferred<void>(), producer = deferred<void>(), key = 'b'.repeat(64); let aborts = 0, refreshes = 0
  const nav = createLocalArtworkWebNavigation({ readPortAvailability: () => true, navigate(_url, ctx) { registerLocalArtworkNavigationPhysical(ctx.signal, { closed: closed.promise, abort() { aborts++ } }) }, refresh() { refreshes++; return producer.promise } })
  await nav.navigate({ source: 'bing-images', query: '原查询', originalCaptureKey: key }, signal())
  for (const request of [{ source: 'bing-images' as const, query: '改正文', originalCaptureKey: key }, { source: 'google-images' as const, query: '原查询', originalCaptureKey: key }, { source: 'bing-images' as const, query: '原查询', originalCaptureKey: 'c'.repeat(64) }]) await assert.rejects(nav.refresh(request, signal()), safe('candidate'))
  assert.equal(refreshes, 0)
  const request = { source: 'bing-images' as const, query: '原查询', originalCaptureKey: key }, pending = nav.refresh(request, signal()), rejected = assert.rejects(pending, safe('cancelled')); await flush()
  await assert.rejects(nav.refresh(request, signal()), safe('busy'))
  let joined = false; const cancel = nav.cancelOriginal(pending).then(() => { joined = true }); await rejected; assert.ok(aborts > 0); await flush(); assert.equal(joined, false)
  producer.resolve(); await flush(); assert.equal(joined, false); closed.resolve(); await cancel; assert.equal(joined, true); await nav.close()
})
test('CD21 external在navigate不可用时仍核自身端口和固定编码URL，shell原Promise失败不报opened', async () => {
  let opened = 0, shellFailed = false; const ctx = { signal: signal(), assertCurrent() {} }
  const nav = createLocalArtworkWebNavigation({ readPortAvailability: mode => mode === 'openExternal', navigate() { assert.fail('external不得借内嵌窗口') }, openExternal(url) { opened++; assert.equal(url.hostname, 'www.google.com'); assert.equal(url.pathname, '/search'); assert.equal(url.searchParams.get('q'), '查询 & 原/? 封面'); if (shellFailed) return Promise.reject(new Error('原shell拒绝')) } })
  assert.equal((await nav.readAvailability('navigate', 'google-images', ctx)).available, false); assert.equal((await nav.readAvailability('openExternal', 'google-images', ctx)).available, true)
  const first = nav.openExternal({ source: 'google-images', query: '查询 & 原/?' }, ctx.signal); assert.deepEqual(await first, { opened: true }); await nav.join(first)
  shellFailed = true; await assert.rejects(nav.openExternal({ source: 'google-images', query: '查询 & 原/?' }, ctx.signal)); assert.equal(opened, 2)
  await assert.rejects(nav.close())
})
