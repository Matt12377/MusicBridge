import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'

const entry = new URL('../run-v3-capacity-clean-clone.mjs', import.meta.url)
const directWorker = new URL('../../../packages/bridge-core/test/benchmarks/recording-capacity-clean-clone.ts', import.meta.url)
const gibibyte = 1024 ** 3
const frozenObjectsLimit = Object.freeze({
  photoBytes: Math.ceil(.9 * gibibyte),
  printObjectBytes: Math.ceil(.9 * gibibyte),
  maxRecords: 220,
  perRecordWorkingBytes: 16 * 1024 ** 2,
  evidenceBytes: 128 * 1024 ** 2,
  floorBytes: 10 * gibibyte,
})
const plannedBytes = (frozenObjectsLimit.photoBytes + frozenObjectsLimit.printObjectBytes) * 3
  + frozenObjectsLimit.maxRecords * frozenObjectsLimit.perRecordWorkingBytes + frozenObjectsLimit.evidenceBytes
const requiredAvailableBytes = plannedBytes + frozenObjectsLimit.floorBytes

async function loadEntry() {
  return import(`${entry.href}?test=${Date.now()}-${Math.random()}`)
}

function fixture(overrides = {}) {
  const events = []
  return {
    events,
    input: {
      argv: [],
      inspect: () => ({ clean: true, runtimeReady: true, dependenciesReady: true, contractsReady: true }),
      preflight: () => ({
        ready: true,
        root: '/fixed/tmp',
        availableBytes: requiredAvailableBytes + gibibyte,
        plannedBytes,
        floorBytes: frozenObjectsLimit.floorBytes,
        requiredAvailableBytes,
      }),
      install: () => { events.push('install'); return 0 },
      buildContracts: () => { events.push('build'); return 0 },
      runBenchmark: command => { events.push(['benchmark', command]); return { status: 0, signal: null } },
      loadAuthorityReceipt: (path, identity) => {
        events.push(['receipt', path, identity])
        return { consumeCommand: ['/fixed/python', '/fixed/supervisor.py', '--window', '/fixed/window.json', '--window-sha256', 'a'.repeat(64)] }
      },
      consumeAuthority: command => { events.push(['authority', command]); return { status: 0, signal: null } },
      emit: line => events.push(['emit', line]),
      benchmarkCommand: ['/fixed/node', '--import', '/fixed/tsx', '/fixed/worker.ts'],
      ...overrides,
    },
  }
}

test('空间预检按实际运行根statfs计算planned、floor与required边界', async () => {
  const { FORMAL_CAPACITY_SPACE_BUDGET, inspectFormalCapacitySpace } = await loadEntry()
  const statfs = availableBytes => ({ bavail: BigInt(availableBytes), bsize: 1n })
  const dependencies = availableBytes => ({
    realpath: value => value,
    statfs: () => statfs(availableBytes),
  })
  assert.deepEqual(FORMAL_CAPACITY_SPACE_BUDGET, {
    plannedBytes,
    floorBytes: frozenObjectsLimit.floorBytes,
  })
  assert.deepEqual(inspectFormalCapacitySpace('/fixed/tmp', dependencies(requiredAvailableBytes - 1)), {
    ready: false,
    root: '/fixed/tmp',
    availableBytes: requiredAvailableBytes - 1,
    plannedBytes,
    floorBytes: frozenObjectsLimit.floorBytes,
    requiredAvailableBytes,
  })
  assert.equal(inspectFormalCapacitySpace('/fixed/tmp', dependencies(requiredAvailableBytes)).ready, true)
})

test('clean clone没有authority收据时只完成预检且绝不直接启动benchmark', async () => {
  const { runFormalCapacityHarness } = await loadEntry()
  const f = fixture()
  const result = runFormalCapacityHarness(f.input)
  assert.equal(result, 'AUTHORITY_REQUIRED')
  assert.deepEqual(f.events, [
    ['emit', `CAPACITY_PREFLIGHT=READY root=/fixed/tmp availableBytes=${requiredAvailableBytes + gibibyte} plannedBytes=${plannedBytes} floorBytes=${frozenObjectsLimit.floorBytes} requiredAvailableBytes=${requiredAvailableBytes}`],
    ['emit', 'CAPACITY_GATE=AUTHORITY_REQUIRED'],
  ])
  assert.equal(f.events.some(value => Array.isArray(value) && value[0] === 'benchmark'), false)
})

test('合法authority收据只消费一次installed supervisor命令且不输出正式PASS', async () => {
  const { runFormalCapacityHarness } = await loadEntry()
  const f = fixture({
    argv: ['--authority-receipt', '/fixed/receipt.json'],
    inspect: () => ({ clean: true, runtimeReady: true, dependenciesReady: true, contractsReady: true,
      root: '/fixed/repo', branch: 'codex/task-080-capacity-authority-harness', head: 'b'.repeat(40) }),
  })
  assert.equal(runFormalCapacityHarness(f.input), 'AUTHORITY_CONSUMED')
  assert.deepEqual(f.events, [
    ['emit', `CAPACITY_PREFLIGHT=READY root=/fixed/tmp availableBytes=${requiredAvailableBytes + gibibyte} plannedBytes=${plannedBytes} floorBytes=${frozenObjectsLimit.floorBytes} requiredAvailableBytes=${requiredAvailableBytes}`],
    ['receipt', '/fixed/receipt.json', {
      root: '/fixed/repo', branch: 'codex/task-080-capacity-authority-harness', head: 'b'.repeat(40),
    }],
    ['authority', ['/fixed/python', '/fixed/supervisor.py', '--window', '/fixed/window.json', '--window-sha256', 'a'.repeat(64)]],
    ['emit', 'CAPACITY_AUTHORITY_CONSUMPTION=EXIT_0'],
  ])
  assert.equal(f.events.some(value => Array.isArray(value) && value[0] === 'benchmark'), false)
  assert.equal(f.events.some(value => String(value).includes('CAPACITY_CLASSIFICATION=PASS')), false)
})

test('正式运行根空间不足时在benchmark子进程启动前确定性拒绝', async () => {
  const { runFormalCapacityHarness } = await loadEntry()
  const f = fixture({
    preflight: () => ({
      ready: false,
      root: '/fixed/low-space',
      availableBytes: requiredAvailableBytes - 1,
      plannedBytes,
      floorBytes: frozenObjectsLimit.floorBytes,
      requiredAvailableBytes,
    }),
  })
  assert.equal(runFormalCapacityHarness(f.input), 'HARNESS_BUG')
  assert.equal(f.events.some(value => Array.isArray(value) && value[0] === 'benchmark'), false)
  assert.deepEqual(f.events, [
    ['emit', `CAPACITY_PREFLIGHT=INSUFFICIENT_SPACE root=/fixed/low-space availableBytes=${requiredAvailableBytes - 1} plannedBytes=${plannedBytes} floorBytes=${frozenObjectsLimit.floorBytes} requiredAvailableBytes=${requiredAvailableBytes}`],
    ['emit', 'CAPACITY_CLASSIFICATION=HARNESS_BUG'],
  ])
})

test('缺依赖时只做固定install/build，完成预检后仍等待authority', async () => {
  const { runFormalCapacityHarness } = await loadEntry()
  let inspection = 0
  const f = fixture({
    inspect: () => ++inspection === 1
      ? { clean: true, runtimeReady: true, dependenciesReady: false, contractsReady: false }
      : { clean: true, runtimeReady: true, dependenciesReady: true, contractsReady: true },
  })
  assert.equal(runFormalCapacityHarness(f.input), 'AUTHORITY_REQUIRED')
  assert.deepEqual(f.events.map(value => Array.isArray(value) ? value[0] : value), [
    'install', 'build', 'emit', 'emit',
  ])
  assert.equal(f.events.filter(value => Array.isArray(value) && value[0] === 'benchmark').length, 0)
})

test('参数、dirty clone或setup失败均在benchmark前分类HARNESS_BUG', async () => {
  const { runFormalCapacityHarness } = await loadEntry()
  for (const overrides of [
    { argv: ['--window', '<WINDOW>'] },
    { inspect: () => ({ clean: true, runtimeReady: false, dependenciesReady: true, contractsReady: true }) },
    { inspect: () => ({ clean: false, runtimeReady: true, dependenciesReady: true, contractsReady: true }) },
    { inspect: () => ({ clean: true, runtimeReady: true, dependenciesReady: false, contractsReady: false }), install: () => 1 },
    { preflight: () => { throw new Error('statfs') } },
    { preflight: () => ({ ready: true, root: '/fixed/tmp', availableBytes: requiredAvailableBytes - 1,
      plannedBytes, floorBytes: frozenObjectsLimit.floorBytes, requiredAvailableBytes }) },
  ]) {
    const f = fixture(overrides)
    assert.equal(runFormalCapacityHarness(f.input), 'HARNESS_BUG')
    assert.equal(f.events.some(value => Array.isArray(value) && value[0] === 'benchmark'), false)
    assert.deepEqual(f.events.at(-1), ['emit', 'CAPACITY_CLASSIFICATION=HARNESS_BUG'])
  }
})

test('authority consumer非零或signal只报告消费失败，不伪造容量分类', async () => {
  const { runFormalCapacityHarness } = await loadEntry()
  for (const [status, signal] of [[2, null], [3, null], [null, 'SIGTERM']]) {
    const f = fixture({
      argv: ['--authority-receipt', '/fixed/receipt.json'],
      inspect: () => ({ clean: true, runtimeReady: true, dependenciesReady: true, contractsReady: true,
        root: '/fixed/repo', branch: 'codex/task-080-capacity-authority-harness', head: 'b'.repeat(40) }),
      consumeAuthority: command => { f.events.push(['authority', command]); return { status, signal } },
    })
    assert.equal(runFormalCapacityHarness(f.input), 'AUTHORITY_CONSUMER_FAILED')
    assert.equal(f.events.filter(value => Array.isArray(value) && value[0] === 'benchmark').length, 0)
    assert.deepEqual(f.events.at(-1), ['emit', signal ? `CAPACITY_AUTHORITY_CONSUMPTION=SIGNAL_${signal}` : `CAPACITY_AUTHORITY_CONSUMPTION=EXIT_${status}`])
  }

  const thrown = fixture({
    argv: ['--authority-receipt', '/fixed/receipt.json'],
    inspect: () => ({ clean: true, runtimeReady: true, dependenciesReady: true, contractsReady: true,
      root: '/fixed/repo', branch: 'codex/task-080-capacity-authority-harness', head: 'b'.repeat(40) }),
    consumeAuthority: () => { throw new Error('spawn failed') },
  })
  assert.equal(runFormalCapacityHarness(thrown.input), 'AUTHORITY_CONSUMER_FAILED')
  assert.deepEqual(thrown.events.at(-1), ['emit', 'CAPACITY_AUTHORITY_CONSUMPTION=SPAWN_ERROR'])
})

test('authority收据精确绑定window SHA、候选身份与固定consumer命令', async () => {
  const { inspectCapacityAuthorityReceipt } = await loadEntry()
  const root = realpathSync(mkdtempSync(join(os.tmpdir(), 'musicbridge-task080-')))
  try {
    const authority = join(root, 'authority'), identity = {
      root: '/fixed/repo', branch: 'codex/task-080-capacity-authority-harness', head: 'b'.repeat(40),
    }
    const windowId = 'task080-window', label = 'task080-queued-stop', deadlineAt = '2026-08-31T20:00:00.000Z'
    mkdirSync(authority)
    const supervisor = join(authority, 'supervisor.py'), consumer = join(root, 'python'), windowPath = join(authority, 'window.json')
    writeFileSync(supervisor, 'supervisor\n'); writeFileSync(consumer, 'python\n'); chmodSync(consumer, 0o700)
    const sha = value => createHash('sha256').update(value).digest('hex')
    const fileSha = path => sha(Buffer.from(path === supervisor ? 'supervisor\n' : 'python\n'))
    const window = {
      schemaVersion: 1, scope: 'musicbridge-capacity-queued-stop-window', state: 'approved',
      id: windowId, label, deadlineAt, phase: 'queued-stop', profile: 'objects-limit', candidateRepository: identity,
      supervisor: { path: supervisor, sha256: fileSha(supervisor) },
      toolchain: { consumerPython: { path: consumer, sha256: fileSha(consumer) } },
    }
    const windowBytes = `${JSON.stringify(window)}\n`; writeFileSync(windowPath, windowBytes)
    const windowSha256 = sha(Buffer.from(windowBytes))
    const consumeCommand = [consumer, supervisor, '--window', windowPath, '--window-sha256', windowSha256]
    const receiptPath = join(root, 'receipt.json')
    writeFileSync(receiptPath, `${JSON.stringify({ state: 'ISSUED_NOT_EXECUTED', profile: 'objects-limit', windowId, label, deadlineAt,
      windowPath, windowSha256, consumeCommand })}\n`)
    assert.deepEqual(inspectCapacityAuthorityReceipt(receiptPath, identity), { consumeCommand })
    writeFileSync(receiptPath, `${JSON.stringify({ state: 'ISSUED_NOT_EXECUTED', profile: 'objects-limit', windowId, label, deadlineAt,
      windowPath, windowSha256, consumeCommand: [...consumeCommand.slice(0, 1), '/wrong/supervisor.py', ...consumeCommand.slice(2)] })}\n`)
    assert.throws(() => inspectCapacityAuthorityReceipt(receiptPath, identity), /authority receipt无效/u)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('clean-clone benchmark模块没有可绕过authority的直接main入口', () => {
  const source = readFileSync(directWorker, 'utf8')
  assert.doesNotMatch(source, /void main\(\)/u)
  assert.doesNotMatch(source, /productionDependencies\(\)/u)
})
