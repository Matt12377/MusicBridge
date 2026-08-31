#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, realpathSync, statfsSync } from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execFileSync, spawnSync } from 'node:child_process'

const root = realpathSync(join(dirname(fileURLToPath(import.meta.url)), '../..'))
const bridgePackage = join(root, 'packages/bridge-core/package.json')
const contractsDist = join(root, 'packages/contracts/dist/index.js')
const gibibyte = 1024 ** 3
const sha256Pattern = /^[0-9a-f]{64}$/u
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

function fileSha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function strictFile(path, maximumBytes, executable = false) {
  if (typeof path !== 'string' || !isAbsolute(path) || realpathSync(path) !== path) {
    throw new Error('authority receipt无效')
  }
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.nlink !== 1 || stat.size < 2 || stat.size > maximumBytes
      || (executable && (stat.mode & 0o111) === 0)) {
    throw new Error('authority receipt无效')
  }
  return path
}

function strictJson(path, maximumBytes) {
  const value = JSON.parse(readFileSync(strictFile(path, maximumBytes), 'utf8'))
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('authority receipt无效')
  return value
}

function validIdentity(value) {
  return value && typeof value === 'object' && typeof value.root === 'string' && isAbsolute(value.root)
    && typeof value.branch === 'string' && value.branch.length > 0
    && typeof value.head === 'string' && /^[0-9a-f]{40}$/u.test(value.head)
}

function sameIdentity(left, right) {
  return validIdentity(left) && validIdentity(right)
    && left.root === right.root && left.branch === right.branch && left.head === right.head
}

function verifiedFileFact(value, executable = false) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || typeof value.path !== 'string' || !sha256Pattern.test(value.sha256 ?? '')) {
    throw new Error('authority receipt无效')
  }
  strictFile(value.path, 16 * 1024 * 1024, executable)
  if (fileSha256(value.path) !== value.sha256) throw new Error('authority receipt无效')
  return value.path
}

/** 只接受issuer输出与其window派生出的精确consumer命令；不信任收据中的可执行路径。 */
export function inspectCapacityAuthorityReceipt(receiptPath, candidateIdentity) {
  try {
    const receipt = strictJson(receiptPath, 1024 * 1024)
    if (receipt.state !== 'ISSUED_NOT_EXECUTED' || receipt.profile !== 'objects-limit'
        || typeof receipt.windowId !== 'string' || receipt.windowId.length === 0
        || typeof receipt.label !== 'string' || receipt.label.length === 0
        || typeof receipt.deadlineAt !== 'string'
        || typeof receipt.windowPath !== 'string' || !sha256Pattern.test(receipt.windowSha256 ?? '')
        || !Array.isArray(receipt.consumeCommand)) throw new Error('authority receipt无效')
    const windowPath = strictFile(receipt.windowPath, 1024 * 1024)
    if (fileSha256(windowPath) !== receipt.windowSha256) throw new Error('authority receipt无效')
    const window = strictJson(windowPath, 1024 * 1024)
    if (window.schemaVersion !== 1 || window.scope !== 'musicbridge-capacity-queued-stop-window'
        || window.state !== 'approved' || window.phase !== 'queued-stop' || window.profile !== 'objects-limit'
        || window.id !== receipt.windowId || window.label !== receipt.label
        || window.deadlineAt !== receipt.deadlineAt || !sameIdentity(window.candidateRepository, candidateIdentity)
        || !window.toolchain || typeof window.toolchain !== 'object') throw new Error('authority receipt无效')
    const consumer = verifiedFileFact(window.toolchain.consumerPython, true)
    const supervisor = verifiedFileFact(window.supervisor)
    const expected = [consumer, supervisor, '--window', windowPath, '--window-sha256', receipt.windowSha256]
    if (JSON.stringify(receipt.consumeCommand) !== JSON.stringify(expected)) throw new Error('authority receipt无效')
    return { consumeCommand: expected }
  } catch (error) {
    if (error instanceof Error && error.message === 'authority receipt无效') throw error
    throw new Error('authority receipt无效', { cause: error })
  }
}

/** 纯调度函数只接受测试注入；正式结果只能由收据绑定的installed supervisor形成。 */
export function runFormalCapacityHarness(input) {
  const emit = value => input.emit(`CAPACITY_CLASSIFICATION=${value}`)
  const receiptArgument = input.argv.length === 2 && input.argv[0] === '--authority-receipt'
    && typeof input.argv[1] === 'string' && isAbsolute(input.argv[1]) ? input.argv[1] : undefined
  if (input.argv.length !== 0 && !receiptArgument) { emit('HARNESS_BUG'); return 'HARNESS_BUG' }
  let inspected
  try { inspected = input.inspect() } catch { emit('HARNESS_BUG'); return 'HARNESS_BUG' }
  if (inspected.clean !== true || inspected.runtimeReady !== true) {
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
  if (!receiptArgument) {
    input.emit('CAPACITY_GATE=AUTHORITY_REQUIRED')
    return 'AUTHORITY_REQUIRED'
  }
  const candidateIdentity = { root: inspected.root, branch: inspected.branch, head: inspected.head }
  if (!validIdentity(candidateIdentity)) { emit('HARNESS_BUG'); return 'HARNESS_BUG' }
  let receipt
  try { receipt = input.loadAuthorityReceipt(receiptArgument, candidateIdentity) }
  catch { input.emit('CAPACITY_AUTHORITY=INVALID'); emit('HARNESS_BUG'); return 'HARNESS_BUG' }
  if (!receipt || !Array.isArray(receipt.consumeCommand)
      || receipt.consumeCommand.length !== 6 || receipt.consumeCommand.some(value => typeof value !== 'string')) {
    input.emit('CAPACITY_AUTHORITY=INVALID'); emit('HARNESS_BUG'); return 'HARNESS_BUG'
  }
  let result
  try { result = input.consumeAuthority([...receipt.consumeCommand]) }
  catch {
    input.emit('CAPACITY_AUTHORITY_CONSUMPTION=SPAWN_ERROR')
    return 'AUTHORITY_CONSUMER_FAILED'
  }
  const terminal = result?.signal !== null && result?.signal !== undefined
    ? `SIGNAL_${result.signal}` : `EXIT_${result?.status ?? 'UNKNOWN'}`
  input.emit(`CAPACITY_AUTHORITY_CONSUMPTION=${terminal}`)
  return result?.signal === null && result?.status === 0 ? 'AUTHORITY_CONSUMED' : 'AUTHORITY_CONSUMER_FAILED'
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
  const branch = git('branch', '--show-current')
  const head = git('rev-parse', 'HEAD')
  const clean = top === root
    && realpathSync(process.cwd()) === root
    && git('status', '--porcelain=v1', '--untracked-files=all') === ''
    && branch.length > 0 && /^[0-9a-f]{40}$/u.test(head)
  let dependenciesReady = false
  try {
    const require = createRequire(pathToFileURL(bridgePackage))
    dependenciesReady = existsSync(require.resolve('tsx'))
  } catch { dependenciesReady = false }
  return {
    clean, root: top, branch, head,
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
  const input = {
    argv: process.argv.slice(2),
    inspect: inspectClone,
    preflight: () => inspectFormalCapacitySpace(os.tmpdir()),
    install: () => fixedSetup(['corepack', 'pnpm@10.17.1', 'install', '--frozen-lockfile', '--ignore-scripts']),
    buildContracts: () => fixedSetup(['corepack', 'pnpm@10.17.1', '--filter', '@music-bridge/contracts', 'run', 'build']),
    loadAuthorityReceipt: (path, identity) => inspectCapacityAuthorityReceipt(path, identity),
    consumeAuthority: command => spawnSync(command[0], command.slice(1), {
      cwd: root,
      stdio: 'inherit',
      timeout: 900_000,
      env: Object.fromEntries(Object.entries(process.env).filter(([key]) =>
        ['HOME', 'PATH', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'TZ'].includes(key))),
    }),
    emit: line => process.stdout.write(`${line}\n`),
  }
  const result = runFormalCapacityHarness(input)
  process.exitCode = result === 'AUTHORITY_CONSUMED' ? 0
    : result === 'AUTHORITY_REQUIRED' ? 4 : result === 'AUTHORITY_CONSUMER_FAILED' ? 5 : 3
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
