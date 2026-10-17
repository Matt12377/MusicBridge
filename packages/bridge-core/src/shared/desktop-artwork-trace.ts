import { LOCAL_ALBUM_TRACE_CODES } from './library-read-trace.js'

declare const __MUSIC_BRIDGE_PRIVATE_DESKTOP_ARTWORK__: boolean
/** 只由显式 once 诊断构建开启；普通启动无需环境变量、偏好或调试端口。 */
export const desktopArtworkTraceEnabled = typeof __MUSIC_BRIDGE_PRIVATE_DESKTOP_ARTWORK__ === 'boolean' && __MUSIC_BRIDGE_PRIVATE_DESKTOP_ARTWORK__
export const DESKTOP_ARTWORK_PREFIX = '[desktop:artwork:v1] '
export const DESKTOP_ARTWORK_STAGES = ['request', 'ram-hit', 'ram-evict', 'inflight-join', 'queue', 'reply', 'late', 'disk-hit', 'disk-miss', 'disk-put', 'disk-skip', 'disk-disable', 'source-read', 'source-extract', 'normalize', 'native-decode', 'revalidate', 'count-refresh', 'grid-hit', 'grid-create', 'grid-skip', 'img-load', 'img-error', 'observer-truncated'] as const
export const DESKTOP_ARTWORK_REASONS = ['none', 'no-cache', 'no-proof', 'expired', 'busy', 'invalid', 'not-found', 'row-invalid', 'disabled', 'closed', 'retired', 'capacity', 'space', 'unresolved', 'get', 'put', 'open', 'cleanup', 'remove', 'source-changed', 'error', 'evicted', 'cancelled'] as const
export type DesktopArtworkStage = typeof DESKTOP_ARTWORK_STAGES[number]
export type DesktopArtworkReason = typeof DESKTOP_ARTWORK_REASONS[number]
export interface DesktopArtworkEvent {
  version: 1
  origin: 'core' | 'main' | 'renderer'
  stage: DesktopArtworkStage
  keySha256: string | null
  requestSha256: string | null
  atMs: number
  elapsedMs: number
  bytes: number
  decodedBytes: number
  count: number
  reason: DesktopArtworkReason
  code: typeof LOCAL_ALBUM_TRACE_CODES[number]
}
export type DesktopArtworkMetrics = Partial<Pick<DesktopArtworkEvent, 'elapsedMs' | 'bytes' | 'decodedBytes' | 'count' | 'reason' | 'code'>>
export interface DesktopArtworkSnapshot {
  schema: 'desktop-artwork.v1'
  records: DesktopArtworkEvent[]
  totals: Record<DesktopArtworkStage, number>
  droppedRecords: number
  truncated: boolean
  totalsComplete: boolean
}
const fields = ['version', 'origin', 'stage', 'keySha256', 'requestSha256', 'atMs', 'elapsedMs', 'bytes', 'decodedBytes', 'count', 'reason', 'code'] as const
const digest = (value: unknown): value is string | null => value === null || typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value)
const number = (value: unknown, max: number): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= max
function dataObject(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false
  const descriptors = Object.getOwnPropertyDescriptors(value)
  return Reflect.ownKeys(descriptors).length === keys.length && keys.every(key => descriptors[key]?.enumerable === true && Object.hasOwn(descriptors[key]!, 'value'))
}
/** 输入必须是自有闭集数据；Node 收集边界另拒绝 Proxy，字符串边界仅解析有界 JSON。 */
export function copyDesktopArtworkEvent(value: unknown): DesktopArtworkEvent | null {
  try {
    if (!dataObject(value, fields) || value.version !== 1 || !['core', 'main', 'renderer'].includes(value.origin as string)
      || !DESKTOP_ARTWORK_STAGES.includes(value.stage as DesktopArtworkStage) || !digest(value.keySha256) || !digest(value.requestSha256)
      || !number(value.atMs, 8_640_000_000_000_000) || !Number.isSafeInteger(value.atMs) || !number(value.elapsedMs, 86_400_000) || !number(value.bytes, 1_099_511_627_776) || !number(value.decodedBytes, 1_099_511_627_776)
      || !number(value.count, Number.MAX_SAFE_INTEGER) || !Number.isSafeInteger(value.count)
      || !DESKTOP_ARTWORK_REASONS.includes(value.reason as DesktopArtworkReason) || !LOCAL_ALBUM_TRACE_CODES.includes(value.code as DesktopArtworkEvent['code'])) return null
    return { version: 1, origin: value.origin as DesktopArtworkEvent['origin'], stage: value.stage as DesktopArtworkStage,
      keySha256: value.keySha256, requestSha256: value.requestSha256, atMs: value.atMs, elapsedMs: value.elapsedMs, bytes: value.bytes,
      decodedBytes: value.decodedBytes, count: value.count, reason: value.reason as DesktopArtworkReason, code: value.code as DesktopArtworkEvent['code'] }
  } catch { return null }
}
/** 对有界身份元组计算UTF-8 SHA-256；不把原身份写入诊断。 */
export function desktopArtworkIdentitySha256(value: string): string | null {
  if (typeof value !== 'string' || value.length > 4096) return null
  try {
    const rounds = [
      0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
      0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
      0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
      0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
      0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
      0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
      0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
      0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2,
    ]
    const initial = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19]
    const words = new Uint32Array(64), rotate = (word: number, shift: number): number => word >>> shift | word << 32 - shift
    const input = new TextEncoder().encode(value), padded = new Uint8Array(Math.ceil((input.length + 9) / 64) * 64)
    padded.set(input); padded[input.length] = 0x80
    const view = new DataView(padded.buffer); view.setUint32(padded.length - 4, input.length * 8)
    for (let offset = 0; offset < padded.length; offset += 64) {
      words.fill(0)
      for (let index = 0; index < 16; index++) words[index] = view.getUint32(offset + index * 4)
    for (let index = 16; index < 64; index++) {
      const left = words[index - 15]!, right = words[index - 2]!
      const sigma0 = rotate(left,7) ^ rotate(left,18) ^ left >>> 3, sigma1 = rotate(right,17) ^ rotate(right,19) ^ right >>> 10
      words[index] = (words[index - 16]! + sigma0 + words[index - 7]! + sigma1) >>> 0
    }
    let a = initial[0]!, b = initial[1]!, c = initial[2]!, d = initial[3]!, e = initial[4]!, f = initial[5]!, g = initial[6]!, h = initial[7]!
    for (let index = 0; index < 64; index++) {
      const sum1 = rotate(e,6) ^ rotate(e,11) ^ rotate(e,25), choose = e & f ^ ~e & g
      const first = (h + sum1 + choose + rounds[index]! + words[index]!) >>> 0
      const sum0 = rotate(a,2) ^ rotate(a,13) ^ rotate(a,22), majority = a & b ^ a & c ^ b & c, second = (sum0 + majority) >>> 0
      h = g; g = f; f = e; e = (d + first) >>> 0; d = c; c = b; b = a; a = (first + second) >>> 0
    }
      for (const [index, word] of [a,b,c,d,e,f,g,h].entries()) initial[index] = (initial[index]! + word) >>> 0
    }
    return initial.map(word => word.toString(16).padStart(8,'0')).join('')
  } catch { return null }
}

export function desktopArtworkKey(identity: string): string | null {
  try { return desktopArtworkTraceEnabled ? desktopArtworkIdentitySha256(identity) : null } catch { return null }
}
export function desktopArtworkStarted(): number { try { return desktopArtworkTraceEnabled ? performance.now() : 0 } catch { return 0 } }
export function desktopArtworkElapsed(started: number): number { try { return started > 0 ? Math.max(0, performance.now() - started) : 0 } catch { return 0 } }
const rendererEmissions = new Map<string, number>()
let rendererRecords = 0, rendererTruncated = false
export function emitRendererArtwork(stage: DesktopArtworkStage, keySha256: string | null = null, metrics: DesktopArtworkMetrics = {}): void {
  if (!desktopArtworkTraceEnabled) return
  try {
    const safe = copyDesktopArtworkEvent({ version: 1, origin: 'renderer', stage, keySha256, requestSha256: null,
      atMs: Date.now(), elapsedMs: 0, bytes: 0, decodedBytes: 0, count: 1, reason: 'none', code: 'UNKNOWN', ...metrics })
    if (!safe || rendererTruncated) return
    const key = `${stage}:${keySha256 ?? 'none'}`, prior = rendererEmissions.get(key) ?? 0
    if (rendererRecords >= 8192 || prior >= 8 && keySha256 !== null || !rendererEmissions.has(key) && rendererEmissions.size >= 2048) {
      rendererTruncated = true
      console.info(DESKTOP_ARTWORK_PREFIX + JSON.stringify({ ...safe, stage: 'observer-truncated', count: 1, reason: 'capacity' }))
      return
    }
    rendererEmissions.set(key, prior + 1); rendererRecords++
    console.info(DESKTOP_ARTWORK_PREFIX + JSON.stringify(safe))
  } catch { /* 旁注不能改变请求、显示或原事件。 */ }
}
export function readDesktopArtworkLine(line: string): DesktopArtworkEvent | null {
  try { return line.length <= 1536 && line.startsWith(DESKTOP_ARTWORK_PREFIX) ? copyDesktopArtworkEvent(JSON.parse(line.slice(DESKTOP_ARTWORK_PREFIX.length))) : null } catch { return null }
}
export function copyDesktopArtworkSnapshot(value: unknown): DesktopArtworkSnapshot | null {
  try {
    if (!dataObject(value, ['schema', 'records', 'totals', 'droppedRecords', 'truncated', 'totalsComplete']) || value.schema !== 'desktop-artwork.v1'
      || !Array.isArray(value.records) || Object.getPrototypeOf(value.records) !== Array.prototype || value.records.length > 512
      || Reflect.ownKeys(value.records).length !== value.records.length + 1 || !dataObject(value.totals, DESKTOP_ARTWORK_STAGES)
      || !number(value.droppedRecords, Number.MAX_SAFE_INTEGER) || !Number.isSafeInteger(value.droppedRecords) || value.truncated !== (value.droppedRecords > 0) || typeof value.totalsComplete !== 'boolean') return null
    const records: DesktopArtworkEvent[] = []
    for (let index = 0; index < value.records.length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(value.records, String(index))
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return null
      const row = copyDesktopArtworkEvent(descriptor.value); if (!row) return null; records.push(row)
    }
    const totals = Object.create(null) as Record<DesktopArtworkStage, number>
    for (const stage of DESKTOP_ARTWORK_STAGES) { const total = value.totals[stage]; if (!number(total, Number.MAX_SAFE_INTEGER) || !Number.isSafeInteger(total)) return null; totals[stage] = total }
    return { schema: 'desktop-artwork.v1', records, totals, droppedRecords: value.droppedRecords, truncated: value.truncated as boolean, totalsComplete: value.totalsComplete }
  } catch { return null }
}
