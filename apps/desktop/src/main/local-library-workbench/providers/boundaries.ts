/** Main 私有 Provider 共同边界；上游正文、URL、凭据和 cause 不进入错误对象。 */
export type LocalProviderErrorCode =
  | 'configuration' | 'input' | 'busy' | 'closed' | 'cancelled' | 'timeout'
  | 'transport' | 'status' | 'response' | 'budget' | 'candidate'

const messages: Record<LocalProviderErrorCode, string> = {
  configuration: '服务配置不可用，请检查 Main 中的服务设置。',
  input: '查询输入不符合要求，请使用有界的名称或受支持的来源。',
  busy: '服务正在处理请求，请稍后再试。',
  closed: '服务已关闭，请重新打开整理工作台。',
  cancelled: '请求已取消。',
  timeout: '服务请求已超时，请稍后显式重试。',
  transport: '无法连接来源服务，请检查连接后重试。',
  status: '来源服务拒绝了请求，请检查服务状态或凭据。',
  response: '来源返回了无法识别的数据。',
  budget: '来源响应超过安全预算，请缩小查询范围。',
  candidate: '封面候选已失效或不符合图片安全规则，请重新查询。',
}

export class LocalProviderError extends Error {
  readonly code: LocalProviderErrorCode
  constructor(code: LocalProviderErrorCode) {
    super(messages[code])
    this.name = 'LocalProviderError'
    this.code = code
  }
}
export function fail(code: LocalProviderErrorCode): never { throw new LocalProviderError(code) }
export function safeProviderError(error: unknown, signal?: AbortSignal): LocalProviderError {
  if (signal?.aborted) return new LocalProviderError(signal.reason === 'provider-timeout' ? 'timeout' : 'cancelled')
  return error instanceof LocalProviderError ? error : new LocalProviderError('transport')
}
export function checkSignal(signal: AbortSignal): void { if (signal.aborted) throw safeProviderError(null, signal) }

export function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(safeProviderError(null, signal))
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(safeProviderError(null, signal))
    signal.addEventListener('abort', abort, { once: true })
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort)).catch(() => {})
    if (signal.aborted) abort()
  })
}

export function deadline(parent: AbortSignal | undefined, milliseconds: number) {
  const controller = new AbortController()
  const abort = () => controller.abort('provider-cancelled')
  parent?.addEventListener('abort', abort, { once: true })
  if (parent?.aborted) abort()
  const timer = setTimeout(() => controller.abort('provider-timeout'), milliseconds)
  return {
    controller,
    signal: controller.signal,
    dispose() { clearTimeout(timer); parent?.removeEventListener('abort', abort) },
  }
}

export function boundedInteger(value: number | undefined, fallback: number, maximum: number): number {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) return fail('configuration')
  return value
}
export function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}
export function parseJson(value: string): unknown {
  try { return JSON.parse(value) as unknown } catch { return fail('response') }
}
export function utf8(bytes: Uint8Array): string {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch { return fail('response') }
}
export function queryText(value: unknown): string {
  if (typeof value !== 'string') return fail('input')
  const text = value.trim()
  if (!text || Buffer.byteLength(text, 'utf8') > 512 || /[\u0000-\u001f\u007f\\]/u.test(text)
    || /(?:https?:|file:|data:|javascript:)/iu.test(text) || /^(?:\/|~\/|[a-z]:[\/\\])/iu.test(text)) return fail('input')
  return text
}

/** 有界纯文本仅用于展示；不展开 HTML、不执行内嵌脚本，也不保留地址形态的元数据。 */
export function displayText(value: unknown, maximum = 512): string | null {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > maximum * 4) return null
  const text = value.replace(/<(script|style|iframe|object)\b[^>]*>[\s\S]*?<\/\1\s*>/giu, ' ')
    .replace(/<[^>]*>/gu, ' ').replace(/&(?:nbsp|amp|lt|gt|quot|apos);/giu, entity => ({
      '&nbsp;': ' ', '&amp;': '&', '&lt;': '', '&gt;': '', '&quot;': '"', '&apos;': "'",
    }[entity.toLowerCase()] ?? ' ')).replace(/[<>\u0000-\u001f\u007f]/gu, ' ').replace(/\s+/gu, ' ').trim()
  if (!text || Buffer.byteLength(text, 'utf8') > maximum || /(?:https?:\/\/|data:|file:|javascript:)/iu.test(text)) return null
  return text
}
