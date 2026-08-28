import { contextBridge, ipcRenderer } from 'electron'
import type {
  RemoteCoreTunnelState,
  RoonImageResult,
  TrackSummary,
  TypedIpcEvent,
} from '@music-bridge/contracts'

import { createPreloadApi } from './api.js'
import { createCommandOutboxClient } from './command-outbox-client.js'
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

const outbox = createCommandOutboxClient((channel, value) => ipcRenderer.invoke(channel, value))

contextBridge.exposeInMainWorld(
  'musicBridge',
  createPreloadApi(
    () => ipcRenderer.invoke('app:get-info'),
    () => ipcRenderer.invoke('core:get-health'),
    () => ipcRenderer.invoke('core:get-state'),
    () => ipcRenderer.invoke('core:ping'),
    () => ipcRenderer.invoke('diagnostics:export'),
    () => ipcRenderer.invoke('auth:get-state'),
    () => ipcRenderer.invoke('auth:begin-qr'),
    (challengeId: string) => ipcRenderer.invoke('auth:poll-qr', challengeId),
    (challengeId: string) => ipcRenderer.invoke('auth:cancel-qr', challengeId),
    () => ipcRenderer.invoke('auth:logout'),
    () => ipcRenderer.invoke('account:get-state'),
    () => ipcRenderer.invoke('account:refresh'),
    (query: string, page: { offset: number; limit: number }) =>
      ipcRenderer.invoke('library:search', query, page),
    (page: { offset: number; limit: number }) => ipcRenderer.invoke('library:liked', page),
    () => ipcRenderer.invoke('library:playlists'),
    (playlistId: string, page: { offset: number; limit: number }) =>
      ipcRenderer.invoke('library:playlist', playlistId, page),
    () => ipcRenderer.invoke('library:daily-recommendations'),
    () => ipcRenderer.invoke('roon:list-zones'),
    (zoneId: string) => ipcRenderer.invoke('roon:select-zone', zoneId),
    (trackId: string) => ipcRenderer.invoke('lyrics:get', trackId),
    () => ipcRenderer.invoke('playback:get-state'),
    (trackId: string, qualityPreference: string, rendererClickAtMs?: number) =>
      ipcRenderer.invoke('playback:play', trackId, qualityPreference, rendererClickAtMs),
    () => ipcRenderer.invoke('playback:pause'),
    () => ipcRenderer.invoke('playback:resume'),
    () => ipcRenderer.invoke('playback:stop'),
    () => ipcRenderer.invoke('playback:next'),
    () => ipcRenderer.invoke('playback:previous'),
    (items, index) => ipcRenderer.invoke('playback:replace-queue', items, index),
    (items) => ipcRenderer.invoke('playback:append-queue', items),
    (items) => ipcRenderer.invoke('playback:insert-next', items),
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
    () => ipcRenderer.invoke('remote-core:get-state'),
    () => ipcRenderer.invoke('remote-core:start'),
    () => ipcRenderer.invoke('remote-core:stop'),
    () => ipcRenderer.invoke('remote-core:reconnect'),
    (listener: (state: RemoteCoreTunnelState) => void): (() => void) => {
      const handler = (_event: Electron.IpcRendererEvent, state: RemoteCoreTunnelState): void => {
        listener(state)
      }
      ipcRenderer.on('remote-core:event', handler)
      return () => ipcRenderer.removeListener('remote-core:event', handler)
    },
    (query: string, page: { offset: number; limit: number }) =>
      ipcRenderer.invoke('library:search-artists', query, page),
    (query: string, page: { offset: number; limit: number }) =>
      ipcRenderer.invoke('library:search-albums', query, page),
    (artistId: string, page: { offset: number; limit: number }) =>
      ipcRenderer.invoke('library:artist', artistId, page),
    (albumId: string, page: { offset: number; limit: number }) =>
      ipcRenderer.invoke('library:album', albumId, page),
    (page: { offset: number; limit: number }) => ipcRenderer.invoke('roon:library:albums', page),
    (page: { offset: number; limit: number }) => ipcRenderer.invoke('roon:library:artists', page),
    (page: { offset: number; limit: number }) => ipcRenderer.invoke('roon:library:genres', page),
    (page: { offset: number; limit: number }) => ipcRenderer.invoke('roon:library:playlists', page),
    (reference: string, page: { offset: number; limit: number }) =>
      ipcRenderer.invoke('roon:library:album', reference, page),
    (reference: string, page: { offset: number; limit: number }) =>
      ipcRenderer.invoke('roon:library:artist', reference, page),
    (reference: string, page: { offset: number; limit: number }) =>
      ipcRenderer.invoke('roon:library:genre', reference, page),
    (reference: string, page: { offset: number; limit: number }) =>
      ipcRenderer.invoke('roon:library:playlist', reference, page),
    (query: string, page: { offset: number; limit: number }) =>
      ipcRenderer.invoke('roon:library:search', query, page),
    async (reference: string, options?: { scale?: 'fit' | 'fill' | 'stretch'; width?: number; height?: number; format?: 'image/jpeg' | 'image/png' }) => {
      const envelope = await ipcRenderer.invoke(
        'roon:library:image',
        reference,
        options,
      ) as RoonImageIpcEnvelope
      const result: RoonImageResult = unwrapRoonImageIpc(envelope)
      if (recordRoonImageShape) {
        try {
          await ipcRenderer.invoke(
            'roon:image:diagnostic',
            summarizePreloadRoonImage(result),
          )
        } catch {
          // 诊断采样不得改变图片行为。
        }
      }
      return result
    },
    (reference: string, zoneId: string) => ipcRenderer.invoke('roon:library:play', reference, zoneId),
    (reference: string, zoneId: string) => ipcRenderer.invoke('roon:library:queue', reference, zoneId),
    (kind: 'track' | 'album' | 'artist' | undefined, page: { offset: number; limit: number }) =>
      ipcRenderer.invoke('favorites:list', kind, page),
    (descriptor) => ipcRenderer.invoke('favorites:check', descriptor),
    (descriptor, favorite) => ipcRenderer.invoke('favorites:set', descriptor, favorite),
    (trackId: string) => ipcRenderer.invoke('library:like-status', trackId),
    (trackId: string, liked: boolean) => ipcRenderer.invoke('library:like', trackId, liked),
    (track: TrackSummary) => ipcRenderer.invoke('library:match', track),
    (query: string, page: { offset: number; limit: number }) => ipcRenderer.invoke('library:aggregate-search', query, page),
    (positionMs: number) => ipcRenderer.invoke('playback:seek', positionMs),
    () => ipcRenderer.invoke('roon:transport:stop'),
    (index: number) => ipcRenderer.invoke('playback:play-queue-index', index),
    () => ipcRenderer.invoke('lyrics:match:get'),
    (matchSessionId: string, candidateId: string) =>
      ipcRenderer.invoke('lyrics:match:select', matchSessionId, candidateId),
    () => ipcRenderer.invoke('lyrics:match:revoke'),
    {
      pickCollectionPhoto: () => ipcRenderer.invoke('collection:pick-photo'),
      addCollectionPhoto: request => outbox.submit('collection.addPhoto', request),
      getCollectionPhoto: photoId => ipcRenderer.invoke('collection:photo', photoId),
      changeCollectionPhoto: request => outbox.submit('collection.changePhoto', request),
      listCollection: (page, filter) => ipcRenderer.invoke('collection:list', page, filter),
      getCollectionModel: (modelId, page) => ipcRenderer.invoke('collection:detail', modelId, page),
      receiveCollectionStock: request => outbox.submit('collection.receive', request),
      materializeCollectionCopy: request => outbox.submit('collection.materialize', request),
      updateCollectionCopy: request => outbox.submit('collection.updateCopy', request),
      setCollectionPolicy: request => outbox.submit('collection.setPolicy', request),
    },
    {
      listPhysicalMusic: (page, filter) => ipcRenderer.invoke('physicalMusic:list', page, filter),
      getPhysicalMusic: id => ipcRenderer.invoke('physicalMusic:detail', id),
      savePhysicalRelease: request => outbox.submit('physicalMusic.saveRelease', request),
      saveLegacyRecording: request => outbox.submit('physicalMusic.saveLegacy', request),
      addPhysicalMusicPhoto: request => outbox.submit('physicalMusic.addPhoto', request),
      getPhysicalMusicPhoto: photoId => ipcRenderer.invoke('physicalMusic:photo', photoId),
      removePhysicalMusicPhoto: request => outbox.submit('physicalMusic.removePhoto', request),
    },
    {
      searchPhysicalRoonAlbums: (query, page) => ipcRenderer.invoke('physicalLinks:search', query, page),
      listDigitalAlbums: page => ipcRenderer.invoke('physicalLinks:digitalList', page),
      getDigitalAlbum: id => ipcRenderer.invoke('physicalLinks:digitalDetail', id),
      getPhysicalLinks: releaseId => ipcRenderer.invoke('physicalLinks:physical', releaseId),
      getDigitalRuntime: id => ipcRenderer.invoke('physicalLinks:runtime', id),
      confirmPhysicalLink: request => outbox.submit('physicalLinks.confirm', request),
      relocateDigitalAlbum: request => outbox.submit('physicalLinks.relocate', request),
      registerDigitalAlbum: request => outbox.submit('physicalLinks.register', request),
      removePhysicalLink: request => outbox.submit('physicalLinks.remove', request),
      confirmPhysicalAbsence: request => outbox.submit('physicalLinks.absence', request),
      getCollectionMatrix: (page, query) => ipcRenderer.invoke('physicalLinks:matrix', page, query),
    },
    {
      listMasterDrafts: page => ipcRenderer.invoke('recordingDrafts:list', page),
      getMasterDraft: id => ipcRenderer.invoke('recordingDrafts:detail', id),
      appendMasterDraft: request => outbox.submit('recordingDrafts.append', request),
      updateMasterDraft: request => outbox.submit('recordingDrafts.update', request),
      getMasterDraftTrackRuntime: (draftId, trackId) => ipcRenderer.invoke('recordingDrafts:runtime', draftId, trackId),
    },
    {
      listRecordingSourceRoots: () => ipcRenderer.invoke('recordingSources:roots'),
      chooseRecordingSourceRoot: commandId => outbox.submit('recordingSources.chooseRoot', { commandId }),
      revokeRecordingSourceRoot: request => outbox.submit('recordingSources.revoke', request),
      chooseRecordingSource: request => outbox.submit('recordingSources.choose', request),
      getDraftSources: draftId => ipcRenderer.invoke('recordingSources:snapshot', draftId),
      getRecordingSourceJob: id => ipcRenderer.invoke('recordingSources:job', id),
      cancelRecordingSourceJob: request => outbox.submit('recordingSources.cancel', request),
      recheckRecordingSource: request => outbox.submit('recordingSources.recheck', request),
      confirmRecordingSource: request => outbox.submit('recordingSources.confirm', request),
    },
    {
      listMediaPlans: draftId => ipcRenderer.invoke('recordingMedia:plans', draftId),
      getMediaPlan: id => ipcRenderer.invoke('recordingMedia:detail', id),
      previewMediaPlan: request => ipcRenderer.invoke('recordingMedia:preview', request),
      balanceMediaPlan: (draftId, spec) => ipcRenderer.invoke('recordingMedia:balance', draftId, spec),
      saveMediaPlan: request => outbox.submit('recordingMedia.save', request),
      reserveMediaPlan: request => outbox.submit('recordingMedia.reserve', request),
      releaseMediaPlan: request => outbox.submit('recordingMedia.release', request),
    },
    {
      listMasterVersions: draftId => ipcRenderer.invoke('recordingVersions:list', draftId),
      previewMasterVersions: request => ipcRenderer.invoke('recordingVersions:preview', request),
      freezeMasterVersions: request => outbox.submit('recordingVersions.freeze', request),
      getMasterVersionJob: id => ipcRenderer.invoke('recordingVersions:job', id),
      cancelMasterVersionJob: request => outbox.submit('recordingVersions.cancel', request),
    },
    {
      listPreparationDestinations: () => ipcRenderer.invoke('recordingPreparation:destinations'),
      choosePreparationDestination: commandId => outbox.submit('recordingPreparation.chooseDestination', { commandId }),
      revokePreparationDestination: request => outbox.submit('recordingPreparation.revoke', request),
      listPreparations: draftId => ipcRenderer.invoke('recordingPreparation:list', draftId),
      previewPreparation: request => ipcRenderer.invoke('recordingPreparation:preview', request),
      startPreparation: request => outbox.submit('recordingPreparation.start', request),
      getPreparationJob: id => ipcRenderer.invoke('recordingPreparation:job', id),
      cancelPreparationJob: request => outbox.submit('recordingPreparation.cancel', request),
      openPreparationWorkspace: id => ipcRenderer.invoke('recordingPreparation:open', id),
    },
    {
      listPrepared: draftId => ipcRenderer.invoke('recordingPrepared:list', draftId),
      listPreparedSelections: preparationId => ipcRenderer.invoke('recordingPrepared:selections', preparationId),
      choosePreparedRender: request => outbox.submit('recordingPrepared.choose', request),
      revokePreparedSelection: request => outbox.submit('recordingPrepared.revoke', request),
      revokePreparedSelections: requests => outbox.submitPreparedRevocations(requests),
      previewPreparedImport: request => ipcRenderer.invoke('recordingPrepared:previewImport', request),
      startPreparedImport: request => outbox.submit('recordingPrepared.startImport', request),
      getPreparedImportJob: id => ipcRenderer.invoke('recordingPrepared:job', id),
      cancelPreparedImport: request => outbox.submit('recordingPrepared.cancel', request),
      reviewPrepared: request => ipcRenderer.invoke('recordingPrepared:review', request),
      freezePrepared: request => outbox.submit('recordingPrepared.freeze', request),
    },
    {
      listRecordingProfiles: () => ipcRenderer.invoke('recordingProfiles:list'),
      getRecordingProfileHistory: profileId => ipcRenderer.invoke('recordingProfiles:history', profileId),
      getRecordingProfileVersion: versionId => ipcRenderer.invoke('recordingProfiles:version', versionId),
      saveRecordingProfile: request => outbox.submit('recordingProfiles.save', request),
      getRecordingSession: draftId => ipcRenderer.invoke('recordingProfiles:session', draftId),
      saveRecordingSession: request => outbox.submit('recordingProfiles.saveSession', request),
    },
    {
      listExecutionAssets: draftId => ipcRenderer.invoke('recordingExecution:list', draftId),
      previewExecutionAsset: request => ipcRenderer.invoke('recordingExecution:preview', request),
      startExecutionAsset: request => outbox.submit('recordingExecution.start', request),
      getExecutionJob: id => ipcRenderer.invoke('recordingExecution:job', id),
      cancelExecutionJob: request => outbox.submit('recordingExecution.cancel', request),
      cancelExecutionRead: id => ipcRenderer.invoke('recordingExecution:cancelRead', id),
      verifyExecutionAsset: request => ipcRenderer.invoke('recordingExecution:verify', request),
    },
    {
      listArchiveRoots: () => ipcRenderer.invoke('recordingArchive:roots'),
      chooseArchiveRoot: commandId => outbox.submit('recordingArchive.choose', { commandId }),
      initializeArchiveRoot: request => outbox.submit('recordingArchive.initialize', request),
      revokeArchiveRoot: request => outbox.submit('recordingArchive.revokeRoot', request),
      previewArchive: request => ipcRenderer.invoke('recordingArchive:preview', request),
      startArchive: request => outbox.submit('recordingArchive.start', request),
      listArchives: draftId => ipcRenderer.invoke('recordingArchive:list', draftId),
      getArchiveOperation: id => ipcRenderer.invoke('recordingArchive:operation', id),
      cancelArchive: request => outbox.submit('recordingArchive.cancel', request),
      resumeArchive: request => outbox.submit('recordingArchive.resume', request),
      verifyArchive: request => ipcRenderer.invoke('recordingArchive:verify', request),
      cancelArchiveRead: id => ipcRenderer.invoke('recordingArchive:cancelRead', id),
    },
    {
      activateRestoredDataset: request => outbox.submit('recordingBackups.activate', request),
      getBackupOverview: () => ipcRenderer.invoke('recordingBackups:overview'),
      chooseBackupRoot: request => outbox.submit('recordingBackups.choose', request),
      startBackupJob: request => outbox.submit('recordingBackups.start', request),
      cancelBackupJob: request => outbox.submit('recordingBackups.cancel', request),
      revokeBackupRoot: request => outbox.submit('recordingBackups.revoke', request),
    },
    {
      getCommandOutbox: () => ipcRenderer.invoke('commandOutbox:overview'),
      retryCommandOutbox: request => ipcRenderer.invoke('commandOutbox:retry', request),
      dismissCommandOutbox: request => ipcRenderer.invoke('commandOutbox:dismiss', request),
      acknowledgeCommandOutbox: request => ipcRenderer.invoke('commandOutbox:acknowledge', request),
    },
    {
      registerReferenceSource: request => outbox.submit('referenceCatalog.registerSource', request),
      listReferenceSources: request => ipcRenderer.invoke('referenceCatalog:sources', request),
      getReferenceSource: request => ipcRenderer.invoke('referenceCatalog:source', request),
      previewCatalogRevision: request => ipcRenderer.invoke('referenceCatalog:previewRevision', request),
      publishCatalogRevision: request => outbox.submit('referenceCatalog.publishRevision', request),
      getCatalogRevision: request => ipcRenderer.invoke('referenceCatalog:revision', request),
      setCatalogMatch: request => outbox.submit('referenceCatalog.setMatch', request),
      getCatalogSnapshot: request => ipcRenderer.invoke('referenceCatalog:snapshot', request),
      getCatalogHistory: request => ipcRenderer.invoke('referenceCatalog:history', request),
    },
    {
      chooseSpreadsheetWorkbook: request => outbox.submit('spreadsheetImports.chooseWorkbook', request),
      listSpreadsheetSources: request => ipcRenderer.invoke('spreadsheetImports:sources', request),
      getSpreadsheetSource: request => ipcRenderer.invoke('spreadsheetImports:source', request),
      getSpreadsheetSourceRows: request => ipcRenderer.invoke('spreadsheetImports:sourceRows', request),
      previewSpreadsheetImport: request => ipcRenderer.invoke('spreadsheetImports:preview', request),
      applySpreadsheetImport: request => outbox.submit('spreadsheetImports.apply', request),
      getSpreadsheetImportRevision: request => ipcRenderer.invoke('spreadsheetImports:revision', request),
      listSpreadsheetImportHistory: request => ipcRenderer.invoke('spreadsheetImports:history', request),
      previewSpreadsheetAdjustment: request => ipcRenderer.invoke('spreadsheetImports:adjustmentPreview', request),
      adjustSpreadsheetInventory: request => outbox.submit('spreadsheetImports.adjust', request),
      listSpreadsheetAdjustments: request => ipcRenderer.invoke('spreadsheetImports:adjustments', request),
    },
  ),
)
