import {
  app,
  BrowserWindow,
  ipcMain,
  MessageChannelMain,
  safeStorage,
  session,
  utilityProcess,
} from 'electron'
import type {
  PageRequest,
  PlaybackQueueItem,
  PlaybackQuality,
  PublicAuthState,
  PublicErrorCode,
  TypedIpcEvent,
} from '@music-bridge/contracts'
import { IPC_VERSION, validateIpcEvent } from '@music-bridge/contracts'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { migrateRoonConfig } from './config-migration.js'
import {
  provisionProviderCredential,
  restoreProviderCredential,
} from './credential-provisioning.js'
import { CredentialVault } from './credential-vault.js'
import {
  CoreIpcError,
  CoreSupervisor,
  type CoreChildProcess,
  type CoreMessagePort,
} from './core-supervisor.js'
import {
  buildBrowserWindowWebPreferences,
  buildContentSecurityPolicy,
  getWindowOpenDecision,
  isNavigationAllowed,
  isTrustedRendererSender,
} from './security.js'

const currentFile = fileURLToPath(import.meta.url)
const currentDirectory = path.dirname(currentFile)
const isStartupTest = process.env.MUSIC_BRIDGE_STARTUP_TEST === '1'
const isCoreCrashGate = isStartupTest && process.env.MUSIC_BRIDGE_CORE_CRASH_GATE === '1'
const isCredentialVaultGate =
  isStartupTest && process.env.MUSIC_BRIDGE_CREDENTIAL_VAULT_GATE === '1'

let mainWindow: BrowserWindow | undefined
let coreSupervisor: CoreSupervisor | undefined
let quitAfterCoreShutdown = false

function appInfo() {
  return {
    version: app.getVersion(),
    buildMode: app.isPackaged ? 'production' : 'development',
    platform: process.platform,
  } as const
}

function installSessionSecurity(targetSession: Electron.Session): void {
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

function publicIpcFailure(code: PublicErrorCode, message: string): never {
  throw Object.freeze({ code, message })
}

function requireTrustedRenderer(event: Electron.IpcMainInvokeEvent): BrowserWindow {
  const target = mainWindow
  if (
    !target ||
    target.isDestroyed() ||
    event.sender !== target.webContents ||
    !isTrustedRendererSender({
      senderId: event.sender.id,
      windowId: target.webContents.id,
      frameUrl: event.senderFrame?.url ?? '',
    })
  ) {
    return publicIpcFailure('NOT_READY', 'Renderer sender rejected')
  }
  return target
}

async function invokeCore<T>(
  event: Electron.IpcMainInvokeEvent,
  operation: () => Promise<T>,
): Promise<T> {
  requireTrustedRenderer(event)
  try {
    return await operation()
  } catch (error) {
    if (error instanceof CoreIpcError) {
      return publicIpcFailure(error.code, error.message)
    }
    return publicIpcFailure('INTERNAL_ERROR', 'Core request failed')
  }
}

function requireChallengeId(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 128) {
    return publicIpcFailure('INVALID_IPC_REQUEST', 'Invalid QR challenge')
  }
  return value
}

function requireLibraryPage(value: unknown): PageRequest {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !['offset', 'limit'].includes(key))
  ) {
    return publicIpcFailure('INVALID_IPC_REQUEST', 'Invalid library page')
  }
  const page = value as { offset?: unknown; limit?: unknown }
  if (
    typeof page.offset !== 'number' ||
    !Number.isSafeInteger(page.offset) ||
    page.offset < 0 ||
    page.offset > 1_000_000 ||
    typeof page.limit !== 'number' ||
    !Number.isSafeInteger(page.limit) ||
    page.limit < 1 ||
    page.limit > 100
  ) {
    return publicIpcFailure('INVALID_IPC_REQUEST', 'Invalid library page')
  }
  return { offset: page.offset, limit: page.limit }
}

function requireSearchQuery(value: unknown): string {
  if (typeof value !== 'string') {
    return publicIpcFailure('INVALID_IPC_REQUEST', 'Invalid search query')
  }
  const query = value.trim()
  if (query.length === 0 || query.length > 100) {
    return publicIpcFailure('INVALID_IPC_REQUEST', 'Invalid search query')
  }
  return query
}

function requirePlaylistId(value: unknown): string {
  if (typeof value !== 'string' || !/^\d+$/.test(value) || value === '0' || value.length > 128) {
    return publicIpcFailure('INVALID_IPC_REQUEST', 'Invalid playlist')
  }
  return value
}

function requirePlaybackTrackId(value: unknown): string {
  if (typeof value !== 'string' || !/^\d+$/.test(value) || value === '0' || value.length > 128) {
    return publicIpcFailure('INVALID_IPC_REQUEST', 'Invalid playback track')
  }
  return value
}

function requirePlaybackQuality(value: unknown): PlaybackQuality {
  if (!['standard', 'exhigh', 'lossless', 'hires'].includes(String(value))) {
    return publicIpcFailure('INVALID_IPC_REQUEST', 'Invalid playback quality')
  }
  return value as PlaybackQuality
}

function requirePlaybackQueue(value: unknown): readonly PlaybackQueueItem[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 100) {
    return publicIpcFailure('INVALID_IPC_REQUEST', 'Invalid playback queue')
  }
  return value.map((item) => {
    if (
      !item ||
      typeof item !== 'object' ||
      Array.isArray(item) ||
      Object.keys(item).some((key) => !['trackId', 'quality'].includes(key))
    ) {
      return publicIpcFailure('INVALID_IPC_REQUEST', 'Invalid playback queue')
    }
    const queueItem = item as { trackId?: unknown; quality?: unknown }
    return {
      trackId: requirePlaybackTrackId(queueItem.trackId),
      quality: requirePlaybackQuality(queueItem.quality),
    }
  })
}

function requirePlaybackIndex(value: unknown, items: readonly PlaybackQueueItem[]): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value >= items.length
  ) {
    return publicIpcFailure('INVALID_IPC_REQUEST', 'Invalid playback queue index')
  }
  return value
}

async function saveQrCredential(
  supervisor: CoreSupervisor,
  credentialVault: CredentialVault,
  credential: string,
): Promise<void> {
  try {
    await credentialVault.save(credential)
    await supervisor.request('auth.setCredential', { credential })
  } catch (error) {
    await credentialVault.delete().catch(() => undefined)
    await supervisor.request('auth.clearCredential', {}).catch(() => undefined)
    throw error
  }
}

function registerIpcHandlers(
  supervisor: CoreSupervisor,
  credentialVault: CredentialVault,
): void {
  ipcMain.handle('app:get-info', (event) => {
    requireTrustedRenderer(event)
    return appInfo()
  })
  ipcMain.handle('core:get-health', (event) =>
    invokeCore(event, () => supervisor.request('core.getHealth', {})),
  )
  ipcMain.handle('core:get-state', (event) =>
    invokeCore(event, () => supervisor.request('core.getState', {})),
  )
  ipcMain.handle('core:ping', (event) =>
    invokeCore(event, () => supervisor.request('core.ping', {})),
  )
  ipcMain.handle('auth:get-state', (event) =>
    invokeCore(event, () => supervisor.request('auth.getState', {})),
  )
  ipcMain.handle('auth:begin-qr', (event) =>
    invokeCore(event, () => supervisor.request('auth.beginQr', {})),
  )
  ipcMain.handle('auth:poll-qr', (event, challengeId: unknown) =>
    invokeCore(event, async (): Promise<PublicAuthState> => {
      const result = await supervisor.requestInternal('auth.pollQr', {
        challengeId: requireChallengeId(challengeId),
      })
      if (result.credential !== undefined) {
        await saveQrCredential(supervisor, credentialVault, result.credential)
      }
      return result.state
    }),
  )
  ipcMain.handle('auth:cancel-qr', (event, challengeId: unknown) =>
    invokeCore(event, () =>
      supervisor.request('auth.cancelQr', {
        challengeId: requireChallengeId(challengeId),
      }),
    ),
  )
  ipcMain.handle('auth:logout', (event) =>
    invokeCore(event, async (): Promise<PublicAuthState> => {
      let state: PublicAuthState | undefined
      let failure: unknown
      try {
        state = await supervisor.request('auth.logout', {})
      } catch (error) {
        failure = error
      }
      try {
        await credentialVault.delete()
      } catch (error) {
        failure ??= error
      }
      if (failure) throw failure
      if (!state) throw new Error('Auth logout returned no state')
      return state
    }),
  )
  ipcMain.handle('library:search', (event, query: unknown, page: unknown) =>
    invokeCore(event, () =>
      supervisor.request('library.search', {
        query: requireSearchQuery(query),
        page: requireLibraryPage(page),
      }),
    ),
  )
  ipcMain.handle('library:liked', (event, page: unknown) =>
    invokeCore(event, () =>
      supervisor.request('library.liked', { page: requireLibraryPage(page) }),
    ),
  )
  ipcMain.handle('library:playlists', (event) =>
    invokeCore(event, () => supervisor.request('library.playlists', {})),
  )
  ipcMain.handle('library:playlist', (event, playlistId: unknown, page: unknown) =>
    invokeCore(event, () =>
      supervisor.request('library.playlist', {
        playlistId: requirePlaylistId(playlistId),
        page: requireLibraryPage(page),
      }),
    ),
  )
  ipcMain.handle('lyrics:get', (event, trackId: unknown) =>
    invokeCore(event, () =>
      supervisor.request('lyrics.get', {
        trackId: requirePlaybackTrackId(trackId),
      }),
    ),
  )
  ipcMain.handle('playback:get-state', (event) =>
    invokeCore(event, () => supervisor.request('playback.getState', {})),
  )
  ipcMain.handle('playback:play', (event, trackId: unknown, quality: unknown) =>
    invokeCore(event, () =>
      supervisor.request('playback.play', {
        trackId: requirePlaybackTrackId(trackId),
        quality: requirePlaybackQuality(quality),
      }),
    ),
  )
  ipcMain.handle('playback:stop', (event) =>
    invokeCore(event, () => supervisor.request('playback.stop', {})),
  )
  ipcMain.handle('playback:next', (event) =>
    invokeCore(event, () => supervisor.request('playback.next', {})),
  )
  ipcMain.handle('playback:previous', (event) =>
    invokeCore(event, () => supervisor.request('playback.previous', {})),
  )
  ipcMain.handle('playback:replace-queue', (event, items: unknown, index: unknown) =>
    invokeCore(event, () => {
      const queue = requirePlaybackQueue(items)
      return supervisor.request('playback.replaceQueue', {
        items: queue,
        index: requirePlaybackIndex(index, queue),
      })
    }),
  )
}

function createWindow(supervisor: CoreSupervisor): BrowserWindow {
  const window = new BrowserWindow({
    width: 960,
    height: 640,
    minWidth: 720,
    minHeight: 480,
    show: !isStartupTest,
    backgroundColor: '#10131a',
    webPreferences: {
      ...buildBrowserWindowWebPreferences(),
      preload: path.join(currentDirectory, '../preload/index.cjs'),
    },
  })
  mainWindow = window

  window.webContents.on('will-navigate', (event, url) => {
    if (!isNavigationAllowed(url)) {
      event.preventDefault()
    }
  })
  window.webContents.setWindowOpenHandler(() => getWindowOpenDecision())
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = undefined
  })
  window.loadFile(path.join(currentDirectory, '../renderer/index.html'))

  window.webContents.once('did-finish-load', () => {
    if (isStartupTest && !isCoreCrashGate && supervisor.status === 'ready') {
      void window.webContents
        .executeJavaScript(
          'Promise.all([window.musicBridge.pingCore(), window.musicBridge.getCoreHealth(), window.musicBridge.getCoreState()])',
        )
        .then((result: unknown) => {
          const [ping, health, state] = Array.isArray(result) ? result : []
          const healthValid = validateIpcEvent({
            version: IPC_VERSION,
            event: 'core.health',
            payload: { state: health },
          }).ok
          const stateValid = validateIpcEvent({
            version: IPC_VERSION,
            event: 'core.health',
            payload: { state },
          }).ok
          const passed =
            ping &&
            typeof ping === 'object' &&
            'pong' in ping &&
            ping.pong === true &&
            healthValid &&
            stateValid
          process.stdout.write(`${passed ? 'DESKTOP_STARTUP_READY' : 'DESKTOP_STARTUP_FAIL'}\n`)
          if (passed) {
            setTimeout(() => app.quit(), 25)
          } else {
            app.exit(1)
          }
        })
        .catch(() => {
          process.stdout.write('DESKTOP_STARTUP_FAIL\n')
          app.exit(1)
        })
    }
  })

  return window
}

function buildCoreEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...process.env }
  delete environment.NETEASE_COOKIE
  delete environment.MUSIC_BRIDGE_CORE_CRASH_PROBE
  if (isStartupTest) {
    environment.NODE_ENV = 'test'
    environment.MUSIC_BRIDGE_CORE_TEST_MODE = '1'
    if (isCoreCrashGate) {
      environment.MUSIC_BRIDGE_CORE_CRASH_PROBE = '1'
    }
  } else {
    delete environment.MUSIC_BRIDGE_CORE_TEST_MODE
  }
  return environment
}

function createCoreSupervisor(
  dataDirectory: string,
  options: {
    onReady?: () => Promise<void> | void
    onEvent?: (event: TypedIpcEvent) => void
  } = {},
): CoreSupervisor {
  return new CoreSupervisor({
    entryPath: path.join(currentDirectory, 'core.js'),
    cwd: dataDirectory,
    env: buildCoreEnvironment(),
    dependencies: {
      createChannel: () => {
        const channel = new MessageChannelMain()
        return {
          port1: channel.port1 as unknown as CoreMessagePort,
          port2: channel.port2 as unknown as CoreMessagePort,
        }
      },
      fork: (entryPath, args, options) =>
        utilityProcess.fork(entryPath, args, {
          cwd: options.cwd,
          env: options.env as Record<string, string>,
          stdio: options.stdio,
          serviceName: options.serviceName,
        }) as unknown as CoreChildProcess,
    },
    onReady: options.onReady,
    onEvent: (event: TypedIpcEvent) => {
      options.onEvent?.(event)
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('core:event', event)
      }
    },
  })
}

async function prepareCoreDataDirectory(): Promise<{
  dataDirectory: string
  credentialVault: CredentialVault
}> {
  if (isStartupTest) {
    app.setPath('userData', path.join(app.getPath('temp'), 'musicbridge-task012-startup'))
  }
  const dataDirectory = path.join(app.getPath('userData'), 'data')
  await mkdir(dataDirectory, { recursive: true, mode: 0o700 })
  const legacyPath = path.join(
    app.getPath('home'),
    'Library',
    'Application Support',
    'MusicBridgeAgent',
    'data',
    'config.json',
  )
  const result = await migrateRoonConfig({
    legacyPath,
    targetPath: path.join(dataDirectory, 'config.json'),
  })
  if (result.status === 'invalid') {
    throw new Error('Roon configuration migration failed')
  }
  return {
    dataDirectory,
    credentialVault: new CredentialVault({
      filePath: path.join(dataDirectory, 'netease.credential'),
      storage: safeStorage,
    }),
  }
}

async function runCredentialVaultGate(credentialVault: CredentialVault): Promise<boolean> {
  const testCredential = 'v'.repeat(32)
  await credentialVault.save(testCredential)
  const stored = await credentialVault.read()
  await credentialVault.delete()
  const deleted = (await credentialVault.read()).status === 'missing'
  return stored.status === 'configured' && stored.credential === testCredential && deleted
}

async function bootstrap(): Promise<void> {
  await app.whenReady()
  app.setName('Music Bridge for Roon')
  installSessionSecurity(session.defaultSession)

  const prepared = await prepareCoreDataDirectory()
  if (isCredentialVaultGate) {
    try {
      const passed = await runCredentialVaultGate(prepared.credentialVault)
      process.stdout.write(`${passed ? 'CREDENTIAL_VAULT_GATE_PASS' : 'CREDENTIAL_VAULT_GATE_FAIL'}\n`)
      if (passed) app.quit()
      else app.exit(1)
    } catch {
      process.stdout.write('CREDENTIAL_VAULT_GATE_FAIL\n')
      app.exit(1)
    }
    return
  }

  let initialProvisioningComplete = false
  let supervisor: CoreSupervisor
  supervisor = createCoreSupervisor(prepared.dataDirectory, {
    onReady: async () => {
      if (!initialProvisioningComplete) return
      await restoreProviderCredential({
        vault: prepared.credentialVault,
        core: {
          setCredential: (credential) =>
            supervisor.request('auth.setCredential', { credential }),
          clearCredential: () => supervisor.request('auth.clearCredential', {}),
        },
      })
    },
    onEvent: (event) => {
      if (event.event === 'auth.changed' && event.payload.state.status === 'expired') {
        void prepared.credentialVault.delete().catch(() => undefined)
      }
    },
  })
  coreSupervisor = supervisor
  await supervisor.start()
  await provisionProviderCredential({
    vault: prepared.credentialVault,
    environment: process.env,
    core: {
      setCredential: (credential) =>
        supervisor.request('auth.setCredential', { credential }),
      clearCredential: () => supervisor.request('auth.clearCredential', {}),
    },
  })
  initialProvisioningComplete = true
  registerIpcHandlers(supervisor, prepared.credentialVault)
  createWindow(supervisor)
  if (isCoreCrashGate) {
    setTimeout(() => {
      const passed = supervisor.status === 'failed' && supervisor.restarts === 1
      process.stdout.write(`${passed ? 'CORE_CRASH_GATE_PASS' : 'CORE_CRASH_GATE_FAIL'}\n`)
      app.quit()
    }, 1_000)
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow(supervisor)
    }
  })
}

void bootstrap().catch(() => {
  process.stderr.write('DESKTOP_STARTUP_FAIL\n')
  app.exit(1)
})

app.on('before-quit', (event) => {
  if (quitAfterCoreShutdown || !coreSupervisor) return
  event.preventDefault()
  quitAfterCoreShutdown = true
  void coreSupervisor.shutdown().finally(() => app.quit())
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
