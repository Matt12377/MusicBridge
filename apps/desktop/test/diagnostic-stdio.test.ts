import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Writable } from 'node:stream'
import test from 'node:test'
import { createDiagnosticWriter, installDiagnosticStdioProtection } from '../src/main/diagnostic-stdio.js'
import { createLibraryOperationLogReader, LIBRARY_OPERATION_PREFIX } from '../../../packages/bridge-core/src/shared/library-operation-log.js'

class DiagnosticOutput extends EventEmitter {
  destroyed = false
  writableEnded = false
  attempts = 0
  lines: string[] = []
  writable = true
  failure?: Error

  write(line: string): boolean {
    this.attempts += 1
    if (this.failure) throw this.failure
    this.lines.push(line)
    return this.writable
  }
}

const pipeError = () => Object.assign(new Error('合成诊断管道已关闭'), { code: 'EPIPE' })
const operationLine = LIBRARY_OPERATION_PREFIX + JSON.stringify({
  version: 1, part: 'library', action: 'read.fixture', state: 'complete', atMs: 1,
  slow: false, message: '音乐库：完成', count: 1,
}) + '\n'

test('诊断输出：健康的两路保留原文，短暂反压不关闭通道', () => {
  const stdout = new DiagnosticOutput(), stderr = new DiagnosticOutput()
  installDiagnosticStdioProtection({ stdout, stderr })
  const writeOut = createDiagnosticWriter(stdout), writeError = createDiagnosticWriter(stderr)
  stdout.writable = false
  writeOut('首条正常日志\n')
  stdout.writable = true
  writeOut('后续正常日志\n')
  writeError('正常诊断错误\n')
  assert.deepEqual(stdout.lines, ['首条正常日志\n', '后续正常日志\n'])
  assert.deepEqual(stderr.lines, ['正常诊断错误\n'])
})

test('诊断输出：运营日志异步 EPIPE 不抛到主进程，另一通道仍可写', async t => {
  for (const failedChannel of ['stdout', 'stderr'] as const) {
    await t.test(failedChannel, async t => {
      const failure = pipeError()
      const broken = new Writable({
        autoDestroy: false,
        write(_chunk, _encoding, callback) { queueMicrotask(() => callback(failure)) },
      })
      t.after(() => { broken.destroy() })
      const writes = t.mock.method(broken, 'write')
      const healthy = new DiagnosticOutput()
      installDiagnosticStdioProtection(failedChannel === 'stdout'
        ? { stdout: broken, stderr: healthy } : { stdout: healthy, stderr: broken })
      const consume = createLibraryOperationLogReader(createDiagnosticWriter(broken))
      assert.doesNotThrow(() => consume(operationLine))
      await new Promise<void>(resolve => setImmediate(resolve))
      assert.equal(broken.errored, failure)
      assert.doesNotThrow(() => consume(operationLine))
      assert.doesNotThrow(() => broken.emit('error', pipeError()))
      assert.equal(writes.mock.callCount(), 1)
      createDiagnosticWriter(healthy)('健康通道继续\n')
      assert.deepEqual(healthy.lines, ['健康通道继续\n'])
    })
  }
})

test('诊断输出：同步写入失败只禁用该流，不重试或递归写错误', () => {
  const stdout = new DiagnosticOutput(), stderr = new DiagnosticOutput()
  installDiagnosticStdioProtection({ stdout, stderr })
  stdout.failure = pipeError()
  const write = createDiagnosticWriter(stdout)
  assert.doesNotThrow(() => write('管道断开时的日志\n'))
  assert.doesNotThrow(() => write('后续日志\n'))
  assert.equal(stdout.attempts, 1)
  assert.deepEqual(stderr.lines, [])
  createDiagnosticWriter(stderr)('仍可输出\n')
  assert.deepEqual(stderr.lines, ['仍可输出\n'])
  assert.doesNotThrow(() => stdout.emit('error', pipeError()))
})

test('诊断输出：重复安装与逐行转发不增加监听，保留原有监听', () => {
  const stdout = new DiagnosticOutput(), stderr = new DiagnosticOutput()
  let observed = 0
  stdout.on('error', () => { observed += 1 })
  installDiagnosticStdioProtection({ stdout, stderr })
  const writer = createDiagnosticWriter(stdout)
  for (let index = 0; index < 100; index += 1) {
    installDiagnosticStdioProtection({ stdout, stderr })
    assert.equal(createDiagnosticWriter(stdout), writer)
    writer('正常日志\n')
  }
  assert.equal(stdout.listenerCount('error'), 2)
  assert.equal(stdout.listenerCount('close'), 1)
  assert.equal(stderr.listenerCount('error'), 1)
  assert.equal(stderr.listenerCount('close'), 1)
  assert.equal(stdout.lines.length, 100)
  stdout.emit('error', pipeError())
  assert.equal(observed, 1)
  assert.doesNotThrow(() => stderr.emit('error', pipeError()))
  createDiagnosticWriter(stderr)('安装后已失效的通道\n')
  assert.equal(stderr.attempts, 0)
})

test('诊断输出：已关闭、已结束或已销毁的流不再写入', () => {
  for (const state of ['close', 'writableEnded', 'destroyed'] as const) {
    const stream = new DiagnosticOutput(), write = createDiagnosticWriter(stream)
    if (state === 'close') stream.emit('close')
    else stream[state] = true
    assert.doesNotThrow(() => write('退出期间的迟到日志\n'))
    assert.equal(stream.attempts, 0)
    assert.doesNotThrow(() => stream.emit('error', pipeError()))
  }
})
