import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import electron from 'electron'

const desktopRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
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

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: desktopRoot,
      env: process.env,
      stdio: 'inherit',
      ...options,
    })
    child.once('error', reject)
    child.once('exit', (code, signal) => resolve({ code, signal }))
  })
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
  ]) delete environment[key]
  assertNoPlaintextCredentialEnvironment(environment)

  return new Promise((resolve) => {
    const child = spawn(electron, ['dist/main/index.js'], {
      cwd: desktopRoot,
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill('SIGTERM')
      resolve({ code: null, signal: 'SIGTERM', stdout, stderr, timedOut: true })
    }, 30_000)

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString()
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
    })
    child.once('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code: null, signal: null, stdout, stderr, error, timedOut: false })
    })
    child.once('exit', (code, signal) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code, signal, stdout, stderr, timedOut: false })
    })
  })
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
  const build = await run(commandPath('electron-vite'), ['build', '--mode', 'development'])
  if (build.code !== 0) throw new Error('cold-start gate desktop build failed')

  const first = await runElectronStage('seed', userDataDirectory)
  if (first.code !== 0 || !first.stdout.includes('ELECTRON_COLD_START_SEED_PASS')) {
    throw new Error('cold-start seed Electron process did not exit cleanly')
  }
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
  if (second.code !== 0 || !second.stdout.includes('ELECTRON_COLD_START_RESTORE_PASS')) {
    throw new Error('cold-start restore Electron process did not exit cleanly')
  }
  if (await pathExists(vaultPath)) {
    throw new Error('cold-start restore did not delete the synthetic vault')
  }
  passed = true
} finally {
  await rm(userDataDirectory, { recursive: true, force: true })
}

if (!passed) {
  process.stderr.write('ELECTRON_COLD_START_CREDENTIAL_RECOVERY_GATE_FAIL\n')
  process.exitCode = 1
} else {
  process.stdout.write('ELECTRON_COLD_START_CREDENTIAL_RECOVERY_GATE_PASS\n')
}
