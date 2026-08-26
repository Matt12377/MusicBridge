import { randomUUID } from 'node:crypto'
import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { LocalTrackSignature } from './signature.js'
import { createLocalTrackSignature } from './signature.js'

export const MAX_LYRICS_MATCH_RECORDS = 4_096

export type PersistedLyricsMatchSource = 'CONFIRMED' | 'MANUAL'

export interface PersistedLyricsMatchRecord {
  signature: LocalTrackSignature
  neteaseTrackId: string
  source: PersistedLyricsMatchSource
  algorithmVersion: string
  createdAt: number
  lastUsedAt: number
}

export interface LyricsMatchRepository {
  get(signatureKey: string, algorithmVersion: string): Promise<PersistedLyricsMatchRecord | undefined>
  set(input: {
    signature: LocalTrackSignature
    neteaseTrackId: string
    source: PersistedLyricsMatchSource
    algorithmVersion: string
  }): Promise<PersistedLyricsMatchRecord>
  touch(signatureKey: string): Promise<PersistedLyricsMatchRecord | undefined>
  delete(signatureKey: string): Promise<boolean>
  listBounded(offset: number, limit: number): Promise<readonly PersistedLyricsMatchRecord[]>
}

export function createLyricsMatchRepository(_options: {
  filePath?: string
  now?: () => number
  maxEntries?: number
} = {}): LyricsMatchRepository {
  const options = _options
  const filePath = options.filePath
  const now = options.now ?? (() => Date.now())
  const maxEntries = options.maxEntries === undefined
    ? MAX_LYRICS_MATCH_RECORDS
    : Math.min(MAX_LYRICS_MATCH_RECORDS, Math.max(1, options.maxEntries))
  if (!Number.isSafeInteger(maxEntries)) throw new TypeError('Invalid lyrics match capacity')
  const records = new Map<string, PersistedLyricsMatchRecord>()
  let loaded = false
  let loading: Promise<void> | undefined
  let mutationTail: Promise<void> = Promise.resolve()

  const cloneSignature = (value: LocalTrackSignature): LocalTrackSignature => ({
    key: value.key,
    canonical: { ...value.canonical, artists: [...value.canonical.artists] },
  })
  const cloneRecord = (value: PersistedLyricsMatchRecord): PersistedLyricsMatchRecord => ({
    ...value,
    signature: cloneSignature(value.signature),
  })
  const exactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean => {
    const actual = Object.keys(value).sort()
    return actual.length === keys.length && actual.every((key, index) => key === [...keys].sort()[index])
  }
  const validTrackId = (value: unknown): value is string =>
    typeof value === 'string' && /^[1-9][0-9]{0,19}$/u.test(value)
  const validAlgorithmVersion = (value: unknown): value is string =>
    typeof value === 'string' && value.length > 0 && value.length <= 64
  const validTimestamp = (value: unknown): value is number =>
    Number.isSafeInteger(value) && Number(value) >= 0
  const validateSignature = (value: unknown): value is LocalTrackSignature => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false
    const signature = value as Record<string, unknown>
    if (!exactKeys(signature, ['canonical', 'key']) || typeof signature.key !== 'string'
      || !/^[0-9a-f]{32}$/u.test(signature.key)) return false
    if (!signature.canonical || typeof signature.canonical !== 'object' || Array.isArray(signature.canonical)) return false
    const canonical = signature.canonical as Record<string, unknown>
    if (!exactKeys(canonical, ['album', 'artists', 'durationMs', 'title', 'version'])
      || typeof canonical.title !== 'string' || !Array.isArray(canonical.artists)
      || !canonical.artists.every((artist) => typeof artist === 'string')
      || !(canonical.album === null || typeof canonical.album === 'string')
      || !(canonical.version === null || typeof canonical.version === 'string')
      || !(canonical.durationMs === null || Number.isSafeInteger(canonical.durationMs))) return false
    try {
      const rebuilt = createLocalTrackSignature({
        title: canonical.title,
        artists: canonical.artists as string[],
        ...(canonical.album === null ? {} : { album: canonical.album as string }),
        ...(canonical.durationMs === null ? {} : { durationMs: canonical.durationMs as number }),
        ...(canonical.version === null ? {} : { version: canonical.version as string }),
      })
      return rebuilt.key === signature.key
        && rebuilt.canonical.title === canonical.title
        && JSON.stringify(rebuilt.canonical.artists) === JSON.stringify(canonical.artists)
        && rebuilt.canonical.album === canonical.album
        && rebuilt.canonical.durationMs === canonical.durationMs
        && rebuilt.canonical.version === canonical.version
    } catch {
      return false
    }
  }
  const parseRecord = (value: unknown): PersistedLyricsMatchRecord => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid lyrics match record')
    const record = value as Record<string, unknown>
    if (!exactKeys(record, ['algorithmVersion', 'createdAt', 'lastUsedAt', 'neteaseTrackId', 'signature', 'source'])
      || !validateSignature(record.signature) || !validTrackId(record.neteaseTrackId)
      || !['CONFIRMED', 'MANUAL'].includes(String(record.source))
      || !validAlgorithmVersion(record.algorithmVersion)
      || !validTimestamp(record.createdAt) || !validTimestamp(record.lastUsedAt)
      || Number(record.lastUsedAt) < Number(record.createdAt)) throw new TypeError('Invalid lyrics match record')
    return cloneRecord(record as unknown as PersistedLyricsMatchRecord)
  }
  async function load(): Promise<void> {
    if (loaded) return
    if (loading) return loading
    loading = (async () => {
      if (!filePath) { loaded = true; return }
      try {
        const parsed = JSON.parse(await readFile(filePath, 'utf8')) as unknown
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
          || !exactKeys(parsed as Record<string, unknown>, ['records', 'schemaVersion'])
          || (parsed as { schemaVersion?: unknown }).schemaVersion !== 1
          || !Array.isArray((parsed as { records?: unknown }).records)
          || (parsed as { records: unknown[] }).records.length > MAX_LYRICS_MATCH_RECORDS) {
          throw new TypeError('Invalid lyrics match repository schema')
        }
        const next = new Map<string, PersistedLyricsMatchRecord>()
        for (const value of (parsed as { records: unknown[] }).records) {
          const record = parseRecord(value)
          if (next.has(record.signature.key)) throw new TypeError('Duplicate lyrics match signature')
          next.set(record.signature.key, record)
        }
        records.clear()
        for (const [key, record] of next) records.set(key, record)
        loaded = true
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') { loaded = true; return }
        records.clear()
        throw new Error('Lyrics match repository file is invalid', { cause: error })
      }
    })()
    try { await loading } finally { loading = undefined }
  }
  const sortedRecords = (): PersistedLyricsMatchRecord[] => [...records.values()].sort((left, right) =>
    right.lastUsedAt - left.lastUsedAt || left.signature.key.localeCompare(right.signature.key, 'en'))
  async function persist(): Promise<void> {
    if (!filePath) return
    const directory = path.dirname(filePath)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    await chmod(directory, 0o700)
    const temporaryPath = `${filePath}.${randomUUID()}.tmp`
    try {
      await writeFile(temporaryPath, `${JSON.stringify({ schemaVersion: 1, records: sortedRecords() })}\n`, {
        encoding: 'utf8', mode: 0o600, flag: 'wx',
      })
      await chmod(temporaryPath, 0o600)
      await rename(temporaryPath, filePath)
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined)
      throw error
    }
  }
  const snapshot = (): Map<string, PersistedLyricsMatchRecord> =>
    new Map([...records].map(([key, record]) => [key, cloneRecord(record)]))
  const restore = (previous: Map<string, PersistedLyricsMatchRecord>): void => {
    records.clear()
    for (const [key, record] of previous) records.set(key, record)
  }
  const mutate = <Value>(operation: () => Promise<Value>): Promise<Value> => {
    const result = mutationTail.then(operation)
    mutationTail = result.then(() => undefined, () => undefined)
    return result
  }
  const timestamp = (): number => {
    const value = now()
    if (!validTimestamp(value)) throw new TypeError('Invalid lyrics match timestamp')
    return value
  }

  return {
    async get(signatureKey, algorithmVersion) {
      await mutationTail; await load()
      const record = records.get(signatureKey)
      if (!record || (record.source === 'CONFIRMED' && record.algorithmVersion !== algorithmVersion)) return undefined
      return cloneRecord(record)
    },
    set(input) {
      if (!validateSignature(input.signature)) return Promise.reject(new TypeError('Invalid local track signature'))
      if (!validTrackId(input.neteaseTrackId)) return Promise.reject(new TypeError('Invalid NetEase track id'))
      if (!['CONFIRMED', 'MANUAL'].includes(String(input.source))) return Promise.reject(new TypeError('Invalid lyrics match source'))
      if (!validAlgorithmVersion(input.algorithmVersion)) return Promise.reject(new TypeError('Invalid algorithm version'))
      return mutate(async () => {
        await load()
        const previous = snapshot()
        const old = records.get(input.signature.key)
        const time = Math.max(timestamp(), old?.createdAt ?? 0, old?.lastUsedAt ?? 0)
        const record: PersistedLyricsMatchRecord = {
          signature: cloneSignature(input.signature), neteaseTrackId: input.neteaseTrackId,
          source: input.source, algorithmVersion: input.algorithmVersion,
          createdAt: old?.createdAt ?? time, lastUsedAt: time,
        }
        records.set(record.signature.key, record)
        while (records.size > maxEntries) {
          const oldest = [...records.values()].sort((left, right) =>
            left.lastUsedAt - right.lastUsedAt || left.signature.key.localeCompare(right.signature.key, 'en'))[0]
          if (!oldest) break
          records.delete(oldest.signature.key)
        }
        try { await persist() } catch (error) { restore(previous); throw error }
        return cloneRecord(record)
      })
    },
    touch(signatureKey) {
      return mutate(async () => {
        await load()
        const record = records.get(signatureKey)
        if (!record) return undefined
        const previous = snapshot()
        record.lastUsedAt = Math.max(timestamp(), record.createdAt, record.lastUsedAt)
        try { await persist() } catch (error) { restore(previous); throw error }
        return cloneRecord(record)
      })
    },
    delete(signatureKey) {
      return mutate(async () => {
        await load()
        if (!records.has(signatureKey)) return false
        const previous = snapshot()
        records.delete(signatureKey)
        try { await persist() } catch (error) { restore(previous); throw error }
        return true
      })
    },
    async listBounded(offset, limit) {
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
        throw new TypeError('Invalid lyrics match page')
      }
      await mutationTail; await load()
      return sortedRecords().slice(offset, offset + limit).map(cloneRecord)
    },
  }
}
