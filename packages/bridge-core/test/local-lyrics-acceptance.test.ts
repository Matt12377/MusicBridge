import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { LyricsSnapshot, PlaybackSnapshot, TrackSummary } from '@music-bridge/contracts'
import { LyricsCoordinator, createLyricsRequestContext } from '../src/lyrics/coordinator.js'
import { LocalLyricsManualMatchController } from '../src/lyrics-matching/manual-controller.js'
import { createLyricsMatchRepository } from '../src/lyrics-matching/repository.js'
import { LyricsMatchResolver, type LyricsResolverProvider } from '../src/lyrics-matching/resolver.js'

// 全部数据均为受控夹具；不访问实际 Provider 或 Roon。
const localTrack: TrackSummary = {
  id: '900001', title: '归零', artists: ['林忆莲'], album: '0', durationMs: 271_000,
}
const candidate = (id: string, changes: Partial<TrackSummary> = {}): TrackSummary => ({ ...localTrack, id, ...changes })
const ready: LyricsSnapshot = {
  status: 'ready',
  lines: [{ startMs: 0, endMs: 1_000, text: 'SYNTHETIC_LYRIC_ONLY_IN_MEMORY' }, { startMs: 1_000, text: 'SYNTHETIC_SECOND_LINE' }],
  activeLineIndex: -1, timingSource: 'static',
}

function playback(track = localTrack): PlaybackSnapshot {
  return {
    state: 'playing', currentTrack: track, source: 'roon', positionMs: 0, selectedZoneId: 'synthetic-zone',
    queue: { items: [{ trackId: track.id, track, preferredSource: 'roon', qualityPreference: 'auto' }], index: 0, hasNext: false, hasPrevious: false },
    canPause: true, canResume: false, canStop: true, canNext: false, canPrevious: false,
  }
}

function port(options: {
  tracks?: readonly TrackSummary[]
  configured?: boolean
  lyrics?: LyricsSnapshot
  failSearch?: boolean
  load?: (trackId: string) => Promise<LyricsSnapshot>
} = {}): LyricsResolverProvider & { searches: number; downloads: string[] } {
  return {
    configured: options.configured ?? true, searches: 0, downloads: [],
    async searchTracks(_query, request) {
      this.searches += 1
      assert.equal(request.limit, 20)
      if (options.failSearch) throw new Error('SYNTHETIC_PRIVATE_NETWORK_DETAIL')
      const items = options.tracks ?? [candidate('101')]
      return { items, offset: 0, limit: 20, total: items.length, hasMore: false }
    },
    async getLyrics(trackId) {
      this.downloads.push(trackId)
      return options.load ? options.load(trackId) : options.lyrics ?? ready
    },
  }
}

function pipeline(provider: LyricsResolverProvider, repository = createLyricsMatchRepository()) {
  const resolver = new LyricsMatchResolver({ provider, repository })
  let coordinator!: LyricsCoordinator
  const manual = new LocalLyricsManualMatchController({
    repository,
    reload: async (context) => { resolver.invalidate(context.signature.key); await coordinator.reloadActiveLocalLyrics(context) },
  })
  coordinator = new LyricsCoordinator({
    now: () => 0,
    load: async () => { throw new Error('本地播放不得调用直接 NetEase ID 入口') },
    localResolver: resolver,
    onLocalResolution: (context, result) => manual.observeResolution(context, result),
  })
  return {
    coordinator, manual, repository,
    observe(snapshot: PlaybackSnapshot, generation: number) {
      const context = createLyricsRequestContext(snapshot, generation)
      manual.observeContext(context?.kind === 'local' ? context : undefined)
      coordinator.onPlaybackChanged(snapshot, context)
      return context
    },
  }
}

async function settled(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000
  while (!condition()) {
    assert.ok(Date.now() < deadline, '合成歌词流程未在测试时限内结算')
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
}

for (const version of ['Live', 'Remix', 'Instrumental', 'Cover', 'Demo']) {
  test(`验收：${version} 硬冲突不能进入歌词或手动候选`, async () => {
    const provider = port({ tracks: [candidate('201', { title: `归零 (${version})` })] })
    const flow = pipeline(provider)
    flow.observe(playback(), 1)
    await settled(() => flow.coordinator.getSnapshot().status !== 'loading')
    assert.equal(flow.coordinator.getSnapshot().status, 'unavailable')
    assert.equal(flow.manual.getSnapshot().status, 'no-match')
    assert.deepEqual(flow.manual.getSnapshot().candidates, [])
    assert.deepEqual(provider.downloads, [])
    assert.deepEqual(await flow.repository.listBounded(0, 10), [])
  })
}

for (const album of ['0', 'Synthetic Collection']) {
  test(`验收：唯一同版本候选在 ${album} 专辑可确认并显示来源`, async () => {
    const provider = port({ tracks: [candidate('301', { album })] })
    const flow = pipeline(provider)
    flow.observe(playback(), 1)
    await settled(() => flow.coordinator.getSnapshot().status !== 'loading')
    assert.equal(flow.coordinator.getSnapshot().status, 'ready')
    assert.equal(flow.coordinator.getSnapshot().source, 'netease')
    assert.equal(flow.manual.getSnapshot().status, 'matched')
    assert.deepEqual(provider.downloads, ['301'])
  })
}

for (const scenario of ['ambiguous', 'possible', 'none', 'no-lyrics', 'network', 'unconfigured'] as const) {
  test(`验收：${scenario} 有明确状态且不自动显示未经确认的歌词`, async () => {
    const provider = port({
      tracks: scenario === 'ambiguous'
        ? [candidate('401', { durationMs: 268_000, album: '甲' }), candidate('402', { durationMs: 274_000, album: '乙' })]
        : scenario === 'possible' ? [candidate('401', { durationMs: 260_000 })]
          : scenario === 'none' ? [] : [candidate('401')],
      failSearch: scenario === 'network',
      configured: scenario !== 'unconfigured',
      ...(scenario === 'no-lyrics' ? { lyrics: { status: 'unavailable' as const, lines: [], activeLineIndex: -1, timingSource: 'static' as const } } : {}),
    })
    const flow = pipeline(provider)
    const snapshot = playback()
    flow.observe(snapshot, 1)
    await settled(() => flow.coordinator.getSnapshot().status !== 'loading')
    assert.equal(snapshot.state, 'playing')
    assert.equal(snapshot.source, 'roon')
    assert.deepEqual(flow.coordinator.getSnapshot().lines, [])
    assert.equal(flow.coordinator.getSnapshot().source, undefined)
    const expected = {
      ambiguous: 'needs-choice', possible: 'needs-choice', none: 'no-match',
      'no-lyrics': 'no-lyrics', network: 'network-error', unconfigured: 'provider-unavailable',
    }[scenario]
    assert.equal(flow.manual.getSnapshot().status, expected)
    if (scenario !== 'no-lyrics') assert.deepEqual(provider.downloads, [])
    if (scenario === 'unconfigured') assert.equal(provider.searches, 0)
    assert.doesNotMatch(JSON.stringify(flow.manual.getSnapshot()), /SYNTHETIC_PRIVATE_NETWORK_DETAIL|score|confidence|algorithmVersion|neteaseTrackId/u)
  })
}

test('验收：旧歌词下载在快速切歌后返回不能覆盖新曲目', async () => {
  let release!: (lyrics: LyricsSnapshot) => void
  const pending = new Promise<LyricsSnapshot>((resolve) => { release = resolve })
  const provider = port({ load: async (id) => id === '501' ? pending : ready })
  const flow = pipeline(provider)
  const first = playback()
  const second = playback({ ...localTrack, id: '900002', title: 'Synthetic Next Song' })
  for (const [snapshot, id] of [[first, '501'], [second, '502']] as const) {
    const context = createLyricsRequestContext(snapshot, 1)
    assert.ok(context?.kind === 'local')
    await flow.repository.set({ signature: context.signature, neteaseTrackId: id, source: 'MANUAL', algorithmVersion: 'lyrics-match-v1' })
  }
  flow.observe(first, 1)
  await settled(() => provider.downloads.includes('501'))
  flow.observe(second, 2)
  await settled(() => flow.coordinator.getSnapshot().status === 'ready')
  const expected = flow.coordinator.getSnapshot()
  release({ ...ready, lines: [{ startMs: 0, text: 'SYNTHETIC_STALE_LYRIC' }] })
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(flow.coordinator.getSnapshot(), expected)
  assert.equal(flow.manual.getSnapshot().status, 'matched')
})

test('验收：跨实例重播复用持久映射且文件不保存歌词正文或运行期身份', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'musicbridge-lyrics-acceptance-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const filePath = path.join(directory, 'matches.json')
  const provider = port()
  const first = pipeline(provider, createLyricsMatchRepository({ filePath }))
  first.observe(playback(), 1)
  await settled(() => first.coordinator.getSnapshot().status === 'ready')
  first.coordinator.shutdown()
  const secondProvider = port({ failSearch: true })
  const second = pipeline(secondProvider, createLyricsMatchRepository({ filePath }))
  second.observe(playback({ ...localTrack, id: '900009' }), 2)
  await settled(() => second.coordinator.getSnapshot().status === 'ready')
  assert.equal(secondProvider.searches, 0)
  assert.deepEqual(secondProvider.downloads, ['101'])
  const serialized = await readFile(filePath, 'utf8')
  assert.doesNotMatch(serialized, /SYNTHETIC_LYRIC|900001|900009|item_key|runtime|credential|cookie|\/Users\/|https?:\/\//iu)
  assert.equal((await stat(filePath)).mode & 0o777, 0o600)
})
