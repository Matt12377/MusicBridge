import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:net'
import test from 'node:test'
import { LocalCorePortError, selectLocalCorePorts, type LocalCorePorts } from '../src/main/local-core-ports.js'

async function bind(port = 0, host = '127.0.0.1'): Promise<{ server: Server; port: number }> {
  const server = createServer(socket => socket.destroy())
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen({ host, port, exclusive: true }, () => { server.off('error', reject); resolve() })
  })
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  return { server, port: address.port }
}
async function close(server: Server): Promise<void> {
  if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
}
async function pair(t: test.TestContext) {
  const control = await bind(), stream = await bind()
  t.after(async () => { await Promise.all([close(control.server), close(stream.server)]) })
  return { control, stream, ports: { controlPort: control.port, streamPort: stream.port } }
}
async function assertReleased(ports: LocalCorePorts): Promise<void> {
  const control = await bind(ports.controlPort)
  try { const stream = await bind(ports.streamPort); await close(stream.server) }
  finally { await close(control.server) }
}

test('本地Core端口：缺省空闲时沿用原端口，空白环境按缺省且不修改父环境', async t => {
  const fixture = await pair(t)
  await Promise.all([close(fixture.control.server), close(fixture.stream.server)])
  const parent = Object.freeze({ BRIDGE_CONTROL_PORT: ' ', BRIDGE_STREAM_PORT: '', NETEASE_COOKIE: '合成私密值' })
  const before = { ...parent }
  const selected = await selectLocalCorePorts(parent, { defaultPorts: fixture.ports })
  assert.deepEqual(selected, fixture.ports)
  assert.deepEqual(parent, before)
  await assertReleased(selected)
})

for (const blocked of ['control', 'both'] as const) test(`本地Core端口：${blocked === 'both' ? '两个' : '控制'}缺省端口真实占用时只回退冲突项`, async t => {
  const fixture = await pair(t)
  if (blocked === 'control') await close(fixture.stream.server)
  const selected = await selectLocalCorePorts({}, { defaultPorts: fixture.ports })
  assert.notEqual(selected.controlPort, fixture.control.port)
  assert.notEqual(selected.controlPort, selected.streamPort)
  if (blocked === 'both') assert.notEqual(selected.streamPort, fixture.stream.port)
  else assert.equal(selected.streamPort, fixture.stream.port)
  assert.ok(Object.values(selected).every(port => Number.isInteger(port) && port > 0 && port <= 65535))
  await assertReleased(selected)
})

test('本地Core端口：显式占用端口保持固定语义，不静默回退', async t => {
  const fixture = await pair(t)
  await assert.rejects(selectLocalCorePorts({ BRIDGE_CONTROL_PORT: String(fixture.control.port) }, { defaultPorts: fixture.ports }),
    error => error instanceof LocalCorePortError && error.code === 'EADDRINUSE' && error.role === 'control')
})

test('本地Core端口：显式媒体端口先保留，自动控制端口避让', async t => {
  const fixture = await pair(t)
  await close(fixture.stream.server)
  const selected = await selectLocalCorePorts({ BRIDGE_STREAM_PORT: String(fixture.stream.port) }, {
    defaultPorts: { controlPort: fixture.stream.port, streamPort: fixture.stream.port },
  })
  assert.equal(selected.streamPort, fixture.stream.port)
  assert.notEqual(selected.controlPort, fixture.stream.port)
  await assertReleased(selected)
})

test('本地Core端口：显式public base固定原媒体端口，冲突不能留下失配URL', async t => {
  const fixture = await pair(t)
  await close(fixture.control.server)
  const parent = Object.freeze({ BRIDGE_PUBLIC_STREAM_BASE_URL: `http://127.0.0.1:${fixture.stream.port}/合成原路径` })
  await assert.rejects(selectLocalCorePorts(parent, { defaultPorts: fixture.ports }),
    error => error instanceof LocalCorePortError && error.code === 'EADDRINUSE' && error.role === 'stream')
  const released = await bind(fixture.control.port)
  await close(released.server)
})

test('本地Core端口：后续固定端口失败时释放已探测的另一端口', async t => {
  const fixture = await pair(t)
  await close(fixture.control.server)
  await assert.rejects(selectLocalCorePorts({ BRIDGE_CONTROL_PORT: String(fixture.control.port), BRIDGE_STREAM_PORT: String(fixture.stream.port) }),
    error => error instanceof LocalCorePortError && error.code === 'EADDRINUSE')
  const released = await bind(fixture.control.port)
  await close(released.server)
})

test('本地Core端口：非法端口、同址固定重复和非loopback配置在监听前拒绝', async () => {
  for (const value of ['0', '65536', '-1', '1.5', 'NaN']) {
    await assert.rejects(selectLocalCorePorts({ BRIDGE_CONTROL_PORT: value }),
      error => error instanceof LocalCorePortError && error.code === 'CONFIG_INVALID')
  }
  for (const parent of [{ BRIDGE_CONTROL_HOST: '0.0.0.0' }, { BRIDGE_STREAM_HOST: '192.0.2.3' },
    { BRIDGE_CONTROL_PORT: '41001', BRIDGE_STREAM_PORT: '41001' },
    { BRIDGE_PUBLIC_STREAM_BASE_URL: 'https://127.0.0.1:41001' }, { BRIDGE_PUBLIC_STREAM_BASE_URL: '无效地址' }]) {
    await assert.rejects(selectLocalCorePorts(parent), error => error instanceof LocalCorePortError && error.code === 'CONFIG_INVALID')
  }
})

test('本地Core端口：IPv6 loopback保持原监听地址', async t => {
  let fixture: Awaited<ReturnType<typeof bind>>
  try { fixture = await bind(0, '::1') }
  catch (error) {
    if (['EAFNOSUPPORT', 'EADDRNOTAVAIL'].includes((error as NodeJS.ErrnoException).code ?? '')) { t.skip('本机没有IPv6 loopback。'); return }
    throw error
  }
  await close(fixture.server)
  const selected = await selectLocalCorePorts({ BRIDGE_CONTROL_HOST: '::1', BRIDGE_STREAM_HOST: '::1', BRIDGE_CONTROL_PORT: String(fixture.port) })
  assert.equal(selected.controlPort, fixture.port)
  const verify = await bind(selected.controlPort, '::1')
  await close(verify.server)
})
