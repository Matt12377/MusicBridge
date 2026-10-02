import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import type { RoonLibraryPage } from '@music-bridge/contracts'
import { CoreSupervisor, type CoreChildProcess, type CoreMessagePort } from '../src/main/core-supervisor.js'
import { createLibraryReadBroker } from '../src/main/library-read-ipc.js'
import { buildCoreEnvironment } from '../src/main/core-environment.js'
import { createLibraryReadTerminalClient } from '../src/preload/library-read-terminal.js'
import { createLibraryReadScope } from '../src/renderer/src/composables/libraryReadScope.js'
import { useRoonCollection } from '../src/renderer/src/composables/useRoonCollection.js'
import { roonLibraryMessage } from '../src/renderer/src/roonLibraryMessages.js'
import { createLibraryReadTraceWriter, LIBRARY_READ_TRACE_PREFIX } from '../src/shared/library-read-trace.js'
import { createRoonLibraryService } from '../../../packages/bridge-core/src/roon/library.js'
import { createRoonPublicLibrary } from '../../../packages/bridge-core/src/roon/public-library.js'
import { attachCoreRuntimePort, type CoreRuntimeForIpc } from '../../../packages/bridge-core/src/utility-main.js'

const turn = () => new Promise<void>(resolve => setImmediate(resolve))
class Port implements CoreMessagePort {
  peer!: Port
  listener?: (event: { data: unknown }) => void
  closed = false
  on(_event: 'message', listener: (event: { data: unknown }) => void): void { this.listener = listener }
  start(): void {}
  close(): void { this.closed = true }
  postMessage(message: unknown): void { queueMicrotask(() => { if (!this.closed && !this.peer.closed) this.peer.listener?.({ data: message }) }) }
}
async function harness(hold = false, hint: unknown = 'list', enabled = true) {
  const lines: string[] = [], forkOptions: Array<{ stdio: string; env: NodeJS.ProcessEnv }> = []
  const trace = createLibraryReadTraceWriter({ enabled, write: line => lines.push(line) })
  let scope = JSON.stringify([false, 0, 'private-read-scope', 'private-zone'])
  let reply!: (error: string | false, body: unknown) => void
  const service = createRoonLibraryService({ browse: {
    browse(_options, callback) { if (hold) reply = callback; else callback(false, { action: 'list', list: { level: 0, count: 1 } }) },
    load(options, callback) { callback(false, { offset: options.offset, items: [{ title: 'private-media-title', item_key: 'private-item-key', hint, subtitle: 'private-artist' }] }) },
  }, image: { get_image() {} } })
  const library = createRoonPublicLibrary(() => service)
  const child = {
    stdout: new EventEmitter(), stderr: new EventEmitter(), exits: [] as Array<(code: number) => void>,
    once(_event: 'exit', callback: (code: number) => void) { this.exits.push(callback) },
    exit(code: number) { for (const callback of this.exits.splice(0)) callback(code) },
    kill() { this.exit(0); return true },
    postMessage(_message: unknown, ports?: CoreMessagePort[]) {
      const coreTrace = createLibraryReadTraceWriter({ enabled, write: line => { this.stdout.emit('data', Buffer.from(line)) } })
      void attachCoreRuntimePort(ports![0]!, runtime, { ...(enabled ? { libraryReadTrace: coreTrace } : {}) })
    },
  }
  const runtime = {
    start: async () => {}, shutdown: async () => { queueMicrotask(() => child.exit(0)) },
    getState: () => ({ runtime: 'ready', roon: 'ready', provider: 'missing', activeStreamCount: 0, activePlaybackPresent: false }),
    getLibraryReadScope: () => scope,
    browseRoonAlbums: (page: { offset: number; limit: number }) => library.browseAlbums(page),
  } as unknown as CoreRuntimeForIpc
  const supervisor = new CoreSupervisor({ entryPath: '/synthetic/core.js', cwd: '/synthetic', requestTimeoutMs: 30, startupTimeoutMs: 1000,
    ...(enabled ? { libraryReadTrace: trace } : {}), dependencies: {
      createChannel() { const port1 = new Port(), port2 = new Port(); port1.peer = port2; port2.peer = port1; return { port1, port2 } },
      fork(_path, _args, options) { forkOptions.push(options); return child as CoreChildProcess },
    } })
  await supervisor.start()
  const broker = createLibraryReadBroker(supervisor, { ...(enabled ? { trace } : {}) })
  const client = createLibraryReadTerminalClient(async (channel, ...args) => {
    if (channel === 'library:read') return broker.read(1, args[0], args[1])
    if (channel === 'library:cancel-read') return broker.cancel(1, args[0], args[1])
    assert.fail('禁止其他 IPC 通道')
  }, enabled)
  let id = 0
  const reader = createLibraryReadScope(client, { createId: () => `11111111-1111-4111-8111-${String(++id).padStart(12, '0')}` })
  return { lines, forkOptions, reader, child, broker, client,
    events: () => lines.map(line => JSON.parse(line.slice(LIBRARY_READ_TRACE_PREFIX.length)) as Record<string, unknown>),
    reply: (error: string | false = false) => reply(error, { action: 'list', list: { level: 0, count: 1 } }),
    changeScope: () => { scope = JSON.stringify([false, 1, 'next-private-read-scope', 'private-zone']) },
    close: async () => { reader.dispose(); await supervisor.shutdown() },
  }
}
const pageRequest = { page: { offset: 0, limit: 24 } }
const read = (h: Awaited<ReturnType<typeof harness>>, signal?: AbortSignal) => h.reader.read('roon.library.albums', pageRequest, () => assert.fail('不允许 fallback'), signal ? { signal } : {})

test('逐请求终端整链：真实包装层与合成 SDK 完整成功，Renderer/Core ID 映射可对照', async t => {
  const h = await harness(); t.after(h.close); const page = await read(h); await turn()
  assert.equal(page.items.length, 1); assert.equal(h.forkOptions[0]?.stdio, 'pipe')
  const events = h.events()
  for (const stage of ['renderer.dispatch', 'main.receive', 'main.dispatch', 'core.receive', 'core.flight.start', 'sdk.dispatch', 'sdk.callback', 'core.map', 'core.finish', 'core.return', 'main.response', 'main.finish', 'renderer.return']) assert.ok(events.some(event => event.stage === stage), stage)
  const dispatch = events.find(event => event.stage === 'main.dispatch')!
  assert.notEqual(dispatch.rendererReadId, dispatch.coreReadId)
  assert.equal(events.find(event => event.stage === 'core.receive')?.coreReadId, dispatch.coreReadId)
  assert.equal(events.find(event => event.stage === 'renderer.return')?.rendererReadId, dispatch.rendererReadId)
  assert.equal(events.filter(event => event.stage === 'core.finish').length, 1)
  assert.equal(events.filter(event => event.outcome === 'cancelled').length, 0)
  h.child.stdout.emit('data', Buffer.from('SDK Cookie=private-stdout-secret\n')); h.child.stderr.emit('data', Buffer.from('private-stack-secret'))
  assert.doesNotMatch(h.lines.join(''), /private-|title|payload|item_key|session_key|Cookie|stack/u)
})

test('逐请求终端整链：Core 当前 scope 取消进入 Renderer error，脱敏布尔原因可见', async t => {
  const h = await harness(true); t.after(h.close)
  const collection = useRoonCollection((page, options) => h.reader.read('roon.library.albums', { page }, () => assert.fail('不允许 fallback'), options), roonLibraryMessage)
  const pending = collection.load(); await turn(); h.changeScope(); h.reply(); await pending; await turn()
  assert.match(collection.error.value ?? '', /取消/u)
  const events = h.events(); assert.ok(events.some(event => event.stage === 'core.scope' && event.scopeChanged === true && event.serviceChanged === true))
  assert.ok(events.some(event => event.stage === 'renderer.return' && event.outcome === 'cancelled'))
  assert.equal(events.filter(event => event.stage === 'main.cancel').length, 0)
  assert.doesNotMatch(h.lines.join(''), /private-read-scope|private-zone/u)
})

test('逐请求终端整链：离页取消有 Renderer/Main 来源，迟到回调不写回或追加第二个终态', async t => {
  const h = await harness(true); t.after(h.close)
  const collection = useRoonCollection((page, options) => h.reader.read('roon.library.albums', { page }, () => assert.fail('不允许 fallback'), options), roonLibraryMessage)
  const pending = collection.load(); await turn(); collection.suspend(); await pending; await turn(); h.reply(); await turn()
  assert.equal(collection.error.value, null); assert.equal(collection.page.value.items.length, 0)
  const events = h.events()
  assert.ok(events.some(event => event.stage === 'renderer.cancel' && event.reason === 'renderer-cancel'))
  assert.ok(events.some(event => event.stage === 'main.cancel' && event.reason === 'renderer-cancel'))
  assert.ok(events.some(event => event.stage === 'sdk.callback' && event.late === true))
  assert.equal(events.filter(event => event.stage === 'core.finish').length, 1)
  assert.equal(events.filter(event => event.stage === 'renderer.return').length, 1)
})

test('逐请求终端整链：非空 raw 被 hint 过滤有计数，SDK 私密错误仅输出安全枚举', async t => {
  const h = await harness(false, null); t.after(h.close); const page = await read(h); await turn()
  assert.equal(page.items.length, 0); assert.equal(page.total, 1)
  assert.ok(h.events().some(event => event.stage === 'core.map' && event.rawCount === 1 && event.mappedCount === 0 && event.total === 1))
  assert.ok(h.events().some(event => event.stage === 'sdk.callback' && (event.hintCounts as { null?: number } | undefined)?.null === 1))
  const failed = await harness(true); t.after(failed.close); const pending = read(failed); const rejected = assert.rejects(pending); await turn(); failed.reply('Cookie=private-sdk-error'); await rejected; await turn()
  assert.doesNotMatch(failed.lines.join(''), /Cookie|private-|stack/u)
})

test('逐请求终端：生产关闭不启用 utility pipe、IPC 尾参数或终端日志', async t => {
  const h = await harness(false, 'list', false); t.after(h.close); assert.equal((await read(h)).items.length, 1); await turn()
  assert.equal(h.forkOptions[0]?.stdio, 'ignore'); assert.deepEqual(h.lines, [])
  const calls: unknown[][] = [], client = createLibraryReadTerminalClient(async (...args) => { calls.push(args); return { items: [] } }, false)
  await client.readLibrary({ id: 'production-read', command: 'roon.library.albums', payload: pageRequest, deadlineAtMs: Date.now() + 1000 }); await client.cancelLibraryRead('production-read')
  assert.equal(calls.length, 2); assert.equal(calls[0]?.length, 2); assert.equal(calls[1]?.length, 2)
  assert.equal(buildCoreEnvironment({}, { startupTest: false, uiE2e: false, coreCrashGate: false, libraryReadTrace: false }).MUSIC_BRIDGE_LIBRARY_READ_TRACE, '0')
  assert.equal(buildCoreEnvironment({}, { startupTest: false, uiE2e: false, coreCrashGate: false, libraryReadTrace: true }).MUSIC_BRIDGE_LIBRARY_READ_TRACE, '1')
})

test('逐请求终端：Main stderr 接线只转发安全播放失败原因，丢弃 SDK 凭据文本', async t => {
  const h = await harness(); t.after(h.close)
  const output: string[] = []
  t.mock.method(process.stderr, 'write', ((chunk: string | Uint8Array) => { output.push(String(chunk)); return true }) as typeof process.stderr.write)
  h.child.stderr.emit('data', Buffer.from('SDK Cookie=private-cookie\n'))
  const line = JSON.stringify({ level: 'warn', event: 'queue_replace_failed', code: 'NETEASE_REQUEST_FAILED', reason: 'request-budget', stack: 'private-stack', payload: { cookie: 'private-cookie' } }) + '\n'
  h.child.stderr.emit('data', Buffer.from(line.slice(0, 20))); h.child.stderr.emit('data', Buffer.from(line.slice(20)))
  assert.deepEqual(output, ['[playback:replace-queue] {"code":"NETEASE_REQUEST_FAILED","reason":"request-budget"}\n'])
  assert.doesNotMatch(output.join(''), /private|Cookie|payload|stack/u)
})

test('逐请求终端：私有尾参数不能越权取消或成为任意日志通道，成功回执不取消', async () => {
  let signal!: AbortSignal, finish!: (value: RoonLibraryPage) => void
  const events: Array<Record<string, unknown>> = []
  const supervisor = { request: (_command: unknown, _payload: unknown, _expected: unknown, read: { signal: AbortSignal }) => { signal = read.signal; return new Promise(resolve => { finish = resolve }) } } as unknown as Pick<CoreSupervisor, 'request'>
  const broker = createLibraryReadBroker(supervisor, { trace: event => events.push(event) })
  const input = { id: 'not-a-uuid', command: 'roon.library.albums', payload: pageRequest, deadlineAtMs: Date.now() + 1000 }
  const pending = broker.read(1, input, { __musicBridgeLibraryReadTrace: 1, stage: 'renderer.dispatch' })
  assert.throws(() => broker.cancel(2, input.id, { __musicBridgeLibraryReadTrace: 1, stage: 'renderer.return', outcome: 'ok' }), /其他窗口/u)
  assert.throws(() => broker.cancel(1, input.id, { __musicBridgeLibraryReadTrace: 1, stage: 'renderer.cancel', payload: 'private-console-text' }), /诊断阶段/u)
  assert.equal(signal.aborted, false)
  finish({ items: [], offset: 0, limit: 24, total: 0, hasMore: false }); await pending
  broker.cancel(1, input.id, { __musicBridgeLibraryReadTrace: 1, stage: 'renderer.return', outcome: 'ok' })
  assert.equal(signal.aborted, false); assert.equal(events.at(-1)?.stage, 'renderer.return'); assert.doesNotMatch(JSON.stringify(events), /private-console-text/u)
})
