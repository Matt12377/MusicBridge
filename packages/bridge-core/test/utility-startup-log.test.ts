import assert from 'node:assert/strict'
import test from 'node:test'
import { runCoreUtilityProcess, type UtilityPort } from '../src/utility-main.js'
import { readLibraryOperationLine } from '../src/shared/library-operation-log.js'

test('Utility启动失败：Owner首错在关闭前留痕，清理异常不替换原因或泄漏原文', async t => {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'parentPort'), previousExitCode = process.exitCode
  const lines: string[] = [], order: string[] = [], exits: unknown[] = []
  let receive!: (event: { data: unknown; ports: UtilityPort[] }) => void
  Object.defineProperty(process, 'parentPort', { configurable: true, value: { once(_event: string, callback: typeof receive) { receive = callback } } })
  t.after(() => {
    if (descriptor) Object.defineProperty(process, 'parentPort', descriptor)
    else Reflect.deleteProperty(process, 'parentPort')
    process.exitCode = previousExitCode
  })
  t.mock.method(console, 'info', (line: string) => { lines.push(line); order.push(readLibraryOperationLine(line)?.action ?? '') })
  t.mock.method(process, 'exit', ((code: unknown) => { exits.push(code) }) as typeof process.exit)
  const first = Object.assign(new Error('合成启动私密 http://example.invalid/?token=secret'), { code: 'EADDRINUSE' })
  await runCoreUtilityProcess({ MUSIC_BRIDGE_CORE_TEST_MODE: '1', MUSIC_BRIDGE_DATA_DIRECTORY: '/合成/不会读取' }, undefined, undefined, undefined, undefined, () => ({
    prepare: async () => { throw first },
    dispatch: async () => { assert.fail('禁止访问真实资料。') },
    commitBoot: async () => { assert.fail('准备失败不能commit。') },
    close: async () => { order.push('owner.cleanup'); throw Object.assign(new Error('合成清理私密'), { code: 'EACCES' }) },
  }))
  const port: UtilityPort & { close(): void } = { on() {}, start() {}, postMessage() {}, close() {} }
  receive({ data: { type: 'musicbridge.core.port' }, ports: [port] })
  const deadline = performance.now() + 2_000
  while (exits.length === 0) {
    assert.ok(performance.now() < deadline, '受控失败必须完成退出。')
    await new Promise<void>(resolve => setImmediate(resolve))
  }
  const events = lines.map(line => readLibraryOperationLine(line))
  assert.equal(events.find(event => event?.action === 'startup.owner.prepare' && event.state === 'error')?.code, 'EADDRINUSE')
  assert.equal(events.find(event => event?.action === 'startup.utility.bootstrap' && event.state === 'error')?.code, 'EADDRINUSE')
  assert.ok(order.indexOf('startup.utility.bootstrap') < order.indexOf('owner.cleanup'))
  assert.deepEqual(exits, [1])
  assert.ok(lines.every(line => !/私密|example\.invalid|token|Error:/u.test(line)))
})
