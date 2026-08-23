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
    'ServerAliveInterval=15',
    '-o',
    'ServerAliveCountMax=3',
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
