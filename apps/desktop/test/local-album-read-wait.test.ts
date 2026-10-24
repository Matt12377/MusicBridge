import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { randomUUID } from 'node:crypto'
import { IPC_VERSION, LOCAL_ALBUM_STATUSES, type LocalAlbumPage } from '@music-bridge/contracts'
import { CoreSupervisor, type CoreMessagePort, type CoreChildProcess } from '../src/main/core-supervisor.js'
import { isLocalAlbumMainRequest, isLocalAlbumMainResponse, type LocalAlbumMainRequest, type LocalAlbumMainResponse } from '../../../packages/bridge-core/src/collection/local-album-browser/main-protocol.js'

class Port implements CoreMessagePort {
  readonly sent: unknown[] = []
  closed = false
  private listener: ((event: { data: unknown }) => void) | undefined
  constructor(private readonly sentHook: (message: unknown) => void = () => {}) {}
  on(event: 'message', listener: (event: { data: unknown }) => void): void { assert.equal(event, 'message'); this.listener = listener }
  start(): void {}
  close(): void { this.closed = true }
  postMessage(message: unknown): void { if (this.closed) throw new Error('受控旧端口已关闭。'); this.sent.push(message); this.sentHook(message) }
  /** 故意允许向已关闭旧端口注入迟到帧，用实际Supervisor门禁证明隔离。 */
  receive(message: unknown): void { this.listener?.({ data: message }) }
}
class Child implements CoreChildProcess {
  private listeners: Array<(code: number) => void> = []
  exited = false
  postMessage(_message: unknown): void {}
  once(event: 'exit', listener: (code: number) => void): void { assert.equal(event, 'exit'); this.listeners.push(listener) }
  kill(): boolean { this.exit(0); return true }
  exit(code: number): void { if (this.exited) return; this.exited = true; for (const listener of this.listeners.splice(0)) listener(code) }
}
const turn = () => new Promise<void>(resolve => setImmediate(resolve))
async function eventually(ready: () => boolean) { for (let count = 0; !ready(); count++) { assert.ok(count < 64, '受控路由未完成预期转换'); await turn() } }
function ready(port: Port) { port.receive({ version: IPC_VERSION, event: 'core.ready', payload: { state: {
  runtime: 'ready', roon: 'disconnected', provider: 'missing', activeStreamCount: 0, activePlaybackPresent: false,
} } }) }
/** 实际Supervisor及物理route对象；受控端口/child不启动Electron、DB或源读取。 */
async function harness(t: TestContext, requestTimeoutMs?: number) {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const channels: Array<{ port1: Port; port2: Port }> = [], children: Child[] = []
  const supervisor = new CoreSupervisor({ entryPath: '/合成/未启动-core.js', cwd: '/合成/未启动', playbackEventProtocol: null,
    ...(requestTimeoutMs === undefined ? {} : { requestTimeoutMs }), dependencies: {
      createChannel() {
        const index = channels.length
        const primary = new Port(message => {
          const value = message as { type?: string; command?: string; id?: string }
          if (value.command === 'core.shutdown') queueMicrotask(() => primary.receive({ version: IPC_VERSION, id: value.id, ok: true, result: { stopped: true } }))
          if (value.type === 'musicbridge.core-shutdown-received') queueMicrotask(() => children[index]!.exit(0))
        })
        const channel = { port1: new Port(), port2: primary }; channels.push(channel); return channel
      },
      fork() { const child = new Child(); children.push(child); return child },
    },
  })
  t.after(async () => { try { await supervisor.shutdown() } finally { t.mock.timers.reset() } })
  const starting = supervisor.start(); ready(channels[0]!.port2); await starting
  return { supervisor, channels, children,
    get port() { return channels.at(-1)!.port2 },
    async advance(ms: number) { t.mock.timers.tick(ms); await turn() },
  }
}
function query(id: string = randomUUID(), datasetId: string = randomUUID()): LocalAlbumMainRequest {
  const call: LocalAlbumMainRequest = { version: 1, type: 'local-album-main-request', id, datasetId,
    request: { command: 'localAlbum.query', payload: { query: '', rootId: null, filter: 'all', offset: 0, limit: 50 } } }
  assert.equal(isLocalAlbumMainRequest(call), true); return call
}
function success(call: LocalAlbumMainRequest): LocalAlbumMainResponse {
  if (call.request.command !== 'localAlbum.query') throw new Error('本夹具只生成真实合同的空专辑页。')
  const counts = Object.fromEntries(['all', ...LOCAL_ALBUM_STATUSES].map(key => [key, 0])) as unknown as LocalAlbumPage['counts']
  const result: LocalAlbumPage = { ...call.request.payload, total: 0, hasMore: false, items: [], counts }
  const reply: LocalAlbumMainResponse = { version: 1, type: 'local-album-main-response', id: call.id, datasetId: call.datasetId, command: call.request.command, ok: true, result }
  assert.equal(isLocalAlbumMainResponse(reply, call), true); return reply
}
function watch<T>(promise: Promise<T>) {
  let settled = false
  const result = promise.then(value => { settled = true; return { ok: true as const, value } }, (error: unknown) => {
    settled = true; assert.ok(error && typeof error === 'object' && 'code' in error)
    return { ok: false as const, code: error.code }
  })
  return { result, settled: () => settled }
}

test('专辑只读等待默认20秒：普通control仍2秒，11.95秒同代真实DTO回包可成功', async t => {
  const f = await harness(t), call = query(), reading = watch(f.supervisor.readLocalAlbum(call))
  const control = watch(f.supervisor.request('core.ping', {}))
  assert.deepEqual(f.port.sent.find(isLocalAlbumMainRequest), call)
  await f.advance(2001)
  assert.equal(reading.settled(), false)
  assert.deepEqual(await control.result, { ok: false, code: 'TIMEOUT' })
  await f.advance(9949)
  assert.equal(reading.settled(), false)
  const reply = success(call); f.port.receive(reply)
  assert.deepEqual(await reading.result, { ok: true, value: reply })
  await f.advance(20_000)
  assert.equal(f.port.sent.filter(isLocalAlbumMainRequest).length, 1, '较长等待不自动重发读取')
})

test('专辑只读等待20秒封顶：19,999ms未超，20,000ms拒绝；迟到结果不能转成功或伪报quiet', async t => {
  const f = await harness(t), call = query(), reading = watch(f.supervisor.readLocalAlbum(call))
  await f.advance(19_999); assert.equal(reading.settled(), false)
  await f.advance(1); assert.deepEqual(await reading.result, { ok: false, code: 'TIMEOUT' })
  f.port.receive(success(call)); await turn()
  assert.deepEqual(await reading.result, { ok: false, code: 'TIMEOUT' })
  assert.equal(f.port.sent.length, 1, '原协议只停止Main等待；不新增取消帧、Source许可或quiet回执')
})

for (const timeout of [500, 2000, 30_000] as const) test(`专辑只读显式requestTimeoutMs=${timeout}保持更紧并封顶20秒`, async t => {
  const f = await harness(t, timeout), reading = watch(f.supervisor.readLocalAlbum(query())), effective = Math.min(timeout, 20_000)
  await f.advance(effective - 1); assert.equal(reading.settled(), false)
  await f.advance(1); assert.deepEqual(await reading.result, { ok: false, code: 'TIMEOUT' })
})

for (const changed of ['dataset', 'command', 'result'] as const) test(`延长等待不放宽回复${changed}身份或DTO核验`, async t => {
  const f = await harness(t), call = query(), reading = watch(f.supervisor.readLocalAlbum(call))
  await f.advance(2001); assert.equal(reading.settled(), false)
  const reply: Record<string, unknown> = { ...success(call) }
  if (changed === 'dataset') reply.datasetId = randomUUID()
  else if (changed === 'command') reply.command = 'localAlbum.tracks'
  else reply.result = { items: [] }
  f.port.receive(reply)
  assert.deepEqual(await reading.result, { ok: false, code: 'INVALID_IPC_RESPONSE' })
})

test('延长等待不放宽重复ID：2秒后原请求仍pending，不能替换其body或让新请求占用原回包', async t => {
  const f = await harness(t), call = query(), reading = watch(f.supervisor.readLocalAlbum(call))
  await f.advance(2001); assert.equal(reading.settled(), false)
  const duplicate = await watch(f.supervisor.readLocalAlbum(query(call.id, call.datasetId))).result
  assert.deepEqual(duplicate, { ok: false, code: 'INVALID_IPC_REQUEST' })
  assert.equal(f.port.sent.filter(isLocalAlbumMainRequest).length, 1)
  const reply = success(call); f.port.receive(reply); assert.deepEqual(await reading.result, { ok: true, value: reply })
})

test('专辑长等待仍即时服从主动撤销：restart拒旧请求，旧代同ID回包不能完成新代读取', async t => {
  const f = await harness(t), oldPort = f.port, oldCall = query(), old = watch(f.supervisor.readLocalAlbum(oldCall))
  await f.advance(2001); assert.equal(old.settled(), false)
  const restarting = f.supervisor.restart()
  await eventually(() => f.channels.length === 2)
  assert.deepEqual(await old.result, { ok: false, code: 'NOT_READY' })
  ready(f.channels[1]!.port2); await restarting
  const call = query(oldCall.id), reading = watch(f.supervisor.readLocalAlbum(call))
  oldPort.receive(success(oldCall)); await turn(); assert.equal(reading.settled(), false)
  const reply = success(call); f.port.receive(reply)
  assert.deepEqual(await reading.result, { ok: true, value: reply })
  assert.deepEqual(await old.result, { ok: false, code: 'NOT_READY' })
})

test('专辑只读原闭集不接收mutation或caller自带期限/用途，非法请求零发送', async t => {
  const f = await harness(t), call = query()
  for (const invalid of [
    { ...call, deadlineAtMs: Date.now() + 60_000 },
    { ...call, request: { command: 'localAlbum.query', payload: { ...call.request.payload, purpose: 'background' } } },
    { ...call, request: { command: 'localArtwork.apply', payload: {} } },
  ]) assert.deepEqual(await watch(f.supervisor.readLocalAlbum(invalid as unknown as LocalAlbumMainRequest)).result, { ok: false, code: 'INVALID_IPC_REQUEST' })
  assert.deepEqual(f.port.sent, [])
})
