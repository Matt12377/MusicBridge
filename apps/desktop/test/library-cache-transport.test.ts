import assert from 'node:assert/strict'
import test from 'node:test'
import type { LibraryReadCommand, LibraryReadRequest, IpcCommandResults } from '@music-bridge/contracts'
import { createLibraryReadScope } from '../src/renderer/src/composables/libraryReadScope.js'
import { createLibraryReadBroker } from '../src/main/library-read-ipc.js'
import { CoreSupervisor, type CoreMessagePort, type CoreChildProcess } from '../src/main/core-supervisor.js'
const command = 'roon.library.albums' as const
const payload = { page: { offset: 0, limit: 24 } }
const page = { items: [], offset: 0, limit: 24, hasMore: false }

test('005刷新：Renderer与Main传递reload，普通请求仍只有原四字段', async () => {
  const requests: LibraryReadRequest[] = [], modes: unknown[] = []
  const broker = createLibraryReadBroker({ request: async (_command, _payload, _dataset, read) => {
    modes.push(read?.cacheMode); return page as never
  } })
  const scope = createLibraryReadScope({
    readLibrary: <C extends LibraryReadCommand>(request: LibraryReadRequest<C>) => {
      requests.push(request); return broker.read(1, request) as Promise<IpcCommandResults[C]>
    }, cancelLibraryRead: async id => broker.cancel(1, id),
  })
  try {
    await scope.read(command, payload, async () => assert.fail('不回退'), { cacheMode: 'reload' })
    await scope.read(command, payload, async () => assert.fail('不回退'))
    assert.deepEqual(modes, ['reload', undefined])
    assert.equal(requests[0]?.cacheMode, 'reload')
    assert.deepEqual(Object.keys(requests[1]!).sort(), ['command', 'deadlineAtMs', 'id', 'payload'])
  } finally { scope.dispose() }
})

test('005刷新：非法mode在Renderer/Main入口拒绝，不派发或回放旧API', async () => {
  let calls = 0
  const broker = createLibraryReadBroker({ request: async () => { calls++; return page as never } })
  const scope = createLibraryReadScope({})
  try {
    await assert.rejects(scope.read(command, payload, async () => { calls++; return page }, { cacheMode: 'default' } as never), /INVALID_IPC_REQUEST/u)
    for (const cacheMode of ['default', true, ['reload']]) await assert.rejects(broker.read(1, { id: 'bad', command, payload, deadlineAtMs: Date.now() + 1_000, cacheMode }), (error: unknown) => !!error && typeof error === 'object' && 'code' in error && error.code === 'INVALID_IPC_REQUEST')
    assert.equal(calls, 0)
  } finally { scope.dispose() }
})

class Port implements CoreMessagePort {
  sent: unknown[] = []; listener?: (event: { data: unknown }) => void
  on(_event: 'message', listener: (event: { data: unknown }) => void) { this.listener = listener }
  start() {} close() {}
  postMessage(message: unknown) { this.sent.push(structuredClone(message)) }
  receive(data: unknown) { this.listener?.({ data }) }
}
class Child implements CoreChildProcess {
  exit?: (code: number) => void
  postMessage() {} once(_event: 'exit', listener: (code: number) => void) { this.exit = listener }
  kill() { this.exit?.(0); return true }
}

test('005刷新：真实Supervisor将readonlymode复制到Utility消息，不改变普通context', async () => {
  const port = new Port(), child = new Child()
  const supervisor = new CoreSupervisor({ entryPath: '/Volumes/LifeWeave/Developer/CommandLine/tmp/合成Core.js',
    cwd: '/Volumes/LifeWeave/Developer/CommandLine/tmp', requestTimeoutMs: 10, startupTimeoutMs: 1_000,
    dependencies: { createChannel: () => ({ port1: new Port(), port2: port }), fork: () => child } })
  const started = supervisor.start()
  port.receive({ version: 1, event: 'core.ready', payload: { state: { runtime: 'ready', roon: 'disconnected', provider: 'missing', activeStreamCount: 0, activePlaybackPresent: false } } })
  await started
  try {
    for (const cacheMode of ['reload', undefined] as const) {
      const pending = supervisor.request(command, payload, undefined, { deadlineAtMs: Date.now() + 1_000, ...(cacheMode ? { cacheMode } : {}) })
      void pending.catch(() => undefined)
      const sent = port.sent.at(-1) as { id: string; readContext: { deadlineAtMs: number; cacheMode?: 'reload' } }
      assert.equal(sent.readContext.cacheMode, cacheMode)
      if (!cacheMode) assert.deepEqual(Object.keys(sent.readContext), ['deadlineAtMs'])
      port.receive({ version: 1, id: sent.id, ok: true, result: page }); assert.deepEqual(await pending, page)
    }
    await assert.rejects(supervisor.request(command, payload, undefined, { cacheMode: 'default' } as never), /无效/u)
    await assert.rejects(supervisor.request('playback.stop', {}, undefined, { cacheMode: 'reload' }), /写命令/u)
  } finally { child.kill(); await supervisor.shutdown() }
})
