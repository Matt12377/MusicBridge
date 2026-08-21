import type { PlaybackSnapshot, PublicBridgeState } from '@music-bridge/contracts'

export const TRAY_ACTION_LABELS = [
  'Open Music Bridge',
  'Previous',
  'Next',
  'Stop',
  'Show Queue',
  'Export Diagnostics',
  'Quit Music Bridge',
] as const

export interface TraySnapshot {
  bridge: PublicBridgeState
  playback: PlaybackSnapshot
}

export interface TrayPresentation {
  statusLabel: string
  trackLabel: string
  actionLabels: readonly string[]
}

function publicText(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback
  const sanitized = value
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/(?:https?|file):\/\/\S+/gi, '[hidden]')
    .replace(/[?&][A-Za-z0-9_-]+=[^\s]+/g, '[hidden]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 96)
  return sanitized || fallback
}

function trackSummary(snapshot: PlaybackSnapshot): string {
  const track = snapshot.currentTrack
  if (!track) return 'Now Playing: idle'

  const title = publicText(track.title, 'Untitled')
  const artists = track.artists
    .map((artist) => publicText(artist, 'Unknown artist'))
    .filter((artist) => artist !== 'Unknown artist')
    .join('、')
  const album = publicText(track.album, 'Unknown album')
  const suffix = artists ? ` · ${artists}` : ''
  return `Now Playing: ${title}${suffix} · ${album}`.slice(0, 240)
}

export function buildTrayPresentation(snapshot: TraySnapshot): TrayPresentation {
  return {
    statusLabel: `Bridge: ${snapshot.bridge.runtime} · Roon: ${snapshot.bridge.roon} · Provider: ${snapshot.bridge.provider}`,
    trackLabel: trackSummary(snapshot.playback),
    actionLabels: TRAY_ACTION_LABELS,
  }
}

export function shouldHideWindowOnClose(isQuitting: boolean): boolean {
  return !isQuitting
}
