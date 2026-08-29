import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { once } from 'node:events'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { runStartupProcess, type StartupProcessOptions } from '../scripts/startup-gate-process.mjs'
import { parseTestKeychainMode, readTestKeychainMode, testElectronArguments } from '../scripts/test-keychain.mjs'

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

// 执行原脚本及原进程等待helper，只替换外部进程和文件系统；不会启动Electron或构建。
function gateScript(file: 'startup-gate.mjs' | 'cold-start-credential-gate.mjs', configuration: {
  args?: string[]
  environment?: Record<string, string>
  holdClose?: 'seed' | 'restore' | 'build'
  fastTimeout?: boolean
  missingMarker?: boolean
  failure?: { stage: 'build' | 'seed' | 'restore'; code?: number; signal?: string; spawnError?: boolean }
} = {}) {
  type Child = EventEmitter & { stdout: EventEmitter & { destroy(): void }; stderr: EventEmitter & { destroy(): void }; pid: number; exitCode: number | null; signalCode: string | null; kill(signal: string): boolean; unref(): void }
  const calls: { stage: string; args: string[]; child: Child }[] = []
  const removals: string[] = []
  const logs: string[] = []
  const directories: string[] = []
  const timerBudgets: number[] = []
  const closed = new Set<string>()
  let vaultExists = false
  const scriptProcess = {
    argv: ['node', file, ...(configuration.args ?? [])],
    env: { ...configuration.environment }, platform: process.platform, exitCode: undefined as number | undefined,
    stdout: { write: (value: string) => { logs.push(value) } },
    stderr: { write: (value: string) => { logs.push(value) } },
    exit: (code: number) => { scriptProcess.exitCode = code; throw new Error('受控脚本退出') },
  }
  const finishClose = (stage: string) => {
    const call = calls.find(item => item.stage === stage)
    if (call && !closed.has(stage)) { closed.add(stage); call.child.emit('close', call.child.exitCode, call.child.signalCode) }
  }
  const spawnControlled = (_command: string, args: string[], options: { env: Record<string, string> }) => {
    const stage = args[0] === 'build' ? 'build' : options.env.MUSIC_BRIDGE_CREDENTIAL_COLD_START_STAGE ?? 'startup'
    const stream = () => Object.assign(new EventEmitter(), { destroy() {} })
    const child: Child = Object.assign(new EventEmitter(), {
      stdout: stream(), stderr: stream(), pid: 100 + calls.length, exitCode: null as number | null, signalCode: null as string | null,
      kill(signal: string) { queueMicrotask(() => { child.signalCode = signal; child.emit('exit', null, signal); finishClose(stage) }); return true }, unref() {},
    })
    calls.push({ stage, args: [...args], child })
    queueMicrotask(() => {
      const fault = configuration.failure?.stage === stage ? configuration.failure : undefined
      if (fault?.spawnError) { child.emit('error', new Error('不可输出的合成内部错误')); finishClose(stage); return }
      if (stage === 'seed') vaultExists = true
      if (stage === 'restore') vaultExists = false
      const expected = stage === 'seed' ? 'ELECTRON_COLD_START_SEED_PASS' : stage === 'restore' ? 'ELECTRON_COLD_START_RESTORE_PASS'
        : options.env.MUSIC_BRIDGE_CREDENTIAL_VAULT_GATE === '1' ? 'CREDENTIAL_VAULT_GATE_PASS'
          : options.env.MUSIC_BRIDGE_CORE_RESTART_CREDENTIAL_RECOVERY_GATE === '1' ? 'CORE_RESTART_CREDENTIAL_RECOVERY_GATE_PASS'
            : options.env.MUSIC_BRIDGE_CORE_CRASH_GATE === '1' ? 'CORE_CRASH_GATE_PASS' : marker
      if (!configuration.missingMarker) child.stdout.emit('data', Buffer.from(expected + '\n'))
      child.stderr.emit('data', Buffer.from('不可输出的合成stderr'))
      child.exitCode = fault?.signal ? null : fault?.code ?? 0; child.signalCode = fault?.signal ?? null
      child.emit('exit', child.exitCode, child.signalCode)
      if (stage !== configuration.holdClose) finishClose(stage)
    })
    return child
  }
  const files = {
    async mkdtemp(prefix: string) { directories.push(prefix); return '/tmp/musicbridge-task036-synthetic' },
    async stat() { if (!vaultExists) throw new Error('合成文件不存在'); return { mode: 0o100600 } },
    async readFile() { return '仅合成密文' },
    async rm(directory: string) { removals.push(directory) },
  }
  const moduleCache = new Map<string, unknown>()
  const load = (name: string): any => {
    const builtins: Record<string, unknown> = { 'node:fs/promises': files, 'node:os': os, 'node:path': path, 'node:url': { fileURLToPath }, 'node:child_process': { spawn: spawnControlled }, electron: '/synthetic/electron' }
    if (name in builtins) return builtins[name]
    if (moduleCache.has(name)) return moduleCache.get(name)
    const location = new URL('../scripts/' + name.replace(/^\.\//u, ''), import.meta.url)
    const source = readFileSync(location, 'utf8').replaceAll('import.meta.url', JSON.stringify(location.href))
    const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText
    const exports = {}
    runInNewContext(compiled, { ...sandbox, exports })
    moduleCache.set(name, exports)
    return exports
  }
  const sandbox = {
    require: load, process: scriptProcess, Buffer,
    console: { log: (...values: unknown[]) => logs.push(values.join(' ')), error: (...values: unknown[]) => logs.push(values.join(' ')) },
    setTimeout: (callback: () => void, ms: number) => { timerBudgets.push(ms); return setTimeout(callback, configuration.fastTimeout ? Math.min(ms, 20) : ms) }, clearTimeout,
  }
  const location = new URL('../scripts/' + file, import.meta.url)
  const source = readFileSync(location, 'utf8').replaceAll('import.meta.url', JSON.stringify(location.href))
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText
  const finished: Promise<unknown> = runInNewContext('(async () => {\n' + compiled + '\n})()', { ...sandbox, exports: {} }).then(() => undefined, (error: unknown) => error)
  return { calls, removals, logs, directories, timerBudgets, scriptProcess, finished, finishClose }
}

const nextTurn = () => new Promise<void>(resolve => setImmediate(resolve))

test('startup显式mock必须传给Electron且报告软件模式，默认system不偷换', async () => {
  for (const mode of ['mock', 'system']) {
    const gate = gateScript('startup-gate.mjs', { args: ['development', '--keychain=' + mode] })
    assert.equal(await gate.finished, undefined)
    assert.equal(gate.calls.find(call => call.stage === 'startup')?.args.includes('--use-mock-keychain'), mode === 'mock')
    assert.ok(gate.logs.includes('KEYCHAIN_MODE=' + mode))
    if (mode === 'mock') {
      assert.ok(gate.logs.includes('REAL_KEYCHAIN_GATE=NOT_RUN'))
      assert.ok(gate.logs.includes('DESKTOP_STARTUP_MOCK_PASS=development'))
      assert.ok(!gate.logs.includes('DESKTOP_STARTUP_PASS=development'))
    }
  }
})

test('cold-start显式mock必须同时传给seed和restore并独立标识结果', async () => {
  const gate = gateScript('cold-start-credential-gate.mjs', { args: ['--keychain=mock'] })
  assert.equal(await gate.finished, undefined)
  assert.deepEqual(gate.calls.map(call => call.stage), ['build', 'seed', 'restore'])
  assert.ok(gate.calls.filter(call => call.stage !== 'build').every(call => call.args.includes('--use-mock-keychain')))
  assert.ok(gate.logs.join('\n').includes('ELECTRON_COLD_START_CREDENTIAL_RECOVERY_MOCK_GATE_PASS'))
  assert.ok(gate.logs.includes('REAL_KEYCHAIN_GATE=NOT_RUN'))
})

test('cold-start的seed仅exit0而未close不能进入restore或删除目录', async () => {
  const gate = gateScript('cold-start-credential-gate.mjs', { holdClose: 'seed' })
  try {
    await nextTurn(); await nextTurn()
    assert.deepEqual(gate.calls.map(call => call.stage), ['build', 'seed'])
    assert.deepEqual(gate.removals, [])
  } finally { gate.finishClose('seed'); await gate.finished }
})

test('cold-start的restore仅exit0而未close不能删除目录或宣称PASS', async () => {
  const gate = gateScript('cold-start-credential-gate.mjs', { holdClose: 'restore' })
  try {
    await nextTurn(); await nextTurn()
    assert.deepEqual(gate.removals, [])
    assert.ok(!gate.logs.join('\n').includes('RECOVERY_GATE_PASS'))
  } finally { gate.finishClose('restore'); await gate.finished }
})

test('cold-start close超时必须失败保留证据，seed失败不得启动restore', async () => {
  const gate = gateScript('cold-start-credential-gate.mjs', { holdClose: 'seed', fastTimeout: true })
  await gate.finished
  assert.equal(gate.scriptProcess.exitCode, 1)
  assert.deepEqual(gate.calls.map(call => call.stage), ['build', 'seed'])
  assert.deepEqual(gate.removals, [])
  assert.ok(gate.logs.join('\n').includes('ELECTRON_COLD_START_CREDENTIAL_RECOVERY_GATE_FAIL'))
})

test('测试参数helper只接受有限模式，mock不重复且不修改调用方数组', () => {
  const args = ['dist/main/index.js']
  assert.deepEqual(testElectronArguments(args, 'system'), args)
  assert.deepEqual(testElectronArguments(args, 'mock'), [...args, '--use-mock-keychain'])
  const once = testElectronArguments(args, 'mock')
  assert.deepEqual(testElectronArguments(once, 'mock'), once)
  assert.deepEqual(args, ['dist/main/index.js'])
  for (const invalid of ['', 'MOCK', 'mock\n', '未知合成模式']) {
    assert.throws(() => testElectronArguments(args, invalid), { message: '测试钥匙串模式无效' })
    assert.throws(() => readTestKeychainMode(invalid), { message: '测试钥匙串模式无效' })
  }
})

test('CLI解析无参system且拒未知或多个参数，不回显输入', () => {
  assert.equal(parseTestKeychainMode([]), 'system')
  assert.equal(parseTestKeychainMode(['--keychain=system']), 'system')
  assert.equal(parseTestKeychainMode(['--keychain=mock']), 'mock')
  for (const invalid of [['--keychain=mock\n'], ['--use-mock-keychain'], ['--keychain=mock', '--keychain=system'], ['合成秘密']]) {
    assert.throws(() => parseTestKeychainMode(invalid), { message: '测试钥匙串模式无效' })
  }
})

test('E2E参数helper默认读取专用环境，未设保持system且非法值不回退', () => {
  const source = readFileSync(new URL('../scripts/test-keychain.mjs', import.meta.url), 'utf8')
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  for (const mode of [undefined, 'system', 'mock', 'invalid']) {
    const exports = {} as typeof import('../scripts/test-keychain.mjs')
    runInNewContext(compiled, { exports, process: { env: { MUSIC_BRIDGE_TEST_KEYCHAIN_MODE: mode } } })
    if (mode === 'invalid') assert.throws(() => exports.testElectronArguments(['entry']), /测试钥匙串模式无效/u)
    else assert.equal(exports.testElectronArguments(['entry']).includes('--use-mock-keychain'), mode === 'mock')
  }
})

test('脚本非法CLI在创建目录或spawn前退出且错误不包含参数', async () => {
  for (const file of ['startup-gate.mjs', 'cold-start-credential-gate.mjs'] as const) {
    const gate = gateScript(file, { args: [...(file === 'startup-gate.mjs' ? ['development'] : []), '--keychain=合成秘密'] })
    await gate.finished
    assert.equal(gate.scriptProcess.exitCode, 2)
    assert.deepEqual(gate.calls, []); assert.deepEqual(gate.directories, [])
    assert.deepEqual(gate.logs, ['测试钥匙串模式无效'])
  }
})

test('无CLI的两个脚本仍为system，不能因runner环境mock而暗改原模式', async () => {
  for (const file of ['startup-gate.mjs', 'cold-start-credential-gate.mjs'] as const) {
    const gate = gateScript(file, { args: file === 'startup-gate.mjs' ? ['production'] : [], environment: { MUSIC_BRIDGE_TEST_KEYCHAIN_MODE: 'mock' } })
    assert.equal(await gate.finished, undefined)
    assert.ok(gate.logs.includes('KEYCHAIN_MODE=system'))
    assert.ok(gate.calls.every(call => !call.args.includes('--use-mock-keychain')))
    assert.ok(!gate.logs.join('\n').includes('MOCK_'))
  }
})

test('startup各专用marker保留原子进程事实，但mock汇总不伪报system', async () => {
  for (const [flag, expected] of [
    ['MUSIC_BRIDGE_CORE_CRASH_GATE', 'CORE_CRASH'],
    ['MUSIC_BRIDGE_CREDENTIAL_VAULT_GATE', 'CREDENTIAL_VAULT'],
    ['MUSIC_BRIDGE_CORE_RESTART_CREDENTIAL_RECOVERY_GATE', 'CORE_RESTART_CREDENTIAL_RECOVERY'],
  ]) {
    const gate = gateScript('startup-gate.mjs', { args: ['development', '--keychain=mock'], environment: { [flag]: '1' } })
    assert.equal(await gate.finished, undefined)
    assert.equal(gate.scriptProcess.exitCode, 0)
    assert.ok(gate.logs.includes(`${expected}_MOCK_GATE=development`))
    assert.ok(!gate.logs.includes(`${expected}_GATE=development`))
  }
})

test('cold-start build也必须close后才进入seed，全部成功后才能删除', async () => {
  const gate = gateScript('cold-start-credential-gate.mjs', { holdClose: 'build' })
  try {
    await nextTurn(); await nextTurn()
    assert.deepEqual(gate.calls.map(call => call.stage), ['build'])
    assert.deepEqual(gate.removals, [])
  } finally { gate.finishClose('build'); await gate.finished }
  assert.deepEqual(gate.calls.map(call => call.stage), ['build', 'seed', 'restore'])
  assert.equal(gate.removals.length, 1)
  assert.ok(gate.timerBudgets.includes(120_000))
})

test('cold-start任一stage异常或非零/信号退出均失败保留，原始stderr不输出', async () => {
  for (const failure of [
    { stage: 'build' as const, code: 7 }, { stage: 'seed' as const, code: 7 },
    { stage: 'seed' as const, spawnError: true }, { stage: 'restore' as const, signal: 'SIGTERM' },
  ]) {
    const gate = gateScript('cold-start-credential-gate.mjs', { failure })
    assert.equal(await gate.finished, undefined)
    assert.equal(gate.scriptProcess.exitCode, 1)
    assert.deepEqual(gate.removals, [])
    assert.doesNotMatch(gate.logs.join('\n'), /不可输出|RECOVERY_GATE_PASS/u)
    if (failure.stage !== 'restore') assert.ok(!gate.calls.some(call => call.stage === 'restore'))
  }
  const missing = gateScript('cold-start-credential-gate.mjs', { missingMarker: true })
  await missing.finished
  assert.equal(missing.scriptProcess.exitCode, 1); assert.deepEqual(missing.removals, [])
})

test('Electron Gate wrapper显式传模式、命名分类且外层预算覆盖内层close清理', () => {
  for (const selected of ['mock', 'system'] as const) {
    const calls: { args: string[]; timeout: number }[] = []
    const names: string[] = []
    const wrapper = readFileSync(new URL('../electron-gate/startup.test.ts', import.meta.url), 'utf8')
    const compiled = ts.transpileModule(wrapper, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText
    const requireControlled = (name: string) => {
      if (name === 'node:assert/strict') return assert
      if (name === 'node:path') return path
      if (name === '../scripts/test-keychain.mjs') return { readTestKeychainMode: () => readTestKeychainMode(selected) }
      if (name === 'node:test') return (title: string, run: () => void) => { names.push(title); run() }
      if (name === 'node:child_process') return {
        spawnSync(_command: string, args: string[], options: { timeout: number; env?: Record<string, string> }) {
          calls.push({ args: [...args], timeout: options.timeout })
          assert.ok(args.includes('--keychain=' + selected))
          const cold = args[0].includes('cold-start')
          const environment = options.env ?? {}
          const marker = cold ? `ELECTRON_COLD_START_CREDENTIAL_RECOVERY_${selected === 'mock' ? 'MOCK_' : ''}GATE_PASS`
            : (environment.MUSIC_BRIDGE_CREDENTIAL_VAULT_GATE ? 'CREDENTIAL_VAULT' : environment.MUSIC_BRIDGE_CORE_RESTART_CREDENTIAL_RECOVERY_GATE ? 'CORE_RESTART_CREDENTIAL_RECOVERY' : environment.MUSIC_BRIDGE_CORE_CRASH_GATE ? 'CORE_CRASH' : 'DESKTOP_STARTUP')
              + (selected === 'mock' ? '_MOCK' : '') + (Object.values(environment).includes('1') ? '_GATE' : '_PASS') + '=' + args[1]
          return { status: 0, stdout: `KEYCHAIN_MODE=${selected}\n${selected === 'mock' ? 'REAL_KEYCHAIN_GATE=NOT_RUN\n' : ''}${marker}\n`, stderr: '' }
        },
      }
      throw new Error('未声明的测试依赖')
    }
    runInNewContext(compiled, { require: requireControlled, exports: {}, process: { execPath: '/synthetic/node', env: {} } })
    assert.equal(names.length, 4); assert.equal(calls.length, 6)
    assert.ok(names.every(name => name.includes(selected === 'mock' ? 'mock 软件集成' : '[system]')))
    assert.ok(calls.filter(call => !call.args[0].includes('cold-start')).every(call => call.timeout > 120_000 + 60_000 + 6_000))
    assert.ok(calls.find(call => call.args[0].includes('cold-start'))!.timeout > 120_000 + 2 * 60_000 + 9_000)
  }
})
