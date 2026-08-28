import { mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import electron from 'electron'
import { runStartupProcess } from './startup-gate-process.mjs'

const desktopRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const mode = process.argv[2]
const crashGate = process.env.MUSIC_BRIDGE_CORE_CRASH_GATE === '1'
const credentialVaultGate = process.env.MUSIC_BRIDGE_CREDENTIAL_VAULT_GATE === '1'
const coreRestartCredentialRecoveryGate =
  process.env.MUSIC_BRIDGE_CORE_RESTART_CREDENTIAL_RECOVERY_GATE === '1'

if (mode !== 'development' && mode !== 'production') {
  console.error('用法：node scripts/startup-gate.mjs <development|production>')
  process.exit(2)
}

function commandPath(name) {
  const suffix = process.platform === 'win32' ? '.cmd' : ''
  return path.join(desktopRoot, 'node_modules', '.bin', `${name}${suffix}`)
}

const userDataDirectory = await mkdtemp(
  path.join(os.tmpdir(), 'musicbridge-task036-startup-'),
)
let exitCode = 0

try {
  const buildResult = await runStartupProcess(commandPath('electron-vite'), ['build', '--mode', mode], {
    cwd: desktopRoot, env: process.env, output: 'inherit', exitTimeoutMs: 120_000,
  })
  if (buildResult.failure || !buildResult.closed || buildResult.code !== 0 || buildResult.signal !== null) {
    console.error(`DESKTOP_BUILD_FAIL=${mode}`)
    console.error(`DESKTOP_BUILD_REASON=${buildResult.failure ?? 'process-exit'}`)
    exitCode = 1
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

    const expectedMarker = credentialVaultGate
      ? 'CREDENTIAL_VAULT_GATE_PASS'
      : coreRestartCredentialRecoveryGate
        ? 'CORE_RESTART_CREDENTIAL_RECOVERY_GATE_PASS'
        : crashGate
          ? 'CORE_CRASH_GATE_PASS'
          : 'DESKTOP_STARTUP_READY'
    const result = await runStartupProcess(electron, ['dist/main/index.js'], {
      cwd: desktopRoot, env: childEnvironment,
      readyMarker: 'DESKTOP_STARTUP_READY', expectedMarker,
    })
    if (result.failure || !result.markerSeen || !result.closed || result.code !== 0 || result.signal !== null) {
      console.error(`DESKTOP_STARTUP_FAIL=${mode}`)
      console.error(`DESKTOP_STARTUP_REASON=${result.failure ?? 'process-exit'}`)
      if (result.failure?.endsWith('-timeout')) console.error('DESKTOP_STARTUP_TIMEOUT=true')
      exitCode = 1
    } else {
      console.log(
        `${credentialVaultGate ? 'CREDENTIAL_VAULT_GATE' : coreRestartCredentialRecoveryGate ? 'CORE_RESTART_CREDENTIAL_RECOVERY_GATE' : crashGate ? 'CORE_CRASH_GATE' : 'DESKTOP_STARTUP_PASS'}=${mode}`,
      )
    }
  }
} catch {
  console.error(`DESKTOP_STARTUP_FAIL=${mode}`)
  console.error('DESKTOP_STARTUP_REASON=gate-error')
  exitCode = 1
}

// 自建用户目录保留为测试证据，不在失败或仍有迟到子进程时删除。
process.exitCode = exitCode
