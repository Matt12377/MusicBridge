import { contextBridge, ipcRenderer } from 'electron'
import type {
  RemoteCoreTunnelState,
  RoonImageResult,
  TrackSummary,
  TypedIpcEvent,
} from '@music-bridge/contracts'

import { createPreloadApi } from './api.js'
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
      listCollection: page => ipcRenderer.invoke('collection:list', page),
      getCollectionModel: (modelId, page) => ipcRenderer.invoke('collection:detail', modelId, page),
      receiveCollectionStock: request => ipcRenderer.invoke('collection:receive', request),
      materializeCollectionCopy: request => ipcRenderer.invoke('collection:materialize', request),
      updateCollectionCopy: request => ipcRenderer.invoke('collection:update-copy', request),
      setCollectionPolicy: request => ipcRenderer.invoke('collection:set-policy', request),
    },
  ),
)
