import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import test from 'node:test'

const desktopRoot = path.resolve('.')

function runStartupGate(
  mode: 'development' | 'production',
  crashGate = false,
  credentialVaultGate = false,
  coreRestartCredentialRecoveryGate = false,
) {
  const result = spawnSync(process.execPath, ['scripts/startup-gate.mjs', mode], {
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
  assert.match(
    result.stdout,
    new RegExp(
      credentialVaultGate
        ? `CREDENTIAL_VAULT_GATE=${mode}`
        : coreRestartCredentialRecoveryGate
          ? `CORE_RESTART_CREDENTIAL_RECOVERY_GATE=${mode}`
          : crashGate
            ? `CORE_CRASH_GATE=${mode}`
            : `DESKTOP_STARTUP_PASS=${mode}`,
    ),
  )
}

test('Electron startup and Core crash gates pass serially', () => {
  runStartupGate('development')
  runStartupGate('production')
  runStartupGate('development', true)
})

test('Electron safeStorage credential vault gate passes with a synthetic value', () => {
  runStartupGate('development', false, true)
})

test('same-process Core restart credential recovery gate passes with a synthetic value', () => {
  runStartupGate('development', false, false, true)
})

test('two-process Electron cold-start credential recovery gate passes with a synthetic value', () => {
  const result = spawnSync(process.execPath, ['scripts/cold-start-credential-gate.mjs'], {
    cwd: desktopRoot,
    encoding: 'utf8',
    timeout: 120_000,
  })

  assert.equal(result.error, undefined, result.error?.message)
  assert.equal(
    result.status,
    0,
    `Electron cold-start credential recovery gate failed:\n${result.stdout}\n${result.stderr}`,
  )
  assert.match(result.stdout, /ELECTRON_COLD_START_CREDENTIAL_RECOVERY_GATE_PASS/)
})
