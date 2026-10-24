import assert from 'node:assert/strict'
import test from 'node:test'
import { runLibraryShutdownStep } from '../../src/shared/library-shutdown-log.js'
import { readLibraryOperationLine } from '../../src/shared/library-operation-log.js'

test('关闭阶段旁注：实际等待完成后才记录complete，返回原结果', async t => {
  const lines: string[] = []
  t.mock.method(console, 'info', (line: string) => { lines.push(line) })
  let finish!: (value: object) => void
  const operation = new Promise<object>(resolve => { finish = resolve }), result = { closed: true }
  const pending = runLibraryShutdownStep('owner.media-worker', () => operation)
  assert.deepEqual(lines.map(line => readLibraryOperationLine(line)?.state), ['start'])
  finish(result); assert.equal(await pending, result)
  const events = lines.map(line => readLibraryOperationLine(line))
  assert.ok(events.every(event => event?.action === 'shutdown.owner.media-worker' && event.part === 'library'))
  assert.deepEqual(events.map(event => event?.state), ['start', 'complete'])
  assert.ok(events[1]!.elapsedMs! >= 0)
})

test('关闭阶段旁注：异常原样传播，仅输出闭集安全码，不求值getter或输出路径和栈', async t => {
  const lines: string[] = []
  t.mock.method(console, 'info', (line: string) => { lines.push(line) })
  const failure = Object.assign(new Error('合成私密路径/不可输出'), { code: 'INVENTORY_UNAVAILABLE' })
  await assert.rejects(runLibraryShutdownStep('runtime.owner', async () => { throw failure }), error => error === failure)
  assert.equal(readLibraryOperationLine(lines.at(-1)!)?.code, 'INVENTORY_UNAVAILABLE')
  const nested = Object.assign(new Error('不能输出的Owner原文'), { failure: { error: { code: 'INTERNAL_ERROR' } } })
  await assert.rejects(runLibraryShutdownStep('runtime.owner', () => { throw nested }), error => error === nested)
  assert.equal(readLibraryOperationLine(lines.at(-1)!)?.code, 'INTERNAL_ERROR')
  let called = 0
  const accessor = new Error('合成私密路径/另一项')
  Object.defineProperty(accessor, 'code', { get() { called++; return '错误路径/未知码' } })
  await assert.rejects(runLibraryShutdownStep('owner.background', () => { throw accessor }), error => error === accessor)
  assert.equal(called, 0); assert.equal(readLibraryOperationLine(lines.at(-1)!)?.code, 'SHUTDOWN_STEP_FAILED')
  assert.ok(lines.every(line => !line.includes('私密路径') && !line.includes('不能输出') && !line.includes('Error:')))
})

test('关闭阶段旁注：日志输出故障不能替换实际成功或失败，也不重试关闭', async t => {
  t.mock.method(console, 'info', () => { throw new Error('合成日志输出失效') })
  let calls = 0
  assert.equal(await runLibraryShutdownStep('utility.dispatch', () => { calls++; return 17 }), 17)
  const failure = new Error('合成真实关闭失败')
  await assert.rejects(runLibraryShutdownStep('utility.workbench', () => { calls++; throw failure }), error => error === failure)
  assert.equal(calls, 2)
})
