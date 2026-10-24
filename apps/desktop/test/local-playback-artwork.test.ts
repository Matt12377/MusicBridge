import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { computed, effectScope, nextTick, ref, shallowRef } from 'vue'
import { isLocalAlbumArtworkReply, isLocalAlbumTrackItem, isLocalPlaybackObservationLeaf } from '@music-bridge/contracts'
import type { LocalAlbumArtworkReply, LocalAlbumArtworkRequest, LocalAlbumSummary, LocalAlbumTrackItem, PlaybackSnapshot } from '@music-bridge/contracts'
import { useLocalPlaybackArtwork } from '../src/renderer/src/composables/application/useLocalPlaybackArtwork.js'

// 真实Vue叶组合函数+合成公开DTO；不冒充Source、Owner权限、IMG解码或物理音频输出。
const id = (value: number) => `33333333-3333-4333-8333-${String(value).padStart(12, '0')}`
function member(index: number, rootId = id(1)): LocalAlbumTrackItem {
  const metadata = { title: '同名曲目', artist: '合成作者', album: '同名专辑' }
  const value: LocalAlbumTrackItem = { facts: { track: { id: id(1000 + index), assetId: id(2000 + index), selectionRevision: '1', segment: null },
    asset: { id: id(2000 + index), libraryRootId: rootId, sourceRootId: id(2), rootRevision: '1', fileRevision: '1', locationRevision: '1', sampleFrames: null, timebaseHz: null },
    metadata: { raw: metadata, effective: metadata, override: null }, versionTokens: [], editions: [], fileParameters: null },
    disc: 1, trackNumber: index + 1, sequence: index + 1, statuses: ['has-artwork'] }
  assert.ok(isLocalAlbumTrackItem(value)); return value
}
function album(items: readonly LocalAlbumTrackItem[], changes: Partial<LocalAlbumSummary> = {}): LocalAlbumSummary {
  return { id: 'synthetic-playback-album', rootId: items[0]!.facts.asset.libraryRootId, kind: 'source-directory', editionId: null,
    representativeTrackId: items[0]!.facts.track.id, title: '同名专辑', artists: ['合成作者'], year: null, versionLabel: null,
    trackCount: items.length, revision: 'album-1', artworkAvailable: true, artworkState: 'available', statuses: ['has-artwork'], ...changes }
}
function playing(item: LocalAlbumTrackItem): PlaybackSnapshot {
  const { track, asset, metadata } = item.facts
  const local: NonNullable<PlaybackSnapshot['local']> = { schema_version: '1.2', request_id: id(60), attempt_id: id(61), intent_generation: '1', route: 'roon_audio_input',
    local_track_id: track.id, asset_id: asset.id, asset_revision: asset.fileRevision, target: { core_id: 'synthetic-core', zone_id: 'synthetic-zone' }, session_epoch: id(62),
    phase: 'PLAYING', ownership: 'MB_OWNED', queue_owner: 'MB', delivery_state: 'BYTES_SENT', roon_observation: { event: 'PLAYING', observed: true, correlation: 'ATTEMPT_CONFIRMED' },
    position_ms: 10, quality: { http_bytes: 'NOT_TESTED', signal_path: 'NOT_TESTED', digital_output: 'NOT_TESTED', gapless: 'NOT_TESTED' }, error_code: null }
  assert.ok(isLocalPlaybackObservationLeaf(local))
  return { state: 'playing', source: 'local_file', selectedZoneId: 'synthetic-zone', currentTrack: { id: track.id, title: metadata.effective.title!, artists: ['合成作者'], album: '同名专辑' },
    positionMs: 10, canPause: true, canResume: false, canStop: true, canNext: false, canPrevious: false, local,
    queue: { index: 0, hasNext: false, hasPrevious: false, items: [{ trackId: track.id, resolvedSource: 'local_file', qualityPreference: 'auto',
      local: { local_track_id: track.id, asset_id: asset.id, asset_revision: asset.fileRevision, selection_revision: track.selectionRevision, location_revision: asset.locationRevision, root_revision: asset.rootRevision } }] } }
}
function reply(request: LocalAlbumArtworkRequest, variant = false): LocalAlbumArtworkReply {
  const display = { mime: 'image/jpeg' as const, bytes: variant ? 4 : 3, sha256: (variant ? 'b' : 'a').repeat(64), width: 512, height: 512,
    dataUrl: variant ? 'data:image/jpeg;base64,/9j/AA==' : 'data:image/jpeg;base64,/9j/' }
  const value: LocalAlbumArtworkReply = { ...request, status: 'ready', image: { original: { mime: display.mime, bytes: display.bytes, sha256: display.sha256, width: 512, height: 512 }, display } }
  assert.ok(isLocalAlbumArtworkReply(value, request)); return value
}
async function drain() { for (let pass = 0; pass < 12; pass++) { await Promise.resolve(); await nextTick() } }
function fixture(t: TestContext, values = [member(0), member(1)]) {
  const scope = effectScope(), dataset = ref<string | null>(id(90)), ready = ref(true), clock = ref<string | undefined>('owned-core:1')
  const snapshot = shallowRef<PlaybackSnapshot | null>(null), sourceTrack = computed(() => snapshot.value?.currentTrack)
  const opened = shallowRef<readonly { album: LocalAlbumSummary | null; tracks: readonly LocalAlbumTrackItem[] }[]>([{ album: album(values), tracks: values }])
  const calls: { request: LocalAlbumArtworkRequest; resolve(value: LocalAlbumArtworkReply): void; reject(error: unknown): void }[] = []
  const layer = scope.run(() => useLocalPlaybackArtwork({ getDatasetId: () => dataset.value, isReadReady: () => ready.value,
    getClockIdentity: () => clock.value, getSnapshot: () => snapshot.value, getTrack: () => sourceTrack.value, getOpenedAlbums: () => opened.value,
    read: request => new Promise((resolve, reject) => { calls.push({ request: structuredClone(request), resolve, reject }) }) }))!
  t.after(() => { scope.stop(); for (const call of calls) call.resolve(reply(call.request)) })
  function play(value: LocalAlbumTrackItem, generation = 1) {
    // 与正式session相同：先Clock，随后同一栈写新快照。
    clock.value = `owned-core:${generation}:${value.facts.track.id}`; snapshot.value = playing(value)
  }
  return { layer, values, dataset, ready, clock, snapshot, opened, calls, play, stop: () => scope.stop() }
}

test('本地播放图：只在真实当前UUID/资产/修订匹配后读原专辑五元组，离开页面保关联且下一首同组仍正确', async t => {
  const f = fixture(t); assert.equal(f.calls.length, 0)
  f.play(f.values[0]!); await drain(); assert.equal(f.calls.length, 1)
  const selected = f.opened.value[0]!.album!
  assert.deepEqual(f.calls[0]!.request, { albumKey: selected.id, rootId: selected.rootId, editionId: selected.editionId, representativeTrackId: selected.representativeTrackId, revision: selected.revision })
  const raw = JSON.stringify(f.snapshot.value); f.calls[0]!.resolve(reply(f.calls[0]!.request)); await drain()
  assert.equal(f.layer.currentTrack.value?.artworkUrl, reply(f.calls[0]!.request).image!.display.dataUrl)
  assert.equal(JSON.stringify(f.snapshot.value), raw, '不能把显示图写入Core快照或队列')
  const displayed = f.layer.currentTrack.value
  f.opened.value = []; f.snapshot.value = { ...f.snapshot.value!, positionMs: 1000 }; await drain()
  assert.equal(f.calls.length, 1); assert.equal(f.layer.currentTrack.value, displayed)
  f.play(f.values[1]!, 2); await drain(); assert.equal(f.calls.length, 2)
  assert.equal(f.layer.currentTrack.value?.artworkUrl, undefined, '新曲未核回图前不借前曲图')
  f.calls[1]!.resolve(reply(f.calls[1]!.request, true)); await drain()
  assert.equal(f.layer.currentTrack.value?.artworkUrl, reply(f.calls[1]!.request, true).image!.display.dataUrl)
})

test('本地播放图：同名外UUID、外根、资产/选择/位置/根修订与edition不匹配时不猜图', async t => {
  for (const mode of ['uuid', 'root', 'asset', 'selection', 'location', 'rootRevision', 'edition'] as const) await t.test(mode, async sub => {
    const f = fixture(sub), original = f.values[0]!, changed = structuredClone(original)
    if (mode === 'uuid') { changed.facts.track.id = id(888); changed.facts.asset.id = changed.facts.track.assetId = id(889) }
    if (mode === 'root') { changed.facts.asset.libraryRootId = id(888); changed.facts.asset.id = changed.facts.track.assetId = id(889) }
    if (mode === 'asset') changed.facts.asset.fileRevision = '2'
    if (mode === 'selection') changed.facts.track.selectionRevision = '2'
    if (mode === 'location') changed.facts.asset.locationRevision = '2'
    if (mode === 'rootRevision') changed.facts.asset.rootRevision = '2'
    f.play(changed)
    if (mode === 'edition') f.snapshot.value = { ...f.snapshot.value!, queue: { ...f.snapshot.value!.queue, items: [{ ...f.snapshot.value!.queue.items[0]!, edition: { id: id(888), title: '同名专辑', edition: '', revision: '1' } }] } }
    await drain(); assert.equal(f.calls.length, 0); assert.equal(f.layer.currentTrack.value?.artworkUrl, undefined)
  })
})

test('本地播放图：Clock与快照同栈切换不读中间旧曲；慢旧图只占一个flight并合并到最新曲', async t => {
  const f = fixture(t, [member(0), member(1), member(2)])
  f.play(f.values[0]!); await drain(); assert.equal(f.calls.length, 1)
  f.play(f.values[1]!, 2); f.play(f.values[2]!, 3); await drain()
  assert.equal(f.calls.length, 1); assert.deepEqual(f.layer.getAssociationUsage(), { entries: 3, bytes: f.layer.getAssociationUsage().bytes, active: 1, pending: 1 })
  f.calls[0]!.resolve(reply(f.calls[0]!.request)); await drain()
  assert.equal(f.calls.length, 2, '中间曲及旧曲的新Clock不得额外发API')
  assert.equal(f.layer.currentTrack.value?.id, f.values[2]!.facts.track.id); assert.equal(f.layer.currentTrack.value?.artworkUrl, undefined)
  f.calls[1]!.resolve(reply(f.calls[1]!.request, true)); await drain()
  assert.equal(f.layer.currentTrack.value?.artworkUrl, reply(f.calls[1]!.request, true).image!.display.dataUrl)
  assert.equal(f.layer.getAssociationUsage().active, 0); assert.equal(f.layer.getAssociationUsage().pending, 0)
})

test('本地播放图：dataset、Owner代次、专辑修订或关闭后旧成功不复活；当前身份错误的回复也不得发布', async t => {
  for (const mode of ['dataset', 'owner', 'albumRevision', 'close', 'wrongReply'] as const) await t.test(mode, async sub => {
    const f = fixture(sub); f.play(f.values[0]!); await drain(); const original = f.calls[0]!
    if (mode === 'dataset') { f.opened.value = []; f.dataset.value = id(91) }
    if (mode === 'owner') { f.ready.value = false; f.clock.value = 'new-owned-core'; f.ready.value = true }
    if (mode === 'albumRevision') f.opened.value = [{ album: { ...f.opened.value[0]!.album!, revision: 'album-2' }, tracks: f.values }]
    if (mode === 'close') f.stop()
    const answer = reply(original.request)
    original.resolve(mode === 'wrongReply' ? { ...answer, rootId: id(999) } : answer); await drain()
    assert.equal(f.layer.currentTrack.value?.artworkUrl, undefined)
    if (mode === 'owner' || mode === 'albumRevision') {
      assert.equal(f.calls.length, 2); if (mode === 'albumRevision') assert.equal(f.calls[1]!.request.revision, 'album-2')
      f.calls[1]!.resolve(reply(f.calls[1]!.request, true)); await drain()
      assert.equal(f.layer.currentTrack.value?.artworkUrl, reply(f.calls[1]!.request, true).image!.display.dataUrl)
    } else assert.equal(f.calls.length, 1)
  })
})

test('本地播放图：失败不自动重发且不改播放状态，新的Owner代次才重新读取', async t => {
  const f = fixture(t); f.play(f.values[0]!); await drain(); const before = JSON.stringify(f.snapshot.value)
  f.calls[0]!.reject(new Error('合成图片读失败')); await drain()
  for (let pass = 0; pass < 8; pass++) { f.snapshot.value = { ...f.snapshot.value!, positionMs: pass + 100 }; await drain() }
  assert.equal(f.calls.length, 1); assert.equal(f.layer.currentTrack.value?.artworkUrl, undefined)
  assert.equal(JSON.parse(before).state, f.snapshot.value!.state)
  f.clock.value = 'owned-core:new-generation'; await drain(); assert.equal(f.calls.length, 2)
})

test('本地播放图：大量真实成员关联有界、无离屏hydration，当前关联不被随后打开的专辑冲掉', async t => {
  const f = fixture(t); f.play(f.values[0]!); await drain(); f.calls[0]!.resolve(reply(f.calls[0]!.request)); await drain()
  const displayed = f.layer.currentTrack.value, many = Array.from({ length: 1000 }, (_, index) => member(index + 100))
  f.opened.value = [{ album: album(many, { id: 'other-real-album' }), tracks: many }]; await drain()
  assert.equal(f.calls.length, 1); assert.equal(f.layer.currentTrack.value, displayed)
  assert.ok(f.layer.getAssociationUsage().entries <= 128); assert.ok(f.layer.getAssociationUsage().bytes <= 256 * 1024)
  f.opened.value = []; f.clock.value = 'owned-core:next-generation'; await drain()
  assert.equal(f.calls.length, 2); assert.equal(f.calls[1]!.request.albumKey, 'synthetic-playback-album')
})
