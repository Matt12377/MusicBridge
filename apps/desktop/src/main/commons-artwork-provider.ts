import { createHash } from 'node:crypto'
import { Resolver } from 'node:dns/promises'
import https from 'node:https'
import { isIP, type LookupFunction } from 'node:net'

const API_HOST = 'commons.wikimedia.org'
const IMAGE_HOST = 'upload.wikimedia.org'
const LICENSE_URL = 'https://creativecommons.org/publicdomain/zero/1.0/' as const
const POLICY_VERSION = '2026-10-07-cc0-only-v1' as const
const USER_AGENT = 'MusicBridge/0.1.0 (https://github.com/Matt12377/MusicBridge; artwork-contact via repository issues)'
const METADATA_LIMIT = 512 * 1024
const IMAGE_LIMIT = 4 * 1024 * 1024
const SEARCH_DEADLINE_MS = 15_000
const MAX_ROWS = 8
const MAX_IMAGES = 2

export interface CommonsArtworkSource {
  pageId: number
  pageRevision: number
  fileSha1: string
  fileTimestamp: string
  title: string
  author: string | null
  descriptionUrl: string
  licenseUrl: typeof LICENSE_URL
  policyVersion: typeof POLICY_VERSION
}

export interface CommonsArtworkProvider {
  search(query: string, signal: AbortSignal): Promise<Array<{ bytes: Uint8Array; source: CommonsArtworkSource }>>
  close(): void
}

export interface CommonsTransportResponse {
  statusCode: number
  headers: Readonly<Record<string, string | string[] | undefined>>
  body: AsyncIterable<Uint8Array>
  destroy(): void
  /** 请求和响应实际关闭的证据；取消调用本身不代表物理释放。 */
  closed: Promise<void>
}

export interface CommonsArtworkProviderOptions {
  /** 只供 Main 的受控测试注入；Renderer 不可提供 transport 或 lookup。 */
  transport?: (url: URL, signal: AbortSignal) => Promise<CommonsTransportResponse>
  lookup?: (hostname: string, signal: AbortSignal) => Promise<Array<{ address: string; family: 4 | 6 }>>
  now?: () => number
}

export type ArtworkDnsLookup = NonNullable<CommonsArtworkProviderOptions['lookup']>
export type PinnedArtworkTransport = NonNullable<CommonsArtworkProviderOptions['transport']>

class ProviderError extends Error {
  constructor(message: string) { super(message); this.name = 'CommonsArtworkProviderError' }
}
function fail(message: string): never { throw new ProviderError(message) }
const canceled = (): ProviderError => new ProviderError('封面查询已取消或超时。')
function checkSignal(signal: AbortSignal): void { if (signal.aborted) throw canceled() }
function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(canceled())
  return new Promise((resolve, reject) => {
    const abort = () => reject(canceled())
    signal.addEventListener('abort', abort, { once: true })
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort)).catch(() => {})
  })
}

// 所有工厂实例共享物理请求队列和速率；队列有界，关闭未确认时不释放槽位。
let physicalTail: Promise<void> = Promise.resolve()
let physicalPending = 0
let requestTimes: number[] = []
let cooldownUntil = 0
async function serial<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
  if (physicalPending >= 8) fail('封面查询队列已满，请稍后再试。')
  const previous = physicalTail
  let release!: () => void
  physicalTail = new Promise<void>(resolve => { release = resolve })
  physicalPending++
  try { await previous; checkSignal(signal); return await work() }
  finally { physicalPending--; release() }
}
function takeRateSlot(now: number): void {
  if (!Number.isFinite(now) || now < cooldownUntil) fail('封面来源暂时要求降低请求频率，请稍后再试。')
  requestTimes = requestTimes.filter(time => time > now - 60_000)
  if (requestTimes.length >= 30) fail('封面查询已达到每分钟 30 次的本机上限。')
  requestTimes.push(now)
}
function header(response: CommonsTransportResponse, key: string): string | undefined {
  const value = response.headers[key]
  if (Array.isArray(value)) fail('封面来源响应头不明确。')
  return value
}
function coolDown(response: CommonsTransportResponse, now: number): void {
  const value = header(response, 'retry-after')
  const seconds = value && /^\d+$/u.test(value) ? Number(value) : NaN
  if (value && /^\d+$/u.test(value) && !Number.isSafeInteger(seconds)) { cooldownUntil = Infinity; return }
  const date = value && !Number.isFinite(seconds) ? Date.parse(value) : NaN
  const delay = Number.isFinite(seconds) ? seconds * 1000 : Number.isFinite(date) ? date - now : 5000
  // 长 Retry-After 仍保持禁用；不截短上游要求、不自动重试。
  cooldownUntil = Math.max(cooldownUntil, now + Math.max(5000, delay))
}

function checkedUrl(value: string, kind: 'api' | 'image' | 'description'): URL {
  if (typeof value !== 'string' || value.length > 2048 || /[\u0000-\u0020\u007f\\]/u.test(value)) fail('封面来源地址不符合安全规则。')
  const expectedHost = kind === 'image' ? IMAGE_HOST : API_HOST
  // URL 会吞掉显式 :443，所以先校验原始 authority。
  if (!value.startsWith(`https://${expectedHost}/`)) fail('封面来源地址不符合安全规则。')
  let url: URL
  try { url = new URL(value) } catch { return fail('封面来源地址不符合安全规则。') }
  if (url.protocol !== 'https:' || url.hostname !== expectedHost || url.username || url.password || url.port || url.hash) fail('封面来源地址不符合安全规则。')
  if (/%(?:00|0a|0d|2f|5c)/iu.test(url.pathname)) fail('封面来源路径不符合安全规则。')
  if (kind === 'api' && url.pathname !== '/w/api.php') fail('封面查询接口不符合安全规则。')
  if (kind === 'image' && (!url.pathname.startsWith('/wikipedia/commons/') || url.search || url.pathname.includes('//'))) fail('封面图片路径不符合安全规则。')
  if (kind === 'description' && (!url.pathname.startsWith('/wiki/File:') || url.search)) fail('封面来源页不符合安全规则。')
  return url
}

function publicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b, c] = address.split('.').map(Number)
    if (a === 0 || a === 10 || a === 127 || a! >= 224 || a === 169 && b === 254 || a === 172 && b! >= 16 && b! <= 31 || a === 100 && b! >= 64 && b! <= 127) return false
    if (a === 192 && (b === 0 || b === 168 || b === 88 && c === 99 || b === 31 && c === 196 || b === 52 && c === 193 || b === 175 && c === 48)) return false
    if (a === 198 && (b === 18 || b === 19 || b === 51 && c === 100) || a === 203 && b === 0 && c === 113) return false
    return true
  }
  if (isIP(address) !== 6 || address.includes('%') || address.includes('.')) return false
  const sides = address.toLowerCase().split('::')
  const left = sides[0] ? sides[0].split(':') : []
  const right = sides[1] ? sides[1].split(':') : []
  const words = (sides.length === 2 ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right] : left).map(word => parseInt(word, 16))
  const first = words[0]!, second = words[1]!
  // 仅保守接受全球单播，排除 Teredo/特殊2001空间、文档、6to4和旧6bone。
  return (first & 0xe000) === 0x2000 && !(first === 0x2001 && (second < 0x200 || second === 0xdb8)) && first !== 0x2002 && first !== 0x3ffe && (first !== 0x3fff || second >= 0x1000)
}

async function lookupPublic(hostname: string, signal: AbortSignal): Promise<Array<{ address: string; family: 4 | 6 }>> {
  const resolver = new Resolver()
  const cancel = () => resolver.cancel()
  signal.addEventListener('abort', cancel, { once: true })
  const timer = setTimeout(cancel, 3000)
  try {
    checkSignal(signal)
    const answers = await Promise.allSettled([resolver.resolve4(hostname), resolver.resolve6(hostname)])
    const addresses: Array<{ address: string; family: 4 | 6 }> = []
    for (let index = 0; index < answers.length; index++) {
      const answer = answers[index]!
      if (answer.status === 'fulfilled') addresses.push(...answer.value.map(address => ({ address, family: (index === 0 ? 4 : 6) as 4 | 6 })))
      else if (!['ENODATA', 'ENOTFOUND'].includes(String((answer.reason as { code?: string })?.code))) fail('封面来源地址解析失败。')
    }
    checkSignal(signal)
    return addresses
  } finally { clearTimeout(timer); signal.removeEventListener('abort', cancel) }
}

function nativeTransport(lookup: ArtworkDnsLookup): PinnedArtworkTransport {
  return async (url, signal) => {
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash) fail('封面连接地址不符合安全规则。')
    const addresses = await lookup(url.hostname, signal)
    checkSignal(signal)
    if (!addresses.length || addresses.length > 32 || addresses.some(item => isIP(item.address) !== item.family || !publicAddress(item.address))) fail('封面来源地址不是允许的公网地址。')
    const selected = addresses[0]!
    // 只按Main已支持的固定路由挑Accept；此处不替代各provider的host/path准入。
    const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
    const json = url.hostname === API_HOST && url.pathname === '/w/api.php'
      || url.hostname === 'musicbrainz.org' && url.pathname.startsWith('/ws/2/')
      || url.hostname === 'coverartarchive.org' && new RegExp(`^/release/${uuid}/?$`, 'u').test(url.pathname)
      || (url.hostname === 'archive.org' || /^ia\d+\.(?:us\.)?archive\.org$/u.test(url.hostname)) && new RegExp(`^/download/mbid-${uuid}/index\\.json$`, 'u').test(url.pathname)
    const pinnedLookup: LookupFunction = (_hostname, _options, callback) => {
      if (_hostname !== url.hostname) { callback(new ProviderError('封面连接主机不一致。'), '', selected.family); return }
      callback(null, selected.address, selected.family)
    }
    return new Promise<CommonsTransportResponse>((resolve, reject) => {
      let response: import('node:http').IncomingMessage | undefined
      let delivered = false
      let releaseRequest!: () => void
      const requestClosed = new Promise<void>(done => { releaseRequest = done })
      // Node运行时支持此TCP选项；当前https类型未继承该可选字段。
      const requestOptions: https.RequestOptions & { autoSelectFamily: false } = {
        method: 'GET', agent: false, lookup: pinnedLookup, family: selected.family, autoSelectFamily: false,
        servername: url.hostname, rejectUnauthorized: true, maxHeaderSize: 8192,
        headers: { 'User-Agent': USER_AGENT, Accept: json ? 'application/json' : 'image/png,image/jpeg', 'Accept-Encoding': 'identity' },
      }
      const request = https.request(url, requestOptions)
      const abort = () => { response?.destroy(); request.destroy(canceled()) }
      request.once('close', () => { releaseRequest(); if (!delivered) { signal.removeEventListener('abort', abort); reject(new ProviderError('封面来源连接失败。')) } })
      request.once('error', () => { if (!delivered) requestClosed.then(() => reject(new ProviderError('封面来源连接失败。'))).catch(reject) })
      request.once('socket', socket => {
        socket.once('secureConnect', () => {
          if (!socket.remoteAddress || socket.remoteAddress !== selected.address || !publicAddress(socket.remoteAddress)) request.destroy(new ProviderError('封面连接地址校验失败。'))
        })
      })
      request.once('response', incoming => {
        response = incoming
        // 在开始消费流前就安装关闭证据，防止同步destroy遗漏close。
        const responseClosed = new Promise<void>(done => incoming.once('close', done))
        delivered = true
        resolve({
          statusCode: incoming.statusCode ?? 0, headers: incoming.headers, body: incoming,
          destroy: () => { incoming.destroy(); request.destroy() },
          closed: Promise.all([requestClosed, responseClosed]).then(() => { signal.removeEventListener('abort', abort) }),
        })
        if (signal.aborted) abort()
      })
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
      else request.end()
    })
  }
}

function leasedTransport(transport: PinnedArtworkTransport): PinnedArtworkTransport {
  return (url, signal) => new Promise((resolve, reject) => {
    const work = serial(signal, async () => {
      const response = await transport(url, signal)
      resolve(response)
      // 先交给调用者消费流，物理租约仍等实际close；所有Main provider共享此槽。
      await response.closed
    })
    work.catch(reject)
  })
}

/** 只供Main模块复用；先按静态provider规则逐跳验证host/path，再消费流并destroy/await closed。 */
export function createPinnedArtworkTransport(lookup: ArtworkDnsLookup = lookupPublic): PinnedArtworkTransport {
  return leasedTransport(nativeTransport(lookup))
}

function object(value: unknown): Record<string, unknown> | null { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null }
function string(value: unknown, maximum = 2048): string | null { return typeof value === 'string' && Buffer.byteLength(value, 'utf8') <= maximum && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value) ? value : null }
function positiveInteger(value: unknown, maximum = Number.MAX_SAFE_INTEGER): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= maximum }
function plainText(value: string): string {
  const removeHtml = (text: string) => text.replace(/<!--[\s\S]*?-->/gu, ' ').replace(/<(script|style|iframe|object)\b[^>]*>[\s\S]*?<\/\1\s*>/giu, ' ').replace(/<[^>]*>/gu, ' ')
  const decoded = removeHtml(value).replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/giu, (_, entity: string) => {
    const known: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }
    if (!entity.startsWith('#')) return known[entity.toLowerCase()] ?? ''
    const point = parseInt(entity.slice(entity[1]?.toLowerCase() === 'x' ? 2 : 1), entity[1]?.toLowerCase() === 'x' ? 16 : 10)
    return point >= 32 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff) ? String.fromCodePoint(point) : ' '
  })
  return removeHtml(decoded).replace(/[<>]/gu, '').replace(/\s+/gu, ' ').trim()
}
function metadataValue(metadata: Record<string, unknown>, key: string): string | null { return string(object(metadata[key])?.value, 4096) }
function falseValue(value: string | null): boolean { return value !== null && /^(?:false|0)$/iu.test(value.trim()) }
function cc0(metadata: Record<string, unknown>): boolean {
  const shortName = metadataValue(metadata, 'LicenseShortName')?.trim()
  const terms = metadataValue(metadata, 'UsageTerms')?.trim()
  const licenseUrl = metadataValue(metadata, 'LicenseUrl')?.trim()
  if (!shortName || !/^(?:CC0|CC0 1\.0|CC0 1\.0 Universal)$/u.test(shortName)) return false
  if (!terms || !['Creative Commons Zero, Public Domain Dedication', 'CC0 1.0 Universal', 'Creative Commons CC0 1.0 Universal', 'CC0 1.0 Universal Public Domain Dedication'].includes(terms)) return false
  if (!licenseUrl || !/^(?:https|http):\/\/creativecommons\.org\/publicdomain\/zero\/1\.0\/(?:deed\.en)?$/u.test(licenseUrl)) return false
  if (!falseValue(metadataValue(metadata, 'Copyrighted')) || !falseValue(metadataValue(metadata, 'AttributionRequired'))) return false
  if ('NonFree' in metadata && !falseValue(metadataValue(metadata, 'NonFree'))) return false
  for (const key of ['Restrictions', 'DeletionReason']) {
    if (!(key in metadata)) continue
    const value = object(metadata[key])?.value
    if (value !== '' && !(Array.isArray(value) && value.length === 0)) return false
  }
  // 不尝试从模糊的多许可输出中选择一个；猜测License也不能推翻三字段准入。
  const guessed = metadataValue(metadata, 'License')
  if ('License' in metadata && guessed === null) return false
  if (guessed !== null && !/^cc0(?:-1\.0)?$/iu.test(guessed.trim())) return false
  return true
}

interface Candidate { url: URL; mime: 'image/png' | 'image/jpeg'; size: number; width: number; height: number; source: CommonsArtworkSource }
function candidate(value: unknown): Candidate | null {
  const page = object(value)
  if (!page || page.ns !== 6 || page.imagerepository !== 'local' || !positiveInteger(page.pageid) || !positiveInteger(page.lastrevid) || page.missing !== undefined || page.invalid !== undefined) return null
  const title = string(page.title, 2048)
  if (!title?.startsWith('File:') || title.length <= 5 || title.length > 512 || /[\u0000-\u001f<>]/u.test(title)) return null
  if (!Array.isArray(page.imageinfo) || page.imageinfo.length !== 1) return null
  const info = object(page.imageinfo[0]), metadata = object(info?.extmetadata)
  if (!info || !metadata || !cc0(metadata) || !['image/png', 'image/jpeg'].includes(String(info.mime))) return null
  if (!positiveInteger(info.size, IMAGE_LIMIT) || !positiveInteger(info.width, 4096) || !positiveInteger(info.height, 4096) || info.width * info.height > 16 * 1024 * 1024) return null
  const sha1 = string(info.sha1, 40), timestamp = string(info.timestamp, 40), urlValue = string(info.url), descriptionValue = string(info.descriptionurl)
  if (!sha1 || !/^[0-9a-f]{40}$/u.test(sha1) || !timestamp || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(timestamp) || !Number.isFinite(Date.parse(timestamp))) return null
  if (new Date(timestamp).toISOString().replace('.000Z', 'Z') !== timestamp.replace('.000Z', 'Z')) return null
  if (!urlValue || !descriptionValue) return null
  let url: URL, description: URL
  try {
    url = checkedUrl(urlValue, 'image'); description = checkedUrl(descriptionValue, 'description')
    if (decodeURIComponent(description.pathname).replace(/ /gu, '_') !== `/wiki/${title.replace(/ /gu, '_')}`) return null
    if (decodeURIComponent(url.pathname.split('/').at(-1) ?? '') !== title.slice(5).replace(/ /gu, '_')) return null
  } catch { return null }
  const artist = metadataValue(metadata, 'Artist')
  if ('Artist' in metadata && artist === null) return null
  const author = artist === null ? null : plainText(artist) || null
  if (author !== null && author.length > 512) return null
  return {
    url, mime: info.mime as Candidate['mime'], size: info.size, width: info.width, height: info.height,
    source: { pageId: page.pageid, pageRevision: page.lastrevid, fileSha1: sha1, fileTimestamp: timestamp, title, author, descriptionUrl: description.href, licenseUrl: LICENSE_URL, policyVersion: POLICY_VERSION },
  }
}

// 只核对压缩头与API声明一致；完整chunk/marker和native解码仍由Main helper完成。
function dimensionsMatch(bytes: Buffer, item: Candidate): boolean {
  if (item.mime === 'image/png') return bytes.length >= 33 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && bytes.readUInt32BE(8) === 13 && bytes.toString('ascii', 12, 16) === 'IHDR' && bytes.readUInt32BE(16) === item.width && bytes.readUInt32BE(20) === item.height
  if (bytes.length < 4 || bytes[0] !== 255 || bytes[1] !== 216) return false
  let position = 2
  for (let count = 0; count < 1024 && position + 4 <= bytes.length; count++) {
    if (bytes[position++] !== 255) return false
    while (bytes[position] === 255) position++
    const marker = bytes[position++]
    if (marker === 218 || marker === 217 || marker === undefined || position + 2 > bytes.length) return false
    const length = bytes.readUInt16BE(position)
    if (length < 2 || position + length > bytes.length) return false
    if ([192, 193, 194].includes(marker)) return length >= 8 && bytes[position + 2] === 8 && bytes.readUInt16BE(position + 3) === item.height && bytes.readUInt16BE(position + 5) === item.width
    position += length
  }
  return false
}

function searchUrl(query: string): URL {
  if (typeof query !== 'string' || !query.trim() || [...query].length > 120 || Buffer.byteLength(query, 'utf8') > 512 || /[\u0000-\u001f\u007f]/u.test(query) || /(?:[a-z][a-z0-9+.-]*:\/\/|(?:https?|data|file|javascript):|www\.)/iu.test(query) || /^\s*(?:\/|~\/|[a-z]:\\)/iu.test(query)) fail('请输入不含网址的有效封面关键词（最多 120 字）。')
  const url = new URL(`https://${API_HOST}/w/api.php`)
  const values = { action: 'query', generator: 'search', gsrnamespace: '6', gsrlimit: '8', gsrsearch: `"${query.trim().replace(/["\\]/gu, ' ')}"`, prop: 'info|imageinfo', inprop: 'url', iilimit: '1', iilocalonly: '1', iiprop: 'url|mime|size|sha1|timestamp|extmetadata', iiextmetadatalanguage: 'en', iiextmetadatafilter: 'LicenseShortName|LicenseUrl|UsageTerms|Copyrighted|AttributionRequired|NonFree|Restrictions|DeletionReason|Artist|Credit|License', format: 'json', formatversion: '2' }
  for (const [key, value] of Object.entries(values)) url.searchParams.set(key, value)
  return url
}

export function createCommonsArtworkProvider(options: CommonsArtworkProviderOptions = {}): CommonsArtworkProvider {
  const now = options.now ?? Date.now
  const underlyingTransport = options.transport ?? nativeTransport(options.lookup ?? lookupPublic)
  const transport = leasedTransport(async (url, signal) => {
    // 排队时间不能提前占用速率窗口；实际获得物理槽后再记本次请求。
    takeRateSlot(now())
    return underlyingTransport(url, signal)
  })
  const controllers = new Set<AbortController>()
  let closed = false
  async function get(url: URL, kind: 'api' | 'image', maximum: number, signal: AbortSignal): Promise<{ bytes: Buffer; contentType: string }> {
    let current = checkedUrl(url.href, kind)
    for (let redirects = 0; redirects <= 1; redirects++) {
      const result = await (async () => {
        checkSignal(signal)
        const response = await transport(current, signal)
        const abort = () => response.destroy()
        signal.addEventListener('abort', abort, { once: true })
        try {
          checkSignal(signal)
          if ([429, 503].includes(response.statusCode)) { coolDown(response, now()); fail('封面来源暂时繁忙，请稍后再试。') }
          if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
            const location = header(response, 'location')
            if (!location || redirects === 1 || /[\u0000-\u0020\u007f\\]/u.test(location)) fail('封面来源重定向不符合安全规则。')
            const target = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/iu.test(location) ? location.startsWith('//') ? `https:${location}` : location : new URL(location, current).href
            return { redirect: checkedUrl(target, kind) }
          }
          if (response.statusCode !== 200) fail('封面来源暂时无法提供结果。')
          if (header(response, 'content-encoding') && header(response, 'content-encoding') !== 'identity') fail('封面来源响应编码不受支持。')
          const contentType = (header(response, 'content-type') ?? '').split(';')[0]!.trim().toLowerCase()
          if (kind === 'api' ? contentType !== 'application/json' : !['image/png', 'image/jpeg'].includes(contentType)) fail('封面来源响应类型不受支持。')
          const length = header(response, 'content-length')
          if (length !== undefined && (!/^\d+$/u.test(length) || !Number.isSafeInteger(Number(length)) || Number(length) > maximum)) fail('封面来源响应超过字节预算。')
          const pieces: Buffer[] = []
          let size = 0
          for await (const chunk of response.body) {
            checkSignal(signal)
            if (!(chunk instanceof Uint8Array) || !Number.isSafeInteger(size + chunk.byteLength) || size + chunk.byteLength > maximum) fail('封面来源响应超过字节预算。')
            size += chunk.byteLength; pieces.push(Buffer.from(chunk))
          }
          checkSignal(signal)
          if (length !== undefined && Number(length) !== size) fail('封面来源响应长度不一致。')
          return { bytes: Buffer.concat(pieces, size), contentType }
        } finally {
          signal.removeEventListener('abort', abort)
          response.destroy()
          await response.closed
        }
      })()
      checkSignal(signal)
      if ('redirect' in result && result.redirect) { current = result.redirect; continue }
      if ('bytes' in result && result.bytes && result.contentType) return { bytes: result.bytes, contentType: result.contentType }
    }
    return fail('封面来源重定向超过预算。')
  }
  return {
    async search(query, signal) {
      if (closed) fail('封面来源已关闭。')
      checkSignal(signal)
      const url = searchUrl(query)
      if (controllers.size >= 2) fail('封面查询仍在结束，请稍后再试。')
      const controller = new AbortController()
      controllers.add(controller)
      const abort = () => controller.abort()
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
      const timer = setTimeout(abort, SEARCH_DEADLINE_MS)
      const work = (async () => {
        const metadata = await get(url, 'api', METADATA_LIMIT, controller.signal)
        let parsed: unknown
        try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(metadata.bytes)) } catch { return fail('封面来源元数据不是有效 JSON。') }
        const root = object(parsed)
        if (!root || root.error) fail('封面来源元数据无法使用。')
        const queryValue = object(root.query)
        if (!queryValue && root.batchcomplete !== undefined) return []
        if (!queryValue || !Array.isArray(queryValue.pages) || queryValue.pages.length > MAX_ROWS) fail('封面来源候选超过预算或结构无效。')
        const items = queryValue.pages.map(candidate).filter((item): item is Candidate => item !== null)
        const results: Array<{ bytes: Uint8Array; source: CommonsArtworkSource }> = []
        const used = new Set<number>()
        let totalBytes = 0
        for (const item of items) {
          if (used.has(item.source.pageId)) continue
          used.add(item.source.pageId)
          const image = await get(item.url, 'image', IMAGE_LIMIT, controller.signal)
          checkSignal(controller.signal)
          totalBytes += image.bytes.length
          if (totalBytes > IMAGE_LIMIT * MAX_IMAGES || image.contentType !== item.mime || image.bytes.length !== item.size || !dimensionsMatch(image.bytes, item) || createHash('sha1').update(image.bytes).digest('hex') !== item.source.fileSha1) fail('封面文件与来源元数据不一致。')
          results.push({ bytes: image.bytes, source: item.source })
          if (results.length === MAX_IMAGES) break
        }
        return results
      })().catch(error => { if (error instanceof ProviderError) throw error; throw new ProviderError('封面查询失败。') })
      // 逻辑超时及时返回，物理队列仍等待实际close；迟到数据永不返回给调用者。
      work.finally(() => controllers.delete(controller)).catch(() => {})
      try { return await abortable(work, controller.signal) }
      finally { clearTimeout(timer); signal.removeEventListener('abort', abort) }
    },
    close() { closed = true; for (const controller of controllers) controller.abort() },
  }
}
