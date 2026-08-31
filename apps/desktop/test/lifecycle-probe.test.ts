import assert from 'node:assert/strict'
import test from 'node:test'
import { createLifecycleProbe } from '../src/main/lifecycle-probe.js'

const prefix = 'TASK078_LIFECYCLE '
const tick = () => new Promise<void>(resolve => setImmediate(resolve))

test('普通模式不读取时钟、不调用sink，也不附加Promise观察', async () => {
  const probe = createLifecycleProbe({ enabled: false, now: () => { throw new Error('不应读取') }, sink: () => { throw new Error('不应输出') } })
  probe.mark('bootstrap-start')
  let observations = 0
  probe.observe({ then() { observations++ } } as unknown as Promise<void>, 'print-stop-settled', 'print-stop-failed')
  await tick()
  assert.equal(observations, 0)
})

test('仅有限阶段与core-exit整数进入输出，不记录调用方对象或多余信息', () => {
  const lines: string[] = []
  let clock = 100
  const probe = createLifecycleProbe({ enabled: true, now: () => clock, sink: line => lines.push(line) })
  clock = 112.25
  probe.mark('bootstrap-start')
  probe.mark('core-exit', 0)
  probe.mark('core-exit', -1)
  for (const phase of ['任意内容', '/private/example', ['bootstrap-start'], { phase: 'bootstrap-start' }]) probe.mark(phase as never)
  for (const value of [null, undefined, '0', 0.5, Number.NaN, Infinity, 256, -256]) probe.mark('core-exit', value as number)
  probe.mark('ui-loaded', 0)
  assert.deepEqual(lines.map(line => { assert.ok(line.startsWith(prefix)); assert.ok(line.endsWith('\n')); return JSON.parse(line.slice(prefix.length)) }), [
    { phase: 'bootstrap-start', elapsedMs: 12.25 },
    { phase: 'core-exit', elapsedMs: 12.25, exitCode: 0 },
    { phase: 'core-exit', elapsedMs: 12.25, exitCode: -1 },
  ])
})

test('时钟倒退、非有限值或抛错不制造阶段，后续有效值仍保持单调', () => {
  const lines: string[] = []
  let clock = 100, fail = false
  const probe = createLifecycleProbe({ enabled: true, now: () => { if (fail) throw new Error('时钟内部细节'); return clock }, sink: line => lines.push(line) })
  clock = 110; probe.mark('core-spawn')
  clock = 109; probe.mark('core-spawn')
  clock = Number.NaN; probe.mark('core-spawn')
  clock = Infinity; probe.mark('core-spawn')
  fail = true; assert.doesNotThrow(() => probe.mark('core-spawn'))
  fail = false; clock = 115; probe.mark('supervisor-ready')
  assert.deepEqual(lines.map(line => JSON.parse(line.slice(prefix.length)).elapsedMs), [10, 15])
  const broken = createLifecycleProbe({ enabled: true, now: () => { throw new Error('初始化时钟') }, sink: () => assert.fail('坏时钟不得输出') })
  assert.doesNotThrow(() => broken.mark('bootstrap-start'))
})

test('单实例最多输出256条，失败sink也消耗相同有限预算', () => {
  let count = 0
  const probe = createLifecycleProbe({ enabled: true, now: () => 1, sink: () => { count++; throw new Error('sink内部细节') } })
  for (let i = 0; i < 1000; i++) assert.doesNotThrow(() => probe.mark('core-spawn'))
  assert.equal(count, 256)
})

test('sink同步抛错、异步拒绝或坏thenable都不逸出或产生未处理拒绝', async () => {
  for (const sink of [() => { throw new Error('内部路径') }, () => Promise.reject(new Error('内部凭据')), () => ({ get then() { throw new Error('内部thenable') } })]) {
    const probe = createLifecycleProbe({ enabled: true, now: () => 1, sink })
    assert.doesNotThrow(() => probe.mark('bootstrap-start'))
  }
  await tick()
})

test('Promise观察不提前报settled，不更换原结果，成功和失败有独立阶段', async () => {
  const lines: string[] = []
  const probe = createLifecycleProbe({ enabled: true, now: () => 1, sink: line => lines.push(line) })
  let release!: (value: string) => void
  const pending = new Promise<string>(resolve => { release = resolve })
  assert.equal(probe.observe(pending, 'print-stop-settled', 'print-stop-failed'), undefined)
  await tick(); assert.equal(lines.length, 0)
  release('原结果'); assert.equal(await pending, '原结果')
  const original = new Error('原错误，不进入日志')
  const rejected = Promise.reject(original)
  probe.observe(rejected, 'print-stop-settled', 'print-stop-failed')
  await assert.rejects(rejected, error => error === original)
  await tick()
  assert.deepEqual(lines.map(line => JSON.parse(line.slice(prefix.length)).phase), ['print-stop-settled', 'print-stop-failed'])
  assert.ok(lines.every(line => !line.includes('原错误')))
})
