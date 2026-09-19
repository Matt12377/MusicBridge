import { isRoonDisplayLyricsEvent, type LyricsSnapshot, type RoonDisplayLyricsEvent, type RoonDisplayTrack } from '@music-bridge/contracts';
import { emptyLyricsSnapshot, parseLyricsResponse } from '../netease/lyrics.js';
import { createLocalTrackSignature } from '../lyrics-matching/signature.js';
import type { LyricsRequestContext } from './coordinator.js';

/** 只保留每个 Zone 当前歌词；切歌/断连作废，不写磁盘，也不跨曲目猜测。 */
export class RoonDisplayLyricsStore {
  enabled = false;
  private readonly zones = new Map<string, Extract<RoonDisplayLyricsEvent, { type: 'zone' }>>();

  constructor(private readonly getTransportObservation?: () => { zoneId: string; track: RoonDisplayTrack } | undefined) {}

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
      if (observed.title !== expected.title
        || (expected.album !== null && observed.album !== expected.album)
        || (expected.durationMs !== null && Math.abs(track.durationMs - expected.durationMs) > 2000)) return unavailable();
      if (JSON.stringify(observed.artists) !== JSON.stringify(expected.artists)) {
        // Browse 的艺人可能包含制作人员，Display 只给主艺人。仅在独立 Transport
        // 观测完整佐证 Display 身份且主艺人属于列表艺人时接受，不进行模糊匹配。
        const transport = this.getTransportObservation?.();
        if (!transport || transport.zoneId !== context.zoneId) return unavailable();
        const trusted = createLocalTrackSignature({ ...transport.track, artists: [transport.track.artist] }).canonical;
        if (trusted.title !== observed.title || trusted.album !== observed.album
          || JSON.stringify(trusted.artists) !== JSON.stringify(observed.artists)
          || Math.abs(transport.track.durationMs - track.durationMs) > 2000
          || !observed.artists.every(artist => expected.artists.includes(artist))) return unavailable();
      }
      // 复用有界 LRC 解析器；这里不进行 Provider 请求，也不附带网易云来源。
      return { ...parseLyricsResponse({ code: 200, lrc: { lyric: zone.lrc } }), source: 'roon-display' };
    } catch { return unavailable(); }
  }
}
