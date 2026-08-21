import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import test from 'node:test'

const desktopRoot = path.resolve('.')

function runStartupGate(mode: 'development' | 'production') {
  const result = spawnSync(process.execPath, ['scripts/startup-gate.mjs', mode], {
    cwd: desktopRoot,
    encoding: 'utf8',
    timeout: 60_000,
  })

  assert.equal(result.error, undefined, result.error?.message)
  assert.equal(result.status, 0, `${mode} startup gate failed:\n${result.stdout}\n${result.stderr}`)
  assert.match(result.stdout, new RegExp(`DESKTOP_STARTUP_PASS=${mode}`))
}

test('development build starts the unpacked desktop shell', () => {
  runStartupGate('development')
})

test('production build starts the unpacked desktop shell', () => {
  runStartupGate('production')
})
