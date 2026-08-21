import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DiagnosticRingBuffer,
  assertDiagnosticExportSafe,
  buildDiagnosticReport,
  type DiagnosticComponentSnapshot,
} from '../src/diagnostics.js'

const health = {
  runtime: 'ready' as const,
  roon: 'ready' as const,
  provider: 'missing' as const,
  activeStreamCount: 0,
  activePlaybackPresent: false,
}

function snapshot(component: 'main' | 'core'): DiagnosticComponentSnapshot {
  return {
    component,
    health,
    timeline: [],
    memory: {
      rssBytes: 1,
      heapUsedBytes: 2,
      heapTotalBytes: 3,
      externalBytes: 4,
    },
    counters: {
      queueItemCount: 0,
      activeStreamCount: 0,
      activePlaybackCount: 0,
      activeSessionCount: 0,
      activeTokenCount: 0,
      listenerCount: 0,
      timerCount: 0,
    },
    latency: {},
    gates: [{ name: 'synthetic', status: 'pass' }],
  }
}

test('DiagnosticRingBuffer is bounded and returns immutable-safe snapshots', () => {
  const buffer = new DiagnosticRingBuffer(2)
  buffer.record({ component: 'core', level: 'info', event: 'first' })
  buffer.record({ component: 'core', level: 'warn', event: 'second', code: 'ONE' })
  buffer.record({ component: 'core', level: 'error', event: 'third', diagnosticId: 'diag-3' })

  assert.deepEqual(
    buffer.snapshot().map((event) => event.event),
    ['second', 'third'],
  )
  const copy = buffer.snapshot()
  const mutableCopy = [...copy]
  mutableCopy.pop()
  assert.equal(buffer.snapshot().length, 2)
})

test('diagnostic export contains only the bounded public schema', () => {
  const report = buildDiagnosticReport({
    platform: {
      platform: 'darwin',
      arch: 'arm64',
      appVersion: '0.1.0-poc.1',
      electronVersion: '43.4.0',
      nodeVersion: '22.0.0',
    },
    main: snapshot('main'),
    core: snapshot('core'),
    generatedAt: '2026-08-22T00:00:00.000Z',
  })

  const serialized = JSON.stringify(report)
  assert.equal(report.schemaVersion, 1)
  assert.doesNotMatch(serialized, /trackId|account|profile|Cookie|MUSIC_U|__csrf/i)
  assert.doesNotMatch(serialized, /https?:\/\/|[?&][A-Za-z0-9_-]+=|\/Users\//)
  assertDiagnosticExportSafe(serialized)
})

test('diagnostic export rejects injected secrets without echoing them', () => {
  const unsafeValues = [
    '{"message":"Cookie: synthetic-value"}',
    '{"token":"synthetic-value"}',
    '{"url":"https://music.example.invalid/audio"}',
    '{"path":"/Users/example/private.json"}',
    '{"query":"?synthetic=1"}',
  ]

  for (const value of unsafeValues) {
    assert.throws(
      () => assertDiagnosticExportSafe(value),
      (error: Error) => {
        assert.equal(error.message, 'Diagnostic export rejected by secret scan')
        return true
      },
    )
  }
})
