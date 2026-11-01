import assert from 'node:assert/strict'
import { createServer } from 'node:net'
import test from 'node:test'
import { createBridgeRuntime } from '../src/runtime.js'
import { RoonAudioInputAdapter } from '../src/roon/adapter.js'
import { createLocalFavoriteRepository } from '../src/favorites/repository.js'
import { readLibraryOperationLine } from '../src/shared/library-operation-log.js'

test('真实Runtime：Gateway占用首错先记录，Owner清理失败不能覆盖EADDRINUSE', async t => {
  const occupied = createServer(socket => socket.destroy())
  await new Promise<void>((resolve, reject) => {
    occupied.once('error', reject)
    occupied.listen(0, '127.0.0.1', () => { occupied.off('error', reject); resolve() })
  })
  t.after(async () => { if (occupied.listening) await new Promise<void>((resolve, reject) => occupied.close(error => error ? reject(error) : resolve())) })
  const address = occupied.address()
  assert.ok(address && typeof address === 'object')
  const lines: string[] = []
  t.mock.method(console, 'info', (line: string) => { lines.push(line) })
  const roonStart = t.mock.method(RoonAudioInputAdapter.prototype, 'start', async () => { assert.fail('Gateway失败后不能启动Roon。') })
  const cleanupError = Object.assign(new Error('合成清理私密原文'), { code: 'CONFIG_INVALID' })
  const runtime = createBridgeRuntime({
    env: { BRIDGE_CONTROL_HOST: '127.0.0.1', BRIDGE_STREAM_HOST: '127.0.0.1', BRIDGE_STREAM_PORT: String(address.port) },
    roonSdk: { createApi: () => assert.fail('此测试禁止真实Roon连接。') } as never,
    favoriteRepository: createLocalFavoriteRepository(),
    datasetOwnerEndpoint: {
      prepare: async () => { throw new Error('此测试无需Owner prepare。') },
      dispatch: async () => { throw new Error('此测试禁止资料访问。') },
      commitBoot: async () => { throw new Error('此测试禁止Owner commit。') },
      close: async () => { throw cleanupError },
    },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  })
  t.after(() => runtime.shutdown().catch(() => {}))
  await assert.rejects(runtime.start(), error => (error as NodeJS.ErrnoException).code === 'EADDRINUSE' && error !== cleanupError)
  const events = lines.map(line => readLibraryOperationLine(line))
  const gatewayFailure = events.find(event => event?.action === 'startup.runtime.gateway' && event.state === 'error')
  assert.equal(gatewayFailure?.code, 'EADDRINUSE')
  assert.ok(events.findIndex(event => event?.action === 'startup.runtime.gateway' && event.state === 'error')
    < events.findIndex(event => event?.action === 'shutdown.runtime.owner' && event.state === 'start'))
  assert.equal(events.some(event => event?.action === 'startup.runtime.roon'), false)
  assert.equal(roonStart.mock.callCount(), 0)
  assert.equal(runtime.getState().runtime, 'failed')
  assert.ok(lines.every(line => !line.includes('私密原文') && !line.includes('Error:')))
})
