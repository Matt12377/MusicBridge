import assert from 'node:assert/strict'
import test, { after } from 'node:test'
import { randomUUID } from 'node:crypto'
import { captureDatasetNameProviderRequest, captureDatasetNameProviderReply, assertDatasetNameProviderReplyForRequest, datasetWorkbenchMeta, datasetWorkbenchFrames, type DatasetWorkbenchFrame } from '../../../packages/bridge-core/src/collection/dataset-owner-protocol.js'
import { captureSourceWritesLyricsGrantRequest, captureSourceWritesLyricsGrantReply, assertSourceWritesLyricsGrantReplyForRequest, captureSourceWritesLyricsVerifyRequest, captureSourceWritesLyricsVerifyReply, captureSourceWorkbenchDirectoryRequest, captureSourceWorkbenchDirectoryReply, assertSourceWorkbenchDirectoryReplyForRequest, type SourceWritesLyricsGrantRequest, type SourceWritesLyricsGrantReply, type SourceWritesLyricsVerifyRequest } from '../../../packages/bridge-core/src/collection/source-writes-authority.js'
import { lyricsPhysicalDigest, type LocalLyricsPhysicalBinding } from '../../../packages/bridge-core/src/library/lyrics-source-format.js'
import { PerformanceTraceRecorder } from '@music-bridge/contracts'
import { createCoreShutdownReceipt } from '../../../packages/bridge-core/src/shared/core-shutdown-receipt.js'
import { readLibraryOperationLine, type LibraryOperationEvent } from '../../../packages/bridge-core/src/shared/library-operation-log.js'

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
  autoShutdownReply = true

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
    const request = message as { version?: unknown; id?: unknown; command?: unknown }
    // 仅受控Core关闭回执；ACK不代表exit，旧kill无exit屏障仍由Child负例核。
    if (this.autoShutdownReply && !this.closed && request.version === IPC_VERSION && request.command === 'core.shutdown' && typeof request.id === 'string') {
      queueMicrotask(() => this.receive({ version: IPC_VERSION, id: request.id, ok: true, result: { stopped: true } }))
    }
  }

  receive(message: unknown): void {
    this.listener?.({ data: message })
  }
}

class FakeChild implements CoreChildProcess {
  readonly posted: unknown[] = []
  private exitListeners: Array<(code: number) => void> = []
  killed = false

  postMessage(message: unknown): void {
    this.posted.push(message)
  }

  once(event: 'exit', listener: (code: number) => void): void {
    assert.equal(event, 'exit')
    this.exitListeners.push(listener)
  }

  kill(): boolean {
    this.killed = true
    this.exit(0)
    return true
  }

  exit(code: number): void {
    const listeners = this.exitListeners.splice(0)
    for (const listener of listeners) listener(code)
  }
}

function makeHarness(requestTimeoutMs = 20) {
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
    requestTimeoutMs,
    startupTimeoutMs: 20,
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

async function shutdownReceiptHarness(t: test.TestContext) {
  const h = makeHarness(2000), logs: LibraryOperationEvent[] = []
  t.mock.method(console, 'info', (line: string) => { const event = readLibraryOperationLine(line); if (event) logs.push(event) })
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_800_000_000_000 })
  const starting = h.supervisor.start(); ready(h.channels[0]!); await starting
  const port = h.channels[0]!.port2, child = h.children[0]!
  port.autoShutdownReply = false
  let confirmed = 0, failAck = false
  const utility = { postMessage: (message: unknown) => port.receive(message) }
  const receipt = createCoreShutdownReceipt(utility, () => { confirmed++ })
  const post = port.postMessage.bind(port)
  t.mock.method(port, 'postMessage', (message: unknown) => {
    const ack = (message as { type?: unknown }).type === 'musicbridge.core-shutdown-received'
    if (ack && failAck) throw new Error('合成ACK投递失败 file:///private/fixture-secret')
    post(message)
    if (ack) receipt.receive(utility, message)
  })
  const closings: Promise<{ ok: true } | { ok: false; code: string }>[] = []
  const close = () => {
    const closing = h.supervisor.shutdown().then(() => ({ ok: true as const }), error => ({ ok: false as const, code: error instanceof CoreIpcError ? error.code : 'OTHER' }))
    closings.push(closing); return closing
  }
  const turn = async () => { for (let pass = 0; pass < 16; pass++) await Promise.resolve() }
  t.after(async () => { child.exit(1); await Promise.all(closings); t.mock.timers.reset() })
  return { ...h, port, child, logs, close, turn, confirmed: () => confirmed, failAck: () => { failAck = true },
    requests: () => port.sent.filter(message => (message as { command?: unknown }).command === 'core.shutdown') as { id: string }[],
    acks: () => port.sent.filter(message => (message as { type?: unknown }).type === 'musicbridge.core-shutdown-received'),
    reply: (id: string) => receipt.postSuccess(id, { version: 1, id, ok: true, result: { stopped: true } }),
    tick: async (ms: number) => { t.mock.timers.tick(ms); await turn() },
    slot: () => (h.supervisor as unknown as { shutdownReceipt?: unknown }).shutdownReceipt,
  }
}

test('专用关闭期限：普通RPC仍两秒，2.143秒的原成功回执获ACK但实际exit前不成功', async t => {
  const h = await shutdownReceiptHarness(t)
  const ordinary = h.supervisor.request('core.getHealth', {}).then(() => ({ ok: true }), error => ({ ok: false, code: error.code }))
  await h.tick(2001); assert.deepEqual(await ordinary, { ok: false, code: 'TIMEOUT' })
  let settled = false; const closing = h.close().then(value => { settled = true; return value }); await h.turn()
  const request = h.requests()[0]!; await h.tick(2143); assert.equal(settled, false)
  h.reply(request.id); await h.turn()
  assert.equal(h.acks().length, 1); assert.equal(h.confirmed(), 1); assert.equal(settled, false)
  h.child.exit(0); assert.deepEqual(await closing, { ok: true }); assert.equal(h.child.killed, false); assert.equal(h.slot(), undefined)
})

test('专用关闭期限：三十秒有界，重复Quit复用原ID，迟到正确ACK不升级原TIMEOUT', async t => {
  const h = await shutdownReceiptHarness(t), closing = h.close(); await h.turn(); const request = h.requests()[0]!
  await h.tick(30_001); assert.deepEqual(await closing, { ok: false, code: 'TIMEOUT' })
  assert.equal((h.supervisor as unknown as { pending: Map<string, unknown> }).pending.size, 0, '不能无限保留普通pending')
  assert.deepEqual(await h.close(), { ok: false, code: 'TIMEOUT' }); assert.equal(h.requests().length, 1)
  h.reply(request.id); await h.turn(); assert.equal(h.acks().length, 1); assert.equal(h.confirmed(), 1)
  h.port.receive({ version: 1, id: request.id, ok: true, result: { stopped: true } }); await h.turn(); assert.equal(h.acks().length, 1)
  assert.deepEqual(h.logs.filter(event => event.action === 'shutdown.supervisor-late-receipt').map(event => [event.state, event.code]), [['complete', 'LATE_RECEIPT_SENT']])
  h.child.exit(0); await h.turn(); assert.equal(h.slot(), undefined); assert.deepEqual(await closing, { ok: false, code: 'TIMEOUT' })
})

test('专用关闭期限：迟到错误、无效成功、异ID和旧epoch不能获得ACK或正常退出资格', async t => {
  const h = await shutdownReceiptHarness(t), closing = h.close(); await h.turn(); const request = h.requests()[0]!
  await h.tick(30_001); assert.deepEqual(await closing, { ok: false, code: 'TIMEOUT' })
  for (const message of [{ version: 1, id: 'foreign-id', ok: true, result: { stopped: true } },
    { version: 1, id: request.id, ok: true, result: {} }, { version: 1, id: request.id, ok: true, result: { stopped: false } },
    { version: 1, id: request.id, ok: false, error: { code: 'NOT_READY', message: '合成关闭失败' } }]) h.port.receive(message)
  await h.turn(); assert.equal(h.acks().length, 0); assert.equal(h.confirmed(), 0)
  ;(h.supervisor as unknown as { startupGeneration: number }).startupGeneration++
  h.reply(request.id); await h.turn(); assert.equal(h.acks().length, 0); assert.equal(h.confirmed(), 0)
  assert.equal(h.logs.some(event => event.action === 'shutdown.supervisor-late-receipt'), false)
})

for (const late of [false, true]) test(`专用关闭期限：${late ? '迟到' : '正常'}ACK投递失败保原拒绝且不允许Core正常退出`, async t => {
  const h = await shutdownReceiptHarness(t), closing = h.close(); await h.turn(); const request = h.requests()[0]!
  if (late) await h.tick(30_001)
  h.failAck(); h.reply(request.id); await h.turn()
  assert.equal(h.acks().length, 0); assert.equal(h.confirmed(), 0); assert.equal(h.child.killed, false)
  assert.deepEqual(await closing, { ok: false, code: late ? 'TIMEOUT' : 'INTERNAL_ERROR' })
  const diagnostics = h.logs.filter(event => event.action === 'shutdown.supervisor-late-receipt')
  assert.deepEqual(diagnostics.map(event => [event.state, event.code]), late ? [['error', 'LATE_RECEIPT_POST_FAILED']] : [])
  assert.doesNotMatch(JSON.stringify(h.logs), /fixture-secret|file:\/\/|private/u)
})

test('专用关闭期限：原Core明确失败不ACK，实际exit清唯一slot后旧回执不复活', async t => {
  const h = await shutdownReceiptHarness(t), closing = h.close(); await h.turn(); const request = h.requests()[0]!
  h.port.receive({ version: 1, id: request.id, ok: false, error: { code: 'NOT_READY', message: '合成关闭未确认' } }); await h.turn()
  assert.deepEqual(await closing, { ok: false, code: 'NOT_READY' }); assert.equal(h.acks().length, 0); assert.equal(h.confirmed(), 0)
  h.child.exit(1); h.port.receive({ version: 1, id: request.id, ok: true, result: { stopped: true } }); await h.turn()
  assert.equal(h.slot(), undefined); assert.equal(h.acks().length, 0); assert.deepEqual(await closing, { ok: false, code: 'NOT_READY' })
})

test('关闭回执确认：只有已核验的原成功回执收到确认，实际exit前shutdown仍等待', async () => {
  const h = makeHarness(), starting = h.supervisor.start()
  ready(h.channels[0]!); await starting
  const port = h.channels[0]!.port2; port.autoShutdownReply = false
  let settled = false
  const closing = h.supervisor.shutdown().then(() => { settled = true })
  const request = port.sent.find(value => (value as { command?: string }).command === 'core.shutdown') as { id: string }
  assert.ok(request)
  port.receive({ version: 1, id: request.id, ok: true, result: { stopped: true } })
  await Promise.resolve()
  assert.deepEqual(port.sent.filter(value => (value as { type?: string }).type === 'musicbridge.core-shutdown-received'),
    [{ version: 1, type: 'musicbridge.core-shutdown-received', requestId: request.id }])
  assert.equal(settled, false)
  h.children[0]!.exit(0); await closing
  assert.equal(settled, true)
})

for (const invalid of [false, true]) test(`关闭回执确认：${invalid ? '无效成功结果' : '关闭失败'}不发送确认或冒充静止`, async () => {
  const h = makeHarness(), starting = h.supervisor.start()
  ready(h.channels[0]!); await starting
  const port = h.channels[0]!.port2; port.autoShutdownReply = false
  const closing = h.supervisor.shutdown(), rejection = assert.rejects(closing, CoreIpcError)
  const request = port.sent.find(value => (value as { command?: string }).command === 'core.shutdown') as { id: string }
  port.receive(invalid ? { version: 1, id: request.id, ok: true, result: {} }
    : { version: 1, id: request.id, ok: false, error: { code: 'NOT_READY', message: '合成关闭失败' } })
  await rejection
  assert.equal(port.sent.some(value => (value as { type?: string }).type === 'musicbridge.core-shutdown-received'), false)
  assert.equal(h.children[0]!.killed, false)
  h.children[0]!.exit(1)
})

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

  assert.deepEqual(lifecycle, ['spawn', 'ready', 'exit', 'restart', 'spawn', 'ready', 'exit', 'stopped'])
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

test('CoreSupervisor can restart with a new explicitly supplied Core environment', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
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
  // 先消费原关闭ACK，再仅推进旧child的20ms退出等待；新child仍须在原启动期限内ready。
  await new Promise((resolve) => setImmediate(resolve))
  t.mock.timers.tick(20)
  await new Promise((resolve) => setImmediate(resolve))
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

  const closing = harness.supervisor.shutdown()
  await new Promise((resolve) => setImmediate(resolve))
  t.mock.timers.tick(20)
  await closing
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

test('显式重启可单次延长启动期限，后续普通启动不继承override且参数必须有界', async t => {
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

test('原生授权与激活请求把编辑时dataset scope送到Core而不改写', async t => {
  const harness = makeHarness(), starting = harness.supervisor.start()
  await new Promise(resolve => setImmediate(resolve)); ready(harness.channels[0]!); await starting
  const dataset = randomUUID(), request = { commandId: randomUUID(), restoreJobId: randomUUID(), expectedActiveId: null, userConfirmed: true as const, stopPlaybackConfirmed: true as const }
  const response = harness.supervisor.requestInternal('recordingBackups.activationReceipt', request, dataset)
  const sent = harness.channels[0]!.port2.sent.at(-1) as { id: string; expectedDatasetId?: string }
  harness.channels[0]!.port2.receive({ version: IPC_VERSION, id: sent.id, ok: true, result: { activation: null } })
  assert.deepEqual(await response, { activation: null }); assert.equal(sent.expectedDatasetId, dataset)
  const calls: unknown[][] = []
  t.mock.method(harness.supervisor, 'request', async (...args: unknown[]) => { calls.push(args); return { id: randomUUID(), restoreJobId: request.restoreJobId, previousId: null, state: 'failed', issue: 'PREPARATION_FAILED', createdAt: new Date().toISOString() } as never })
  await harness.supervisor.activateRestoredDataset(request, dataset)
  assert.deepEqual(calls[0], ['recordingBackups.activate', request, dataset])
  await harness.supervisor.shutdown()
})

test('outbox包装保留归档长操作预算，普通控制请求仍按短期限', async () => {
  const harness = makeHarness(), starting = harness.supervisor.start()
  await new Promise(resolve => setImmediate(resolve)); ready(harness.channels[0]!); await starting
  const id = randomUUID(); let settled = false
  const pending = harness.supervisor.request('commandOutbox.execute', { datasetId: id, command: 'recordingArchive.initialize', payload: { commandId: id, id, userConfirmed: true } }).then(() => { settled = true }, () => { settled = true })
  await new Promise(resolve => setTimeout(resolve, 45))
  const early = settled
  harness.children[0]!.exit(1); await pending
  // 本条仅测deadline；清理重启子进程不能把timeout判断混在一起。
  await harness.supervisor.shutdown()
  assert.equal(early, false, 'outbox内部归档操作不能退回20ms测试短期限')
})


for (const method of ['status', 'inspect', 'cancelRead', 'start', 'get', 'stop'] as const) {
  test(`recordingReplica.${method} 只有归档核验使用长期限，会话派发和停止保持短期限`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const harness = makeHarness(), starting = harness.supervisor.start(); ready(harness.channels[0]!); await starting
    const id = randomUUID(), payload = method === 'status' ? {} : method === 'inspect' ? { readId: id, recordingId: id }
      : method === 'cancelRead' ? { readId: id } : method === 'start' ? { runId: id, recordingId: id, target: 'actual-execution', side: 'A', expectedFingerprint: 'a'.repeat(64), userConfirmed: true } : { runId: id }
    let settled = false
    const pending = harness.supervisor.request(`recordingReplica.${method}`, payload as never, randomUUID()).then(() => { settled = true; return undefined }, error => { settled = true; return error })
    t.mock.timers.tick(45); await new Promise<void>(resolve => setImmediate(resolve)); const early = settled
    if (method === 'inspect') t.mock.timers.tick(35 * 60_000)
    const result = await pending; t.mock.timers.reset(); await harness.supervisor.shutdown()
    assert.equal(early, method !== 'inspect'); assert.equal(result.code, 'TIMEOUT')
  })
}

for (const command of ['recordingOutput.check', 'recordingOutput.status', 'recordingOutput.cancel'] as const) {
  test(`${command} 只有完整文件检查使用长期限，状态和取消保留短期限`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const harness = makeHarness(), starting = harness.supervisor.start(); ready(harness.channels[0]!); await starting
    const runId = randomUUID(), payload = command === 'recordingOutput.check' ? { runId, planVersionId: randomUUID(), side: 'A' } : command === 'recordingOutput.cancel' ? { runId } : {}
    let settled = false
    const pending = harness.supervisor.request(command, payload as never).then(() => { settled = true; return undefined }, error => { settled = true; return error })
    t.mock.timers.tick(45); await new Promise<void>(resolve => setImmediate(resolve)); const early = settled
    if (command === 'recordingOutput.check') t.mock.timers.tick(35 * 60_000)
    const result = await pending; t.mock.timers.reset(); await harness.supervisor.shutdown()
    assert.equal(early, command !== 'recordingOutput.check'); assert.equal(result.code, 'TIMEOUT')
  })
}

for (const command of ['recordingPlans.preview', 'recordingPlans.freeze', 'recordingPlans.preflight'] as const) {
  test(`${command} 及outbox冻结使用有界文件核对期限`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const harness = makeHarness(), starting = harness.supervisor.start(); ready(harness.channels[0]!); await starting;
    const id = randomUUID(), selection = { assetId: id, archiveOperationId: id, outputSelection: { endpointId: 'synthetic-device', selectionGeneration: randomUUID() } };
    const payload = command === 'recordingPlans.preview' ? { readId: id, selection } : command === 'recordingPlans.freeze' ? { commandId: id, selection, proposalFingerprint: 'a'.repeat(64), userConfirmed: true } : { readId: id, planVersionId: id };
    let settled = false;
    const pending = (command === 'recordingPlans.freeze'
      ? harness.supervisor.request('commandOutbox.execute', { datasetId: id, command, payload: payload as never })
      : harness.supervisor.request(command, payload as never)).then(() => { settled = true; return undefined }, error => { settled = true; return error });
    t.mock.timers.tick(45); await Promise.resolve(); const timedOutEarly = settled;
    const sent = harness.channels[0]!.port2.sent.at(-1) as { id: string };
    harness.channels[0]!.port2.receive({ version: 1, id: sent.id, ok: false, error: { code: 'INVALID_IPC_REQUEST', message: '合成结束文件核对' } });
    const result = await pending; t.mock.timers.reset(); await harness.supervisor.shutdown();
    assert.equal(timedOutEarly, false); assert.equal(result.code, 'INVALID_IPC_REQUEST');
  });
}

function startupHarness(options: { startupTimeoutMs?: number; onReady?: (client: import('../src/main/core-supervisor.js').CoreStartupClient) => Promise<void> | void } = {}) {
  const base = makeHarness(), events: string[] = []
  const supervisor = new CoreSupervisor({ entryPath: '/tmp/core-entry.js', cwd: '/tmp', dependencies: base.dependencies, ...options, onLifecycle: event => events.push(event.event), onEvent: event => events.push(event.event) })
  return { ...base, supervisor, events }
}
const flushStartup = () => new Promise<void>(resolve => setImmediate(resolve))
function startupDeferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }

test('普通启动独立60秒预算，普通IPC仍两秒且启动参数只能收紧', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const h = startupHarness(), pending = h.supervisor.start()
  t.mock.timers.tick(2_001); await flushStartup()
  assert.equal(h.children.length, 1); assert.equal(h.children[0]!.killed, false)
  ready(h.channels[0]!); await pending
  const request = h.supervisor.request('core.ping', {}).catch(error => error)
  t.mock.timers.tick(2_001); assert.equal((await request).code, 'TIMEOUT')
  for (const startupTimeoutMs of [0, 60_001, Infinity, 1.5]) assert.throws(() => startupHarness({ startupTimeoutMs }))
})

test('已ready的Core重复start保持幂等，不误判其仍在运行的child为旧进程', async () => {
  const h = startupHarness(), first = h.supervisor.start(); ready(h.channels[0]!); await first
  await h.supervisor.start()
  assert.equal(h.children.length, 1)
  assert.equal(h.supervisor.status, 'ready')
  await h.supervisor.shutdown()
})

test('启动失败后旧Core拒绝退出时不得fork第二个writer，迟到exit也不自动重试', async () => {
  const h = startupHarness({ startupTimeoutMs: 20 }), pending = h.supervisor.start().catch(error => error)
  h.children[0]!.kill = () => { h.children[0]!.killed = true; return true }
  const failure = await pending
  assert.equal(failure.code, 'NOT_READY')
  assert.equal(h.children.length, 1)
  assert.equal(h.supervisor.status, 'failed')
  await assert.rejects(h.supervisor.start(), { code: 'NOT_READY' })
  h.children[0]!.exit(0); await flushStartup()
  assert.equal(h.children.length, 1)
})

test('shutdown/restart在kill无exit时保持旧writer屏障，不能启动新Core', async () => {
  const h = startupHarness(), started = h.supervisor.start(); ready(h.channels[0]!); await started
  h.children[0]!.kill = () => { h.children[0]!.killed = true; return true }
  await assert.rejects(h.supervisor.restart(), { code: 'NOT_READY' })
  assert.equal(h.children.length, 1)
  assert.equal(h.supervisor.status, 'failed')
  h.children[0]!.exit(0); await flushStartup()
  assert.equal(h.children.length, 1)
})

test('onReady未完成时重复start共等、普通IPC及ready健康事件不能提前放行', async () => {
  const gate = startupDeferred(), h = startupHarness({ onReady: () => gate.promise }), first = h.supervisor.start()
  ready(h.channels[0]!); await flushStartup()
  let secondDone = false; const second = h.supervisor.start().then(() => { secondDone = true })
  await flushStartup()
  assert.equal(secondDone, false); assert.equal(h.supervisor.status, 'starting')
  await assert.rejects(h.supervisor.request('core.ping', {}), { code: 'NOT_READY' })
  h.channels[0]!.port2.receive({ version: 1, event: 'core.health', payload: { state: { runtime: 'ready', roon: 'disconnected', provider: 'missing', activeStreamCount: 0, activePlaybackPresent: false } } })
  assert.equal(h.events.includes('core.ready'), false); assert.equal(h.events.includes('core.health'), false)
  gate.resolve(); await first; await second
  assert.equal(h.supervisor.status, 'ready'); assert.equal(h.events.filter(v => v === 'core.ready').length, 1)
})

test('总启动deadline覆盖恢复hook，旧hook迟到与旧client不能使重试跨代ready', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const gates = [startupDeferred(), startupDeferred()], clients: import('../src/main/core-supervisor.js').CoreStartupClient[] = []
  const h = startupHarness({ startupTimeoutMs: 40, onReady: client => { clients.push(client); return gates[clients.length - 1]!.promise } })
  const pending = h.supervisor.start().catch(error => error)
  ready(h.channels[0]!); await flushStartup(); t.mock.timers.tick(41); await flushStartup()
  assert.equal(h.children.length, 2); assert.equal(h.children[0]!.killed, true)
  ready(h.channels[1]!); await flushStartup(); gates[0]!.resolve(); await flushStartup()
  assert.equal(h.supervisor.status, 'starting'); assert.equal(h.events.includes('ready'), false)
  await assert.rejects(clients[0]!.request('core.ping', {}), { code: 'NOT_READY' })
  t.mock.timers.tick(41); assert.equal((await pending).code, 'TIMEOUT')
  gates[1]!.resolve(); await flushStartup(); assert.equal(h.supervisor.status, 'failed'); assert.equal(h.events.includes('ready'), false)
})

test('同步throw恢复hook不逸出message listener且不提前显示ready', async () => {
  const h = startupHarness({ onReady: () => { throw new Error('/private/synthetic-hook') } }), pending = h.supervisor.start().catch(error => error)
  assert.doesNotThrow(() => ready(h.channels[0]!)); await flushStartup()
  assert.equal(h.children.length, 2); assert.doesNotThrow(() => ready(h.channels[1]!))
  const error = await pending; assert.equal(error.code, 'INTERNAL_ERROR'); assert.doesNotMatch(error.message, /private/)
  assert.equal(h.supervisor.status, 'failed'); assert.equal(h.events.includes('ready'), false); assert.equal(h.events.includes('core.ready'), false)
})

test('私有启动client可恢复安全消息，hook后可供worker用但退出即失效', async () => {
  let client!: import('../src/main/core-supervisor.js').CoreStartupClient
  const h = startupHarness({ onReady: async value => { client = value; assert.deepEqual(await value.request('core.ping', {}), { pong: true }) } }), first = h.supervisor.start()
  ready(h.channels[0]!); await flushStartup()
  const sent = h.channels[0]!.port2.sent.at(-1) as { id: string }; assert.ok(sent)
  h.channels[0]!.port2.receive({ version: 1, id: sent.id, ok: true, result: { pong: true } }); await first
  const worker = client.request('core.ping', {}), next = h.channels[0]!.port2.sent.at(-1) as { id: string }
  h.channels[0]!.port2.receive({ version: 1, id: next.id, ok: true, result: { pong: true } }); await worker
  const old = client; h.children[0]!.exit(1); await flushStartup()
  await assert.rejects(old.request('core.ping', {}), { code: 'NOT_READY' })
  ready(h.channels[1]!); await flushStartup(); const request = h.channels[1]!.port2.sent.at(-1) as { id: string }
  h.channels[1]!.port2.receive({ version: 1, id: request.id, ok: true, result: { pong: true } }); await flushStartup()
  assert.equal(h.supervisor.status, 'ready'); await assert.rejects(old.requestInternal('auth.verifyCredential', { credential: 'synthetic' }), { code: 'NOT_READY' })
})

test('hook中退出只由当前start重试一次，不重复并发fork', async () => {
  const gate = startupDeferred(), h = startupHarness({ onReady: () => gate.promise }), pending = h.supervisor.start()
  ready(h.channels[0]!); await flushStartup(); h.children[0]!.exit(1); await flushStartup()
  assert.equal(h.children.length, 2); ready(h.channels[1]!); gate.resolve(); await pending
  assert.equal(h.supervisor.status, 'ready'); assert.equal(h.children.length, 2)
})

test('hook中shutdown立即撤销client并终止start，不因迟到完成或失败重启', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const gate = startupDeferred(); let client!: import('../src/main/core-supervisor.js').CoreStartupClient
  const h = startupHarness({ onReady: value => { client = value; return gate.promise } }), starting = h.supervisor.start().catch(error => error)
  ready(h.channels[0]!); await flushStartup(); const closing = h.supervisor.shutdown(); await flushStartup()
  await assert.rejects(client.request('core.ping', {}), { code: 'NOT_READY' })
  t.mock.timers.tick(2_001); await flushStartup(); t.mock.timers.tick(251); await closing
  const outcome = await starting; assert.equal(outcome.code, 'NOT_READY'); gate.resolve(); await flushStartup()
  assert.equal(h.children.length, 1); assert.equal(h.supervisor.status, 'stopped')
})


test('撤销启动client不吞正常shutdown回执，Core自行code0退出不需kill', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const h = startupHarness(), starting = h.supervisor.start(); ready(h.channels[0]!); await starting
  let acknowledged = false
  h.channels[0]!.port2.autoShutdownReply = false
  // Root591由关闭专用上下文进入原sendRequest；只观察原Promise，不改route/参数/ACK。
  const sender = h.supervisor as unknown as { sendRequest(...args: unknown[]): Promise<unknown> }, send = sender.sendRequest.bind(h.supervisor)
  t.mock.method(sender, 'sendRequest', (...args: unknown[]) => {
    const original = send(...args)
    if (args[0] === 'core.shutdown') void original.then(() => { acknowledged = true }, () => {})
    return original
  })
  const shutdown = h.supervisor.shutdown(); await flushStartup()
  const sent = h.channels[0]!.port2.sent.at(-1) as { id: string; command: string }; assert.equal(sent.command, 'core.shutdown')
  h.channels[0]!.port2.receive({ version: 1, id: sent.id, ok: true, result: { stopped: true } })
  await flushStartup(); assert.equal(acknowledged, true, '撤销startup capability后仍需收取shutdown协议回执')
  h.children[0]!.exit(0)
  let done = false; void shutdown.then(() => { done = true }); await flushStartup()
  assert.equal(done, true, '正常shutdown回执和exit后应立即完成，无需等请求超时')
  assert.equal(h.children[0]!.killed, false); assert.equal(h.supervisor.status, 'stopped')
})

test('自动崩溃重启的hook pending期间start复用重启，不并发fork', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const gate = startupDeferred(); let hooks = 0
  const h = startupHarness({ onReady: () => ++hooks === 1 ? undefined : gate.promise })
  const initial = h.supervisor.start(); ready(h.channels[0]!); await initial
  h.children[0]!.exit(1); await flushStartup(); ready(h.channels[1]!); await flushStartup()
  let done = false; const repeated = h.supervisor.start().then(() => { done = true })
  await flushStartup(); assert.equal(h.children.length, 2); assert.equal(done, false)
  gate.resolve(); await repeated; assert.equal(h.supervisor.status, 'ready')
})

test('复用自动重启的start在恢复失败时拒绝，不把failed当成功完成', async () => {
  let hooks = 0
  const h = startupHarness({ onReady: () => { if (++hooks > 1) throw new Error('合成恢复失败') } })
  const initial = h.supervisor.start(); ready(h.channels[0]!); await initial
  h.children[0]!.exit(1); await flushStartup()
  const repeated = h.supervisor.start().then(() => 'unexpected-success', error => error.code)
  ready(h.channels[1]!); assert.equal(await repeated, 'INTERNAL_ERROR'); assert.equal(h.supervisor.status, 'failed')
})

for (const command of ['roon.library.play', 'roon.library.queue', 'roon.library.albums'] as const) {
  test(`${command} 区分播放操作和读库预算，且保持有界超时`, async t => {
    const harness = makeHarness(), starting = harness.supervisor.start()
    await new Promise(resolve => setImmediate(resolve)); ready(harness.channels[0]!); await starting
    t.mock.timers.enable({ apis: ['setTimeout'] })
    let settled = false
    const payload = command === 'roon.library.albums' ? { page: { offset: 0, limit: 20 } }
      : { reference: `musicbridge-v2-entity-${randomUUID()}`, zoneId: 'zone-1' }
    const pending = harness.supervisor.request(command, payload as never).catch(error => { settled = true; return error })
    t.mock.timers.tick(10_001)
    await new Promise(resolve => setImmediate(resolve))
    const timedOutAtReadDeadline = settled
    t.mock.timers.tick(60_000)
    const result = await pending
    t.mock.timers.reset()
    await harness.supervisor.shutdown()
    assert.equal(timedOutAtReadDeadline, command === 'roon.library.albums')
    assert.equal(result.code, 'TIMEOUT')
  })
}

test('正式 Supervisor RPC 保留 Renderer trace 并以实际请求 UUID 关联响应', async () => {
  const harness = makeHarness()
  const performance = new PerformanceTraceRecorder({ component: 'main', enabled: true })
  const parent = performance.context()!
  const supervisor = new CoreSupervisor({ entryPath: '/synthetic/core.js', cwd: '/synthetic', dependencies: harness.dependencies,
    requestTimeoutMs: 100, startupTimeoutMs: 100, performance, performanceContext: () => parent })
  const starting = supervisor.start(); ready(harness.channels[0]!); await starting
  const request = supervisor.request('core.ping', {})
  const sent = harness.channels[0]!.port2.sent.at(-1) as { id: string; performanceTrace: { traceId: string; requestId: string; parentRequestId: string } }
  assert.deepEqual(sent.performanceTrace, { traceId: parent.traceId, requestId: sent.id, parentRequestId: parent.requestId })
  harness.channels[0]!.port2.receive({ version: 1, id: sent.id, ok: true, result: { pong: true } })
  assert.deepEqual(await request, { pong: true })
  assert.equal(performance.snapshot().inflightCount, 0)
  assert.equal(performance.snapshot().gauges.activeRequestCount, 0)
  assert.equal(performance.snapshot().events.at(-1)?.outcome, 'ok')
  await assert.rejects(supervisor.request('core.ping', { invalid: true } as never))
  assert.equal(performance.snapshot().inflightCount, 0)
  await supervisor.shutdown()
})

for (const enabled of [false, true]) {
  test(`Supervisor 诊断上下文异常不影响业务，enabled=${enabled}`, async () => {
    const harness = makeHarness()
    let diagnosticCalls = 0
    const performance = new PerformanceTraceRecorder({ component: 'main', enabled })
    const supervisor = new CoreSupervisor({ entryPath: '/synthetic/core.js', cwd: '/synthetic', dependencies: harness.dependencies,
      requestTimeoutMs: 100, startupTimeoutMs: 100, performance,
      performanceContext: () => { diagnosticCalls++; throw new Error('合成诊断故障') } })
    const starting = supervisor.start(); ready(harness.channels[0]!); await starting
    const pending = supervisor.request('core.ping', {})
    const request = harness.channels[0]!.port2.sent.at(-1) as { id: string }
    harness.channels[0]!.port2.receive({ version: 1, id: request.id, ok: true, result: { pong: true } })
    assert.deepEqual(await pending, { pong: true })
    assert.equal(diagnosticCalls, enabled ? 1 : 0)
    assert.equal(performance.snapshot().inflightCount, 0)
    if (enabled) assert.equal(performance.snapshot().gauges.activeRequestCount, 0)
    await supervisor.shutdown()
  })
}

test('MBP-002：Main 读取取消立即结束等待并通知 Core，迟到结果不二次落定', async () => {
  const harness = makeHarness(); const starting = harness.supervisor.start(); ready(harness.channels[0]!); await starting;
  const controller = new AbortController(); const pending = harness.supervisor.request('library.search', { query: 'x', page: { offset: 0, limit: 24 } }, undefined, { signal: controller.signal, deadlineAtMs: Date.now() + 500 });
  const rejected = assert.rejects(pending, error => error instanceof CoreIpcError && error.code === 'CANCELLED'); const port = harness.channels[0]!.port2; const sent = port.sent.at(-1) as { id: string; readContext: { deadlineAtMs: number } };
  assert.ok(sent.readContext.deadlineAtMs <= Date.now() + 500); controller.abort(); await rejected; assert.deepEqual(port.sent.at(-1), { version: 1, kind: 'library.read.cancel', id: sent.id });
  port.receive({ version: 1, id: sent.id, ok: true, result: { items: [], offset: 0, limit: 24, total: 0, hasMore: false } }); await harness.supervisor.shutdown();
});
test('MBP-002：Main 拒绝预先取消与写命令读取上下文，均零派发', async () => {
  const harness = makeHarness(); const starting = harness.supervisor.start(); ready(harness.channels[0]!); await starting; const controller = new AbortController(); controller.abort(); const port = harness.channels[0]!.port2; const count = port.sent.length;
  await assert.rejects(harness.supervisor.request('library.search', { query: 'x', page: { offset: 0, limit: 24 } }, undefined, { signal: controller.signal }), error => error instanceof CoreIpcError && error.code === 'CANCELLED');
  await assert.rejects(harness.supervisor.request('playback.stop', {}, undefined, { deadlineAtMs: Date.now() + 100 }), error => error instanceof CoreIpcError && error.code === 'INVALID_IPC_REQUEST'); assert.equal(port.sent.length, count); await harness.supervisor.shutdown();
});

test('MBP-002：Main 期限已到即拒绝成功回包，不依赖超时 timer 已执行', async t => {
  const harness = makeHarness();
  const starting = harness.supervisor.start(); ready(harness.channels[0]!); await starting;
  t.after(() => harness.supervisor.shutdown());
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const pending = harness.supervisor.request('library.search', { query: 'deadline', page: { offset: 0, limit: 24 } }, undefined, { deadlineAtMs: now + 100 });
  const rejected = assert.rejects(pending, error => error instanceof CoreIpcError && error.code === 'TIMEOUT');
  const port = harness.channels[0]!.port2, sent = port.sent.at(-1) as { id: string };
  now += 101;
  port.receive({ version: 1, id: sent.id, ok: true, result: { items: [], offset: 0, limit: 24, total: 0, hasMore: false } });
  await rejected;
  assert.deepEqual(port.sent.at(-1), { version: 1, kind: 'library.read.cancel', id: sent.id });
});

// 469 只验证真实 Supervisor 接收链与原 typed 回声；端口/child/producer 为受控组件。
// 这里没有真实 Native/FD/HTTP/SQL 或全 Electron 退出资格。
function warm469Deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}
function warm469Denied(q: SourceWritesLyricsGrantRequest): SourceWritesLyricsGrantReply {
  return captureSourceWritesLyricsGrantReply({ version: 1, type: 'lyrics-source-grant-reply', purpose: 'LYRICS', requestId: q.requestId, sequence: q.sequence, revision: q.revision, authorityId: q.authorityId,
    requestSha256: lyricsPhysicalDigest(q), binding: q.binding, bindingSha256: q.bindingSha256, decision: 'rejected', nonce: null, validUntilMs: null })
}
async function warm469Harness(t: import('node:test').TestContext, options: {
  withoutOwnerPin?: boolean
  produce?: (q: SourceWritesLyricsGrantRequest, context: { signal: AbortSignal; deadlineAtMs: number }) => Promise<SourceWritesLyricsGrantReply>
} = {}) {
  const main = new FakePort(), source = new FakePort(), child = new FakeChild()
  const datasetId = randomUUID(), epoch = randomUUID(), authorityId = randomUUID(), revokeGate = warm469Deferred<void>()
  let grantCalls = 0, nameCalls = 0, contextCalls = 0, revokeSignal: AbortSignal | undefined
  let closing: Promise<{ ok: true } | { ok: false; error: unknown }> | undefined
  const supervisor = new CoreSupervisor({ entryPath: 'synthetic-warm469-core', cwd: '.', playbackEventProtocol: null, sourceWritesPort: true, requestTimeoutMs: 1000, startupTimeoutMs: 1000,
    dependencies: { createChannel: () => ({ port1: new FakePort(), port2: main }), createSourceWritesChannel: () => ({ port1: new FakePort(), port2: source }), fork: () => child } })
  main.postMessage = (message: unknown) => {
    main.sent.push(message)
    const raw = message as Record<string, unknown>
    if (raw.command === 'commandOutbox.context') {
      contextCalls++
      queueMicrotask(() => main.receive({ version: 1, id: raw.id, ok: true, result: { datasetId } }))
    } else if (raw.type === 'musicbridge.workbench.frame' && raw.lane === 'request' && raw.part === 'end') {
      const meta = datasetWorkbenchMeta(message as DatasetWorkbenchFrame)
      for (const frame of datasetWorkbenchFrames(meta, 'response', { epoch, datasetId, ready: true })) queueMicrotask(() => main.receive(frame))
    }
  }
  supervisor.configurePrivateLyricsGrantProducer(async (q, context) => { grantCalls++; return q.sequence === 1 || !options.produce ? warm469Denied(q) : options.produce(q, context) })
  supervisor.configurePrivateNameProviderBridge({ execute: async q => { nameCalls++; return { operationId: q.payload.operationId, state: 'queued' as const } }, revokeOwner: async () => undefined })
  supervisor.configurePrivateWorkbenchDirectoryProducer(async (q, context) => {
    if (q.command === 'revoke') { revokeSignal = context.signal; await revokeGate.promise }
    return captureSourceWorkbenchDirectoryReply({ version: 1, type: 'workbench-directory-reply', purpose: 'WORKBENCH_DIRECTORY', requestId: q.requestId, sequence: q.sequence, authorityId: q.authorityId,
      command: q.command, binding: q.binding, ui: q.ui, requestSha256: lyricsPhysicalDigest(q), decision: q.command === 'revoke' ? 'revoked' : 'rejected', nonce: null, validUntilMs: null, physical: null })
  })
  const starting = supervisor.start(); ready({ port2: main }); await starting
  const author = options.withoutOwnerPin ? undefined : await supervisor.createWorkbenchRootMainAuthor()
  const hash = 'a'.repeat(64), originalUi = { family: 'workbench' as const, command: 'localWorkbench.cue.target' as const, commandId: null, requestSha256: hash }
  const directoryBinding = { datasetId, ownerEpoch: epoch, childGeneration: author?.binding.childGeneration ?? 1, kind: 'cue' as const, choiceId: randomUUID(), revision: hash,
    issuedAtMs: Date.now(), expiresAtMs: Date.now() + 60000, originalUi }
  function directory(command: 'approve' | 'revoke', sequence: number) {
    return captureSourceWorkbenchDirectoryRequest({ version: 1, type: 'workbench-directory-request', purpose: 'WORKBENCH_DIRECTORY', requestId: randomUUID(), sequence, authorityId, command,
      binding: directoryBinding, ui: originalUi, expiresAtMs: Date.now() + 1800 })
  }
  function grant(sequence: number, fields: Partial<SourceWritesLyricsGrantRequest> = {}) {
    const binding: LocalLyricsPhysicalBinding = { datasetId, ownerEpoch: epoch, commandId: randomUUID(), sessionId: randomUUID(), libraryId: randomUUID(), albumId: randomUUID(), captureId: randomUUID(), trackId: randomUUID(), candidateId: randomUUID(),
      rootRevision: 'root-469', fileRevision: 'file-469', locationRevision: 'location-469', metadataRevision: hash, intentFingerprint: hash, bodySha256: hash, kind: 'lrc', originalIntentSha256: hash,
      originalRequestSha256: hash, groupCaptureSha256: hash, protectionSha256: hash, memberCount: 1, resourceCount: 1, targetCount: 1 }
    binding.originalRequestSha256 = lyricsPhysicalDigest({ sessionId: binding.sessionId, commandId: binding.commandId, embed: false })
    return captureSourceWritesLyricsGrantRequest({ version: 1, type: 'lyrics-source-grant-request', purpose: 'LYRICS', requestId: randomUUID(), sequence, revision: 1, authorityId,
      expiresAtMs: Date.now() + 1800, binding, bindingSha256: lyricsPhysicalDigest(binding), ...fields })
  }
  function firstName(fields: Record<string, unknown> = {}) {
    return captureDatasetNameProviderRequest({ version: 1, type: 'musicbridge.name.provider-request', requestId: randomUUID(), sequence: 1, epoch, datasetId, authorityId: null, childGeneration: null,
      command: 'nameProviderStart', payload: { operationId: randomUUID(), jobId: randomUUID(), captureId: randomUUID(), albumId: randomUUID(), preparationId: randomUUID(), backend: 'ollama', systemPrompt: '合成系统', userPrompt: '合成输入', originalStartSha256: hash, expiresAtMs: Date.now() + 15000 }, expiresAtMs: Date.now() + 1800, ...fields })
  }
  async function seedDirectoryActor() {
    const q = directory('approve', 1); source.receive(q); await flushStartup()
    const raw = source.sent.find(value => (value as Record<string, unknown>).requestId === q.requestId)
    assert.ok(raw); assertSourceWorkbenchDirectoryReplyForRequest(captureSourceWorkbenchDirectoryReply(raw), q)
  }
  async function seedLyricsActor() {
    const q = grant(1); source.receive(q); await flushStartup()
    const raw = source.sent.find(value => (value as Record<string, unknown>).requestId === q.requestId)
    assert.ok(raw); assertSourceWritesLyricsGrantReplyForRequest(captureSourceWritesLyricsGrantReply(raw), q)
  }
  function beginShutdown() {
    closing ??= supervisor.shutdown().then(() => ({ ok: true as const }), error => ({ ok: false as const, error }))
    return closing
  }
  async function finish() {
    const pending = beginShutdown(); revokeGate.resolve(); await flushStartup()
    const request = main.sent.find(value => (value as Record<string, unknown>).command === 'core.shutdown') as { id: string } | undefined
    if (request) main.receive({ version: 1, id: request.id, ok: true, result: { stopped: true } })
    child.exit(0)
    return pending
  }
  t.after(async () => { revokeGate.resolve(); await finish() })
  return { supervisor, main, source, child, author, epoch, datasetId, authorityId, directory, grant, firstName, seedDirectoryActor, seedLyricsActor, beginShutdown, finish, revokeGate,
    grantCalls: () => grantCalls, nameCalls: () => nameCalls, contextCalls: () => contextCalls, revokeSignal: () => revokeSignal }
}

test('暖关闭469：原目录actor的晚歌词grant只收原rejected，共享revoke仍待原工作且不关port', async t => {
  const h = await warm469Harness(t); await h.seedDirectoryActor()
  const closing = h.beginShutdown(); let stopped = false; void closing.then(() => { stopped = true }); await flushStartup()
  const revoke = h.directory('revoke', 2); h.source.receive(revoke); await flushStartup()
  const grant = h.grant(1); h.source.receive(grant); await flushStartup()
  assert.equal(h.source.closed, false); assert.equal(h.main.closed, false); assert.equal(h.child.killed, false)
  assert.equal(h.grantCalls(), 0); assert.equal(h.revokeSignal()?.aborted, false); assert.equal(stopped, false)
  const raw = h.source.sent.find(value => (value as Record<string, unknown>).requestId === grant.requestId); assert.ok(raw)
  const reply = captureSourceWritesLyricsGrantReply(raw); assertSourceWritesLyricsGrantReplyForRequest(reply, grant)
  assert.equal(reply.decision, 'rejected'); assert.equal(reply.nonce, null); assert.equal(reply.validUntilMs, null)
  h.revokeGate.resolve(); await h.supervisor.joinPrivateWorkbenchDirectoryProducer()
  const echo = h.source.sent.find(value => (value as Record<string, unknown>).requestId === revoke.requestId); assert.ok(echo)
  assertSourceWorkbenchDirectoryReplyForRequest(captureSourceWorkbenchDirectoryReply(echo), revoke)
  assert.equal((await h.finish()).ok, true)
  t.diagnostic('进入当前Supervisor真实监听和匹配链；controlled child/port/directory producer，未授真实FD、Native或完整Main退出资格。')
})

for (const outcome of ['旧许可', '原作者失权'] as const) test(`暖关闭469：原在途grant跨关闭返回旧许可或作者失权，均回原rejected并等待producer（${outcome}）`, async t => {
    const produced = warm469Deferred<SourceWritesLyricsGrantReply>()
    t.after(() => produced.reject(new CoreIpcError('NOT_READY', '合成原producer收口')))
    const h = await warm469Harness(t, { produce: () => produced.promise }); await h.seedDirectoryActor(); await h.seedLyricsActor()
    const grant = h.grant(2), acceptedBeforeQuit = { ...warm469Denied(grant), decision: 'granted' as const, nonce: randomUUID(), validUntilMs: Date.now() + 60000 }
    h.source.receive(grant); await flushStartup(); assert.equal(h.grantCalls(), 2)
    h.beginShutdown(); await flushStartup(); const revoke = h.directory('revoke', 2); h.source.receive(revoke); await flushStartup()
    let joined = false; const join = h.supervisor.joinPrivateLyricsGrantProducer().then(() => { joined = true }); await flushStartup(); assert.equal(joined, false)
    if (outcome === '旧许可') produced.resolve(acceptedBeforeQuit); else produced.reject(new CoreIpcError('OUTBOX_SCOPE_MISMATCH', '合成原作者失权'))
    await join; assert.equal(joined, true); assert.equal(h.source.closed, false); assert.equal(h.child.killed, false); assert.equal(h.revokeSignal()?.aborted, false)
    const raw = h.source.sent.find(value => (value as Record<string, unknown>).requestId === grant.requestId); assert.ok(raw)
    const reply = captureSourceWritesLyricsGrantReply(raw); assertSourceWritesLyricsGrantReplyForRequest(reply, grant)
    assert.equal(reply.decision, 'rejected'); assert.equal(reply.nonce, null); assert.equal(reply.validUntilMs, null)
    h.revokeGate.resolve(); await h.supervisor.joinPrivateWorkbenchDirectoryProducer(); assert.equal((await h.finish()).ok, true)
})

function warm469VerifyEcho(q: SourceWritesLyricsVerifyRequest) {
  const grant = q.grantRequest, binding = grant.binding
  return captureSourceWritesLyricsVerifyReply({ version: 1, type: 'lyrics-source-verify-reply', purpose: 'LYRICS', requestId: q.requestId, sequence: q.sequence, epoch: q.epoch, datasetId: q.datasetId,
    grantRequestId: grant.requestId, authorityId: grant.authorityId, binding, bindingSha256: grant.bindingSha256, revision: grant.revision,
    result: { originalBinding: binding, request: { sessionId: binding.sessionId, commandId: binding.commandId, embed: false }, phase: 'PREPARED', revision: grant.revision, recordOwnerEpoch: q.epoch, currentOwnerEpoch: q.epoch,
      physicalClosed: false, protectionReleased: false, unresolved: false, ledgerSequence: 1, originalIntentSha256: binding.originalIntentSha256, originalRequestSha256: binding.originalRequestSha256,
      groupCaptureSha256: binding.groupCaptureSha256, protectionSha256: binding.protectionSha256, jobOrigin: null } })
}

test('暖关闭469：已受理原verify回包迟到仍消费原flight，作者末尾拒绝不毒共享revoke', async t => {
  let h!: Awaited<ReturnType<typeof warm469Harness>>, afterVerify = 0
  h = await warm469Harness(t, { produce: async (q, context) => {
    assert.ok(h.author)
    await h.supervisor.verifyLyricsGrantOriginal(q, h.author.binding, context.signal, context.deadlineAtMs)
    afterVerify++
    return warm469Denied(q)
  } })
  await h.seedDirectoryActor(); await h.seedLyricsActor(); const grant = h.grant(2); h.source.receive(grant); await flushStartup()
  const raw = h.source.sent.find(value => (value as Record<string, unknown>).type === 'lyrics-source-verify-request'); assert.ok(raw)
  const verify = captureSourceWritesLyricsVerifyRequest(raw)
  assert.equal(verify.grantRequest.requestId, grant.requestId)
  h.beginShutdown(); await flushStartup(); const revoke = h.directory('revoke', 2); h.source.receive(revoke); await flushStartup()
  let joined = false; const join = h.supervisor.joinPrivateLyricsGrantProducer().then(() => { joined = true }); await flushStartup(); assert.equal(joined, false)
  h.source.receive(warm469VerifyEcho(verify)); await join
  assert.equal(afterVerify, 0, '原verify末尾作者检查准确拒绝；没有走任何新grant续体')
  assert.equal(h.source.closed, false); assert.equal(h.child.killed, false); assert.equal(h.revokeSignal()?.aborted, false)
  const echo = h.source.sent.find(value => (value as Record<string, unknown>).requestId === grant.requestId); assert.ok(echo)
  const reply = captureSourceWritesLyricsGrantReply(echo); assertSourceWritesLyricsGrantReplyForRequest(reply, grant)
  assert.equal(reply.decision, 'rejected'); assert.equal(reply.nonce, null)
  h.revokeGate.resolve(); await h.supervisor.joinPrivateWorkbenchDirectoryProducer(); assert.equal((await h.finish()).ok, true)
})

for (const variant of ['未知pending', '错authority', '错原body', '添nonce'] as const) test(`暖关闭469：迟到verify的未知pending、错authority/原body和添nonce仍fail closed（${variant}）`, async t => {
    let h!: Awaited<ReturnType<typeof warm469Harness>>, afterVerify = 0
    h = await warm469Harness(t, { produce: async (q, context) => {
      assert.ok(h.author)
      await h.supervisor.verifyLyricsGrantOriginal(q, h.author.binding, context.signal, context.deadlineAtMs)
      afterVerify++
      return warm469Denied(q)
    } })
    await h.seedDirectoryActor(); await h.seedLyricsActor(); const grant = h.grant(2); h.source.receive(grant); await flushStartup()
    const raw = h.source.sent.find(value => (value as Record<string, unknown>).type === 'lyrics-source-verify-request'); assert.ok(raw)
    const verify = captureSourceWritesLyricsVerifyRequest(raw)
    h.beginShutdown(); await flushStartup(); const valid = warm469VerifyEcho(verify)
    const bad = { ...valid, ...(variant === '未知pending' ? { requestId: randomUUID() } : variant === '错authority' ? { authorityId: randomUUID() } : variant === '错原body' ? { bindingSha256: 'b'.repeat(64) } : variant === '添nonce' ? { nonce: randomUUID() } : {}) }
    h.source.receive(bad); await h.supervisor.joinPrivateLyricsGrantProducer()
    assert.equal(h.source.closed, true, variant); assert.equal(afterVerify, 0)
    assert.equal(h.source.sent.some(value => (value as Record<string, unknown>).requestId === grant.requestId), false)
})

for (const outcome of ['迟到旧许可', '迟到失权'] as const) test(`暖关闭479：原grant实际到期只abort本flight并回一次拒绝，producer真结束前join不转绿（${outcome}）`, async t => {
    const produced = warm469Deferred<SourceWritesLyricsGrantReply>()
    let producerSignal: AbortSignal | undefined
    const h = await warm469Harness(t, { produce: async (_q, context) => { producerSignal = context.signal; return produced.promise } })
    await h.seedDirectoryActor(); await h.seedLyricsActor()
    const q = h.grant(2, { expiresAtMs: Date.now() + 100 })
    const granted = captureSourceWritesLyricsGrantReply({ ...warm469Denied(q), decision: 'granted', nonce: randomUUID(), validUntilMs: Date.now() + 1000 })
    h.source.receive(q); await flushStartup(); h.beginShutdown(); await flushStartup()
    h.source.receive(h.directory('revoke', 2)); await flushStartup()
    let joined = false
    const join = h.supervisor.joinPrivateLyricsGrantProducer().then(() => { joined = true })
    await new Promise(resolve => setTimeout(resolve, 150))
    assert.equal(producerSignal?.aborted, true); assert.equal(joined, false)
    assert.equal(h.source.closed, false); assert.equal(h.child.killed, false); assert.equal(h.revokeSignal()?.aborted, false)
    const echoes = () => h.source.sent.filter(value => (value as Record<string, unknown>).requestId === q.requestId)
    assert.equal(echoes().length, 1)
    const rejected = captureSourceWritesLyricsGrantReply(echoes()[0]); assertSourceWritesLyricsGrantReplyForRequest(rejected, q)
    assert.equal(rejected.decision, 'rejected'); assert.equal(rejected.nonce, null); assert.equal(rejected.validUntilMs, null)
    if (outcome === '迟到旧许可') produced.resolve(granted)
    else produced.reject(new CoreIpcError('OUTBOX_SCOPE_MISMATCH', '合成原producer到期失权'))
    await join
    assert.equal(joined, true); assert.equal(echoes().length, 1); assert.equal(h.source.closed, false)
    h.revokeGate.resolve(); await h.supervisor.joinPrivateWorkbenchDirectoryProducer(); assert.equal((await h.finish()).ok, true)
})

for (const variant of ['完整原回声', '坏原body'] as const) test(`暖关闭479：实际核验到期后只退休完整原回声，坏原body仍封口且不续授权（${variant}）`, async t => {
    let h!: Awaited<ReturnType<typeof warm469Harness>>, afterVerify = 0
    h = await warm469Harness(t, { produce: async (q, context) => {
      assert.ok(h.author)
      await h.supervisor.verifyLyricsGrantOriginal(q, h.author.binding, context.signal, context.deadlineAtMs)
      afterVerify++; return warm469Denied(q)
    } })
    await h.seedDirectoryActor(); await h.seedLyricsActor()
    const grant = h.grant(2, { expiresAtMs: Date.now() + 100 }); h.source.receive(grant); await flushStartup()
    const raw = h.source.sent.find(value => (value as Record<string, unknown>).type === 'lyrics-source-verify-request'); assert.ok(raw)
    const verify = captureSourceWritesLyricsVerifyRequest(raw)
    h.beginShutdown(); await flushStartup(); h.source.receive(h.directory('revoke', 2)); await flushStartup()
    await new Promise(resolve => setTimeout(resolve, 150)); await h.supervisor.joinPrivateLyricsGrantProducer()
    assert.equal(afterVerify, 0); assert.equal(h.source.closed, false); assert.equal(h.revokeSignal()?.aborted, false)
    const before = h.source.sent.filter(value => (value as Record<string, unknown>).requestId === grant.requestId)
    assert.equal(before.length, 1); assert.equal(captureSourceWritesLyricsGrantReply(before[0]).decision, 'rejected')
    const echo = warm469VerifyEcho(verify)
    h.source.receive(variant === '坏原body' ? { ...echo, bindingSha256: 'b'.repeat(64) } : echo); await flushStartup()
    assert.equal(h.source.closed, variant === '坏原body'); assert.equal(afterVerify, 0)
    assert.equal(h.source.sent.filter(value => (value as Record<string, unknown>).requestId === grant.requestId).length, 1)
    if (variant === '完整原回声') {
      assert.equal(h.child.killed, false); assert.equal(h.revokeSignal()?.aborted, false)
      h.revokeGate.resolve(); await h.supervisor.joinPrivateWorkbenchDirectoryProducer(); assert.equal((await h.finish()).ok, true)
    }
})

test('暖关闭469：无NAME关联的首次Start按原已确认Owner回NOT_READY，不建binding或kill原child', async t => {
  const h = await warm469Harness(t); await h.seedDirectoryActor(); const contexts = h.contextCalls()
  h.beginShutdown(); await flushStartup(); const q = h.firstName(); h.main.receive(q); await flushStartup()
  assert.equal(h.child.killed, false); assert.equal(h.main.closed, false); assert.equal(h.source.closed, false)
  assert.equal(h.nameCalls(), 0); assert.equal(h.contextCalls(), contexts)
  const raw = h.main.sent.find(value => (value as Record<string, unknown>).requestId === q.requestId); assert.ok(raw)
  const reply = captureDatasetNameProviderReply(raw); assertDatasetNameProviderReplyForRequest(reply, q)
  assert.equal(reply.ok, false); if (!reply.ok) assert.equal(reply.failure, 'NOT_READY')
  assert.equal(reply.authorityId, null); assert.equal(reply.childGeneration, null)
  const revoke = h.directory('revoke', 2); h.source.receive(revoke); await flushStartup(); assert.equal(h.revokeSignal()?.aborted, false)
  h.revokeGate.resolve(); await h.supervisor.joinPrivateWorkbenchDirectoryProducer(); assert.equal((await h.finish()).ok, true)
})

for (const variant of ['未知actor', '异epoch', '异dataset', '已过期', '超期限', '重复序号', '坏bindingSHA', '无原Ownerpin'] as const) test(`暖关闭469：歌词坏包、未知actor、异epoch/dataset与期限序号仍fail closed（${variant}）`, async t => {
    const h = await warm469Harness(t, { withoutOwnerPin: variant === '无原Ownerpin' }); await h.seedDirectoryActor(); await h.seedLyricsActor()
    h.beginShutdown(); await flushStartup(); let q = h.grant(2)
    if (variant === '未知actor') q = { ...q, authorityId: randomUUID() }
    if (variant === '异epoch' || variant === '异dataset') {
      const binding = { ...q.binding, ...(variant === '异epoch' ? { ownerEpoch: randomUUID() } : { datasetId: randomUUID() }) }
      q = { ...q, binding, bindingSha256: lyricsPhysicalDigest(binding) }
    }
    if (variant === '已过期') q = { ...q, expiresAtMs: Date.now() - 1 }
    if (variant === '超期限') q = { ...q, expiresAtMs: Date.now() + 2500 }
    if (variant === '重复序号') q = { ...q, sequence: 1 }
    if (variant === '坏bindingSHA') q = { ...q, bindingSha256: 'b'.repeat(64) }
    h.source.receive(q); await flushStartup()
    assert.equal(h.source.closed, true, variant); assert.equal(h.grantCalls(), 1)
    assert.equal(h.source.sent.some(value => (value as Record<string, unknown>).requestId === q.requestId), false)
})

for (const variant of ['未知作者', '异代', '异epoch', '异dataset', '已过期', '超期限', '无原Ownerpin'] as const) test(`暖关闭469：NAME首Start的异作者/代/epoch/dataset/期限或缺原pin不会被拒绝口放宽（${variant}）`, async t => {
    const h = await warm469Harness(t, { withoutOwnerPin: variant === '无原Ownerpin' }); h.beginShutdown(); await flushStartup()
    const fields: Record<string, unknown> = {}
    if (variant === '未知作者' || variant === '异代') { fields.authorityId = randomUUID(); fields.childGeneration = variant === '异代' ? 2 : 1 }
    if (variant === '异epoch') fields.epoch = randomUUID()
    if (variant === '异dataset') fields.datasetId = randomUUID()
    if (variant === '已过期') fields.expiresAtMs = Date.now() - 1
    if (variant === '超期限') fields.expiresAtMs = Date.now() + 2500
    const q = h.firstName(fields); h.main.receive(q); await flushStartup()
    assert.equal(h.child.killed, true, variant); assert.equal(h.nameCalls(), 0)
    assert.equal(h.main.sent.some(value => (value as Record<string, unknown>).requestId === q.requestId), false)
})

import {MessageChannel as FenceMessageChannel493,type MessagePort as FenceMessagePort493} from 'node:worker_threads'
import {mkdtemp as fenceMkdtemp493,writeFile as fenceWriteFile493,open as fenceOpen493} from 'node:fs/promises'
import {constants as fenceFsConstants493} from 'node:fs'
import path493 from 'node:path'
import {createSourceWritesMainActor as fenceActor493,requestSourceWorkbenchReadersStop as fenceRequest493,consumeSourceWorkbenchReadersReply as fenceConsume493,
  captureSourceWorkbenchReadersRequest as fenceCaptureRequest493,captureSourceWorkbenchReadersReply as fenceCaptureReply493,assertSourceWorkbenchReadersReplyForRequest as fenceAssertReply493,
  type SourceWorkbenchReadersRequest as FenceRequest493,type SourceWorkbenchReadersBinding as FenceBinding493} from '../../../packages/bridge-core/src/collection/source-writes-authority.js'

const fenceClosed493=new WeakSet<FenceMessagePort493>()
function fencePort493(port:FenceMessagePort493){port.once('close',()=>fenceClosed493.add(port));return port}
async function fenceClose493(port:FenceMessagePort493,close=false){if(fenceClosed493.has(port))return;await new Promise<void>((resolve,reject)=>{
  const timer=setTimeout(()=>reject(new Error('原Supervisor Node物理端口未关闭493')),2000);port.once('close',()=>{clearTimeout(timer);resolve()});if(close)port.close()})}
class FenceCorePort493 implements CoreMessagePort{
  constructor(readonly port:FenceMessagePort493){}
  on(event:'message',listener:(event:{data:unknown})=>void){return this.port.on(event,(data:unknown)=>listener({data}))}
  start(){this.port.start()}
  postMessage(data:unknown){this.port.postMessage(data)}
  close(){this.port.close()}
}
type FenceProducer493=Parameters<CoreSupervisor['configurePrivateWorkbenchReadersProducer']>[0]
type FenceContext493=Parameters<FenceProducer493>[1]
/** Main/Owner启动帧和child为受控组件，源通道与producer持有的FD是真实Node资源；不称实际Electron/Main factory。 */
async function fenceHarness493(t:import('node:test').TestContext,options:{held?:boolean;failure?:boolean}={}){
  const temporary=process.env.TMPDIR;assert.ok(temporary);assert.ok(temporary.startsWith('/Volumes/LifeWeave/Developer/CommandLine/'))
  const directory=await fenceMkdtemp493(path493.join(temporary,'main-readers493-')),file=path493.join(directory,'controlled-reader.txt');await fenceWriteFile493(file,'自有Main读取资源493',{flag:'wx',mode:0o600})
  const fd=await fenceOpen493(file,fenceFsConstants493.O_RDONLY),channel=new FenceMessageChannel493(),owner=fencePort493(channel.port1),mainSource=fencePort493(channel.port2),actor=fenceActor493(owner)
  const source=new FenceCorePort493(mainSource),main=new FakePort(),child=new FakeChild(),datasetId=randomUUID(),epoch=randomUUID(),gate=warm469Deferred<void>(),entered=warm469Deferred<{q:FenceRequest493;context:FenceContext493}>()
  const requests:FenceRequest493[]=[],replies:ReturnType<typeof fenceCaptureReply493>[]=[],consumed:unknown[]=[],errors:unknown[]=[]
  if(!options.held)gate.resolve()
  owner.on('message',raw=>{try{const reply=fenceCaptureReply493(raw);replies.push(reply);if(fenceConsume493(actor,raw))consumed.push(raw)}catch(error){errors.push(error);owner.close()}})
  const supervisor=new CoreSupervisor({entryPath:'controlled-main-reader493',cwd:directory,playbackEventProtocol:null,sourceWritesPort:true,requestTimeoutMs:1000,startupTimeoutMs:1000,
    dependencies:{createChannel:()=>({port1:new FakePort(),port2:main}),createSourceWritesChannel:()=>({port1:new FenceCorePort493(owner),port2:source}),fork:()=>child}})
  main.postMessage=(message:unknown)=>{
    main.sent.push(message);const raw=message as Record<string,unknown>
    if(raw.command==='commandOutbox.context')queueMicrotask(()=>main.receive({version:1,id:raw.id,ok:true,result:{datasetId}}))
    else if(raw.type==='musicbridge.workbench.frame'&&raw.lane==='request'&&raw.part==='end'){
      const meta=datasetWorkbenchMeta(message as DatasetWorkbenchFrame);for(const frame of datasetWorkbenchFrames(meta,'response',{epoch,datasetId,ready:true}))queueMicrotask(()=>main.receive(frame))
    }else if(raw.command==='core.shutdown')queueMicrotask(()=>{main.receive({version:1,id:raw.id,ok:true,result:{stopped:true}});child.exit(0)})
  }
  supervisor.configurePrivateWorkbenchReadersProducer(async(q,context)=>{
    requests.push(q);entered.resolve({q,context});await gate.promise
    if(options.failure)throw new Error('受控Main原producer仍未确认关闭493')
    await fd.close()
  })
  const starting=supervisor.start();ready({port2:main});await starting;const author=await supervisor.createWorkbenchRootMainAuthor()
  const binding:FenceBinding493={datasetId,ownerEpoch:epoch,commandId:randomUUID(),originalSha256:'a'.repeat(64),libraryId:randomUUID()}
  let cleaning:Promise<void>|undefined
  const cleanup=()=>cleaning??=(async()=>{gate.resolve();try{await supervisor.shutdown()}catch{/* 原UNKNOWN不签shutdown绿；只收测试自有资源。 */}
    if(fd.fd>=0)await fd.close();child.exit(0);await Promise.all([fenceClose493(owner,true),fenceClose493(mainSource,true)])})()
  t.after(cleanup)
  function request(deadlineMs=2000,scope: FenceBinding493=binding){return fenceRequest493(actor,scope,{signal:new AbortController().signal,deadlineAtMs:performance.now()+deadlineMs})}
  async function reply(){const deadline=performance.now()+2000;while(!replies.length){assert.ok(performance.now()<deadline,'原读取fence未返回');await flushStartup()}return replies[0]!}
  return{supervisor,author,actor,source,owner,mainSource,main,child,fd,binding,requests,replies,consumed,errors,entered:entered.promise,gate,request,reply,cleanup}
}

test('按库Main fence493：原Supervisor当前route与同actor单库producer完成后才回完整closed，真实FD与专用端口最终闭口',async t=>{
  const h=await fenceHarness493(t,{held:true});let settled=false;const pending=h.request().then(()=>{settled=true}),accepted=await h.entered
  assert.equal(Object.getPrototypeOf(accepted.q.binding),null);assert.deepEqual({...accepted.q.binding},h.binding);assert.equal(accepted.q.authorityId,h.actor.authorityId);assert.equal(accepted.q.sequence,1);assert.equal(accepted.context.binding,h.author.binding)
  assert.equal(accepted.context.binding.datasetId,h.binding.datasetId);assert.equal(accepted.context.binding.ownerEpoch,h.binding.ownerEpoch)
  assert.ok(accepted.context.deadlineAtMs>performance.now());assert.ok(accepted.context.deadlineAtMs-performance.now()<=2000);assert.equal(accepted.context.signal.aborted,false)
  assert.equal(h.fd.fd>=0,true);assert.equal(settled,false);assert.equal(h.replies.length,0);assert.equal(h.child.killed,false);assert.equal(h.main.closed,false)
  let joined=false;const joining=h.supervisor.joinPrivateWorkbenchReadersProducer().then(()=>{joined=true});await flushStartup();assert.equal(joined,false)
  h.gate.resolve();await pending;await joining;assert.equal(h.fd.fd,-1);assert.equal(settled,true);assert.equal(joined,true)
  const reply=await h.reply();fenceAssertReply493(reply,accepted.q);assert.equal(reply.ok,true);assert.equal(reply.physicalClosed,true);assert.equal(reply.failure,null);assert.equal(h.consumed.length,1);assert.equal(h.errors.length,0)
  assert.equal(h.requests.length,1);assert.equal(h.actor.active,true);assert.equal(h.child.killed,false);await h.cleanup();assert.equal(fenceClosed493.has(h.owner),true);assert.equal(fenceClosed493.has(h.mainSource),true)
  t.diagnostic('受控child/启动帧与私有producer，实际MessageChannel/FD；不代表真实Main assembly、独立Owner worker或完整C03。')
})
test('按库Main fence493：原剩余deadline只abort本flight，迟到physicalClosed不能放行，UNKNOWN producer实际join仍拒绝',async t=>{
  const h=await fenceHarness493(t,{held:true});t.mock.timers.enable({apis:['Date','setTimeout'],now:Date.now()})
  try{
    const pending=h.request(300),rejected=assert.rejects(pending),accepted=await h.entered;assert.ok(accepted.q.expiresAtMs-Date.now()<=300);assert.equal(h.fd.fd>=0,true)
    let joined=false;const joining=h.supervisor.joinPrivateWorkbenchReadersProducer().then(()=>{joined=true})
    t.mock.timers.tick(400);await rejected;await flushStartup();assert.equal(accepted.context.signal.aborted,true);assert.equal(joined,false);assert.equal(h.fd.fd>=0,true);assert.equal(h.replies.length,0)
    assert.equal(h.child.killed,false);assert.equal(h.main.closed,false);assert.equal(fenceClosed493.has(h.owner),false);assert.equal(fenceClosed493.has(h.mainSource),false)
    h.gate.resolve();await joining;const reply=await h.reply();fenceAssertReply493(reply,accepted.q);assert.equal(reply.ok,false);assert.equal(reply.physicalClosed,true);assert.equal(reply.failure,'TIMEOUT');assert.equal(h.fd.fd,-1)
    assert.equal(h.requests.length,1);assert.equal(h.consumed.length,1);assert.equal(h.actor.active,true);assert.equal(h.errors.length,0)
    // 真实迟到关闭只退休原flight；不会发第二个请求、续期限或改变原已拒绝Promise。
    await assert.rejects(pending);assert.equal(h.requests[0]!.requestId,accepted.q.requestId);assert.equal(h.requests[0]!.expiresAtMs,accepted.q.expiresAtMs)
  }finally{t.mock.timers.reset();await h.cleanup()}

  const unknown=await fenceHarness493(t,{held:true,failure:true}),pendingUnknown=unknown.request(),rejectedUnknown=assert.rejects(pendingUnknown),acceptedUnknown=await unknown.entered
  const joinUnknown=unknown.supervisor.joinPrivateWorkbenchReadersProducer().then(()=>({ok:true as const}),error=>({ok:false as const,error}))
  await flushStartup();assert.equal(unknown.fd.fd>=0,true);assert.equal(unknown.replies.length,0);unknown.gate.resolve();await rejectedUnknown
  const unknownReply=await unknown.reply();fenceAssertReply493(unknownReply,acceptedUnknown.q);assert.equal(unknownReply.ok,false);assert.equal(unknownReply.physicalClosed,false);assert.equal(unknownReply.failure,'UNKNOWN')
  const joined=await joinUnknown;assert.equal(joined.ok,false);assert.ok(!joined.ok&&joined.error instanceof CoreIpcError);assert.equal(!joined.ok&&joined.error.code,'NOT_READY');assert.equal(unknown.fd.fd>=0,true)
  await assert.rejects(unknown.supervisor.joinPrivateWorkbenchReadersProducer(),error=>error instanceof CoreIpcError&&error.code==='NOT_READY');assert.equal(unknown.requests.length,1);assert.equal(unknown.child.killed,false)
  t.diagnostic('UNKNOWN cleanup只在测试末尾手动close自有FD，不补physicalClosed回声、重签原操作或记shutdown资格。')
})
test('按库Main fence493：foreign dataset或epoch及换actor的原port消息fatal，保原producer至真实FD收口而不mint或kill',async t=>{
  for(const field of ['datasetId','ownerEpoch','authorityId'] as const){
    const h=await fenceHarness493(t,{held:true}),pending=h.request(),rejected=assert.rejects(pending),accepted=await h.entered
    const binding=field==='authorityId'?accepted.q.binding:{...accepted.q.binding,[field]:randomUUID()}
    const forged=fenceCaptureRequest493({...accepted.q,requestId:randomUUID(),sequence:2,expiresAtMs:Date.now()+1500,binding,...(field==='authorityId'?{authorityId:randomUUID()}:{})})
    h.owner.postMessage(forged);await rejected;await Promise.all([fenceClose493(h.owner),fenceClose493(h.mainSource)])
    assert.equal(h.actor.active,false);assert.equal(accepted.context.signal.aborted,true);assert.equal(h.requests.length,1);assert.equal(h.replies.length,0);assert.equal(h.fd.fd>=0,true);assert.equal(h.child.killed,false);assert.equal(h.main.closed,false)
    let joined=false;const joining=h.supervisor.joinPrivateWorkbenchReadersProducer().then(()=>{joined=true});await flushStartup();assert.equal(joined,false)
    h.gate.resolve();await joining;assert.equal(h.fd.fd,-1);assert.equal(h.requests.length,1);assert.equal(h.replies.length,0);assert.equal(h.child.killed,false)
    assert.equal(h.author.binding.datasetId,accepted.q.binding.datasetId);assert.equal(h.author.binding.ownerEpoch,accepted.q.binding.ownerEpoch);await h.cleanup()
  }
  t.diagnostic('foreign请求是明确攻击负例，不是伪Main闭口；实际专用port关闭仍不能替代原受控producer/FD join。')
})


// 仅只读图片反向桥组件：实际 Node MessageChannel、生产 Utility/Main 路由与 normalizer；
// startup/Owner context 为受控组件，图片走生产Rust池；此处不冒充真实Electron/Owner/App验证。
import { MessageChannel as ArtworkRouteChannel, type MessagePort as ArtworkRoutePort } from 'node:worker_threads'
import { readFileSync as artworkRouteReadFile } from 'node:fs'
import { createHash as artworkRouteHash } from 'node:crypto'
import * as artworkRouteDto from '@music-bridge/contracts'
import { createUtilityLocalAlbumArtworkBridge, type UtilityPort as ArtworkUtilityPort } from '../../../packages/bridge-core/src/utility-main.js'
import { isLocalAlbumArtworkMainRequest, isLocalAlbumArtworkMainReply } from '../../../packages/bridge-core/src/collection/local-album-browser/main-protocol.js'
import { createLocalAlbumArtworkNormalizer } from '../src/main/local-library-workbench/album-artwork-normalizer.js'
import type { PhotoDecoderImage as ArtworkRouteDecoder } from '../src/main/collection-photos.js'
import { closeRustMediaWorkerPool } from '../../../packages/bridge-core/src/library/rust-media-worker.js'
// 本组件使用真实共享Rust子进程；逐项producer完成后，套件末尾仍须等待池真实关闭。
after(() => closeRustMediaWorkerPool())
const artworkRouteJpeg = artworkRouteReadFile(new URL('../../../packages/bridge-core/test/fixtures/mbrs012-source/owned-cover-16.jpg', import.meta.url))
const artworkRouteCopies = (): artworkRouteDto.LocalArtworkSourceCopies => ({status:'ready',items:[{origin:'local-independent',sourceIdentity:artworkRouteHash('sha256').update(artworkRouteJpeg).digest('hex'),sourceLabel:'自有合成封面',base64:artworkRouteJpeg.toString('base64')}]})
function artworkRoutePort(port:ArtworkRoutePort,receivedNow?:(raw:unknown)=>number|undefined):CoreMessagePort&ArtworkUtilityPort {
  return {on(_event,listener){port.on('message',data=>{const original=Date.now,now=receivedNow?.(data);try{if(now!==undefined)Date.now=()=>now;listener({data})}finally{Date.now=original}})},start(){port.start()},close(){port.close()},postMessage(message){port.postMessage(message)}}
}
async function artworkRouteFixture(t:import('node:test').TestContext,options:{normalize?:(copies:unknown,context:{signal:AbortSignal;deadlineAtMs:number})=>Promise<{image:artworkRouteDto.LocalArtworkImage|null;status:'ready'|'source-unavailable'}>;withoutNormalizer?:boolean;beforeClose?:()=>void;receivedNow?:(raw:unknown)=>number|undefined;failRecoveryFork?:boolean}={}) {
  const channel=new ArtworkRouteChannel(),main=artworkRoutePort(channel.port1,options.receivedNow),utility=artworkRoutePort(channel.port2),child=new FakeChild()
  const datasetId=randomUUID(),epoch=randomUUID(),identity={datasetId,epoch},outgoing:unknown[]=[],replies:unknown[]=[],fatals:unknown[]=[]
  let current=identity,decodeCalls=0,producerCalls=0,producerSettled=0,closed=false,shutdownId:unknown,forkCount=0
  const decoder:ArtworkRouteDecoder={isEmpty:()=>false,getSize:()=>({width:16,height:16}),resize:()=>decoder,toJPEG:()=>Buffer.from(artworkRouteJpeg)}
  const normalize=createLocalAlbumArtworkNormalizer(bytes=>{decodeCalls++;assert.deepEqual(Buffer.from(bytes),artworkRouteJpeg);return decoder})
  const supervisor=new CoreSupervisor({entryPath:'synthetic-artwork-utility',cwd:'.',startupTimeoutMs:1000,requestTimeoutMs:1000,dependencies:{createChannel:()=>({port1:utility,port2:main}),fork:()=>{if(++forkCount>1&&options.failRecoveryFork)throw new Error('受控恢复fork失败，旧Core已退出且没有替代child。');return child}}})
  if(!options.withoutNormalizer)supervisor.configurePrivateLocalAlbumArtworkNormalizer(async(copies,context)=>{
    producerCalls++
    try{return await (options.normalize??normalize)(copies,context)}finally{producerSettled++}
  })
  utility.on('message',event=>{
    const raw=event.data as Record<string,unknown>
    if(raw.type==='local-album-artwork-main-response'){replies.push(event.data);return}
    if(raw.command==='commandOutbox.context')utility.postMessage({version:1,id:raw.id,ok:true,result:{datasetId}})
    else if(raw.type==='musicbridge.workbench.frame'&&raw.lane==='request'&&raw.part==='end')for(const frame of datasetWorkbenchFrames(datasetWorkbenchMeta(event.data as DatasetWorkbenchFrame),'response',{datasetId,epoch,ready:true}))utility.postMessage(frame)
    else if(raw.command==='core.shutdown'){shutdownId=raw.id;utility.postMessage({version:1,id:raw.id,ok:true,result:{stopped:true}})}
  })
  // Node MessagePort异步交付；Fake退出必须发生在Main观察原shutdown回执之后。
  channel.port1.on('message',(raw:{id?:unknown;ok?:unknown;result?:{stopped?:unknown}})=>{if(raw.id===shutdownId&&raw.ok===true&&raw.result?.stopped===true)setImmediate(()=>child.exit(0))})
  const observedUtility:ArtworkUtilityPort={on:(event,listener)=>utility.on(event,listener),start:()=>utility.start(),postMessage(message){outgoing.push(message);utility.postMessage(message)}}
  const bridge=createUtilityLocalAlbumArtworkBridge(observedUtility,()=>current,()=>fatals.push('fatal'))
  const starting=supervisor.start();utility.start();utility.postMessage({version:1,event:'core.ready',payload:{state:{runtime:'ready',roon:'disconnected',provider:'missing',activeStreamCount:0,activePlaybackPresent:false}}});await starting
  const author=await supervisor.createWorkbenchRootMainAuthor()
  async function finish(){if(closed)return;closed=true;options.beforeClose?.();bridge.close();await supervisor.shutdown();await supervisor.joinPrivateLocalAlbumArtworkNormalizer();main.close();utility.close()}
  t.after(finish)
  return {supervisor,bridge,author,outgoing,replies,fatals,scope:identity,normalize,finish,child,decodeCalls:()=>decodeCalls,producerCalls:()=>producerCalls,producerSettled:()=>producerSettled,changeIdentity(value:typeof identity){current=value}}
}
async function artworkRouteUntil(check:()=>boolean):Promise<void>{const until=performance.now()+2000;while(!check()){assert.ok(performance.now()<until,'原图片组件未在两秒内到达');await new Promise<void>(resolve=>setImmediate(resolve))}}

test('专辑封面Main接线：真实物理往返规范化原副本，缺图与来源不可用分别保留原合同',async t=>{
  const h=await artworkRouteFixture(t),copies=artworkRouteCopies(),result=await h.bridge.call({copies},h.scope)
  assert.equal(h.producerCalls(),1);assert.equal(h.producerSettled(),1);assert.equal(result.status,'ready');assert.ok(result.image);assert.equal(artworkRouteDto.isLocalArtworkImage(result.image),true)
  assert.equal(result.image.original.sha256,copies.items[0]!.sourceIdentity);assert.equal(result.image.original.width,16);assert.equal(result.image.display.width,16)
  assert.ok(result.grid);assert.equal(artworkRouteDto.isLocalAlbumArtworkGrid(result.grid),true);assert.equal(result.grid.width,16);assert.equal(result.grid.height,16)
  const display=Buffer.from(result.image.display.dataUrl.slice('data:image/jpeg;base64,'.length),'base64')
  assert.equal(display.length,result.image.display.bytes);assert.equal(artworkRouteHash('sha256').update(display).digest('hex'),result.image.display.sha256)
  assert.equal(h.decodeCalls(),0,'JPEG已由真实Rust生成展示和网格副本，不能退回合成Main decoder')
  assert.deepEqual(await h.bridge.call({copies:{status:'ready',items:[]}},h.scope),{image:null,status:'ready'})
  assert.deepEqual(await h.bridge.call({copies:{status:'source-unavailable',items:[]}},h.scope),{image:null,status:'source-unavailable'})
  assert.equal(h.producerCalls(),3);assert.equal(h.producerSettled(),3);assert.equal(h.fatals.length,0);assert.equal(h.bridge.pending(),0)
  const request=h.outgoing.find(isLocalAlbumArtworkMainRequest)!;assert.ok(isLocalAlbumArtworkMainReply(h.replies[0],request));assert.equal(request.projection.command,'normalizeLocalAlbumArtwork');assert.equal(request.projection.epoch,h.author.binding.ownerEpoch)
})

test('专辑封面Main接线：畸形copies、未知命令/getter零派发；坏图片拒绝而不冒缺图',async t=>{
  const h=await artworkRouteFixture(t),before=h.outgoing.length
  const malformed={copies:{...artworkRouteCopies(),file:'/自有不应被读取'}} as unknown as Parameters<typeof h.bridge.call>[0]
  await assert.rejects(h.bridge.call(malformed,h.scope));assert.equal(h.outgoing.length,before);assert.equal(h.producerCalls(),0);assert.equal(h.decodeCalls(),0)
  let getters=0;const getter={};Object.defineProperty(getter,'copies',{enumerable:true,get(){getters++;return artworkRouteCopies()}})
  await assert.rejects(h.bridge.call(getter as Parameters<typeof h.bridge.call>[0],h.scope));assert.equal(getters,0);assert.equal(h.outgoing.length,before)
  const bad={...artworkRouteCopies(),items:[{...artworkRouteCopies().items[0]!,base64:'AA=='}]};await assert.rejects(h.bridge.call({copies:bad},h.scope));assert.equal(h.decodeCalls(),0)
  const q=h.outgoing.find(isLocalAlbumArtworkMainRequest)!;assert.equal(isLocalAlbumArtworkMainRequest({...q,projection:{...q.projection,command:'browseAlbumCandidates'}}),false)
  assert.equal(isLocalAlbumArtworkMainRequest({...q,epoch:randomUUID()}),false);assert.equal(h.bridge.pending(),0);assert.equal(h.fatals.length,0)
})

test('专辑封面Main接线：同物理port的异epoch/dataset不调用原Main decoder',async t=>{
  for(const field of ['epoch','datasetId'] as const){const h=await artworkRouteFixture(t),foreign={...h.scope,[field]:randomUUID()};h.changeIdentity(foreign)
    await assert.rejects(h.bridge.call({copies:artworkRouteCopies()},foreign));assert.equal(h.producerCalls(),0);assert.equal(h.decodeCalls(),0);assert.equal(h.bridge.pending(),0);assert.equal(h.fatals.length,0);await h.finish()}
})

test('专辑封面Main接线：有图片时无效ready/null或未知回复字段均拒绝，不固定image:null',async t=>{
  const h=await artworkRouteFixture(t,{normalize:async()=>({image:null,status:'ready'})})
  await assert.rejects(h.bridge.call({copies:artworkRouteCopies()},h.scope),error=>error instanceof Error&&'failure'in error&&(error as {failure:{error:{code:string}}}).failure.error.code==='INVALID_IPC_RESPONSE')
  const q=h.outgoing.find(isLocalAlbumArtworkMainRequest)!,response=h.replies[0];assert.equal(isLocalAlbumArtworkMainReply({...response as object,sourcePath:'/自有秘密'},q),false);assert.equal(h.decodeCalls(),0)
})

test('专辑封面Main接线：关闭发送原cancel，迟到图片不成功，实际producer settle前join仍等待',async t=>{
  const entered=warm469Deferred<{signal:AbortSignal;deadlineAtMs:number}>(),release=warm469Deferred<void>();let actualResult:{image:artworkRouteDto.LocalArtworkImage|null;status:'ready'|'source-unavailable'}|undefined
  const h=await artworkRouteFixture(t,{beforeClose:()=>release.resolve(),normalize:async(copies,context)=>{actualResult=await h.normalize(copies,context);entered.resolve(context);await release.promise;return actualResult}})
  t.after(()=>release.resolve());const work=h.bridge.call({copies:artworkRouteCopies()},h.scope),rejected=assert.rejects(work),context=await entered.promise
  h.bridge.close();await rejected;await artworkRouteUntil(()=>context.signal.aborted)
  let joined=false;const join=h.supervisor.joinPrivateLocalAlbumArtworkNormalizer().then(()=>{joined=true});await new Promise<void>(resolve=>setImmediate(resolve));assert.equal(joined,false)
  const q=h.outgoing.find(isLocalAlbumArtworkMainRequest)!,cancel=h.outgoing.find(row=>(row as {type?:unknown}).type==='local-album-artwork-main-cancel') as {id:string;epoch:string;datasetId:string;expiresAtMs:number}
  assert.equal(cancel.id,q.id);assert.equal(cancel.epoch,q.projection.epoch);assert.equal(cancel.datasetId,q.datasetId);assert.equal(cancel.expiresAtMs,q.expiresAtMs)
  release.resolve();await join;assert.equal(joined,true);assert.equal(h.bridge.pending(),0);assert.equal(h.fatals.length,0)
  assert.ok(h.replies.every(row=>!(row as {projection:{ok:boolean}}).projection.ok))
})

test('专辑封面退出屏障：旧Core已exit且child为空时shutdown仍等待原flight实际收尾',async t=>{
  const entered=warm469Deferred<{signal:AbortSignal;deadlineAtMs:number}>(),release=warm469Deferred<void>()
  let producerSettled=false,shutdownSettled=false,closing:Promise<void>|undefined
  const h=await artworkRouteFixture(t,{failRecoveryFork:true,beforeClose:()=>release.resolve(),normalize:async(_copies,context)=>{
    entered.resolve(context)
    try{await release.promise;throw new Error('原封面producer实际收尾后才拒绝。')}
    finally{producerSettled=true}
  }})
  const work=h.bridge.call({copies:artworkRouteCopies()},h.scope),rejected=assert.rejects(work)
  try{
    const context=await entered.promise,q=h.outgoing.find(isLocalAlbumArtworkMainRequest)!
    assert.equal(q.datasetId,h.author.binding.datasetId);assert.equal(q.projection.epoch,h.author.binding.ownerEpoch)
    // 只走原exit listener撤销旧child；恢复fork受控失败，不改Supervisor私有状态或原flight。
    h.child.exit(1);assert.equal(context.signal.aborted,true);h.bridge.close();await rejected;await flushStartup()
    closing=h.supervisor.shutdown().then(()=>{shutdownSettled=true});await flushStartup()
    assert.equal(producerSettled,false,'取消与Core exit不能冒充原producer已实际收尾。')
    assert.equal(shutdownSettled,false,'旧child为空也必须等待原封面flight的实际收尾Promise。')
    release.resolve();await closing
    assert.equal(producerSettled,true);assert.equal(h.supervisor.status,'stopped');assert.equal(h.child.killed,false)
    assert.equal(h.fatals.length,0);assert.equal(h.bridge.pending(),0)
  }finally{
    release.resolve();h.bridge.close();await rejected;await closing;await h.finish()
  }
})

test('专辑封面恢复屏障：自动恢复不得在旧flight实际收尾前fork第二actor',async()=>{
  const h=makeHarness(),datasetId=randomUUID(),entered=warm469Deferred<{signal:AbortSignal;deadlineAtMs:number}>(),release=warm469Deferred<void>()
  type Actor={child:FakeChild;main:FakePort;scope:{datasetId:string;epoch:string}}
  const actors:Actor[]=[],secondForked=warm469Deferred<Actor>(),outgoing:unknown[]=[],fatals:unknown[]=[]
  let producerSettled=false,normalizeCalls=0,receiveArtwork:Parameters<ArtworkUtilityPort['on']>[1]|undefined
  const fork=h.dependencies.fork
  h.dependencies.fork=(entry,args,options)=>{
    const child=fork(entry,args,options),channel=h.channels.at(-1)!,main=channel.port2,scope={datasetId,epoch:randomUUID()},actor={child,main,scope}
    actors.push(actor)
    main.postMessage=(message:unknown)=>{
      main.sent.push(message);const raw=message as Record<string,unknown>
      if(raw.command==='commandOutbox.context')queueMicrotask(()=>main.receive({version:1,id:raw.id,ok:true,result:{datasetId}}))
      else if(raw.type==='musicbridge.workbench.frame'&&raw.lane==='request'&&raw.part==='end')for(const frame of datasetWorkbenchFrames(datasetWorkbenchMeta(message as DatasetWorkbenchFrame),'response',{...scope,ready:true}))queueMicrotask(()=>main.receive(frame))
      else if(raw.command==='core.shutdown')queueMicrotask(()=>{main.receive({version:1,id:raw.id,ok:true,result:{stopped:true}});child.exit(0)})
      else if(raw.type==='local-album-artwork-main-response'&&actors[0]===actor)receiveArtwork?.({data:message})
    }
    if(actors.length===2)secondForked.resolve(actor)
    queueMicrotask(()=>ready(channel));return child
  }
  h.supervisor.configurePrivateLocalAlbumArtworkNormalizer(async(_copies,context)=>{
    normalizeCalls++;entered.resolve(context)
    try{await release.promise;throw new Error('原actor封面producer实际收尾后才拒绝。')}
    finally{producerSettled=true}
  })
  await h.supervisor.start()
  const first=actors[0]!,author=await h.supervisor.createWorkbenchRootMainAuthor()
  const bridge=createUtilityLocalAlbumArtworkBridge({on(_event,listener){receiveArtwork=listener},start(){},postMessage(message){outgoing.push(message);first.main.receive(message)}},()=>first.scope,()=>fatals.push('fatal'))
  const work=bridge.call({copies:artworkRouteCopies()},first.scope),rejected=assert.rejects(work)
  try{
    const context=await entered.promise,q=outgoing.find(isLocalAlbumArtworkMainRequest)!
    assert.equal(q.datasetId,author.binding.datasetId);assert.equal(q.projection.epoch,author.binding.ownerEpoch)
    first.child.exit(1);assert.equal(context.signal.aborted,true);bridge.close();await rejected;await flushStartup()
    assert.equal(producerSettled,false,'旧Core exit与原取消不能冒充原producer实际收尾。')
    assert.equal(actors.length,1,'自动恢复必须先等待旧flight原Promise，不能提前fork第二actor。')
    release.resolve();const second=await secondForked.promise;await h.supervisor.start()
    const nextAuthor=await h.supervisor.createWorkbenchRootMainAuthor()
    assert.equal(producerSettled,true);assert.equal(actors.length,2);assert.notEqual(second.child,first.child)
    assert.notEqual(second.main,first.main);assert.notEqual(nextAuthor.binding.ownerEpoch,author.binding.ownerEpoch)
    assert.equal(nextAuthor.binding.ownerEpoch,second.scope.epoch);assert.ok(nextAuthor.binding.childGeneration>author.binding.childGeneration)
    await assert.rejects(author.assertCurrent(author.binding));assert.equal(normalizeCalls,1)
    assert.equal(second.main.sent.some(row=>(row as {type?:unknown}).type==='local-album-artwork-main-response'),false)
    assert.equal(fatals.length,0);assert.equal(bridge.pending(),0)
  }finally{
    release.resolve();bridge.close();await rejected;await h.supervisor.shutdown();await h.supervisor.joinPrivateLocalAlbumArtworkNormalizer()
  }
})

test('专辑封面恢复屏障：等待原flight时shutdown后不得复活第二actor',async()=>{
  const h=makeHarness(),datasetId=randomUUID(),entered=warm469Deferred<{signal:AbortSignal;deadlineAtMs:number}>(),release=warm469Deferred<void>()
  const scopes:Array<{datasetId:string;epoch:string}>=[],outgoing:unknown[]=[],fatals:unknown[]=[]
  let producerSettled=false,shutdownSettled=false,closing:Promise<void>|undefined,recovery:Promise<unknown>|undefined,receiveArtwork:Parameters<ArtworkUtilityPort['on']>[1]|undefined
  const fork=h.dependencies.fork
  h.dependencies.fork=(entry,args,options)=>{
    const child=fork(entry,args,options),channel=h.channels.at(-1)!,main=channel.port2,scope={datasetId,epoch:randomUUID()}
    scopes.push(scope)
    main.postMessage=(message:unknown)=>{
      main.sent.push(message);const raw=message as Record<string,unknown>
      if(raw.command==='commandOutbox.context')queueMicrotask(()=>main.receive({version:1,id:raw.id,ok:true,result:{datasetId}}))
      else if(raw.type==='musicbridge.workbench.frame'&&raw.lane==='request'&&raw.part==='end')for(const frame of datasetWorkbenchFrames(datasetWorkbenchMeta(message as DatasetWorkbenchFrame),'response',{...scope,ready:true}))queueMicrotask(()=>main.receive(frame))
      else if(raw.command==='core.shutdown')queueMicrotask(()=>{main.receive({version:1,id:raw.id,ok:true,result:{stopped:true}});child.exit(0)})
      else if(raw.type==='local-album-artwork-main-response'&&h.channels[0]===channel)receiveArtwork?.({data:message})
    }
    queueMicrotask(()=>ready(channel));return child
  }
  h.supervisor.configurePrivateLocalAlbumArtworkNormalizer(async(_copies,context)=>{
    entered.resolve(context)
    try{await release.promise;throw new Error('停止中的原封面producer实际收尾后才拒绝。')}
    finally{producerSettled=true}
  })
  await h.supervisor.start()
  const first=h.children[0]!,main=h.channels[0]!.port2,scope=scopes[0]!,author=await h.supervisor.createWorkbenchRootMainAuthor()
  const bridge=createUtilityLocalAlbumArtworkBridge({on(_event,listener){receiveArtwork=listener},start(){},postMessage(message){outgoing.push(message);main.receive(message)}},()=>scope,()=>fatals.push('fatal'))
  const work=bridge.call({copies:artworkRouteCopies()},scope),rejected=assert.rejects(work)
  try{
    const context=await entered.promise,q=outgoing.find(isLocalAlbumArtworkMainRequest)!
    assert.equal(q.datasetId,author.binding.datasetId);assert.equal(q.projection.epoch,author.binding.ownerEpoch)
    first.exit(1);assert.equal(context.signal.aborted,true);bridge.close();await rejected
    // start只复用已登记的原自动恢复Promise；shutdown在原producer尚未settle时入场。
    recovery=h.supervisor.start().then(()=>undefined,error=>error)
    closing=h.supervisor.shutdown().then(()=>{shutdownSettled=true});await flushStartup()
    assert.equal(producerSettled,false);assert.equal(shutdownSettled,false);assert.equal(h.children.length,1)
    release.resolve();const [,outcome]=await Promise.all([closing,recovery])
    assert.equal(producerSettled,true);assert.equal(shutdownSettled,true)
    assert.equal(h.children.length,1,'原flight收尾后的自动恢复必须重核停止意图，不能复活第二actor。')
    assert.ok(outcome instanceof CoreIpcError);assert.equal(outcome.code,'INTERNAL_ERROR');assert.equal(h.supervisor.status,'stopped')
    await assert.rejects(author.assertCurrent(author.binding));assert.equal(first.killed,false)
    assert.equal(fatals.length,0);assert.equal(bridge.pending(),0)
  }finally{
    release.resolve();bridge.close();await rejected;await closing;await recovery;await h.supervisor.shutdown();await h.supervisor.joinPrivateLocalAlbumArtworkNormalizer()
  }
})

test('Core退出请求屏障：manual restart内部close期间后续shutdown撤销重启',async()=>{
  const h=makeHarness(),datasetId=randomUUID(),entered=warm469Deferred<{signal:AbortSignal;deadlineAtMs:number}>(),release=warm469Deferred<void>(),exited=warm469Deferred<void>()
  const scopes:Array<{datasetId:string;epoch:string}>=[],outgoing:unknown[]=[],fatals:unknown[]=[]
  let producerSettled=false,restartSettled=false,shutdownSettled=false,shutdownCommands=0,restarting:Promise<unknown>|undefined,closing:Promise<void>|undefined,receiveArtwork:Parameters<ArtworkUtilityPort['on']>[1]|undefined
  const fork=h.dependencies.fork
  h.dependencies.fork=(entry,args,options)=>{
    const child=fork(entry,args,options),channel=h.channels.at(-1)!,main=channel.port2,scope={datasetId,epoch:randomUUID()}
    scopes.push(scope)
    main.postMessage=(message:unknown)=>{
      main.sent.push(message);const raw=message as Record<string,unknown>
      if(raw.command==='commandOutbox.context')queueMicrotask(()=>main.receive({version:1,id:raw.id,ok:true,result:{datasetId}}))
      else if(raw.type==='musicbridge.workbench.frame'&&raw.lane==='request'&&raw.part==='end')for(const frame of datasetWorkbenchFrames(datasetWorkbenchMeta(message as DatasetWorkbenchFrame),'response',{...scope,ready:true}))queueMicrotask(()=>main.receive(frame))
      else if(raw.command==='core.shutdown'){shutdownCommands++;queueMicrotask(()=>{main.receive({version:1,id:raw.id,ok:true,result:{stopped:true}});child.exit(0)})}
      else if(raw.type==='local-album-artwork-main-response'&&h.channels[0]===channel)receiveArtwork?.({data:message})
    }
    queueMicrotask(()=>ready(channel));return child
  }
  h.supervisor.configurePrivateLocalAlbumArtworkNormalizer(async(_copies,context)=>{
    entered.resolve(context)
    try{await release.promise;throw new Error('重启关闭中的原封面producer实际收尾后才拒绝。')}
    finally{producerSettled=true}
  })
  await h.supervisor.start()
  const first=h.children[0]!,main=h.channels[0]!.port2,scope=scopes[0]!,author=await h.supervisor.createWorkbenchRootMainAuthor()
  const bridge=createUtilityLocalAlbumArtworkBridge({on(_event,listener){receiveArtwork=listener},start(){},postMessage(message){outgoing.push(message);main.receive(message)}},()=>scope,()=>fatals.push('fatal'))
  const work=bridge.call({copies:artworkRouteCopies()},scope),rejected=assert.rejects(work)
  try{
    const context=await entered.promise,q=outgoing.find(isLocalAlbumArtworkMainRequest)!
    assert.equal(q.datasetId,author.binding.datasetId);assert.equal(q.projection.epoch,author.binding.ownerEpoch)
    first.once('exit',()=>exited.resolve())
    restarting=h.supervisor.restart().then(()=>{restartSettled=true;return undefined},error=>{restartSettled=true;return error})
    await exited.promise;bridge.close();await rejected;await flushStartup()
    assert.equal(context.signal.aborted,true);assert.equal(producerSettled,false);assert.equal(restartSettled,false)
    closing=h.supervisor.shutdown().then(()=>{shutdownSettled=true});await flushStartup()
    assert.equal(shutdownSettled,false);assert.equal(shutdownCommands,1,'后续停止复用原close，不重发Owner关闭。')
    release.resolve();const [outcome]=await Promise.all([restarting,closing])
    assert.equal(producerSettled,true);assert.equal(restartSettled,true);assert.equal(shutdownSettled,true)
    assert.ok(outcome instanceof CoreIpcError);assert.equal(outcome.code,'NOT_READY')
    assert.equal(h.children.length,1,'复用关闭Promise也必须保留后续Quit，旧manual restart不得新建Core。')
    assert.equal(h.supervisor.status,'stopped');assert.equal(first.killed,false);assert.equal(shutdownCommands,1)
    await assert.rejects(author.assertCurrent(author.binding));assert.equal(fatals.length,0);assert.equal(bridge.pending(),0)
  }finally{
    release.resolve();bridge.close();await rejected;await restarting;await closing;await h.supervisor.shutdown();await h.supervisor.joinPrivateLocalAlbumArtworkNormalizer()
  }
})

test('Core退出请求屏障：启动失败等待原exit期间shutdown阻止下一次fork',async()=>{
  const h=makeHarness(),killed=warm469Deferred<void>()
  const supervisor=new CoreSupervisor({entryPath:'controlled-quit-during-startup',cwd:'.',dependencies:h.dependencies,requestTimeoutMs:20,startupTimeoutMs:20,onReady:()=>{throw new Error('受控恢复hook失败，旧child尚未退出。')}})
  let startSettled=false,closing:Promise<unknown>|undefined
  const starting=supervisor.start().then(()=>{startSettled=true;return undefined},error=>{startSettled=true;return error})
  const child=h.children[0]!
  // 仅改变受控Child的kill结果：已发送终止，但实际exit必须由后面的原事件确认。
  child.kill=()=>{child.killed=true;killed.resolve();return true}
  ready(h.channels[0]!)
  try{
    await killed.promise;await flushStartup()
    assert.equal(startSettled,false);assert.equal(h.children.length,1);assert.equal(h.channels[0]!.port2.closed,true)
    closing=supervisor.shutdown().then(()=>undefined,error=>error)
    child.exit(0)
    const [failure,closeFailure]=await Promise.all([starting,closing])
    assert.ok(failure instanceof CoreIpcError);assert.ok(closeFailure instanceof CoreIpcError);assert.equal(closeFailure.code,'NOT_READY')
    assert.equal(h.children.length,1,'exitWithin实际返回后仍须重核后续Quit，不能进入下一轮fork。')
    await supervisor.shutdown();assert.equal(supervisor.status,'stopped')
  }finally{
    for(const original of h.children)original.exit(0)
    await starting;await closing;await supervisor.shutdown()
  }
})

test('专辑封面Main接线：原两秒到期取消本flight，后续真实settle仅退休原迟到回包',async t=>{
  // 到期由原两秒时钟推进，物理MessagePort与原producer仍实际settle；不依赖宿主毫秒量化。
  t.mock.timers.enable({apis:['Date','setTimeout'],now:Date.now()})
  const entered=warm469Deferred<AbortSignal>(),release=warm469Deferred<void>()
  const h=await artworkRouteFixture(t,{beforeClose:()=>release.resolve(),normalize:async(copies,context)=>{const result=await h.normalize(copies,context);entered.resolve(context.signal);await release.promise;return result}})
  t.after(()=>release.resolve());const work=h.bridge.call({copies:artworkRouteCopies()},h.scope),rejected=assert.rejects(work,error=>error instanceof Error&&'failure'in error&&(error as {failure:{error:{code:string}}}).failure.error.code==='TIMEOUT'),signal=await entered.promise
  const q=h.outgoing.find(isLocalAlbumArtworkMainRequest)!;assert.ok(q.expiresAtMs>Date.now()&&q.expiresAtMs-Date.now()<=2000)
  assert.equal(signal.aborted,false);assert.equal(h.bridge.pending(),1)
  t.mock.timers.tick(2000)
  await rejected;await artworkRouteUntil(()=>signal.aborted);assert.ok(Date.now()>=q.expiresAtMs);assert.equal(h.bridge.pending(),0)
  const cancellations=h.outgoing.filter(row=>(row as {type?:unknown}).type==='local-album-artwork-main-cancel')
  assert.equal(cancellations.length,1);const cancel=cancellations[0] as {id:string;sequence:number;epoch:string;datasetId:string;expiresAtMs:number}
  assert.deepEqual({id:cancel.id,sequence:cancel.sequence,epoch:cancel.epoch,datasetId:cancel.datasetId,expiresAtMs:cancel.expiresAtMs},
    {id:q.id,sequence:q.sequence,epoch:q.projection.epoch,datasetId:q.datasetId,expiresAtMs:q.expiresAtMs})
  release.resolve();await h.supervisor.joinPrivateLocalAlbumArtworkNormalizer();await artworkRouteUntil(()=>h.replies.length===1);assert.equal(h.fatals.length,0)
  assert.ok(isLocalAlbumArtworkMainReply(h.replies[0],q));const late=h.replies[0] as {projection:{ok:boolean;failure:{error:{code:string}}}}
  assert.equal(late.projection.ok,false);assert.equal(late.projection.failure.error.code,'TIMEOUT');assert.equal(h.bridge.pending(),0)
  assert.equal(h.outgoing.filter(row=>(row as {type?:unknown}).type==='local-album-artwork-main-cancel').length,1)
  assert.ok(h.replies.every(row=>!(row as {projection:{ok:boolean}}).projection.ok));assert.equal(h.outgoing.filter(row=>isLocalAlbumArtworkMainRequest(row)).length,1)
})


test('专辑封面Main接线：原context剩余期限与signal透传，不重新获得两秒或重发UUID',async t=>{
  const entered=warm469Deferred<{signal:AbortSignal;deadlineAtMs:number}>(),release=warm469Deferred<void>()
  const h=await artworkRouteFixture(t,{beforeClose:()=>release.resolve(),normalize:async(copies,context)=>{const result=await h.normalize(copies,context);entered.resolve(context);await release.promise;return result}})
  t.after(()=>release.resolve());const controller=new AbortController(),deadlineAtMs=performance.now()+700,expiresAtMs=Date.now()+700
  const work=h.bridge.call({copies:artworkRouteCopies()},{...h.scope,signal:controller.signal,deadlineAtMs,expiresAtMs}),rejected=assert.rejects(work),context=await entered.promise
  const q=h.outgoing.find(isLocalAlbumArtworkMainRequest)!;assert.ok(q.expiresAtMs<=expiresAtMs);assert.ok(context.deadlineAtMs<=deadlineAtMs+1)
  controller.abort();await rejected;await artworkRouteUntil(()=>context.signal.aborted);assert.equal(h.bridge.pending(),0)
  release.resolve();await h.supervisor.joinPrivateLocalAlbumArtworkNormalizer();await new Promise<void>(resolve=>setImmediate(resolve));assert.equal(h.fatals.length,0)
  assert.equal(h.outgoing.filter(isLocalAlbumArtworkMainRequest).length,1);assert.ok(h.replies.every(row=>!(row as {projection:{ok:boolean}}).projection.ok))
})

test('专辑封面Main接线：合法原请求在传输中到期只回TIMEOUT，保Core与下一读取',async t=>{
  let first=true
  const h=await artworkRouteFixture(t,{receivedNow:raw=>{if(first&&isLocalAlbumArtworkMainRequest(raw)){first=false;return raw.expiresAtMs+1}return undefined}})
  await assert.rejects(h.bridge.call({copies:artworkRouteCopies()},h.scope),error=>error instanceof Error&&'failure'in error&&(error as {failure:{error:{code:string}}}).failure.error.code==='TIMEOUT')
  assert.equal(h.producerCalls(),0);assert.equal(h.producerSettled(),0);assert.equal(h.decodeCalls(),0);assert.equal(h.child.killed,false);assert.equal(h.supervisor.status,'ready');assert.equal(h.fatals.length,0)
  const expired=h.outgoing.find(isLocalAlbumArtworkMainRequest)!,reply=h.replies[0] as {expiresAtMs:number}
  assert.equal(reply.expiresAtMs,expired.expiresAtMs);assert.ok(isLocalAlbumArtworkMainReply(reply,expired))
  const next=await h.bridge.call({copies:artworkRouteCopies()},h.scope);assert.ok(next.image);assert.ok(next.grid);assert.equal(artworkRouteDto.isLocalAlbumArtworkGrid(next.grid),true);assert.equal(h.producerCalls(),1);assert.equal(h.producerSettled(),1)
  assert.equal(h.outgoing.filter(isLocalAlbumArtworkMainRequest).length,2);assert.equal(h.child.killed,false)
})

test('专辑封面Main接线：四个取消未settle的producer保持上限，第五回NOT_READY且Core可恢复',async t=>{
  const release=warm469Deferred<void>(),contexts:Array<{signal:AbortSignal;deadlineAtMs:number}>=[]
  const h=await artworkRouteFixture(t,{beforeClose:()=>release.resolve(),normalize:async(copies,context)=>{const result=await h.normalize(copies,context);contexts.push(context);await release.promise;return result}})
  t.after(()=>release.resolve());const controllers=Array.from({length:4},()=>new AbortController())
  const works=controllers.map(controller=>h.bridge.call({copies:artworkRouteCopies()},{...h.scope,signal:controller.signal})),rejected=Promise.all(works.map(work=>assert.rejects(work)))
  await artworkRouteUntil(()=>contexts.length===4);controllers.forEach(controller=>controller.abort());await rejected
  await artworkRouteUntil(()=>contexts.every(context=>context.signal.aborted));assert.equal(h.producerCalls(),4);assert.equal(h.producerSettled(),0);assert.equal(h.bridge.pending(),0)
  let joined=false;const join=h.supervisor.joinPrivateLocalAlbumArtworkNormalizer().then(()=>{joined=true});await new Promise<void>(resolve=>setImmediate(resolve));assert.equal(joined,false)
  await assert.rejects(h.bridge.call({copies:artworkRouteCopies()},h.scope),error=>error instanceof Error&&'failure'in error&&(error as {failure:{error:{code:string}}}).failure.error.code==='NOT_READY')
  assert.equal(h.producerCalls(),4);assert.equal(h.producerSettled(),0);assert.equal(h.child.killed,false);assert.equal(h.supervisor.status,'ready');assert.equal(h.fatals.length,0);assert.equal(joined,false)
  release.resolve();await join;assert.equal(joined,true);assert.equal(h.producerSettled(),4)
  const next=await h.bridge.call({copies:artworkRouteCopies()},h.scope);assert.ok(next.image);assert.ok(next.grid);assert.equal(h.producerCalls(),5);assert.equal(h.producerSettled(),5)
  assert.equal(h.outgoing.filter(isLocalAlbumArtworkMainRequest).length,6);assert.equal(h.fatals.length,0);assert.equal(h.child.killed,false)
})


// 原Supervisor+受控端口组件，非实际Utility/Owner/App；原guard与异常合同必须由调度执行后判定。
async function contextTraceHarness748() {
  const { datasetWorkbenchControl } = await import('../../../packages/bridge-core/src/collection/dataset-owner-protocol.js')
  const trace = await import('../../../packages/bridge-core/src/shared/local-album-read-trace-node.js')
  const { createHash } = await import('node:crypto')
  const h = makeHarness(), datasetId = randomUUID(), epoch = randomUUID()
  const starting = h.supervisor.start(), main = h.channels[0]!.port2, child = h.children[0]!
  let hold = false
  const pending: ReturnType<typeof datasetWorkbenchMeta>[] = []
  const contexts: ReturnType<typeof datasetWorkbenchMeta>[] = []
  const originalPost = main.postMessage.bind(main)
  main.postMessage = (message: unknown) => {
    originalPost(message)
    const raw = message as { command?: unknown; id?: unknown; type?: unknown; lane?: unknown; part?: unknown; kind?: unknown }
    if (raw.command === 'commandOutbox.context') queueMicrotask(() => main.receive({ version: IPC_VERSION, id: raw.id, ok: true, result: { datasetId } }))
    else if (raw.type === 'musicbridge.workbench.frame' && raw.lane === 'request' && raw.part === 'end' && (raw.kind === 'context' || raw.kind === 'context.identity')) {
      const meta = datasetWorkbenchMeta(message as DatasetWorkbenchFrame); contexts.push(meta)
      if (hold) pending.push(meta)
      else for (const frame of datasetWorkbenchFrames(meta, 'response', { datasetId, epoch, ready: true })) queueMicrotask(() => main.receive(frame))
    }
  }
  ready(h.channels[0]!); await starting
  const author = await h.supervisor.createWorkbenchRootMainAuthor()
  const parent = { sha256: '' }
  return { h, main, author, contexts, pending, parent, trace,
    hold(value: boolean) { hold = value },
    read() { const parentId = randomUUID(); parent.sha256 = createHash('sha256').update(parentId).digest('hex'); return trace.runLocalAlbumContext(parentId, null, 'main.dataset', () => author.assertCurrent(author.binding)) },
    reply(meta: ReturnType<typeof datasetWorkbenchMeta>, failure?: 'NOT_READY') {
      if (failure) { main.receive(datasetWorkbenchControl(meta, 'failure', failure)); main.receive(datasetWorkbenchControl(meta, 'settled')) }
      else for (const frame of datasetWorkbenchFrames(meta, 'response', { datasetId, epoch, ready: true })) main.receive(frame)
    },
    async close() {
      hold = false
      for (const meta of pending.splice(0)) for (const frame of datasetWorkbenchFrames(meta, 'response', { datasetId, epoch, ready: true })) main.receive(frame)
      const closing = h.supervisor.shutdown(); await flushStartup(); child.exit(0); await closing
    },
  }
}

test('专辑context Trace：原24预算在发送前拒绝，成功context不加RPC或证据行', async () => {
  const h = await contextTraceHarness748()
  try {
    const before = h.contexts.length
    await h.read(); assert.equal(h.contexts.length, before + 1)
    const success = h.trace.snapshotLocalAlbumReadTrace().records.filter(row => row.traceSha256 === h.parent.sha256 || row.parentSha256 === h.parent.sha256)
    assert.equal(success.length, 1); assert.equal(success[0]!.stage, 'main.dataset'); assert.equal(success[0]!.outcome, 'begin')
    h.hold(true)
    const flights = Array.from({ length: 24 }, () => h.author.assertCurrent(h.author.binding))
    const sent = h.contexts.length
    await assert.rejects(h.read(), error => error instanceof CoreIpcError && error.code === 'NOT_READY')
    assert.equal(h.contexts.length, sent)
    const refusal = h.trace.snapshotLocalAlbumReadTrace().firstRejects.find(row => row.traceSha256 === h.parent.sha256)
    assert.ok(refusal); assert.equal(refusal.firstStage, 'context.supervisor.budget'); assert.equal(refusal.code, 'NOT_READY'); assert.equal(refusal.matches.route, true)
    h.hold(false); for (const meta of h.pending.splice(0)) h.reply(meta)
    await Promise.all(flights)
  } finally { await h.close() }
})

test('专辑只读身份每次实发私有RPC，原工作台核验仍走完整context且伪造绑定零发送', async () => {
  const h = await contextTraceHarness748()
  try {
    const read = h.author.assertReadCurrent
    assert.ok(read)
    const before = h.contexts.length
    await read(h.author.binding); await read(h.author.binding)
    assert.deepEqual(h.contexts.slice(before).map(meta => meta.kind), ['context.identity', 'context.identity'])
    assert.notEqual(h.contexts[before]!.id, h.contexts[before + 1]!.id)
    assert.equal(h.contexts[before]!.epoch, h.author.binding.ownerEpoch)
    assert.equal(h.contexts[before]!.datasetId, h.author.binding.datasetId)
    await h.author.assertCurrent(h.author.binding)
    assert.equal(h.contexts.at(-1)!.kind, 'context')
    const sent = h.contexts.length
    for (const changed of [{ ownerEpoch: randomUUID() }, { datasetId: randomUUID() }, { childGeneration: 99 }, { authorityRef: {} }]) {
      await assert.rejects(read({ ...h.author.binding, ...changed }), error => error instanceof CoreIpcError && error.code === 'OUTBOX_SCOPE_MISMATCH')
    }
    assert.equal(h.contexts.length, sent)
  } finally { await h.close() }
})

test('专辑只读身份拒绝同路由返回的错误Owner代次，不把ready当成身份许可', async () => {
  const { datasetWorkbenchControl } = await import('../../../packages/bridge-core/src/collection/dataset-owner-protocol.js')
  const h = await contextTraceHarness748()
  try {
    assert.ok(h.author.assertReadCurrent)
    h.hold(true)
    const work = h.author.assertReadCurrent(h.author.binding)
    const rejected = assert.rejects(work, error => error instanceof CoreIpcError && error.code === 'OUTBOX_SCOPE_MISMATCH')
    const meta = h.pending.shift(); assert.ok(meta); assert.equal(meta.kind, 'context.identity')
    for (const frame of datasetWorkbenchFrames(meta, 'response', { datasetId: h.author.binding.datasetId, epoch: randomUUID(), ready: true })) h.main.receive(frame)
    await rejected
    h.main.receive(datasetWorkbenchControl(meta, 'settled'))
    assert.equal(h.h.supervisor.status, 'ready')
  } finally { await h.close() }
})

test('专辑context Trace：原Pending跨事件关联下游首码，诊断输出异常不改变原拒绝', async () => {
  const h = await contextTraceHarness748(), originalInfo = console.info
  try {
    h.hold(true)
    const read = h.read(), originalMeta = h.pending.shift(); assert.ok(originalMeta)
    assert.equal(h.trace.captureLocalAlbumContext(), undefined)
    console.info = () => { throw new Error('仅受控诊断输出失效') }
    const rejected = assert.rejects(read, error => error instanceof CoreIpcError && error.code === 'NOT_READY' && error.message === '原整理请求未确认，请核对原command/body回执')
    h.reply(originalMeta, 'NOT_READY'); await rejected
    const snapshot = h.trace.snapshotLocalAlbumReadTrace(), refusal = snapshot.firstRejects.find(row => row.traceSha256 === h.parent.sha256)
    assert.ok(refusal); assert.equal(refusal.firstStage, 'context.supervisor.receive.failure'); assert.equal(refusal.code, 'NOT_READY'); assert.equal(refusal.name, 'CoreIpcError')
    const childSha256 = h.trace.localAlbumTraceSha(originalMeta.id)
    assert.ok(snapshot.records.some(row => row.traceSha256 === childSha256 && row.parentSha256 === h.parent.sha256 && row.stage === 'context.supervisor.receive.failure'))
    assert.equal(h.contexts.length, 2); assert.equal(h.h.children[0]!.killed, false)
  } finally { console.info = originalInfo; await h.close() }
})

import { createLocalArtworkImportNormalizer, LocalArtworkNormalizationPhysicalError as AlbumOsPhysicalError } from '../src/main/local-library-workbench/artwork-import-normalizer.js'
import { mkdtemp as albumOsTemp, mkdir as albumOsMkdir, readdir as albumOsRead, rm as albumOsRm } from 'node:fs/promises'
import albumOsPath from 'node:path'

// 与生产格式探针相同的完整单帧1×1 VP8，不能用只有帧头的伪图片代替真实解码。
const albumOsWebp=()=>Buffer.from('UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA','base64')

/** 真实MessageChannel、生产Main adapter和Rust池；不再伪造已取消的逐图系统转换进程。 */
test('WebP普通专辑入口：实际Utility→Main往返沿同原2s，真实Rust转换JPEG并保源身份与任务收口',async t=>{
  const temporary=process.env.TMPDIR;if(!temporary?.startsWith('/Volumes/LifeWeave/Developer/CommandLine/tmp/'))throw Error('原图片组件必须使用外置临时根')
  const directory=await albumOsTemp(albumOsPath.join(temporary,'album-webp-main-')),privateRoot=albumOsPath.join(directory,'captured');await albumOsMkdir(privateRoot,{mode:0o700})
  const raw=albumOsWebp(),deadlines:number[]=[]
  const adapter=createLocalArtworkImportNormalizer({privateRoot,
    decode(){assert.fail('生产WebP异步路径不能借合成Main decoder通过')},
    spawnProcess(){assert.fail('生产Rust路径不拥有逐图系统转换器，不能伪造其close资格')},
  })
  const converted:Array<Awaited<ReturnType<typeof adapter.normalize>>>=[]
  const normalize=createLocalAlbumArtworkNormalizer(()=>{assert.fail('不能绕过原异步adapter')},{async normalize(bytes,context){
    assert.deepEqual(bytes,raw)
    const work=adapter.normalize(bytes,context);assert.deepEqual(adapter.inspect(),{active:1,retained:0,closing:false})
    const value=await work;converted.push(value);assert.deepEqual(adapter.inspect(),{active:0,retained:0,closing:false});return value
  }})
  const h=await artworkRouteFixture(t,{normalize:async(copies,context)=>{deadlines.push(context.deadlineAtMs);return normalize(copies,context)}})
  try{
    const sourceIdentity=artworkRouteHash('sha256').update(raw).digest('hex'),copies:artworkRouteDto.LocalArtworkSourceCopies={status:'ready',items:[{origin:'local-independent',sourceIdentity,sourceLabel:'自有完整WebP',base64:raw.toString('base64')}]}
    const before=Buffer.from(raw),deadlineAtMs=performance.now()+2000,expiresAtMs=Date.now()+2000
    const value=await h.bridge.call({copies},{...h.scope,deadlineAtMs,expiresAtMs})
    assert.ok(value.image);assert.equal(value.status,'ready');assert.equal(artworkRouteDto.isLocalArtworkImage(value.image),true);assert.equal(value.image.original.mime,'image/jpeg')
    assert.equal(converted.length,1);const result=converted[0]!,compatible=Buffer.from(result.compatibleOriginalBytes)
    assert.equal(result.input.mime,'image/webp');assert.equal(result.input.sha256,sourceIdentity);assert.equal(result.input.bytes,raw.length);assert.equal(result.input.converted,true)
    assert.deepEqual([...compatible.subarray(0,2)],[255,216]);assert.equal(value.image.original.sha256,artworkRouteHash('sha256').update(compatible).digest('hex'));assert.equal(value.image.original.bytes,compatible.length);assert.notEqual(value.image.original.sha256,sourceIdentity)
    assert.equal(value.image.original.width,1);assert.equal(value.image.original.height,1);assert.equal(value.image.display.width,1);assert.equal(value.image.display.height,1);assert.deepEqual(raw,before)
    const display=Buffer.from(value.image.display.dataUrl.slice('data:image/jpeg;base64,'.length),'base64')
    assert.equal(display.length,value.image.display.bytes);assert.equal(artworkRouteHash('sha256').update(display).digest('hex'),value.image.display.sha256)
    const request=h.outgoing.find(isLocalAlbumArtworkMainRequest)!;assert.ok(isLocalAlbumArtworkMainReply(h.replies[0],request));assert.ok(request.expiresAtMs<=expiresAtMs)
    assert.equal(deadlines.length,1);assert.ok(deadlines[0]!<=deadlineAtMs+1);assert.ok(deadlines[0]!>performance.now())
    assert.equal(h.producerCalls(),1);assert.equal(h.producerSettled(),1);assert.deepEqual(await albumOsRead(privateRoot),[]);assert.equal(h.bridge.pending(),0);assert.equal(h.fatals.length,0)
    await h.finish();await adapter.close();assert.deepEqual(adapter.inspect(),{active:0,retained:0,closing:true})
    await assert.rejects(adapter.normalize(raw,{signal:new AbortController().signal,deadlineAtMs}),{name:'AbortError'})
  }finally{await h.finish();await adapter.close();await albumOsRm(directory,{recursive:true,force:true})}
})

test('WebP普通专辑入口：所有副本共用原截止，物理失败不借后续JPEG冒无图或ready',async t=>{
  const signal=new AbortController(),deadlineAtMs=performance.now()+2000,physical=new AlbumOsPhysicalError(new Error('受控实际收尾未确认')),seen:number[]=[]
  let calls=0,currentChecks=0
  const assertCurrent=()=>{currentChecks++},original={signal:signal.signal,deadlineAtMs,assertCurrent}
  const normalize=createLocalAlbumArtworkNormalizer(()=>{assert.fail('本例不能绕过原异步作者')},{async normalize(_bytes,context){
    calls++;seen.push(context.deadlineAtMs);assert.equal(context.signal,original.signal);assert.equal(context.assertCurrent,assertCurrent);throw physical
  }})
  const raw=albumOsWebp(),copies:artworkRouteDto.LocalArtworkSourceCopies={status:'ready',items:[{origin:'embedded',sourceIdentity:artworkRouteHash('sha256').update(raw).digest('hex'),sourceLabel:'自有WebP',base64:raw.toString('base64')},{origin:'local-independent',sourceIdentity:artworkRouteHash('sha256').update(artworkRouteJpeg).digest('hex'),sourceLabel:'自有JPEG',base64:artworkRouteJpeg.toString('base64')}]}
  assert.ok(artworkRouteDto.isLocalArtworkCommandResult('localArtwork.readCandidates',copies),'受控副本先满足原DTO身份与闭字段，不能以早拒冒物理错误验证')
  await assert.rejects(normalize(copies,original),error=>error===physical);assert.equal(calls,1);assert.deepEqual(seen,[deadlineAtMs]);assert.ok(currentChecks>=2)
  await assert.rejects(normalize(copies));assert.equal(calls,1,'缺原context不得新建截止或进入adapter')
  const cancelled=new AbortController();cancelled.abort();await assert.rejects(normalize(copies,{signal:cancelled.signal,deadlineAtMs}),{name:'AbortError'});assert.equal(calls,1)
})

import { libraryRemovalClock as removalClockSupervisor } from '../../../packages/bridge-core/test/helpers/library-removal-clock.js'
import { isDatasetWorkbenchFrame, type DatasetWorkbenchMeta } from '../../../packages/bridge-core/src/collection/dataset-owner-protocol.js'

for(const mode of ['按原期限成功','原期限到期'] as const)test(`移除期限：实际Supervisor反向fence跨2秒仍等真实FD，迟到closed不放行（${mode}）`,async t=>{
  const h=await fenceHarness493(t,{held:true}),clock=removalClockSupervisor(t),pending=h.request(8000),observed=pending.then(()=>({ok:true}),error=>({error}))
  try{const accepted=await h.entered;assert.ok(accepted.q.expiresAtMs-Date.now()>7900&&accepted.q.expiresAtMs-Date.now()<=8000)
    assert.ok(accepted.context.deadlineAtMs-performance.now()>7900&&accepted.context.deadlineAtMs-performance.now()<=8000)
    clock.advance(2100);await flushStartup();assert.equal(accepted.context.signal.aborted,false);assert.equal(h.fd.fd>=0,true);assert.equal(h.replies.length,0)
    if(mode==='原期限到期'){clock.advance(5901);const result=await observed;assert.ok('error'in result);assert.equal(accepted.context.signal.aborted,true);assert.equal(h.fd.fd>=0,true)}
    h.gate.resolve();await h.supervisor.joinPrivateWorkbenchReadersProducer();const result=await observed,reply=await h.reply()
    assert.equal(h.fd.fd,-1);assert.equal(reply.physicalClosed,true);assert.equal(reply.ok,mode==='按原期限成功')
    assert.equal('ok'in result,mode==='按原期限成功');assert.equal(h.requests.length,1)
  }finally{clock.reset();await h.cleanup()}
})

for(const command of ['library.remove','library.rename'] as const)test(`移除期限：实际Supervisor发送仅remove使用原剩余8秒，普通请求仍2秒（${command}）`,{timeout:5000},async t=>{
  const h=await fenceHarness493(t),clock=removalClockSupervisor(t),originalPost=h.main.postMessage.bind(h.main);let meta:DatasetWorkbenchMeta|undefined;
  h.main.postMessage=(message:unknown)=>{if(isDatasetWorkbenchFrame(message)&&message.kind==='execute'&&message.lane==='request'){
      if(message.part==='begin')meta=datasetWorkbenchMeta(message);if(message.part==='end'){h.main.sent.push(message);return;}}
    originalPost(message);};
  const commandId=randomUUID(),libraryId=randomUUID(),request:import('../../../packages/bridge-core/src/collection/dataset-owner-protocol.js').DatasetWorkbenchRequest=command==='library.remove'
    ?{family:'management',command,payload:{commandId,libraryIds:[libraryId]}}:{family:'management',command,payload:{commandId,libraryId,name:'合成名称'}};
  const pending=h.author.request(request,{binding:h.author.binding,signal:new AbortController().signal,deadlineAtMs:performance.now()+8000}),observed=pending.then(value=>({value}),error=>({error}));
  try{assert.ok(meta);const remaining=meta.expiresAtMs-Date.now();assert.ok(command==='library.remove'?remaining>7900&&remaining<=8000:remaining<=2000);
    clock.advance(2100);await flushStartup();const receipt={commandId,kind:command,state:'succeeded',libraryIds:[libraryId],message:null};
    for(const frame of datasetWorkbenchFrames(meta,'response',receipt))h.main.receive(frame);
    const result=await observed;if(command==='library.remove')assert.ok('value'in result);else assert.ok('error'in result&&result.error instanceof CoreIpcError&&result.error.code==='TIMEOUT');
  }finally{clock.reset();await h.cleanup();}
});

function identityWaitObserved(promise: Promise<unknown>) {
  let done = false
  const result = promise.then(() => { done = true; return 'ok' }, error => { done = true; return error.code })
  return { result, done: () => done }
}

test('身份等待20秒：实际Main只读identity排队2.5秒仍成功，完整context保持2秒', async t => {
  const h = await contextTraceHarness748(), { libraryRemovalClock } = await import('../../../packages/bridge-core/test/helpers/library-removal-clock.js'), clock = libraryRemovalClock(t)
  try {
    h.hold(true)
    const reading = identityWaitObserved(h.author.assertReadCurrent!(h.author.binding)), identity = h.pending.shift()!
    const full = identityWaitObserved(h.author.assertCurrent(h.author.binding)), context = h.pending.shift()!
    assert.equal(identity.kind, 'context.identity'); assert.equal(context.kind, 'context')
    assert.ok(identity.expiresAtMs - Date.now() > 19_900 && identity.expiresAtMs - Date.now() <= 20_000)
    assert.ok(context.expiresAtMs - Date.now() <= 2_000)
    clock.advance(2_001); await flushStartup(); assert.equal(await full.result, 'TIMEOUT'); assert.equal(reading.done(), false)
    clock.advance(499); h.reply(context); h.reply(identity)
    assert.equal(await reading.result, 'ok'); assert.equal(await full.result, 'TIMEOUT')
    assert.equal(h.h.children[0]!.killed, false)
  } finally { clock.reset(); await h.close() }
})

test('身份等待20秒：Main在timer尚未回调时也拒绝超过原expiry的identity回复，下一操作重新发送', async t => {
  const h = await contextTraceHarness748(), { libraryRemovalClock } = await import('../../../packages/bridge-core/test/helpers/library-removal-clock.js'), clock = libraryRemovalClock(t)
  try {
    h.hold(true)
    const reading = identityWaitObserved(h.author.assertReadCurrent!(h.author.binding)), meta = h.pending.shift()!
    clock.elapse(20_001); assert.equal(reading.done(), false, '故意不执行timer回调')
    h.reply(meta); assert.equal(await reading.result, 'TIMEOUT')
    h.reply(meta); assert.equal(await reading.result, 'TIMEOUT', '迟到重复end不能改写原拒绝')
    h.hold(false); const before = h.contexts.length
    await h.author.assertReadCurrent!(h.author.binding); assert.equal(h.contexts.length, before + 1)
    assert.notEqual(h.contexts.at(-1)!.id, meta.id)
  } finally { clock.reset(); await h.close() }
})

test('身份等待20秒：Main主动关闭仍立即撤销排队identity，迟到ready身份不能复活旧route', async t => {
  const h = await contextTraceHarness748(), { libraryRemovalClock } = await import('../../../packages/bridge-core/test/helpers/library-removal-clock.js'), clock = libraryRemovalClock(t)
  try {
    h.hold(true)
    const reading = identityWaitObserved(h.author.assertReadCurrent!(h.author.binding)), meta = h.pending.shift()!
    clock.advance(2_500); await flushStartup(); assert.equal(reading.done(), false)
    const closing = h.h.supervisor.shutdown(); await flushStartup()
    assert.equal(await reading.result, 'NOT_READY')
    h.reply(meta); assert.equal(await reading.result, 'NOT_READY')
    h.h.children[0]!.exit(0); await closing; assert.equal(h.h.supervisor.status, 'stopped')
    await assert.rejects(h.author.assertReadCurrent!(h.author.binding), error => error instanceof CoreIpcError && error.code === 'OUTBOX_SCOPE_MISMATCH')
  } finally { clock.reset(); await h.close() }
})
