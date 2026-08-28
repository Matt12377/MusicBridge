import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'

import { IPC_VERSION, type ActivateRestoredDataset, type RestoreActivationView } from '@music-bridge/contracts'
import {
  CoreIpcError,
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

test('PREP 完整文件核对使用有界长超时，不被普通两秒控制请求窗口截断', async t => {
  // 这里验证请求期限，不让 20ms 的模拟启动期限与宿主调度竞争。
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const harness = makeHarness(), starting = harness.supervisor.start();
  ready(harness.channels[0]!); await starting;
  const id = '11111111-1111-4111-8111-111111111111'; let settled = false;
  const pending = harness.supervisor.request('recordingPrepared.previewImport', { preparationId: id, destinationId: id, selectionIds: [id] }).then(() => { settled = true; return undefined }, error => { settled = true; return error });
  t.mock.timers.tick(45); await Promise.resolve();
  const timedOutEarly = settled;
  const sent = harness.channels[0]!.port2.sent.at(-1) as { id: string };
  harness.channels[0]!.port2.receive({ version: 1, id: sent.id, ok: false, error: { code: 'INVALID_IPC_REQUEST', message: '合成取消文件核对' } });
  const result = await pending; t.mock.timers.reset(); await harness.supervisor.shutdown();
  assert.equal(timedOutEarly, false); assert.equal(result.code, 'INVALID_IPC_REQUEST');
});

for (const command of ['recordingArchive.preview','recordingArchive.start','recordingArchive.initialize','recordingArchive.verify'] as const) {
  test(`${command} 使用有界文件期限`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const harness = makeHarness(), starting = harness.supervisor.start(); ready(harness.channels[0]!); await starting;
    const id = randomUUID(), selection = { assetId: id, rootId: id, sourcePolicy: 'reference-dependent' as const };
    const payload = command === 'recordingArchive.preview' ? { ...selection, readId: id } : command === 'recordingArchive.start' ? { ...selection, commandId: id, proposalFingerprint: 'a'.repeat(64), userConfirmed: true } : command === 'recordingArchive.initialize' ? { commandId: id, id, userConfirmed: true } : { id, readId: id };
    let settled = false;
    const pending = harness.supervisor.request(command, payload as never).then(() => { settled = true; return undefined }, error => { settled = true; return error });
    t.mock.timers.tick(45); await Promise.resolve(); const timedOutEarly = settled;
    const sent = harness.channels[0]!.port2.sent.at(-1) as { id: string };
    harness.channels[0]!.port2.receive({ version: 1, id: sent.id, ok: false, error: { code: 'INVALID_IPC_REQUEST', message: '合成结束' } });
    const result = await pending; t.mock.timers.reset(); await harness.supervisor.shutdown();
    assert.equal(timedOutEarly, false, command); assert.equal(result.code, 'INVALID_IPC_REQUEST');
  })
}

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

test('执行启动包含原始 Render 核验，不使用短交互期限', async () => {
  const harness = makeHarness()
  const starting = harness.supervisor.start()
  await new Promise(resolve => setImmediate(resolve)); ready(harness.channels[0]!); await starting
  const payload = { commandId: randomUUID(), layoutVersionId: randomUUID(), destinationId: randomUUID(), preparedVersionId: randomUUID(), mode: 'prepared-derivative' as const, sessionRevision: 1, proposalFingerprint: 'a'.repeat(64), userConfirmed: true as const }
  const request = harness.supervisor.request('recordingExecution.start', payload)
  await new Promise(resolve => setImmediate(resolve))
  const sent = harness.channels[0]!.port2.sent[0] as { id: string }
  setTimeout(() => harness.channels[0]!.port2.receive({ version: IPC_VERSION, id: sent.id, ok: true, result: { id: payload.commandId, draftId: randomUUID(), layoutVersionId: payload.layoutVersionId, destinationId: payload.destinationId, profileVersionId: randomUUID(), mode: payload.mode, state: 'running', completedSides: 0, totalSides: 1 } }), 30)
  try { assert.equal((await request).state, 'running') } finally { await harness.supervisor.shutdown() }
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

function activationRequest(): ActivateRestoredDataset {
  return { commandId: randomUUID(), restoreJobId: randomUUID(), expectedActiveId: null, userConfirmed: true, stopPlaybackConfirmed: true }
}

test('显式恢复激活只在 prepared 后停止播放与重启，同命令并发和失回执重试不重复重启', async t => {
  const { supervisor } = makeHarness(), request = activationRequest(), calls: string[] = []
  const activationId = randomUUID()
  assert.notEqual(activationId, request.commandId)
  let state: RestoreActivationView['state'] = 'preparing'
  const view = (): RestoreActivationView => ({ id: activationId, restoreJobId: request.restoreJobId, previousId: null, state, createdAt: new Date(0).toISOString(), contentIncluded: false })
  t.mock.method(supervisor, 'request', (async (command: string) => {
    calls.push(command)
    if (command === 'recordingBackups.activate') return view()
    if (command === 'recordingBackups.overview') { if (state === 'preparing') state = 'prepared'; return { roots: [], jobs: [], activations: [view()] } }
    if (command === 'playback.stop') return { state: 'idle', queue: [], currentIndex: -1 }
    throw new Error('不应调用其他业务操作')
  }) as typeof supervisor.request)
  t.mock.method(supervisor, 'restart', async (_env?: NodeJS.ProcessEnv, options?: { readyTimeoutMs?: number }) => {
    calls.push('restart'); assert.equal(options?.readyTimeoutMs, 30 * 60_000); state = 'active'
  })
  assert.equal(typeof supervisor.activateRestoredDataset, 'function')
  const results = await Promise.all([supervisor.activateRestoredDataset(request), supervisor.activateRestoredDataset(request)])
  assert.ok(results.every(result => result.state === 'active'))
  assert.deepEqual(calls, ['recordingBackups.activate', 'recordingBackups.overview', 'playback.stop', 'restart', 'recordingBackups.overview'])
  const replay = await supervisor.activateRestoredDataset(request)
  assert.equal(replay.state, 'active')
  assert.equal(calls.filter(call => call === 'restart').length, 1)
  assert.equal(calls.at(-1), 'recordingBackups.activate')
})

for (const state of ['failed', 'rolled-back'] as const) {
  test(`激活 ${state} 回执不会再次停止播放、重启或自动重试`, async t => {
    const { supervisor } = makeHarness(), request = activationRequest(), calls: string[] = []
    const result: RestoreActivationView = { id: randomUUID(), restoreJobId: request.restoreJobId, previousId: null, state, createdAt: new Date(0).toISOString(), contentIncluded: false, issue: state === 'failed' ? 'PREPARATION_FAILED' : 'BOOT_FAILED' }
    t.mock.method(supervisor, 'request', (async (command: string) => { calls.push(command); return result }) as typeof supervisor.request)
    t.mock.method(supervisor, 'restart', async () => { calls.push('restart') })
    assert.equal(typeof supervisor.activateRestoredDataset, 'function')
    assert.deepEqual(await supervisor.activateRestoredDataset(request), result)
    assert.deepEqual(calls, ['recordingBackups.activate'])
  })
}

test('恢复激活准备轮询有界，超时不会停止播放或重启', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  const { supervisor } = makeHarness(), request = activationRequest(), calls: string[] = []
  const view: RestoreActivationView = { id: randomUUID(), restoreJobId: request.restoreJobId, previousId: null, state: 'preparing', createdAt: new Date(0).toISOString() }
  t.mock.method(supervisor, 'request', (async (command: string) => { calls.push(command); return command === 'recordingBackups.activate' ? view : { roots: [], jobs: [], activations: [view] } }) as typeof supervisor.request)
  assert.equal(typeof supervisor.activateRestoredDataset, 'function')
  const pending = supervisor.activateRestoredDataset(request).then(() => undefined, error => error as { code: string })
  await new Promise(resolve => setImmediate(resolve)); t.mock.timers.tick(30 * 60_000 + 1)
  const failure = await pending
  assert.equal(failure?.code, 'TIMEOUT'); assert.ok(!calls.includes('playback.stop'))
})

test('显式重启可单次延长 ready 期限，普通启动仍使用原期限且参数必须有界', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const harness = makeHarness()
  const restarting = harness.supervisor.restart(undefined, { readyTimeoutMs: 100 }).then(() => undefined, error => error)
  await new Promise(resolve => setImmediate(resolve)); t.mock.timers.tick(40); await new Promise(resolve => setImmediate(resolve))
  const childrenBeforeReady = harness.children.length
  ready(harness.channels.at(-1)!); assert.equal(await restarting, undefined)
  const ordinary = makeHarness(), starting = ordinary.supervisor.start().then(() => undefined, error => error)
  t.mock.timers.tick(21); await new Promise(resolve => setImmediate(resolve)); t.mock.timers.tick(21)
  const failure = await starting
  t.mock.timers.reset(); await harness.supervisor.shutdown()
  assert.equal(childrenBeforeReady, 1, '延长 ready 的显式重启不应按旧期限提前杀进程')
  assert.equal(failure.code, 'TIMEOUT'); assert.equal(ordinary.children.length, 2)
  await assert.rejects(ordinary.supervisor.restart(undefined, { readyTimeoutMs: 30 * 60_000 + 1 }))
})

test('激活单航班拒绝同编号改参及其他命令，未确认请求不进入 Core', async t => {
  const { supervisor } = makeHarness(), request = activationRequest()
  let resolveActivation: (value: RestoreActivationView) => void = () => undefined, calls = 0
  t.mock.method(supervisor, 'request', (() => { calls += 1; return new Promise<RestoreActivationView>(resolve => { resolveActivation = resolve }) }) as typeof supervisor.request)
  await assert.rejects(supervisor.activateRestoredDataset({ ...request, userConfirmed: false } as unknown as ActivateRestoredDataset), error => error instanceof CoreIpcError && error.code === 'INVALID_IPC_REQUEST')
  const pending = supervisor.activateRestoredDataset(request)
  await assert.rejects(supervisor.activateRestoredDataset({ ...request, restoreJobId: randomUUID() }), error => error instanceof CoreIpcError && error.code === 'INVENTORY_CONFLICT')
  await assert.rejects(supervisor.activateRestoredDataset({ ...request, commandId: randomUUID() }), error => error instanceof CoreIpcError && error.code === 'INVENTORY_CONFLICT')
  resolveActivation({ id: randomUUID(), restoreJobId: request.restoreJobId, previousId: null, state: 'active', createdAt: new Date(0).toISOString(), contentIncluded: false })
  await pending; assert.equal(calls, 1)
})

test('激活停止播放失败时不重启 Core，保留当前工作库', async t => {
  const { supervisor } = makeHarness(), request = activationRequest(), calls: string[] = []
  t.mock.method(supervisor, 'request', (async (command: string) => {
    calls.push(command)
    if (command === 'playback.stop') throw new CoreIpcError('TIMEOUT', '合成停止播放超时')
    return { id: randomUUID(), restoreJobId: request.restoreJobId, previousId: null, state: 'prepared', createdAt: new Date(0).toISOString(), contentIncluded: false }
  }) as typeof supervisor.request)
  t.mock.method(supervisor, 'restart', async () => { calls.push('restart') })
  await assert.rejects(supervisor.activateRestoredDataset(request), error => error instanceof CoreIpcError && error.code === 'TIMEOUT')
  assert.deepEqual(calls, ['recordingBackups.activate', 'playback.stop'])
})
