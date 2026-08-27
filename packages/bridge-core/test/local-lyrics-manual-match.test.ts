import assert from 'node:assert/strict'
import test from 'node:test'
import { LocalLyricsManualMatchController } from '../src/lyrics-matching/manual-controller.js'
import { matchLyricsRecording } from '../src/lyrics-matching/index.js'
import { createLyricsMatchRepository } from '../src/lyrics-matching/repository.js'
import type { LyricsResolution } from '../src/lyrics-matching/resolver.js'
import { createLocalTrackSignature } from '../src/lyrics-matching/signature.js'

const signature = createLocalTrackSignature({
  title: '归零',
  artists: ['林忆莲'],
  album: '0',
  durationMs: 271_000,
})

const context = {
  kind: 'local' as const,
  playbackGeneration: 7,
  cacheKey: `local:${signature.key}`,
  signature,
  manualEligible: true,
}

const identity = {
  title: signature.canonical.title,
  artists: signature.canonical.artists,
  ...(signature.canonical.album === null ? {} : { album: signature.canonical.album }),
  ...(signature.canonical.durationMs === null ? {} : { durationMs: signature.canonical.durationMs }),
  ...(signature.canonical.version === null ? {} : { version: signature.canonical.version }),
}

function ambiguousResolution(): LyricsResolution {
  return {
    status: 'unavailable',
    applied: true,
    match: matchLyricsRecording(identity, [
      { trackId: '101', title: '归零', artists: ['林忆莲'], album: '甲', durationMs: 268_000 },
      { trackId: '102', title: '归零', artists: ['林忆莲'], album: '乙', durationMs: 274_000 },
    ]),
  }
}

test('manual lyrics selection accepts only a current unexpired allowlisted candidate', async () => {
  let now = 1_000
  let serial = 0
  const reloads: string[] = []
  const repository = createLyricsMatchRepository({ now: () => now })
  const controller = new LocalLyricsManualMatchController({
    repository,
    now: () => now,
    createId: (kind) => `${kind}-${String(++serial).padStart(16, '0')}`,
    reload: async (active) => { reloads.push(active.signature.key) },
  })

  controller.observeContext(context)
  controller.observeResolution(context, ambiguousResolution())
  const choice = controller.getSnapshot()
  assert.equal(choice.status, 'needs-choice')
  assert.equal(choice.candidates.length, 2)
  assert.deepEqual(Object.keys(choice.candidates[0] ?? {}).sort(), [
    'album', 'artists', 'candidateId', 'durationMs', 'title',
  ])
  assert.doesNotMatch(JSON.stringify(choice), /score|confidence|evidence|algorithmVersion|signature|trackId|roon|search/iu)

  await assert.rejects(
    controller.select(choice.matchSessionId ?? '', 'candidate-not-allowlisted'),
    /candidate/iu,
  )
  const selected = choice.candidates[1]
  assert.ok(selected)
  await controller.select(choice.matchSessionId ?? '', selected.candidateId)
  const stored = await repository.get(signature.key, 'lyrics-match-v1')
  assert.equal(stored?.source, 'MANUAL')
  assert.equal(stored?.neteaseTrackId, '102')
  assert.deepEqual(reloads, [signature.key])

  controller.observeContext({ ...context, playbackGeneration: 8 })
  await assert.rejects(
    controller.select(choice.matchSessionId ?? '', selected.candidateId),
    /session/iu,
  )

  controller.observeContext(context)
  controller.observeResolution(context, ambiguousResolution())
  const expiring = controller.getSnapshot()
  now += 5 * 60_000 + 1
  await assert.rejects(
    controller.select(expiring.matchSessionId ?? '', expiring.candidates[0]?.candidateId ?? ''),
    /expired/iu,
  )
})

test('manual lyrics revoke deletes only the current signature mapping and reloads without playback control', async () => {
  const repository = createLyricsMatchRepository({ now: () => 2_000 })
  await repository.set({
    signature,
    neteaseTrackId: '201',
    source: 'MANUAL',
    algorithmVersion: 'lyrics-match-v1',
  })
  let reloadCount = 0
  const controller = new LocalLyricsManualMatchController({
    repository,
    reload: async () => { reloadCount += 1 },
  })
  controller.observeContext(context)
  controller.observeResolution(context, {
    status: 'resolved',
    applied: true,
    neteaseTrackId: '201',
    match: {
      ...matchLyricsRecording(identity, [{
        trackId: '201', title: '归零', artists: ['林忆莲'], album: '0', durationMs: 271_000,
      }]),
      state: 'MANUAL',
    },
  })

  assert.equal(controller.getSnapshot().canRevoke, true)
  await controller.revoke()
  assert.equal(await repository.get(signature.key, 'lyrics-match-v1'), undefined)
  assert.equal(reloadCount, 1)
})

test('manual controls stay hidden for Smart-to-Roon and non-local playback contexts', () => {
  const controller = new LocalLyricsManualMatchController({
    repository: createLyricsMatchRepository(),
    reload: async () => undefined,
  })
  controller.observeContext({ ...context, manualEligible: false, trustedNeteaseTrackId: '301' })
  controller.observeResolution({ ...context, manualEligible: false, trustedNeteaseTrackId: '301' }, ambiguousResolution())
  assert.deepEqual(controller.getSnapshot(), { status: 'hidden', candidates: [], canRevoke: false })
  controller.observeContext(undefined)
  assert.deepEqual(controller.getSnapshot(), { status: 'hidden', candidates: [], canRevoke: false })
})

test('自动确认的当前匹配也允许撤销并重新解析', () => {
  const controller = new LocalLyricsManualMatchController({
    repository: createLyricsMatchRepository(),
    reload: async () => undefined,
  })
  controller.observeContext(context)
  controller.observeResolution(context, {
    status: 'resolved',
    applied: true,
    neteaseTrackId: '401',
    match: matchLyricsRecording(identity, [{
      trackId: '401', title: '归零', artists: ['林忆莲'], album: '0', durationMs: 271_000,
    }]),
  })
  assert.equal(controller.getSnapshot().status, 'matched')
  assert.equal(controller.getSnapshot().canRevoke, true)
})

test('手动候选排除 hard reject 和标题不相关的搜索结果', () => {
  const controller = new LocalLyricsManualMatchController({
    repository: createLyricsMatchRepository(),
    reload: async () => undefined,
  })
  const match = matchLyricsRecording(identity, [
    { trackId: '101', title: '归零', artists: ['林忆莲'], durationMs: 268_000 },
    { trackId: '102', title: '归零', artists: ['林忆莲'], durationMs: 274_000 },
    { trackId: '103', title: '归零 (Live)', artists: ['林忆莲'], durationMs: 271_000 },
    { trackId: '104', title: '另一首歌', artists: ['林忆莲'], durationMs: 271_000 },
  ])
  assert.equal(match.state, 'AMBIGUOUS')
  controller.observeContext(context)
  controller.observeResolution(context, { status: 'unavailable', applied: true, match })
  assert.deepEqual(controller.getSnapshot().candidates.map((candidate) => candidate.title), ['归零', '归零'])
})

test('同一候选会话的并发选择只允许一次持久化和重新加载', async () => {
  const repository = createLyricsMatchRepository()
  const originalSet = repository.set.bind(repository)
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  let writes = 0
  let reloads = 0
  repository.set = async (input) => {
    writes += 1
    await gate
    return originalSet(input)
  }
  const controller = new LocalLyricsManualMatchController({
    repository,
    reload: async () => { reloads += 1 },
  })
  controller.observeContext(context)
  controller.observeResolution(context, ambiguousResolution())
  const choice = controller.getSnapshot()
  const first = controller.select(choice.matchSessionId!, choice.candidates[0]!.candidateId)
  const second = controller.select(choice.matchSessionId!, choice.candidates[1]!.candidateId)
  const resultsPromise = Promise.allSettled([first, second])
  release()
  const results = await resultsPromise
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1)
  assert.equal(writes, 1)
  assert.equal(reloads, 1)
})

test('撤销删除当前自动确认记录，但不接受没有记录的再次撤销', async () => {
  const repository = createLyricsMatchRepository()
  await repository.set({ signature, neteaseTrackId: '501', source: 'CONFIRMED', algorithmVersion: 'lyrics-match-v1' })
  const controller = new LocalLyricsManualMatchController({ repository, reload: async () => undefined })
  controller.observeContext(context)
  await controller.revoke()
  assert.equal(await repository.get(signature.key, 'lyrics-match-v1'), undefined)
  await assert.rejects(controller.revoke(), /match/iu)
})

test('track change during a pending manual repository write rolls back the stale selection', async () => {
  const repository = createLyricsMatchRepository({ now: () => 3_000 })
  const originalSet = repository.set.bind(repository)
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  repository.set = async (input) => {
    await gate
    return originalSet(input)
  }
  let reloadCount = 0
  const controller = new LocalLyricsManualMatchController({
    repository,
    createId: (kind) => `${kind}-0123456789abcdef`,
    reload: async () => { reloadCount += 1 },
  })
  controller.observeContext(context)
  controller.observeResolution(context, ambiguousResolution())
  const choice = controller.getSnapshot()
  const pending = controller.select(
    choice.matchSessionId ?? '',
    choice.candidates[0]?.candidateId ?? '',
  )
  controller.observeContext({
    ...context,
    playbackGeneration: 8,
    signature: createLocalTrackSignature({ title: '下一首', artists: ['歌手'] }),
  })
  release()
  await assert.rejects(pending, /current/iu)
  assert.equal(await repository.get(signature.key, 'lyrics-match-v1'), undefined)
  assert.equal(reloadCount, 0)
})

test('track change during a pending revoke preserves the new track state and skips reload', async () => {
  const repository = createLyricsMatchRepository({ now: () => 4_000 })
  await repository.set({ signature, neteaseTrackId: '301', source: 'MANUAL', algorithmVersion: 'lyrics-match-v1' })
  const originalDelete = repository.delete.bind(repository)
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  repository.delete = async (signatureKey) => {
    await gate
    return originalDelete(signatureKey)
  }
  let reloadCount = 0
  const controller = new LocalLyricsManualMatchController({
    repository,
    reload: async () => { reloadCount += 1 },
  })
  controller.observeContext(context)
  const pending = controller.revoke()
  controller.observeContext({
    ...context,
    playbackGeneration: 9,
    signature: createLocalTrackSignature({ title: '下一首', artists: ['歌手'] }),
  })
  release()
  await assert.rejects(pending, /current/iu)
  assert.equal(controller.getSnapshot().status, 'searching')
  assert.equal(reloadCount, 0)
})
