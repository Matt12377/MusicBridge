import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { once } from 'node:events'
import { runStartupProcess, type StartupProcessOptions } from '../scripts/startup-gate-process.mjs'

const cwd = new URL('..', import.meta.url).pathname
const marker = 'DESKTOP_STARTUP_READY'
const options: StartupProcessOptions = { cwd, readyMarker: marker, expectedMarker: marker, startupTimeoutMs: 500, exitTimeoutMs: 160, killGraceMs: 60, closeTimeoutMs: 160, outputLimitBytes: 8192 }
const runFixture = (source: string, overrides: Partial<StartupProcessOptions> = {}) => runStartupProcess(process.execPath, ['-e', source], { ...options, ...overrides })

test('READY后挂起仍有退出期限，不能把READY当作完成', async () => {
  const result = await runFixture(`process.stdout.write('${marker}\\n'); setInterval(() => {}, 1000)`)
  assert.equal(result.failure, 'exit-timeout')
  assert.equal(result.ready, true)
  assert.equal(result.closed, true)
  assert.notEqual(result.signal, null)
})

test('退出码0早于stdio关闭时，必须等待真实close才能成功', async () => {
  const started = Date.now()
  const result = await runFixture(`require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 250)'], { stdio: ['ignore', 1, 2] }); process.stdout.write('${marker}\\n'); process.exit(0)`, { exitTimeoutMs: 800, closeTimeoutMs: 600 })
  assert.equal(result.failure, null)
  assert.equal(result.code, 0)
  assert.equal(result.signal, null)
  assert.equal(result.closed, true)
  assert.ok(Date.now() - started >= 200)
})

test('启动没有READY有界失败；无法退出时只终止所建子进程', async t => {
  const unrelated = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  t.after(async () => { const closed = once(unrelated, 'close'); unrelated.kill('SIGKILL'); await closed })
  const result = await runFixture('setInterval(() => {}, 1000)', { startupTimeoutMs: 100 })
  assert.equal(result.failure, 'startup-timeout'); assert.equal(result.closed, true)
  assert.equal(unrelated.exitCode, null); assert.equal(unrelated.signalCode, null)
})

test('READY后忽略SIGTERM仍被有界SIGKILL收口，重复READY不延长期限', async () => {
  const started = Date.now()
  const result = await runFixture(`process.on('SIGTERM', () => {}); process.stdout.write('${marker}'); setInterval(() => process.stdout.write('${marker}'), 25)`)
  assert.equal(result.failure, 'exit-timeout'); assert.equal(result.signal, 'SIGKILL'); assert.equal(result.closed, true)
  assert.ok(Date.now() - started < 1500)
})

test('exit后后代保留stdio必须close-timeout，不能重发信号到已退出PID', async () => {
  const started = Date.now()
  const result = await runFixture(`require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 650)'], { stdio: ['ignore', 1, 2] }); process.stdout.write('${marker}'); process.exit(0)`, { exitTimeoutMs: 1000, closeTimeoutMs: 80 })
  assert.equal(result.failure, 'close-timeout'); assert.equal(result.code, 0); assert.equal(result.signal, null); assert.equal(result.closed, false)
  assert.ok(Date.now() - started < 600)
})

test('正常close需code0且signalnull；非0和信号退出均失败', async () => {
  const ok = await runFixture(`process.stdout.write('${marker}')`)
  assert.equal(ok.failure, null); assert.equal(ok.code, 0); assert.equal(ok.signal, null); assert.equal(ok.closed, true)
  for (const source of [`process.stdout.write('${marker}'); process.exitCode = 7`, `process.stdout.write('${marker}'); process.kill(process.pid, 'SIGTERM')`]) {
    const failed = await runFixture(source); assert.equal(failed.failure, 'process-exit'); assert.equal(failed.closed, true)
  }
})

test('spawn错误有界失败且不返回命令、环境或内部错误文本', async () => {
  const result = await runStartupProcess('/不存在的合成可执行文件', [], { ...options, env: { SYNTHETIC_SECRET: '不可回传的合成值' } })
  assert.equal(result.failure, 'spawn-error'); assert.equal(result.closed, true)
  assert.doesNotMatch(JSON.stringify(result), /不存在|合成值|ENOENT|SYNTHETIC_SECRET/u)
})

test('READY与专用PASS可以跨chunk，READY不吞掉后续专用marker', async () => {
  for (const expectedMarker of ['CREDENTIAL_VAULT_GATE_PASS', 'CORE_RESTART_CREDENTIAL_RECOVERY_GATE_PASS', 'CORE_CRASH_GATE_PASS']) {
    const result = await runFixture(`process.stdout.write('DESKTOP_START'); setTimeout(() => process.stdout.write('UP_READY'), 10); setTimeout(() => process.stdout.write('${expectedMarker.slice(0, 10)}'), 20); setTimeout(() => process.stdout.write('${expectedMarker.slice(10)}'), 30)`, { expectedMarker })
    assert.equal(result.failure, null); assert.equal(result.ready, true); assert.equal(result.markerSeen, true)
  }
  const missing = await runFixture(`process.stdout.write('${marker}')`, { expectedMarker: 'CORE_CRASH_GATE_PASS' })
  assert.equal(missing.failure, 'marker-missing')
})

test('stdout或stderr输出超预算即失败，只保留固定结果不回传原始内容', async () => {
  for (const stream of ['stdout', 'stderr']) {
    const result = await runFixture(`process.${stream}.write('合成秘密'.repeat(10000)); setInterval(() => {}, 1000)`)
    assert.equal(result.failure, 'output-limit'); assert.equal(result.closed, true)
    assert.doesNotMatch(JSON.stringify(result), /合成秘密|stdout|stderr/u)
  }
})

test('无marker的构建模式也等待close且保持继承输出选项', async () => {
  const result = await runFixture('process.exitCode = 0', { readyMarker: undefined, expectedMarker: undefined, output: 'inherit' })
  assert.equal(result.failure, null); assert.equal(result.closed, true)
})

test('正式入口接入有限helper、保留各Gate marker且不删除证据或打印原始stderr', async () => {
  const source = await readFile(new URL('../scripts/startup-gate.mjs', import.meta.url), 'utf8')
  assert.match(source, /runStartupProcess/u); assert.match(source, /output: 'inherit'/u)
  for (const value of [marker, 'CREDENTIAL_VAULT_GATE_PASS', 'CORE_RESTART_CREDENTIAL_RECOVERY_GATE_PASS', 'CORE_CRASH_GATE_PASS']) assert.ok(source.includes(value))
  assert.doesNotMatch(source, /stderr\.trim|await rm\(userDataDirectory|child\.once\('exit'/u)
})
