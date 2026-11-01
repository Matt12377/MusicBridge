import assert from 'node:assert/strict'
import test from 'node:test'
import { recordLibraryStartupFailure, traceLibraryStartup, readLibraryOperationLine, createLibraryOperationLogReader } from '../../src/shared/library-operation-log.js'

test('启动诊断：等待真实结算、保留返回值，固定阶段可经Main现有reader转发', async t => {
  const lines: string[] = [], forwarded: string[] = []
  t.mock.method(console, 'info', (line: string) => { lines.push(line) })
  let finish!: (value: object) => void
  const actual = new Promise<object>(resolve => { finish = resolve }), value = { prepared: true }
  const pending = traceLibraryStartup('owner.prepare', () => actual)
  assert.deepEqual(lines.map(line => readLibraryOperationLine(line)?.state), ['start'])
  finish(value)
  assert.equal(await pending, value)
  const reader = createLibraryOperationLogReader(line => forwarded.push(line))
  for (const line of lines) { reader(line.slice(0, 11)); reader(line.slice(11) + '\n') }
  const events = forwarded.map(line => readLibraryOperationLine(line.trimEnd()))
  assert.deepEqual(events.map(event => [event?.action, event?.state]), [['startup.owner.prepare', 'start'], ['startup.owner.prepare', 'complete']])
  assert.ok(events[1]!.elapsedMs! >= 0)
})

test('启动诊断：首错原样传播，只输出闭集码，不求值getter或输出异常、URL和环境', async t => {
  const lines: string[] = []
  t.mock.method(console, 'info', (line: string) => { lines.push(line) })
  for (const code of ['EADDRINUSE', 'EADDRNOTAVAIL', 'EACCES', 'TIMEOUT', 'CONFIG_INVALID', 'UNKNOWN']) {
    const error = Object.assign(new Error('合成私密原文 http://127.0.0.1/private?token=合成令牌'), { code, env: { NETEASE_COOKIE: '合成凭据' } })
    await assert.rejects(traceLibraryStartup('runtime.gateway', () => { throw error }), failure => failure === error)
    assert.equal(readLibraryOperationLine(lines.at(-1)!)?.code, code)
  }
  let getters = 0
  const accessor = new Error('不能输出的异常正文')
  Object.defineProperty(accessor, 'code', { get() { getters++; return 'EADDRINUSE' } })
  await assert.rejects(traceLibraryStartup('runtime.control', () => { throw accessor }), failure => failure === accessor)
  assert.equal(getters, 0)
  assert.equal(readLibraryOperationLine(lines.at(-1)!)?.code, 'UNKNOWN')
  const arbitrary = Object.assign(new Error('不能输出的堆栈'), { code: 'PRIVATE_SECRET_VALUE' })
  recordLibraryStartupFailure('owner.prepare', { failure: { error: { code: 'CONFIG_INVALID', message: '合成私密Owner原文' } } })
  assert.equal(readLibraryOperationLine(lines.at(-1)!)?.code, 'CONFIG_INVALID')
  recordLibraryStartupFailure('utility.bootstrap', arbitrary)
  recordLibraryStartupFailure('合成私密阶段' as never, arbitrary)
  assert.equal(readLibraryOperationLine(lines.at(-1)!)?.action, 'startup.utility.bootstrap')
  assert.ok(lines.every(line => !/合成私密|private|token|NETEASE_COOKIE|合成凭据|异常正文|堆栈|PRIVATE_SECRET|Error:/u.test(line)))
})

test('启动诊断：日志输出故障不改变原成功、首错和调用次数', async t => {
  t.mock.method(console, 'info', () => { throw new Error('合成日志通道故障') })
  let calls = 0
  assert.equal(await traceLibraryStartup('owner.commit', () => { calls++; return 17 }), 17)
  const first = Object.assign(new Error('合成原失败'), { code: 'EADDRINUSE' })
  await assert.rejects(traceLibraryStartup('runtime.roon', () => { calls++; throw first }), error => error === first)
  assert.equal(calls, 2)
})
