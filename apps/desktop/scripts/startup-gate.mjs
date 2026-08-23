import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import electron from 'electron'

const desktopRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const mode = process.argv[2]
const crashGate = process.env.MUSIC_BRIDGE_CORE_CRASH_GATE === '1'
const credentialVaultGate = process.env.MUSIC_BRIDGE_CREDENTIAL_VAULT_GATE === '1'
const coreRestartCredentialRecoveryGate =
  process.env.MUSIC_BRIDGE_CORE_RESTART_CREDENTIAL_RECOVERY_GATE === '1'

if (mode !== 'development' && mode !== 'production') {
  console.error('usage: node scripts/startup-gate.mjs <development|production>')
  process.exit(2)
}

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

const userDataDirectory = await mkdtemp(
  path.join(os.tmpdir(), 'musicbridge-task036-startup-'),
)
let exitCode = 0

try {
  const buildResult = await run(commandPath('electron-vite'), ['build', '--mode', mode])
  if (buildResult.code !== 0) {
    console.error(`DESKTOP_BUILD_FAIL=${mode}`)
    exitCode = buildResult.code ?? 1
  } else {
    const childEnvironment = {
      ...process.env,
      MUSIC_BRIDGE_STARTUP_TEST: '1',
      MUSIC_BRIDGE_CORE_TEST_MODE: '1',
      MUSIC_BRIDGE_STARTUP_USER_DATA_DIR: userDataDirectory,
      ...(crashGate ? { MUSIC_BRIDGE_CORE_CRASH_GATE: '1' } : {}),
      ...(credentialVaultGate ? { MUSIC_BRIDGE_CREDENTIAL_VAULT_GATE: '1' } : {}),
      ...(coreRestartCredentialRecoveryGate
        ? {
            MUSIC_BRIDGE_CORE_RESTART_CREDENTIAL_RECOVERY_GATE: '1',
            MUSIC_BRIDGE_CORE_CRASH_DELAY_MS: '250',
          }
        : {}),
    }
    delete childEnvironment.NETEASE_COOKIE
    delete childEnvironment.MUSIC_BRIDGE_CREDENTIAL_RECOVERY_GATE
    delete childEnvironment.MUSIC_BRIDGE_CREDENTIAL_COLD_START_STAGE

    const child = spawn(electron, ['dist/main/index.js'], {
      cwd: desktopRoot,
      env: childEnvironment,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''
    let finished = false

    const result = await new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (!finished) {
          finished = true
          child.kill('SIGTERM')
          resolve({ code: null, timedOut: true })
        }
      }, 30_000)

      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString()
        if (!finished && stdout.includes('DESKTOP_STARTUP_READY')) {
          finished = true
          clearTimeout(timer)
          child.once('exit', (code) => resolve({ code, timedOut: false }))
        }
      })
      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString()
      })
      child.once('error', (error) => {
        if (!finished) {
          finished = true
          clearTimeout(timer)
          resolve({ code: null, error, timedOut: false })
        }
      })
      child.once('exit', (code) => {
        if (!finished) {
          finished = true
          clearTimeout(timer)
          resolve({ code, timedOut: false })
        }
      })
    })

    const expectedMarker = credentialVaultGate
      ? 'CREDENTIAL_VAULT_GATE_PASS'
      : coreRestartCredentialRecoveryGate
        ? 'CORE_RESTART_CREDENTIAL_RECOVERY_GATE_PASS'
        : crashGate
          ? 'CORE_CRASH_GATE_PASS'
          : 'DESKTOP_STARTUP_READY'
    if (!stdout.includes(expectedMarker) || result.code !== 0) {
      console.error(`DESKTOP_STARTUP_FAIL=${mode}`)
      if (result.timedOut) console.error('DESKTOP_STARTUP_TIMEOUT=true')
      if (stderr.trim()) console.error(stderr.trim().slice(-2000))
      exitCode = 1
    } else {
      console.log(
        `${credentialVaultGate ? 'CREDENTIAL_VAULT_GATE' : coreRestartCredentialRecoveryGate ? 'CORE_RESTART_CREDENTIAL_RECOVERY_GATE' : crashGate ? 'CORE_CRASH_GATE' : 'DESKTOP_STARTUP_PASS'}=${mode}`,
      )
    }
  }
} finally {
  await rm(userDataDirectory, { recursive: true, force: true })
}

process.exitCode = exitCode
