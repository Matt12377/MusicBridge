import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  MessageChannelMain,
  nativeImage,
  protocol,
  safeStorage,
  session,
  Tray,
  utilityProcess,
} from 'electron'
import type {
  PageRequest,
  PlaybackQueueItem,
  PlaybackQuality,
  PlaybackSnapshot,
  PublicAuthState,
  PublicBridgeState,
  PublicErrorCode,
  RemoteCoreMode,
  RemoteCoreTunnelState,
  TypedIpcEvent,
} from '@music-bridge/contracts'
import { IPC_VERSION, validateIpcEvent } from '@music-bridge/contracts'
import { mkdir, readFile, realpath } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { migrateRoonConfig } from './config-migration.js'
import {
  provisionProviderCredential,
  restoreProviderCredential,
} from './credential-provisioning.js'
import { CredentialVault } from './credential-vault.js'
import {
  MainDiagnosticRecorder,
  writeDiagnosticReport,
} from './diagnostics.js'
import {
  CoreIpcError,
  CoreSupervisor,
  type CoreSupervisorLifecycle,
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
import {
  getRendererAssetPath,
  isAllowedRendererRequest,
  RENDERER_ENTRY_PATH,
  RENDERER_HOST,
  RENDERER_SCHEME,
  rendererContentType,
} from './renderer-protocol.js'
import { buildCoreEnvironment as buildAllowlistedCoreEnvironment } from './core-environment.js'
import {
  DEFAULT_REMOTE_STREAM_PORT,
  LOCAL_STREAM_PORT,
  RemoteCoreTunnelManager,
} from './remote-core-tunnel.js'
import trayTemplateSvg from './assets/musicbridge-tray-template.svg?raw'
import {
  buildTrayPresentation,
  shouldHideWindowOnClose,
  type TrayPresentation,
} from './tray.js'

protocol.registerSchemesAsPrivileged([
  {
    scheme: RENDERER_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
    },
  },
])

const currentFile = fileURLToPath(import.meta.url)
const currentDirectory = path.dirname(currentFile)
const isStartupTest = process.env.MUSIC_BRIDGE_STARTUP_TEST === '1'
const isUiE2e = process.env.MUSIC_BRIDGE_UI_E2E === '1'
const isCoreCrashGate = isStartupTest && process.env.MUSIC_BRIDGE_CORE_CRASH_GATE === '1'
const isCredentialVaultGate =
  isStartupTest && process.env.MUSIC_BRIDGE_CREDENTIAL_VAULT_GATE === '1'
const isCredentialRecoveryGate =
  isStartupTest && process.env.MUSIC_BRIDGE_CREDENTIAL_RECOVERY_GATE === '1'
const isRoonTimeGate = process.env.MUSIC_BRIDGE_ROON_TIME_GATE === '1'

let mainWindow: BrowserWindow | undefined
let coreSupervisor: CoreSupervisor | undefined
let coreMode: RemoteCoreMode = 'local-core'
let remoteStreamPort: number | undefined
let tray: Tray | undefined
let trayRefreshPromise: Promise<void> | undefined
let trayRefreshQueued = false
let quitAfterCoreShutdown = false
const mainDiagnostics = new MainDiagnosticRecorder()

const remoteCoreTunnelManager = new RemoteCoreTunnelManager({
  onStateChanged: (state) => {
    if (state.status === 'failed' || state.status === 'disconnected') {
      const code = state.errorCode ?? 'UNKNOWN'
      mainDiagnostics.recordLifecycle(
        'remote_core_tunnel_failed',
        state.status === 'failed' ? 'error' : 'warn',
        { code, state: state.status },
      )
      process.stderr.write(
        `[remote-core] ${state.status} code=${code} port=${state.remoteStreamPort ?? '-'}\n`,
      )
    }
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('remote-core:event', state)
    }
  },
  onTunnelBound: async (state) => {
    const supervisor = coreSupervisor
    if (!supervisor || state.remoteStreamPort === undefined) {
      throw new Error('Core supervisor is not ready for remote development mode')
    }
    const previousMode = coreMode
    const previousRemotePort = remoteStreamPort
    coreMode = 'remote-core-development'
    remoteStreamPort = state.remoteStreamPort
    try {
      await supervisor.restart(buildCoreEnvironment())
    } catch (error) {
      coreMode = previousMode
      remoteStreamPort = previousRemotePort
      await supervisor.restart(buildCoreEnvironment()).catch(() => undefined)
      throw error
    }
  },
  onDisconnected: async () => {
    await coreSupervisor?.request('playback.stop', {}).catch(() => undefined)
  },
})

const EMPTY_PLAYBACK_SNAPSHOT: PlaybackSnapshot = {
  state: 'idle',
  queue: { items: [], index: -1, hasNext: false, hasPrevious: false },
  canNext: false,
  canPrevious: false,
  canStop: false,
}

const STARTING_BRIDGE_STATE: PublicBridgeState = {
  runtime: 'starting',
  roon: 'disconnected',
  provider: 'missing',
  activeStreamCount: 0,
  activePlaybackPresent: false,
}

function appInfo() {
  return {
    version: app.getVersion(),
    buildMode: app.isPackaged ? 'production' : 'development',
    platform: process.platform,
  } as const
}

function sendRendererCommand(command: 'show-queue'): void {
  const target = mainWindow
  if (!target || target.isDestroyed()) return
  const send = (): void => {
    if (!target.isDestroyed()) target.webContents.send('app:command', command)
  }
  if (target.webContents.isLoading()) target.webContents.once('did-finish-load', send)
  else send()
}

function showMainWindow(command?: 'show-queue'): void {
  const target = mainWindow
  if (!target || target.isDestroyed()) return
  if (target.isMinimized()) target.restore()
  target.show()
  target.focus()
  if (command) sendRendererCommand(command)
}

function createTrayIcon() {
  const icon = nativeImage.createFromDataURL(
    `data:image/svg+xml;charset=utf-8,${encodeURIComponent(trayTemplateSvg)}`,
  )
  if (process.platform === 'darwin') icon.setTemplateImage(true)
  return icon
}

function destroyTray(): void {
  trayRefreshQueued = false
  tray?.destroy()
  tray = undefined
}

function buildTrayMenu(
  supervisor: CoreSupervisor,
  snapshot: { bridge: PublicBridgeState; playback: PlaybackSnapshot },
  presentation: TrayPresentation,
): Electron.Menu {
  const runPlaybackCommand = (
    command: 'playback.previous' | 'playback.next' | 'playback.stop',
  ): void => {
    void supervisor
      .request(command, {})
      .catch(() => undefined)
      .finally(() => requestTrayRefresh(supervisor))
  }

  return Menu.buildFromTemplate([
    { label: presentation.statusLabel, enabled: false },
    { label: presentation.trackLabel, enabled: false },
    { type: 'separator' },
    { label: 'Open Music Bridge', click: () => showMainWindow() },
    {
      label: 'Previous',
      enabled: snapshot.playback.canPrevious,
      click: () => runPlaybackCommand('playback.previous'),
    },
    {
      label: 'Next',
      enabled: snapshot.playback.canNext,
      click: () => runPlaybackCommand('playback.next'),
    },
    {
      label: 'Stop',
      enabled: snapshot.playback.canStop,
      click: () => runPlaybackCommand('playback.stop'),
    },
    { label: 'Show Queue', click: () => showMainWindow('show-queue') },
    { label: 'Export Diagnostics', click: () => void exportDiagnosticsFromMain(supervisor) },
    { type: 'separator' },
    { label: 'Quit Music Bridge', click: () => app.quit() },
  ])
}

function requestTrayRefresh(supervisor: CoreSupervisor = coreSupervisor!): void {
  if (!tray || !supervisor) return
  trayRefreshQueued = true
  if (trayRefreshPromise) return

  trayRefreshPromise = (async () => {
    while (tray && trayRefreshQueued) {
      trayRefreshQueued = false
      try {
        const [bridge, playback] = await Promise.all([
          supervisor.request('core.getHealth', {}),
          supervisor.request('playback.getState', {}),
        ])
        if (!tray) return
        const snapshot = { bridge, playback }
        const presentation = buildTrayPresentation(snapshot)
        tray.setContextMenu(buildTrayMenu(supervisor, snapshot, presentation))
      } catch {
        if (!tray) return
        const snapshot = { bridge: STARTING_BRIDGE_STATE, playback: EMPTY_PLAYBACK_SNAPSHOT }
        const presentation = buildTrayPresentation(snapshot)
        tray.setContextMenu(buildTrayMenu(supervisor, snapshot, presentation))
      }
    }
  })().finally(() => {
    trayRefreshPromise = undefined
    if (trayRefreshQueued) requestTrayRefresh(supervisor)
  })
}

function createTray(supervisor: CoreSupervisor): void {
  if (process.platform !== 'darwin') return
  destroyTray()
  tray = new Tray(createTrayIcon())
  tray.setToolTip('Music Bridge for Roon')
  tray.on('click', () => showMainWindow())
  requestTrayRefresh(supervisor)
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

async function installRendererProtocol(): Promise<void> {
  const rendererRoot = await realpath(path.join(currentDirectory, '../renderer'))
  protocol.handle(RENDERER_SCHEME, async (request) => {
    if (!isAllowedRendererRequest(request.url, request.method)) {
      return new Response('Not Found', { status: 404 })
    }
    try {
      const url = new URL(request.url)
      if (url.hostname !== RENDERER_HOST) return new Response('Not Found', { status: 404 })
      const assetPath = await getRendererAssetPath(rendererRoot, url.pathname)
      const body = request.method === 'HEAD' ? null : await readFile(assetPath)
      return new Response(body, {
        status: 200,
        headers: {
          'Content-Type': rendererContentType(url.pathname),
          'Cache-Control': 'no-store',
        },
      })
    } catch {
      return new Response('Not Found', { status: 404 })
    }
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

function requireZoneId(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 128) {
    return publicIpcFailure('INVALID_IPC_REQUEST', 'Invalid Roon zone')
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
    // Keep an encrypted credential after a transient Core/IPC failure. The
    // next cold-start or Core restart will verify it through login_status.
    if (error instanceof CoreIpcError || error instanceof Error) {
      await supervisor.request('auth.clearCredential', {}).catch(() => undefined)
    }
    throw error
  }
}

async function exportDiagnosticsFromMain(
  supervisor: CoreSupervisor,
): Promise<{ exported: boolean }> {
  mainDiagnostics.recordLifecycle('diagnostics_export_requested')
  const core = await supervisor.request('core.getDiagnostics', {})
  const testOutputPath = isUiE2e ? process.env.MUSIC_BRIDGE_DIAGNOSTIC_EXPORT_PATH : undefined
  const selection = testOutputPath
    ? { canceled: false, filePath: testOutputPath }
    : mainWindow
      ? await dialog.showSaveDialog(mainWindow, {
          title: '导出 Music Bridge 诊断文件',
          defaultPath: 'MusicBridge-diagnostics.json',
          filters: [{ name: 'JSON', extensions: ['json'] }],
        })
      : await dialog.showSaveDialog({
          title: '导出 Music Bridge 诊断文件',
          defaultPath: 'MusicBridge-diagnostics.json',
          filters: [{ name: 'JSON', extensions: ['json'] }],
        })
  if (selection.canceled || !selection.filePath) return { exported: false }

  await writeDiagnosticReport(selection.filePath, {
    platform: {
      platform: process.platform,
      arch: process.arch,
      appVersion: app.getVersion(),
      electronVersion: process.versions.electron ?? 'unknown',
      nodeVersion: process.versions.node,
    },
    main: mainDiagnostics.snapshot(core.health),
    core,
    gates: [
      ...mainDiagnostics.snapshot(core.health).gates,
      ...core.gates,
      { name: 'diagnostic-export', status: 'pass' },
    ],
  })
  mainDiagnostics.recordLifecycle('diagnostics_export_completed')
  return { exported: true }
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
  ipcMain.handle('diagnostics:export', (event) =>
    invokeCore(event, () => exportDiagnosticsFromMain(supervisor)),
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
  ipcMain.handle('account:get-state', (event) =>
    invokeCore(event, () => supervisor.request('account.getState', {})),
  )
  ipcMain.handle('account:refresh', (event) =>
    invokeCore(event, () => supervisor.request('account.refresh', {})),
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
  ipcMain.handle('library:daily-recommendations', (event) =>
    invokeCore(event, () => supervisor.request('library.dailyRecommendations', {})),
  )
  ipcMain.handle('roon:list-zones', (event) =>
    invokeCore(event, () => supervisor.request('roon.listZones', {})),
  )
  ipcMain.handle('roon:select-zone', (event, zoneId: unknown) =>
    invokeCore(event, () =>
      supervisor.request('roon.selectZone', { zoneId: requireZoneId(zoneId) }),
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
  ipcMain.handle('remote-core:get-state', (event) => {
    return invokeRemoteCore(event, () => {
      requireRemoteCoreDevelopment()
      return remoteCoreTunnelManager.getState()
    })
  })
  ipcMain.handle('remote-core:start', (event) => invokeRemoteCore(event, startRemoteCoreDevelopment))
  ipcMain.handle('remote-core:stop', (event) => invokeRemoteCore(event, stopRemoteCoreDevelopment))
  ipcMain.handle('remote-core:reconnect', (event) => invokeRemoteCore(event, reconnectRemoteCoreDevelopment))
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
  window.on('close', (event) => {
    if (!shouldHideWindowOnClose(quitAfterCoreShutdown)) {
      return
    }
    event.preventDefault()
    window.hide()
  })
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = undefined
  })
  void window.loadURL(`${RENDERER_SCHEME}://${RENDERER_HOST}${RENDERER_ENTRY_PATH}`)

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
  return buildAllowlistedCoreEnvironment(process.env, {
    startupTest: isStartupTest,
    uiE2e: isUiE2e,
    coreCrashGate: isCoreCrashGate || isCredentialRecoveryGate,
    roonTimeGate: isRoonTimeGate,
    remoteCoreMode: coreMode,
    ...(remoteStreamPort !== undefined ? { remoteStreamPort } : {}),
  })
}

function requireRemoteCoreDevelopment(): void {
  if (app.isPackaged) {
    publicIpcFailure('NOT_READY', 'Remote Core development mode is disabled in packaged builds')
  }
}

async function invokeRemoteCore<T>(
  event: Electron.IpcMainInvokeEvent,
  operation: () => Promise<T> | T,
): Promise<T> {
  requireTrustedRenderer(event)
  try {
    return await operation()
  } catch (error) {
    if (error instanceof CoreIpcError) {
      return publicIpcFailure(error.code, error.message)
    }
    if (
      error &&
      typeof error === 'object' &&
      (error as { code?: unknown }).code === 'NOT_READY'
    ) {
      return publicIpcFailure('NOT_READY', 'Remote Core development mode is disabled in packaged builds')
    }
    return publicIpcFailure('INTERNAL_ERROR', 'Remote Core request failed')
  }
}

async function startRemoteCoreDevelopment(): Promise<RemoteCoreTunnelState> {
  requireRemoteCoreDevelopment()
  return remoteCoreTunnelManager.start({
    sshTarget: process.env.CORE_SSH_TARGET ?? '',
    remoteStreamPort: DEFAULT_REMOTE_STREAM_PORT,
    localStreamPort: LOCAL_STREAM_PORT,
    autoReconnect: true,
  })
}

async function stopRemoteCoreDevelopment(): Promise<RemoteCoreTunnelState> {
  requireRemoteCoreDevelopment()
  await coreSupervisor?.request('playback.stop', {}).catch(() => undefined)
  const state = await remoteCoreTunnelManager.stop()
  if (coreMode === 'remote-core-development') {
    coreMode = 'local-core'
    remoteStreamPort = undefined
    await coreSupervisor?.restart(buildCoreEnvironment())
  }
  return state
}

async function reconnectRemoteCoreDevelopment(): Promise<RemoteCoreTunnelState> {
  requireRemoteCoreDevelopment()
  return remoteCoreTunnelManager.reconnect()
}

function createCoreSupervisor(
  dataDirectory: string,
  options: {
    onReady?: () => Promise<void> | void
    onEvent?: (event: TypedIpcEvent) => void
    onLifecycle?: (event: CoreSupervisorLifecycle) => void
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
    onLifecycle: options.onLifecycle,
    onEvent: (event: TypedIpcEvent) => {
      mainDiagnostics.recordCoreEvent(event)
      options.onEvent?.(event)
      requestTrayRefresh()
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
  if (isStartupTest || isUiE2e) {
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

async function waitForCredentialRecovery(
  supervisor: CoreSupervisor,
  credentialVault: CredentialVault,
): Promise<boolean> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    if (supervisor.restarts === 1 && supervisor.status === 'ready') {
      try {
        const health = await supervisor.request('core.getHealth', {})
        const stored = await credentialVault.read()
        if (
          health.provider === 'configured' &&
          stored.status === 'configured'
        ) {
          return true
        }
      } catch {
        // The restart boundary is allowed to race one health request.
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return false
}

async function bootstrap(): Promise<void> {
  await app.whenReady()
  app.setName('Music Bridge for Roon')
  await installRendererProtocol()
  installSessionSecurity(session.defaultSession)

  const prepared = await prepareCoreDataDirectory()
  if (isCredentialVaultGate && !isCredentialRecoveryGate) {
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
          verifyCredential: async (credential) =>
            (await supervisor.requestInternal('auth.verifyCredential', { credential })).status,
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
    onLifecycle: (event) => {
      const level = event.event === 'exit' || event.event === 'failed' ? 'warn' : 'info'
      mainDiagnostics.recordLifecycle(`core_${event.event}`, level)
    },
  })
  coreSupervisor = supervisor
  if (isCredentialRecoveryGate) {
    await prepared.credentialVault.save('v'.repeat(32))
  }
  await supervisor.start()
  await provisionProviderCredential({
    vault: prepared.credentialVault,
    environment: process.env,
    core: {
      verifyCredential: async (credential) =>
        (await supervisor.requestInternal('auth.verifyCredential', { credential })).status,
      setCredential: (credential) =>
        supervisor.request('auth.setCredential', { credential }),
      clearCredential: () => supervisor.request('auth.clearCredential', {}),
    },
  })
  initialProvisioningComplete = true
  if (isCredentialRecoveryGate) {
    const passed = await waitForCredentialRecovery(supervisor, prepared.credentialVault)
    await prepared.credentialVault.delete().catch(() => undefined)
    await supervisor.shutdown()
    process.stdout.write(`${passed ? 'CREDENTIAL_RECOVERY_GATE_PASS' : 'CREDENTIAL_RECOVERY_GATE_FAIL'}\n`)
    if (passed) app.quit()
    else app.exit(1)
    return
  }
  registerIpcHandlers(supervisor, prepared.credentialVault)
  createWindow(supervisor)
  createTray(supervisor)
  if (isCoreCrashGate) {
    setTimeout(() => {
      const passed = supervisor.status === 'failed' && supervisor.restarts === 1
      process.stdout.write(`${passed ? 'CORE_CRASH_GATE_PASS' : 'CORE_CRASH_GATE_FAIL'}\n`)
      app.quit()
    }, 1_000)
  }

  app.on('activate', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      showMainWindow()
    } else {
      createWindow(supervisor)
      createTray(supervisor)
    }
  })
}

void bootstrap().catch(() => {
  process.stderr.write('DESKTOP_STARTUP_FAIL\n')
  app.exit(1)
})

app.on('before-quit', (event) => {
  if (quitAfterCoreShutdown) {
    destroyTray()
    return
  }
  if (!coreSupervisor) {
    destroyTray()
    return
  }
  event.preventDefault()
  quitAfterCoreShutdown = true
  void remoteCoreTunnelManager.stop().catch(() => undefined).finally(() => {
    void coreSupervisor?.shutdown().finally(() => {
      destroyTray()
      app.quit()
    })
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' && !quitAfterCoreShutdown) {
    app.quit()
  }
})
