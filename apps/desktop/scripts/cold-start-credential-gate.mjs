import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import electron from 'electron'
import { runStartupProcess } from './startup-gate-process.mjs'
import { parseTestKeychainMode, testElectronArguments } from './test-keychain.mjs'

const desktopRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
let keychainMode
try { keychainMode = parseTestKeychainMode(process.argv.slice(2)) } catch {
  console.error('测试钥匙串模式无效')
  process.exit(2)
}
console.log(`KEYCHAIN_MODE=${keychainMode}`)
if (keychainMode === 'mock') console.log('REAL_KEYCHAIN_GATE=NOT_RUN')
const resultMarker = keychainMode === 'mock'
  ? 'ELECTRON_COLD_START_CREDENTIAL_RECOVERY_MOCK_GATE'
  : 'ELECTRON_COLD_START_CREDENTIAL_RECOVERY_GATE'
const plaintextCredentialEnvironmentKeys = [
  'NETEASE_COOKIE',
  'MUSIC_U',
  '__csrf',
  'MUSIC_A',
  'MUSIC_R_T',
  'MUSIC_R_I',
  'NETEASE_TOKEN',
  'NETEASE_CREDENTIAL',
]

function commandPath(name) {
  const suffix = process.platform === 'win32' ? '.cmd' : ''
  return path.join(desktopRoot, 'node_modules', '.bin', `${name}${suffix}`)
}

function assertNoPlaintextCredentialEnvironment(environment) {
  for (const key of plaintextCredentialEnvironmentKeys) {
    if (environment[key] !== undefined) {
      throw new Error('cold-start gate received a plaintext credential environment variable')
    }
  }
}

function runElectronStage(stage, userDataDirectory) {
  const environment = {
    ...process.env,
    MUSIC_BRIDGE_STARTUP_TEST: '1',
    MUSIC_BRIDGE_CORE_TEST_MODE: '1',
    MUSIC_BRIDGE_CREDENTIAL_COLD_START_STAGE: stage,
    MUSIC_BRIDGE_STARTUP_USER_DATA_DIR: userDataDirectory,
  }
  for (const key of [
    ...plaintextCredentialEnvironmentKeys,
    'MUSIC_BRIDGE_CORE_CRASH_GATE',
    'MUSIC_BRIDGE_CREDENTIAL_VAULT_GATE',
    'MUSIC_BRIDGE_CORE_RESTART_CREDENTIAL_RECOVERY_GATE',
    'MUSIC_BRIDGE_CREDENTIAL_RECOVERY_GATE',
    'MUSIC_BRIDGE_TEST_KEYCHAIN_MODE',
  ]) delete environment[key]
  assertNoPlaintextCredentialEnvironment(environment)

  return runStartupProcess(electron, testElectronArguments(['dist/main/index.js'], keychainMode), {
    cwd: desktopRoot, env: environment,
    readyMarker: 'DESKTOP_STARTUP_READY',
    expectedMarker: stage === 'seed' ? 'ELECTRON_COLD_START_SEED_PASS' : 'ELECTRON_COLD_START_RESTORE_PASS',
  })
}

function requireClosedSuccess(result, stage) {
  if (result.failure || !result.markerSeen || !result.closed || result.code !== 0 || result.signal !== null) {
    console.error(`ELECTRON_COLD_START_STAGE_FAIL=${stage}`)
    console.error(`ELECTRON_COLD_START_REASON=${result.failure ?? 'process-exit'}`)
    throw new Error('冷启动验证阶段失败')
  }
}

async function pathExists(filePath) {
  try {
    await stat(filePath)
    return true
  } catch {
    return false
  }
}

const userDataDirectory = await mkdtemp(
  path.join(os.tmpdir(), 'musicbridge-task036-cold-start-'),
)
const vaultPath = path.join(userDataDirectory, 'data', 'netease.credential')
let passed = false

try {
  const build = await runStartupProcess(commandPath('electron-vite'), ['build', '--mode', 'development'], {
    cwd: desktopRoot, env: process.env, output: 'inherit', exitTimeoutMs: 120_000,
  })
  requireClosedSuccess(build, 'build')

  const first = await runElectronStage('seed', userDataDirectory)
  requireClosedSuccess(first, 'seed')
  if (!(await pathExists(vaultPath))) {
    throw new Error('cold-start seed did not leave the encrypted vault for process B')
  }
  const vaultStat = await stat(vaultPath)
  if ((vaultStat.mode & 0o777) !== 0o600) {
    throw new Error('cold-start seed vault permissions are not private')
  }
  const vaultContents = await readFile(vaultPath, 'utf8')
  if (vaultContents.includes('v'.repeat(32))) {
    throw new Error('cold-start seed vault contains plaintext synthetic credential')
  }

  const second = await runElectronStage('restore', userDataDirectory)
  requireClosedSuccess(second, 'restore')
  if (await pathExists(vaultPath)) {
    throw new Error('cold-start restore did not delete the synthetic vault')
  }
  // 只有全部子进程已close且业务检查通过，才可删除自建合成目录。
  await rm(userDataDirectory, { recursive: true, force: true })
  passed = true
} catch {
  // 失败保留合成目录；不打印子进程原始输出或内部异常。
}

if (!passed) {
  process.stderr.write(`${resultMarker}_FAIL\n`)
  process.exitCode = 1
} else {
  process.stdout.write(`${resultMarker}_PASS\n`)
}
