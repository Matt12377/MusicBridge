import { randomUUID } from 'node:crypto'

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
}

export interface CoreSupervisorDependencies {
  createChannel(): { port1: CoreMessagePort; port2: CoreMessagePort }
  fork(
    entryPath: string,
    args: string[],
    options: {
      cwd: string
      env: NodeJS.ProcessEnv
      stdio: 'ignore'
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
}
interface StartupAttempt {
  generation: number
  child: CoreChildProcess
  port: CoreMessagePort
  valid: boolean
  readyReceived: boolean
  cancelStart(error: CoreIpcError): void
}

interface PendingRequest {
  command: IpcCommand
  internal: boolean
  timer: NodeJS.Timeout
  reject(error: CoreIpcError): void
  resolve(value: unknown): void
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
      dependencies: CoreSupervisorDependencies
      requestTimeoutMs?: number
      startupTimeoutMs?: number
      onEvent?: (event: TypedIpcEvent) => void
      onReady?: (client: CoreStartupClient) => Promise<void> | void
      onLifecycle?: (event: CoreSupervisorLifecycle) => void
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
  ): Promise<IpcCommandResults[TCommand]> {
    return (await this.sendRequest(command, payload, false, expectedDatasetId)) as IpcCommandResults[TCommand]
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
  ): Promise<unknown> {
    const permitted = startup
      ? startup.valid && startup.readyReceived && startup.generation === this.startupGeneration && this.startupAttempt === startup && this.child === startup.child && this.port === startup.port && !this.shuttingDown
      : this._status === 'ready'
    if (!permitted || !this.port) {
      throw new CoreIpcError('NOT_READY', 'Core is not ready')
    }
    const id = randomUUID()
    const request = { version: IPC_VERSION, id, command, payload, ...(expectedDatasetId === undefined ? {} : { expectedDatasetId }) }
    const validated = validateIpcRequest(request)
    if (!validated.ok) {
      throw new CoreIpcError(validated.error.code, validated.error.message)
    }
    const timedCommand = command === 'commandOutbox.execute' && 'command' in payload ? String(payload.command) : command
    const timeoutMs =
      ['recordingReplica.inspect', 'recordingOutput.check', 'recordingPlans.preview', 'recordingPlans.freeze', 'recordingPlans.preflight', 'recordingArchive.preview', 'recordingArchive.start', 'recordingArchive.verify', 'recordingArchive.initialize', 'recordingExecution.preview', 'recordingExecution.start', 'recordingExecution.verify', 'recordingPrepared.previewImport', 'recordingPrepared.startImport', 'recordingPrepared.review', 'recordingPrepared.freeze'].includes(timedCommand)
      ? PREPARED_FILE_REQUEST_TIMEOUT_MS
      : command.startsWith('library.') ||
      command.startsWith('roon.library.') ||
      command.startsWith('roon.transport.')
      ? LIBRARY_REQUEST_TIMEOUT_MS
      : command.startsWith('playback.')
        ? PLAYBACK_REQUEST_TIMEOUT_MS
        : this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    const response = await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new CoreIpcError('TIMEOUT', 'Core request timed out'))
      }, timeoutMs)
      this.pending.set(id, { command, internal, timer, resolve, reject })
      try {
        this.port?.postMessage(request)
      } catch {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(new CoreIpcError('INTERNAL_ERROR', 'Core request could not be sent'))
      }
    })
    return response
  }

  async shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise
    this.shutdownPromise = this.shutdownInternal()
    return this.shutdownPromise
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
        stdio: 'ignore',
        serviceName: 'Music Bridge Core',
      },
    )
    this.child = child
    this.port = channel.port2
    this._status = 'starting'
    this.options.onLifecycle?.({ event: 'spawn' })

    let settled = false
    let readyReceived = false
    let resolveReady: () => void = () => undefined
    let rejectReady: (error: CoreIpcError) => void = () => undefined
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve
      rejectReady = reject
    })
    const attempt: StartupAttempt = {
      generation: ++this.startupGeneration, child, port: channel.port2, valid: true, readyReceived: false,
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
        this.child = undefined
        this.port = undefined
        this.rejectPending(error)
      }
      try { child.kill() } catch { /* 启动已失败，不能让清理异常逸出计时器。 */ }
    }
    const readyTimer = setTimeout(() => {
      failStart(new CoreIpcError('TIMEOUT', 'Core 启动与恢复等待超时'))
    }, this.readyTimeoutOverride ?? this.options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS)
    const startupClient: CoreStartupClient = {
      request: <C extends IpcCommand>(command: C, payload: IpcCommandPayloads[C], expectedDatasetId?: string) => this.sendRequest(command, payload, false, expectedDatasetId, attempt) as Promise<IpcCommandResults[C]>,
      requestInternal: <C extends IpcInternalCommand>(command: C, payload: IpcCommandPayloads[C], expectedDatasetId?: string) => this.sendRequest(command, payload, true, expectedDatasetId, attempt) as Promise<IpcInternalCommandResults[C]>,
    }

    const handleExit = (code: number): void => {
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
            readyReceived = true
            attempt.readyReceived = true
            void Promise.resolve().then(() => {
              if (!attempt.valid || settled || this.shuttingDown) return
              return this.options.onReady?.(startupClient)
            }).then(
              () => {
                if (settled || !attempt.valid || this.child !== child || this.shuttingDown) return
                settled = true
                completedReady = true
                clearTimeout(readyTimer)
                this._status = 'ready'
                this.options.onLifecycle?.({ event: 'ready' })
                this.options.onEvent?.(message)
                resolveReady()
              },
              () => failStart(new CoreIpcError('INTERNAL_ERROR', 'Core 启动恢复未完成')),
            )
          }
          return
        }
        // Core自己的ready不等于Main恢复完成；不把早到health转发成UI就绪。
        if (message.event === 'core.health' && !completedReady) return
        this.options.onEvent?.(message)
        return
      }
      const pending = this.pending.get(message.id)
      if (!pending) return
      const response = pending.internal
        ? validateIpcInternalResponseForCommand(
            message,
            pending.command as IpcInternalCommand,
          )
        : validateIpcResponseForCommand(message, pending.command)
      if (!response.ok) {
        clearTimeout(pending.timer)
        this.pending.delete(message.id)
        pending.reject(new CoreIpcError(response.error.code, response.error.message))
        return
      }
      clearTimeout(pending.timer)
      this.pending.delete(message.id)
      if (response.value.ok) {
        pending.resolve(response.value.result)
      } else {
        pending.reject(new CoreIpcError(response.value.error.code, response.value.error.message))
      }
    })
    channel.port2.start()
    try {
      child.postMessage({ type: 'musicbridge.core.port' }, [channel.port1])
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

  private rejectPending(error: CoreIpcError): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer)
      pending.reject(error)
      this.pending.delete(id)
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

    const exited = new Promise<void>((resolve) => {
      child.once('exit', () => resolve())
    })
    try {
      await this.request('core.shutdown', {})
    } catch {
      // The bounded kill below is the fallback when Core is already unhealthy.
    }
    await Promise.race([exited, this.delay(this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS)])
    if (this.child === child) {
      child.kill()
      await Promise.race([exited, this.delay(250)])
    }
    port?.close()
    this._status = 'stopped'
    this.options.onLifecycle?.({ event: 'stopped' })
    this.rejectPending(new CoreIpcError('NOT_READY', 'Core supervisor is stopped'))
  }

  private delay(milliseconds: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, milliseconds))
  }
}
