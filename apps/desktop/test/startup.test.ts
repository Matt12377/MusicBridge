import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import test from 'node:test'

const desktopRoot = path.resolve('.')

function runStartupGate(mode: 'development' | 'production', crashGate = false) {
  const result = spawnSync(process.execPath, ['scripts/startup-gate.mjs', mode], {
    cwd: desktopRoot,
    encoding: 'utf8',
    timeout: 60_000,
    env: {
      ...process.env,
      ...(crashGate ? { MUSIC_BRIDGE_CORE_CRASH_GATE: '1' } : {}),
    },
  })

  assert.equal(result.error, undefined, result.error?.message)
  assert.equal(result.status, 0, `${mode} startup gate failed:\n${result.stdout}\n${result.stderr}`)
  assert.match(
    result.stdout,
    new RegExp(crashGate ? `CORE_CRASH_GATE=${mode}` : `DESKTOP_STARTUP_PASS=${mode}`),
  )
}

test('desktop startup and test-only Core crash gates pass serially', () => {
  runStartupGate('development')
  runStartupGate('production')
  runStartupGate('development', true)
})
