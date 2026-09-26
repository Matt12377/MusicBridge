import { BrowserWindow, session } from 'electron'
import { randomUUID } from 'node:crypto'
import { readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { normalizeRoonDisplayUrl, type RoonDisplayLyricsEvent, type RoonDisplaySettings } from '@music-bridge/contracts'
import { RoonDisplayProtocol } from './roon-display-protocol.js'

/** 官方网页运行在无 Node、无 preload、独立内存 session 中。外部页面不能访问业务 IPC。 */
export class RoonDisplayConnection {
  private window?: BrowserWindow
  private generation = 0
  private timer?: ReturnType<typeof setTimeout>
  private connectDeadline?: ReturnType<typeof setTimeout>
  private readonly partition = 'roon-display-' + randomUUID()
  private isolated?: Electron.Session
  private state: RoonDisplaySettings = { url: '', status: 'disabled' }
  private pending = new Map<string, RoonDisplayLyricsEvent>()
  private delivering = false
  private desiredConfigurationRevision = 0
  private saving: Promise<unknown> = Promise.resolve()
  private paused = false

  constructor(private readonly options: {
    settingsPath: string
    forward(event: RoonDisplayLyricsEvent): Promise<unknown>
  }) {}

  getSettings(): RoonDisplaySettings { return { ...this.state } }

  async restore(): Promise<void> {
    this.desiredConfigurationRevision++
    const operation = this.saving.catch(() => {}).then(async () => {
      let url = ''
      try {
        if ((await stat(this.options.settingsPath)).size > 2048) throw new Error('配置超限')
        const value = JSON.parse(await readFile(this.options.settingsPath, 'utf8'))
        url = normalizeRoonDisplayUrl(value.url)
      } catch { /* 缺少或无效配置不连接任意地址。 */ }
      this.applyConfiguration(url)
    })
    this.saving = operation
    await operation
  }

  async configure(value: unknown): Promise<RoonDisplaySettings> {
    const url = normalizeRoonDisplayUrl(value)
    const revision = ++this.desiredConfigurationRevision
    const operation = this.saving.catch(() => {}).then(async () => {
      const temp = this.options.settingsPath + '.' + randomUUID() + '.tmp'
      try {
        await writeFile(temp, JSON.stringify({ url }) + '\n', { mode: 0o600, flag: 'wx' })
        await rename(temp, this.options.settingsPath)
      } catch (error) {
        // 写盘未成功时继续使用上一个持久化目标；若旧重试被新意图抑制，则恢复连接。
        if (revision === this.desiredConfigurationRevision && !this.paused && this.state.url && this.state.status === 'disconnected') {
          this.start(this.state.url)
        }
        throw error
      } finally { await unlink(temp).catch(() => {}) }
      this.applyConfiguration(url)
      return this.getSettings()
    })
    this.saving = operation
    return operation
  }

  restart(): void {
    this.paused = false
    this.start(this.state.url)
  }

  stop(): void {
    this.paused = true
    this.teardown()
    this.state.status = this.state.url ? 'disconnected' : 'disabled'
  }

  private teardown(): void {
    this.generation++
    clearTimeout(this.timer)
    clearTimeout(this.connectDeadline)
    this.timer = undefined
    this.connectDeadline = undefined
    const window = this.window
    this.window = undefined
    if (window && !window.isDestroyed()) window.destroy()
    this.pending.clear()
  }

  private applyConfiguration(url: string): void {
    if (this.paused) {
      this.state = { url, status: url ? 'disconnected' : 'disabled' }
      return
    }
    this.start(url)
  }

  private publish(event: RoonDisplayLyricsEvent): void {
    if (event.type === 'reset') this.pending.clear()
    this.pending.set(event.type === 'reset' ? 'reset' : event.zoneId, event)
    if (this.pending.size > 33) this.pending.delete(this.pending.keys().next().value!)
    if (!this.delivering) void this.drain()
  }

  private async drain(): Promise<void> {
    this.delivering = true
    try {
      while (this.pending.size) {
        const key = this.pending.keys().next().value!
        const event = this.pending.get(key)!
        this.pending.delete(key)
        try { await this.options.forward(event) } catch { /* Core 重启后重新建立整个会话，不重放旧歌词。 */ }
      }
    } finally { this.delivering = false }
  }

  private start(url: string): void {
    this.teardown()
    this.state = { url, status: url ? 'connecting' : 'disabled' }
    this.publish({ type: 'reset', enabled: !!url })
    if (!url) return
    const generation = this.generation
    const base = new URL(url)
    const sameServer = (value: string): boolean => {
      try {
        const candidate = new URL(value)
        return ['http:', 'https:', 'ws:', 'wss:'].includes(candidate.protocol) && !candidate.username && !candidate.password
          && candidate.hostname === base.hostname && (candidate.port || (['https:', 'wss:'].includes(candidate.protocol) ? '443' : '80')) === (base.port || (base.protocol === 'https:' ? '443' : '80'))
      } catch { return false }
    }
    const isolated = this.isolated ?? session.fromPartition(this.partition, { cache: false })
    isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
    isolated.setPermissionCheckHandler(() => false)
    if (!this.isolated) isolated.on('will-download', event => event.preventDefault())
    this.isolated = isolated
    isolated.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !sameServer(details.url) }))
    const window = new BrowserWindow({ show: false, webPreferences: { session: isolated, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, webSecurity: true } })
    this.window = window
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    window.webContents.on('will-navigate', (event, target) => { if (target !== url) event.preventDefault() })
    window.webContents.on('will-redirect', (event, target) => { if (target !== url) event.preventDefault() })
    const parser = new RoonDisplayProtocol()
    const sockets = new Set<string>()
    const fail = () => {
      if (generation !== this.generation || this.timer) return
      this.state.status = 'disconnected'
      clearTimeout(this.connectDeadline)
      parser.clear()
      sockets.clear()
      this.publish({ type: 'reset', enabled: true })
      // 有界频率重连；不会阻塞 Core 或任何播放命令。
      const revision = this.desiredConfigurationRevision
      this.timer = setTimeout(() => {
        this.timer = undefined
        if (generation === this.generation && revision === this.desiredConfigurationRevision && !this.paused) {
          this.start(this.state.url)
        }
      }, 10000)
    }
    window.webContents.on('render-process-gone', fail)
    window.webContents.on('did-fail-load', fail)
    try {
      window.webContents.debugger.attach('1.3')
      window.webContents.debugger.on('detach', fail)
      window.webContents.debugger.on('message', (_event, method, params) => {
        if (generation !== this.generation || this.timer) return
        if (method === 'Network.webSocketCreated' && sameServer(params.url)) sockets.add(params.requestId)
        if ((method === 'Network.webSocketClosed' || method === 'Network.webSocketFrameError') && sockets.has(params.requestId)) fail()
        if (method !== 'Network.webSocketFrameReceived' || !sockets.has(params.requestId)) return
        const response = params.response
        if (typeof response?.payloadData !== 'string') return
        for (const event of parser.receive(response.payloadData, response.opcode)) {
          clearTimeout(this.connectDeadline)
          this.state.status = 'connected'
          this.publish(event)
        }
      })
      // 在初始页面载入前调用，但不能 await：空 WebContents 的命令需导航后才完成。
      void window.webContents.debugger.sendCommand('Network.enable').catch(fail)
      void window.loadURL(url).catch(fail)
      this.connectDeadline = setTimeout(() => { if (this.state.status !== 'connected') fail() }, 20000)
    } catch { fail() }
  }
}
