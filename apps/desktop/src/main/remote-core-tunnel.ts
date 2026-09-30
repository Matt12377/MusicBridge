import { spawn as nodeSpawn } from 'node:child_process'

import type {
  RemoteCoreTunnelErrorCode,
  RemoteCoreTunnelFailure,
  RemoteCoreTunnelFailurePhase,
  RemoteCoreTunnelState,
} from '@music-bridge/contracts'
import {
  REMOTE_CORE_LOCAL_PORT_PAIRS,
  REMOTE_CORE_STREAM_PORT_CANDIDATES,
} from '@music-bridge/contracts'

export const LOCAL_STREAM_PORT = REMOTE_CORE_LOCAL_PORT_PAIRS.default.streamPort
export const LOCAL_STREAM_PORT_CANDIDATES: readonly number[] = Object.freeze(
  Object.values(REMOTE_CORE_LOCAL_PORT_PAIRS).map((ports) => ports.streamPort),
)
export const LOCAL_ROON_CORE_PORT = 19330 as const
export const REMOTE_ROON_CORE_PORT = 9330 as const
export const REMOTE_STREAM_PORT_CANDIDATES = REMOTE_CORE_STREAM_PORT_CANDIDATES
export const DEFAULT_REMOTE_STREAM_PORT = REMOTE_STREAM_PORT_CANDIDATES[0]!
export const REMOTE_HEALTH_PATH = '/__musicbridge_remote_dev_health'

type SshExitListener = (code: number | null, signal: NodeJS.Signals | null) => void
type SshErrorListener = (error: Error) => void

export interface RemoteSshOutput {
  on(event: 'data', listener: (chunk: Buffer | string) => void): unknown
  removeListener?(event: 'data', listener: (chunk: Buffer | string) => void): unknown
}

export interface RemoteSshProcess {
  stdout?: RemoteSshOutput | null
  stderr?: RemoteSshOutput | null
  on(event: 'exit', listener: SshExitListener): this
  on(event: 'error', listener: SshErrorListener): this
  once(event: 'exit', listener: SshExitListener): this
  once(event: 'close', listener: SshExitListener): this
  once(event: 'error', listener: SshErrorListener): this
  removeListener(event: 'exit', listener: SshExitListener): this
  removeListener(event: 'close', listener: SshExitListener): this
  removeListener(event: 'error', listener: SshErrorListener): this
  kill(signal?: NodeJS.Signals): boolean
}

export interface RemoteCoreTunnelSpawnOptions {
  shell: false
  stdio: ['ignore', 'pipe', 'pipe']
}

export type RemoteCoreTunnelSpawn = (
  command: '/usr/bin/ssh',
  args: readonly string[],
  options: RemoteCoreTunnelSpawnOptions,
) => RemoteSshProcess

export interface RemoteCoreTunnelConfig {
  sshTarget: string
  remoteStreamPort: number
  localStreamPort: number
  autoReconnect: boolean
}

export interface RemoteCoreTunnelHealthProbeInput {
  sshTarget: string
  remoteStreamPort: number
  signal?: AbortSignal
}

export interface RemoteCoreTunnelManagerOptions {
  spawn?: RemoteCoreTunnelSpawn
  healthProbe?: (input: RemoteCoreTunnelHealthProbeInput) => Promise<boolean>
  onTunnelBound?: (state: RemoteCoreTunnelState) => Promise<void> | void
  onDisconnected?: (state: RemoteCoreTunnelState) => Promise<void> | void
  onStateChanged?: (state: RemoteCoreTunnelState) => void
  boundGraceMs?: number
  healthTimeoutMs?: number
  stopGraceMs?: number
}

const DEFAULT_BOUND_GRACE_MS = 150
const DEFAULT_HEALTH_TIMEOUT_MS = 5_000
const REMOTE_TARGET_PATTERN = /^(?:[A-Za-z0-9][A-Za-z0-9._-]*@)?[A-Za-z0-9][A-Za-z0-9._-]*$/

function isValidPort(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= 65_535
}

function assertSafePort(value: number, code: RemoteCoreTunnelErrorCode): void {
  if (!isValidPort(value)) throw new Error(code)
}

export function isSafeSshTarget(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 255 &&
    !/[\u0000-\u001f\u007f\s]/.test(value) &&
    REMOTE_TARGET_PATTERN.test(value)
  )
}

function assertSafeSshTarget(value: string): void {
  if (!isSafeSshTarget(value)) throw new Error('INVALID_SSH_TARGET')
}

function assertRemotePort(value: number): void {
  if (!REMOTE_STREAM_PORT_CANDIDATES.includes(value)) {
    throw new Error('INVALID_REMOTE_STREAM_PORT')
  }
}

export function buildTunnelSshArgs(
  sshTarget: string,
  remoteStreamPort: number,
  localStreamPort: number,
): readonly string[] {
  assertSafeSshTarget(sshTarget)
  assertRemotePort(remoteStreamPort)
  assertSafePort(localStreamPort, 'INVALID_LOCAL_STREAM_PORT')
  if (!LOCAL_STREAM_PORT_CANDIDATES.includes(localStreamPort)) throw new Error('INVALID_LOCAL_STREAM_PORT')
  return [
    '-N',
    '-T',
    '-o',
    'BatchMode=yes',
    '-o',
    'ExitOnForwardFailure=yes',
    '-o',
    'StrictHostKeyChecking=yes',
    '-o',
    'ControlMaster=no',
    '-o',
    'ControlPath=none',
    '-o',
    'ServerAliveInterval=15',
    '-o',
    'ServerAliveCountMax=3',
    '-L',
    `127.0.0.1:${LOCAL_ROON_CORE_PORT}:127.0.0.1:${REMOTE_ROON_CORE_PORT}`,
    '-R',
    `127.0.0.1:${remoteStreamPort}:127.0.0.1:${localStreamPort}`,
    sshTarget,
  ]
}

export function buildHealthCheckSshArgs(
  sshTarget: string,
  remoteStreamPort: number,
): readonly string[] {
  assertSafeSshTarget(sshTarget)
  assertRemotePort(remoteStreamPort)
  return [
    '-T',
    '-o',
    'BatchMode=yes',
    '-o',
    'StrictHostKeyChecking=yes',
    '-o',
    'ControlMaster=no',
    '-o',
    'ControlPath=none',
    '-o',
    'ConnectTimeout=5',
    sshTarget,
    '/usr/bin/curl',
    '--fail',
    '--silent',
    '--show-error',
    '--max-time',
    '5',
    `http://127.0.0.1:${remoteStreamPort}${REMOTE_HEALTH_PATH}`,
  ]
}

function defaultSpawn(
  command: '/usr/bin/ssh',
  args: readonly string[],
  options: RemoteCoreTunnelSpawnOptions,
): RemoteSshProcess {
  return nodeSpawn(command, [...args], {
    shell: options.shell,
    stdio: options.stdio,
  }) as unknown as RemoteSshProcess
}

function classifySshFailure(stderr: string): RemoteCoreTunnelErrorCode {
  const normalized = stderr.toLowerCase()
  if (
    /permission denied|publickey|authentication failed|no supported authentication/.test(
      normalized,
    )
  ) {
    return 'SSH_AUTH_REQUIRED'
  }
  if (
    /could not resolve hostname|nodename nor servname|connection timed out|connection refused|no route to host|network is unreachable|operation timed out/.test(
      normalized,
    )
  ) {
    return 'SSH_CONNECTION_FAILED'
  }
  if (/remote forward failure|address already in use|cannot listen|listen port/.test(normalized)) {
    return 'REMOTE_PORTS_UNAVAILABLE'
  }
  if (/enoent|spawn .*ssh|not found/.test(normalized)) return 'SSH_BINARY_UNAVAILABLE'
  return 'REMOTE_PORTS_UNAVAILABLE'
}

function failurePhase(errorCode: RemoteCoreTunnelErrorCode): RemoteCoreTunnelFailurePhase {
  switch (errorCode) {
    case 'INVALID_SSH_TARGET':
    case 'INVALID_REMOTE_STREAM_PORT':
    case 'INVALID_LOCAL_STREAM_PORT':
      return 'configuration'
    case 'SSH_AUTH_REQUIRED':
    case 'SSH_CONNECTION_FAILED':
    case 'SSH_BINARY_UNAVAILABLE':
      return 'ssh'
    case 'REMOTE_PORTS_UNAVAILABLE':
      return 'port-forward'
    case 'CORE_RESTART_FAILED':
      return 'core-restart'
    case 'REMOTE_HEALTH_UNAVAILABLE':
      return 'health-check'
    case 'TUNNEL_DISCONNECTED':
      return 'lifecycle'
  }
}

function failureMessage(errorCode: RemoteCoreTunnelErrorCode): string {
  switch (errorCode) {
    case 'INVALID_SSH_TARGET':
      return 'SSH 目标格式无效，请使用已配置的别名或 user@host。'
    case 'INVALID_REMOTE_STREAM_PORT':
      return '远程开发端口不在允许范围内。'
    case 'INVALID_LOCAL_STREAM_PORT':
      return '本地 Gateway 端口不符合远程开发约束。'
    case 'SSH_AUTH_REQUIRED':
      return 'SSH 认证失败，请确认 SSH key、known_hosts 和 BatchMode 配置。'
    case 'SSH_CONNECTION_FAILED':
      return 'SSH 无法连接到远端目标，请检查主机名、网络和 SSH 配置。'
    case 'SSH_BINARY_UNAVAILABLE':
      return '本机找不到受控的 SSH 程序。'
    case 'REMOTE_PORTS_UNAVAILABLE':
      return '远程端口转发失败，已检查允许的开发端口范围。'
    case 'CORE_RESTART_FAILED':
      return '本地 Core 切换到远程开发模式失败，应用已保留安全回退路径。'
    case 'REMOTE_HEALTH_UNAVAILABLE':
      return '远程 Core 健康检查失败，请确认远端 TASK-035 Core 正在运行。'
    case 'TUNNEL_DISCONNECTED':
      return 'SSH 隧道已断开，播放已停止并等待受控重连。'
  }
}

function buildFailure(errorCode: RemoteCoreTunnelErrorCode): RemoteCoreTunnelFailure {
  return {
    phase: failurePhase(errorCode),
    code: errorCode,
    message: failureMessage(errorCode),
  }
}

function copyState(state: RemoteCoreTunnelState): RemoteCoreTunnelState {
  return { ...state }
}

function baseRemoteState(
  config: RemoteCoreTunnelConfig,
  status: RemoteCoreTunnelState['status'],
  errorCode?: RemoteCoreTunnelErrorCode,
  remoteStreamPort?: number,
): RemoteCoreTunnelState {
  return {
    mode: 'remote-core-development',
    status,
    sshTarget: config.sshTarget,
    localStreamPort: config.localStreamPort,
    ...(remoteStreamPort !== undefined ? { remoteStreamPort } : {}),
    remoteHealth: 'unavailable',
    autoReconnect: config.autoReconnect,
    ...(errorCode ? { errorCode } : {}),
    ...(errorCode ? { failure: buildFailure(errorCode) } : {}),
  }
}

interface BoundResult {
  bound: boolean
  errorCode?: RemoteCoreTunnelErrorCode
}

interface OwnedSshProcess {
  child: RemoteSshProcess
  exited: boolean
  intentional: boolean
  exit: Promise<void>
  stopping?: Promise<boolean>
}

export class RemoteCoreTunnelManager {
  private readonly spawn: RemoteCoreTunnelSpawn
  private readonly healthProbe: (
    input: RemoteCoreTunnelHealthProbeInput,
  ) => Promise<boolean>
  private readonly boundGraceMs: number
  private readonly healthTimeoutMs: number
  private readonly stopGraceMs: number
  private readonly options: RemoteCoreTunnelManagerOptions
  private state: RemoteCoreTunnelState = {
    mode: 'local-core',
    status: 'idle',
    localStreamPort: LOCAL_STREAM_PORT,
    remoteHealth: 'unavailable',
    autoReconnect: false,
  }
  private child: RemoteSshProcess | undefined
  private lastConfig: RemoteCoreTunnelConfig | undefined
  private autoReconnectUsed = false
  private stopping = false
  private operationTail: Promise<void> = Promise.resolve()
  private readonly owned = new Map<RemoteSshProcess, OwnedSshProcess>()
  private probeController: AbortController | undefined
  private intentGeneration = 0

  constructor(options: RemoteCoreTunnelManagerOptions = {}) {
    this.options = options
    this.spawn = options.spawn ?? defaultSpawn
    this.boundGraceMs = options.boundGraceMs ?? DEFAULT_BOUND_GRACE_MS
    this.healthTimeoutMs = options.healthTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS
    this.stopGraceMs = options.stopGraceMs ?? 500
    if (!Number.isSafeInteger(this.stopGraceMs) || this.stopGraceMs < 1 || this.stopGraceMs > 1_000
      || !Number.isSafeInteger(this.healthTimeoutMs) || this.healthTimeoutMs < 1 || this.healthTimeoutMs > 5_000)
      throw new Error('SSH生命周期截止期限无效')
    this.healthProbe = options.healthProbe ?? ((input) => this.probeHealth(input))
  }

  getState(): RemoteCoreTunnelState {
    return copyState(this.state)
  }

  start(config: RemoteCoreTunnelConfig): Promise<RemoteCoreTunnelState> {
    const generation = ++this.intentGeneration
    this.probeController?.abort()
    return this.enqueue(async () => {
      if (generation !== this.intentGeneration) return this.getState()
      this.stopping = false
      this.autoReconnectUsed = false
      return this.startInternal(config, false, generation)
    })
  }

  stop(): Promise<RemoteCoreTunnelState> {
    ++this.intentGeneration
    this.stopping = true
    this.probeController?.abort()
    return this.enqueue(async () => {
      this.stopping = true
      this.setState({
        ...this.state,
        status: this.child ? 'stopping' : 'idle',
      })
      if (!await this.stopAllOwned()) {
        this.setState({ ...this.state, status: 'failed', remoteHealth: 'unavailable', errorCode: 'TUNNEL_DISCONNECTED', failure: buildFailure('TUNNEL_DISCONNECTED') })
        return this.getState()
      }
      this.lastConfig = undefined
      this.autoReconnectUsed = false
      this.setState({
        mode: 'local-core',
        status: 'idle',
        localStreamPort: LOCAL_STREAM_PORT,
        remoteHealth: 'unavailable',
        autoReconnect: false,
      })
      this.stopping = false
      return this.getState()
    })
  }

  reconnect(): Promise<RemoteCoreTunnelState> {
    const generation = ++this.intentGeneration
    this.probeController?.abort()
    return this.enqueue(async () => {
      if (generation !== this.intentGeneration) return this.getState()
      this.stopping = false
      const config = this.lastConfig
      if (!config) {
        return this.failState(
          {
            sshTarget: '',
            remoteStreamPort: DEFAULT_REMOTE_STREAM_PORT,
            localStreamPort: LOCAL_STREAM_PORT,
            autoReconnect: false,
          },
          'INVALID_SSH_TARGET',
        )
      }
      this.autoReconnectUsed = false
      return this.startInternal(config, true, generation)
    })
  }

  private async startInternal(
    config: RemoteCoreTunnelConfig,
    reconnecting: boolean,
    generation = this.intentGeneration,
  ): Promise<RemoteCoreTunnelState> {
    this.lastConfig = { ...config }
    const validationError = this.validateConfig(config)
    if (validationError) return this.failState(config, validationError)
    if (!await this.stopAllOwned()) return this.failState(config, 'TUNNEL_DISCONNECTED')
    if (generation !== this.intentGeneration || this.stopping) return this.getState()

    this.setState(baseRemoteState(config, reconnecting ? 'reconnecting' : 'checking'))
    const candidates = this.remotePortCandidates(config.remoteStreamPort)

    for (const remoteStreamPort of candidates) {
      let child: RemoteSshProcess
      try {
        child = this.spawn(
          '/usr/bin/ssh',
          buildTunnelSshArgs(config.sshTarget, remoteStreamPort, config.localStreamPort),
          { shell: false, stdio: ['ignore', 'pipe', 'pipe'] },
        )
        this.own(child)
        this.child = child
      } catch {
        return this.failState(config, 'SSH_BINARY_UNAVAILABLE')
      }

      const bound = await this.waitForBound(child)
      if (generation !== this.intentGeneration || this.stopping) { await this.stopOwned(child); return this.getState() }
      if (!bound.bound) {
        if (!await this.stopOwned(child)) return this.failState(config, 'TUNNEL_DISCONNECTED', remoteStreamPort)
        if (
          bound.errorCode === 'SSH_AUTH_REQUIRED' ||
          bound.errorCode === 'SSH_CONNECTION_FAILED' ||
          bound.errorCode === 'SSH_BINARY_UNAVAILABLE'
        ) {
          return this.failState(config, bound.errorCode)
        }
        continue
      }

      this.child = child
      const boundState = baseRemoteState(config, 'starting', undefined, remoteStreamPort)
      this.setState(boundState)
      this.attachUnexpectedExit(child)

      try {
        try {
          await this.options.onTunnelBound?.(this.getState())
        } catch {
          if (!await this.stopOwned(child)) return this.failState(config, 'TUNNEL_DISCONNECTED', remoteStreamPort)
          return this.failState(config, 'CORE_RESTART_FAILED', remoteStreamPort)
        }

        if (generation !== this.intentGeneration || this.stopping) { await this.stopOwned(child); return this.getState() }

        const healthy = await this.healthProbeWithTimeout({
          sshTarget: config.sshTarget,
          remoteStreamPort,
        })
        if (!healthy || this.child !== child || generation !== this.intentGeneration || this.stopping) {
          if (!await this.stopAllOwned()) return this.failState(config, 'TUNNEL_DISCONNECTED', remoteStreamPort)
          return this.failState(config, 'REMOTE_HEALTH_UNAVAILABLE', remoteStreamPort)
        }
        this.setState({
          ...boundState,
          status: 'ready',
          remoteHealth: 'available',
        })
        return this.getState()
      } catch {
        if (!await this.stopAllOwned()) return this.failState(config, 'TUNNEL_DISCONNECTED', remoteStreamPort)
        return this.failState(config, 'REMOTE_HEALTH_UNAVAILABLE', remoteStreamPort)
      }
    }

    return this.failState(config, 'REMOTE_PORTS_UNAVAILABLE')
  }

  private validateConfig(config: RemoteCoreTunnelConfig): RemoteCoreTunnelErrorCode | undefined {
    if (!isSafeSshTarget(config.sshTarget)) return 'INVALID_SSH_TARGET'
    if (!REMOTE_STREAM_PORT_CANDIDATES.includes(config.remoteStreamPort)) {
      return 'INVALID_REMOTE_STREAM_PORT'
    }
    if (!LOCAL_STREAM_PORT_CANDIDATES.includes(config.localStreamPort)) return 'INVALID_LOCAL_STREAM_PORT'
    return undefined
  }

  private remotePortCandidates(start: number): readonly number[] {
    const index = REMOTE_STREAM_PORT_CANDIDATES.indexOf(start)
    if (index <= 0) return REMOTE_STREAM_PORT_CANDIDATES
    return [
      ...REMOTE_STREAM_PORT_CANDIDATES.slice(index),
      ...REMOTE_STREAM_PORT_CANDIDATES.slice(0, index),
    ]
  }

  private failState(
    config: RemoteCoreTunnelConfig,
    errorCode: RemoteCoreTunnelErrorCode,
    remoteStreamPort?: number,
  ): RemoteCoreTunnelState {
    const state = baseRemoteState(config, 'failed', errorCode, remoteStreamPort)
    this.setState(state)
    return this.getState()
  }

  private async waitForBound(child: RemoteSshProcess): Promise<BoundResult> {
    let stderr = ''
    const onData = (chunk: Buffer | string) => {
      if (stderr.length < 4_096) stderr += chunk.toString().slice(0, 4_096 - stderr.length)
    }
    child.stderr?.on('data', onData)

    return new Promise<BoundResult>((resolve) => {
      let settled = false
      let timer: ReturnType<typeof setTimeout> | undefined
      const finish = (result: BoundResult): void => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        child.removeListener('exit', onExit)
        child.removeListener('error', onError)
        child.stderr?.removeListener?.('data', onData)
        resolve(result)
      }
      const onExit: SshExitListener = (code) => {
        finish({
          bound: false,
          errorCode: code === 255 ? classifySshFailure(stderr) : 'REMOTE_PORTS_UNAVAILABLE',
        })
      }
      const onError: SshErrorListener = () => finish({ bound: false, errorCode: 'SSH_BINARY_UNAVAILABLE' })
      child.once('exit', onExit)
      child.once('error', onError)
      if (this.boundGraceMs <= 0) {
        queueMicrotask(() => finish({ bound: true }))
      } else {
        timer = setTimeout(() => finish({ bound: true }), this.boundGraceMs)
      }
    })
  }

  private attachUnexpectedExit(child: RemoteSshProcess): void {
    const owner = this.owned.get(child)
    child.once('exit', (code) => {
      if (this.child !== child || this.stopping || owner?.intentional) return
      const generation = this.intentGeneration
      this.child = undefined
      const state = baseRemoteState(
        this.lastConfig ?? {
          sshTarget: '',
          remoteStreamPort: DEFAULT_REMOTE_STREAM_PORT,
          localStreamPort: LOCAL_STREAM_PORT,
          autoReconnect: false,
        },
        'disconnected',
        'TUNNEL_DISCONNECTED',
        this.state.remoteStreamPort,
      )
      this.setState(state)
      void this.handleDisconnect(state, code, generation)
    })
  }

  private async handleDisconnect(state: RemoteCoreTunnelState, _code: number | null, generation: number): Promise<void> {
    try {
      await this.options.onDisconnected?.(copyState(state))
    } catch {
      // 播放清理回调失败不能阻断隧道收尾。
    }
    const config = this.lastConfig
    if (generation !== this.intentGeneration || !config || !config.autoReconnect || this.autoReconnectUsed || this.stopping) return
    this.autoReconnectUsed = true
    await this.enqueue(async () => generation === this.intentGeneration && !this.stopping
      ? this.startInternal(config, true, generation)
      : this.getState())
  }

  private async healthProbeWithTimeout(
    input: RemoteCoreTunnelHealthProbeInput,
  ): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const controller = new AbortController()
    this.probeController = controller
    const onAbort = () => resolveAbort(false)
    let resolveAbort!: (value: boolean) => void
    try {
      // 先订阅取消，再进入注入的探测回调；回调可能同步触发stop。
      const cancelled = new Promise<boolean>((resolve) => {
        resolveAbort = resolve
        controller.signal.addEventListener('abort', onAbort, { once: true })
        timer = setTimeout(() => controller.abort(), this.healthTimeoutMs)
      })
      return await Promise.race([
        cancelled,
        this.healthProbe({ ...input, signal: controller.signal }),
      ])
    } catch {
      return false
    } finally {
      if (timer) clearTimeout(timer)
      controller.signal.removeEventListener('abort', onAbort)
      controller.abort()
      if (this.probeController === controller) this.probeController = undefined
    }
  }

  private async probeHealth(input: RemoteCoreTunnelHealthProbeInput): Promise<boolean> {
    if (input.signal?.aborted) return false
    let child: RemoteSshProcess
    try {
      child = this.spawn(
        '/usr/bin/ssh',
        buildHealthCheckSshArgs(input.sshTarget, input.remoteStreamPort),
        { shell: false, stdio: ['ignore', 'pipe', 'pipe'] },
      )
      this.own(child)
    } catch {
      return false
    }

    return new Promise<boolean>((resolve) => {
      let output = ''
      let settled = false
      let overflow = false
      const finish = (value: boolean): void => {
        if (settled) return
        settled = true
        child.removeListener('exit', onExit)
        child.removeListener('error', onError)
        child.stdout?.removeListener?.('data', onData)
        input.signal?.removeEventListener('abort', onAbort)
        resolve(value)
      }
      const onExit: SshExitListener = (code) => {
        if (code !== 0 || overflow || input.signal?.aborted) return finish(false)
        try {
          const body = JSON.parse(output.trim()) as { ok?: unknown; mode?: unknown }
          finish(body.ok === true && body.mode === 'remote-core-development')
        } catch {
          finish(false)
        }
      }
      const onError: SshErrorListener = () => { void this.stopOwned(child).then(() => finish(false)) }
      const onAbort = () => { void this.stopOwned(child).then(() => finish(false)) }
      const onData = (chunk: Buffer | string) => {
        const value = chunk.toString()
        if (Buffer.byteLength(output) + Buffer.byteLength(value) > 4_096) { overflow = true; onAbort(); return }
        output += value
      }
      child.stdout?.on('data', onData)
      child.once('exit', onExit)
      child.once('error', onError)
      input.signal?.addEventListener('abort', onAbort, { once: true })
      if (input.signal?.aborted) onAbort()
    })
  }

  private own(child: RemoteSshProcess): OwnedSshProcess {
    const prior = this.owned.get(child)
    if (prior) return prior
    let resolveExit!: () => void
    const owner: OwnedSshProcess = { child, exited: false, intentional: false, exit: new Promise(resolve => { resolveExit = resolve }) }
    const onError: SshErrorListener = () => { /* error不等于进程已退出，仍由退出事件或受控停止核对。 */ }
    const finish = () => {
      if (owner.exited) return
      owner.exited = true
      this.owned.delete(child)
      child.removeListener('error', onError)
      child.removeListener('exit', finish)
      child.removeListener('close', finish)
      resolveExit()
    }
    child.on('error', onError)
    child.once('exit', finish)
    // Node的spawn失败可能只发error、close；close也确认该子进程生命周期结束。
    child.once('close', finish)
    this.owned.set(child, owner)
    return owner
  }

  private async stopOwned(child: RemoteSshProcess): Promise<boolean> {
    const owner = this.owned.get(child)
    if (!owner) { if (this.child === child) this.child = undefined; return true }
    if (owner.stopping) return owner.stopping
    owner.intentional = true
    const waitExit = async () => {
      let timer!: ReturnType<typeof setTimeout>
      try { await Promise.race([owner.exit, new Promise<void>(resolve => { timer = setTimeout(resolve, this.stopGraceMs) })]) }
      finally { clearTimeout(timer) }
    }
    // 先公开共享停止Promise，再发送信号，防同步error/exit回调重入重复kill。
    owner.stopping = Promise.resolve().then(async () => {
      for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
        if (owner.exited) break
        try { child.kill(signal) } catch { /* 发送失败仍不代表退出；保留所有权。 */ }
        if (!owner.exited) await waitExit()
      }
      if (owner.exited && this.child === child) this.child = undefined
      return owner.exited
    }).finally(() => { owner.stopping = undefined })
    return owner.stopping
  }

  private async stopAllOwned(): Promise<boolean> {
    const results = await Promise.all([...this.owned.keys()].map(child => this.stopOwned(child)))
    if (this.child && !this.owned.has(this.child)) this.child = undefined
    return results.every(Boolean) && this.owned.size === 0
  }

  private setState(state: RemoteCoreTunnelState): void {
    this.state = copyState(state)
    try {
      this.options.onStateChanged?.(this.getState())
    } catch {
      // UI状态观察者不能阻断隧道生命周期与收尾。
    }
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.operationTail.then(operation, operation)
    this.operationTail = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }
}
