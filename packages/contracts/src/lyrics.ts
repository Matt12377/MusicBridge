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
}
