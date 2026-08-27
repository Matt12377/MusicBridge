import assert from 'node:assert/strict'
import test from 'node:test'
import type { LyricsSnapshot, TrackSummary } from '@music-bridge/contracts'
import { emptyLyricsSnapshot } from '../src/netease/lyrics.js'
import { createLyricsMatchRepository } from '../src/lyrics-matching/repository.js'
import { LyricsMatchResolver, type LyricsResolverProvider } from '../src/lyrics-matching/resolver.js'
import { createLocalTrackSignature } from '../src/lyrics-matching/signature.js'

const signature = createLocalTrackSignature({ title: '归零', artists: ['林忆莲'], album: '0', durationMs: 271_000 })
const ready: LyricsSnapshot = { status: 'ready', lines: [{ startMs: 0, text: '归零' }], activeLineIndex: -1, timingSource: 'static' }

function provider(options: {
  configured?: boolean
  tracks?: readonly TrackSummary[]
  lyrics?: LyricsSnapshot
  search?: (query: string, limit: number) => Promise<readonly TrackSummary[]>
  load?: (id: string) => Promise<LyricsSnapshot>
} = {}): LyricsResolverProvider & { searches: string[]; lyricIds: string[] } {
  const searches: string[] = []
  const lyricIds: string[] = []
  return {
    configured: options.configured ?? true,
    searches,
    lyricIds,
    async searchTracks(query, page) {
      searches.push(`${query}:${page.limit}`)
      const items = options.search ? await options.search(query, page.limit) : (options.tracks ?? [])
      return { items, offset: 0, limit: page.limit, total: items.length, hasMore: false }
    },
    async getLyrics(id) {
      lyricIds.push(id)
      return options.load ? options.load(id) : (options.lyrics ?? ready)
    },
  }
}

const track = (id: string, overrides: Partial<TrackSummary> = {}): TrackSummary => ({
  id, title: '归零', artists: ['林忆莲'], album: '0', durationMs: 271_000, ...overrides,
})

test('trusted NetEase link skips search and returns an independent confirmed match', async () => {
  const port = provider()
  const resolver = new LyricsMatchResolver({ provider: port, repository: createLyricsMatchRepository() })
  const result = await resolver.resolveActive({ signature, playbackGeneration: 1, trustedNeteaseTrackId: '101' })
  assert.equal(result.status, 'resolved')
  assert.equal(result.match.state, 'CONFIRMED')
  assert.equal(result.neteaseTrackId, '101')
  assert.deepEqual(port.searches, [])
  assert.deepEqual(port.lyricIds, ['101'])
})

test('confirmed repository mapping is reused before search', async () => {
  const repository = createLyricsMatchRepository({ now: () => 1 })
  await repository.set({ signature, neteaseTrackId: '102', source: 'MANUAL', algorithmVersion: 'old' })
  const port = provider()
  const result = await new LyricsMatchResolver({ provider: port, repository }).resolveActive({ signature, playbackGeneration: 1 })
  assert.equal(result.match.state, 'MANUAL')
  assert.equal(result.neteaseTrackId, '102')
  assert.deepEqual(port.searches, [])
})

test('search is bounded to two rounds of twenty and deduplicates candidates', async () => {
  const port = provider({ search: async () => [track('201'), track('201')] })
  const result = await new LyricsMatchResolver({ provider: port, repository: createLyricsMatchRepository() })
    .resolveActive({ signature, playbackGeneration: 1 })
  assert.equal(result.status, 'resolved')
  assert.ok(port.searches.length <= 2)
  assert.ok(port.searches.every((call) => call.endsWith(':20')))
  assert.equal(result.match.candidates.length, 1)
})

test('version conflict never calls lyric_new', async () => {
  const port = provider({ tracks: [track('301', { title: '归零 Live' })] })
  const result = await new LyricsMatchResolver({ provider: port, repository: createLyricsMatchRepository() })
    .resolveActive({ signature, playbackGeneration: 1 })
  assert.equal(result.match.state, 'REJECTED')
  assert.deepEqual(port.lyricIds, [])
})

test('same recording across different albums forms one confirmed lyrics candidate', async () => {
  const port = provider({ tracks: [
    track('311', { album: '0', durationMs: 271_100 }),
    track('312', { album: '林忆莲精选', durationMs: 271_600 }),
  ] })
  const result = await new LyricsMatchResolver({ provider: port, repository: createLyricsMatchRepository() })
    .resolveActive({ signature, playbackGeneration: 1 })
  assert.equal(result.match.state, 'CONFIRMED')
  assert.equal(result.match.clusters.length, 1)
  assert.equal(port.lyricIds.length, 1)
})

test('ambiguous recording clusters never call lyric_new', async () => {
  const port = provider({ tracks: [
    track('321', { album: '甲', durationMs: 268_000 }),
    track('322', { album: '乙', durationMs: 274_000 }),
  ] })
  const result = await new LyricsMatchResolver({ provider: port, repository: createLyricsMatchRepository() })
    .resolveActive({ signature, playbackGeneration: 1 })
  assert.equal(result.match.state, 'AMBIGUOUS')
  assert.deepEqual(port.lyricIds, [])
})

test('confirmed mapping without lyrics stays unavailable without losing the match', async () => {
  const port = provider({ tracks: [track('401')], lyrics: emptyLyricsSnapshot('unavailable') })
  const result = await new LyricsMatchResolver({ provider: port, repository: createLyricsMatchRepository() })
    .resolveActive({ signature, playbackGeneration: 1 })
  assert.equal(result.status, 'unavailable')
  assert.equal(result.match.state, 'CONFIRMED')
  assert.equal(result.neteaseTrackId, '401')
})

test('old active result is stale after rapid track switching', async () => {
  let release!: (value: LyricsSnapshot) => void
  const delayed = new Promise<LyricsSnapshot>((resolve) => { release = resolve })
  const port = provider({ tracks: [track('501')], load: async () => delayed })
  const applied: LyricsResolutionStatus[] = []
  const resolver = new LyricsMatchResolver({ provider: port, repository: createLyricsMatchRepository(), onActiveResult: (value) => applied.push(value.status) })
  const old = resolver.resolveActive({ signature, playbackGeneration: 1 })
  const nextSignature = createLocalTrackSignature({ title: '下一首', artists: ['歌手'], durationMs: 200_000 })
  const next = resolver.resolveActive({ signature: nextSignature, playbackGeneration: 2, trustedNeteaseTrackId: '502' })
  release(ready)
  assert.equal((await old).status, 'stale')
  assert.equal((await next).status, 'resolved')
  assert.deepEqual(applied, ['resolved'])
})

test('same active signature and generation deduplicate concurrent requests', async () => {
  const port = provider({ tracks: [track('601')] })
  const resolver = new LyricsMatchResolver({ provider: port, repository: createLyricsMatchRepository() })
  const request = { signature, playbackGeneration: 1 }
  const [first, second] = await Promise.all([resolver.resolveActive(request), resolver.resolveActive(request)])
  assert.equal(first.neteaseTrackId, second.neteaseTrackId)
  assert.equal(port.searches.length, 1)
})

test('provider unavailable returns a bounded error and never needs playback controls', async () => {
  const result = await new LyricsMatchResolver({ provider: provider({ configured: false }), repository: createLyricsMatchRepository() })
    .resolveActive({ signature, playbackGeneration: 1 })
  assert.equal(result.status, 'error')
  assert.equal(result.errorCode, 'provider-unavailable')
})

test('repository write failure does not discard confirmed lyrics', async () => {
  const repository = createLyricsMatchRepository()
  repository.set = async () => { throw new Error('disk details must stay private') }
  const result = await new LyricsMatchResolver({ provider: provider({ tracks: [track('701')] }), repository })
    .resolveActive({ signature, playbackGeneration: 1 })
  assert.equal(result.status, 'resolved')
  assert.equal(result.errorCode, 'repository-write')
  assert.equal(result.lyrics?.status, 'ready')
})

test('prefetch considers only two signatures with at most two concurrent Provider calls', async () => {
  let active = 0
  let maximum = 0
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const port = provider({ search: async () => {
    active += 1
    maximum = Math.max(maximum, active)
    await gate
    active -= 1
    return []
  } })
  const resolver = new LyricsMatchResolver({ provider: port, repository: createLyricsMatchRepository() })
  const work = resolver.prefetch([
    signature,
    createLocalTrackSignature({ title: 'B', artists: ['Artist'] }),
    createLocalTrackSignature({ title: 'C', artists: ['Artist'] }),
  ])
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(maximum, 2)
  release()
  await work
  assert.ok(port.searches.length <= 4)
  assert.equal(port.searches.some((query) => query.startsWith('c artist')), false)
})

test('temporary search failure uses a short fake-clock negative cache and retries after expiry', async () => {
  let now = 1_000
  let calls = 0
  const port = provider({ search: async () => {
    calls += 1
    throw new Error('network details')
  } })
  const resolver = new LyricsMatchResolver({
    provider: port,
    repository: createLyricsMatchRepository(),
    now: () => now,
  })

  assert.equal((await resolver.resolveActive({ signature, playbackGeneration: 1 })).errorCode, 'network')
  assert.equal((await resolver.resolveActive({ signature, playbackGeneration: 2 })).errorCode, 'network')
  assert.equal(calls, 1)
  now += 30_001
  assert.equal((await resolver.resolveActive({ signature, playbackGeneration: 3 })).errorCode, 'network')
  assert.equal(calls, 2)
})

type LyricsResolutionStatus = import('../src/lyrics-matching/resolver.js').LyricsResolutionStatus
