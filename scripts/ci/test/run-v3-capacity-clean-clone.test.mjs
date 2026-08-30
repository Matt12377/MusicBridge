import test from 'node:test'
import assert from 'node:assert/strict'

const entry = new URL('../run-v3-capacity-clean-clone.mjs', import.meta.url)

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
      install: () => { events.push('install'); return 0 },
      buildContracts: () => { events.push('build'); return 0 },
      runBenchmark: command => { events.push(['benchmark', command]); return { status: 0, signal: null } },
      emit: line => events.push(['emit', line]),
      benchmarkCommand: ['/fixed/node', '--import', '/fixed/tsx', '/fixed/worker.ts'],
      ...overrides,
    },
  }
}

test('clean clone入口只启动一次无window参数的正式benchmark子进程并分类PASS', async () => {
  const { runFormalCapacityHarness } = await loadEntry()
  const f = fixture()
  const result = runFormalCapacityHarness(f.input)
  assert.equal(result, 'PASS')
  assert.deepEqual(f.events, [
    ['benchmark', ['/fixed/node', '--import', '/fixed/tsx', '/fixed/worker.ts']],
    ['emit', 'CAPACITY_CLASSIFICATION=PASS'],
  ])
  const command = f.events[0][1]
  assert.equal(command.some(value => /window|authority|receipt|checkpoint|placeholder|dry-run|prepare/iu.test(value)), false)
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
    'install', 'build', 'benchmark', 'emit',
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
