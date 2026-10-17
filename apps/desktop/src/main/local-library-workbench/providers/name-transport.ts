import {
  abortable, boundedInteger, checkSignal, deadline, fail, LocalProviderError, parseJson, record, safeProviderError, utf8,
} from './boundaries.js'

export type LocalNameBackend = 'ollama' | 'vllm' | 'cloud'
/** 只由 Main 设置与保险库解析；Renderer 只可传 backend，不可传此对象。 */
export interface LocalNameConfiguration {
  baseUrl: string
  model: string
  requiresSecret?: boolean
  /** 与原 CoverDrop 保持默认 30s；此字段不进入公开合同。 */
  keepAlive?: string
}
export interface LocalNameTransportOptions {
  getConfiguration(backend: LocalNameBackend): LocalNameConfiguration | null | Promise<LocalNameConfiguration | null>
  resolveSecret?(backend: LocalNameBackend, configuration: LocalNameConfiguration, signal: AbortSignal): string | null | Promise<string | null>
  /** Main 受控测试注入；默认使用 Node 的 fetch，不自动重试或跟随重定向。 */
  fetch?: typeof globalThis.fetch
  timeoutMs?: number
  unloadTimeoutMs?: number
  maxResponseBytes?: number
  maxContentBytes?: number
  maxLineBytes?: number
}
export interface LocalNameRequest { backend: LocalNameBackend; systemPrompt: string; userPrompt: string }
/** 私有模型正文仍需 Core 确定性校验；返回不代表候选可应用。 */
export interface LocalNamePrivateContent { backend: LocalNameBackend; content: string }
export interface LocalNameTransport {
  suggest(request: LocalNameRequest, signal: AbortSignal): Promise<LocalNamePrivateContent>
  releaseResources(backend: LocalNameBackend, signal?: AbortSignal): Promise<{ released: boolean }>
  /** 私有真实资源join；旧受控transport可不提供，生产NAME桥必须使用实际品牌。 */
  join?(operation: Promise<LocalNamePrivateContent>): Promise<void>
  stop(): Promise<void>
  close(): Promise<void>
}

interface OllamaSession { endpoint: URL; model: string }
interface Chunk { content: string; done: boolean }
const supported = (value: unknown): value is LocalNameBackend => value === 'ollama' || value === 'vllm' || value === 'cloud'
const prompt = (value: unknown): string => {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value, 'utf8') > 64 * 1024 || /\u0000/u.test(value)) return fail('input')
  return value
}
function configuredEndpoint(backend: LocalNameBackend, configuration: LocalNameConfiguration): URL {
  const base = typeof configuration.baseUrl === 'string' ? configuration.baseUrl.trim() : ''
  if (!base || base.length > 2048 || /[\u0000-\u0020\u007f\\]/u.test(base)) return fail('configuration')
  let url: URL
  try { url = new URL(base) } catch { return fail('configuration') }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash
    || (backend === 'cloud' && url.protocol !== 'https:')) return fail('configuration')
  if (typeof configuration.model !== 'string' || !configuration.model.trim()
    || Buffer.byteLength(configuration.model, 'utf8') > 512 || /[\u0000-\u001f\u007f]/u.test(configuration.model)) return fail('configuration')
  const path = url.pathname.replace(/\/+$/u, '')
  url.pathname = backend === 'ollama' ? `${path}/api/chat` : `${path.endsWith('/v1') ? path : `${path}/v1`}/chat/completions`
  return url
}
function content(value: unknown): string {
  if (value === undefined || value === null) return ''
  if (typeof value !== 'string') return fail('response')
  return value
}
function ollamaChunk(line: string): Chunk {
  const body = record(parseJson(line))
  if (!body || ('error' in body && body.error !== null && body.error !== undefined)) return fail('response')
  if (body.done !== undefined && typeof body.done !== 'boolean') return fail('response')
  const message = body.message === undefined || body.message === null ? null : record(body.message)
  if (body.message != null && !message) return fail('response')
  // thinking 留在流预算内，但不进入名称正文。
  return { content: content(message?.content), done: body.done === true }
}
function compatibleChunk(line: string): Chunk {
  const trimmed = line.trim()
  if (!trimmed || /^(?::|event:|id:|retry:)/u.test(trimmed)) return { content: '', done: false }
  const payload = trimmed.startsWith('data:') ? trimmed.slice(5).trim() : trimmed
  if (!payload) return { content: '', done: false }
  if (payload === '[DONE]') return { content: '', done: true }
  const body = record(parseJson(payload))
  if (!body || body.error != null || (body.choices != null && !Array.isArray(body.choices))) return fail('response')
  const first = Array.isArray(body.choices) && body.choices.length ? record(body.choices[0]) : null
  if (Array.isArray(body.choices) && body.choices.length && !first) return fail('response')
  const delta = first?.delta == null ? null : record(first.delta)
  if (first?.delta != null && !delta) return fail('response')
  if (first?.finish_reason != null && typeof first.finish_reason !== 'string') return fail('response')
  return { content: content(delta?.content), done: first?.finish_reason != null }
}

function validateResponse(response: Response, maximum: number, streaming: boolean): void {
  if (!response.ok) return fail('status')
  const length = response.headers.get('content-length')
  if (length !== null && (!/^\d+$/u.test(length) || !Number.isSafeInteger(Number(length)) || Number(length) > maximum)) return fail('budget')
  const mime = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase()
  const allowed = streaming ? ['application/json', 'application/x-ndjson', 'application/json-seq', 'text/event-stream'] : ['application/json', 'application/x-ndjson']
  if (!mime || !allowed.includes(mime) || !response.body) return fail('response')
}
async function receiveContent(response: Response, backend: LocalNameBackend, signal: AbortSignal, limits: { response: number; content: number; line: number }, resources: NamePhysicalResources): Promise<string> {
  validateResponse(response, limits.response, true)
  const reader = response.body!.getReader()
  ownNameReader(resources,reader,response.body!)
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let total = 0, pending = '', result = '', resultBytes = 0, lines = 0
  const process = (line: string): boolean => {
    if (++lines > 16_384 || Buffer.byteLength(line, 'utf8') > limits.line) return fail('budget')
    if (!line.trim()) return false
    const chunk = backend === 'ollama' ? ollamaChunk(line.trim()) : compatibleChunk(line)
    resultBytes += Buffer.byteLength(chunk.content, 'utf8')
    if (resultBytes > limits.content) return fail('budget')
    result += chunk.content
    return chunk.done
  }
  try {
    while (true) {
      checkSignal(signal)
      const next = await abortable(trackNameResource(resources, reader.read()), signal)
      if (next.done) {
        try { pending += decoder.decode() } catch { return fail('response') }
        if (pending && process(pending)) break
        break
      }
      total += next.value.byteLength
      if (total > limits.response) return fail('budget')
      try { pending += decoder.decode(next.value, { stream: true }) } catch { return fail('response') }
      let at = pending.indexOf('\n')
      while (at >= 0) {
        const line = pending.slice(0, at)
        pending = pending.slice(at + 1)
        if (process(line)) { checkSignal(signal); if (!result.trim()) return fail('response'); return result }
        at = pending.indexOf('\n')
      }
      if (Buffer.byteLength(pending, 'utf8') > limits.line) return fail('budget')
    }
    checkSignal(signal)
    // 原客户端接受有正文的正常 EOF；最终名称结构仍由 Core 校验。
    if (!result.trim()) return fail('response')
    return result
  } finally {
    closeNameReader(resources, reader)
  }
}

interface NamePhysicalResources { pending: Set<Promise<unknown>>; readerClosures: Set<Promise<void>>; readerBodies: WeakSet<object>; readerStates: WeakMap<object,{terminal:Promise<void>;state:'pending'|'closed'|'errored';error:unknown}>; cleanupFailed: boolean }
const nameTransportBrands = new WeakSet<object>()
export interface TrackedLocalNameTransport extends LocalNameTransport {
  /** 只取消这一个本工厂原Promise；不退休全局generation或其它库请求。 */
  cancelOriginal(operation:Promise<LocalNamePrivateContent>):Promise<void>
  join(operation: Promise<LocalNamePrivateContent>): Promise<void>
  /** 只返回配置是否实际可用；URL、模型配置及密钥始终留在Main。 */
  configured(backend: LocalNameBackend, signal: AbortSignal): Promise<boolean>
}
export const isTrackedLocalNameTransport = (value: unknown): value is TrackedLocalNameTransport => value !== null && typeof value === 'object' && nameTransportBrands.has(value)
function trackNameResource<T>(resources: NamePhysicalResources, work: Promise<T>, cleanup = false): Promise<T> {
  const tracked = work.catch(error => { if (cleanup) resources.cleanupFailed = true; throw error })
  resources.pending.add(tracked)
  void tracked.then(() => resources.pending.delete(tracked), () => resources.pending.delete(tracked))
  return tracked
}
function ownNameReader(resources:NamePhysicalResources,reader:ReadableStreamDefaultReader<Uint8Array>,body:ReadableStream<Uint8Array>):void {
  const state:{terminal:Promise<void>;state:'pending'|'closed'|'errored';error:unknown}={terminal:Promise.resolve(),state:'pending',error:undefined}
  state.terminal=trackNameResource(resources,reader.closed.then(()=>{state.state='closed'},error=>{state.state='errored';state.error=error}))
  resources.readerBodies.add(body);resources.readerStates.set(reader,state)
}
function closeNameReader(resources: NamePhysicalResources, reader: ReadableStreamDefaultReader<Uint8Array>): void {
  const state=resources.readerStates.get(reader)
  const work = trackNameResource(resources, Promise.resolve().then(async () => {
    try {
      try { await reader.cancel() }
      catch(error){if(!state||state.state!=='errored'||state.error!==error)throw error}
      if(state)await state.terminal
    } finally { reader.releaseLock() }
  }), true)
  resources.readerClosures.add(work)
  void work.then(() => resources.readerClosures.delete(work), () => resources.readerClosures.delete(work))
}
function closeNameBody(resources: NamePhysicalResources, response: Response): void {
  const readers = [...resources.readerClosures]
  trackNameResource(resources, Promise.resolve().then(async () => {
    await Promise.allSettled(readers)
    if (response.body?.locked) return fail('closed')
    if(response.body&&!resources.readerBodies.has(response.body))await response.body.cancel()
  }), true)
}
async function joinNameResources(resources: NamePhysicalResources): Promise<void> {
  while (resources.pending.size) await Promise.allSettled([...resources.pending])
  if (resources.cleanupFailed) return fail('closed')
}

export function createLocalNameTransport(options: LocalNameTransportOptions): TrackedLocalNameTransport {
  const fetcher = options.fetch ?? globalThis.fetch
  const timeoutMs = boundedInteger(options.timeoutMs, 300_000, 900_000)
  const unloadTimeoutMs = boundedInteger(options.unloadTimeoutMs, 30_000, 30_000)
  const limits = {
    response: boundedInteger(options.maxResponseBytes, 512 * 1024, 4 * 1024 * 1024),
    content: boundedInteger(options.maxContentBytes, 64 * 1024, 256 * 1024),
    line: boundedInteger(options.maxLineBytes, 64 * 1024, 512 * 1024),
  }
  let closed = false, stopping = false, generation = 0
  let current: { controller: AbortController; done: Promise<LocalNamePrivateContent>; physical: Promise<void> } | null = null
  let ollama: OllamaSession | null = null
  let unloading: Promise<{ released: boolean }> | null = null
  let stoppingTask: Promise<void> | null = null
  const joins = new WeakMap<Promise<LocalNamePrivateContent>, Promise<void>>()
  const originalControllers=new WeakMap<Promise<LocalNamePrivateContent>,AbortController>()
  const active = new Set<Promise<void>>()
  let physicalFailure = false
  const own = (work: Promise<void>): Promise<void> => {
    active.add(work)
    void work.then(() => active.delete(work), () => { physicalFailure = true; active.delete(work) })
    return work
  }
  const resourceSet = (): NamePhysicalResources => ({ pending: new Set(), readerClosures: new Set(), readerBodies:new WeakSet(),readerStates:new WeakMap(),cleanupFailed: false })
  const fetchResponse = async (resources: NamePhysicalResources, url: URL, init: RequestInit, signal: AbortSignal): Promise<Response> => {
    const work = trackNameResource(resources, Promise.resolve().then(() => { checkSignal(signal); return fetcher(url, { ...init, signal, redirect: 'error', credentials: 'omit', cache: 'no-store' }) }))
    // logical取消不替代原fetch的真实settle；迟到body也由同一operation完整关闭。
    trackNameResource(resources, work.then(response => { if (signal.aborted) closeNameBody(resources, response) }, () => undefined))
    return abortable(work, signal)
  }
  const unload = (signal?: AbortSignal): Promise<{ released: boolean }> => {
    if (unloading) return unloading
    const session = ollama
    if (!session) return Promise.resolve({ released: false })
    const scope = deadline(signal, unloadTimeoutMs), resources = resourceSet()
    const logical = Promise.resolve().then(async () => {
      let response: Response | undefined
      try {
        checkSignal(scope.signal)
        response = await fetchResponse(resources, session.endpoint, {
          method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ model: session.model, messages: [], stream: false, keep_alive: '0' }),
        }, scope.signal)
        validateResponse(response, 32 * 1024, false)
        const reader = response.body!.getReader()
        ownNameReader(resources,reader,response.body!)
        let bytes = 0
        const chunks: Uint8Array[] = []
        try {
          while (true) {
            const item = await abortable(trackNameResource(resources, reader.read()), scope.signal)
            if (item.done) break
            bytes += item.value.byteLength
            if (bytes > 32 * 1024) return fail('budget')
            chunks.push(item.value)
          }
        } finally { closeNameReader(resources, reader) }
        checkSignal(scope.signal)
        if (record(parseJson(utf8(Buffer.concat(chunks))))?.done !== true) return fail('response')
        if (ollama === session) ollama = null
        return { released: true }
      } catch { return { released: false } }
      finally { if (response) closeNameBody(resources, response); scope.dispose() }
    })
    const physical = own(logical.then(async () => { await joinNameResources(resources) }))
    unloading = logical.then(async result => { await physical; return result }).finally(() => { unloading = null })
    void unloading.catch(() => undefined)
    return unloading
  }
  const stop = (): Promise<void> => {
    if (stoppingTask) return stoppingTask
    stopping = true
    generation++
    current?.controller.abort('provider-cancelled')
    const pending = current?.physical
    stoppingTask = (async () => {
      if (pending) await pending
      await unload()
      while (active.size) await Promise.allSettled([...active])
      if (physicalFailure) return fail('closed')
    })().finally(() => { stopping = false; stoppingTask = null })
    return stoppingTask
  }
  const refused=(code:'closed'|'busy'|'input'):Promise<LocalNamePrivateContent>=>{const operation=Promise.reject(new LocalProviderError(code));joins.set(operation,Promise.resolve());return operation}
  const transport: TrackedLocalNameTransport = {
    suggest(request, parent) {
      if (closed) return refused('closed')
      if (current || stopping || unloading) return refused('busy')
      if (!supported(request.backend)) return refused('input')
      const scope = deadline(parent, timeoutMs), started = generation, resources = resourceSet()
      const operation = (async () => {
        try {
          checkSignal(scope.signal)
          const systemPrompt = prompt(request.systemPrompt), userPrompt = prompt(request.userPrompt)
          const configuration = await abortable(trackNameResource(resources, Promise.resolve().then(() => options.getConfiguration(request.backend))), scope.signal)
          if (!configuration) return fail('configuration')
          const endpoint = configuredEndpoint(request.backend, configuration)
          const model = configuration.model.trim()
          let secret: string | null = null
          if (request.backend !== 'ollama' && options.resolveSecret) secret = await abortable(trackNameResource(resources, Promise.resolve().then(() => options.resolveSecret!(request.backend, configuration, scope.signal))), scope.signal)
          if (secret !== null && (typeof secret !== 'string' || Buffer.byteLength(secret, 'utf8') > 64 * 1024 || /[^\u0020-\u007e]/u.test(secret))) return fail('configuration')
          const key = secret?.trim() ?? ''
          if ((configuration.requiresSecret ?? request.backend === 'cloud') && !key) return fail('configuration')
          const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json' }
          if (key) headers.Authorization = `Bearer ${key}`
          const messages = [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }]
          const keepAlive = configuration.keepAlive ?? '30s'
          if (request.backend === 'ollama' && (typeof keepAlive !== 'string' || !/^(?:0|\d{1,4}s|\d{1,3}m)$/u.test(keepAlive))) return fail('configuration')
          const body = request.backend === 'ollama' ? {
            model, messages, think: false, stream: true,
            format: { type: 'object', properties: { artistName: { type: 'string' }, albumName: { type: 'string' } }, required: ['artistName', 'albumName'], additionalProperties: false },
            keep_alive: keepAlive,
          } : { model, messages, stream: true }
          checkSignal(scope.signal)
          if (request.backend === 'ollama') ollama = { endpoint, model }
          const response = await fetchResponse(resources, endpoint, { method: 'POST', headers, body: JSON.stringify(body) }, scope.signal)
          let result: string
          try { result = await receiveContent(response, request.backend, scope.signal, limits, resources) }
          finally { closeNameBody(resources, response) }
          checkSignal(scope.signal)
          if (started !== generation || closed) return fail('cancelled')
          return { backend: request.backend, content: result }
        } catch (error) { throw safeProviderError(error, scope.signal) }
        finally {
          const cancelled = scope.signal.aborted
          scope.dispose()
          if (cancelled && request.backend === 'ollama' && !stopping) await unload()
        }
      })()
      const physical = own(operation.then(() => undefined, () => undefined).then(() => joinNameResources(resources)))
      joins.set(operation, physical);originalControllers.set(operation,scope.controller)
      current = { controller: scope.controller, done: operation, physical }
      void physical.then(() => { if (current?.done === operation) current = null }, () => { /* 未确认物理关闭，保留busy和原资源身份。 */ })
      return operation
    },
    join(operation) { const physical = joins.get(operation); return physical ?? Promise.reject(new LocalProviderError('input')) },
    cancelOriginal(operation){const physical=joins.get(operation);if(!physical)return Promise.reject(new LocalProviderError('input'));originalControllers.get(operation)?.abort('provider-cancelled');return physical},
    async configured(backend, signal) {
      if (closed || !supported(backend)) return false
      const resources = resourceSet()
      const operation = (async () => {
        checkSignal(signal)
        const configuration = await abortable(trackNameResource(resources, Promise.resolve().then(() => options.getConfiguration(backend))), signal)
        if (!configuration) return false
        configuredEndpoint(backend, configuration)
        if (backend === 'ollama') return true
        const secret = options.resolveSecret ? await abortable(trackNameResource(resources, Promise.resolve().then(() => options.resolveSecret!(backend, configuration, signal))), signal) : null
        if (secret !== null && (typeof secret !== 'string' || Buffer.byteLength(secret, 'utf8') > 64 * 1024 || /[^\u0020-\u007e]/u.test(secret))) return false
        checkSignal(signal)
        return !(configuration.requiresSecret ?? backend === 'cloud') || Boolean(secret?.trim())
      })()
      const physical=own(operation.then(() => undefined, () => undefined).then(() => joinNameResources(resources)))
      return operation.then(async result=>{await physical;return result},async error=>{await physical;throw error})
    },
    async releaseResources(backend, signal) {
      if (!supported(backend)) return fail('input')
      if (backend !== 'ollama') return { released: false }
      if (current) return fail('busy')
      return unload(signal)
    },
    stop,
    async close() { closed = true; await stop() },
  }
  nameTransportBrands.add(transport)
  return transport
}
