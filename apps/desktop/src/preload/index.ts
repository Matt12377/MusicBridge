import {createLocalLibraryClient} from './local-library-client.js'
import { PerformanceTraceRecorder, isCollectionReadonlySettings, isCollectionRefreshResult } from '@music-bridge/contracts'
import { createPerformanceInvoker, createPerformanceInteractions } from '../shared/performance-transport.js'
import { createLibraryReadTerminalClient } from './library-read-terminal.js'
import { createRecordingPrintClient } from './recording-print-client.js'
import { createRecordingReplicaClient } from './recording-replica-client.js'
import { createRecordingDeviceClient } from './recording-device-client.js'
import { createRecordingRecordClient } from './recording-record-client.js'
import { createRecordingWorkspaceClient } from './recording-workspace-client.js'
import { createRecordingCandidateClient } from './recording-candidate-client.js'
import { createPreparationZipClient } from './preparation-zip-client.js'
import { contextBridge, ipcRenderer } from 'electron'
import type {
  RemoteCoreTunnelState,
  RoonImageResult,
  TrackSummary,
  TypedIpcEvent,
} from '@music-bridge/contracts'

import { createPreloadApi } from './api.js'
import { createRecordingAttemptClient } from './recording-attempt-client.js'
import { createCommandOutboxClient, createCommandOutboxDatasetScope } from './command-outbox-client.js'
import { summarizePreloadRoonImage } from './image-diagnostic.js'
import { unwrapRoonImageIpc, type RoonImageIpcEnvelope } from '../roon-image-ipc.js'

if (!process.contextIsolated) {
  throw new Error('Music Bridge requires contextIsolation')
}

const recordRoonImageShape =
  process.env.MUSIC_BRIDGE_ROON_IMAGE_GATE === '1'
  && /^\/tmp\/musicbridge-roon-image-gate-[A-Za-z0-9._-]+\.jsonl$/u.test(
    process.env.MUSIC_BRIDGE_ROON_IMAGE_GATE_PATH ?? '',
  )

const rendererPerformance = new PerformanceTraceRecorder({ component: 'renderer', enabled: process.argv?.includes('--music-bridge-performance-trace=1') ?? false })
const interactions = createPerformanceInteractions(rendererPerformance)
const invokePerformance: typeof ipcRenderer.invoke = createPerformanceInvoker(
  (channel, ...args) => ipcRenderer.invoke(channel, ...args), rendererPerformance,
  callback => { if (typeof requestAnimationFrame === 'function') requestAnimationFrame(callback) },
  interactions.consume,
) as typeof ipcRenderer.invoke
const invokeScoped = (channel: string, value?: unknown): Promise<unknown> => invokePerformance(channel, value)
const getDatasetId = createCommandOutboxDatasetScope(invokeScoped)
const outbox = createCommandOutboxClient(invokeScoped, getDatasetId)
const workspaceClient = createRecordingWorkspaceClient(invokeScoped, request => outbox.submit('recordingWorkspace.put', request), getDatasetId)
const candidateClient = createRecordingCandidateClient(invokeScoped, request => outbox.submit('recordingCandidates.select', request), getDatasetId)
const preparationZipClient = createPreparationZipClient(invokeScoped, getDatasetId)

contextBridge.exposeInMainWorld(
  'musicBridge',
  createPreloadApi(
    () => invokePerformance('app:get-info'),
    () => invokePerformance('core:get-health'),
    () => invokePerformance('core:get-state'),
    () => invokePerformance('core:ping'),
    () => invokePerformance('diagnostics:export'),
    () => invokePerformance('auth:get-state'),
    () => invokePerformance('auth:begin-qr'),
    (challengeId: string) => invokePerformance('auth:poll-qr', challengeId),
    (challengeId: string) => invokePerformance('auth:cancel-qr', challengeId),
    () => invokePerformance('auth:logout'),
    () => invokePerformance('account:get-state'),
    () => invokePerformance('account:refresh'),
    (query: string, page: { offset: number; limit: number }) =>
      invokePerformance('library:search', query, page),
    (page: { offset: number; limit: number }) => invokePerformance('library:liked', page),
    () => invokePerformance('library:playlists'),
    (playlistId: string, page: { offset: number; limit: number }) =>
      invokePerformance('library:playlist', playlistId, page),
    () => invokePerformance('library:daily-recommendations'),
    () => invokePerformance('roon:list-zones'),
    (zoneId: string) => invokePerformance('roon:select-zone', zoneId),
    (trackId: string) => invokePerformance('lyrics:get', trackId),
    () => invokePerformance('playback:get-state'),
    (trackId: string, qualityPreference: string, rendererClickAtMs?: number) =>
      invokePerformance('playback:play', trackId, qualityPreference, rendererClickAtMs),
    () => invokePerformance('playback:pause'),
    () => invokePerformance('playback:resume'),
    () => invokePerformance('playback:stop'),
    () => invokePerformance('playback:next'),
    () => invokePerformance('playback:previous'),
    (items, index) => invokePerformance('playback:replace-queue', items, index),
    (items) => invokePerformance('playback:append-queue', items),
    (items) => invokePerformance('playback:insert-next', items),
    (listener: (event: TypedIpcEvent) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, message: TypedIpcEvent): void => {
        listener(message)
      }
      ipcRenderer.on('core:event', handler)
      return () => ipcRenderer.removeListener('core:event', handler)
    },
    (listener: (command: 'show-queue') => void) => {
      const handler = (_event: Electron.IpcRendererEvent, command: 'show-queue'): void => {
        if (command === 'show-queue') listener(command)
      }
      ipcRenderer.on('app:command', handler)
      return () => ipcRenderer.removeListener('app:command', handler)
    },
    () => invokePerformance('remote-core:get-state'),
    (sshTarget: string) => invokePerformance('remote-core:start', sshTarget),
    () => invokePerformance('remote-core:stop'),
    () => invokePerformance('remote-core:reconnect'),
    (listener: (state: RemoteCoreTunnelState) => void): (() => void) => {
      const handler = (_event: Electron.IpcRendererEvent, state: RemoteCoreTunnelState): void => {
        listener(state)
      }
      ipcRenderer.on('remote-core:event', handler)
      return () => ipcRenderer.removeListener('remote-core:event', handler)
    },
    (query: string, page: { offset: number; limit: number }) =>
      invokePerformance('library:search-artists', query, page),
    (query: string, page: { offset: number; limit: number }) =>
      invokePerformance('library:search-albums', query, page),
    (artistId: string, page: { offset: number; limit: number }) =>
      invokePerformance('library:artist', artistId, page),
    (albumId: string, page: { offset: number; limit: number }) =>
      invokePerformance('library:album', albumId, page),
    (page: { offset: number; limit: number }) => invokePerformance('roon:library:albums', page),
    (page: { offset: number; limit: number }) => invokePerformance('roon:library:artists', page),
    (page: { offset: number; limit: number }) => invokePerformance('roon:library:genres', page),
    (page: { offset: number; limit: number }) => invokePerformance('roon:library:playlists', page),
    (reference: string, page: { offset: number; limit: number }) =>
      invokePerformance('roon:library:album', reference, page),
    (reference: string, page: { offset: number; limit: number }) =>
      invokePerformance('roon:library:artist', reference, page),
    (reference: string, page: { offset: number; limit: number }) =>
      invokePerformance('roon:library:genre', reference, page),
    (reference: string, page: { offset: number; limit: number }) =>
      invokePerformance('roon:library:playlist', reference, page),
    (query: string, page: { offset: number; limit: number }, kind?: 'track' | 'album' | 'artist') =>
      invokePerformance('roon:library:search', query, page, kind),
    async (reference: string, options?: { scale?: 'fit' | 'fill' | 'stretch'; width?: number; height?: number; format?: 'image/jpeg' | 'image/png' }) => {
      const envelope = await invokePerformance(
        'roon:library:image',
        reference,
        options,
      ) as RoonImageIpcEnvelope
      const result: RoonImageResult = unwrapRoonImageIpc(envelope)
      if (recordRoonImageShape) {
        try {
          await invokePerformance(
            'roon:image:diagnostic',
            summarizePreloadRoonImage(result),
          )
        } catch {
          // 诊断采样不得改变图片行为。
        }
      }
      return result
    },
    (reference: string, zoneId: string, queueReferences?: readonly string[], contextHandle?: string) => contextHandle === undefined
      ? invokePerformance('roon:library:play', reference, zoneId, queueReferences)
      : invokePerformance('roon:library:play', reference, zoneId, queueReferences, contextHandle),
    (reference: string, zoneId: string) => invokePerformance('roon:library:queue', reference, zoneId),
    (kind: 'track' | 'album' | 'artist' | undefined, page: { offset: number; limit: number }) =>
      invokePerformance('favorites:list', kind, page),
    (descriptor) => invokePerformance('favorites:check', descriptor),
    (descriptor, favorite) => invokePerformance('favorites:set', descriptor, favorite),
    (trackId: string) => invokePerformance('library:like-status', trackId),
    (trackId: string, liked: boolean) => invokePerformance('library:like', trackId, liked),
    (track: TrackSummary) => invokePerformance('library:match', track),
    (query: string, page: { offset: number; limit: number }) => invokePerformance('library:aggregate-search', query, page),
    (positionMs: number) => invokePerformance('playback:seek', positionMs),
    () => invokePerformance('roon:transport:stop'),
    (index: number) => invokePerformance('playback:play-queue-index', index),
    () => invokePerformance('lyrics:match:get'),
    (matchSessionId: string, candidateId: string) =>
      invokePerformance('lyrics:match:select', matchSessionId, candidateId),
    () => invokePerformance('lyrics:match:revoke'),
    {
      pickCollectionPhoto: () => invokePerformance('collection:pick-photo'),
      addCollectionPhoto: request => outbox.submit('collection.addPhoto', request),
      getCollectionPhoto: photoId => invokePerformance('collection:photo', photoId),
      changeCollectionPhoto: request => outbox.submit('collection.changePhoto', request),
      listCollection: (page, filter) => invokePerformance('collection:list', page, filter),
      getCollectionModel: (modelId, page) => invokePerformance('collection:detail', modelId, page),
      getCollectionCopy: workspaceClient.getCollectionCopy,
      receiveCollectionStock: request => outbox.submit('collection.receive', request),
      materializeCollectionCopy: request => outbox.submit('collection.materialize', request),
      updateCollectionCopy: request => outbox.submit('collection.updateCopy', request),
      setCollectionPolicy: request => outbox.submit('collection.setPolicy', request),
    },
    {
      listPhysicalMusic: (page, filter) => invokePerformance('physicalMusic:list', page, filter),
      getPhysicalMusic: id => invokePerformance('physicalMusic:detail', id),
      getCommercialCopies: (releaseId, page) => invokePerformance('physicalMusic:copies', releaseId, page),
      savePhysicalRelease: request => outbox.submit('physicalMusic.saveRelease', request),
      materializeCommercialCopy: request => outbox.submit('physicalMusic.materializeCopy', request),
      saveCommercialCopyDetails: request => outbox.submit('physicalMusic.saveCopyDetails', request),
      assignCommercialCopyPhoto: request => outbox.submit('physicalMusic.assignCopyPhoto', request),
      saveLegacyRecording: request => outbox.submit('physicalMusic.saveLegacy', request),
      addPhysicalMusicPhoto: request => outbox.submit('physicalMusic.addPhoto', request),
      getPhysicalMusicPhoto: photoId => invokePerformance('physicalMusic:photo', photoId),
      removePhysicalMusicPhoto: request => outbox.submit('physicalMusic.removePhoto', request),
    },
    {
      searchPhysicalRoonAlbums: (query, page) => invokePerformance('physicalLinks:search', query, page),
      listDigitalAlbums: page => invokePerformance('physicalLinks:digitalList', page),
      getDigitalAlbum: id => invokePerformance('physicalLinks:digitalDetail', id),
      getPhysicalLinks: releaseId => invokePerformance('physicalLinks:physical', releaseId),
      getPhysicalLinkHistory: (releaseId, page) => invokePerformance('physicalLinks:history', releaseId, page),
      getDigitalRuntime: id => invokePerformance('physicalLinks:runtime', id),
      confirmPhysicalLink: request => outbox.submit('physicalLinks.confirmWithEvidence', request),
      relocateDigitalAlbum: request => outbox.submit('physicalLinks.relocate', request),
      registerDigitalAlbum: request => outbox.submit('physicalLinks.register', request),
      removePhysicalLink: request => outbox.submit('physicalLinks.removeWithEvidence', request),
      confirmPhysicalAbsence: request => outbox.submit('physicalLinks.absence', request),
      getCollectionMatrix: (page, query) => invokePerformance('physicalLinks:matrix', page, query),
    },
    {
      listMasterDrafts: page => invokePerformance('recordingDrafts:list', page),
      getMasterDraft: id => invokePerformance('recordingDrafts:detail', id),
      appendMasterDraft: request => outbox.submit('recordingDrafts.append', request),
      updateMasterDraft: request => outbox.submit('recordingDrafts.update', request),
      getMasterDraftTrackRuntime: (draftId, trackId) => invokePerformance('recordingDrafts:runtime', draftId, trackId),
    },
    {
      listRecordingSourceRoots: () => invokePerformance('recordingSources:roots'),
      chooseRecordingSourceRoot: commandId => outbox.submit('recordingSources.chooseRoot', { commandId }),
      revokeRecordingSourceRoot: request => outbox.submit('recordingSources.revoke', request),
      chooseRecordingSource: request => outbox.submit('recordingSources.choose', request),
      getDraftSources: draftId => invokePerformance('recordingSources:snapshot', draftId),
      getRecordingSourceJob: id => invokePerformance('recordingSources:job', id),
      cancelRecordingSourceJob: request => outbox.submit('recordingSources.cancel', request),
      recheckRecordingSource: request => outbox.submit('recordingSources.recheck', request),
      confirmRecordingSource: request => outbox.submit('recordingSources.confirm', request),
    },
    {
      listMediaPlans: draftId => invokePerformance('recordingMedia:plans', draftId),
      getMediaPlan: id => invokePerformance('recordingMedia:detail', id),
      previewMediaPlan: request => invokePerformance('recordingMedia:preview', request),
      balanceMediaPlan: (draftId, spec) => invokePerformance('recordingMedia:balance', draftId, spec),
      saveMediaPlan: request => outbox.submit('recordingMedia.save', request),
      reserveMediaPlan: request => outbox.submit('recordingMedia.reserve', request),
      releaseMediaPlan: request => outbox.submit('recordingMedia.release', request),
    },
    {
      listMasterVersions: draftId => invokePerformance('recordingVersions:list', draftId),
      previewMasterVersions: request => invokePerformance('recordingVersions:preview', request),
      freezeMasterVersions: request => outbox.submit('recordingVersions.freeze', request),
      getMasterVersionJob: id => invokePerformance('recordingVersions:job', id),
      cancelMasterVersionJob: request => outbox.submit('recordingVersions.cancel', request),
    },
    {
      listPreparationDestinations: () => invokePerformance('recordingPreparation:destinations'),
      choosePreparationDestination: commandId => outbox.submit('recordingPreparation.chooseDestination', { commandId }),
      revokePreparationDestination: request => outbox.submit('recordingPreparation.revoke', request),
      listPreparations: draftId => invokePerformance('recordingPreparation:list', draftId),
      previewPreparation: request => invokePerformance('recordingPreparation:preview', request),
      startPreparation: request => outbox.submit('recordingPreparation.start', request),
      getPreparationJob: id => invokePerformance('recordingPreparation:job', id),
      cancelPreparationJob: request => outbox.submit('recordingPreparation.cancel', request),
      openPreparationWorkspace: id => invokePerformance('recordingPreparation:open', id),
    },
    {
      listPrepared: draftId => invokePerformance('recordingPrepared:list', draftId),
      listPreparedSelections: preparationId => invokePerformance('recordingPrepared:selections', preparationId),
      choosePreparedRender: request => outbox.submit('recordingPrepared.choose', request),
      revokePreparedSelection: request => outbox.submit('recordingPrepared.revoke', request),
      revokePreparedSelections: requests => outbox.submitPreparedRevocations(requests),
      previewPreparedImport: request => invokePerformance('recordingPrepared:previewImport', request),
      startPreparedImport: request => outbox.submit('recordingPrepared.startImport', request),
      getPreparedImportJob: id => invokePerformance('recordingPrepared:job', id),
      cancelPreparedImport: request => outbox.submit('recordingPrepared.cancel', request),
      reviewPrepared: request => invokePerformance('recordingPrepared:review', request),
      freezePrepared: request => outbox.submit('recordingPrepared.freeze', request),
    },
    {
      listRecordingProfiles: () => invokePerformance('recordingProfiles:list'),
      getRecordingProfileHistory: profileId => invokePerformance('recordingProfiles:history', profileId),
      getRecordingProfileVersion: versionId => invokePerformance('recordingProfiles:version', versionId),
      saveRecordingProfile: request => outbox.submit('recordingProfiles.save', request),
      getRecordingSession: draftId => invokePerformance('recordingProfiles:session', draftId),
      saveRecordingSession: request => outbox.submit('recordingProfiles.saveSession', request),
    },
    {
      listExecutionAssets: draftId => invokePerformance('recordingExecution:list', draftId),
      previewExecutionAsset: request => invokePerformance('recordingExecution:preview', request),
      startExecutionAsset: request => outbox.submit('recordingExecution.start', request),
      getExecutionJob: id => invokePerformance('recordingExecution:job', id),
      cancelExecutionJob: request => outbox.submit('recordingExecution.cancel', request),
      cancelExecutionRead: id => invokePerformance('recordingExecution:cancelRead', id),
      verifyExecutionAsset: request => invokePerformance('recordingExecution:verify', request),
    },
    {
      listArchiveRoots: () => invokePerformance('recordingArchive:roots'),
      chooseArchiveRoot: commandId => outbox.submit('recordingArchive.choose', { commandId }),
      initializeArchiveRoot: request => outbox.submit('recordingArchive.initialize', request),
      revokeArchiveRoot: request => outbox.submit('recordingArchive.revokeRoot', request),
      previewArchive: request => invokePerformance('recordingArchive:preview', request),
      startArchive: request => outbox.submit('recordingArchive.start', request),
      listArchives: draftId => invokePerformance('recordingArchive:list', draftId),
      getArchiveOperation: id => invokePerformance('recordingArchive:operation', id),
      cancelArchive: request => outbox.submit('recordingArchive.cancel', request),
      resumeArchive: request => outbox.submit('recordingArchive.resume', request),
      verifyArchive: request => invokePerformance('recordingArchive:verify', request),
      cancelArchiveRead: id => invokePerformance('recordingArchive:cancelRead', id),
    },
    {
      activateRestoredDataset: request => outbox.submit('recordingBackups.activate', request),
      getBackupOverview: () => invokePerformance('recordingBackups:overview'),
      chooseBackupRoot: request => outbox.submit('recordingBackups.choose', request),
      startBackupJob: request => outbox.submit('recordingBackups.start', request),
      cancelBackupJob: request => outbox.submit('recordingBackups.cancel', request),
      revokeBackupRoot: request => outbox.submit('recordingBackups.revoke', request),
    },
    {
      getCommandOutbox: () => invokePerformance('commandOutbox:overview'),
      retryCommandOutbox: request => invokePerformance('commandOutbox:retry', request),
      dismissCommandOutbox: request => invokePerformance('commandOutbox:dismiss', request),
      acknowledgeCommandOutbox: request => invokePerformance('commandOutbox:acknowledge', request),
    },
    {
      registerReferenceSource: request => outbox.submit('referenceCatalog.registerSource', request),
      previewReferenceSourceZip: request => invokePerformance('referenceCatalog:previewSourceZip', request),
      registerReferenceSourceZip: request => outbox.submit('referenceCatalog.registerSourceZip', request),
      listReferenceSourceZipReceipts: request => invokePerformance('referenceCatalog:sourceZipReceipts', request),
      listReferenceSources: request => invokePerformance('referenceCatalog:sources', request),
      getReferenceSource: request => invokePerformance('referenceCatalog:source', request),
      previewCatalogRevision: request => invokePerformance('referenceCatalog:previewRevision', request),
      publishCatalogRevision: request => outbox.submit('referenceCatalog.publishRevision', request),
      getCatalogRevision: request => invokePerformance('referenceCatalog:revision', request),
      setCatalogMatch: request => outbox.submit('referenceCatalog.setMatch', request),
      getCatalogSnapshot: request => invokePerformance('referenceCatalog:snapshot', request),
      getCatalogHistory: request => invokePerformance('referenceCatalog:history', request),
    },
    {
      chooseSpreadsheetWorkbook: request => outbox.submit('spreadsheetImports.chooseWorkbook', request),
      listSpreadsheetSources: request => invokePerformance('spreadsheetImports:sources', request),
      getSpreadsheetSource: request => invokePerformance('spreadsheetImports:source', request),
      getSpreadsheetSourceRows: request => invokePerformance('spreadsheetImports:sourceRows', request),
      previewSpreadsheetImport: request => invokePerformance('spreadsheetImports:preview', request),
      applySpreadsheetImport: request => outbox.submit('spreadsheetImports.apply', request),
      getSpreadsheetImportRevision: request => invokePerformance('spreadsheetImports:revision', request),
      listSpreadsheetImportHistory: request => invokePerformance('spreadsheetImports:history', request),
      previewSpreadsheetAdjustment: request => invokePerformance('spreadsheetImports:adjustmentPreview', request),
      adjustSpreadsheetInventory: request => outbox.submit('spreadsheetImports.adjust', request),
      listSpreadsheetAdjustments: request => invokePerformance('spreadsheetImports:adjustments', request),
    },
    {
      listWantEntries: request => invokePerformance('collectionProgress:wants', request),
      saveWantEntry: request => outbox.submit('collectionProgress.saveWant', request),
      cancelWantEntry: request => outbox.submit('collectionProgress.cancelWant', request),
      getWantEntryHistory: request => invokePerformance('collectionProgress:wantHistory', request),
      getCollectionProgress: request => invokePerformance('collectionProgress:current', request),
      captureCollectionProgress: request => outbox.submit('collectionProgress.capture', request),
      listCollectionProgressSnapshots: request => invokePerformance('collectionProgress:snapshots', request),
      getCollectionProgressSnapshot: request => invokePerformance('collectionProgress:snapshot', request),
      getCollectionModelLengths: request => invokePerformance('collectionProgress:modelLengths', request),
    },
    {
      listRecordingPlans: draftId => invokePerformance('recordingPlans:list', { draftId }),
      getRecordingPlanVersion: id => invokePerformance('recordingPlans:version', { id }),
      previewRecordingPlan: request => invokePerformance('recordingPlans:preview', request),
      freezeRecordingPlan: request => outbox.submit('recordingPlans.freeze', request),
      preflightRecordingPlan: request => invokePerformance('recordingPlans:preflight', request),
      cancelRecordingPlanRead: id => invokePerformance('recordingPlans:cancelRead', { id }),
    },
    {
      getRecordingOutputStatus: () => invokePerformance('recordingOutput:status', {}),
      checkRecordingOutput: request => invokePerformance('recordingOutput:check', request),
      cancelRecordingOutputCheck: runId => invokePerformance('recordingOutput:cancel', { runId }),
    },
    createRecordingAttemptClient((channel, value) => invokePerformance(channel, value)),
    createRecordingRecordClient((channel, value) => invokePerformance(channel, value)),
    createRecordingReplicaClient((channel, value) => invokePerformance(channel, value)),
    createRecordingPrintClient((channel, value) => invokePerformance(channel, value)),
    theme => invokePerformance('app:set-appearance-theme', theme),
    {getVolume: () => invokePerformance('roon:volume:get'), setVolume: request => invokePerformance('roon:volume:set', request)},
    { getRoonDisplaySettings: () => invokePerformance('lyrics:display:get'), configureRoonDisplay: url => invokePerformance('lyrics:display:configure', url) },
    workspaceClient,
    candidateClient,
    preparationZipClient,
    createRecordingDeviceClient((channel, value) => invokePerformance(channel, value)),
    interactions.api,
    createLibraryReadTerminalClient(invokePerformance, process.argv?.includes('--music-bridge-library-read-trace=1') ?? false),
    { getPlaybackStreamSnapshot: () => invokePerformance('playback:get-stream-snapshot') },
    {
      getCollectionReadonlySettings: async () => { const value: unknown = await invokePerformance('collection:readonly-settings'); if (!isCollectionReadonlySettings(value)) throw new Error('收藏查询设置回执无效。'); return value },
      setCollectionReadonlyEnabled: async enabled => { if (typeof enabled !== 'boolean') throw new Error('收藏查询开关无效。'); const value: unknown = await invokePerformance('collection:set-readonly-enabled', enabled); if (!isCollectionReadonlySettings(value)) throw new Error('收藏查询设置回执无效。'); return value },
      refreshCollection: async () => { const value: unknown = await invokePerformance('collection:refresh'); if (!isCollectionRefreshResult(value)) throw new Error('收藏刷新回执无效。'); return value },
    },
    createLocalLibraryClient(invokeScoped,getDatasetId,{chooseRoot:commandId=>outbox.submit('localLibrary.chooseRoot',{commandId}),confirm:request=>outbox.submit('localRelocation.confirm',request),relink:request=>outbox.submit('localRelocation.relinkRoot',request)}),
  ),
)
