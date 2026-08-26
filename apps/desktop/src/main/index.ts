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
  PlaybackQueueRequestItem,
  PlaybackQualityPreference,
  PlaybackSourcePreference,
  PlaybackSnapshot,
  PublicAuthState,
  PublicBridgeState,
  PublicErrorCode,
  RemoteCoreMode,
  RemoteCoreTunnelState,
  FavoriteEntityDescriptor,
  FavoriteKind,
  RoonImageOptions,
  RoonImageResult,
  RoonImageShapeSummary,
  TrackSummary,
  TypedIpcEvent,
} from '@music-bridge/contracts'
import {
  IPC_VERSION,
  MAX_PLAYBACK_QUEUE_ITEMS,
  summarizeRoonImageBinary,
  validateIpcEvent,
} from '@music-bridge/contracts'
import { appendFileSync, chmodSync } from 'node:fs'
import { mkdir, readFile, realpath } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const APPLICATION_NAME = 'Music Bridge for Roon'
app.setName(APPLICATION_NAME)

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
import {
  buildCoreEnvironment as buildAllowlistedCoreEnvironment,
  resolveRemoteCoreLocalPorts,
} from './core-environment.js'
import {
  DEFAULT_REMOTE_STREAM_PORT,
  RemoteCoreTunnelManager,
} from './remote-core-tunnel.js'
import {
  readStartupTestConfiguration,
  type ElectronColdStartStage,
} from './startup-test-config.js'
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
const startupTestConfiguration = readStartupTestConfiguration()
const isStartupTest = startupTestConfiguration.isStartupTest
const isUiE2e = process.env.MUSIC_BRIDGE_UI_E2E === '1'
const isCoreCrashGate = startupTestConfiguration.coreCrashGate
const isCredentialVaultGate = startupTestConfiguration.credentialVaultGate
const isCoreRestartCredentialRecoveryGate =
  startupTestConfiguration.coreRestartCredentialRecoveryGate
const electronColdStartStage: ElectronColdStartStage | undefined =
  startupTestConfiguration.electronColdStartStage
const isElectronColdStartGate = electronColdStartStage !== undefined
const isRoonTimeGate = process.env.MUSIC_BRIDGE_ROON_TIME_GATE === '1'
const isRoonBrowseGate = process.env.MUSIC_BRIDGE_ROON_BROWSE_GATE === '1'
const isRoonImageGate = process.env.MUSIC_BRIDGE_ROON_IMAGE_GATE === '1'
const roonImageGatePath = process.env.MUSIC_BRIDGE_ROON_IMAGE_GATE_PATH

let mainWindow: BrowserWindow | undefined
let coreSupervisor: CoreSupervisor | undefined
let coreMode: RemoteCoreMode = 'local-core'
let remoteStreamPort: number | undefined
let tray: Tray | undefined
let trayRefreshPromise: Promise<void> | undefined
let trayRefreshQueued = false
let quitAfterCoreShutdown = false
const mainDiagnostics = new MainDiagnosticRecorder()

function recordRoonImageShape(summary: RoonImageShapeSummary): void {
  if (
    !isRoonImageGate
    || !roonImageGatePath
    || !/^\/tmp\/musicbridge-roon-image-gate-[A-Za-z0-9._-]+\.jsonl$/.test(roonImageGatePath)
  ) {
    return
  }
  try {
    appendFileSync(roonImageGatePath, `${JSON.stringify(summary)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    })
    chmodSync(roonImageGatePath, 0o600)
  } catch {
    // 诊断采样不得改变图片行为。
  }
}

function recordPreloadRoonImageShape(value: unknown): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return
  const shape = value as Record<string, unknown>
  if (
    shape.layer !== 'preload'
    || (shape.contentType !== 'image/jpeg' && shape.contentType !== 'image/png')
    || !Number.isSafeInteger(shape.byteLength)
    || (shape.byteLength as number) < 0
    || (shape.byteLength as number) > 4 * 1024 * 1024
    || typeof shape.magic8 !== 'string'
    || !/^[0-9a-f]{0,16}$/u.test(shape.magic8)
    || typeof shape.bodyType !== 'string'
    || shape.bodyType.length > 64
    || typeof shape.isBuffer !== 'boolean'
    || typeof shape.isUint8Array !== 'boolean'
    || typeof shape.isArrayBuffer !== 'boolean'
    || typeof shape.valid !== 'boolean'
  ) {
    return
  }
  recordRoonImageShape({
    layer: 'preload',
    contentType: shape.contentType,
    byteLength: shape.byteLength as number,
    magic8: shape.magic8,
    bodyType: shape.bodyType,
    isBuffer: shape.isBuffer,
    isUint8Array: shape.isUint8Array,
    isArrayBuffer: shape.isArrayBuffer,
    valid: shape.valid,
  })
}

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
  positionMs: 0,
  canNext: false,
  canPrevious: false,
  canStop: false,
  canPause: false,
  canResume: false,
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

function installApplicationMenu(): void {
  const editMenu: Electron.MenuItemConstructorOptions = {
    label: 'Edit',
    submenu: [
      { role: 'undo' },
      { role: 'redo' },
      { type: 'separator' },
      { role: 'cut' },
      { role: 'copy' },
      { role: 'paste' },
      { role: 'selectAll' },
    ],
  }
  const windowMenu: Electron.MenuItemConstructorOptions = {
    label: 'Window',
    submenu: [
      { role: 'minimize' },
      { role: 'zoom' },
      { type: 'separator' },
      { role: 'front' },
    ],
  }
  const template: Electron.MenuItemConstructorOptions[] = process.platform === 'darwin'
    ? [
        {
          label: APPLICATION_NAME,
          submenu: [
            { role: 'about' },
            { type: 'separator' },
            { role: 'services' },
            { type: 'separator' },
            { role: 'hide' },
            { role: 'hideOthers' },
            { role: 'unhide' },
            { type: 'separator' },
            { role: 'quit' },
          ],
        },
        editMenu,
        windowMenu,
      ]
    : [
        { label: 'File', submenu: [{ role: 'close' }, { role: 'quit' }] },
        editMenu,
        { role: 'viewMenu' },
        windowMenu,
      ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
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

class PublicIpcError extends Error {
  readonly code: PublicErrorCode

  constructor(code: PublicErrorCode, message: string) {
    // Electron 通过 ipcRenderer.invoke() 传递异常时只保留 Error.message；
    // 将受控公开错误码写入消息，Renderer 才能安全恢复具体错误语义。
    super(`[${code}] ${message}`)
    this.name = 'PublicIpcError'
    this.code = code
  }
}

function publicIpcFailure(code: PublicErrorCode, message: string): never {
  throw new PublicIpcError(code, message)
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

function requireFavoriteKind(value: unknown): FavoriteKind | undefined {
  if (value === undefined) return undefined
  if (value !== 'track' && value !== 'album' && value !== 'artist') {
    return publicIpcFailure('INVALID_IPC_REQUEST', 'Invalid favorite kind')
  }
  return value
}

function requireFavoriteDescriptor(value: unknown): FavoriteEntityDescriptor {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return publicIpcFailure('INVALID_IPC_REQUEST', 'Invalid favorite descriptor')
  }
  const descriptor = value as Record<string, unknown>
  const allowedKeys = new Set([
    'kind',
    'title',
    'subtitle',
    'artist',
    'album',
    'durationMs',
    'trackNumber',
    'discNumber',
    'year',
    'version',
  ])
  if (Object.keys(descriptor).some((key) => !allowedKeys.has(key))) {
    return publicIpcFailure('INVALID_IPC_REQUEST', 'Invalid favorite descriptor')
  }
  const kind = requireFavoriteKind(descriptor.kind)
  const title = descriptor.title
  if (
    kind === undefined ||
    typeof title !== 'string' ||
    title.trim().length === 0 ||
    title.length > 512
  ) {
    return publicIpcFailure('INVALID_IPC_REQUEST', 'Invalid favorite descriptor')
  }
  for (const key of ['subtitle', 'artist', 'album', 'version'] as const) {
    const field = descriptor[key]
    if (field !== undefined && (typeof field !== 'string' || field.length > 512)) {
      return publicIpcFailure('INVALID_IPC_REQUEST', 'Invalid favorite descriptor')
    }
  }
  for (const key of ['durationMs', 'trackNumber', 'discNumber', 'year'] as const) {
    const field = descriptor[key]
    if (
      field !== undefined &&
      (typeof field !== 'number' || !Number.isSafeInteger(field) || field < 0)
    ) {
      return publicIpcFailure('INVALID_IPC_REQUEST', 'Invalid favorite descriptor')
    }
  }
  const optionalText = (key: 'subtitle' | 'artist' | 'album' | 'version'): string | undefined =>
    typeof descriptor[key] === 'string' ? descriptor[key] as string : undefined
  const optionalNumber = (key: 'durationMs' | 'trackNumber' | 'discNumber' | 'year'): number | undefined =>
    typeof descriptor[key] === 'number' ? descriptor[key] as number : undefined
  const subtitle = optionalText('subtitle')
  const artist = optionalText('artist')
  const album = optionalText('album')
  const version = optionalText('version')
  const durationMs = optionalNumber('durationMs')
  const trackNumber = optionalNumber('trackNumber')
  const discNumber = optionalNumber('discNumber')
  const year = optionalNumber('year')
  return {
    kind,
    title,
    ...(subtitle !== undefined ? { subtitle } : {}),
    ...(artist !== undefined ? { artist } : {}),
    ...(album !== undefined ? { album } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(trackNumber !== undefined ? { trackNumber } : {}),
    ...(discNumber !== undefined ? { discNumber } : {}),
    ...(year !== undefined ? { year } : {}),
    ...(version !== undefined ? { version } : {}),
  }
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

function requireRoonReference(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.trim().length === 0 ||
    value.length > 128 ||
    !/^musicbridge-v2-(?:entity|image)-[0-9a-f-]{36}$/u.test(value)
  ) {
    return publicIpcFailure('INVALID_IPC_REQUEST', 'Invalid Roon Library reference')
  }
  return value
}

function requireRoonEntityReference(value: unknown): string {
  const reference = requireRoonReference(value)
  if (!reference.startsWith('musicbridge-v2-entity-')) {
    return publicIpcFailure('INVALID_IPC_REQUEST', 'Invalid Roon entity reference')
  }
  return reference
}

function requireRoonImageOptions(value: unknown): RoonImageOptions | undefined {
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return publicIpcFailure('INVALID_IPC_REQUEST', 'Invalid Roon image options')
  }
  const options = value as {
    scale?: unknown
    width?: unknown
    height?: unknown
    format?: unknown
  }
  if (
    Object.keys(options).some((key) => !['scale', 'width', 'height', 'format'].includes(key)) ||
    (options.scale !== undefined && !['fit', 'fill', 'stretch'].includes(String(options.scale))) ||
    (options.format !== undefined && !['image/jpeg', 'image/png'].includes(String(options.format))) ||
    (options.width !== undefined && (
      typeof options.width !== 'number' || !Number.isSafeInteger(options.width) || options.width < 1 || options.width > 2048
    )) ||
    (options.height !== undefined && (
      typeof options.height !== 'number' || !Number.isSafeInteger(options.height) || options.height < 1 || options.height > 2048
    ))
  ) {
    return publicIpcFailure('INVALID_IPC_REQUEST', 'Invalid Roon image options')
  }
  return {
    ...(options.scale !== undefined ? { scale: options.scale as RoonImageOptions['scale'] } : {}),
    ...(options.width !== undefined ? { width: options.width } : {}),
    ...(options.height !== undefined ? { height: options.height } : {}),
    ...(options.format !== undefined ? { format: options.format as RoonImageOptions['format'] } : {}),
  }
}

function requirePlaybackTrackId(value: unknown): string {
  if (typeof value !== 'string' || !/^\d+$/.test(value) || value === '0' || value.length > 128) {
    return publicIpcFailure('INVALID_IPC_REQUEST', 'Invalid playback track')
  }
  return value
}

function requireTrackSummary(value: unknown): TrackSummary {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return publicIpcFailure('INVALID_IPC_REQUEST', 'Invalid match track')
  }
  const track = value as Record<string, unknown>
  const allowedKeys = new Set(['id', 'title', 'artists', 'album', 'durationMs', 'artworkUrl'])
  if (Object.keys(track).some((key) => !allowedKeys.has(key))) {
    return publicIpcFailure('INVALID_IPC_REQUEST', 'Invalid match track')
  }
  const id = requirePlaybackTrackId(track.id)
  if (
    typeof track.title !== 'string' ||
    track.title.trim().length === 0 ||
    track.title.length > 512 ||
    typeof track.album !== 'string' ||
    track.album.trim().length === 0 ||
    track.album.length > 512 ||
    !Array.isArray(track.artists) ||
    track.artists.length > 64 ||
    track.artists.some((artist) => typeof artist !== 'string' || artist.trim().length === 0 || artist.length > 256)
  ) {
    return publicIpcFailure('INVALID_IPC_REQUEST', 'Invalid match track')
  }
  if (
    track.durationMs !== undefined &&
    (typeof track.durationMs !== 'number' ||
      !Number.isSafeInteger(track.durationMs) ||
      track.durationMs < 0 ||
      track.durationMs > 24 * 60 * 60 * 1000)
  ) {
    return publicIpcFailure('INVALID_IPC_REQUEST', 'Invalid match track')
  }
  if (track.artworkUrl !== undefined) {
    if (typeof track.artworkUrl !== 'string' || track.artworkUrl.length > 2_048) {
      return publicIpcFailure('INVALID_IPC_REQUEST', 'Invalid match track')
    }
    try {
      const url = new URL(track.artworkUrl)
      const hostname = url.hostname.toLowerCase()
      if (
        url.protocol !== 'https:' ||
        (hostname !== 'music.126.net' && !hostname.endsWith('.music.126.net')) ||
        url.username !== '' ||
        url.password !== '' ||
        url.hash !== ''
      ) {
        return publicIpcFailure('INVALID_IPC_REQUEST', 'Invalid match track')
      }
    } catch {
      return publicIpcFailure('INVALID_IPC_REQUEST', 'Invalid match track')
    }
  }
  return {
    id,
    title: track.title,
    artists: track.artists,
    album: track.album,
    ...(track.durationMs !== undefined ? { durationMs: track.durationMs } : {}),
    ...(track.artworkUrl !== undefined ? { artworkUrl: track.artworkUrl } : {}),
  }
}

function requirePlaybackQualityPreference(value: unknown): PlaybackQualityPreference {
  if (!['auto', 'standard', 'exhigh', 'lossless', 'hires'].includes(String(value))) {
    return publicIpcFailure('INVALID_IPC_REQUEST', 'Invalid playback quality preference')
  }
  return value as PlaybackQualityPreference
}

function requireRendererClickAtMs(value: unknown, receivedAtMs: number): number {
  if (value === undefined) return receivedAtMs
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value <= 0 ||
    value > receivedAtMs + 1_000 ||
    value < receivedAtMs - 60_000
  ) {
    return publicIpcFailure('INVALID_IPC_REQUEST', 'Invalid playback startup timestamp')
  }
  return value
}

function requirePlaybackSourcePreference(value: unknown): PlaybackSourcePreference {
  if (!['smart', 'netease', 'roon'].includes(String(value))) {
    return publicIpcFailure('INVALID_IPC_REQUEST', 'Invalid playback source preference')
  }
  return value as PlaybackSourcePreference
}

function requirePlaybackQueue(value: unknown): readonly PlaybackQueueRequestItem[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_PLAYBACK_QUEUE_ITEMS) {
    return publicIpcFailure('INVALID_IPC_REQUEST', 'Invalid playback queue')
  }
  return value.map((item) => {
    if (
      !item ||
      typeof item !== 'object' ||
      Array.isArray(item) ||
      Object.keys(item).some((key) => !['trackId', 'qualityPreference', 'preferredSource'].includes(key))
    ) {
      return publicIpcFailure('INVALID_IPC_REQUEST', 'Invalid playback queue')
    }
    const queueItem = item as { trackId?: unknown; qualityPreference?: unknown; preferredSource?: unknown }
    const preferredSource = queueItem.preferredSource === undefined
      ? {}
      : { preferredSource: requirePlaybackSourcePreference(queueItem.preferredSource) }
    return {
      trackId: requirePlaybackTrackId(queueItem.trackId),
      qualityPreference: requirePlaybackQualityPreference(queueItem.qualityPreference),
      ...preferredSource,
    }
  })
}

function requirePlaybackIndex(value: unknown, items: readonly PlaybackQueueRequestItem[]): number {
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

function requireExistingPlaybackIndex(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value >= MAX_PLAYBACK_QUEUE_ITEMS
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
  if (isRoonImageGate) {
    ipcMain.handle('roon:image:diagnostic', (event, shape: unknown) => {
      requireTrustedRenderer(event)
      recordPreloadRoonImageShape(shape)
      return { recorded: true }
    })
  }
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
  ipcMain.handle('library:search-artists', (event, query: unknown, page: unknown) =>
    invokeCore(event, () =>
      supervisor.request('library.searchArtists', {
        query: requireSearchQuery(query),
        page: requireLibraryPage(page),
      }),
    ),
  )
  ipcMain.handle('library:search-albums', (event, query: unknown, page: unknown) =>
    invokeCore(event, () =>
      supervisor.request('library.searchAlbums', {
        query: requireSearchQuery(query),
        page: requireLibraryPage(page),
      }),
    ),
  )
  ipcMain.handle('library:artist', (event, artistId: unknown, page: unknown) =>
    invokeCore(event, () =>
      supervisor.request('library.artist', {
        artistId: requirePlaybackTrackId(artistId),
        page: requireLibraryPage(page),
      }),
    ),
  )
  ipcMain.handle('library:album', (event, albumId: unknown, page: unknown) =>
    invokeCore(event, () =>
      supervisor.request('library.album', {
        albumId: requirePlaybackTrackId(albumId),
        page: requireLibraryPage(page),
      }),
    ),
  )
  ipcMain.handle('library:liked', (event, page: unknown) =>
    invokeCore(event, () =>
      supervisor.request('library.liked', { page: requireLibraryPage(page) }),
    ),
  )
  ipcMain.handle('library:like-status', (event, trackId: unknown) =>
    invokeCore(event, () => supervisor.request('library.likeStatus', {
      trackId: requirePlaybackTrackId(trackId),
    })),
  )
  ipcMain.handle('library:like', (event, trackId: unknown, liked: unknown) =>
    invokeCore(event, () => {
      if (typeof liked !== 'boolean') {
        return publicIpcFailure('INVALID_IPC_REQUEST', 'Invalid like state')
      }
      return supervisor.request('library.like', {
        trackId: requirePlaybackTrackId(trackId),
        liked,
      })
    }),
  )
  ipcMain.handle('library:match', (event, track: unknown) =>
    invokeCore(event, () => supervisor.request('library.match', {
      track: requireTrackSummary(track),
    })),
  )
  ipcMain.handle('library:aggregate-search', (event, query: unknown, page: unknown) =>
    invokeCore(event, () => supervisor.request('library.aggregateSearch', {
      query: requireSearchQuery(query),
      page: requireLibraryPage(page),
    })),
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
  ipcMain.handle('favorites:list', (event, kind: unknown, page: unknown) =>
    invokeCore(event, () => {
      const favoriteKind = requireFavoriteKind(kind)
      return supervisor.request('favorites.list', {
        ...(favoriteKind !== undefined ? { kind: favoriteKind } : {}),
        page: requireLibraryPage(page),
      })
    }),
  )
  ipcMain.handle('favorites:check', (event, descriptor: unknown) =>
    invokeCore(event, () => supervisor.request('favorites.check', {
      descriptor: requireFavoriteDescriptor(descriptor),
    })),
  )
  ipcMain.handle('favorites:set', (event, descriptor: unknown, favorite: unknown) =>
    invokeCore(event, () => {
      if (typeof favorite !== 'boolean') {
        return publicIpcFailure('INVALID_IPC_REQUEST', 'Invalid favorite state')
      }
      return supervisor.request('favorites.set', {
        descriptor: requireFavoriteDescriptor(descriptor),
        favorite,
      })
    }),
  )
  ipcMain.handle('roon:list-zones', (event) =>
    invokeCore(event, () => supervisor.request('roon.listZones', {})),
  )
  ipcMain.handle('roon:select-zone', (event, zoneId: unknown) =>
    invokeCore(event, () =>
      supervisor.request('roon.selectZone', { zoneId: requireZoneId(zoneId) }),
    ),
  )
  ipcMain.handle('roon:library:albums', (event, page: unknown) =>
    invokeCore(event, () =>
      supervisor.request('roon.library.albums', { page: requireLibraryPage(page) }),
    ),
  )
  ipcMain.handle('roon:library:artists', (event, page: unknown) =>
    invokeCore(event, () =>
      supervisor.request('roon.library.artists', { page: requireLibraryPage(page) }),
    ),
  )
  ipcMain.handle('roon:library:genres', (event, page: unknown) =>
    invokeCore(event, () =>
      supervisor.request('roon.library.genres', { page: requireLibraryPage(page) }),
    ),
  )
  ipcMain.handle('roon:library:playlists', (event, page: unknown) =>
    invokeCore(event, () =>
      supervisor.request('roon.library.playlists', { page: requireLibraryPage(page) }),
    ),
  )
  ipcMain.handle('roon:library:album', (event, reference: unknown, page: unknown) =>
    invokeCore(event, () =>
      supervisor.request('roon.library.album', {
        reference: requireRoonReference(reference),
        page: requireLibraryPage(page),
      }),
    ),
  )
  ipcMain.handle('roon:library:artist', (event, reference: unknown, page: unknown) =>
    invokeCore(event, () =>
      supervisor.request('roon.library.artist', {
        reference: requireRoonReference(reference),
        page: requireLibraryPage(page),
      }),
    ),
  )
  ipcMain.handle('roon:library:genre', (event, reference: unknown, page: unknown) =>
    invokeCore(event, () =>
      supervisor.request('roon.library.genre', {
        reference: requireRoonReference(reference),
        page: requireLibraryPage(page),
      }),
    ),
  )
  ipcMain.handle('roon:library:playlist', (event, reference: unknown, page: unknown) =>
    invokeCore(event, () =>
      supervisor.request('roon.library.playlist', {
        reference: requireRoonReference(reference),
        page: requireLibraryPage(page),
      }),
    ),
  )
  ipcMain.handle('roon:library:search', (event, query: unknown, page: unknown) =>
    invokeCore(event, () =>
      supervisor.request('roon.library.search', {
        query: requireSearchQuery(query),
        page: requireLibraryPage(page),
      }),
    ),
  )
  ipcMain.handle('roon:library:image', (event, reference: unknown, options: unknown) =>
    invokeCore(event, async () => {
      const imageOptions = requireRoonImageOptions(options)
      const result = await supervisor.request('roon.library.image', {
        reference: requireRoonReference(reference),
        ...(imageOptions !== undefined ? { options: imageOptions } : {}),
      })
      recordRoonImageShape(summarizeRoonImageBinary(
        'main-ipc',
        (result as RoonImageResult).contentType,
        (result as RoonImageResult).body,
      ))
      return result
    }),
  )
  ipcMain.handle('roon:library:play', (event, reference: unknown, zoneId: unknown) =>
    invokeCore(event, () =>
      supervisor.request('roon.library.play', {
        reference: requireRoonEntityReference(reference),
        zoneId: requireZoneId(zoneId),
      }),
    ),
  )
  ipcMain.handle('roon:library:queue', (event, reference: unknown, zoneId: unknown) =>
    invokeCore(event, () =>
      supervisor.request('roon.library.queue', {
        reference: requireRoonEntityReference(reference),
        zoneId: requireZoneId(zoneId),
      }),
    ),
  )
  ipcMain.handle('roon:transport:stop', (event) =>
    invokeCore(event, () => supervisor.request('roon.transport.stop', {})),
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
  ipcMain.handle('playback:play', (event, trackId: unknown, qualityPreference: unknown, rendererClickAt: unknown) => {
    const mainReceivedAtMs = Date.now()
    return invokeCore(event, () => {
      const rendererClickAtMs = requireRendererClickAtMs(rendererClickAt, mainReceivedAtMs)
      mainDiagnostics.recordPlaybackStartup(rendererClickAtMs, mainReceivedAtMs)
      return supervisor.request('playback.play', {
        trackId: requirePlaybackTrackId(trackId),
        qualityPreference: requirePlaybackQualityPreference(qualityPreference),
        rendererClickAtMs,
      })
    })
  })
  ipcMain.handle('playback:pause', (event) =>
    invokeCore(event, () => supervisor.request('playback.pause', {})),
  )
  ipcMain.handle('playback:resume', (event) =>
    invokeCore(event, () => supervisor.request('playback.resume', {})),
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
  ipcMain.handle('playback:play-queue-index', (event, index: unknown) =>
    invokeCore(event, () =>
      supervisor.request('playback.playQueueIndex', {
        index: requireExistingPlaybackIndex(index),
      }),
    ),
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
  ipcMain.handle('playback:seek', (event, positionMs: unknown) =>
    invokeCore(event, () => {
      if (
        typeof positionMs !== 'number' ||
        !Number.isSafeInteger(positionMs) ||
        positionMs < 0 ||
        positionMs > 24 * 60 * 60 * 1_000
      ) {
        return publicIpcFailure('INVALID_IPC_REQUEST', 'Invalid playback position')
      }
      return supervisor.request('playback.seek', { positionMs })
    }),
  )
  ipcMain.handle('playback:append-queue', (event, items: unknown) =>
    invokeCore(event, () =>
      supervisor.request('playback.appendQueue', {
        items: requirePlaybackQueue(items),
      }),
    ),
  )
  ipcMain.handle('playback:insert-next', (event, items: unknown) =>
    invokeCore(event, () =>
      supervisor.request('playback.insertNext', {
        items: requirePlaybackQueue(items),
      }),
    ),
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
    coreCrashGate: isCoreCrashGate || isCoreRestartCredentialRecoveryGate,
    roonTimeGate: isRoonTimeGate,
    roonBrowseGate: isRoonBrowseGate,
    roonImageGate: isRoonImageGate,
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
  const localPorts = resolveRemoteCoreLocalPorts(process.env)
  return remoteCoreTunnelManager.start({
    sshTarget: process.env.CORE_SSH_TARGET ?? '',
    remoteStreamPort: DEFAULT_REMOTE_STREAM_PORT,
    localStreamPort: localPorts.streamPort,
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
  if (isStartupTest) {
    const userDataDirectory = startupTestConfiguration.userDataDirectory
    if (!userDataDirectory) {
      throw new Error('Electron startup test userData directory is missing')
    }
    app.setPath('userData', userDataDirectory)
  } else if (isUiE2e) {
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

async function waitForProviderConfigured(
  supervisor: CoreSupervisor,
  credentialVault: CredentialVault,
): Promise<boolean> {
  try {
    const health = await supervisor.request('core.getHealth', {})
    const stored = await credentialVault.read()
    return health.provider === 'configured' && stored.status === 'configured'
  } catch {
    return false
  }
}

async function waitForCoreRestartCredentialRecovery(
  supervisor: CoreSupervisor,
  credentialVault: CredentialVault,
): Promise<boolean> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    if (supervisor.restarts === 1 && supervisor.status === 'ready') {
      try {
        if (await waitForProviderConfigured(supervisor, credentialVault)) return true
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
  app.setAboutPanelOptions({ applicationName: APPLICATION_NAME })
  installApplicationMenu()
  await installRendererProtocol()
  installSessionSecurity(session.defaultSession)

  const prepared = await prepareCoreDataDirectory()
  if (isCredentialVaultGate && !isCoreRestartCredentialRecoveryGate && !isElectronColdStartGate) {
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
  if (isCoreRestartCredentialRecoveryGate || electronColdStartStage === 'seed') {
    await prepared.credentialVault.save('v'.repeat(32))
  }
  await supervisor.start()
  const credentialCore = {
    verifyCredential: async (credential: string) =>
      (await supervisor.requestInternal('auth.verifyCredential', { credential })).status,
    setCredential: (credential: string) =>
      supervisor.request('auth.setCredential', { credential }),
    clearCredential: () => supervisor.request('auth.clearCredential', {}),
  }
  if (electronColdStartStage === 'restore') {
    await restoreProviderCredential({ vault: prepared.credentialVault, core: credentialCore })
  } else {
    await provisionProviderCredential({
      vault: prepared.credentialVault,
      environment: process.env,
      core: credentialCore,
    })
  }
  initialProvisioningComplete = true
  if (isCoreRestartCredentialRecoveryGate) {
    const passed = await waitForCoreRestartCredentialRecovery(
      supervisor,
      prepared.credentialVault,
    )
    await prepared.credentialVault.delete().catch(() => undefined)
    await supervisor.shutdown()
    process.stdout.write(
      `${passed ? 'CORE_RESTART_CREDENTIAL_RECOVERY_GATE_PASS' : 'CORE_RESTART_CREDENTIAL_RECOVERY_GATE_FAIL'}\n`,
    )
    if (passed) app.quit()
    else app.exit(1)
    return
  }
  if (isElectronColdStartGate) {
    const passed = await waitForProviderConfigured(supervisor, prepared.credentialVault)
    if (electronColdStartStage === 'restore') {
      await prepared.credentialVault.delete().catch(() => undefined)
    }
    await supervisor.shutdown()
    const marker =
      electronColdStartStage === 'seed'
        ? 'ELECTRON_COLD_START_SEED'
        : 'ELECTRON_COLD_START_RESTORE'
    process.stdout.write(`${passed ? `${marker}_PASS` : `${marker}_FAIL`}\n`)
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
