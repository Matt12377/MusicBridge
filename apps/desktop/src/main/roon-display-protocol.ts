import { isRoonDisplayLyricsEvent, isRoonDisplayTrack, type RoonDisplayLyricsEvent, type RoonDisplayTrack } from '@music-bridge/contracts'

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)

/** 只解析已建立的官方 Display 连接；不注册扩展、不伪装官方身份、不处理令牌。 */
export class RoonDisplayProtocol {
  private readonly zones = new Map<string, RoonDisplayTrack | null>()

  clear(): void { this.zones.clear() }

  receive(payload: string, opcode: number): RoonDisplayLyricsEvent[] {
    if (![1, 2].includes(opcode) || payload.length > 1024 * 1024) return []
    const frame = opcode === 2 ? Buffer.from(payload, 'base64').toString('utf8') : payload
    const boundary = /\r?\n\r?\n/u.exec(frame)
    if (!boundary || boundary.index > 4096) return []
    const header = frame.slice(0, boundary.index)
    const match = /^MOO\/1 CONTINUE (Subscribed|Changed|LyricsChanged)\r?\n/u.exec(header + '\n')
    if (!match) return []
    let body: unknown
    try { body = JSON.parse(frame.slice(boundary.index + boundary[0].length)) } catch { return [] }
    if (!record(body)) return []
    const events: RoonDisplayLyricsEvent[] = []
    const add = (event: RoonDisplayLyricsEvent) => { if (isRoonDisplayLyricsEvent(event)) events.push(event) }
    if (match[1] === 'LyricsChanged') {
      if (typeof body.zone_id !== 'string' || !this.zones.has(body.zone_id)) return []
      add({ type: 'zone', zoneId: body.zone_id, track: this.zones.get(body.zone_id) ?? null, lrc: typeof body.lrc === 'string' && body.lrc.length <= 512 * 1024 ? body.lrc : null })
      return events
    }
    if (match[1] === 'Subscribed') {
      if (!Array.isArray(body.zones)) return []
      this.clear()
      events.push({ type: 'reset', enabled: true })
    }
    if (Array.isArray(body.zones_removed)) for (const id of body.zones_removed.slice(0, 32)) {
      if (typeof id !== 'string') continue
      this.zones.delete(id)
      add({ type: 'zone', zoneId: id, track: null, lrc: null })
    }
    for (const field of ['zones', 'zones_added', 'zones_changed']) {
      const list = body[field]
      if (!Array.isArray(list)) continue
      for (const item of list.slice(0, 32)) {
        if (!record(item) || typeof item.zone_id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/u.test(item.zone_id)) continue
        const hasNowPlaying = Object.hasOwn(item, 'now_playing')
        // 已知区域的增量消息可只包含其他状态；新增区域和完整快照没有曲目则为空。
        if (!hasNowPlaying && field === 'zones_changed' && this.zones.has(item.zone_id)) continue
        let track: RoonDisplayTrack | null = null
        if (hasNowPlaying && item.now_playing !== null) {
          if (!record(item.now_playing)) continue
          const np = item.now_playing
          const lines = record(np.three_line) ? np.three_line : undefined
          const candidate = { title: lines?.line1, artist: lines?.line2 ?? '', album: lines?.line3 ?? '', durationMs: typeof np.length === 'number' ? Math.round(np.length * 1000) : 0 }
          if (!isRoonDisplayTrack(candidate)) continue
          track = candidate
        }
        if (!this.zones.has(item.zone_id) || JSON.stringify(this.zones.get(item.zone_id)) !== JSON.stringify(track)) {
          if (this.zones.size >= 32 && !this.zones.has(item.zone_id)) continue
          this.zones.set(item.zone_id, track)
          add({ type: 'zone', zoneId: item.zone_id, track, lrc: null })
        }
      }
    }
    return events
  }
}
