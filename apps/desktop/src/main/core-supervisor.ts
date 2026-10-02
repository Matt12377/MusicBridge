import { isLibraryReadCommand } from '@music-bridge/contracts'
import { randomUUID } from 'node:crypto'
import { createLibraryReadTraceStreamReader, emitLibraryReadTrace, libraryReadTraceFailure, type LibraryReadTraceSink } from '../shared/library-read-trace.js'
import { createPlaybackFailureTraceStreamReader } from '../shared/playback-failure-trace.js'

import {
  IPC_VERSION,
  isActivateRestoredDataset,
  parseIpcRuntimeMessage,
  validateIpcInternalResponseForCommand,
  validateIpcResponseForCommand,
  validateIpcRequest,
  type IpcCommand,
  type IpcCommandPayloads,
  type IpcCommandResults,
  type IpcInternalCommand,
  type IpcInternalCommandResults,
  type PublicErrorCode,
  type TypedIpcEvent,
  type ActivateRestoredDataset,
  type RestoreActivationView,
  type PerformanceTraceRecorder,
  type PerformanceTraceContext,
  type PerformanceSpan,
  type PlaybackEventProtocol,
  type PlaybackEventProtocolAck,
  type PlaybackStreamSnapshot,
} from '@music-bridge/contracts'

export interface CoreMessagePort {
  on(event: 'message', listener: (event: { data: unknown }) => void): unknown
  start(): void
  close(): void
  postMessage(message: unknown): void
}

export interface CoreChildProcess {
  postMessage(message: unknown, transfer?: CoreMessagePort[]): void
  once(event: 'exit', listener: (code: number) => void): unknown
  kill(): boolean
  stdout?: { on(event: 'data', listener: (chunk: { toString(): string }) => void): unknown } | null
  stderr?: { on(event: 'data', listener: (chunk: unknown) => void): unknown } | null
}

export interface CoreSupervisorDependencies {
  createChannel(): { port1: CoreMessagePort; port2: CoreMessagePort }
  fork(
    entryPath: string,
    args: string[],
    options: {
      cwd: string
      env: NodeJS.ProcessEnv
      stdio: 'ignore' | 'pipe'
      serviceName: string
    },
  ): CoreChildProcess
}

export type CoreSupervisorStatus = 'stopped' | 'starting' | 'ready' | 'failed'

export type CoreSupervisorLifecycle =
  | { event: 'spawn' | 'ready' | 'restart' | 'failed' | 'stopped' }
  | { event: 'exit'; code: number }

export class CoreIpcError extends Error {
  constructor(
    readonly code: PublicErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'CoreIpcError'
  }
}

export interface CoreStartupClient {
  request: CoreSupervisor['request']
  requestInternal: CoreSupervisor['requestInternal']
  readonly playbackEvents: PlaybackEventProtocolAck | null
}
interface StartupAttempt {
  generation: number
  child: CoreChildProcess
  port: CoreMessagePort
  valid: boolean
  readyReceived: boolean
  playbackEvents: PlaybackEventProtocolAck | null
  cancelStart(error: CoreIpcError): void
}

interface PendingRequest {
  rendererReadId?: string
  performanceSpan?: PerformanceSpan
  detachReadAbort?: () => void
  readDeadlineAtMs?: number
  cancelCoreRead?: () => void
  command: IpcCommand
  internal: boolean
  timer: NodeJS.Timeout
  reject(error: CoreIpcError): void
  resolve(value: unknown): void
  accept?: (value: unknown) => void
}

/** 位置tick不能触发托盘的全队列读取。 */
export function shouldRefreshTrayForCoreEvent(event: TypedIpcEvent): boolean {
  return event.event !== 'playback.progress'
}

const DEFAULT_REQUEST_TIMEOUT_MS = 2_000
const DEFAULT_STARTUP_TIMEOUT_MS = 60_000
// 两份 WAV 的完整 Hash 读取各自最多 15 分钟；撤销仍走短控制请求。
const PREPARED_FILE_REQUEST_TIMEOUT_MS = 35 * 60_000
const LIBRARY_REQUEST_TIMEOUT_MS = 10_000
const PLAYBACK_REQUEST_TIMEOUT_MS = 60_000
const RESTORE_ACTIVATION_TIMEOUT_MS = 30 * 60_000

export class CoreSupervisor {
  private startupGeneration = 0
  private startupAttempt: StartupAttempt | undefined
  private child: CoreChildProcess | undefined
  private childExit: { child: CoreChildProcess; promise: Promise<void> } | undefined
  private port: CoreMessagePort | undefined
  private startPromise: Promise<void> | undefined
  private restartPromise: Promise<void> | undefined
  private manualRestartPromise: Promise<void> | undefined
  private shutdownPromise: Promise<void> | undefined
  private readyTimeoutOverride: number | undefined
  private activationFlight: { request: ActivateRestoredDataset; expectedDatasetId?: string; promise: Promise<RestoreActivationView> } | undefined
  private shuttingDown = false
  private restartCount = 0
  private readonly pending = new Map<string, PendingRequest>()
  private _status: CoreSupervisorStatus = 'stopped'

  constructor(
    private readonly options: {
      entryPath: string
      cwd: string
      env?: NodeJS.ProcessEnv
      playbackEventProtocol?: PlaybackEventProtocol | null
      dependencies: CoreSupervisorDependencies
      requestTimeoutMs?: number
      startupTimeoutMs?: number
      onEvent?: (event: TypedIpcEvent) => void
      onReady?: (client: CoreStartupClient) => Promise<void> | void
      onLifecycle?: (event: CoreSupervisorLifecycle) => void
      performance?: PerformanceTraceRecorder
      performanceContext?: () => PerformanceTraceContext | undefined
      libraryReadTrace?: LibraryReadTraceSink
    },
  ) {
    const timeout = options.startupTimeoutMs
    if (timeout !== undefined && (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > DEFAULT_STARTUP_TIMEOUT_MS)) {
      throw new CoreIpcError('INVALID_IPC_REQUEST', 'Core 启动等待期限无效')
    }
  }

  get status(): CoreSupervisorStatus {
    return this._status
  }

  get restarts(): number {
    return this.restartCount
  }

  async getPlaybackStreamSnapshot(): Promise<PlaybackStreamSnapshot | null> {
    const route = this.startupAttempt
    if (!route || !this.isCurrentRoute(route) || this._status !== 'ready') throw new CoreIpcError('NOT_READY', 'Core is not ready')
    if (!route.playbackEvents) return null
    const result = await this.request('playback.getStreamSnapshot', {})
    // 已resolve的旧回复也不能跨异步续体进入新route。
    if (!this.isCurrentRoute(route) || this._status !== 'ready') throw new CoreIpcError('NOT_READY', 'Core 播放流路由已撤销')
    this.assertStreamSnapshot(result, route)
    return result
  }

  private isCurrentRoute(route: StartupAttempt): boolean {
    return route.valid && route === this.startupAttempt && route.generation === this.startupGeneration && this.child === route.child && this.port === route.port && !this.shuttingDown
  }

  private assertStreamSnapshot(value: PlaybackStreamSnapshot | null, route: StartupAttempt): asserts value is PlaybackStreamSnapshot {
    if (!value || value.stamp.coreInstanceId !== route.playbackEvents?.coreInstanceId) throw new CoreIpcError('INVALID_IPC_RESPONSE', 'Core 播放流基准身份无效')
  }

  async start(): Promise<void> {
    if (this.startPromise) return this.startPromise
    if (this.restartPromise) {
      await this.restartPromise
      if (this._status !== 'ready' || this.shuttingDown) throw new CoreIpcError('INTERNAL_ERROR', 'Core 重启恢复未完成')
      return
    }
    if (this.shuttingDown) {
      throw new CoreIpcError('NOT_READY', 'Core supervisor is shutting down')
    }
    if (this._status === 'ready') return
    if (this.childExit) throw new CoreIpcError('NOT_READY', '旧 Core 未确认退出，禁止启动新进程')
    this.startPromise = this.startWithOneRetry()
    try {
      await this.startPromise
    } finally {
      this.startPromise = undefined
    }
  }

  async request<TCommand extends IpcCommand>(
    command: TCommand,
    payload: IpcCommandPayloads[TCommand],
    expectedDatasetId?: string,
    read?: { signal?: AbortSignal; deadlineAtMs?: number; cacheMode?: 'reload'; trace?: { rendererReadId: string } },
  ): Promise<IpcCommandResults[TCommand]> {
    const route = this.startupAttempt
    const result = await this.sendRequest(command, payload, false, expectedDatasetId, undefined, read)
    if (command.startsWith('playback.')) {
      if (!route || !this.isCurrentRoute(route) || this._status !== 'ready') throw new CoreIpcError('NOT_READY', 'Core 播放回执路由已撤销')
      if (route.playbackEvents && result && typeof result === 'object' && 'stream' in result) {
        const stream = result.stream as import('@music-bridge/contracts').PlaybackStreamStamp | undefined
        if (stream && stream.coreInstanceId !== route.playbackEvents.coreInstanceId) throw new CoreIpcError('INVALID_IPC_RESPONSE', 'Core 播放回执身份无效')
      }
    }
    return result as IpcCommandResults[TCommand]
  }

  async requestInternal<TCommand extends IpcInternalCommand>(
    command: TCommand,
    payload: IpcCommandPayloads[TCommand],
    expectedDatasetId?: string,
  ): Promise<IpcInternalCommandResults[TCommand]> {
    return (await this.sendRequest(command, payload, true, expectedDatasetId)) as IpcInternalCommandResults[TCommand]
  }

  private async sendRequest<TCommand extends IpcCommand>(
    command: TCommand,
    payload: IpcCommandPayloads[TCommand],
    internal: boolean,
    expectedDatasetId?: string,
    startup?: StartupAttempt,
    read?: { signal?: AbortSignal; deadlineAtMs?: number; cacheMode?: 'reload'; trace?: { rendererReadId: string } },
    accept?: (value: unknown) => void,
  ): Promise<unknown> {
    if (read && !isLibraryReadCommand(command)) throw new CoreIpcError('INVALID_IPC_REQUEST', '写命令不能使用读取取消协议')
    if (read?.deadlineAtMs !== undefined && (!Number.isSafeInteger(read.deadlineAtMs) || read.deadlineAtMs <= 0)) throw new CoreIpcError('INVALID_IPC_REQUEST', '读取期限无效')
    if (read?.cacheMode !== undefined && read.cacheMode !== 'reload') throw new CoreIpcError('INVALID_IPC_REQUEST', '读取刷新意图无效')
    if (read?.signal?.aborted) throw new CoreIpcError('CANCELLED', '读取已取消')
    const permitted = startup
      ? startup.valid && startup.readyReceived && startup.generation === this.startupGeneration && this.startupAttempt === startup && this.child === startup.child && this.port === startup.port && !this.shuttingDown
      : this._status === 'ready'
    if (!permitted || !this.port) {
      throw new CoreIpcError('NOT_READY', 'Core is not ready')
    }
    const id = randomUUID()
    const emitRead = (stage: string, fields: Record<string, unknown> = {}): void => {
      if (isLibraryReadCommand(command)) emitLibraryReadTrace(this.options.libraryReadTrace, { stage, command, coreReadId: id, ...(read?.trace ? { rendererReadId: read.trace.rendererReadId } : {}), ...fields })
    }
    const recorder = this.options.performance
    let parent: import('@music-bridge/contracts').PerformanceTraceContext | undefined
    if (recorder?.isEnabled()) {
      try { parent = this.options.performanceContext?.() } catch { /* 诊断回调不得阻止业务请求。 */ }
    }
    const traceContext = recorder?.context(parent ? { traceId: parent.traceId, requestId: id, parentRequestId: parent.requestId } : { requestId: id })
    const performanceSpan = recorder?.start('ipc', traceContext, {}, { command })
    const timedCommand = command === 'commandOutbox.execute' && 'command' in payload ? String(payload.command) : command
    const timeoutMs =
      ['recordingReplica.inspect', 'recordingOutput.check', 'recordingPlans.preview', 'recordingPlans.freeze', 'recordingPlans.preflight', 'recordingArchive.preview', 'recordingArchive.start', 'recordingArchive.verify', 'recordingArchive.initialize', 'recordingExecution.preview', 'recordingExecution.start', 'recordingExecution.verify', 'recordingPrepared.previewImport', 'recordingPrepared.startImport', 'recordingPrepared.review', 'recordingPrepared.freeze', 'recordingPreparationZip.preview', 'recordingPreparationZip.start'].includes(timedCommand)
      ? PREPARED_FILE_REQUEST_TIMEOUT_MS
      : command.startsWith('playback.') || command === 'roon.library.play' || command === 'roon.library.queue'
        ? PLAYBACK_REQUEST_TIMEOUT_MS
      : command.startsWith('library.') ||
      command.startsWith('roon.library.') ||
      command.startsWith('roon.transport.')
      ? LIBRARY_REQUEST_TIMEOUT_MS
      : this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    const deadlineAtMs = isLibraryReadCommand(command) ? Math.min(Date.now() + timeoutMs, read?.deadlineAtMs ?? Infinity) : undefined
    if (deadlineAtMs !== undefined && deadlineAtMs <= Date.now()) { performanceSpan?.end('cancelled'); throw new CoreIpcError('TIMEOUT', '读取期限已到') }
    const request = { version: IPC_VERSION, id, command, payload, ...(deadlineAtMs === undefined ? {} : { readContext: { deadlineAtMs, ...(read?.cacheMode !== undefined ? { cacheMode: read.cacheMode } : {}) } }), ...(expectedDatasetId === undefined ? {} : { expectedDatasetId }), ...(traceContext ? { performanceTrace: traceContext } : {}) }
    const validated = validateIpcRequest(request)
    if (!validated.ok) {
      performanceSpan?.end('error')
      throw new CoreIpcError(validated.error.code, validated.error.message)
    }
    const port = this.port
    const cancelCoreRead = (): void => { if (deadlineAtMs !== undefined) { try { port?.postMessage({ version: IPC_VERSION, kind: 'library.read.cancel', id }) } catch { /* 已退出的 Core 不再有存活读取。 */ } } }
    const response = await new Promise<unknown>((resolve, reject) => {
      const abort = (): void => {
        const pending = this.pending.get(id)
        if (!pending) return
        clearTimeout(pending.timer); this.removePending(id); cancelCoreRead()
        performanceSpan?.cancel(); performanceSpan?.end('cancelled')
        const failure = libraryReadTraceFailure(read?.signal?.reason)
        emitRead('main.cancel', { outcome: 'cancelled', reason: failure.reason ?? 'main-signal' })
        reject(Object.assign(new CoreIpcError('CANCELLED', '读取已取消'), { libraryReadSource: failure.reason ?? 'main-signal' }))
      }
      const timer = setTimeout(() => {
        this.removePending(id)
        cancelCoreRead()
        performanceSpan?.cancel()
        performanceSpan?.end('cancelled')
        emitRead('main.cancel', { outcome: 'timeout', reason: 'main-deadline' })
        reject(new CoreIpcError('TIMEOUT', 'Core request timed out'))
      }, deadlineAtMs === undefined ? timeoutMs : Math.max(1, deadlineAtMs - Date.now()))
      read?.signal?.addEventListener('abort', abort, { once: true })
      this.pending.set(id, { command, internal, timer, resolve, reject, ...(read?.trace ? { rendererReadId: read.trace.rendererReadId } : {}), ...(accept ? { accept } : {}), ...(deadlineAtMs === undefined ? {} : { readDeadlineAtMs: deadlineAtMs, cancelCoreRead }), ...(read?.signal ? { detachReadAbort: () => read.signal?.removeEventListener('abort', abort) } : {}), ...(performanceSpan ? { performanceSpan } : {}) })
      recorder?.setGauge('activeRequestCount', this.pending.size)
      try {
        if (read?.signal?.aborted) { abort(); return }
        emitRead('main.dispatch')
        port?.postMessage(request)
      } catch {
        clearTimeout(timer)
        this.removePending(id)
        performanceSpan?.end('error')
        reject(new CoreIpcError('INTERNAL_ERROR', 'Core request could not be sent'))
      }
    })
    return response
  }

  async shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise
    const work = this.shutdownInternal()
    this.shutdownPromise = work
    try { await work }
    catch (error) { if (this.shutdownPromise === work) this.shutdownPromise = undefined; throw error }
  }

  async restart(env?: NodeJS.ProcessEnv, options?: { readyTimeoutMs?: number }): Promise<void> {
    const timeout = options?.readyTimeoutMs
    if (timeout !== undefined && (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > RESTORE_ACTIVATION_TIMEOUT_MS)) {
      throw new CoreIpcError('INVALID_IPC_REQUEST', 'Core 重启等待期限无效')
    }
    if (this.manualRestartPromise) return this.manualRestartPromise
    const restart = (async (): Promise<void> => {
      await this.shutdown()
      if (env) this.options.env = { ...env }
      this.shutdownPromise = undefined
      this.shuttingDown = false
      this._status = 'stopped'
      this.readyTimeoutOverride = timeout
      try { await this.start() }
      finally { this.readyTimeoutOverride = undefined }
    })()
    this.manualRestartPromise = restart
    try {
      await restart
    } finally {
      if (this.manualRestartPromise === restart) this.manualRestartPromise = undefined
    }
  }

  /** 显式激活只复制并切换收藏工作库；账号恢复仍由既有 onReady 安全通道处理。 */
  async activateRestoredDataset(request: ActivateRestoredDataset, expectedDatasetId?: string): Promise<RestoreActivationView> {
    if (!isActivateRestoredDataset(request)) throw new CoreIpcError('INVALID_IPC_REQUEST', '激活必须明确确认停止播放和切换工作库')
    if (this.activationFlight) {
      const prior = this.activationFlight.request
      if (this.activationFlight.expectedDatasetId !== expectedDatasetId || prior.commandId !== request.commandId || prior.restoreJobId !== request.restoreJobId || prior.expectedActiveId !== request.expectedActiveId) {
        throw new CoreIpcError('INVENTORY_CONFLICT', '已有工作库切换正在处理')
      }
      return this.activationFlight.promise
    }
    const accepted = { ...request }
    const promise = this.activateRestoredDatasetInternal(accepted, expectedDatasetId)
    this.activationFlight = { request: accepted, expectedDatasetId, promise }
    try { return await promise }
    finally { if (this.activationFlight?.promise === promise) this.activationFlight = undefined }
  }

  private async activateRestoredDatasetInternal(request: ActivateRestoredDataset, expectedDatasetId?: string): Promise<RestoreActivationView> {
    const deadline = Date.now() + RESTORE_ACTIVATION_TIMEOUT_MS
    let result = await this.request('recordingBackups.activate', request, expectedDatasetId)
    const activationId = result.id
    if (result.restoreJobId !== request.restoreJobId) throw new CoreIpcError('INVENTORY_CONFLICT', '激活回执与请求的恢复任务不一致')
    const current = async (): Promise<RestoreActivationView> => {
      const view = (await this.request('recordingBackups.overview', {})).activations.find(item => item.id === activationId)
      if (!view || view.restoreJobId !== request.restoreJobId) throw new CoreIpcError('INVENTORY_CONFLICT', '激活回执与当前维护记录不一致')
      return view
    }
    while (result.state === 'preparing' || result.state === 'activating') {
      if (Date.now() >= deadline) throw new CoreIpcError('TIMEOUT', '激活准备超时；请刷新状态，不会自动重试')
      result = await current()
      if (result.state === 'preparing' || result.state === 'activating') await this.delay(250)
    }
    // 失回执重试直接返回持久终态；失败和回滚不再触发停止或重启。
    if (result.state !== 'prepared') return result
    await this.request('playback.stop', {})
    await this.restart(undefined, { readyTimeoutMs: RESTORE_ACTIVATION_TIMEOUT_MS })
    result = await current()
    if (result.state !== 'active' && result.state !== 'rolled-back') {
      throw new CoreIpcError('NOT_READY', 'Core 已重启，但尚未取得工作库切换终态')
    }
    return result
  }

  private async startWithOneRetry(): Promise<void> {
    this.restartCount = 0
    this._status = 'starting'
    while (true) {
      try {
        await this.spawnAndAwaitReady()
        this._status = 'ready'
        return
      } catch (error) {
        if (this.shuttingDown) throw error
        // 启动超时或恢复 hook 失败后，旧 Core 必须确实退出才能试第二次。
        // 仅 kill() 返回不代表旧进程停止写库。
        if (this.childExit && !await this.exitWithin(this.childExit.promise, 250)) {
          this._status = 'failed'
          this.options.onLifecycle?.({ event: 'failed' })
          throw new CoreIpcError('NOT_READY', '旧 Core 未确认退出，禁止启动新进程')
        }
        if (this.restartCount >= 1) {
          this._status = 'failed'
          this.options.onLifecycle?.({ event: 'failed' })
          throw error
        }
        this.restartCount += 1
        this._status = 'starting'
      }
    }
  }

  private spawnAndAwaitReady(): Promise<void> {
    const channel = this.options.dependencies.createChannel()
    const child = this.options.dependencies.fork(
      this.options.entryPath,
      [],
      {
        cwd: this.options.cwd,
        env: { ...(this.options.env ?? {}) },
        stdio: this.options.libraryReadTrace ? 'pipe' : 'ignore',
        serviceName: 'Music Bridge Core',
      },
    )
    if (this.options.libraryReadTrace) {
      const consume = createLibraryReadTraceStreamReader(this.options.libraryReadTrace)
      child.stdout?.on('data', chunk => { try { consume(chunk.toString()) } catch { /* 只允许封闭诊断行进入父终端。 */ } })
      const consumePlaybackFailure = createPlaybackFailureTraceStreamReader(line => { process.stderr.write(line) })
      child.stderr?.on('data', chunk => { try { consumePlaybackFailure(String(chunk)) } catch { /* 其他 SDK 输出和错误栈只消费、不转发。 */ } })
    }
    this.child = child
    this.port = channel.port2
    this._status = 'starting'
    this.options.onLifecycle?.({ event: 'spawn' })
    let confirmExit: () => void = () => undefined
    const exited = new Promise<void>(resolve => { confirmExit = resolve })
    this.childExit = { child, promise: exited }

    let settled = false
    let readyReceived = false
    let resolveReady: () => void = () => undefined
    let rejectReady: (error: CoreIpcError) => void = () => undefined
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve
      rejectReady = reject
    })
    const attempt: StartupAttempt = {
      generation: ++this.startupGeneration, child, port: channel.port2, valid: true, readyReceived: false, playbackEvents: null,
      cancelStart: error => {
        clearTimeout(readyTimer)
        attempt.valid = false
        if (!settled) { settled = true; rejectReady(error) }
      },
    }
    this.startupAttempt = attempt
    let completedReady = false
    const failStart = (error: CoreIpcError): void => {
      if (settled) return
      attempt.cancelStart(error)
      channel.port2.close()
      if (this.child === child) {
        this.port = undefined
        this.rejectPending(error)
      }
      try { child.kill() } catch { /* 启动已失败，不能让清理异常逸出计时器。 */ }
    }
    const readyTimer = setTimeout(() => {
      failStart(new CoreIpcError('TIMEOUT', 'Core 启动与恢复等待超时'))
    }, this.readyTimeoutOverride ?? this.options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS)
    const startupClient: CoreStartupClient = {
      get playbackEvents() { return attempt.playbackEvents },
      request: <C extends IpcCommand>(command: C, payload: IpcCommandPayloads[C], expectedDatasetId?: string) => this.sendRequest(command, payload, false, expectedDatasetId, attempt) as Promise<IpcCommandResults[C]>,
      requestInternal: <C extends IpcInternalCommand>(command: C, payload: IpcCommandPayloads[C], expectedDatasetId?: string) => this.sendRequest(command, payload, true, expectedDatasetId, attempt) as Promise<IpcInternalCommandResults[C]>,
    }
    const requestedProtocol = this.options.playbackEventProtocol === null || this.options.env?.MUSIC_BRIDGE_COMPACT_PLAYBACK_EVENTS === '0' ? undefined : 'compact-v1'
    const commitReady = (message: TypedIpcEvent, seed?: PlaybackStreamSnapshot): void => {
      if (settled || !this.isCurrentRoute(attempt)) throw new CoreIpcError('NOT_READY', 'Core 启动路由已撤销')
      this._status = 'ready'
      // 回调可同步shutdown/restart；每次广播前重核，不能续发旧seed。
      this.options.onLifecycle?.({ event: 'ready' })
      if (!this.isCurrentRoute(attempt)) throw new CoreIpcError('NOT_READY', 'Core 启动路由已撤销')
      this.options.onEvent?.(message)
      if (!this.isCurrentRoute(attempt)) throw new CoreIpcError('NOT_READY', 'Core 启动路由已撤销')
      if (seed) this.options.onEvent?.({ version: IPC_VERSION, event: 'playback.snapshot', payload: seed })
      if (!this.isCurrentRoute(attempt)) throw new CoreIpcError('NOT_READY', 'Core 启动路由已撤销')
      settled = true
      completedReady = true
      clearTimeout(readyTimer)
      resolveReady()
    }

    const handleExit = (code: number): void => {
      confirmExit()
      if (this.childExit?.child === child) this.childExit = undefined
      clearTimeout(readyTimer)
      attempt.valid = false
      if (this.child !== child) return
      this.options.onLifecycle?.({ event: 'exit', code })
      this.child = undefined
      this.port = undefined
      channel.port2.close()
      this.rejectPending(new CoreIpcError('INTERNAL_ERROR', 'Core process exited'))
      if (!settled) {
        settled = true
        rejectReady(
          new CoreIpcError('INTERNAL_ERROR', code === 0 ? 'Core stopped before ready' : 'Core crashed'),
        )
      }
      if (completedReady && !this.shuttingDown && !this.restartPromise) {
        this.restartPromise = this.restartAfterCrash()
        void this.restartPromise.finally(() => {
          this.restartPromise = undefined
        })
      }
    }

    child.once('exit', handleExit)
    channel.port2.on('message', (event) => {
      if (this.child !== child || this.port !== channel.port2) return
      const parsed = parseIpcRuntimeMessage(event.data)
      if (!parsed.ok) return
      const message = parsed.value
      if ('event' in message) {
        if (!attempt.valid) return
        if (message.event === 'core.ready') {
          if (!settled && !readyReceived) {
            const ack = message.payload.playbackEvents
            if (ack && !requestedProtocol) { failStart(new CoreIpcError('INVALID_IPC_RESPONSE', 'Core 未经请求启用播放流协议')); return }
            attempt.playbackEvents = ack ?? null
            readyReceived = true
            attempt.readyReceived = true
            void Promise.resolve().then(() => {
              if (!attempt.valid || settled || this.shuttingDown) return
              return this.options.onReady?.(startupClient)
            }).then(
              () => {
                if (settled || !attempt.valid || this.child !== child || this.shuttingDown) return
                if (!attempt.playbackEvents) { commitReady(message); return }
                // 专用响应处理器在reply调用栈提交；Promise续体只处理失败。
                void this.sendRequest('playback.getStreamSnapshot', {}, false, undefined, attempt, undefined, value => {
                  const seed = value as PlaybackStreamSnapshot | null
                  this.assertStreamSnapshot(seed, attempt)
                  commitReady(message, seed)
                }).catch(error => failStart(error instanceof CoreIpcError ? error : new CoreIpcError('INTERNAL_ERROR', 'Core 启动恢复未完成')))
              },
              () => failStart(new CoreIpcError('INTERNAL_ERROR', 'Core 启动恢复未完成')),
            ).catch(error => failStart(error instanceof CoreIpcError ? error : new CoreIpcError('INTERNAL_ERROR', 'Core 启动恢复未完成')))
          }
          return
        }
        // Core自己的ready不等于Main恢复完成；不把早到health转发成UI就绪。
        if (message.event === 'core.health' && !completedReady) return
        if (message.event === 'playback.snapshot' || message.event === 'playback.state' || message.event === 'playback.progress') {
          if (!completedReady || message.payload.stamp.coreInstanceId !== attempt.playbackEvents?.coreInstanceId) return
        }
        if (attempt.playbackEvents && (message.event === 'playback.changed' || message.event === 'queue.changed')) return
        this.options.onEvent?.(message)
        return
      }
      const pending = this.pending.get(message.id)
      if (!pending) return
      if (pending.readDeadlineAtMs !== undefined && Date.now() >= pending.readDeadlineAtMs) {
        clearTimeout(pending.timer)
        this.removePending(message.id)
        pending.cancelCoreRead?.()
        pending.performanceSpan?.cancel()
        pending.performanceSpan?.end('cancelled')
        pending.reject(new CoreIpcError('TIMEOUT', '读取期限已到'))
        return
      }
      const response = pending.internal
        ? validateIpcInternalResponseForCommand(
            message,
            pending.command as IpcInternalCommand,
          )
        : validateIpcResponseForCommand(message, pending.command)
      if (!response.ok) {
        clearTimeout(pending.timer)
        this.removePending(message.id)
        pending.performanceSpan?.end('error')
        pending.reject(new CoreIpcError(response.error.code, response.error.message))
        return
      }
      clearTimeout(pending.timer)
      this.removePending(message.id)
      pending.performanceSpan?.end(response.value.ok ? 'ok' : 'error')
      if (isLibraryReadCommand(pending.command)) emitLibraryReadTrace(this.options.libraryReadTrace, { stage: 'main.response', command: pending.command, coreReadId: message.id,
        ...(pending.rendererReadId ? { rendererReadId: pending.rendererReadId } : {}), ...(response.value.ok ? { outcome: 'ok' } : { ...libraryReadTraceFailure(response.value.error), reason: 'upstream-response' }) })
      if (response.value.ok) {
        try { pending.accept?.(response.value.result); pending.resolve(response.value.result) }
        catch (error) { pending.reject(error instanceof CoreIpcError ? error : new CoreIpcError('INTERNAL_ERROR', 'Core 启动恢复未完成')) }
      } else {
        pending.reject(new CoreIpcError(response.value.error.code, response.value.error.message))
      }
    })
    channel.port2.start()
    try {
      child.postMessage({ type: 'musicbridge.core.port', ...(requestedProtocol ? { playbackEventProtocol: requestedProtocol } : {}) }, [channel.port1])
    } catch {
      failStart(new CoreIpcError('INTERNAL_ERROR', 'Core process could not be started'))
    }
    return ready
  }

  private async restartAfterCrash(): Promise<void> {
    if (this.restartCount >= 1) {
      this._status = 'failed'
      this.options.onLifecycle?.({ event: 'failed' })
      return
    }
    this.restartCount += 1
    this._status = 'starting'
    this.options.onLifecycle?.({ event: 'restart' })
    try {
      await this.spawnAndAwaitReady()
      this._status = 'ready'
    } catch {
      this._status = 'failed'
      this.options.onLifecycle?.({ event: 'failed' })
    }
  }

  private removePending(id: string): void {
    this.pending.get(id)?.detachReadAbort?.()
    this.pending.delete(id)
    this.options.performance?.setGauge('activeRequestCount', this.pending.size)
  }

  private rejectPending(error: CoreIpcError): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer)
      pending.performanceSpan?.end('error')
      pending.reject(error)
      this.removePending(id)
    }
  }

  private async shutdownInternal(): Promise<void> {
    this.shuttingDown = true
    this.startupAttempt?.cancelStart(new CoreIpcError('NOT_READY', 'Core supervisor is shutting down'))
    const child = this.child
    const port = this.port
    if (!child) {
      this._status = 'stopped'
      port?.close()
      this.options.onLifecycle?.({ event: 'stopped' })
      return
    }

    const exited = this.childExit?.child === child ? this.childExit.promise : Promise.resolve()
    try {
      await this.request('core.shutdown', {})
    } catch {
      // The bounded kill below is the fallback when Core is already unhealthy.
    }
    await Promise.race([exited, this.delay(this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS)])
    if (this.child === child) {
      child.kill()
      if (!await this.exitWithin(exited, 250)) {
        port?.close()
        if (this.port === port) this.port = undefined
        this._status = 'failed'
        this.rejectPending(new CoreIpcError('NOT_READY', '旧 Core 未确认退出'))
        throw new CoreIpcError('NOT_READY', '旧 Core 未确认退出，禁止重启或切换工作库')
      }
    }
    port?.close()
    this._status = 'stopped'
    this.options.onLifecycle?.({ event: 'stopped' })
    this.rejectPending(new CoreIpcError('NOT_READY', 'Core supervisor is stopped'))
  }

  private delay(milliseconds: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, milliseconds))
  }

  private async exitWithin(exited: Promise<void>, milliseconds: number): Promise<boolean> {
    return new Promise(resolve => {
      const timer = setTimeout(() => resolve(false), milliseconds)
      void exited.then(() => { clearTimeout(timer); resolve(true) })
    })
  }
}
