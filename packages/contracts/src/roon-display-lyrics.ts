/** 仅 Main → Core 使用；不传递 Web Display 的令牌、LRC key 或原始协议帧。 */
export interface RoonDisplayTrack {
  title: string
  artist: string
  album: string
  durationMs: number
}

export type RoonDisplayLyricsEvent =
  | { type: 'reset'; enabled: boolean }
  | { type: 'zone'; zoneId: string; track: RoonDisplayTrack | null; lrc: string | null }

export interface RoonDisplaySettings {
  url: string
  status: 'disabled' | 'connecting' | 'connected' | 'disconnected' | 'error'
}

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const keys = (value: Record<string, unknown>, expected: string[]) => Object.keys(value).length === expected.length && expected.every(key => Object.hasOwn(value, key))
const text = (value: unknown, max: number) => typeof value === 'string' && value.length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(value)

export function isRoonDisplayTrack(value: unknown): value is RoonDisplayTrack {
  return record(value) && keys(value, ['title', 'artist', 'album', 'durationMs'])
    && text(value.title, 512) && typeof value.title === 'string' && value.title.trim().length > 0
    && text(value.artist, 512) && text(value.album, 512)
    && typeof value.durationMs === 'number' && Number.isSafeInteger(value.durationMs)
    && value.durationMs >= 0 && value.durationMs <= 86_400_000
}

export function isRoonDisplayLyricsEvent(value: unknown): value is RoonDisplayLyricsEvent {
  if (!record(value)) return false
  if (value.type === 'reset') return keys(value, ['type', 'enabled']) && typeof value.enabled === 'boolean'
  return value.type === 'zone' && keys(value, ['type', 'zoneId', 'track', 'lrc'])
    && typeof value.zoneId === 'string' && /^[A-Za-z0-9_-]{1,128}$/u.test(value.zoneId)
    && (value.track === null || isRoonDisplayTrack(value.track))
    && (value.lrc === null || text(value.lrc, 512 * 1024))
}

/** 只允许明确的局域网地址，禁止凭据、查询参数、任意页面或公网跳转。 */
export function normalizeRoonDisplayUrl(value: unknown): string {
  if (value === '') return ''
  if (typeof value !== 'string' || value.length > 512) throw new Error('请输入局域网 Roon Web Display 地址。')
  let url: URL
  try { url = new URL(value.trim()) } catch { throw new Error('Roon Web Display 地址格式不正确。') }
  const host = url.hostname
  const parts = host.split('.').map(Number)
  const ipv4 = /^\d+\.\d+\.\d+\.\d+$/u.test(host) && parts.every(part => Number.isInteger(part) && part >= 0 && part <= 255)
  const local = host === 'localhost' || (ipv4 && (parts[0] === 10 || parts[0] === 127
    || (parts[0] === 192 && parts[1] === 168) || (parts[0] === 172 && parts[1]! >= 16 && parts[1]! <= 31)))
  if (!local || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash
    || !['/display', '/display/'].includes(url.pathname)) throw new Error('只支持不含凭据的局域网 /display/ 地址。')
  url.pathname = '/display/'
  return url.href
}
