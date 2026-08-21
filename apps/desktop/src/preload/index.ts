import { contextBridge, ipcRenderer } from 'electron'
import type { TypedIpcEvent } from '@music-bridge/contracts'

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
    () => ipcRenderer.invoke('auth:get-state'),
    () => ipcRenderer.invoke('auth:begin-qr'),
    (challengeId: string) => ipcRenderer.invoke('auth:poll-qr', challengeId),
    (challengeId: string) => ipcRenderer.invoke('auth:cancel-qr', challengeId),
    () => ipcRenderer.invoke('auth:logout'),
    (query: string, page: { offset: number; limit: number }) =>
      ipcRenderer.invoke('library:search', query, page),
    (page: { offset: number; limit: number }) => ipcRenderer.invoke('library:liked', page),
    () => ipcRenderer.invoke('library:playlists'),
    (playlistId: string, page: { offset: number; limit: number }) =>
      ipcRenderer.invoke('library:playlist', playlistId, page),
    () => ipcRenderer.invoke('roon:list-zones'),
    (zoneId: string) => ipcRenderer.invoke('roon:select-zone', zoneId),
    (trackId: string) => ipcRenderer.invoke('lyrics:get', trackId),
    () => ipcRenderer.invoke('playback:get-state'),
    (trackId: string, quality: string) => ipcRenderer.invoke('playback:play', trackId, quality),
    () => ipcRenderer.invoke('playback:stop'),
    () => ipcRenderer.invoke('playback:next'),
    () => ipcRenderer.invoke('playback:previous'),
    (items, index) => ipcRenderer.invoke('playback:replace-queue', items, index),
    (listener: (event: TypedIpcEvent) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, message: TypedIpcEvent): void => {
        listener(message)
      }
      ipcRenderer.on('core:event', handler)
      return () => ipcRenderer.removeListener('core:event', handler)
    },
  ),
)
