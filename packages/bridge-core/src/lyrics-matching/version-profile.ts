import { normalizeLyricsText } from './normalize.js'
import type { LyricsRecordingIdentity } from './types.js'

export type LyricsVersionAxis = 'performance' | 'mix' | 'vocal' | 'authorship' | 'release'

export interface LyricsVersionProfile {
  performance: 'studio' | 'live'
  mix: 'original' | 'remix'
  vocal: 'vocal' | 'instrumental'
  authorship: 'original' | 'cover'
  release: 'final' | 'demo'
}

export interface LyricsVersionConflict {
  axis: LyricsVersionAxis
  recordingValue: LyricsVersionProfile[LyricsVersionAxis]
  candidateValue: LyricsVersionProfile[LyricsVersionAxis]
}

const SPECIAL_MARKERS = {
  performance: [/(?:^|\s)live(?:\s|$)/gu, /现场/gu, /演唱会版?/gu],
  mix: [/(?:^|\s)remix(?:ed)?(?:\s|$)/gu, /混音/gu],
  vocal: [/(?:^|\s)instrumental(?:\s|$)/gu, /纯音乐/gu, /伴奏/gu, /器乐/gu],
  authorship: [/(?:^|\s)cover(?:ed)?(?:\s|$)/gu, /翻唱/gu],
  release: [/(?:^|\s)demo(?:\s|$)/gu, /演示/gu, /样带/gu],
} as const

const DEFAULT_MARKERS = {
  performance: [/(?:^|\s)studio(?:\s|$)/gu, /录音室/gu],
  mix: [/(?:^|\s)original(?:\s+mix)?(?:\s|$)/gu, /原始混音/gu],
  vocal: [/(?:^|\s)vocal(?:\s|$)/gu, /人声/gu],
  authorship: [/(?:^|\s)original(?:\s|$)/gu, /原唱/gu, /原版/gu],
  release: [/(?:^|\s)final(?:\s|$)/gu, /正式版/gu],
} as const

const ALL_MARKERS = [
  ...Object.values(SPECIAL_MARKERS).flat(),
  ...Object.values(DEFAULT_MARKERS).flat(),
]

function identityVersionText(identity: LyricsRecordingIdentity): string {
  return normalizeLyricsText(`${identity.title} ${identity.album ?? ''} ${identity.version ?? ''}`)
}

function hasAny(value: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => {
    pattern.lastIndex = 0
    return pattern.test(value)
  })
}

export function buildLyricsVersionProfile(identity: LyricsRecordingIdentity): LyricsVersionProfile {
  const value = identityVersionText(identity)
  return {
    performance: hasAny(value, SPECIAL_MARKERS.performance) ? 'live' : 'studio',
    mix: hasAny(value, SPECIAL_MARKERS.mix) ? 'remix' : 'original',
    vocal: hasAny(value, SPECIAL_MARKERS.vocal) ? 'instrumental' : 'vocal',
    authorship: hasAny(value, SPECIAL_MARKERS.authorship) ? 'cover' : 'original',
    release: hasAny(value, SPECIAL_MARKERS.release) ? 'demo' : 'final',
  }
}

export function findLyricsVersionConflicts(
  recording: LyricsVersionProfile,
  candidate: LyricsVersionProfile,
): readonly LyricsVersionConflict[] {
  const axes: readonly LyricsVersionAxis[] = ['performance', 'mix', 'vocal', 'authorship', 'release']
  return axes
    .filter((axis) => recording[axis] !== candidate[axis])
    .map((axis) => ({
      axis,
      recordingValue: recording[axis],
      candidateValue: candidate[axis],
    }))
}

export function lyricsVersionProfileKey(profile: LyricsVersionProfile): string {
  return [profile.performance, profile.mix, profile.vocal, profile.authorship, profile.release].join('|')
}

export function normalizeLyricsBaseTitle(value: string): string {
  let normalized = ` ${normalizeLyricsText(value)} `
  for (const marker of ALL_MARKERS) {
    marker.lastIndex = 0
    normalized = normalized.replace(marker, ' ')
  }
  return normalized.replace(/\s+/gu, ' ').trim()
}
