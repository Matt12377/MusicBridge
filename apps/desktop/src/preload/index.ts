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
    (listener: (event: TypedIpcEvent) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, message: TypedIpcEvent): void => {
        listener(message)
      }
      ipcRenderer.on('core:event', handler)
      return () => ipcRenderer.removeListener('core:event', handler)
    },
  ),
)
