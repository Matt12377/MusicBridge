import { isRoonDisplayLyricsEvent, type LyricsSnapshot, type RoonDisplayLyricsEvent } from '@music-bridge/contracts';
import { emptyLyricsSnapshot, parseLyricsResponse } from '../netease/lyrics.js';
import { createLocalTrackSignature } from '../lyrics-matching/signature.js';
import type { LyricsRequestContext } from './coordinator.js';

/** 只保留每个 Zone 当前歌词；切歌/断连作废，不写磁盘，也不跨曲目猜测。 */
export class RoonDisplayLyricsStore {
  enabled = false;
  private readonly zones = new Map<string, Extract<RoonDisplayLyricsEvent, { type: 'zone' }>>();

  update(event: RoonDisplayLyricsEvent): void {
    if (!isRoonDisplayLyricsEvent(event)) throw new TypeError('Roon Display 歌词消息无效');
    if (event.type === 'reset') {
      this.enabled = event.enabled;
      this.zones.clear();
      return;
    }
    if (!this.enabled) return;
    this.zones.delete(event.zoneId);
    this.zones.set(event.zoneId, structuredClone(event));
    if (this.zones.size > 32) this.zones.delete(this.zones.keys().next().value!);
  }

  read(context: Extract<LyricsRequestContext, { kind: 'local' }>): LyricsSnapshot | undefined {
    if (!this.enabled) return undefined;
    const unavailable = (): LyricsSnapshot => ({ ...emptyLyricsSnapshot('unavailable'), source: 'roon-display' });
    const zone = context.zoneId ? this.zones.get(context.zoneId) : undefined;
    if (!zone?.track || !zone.lrc) return unavailable();
    const track = zone.track;
    try {
      const observed = createLocalTrackSignature({ title: track.title, artists: [track.artist], album: track.album, durationMs: track.durationMs }).canonical;
      const expected = context.signature.canonical;
      if (observed.title !== expected.title || JSON.stringify(observed.artists) !== JSON.stringify(expected.artists)
        || (expected.album !== null && observed.album !== expected.album)
        || (expected.durationMs !== null && Math.abs(track.durationMs - expected.durationMs) > 2000)) return unavailable();
      // 复用有界 LRC 解析器；这里不进行 Provider 请求，也不附带网易云来源。
      return { ...parseLyricsResponse({ code: 200, lrc: { lyric: zone.lrc } }), source: 'roon-display' };
    } catch { return unavailable(); }
  }
}
