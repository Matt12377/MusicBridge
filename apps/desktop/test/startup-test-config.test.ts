import assert from 'node:assert/strict'
import { realpathSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { readStartupTestConfiguration } from '../src/main/startup-test-config.js'

test('startup configuration accepts a bounded cold-start stage and temporary userData directory', async () => {
  const userDataDirectory = await mkdtemp(
    path.join(os.tmpdir(), 'musicbridge-task036-cold-start-'),
  )
  try {
    assert.deepEqual(
      readStartupTestConfiguration({
        MUSIC_BRIDGE_STARTUP_TEST: '1',
        MUSIC_BRIDGE_STARTUP_USER_DATA_DIR: userDataDirectory,
        MUSIC_BRIDGE_CREDENTIAL_COLD_START_STAGE: 'restore',
      }),
      {
        isStartupTest: true,
        userDataDirectory: realpathSync(userDataDirectory),
        coreCrashGate: false,
        credentialVaultGate: false,
        coreRestartCredentialRecoveryGate: false,
        electronColdStartStage: 'restore',
      },
    )
  } finally {
    await rm(userDataDirectory, { recursive: true, force: true })
  }
})

test('startup configuration rejects an unbounded userData path and an invalid stage', async () => {
  assert.throws(
    () =>
      readStartupTestConfiguration({
        MUSIC_BRIDGE_STARTUP_TEST: '1',
        MUSIC_BRIDGE_STARTUP_USER_DATA_DIR: path.join(os.tmpdir(), 'musicbridge-task036-invalid'),
      }),
    /invalid temporary directory name/,
  )
  const userDataDirectory = await mkdtemp(
    path.join(os.tmpdir(), 'musicbridge-task036-startup-'),
  )
  try {
    assert.throws(
      () =>
        readStartupTestConfiguration({
          MUSIC_BRIDGE_STARTUP_TEST: '1',
          MUSIC_BRIDGE_STARTUP_USER_DATA_DIR: userDataDirectory,
          MUSIC_BRIDGE_CREDENTIAL_COLD_START_STAGE: 'unknown',
        }),
      /must be seed or restore/,
    )
  } finally {
    await rm(userDataDirectory, { recursive: true, force: true })
  }
})

test('startup configuration rejects startup-only variables outside startup test mode', () => {
  assert.throws(
    () =>
      readStartupTestConfiguration({
        MUSIC_BRIDGE_CORE_RESTART_CREDENTIAL_RECOVERY_GATE: '1',
      }),
    /require MUSIC_BRIDGE_STARTUP_TEST=1/,
  )
  assert.throws(
    () => readStartupTestConfiguration({ MUSIC_BRIDGE_CREDENTIAL_RECOVERY_GATE: '1' }),
    /obsolete/,
  )
})
