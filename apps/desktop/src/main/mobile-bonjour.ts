import { spawn as nodeSpawn } from 'node:child_process'
import { isIP } from 'node:net'
import { hostname, networkInterfaces, type NetworkInterfaceInfo } from 'node:os'

export const MOBILE_BONJOUR_SERVICE_TYPE = '_mousa._tcp' as const
export interface MobileBonjourAdvertisement {
  serverId: string
  host: string
  port: number
  /** 仅供调用者沿用连接对象；不发布证书或据此建立信任。 */
  certificateSha256?: string
}
export type MobileBonjourErrorCode = 'INVALID_ADVERTISEMENT' | 'LOCAL_HOST_UNAVAILABLE'
  | 'PUBLISH_UNAVAILABLE' | 'PUBLISH_TIMEOUT' | 'PUBLISH_EXITED' | 'PUBLISH_CANCELLED' | 'STOP_TIMEOUT'
export class MobileBonjourError extends Error {
  constructor(readonly code: MobileBonjourErrorCode) {
    super('局域网发现当前不可用。')
    this.name = 'MobileBonjourError'
  }
}
interface BonjourOutput {
  on(event: 'data', listener: (chunk: Buffer | string) => void): unknown
  removeListener(event: 'data', listener: (chunk: Buffer | string) => void): unknown
}
type ExitListener = (code: number | null, signal: NodeJS.Signals | null) => void
export interface MobileBonjourProcess {
  stdout?: BonjourOutput | null
  stderr?: BonjourOutput | null
  on(event: 'error', listener: (error: Error) => void): this
  once(event: 'exit' | 'close', listener: ExitListener): this
  removeListener(event: 'exit' | 'close', listener: ExitListener): this
  kill(signal?: NodeJS.Signals): boolean
}
export type MobileBonjourSpawn = (command: '/usr/bin/dns-sd', args: readonly string[], options: {
  shell: false; stdio: ['ignore', 'pipe', 'pipe']; env: NodeJS.ProcessEnv; windowsHide: true
}) => MobileBonjourProcess

function privateLanIPv4(value: unknown): value is string {
  if (typeof value !== 'string' || isIP(value) !== 4) return false
  const [a, b] = value.split('.').map(Number)
  return a === 10 || a === 172 && b! >= 16 && b! <= 31 || a === 192 && b === 168
}

/** 发现只面向实际局域网地址；不把 loopback、Tailscale 或公网地址发布为 LAN。 */
export function readMobileBonjourPrivateIPv4Addresses(interfaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces()): string[] {
  return [...new Set(Object.values(interfaces).flatMap(entries => (entries ?? [])
    .filter(entry => entry.family === 'IPv4' && !entry.internal && privateLanIPv4(entry.address))
    .map(entry => entry.address)))].sort()
}

function capture(input: MobileBonjourAdvertisement): MobileBonjourAdvertisement {
  if (!input || typeof input.serverId !== 'string' || !/^server:[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(input.serverId)
    || !privateLanIPv4(input.host) || !Number.isSafeInteger(input.port) || input.port < 1024 || input.port > 65535
    || input.certificateSha256 !== undefined && !/^[0-9a-f]{64}$/u.test(input.certificateSha256)) throw new MobileBonjourError('INVALID_ADVERTISEMENT')
  return Object.freeze({ serverId: input.serverId, host: input.host, port: input.port })
}

function serviceName(computerName: string): string {
  const name = computerName.normalize('NFKC').replace(/\.local\.?$/iu, '').replace(/[\p{Cc}\p{Cf}]/gu, '').trim()
  const points = [...('Mousa ' + (name || 'Mac'))]
  while (Buffer.byteLength(points.join(''), 'utf8') > 63) points.pop()
  return points.join('')
}

/** TXT 是公开发现提示，不含配对码、许可、证书正文或登录资料。 */
export function buildMobileBonjourArgs(input: MobileBonjourAdvertisement, computerName = hostname()): readonly string[] {
  const value = capture(input)
  return Object.freeze(['-R', serviceName(computerName), MOBILE_BONJOUR_SERVICE_TYPE, 'local.', String(value.port),
    'v=1', 'id=' + value.serverId, 'host=' + value.host, 'port=' + value.port, 'pairing=srp6a'])
}

interface Owner {
  process: MobileBonjourProcess
  ready: Promise<void>
  rejectReady(code: MobileBonjourErrorCode): void
  exited: boolean
  intentional: boolean
  exit: Promise<void>
  stopping?: Promise<void>
}

/** 每次只持有一个注册进程；换服务、关闭必须先确认旧进程退出。 */
export function createMobileBonjourPublisher(options: {
  spawn?: MobileBonjourSpawn
  localAddresses?: () => readonly string[]
  computerName?: () => string
  publishTimeoutMs?: number
  stopGraceMs?: number
} = {}) {
  const spawn = options.spawn ?? ((command, args, spawnOptions) => nodeSpawn(command, [...args], spawnOptions))
  const publishTimeoutMs = options.publishTimeoutMs ?? 8000, stopGraceMs = options.stopGraceMs ?? 1000
  if (![publishTimeoutMs, stopGraceMs].every(value => Number.isSafeInteger(value) && value > 0 && value <= 60000)) throw new MobileBonjourError('INVALID_ADVERTISEMENT')
  let state: { status: 'stopped' | 'publishing' | 'published' | 'failed'; code?: MobileBonjourErrorCode } = { status: 'stopped' }
  let active: Owner | undefined, generation = 0, desiredKey: string | undefined, startFlight: Promise<void> | undefined
  let tail = Promise.resolve()
  const enqueue = (work: () => Promise<void>) => {
    const next = tail.then(work, work)
    tail = next.then(() => undefined, () => undefined)
    return next
  }
  async function stopOwned(owner: Owner): Promise<void> {
    if (owner.stopping) return owner.stopping
    owner.intentional = true
    owner.rejectReady('PUBLISH_CANCELLED')
    const waitExit = async () => {
      let timer: ReturnType<typeof setTimeout> | undefined
      try { await Promise.race([owner.exit, new Promise<void>(resolve => { timer = setTimeout(resolve, stopGraceMs) })]) }
      finally { if (timer) clearTimeout(timer) }
    }
    owner.stopping = Promise.resolve().then(async () => {
      for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
        if (owner.exited) break
        try { owner.process.kill(signal) } catch { /* 信号发送失败不能视为进程已退出。 */ }
        if (!owner.exited) await waitExit()
      }
      if (!owner.exited) throw new MobileBonjourError('STOP_TIMEOUT')
      if (active === owner) active = undefined
    }).finally(() => { owner.stopping = undefined })
    return owner.stopping
  }
  function own(child: MobileBonjourProcess): Owner {
    let resolveReady!: () => void, rejectReady!: (error: Error) => void, resolveExit!: () => void, readySettled = false
    let partial = '', timer: ReturnType<typeof setTimeout> | undefined
    const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject })
    const exit = new Promise<void>(resolve => { resolveExit = resolve })
    // 发布被停止时可以先于 start 的 await 结算；内部始终拥有拒绝处理者。
    void ready.catch(() => undefined)
    const settleReady = (code?: MobileBonjourErrorCode) => {
      if (readySettled) return
      readySettled = true
      if (timer) clearTimeout(timer)
      timer = undefined
      if (code) rejectReady(new MobileBonjourError(code)); else resolveReady()
    }
    const owner: Owner = { process: child, ready, rejectReady: settleReady, exit, exited: false, intentional: false }
    const onData = (chunk: Buffer | string) => {
      if (owner.exited || owner.intentional || readySettled) return
      partial = (partial + (typeof chunk === 'string' ? chunk.slice(0, 4096) : chunk.subarray(0, 4096).toString('utf8'))).slice(-8192)
      if (/Name now registered and active/u.test(partial)) settleReady()
    }
    const drain = () => { /* 消费工具输出，不向日志或错误正文转发。 */ }
    const onError = () => {
      settleReady('PUBLISH_UNAVAILABLE')
      if (!owner.intentional && active === owner) {
        state = { status: 'failed', code: 'PUBLISH_UNAVAILABLE' }
        void stopOwned(owner).catch(() => { if (active === owner) state = { status: 'failed', code: 'STOP_TIMEOUT' } })
      }
    }
    const finish = () => {
      if (owner.exited) return
      owner.exited = true
      settleReady('PUBLISH_EXITED')
      child.stdout?.removeListener('data', onData)
      child.stderr?.removeListener('data', drain)
      child.removeListener('exit', finish)
      child.removeListener('close', finish)
      if (!owner.intentional && active === owner) state = { status: 'failed', code: 'PUBLISH_EXITED' }
      resolveExit()
    }
    child.on('error', onError)
    child.once('exit', finish)
    child.once('close', finish)
    child.stdout?.on('data', onData)
    child.stderr?.on('data', drain)
    timer = setTimeout(() => settleReady('PUBLISH_TIMEOUT'), publishTimeoutMs)
    return owner
  }
  return {
    getState: () => ({ ...state }),
    start(input: MobileBonjourAdvertisement): Promise<void> {
      let value: MobileBonjourAdvertisement, args: readonly string[]
      try {
        value = capture(input)
        if (!(options.localAddresses?.() ?? readMobileBonjourPrivateIPv4Addresses()).includes(value.host)) throw new MobileBonjourError('LOCAL_HOST_UNAVAILABLE')
        args = buildMobileBonjourArgs(value, options.computerName?.() ?? hostname())
      } catch (error) { return Promise.reject(error instanceof MobileBonjourError ? error : new MobileBonjourError('PUBLISH_UNAVAILABLE')) }
      const key = JSON.stringify(args)
      if (desiredKey === key && startFlight) return startFlight
      if (desiredKey === key && state.status === 'published' && active && !active.exited) return Promise.resolve()
      const current = ++generation
      desiredKey = key
      active?.rejectReady('PUBLISH_CANCELLED')
      const next = enqueue(async () => {
        try {
          if (active) await stopOwned(active)
          if (current !== generation) throw new MobileBonjourError('PUBLISH_CANCELLED')
          if (!(options.localAddresses?.() ?? readMobileBonjourPrivateIPv4Addresses()).includes(value.host)) throw new MobileBonjourError('LOCAL_HOST_UNAVAILABLE')
          state = { status: 'publishing' }
          let owner: Owner
          try { owner = own(spawn('/usr/bin/dns-sd', args, { shell: false, stdio: ['ignore', 'pipe', 'pipe'],
            env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' }, windowsHide: true })) }
          catch { throw new MobileBonjourError('PUBLISH_UNAVAILABLE') }
          active = owner
          await owner.ready
          if (current !== generation || owner.exited || owner.intentional || active !== owner) throw new MobileBonjourError('PUBLISH_CANCELLED')
          state = { status: 'published' }
        } catch (error) {
          let failure = error instanceof MobileBonjourError ? error : new MobileBonjourError('PUBLISH_UNAVAILABLE')
          if (active && failure.code !== 'STOP_TIMEOUT') {
            try { await stopOwned(active) } catch { failure = new MobileBonjourError('STOP_TIMEOUT') }
          }
          if (current === generation) state = { status: 'failed', code: failure.code }
          throw failure
        }
      })
      startFlight = next
      void next.then(() => { if (startFlight === next) startFlight = undefined }, () => { if (startFlight === next) startFlight = undefined })
      return next
    },
    stop(): Promise<void> {
      generation++; desiredKey = undefined
      active?.rejectReady('PUBLISH_CANCELLED')
      return enqueue(async () => {
        try { if (active) await stopOwned(active); state = { status: 'stopped' } }
        catch { state = { status: 'failed', code: 'STOP_TIMEOUT' }; throw new MobileBonjourError('STOP_TIMEOUT') }
      })
    },
  }
}
