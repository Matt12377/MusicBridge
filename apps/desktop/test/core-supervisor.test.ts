import assert from 'node:assert/strict'
import test from 'node:test'

import { IPC_VERSION } from '@music-bridge/contracts'
import {
  CoreSupervisor,
  type CoreChildProcess,
  type CoreMessagePort,
} from '../src/main/core-supervisor.js'

class FakePort implements CoreMessagePort {
  readonly sent: unknown[] = []
  private listener: ((event: { data: unknown }) => void) | undefined
  closed = false

  on(event: 'message', listener: (event: { data: unknown }) => void): void {
    assert.equal(event, 'message')
    this.listener = listener
  }

  start(): void {}

  close(): void {
    this.closed = true
  }

  postMessage(message: unknown): void {
    this.sent.push(message)
  }

  receive(message: unknown): void {
    this.listener?.({ data: message })
  }
}

class FakeChild implements CoreChildProcess {
  readonly posted: unknown[] = []
  private exitListener: ((code: number) => void) | undefined
  killed = false

  postMessage(message: unknown): void {
    this.posted.push(message)
  }

  once(event: 'exit', listener: (code: number) => void): void {
    assert.equal(event, 'exit')
    this.exitListener = listener
  }

  kill(): boolean {
    this.killed = true
    this.exit(0)
    return true
  }

  exit(code: number): void {
    this.exitListener?.(code)
  }
}

function makeHarness() {
  const channels: Array<{ port1: FakePort; port2: FakePort }> = []
  const children: FakeChild[] = []
  const forkOptions: Array<{ env: NodeJS.ProcessEnv }> = []
  const dependencies = {
      createChannel: () => {
        const channel = { port1: new FakePort(), port2: new FakePort() }
        channels.push(channel)
        return channel
      },
      fork: (_entryPath: string, _args: string[], options: { env: NodeJS.ProcessEnv }) => {
        const child = new FakeChild()
        children.push(child)
        forkOptions.push({ env: options.env })
        return child
      },
  }
  const supervisor = new CoreSupervisor({
    entryPath: '/tmp/core-entry.js',
    cwd: '/tmp',
    dependencies,
    requestTimeoutMs: 20,
  })
  return { channels, children, dependencies, forkOptions, supervisor }
}

function ready(channel: { port2: FakePort }): void {
  channel.port2.receive({
    version: IPC_VERSION,
    event: 'core.ready',
    payload: {
      state: {
        runtime: 'ready',
        roon: 'disconnected',
        provider: 'missing',
        activeStreamCount: 0,
        activePlaybackPresent: false,
      },
    },
  })
}

test('PREP 完整文件核对使用有界长超时，不被普通两秒控制请求窗口截断', async () => {
  const harness = makeHarness(), starting = harness.supervisor.start();
  await new Promise(resolve => setImmediate(resolve)); ready(harness.channels[0]!); await starting;
  const id = '11111111-1111-4111-8111-111111111111'; let settled = false;
  const pending = harness.supervisor.request('recordingPrepared.previewImport', { preparationId: id, destinationId: id, selectionIds: [id] }).then(() => { settled = true; return undefined }, error => { settled = true; return error });
  await new Promise(resolve => setTimeout(resolve, 45));
  const timedOutEarly = settled;
  const sent = harness.channels[0]!.port2.sent.at(-1) as { id: string };
  harness.channels[0]!.port2.receive({ version: 1, id: sent.id, ok: false, error: { code: 'INVALID_IPC_REQUEST', message: '合成取消文件核对' } });
  const result = await pending; await harness.supervisor.shutdown();
  assert.equal(timedOutEarly, false); assert.equal(result.code, 'INVALID_IPC_REQUEST');
});

test('CoreSupervisor creates request ids and resolves typed responses', async () => {
  const harness = makeHarness()
  const starting = harness.supervisor.start()
  await new Promise((resolve) => setImmediate(resolve))
  ready(harness.channels[0]!)
  await starting

  const request = harness.supervisor.request('core.ping', {})
  await new Promise((resolve) => setImmediate(resolve))
  const sent = harness.channels[0]!.port2.sent[0] as { id: string; command: string }
  assert.equal(sent.command, 'core.ping')
  assert.match(sent.id, /^[0-9a-f-]{36}$/)
  harness.channels[0]!.port2.receive({
    version: IPC_VERSION,
    id: sent.id,
    ok: true,
    result: { pong: true },
  })
  assert.deepEqual(await request, { pong: true })
})

test('CoreSupervisor restarts a crashed Core once and then fails closed', async () => {
  const harness = makeHarness()
  const starting = harness.supervisor.start()
  await new Promise((resolve) => setImmediate(resolve))
  ready(harness.channels[0]!)
  await starting

  harness.children[0]!.exit(1)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(harness.children.length, 2)
  ready(harness.channels[1]!)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(harness.supervisor.status, 'ready')

  harness.children[1]!.exit(1)
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(harness.children.length, 2)
  assert.equal(harness.supervisor.status, 'failed')
})

test('CoreSupervisor records bounded lifecycle states without process details', async () => {
  const harness = makeHarness()
  const lifecycle: string[] = []
  const supervisor = new CoreSupervisor({
    entryPath: '/tmp/core-entry.js',
    cwd: '/tmp',
    dependencies: harness.dependencies,
    requestTimeoutMs: 20,
    onLifecycle: (event) => lifecycle.push(event.event),
  })
  const starting = supervisor.start()
  await new Promise((resolve) => setImmediate(resolve))
  ready(harness.channels[0]!)
  await starting

  harness.children[0]!.exit(1)
  await new Promise((resolve) => setImmediate(resolve))
  ready(harness.channels[1]!)
  await new Promise((resolve) => setImmediate(resolve))
  await supervisor.shutdown()

  assert.deepEqual(lifecycle, ['spawn', 'ready', 'exit', 'restart', 'spawn', 'ready', 'stopped'])
})

test('CoreSupervisor request timeout and shutdown are bounded', async () => {
  const harness = makeHarness()
  const starting = harness.supervisor.start()
  await new Promise((resolve) => setImmediate(resolve))
  ready(harness.channels[0]!)
  await starting

  await assert.rejects(harness.supervisor.request('core.getHealth', {}), (error: Error & { code?: string }) => {
    assert.equal(error.code, 'TIMEOUT')
    return true
  })

  await harness.supervisor.shutdown()
  assert.equal(harness.supervisor.status, 'stopped')
  assert.equal(harness.children[0]!.killed, true)
})

test('CoreSupervisor gives library playlist requests a bounded extended timeout', async () => {
  const harness = makeHarness()
  const starting = harness.supervisor.start()
  await new Promise((resolve) => setImmediate(resolve))
  ready(harness.channels[0]!)
  await starting

  const request = harness.supervisor.request('library.playlist', {
    playlistId: '301',
    page: { offset: 0, limit: 20 },
  })
  await new Promise((resolve) => setImmediate(resolve))
  const sent = harness.channels[0]!.port2.sent[0] as { id: string }
  setTimeout(() => {
    harness.channels[0]!.port2.receive({
      version: IPC_VERSION,
      id: sent.id,
      ok: true,
      result: {
        id: '301',
        name: 'Synthetic Large Playlist',
        trackCount: 1200,
        tracks: {
          items: [],
          offset: 0,
          limit: 20,
          total: 1200,
          hasMore: true,
        },
      },
    })
  }, 30)

  assert.equal((await request).trackCount, 1200)
  await harness.supervisor.shutdown()
})

test('CoreSupervisor gives Roon Library requests the same bounded extended timeout', async () => {
  const harness = makeHarness()
  const starting = harness.supervisor.start()
  await new Promise((resolve) => setImmediate(resolve))
  ready(harness.channels[0]!)
  await starting

  const request = harness.supervisor.request('roon.library.albums', {
    page: { offset: 0, limit: 20 },
  })
  await new Promise((resolve) => setImmediate(resolve))
  const sent = harness.channels[0]!.port2.sent[0] as { id: string }
  setTimeout(() => {
    harness.channels[0]!.port2.receive({
      version: IPC_VERSION,
      id: sent.id,
      ok: true,
      result: {
        items: [],
        offset: 0,
        limit: 20,
        hasMore: false,
      },
    })
  }, 30)

  assert.deepEqual(await request, {
    items: [],
    offset: 0,
    limit: 20,
    hasMore: false,
  })
  await harness.supervisor.shutdown()
})

test('CoreSupervisor keeps typed Roon transport control alive for its bounded Core callback', async () => {
  const harness = makeHarness()
  const starting = harness.supervisor.start()
  await new Promise((resolve) => setImmediate(resolve))
  ready(harness.channels[0]!)
  await starting

  const request = harness.supervisor.request('roon.transport.stop', {})
  await new Promise((resolve) => setImmediate(resolve))
  const sent = harness.channels[0]!.port2.sent[0] as { id: string }
  setTimeout(() => {
    harness.channels[0]!.port2.receive({
      version: IPC_VERSION,
      id: sent.id,
      ok: true,
      result: { stopped: true },
    })
  }, 30)

  assert.deepEqual(await request, { stopped: true })
  await harness.supervisor.shutdown()
})

test('CoreSupervisor has an explicit Main-only path for QR poll credentials', async () => {
  const harness = makeHarness()
  const starting = harness.supervisor.start()
  await new Promise((resolve) => setImmediate(resolve))
  ready(harness.channels[0]!)
  await starting

  const request = harness.supervisor.requestInternal('auth.pollQr', {
    challengeId: 'challenge-1',
  })
  await new Promise((resolve) => setImmediate(resolve))
  const sent = harness.channels[0]!.port2.sent[0] as { id: string; command: string }
  assert.equal(sent.command, 'auth.pollQr')
  harness.channels[0]!.port2.receive({
    version: IPC_VERSION,
    id: sent.id,
    ok: true,
    result: {
      state: { status: 'authorized' },
      credential: 'synthetic-credential',
    },
  })

  assert.deepEqual(await request, {
    state: { status: 'authorized' },
    credential: 'synthetic-credential',
  })
})

test('CoreSupervisor runs the readiness recovery hook on initial start and restart', async () => {
  const harness = makeHarness()
  let readyHooks = 0
  const supervisor = new CoreSupervisor({
    entryPath: '/tmp/core-entry.js',
    cwd: '/tmp',
    dependencies: harness.dependencies,
    requestTimeoutMs: 20,
    onReady: async () => {
      readyHooks += 1
    },
  })
  const starting = supervisor.start()
  await new Promise((resolve) => setImmediate(resolve))
  ready(harness.channels[0]!)
  await starting
  assert.equal(readyHooks, 1)

  harness.children[0]!.exit(1)
  await new Promise((resolve) => setImmediate(resolve))
  ready(harness.channels[1]!)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(readyHooks, 2)
})

test('CoreSupervisor can restart with a new explicitly supplied Core environment', async () => {
  const harness = makeHarness()
  const starting = harness.supervisor.start()
  await new Promise((resolve) => setImmediate(resolve))
  ready(harness.channels[0]!)
  await starting

  const restarting = harness.supervisor.restart({
    NODE_ENV: 'test',
    MUSIC_BRIDGE_REMOTE_CORE_MODE: 'remote-core-development',
    MUSIC_BRIDGE_REMOTE_STREAM_PORT: '38512',
  })
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.equal(harness.children[0]?.killed, true)
  assert.equal(harness.children.length, 2)
  assert.deepEqual(harness.forkOptions[1]?.env, {
    NODE_ENV: 'test',
    MUSIC_BRIDGE_REMOTE_CORE_MODE: 'remote-core-development',
    MUSIC_BRIDGE_REMOTE_STREAM_PORT: '38512',
  })
  ready(harness.channels[1]!)
  await restarting
  assert.equal(harness.supervisor.status, 'ready')

  await harness.supervisor.shutdown()
})

test('CoreSupervisor does not reintroduce parent environment secrets into Core', async () => {
  const canaryName = 'MUSIC_BRIDGE_UNRELATED_SECRET_CANARY'
  const previous = process.env[canaryName]
  process.env[canaryName] = 'synthetic-canary'
  try {
    const harness = makeHarness()
    const supervisor = new CoreSupervisor({
      entryPath: '/tmp/core-entry.js',
      cwd: '/tmp',
      env: { NODE_ENV: 'test', MUSIC_BRIDGE_CORE_TEST_MODE: '1' },
      dependencies: harness.dependencies,
      requestTimeoutMs: 20,
    })
    const starting = supervisor.start()
    await new Promise((resolve) => setImmediate(resolve))
    ready(harness.channels[0]!)
    await starting

    assert.equal(harness.forkOptions[0]?.env[canaryName], undefined)
    assert.equal(harness.forkOptions[0]?.env.NETEASE_COOKIE, undefined)
    assert.equal(harness.forkOptions[0]?.env.MUSIC_BRIDGE_CORE_TEST_MODE, '1')
    await supervisor.shutdown()
  } finally {
    if (previous === undefined) delete process.env[canaryName]
    else process.env[canaryName] = previous
  }
})
