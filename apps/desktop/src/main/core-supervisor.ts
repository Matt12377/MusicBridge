import { randomUUID } from 'node:crypto'

import {
  IPC_VERSION,
  parseIpcRuntimeMessage,
  validateIpcResponseForCommand,
  validateIpcRequest,
  type IpcCommand,
  type IpcCommandPayloads,
  type IpcCommandResults,
  type PublicErrorCode,
  type TypedIpcEvent,
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

export class CoreIpcError extends Error {
  constructor(
    readonly code: PublicErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'CoreIpcError'
  }
}

interface PendingRequest {
  command: IpcCommand
  timer: NodeJS.Timeout
  reject(error: CoreIpcError): void
  resolve(value: unknown): void
}

export class CoreSupervisor {
  private child: CoreChildProcess | undefined
  private port: CoreMessagePort | undefined
  private startPromise: Promise<void> | undefined
  private restartPromise: Promise<void> | undefined
  private shutdownPromise: Promise<void> | undefined
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
      onEvent?: (event: TypedIpcEvent) => void
    },
  ) {}

  get status(): CoreSupervisorStatus {
    return this._status
  }

  get restarts(): number {
    return this.restartCount
  }

  async start(): Promise<void> {
    if (this._status === 'ready') return
    if (this.startPromise) return this.startPromise
    if (this.shuttingDown) {
      throw new CoreIpcError('NOT_READY', 'Core supervisor is shutting down')
    }
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
  ): Promise<IpcCommandResults[TCommand]> {
    if (this._status !== 'ready' || !this.port) {
      throw new CoreIpcError('NOT_READY', 'Core is not ready')
    }
    const id = randomUUID()
    const request = { version: IPC_VERSION, id, command, payload }
    const validated = validateIpcRequest(request)
    if (!validated.ok) {
      throw new CoreIpcError(validated.error.code, validated.error.message)
    }
    const timeoutMs = this.options.requestTimeoutMs ?? 2_000
    const response = await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new CoreIpcError('TIMEOUT', 'Core request timed out'))
      }, timeoutMs)
      this.pending.set(id, { command, timer, resolve, reject })
      try {
        this.port?.postMessage(request)
      } catch {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(new CoreIpcError('INTERNAL_ERROR', 'Core request could not be sent'))
      }
    })
    return response as IpcCommandResults[TCommand]
  }

  async shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise
    this.shutdownPromise = this.shutdownInternal()
    return this.shutdownPromise
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
        if (this.restartCount >= 1) {
          this._status = 'failed'
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
        env: { ...process.env, ...this.options.env },
        stdio: 'ignore',
        serviceName: 'Music Bridge Core',
      },
    )
    this.child = child
    this.port = channel.port2
    this._status = 'starting'

    let settled = false
    let readyReceived = false
    let resolveReady: () => void = () => undefined
    let rejectReady: (error: CoreIpcError) => void = () => undefined
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve
      rejectReady = reject
    })
    const readyTimer = setTimeout(() => {
      if (settled) return
      settled = true
      rejectReady(new CoreIpcError('TIMEOUT', 'Core ready timed out'))
      channel.port2.close()
      if (this.child === child) {
        this.child = undefined
        this.port = undefined
      }
      child.kill()
    }, this.options.requestTimeoutMs ?? 2_000)

    const handleExit = (code: number): void => {
      clearTimeout(readyTimer)
      if (this.child !== child) return
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
      if (readyReceived && !this.shuttingDown && !this.restartPromise) {
        this.restartPromise = this.restartAfterCrash()
        void this.restartPromise.finally(() => {
          this.restartPromise = undefined
        })
      }
    }

    child.once('exit', handleExit)
    channel.port2.on('message', (event) => {
      const parsed = parseIpcRuntimeMessage(event.data)
      if (!parsed.ok) return
      const message = parsed.value
      if ('event' in message) {
        if (message.event === 'core.ready' && !settled) {
          readyReceived = true
          settled = true
          clearTimeout(readyTimer)
          this._status = 'ready'
          resolveReady()
        }
        this.options.onEvent?.(message)
        return
      }
      const pending = this.pending.get(message.id)
      if (!pending) return
      const response = validateIpcResponseForCommand(message, pending.command)
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
      clearTimeout(readyTimer)
      channel.port2.close()
      if (this.child === child) {
        this.child = undefined
        this.port = undefined
      }
      child.kill()
      throw new CoreIpcError('INTERNAL_ERROR', 'Core process could not be started')
    }
    return ready
  }

  private async restartAfterCrash(): Promise<void> {
    if (this.restartCount >= 1) {
      this._status = 'failed'
      return
    }
    this.restartCount += 1
    this._status = 'starting'
    try {
      await this.spawnAndAwaitReady()
      this._status = 'ready'
    } catch {
      this._status = 'failed'
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
    const child = this.child
    const port = this.port
    if (!child) {
      this._status = 'stopped'
      port?.close()
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
    await Promise.race([exited, this.delay(this.options.requestTimeoutMs ?? 2_000)])
    if (this.child === child) {
      child.kill()
      await Promise.race([exited, this.delay(250)])
    }
    port?.close()
    this._status = 'stopped'
    this.rejectPending(new CoreIpcError('NOT_READY', 'Core supervisor is stopped'))
  }

  private delay(milliseconds: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, milliseconds))
  }
}
