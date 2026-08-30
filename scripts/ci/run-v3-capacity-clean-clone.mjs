#!/usr/bin/env node
import { existsSync, realpathSync, statfsSync } from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execFileSync, spawnSync } from 'node:child_process'

const root = realpathSync(join(dirname(fileURLToPath(import.meta.url)), '../..'))
const worker = join(root, 'packages/bridge-core/test/benchmarks/recording-capacity-clean-clone.ts')
const bridgePackage = join(root, 'packages/bridge-core/package.json')
const contractsDist = join(root, 'packages/contracts/dist/index.js')
const gibibyte = 1024 ** 3
const objectsLimitAxisBytes = Math.ceil(.9 * gibibyte) * 2
export const FORMAL_CAPACITY_SPACE_BUDGET = Object.freeze({
  plannedBytes: objectsLimitAxisBytes * 3 + 220 * 16 * 1024 ** 2 + 128 * 1024 ** 2,
  floorBytes: 10 * gibibyte,
})

/** 与objects-limit fixture写前投影相同；只读实际运行根，不创建worker或样本。 */
export function inspectFormalCapacitySpace(candidateRoot, dependencies = {}) {
  const canonicalRoot = (dependencies.realpath ?? realpathSync)(candidateRoot)
  const space = (dependencies.statfs ?? (value => statfsSync(value, { bigint: true })))(canonicalRoot)
  const available = BigInt(space.bavail) * BigInt(space.bsize)
  if (available < 0n || available > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('capacity preflight space无效')
  const availableBytes = Number(available)
  const { plannedBytes, floorBytes } = FORMAL_CAPACITY_SPACE_BUDGET
  const requiredAvailableBytes = plannedBytes + floorBytes
  return {
    ready: availableBytes >= requiredAvailableBytes,
    root: canonicalRoot,
    availableBytes,
    plannedBytes,
    floorBytes,
    requiredAvailableBytes,
  }
}

function classificationFor(result) {
  if (result?.signal !== null && result?.signal !== undefined) return 'HARNESS_BUG'
  return result?.status === 0 ? 'PASS' : result?.status === 2 ? 'PRODUCT_BUG' : 'HARNESS_BUG'
}

/** 纯调度函数只接受测试注入；正式CLI没有参数、环境开关或预跑模式。 */
export function runFormalCapacityHarness(input) {
  const emit = value => input.emit(`CAPACITY_CLASSIFICATION=${value}`)
  let inspected
  try { inspected = input.inspect() } catch { emit('HARNESS_BUG'); return 'HARNESS_BUG' }
  if (input.argv.length !== 0 || inspected.clean !== true || inspected.runtimeReady !== true) {
    emit('HARNESS_BUG')
    return 'HARNESS_BUG'
  }
  if (!inspected.dependenciesReady && input.install() !== 0) {
    emit('HARNESS_BUG')
    return 'HARNESS_BUG'
  }
  if (!inspected.contractsReady && input.buildContracts() !== 0) {
    emit('HARNESS_BUG')
    return 'HARNESS_BUG'
  }
  try { inspected = input.inspect() } catch { emit('HARNESS_BUG'); return 'HARNESS_BUG' }
  if (inspected.clean !== true || inspected.runtimeReady !== true
    || inspected.dependenciesReady !== true || inspected.contractsReady !== true) {
    emit('HARNESS_BUG')
    return 'HARNESS_BUG'
  }
  let preflight
  try { preflight = input.preflight() }
  catch { input.emit('CAPACITY_PREFLIGHT=ERROR'); emit('HARNESS_BUG'); return 'HARNESS_BUG' }
  const { plannedBytes, floorBytes } = FORMAL_CAPACITY_SPACE_BUDGET
  const requiredAvailableBytes = plannedBytes + floorBytes
  const validPreflight = preflight && typeof preflight.root === 'string' && preflight.root.length > 0
    && Number.isSafeInteger(preflight.availableBytes) && preflight.availableBytes >= 0
    && preflight.plannedBytes === plannedBytes && preflight.floorBytes === floorBytes
    && preflight.requiredAvailableBytes === requiredAvailableBytes
    && preflight.ready === (preflight.availableBytes >= requiredAvailableBytes)
  if (!validPreflight) {
    input.emit('CAPACITY_PREFLIGHT=ERROR')
    emit('HARNESS_BUG')
    return 'HARNESS_BUG'
  }
  input.emit(`CAPACITY_PREFLIGHT=${preflight.ready ? 'READY' : 'INSUFFICIENT_SPACE'} root=${preflight.root} availableBytes=${preflight.availableBytes} plannedBytes=${plannedBytes} floorBytes=${floorBytes} requiredAvailableBytes=${requiredAvailableBytes}`)
  if (!preflight.ready) {
    emit('HARNESS_BUG')
    return 'HARNESS_BUG'
  }
  const result = input.runBenchmark([...input.benchmarkCommand])
  const classification = classificationFor(result)
  emit(classification)
  return classification
}

function git(...args) {
  return execFileSync('/usr/bin/git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_NO_LAZY_FETCH: '1' },
  }).trim()
}

function inspectClone() {
  const top = realpathSync(git('rev-parse', '--show-toplevel'))
  const clean = top === root
    && realpathSync(process.cwd()) === root
    && git('status', '--porcelain=v1', '--untracked-files=all') === ''
    && /^[0-9a-f]{40}$/u.test(git('rev-parse', 'HEAD'))
  let dependenciesReady = false
  try {
    const require = createRequire(pathToFileURL(bridgePackage))
    dependenciesReady = existsSync(require.resolve('tsx'))
  } catch { dependenciesReady = false }
  return {
    clean,
    runtimeReady: Number.parseInt(process.versions.node.split('.')[0] ?? '', 10) === 22,
    dependenciesReady,
    contractsReady: existsSync(contractsDist),
  }
}

function fixedSetup(args) {
  const result = spawnSync('/usr/bin/env', args, { cwd: root, stdio: 'inherit', env: process.env })
  return result.status ?? 1
}

function main() {
  let tsx = ''
  const input = {
    argv: process.argv.slice(2),
    inspect: inspectClone,
    preflight: () => inspectFormalCapacitySpace(os.tmpdir()),
    install: () => fixedSetup(['corepack', 'pnpm@10.17.1', 'install', '--frozen-lockfile', '--ignore-scripts']),
    buildContracts: () => fixedSetup(['corepack', 'pnpm@10.17.1', '--filter', '@music-bridge/contracts', 'run', 'build']),
    runBenchmark: command => spawnSync(command[0], command.slice(1), {
      cwd: root,
      stdio: 'inherit',
      timeout: 900_000,
      env: Object.fromEntries(Object.entries(process.env).filter(([key]) =>
        ['HOME', 'PATH', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'TZ'].includes(key))),
    }),
    emit: line => process.stdout.write(`${line}\n`),
    get benchmarkCommand() {
      if (!tsx) {
        const require = createRequire(pathToFileURL(bridgePackage))
        tsx = require.resolve('tsx')
      }
      return [process.execPath, '--import', tsx, worker]
    },
  }
  const result = runFormalCapacityHarness(input)
  process.exitCode = result === 'PASS' ? 0 : result === 'PRODUCT_BUG' ? 2 : 3
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
