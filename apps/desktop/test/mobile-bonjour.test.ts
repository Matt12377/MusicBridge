import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import type { NetworkInterfaceInfo } from 'node:os'
import test from 'node:test'
import { buildMobileBonjourArgs, createMobileBonjourPublisher, readMobileBonjourPrivateIPv4Addresses,
  type MobileBonjourProcess, type MobileBonjourSpawn } from '../src/main/mobile-bonjour.js'

const connection = { serverId: 'server:12345678-1234-1234-1234-123456789abc', host: '192.168.5.88', port: 45391 }
const turn = () => new Promise<void>(resolve => setImmediate(resolve))
class Output extends EventEmitter { send(text: string) { this.emit('data', Buffer.from(text)) } }
class Child extends EventEmitter implements MobileBonjourProcess {
  stdout = new Output(); stderr = new Output(); signals: NodeJS.Signals[] = []
  autoExit = true
  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.signals.push(signal)
    if (this.autoExit) this.emit('exit', 0, signal)
    return true
  }
  ready() { this.stdout.send('Got a reply for service: Name now registered and active\n') }
}
function fixture(children: Child[] = [new Child()], overrides: Partial<Parameters<typeof createMobileBonjourPublisher>[0]> = {}) {
  const calls: { command: string; args: readonly string[]; options: Parameters<MobileBonjourSpawn>[2] }[] = []
  const publisher = createMobileBonjourPublisher({ localAddresses: () => [connection.host], computerName: () => '测试 Mac.local',
    publishTimeoutMs: 100, stopGraceMs: 10,
    spawn(command, args, options) { calls.push({ command, args, options }); return children[calls.length - 1]! }, ...overrides })
  return { publisher, calls, children }
}

test('Bonjour：仅公开五个 TXT 字段，实例名沿用电脑名且 UTF8 不超过63字节', () => {
  const args = buildMobileBonjourArgs({ ...connection, certificateSha256: 'a'.repeat(64) }, '书房 Mac.local')
  assert.deepEqual(args, ['-R', 'Mousa 书房 Mac', '_mousa._tcp', 'local.', '45391', 'v=1', 'id=' + connection.serverId,
    'host=192.168.5.88', 'port=45391', 'pairing=srp6a'])
  assert.ok(Buffer.byteLength(buildMobileBonjourArgs(connection, '音乐'.repeat(100))[1]!) <= 63)
  assert.ok(!args.some(arg => arg.includes('a'.repeat(64))))
})

test('Bonjour：接口枚举只收实际私网IPv4，排除loopback、VPN共享地址和公网', () => {
  const entry = (address: string, internal = false, family = 'IPv4') => ({ address, internal, family } as NetworkInterfaceInfo)
  assert.deepEqual(readMobileBonjourPrivateIPv4Addresses({ en0: [entry('192.168.5.88'), entry('10.0.0.2'), entry('172.16.1.2')],
    en1: [entry('192.168.5.88'), entry('127.0.0.1', true), entry('100.64.0.1'), entry('8.8.8.8'), entry('169.254.1.2'), entry('::1', false, 'IPv6')] }),
  ['10.0.0.2', '172.16.1.2', '192.168.5.88'])
})

test('Bonjour：无效地址、非本机地址、无效端口与身份不启动子进程', async () => {
  const f = fixture()
  for (const value of [{ ...connection, host: '127.0.0.1' }, { ...connection, host: '8.8.8.8' },
    { ...connection, host: '192.168.5.99' }, { ...connection, port: 0 }, { ...connection, port: 65536 },
    { ...connection, serverId: '-任意参数' }]) await assert.rejects(f.publisher.start(value))
  assert.equal(f.calls.length, 0); await f.publisher.stop()
})

test('Bonjour：工具存活不算发布成功，只有真实注册回执才就绪', async () => {
  const f = fixture(); let settled = false
  const starting = f.publisher.start(connection).then(() => { settled = true })
  await turn(); assert.equal(settled, false); assert.equal(f.publisher.getState().status, 'publishing')
  f.children[0]!.stdout.send('Registering Service Mousa\nGot a reply: Name now regis')
  await turn(); assert.equal(settled, false)
  f.children[0]!.stdout.send('tered and active\n'); await starting
  assert.deepEqual(f.publisher.getState(), { status: 'published' })
  assert.equal(f.calls[0]!.command, '/usr/bin/dns-sd'); assert.equal(f.calls[0]!.options.shell, false)
  assert.deepEqual(f.calls[0]!.options.env, { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' })
  await f.publisher.stop(); assert.deepEqual(f.children[0]!.signals, ['SIGTERM'])
})

test('Bonjour：相同配置并发及已发布重复start均不创建第二进程', async () => {
  const f = fixture(), first = f.publisher.start(connection), second = f.publisher.start(connection)
  assert.equal(first, second); await turn(); f.children[0]!.ready(); await first
  await f.publisher.start(connection); assert.equal(f.calls.length, 1)
  await Promise.all([f.publisher.stop(), f.publisher.stop()]); assert.equal(f.children[0]!.signals.length, 1)
  assert.deepEqual(f.publisher.getState(), { status: 'stopped' }); assert.equal(f.children[0]!.stdout.listenerCount('data'), 0)
})

test('Bonjour：换服务必须join旧进程，旧回执不能放行新注册', async () => {
  const first = new Child(), second = new Child(), f = fixture([first, second])
  const old = f.publisher.start(connection); await turn(); first.ready(); await old; first.autoExit = false
  const next = f.publisher.start({ ...connection, port: 45392 }); await turn()
  assert.equal(f.calls.length, 1); assert.deepEqual(first.signals, ['SIGTERM'])
  first.ready(); assert.equal(f.calls.length, 1)
  first.emit('exit', 0, 'SIGTERM'); await turn(); assert.equal(f.calls.length, 2)
  assert.equal(f.calls[1]!.args[4], '45392'); second.ready(); await next; await f.publisher.stop()
})

test('Bonjour：启动中stop撤销等待并join，不会残留注册或随后变为published', async () => {
  const f = fixture(), starting = f.publisher.start(connection), rejected = assert.rejects(starting, { code: 'PUBLISH_CANCELLED' })
  await turn(); await f.publisher.stop(); await rejected; f.children[0]!.ready()
  assert.deepEqual(f.publisher.getState(), { status: 'stopped' }); assert.equal(f.calls.length, 1)
})

test('Bonjour：连续两次不同start在首进程创建前合并为最后一次且旧调用明确取消', async () => {
  const f = fixture(), first = f.publisher.start(connection), rejected = assert.rejects(first, { code: 'PUBLISH_CANCELLED' })
  const last = f.publisher.start({ ...connection, port: 45392 }); await turn()
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0]!.args[4], '45392')
  f.children[0]!.ready(); await last; await rejected; await f.publisher.stop()
})

test('Bonjour：注册超时会停止原进程，受控错误不转发工具正文', async () => {
  const f = fixture(undefined, { publishTimeoutMs: 10 })
  const pending = f.publisher.start(connection); await turn(); f.children[0]!.stderr.send('合成禁止转发的秘密正文')
  await assert.rejects(pending, error => error instanceof Error && error.message === '局域网发现当前不可用。' && (error as { code?: string }).code === 'PUBLISH_TIMEOUT')
  assert.deepEqual(f.children[0]!.signals, ['SIGTERM']); assert.equal(f.publisher.getState().status, 'failed'); await f.publisher.stop()
})

test('Bonjour：spawn error只等close也能join，不将失败进程算成可复用服务', async () => {
  const f = fixture(), pending = f.publisher.start(connection), rejected = assert.rejects(pending, { code: 'PUBLISH_UNAVAILABLE' })
  await turn(); f.children[0]!.emit('error', new Error('合成私密异常正文')); f.children[0]!.emit('close', null, null)
  await rejected; await f.publisher.stop(); assert.equal(f.publisher.getState().status, 'stopped')
})

test('Bonjour：已发布进程自然退出后标记失败，不自动重启或借用旧发布', async () => {
  const f = fixture(), pending = f.publisher.start(connection); await turn(); f.children[0]!.ready(); await pending
  f.children[0]!.emit('exit', 1, null); assert.deepEqual(f.publisher.getState(), { status: 'failed', code: 'PUBLISH_EXITED' })
  await turn(); assert.equal(f.calls.length, 1); await f.publisher.stop()
})

test('Bonjour：注册回执与工具错误同栈到达时不能把正在撤销的进程记为published', async () => {
  const f = fixture(), pending = f.publisher.start(connection), rejected = assert.rejects(pending, { code: 'PUBLISH_CANCELLED' })
  await turn(); f.children[0]!.ready(); f.children[0]!.emit('error', new Error('合成工具错误'))
  await rejected; assert.equal(f.publisher.getState().status, 'failed'); await f.publisher.stop()
})

test('Bonjour：旧进程未静止时拒绝第二注册，保留所有权供后续stop收口', async () => {
  const child = new Child(), f = fixture([child, new Child()]), old = f.publisher.start(connection)
  await turn(); child.ready(); await old; child.autoExit = false
  await assert.rejects(f.publisher.start({ ...connection, port: 45392 }), { code: 'STOP_TIMEOUT' })
  assert.equal(f.calls.length, 1); assert.ok(child.signals.includes('SIGKILL'))
  assert.deepEqual(f.publisher.getState(), { status: 'failed', code: 'STOP_TIMEOUT' })
  child.emit('close', 0, 'SIGKILL'); await f.publisher.stop(); assert.equal(f.publisher.getState().status, 'stopped')
})
