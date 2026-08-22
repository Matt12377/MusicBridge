import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import test from 'node:test'

const desktopRoot = path.resolve('.')

function runStartupGate(
  mode: 'development' | 'production',
  crashGate = false,
  credentialVaultGate = false,
  credentialRecoveryGate = false,
) {
  const result = spawnSync(process.execPath, ['scripts/startup-gate.mjs', mode], {
    cwd: desktopRoot,
    encoding: 'utf8',
    timeout: 60_000,
    env: {
      ...process.env,
      ...(crashGate ? { MUSIC_BRIDGE_CORE_CRASH_GATE: '1' } : {}),
      ...(credentialVaultGate ? { MUSIC_BRIDGE_CREDENTIAL_VAULT_GATE: '1' } : {}),
      ...(credentialRecoveryGate ? { MUSIC_BRIDGE_CREDENTIAL_RECOVERY_GATE: '1' } : {}),
    },
  })

  assert.equal(result.error, undefined, result.error?.message)
  assert.equal(result.status, 0, `${mode} startup gate failed:\n${result.stdout}\n${result.stderr}`)
  assert.match(
    result.stdout,
    new RegExp(
      credentialVaultGate
        ? `CREDENTIAL_VAULT_GATE=${mode}`
        : credentialRecoveryGate
          ? `CREDENTIAL_RECOVERY_GATE=${mode}`
        : crashGate
          ? `CORE_CRASH_GATE=${mode}`
          : `DESKTOP_STARTUP_PASS=${mode}`,
    ),
  )
}

test('desktop startup and test-only Core crash gates pass serially', () => {
  runStartupGate('development')
  runStartupGate('production')
  runStartupGate('development', true)
})

test('Electron safeStorage credential vault gate passes with a synthetic value', () => {
  runStartupGate('development', false, true)
})

test('Electron cold-start and Core-restart credential recovery gate passes with a synthetic value', () => {
  runStartupGate('development', false, false, true)
})
