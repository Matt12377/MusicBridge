import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import type { TypedIpcEvent } from '@music-bridge/contracts'
import {
  MainDiagnosticRecorder,
  writeDiagnosticReport,
} from '../src/main/diagnostics.js'

test('Main diagnostic recorder keeps public Core health and a bounded event timeline', () => {
  const recorder = new MainDiagnosticRecorder(2)
  const event = {
    version: 1,
    event: 'core.health',
    payload: {
      state: {
        runtime: 'ready',
        roon: 'ready',
        provider: 'missing',
        activeStreamCount: 0,
        activePlaybackPresent: false,
      },
    },
  } satisfies TypedIpcEvent

  recorder.recordCoreEvent(event)
  recorder.recordLifecycle('window_created')
  recorder.recordLifecycle('window_closed')
  recorder.recordLifecycle('remote_core_tunnel_failed', 'error', {
    code: 'SSH_CONNECTION_FAILED',
    state: 'failed',
  })

  const snapshot = recorder.snapshot(event.payload.state)
  assert.equal(snapshot.component, 'main')
  assert.equal(snapshot.health.runtime, 'ready')
  assert.deepEqual(snapshot.timeline.map((item) => item.event), ['window_closed', 'remote_core_tunnel_failed'])
  assert.equal(snapshot.timeline[1]?.code, 'SSH_CONNECTION_FAILED')
  assert.equal(snapshot.timeline[1]?.state, 'failed')
  assert.doesNotMatch(JSON.stringify(snapshot), /trackId|Cookie|https?:\/\//i)
})

test('diagnostic report writer creates one restricted JSON file', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'musicbridge-diagnostics-'))
  try {
    const outputPath = path.join(directory, 'diagnostics.json')
    const recorder = new MainDiagnosticRecorder()
    const state = {
      runtime: 'ready' as const,
      roon: 'ready' as const,
      provider: 'missing' as const,
      activeStreamCount: 0,
      activePlaybackPresent: false,
    }

    await writeDiagnosticReport(outputPath, {
      platform: {
        platform: 'darwin',
        arch: 'arm64',
        appVersion: '0.1.0-beta.2',
        electronVersion: '43.4.0',
        nodeVersion: '22.0.0',
      },
      main: recorder.snapshot(state),
      core: { ...recorder.snapshot(state), component: 'core' },
    })

    const file = await stat(outputPath)
    assert.equal(file.mode & 0o777, 0o600)
    const report = JSON.parse(await readFile(outputPath, 'utf8')) as { schemaVersion?: number }
    assert.equal(report.schemaVersion, 1)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
