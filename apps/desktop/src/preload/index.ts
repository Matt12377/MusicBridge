import { contextBridge, ipcRenderer } from 'electron'

import { createPreloadApi } from './api.js'

if (!process.contextIsolated) {
  throw new Error('Music Bridge requires contextIsolation')
}

contextBridge.exposeInMainWorld(
  'musicBridge',
  createPreloadApi(() => ipcRenderer.invoke('app:get-info')),
)
