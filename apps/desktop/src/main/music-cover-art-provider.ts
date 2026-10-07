import type { CoverArtArchiveSource } from '@music-bridge/contracts'
import { createPinnedArtworkTransport, type CommonsTransportResponse, type PinnedArtworkTransport } from './commons-artwork-provider.js'

const METADATA_LIMIT = 512 * 1024
const IMAGE_LIMIT = 4 * 1024 * 1024
const SEARCH_DEADLINE_MS = 30_000
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const POLICY_VERSION = '2026-10-07-caa-personal-v1' as const

export interface MusicCoverArtProvider {
  search(query: string, signal: AbortSignal): Promise<Array<{ bytes: Uint8Array; source: CoverArtArchiveSource }>>
  close(): void
}
export interface MusicCoverArtProviderOptions {
  /** 仅可信 Main 测试可注入，Renderer 不接受 transport、时钟或 URL。 */
  transport?: PinnedArtworkTransport
  now?: () => number
}
class ProviderError extends Error {
  constructor(message: string) { super(message); this.name = 'MusicCoverArtProviderError' }
}
function fail(message: string): never { throw new ProviderError(message) }
const canceled = (): ProviderError => new ProviderError('音乐封面查询已取消或超时。')
function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(canceled())
  return new Promise((resolve, reject) => {
    const abort = () => reject(canceled())
    signal.addEventListener('abort', abort, { once: true })
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort)).catch(() => {})
  })
}

// 全部音乐Provider实例共用有界串行搜索；取消后的收尾也保留名额，直到实际响应关闭。
// 默认transport另外复用Commons底层单连接租约，这里不重复申请那个租约。
let searchTail: Promise<void> = Promise.resolve()
let retainedSearches = 0
interface RateReservation { time: number }
let requestTimes: RateReservation[] = []
let musicBrainzLastRequest = -Infinity
let cooldownUntil = 0
async function serialSearch<T>(check: () => void, work: () => Promise<T>): Promise<T> {
  if (retainedSearches >= 4) fail('音乐封面查询仍在收尾，队列已满。')
  const previous = searchTail
  let release!: () => void
  searchTail = new Promise<void>(done => { release = done })
  retainedSearches++
  try { await previous; check(); return await work() }
  finally { retainedSearches--; release() }
}
function takeRateSlot(now: number, musicBrainz: boolean): RateReservation {
  if (!Number.isFinite(now) || now < cooldownUntil || requestTimes.some(slot => slot.time > now)) fail('音乐封面来源要求降低请求频率，请稍后再试。')
  requestTimes = requestTimes.filter(slot => slot.time > now - 60_000)
  if (requestTimes.length >= 30) fail('音乐封面查询已达到每分钟 30 次的本机上限。')
  if (musicBrainz && now - musicBrainzLastRequest < 1000) fail('MusicBrainz 查询须间隔至少一秒，请稍后再试。')
  const slot = { time: now }
  requestTimes.push(slot)
  if (musicBrainz) musicBrainzLastRequest = now
  return slot
}
function settleRateSlot(slot: RateReservation, musicBrainz: boolean, completed: number): void {
  // 底层共享租约可能先等其他Provider关闭；交回响应/失败时推进预约，保守限制下一次真实发出。
  if (!Number.isFinite(completed)) return
  slot.time = Math.max(slot.time, completed)
  if (musicBrainz) musicBrainzLastRequest = Math.max(musicBrainzLastRequest, completed)
}
function header(response: CommonsTransportResponse, name: string): string | undefined {
  const value = response.headers[name]
  if (value !== undefined && (typeof value !== 'string' || value.length > 4096 || /[\u0000-\u001f\u007f]/u.test(value))) fail('音乐封面响应头不明确。')
  return value
}
function coolDown(response: CommonsTransportResponse, now: number): void {
  const value = header(response, 'retry-after')
  const seconds = value && /^\d+$/u.test(value) ? Number(value) : NaN
  const date = value && !Number.isFinite(seconds) ? Date.parse(value) : NaN
  const delay = Number.isSafeInteger(seconds * 1000) ? seconds * 1000 : Number.isFinite(date) ? date - now : 5000
  // 上游要求的长等待不会截短；本地不自动重试。
  cooldownUntil = Math.max(cooldownUntil, now + Math.max(5000, delay))
}

type Route = { kind: 'search'; query: string } | { kind: 'metadata'; releaseId: string } | { kind: 'image'; releaseId: string; imageId: string; extension: 'png' | 'jpg' }
function checkedRoute(value: string, route: Route): URL {
  if (typeof value !== 'string' || value.length > 2048 || /[\u0000-\u0020\u007f\\]/u.test(value)) fail('音乐封面地址不符合安全规则。')
  const raw = /^https:\/\/([^/?#]+)(\/[^#]*)$/u.exec(value)
  if (!raw || !/^(?:musicbrainz\.org|coverartarchive\.org|archive\.org|ia\d{6}\.(?:us|eu)\.archive\.org)$/u.test(raw[1]!)) fail('音乐封面主机或协议不符合安全规则。')
  const path = raw[2]!.split('?')[0]!
  if (path.includes('%') || path.includes('//') || /(?:^|\/)\.{1,2}(?:\/|$)/u.test(path)) fail('音乐封面路径不符合安全规则。')
  let url: URL
  try { url = new URL(value) } catch { return fail('音乐封面地址无法解析。') }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash) fail('音乐封面地址不符合安全规则。')
  if (route.kind === 'search') {
    if (url.hostname !== 'musicbrainz.org' || !/^\/ws\/2\/release\/?$/u.test(url.pathname) || [...url.searchParams].length !== 3
      || url.searchParams.get('fmt') !== 'json' || url.searchParams.get('limit') !== '5' || url.searchParams.get('query') !== route.query) fail('MusicBrainz 查询路由不符合安全规则。')
    return url
  }
  if (url.search) fail('音乐封面地址不能携带额外参数。')
  const directory = `mbid-${route.releaseId}`
  const filename = route.kind === 'metadata' ? 'index.json' : `${directory}-${route.imageId}.${route.extension}`
  if (url.hostname === 'coverartarchive.org') {
    const expected = `/release/${route.releaseId}`
    const match = route.kind === 'metadata' ? url.pathname === expected || url.pathname === `${expected}/`
      : url.pathname === `${expected}/${route.imageId}.${route.extension}` || url.pathname === `${expected}/${route.imageId}`
    if (!match) fail('CAA 路由与发行或图片身份不一致。')
  } else if (url.hostname === 'archive.org') {
    if (url.pathname !== `/download/${directory}/${filename}`) fail('封面归档路径与发行或图片身份不一致。')
  } else if (/^ia\d{6}\.(?:us|eu)\.archive\.org$/u.test(url.hostname)) {
    const parts = url.pathname.split('/')
    if (parts.length !== 5 || !/^\d{1,6}$/u.test(parts[1]!) || parts[2] !== 'items' || parts[3] !== directory || parts[4] !== filename) fail('封面归档节点路径与发行或图片身份不一致。')
  } else fail('音乐封面路由不能切换来源。')
  return url
}
function redirectUrl(value: string, current: URL, route: Route): URL {
  if (!value || value.length > 2048 || /[\u0000-\u0020\u007f\\]/u.test(value) || value.startsWith('//') || /(?:^|\/)\.{1,2}(?:\/|$)/u.test(value)) fail('音乐封面重定向不符合安全规则。')
  let target: string
  try { target = /^[a-z][a-z0-9+.-]*:/iu.test(value) ? value : new URL(value, current).href } catch { return fail('音乐封面重定向无法解析。') }
  return checkedRoute(target, route)
}
function searchRoute(query: string): { url: URL; route: Route } {
  if (typeof query !== 'string' || query !== query.trim() || query.length < 1 || query.length > 80 || /[\u0000-\u001f\u007f]/u.test(query)
    || /(?:[a-z][a-z0-9+.-]*:\/\/|(?:https?|data|file|javascript):|www\.)/iu.test(query) || /^(?:\/|~\/|[a-z]:\\)/iu.test(query)) fail('请输入不含网址的有效专辑或歌手关键词（最多 80 字）。')
  // 引号和反斜杠转义为Lucene字面值，关键词不变成任意查询指令。
  const literal = query.replace(/["\\]/gu, '\\$&')
  const expression = `(release:"${literal}" OR artist:"${literal}")`
  const url = new URL('https://musicbrainz.org/ws/2/release')
  url.searchParams.set('fmt', 'json'); url.searchParams.set('limit', '5'); url.searchParams.set('query', expression)
  return { url, route: { kind: 'search', query: expression } }
}

function object(value: unknown): Record<string, unknown> | null { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null }
function text(value: unknown, allowEmpty = false): value is string {
  return typeof value === 'string' && value.length <= 512 && (allowEmpty || value.trim().length > 0) && !/[\u0000-\u001f\u007f]/u.test(value)
    && !/[a-z][a-z0-9+.-]*:\/\/|(?:bearer|cookie|token|session[_-]?(?:id|handle))\s*[:=]/iu.test(value)
}
function parsedJson(bytes: Uint8Array): Record<string, unknown> {
  try {
    const value = object(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)))
    if (value && !value.error) return value
  } catch { /* 下方只返回固定错误，不带上游文本或堆栈。 */ }
  return fail('音乐封面元数据不是有效 JSON 对象。')
}
interface Release { id: string; title: string; artist: string; date: string | null; country: string | null }
function releaseList(bytes: Uint8Array): Release[] {
  const rows = parsedJson(bytes).releases
  if (!Array.isArray(rows) || rows.length > 5) fail('MusicBrainz 发行结果超过预算或结构无效。')
  const seen = new Set<string>()
  return rows.map(value => {
    const row = object(value)
    if (!row || typeof row.id !== 'string' || !UUID.test(row.id) || !text(row.title) || seen.has(row.id)) fail('MusicBrainz 发行身份或标题无效。')
    seen.add(row.id)
    const credit = row['artist-credit']
    let artist = ''
    if (credit !== undefined) {
      if (!Array.isArray(credit) || credit.length > 32) fail('MusicBrainz 歌手字段超过预算或结构无效。')
      for (const value of credit) {
        const part = object(value), name = part?.name ?? object(part?.artist)?.name, join = part?.joinphrase ?? ''
        if (!part || !text(name) || !text(join, true)) fail('MusicBrainz 歌手字段无效。')
        artist += name + join
        if (!text(artist, true)) fail('MusicBrainz 歌手字段超过预算。')
      }
    }
    const date = row.date === undefined || row.date === null ? null : row.date
    const country = row.country === undefined || row.country === null ? null : row.country
    if (date !== null && (typeof date !== 'string' || !/^\d{4}(?:-(?:0[1-9]|1[0-2])(?:-(?:0[1-9]|[12]\d|3[01]))?)?$/u.test(date))) fail('MusicBrainz 发行日期无效。')
    if (country !== null && (typeof country !== 'string' || !/^[A-Z]{2}$/u.test(country))) fail('MusicBrainz 发行国家字段无效。')
    return { id: row.id, title: row.title, artist, date, country }
  })
}
interface Image { route: Extract<Route, { kind: 'image' }>; source: CoverArtArchiveSource }
function imageList(bytes: Uint8Array, release: Release): Image[] {
  const metadata = parsedJson(bytes)
  const releaseUrl = `https://musicbrainz.org/release/${release.id}`
  if (metadata.release !== releaseUrl && metadata.release !== releaseUrl.replace('https:', 'http:')) fail('CAA 元数据与查询发行身份不一致。')
  if (!Array.isArray(metadata.images) || metadata.images.length > 32) fail('CAA 图片候选超过预算或结构无效。')
  const seen = new Set<string>()
  const images = metadata.images.map<Image>(value => {
    const row = object(value)
    const imageId = typeof row?.id === 'number' && Number.isSafeInteger(row.id) && row.id >= 0 ? String(row.id) : row?.id
    if (!row || typeof imageId !== 'string' || !/^\d{1,20}$/u.test(imageId) || seen.has(imageId) || typeof row.front !== 'boolean' || typeof row.approved !== 'boolean' || typeof row.image !== 'string') fail('CAA 图片身份或审核字段无效。')
    seen.add(imageId)
    const extension = /\.(png|jpg)$/u.exec(row.image)?.[1] as 'png' | 'jpg' | undefined
    if (!extension) fail('CAA 原图格式或地址不受支持。')
    const route: Image['route'] = { kind: 'image', releaseId: release.id, imageId, extension }
    // legacy HTTP只是来源身份字段；真实抓图始终重新构造CAA HTTPS入口。
    checkedRoute(row.image.replace(/^http:\/\//u, 'https://'), route)
    return { route, source: {
      releaseId: release.id, imageId, releaseTitle: release.title, artist: release.artist, releaseDate: release.date, country: release.country,
      releaseUrl, front: row.front, approved: row.approved, musicBrainzMetadataLicense: 'CC0-core', imageRights: 'unverified', imageVariant: 'original', policyVersion: POLICY_VERSION,
    } }
  })
  return images.sort((a, b) => Number(b.source.front) - Number(a.source.front) || Number(b.source.approved) - Number(a.source.approved))
}
function imageSignature(bytes: Uint8Array, extension: 'png' | 'jpg'): boolean {
  // 仅核对声明格式与压缩签名；完整结构、帧数、尺寸和native解码属于Main图像边界。
  return extension === 'png' ? bytes.length >= 8 && Buffer.from(bytes.subarray(0, 8)).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    : bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
}

export function createMusicCoverArtProvider(options: MusicCoverArtProviderOptions = {}): MusicCoverArtProvider {
  const transport = options.transport ?? createPinnedArtworkTransport()
  const now = options.now ?? Date.now
  const controllers = new Set<AbortController>()
  let closed = false
  return {
    async search(query, signal) {
      if (closed) fail('音乐封面来源已关闭。')
      if (signal.aborted) throw canceled()
      const search = searchRoute(query), started = now()
      if (!Number.isFinite(started)) fail('音乐封面查询时钟无效。')
      const controller = new AbortController()
      const abort = () => controller.abort()
      const check = () => {
        if (controller.signal.aborted) throw canceled()
        const current = now()
        if (!Number.isFinite(current) || current < started || current - started >= SEARCH_DEADLINE_MS) { controller.abort(); throw canceled() }
      }
      if (controllers.size >= 4) fail('音乐封面查询仍在收尾，队列已满。')
      controllers.add(controller)
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
      const timer = setTimeout(abort, SEARCH_DEADLINE_MS)
      const get = async (initial: URL, route: Route): Promise<Buffer | null> => {
        let current = checkedRoute(initial.href, route)
        for (let redirects = 0; redirects <= 3; redirects++) {
          check()
          const musicBrainz = current.hostname === 'musicbrainz.org', rate = takeRateSlot(now(), musicBrainz)
          let response: CommonsTransportResponse
          try { response = await transport(current, controller.signal) }
          finally { settleRateSlot(rate, musicBrainz, now()) }
          const destroy = () => response.destroy()
          controller.signal.addEventListener('abort', destroy, { once: true })
          let redirect: URL | undefined, bytes: Buffer | null = null
          try {
            check()
            if (response.statusCode === 429 || response.statusCode === 503) { coolDown(response, now()); fail('音乐封面来源暂时繁忙，请稍后再试。') }
            if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
              const location = header(response, 'location')
              if (!location || redirects === 3) fail('音乐封面重定向超过预算或缺少地址。')
              redirect = redirectUrl(location, current, route)
            } else if (response.statusCode === 404 && route.kind !== 'search') {
              bytes = null
            } else {
              if (response.statusCode !== 200) fail('音乐封面来源暂时无法提供结果。')
              const encoding = header(response, 'content-encoding')
              if (encoding && encoding !== 'identity') fail('音乐封面响应编码不受支持。')
              const type = (header(response, 'content-type') ?? '').split(';')[0]!.trim().toLowerCase()
              const expected = route.kind === 'image' ? route.extension === 'png' ? 'image/png' : 'image/jpeg' : 'application/json'
              if (type !== expected) fail('音乐封面响应类型与请求不一致。')
              const maximum = route.kind === 'image' ? IMAGE_LIMIT : METADATA_LIMIT
              const declared = header(response, 'content-length')
              if (declared !== undefined && (!/^\d+$/u.test(declared) || !Number.isSafeInteger(Number(declared)) || Number(declared) > maximum)) fail('音乐封面响应超过字节预算。')
              const pieces: Buffer[] = []
              let size = 0
              const iterator = response.body[Symbol.asyncIterator]()
              for (;;) {
                check()
                const next = await iterator.next()
                check()
                if (next.done) break
                const chunk = next.value
                if (!(chunk instanceof Uint8Array) || chunk.byteLength === 0 || size + chunk.byteLength > maximum) fail('音乐封面响应超过字节预算或包含无效片段。')
                size += chunk.byteLength; pieces.push(Buffer.from(chunk))
              }
              if (declared !== undefined && Number(declared) !== size) fail('音乐封面响应长度不一致。')
              bytes = Buffer.concat(pieces, size)
            }
          } finally {
            controller.signal.removeEventListener('abort', destroy)
            response.destroy()
            // 逻辑取消不提前释放物理名额；即使信号已取消也等待真实closed证据。
            await response.closed
          }
          check()
          if (redirect) { current = redirect; continue }
          return bytes
        }
        return fail('音乐封面重定向超过预算。')
      }
      const work = serialSearch(check, async () => {
        const metadata = await get(search.url, search.route)
        check()
        const releases = releaseList(metadata!)
        const result: Array<{ bytes: Uint8Array; source: CoverArtArchiveSource }> = []
        const candidates: Image[] = []
        let totalBytes = 0
        for (const release of releases) {
          const metadataRoute: Route = { kind: 'metadata', releaseId: release.id }
          const listing = await get(new URL(`https://coverartarchive.org/release/${release.id}`), metadataRoute)
          check()
          if (listing === null) continue
          candidates.push(...imageList(listing, release))
        }
        // 两张图片名额在全部有界发行中按front/approved分配，保留发行身份和稳定原顺序。
        candidates.sort((a, b) => Number(b.source.front) - Number(a.source.front) || Number(b.source.approved) - Number(a.source.approved))
        for (const image of candidates) {
          const bytes = await get(new URL(`https://coverartarchive.org/release/${image.route.releaseId}/${image.route.imageId}.${image.route.extension}`), image.route)
          check()
          if (bytes === null) continue
          totalBytes += bytes.length
          if (totalBytes > 8 * 1024 * 1024 || !imageSignature(bytes, image.route.extension)) fail('音乐封面文件超过预算或与原图格式不一致。')
          result.push({ bytes, source: image.source })
          if (result.length === 2) return result
        }
        return result
      }).catch(error => { if (error instanceof ProviderError) throw error; throw new ProviderError('音乐封面查询失败。') })
      work.finally(() => controllers.delete(controller)).catch(() => {})
      try { return await abortable(work, controller.signal) }
      finally { clearTimeout(timer); signal.removeEventListener('abort', abort) }
    },
    close() { closed = true; for (const controller of controllers) controller.abort() },
  }
}
