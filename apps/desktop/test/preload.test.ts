import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

import type {
  Page,
  PlaylistDetail,
  PlaylistSummary,
  LyricsSnapshot,
  PlaybackSnapshot,
  PublicAuthState,
  PublicAccountState,
  PublicBridgeState,
  DailyRecommendationsSnapshot,
  TrackSummary,
} from '@music-bridge/contracts'
import { createPreloadApi, PUBLIC_API_KEYS } from '../src/preload/api.js'
import { summarizePreloadRoonImage } from '../src/preload/image-diagnostic.js'

test('Preload 图片诊断保持 sandbox 本地实现，不引入 contracts 运行期依赖', async () => {
  const source = await readFile(path.resolve('src/preload/index.ts'), 'utf8')
  assert.match(source, /import type \{[\s\S]*?\} from '@music-bridge\/contracts'/u)
  assert.doesNotMatch(source, /summarizeRoonImageBinary/u)
  assert.deepEqual(summarizePreloadRoonImage({
    contentType: 'image/jpeg',
    body: new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]),
  }), {
    layer: 'preload',
    contentType: 'image/jpeg',
    byteLength: 8,
    magic8: 'ffd8ffe000104a46',
    bodyType: 'Uint8Array',
    isBuffer: false,
    isUint8Array: true,
    isArrayBuffer: false,
    valid: true,
  })
})

test('Preload exposes only sanitized business methods', async () => {
  const appInfo = {
    version: '0.1.0-beta.2',
    buildMode: 'development' as const,
    platform: 'darwin',
  }
  const state: PublicBridgeState = {
    runtime: 'ready',
    roon: 'paired',
    provider: 'missing',
    activeStreamCount: 0,
    activePlaybackPresent: false,
  }
  const authState: PublicAuthState = { status: 'idle' }
  const accountState: PublicAccountState = {
    status: 'ready',
    profile: { displayName: 'Synthetic Account', avatarUrl: 'https://p1.music.126.net/avatar.jpg' },
  }
  const dailyRecommendations: DailyRecommendationsSnapshot = {
    dayKey: '2026-08-22',
    tracks: [],
  }
  const page: Page<TrackSummary> = {
    items: [],
    offset: 0,
    limit: 20,
    total: 0,
    hasMore: false,
  }
  const playlists: readonly PlaylistSummary[] = []
  const playlist: PlaylistDetail = {
    id: '301',
    name: 'Synthetic Playlist',
    trackCount: 0,
    tracks: page,
  }
  const playbackState: PlaybackSnapshot = {
    state: 'idle',
    queue: { items: [], index: -1, hasNext: false, hasPrevious: false },
    positionMs: 0,
    canNext: false,
    canPrevious: false,
    canStop: false,
    canPause: false,
    canResume: false,
  }
  const lyrics: LyricsSnapshot = {
    status: 'unavailable',
    lines: [],
    activeLineIndex: -1,
    timingSource: 'static',
  }
  const api = createPreloadApi(
    async () => appInfo,
    async () => state,
    async () => state,
    async () => ({ pong: true as const }),
    async () => ({ exported: true }),
    async () => authState,
    async () => authState,
    async () => authState,
    async () => authState,
    async () => authState,
    async () => accountState,
    async () => accountState,
    async () => page,
    async () => page,
    async () => playlists,
    async () => playlist,
    async () => dailyRecommendations,
    async () => ({ zones: [] }),
    async () => state,
    async () => lyrics,
    async () => playbackState,
    async () => playbackState,
    async () => playbackState,
    async () => playbackState,
    async () => playbackState,
    async () => playbackState,
    async () => playbackState,
    async () => playbackState,
    async () => playbackState,
    async () => playbackState,
    () => () => undefined,
    () => () => undefined,
  )

  assert.deepEqual(PUBLIC_API_KEYS, [
    'getCommandOutbox',
    'retryCommandOutbox',
    'dismissCommandOutbox',
    'acknowledgeCommandOutbox',
    'activateRestoredDataset',
    'getBackupOverview',
    'chooseBackupRoot',
    'startBackupJob',
    'cancelBackupJob',
    'revokeBackupRoot',
    'listArchiveRoots',
    'chooseArchiveRoot',
    'initializeArchiveRoot',
    'revokeArchiveRoot',
    'previewArchive',
    'startArchive',
    'listArchives',
    'getArchiveOperation',
    'cancelArchive',
    'resumeArchive',
    'verifyArchive',
    'cancelArchiveRead',
    'listRecordingProfiles',
    'getRecordingProfileHistory',
    'getRecordingProfileVersion',
    'saveRecordingProfile',
    'getRecordingSession',
    'saveRecordingSession',
    'listExecutionAssets',
    'previewExecutionAsset',
    'startExecutionAsset',
    'getExecutionJob',
    'cancelExecutionJob',
    'cancelExecutionRead',
    'verifyExecutionAsset',
    'listPrepared',
    'listPreparedSelections',
    'choosePreparedRender',
    'revokePreparedSelection',
    'revokePreparedSelections',
    'previewPreparedImport',
    'startPreparedImport',
    'getPreparedImportJob',
    'cancelPreparedImport',
    'reviewPrepared',
    'freezePrepared',
    'listPreparationDestinations',
    'choosePreparationDestination',
    'revokePreparationDestination',
    'listPreparations',
    'previewPreparation',
    'startPreparation',
    'getPreparationJob',
    'cancelPreparationJob',
    'openPreparationWorkspace',
    'listMasterVersions',
    'previewMasterVersions',
    'freezeMasterVersions',
    'getMasterVersionJob',
    'cancelMasterVersionJob',
    'listMediaPlans',
  'getMediaPlan',
  'previewMediaPlan',
  'balanceMediaPlan',
  'saveMediaPlan',
  'reserveMediaPlan',
  'releaseMediaPlan',
  'listRecordingSourceRoots',
    'chooseRecordingSourceRoot',
    'revokeRecordingSourceRoot',
    'chooseRecordingSource',
    'getDraftSources',
    'getRecordingSourceJob',
    'cancelRecordingSourceJob',
    'recheckRecordingSource',
    'confirmRecordingSource',
    'listMasterDrafts',
    'getMasterDraft',
    'appendMasterDraft',
    'updateMasterDraft',
    'getMasterDraftTrackRuntime',
    'searchPhysicalRoonAlbums',
    'listDigitalAlbums',
    'getDigitalAlbum',
    'getPhysicalLinks',
    'getDigitalRuntime',
    'confirmPhysicalLink',
    'relocateDigitalAlbum',
    'registerDigitalAlbum',
    'removePhysicalLink',
    'confirmPhysicalAbsence',
    'getCollectionMatrix',
    'listPhysicalMusic',
    'getPhysicalMusic',
    'savePhysicalRelease',
    'saveLegacyRecording',
    'addPhysicalMusicPhoto',
    'getPhysicalMusicPhoto',
    'removePhysicalMusicPhoto',
    'pickCollectionPhoto',
    'addCollectionPhoto',
    'getCollectionPhoto',
    'changeCollectionPhoto',
    'listCollection',
    'getCollectionModel',
    'receiveCollectionStock',
    'materializeCollectionCopy',
    'updateCollectionCopy',
    'setCollectionPolicy',
    'getAppInfo',
    'getCoreHealth',
    'getCoreState',
    'pingCore',
    'exportDiagnostics',
    'getAuthState',
    'beginQrLogin',
    'pollQrLogin',
    'cancelQrLogin',
    'logout',
    'getAccountState',
  'refreshAccountProfile',
  'searchTracks',
  'searchArtists',
  'searchAlbums',
  'getArtist',
  'getAlbum',
    'getLikedTracks',
    'getTrackLikeStatus',
    'setTrackLiked',
    'matchLibraryTrack',
    'aggregateSearch',
    'seek',
    'getUserPlaylists',
    'getPlaylist',
    'getDailyRecommendations',
    'listFavorites',
    'checkFavorite',
    'setFavorite',
    'listZones',
    'selectZone',
    'listRoonAlbums',
    'listRoonArtists',
    'listRoonGenres',
    'listRoonPlaylists',
    'getRoonAlbumTracks',
    'getRoonArtistAlbums',
    'getRoonGenreItems',
    'getRoonPlaylistTracks',
    'searchRoonLibrary',
    'getRoonImage',
    'playRoonTrack',
    'queueRoonTrack',
    'stopRoonTransport',
    'getLyrics',
    'getLocalLyricsMatch',
    'selectLocalLyricsMatch',
    'revokeLocalLyricsMatch',
    'getPlaybackState',
    'play',
    'pause',
    'resume',
    'stop',
    'next',
    'previous',
    'playQueueIndex',
    'replaceQueue',
    'appendQueue',
    'insertNext',
    'onCoreEvent',
    'onAppCommand',
    'getRemoteCoreState',
    'startRemoteCore',
    'stopRemoteCore',
    'reconnectRemoteCore',
    'onRemoteCoreEvent',
  ])
  assert.deepEqual(Object.keys(api), [
    'getCommandOutbox',
    'retryCommandOutbox',
    'dismissCommandOutbox',
    'acknowledgeCommandOutbox',
    'activateRestoredDataset',
    'getBackupOverview',
    'chooseBackupRoot',
    'startBackupJob',
    'cancelBackupJob',
    'revokeBackupRoot',
    'listArchiveRoots',
    'chooseArchiveRoot',
    'initializeArchiveRoot',
    'revokeArchiveRoot',
    'previewArchive',
    'startArchive',
    'listArchives',
    'getArchiveOperation',
    'cancelArchive',
    'resumeArchive',
    'verifyArchive',
    'cancelArchiveRead',
    'listRecordingProfiles',
    'getRecordingProfileHistory',
    'getRecordingProfileVersion',
    'saveRecordingProfile',
    'getRecordingSession',
    'saveRecordingSession',
    'listExecutionAssets',
    'previewExecutionAsset',
    'startExecutionAsset',
    'getExecutionJob',
    'cancelExecutionJob',
    'cancelExecutionRead',
    'verifyExecutionAsset',
    'listPrepared',
    'listPreparedSelections',
    'choosePreparedRender',
    'revokePreparedSelection',
    'revokePreparedSelections',
    'previewPreparedImport',
    'startPreparedImport',
    'getPreparedImportJob',
    'cancelPreparedImport',
    'reviewPrepared',
    'freezePrepared',
    'listPreparationDestinations',
    'choosePreparationDestination',
    'revokePreparationDestination',
    'listPreparations',
    'previewPreparation',
    'startPreparation',
    'getPreparationJob',
    'cancelPreparationJob',
    'openPreparationWorkspace',
    'listMasterVersions',
    'previewMasterVersions',
    'freezeMasterVersions',
    'getMasterVersionJob',
    'cancelMasterVersionJob',
    'listMediaPlans',
  'getMediaPlan',
  'previewMediaPlan',
  'balanceMediaPlan',
  'saveMediaPlan',
  'reserveMediaPlan',
  'releaseMediaPlan',
  'listRecordingSourceRoots',
    'chooseRecordingSourceRoot',
    'revokeRecordingSourceRoot',
    'chooseRecordingSource',
    'getDraftSources',
    'getRecordingSourceJob',
    'cancelRecordingSourceJob',
    'recheckRecordingSource',
    'confirmRecordingSource',
    'listMasterDrafts',
    'getMasterDraft',
    'appendMasterDraft',
    'updateMasterDraft',
    'getMasterDraftTrackRuntime',
    'searchPhysicalRoonAlbums',
    'listDigitalAlbums',
    'getDigitalAlbum',
    'getPhysicalLinks',
    'getDigitalRuntime',
    'confirmPhysicalLink',
    'relocateDigitalAlbum',
    'registerDigitalAlbum',
    'removePhysicalLink',
    'confirmPhysicalAbsence',
    'getCollectionMatrix',
    'listPhysicalMusic',
    'getPhysicalMusic',
    'savePhysicalRelease',
    'saveLegacyRecording',
    'addPhysicalMusicPhoto',
    'getPhysicalMusicPhoto',
    'removePhysicalMusicPhoto',
    'pickCollectionPhoto',
    'addCollectionPhoto',
    'getCollectionPhoto',
    'changeCollectionPhoto',
    'listCollection',
    'getCollectionModel',
    'receiveCollectionStock',
    'materializeCollectionCopy',
    'updateCollectionCopy',
    'setCollectionPolicy',
    'getAppInfo',
    'getCoreHealth',
    'getCoreState',
    'pingCore',
    'exportDiagnostics',
    'getAuthState',
    'beginQrLogin',
    'pollQrLogin',
    'cancelQrLogin',
    'logout',
    'getAccountState',
  'refreshAccountProfile',
  'searchTracks',
  'searchArtists',
  'searchAlbums',
  'getArtist',
  'getAlbum',
    'getLikedTracks',
    'getTrackLikeStatus',
    'setTrackLiked',
    'matchLibraryTrack',
    'aggregateSearch',
    'seek',
    'getUserPlaylists',
    'getPlaylist',
    'getDailyRecommendations',
    'listFavorites',
    'checkFavorite',
    'setFavorite',
    'listZones',
    'selectZone',
    'listRoonAlbums',
    'listRoonArtists',
    'listRoonGenres',
    'listRoonPlaylists',
    'getRoonAlbumTracks',
    'getRoonArtistAlbums',
    'getRoonGenreItems',
    'getRoonPlaylistTracks',
    'searchRoonLibrary',
    'getRoonImage',
    'playRoonTrack',
    'queueRoonTrack',
    'stopRoonTransport',
    'getLyrics',
    'getLocalLyricsMatch',
    'selectLocalLyricsMatch',
    'revokeLocalLyricsMatch',
    'getPlaybackState',
    'play',
    'pause',
    'resume',
    'stop',
    'next',
    'previous',
    'playQueueIndex',
    'replaceQueue',
    'appendQueue',
    'insertNext',
    'onCoreEvent',
    'onAppCommand',
    'getRemoteCoreState',
    'startRemoteCore',
    'stopRemoteCore',
    'reconnectRemoteCore',
    'onRemoteCoreEvent',
  ])
  assert.equal(Object.isFrozen(api), true)
  assert.deepEqual(await api.getAppInfo(), appInfo)
  assert.deepEqual(await api.getCoreHealth(), state)
  assert.deepEqual(await api.getCoreState(), state)
  assert.deepEqual(await api.pingCore(), { pong: true })
  assert.deepEqual(await api.exportDiagnostics(), { exported: true })
  assert.deepEqual(await api.getAuthState(), authState)
  assert.deepEqual(await api.beginQrLogin(), authState)
  assert.deepEqual(await api.pollQrLogin('challenge-1'), authState)
  assert.deepEqual(await api.cancelQrLogin('challenge-1'), authState)
  assert.deepEqual(await api.logout(), authState)
  assert.deepEqual(await api.getAccountState(), accountState)
  assert.deepEqual(await api.refreshAccountProfile(), accountState)
  assert.deepEqual(await api.searchTracks('synthetic', { offset: 0, limit: 20 }), page)
  assert.deepEqual(await api.getLikedTracks({ offset: 0, limit: 20 }), page)
  await assert.rejects(
    () => api.matchLibraryTrack({ id: '301', title: 'Synthetic Song', artists: ['Synthetic Artist'], album: 'Synthetic Album' }),
    /Roon matching API is unavailable/,
  )
  await assert.rejects(
    () => api.aggregateSearch('synthetic', { offset: 0, limit: 20 }),
    /Aggregated search API is unavailable/,
  )
  await assert.rejects(
    () => api.seek(12_345),
    /Roon Transport seek API is unavailable/,
  )
  assert.deepEqual(await api.getUserPlaylists(), playlists)
  assert.deepEqual(await api.getPlaylist('301', { offset: 0, limit: 20 }), playlist)
  assert.deepEqual(await api.getDailyRecommendations(), dailyRecommendations)
  assert.deepEqual(await api.listZones(), { zones: [] })
  assert.deepEqual(await api.selectZone('zone-1'), state)
  assert.deepEqual(await api.getLyrics('301'), lyrics)
  assert.deepEqual(await api.getLocalLyricsMatch(), { status: 'hidden', candidates: [], canRevoke: false })
  await assert.rejects(() => api.selectLocalLyricsMatch('session-0123456789abcdef', 'candidate-0123456789abcdef'), /unavailable/iu)
  await assert.rejects(() => api.revokeLocalLyricsMatch(), /unavailable/iu)
  assert.deepEqual(await api.getPlaybackState(), playbackState)
  assert.deepEqual(await api.play('301', 'lossless'), playbackState)
  assert.deepEqual(await api.pause(), playbackState)
  assert.deepEqual(await api.resume(), playbackState)
  assert.deepEqual(await api.stop(), playbackState)
  assert.deepEqual(await api.next(), playbackState)
  assert.deepEqual(await api.previous(), playbackState)
  await assert.rejects(
    () => api.playQueueIndex(0),
    /Queue index API is unavailable/,
  )
  assert.deepEqual(
    await api.replaceQueue([{ trackId: '301', qualityPreference: 'lossless' }], 0),
    playbackState,
  )
})

test('outbox预加载在编辑前固定scope，等待期间的原DTO不被外部修改，成功后确认接收', async () => {
  const module = await import('../src/preload/command-outbox-client.js').catch(() => ({}))
  assert.ok('createCommandOutboxClient' in module, '缺少持久命令预加载接线')
  const create = (module as typeof import('../src/preload/command-outbox-client.js')).createCommandOutboxClient
  const scope = '11111111-1111-4111-8111-111111111111', id = '22222222-2222-4222-8222-222222222222'
  let release!: (value: unknown) => void
  const calls: Array<[string, unknown]> = []
  const client = create(async (channel, value) => {
    calls.push([channel, value])
    if (channel === 'commandOutbox:context') return new Promise(resolve => { release = resolve })
    if (channel === 'commandOutbox:submit') return { ok: true, outboxId: id, result: { modelId: id } }
    return undefined
  })
  const request = { commandId: id, model: { brand: '合成', name: '编辑时原文', edition: '测试', year: 1990, format: 'cassette' as const, tapeType: 'II' as const, identification: 'verified' as const }, lengthMinutes: 60, quantities: { sealedBlank: 1, openedBlank: 0, legacyUsed: 0, unclassified: 0 } }
  const pending = client.submit('collection.receive', request); request.model.name = '迟到的修改'
  release({ datasetId: scope })
  assert.deepEqual(await pending, { modelId: id })
  assert.equal(calls.filter(([channel]) => channel === 'commandOutbox:context').length, 1)
  assert.deepEqual(calls[1], ['commandOutbox:submit', { request: { datasetId: scope, command: 'collection.receive', payload: { ...request, model: { ...request.model, name: '编辑时原文' } } } }])
  assert.deepEqual(calls[2], ['commandOutbox:acknowledge', { id }])
})

test('outbox预加载只在同会话明确再调用时带retryConfirmed，冷启不发送业务', async () => {
  const module = await import('../src/preload/command-outbox-client.js').catch(() => ({}))
  assert.ok('createCommandOutboxClient' in module)
  const create = (module as typeof import('../src/preload/command-outbox-client.js')).createCommandOutboxClient
  const id = '22222222-2222-4222-8222-222222222222', calls: Array<[string, unknown]> = []
  let attempts = 0
  const client = create(async (channel, value) => {
    calls.push([channel, value])
    if (channel === 'commandOutbox:context') return { datasetId: id }
    if (channel === 'commandOutbox:submit') return ++attempts === 1 ? { ok: false, code: 'OUTBOX_RESULT_UNKNOWN' } : { ok: true, outboxId: id, result: { revoked: true } }
    throw new Error('模拟确认回执丢失，不暴露内容')
  })
  await Promise.resolve(); assert.deepEqual(calls.map(([channel]) => channel), ['commandOutbox:context'])
  const request = { commandId: id, id }
  await assert.rejects(client.submit('recordingSources.revoke', request), /OUTBOX_RESULT_UNKNOWN/u)
  assert.deepEqual(await client.submit('recordingSources.revoke', request), { revoked: true })
  assert.equal((calls.filter(([channel]) => channel === 'commandOutbox:submit')[0]![1] as { retryConfirmed?: boolean }).retryConfirmed, undefined)
  assert.equal((calls.filter(([channel]) => channel === 'commandOutbox:submit')[1]![1] as { retryConfirmed?: boolean }).retryConfirmed, true)
})

test('outbox预加载无有效scope不发送，结果信封非法不确认，错误不透传内部内容', async () => {
  const module = await import('../src/preload/command-outbox-client.js').catch(() => ({}))
  assert.ok('createCommandOutboxClient' in module)
  const create = (module as typeof import('../src/preload/command-outbox-client.js')).createCommandOutboxClient
  const id = '22222222-2222-4222-8222-222222222222', calls: string[] = []
  const invalid = create(async channel => { calls.push(channel); return { datasetId: '/private/untrusted' } })
  await assert.rejects(invalid.submit('recordingSources.revoke', { commandId: id, id }), /OUTBOX_UNAVAILABLE/u)
  assert.deepEqual(calls, ['commandOutbox:context'])
  const badResult = create(async channel => { if (channel === 'commandOutbox:context') return { datasetId: id }; if (channel === 'commandOutbox:submit') return { ok: true, outboxId: '/private/untrusted', result: {} }; throw new Error('不能到达ack') })
  await assert.rejects(badResult.submit('recordingSources.revoke', { commandId: id, id }), /OUTBOX_RESULT_UNKNOWN/u)
})

test('PREP批次在等待scope前捕获整组原请求，单次发送，失败后只在人工重试恢复并逐项确认', async () => {
  const { createCommandOutboxClient } = await import('../src/preload/command-outbox-client.js')
  const ids = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222']
  const requests = ids.map(id => ({ id, commandId: id })), original = structuredClone(requests)
  const calls: Array<[string, unknown]> = []; let release!: (value: unknown) => void, attempts = 0
  const results = ids.map(id => ({ id, preparationId: ids[0], side: 'A', label: '合成', authorized: false }))
  const client = createCommandOutboxClient(async (channel, value) => {
    calls.push([channel, value])
    if (channel === 'commandOutbox:context') return new Promise(resolve => { release = resolve })
    if (channel === 'commandOutbox:revokePreparedBatch') return ++attempts === 1 ? { ok: false, code: 'OUTBOX_RESULT_UNKNOWN' } : { ok: true, submissions: ids.map((id, index) => ({ outboxId: id, result: results[index] })) }
    return undefined
  })
  assert.equal(typeof client.submitPreparedRevocations, 'function')
  const pending = client.submitPreparedRevocations(requests); requests[1]!.id = ids[0]!
  release({ datasetId: ids[0] })
  await assert.rejects(pending, /OUTBOX_RESULT_UNKNOWN/u)
  const first = calls.find(([channel]) => channel === 'commandOutbox:revokePreparedBatch')![1]
  assert.deepEqual(first, { requests: original.map(payload => ({ datasetId: ids[0], command: 'recordingPrepared.revoke', payload })) })
  assert.deepEqual(await client.submitPreparedRevocations(original), results)
  assert.equal((calls.filter(([channel]) => channel === 'commandOutbox:revokePreparedBatch')[1]![1] as { retryConfirmed: boolean }).retryConfirmed, true)
  assert.deepEqual(calls.filter(([channel]) => channel === 'commandOutbox:acknowledge').map(([, value]) => value), ids.map(id => ({ id })))
  assert.equal(calls.some(([channel]) => channel === 'commandOutbox:submit'), false)
})

test('PREP批次不确认不完整的成功信封，不把残缺结果当整批成功', async () => {
  const { createCommandOutboxClient } = await import('../src/preload/command-outbox-client.js')
  const id = '11111111-1111-4111-8111-111111111111', other = '22222222-2222-4222-8222-222222222222'
  let acknowledgements = 0
  const client = createCommandOutboxClient(async channel => {
    if (channel === 'commandOutbox:context') return { datasetId: id }
    if (channel === 'commandOutbox:acknowledge') { acknowledgements++; return undefined }
    return { ok: true, submissions: [{ outboxId: id, result: {} }] }
  })
  assert.equal(typeof client.submitPreparedRevocations, 'function')
  await assert.rejects(client.submitPreparedRevocations([{ commandId: id, id }, { commandId: other, id: other }]), /OUTBOX_RESULT_UNKNOWN/u)
  assert.equal(acknowledgements, 0)
})
