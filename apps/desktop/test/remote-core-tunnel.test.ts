import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'

import type { RemoteCoreTunnelState } from '@music-bridge/contracts'

import {
  REMOTE_STREAM_PORT_CANDIDATES,
  RemoteCoreTunnelManager,
  buildHealthCheckSshArgs,
  buildTunnelSshArgs,
  isSafeSshTarget,
  type RemoteCoreTunnelSpawn,
  type RemoteSshProcess,
} from '../src/main/remote-core-tunnel.js'

class FakeOutput extends EventEmitter {
  emitText(value: string): void {
    this.emit('data', Buffer.from(value))
  }
}

class FakeSshProcess extends EventEmitter implements RemoteSshProcess {
  readonly stdout = new FakeOutput()
  readonly stderr = new FakeOutput()
  killed = false

  constructor(private readonly exitAfterSpawn?: { code: number; stderr?: string }) {
    super()
  }

  start(): void {
    if (this.exitAfterSpawn) {
      const exitAfterSpawn = this.exitAfterSpawn
      queueMicrotask(() => {
        if (exitAfterSpawn.stderr) this.stderr.emitText(exitAfterSpawn.stderr)
        this.emit('exit', exitAfterSpawn.code, null)
      })
    }
  }

  kill(): boolean {
    this.killed = true
    this.emit('exit', 0, 'SIGTERM')
    return true
  }

  exit(code = 255, stderr?: string): void {
    if (stderr) this.stderr.emitText(stderr)
    this.emit('exit', code, null)
  }
}

function managerHarness(options: {
  processes: FakeSshProcess[]
  health?: (port: number) => Promise<boolean>
  onDisconnected?: () => Promise<void>
}): {
  manager: RemoteCoreTunnelManager
  spawnCalls: Array<{ command: string; args: readonly string[]; shell: false }>
  processes: FakeSshProcess[]
  healthCalls: number[]
} {
  const spawnCalls: Array<{ command: string; args: readonly string[]; shell: false }> = []
  const healthCalls: number[] = []
  let processIndex = 0
  const spawn: RemoteCoreTunnelSpawn = (command, args, spawnOptions) => {
    spawnCalls.push({ command, args, shell: spawnOptions.shell })
    const process = options.processes[processIndex++] ?? new FakeSshProcess({ code: 255 })
    process.start()
    return process
  }
  const manager = new RemoteCoreTunnelManager({
    spawn,
    boundGraceMs: 0,
    healthProbe: async ({ remoteStreamPort }) => {
      healthCalls.push(remoteStreamPort)
      return options.health ? options.health(remoteStreamPort) : true
    },
    ...(options.onDisconnected ? { onDisconnected: options.onDisconnected } : {}),
  })
  return { manager, spawnCalls, processes: options.processes, healthCalls }
}

async function waitForStatus(
  manager: RemoteCoreTunnelManager,
  expected: RemoteCoreTunnelState['status'],
): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (manager.getState().status === expected) return
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
  assert.equal(manager.getState().status, expected)
}

test('SSH target only accepts a safe user@host or configured alias', () => {
  assert.equal(isSafeSshTarget('roonstation@192.168.5.76'), true)
  assert.equal(isSafeSshTarget('core-mac'), true)
  assert.equal(isSafeSshTarget('roonstation@core-mac'), true)
  assert.equal(isSafeSshTarget('roonstation@core mac'), false)
  assert.equal(isSafeSshTarget('roonstation@core-mac;touch'), false)
  assert.equal(isSafeSshTarget('roonstation@core-mac$(id)'), false)
  assert.equal(isSafeSshTarget('-v'), false)
  assert.equal(isSafeSshTarget('-v@core-mac'), false)
  assert.equal(isSafeSshTarget('a'.repeat(256)), false)
})

test('SSH commands are fixed, loopback-only, and never forward the control port', () => {
  const tunnelArgs = buildTunnelSshArgs('roonstation@core-mac', 38512, 38502)
  const healthArgs = buildHealthCheckSshArgs('roonstation@core-mac', 38512)

  assert.deepEqual(tunnelArgs, [
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
    '127.0.0.1:19330:127.0.0.1:9330',
    '-R',
    '127.0.0.1:38512:127.0.0.1:38502',
    'roonstation@core-mac',
  ])
  assert.deepEqual(healthArgs, [
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
    'roonstation@core-mac',
    '/usr/bin/curl',
    '--fail',
    '--silent',
    '--show-error',
    '--max-time',
    '5',
    'http://127.0.0.1:38512/__musicbridge_remote_dev_health',
  ])
  assert.equal(tunnelArgs.some((value) => value.includes('38501')), false)
  assert.equal(tunnelArgs.some((value) => value.includes('GatewayPorts')), false)
  assert.equal(tunnelArgs.some((value) => value.includes('PasswordAuthentication')), false)
})

test('SSH tunnel accepts only the explicitly bounded secondary Gateway port', () => {
  const tunnelArgs = buildTunnelSshArgs('core-mac', 38512, 38602)
  assert.equal(tunnelArgs.includes('127.0.0.1:38512:127.0.0.1:38602'), true)
  assert.throws(() => buildTunnelSshArgs('core-mac', 38512, 38603))
})

test('default health probe accepts only the bounded remote health body through a second fake SSH process', async () => {
  const mutableCalls: string[][] = []
  const spawn: RemoteCoreTunnelSpawn = (_command, args, spawnOptions) => {
    assert.equal(spawnOptions.shell, false)
    mutableCalls.push([...args])
    const process = new FakeSshProcess()
    process.start()
    if (args.includes('/usr/bin/curl')) {
      queueMicrotask(() => {
        process.stdout.emitText('{"ok":true,"mode":"remote-core-development"}')
        process.exit(0)
      })
    }
    return process
  }
  const manager = new RemoteCoreTunnelManager({ spawn, boundGraceMs: 0 })

  const state = await manager.start({
    sshTarget: 'core-mac',
    remoteStreamPort: 38512,
    localStreamPort: 38502,
    autoReconnect: false,
  })

  assert.equal(state.status, 'ready')
  assert.equal(state.remoteHealth, 'available')
  assert.equal(mutableCalls.length, 2)
  assert.equal(mutableCalls[1]?.at(-1), 'http://127.0.0.1:38512/__musicbridge_remote_dev_health')
  await manager.stop()
})

test('MBR002：探测超时终止并确认Fake SSH退出，未知退出保留所有权且禁止另起隧道', async () => {
  class HeldProcess extends FakeSshProcess {
    signals: Array<NodeJS.Signals | undefined> = []
    override kill(signal?: NodeJS.Signals): boolean { this.signals.push(signal); return true }
  }
  const tunnel = new FakeSshProcess(), probe = new HeldProcess(); let spawns = 0
  const manager = new RemoteCoreTunnelManager({ boundGraceMs: 0, healthTimeoutMs: 20, stopGraceMs: 10,
    spawn: (_command, args) => { ++spawns; return args.includes('/usr/bin/curl') ? probe : tunnel },
  })
  const config = { sshTarget: 'core-mac', remoteStreamPort: 38512, localStreamPort: 38502, autoReconnect: false }
  const failed = await manager.start(config)
  assert.equal(failed.status, 'failed')
  assert.deepEqual(probe.signals, ['SIGTERM', 'SIGKILL'])
  assert.equal((await manager.start(config)).status, 'failed')
  assert.equal(spawns, 2, '未确认旧探测退出不得开始新的SSH')
  probe.exit(0)
  assert.equal((await manager.stop()).status, 'idle')
  assert.equal(probe.listenerCount('exit'), 0)
  assert.equal(probe.stdout.listenerCount('data'), 0)
})

test('MBR002：停止直接取消正在等待的探测，迟到健康结果不能恢复ready', async () => {
  let enter!: () => void, finish!: (value: boolean) => void, signal: AbortSignal | undefined
  const entered = new Promise<void>(resolve => { enter = resolve })
  const held = new Promise<boolean>(resolve => { finish = resolve })
  const process = new FakeSshProcess()
  const manager = new RemoteCoreTunnelManager({ spawn: () => process, boundGraceMs: 0, healthTimeoutMs: 5_000,
    healthProbe: async input => { signal = input.signal; enter(); return held },
  })
  const starting = manager.start({ sshTarget: 'core-mac', remoteStreamPort: 38512, localStreamPort: 38502, autoReconnect: false })
  await entered
  const stopping = manager.stop()
  assert.equal(signal?.aborted, true)
  await starting; assert.equal((await stopping).status, 'idle')
  finish(true); await new Promise(resolve => setImmediate(resolve))
  assert.equal(manager.getState().status, 'idle'); assert.equal(process.killed, true)
})

test('MBR002：探测输出超预算拒绝而不是截断成可接受JSON', async () => {
  const tunnel = new FakeSshProcess(), probe = new FakeSshProcess()
  const manager = new RemoteCoreTunnelManager({ boundGraceMs: 0, spawn: (_command, args) => {
    if (!args.includes('/usr/bin/curl')) return tunnel
    queueMicrotask(() => { probe.stdout.emitText('{"ok":true,"mode":"remote-core-development"}' + ' '.repeat(4_096)); probe.exit(0) })
    return probe
  } })
  assert.equal((await manager.start({ sshTarget: 'core-mac', remoteStreamPort: 38512, localStreamPort: 38502, autoReconnect: false })).status, 'failed')
  await manager.stop()
})

test('tunnel uses the next bounded remote port after a forward bind failure', async () => {
  const first = new FakeSshProcess({ code: 255, stderr: 'remote forward failure for: listen port 38512' })
  const second = new FakeSshProcess()
  const harness = managerHarness({ processes: [first, second] })

  const state = await harness.manager.start({
    sshTarget: 'roonstation@core-mac',
    remoteStreamPort: 38512,
    localStreamPort: 38502,
    autoReconnect: true,
  })

  assert.equal(state.status, 'ready')
  assert.equal(state.remoteStreamPort, 38513)
  assert.deepEqual(harness.healthCalls, [38513])
  assert.equal(harness.spawnCalls.length, 2)
  assert.equal(harness.spawnCalls[0]?.shell, false)
  assert.equal(harness.spawnCalls[1]?.args.includes('127.0.0.1:38513:127.0.0.1:38502'), true)
})

test('all bounded remote ports produce a deterministic failure without an unbounded scan', async () => {
  const processes = REMOTE_STREAM_PORT_CANDIDATES.map(
    () => new FakeSshProcess({ code: 255, stderr: 'remote forward failure' }),
  )
  const harness = managerHarness({ processes })

  const state = await harness.manager.start({
    sshTarget: 'core-mac',
    remoteStreamPort: 38512,
    localStreamPort: 38502,
    autoReconnect: true,
  })

  assert.equal(state.status, 'failed')
  assert.equal(state.errorCode, 'REMOTE_PORTS_UNAVAILABLE')
  assert.equal(harness.spawnCalls.length, 8)
  assert.equal(harness.healthCalls.length, 0)
})

test('BatchMode authentication failure stops without trying another port', async () => {
  const harness = managerHarness({
    processes: [new FakeSshProcess({ code: 255, stderr: 'Permission denied (publickey)' })],
  })

  const state = await harness.manager.start({
    sshTarget: 'core-mac',
    remoteStreamPort: 38512,
    localStreamPort: 38502,
    autoReconnect: true,
  })

  assert.equal(state.status, 'failed')
  assert.equal(state.errorCode, 'SSH_AUTH_REQUIRED')
  assert.equal(harness.spawnCalls.length, 1)
})

test('SSH DNS or connection failure is reported separately with a redacted reason', async () => {
  const harness = managerHarness({
    processes: [
      new FakeSshProcess({
        code: 255,
        stderr: 'ssh: Could not resolve hostname core-mac: nodename nor servname provided, or not known',
      }),
    ],
  })

  const state = await harness.manager.start({
    sshTarget: 'core-mac',
    remoteStreamPort: 38512,
    localStreamPort: 38502,
    autoReconnect: true,
  })

  assert.equal(state.status, 'failed')
  assert.equal(state.errorCode, 'SSH_CONNECTION_FAILED')
  assert.deepEqual((state as unknown as { failure?: unknown }).failure, {
    phase: 'ssh',
    code: 'SSH_CONNECTION_FAILED',
    message: 'SSH 无法连接到远端目标，请检查主机名、网络和 SSH 配置。',
  })
  assert.equal(JSON.stringify((state as unknown as { failure?: unknown }).failure).includes('core-mac'), false)
  assert.equal(harness.spawnCalls.length, 1)
})

test('unexpected tunnel exit cleans playback through the callback and reconnects at most once', async () => {
  let disconnected = 0
  const first = new FakeSshProcess()
  const second = new FakeSshProcess()
  const harness = managerHarness({
    processes: [first, second],
    onDisconnected: async () => {
      disconnected += 1
    },
  })

  const ready = await harness.manager.start({
    sshTarget: 'core-mac',
    remoteStreamPort: 38512,
    localStreamPort: 38502,
    autoReconnect: true,
  })
  assert.equal(ready.status, 'ready')

  first.exit(255, 'connection lost')
  await waitForStatus(harness.manager, 'ready')

  assert.equal(disconnected, 1)
  assert.equal(harness.spawnCalls.length, 2)
  assert.equal(harness.manager.getState().status, 'ready')

  second.exit(255, 'connection lost again')
  await waitForStatus(harness.manager, 'disconnected')
  assert.equal(harness.spawnCalls.length, 2)
  assert.equal(harness.manager.getState().status, 'disconnected')
})

test('stop kills the SSH child and returns to local-core idle state', async () => {
  const process = new FakeSshProcess()
  const harness = managerHarness({ processes: [process] })
  await harness.manager.start({
    sshTarget: 'core-mac',
    remoteStreamPort: 38512,
    localStreamPort: 38502,
    autoReconnect: true,
  })

  const state = await harness.manager.stop()
  assert.equal(process.killed, true)
  assert.deepEqual(state, {
    mode: 'local-core',
    status: 'idle',
    localStreamPort: 38502,
    remoteHealth: 'unavailable',
    autoReconnect: false,
  })
})

test('尚未配置目标时重连报告输入问题，而非远端健康故障', async () => {
  const manager = new RemoteCoreTunnelManager()
  const state = await manager.reconnect()
  assert.equal(state.errorCode, 'INVALID_SSH_TARGET')
  assert.equal(state.failure?.phase, 'configuration')
})

test('MBR002：spawn失败的close确认释放所有权，不要求不存在的exit事件', async () => {
  class UnspawnedProcess extends FakeSshProcess { override kill(): boolean { return false } }
  const failed = new UnspawnedProcess(), healthy = new FakeSshProcess()
  let spawns = 0
  const manager = new RemoteCoreTunnelManager({ boundGraceMs: 0, stopGraceMs: 5,
    healthProbe: async () => true,
    spawn: () => {
      if (++spawns === 1) {
        queueMicrotask(() => { failed.emit('error', new Error('合成spawn失败')); failed.emit('close', -2, null) })
        return failed
      }
      return healthy
    },
  })
  const config = { sshTarget: 'core-mac', remoteStreamPort: 38512, localStreamPort: 38502, autoReconnect: false }
  try {
    assert.equal((await manager.start(config)).errorCode, 'SSH_BINARY_UNAVAILABLE')
    assert.equal((await manager.start(config)).status, 'ready')
    assert.equal(spawns, 2)
    assert.equal(failed.listenerCount('error'), 0)
    assert.equal(failed.listenerCount('exit'), 0)
    assert.equal(failed.listenerCount('close'), 0)
  } finally { await manager.stop() }
})

test('MBR002：旧断连清理晚到不能重启显式新start创建的隧道', async () => {
  let enter!: () => void, finish!: () => void
  const entered = new Promise<void>(resolve => { enter = resolve })
  const held = new Promise<void>(resolve => { finish = resolve })
  const first = new FakeSshProcess(), second = new FakeSshProcess(), third = new FakeSshProcess()
  const harness = managerHarness({ processes: [first, second, third], onDisconnected: async () => { enter(); await held } })
  const config = { sshTarget: 'core-mac', remoteStreamPort: 38512, localStreamPort: 38502, autoReconnect: true }
  try {
    await harness.manager.start(config)
    first.exit(255); await entered
    assert.equal((await harness.manager.start(config)).status, 'ready')
    finish(); await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve))
    assert.equal(harness.spawnCalls.length, 2, '旧清理不得自动重启新隧道')
    assert.equal(second.killed, false)
  } finally { finish(); await harness.manager.stop() }
})

test('MBR002：探测回调同步触发stop也能立即取消，不遗漏已触发abort', async () => {
  let enter!: () => void, finish!: (value: boolean) => void
  const entered = new Promise<void>(resolve => { enter = resolve })
  const held = new Promise<boolean>(resolve => { finish = resolve })
  let stopping: Promise<RemoteCoreTunnelState> | undefined
  const manager = new RemoteCoreTunnelManager({ boundGraceMs: 0, spawn: () => new FakeSshProcess(),
    healthProbe: input => { stopping = manager.stop(); assert.equal(input.signal?.aborted, true); enter(); return held },
  })
  const starting = manager.start({ sshTarget: 'core-mac', remoteStreamPort: 38512, localStreamPort: 38502, autoReconnect: false })
  try {
    await entered; await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve))
    assert.equal(manager.getState().status, 'idle')
  } finally { finish(true); await starting; await stopping; await manager.stop() }
})

test('MBR002：kill同步报错不能重入发第二次TERM，未退出仍阻断新spawn', async () => {
  class FailedKillProcess extends FakeSshProcess {
    signals: Array<NodeJS.Signals | undefined> = []
    override kill(signal?: NodeJS.Signals): boolean {
      this.signals.push(signal)
      if (this.signals.length === 1) this.emit('error', new Error('合成kill失败'))
      throw new Error('合成发送信号失败')
    }
  }
  const tunnel = new FakeSshProcess(), probe = new FailedKillProcess(); let spawns = 0
  const manager = new RemoteCoreTunnelManager({ boundGraceMs: 0, healthTimeoutMs: 10, stopGraceMs: 5,
    spawn: (_command, args) => { ++spawns; return args.includes('/usr/bin/curl') ? probe : tunnel },
  })
  const config = { sshTarget: 'core-mac', remoteStreamPort: 38512, localStreamPort: 38502, autoReconnect: false }
  try {
    assert.equal((await manager.start(config)).status, 'failed')
    assert.deepEqual(probe.signals.slice(0, 2), ['SIGTERM', 'SIGKILL'])
    assert.equal((await manager.start(config)).status, 'failed')
    assert.equal(spawns, 2)
  } finally { probe.emit('close', null, null); await manager.stop() }
  assert.equal(probe.listenerCount('error'), 0)
  assert.equal(probe.listenerCount('exit'), 0)
  assert.equal(probe.listenerCount('close'), 0)
  assert.equal(probe.stdout.listenerCount('data'), 0)
})

test('MBR002：断连状态观察者同步新start，旧清理仍绑定发布前的intent', async () => {
  const processes = [new FakeSshProcess(), new FakeSshProcess(), new FakeSshProcess()]
  let spawns = 0, finish!: () => void, replacement: Promise<RemoteCoreTunnelState> | undefined
  const held = new Promise<void>(resolve => { finish = resolve })
  const config = { sshTarget: 'core-mac', remoteStreamPort: 38512, localStreamPort: 38502, autoReconnect: true }
  const manager = new RemoteCoreTunnelManager({ boundGraceMs: 0, spawn: () => processes[spawns++]!, healthProbe: async () => true,
    onStateChanged: state => { if (state.status === 'disconnected') replacement = manager.start(config) },
    onDisconnected: () => held,
  })
  try {
    await manager.start(config); processes[0]!.exit(255)
    assert.equal((await replacement!).status, 'ready')
    finish(); await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve))
    assert.equal(spawns, 2)
    assert.equal(processes[1]!.killed, false)
  } finally { finish(); await manager.stop() }
})
