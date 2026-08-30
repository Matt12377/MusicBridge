import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import test from 'node:test'
import { readTestKeychainMode } from '../scripts/test-keychain.mjs'

const desktopRoot = path.resolve('.')
const keychainMode = readTestKeychainMode()
const testLabel = keychainMode === 'mock' ? '[mock 软件集成；系统钥匙串未验证]' : '[system]'

function runStartupGate(
  mode: 'development' | 'production',
  crashGate = false,
  credentialVaultGate = false,
  coreRestartCredentialRecoveryGate = false,
) {
  const result = spawnSync(process.execPath, ['scripts/startup-gate.mjs', mode, `--keychain=${keychainMode}`], {
    cwd: desktopRoot,
    encoding: 'utf8',
    // 覆盖构建120秒、启动/退出各30秒及内层清理；外层不能提前杀掉清理进程。
    timeout: 210_000,
    env: {
      ...process.env,
      ...(crashGate ? { MUSIC_BRIDGE_CORE_CRASH_GATE: '1' } : {}),
      ...(credentialVaultGate ? { MUSIC_BRIDGE_CREDENTIAL_VAULT_GATE: '1' } : {}),
      ...(coreRestartCredentialRecoveryGate
        ? { MUSIC_BRIDGE_CORE_RESTART_CREDENTIAL_RECOVERY_GATE: '1' }
        : {}),
    },
  })

  assert.equal(result.error, undefined, result.error?.message)
  assert.equal(result.status, 0, `${mode} startup gate failed:\n${result.stdout}\n${result.stderr}`)
  assert.match(result.stdout, new RegExp(`^KEYCHAIN_MODE=${keychainMode}$`, 'm'))
  if (keychainMode === 'mock') assert.match(result.stdout, /^REAL_KEYCHAIN_GATE=NOT_RUN$/m)
  const resultMarker = credentialVaultGate ? 'CREDENTIAL_VAULT_GATE' : coreRestartCredentialRecoveryGate ? 'CORE_RESTART_CREDENTIAL_RECOVERY_GATE' : crashGate ? 'CORE_CRASH_GATE' : 'DESKTOP_STARTUP_PASS'
  const labeledMarker = keychainMode === 'mock' ? resultMarker.replace(/_(GATE|PASS)$/u, '_MOCK_$1') : resultMarker
  assert.match(
    result.stdout,
    new RegExp(`^${labeledMarker}=${mode}$`, 'm'),
  )
}

test(`${testLabel} Electron startup and Core crash gates pass serially`, () => {
  runStartupGate('development')
  runStartupGate('production')
  runStartupGate('development', true)
})

test(`${testLabel} Electron safeStorage credential vault gate passes with a synthetic value`, () => {
  runStartupGate('development', false, true)
})

test(`${testLabel} same-process Core restart credential recovery gate passes with a synthetic value`, () => {
  runStartupGate('development', false, false, true)
})

test(`${testLabel} two-process Electron cold-start credential recovery gate passes with a synthetic value`, () => {
  const result = spawnSync(process.execPath, ['scripts/cold-start-credential-gate.mjs', `--keychain=${keychainMode}`], {
    cwd: desktopRoot,
    encoding: 'utf8',
    // 构建120秒、两阶段各最多60秒及内层清理余量；不能提前杀验证父进程。
    timeout: 270_000,
  })

  assert.equal(result.error, undefined, result.error?.message)
  assert.equal(
    result.status,
    0,
    `Electron cold-start credential recovery gate failed:\n${result.stdout}\n${result.stderr}`,
  )
  assert.match(result.stdout, new RegExp(`^KEYCHAIN_MODE=${keychainMode}$`, 'm'))
  if (keychainMode === 'mock') assert.match(result.stdout, /^REAL_KEYCHAIN_GATE=NOT_RUN$/m)
  assert.match(result.stdout, new RegExp(`^ELECTRON_COLD_START_CREDENTIAL_RECOVERY_${keychainMode === 'mock' ? 'MOCK_' : ''}GATE_PASS$`, 'm'))
})
