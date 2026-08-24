import { contextBridge, ipcRenderer } from 'electron'
import type { RemoteCoreTunnelState, TypedIpcEvent } from '@music-bridge/contracts'

import { createPreloadApi } from './api.js'

if (!process.contextIsolated) {
  throw new Error('Music Bridge requires contextIsolation')
}

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
    (trackId: string, qualityPreference: string) => ipcRenderer.invoke('playback:play', trackId, qualityPreference),
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
  ),
)
