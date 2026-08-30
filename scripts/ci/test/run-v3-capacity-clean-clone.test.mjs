import test from 'node:test'
import assert from 'node:assert/strict'

const entry = new URL('../run-v3-capacity-clean-clone.mjs', import.meta.url)
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

test('clean clone入口只启动一次无window参数的正式benchmark子进程并分类PASS', async () => {
  const { runFormalCapacityHarness } = await loadEntry()
  const f = fixture()
  const result = runFormalCapacityHarness(f.input)
  assert.equal(result, 'PASS')
  assert.deepEqual(f.events, [
    ['emit', `CAPACITY_PREFLIGHT=READY root=/fixed/tmp availableBytes=${requiredAvailableBytes + gibibyte} plannedBytes=${plannedBytes} floorBytes=${frozenObjectsLimit.floorBytes} requiredAvailableBytes=${requiredAvailableBytes}`],
    ['benchmark', ['/fixed/node', '--import', '/fixed/tsx', '/fixed/worker.ts']],
    ['emit', 'CAPACITY_CLASSIFICATION=PASS'],
  ])
  const command = f.events.find(value => Array.isArray(value) && value[0] === 'benchmark')[1]
  assert.equal(command.some(value => /window|authority|receipt|checkpoint|placeholder|dry-run|prepare/iu.test(value)), false)
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

test('缺依赖时只做固定install/build，然后仍恰好启动一个benchmark子进程', async () => {
  const { runFormalCapacityHarness } = await loadEntry()
  let inspection = 0
  const f = fixture({
    inspect: () => ++inspection === 1
      ? { clean: true, runtimeReady: true, dependenciesReady: false, contractsReady: false }
      : { clean: true, runtimeReady: true, dependenciesReady: true, contractsReady: true },
  })
  assert.equal(runFormalCapacityHarness(f.input), 'PASS')
  assert.deepEqual(f.events.map(value => Array.isArray(value) ? value[0] : value), [
    'install', 'build', 'emit', 'benchmark', 'emit',
  ])
  assert.equal(f.events.filter(value => Array.isArray(value) && value[0] === 'benchmark').length, 1)
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

test('唯一benchmark子进程只按固定退出码映射三分类', async () => {
  const { runFormalCapacityHarness } = await loadEntry()
  for (const [status, signal, expected] of [[0, null, 'PASS'], [2, null, 'PRODUCT_BUG'], [3, null, 'HARNESS_BUG'], [null, 'SIGTERM', 'HARNESS_BUG']]) {
    const f = fixture({ runBenchmark: command => { f.events.push(['benchmark', command]); return { status, signal } } })
    assert.equal(runFormalCapacityHarness(f.input), expected)
    assert.equal(f.events.filter(value => Array.isArray(value) && value[0] === 'benchmark').length, 1)
  }
})
