import { createHash, randomUUID } from 'node:crypto'
import { isCommandOutboxDatasetId, isLocalWorkbenchIdentity, type LocalWorkbenchAvailability } from '@music-bridge/contracts'
import { createPinnedArtworkTransport, type CommonsTransportResponse, type PinnedArtworkTransport } from '../../commons-artwork-provider.js'
import type { NormalizedLocalArtwork } from '../../local-artwork-image.js'
import {
  abortable, boundedInteger, checkSignal, deadline, displayText, fail, parseJson, queryText, record, safeProviderError, utf8,
} from './boundaries.js'
import {
  artworkSearchUrl, checkedProviderImageUrl, checkedProviderPageUrl, checkedRemoteArtworkUrl, largeProviderImageUrl,
  type LocalArtworkSearchSource, type LocalArtworkWebSource,
} from './artwork-urls.js'

export type LocalArtworkProviderSource = 'douban' | 'itunes' | 'remote-import'
/** 公开候选只含不透明身份、有界文字与安全 JPEG；上游 URL 不出 Main。 */
export interface LocalArtworkProviderCandidate {
  candidateId: string
  source: LocalArtworkProviderSource
  origin: 'provider' | 'manual'
  sourceLabel: string
  albumName: string
  artistName: string
  label: string
  previewUrl: string | null
  width: number
  height: number
  licenseLabel: string
  reason?: string
}
export interface LocalArtworkSourceOutcome {
  source: 'douban' | 'itunes'
  status: 'ready' | 'failed'
  candidateCount: number
  previewFailureCount: number
  truncated: boolean
  error: string | null
}
export interface LocalArtworkProviderSearch {
  query: string
  source?: LocalArtworkSearchSource
  country?: string
  limit?: number
}
export interface LocalArtworkSearchResult {
  candidates: readonly LocalArtworkProviderCandidate[]
  sources: readonly LocalArtworkSourceOutcome[]
}
/** 此对象仅供 Main 写入/验证边界；禁止直接投影到 Renderer 或普通候选。 */
export interface LocalArtworkPrivateSource {
  source: LocalArtworkProviderSource
  providerId: string | null
  sourceLabel: string
  albumName: string
  artistName: string
  imageUrl: URL
  sourcePageUrl: URL | null
}
export interface LocalArtworkPrivateCandidate {
  bytes: Uint8Array
  normalized: NormalizedLocalArtwork
  source: LocalArtworkPrivateSource
}
export interface LocalArtworkRemoteImport {
  /** Main 受控手动选择/拖放入口，不表示任意自动下载授权。 */
  url: string
  label?: string
  webSource?: LocalArtworkWebSource
}
/** Main私有读取上下文；可调用配置不表示公网、解码或Owner行为已经通过。 */
export interface LocalArtworkAvailabilityContext {
  signal: AbortSignal
  assertCurrent(): void | Promise<void>
}
export interface LocalArtworkProvidersOptions {
  /** 默认使用现有 HTTPS + 公网 DNS 固定地址传输；仅 Main 可注入合成 transport。 */
  transport?: PinnedArtworkTransport
  /** 注入端口必须只读取原自有HTTP资源状态；不得为探测新建请求或重置期限。 */
  readTransportAvailability?(signal: AbortSignal): boolean | Promise<boolean>
  normalize(bytes: Uint8Array): NormalizedLocalArtwork | Promise<NormalizedLocalArtwork>
  timeoutMs?: number
  maxMetadataBytes?: number
  maxImageBytes?: number
  maxCandidates?: number
  maxCachedImageBytes?: number
  maxPreviewBytes?: number
  candidateTtlMs?: number
  now?: () => number
}
export interface LocalArtworkProviders {
  readAvailability?(source: LocalArtworkProviderSource, context: LocalArtworkAvailabilityContext): Promise<LocalWorkbenchAvailability>
  search(request: LocalArtworkProviderSearch, signal: AbortSignal): Promise<LocalArtworkSearchResult>
  readPreview(candidateId: string, signal: AbortSignal): Promise<LocalArtworkProviderCandidate>
  readCandidate(candidateId: string, signal: AbortSignal): Promise<LocalArtworkPrivateCandidate>
  importRemoteSource(request: LocalArtworkRemoteImport, signal: AbortSignal): Promise<LocalArtworkProviderCandidate>
  close(): void
}

/** 只品牌化本工厂的原逻辑Promise；克隆、空活动Map和别的adapter不授物理关闭。 */
export interface TrackedLocalArtworkProviders extends LocalArtworkProviders {
  readAvailability(source: LocalArtworkProviderSource, context: LocalArtworkAvailabilityContext): Promise<LocalWorkbenchAvailability>
  close():Promise<void>
  join(operation:Promise<unknown>):Promise<void>
  cancelOriginal(operation:Promise<unknown>):Promise<void>
  associateOriginal(operation:Promise<unknown>,owner:Readonly<{datasetId:string;libraryId:string}>):void
  retireLibrary(owner:Readonly<{datasetId:string;libraryId:string}>):void
}
const artworkProviderBrands=new WeakSet<object>()
export const isTrackedLocalArtworkProviders=(value:unknown):value is TrackedLocalArtworkProviders=>value!==null&&typeof value==='object'&&artworkProviderBrands.has(value)
interface ArtworkPhysicalResources {
  pending:Set<Promise<void>>
  responses:WeakMap<object,Promise<void>>
  cleanupFailed:boolean
  library:Readonly<{datasetId:string;libraryId:string}>|null
  candidates:Set<StoredCandidate>
}

interface MetadataCandidate extends LocalArtworkPrivateSource {}
interface StoredCandidate {
  public: LocalArtworkProviderCandidate
  source: LocalArtworkPrivateSource
  createdAt: number
  image: { bytes: Uint8Array; normalized: NormalizedLocalArtwork } | null
  loading: Promise<{ bytes: Uint8Array; normalized: NormalizedLocalArtwork }> | null
  owners:Set<string>
  unboundOwner:boolean
  readers:Set<ArtworkPhysicalResources>
}
const sourceLabel = (source: LocalArtworkProviderSource): string => source === 'douban' ? '豆瓣' : source === 'itunes' ? 'iTunes' : '远程图片（手动导入）'
const hash = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')
const cloneCandidate = (candidate: LocalArtworkProviderCandidate): LocalArtworkProviderCandidate => ({ ...candidate })
const primary = (value: string): string => value.split(' / ')[0]?.trim() || value

function htmlData(html: string): unknown {
  const marker = html.indexOf('window.__DATA__')
  const start = marker < 0 ? -1 : html.indexOf('{', marker + 'window.__DATA__'.length)
  if (start < 0) return fail('response')
  let depth = 0, quoted = false, escaped = false
  for (let at = start; at < html.length; at++) {
    const char = html[at]
    if (quoted) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') quoted = false
    } else if (char === '"') quoted = true
    else if (char === '{') { if (++depth > 32) return fail('response') }
    else if (char === '}' && --depth === 0) return parseJson(html.slice(start, at + 1))
  }
  return fail('response')
}
function metadataCandidates(bytes: Uint8Array, source: 'douban' | 'itunes'): MetadataCandidate[] {
  const data = record(source === 'douban' ? htmlData(utf8(bytes)) : parseJson(utf8(bytes)))
  const items = data?.[source === 'douban' ? 'items' : 'results']
  if (!Array.isArray(items) || items.length > 200) return fail('budget')
  const results: MetadataCandidate[] = [], ids = new Set<string>()
  for (const value of items) {
    const item = record(value)
    if (!item || (source === 'itunes' && item.collectionType != null && item.collectionType !== 'Album')) continue
    const id = source === 'douban' ? item.id : item.collectionId
    if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 1) continue
    const albumName = displayText(source === 'douban' ? item.title : item.collectionName)
    const artistName = displayText(source === 'douban' ? item.abstract : item.artistName)
    if (!albumName || (source === 'itunes' && !artistName)) continue
    const providerId = `${source}-${id}`
    if (ids.has(providerId)) continue
    try {
      const thumbnail = checkedProviderImageUrl(source === 'douban' ? item.cover_url : item.artworkUrl100, source)
      results.push({
        source, providerId, sourceLabel: sourceLabel(source),
        albumName: source === 'douban' ? primary(albumName) : albumName,
        artistName: source === 'douban' ? artistName ? primary(artistName) : '未知表演者' : artistName!,
        imageUrl: largeProviderImageUrl(thumbnail, source),
        sourcePageUrl: checkedProviderPageUrl(source === 'douban' ? item.url : item.collectionViewUrl, source),
      })
      ids.add(providerId)
    } catch { /* 无法通过静态主机/路径准入的单一候选不进入请求队列。 */ }
  }
  return results
}

function header(response: CommonsTransportResponse, name: string): string | undefined {
  const value = response.headers[name]
  if (Array.isArray(value)) return fail('response')
  return value
}
function checkHeaders(response: CommonsTransportResponse, maximum: number, kind: 'douban' | 'itunes' | 'image'): number | null {
  if (response.statusCode < 200 || response.statusCode > 299) return fail('status')
  const encoding = header(response, 'content-encoding')
  if (encoding && encoding.trim().toLowerCase() !== 'identity') return fail('response')
  const mime = header(response, 'content-type')?.split(';')[0]?.trim().toLowerCase()
  const allowed = kind === 'douban' ? ['text/html', 'application/xhtml+xml'] : kind === 'itunes' ? ['application/json'] : ['image/png', 'image/jpeg']
  if (!mime || !allowed.includes(mime)) return fail('response')
  const length = header(response, 'content-length')
  if (length !== undefined && (!/^\d+$/u.test(length) || !Number.isSafeInteger(Number(length)) || Number(length) > maximum)) return fail('budget')
  return length === undefined ? null : Number(length)
}

/** 注入 normalize 仍须返回规范 JPEG 身份，不能把原图/远程 URL 当展示副本。 */
function checkedNormalized(bytes: Uint8Array, value: NormalizedLocalArtwork, mime: string): NormalizedLocalArtwork {
  const original = value?.original, display = value?.display
  if (!original || !display || original.mime !== mime || original.bytes !== bytes.byteLength || original.sha256 !== hash(bytes)
    || !Number.isSafeInteger(original.width) || !Number.isSafeInteger(original.height) || original.width < 1 || original.height < 1
    || original.width > 4096 || original.height > 4096 || original.width * original.height > 16 * 1024 * 1024
    || display.mime !== 'image/jpeg' || typeof display.dataUrl !== 'string' || display.dataUrl.length > 1_398_128
    || !/^data:image\/jpeg;base64,[a-zA-Z0-9+/]+={0,2}$/u.test(display.dataUrl)) return fail('candidate')
  const encoded = display.dataUrl.slice('data:image/jpeg;base64,'.length)
  const preview = Buffer.from(encoded, 'base64')
  if (preview.toString('base64') !== encoded || preview.length < 4 || preview.length > 1024 * 1024
    || preview[0] !== 255 || preview[1] !== 216 || preview[preview.length - 2] !== 255 || preview[preview.length - 1] !== 217
    || display.bytes !== preview.length || display.sha256 !== hash(preview)
    || !Number.isSafeInteger(display.width) || !Number.isSafeInteger(display.height) || display.width < 1 || display.height < 1
    || display.width > 1200 || display.height > 1200) return fail('candidate')
  return { original: { ...original }, display: { ...display } }
}

export function createLocalArtworkProviders(options: LocalArtworkProvidersOptions): TrackedLocalArtworkProviders {
  const transport = options.transport ?? createPinnedArtworkTransport(),ownedTransport=options.transport===undefined
  const timeoutMs = boundedInteger(options.timeoutMs, 20_000, 60_000)
  const metadataLimit = boundedInteger(options.maxMetadataBytes, 1024 * 1024, 2 * 1024 * 1024)
  const imageLimit = boundedInteger(options.maxImageBytes, 4 * 1024 * 1024, 4 * 1024 * 1024)
  const candidateLimit = boundedInteger(options.maxCandidates, 16, 64)
  const imageCacheLimit = boundedInteger(options.maxCachedImageBytes, 8 * 1024 * 1024, 32 * 1024 * 1024)
  const previewLimit = boundedInteger(options.maxPreviewBytes, 16 * 1024 * 1024, 32 * 1024 * 1024)
  const ttlMs = boundedInteger(options.candidateTtlMs, 10 * 60_000, 60 * 60_000)
  const now = options.now ?? Date.now
  const candidates = new Map<string, StoredCandidate>(), active = new Set<AbortController>()
  let closed = false, pending = 0, closure:Promise<void>|undefined, closureDone = false, closureFailed = false
  // 保存本次实际建立的端口及规范器引用；后续替换对象不自动得到旧实例资格。
  const originalTransport = options.transport, originalNormalize = options.normalize
  const transportAvailability = options.readTransportAvailability
  const ownedTransportResource = ownedTransport ? { created: true, alive: true } : null
  const unavailable = (reason: string): LocalWorkbenchAvailability => ({ available: false, reason })
  const physicalTasks=new Set<Promise<void>>(),joins=new WeakMap<Promise<unknown>,Promise<void>>()
  const controllers=new WeakMap<Promise<unknown>,AbortController>()
  const resourcesBySignal=new WeakMap<AbortSignal,ArtworkPhysicalResources>(),resourcesByOriginal=new WeakMap<Promise<unknown>,ArtworkPhysicalResources>(),liveResources=new Set<ArtworkPhysicalResources>()
  const libraryKey=(owner:Readonly<{datasetId:string;libraryId:string}>)=>JSON.stringify([owner.datasetId,owner.libraryId])
  function touch(candidate:StoredCandidate,signal:AbortSignal):void{
    const resources=resourcesBySignal.get(signal);if(!resources)return fail('closed')
    const key=resources.library?libraryKey(resources.library):null
    const known=new Set([...candidate.owners,...[...candidate.readers].filter(reader=>reader.library!==null).map(reader=>libraryKey(reader.library!))])
    if(key!==null&&!known.has(key)&&known.size>=128)return fail('budget')
    resources.candidates.add(candidate);candidate.readers.add(resources)
  }
  function settleCandidates(resources:ArtworkPhysicalResources):void{
    for(const candidate of resources.candidates){if(resources.library)candidate.owners.add(libraryKey(resources.library));else candidate.unboundOwner=true;candidate.readers.delete(resources)}
  }
  function trackPhysical(resources:ArtworkPhysicalResources,work:Promise<unknown>,cleanup=false):Promise<void>{
    const task=work.then(()=>undefined,()=>{if(cleanup)resources.cleanupFailed=true}).finally(()=>resources.pending.delete(task))
    resources.pending.add(task);return task
  }
  function closeResponse(resources:ArtworkPhysicalResources,response:CommonsTransportResponse):Promise<void>{
    const previous=resources.responses.get(response);if(previous)return previous
    const task=Promise.resolve().then(async()=>{response.destroy();await response.closed})
    resources.responses.set(response,task);trackPhysical(resources,task,true);void task.catch(()=>{})
    return task
  }
  async function joinResources(resources:ArtworkPhysicalResources):Promise<void>{
    while(resources.pending.size)await Promise.allSettled([...resources.pending])
    if(resources.cleanupFailed)return fail('closed')
  }

  const prune = () => {
    const time = now()
    if (!Number.isFinite(time)) return fail('configuration')
    for (const [id, candidate] of candidates) if (time - candidate.createdAt >= ttlMs || time < candidate.createdAt) candidates.delete(id)
    while (candidates.size > 128) candidates.delete(candidates.keys().next().value!)
    let imageBytes = [...candidates.values()].reduce((sum, item) => sum + (item.image?.bytes.byteLength ?? 0), 0)
    let previewBytes = [...candidates.values()].reduce((sum, item) => sum + (item.public.previewUrl ? Buffer.byteLength(item.public.previewUrl, 'utf8') : 0), 0)
    for (const candidate of candidates.values()) {
      if (imageBytes > imageCacheLimit && candidate.image) { imageBytes -= candidate.image.bytes.byteLength; candidate.image = null }
      if (previewBytes > previewLimit && candidate.public.previewUrl) {
        previewBytes -= Buffer.byteLength(candidate.public.previewUrl, 'utf8')
        candidate.public = { ...candidate.public, previewUrl: null, width: 0, height: 0, reason: '展示缓存已释放，可显式重新读取。' }
      }
      if (imageBytes <= imageCacheLimit && previewBytes <= previewLimit) break
    }
  }
  const capture = (candidateId: string,signal:AbortSignal): StoredCandidate => {
    prune()
    if (typeof candidateId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(candidateId)) return fail('candidate')
    const candidate = candidates.get(candidateId)
    if (!candidate) return fail('candidate')
    touch(candidate,signal);return candidate
  }
  const run = <T>(parent:AbortSignal,work:(signal:AbortSignal)=>Promise<T>):Promise<T>=>{
    const refused=(code:'closed'|'busy')=>{const operation=Promise.reject<T>(failError(code));joins.set(operation,Promise.resolve());return operation}
    if(closed)return refused('closed')
    if(pending>=2)return refused('busy')
    const scope=deadline(parent,timeoutMs),resources:ArtworkPhysicalResources={pending:new Set(),responses:new WeakMap(),cleanupFailed:false,library:null,candidates:new Set()}
    resourcesBySignal.set(scope.signal,resources);liveResources.add(resources);pending++;active.add(scope.controller)
    const operation=Promise.resolve().then(async()=>{checkSignal(scope.signal);const result=await work(scope.signal);checkSignal(scope.signal);if(closed)return fail('cancelled');return result})
      .catch(error=>{throw safeProviderError(error,scope.signal)}).finally(()=>scope.dispose())
    const physical=operation.then(()=>undefined,()=>undefined).then(()=>joinResources(resources))
      .then(()=>{settleCandidates(resources);liveResources.delete(resources);pending--;active.delete(scope.controller);physicalTasks.delete(physical)})
    joins.set(operation,physical);controllers.set(operation,scope.controller);resourcesByOriginal.set(operation,resources);physicalTasks.add(physical)
    void physical.catch(()=>{}) // 未闭口的原任务保留，不能释放并发槽或重签静止。
    return operation
  }
  const failError=(code:'closed'|'busy'):Error=>{try{return fail(code)}catch(error){return error as Error}}
  const read = async (url: URL, signal: AbortSignal, maximum: number, kind: 'douban' | 'itunes' | 'image'): Promise<{ bytes: Uint8Array; mime: string }> => {
    let response: CommonsTransportResponse | undefined
    const resources=resourcesBySignal.get(signal);if(!resources)return fail('closed')
    let invoked=false
    const work=Promise.resolve().then(()=>{checkSignal(signal);invoked=true;return transport(new URL(url.href),signal)})
    const producer=work.then(async late=>{if(signal.aborted)await closeResponse(resources,late)},()=>{if(invoked&&!ownedTransport)resources.cleanupFailed=true})
    trackPhysical(resources,producer,true)
    try {
      response = await abortable(work, signal)
      const declared = checkHeaders(response, maximum, kind)
      const chunks: Uint8Array[] = [], iterator = response.body[Symbol.asyncIterator]()
      let length = 0
      while (true) {
        checkSignal(signal)
        const next=Promise.resolve(iterator.next());trackPhysical(resources,next)
        const item = await abortable(next, signal)
        if (item.done) break
        if (!(item.value instanceof Uint8Array)) return fail('response')
        length += item.value.byteLength
        if (length > maximum) return fail('budget')
        chunks.push(Buffer.from(item.value))
      }
      checkSignal(signal)
      if (declared !== null && declared !== length) return fail('response')
      const bytes = Buffer.concat(chunks, length)
      if (kind === 'image') {
        const mime = header(response, 'content-type')!.split(';')[0]!.trim().toLowerCase()
        const png = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        const jpeg = bytes[0] === 255 && bytes[1] === 216
        if ((mime === 'image/png' && !png) || (mime === 'image/jpeg' && !jpeg)) return fail('candidate')
      }
      return { bytes, mime: header(response, 'content-type')!.split(';')[0]!.trim().toLowerCase() }
    } finally {
      // 没有实际 close 证据时不把响应租约冒充为已释放。
      if(response)await closeResponse(resources,response)
    }
  }
  const make = (source: LocalArtworkPrivateSource,signal:AbortSignal,label?: string): StoredCandidate => {
    const candidate: StoredCandidate = {
      source, createdAt: now(), image: null, loading: null,owners:new Set(),unboundOwner:false,readers:new Set(),
      public: {
        candidateId: randomUUID(), source: source.source, origin: source.source === 'remote-import' ? 'manual' : 'provider',
        sourceLabel: source.sourceLabel, albumName: source.albumName, artistName: source.artistName,
        label: label ?? `${source.albumName} · ${source.artistName}`,
        previewUrl: null, width: 0, height: 0, licenseLabel: '来源未提供授权信息', reason: '封面尚未读取。',
      },
    }
    touch(candidate,signal);candidates.set(candidate.public.candidateId, candidate); prune()
    return candidate
  }
  const load = async (candidate: StoredCandidate, signal: AbortSignal): Promise<{ bytes: Uint8Array; normalized: NormalizedLocalArtwork }> => {
    checkSignal(signal)
    if (candidate.loading) return abortable(candidate.loading, signal)
    const work = Promise.resolve().then(async () => {
      let image = candidate.image
      if (!image) {
        const { bytes, mime } = await read(candidate.source.imageUrl, signal, imageLimit, 'image')
        image = { bytes, normalized: checkedNormalized(bytes, await abortable(Promise.resolve().then(() => options.normalize(bytes)), signal), mime) }
      }
      checkSignal(signal)
      if (closed || candidates.get(candidate.public.candidateId) !== candidate) return fail('candidate')
      candidate.image = image
      candidate.public = { ...candidate.public, previewUrl: image.normalized.display.dataUrl, width: image.normalized.original.width, height: image.normalized.original.height }
      delete candidate.public.reason
      candidates.delete(candidate.public.candidateId); candidates.set(candidate.public.candidateId, candidate)
      prune()
      return image
    })
    candidate.loading = work
    work.finally(() => { if (candidate.loading === work) candidate.loading = null }).catch(() => {})
    // 首个调用拥有物理响应，必须由 read 的 finally 等到 closed；不能在外层抢先返回取消。
    // 其他调用仅等共享结果，取消它自己的等待不会宣称已释放首个调用的传输租约。
    return work
  }

  function availabilityBlock(source: LocalArtworkProviderSource): LocalWorkbenchAvailability | null {
    if (!['douban', 'itunes', 'remote-import'].includes(source)) return unavailable('封面来源不在原固定策略内。')
    if (closureFailed || [...liveResources].some(resources => resources.cleanupFailed)) return unavailable('原封面物理资源关闭尚未确认。')
    if (closed) return unavailable(closureDone ? '封面资源已经关闭。' : '封面资源正在关闭。')
    if (pending >= 2) return unavailable('原封面读取槽位已满。')
    if (options.transport !== originalTransport || options.normalize !== originalNormalize
      || options.readTransportAvailability !== transportAvailability || typeof originalNormalize !== 'function' || typeof transport !== 'function') return unavailable('原封面资源配置已经改变。')
    try {
      if (source === 'remote-import') checkedRemoteArtworkUrl('https://example.com/artwork.jpg')
      else artworkSearchUrl(source, '配置检查', 'CN', 1)
    } catch { return unavailable('原封面URL策略不可用。') }
    return null
  }
  const provider:TrackedLocalArtworkProviders = {
    async readAvailability(source, context) {
      if (this !== provider || !context || !(context.signal instanceof AbortSignal) || typeof context.assertCurrent !== 'function') return unavailable('原封面作者尚未建立。')
      const originalSignal=context.signal,originalAssert=context.assertCurrent
      try {
        checkSignal(originalSignal); await originalAssert.call(context); checkSignal(originalSignal)
        if(context.signal!==originalSignal||context.assertCurrent!==originalAssert)return unavailable('原封面读取上下文已经换代。')
        const blocked = availabilityBlock(source); if (blocked) return blocked
        // 默认端口由本工厂实际建立且只随本资源收口；注入端口不能靠函数存在自报alive。
        const ownAlive = ownedTransportResource?.created === true && ownedTransportResource.alive
        // Root提供动态状态时必须消费它；不能用默认资源created短路正在关闭的原工厂。
        const ready = transportAvailability !== undefined
          ? typeof transportAvailability === 'function' && await abortable(Promise.resolve(transportAvailability(originalSignal)), originalSignal) === true
          : ownAlive
        await originalAssert.call(context); checkSignal(originalSignal)
        if(context.signal!==originalSignal||context.assertCurrent!==originalAssert)return unavailable('原封面读取上下文已经换代。')
        const after = availabilityBlock(source); if (after) return after
        return ready ? { available: true } : unavailable('原封面传输状态未确认可调用。')
      } catch { return unavailable('原封面作者或读取信号已撤销。') }
    },
    search(request, parent) {
      return run(parent, async signal => {
        const query = queryText(request.query), source = request.source ?? 'douban-itunes'
        if (!['douban-itunes', 'douban', 'itunes'].includes(source)) return fail('input')
        const country = request.country?.trim().toUpperCase() ?? 'CN'
        if (!/^[A-Z]{2}$/u.test(country)) return fail('input')
        if (request.limit !== undefined && (!Number.isSafeInteger(request.limit) || !Number.isFinite(request.limit))) return fail('input')
        const limit = Math.max(1, Math.min(200, request.limit ?? 50))
        const sources: Array<'douban' | 'itunes'> = source === 'douban-itunes' ? ['douban', 'itunes'] : [source]
        const fetched = await Promise.allSettled(sources.map(async provider => {
          const bytes = await read(artworkSearchUrl(provider, query, country, limit), signal, metadataLimit, provider)
          return metadataCandidates(bytes.bytes, provider)
        }))
        checkSignal(signal)
        const stored: StoredCandidate[] = [], outcomes: LocalArtworkSourceOutcome[] = []
        // 固定顺序合并，完成先后不改变来源身份或选图顺序。
        for (let index = 0; index < sources.length; index++) {
          const provider = sources[index]!, result = fetched[index]!
          if (result.status === 'rejected') { outcomes.push({ source: provider, status: 'failed', candidateCount: 0, previewFailureCount: 0, truncated: false, error: safeProviderError(result.reason, signal).message }); continue }
          const accepted = result.value.slice(0, candidateLimit)
          outcomes.push({ source: provider, status: 'ready', candidateCount: accepted.length, previewFailureCount: 0, truncated: accepted.length < result.value.length, error: null })
          stored.push(...accepted.map(item => make(item,signal)))
        }
        for (const candidate of stored) {
          checkSignal(signal)
          try { await load(candidate, signal) }
          catch (error) {
            checkSignal(signal)
            candidate.public = { ...candidate.public, reason: safeProviderError(error, signal).message }
            outcomes.find(outcome => outcome.source === candidate.source.source)!.previewFailureCount++
          }
        }
        return { candidates: stored.map(item => cloneCandidate(item.public)), sources: outcomes }
      })
    },
    readPreview(candidateId, parent) {
      return run(parent, async signal => { const candidate = capture(candidateId,signal); await load(candidate, signal); return cloneCandidate(candidate.public) })
    },
    readCandidate(candidateId, parent) {
      return run(parent, async signal => {
        const candidate = capture(candidateId,signal), image = await load(candidate, signal)
        return {
          bytes: Uint8Array.from(image.bytes),
          normalized: { original: { ...image.normalized.original }, display: { ...image.normalized.display } },
          source: { ...candidate.source, imageUrl: new URL(candidate.source.imageUrl.href), sourcePageUrl: candidate.source.sourcePageUrl ? new URL(candidate.source.sourcePageUrl.href) : null },
        }
      })
    },
    importRemoteSource(request, parent) {
      return run(parent, async signal => {
        const url = checkedRemoteArtworkUrl(request.url)
        const label = request.label === undefined ? '手动选择的远程封面' : displayText(request.label)
        if (!label || (request.webSource !== undefined && !['douban-web', 'bing-images', 'google-images'].includes(request.webSource))) return fail('input')
        const webLabel = request.webSource === 'douban-web' ? '豆瓣网页（手动导入）' : request.webSource === 'bing-images' ? 'Bing 图片（手动导入）' : request.webSource === 'google-images' ? 'Google 图片（手动导入）' : sourceLabel('remote-import')
        const candidate = make({ source: 'remote-import', providerId: null, sourceLabel: webLabel, albumName: label, artistName: '未提供表演者', imageUrl: url, sourcePageUrl: null },signal,label)
        try { await load(candidate, signal); return cloneCandidate(candidate.public) }
        catch (error) { candidates.delete(candidate.public.candidateId); throw error }
      })
    },
    join(operation){return joins.get(operation)??Promise.reject(failError('closed'))},
    cancelOriginal(operation){const physical=joins.get(operation);if(!physical)return Promise.reject(failError('closed'));controllers.get(operation)?.abort('provider-cancelled');return physical},
    associateOriginal(operation,owner){
      if(!isCommandOutboxDatasetId(owner.datasetId)||!isLocalWorkbenchIdentity(owner.libraryId)||!joins.has(operation))return fail('closed')
      const resources=resourcesByOriginal.get(operation);if(!resources)return
      if(resources.library&&libraryKey(resources.library)!==libraryKey(owner))return fail('closed')
      resources.library=Object.freeze({...owner})
    },
    retireLibrary(owner){
      if(!isCommandOutboxDatasetId(owner.datasetId)||!isLocalWorkbenchIdentity(owner.libraryId))return fail('closed')
      const key=libraryKey(owner)
      // 未关闭的原资源或未登记原归属不能用空Map清缓存；Legacy/别库引用保留。
      if([...liveResources].some(resources=>resources.library===null||libraryKey(resources.library)===key))return fail('closed')
      for(const [id,candidate]of candidates)if(!candidate.unboundOwner&&!candidate.readers.size&&!candidate.loading&&candidate.owners.size>0&&[...candidate.owners].every(ownerKey=>ownerKey===key))candidates.delete(id)
    },
    close(){if(!closure){closed=true;if(ownedTransportResource)ownedTransportResource.alive=false;for(const controller of active)controller.abort('provider-cancelled');closure=(async()=>{const results=await Promise.allSettled([...physicalTasks]);if(results.some(r=>r.status==='rejected'))return fail('closed');candidates.clear();closureDone=true})();void closure.catch(()=>{closureFailed=true})}return closure},
  }
  artworkProviderBrands.add(provider)
  return provider
}
