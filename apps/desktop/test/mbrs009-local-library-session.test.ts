import assert from 'node:assert/strict'
import test from 'node:test'
import type { CommandOutboxOverview, CommandOutboxPublicApi, CommandOutboxState, CommandOutboxView, LocalLibraryPublicApi, LocalLibraryQuery, LocalLibraryQueryPage, LocalLibraryTrackDetail, LocalLibraryTrackSummary, LocalPlayRequest, LocalRootView } from '@music-bridge/contracts'
import { useLocalLibrary } from '../src/renderer/src/composables/application/useLocalLibrary.js'
import { usePlaybackSession } from '../src/renderer/src/composables/application/usePlaybackSession.js'
import type { MusicBridgePublicApi } from '../src/preload/api.js'
import { audioQualityDetails, localLibraryPlaybackStatus, mbQueueOwnershipStatus } from '../src/renderer/src/components/player/details.js'
import { snapshot } from '../../../packages/contracts/test/mbrs006/fixture.js'

export const id = (value: number) => `11111111-1111-4111-8111-${String(value).padStart(12, '0')}`
export const root: LocalRootView = { root: { id: id(1), sourceRootId: id(2), role: 'library', revision: '1' }, label: '合成只读目录', availability: 'ONLINE' }
export function item(index = 0): LocalLibraryTrackSummary {
  return { track: { id: id(1000 + index), assetId: id(2000 + index), selectionRevision: '1', segment: null }, asset: { id: id(2000 + index), libraryRootId: root.root.id, sourceRootId: root.root.sourceRootId, rootRevision: '1', fileRevision: '1', locationRevision: '1', sampleFrames: null, timebaseHz: null }, metadata: { title: `同名版本 ${index}`, artist: '合成作者', album: '合成专辑' }, versionTokens: [] }
}
export function detail(index = 0): LocalLibraryTrackDetail {
  const value = item(index)
  return { track: value.track, asset: value.asset, metadata: { raw: value.metadata, override: null, effective: value.metadata }, editions: [], versionTokens: [], fileParameters: null }
}
export function page(query: LocalLibraryQuery, total = 245): LocalLibraryQueryPage {
  return { ...query, total, hasMore: query.offset + query.limit < total, items: Array.from({ length: Math.min(query.limit, Math.max(0, total - query.offset)) }, (_, offset) => item(query.offset + offset)) }
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => resolve = r); return { resolve, promise } }
export function libraryApi(overrides: Partial<LocalLibraryPublicApi & Pick<CommandOutboxPublicApi, 'getCommandOutbox'>> = {}): LocalLibraryPublicApi & Pick<CommandOutboxPublicApi, 'getCommandOutbox'> {
  return { queryLocalLibraryTracks: async query => page(query), getLocalLibraryTrackDetail: async trackId => detail(Number(trackId.slice(-12)) - 1000), getLocalLibraryPlaybackTarget: async () => ({ core_id: '受控Core', zone_id: '受控Zone' }), listLocalLibraryRoots: async () => [root], overrideLocalLibraryMetadata: async request => ({ trackId: request.trackId, revision: '1', fields: request.fields }), chooseLocalRelocationCandidates: async () => null, confirmLocalRelocation: async () => item().asset, getCommandOutbox: async () => ({ datasetId: id(90), entries: [] }), ...overrides } as LocalLibraryPublicApi & Pick<CommandOutboxPublicApi, 'getCommandOutbox'>
}
function session(api = libraryApi(), sends: LocalPlayRequest[] = []) {
  return useLocalLibrary({ api, getSelectedZone: () => ({ zoneId: '受控Zone', displayName: '合成播放目标', selected: true }), play: async request => { sends.push(request); return { status: 'accepted', request_id: request.request_id, action: request.action } } })
}

test('009抽象总数窗口只读取100条页，滚动缓存至多6页；此项不执行规模扫描', async t => {
  const reads: LocalLibraryQuery[] = [], model = session(libraryApi({ queryLocalLibraryTracks: async query => { reads.push(query); return page(query, 100_000) } })); t.after(() => model.dispose())
  await model.activate()
  for (let i = 1; i < 12; i++) { await model.ensureRange(i * 100 + 2, i * 100 + 24); assert.ok(model.cachePageCount.value <= 6); assert.ok(model.rangeWindow.value.entries.length <= 600) }
  assert.equal(model.total.value, 100_000); assert.equal(reads.length, 12); assert.ok(reads.every(query => query.limit === 100 && query.offset % 100 === 0)); assert.equal(model.rangeWindow.value.entries.find(entry => entry.index === 1102)?.track.id, item(1102).track.id)
})
test('009旧查询迟到不能污染新查询，快速输入只串行读取最新目标', async t => {
  const old = deferred<LocalLibraryQueryPage>(), reads: LocalLibraryQuery[] = []
  const model = session(libraryApi({ queryLocalLibraryTracks: query => { reads.push(query); return query.query === '' ? old.promise : Promise.resolve(page(query, 1)) } })); t.after(() => model.dispose())
  const first = model.activate(), next = model.search('新版本')
  assert.equal(reads.length, 1); old.resolve(page(reads[0]!, 245)); await Promise.all([first, next])
  assert.equal(model.query.value, '新版本'); assert.equal(model.total.value, 1); assert.equal(reads.length, 2); assert.equal(reads[1]!.query, '新版本'); assert.equal(model.rangeWindow.value.entries.length, 1)
})
test('009单项详情有选择代际，迟到A的文件参数不能覆盖B', async t => {
  const old = deferred<LocalLibraryTrackDetail>(), model = session(libraryApi({ getLocalLibraryTrackDetail: track => track === item().track.id ? old.promise : Promise.resolve(detail(1)) })); t.after(() => model.dispose())
  await model.activate(); const a = model.selectTrack(item().track.id); await model.selectTrack(item(1).track.id)
  const stale = detail(); stale.fileParameters = { container: 'FLAC', codec: 'FLAC', sampleRateHz: 96000, channels: 2, bitsPerSample: 24, durationMs: 1000, lossless: true, evidence: 'bounded-parser-reported' }; old.resolve(stale); await a
  assert.equal(model.detail.value?.track.id, item(1).track.id); assert.equal(model.detail.value?.fileParameters, null)
})
test('009离页返回保留搜索、缓存和滚动，重新读取目标与详情', async t => {
  let contexts = 0
  const model = session(libraryApi({ getLocalLibraryPlaybackTarget: async () => { contexts++; return contexts === 1 ? { core_id: '受控Core', zone_id: '受控Zone' } : null } })); t.after(() => model.dispose())
  await model.activate(); await model.search('合成版本'); await model.ensureRange(102, 124); model.scrollTop.value = 102 * 84; await model.selectTrack(item(102).track.id)
  const count = model.cachePageCount.value; model.suspend(); await model.activate()
  assert.equal(model.query.value, '合成版本'); assert.equal(model.scrollTop.value, 102 * 84); assert.equal(model.cachePageCount.value, count); assert.equal(model.detail.value?.track.id, item(102).track.id); assert.equal(model.target.value, null); assert.match(model.targetLabel.value, /尚未选择/u)
})
test('009同查询刷新失败保留最近成功行、总数、详情、选择和滚动并显示旧结果错误', async t => {
  let reject = false
  const model = session(libraryApi({ queryLocalLibraryTracks: async query => { if (reject) throw new Error('合成刷新失败'); return page(query) }, getLocalLibraryTrackDetail: async trackId => { if (reject) throw new Error('合成详情刷新失败'); return detail(Number(trackId.slice(-12)) - 1000) } })); t.after(() => model.dispose())
  await model.activate(); await model.ensureRange(102, 124); model.scrollTop.value = 102 * 84; await model.selectTrack(item(102).track.id)
  const rows = model.rangeWindow.value.entries, previousDetail = model.detail.value; reject = true; await model.refresh()
  assert.deepEqual(model.rangeWindow.value.entries, rows); assert.equal(model.total.value, 245); assert.equal(model.detail.value, previousDetail); assert.equal(model.selectedId.value, item(102).track.id); assert.equal(model.scrollTop.value, 102 * 84); assert.match(model.error.value, /上次|保留/u); assert.match(model.detailError.value, /上次|保留/u)
})
test('009成功空库刷新重新读取第一页，扫描新增曲目可见', async t => {
  let total = 0, reads = 0
  const model = session(libraryApi({ queryLocalLibraryTracks: async query => { reads++; return page(query, total) } })); t.after(() => model.dispose())
  await model.activate(); assert.equal(model.loaded.value, true); assert.equal(model.total.value, 0); assert.equal(reads, 1)
  total = 1; await model.refresh()
  assert.equal(reads, 2); assert.equal(model.total.value, 1); assert.equal(model.rangeWindow.value.entries[0]?.track.id, item().track.id)
})
test('009离线与null目标均零派发，三动作只携当前可信core/zone和九字段', async t => {
  let online = true, targetAvailable = false
  const sends: LocalPlayRequest[] = [], model = session(libraryApi({ listLocalLibraryRoots: async () => [{ ...root, availability: online ? 'ONLINE' : 'SOURCE_ROOT_OFFLINE' }], getLocalLibraryPlaybackTarget: async () => targetAvailable ? { core_id: '受控Core', zone_id: '受控Zone' } : null }), sends); t.after(() => model.dispose())
  await model.activate(); await model.playTrack(item().track.id); assert.equal(sends.length, 0); assert.match(model.actionError.value, /Roon Zone/u)
  targetAvailable = true; online = false; await model.playTrack(item().track.id); assert.equal(sends.length, 0); assert.match(model.actionError.value, /离线.*收藏保留/u)
  online = true
  for (const action of ['PLAY_NOW', 'APPEND_MB_QUEUE', 'PLAY_NEXT_MB_QUEUE'] as const) await model.playTrack(item().track.id, action)
  assert.deepEqual(sends.map(v => v.action), ['PLAY_NOW', 'APPEND_MB_QUEUE', 'PLAY_NEXT_MB_QUEUE']); assert.ok(sends.every(v => Object.keys(v).length === 9 && v.local_track_id === item().track.id && v.asset_id === item().asset.id && v.expected_asset_revision === '1')); assert.ok(sends.every(v => JSON.stringify(v.target) === JSON.stringify({ core_id: '受控Core', zone_id: '受控Zone' })))
})
test('009显示更正未知结果保留同一commandId，改标题/离页/重进不造新请求', async t => {
  const writes: unknown[] = [], model = session(libraryApi({ overrideLocalLibraryMetadata: async request => { writes.push(request); throw new Error('合成未知结果') } })); t.after(() => model.dispose())
  await model.activate(); await model.selectTrack(item().track.id); model.titleDraft.value = '仅显示的重制版'; await model.saveTitle(); const request = model.pendingOverride.value
  assert.ok(request); assert.equal(request.expectedRevision, null); assert.deepEqual(request.fields, { title: '仅显示的重制版' })
  model.titleDraft.value = '换名称'; await model.saveTitle(); model.suspend(); await model.activate(); await model.saveTitle()
  assert.equal(writes.length, 1); assert.equal(model.pendingOverride.value?.commandId, request.commandId); assert.match(model.actionError.value, /未确认/u)
})
test('009重定位只有人工确认后派发，commandId取候选id并保留asset修订', async t => {
  const confirms: any[] = [], candidate = { id: id(80), fileName: '外部改名.wav', relativeLabel: '合成目录 › 外部改名.wav', size: 100, modifiedAt: '2026-10-06T00:00:00.000Z', evidence: 'user-choice' as const }
  const model = session(libraryApi({ chooseLocalRelocationCandidates: async selection => ({ assetId: selection.assetId, candidates: [candidate] }), confirmLocalRelocation: async request => { confirms.push(request); return item().asset } })); t.after(() => model.dispose())
  await model.activate(); await model.selectTrack(item().track.id); await model.locateSelected(); await model.confirmCandidate(candidate.id); assert.equal(confirms.length, 0)
  model.relocationConfirmed.value = true; await model.confirmCandidate(candidate.id); assert.equal(confirms.length, 1); assert.equal(confirms[0].commandId, candidate.id); assert.equal(confirms[0].assetId, item().asset.id); assert.equal(confirms[0].expectedFileRevision, '1'); assert.equal(model.detail.value?.track.id, item().track.id)
})
test('009受理、字节发送与Roon确认分开，外部接管不冒充下一首或沿用旧参数', () => {
  const state = snapshot(), request: LocalPlayRequest = { schema_version: '1.2', request_id: state.local!.request_id, route: 'roon_audio_input', source_kind: 'local_file', local_track_id: state.local!.local_track_id, asset_id: state.local!.asset_id, expected_asset_revision: '1', target: state.local!.target, action: 'PLAY_NOW' }, receipt = { request, result: { status: 'accepted' as const, request_id: request.request_id, action: request.action } }
  state.state = 'preparing'; state.local!.phase = 'AWAITING_ROON'; state.local!.delivery_state = 'BYTES_SENT'; state.local!.ownership = 'MB_PENDING'; state.local!.roon_observation = { event: 'NONE', observed: false, correlation: 'UNKNOWN' }
  assert.match(localLibraryPlaybackStatus(state, receipt).state, /等待 Roon/u); assert.match(localLibraryPlaybackStatus(state, receipt).delivery, /字节已发送/u)
  state.local!.file_parameters = { container: 'FLAC', codec: 'FLAC', sampleRateHz: 96000, channels: 2, bitsPerSample: 24, durationMs: null, lossless: true, evidence: 'bounded-parser-reported' }
  state.currentTrack!.id = '另一首'; assert.equal(audioQualityDetails(state).file, '文件参数未知')
  state.source = 'roon'; state.local!.phase = 'OWNERSHIP_LOST'; state.local!.ownership = 'EXTERNAL'; state.local!.queue_owner = 'ROON_NATIVE_EXTERNAL'; assert.match(mbQueueOwnershipStatus(state)!, /MB 已保存队列.*暂停/u); assert.match(localLibraryPlaybackStatus(state, receipt).state, /所有权已改变/u); assert.equal(audioQualityDetails(state).file, '文件参数未知')
})
test('009正式播放会话沿原协调器，local UUID零云歌词、收藏、数字重播', async t => {
  let cloud = 0; const sent: LocalPlayRequest[] = [], state = snapshot()
  const fail = async () => { cloud++; throw new Error('本地不可调用Provider') }
  const api = { playLocalLibraryTrack: async (request: LocalPlayRequest) => { sent.push(request); return { status: 'accepted', request_id: request.request_id, action: request.action } }, getPlaybackState: async () => state, getLyrics: fail, getTrackLikeStatus: fail, setTrackLiked: fail, play: fail } as unknown as MusicBridgePublicApi
  const playback = usePlaybackSession({ api, getSelectedZone: () => ({ zoneId: 'zone-safe', displayName: '受控目标', selected: true }), getZoneLifecycleStatus: () => 'selected', getSelectedQuality: () => 'auto', getMatchResult: () => undefined, getPendingMatch: () => undefined, onMatchTracks() {}, getRoonPlaybackContext: () => undefined, resolveFavoriteDescriptor: () => { throw new Error('local无旧Provider身份') }, onEnterNowPlaying() {}, clearActionError() {}, onActionMessage() {}, onError: error => { throw error }, onToast() {} }); t.after(() => playback.dispose())
  const request: LocalPlayRequest = { schema_version: '1.2', request_id: state.local!.request_id, route: 'roon_audio_input', source_kind: 'local_file', local_track_id: state.local!.local_track_id, asset_id: state.local!.asset_id, expected_asset_revision: '1', target: state.local!.target, action: 'PLAY_NOW' }
  assert.equal((await playback.playLocalLibrarySelection(request)).status, 'accepted'); await playback.toggleTrackLike(); assert.equal(sent.length, 1); assert.equal(cloud, 0); assert.equal(playback.playbackSource.value, 'local_file'); assert.equal(playback.recentTracks.value.length, 0)
})

function outboxEntry(commandId: string, command: CommandOutboxView['command'], state: CommandOutboxState, datasetId = id(90)): CommandOutboxView {
  return { id: id(91), commandId, command, datasetId, state, createdAt: '2026-10-07T00:00:00.000Z', updatedAt: '2026-10-07T00:00:00.000Z', acknowledged: false, canRetry: state === 'uncertain' }
}
test('009R1 UNKNOWN与所有权丢失保留未知事实及MB队列，不断言外部接管', () => {
  const state = snapshot(); state.local!.phase = 'OWNERSHIP_LOST'; state.local!.ownership = 'UNKNOWN'; state.local!.queue_owner = 'MB'; state.local!.roon_observation = { event: 'UNKNOWN', observed: false, correlation: 'UNKNOWN' }
  assert.match(mbQueueOwnershipStatus(state)!, /未知.*MB 已保存队列.*暂停/u)
  assert.doesNotMatch(mbQueueOwnershipStatus(state)!, /当前由 Roon 外部播放控制/u)
  assert.match(localLibraryPlaybackStatus(state, null).state, /未知|未确认/u)
  state.local!.phase = 'SUBMISSION_UNKNOWN'; assert.match(mbQueueOwnershipStatus(state)!, /未知/u)
  state.local!.ownership = 'EXTERNAL'; state.local!.queue_owner = 'ROON_NATIVE_EXTERNAL'; assert.match(mbQueueOwnershipStatus(state)!, /当前由 Roon 外部播放控制/u)
  state.local!.phase = 'PLAYING'; state.local!.ownership = 'MB_OWNED'; state.local!.queue_owner = 'MB'; assert.equal(mbQueueOwnershipStatus(state), null)
})
test('009R1 当前公开Playing不依赖页面回执，追加队列的最近请求不能遮盖它', () => {
  const state = snapshot()
  assert.match(localLibraryPlaybackStatus(state, null).state, /Roon 已确认播放/u)
  const request: LocalPlayRequest = { schema_version: '1.2', request_id: '最新队列请求', route: 'roon_audio_input', source_kind: 'local_file', local_track_id: '另一曲目', asset_id: '另一资产', expected_asset_revision: '3', target: state.local!.target, action: 'APPEND_MB_QUEUE' }
  const status = localLibraryPlaybackStatus(state, { request, result: { status: 'accepted', request_id: request.request_id, action: request.action } })
  assert.match(status.state, /Roon 已确认播放/u); assert.match((status as any).request, /队列.*受理/u)
  state.local!.phase = 'PAUSED'; state.local!.roon_observation.event = 'PAUSED'; assert.match(localLibraryPlaybackStatus(state, null).state, /Roon 已确认暂停/u)
  state.currentTrack!.id = '陈旧曲目'; assert.doesNotMatch(localLibraryPlaybackStatus(state, null).state, /Roon 已确认暂停/u)
  state.currentTrack!.id = state.local!.local_track_id; state.queue.items[0]!.local!.asset_revision = '2'; assert.doesNotMatch(localLibraryPlaybackStatus(state, null).state, /Roon 已确认暂停/u)
  state.queue.items[0]!.local!.asset_revision = '1'; state.selectedZoneId = '另一个Zone'; assert.doesNotMatch(localLibraryPlaybackStatus(state, null).state, /Roon 已确认暂停/u)
})
test('009R1 点播派发前保留request身份，丢ACK后仍可关联公开确认且不重发', async t => {
  let fail!: (reason: Error) => void
  const sends: LocalPlayRequest[] = [], api = libraryApi()
  const model = useLocalLibrary({ api, getSelectedZone: () => ({ zoneId: '受控Zone', displayName: '合成目标', selected: true }), play: request => { sends.push(request); return new Promise((_resolve, reject) => { fail = reject }) } }); t.after(() => model.dispose())
  await model.activate(); const pending = model.playTrack(item().track.id)
  for (let i = 0; i < 4; i++) await Promise.resolve()
  assert.equal(sends.length, 1); assert.equal(model.lastPlay.value?.request.request_id, sends[0]!.request_id)
  assert.match((localLibraryPlaybackStatus(null, model.lastPlay.value) as any).request, /等待.*受理|等待.*回执/u)
  fail(new Error('合成ACK丢失')); await pending
  assert.equal(model.lastPlay.value?.request.request_id, sends[0]!.request_id); assert.match((localLibraryPlaybackStatus(null, model.lastPlay.value) as any).request, /未知|未确认/u)
  const state = snapshot(); state.local!.request_id = sends[0]!.request_id; state.local!.local_track_id = sends[0]!.local_track_id; state.local!.asset_id = sends[0]!.asset_id; state.local!.target = sends[0]!.target; state.currentTrack!.id = sends[0]!.local_track_id; state.queue.items[0]!.trackId = sends[0]!.local_track_id; state.queue.items[0]!.local!.local_track_id = sends[0]!.local_track_id; state.queue.items[0]!.local!.asset_id = sends[0]!.asset_id
  assert.match(localLibraryPlaybackStatus(state, model.lastPlay.value).state, /Roon 已确认播放/u); assert.equal(sends.length, 1)
})
test('009R1 新动作准备失败保留最近已派发请求及原参数', async t => {
  const model = session(); t.after(() => model.dispose()); await model.activate(); await model.playTrack(item().track.id)
  const previous = model.lastPlay.value; assert.ok(previous)
  await model.playTrack('不再存在的曲目')
  assert.equal(model.lastPlay.value, previous); assert.equal(model.lastPlay.value?.request.asset_id, item().asset.id)
})
test('009R1 显示更正仅按原dataset/command/id终态恢复并重新读取当前修订', async t => {
  let overview: CommandOutboxOverview = { datasetId: id(90), entries: [] }, revision = 0, reads = 0, writes = 0
  const model = session(libraryApi({ getCommandOutbox: async () => overview, getLocalLibraryTrackDetail: async () => { reads++; const value = detail(); if (revision) { value.metadata.override = { trackId: value.track.id, revision: String(revision), fields: { title: '终态后的显示名' } }; value.metadata.effective = { ...value.metadata.raw, title: '终态后的显示名' } } return value }, overrideLocalLibraryMetadata: async () => { writes++; throw new Error('合成未知') } })); t.after(() => model.dispose())
  await model.activate(); await model.selectTrack(item().track.id); model.titleDraft.value = '原请求显示名'; await model.saveTitle()
  const original = model.pendingOverride.value!; assert.ok(original)
  for (const state of ['uncertain', 'dismissed'] as const) { overview = { datasetId: id(90), entries: [outboxEntry(original.commandId, 'localCatalog.overrideMetadata', state)] }; await model.refresh(); assert.equal(model.pendingOverride.value?.commandId, original.commandId) }
  overview = { datasetId: id(92), entries: [outboxEntry(original.commandId, 'localCatalog.overrideMetadata', 'succeeded')] }; await model.refresh(); assert.ok(model.pendingOverride.value)
  overview = { datasetId: id(90), entries: [outboxEntry(id(93), 'localCatalog.overrideMetadata', 'succeeded')] }; await model.refresh(); assert.ok(model.pendingOverride.value)
  overview = { datasetId: id(90), entries: [outboxEntry(original.commandId, 'localRelocation.confirm', 'succeeded')] }; await model.refresh(); assert.ok(model.pendingOverride.value)
  const previousReads = reads; revision = 2; overview = { datasetId: id(90), entries: [outboxEntry(original.commandId, 'localCatalog.overrideMetadata', 'succeeded')] }; await model.refresh()
  assert.equal(model.pendingOverride.value, null); assert.equal(model.detail.value?.metadata.override?.revision, '2'); assert.ok(reads > previousReads); assert.equal(writes, 1); assert.doesNotMatch(model.actionError.value, /结果未确认/u)
  model.titleDraft.value = '独立新更正'; await model.saveTitle(); assert.equal(writes, 2); const nextOverride = model.pendingOverride.value as typeof original | null; assert.ok(nextOverride); assert.notEqual(nextOverride.commandId, original.commandId)
  ;(model as any).observeOutbox(overview); assert.ok(model.pendingOverride.value, '重复旧终态不能清新的pending')
})
test('009R1 拒绝终态释放原显示更正锁但保留拒绝说明，不重放业务', async t => {
  let entries: CommandOutboxView[] = [], writes = 0
  const model = session(libraryApi({ getCommandOutbox: async () => ({ datasetId: id(90), entries }), overrideLocalLibraryMetadata: async () => { writes++; throw new Error('合成未知') } })); t.after(() => model.dispose())
  await model.activate(); await model.selectTrack(item().track.id); model.titleDraft.value = '拒绝候选'; await model.saveTitle(); entries = [outboxEntry(model.pendingOverride.value!.commandId, 'localCatalog.overrideMetadata', 'rejected')]
  await model.refresh(); assert.equal(model.pendingOverride.value, null); assert.match(model.actionError.value, /已拒绝/u); assert.equal(writes, 1)
})
test('009R1 重定位未知保留原候选请求，原终态事件恢复且不自动派发', async t => {
  let calls = 0
  const candidate = { id: id(80), fileName: '改名.wav', relativeLabel: '合成 › 改名.wav', size: 100, modifiedAt: '2026-10-06T00:00:00.000Z', evidence: 'user-choice' as const }
  const model = session(libraryApi({ chooseLocalRelocationCandidates: async selection => ({ assetId: selection.assetId, candidates: [candidate] }), confirmLocalRelocation: async () => { calls++; throw new Error('合成未知') } })); t.after(() => model.dispose())
  await model.activate(); await model.selectTrack(item().track.id); await model.locateSelected(); model.relocationConfirmed.value = true; await model.confirmCandidate(candidate.id)
  assert.equal(model.relocationUnknown.value, true); assert.equal((model as any).pendingRelocation.value.request.commandId, candidate.id)
  model.suspend(); (model as any).observeOutbox({ datasetId: id(92), entries: [outboxEntry(candidate.id, 'localRelocation.confirm', 'succeeded')] }); assert.equal(model.relocationUnknown.value, true, '离页异工作库事件不直接清锁')
  await model.activate(); assert.equal(model.relocationUnknown.value, true, '异工作库终态不作为恢复证明')
  ;(model as any).observeOutbox({ datasetId: id(90), entries: [outboxEntry(candidate.id, 'localRelocation.confirm', 'succeeded')] }); await model.refresh()
  assert.equal(model.relocationUnknown.value, false); assert.equal((model as any).pendingRelocation.value, null); assert.equal(model.candidates.value, null); assert.equal(calls, 1)
})
test('009R1 Outbox迟到读取与离页代际不能清原pending，更不能重发', async t => {
  let deferredRead = false
  const late = deferred<CommandOutboxOverview>(), model = session(libraryApi({ getCommandOutbox: () => deferredRead ? late.promise : Promise.resolve({ datasetId: id(90), entries: [] }), overrideLocalLibraryMetadata: async () => { throw new Error('合成未知') } })); t.after(() => model.dispose())
  await model.activate(); await model.selectTrack(item().track.id); model.titleDraft.value = '原候选'; await model.saveTitle(); const commandId = model.pendingOverride.value!.commandId
  deferredRead = true; const reading = model.refresh(); model.suspend(); late.resolve({ datasetId: id(90), entries: [outboxEntry(commandId, 'localCatalog.overrideMetadata', 'succeeded')] }); await reading
  assert.equal(model.pendingOverride.value?.commandId, commandId)
})

test('009R1 离页中的派发丢ACK仍保留原request未知结论，返回不自动重发', async t => {
  let fail!: (error: Error) => void; let sends = 0
  const model = useLocalLibrary({ api: libraryApi(), getSelectedZone: () => ({ zoneId: '受控Zone', displayName: '合成目标', selected: true }), play: () => { sends++; return new Promise((_resolve, reject) => { fail = reject }) } }); t.after(() => model.dispose())
  await model.activate(); const pending = model.playTrack(item().track.id); for (let i = 0; i < 4; i++) await Promise.resolve()
  const requestId = model.lastPlay.value!.request.request_id; model.suspend(); fail(new Error('合成离页ACK丢失')); await pending; await model.activate()
  assert.equal(model.lastPlay.value?.request.request_id, requestId); assert.match(localLibraryPlaybackStatus(null, model.lastPlay.value).request, /未知|未确认/u); assert.equal(sends, 1)
})
test('009R1 已加载工作库变化后不以新dataset绑定原页面写意图', async t => {
  let datasetId = id(90), writes = 0
  const model = session(libraryApi({ getCommandOutbox: async () => ({ datasetId, entries: [] }), overrideLocalLibraryMetadata: async request => { writes++; return { trackId: request.trackId, revision: '1', fields: request.fields } } })); t.after(() => model.dispose())
  await model.activate(); await model.selectTrack(item().track.id); datasetId = id(92); model.titleDraft.value = '旧页编辑'; await model.saveTitle()
  assert.equal(writes, 0); assert.equal(model.pendingOverride.value, null); assert.match(model.actionError.value, /工作库.*变化|工作库.*核对/u)
})
test('009R1 旧请求相同但公开曲目或资产修订失配，最近状态也不生成Playing', () => {
  const state = snapshot(), request: LocalPlayRequest = { schema_version: '1.2', request_id: state.local!.request_id, route: 'roon_audio_input', source_kind: 'local_file', local_track_id: state.local!.local_track_id, asset_id: state.local!.asset_id, expected_asset_revision: state.local!.asset_revision, target: state.local!.target, action: 'PLAY_NOW' }, receipt = { request, result: { status: 'accepted' as const, request_id: request.request_id, action: request.action } }
  state.currentTrack!.id = '当前另一首'
  const status = localLibraryPlaybackStatus(state, receipt); assert.doesNotMatch(status.state, /Roon 已确认播放/u); assert.doesNotMatch(status.request, /Roon 已确认播放/u)
  state.currentTrack!.id = state.local!.local_track_id; state.queue.items[0]!.local!.asset_revision = '99'
  assert.doesNotMatch(localLibraryPlaybackStatus(state, receipt).request, /Roon 已确认播放/u)
})

test('009R1 显示更正离页收到原Panel成功或拒绝后ACK隐藏，返回同dataset恢复', async t => {
  for (const state of ['succeeded', 'rejected'] as const) {
    let writes = 0, reads = 0, currentRevision = 0
    const model = session(libraryApi({ queryLocalLibraryTracks: async query => { reads++; return page(query) }, getLocalLibraryTrackDetail: async () => { const value = detail(); if (currentRevision) { value.metadata.override = { trackId: value.track.id, revision: String(currentRevision), fields: { title: '原终态修订' } }; value.metadata.effective = { ...value.metadata.raw, title: '原终态修订' } } return value }, overrideLocalLibraryMetadata: async () => { writes++; throw new Error('合成未知') } })); t.after(() => model.dispose())
    await model.activate(); await model.selectTrack(item().track.id); model.titleDraft.value = '原绑定显示名'; await model.saveTitle()
    const pending = model.pendingOverride.value!; model.suspend(); const previousReads = reads
    model.observeOutbox({ datasetId: id(90), entries: [{ ...outboxEntry(pending.commandId, 'localCatalog.overrideMetadata', state), acknowledged: true }] })
    assert.equal(model.pendingOverride.value, pending); assert.equal(reads, previousReads); assert.equal(writes, 1)
    currentRevision = 2; await model.activate()
    assert.equal(model.pendingOverride.value, null); assert.equal(model.detail.value?.metadata.override?.revision, '2'); assert.ok(reads > previousReads); assert.equal(writes, 1)
    if (state === 'rejected') assert.match(model.actionError.value, /已拒绝/u)
  }
})
test('009R1 重定位离页收到原Panel成功或拒绝后ACK隐藏，返回同dataset恢复', async t => {
  for (const state of ['succeeded', 'rejected'] as const) {
    let calls = 0, reads = 0, locationRevision = '1'
    const candidate = { id: id(80), fileName: '改名.wav', relativeLabel: '合成 › 改名.wav', size: 100, modifiedAt: '2026-10-06T00:00:00.000Z', evidence: 'user-choice' as const }
    const model = session(libraryApi({ queryLocalLibraryTracks: async query => { reads++; return page(query) }, getLocalLibraryTrackDetail: async () => { const value = detail(); value.asset.locationRevision = locationRevision; return value }, chooseLocalRelocationCandidates: async selection => ({ assetId: selection.assetId, candidates: [candidate] }), confirmLocalRelocation: async () => { calls++; throw new Error('合成未知') } })); t.after(() => model.dispose())
    await model.activate(); await model.selectTrack(item().track.id); await model.locateSelected(); model.relocationConfirmed.value = true; await model.confirmCandidate(candidate.id)
    model.suspend(); const previousReads = reads
    model.observeOutbox({ datasetId: id(90), entries: [{ ...outboxEntry(candidate.id, 'localRelocation.confirm', state), acknowledged: true }] })
    assert.equal(model.relocationUnknown.value, true); assert.ok(model.pendingRelocation.value); assert.equal(reads, previousReads); assert.equal(calls, 1)
    locationRevision = '2'; await model.activate()
    assert.equal(model.relocationUnknown.value, false); assert.equal(model.pendingRelocation.value, null); assert.equal(model.candidates.value, null); assert.equal(model.detail.value?.asset.locationRevision, '2'); assert.ok(reads > previousReads); assert.equal(calls, 1)
    if (state === 'rejected') assert.match(model.actionError.value, /已拒绝/u)
  }
})
test('009R1 离页原终态缓存不能在返回异dataset时清锁，回原dataset才消费', async t => {
  let datasetId = id(90), writes = 0
  const model = session(libraryApi({ getCommandOutbox: async () => ({ datasetId, entries: [] }), overrideLocalLibraryMetadata: async () => { writes++; throw new Error('合成未知') } })); t.after(() => model.dispose())
  await model.activate(); await model.selectTrack(item().track.id); model.titleDraft.value = '原页面意图'; await model.saveTitle(); const pending = model.pendingOverride.value!
  model.suspend(); model.observeOutbox({ datasetId: id(90), entries: [{ ...outboxEntry(pending.commandId, 'localCatalog.overrideMetadata', 'succeeded'), acknowledged: true }] })
  datasetId = id(92); await model.activate(); assert.equal(model.pendingOverride.value, pending); assert.equal(writes, 1)
  model.suspend(); datasetId = id(90); await model.activate(); assert.equal(model.pendingOverride.value, null); assert.equal(writes, 1)
})
