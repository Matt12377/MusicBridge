export const LYRICS_STATUSES = [
  'idle',
  'loading',
  'ready',
  'instrumental',
  'unavailable',
  'error',
] as const

export type LyricsStatus = (typeof LYRICS_STATUSES)[number]

export const LYRICS_TIMING_SOURCES = ['roon-time', 'estimated', 'static'] as const

export type LyricsTimingSource = (typeof LYRICS_TIMING_SOURCES)[number]

export interface LyricWord {
  startMs: number
  endMs: number
  text: string
}

export interface LyricLine {
  startMs: number
  endMs?: number
  text: string
  translation?: string
  romanization?: string
  words?: readonly LyricWord[]
}

export interface LyricsSnapshot {
  status: LyricsStatus
  lines: readonly LyricLine[]
  activeLineIndex: number
  activeWordIndex?: number
  timingSource: LyricsTimingSource
  /** 歌词正文来源；只公开产品来源，不公开匹配证据或置信度。 */
  source?: 'netease'
}

export const LOCAL_LYRICS_MATCH_STATUSES = [
  'hidden',
  'searching',
  'matched',
  'needs-choice',
  'no-match',
  'no-lyrics',
  'provider-unavailable',
  'network-error',
] as const

export type LocalLyricsMatchStatus = (typeof LOCAL_LYRICS_MATCH_STATUSES)[number]

/** Renderer 可见的候选；candidateId 是短期会话内的不透明标识。 */
export interface LocalLyricsMatchCandidate {
  candidateId: string
  title: string
  artists: readonly string[]
  album?: string
  durationMs?: number
}

/** 当前播放曲目的有界歌词匹配状态，不含签名、搜索原文或工程置信信息。 */
export interface LocalLyricsMatchSnapshot {
  status: LocalLyricsMatchStatus
  candidates: readonly LocalLyricsMatchCandidate[]
  canRevoke: boolean
  matchSessionId?: string
}
