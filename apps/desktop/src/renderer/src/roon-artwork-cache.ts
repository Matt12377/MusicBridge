import {
  isValidRoonImageBinary,
  type RoonImageFormat,
  type RoonImageResult,
  type RoonImageScale,
} from '@music-bridge/contracts'

const DEFAULT_MAX_ENTRIES = 128
const DEFAULT_NEGATIVE_TTL_MS = 3_000

export interface RoonArtworkRequest {
  reference: string
  width: number
  height: number
  scale: RoonImageScale
  format: RoonImageFormat
}

export interface RoonArtworkLease {
  readonly url: string
  release(): void
  invalidate(): void
}

interface ArtworkEntry {
  readonly key: string
  readonly url: string
  leases: number
  cached: boolean
  invalid: boolean
  revoked: boolean
}

interface NegativeEntry {
  readonly error: Error
  readonly expiresAt: number
}

export interface RoonArtworkCacheDependencies {
  getImage?: (reference: string, options: {
    width: number
    height: number
    scale: RoonImageScale
    format: RoonImageFormat
  }) => Promise<RoonImageResult>
  createObjectUrl?: (body: Uint8Array, contentType: string) => string
  revokeObjectUrl?: (url: string) => void
  decodeObjectUrl?: (url: string) => Promise<void>
  now?: () => number
  maxEntries?: number
  negativeTtlMs?: number
}

export interface RoonArtworkCache {
  acquire(request: RoonArtworkRequest): Promise<RoonArtworkLease>
  clear(): void
}

function requireBoundedInteger(
  value: number | undefined,
  fallback: number,
  maximum: number,
  name: string,
): number {
  const resolved = value ?? fallback
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > maximum) {
    throw new TypeError(`${name} is invalid`)
  }
  return resolved
}

function requestKey(request: RoonArtworkRequest): string {
  if (!/^musicbridge-v2-(?:image|entity)-[0-9a-f-]{36}$/u.test(request.reference)) {
    throw new TypeError('Roon artwork reference is invalid')
  }
  if (
    !Number.isSafeInteger(request.width)
    || !Number.isSafeInteger(request.height)
    || request.width < 16
    || request.height < 16
    || request.width > 4_096
    || request.height > 4_096
  ) {
    throw new TypeError('Roon artwork dimensions are invalid')
  }
  return JSON.stringify([
    request.reference,
    request.width,
    request.height,
    request.format,
    request.scale,
  ])
}

function defaultCreateObjectUrl(body: Uint8Array, contentType: string): string {
  const bytes = new Uint8Array(body)
  return URL.createObjectURL(new Blob([bytes.buffer], { type: contentType }))
}

function defaultDecodeObjectUrl(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.decoding = 'async'
    image.onload = () => resolve()
    image.onerror = () => reject(new Error('Roon artwork decode failed'))
    image.src = url
  })
}

export function createRoonArtworkCache(
  dependencies: RoonArtworkCacheDependencies = {},
): RoonArtworkCache {
  const getImage = dependencies.getImage
    ?? ((reference, options) => window.musicBridge.getRoonImage(reference, options))
  const createObjectUrl = dependencies.createObjectUrl ?? defaultCreateObjectUrl
  const revokeObjectUrl = dependencies.revokeObjectUrl ?? URL.revokeObjectURL.bind(URL)
  const decodeObjectUrl = dependencies.decodeObjectUrl ?? defaultDecodeObjectUrl
  const now = dependencies.now ?? Date.now
  const maxEntries = requireBoundedInteger(
    dependencies.maxEntries,
    DEFAULT_MAX_ENTRIES,
    512,
    'Roon artwork cache entry limit',
  )
  const negativeTtlMs = requireBoundedInteger(
    dependencies.negativeTtlMs,
    DEFAULT_NEGATIVE_TTL_MS,
    60_000,
    'Roon artwork negative-cache TTL',
  )
  const entries = new Map<string, ArtworkEntry>()
  const pending = new Map<string, Promise<ArtworkEntry>>()
  const negative = new Map<string, NegativeEntry>()
  let generation = 0

  const revoke = (entry: ArtworkEntry): void => {
    if (entry.revoked) return
    entry.revoked = true
    revokeObjectUrl(entry.url)
  }

  const touch = (key: string, entry: ArtworkEntry): void => {
    if (!entry.cached) return
    entries.delete(key)
    entries.set(key, entry)
  }

  const removeEntry = (entry: ArtworkEntry): void => {
    if (entries.get(entry.key) === entry) entries.delete(entry.key)
    entry.cached = false
    revoke(entry)
  }

  const reserveCacheSlot = (): boolean => {
    while (entries.size >= maxEntries) {
      const candidate = [...entries.values()].find((entry) => entry.leases === 0)
      if (!candidate) return false
      removeEntry(candidate)
    }
    return true
  }

  const createLease = (entry: ArtworkEntry): RoonArtworkLease => {
    if (entry.invalid || entry.revoked) throw new Error('Roon artwork cache entry is unavailable')
    entry.leases += 1
    touch(entry.key, entry)
    let released = false
    const release = (): void => {
      if (released) return
      released = true
      entry.leases = Math.max(0, entry.leases - 1)
      if (!entry.cached && entry.leases === 0) revoke(entry)
    }
    return {
      url: entry.url,
      release,
      invalidate() {
        if (released) return
        entry.invalid = true
        negative.set(entry.key, {
          error: new Error('Roon artwork element rejected the decoded image'),
          expiresAt: now() + negativeTtlMs,
        })
        removeEntry(entry)
        release()
      },
    }
  }

  return {
    async acquire(request) {
      const key = requestKey(request)
      const cached = entries.get(key)
      if (cached) return createLease(cached)

      const failed = negative.get(key)
      if (failed) {
        if (failed.expiresAt > now()) throw failed.error
        negative.delete(key)
      }

      let current = pending.get(key)
      if (!current) {
        const requestGeneration = generation
        current = (async () => {
          let url: string | undefined
          try {
            const result = await getImage(request.reference, {
              width: request.width,
              height: request.height,
              scale: request.scale,
              format: request.format,
            })
            if (!isValidRoonImageBinary(result.contentType, result.body)) {
              const decodeError = new Error('Roon artwork response failed binary validation') as Error & { code: string }
              decodeError.code = 'ROON_IMAGE_DECODE_FAILED'
              throw decodeError
            }
            url = createObjectUrl(new Uint8Array(result.body), result.contentType)
            try {
              await decodeObjectUrl(url)
            } catch (cause) {
              const decodeError = new Error('Roon artwork decode failed', { cause }) as Error & { code: string }
              decodeError.code = 'ROON_IMAGE_DECODE_FAILED'
              throw decodeError
            }
            if (requestGeneration !== generation) {
              revokeObjectUrl(url)
              throw new Error('Roon artwork request became stale')
            }
            const entry: ArtworkEntry = {
              key,
              url,
              leases: 0,
              cached: false,
              invalid: false,
              revoked: false,
            }
            url = undefined
            if (reserveCacheSlot()) {
              entry.cached = true
              entries.set(key, entry)
            }
            return entry
          } catch (error) {
            if (url) revokeObjectUrl(url)
            const normalized = error instanceof Error
              ? error
              : new Error('Roon artwork request failed')
            negative.set(key, {
              error: normalized,
              expiresAt: now() + negativeTtlMs,
            })
            throw normalized
          } finally {
            pending.delete(key)
          }
        })()
        pending.set(key, current)
      }
      return createLease(await current)
    },
    clear() {
      generation += 1
      negative.clear()
      pending.clear()
      for (const entry of entries.values()) {
        entry.invalid = true
        entry.cached = false
        revoke(entry)
      }
      entries.clear()
    },
  }
}

export const roonArtworkCache = createRoonArtworkCache()
