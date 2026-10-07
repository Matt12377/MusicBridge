import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import https from 'node:https'
import { Readable } from 'node:stream'
import test, { type TestContext } from 'node:test'
import {
  createCommonsArtworkProvider, createPinnedArtworkTransport,
  type CommonsTransportResponse,
} from '../src/main/commons-artwork-provider.js'
import { normalizeLocalArtwork } from '../src/main/local-artwork-image.js'

// 合成压缩头和受控传输仅证明Provider边界，不证明真实PNG/native解码或远程可用性。
function png(width = 1, height = 1, size = 33): Buffer {
  const bytes = Buffer.alloc(size)
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes)
  bytes.writeUInt32BE(13, 8); bytes.write('IHDR', 12); bytes.writeUInt32BE(width, 16); bytes.writeUInt32BE(height, 20)
  bytes[24] = 8; bytes[25] = 2
  return bytes
}
function jpeg(): Buffer { return Buffer.from([255, 216, 255, 192, 0, 8, 8, 0, 1, 0, 1, 1, 255, 217]) }
interface Page {
  pageid: number; lastrevid: number; ns: number; title: string; imagerepository: string
  imageinfo: Array<{
    url: string; descriptionurl: string; mime: string; size: number; width: number; height: number; sha1: string; timestamp: string
    extmetadata: Record<string, { value: unknown }>
  }>
}
function page(id = 1, bytes = png(), mime = 'image/png'): Page {
  const name = `Artwork${id}.${mime === 'image/png' ? 'png' : 'jpg'}`
  return {
    pageid: id, lastrevid: 100 + id, ns: 6, title: `File:${name}`, imagerepository: 'local',
    imageinfo: [{
      url: `https://upload.wikimedia.org/wikipedia/commons/a/ab/${name}`,
      descriptionurl: `https://commons.wikimedia.org/wiki/File:${name}`,
      mime, size: bytes.length, width: 1, height: 1, sha1: createHash('sha1').update(bytes).digest('hex'), timestamp: '2026-10-01T00:00:00Z',
      extmetadata: {
        LicenseShortName: { value: 'CC0' }, LicenseUrl: { value: 'http://creativecommons.org/publicdomain/zero/1.0/deed.en' },
        UsageTerms: { value: 'Creative Commons Zero, Public Domain Dedication' }, Copyrighted: { value: 'False' }, AttributionRequired: { value: 'False' },
        Artist: { value: '<a href="https://invalid.example/">合成作者</a>' },
      },
    }],
  }
}
const metadata = (pages: Page[]) => Buffer.from(JSON.stringify({ batchcomplete: true, query: { pages } }))
function response(bytes: Uint8Array, contentType = 'application/json', headers: Record<string, string> = {}, statusCode = 200): CommonsTransportResponse {
  return {
    statusCode, headers: { 'content-type': contentType, 'content-length': String(bytes.byteLength), ...headers },
    body: (async function* () { yield bytes })(), destroy() {}, closed: Promise.resolve(),
  }
}
let clockValue = Date.now() + 60_000
function freshClock(): () => number { clockValue += 120_000; return () => clockValue }
const signal = () => new AbortController().signal
function setup(pages: Page[], files: Uint8Array[] = [png()]) {
  const requests: URL[] = []
  let imageIndex = 0
  const provider = createCommonsArtworkProvider({ now: freshClock(), transport: async url => {
    requests.push(url)
    if (url.hostname === 'commons.wikimedia.org') return response(metadata(pages))
    const file = files[imageIndex++]!
    return response(file, url.pathname.endsWith('.jpg') ? 'image/jpeg' : 'image/png')
  } })
  return { provider, requests }
}
const flush = () => new Promise<void>(resolve => setImmediate(resolve))
function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

test('逐文件CC0保留文件与说明页修订身份，输出固定许可及纯文本作者', async () => {
  const p = page(), { provider, requests } = setup([p])
  const result = await provider.search('合成专辑 作者', signal())
  assert.deepEqual(result, [{ bytes: png(), source: { pageId: 1, pageRevision: 101, fileSha1: p.imageinfo[0]!.sha1, fileTimestamp: '2026-10-01T00:00:00Z', title: 'File:Artwork1.png', author: '合成作者', descriptionUrl: 'https://commons.wikimedia.org/wiki/File:Artwork1.png', licenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/', policyVersion: '2026-10-07-cc0-only-v1' } }])
  assert.equal(requests.length, 2)
  const query = requests[0]!.searchParams
  for (const [key, value] of Object.entries({ action: 'query', generator: 'search', gsrnamespace: '6', gsrlimit: '8', format: 'json', formatversion: '2', iilimit: '1', iilocalonly: '1' })) assert.equal(query.get(key), value)
  assert.equal(query.get('gsrsearch'), '"合成专辑 作者"'); assert.equal(query.has('continue'), false)
  assert.throws(() => normalizeLocalArtwork(result[0]!.bytes, () => { throw new Error('不应进入fake decoder') }), /结构/u)
  provider.close()
})

test('合成JPEG按声明头核对，完整解码仍留在Main边界', async () => {
  const bytes = jpeg(), { provider } = setup([page(1, bytes, 'image/jpeg')], [bytes])
  assert.deepEqual((await provider.search('合成JPEG', signal()))[0]!.bytes, bytes)
  provider.close()
})

test('作者缺失可为null；不能把上传者当作者', async () => {
  const p = page(); delete p.imageinfo[0]!.extmetadata.Artist
  Object.assign(p.imageinfo[0]!, { user: '合成上传者' })
  const { provider } = setup([p]); assert.equal((await provider.search('无作者', signal()))[0]!.source.author, null); provider.close()
})

test('作者HTML、实体和脚本只输出有界纯文本', async () => {
  const p = page(); p.imageinfo[0]!.extmetadata.Artist = { value: '<script>恶意代码</script><b>甲 &amp; 乙</b>&lt;img src=x&gt;' }
  const { provider } = setup([p]); assert.equal((await provider.search('纯文本', signal()))[0]!.source.author, '甲 & 乙'); provider.close()
})

test('标题和纯文本作者超过512字符时逐候选拒绝，不拖垮整组Main', async () => {
  for (const field of ['title', 'author']) {
    const p = page()
    if (field === 'title') p.title = 'File:' + 'x'.repeat(508)
    else p.imageinfo[0]!.extmetadata.Artist = { value: '甲'.repeat(513) }
    const { provider, requests } = setup([p]); assert.deepEqual(await provider.search('长度', signal()), []); assert.equal(requests.length, 1); provider.close()
  }
})

test('一般PD、BY、BY-SA、模糊多许可和License猜测不能独立放行', async () => {
  const edits: Array<(p: Page) => void> = [
    p => { p.imageinfo[0]!.extmetadata.LicenseShortName = { value: 'Public domain' } },
    p => { p.imageinfo[0]!.extmetadata.LicenseShortName = { value: 'CC BY 4.0' } },
    p => { p.imageinfo[0]!.extmetadata.LicenseShortName = { value: 'CC BY-SA 4.0' } },
    p => { p.imageinfo[0]!.extmetadata.LicenseShortName = { value: 'CC0|CC BY' } },
    p => { p.imageinfo[0]!.extmetadata.UsageTerms = { value: 'CC0 or CC BY' } },
    p => { p.imageinfo[0]!.extmetadata.License = { value: 'cc-by-sa-4.0' } },
    p => { p.imageinfo[0]!.extmetadata.License = { value: ['cc0', 'cc-by-sa-4.0'] } },
    p => { p.imageinfo[0]!.extmetadata = { License: { value: 'cc0' }, Copyrighted: { value: 'False' } } },
  ]
  for (const edit of edits) {
    const p = page(); edit(p); const { provider, requests } = setup([p]); assert.deepEqual(await provider.search('许可', signal()), []); assert.equal(requests.length, 1); provider.close()
  }
})

test('三个许可字段缺失或恶意许可URL时拒绝', async () => {
  for (const key of ['LicenseShortName', 'LicenseUrl', 'UsageTerms', 'Copyrighted', 'AttributionRequired']) {
    const p = page(); delete p.imageinfo[0]!.extmetadata[key]
    const { provider } = setup([p]); assert.deepEqual(await provider.search('缺失', signal()), []); provider.close()
  }
  for (const url of ['https://creativecommons.org.invalid/publicdomain/zero/1.0/', 'https://creativecommons.org:443/publicdomain/zero/1.0/', 'https://creativecommons.org/publicdomain/zero/1.0/#x', 'https://creativecommons.org/licenses/by/4.0/']) {
    const p = page(); p.imageinfo[0]!.extmetadata.LicenseUrl = { value: url }
    const { provider } = setup([p]); assert.deepEqual(await provider.search('假许可', signal()), []); provider.close()
  }
})

test('限制、删除、非自由、署名冲突和未知booleanish均默认拒绝', async () => {
  for (const [key, value] of [['Restrictions', ['personality']], ['DeletionReason', '争议'], ['NonFree', 'True'], ['AttributionRequired', 'True'], ['Copyrighted', '未知']] as const) {
    const p = page(); p.imageinfo[0]!.extmetadata[key] = { value }
    const { provider } = setup([p]); assert.deepEqual(await provider.search('限制', signal()), []); provider.close()
  }
})

test('File身份、修订、原图哈希及UTC时间必须闭合', async () => {
  const edits: Array<(p: Page) => void> = [p => { p.ns = 0 }, p => { p.imagerepository = 'shared' }, p => { p.lastrevid = 0 }, p => { p.pageid = -1 }, p => { p.title = 'Category:图片' }, p => { p.imageinfo[0]!.sha1 = 'a'.repeat(39) }, p => { p.imageinfo[0]!.timestamp = '2026-02-30T00:00:00Z' }, p => { p.imageinfo[0]!.descriptionurl = 'https://commons.wikimedia.org/wiki/File:Other.png' }, p => { p.imageinfo[0]!.url = 'https://upload.wikimedia.org/wikipedia/commons/a/ab/Other.png' }]
  for (const edit of edits) { const p = page(); edit(p); const { provider } = setup([p]); assert.deepEqual(await provider.search('身份', signal()), []); provider.close() }
})

test('原图声明字节、MIME及尺寸超限不发起取图', async () => {
  const edits: Array<(p: Page) => void> = [p => { p.imageinfo[0]!.size = 4 * 1024 * 1024 + 1 }, p => { p.imageinfo[0]!.width = 4097 }, p => { p.imageinfo[0]!.height = 0 }, p => { p.imageinfo[0]!.mime = 'image/svg+xml' }, p => { p.imageinfo.push(p.imageinfo[0]!) }]
  for (const edit of edits) { const p = page(); edit(p); const { provider, requests } = setup([p]); assert.deepEqual(await provider.search('预算', signal()), []); assert.equal(requests.length, 1); provider.close() }
})

test('8条候选仅最多下载2张，重复pageId不重复请求', async () => {
  const pages = [page(1), page(1), ...Array.from({ length: 6 }, (_, i) => page(i + 2))]
  const { provider, requests } = setup(pages, [png(), png()]); assert.equal((await provider.search('多条', signal())).length, 2); assert.equal(requests.length, 3); provider.close()
})

test('9条元数据拒绝，不续页、不取图', async () => {
  const { provider, requests } = setup(Array.from({ length: 9 }, (_, i) => page(i + 1)))
  await assert.rejects(provider.search('多条', signal()), /候选超过预算/u); assert.equal(requests.length, 1); provider.close()
})

test('用户URL、空词、控制字符和过长关键词在网络前拒绝', async () => {
  const { provider, requests } = setup([])
  for (const query of ['', ' ', 'https://commons.wikimedia.org/x', '专辑 http://example.invalid/', 'file:/private/secret', 'data:image/png;base64,x', '/Volumes/secret', 'x\nx', '甲'.repeat(121)]) await assert.rejects(provider.search(query, signal()), /关键词/u)
  assert.equal(requests.length, 0); provider.close()
})

test('伪造主机、协议、端口、凭据、fragment及站外路径不进入图片请求', async () => {
  for (const url of ['http://upload.wikimedia.org/wikipedia/commons/a/ab/Artwork1.png', 'https://upload.wikimedia.org.invalid/wikipedia/commons/a/ab/Artwork1.png', 'https://upload.wikimedia.org:443/wikipedia/commons/a/ab/Artwork1.png', 'https://user@upload.wikimedia.org/wikipedia/commons/a/ab/Artwork1.png', 'https://upload.wikimedia.org/wikipedia/commons/a/ab/Artwork1.png#x', 'https://upload.wikimedia.org/wikipedia/en/a/ab/Artwork1.png', 'https://127.0.0.1/wikipedia/commons/a/ab/Artwork1.png', 'https://upload.wikimedia.org/wikipedia/commons/%2f/Artwork1.png']) {
    const p = page(); p.imageinfo[0]!.url = url
    const { provider, requests } = setup([p]); assert.deepEqual(await provider.search('地址', signal()), []); assert.equal(requests.length, 1); provider.close()
  }
})

test('实际SHA1、压缩头、真实声明长度和响应MIME不一致时拒绝', async () => {
  for (const kind of ['hash', 'dimensions', 'mime', 'length', 'magic']) {
    const bytes = png(), p = page(), info = p.imageinfo[0]!
    let contentType = 'image/png'
    if (kind === 'hash') info.sha1 = '0'.repeat(40)
    if (kind === 'dimensions') info.width = 2
    if (kind === 'mime') contentType = 'image/jpeg'
    if (kind === 'length') info.size++
    if (kind === 'magic') { bytes[0] = 0; info.sha1 = createHash('sha1').update(bytes).digest('hex') }
    const provider = createCommonsArtworkProvider({ now: freshClock(), transport: async url => url.hostname === 'commons.wikimedia.org' ? response(metadata([p])) : response(bytes, contentType) })
    await assert.rejects(provider.search('不一致', signal()), /不一致/u); provider.close()
  }
})

test('两张原图恰好总8MiB可返回内部字节，第三张不下载', async () => {
  const bytes = png(1, 1, 4 * 1024 * 1024), pages = [page(1, bytes), page(2, bytes), page(3, bytes)]
  const { provider, requests } = setup(pages, [bytes, bytes]); const results = await provider.search('大边界', signal())
  assert.equal(results.reduce((sum, item) => sum + item.bytes.length, 0), 8 * 1024 * 1024); assert.equal(requests.length, 3); provider.close()
})

test('元数据512KiB恰好接受JSON，超限Content-Length不消费流', async () => {
  const empty = metadata([]), exact = Buffer.concat([empty, Buffer.alloc(512 * 1024 - empty.length, 32)])
  const provider = createCommonsArtworkProvider({ now: freshClock(), transport: async () => response(exact) }); assert.deepEqual(await provider.search('元数据边界', signal()), []); provider.close()
  let read = false, destroyed = false
  const oversized = createCommonsArtworkProvider({ now: freshClock(), transport: async () => ({ ...response(Buffer.alloc(0), 'application/json', { 'content-length': String(512 * 1024 + 1) }), body: (async function* () { read = true })(), destroy() { destroyed = true } }) })
  await assert.rejects(oversized.search('超限', signal()), /字节预算/u); assert.equal(read, false); assert.equal(destroyed, true); oversized.close()
})

test('未知流长度的元数据和图片累计超限立即destroy', async () => {
  for (const kind of ['api', 'image']) {
    let destroyed = false
    const provider = createCommonsArtworkProvider({ now: freshClock(), transport: async url => {
      if (kind === 'image' && url.hostname === 'commons.wikimedia.org') return response(metadata([page()]))
      return { statusCode: 200, headers: { 'content-type': kind === 'api' ? 'application/json' : 'image/png' }, body: (async function* () { yield Buffer.alloc(kind === 'api' ? 512 * 1024 + 1 : 4 * 1024 * 1024 + 1) })(), destroy() { destroyed = true }, closed: Promise.resolve() }
    } })
    await assert.rejects(provider.search('流预算', signal()), /字节预算/u); assert.equal(destroyed, true); provider.close()
  }
})

test('响应长度、压缩编码、JSON及UTF8无效时拒绝', async () => {
  const cases = [response(metadata([]), 'application/json', { 'content-length': '1' }), response(metadata([]), 'application/json', { 'content-encoding': 'gzip' }), response(Buffer.from('{坏JSON')), response(Buffer.from([0xff, 0xfe])), response(metadata([]), 'text/html')]
  for (const value of cases) { const provider = createCommonsArtworkProvider({ now: freshClock(), transport: async () => value }); await assert.rejects(provider.search('响应', signal())); provider.close() }
})

test('同闭集的一次重定向可完成，第二跳与外部Location立即拒绝', async () => {
  for (const kind of ['one', 'two', 'external', 'port']) {
    let count = 0, destroyed = 0
    const provider = createCommonsArtworkProvider({ now: freshClock(), transport: async () => {
      count++
      if (kind === 'one' && count === 2) return response(metadata([]))
      const location = kind === 'external' ? 'https://127.0.0.1/w/api.php' : kind === 'port' ? 'https://commons.wikimedia.org:443/w/api.php' : '/w/api.php?format=json'
      return { ...response(Buffer.alloc(0), 'application/json', { location }, 302), destroy() { destroyed++ } }
    } })
    if (kind === 'one') assert.deepEqual(await provider.search('重定向', signal()), [])
    else await assert.rejects(provider.search('重定向', signal()), /地址|重定向/u)
    assert.equal(count, kind === 'external' || kind === 'port' ? 1 : 2); assert.ok(destroyed >= 1); provider.close()
  }
})

test('429与503遵守Retry-After，无重试且共享冷却', async () => {
  for (const status of [429, 503]) {
    let count = 0; const now = freshClock(), start = now()
    const provider = createCommonsArtworkProvider({ now, transport: async () => { count++; return response(Buffer.alloc(0), 'application/json', { 'retry-after': '60' }, status) } })
    await assert.rejects(provider.search('节流', signal()), /繁忙/u)
    const other = createCommonsArtworkProvider({ now, transport: async () => { count++; return response(metadata([])) } })
    await assert.rejects(other.search('冷却', signal()), /降低请求频率/u); assert.equal(count, 1)
    clockValue = start + 60_001; assert.deepEqual(await other.search('冷却结束', signal()), []); provider.close(); other.close()
  }
})

test('全实例合计每分钟最多30请求，超过预算不调用transport', async () => {
  let count = 0; const now = freshClock()
  const options = { now, transport: async () => { count++; return response(metadata([])) } }
  const first = createCommonsArtworkProvider(options), second = createCommonsArtworkProvider(options)
  for (let index = 0; index < 30; index++) assert.deepEqual(await (index % 2 ? first : second).search('速率', signal()), [])
  await assert.rejects(first.search('超出速率', signal()), /30 次/u); assert.equal(count, 30); first.close(); second.close()
})

test('排队等待物理close时不提前消费速率窗口，启动时重新核对', async () => {
  const physicalClose = deferred<void>(), started = deferred<void>(), now = freshClock(), start = now()
  let calls = 0
  const options = { now, transport: async () => {
    calls++
    if (calls === 30) { started.resolve(); return { ...response(metadata([])), closed: physicalClose.promise } }
    return response(metadata([]))
  } }
  const first = createCommonsArtworkProvider(options), second = createCommonsArtworkProvider(options)
  for (let index = 0; index < 29; index++) assert.deepEqual(await first.search('已启动', signal()), [])
  const one = first.search('最后槽', signal()); await started.promise
  let outcome = 'pending'
  const two = second.search('排队', signal())
  two.then(() => { outcome = 'resolved' }, () => { outcome = 'rejected' })
  try {
    await flush(); assert.equal(outcome, 'pending'); assert.equal(calls, 30)
    clockValue = start + 60_001
    physicalClose.resolve(); assert.deepEqual(await one, []); assert.deepEqual(await two, []); assert.equal(calls, 31)
  } finally {
    physicalClose.resolve(); first.close(); second.close(); await Promise.allSettled([one, two])
  }
})

test('所有实例串行，response.closed未确认前不得启动下一物理请求', async () => {
  const physicalClose = deferred<void>(), started = deferred<void>(); let calls = 0
  const options = { now: freshClock(), transport: async () => { calls++; if (calls === 1) { started.resolve(); return { ...response(metadata([])), closed: physicalClose.promise } } return response(metadata([])) } }
  const first = createCommonsArtworkProvider(options), second = createCommonsArtworkProvider(options)
  const one = first.search('甲', signal()); await started.promise
  const two = second.search('乙', signal()); await flush(); assert.equal(calls, 1)
  physicalClose.resolve(); assert.deepEqual(await one, []); assert.deepEqual(await two, []); assert.equal(calls, 2); first.close(); second.close()
})

test('取消立即拒绝逻辑结果，但直到流和physical close结束才释放请求槽', async () => {
  const delayedBody = deferred<void>(), physicalClose = deferred<void>(), started = deferred<void>(); let calls = 0, destroyed = 0
  const options = { now: freshClock(), transport: async () => {
    calls++
    if (calls !== 1) return response(metadata([]))
    started.resolve()
    return { ...response(metadata([])), body: (async function* () { await delayedBody.promise; yield metadata([]) })(), destroy() { destroyed++ }, closed: physicalClose.promise }
  } }
  const first = createCommonsArtworkProvider(options), second = createCommonsArtworkProvider(options), control = new AbortController()
  const one = first.search('取消', control.signal); await started.promise; control.abort(); await assert.rejects(one, /取消/u); assert.ok(destroyed > 0)
  const two = second.search('后来', signal()); await flush(); assert.equal(calls, 1)
  delayedBody.resolve(); await flush(); assert.equal(calls, 1); physicalClose.resolve(); assert.deepEqual(await two, []); first.close(); second.close()
})

test('15秒总deadline拒绝迟到元数据；关闭同样取消，并且禁止新search', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const delayed = deferred<void>(), started = deferred<void>(); let destroyed = 0
  const provider = createCommonsArtworkProvider({ now: freshClock(), transport: async () => { started.resolve(); return { ...response(metadata([])), body: (async function* () { await delayed.promise; yield metadata([]) })(), destroy() { destroyed++ } } } })
  const late = provider.search('期限', signal()); await started.promise; t.mock.timers.tick(15_000); await assert.rejects(late, /超时/u)
  assert.ok(destroyed > 0); delayed.resolve(); await flush(); provider.close(); await assert.rejects(provider.search('关闭后', signal()), /关闭/u)
})

test('预先取消的signal不调用网络；close销毁在途请求', async () => {
  const { provider, requests } = setup([]), control = new AbortController(); control.abort()
  await assert.rejects(provider.search('取消前', control.signal), /取消/u); assert.equal(requests.length, 0); provider.close()
  const body = deferred<void>(), started = deferred<void>(); let destroyed = false
  const active = createCommonsArtworkProvider({ now: freshClock(), transport: async () => { started.resolve(); return { ...response(metadata([])), body: (async function* () { await body.promise; yield metadata([]) })(), destroy() { destroyed = true } } } })
  const task = active.search('关闭', signal()); await started.promise; active.close(); await assert.rejects(task, /取消/u); assert.equal(destroyed, true); body.resolve(); await flush()
})

// 模拟https.request和TLS事件，只验证配置、DNS pin与关闭生命周期；没有真实TLS或网络证据。
function mockHttps(t: TestContext, peer = '185.15.58.224') {
  const captured: Array<https.RequestOptions & { autoSelectFamily?: boolean }> = []
  t.mock.method(https, 'request', (_url: URL, options: https.RequestOptions) => {
    captured.push(options)
    const request = new EventEmitter() as EventEmitter & { end(): void; destroy(error?: Error): void }
    let destroyed = false
    const incoming = Readable.from([metadata([])]) as Readable & { statusCode: number; headers: Record<string, string> }
    incoming.statusCode = 200; incoming.headers = { 'content-type': 'application/json' }
    request.destroy = error => {
      if (destroyed) return; destroyed = true; incoming.destroy()
      queueMicrotask(() => { if (error) request.emit('error', error); request.emit('close') })
    }
    request.end = () => queueMicrotask(() => {
      const socket = Object.assign(new EventEmitter(), { remoteAddress: peer })
      request.emit('socket', socket); socket.emit('secureConnect')
      if (!destroyed) request.emit('response', incoming)
    })
    return request
  })
  return captured
}

test('HTTPS连接用已校验DNS地址pin，不二次查DNS，TLS/UA/agent配置保留', async t => {
  const captured = mockHttps(t); let lookups = 0
  const provider = createCommonsArtworkProvider({ now: freshClock(), lookup: async host => { assert.equal(host, 'commons.wikimedia.org'); lookups++; return [{ address: lookups === 1 ? '185.15.58.224' : '127.0.0.1', family: 4 }] } })
  assert.deepEqual(await provider.search('pin', signal()), []); assert.equal(lookups, 1); assert.equal(captured.length, 1)
  const options = captured[0]!
  assert.equal(options.agent, false); assert.equal(options.rejectUnauthorized, true); assert.equal(options.servername, 'commons.wikimedia.org'); assert.equal(options.autoSelectFamily, false)
  assert.equal((options.headers as Record<string, string>)['User-Agent'], 'MusicBridge/0.1.0 (https://github.com/Matt12377/MusicBridge; artwork-contact via repository issues)')
  const lookup = options.lookup as NonNullable<https.RequestOptions['lookup']>
  lookup('commons.wikimedia.org', {}, (error, address, family) => { assert.equal(error, null); assert.equal(address, '185.15.58.224'); assert.equal(family, 4) })
  assert.equal(lookups, 1); provider.close()
})

test('任一DNS答案非公网均不建立HTTPS连接，包括混合结果与全部特殊范围', async t => {
  const captured = mockHttps(t)
  const addresses = ['0.0.0.0', '10.0.0.1', '100.64.0.1', '127.0.0.1', '169.254.169.254', '172.16.0.1', '192.168.0.1', '192.0.2.1', '198.18.0.1', '198.51.100.1', '203.0.113.1', '224.0.0.1', '255.255.255.255', '::', '::1', '::ffff:127.0.0.1', '::ffff:0808:0808', 'fc00::1', 'fe80::1', 'ff02::1', '64:ff9b::808:808', '2001::1', '2001:2::1', '2001:db8::1', '2002:0808:0808::1', '3ffe::1', '3fff::1']
  for (const address of addresses) {
    const provider = createCommonsArtworkProvider({ now: freshClock(), lookup: async () => [{ address: '185.15.58.224', family: 4 }, { address, family: address.includes(':') ? 6 : 4 }] })
    await assert.rejects(provider.search('特殊地址', signal()), /公网地址/u); provider.close()
  }
  assert.equal(captured.length, 0)
})

test('连接peer与pin地址不一致时destroy，不返回元数据', async t => {
  mockHttps(t, '185.15.58.225')
  const provider = createCommonsArtworkProvider({ now: freshClock(), lookup: async () => [{ address: '185.15.58.224', family: 4 }] })
  await assert.rejects(provider.search('peer', signal()), /连接失败/u); provider.close()
})

test('普通公网IPv6可pin，不能把全体IPv6误当特殊地址', async t => {
  const address = '2620:0:861:ed1a::1', captured = mockHttps(t, address)
  const provider = createCommonsArtworkProvider({ now: freshClock(), lookup: async () => [{ address, family: 6 }] })
  assert.deepEqual(await provider.search('IPv6', signal()), []); assert.equal(captured[0]!.family, 6); provider.close()
})

test('原生request取消会destroy，headers前close同样释放租约并拒绝', async t => {
  let destroyed = 0
  const began = deferred<void>()
  t.mock.method(https, 'request', () => {
    const request = new EventEmitter() as EventEmitter & { end(): void; destroy(error?: Error): void }
    request.end = () => began.resolve()
    request.destroy = error => { destroyed++; queueMicrotask(() => { if (error) request.emit('error', error); request.emit('close') }) }
    return request
  })
  const control = new AbortController(), provider = createCommonsArtworkProvider({ now: freshClock(), lookup: async () => [{ address: '185.15.58.224', family: 4 }] })
  const pending = provider.search('原生取消', control.signal); await began.promise; control.abort(); await assert.rejects(pending, /取消/u)
  await flush(); assert.equal(destroyed, 1); provider.close()
})

test('Main内部复用transport仍pin DNS，非HTTPS或凭据URL在lookup前拒绝', async t => {
  const captured = mockHttps(t); let lookups = 0
  const transport = createPinnedArtworkTransport(async () => { lookups++; return [{ address: '185.15.58.224', family: 4 }] })
  for (const value of ['http://musicbrainz.org/ws/2/release', 'https://user@musicbrainz.org/ws/2/release', 'https://musicbrainz.org:444/ws/2/release', 'https://musicbrainz.org/ws/2/release#x']) await assert.rejects(transport(new URL(value), signal()), /安全规则/u)
  assert.equal(lookups, 0)
  const result = await transport(new URL('https://musicbrainz.org/ws/2/release?fmt=json'), signal())
  for await (const _ of result.body) { /* 模拟完整消费。 */ }
  result.destroy(); await result.closed
  assert.equal((captured[0]!.headers as Record<string, string>).Accept, 'application/json'); assert.equal(lookups, 1)
  const id = '12345678-1234-1234-1234-123456789abc'
  for (const [value, accept] of [
    [`https://coverartarchive.org/release/${id}`, 'application/json'],
    [`https://coverartarchive.org/release/${id}/123.png`, 'image/png,image/jpeg'],
    [`https://archive.org/download/mbid-${id}/index.json`, 'application/json'],
    [`https://ia800001.us.archive.org/download/mbid-${id}/123.png`, 'image/png,image/jpeg'],
  ]) {
    const reply = await transport(new URL(value!), signal())
    for await (const _ of reply.body) { /* 模拟完整消费。 */ }
    reply.destroy(); await reply.closed
    assert.equal((captured.at(-1)!.headers as Record<string, string>).Accept, accept)
  }
})

test('底层异常统一中文且不把URL、真实路径或错误栈作为用户错误', async () => {
  const provider = createCommonsArtworkProvider({ now: freshClock(), transport: async () => { throw new Error('https://secret.invalid/ /Volumes/private 内容') } })
  await assert.rejects(provider.search('错误', signal()), error => { assert.equal((error as Error).message, '封面查询失败。'); return true }); provider.close()
})
