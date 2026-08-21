import { app, BrowserWindow, ipcMain, session } from 'electron'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  buildBrowserWindowWebPreferences,
  buildContentSecurityPolicy,
  getWindowOpenDecision,
  isNavigationAllowed,
} from './security.js'

const currentFile = fileURLToPath(import.meta.url)
const currentDirectory = path.dirname(currentFile)
const isStartupTest = process.env.MUSIC_BRIDGE_STARTUP_TEST === '1'

function appInfo() {
  return {
    version: app.getVersion(),
    buildMode: app.isPackaged ? 'production' : 'development',
    platform: process.platform,
  } as const
}

function installSessionSecurity(targetSession: Electron.Session) {
  targetSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false)
  })
  targetSession.setPermissionCheckHandler(() => false)
  targetSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          buildContentSecurityPolicy(app.isPackaged ? 'production' : 'development'),
        ],
      },
    })
  })
}

function createWindow() {
  const window = new BrowserWindow({
    width: 960,
    height: 640,
    minWidth: 720,
    minHeight: 480,
    show: !isStartupTest,
    backgroundColor: '#10131a',
    webPreferences: {
      ...buildBrowserWindowWebPreferences(),
      preload: path.join(currentDirectory, '../preload/index.mjs'),
    },
  })

  window.webContents.on('will-navigate', (event, url) => {
    if (!isNavigationAllowed(url)) {
      event.preventDefault()
    }
  })
  window.webContents.setWindowOpenHandler(() => getWindowOpenDecision())
  window.loadFile(path.join(currentDirectory, '../renderer/index.html'))

  window.webContents.once('did-finish-load', () => {
    if (isStartupTest) {
      process.stdout.write('DESKTOP_STARTUP_READY\n')
      setTimeout(() => app.quit(), 25)
    }
  })

  return window
}

app.whenReady().then(() => {
  installSessionSecurity(session.defaultSession)
  ipcMain.handle('app:get-info', () => appInfo())
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
