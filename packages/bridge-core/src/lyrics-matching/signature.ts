export interface LocalTrackSignatureInput {
  title: string
  artists: readonly string[]
  album?: string
  durationMs?: number
  version?: string
}

export interface CanonicalLocalTrackSignature {
  title: string
  artists: readonly string[]
  album: string | null
  durationMs: number | null
  version: string | null
}

export interface LocalTrackSignature {
  key: string
  canonical: CanonicalLocalTrackSignature
}

export function createLocalTrackSignature(input: LocalTrackSignatureInput): LocalTrackSignature {
  const title = normalizeLyricsText(input.title)
  const artists = normalizeLyricsArtists(input.artists)
  if (!title || title.length > MAX_SIGNATURE_TEXT_LENGTH) throw new TypeError('Invalid local track title')
  if (artists.length === 0 || artists.length > MAX_SIGNATURE_ARTISTS
    || artists.some((artist) => artist.length > MAX_SIGNATURE_TEXT_LENGTH)) {
    throw new TypeError('Invalid local track artists')
  }
  const normalizeOptional = (value: string | undefined, field: string): string | null => {
    if (value === undefined) return null
    const normalized = normalizeLyricsText(value)
    if (normalized.length > MAX_SIGNATURE_TEXT_LENGTH) throw new TypeError(`Invalid local track ${field}`)
    return normalized || null
  }
  if (input.durationMs !== undefined
    && (!Number.isSafeInteger(input.durationMs) || input.durationMs < 0)) {
    throw new TypeError('Invalid local track duration')
  }
  const canonical: CanonicalLocalTrackSignature = {
    title,
    artists,
    album: normalizeOptional(input.album, 'album'),
    durationMs: input.durationMs === undefined ? null : Math.round(input.durationMs / 1_000) * 1_000,
    version: normalizeOptional(input.version, 'version'),
  }
  return {
    key: createHash('sha256').update(JSON.stringify(canonical)).digest('hex').slice(0, 32),
    canonical,
  }
}
import { createHash } from 'node:crypto'
import { normalizeLyricsArtists, normalizeLyricsText } from './normalize.js'

const MAX_SIGNATURE_TEXT_LENGTH = 512
const MAX_SIGNATURE_ARTISTS = 64
