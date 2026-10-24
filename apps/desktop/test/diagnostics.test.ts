import assert from 'node:assert/strict'
import { writeSync } from 'node:fs'
import { mkdtemp, open, readFile, rm, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import type { TypedIpcEvent } from '@music-bridge/contracts'
import {
  MainDiagnosticRecorder,
  writeDiagnosticReport,
} from '../src/main/diagnostics.js'
import { createLocalWorkbenchQuitCoordinator, type LocalWorkbenchQuitGroup } from '../src/main/local-library-workbench/quit-coordinator.js'

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

test('Main diagnostic recorder anchors playback startup at the Renderer click', () => {
  const recorder = new MainDiagnosticRecorder()

  recorder.recordPlaybackStartup(1_700_000_000_000, 1_700_000_000_037)

  const timeline = recorder.snapshot().timeline
  assert.deepEqual(timeline.map((item) => ({ event: item.event, durationMs: item.durationMs })), [
    { event: 'playback_renderer_click', durationMs: 0 },
    { event: 'playback_main_ipc_received', durationMs: 37 },
  ])
  assert.equal(timeline[0]?.at, '2023-11-14T22:13:20.000Z')
  assert.equal(timeline[1]?.at, '2023-11-14T22:13:20.037Z')
})

test('Main diagnostic recorder retains playback startup stages during high-frequency updates', () => {
  const recorder = new MainDiagnosticRecorder()
  const rendererClickAtMs = 1_700_000_000_000

  for (let index = 0; index < 5; index += 1) {
    const clickAtMs = rendererClickAtMs + index * 1_000
    recorder.recordPlaybackStartup(clickAtMs, clickAtMs + index + 1)
  }
  for (let index = 0; index < 250; index += 1) {
    recorder.recordLifecycle(`runtime_update_${index}`)
  }

  const timeline = recorder.snapshot().timeline
  const playbackStages = timeline.filter((item) => item.event.startsWith('playback_'))

  assert.equal(timeline.length, 200)
  assert.deepEqual(
    playbackStages.map((item) => ({ event: item.event, durationMs: item.durationMs })),
    [
      { event: 'playback_renderer_click', durationMs: 0 },
      { event: 'playback_main_ipc_received', durationMs: 1 },
      { event: 'playback_renderer_click', durationMs: 0 },
      { event: 'playback_main_ipc_received', durationMs: 2 },
      { event: 'playback_renderer_click', durationMs: 0 },
      { event: 'playback_main_ipc_received', durationMs: 3 },
      { event: 'playback_renderer_click', durationMs: 0 },
      { event: 'playback_main_ipc_received', durationMs: 4 },
      { event: 'playback_renderer_click', durationMs: 0 },
      { event: 'playback_main_ipc_received', durationMs: 5 },
    ],
  )
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


test('私有诊断导出：同请求快照与媒体完成量写入受限文件，保留公开报告', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'musicbridge-private-diagnostics-'))
  try {
    const outputPath = path.join(directory, 'diagnostics.json'), recorder = new MainDiagnosticRecorder()
    const localAlbum = { schema: 'v39.local-album-safe-trace.v1' as const, records: [], firstRejects: [], droppedRecords: 0 }
    const media = { timestamp: '2026-10-14T10:00:00.000Z', level: 'info', event: 'local_playback_media_evidence', schemaVersion: 1, component: 'gateway',
      diagnosticId: 'diag-local-' + 'a'.repeat(64), stage: 'transfer-terminal', currentOwned: true, staleCallback: false,
      requestSequence: 1, method: 'GET', routeClass: 'local-file', rangeClass: 'none', outcome: 'body-completed', statusCode: 200,
      pipelineBodyBytesObserved: 100, observedBytesCapped: false, responseFinished: true, elapsedMs: 10, completedPipelineBodyBytes: 100 }
    await writeDiagnosticReport(outputPath, {
      platform: { platform: 'darwin', arch: 'arm64', appVersion: '0.1.0-beta.2', electronVersion: '43.4.0', nodeVersion: '22.23.2' },
      main: recorder.snapshot(), core: { ...recorder.snapshot(), component: 'core' }, privateEvidence: { version: 1, localAlbum, localPlayback: [media] },
    })
    const report = JSON.parse(await readFile(outputPath, 'utf8'))
    assert.equal(report.schemaVersion, 1)
    assert.deepEqual(report.privateEvidence, { version: 1, localAlbum, localPlayback: [media] })
    assert.equal((await stat(outputPath)).mode & 0o777, 0o600)
    assert.doesNotMatch(JSON.stringify(report.privateEvidence), /https?:\/\/|sessionId|requestId|sourcePath|Cookie/)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('私有诊断导出：非法媒体记录与截断计数不伪装成功，不覆盖原文件', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'musicbridge-private-diagnostics-reject-'))
  try {
    const outputPath = path.join(directory, 'diagnostics.json'), recorder = new MainDiagnosticRecorder()
    const input = { platform: { platform: 'darwin' as const, arch: 'arm64', appVersion: '0.1.0-beta.2', electronVersion: '43.4.0', nodeVersion: '22.23.2' },
      main: recorder.snapshot(), core: { ...recorder.snapshot(), component: 'core' as const } }
    await writeDiagnosticReport(outputPath, input)
    const original = await readFile(outputPath)
    const localAlbum = { schema: 'v39.local-album-safe-trace.v1' as const, records: [], firstRejects: [], droppedRecords: 3 }
    await assert.rejects(writeDiagnosticReport(outputPath, { ...input,
      privateEvidence: { version: 1, localAlbum, localPlayback: [{ url: 'https://example.invalid/private', sessionId: '不可导出' }] },
    }), /安全闭集/)
    assert.deepEqual(await readFile(outputPath), original)
    await writeDiagnosticReport(outputPath, { ...input, privateEvidence: { version: 1, localAlbum, localPlayback: [] } })
    const report = JSON.parse(await readFile(outputPath, 'utf8'))
    assert.equal(report.privateEvidence.localAlbum.droppedRecords, 3)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

interface ShutdownStageRow {
  schema: 'musicbridge.shutdown-stage.v1'; component: 'main'; at: string; event: string; phase: string | null
  status: 'pending' | 'completed' | 'failed'; elapsedMs: number | null; code: string | null; failureKind: 'first' | 'cleanup' | null
  pending: string[]; completed: string[]; failed: string[]; firstFailure: { phase: string; code: string } | null
  cleanupFailures: Array<{ phase: string; code: string }>
}
const shutdownPrefix = 'MUSICBRIDGE_SHUTDOWN_STAGE '
const shutdownTick = () => new Promise<void>(resolve => setImmediate(resolve))
function shutdownTraceFixture() {
  const lines: string[] = []; let elapsed = 0
  const recorder = new MainDiagnosticRecorder(200, { sink: line => { lines.push(line) }, now: () => elapsed,
    utcNow: () => Date.parse('2026-10-15T07:00:00.000Z') + elapsed })
  const rows = (): ShutdownStageRow[] => lines.map(line => {
    assert.ok(line.startsWith(shutdownPrefix) && line.endsWith('\n'))
    assert.ok(Buffer.byteLength(line, 'utf8') <= 4 * 1024, '每行闭集旁注不超过4KiB。')
    const row = JSON.parse(line.slice(shutdownPrefix.length)) as ShutdownStageRow
    assert.deepEqual(Object.keys(row).sort(), ['schema', 'component', 'at', 'event', 'phase', 'status', 'elapsedMs', 'code', 'failureKind', 'pending', 'completed', 'failed', 'firstFailure', 'cleanupFailures'].sort())
    assert.equal(row.schema, 'musicbridge.shutdown-stage.v1'); assert.equal(row.component, 'main')
    assert.match(row.at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u)
    assert.doesNotMatch(line, /reason|message|stack|https?:\/\/|request_id|session|token|sourcePath|\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/iu)
    return row
  })
  return { recorder, lines, rows, advance(milliseconds: number) { elapsed += milliseconds } }
}
/** 原coordinator接原recorder；关闭者只提供本例受控Promise，不冒充真实Main/Owner闭口。 */
function tracedShutdown(recorder: MainDiagnosticRecorder, groups: readonly LocalWorkbenchQuitGroup[], codes = new Map<unknown, string>()) {
  return createLocalWorkbenchQuitCoordinator({ groups,
    onPhaseStart: phase => recorder.recordLifecycle('local_workbench_shutdown_phase_start', 'info', { state: phase }),
    onPhaseSettled: phase => recorder.recordLifecycle('local_workbench_shutdown_phase_settled', 'info', { state: phase }),
    onFailure: (failure, first) => recorder.recordLifecycle(first ? 'local_workbench_shutdown_failure' : 'local_workbench_shutdown_cleanup_failure', 'error',
      { state: failure.phase, code: codes.get(failure.reason) ?? 'INTERNAL_ERROR' }),
  })
}

test('退出阶段私有旁注：艺术家目录关闭等待和失败可见，保留真实关闭屏障', async t => {
  const f = shutdownTraceFixture(); let reject!: (error: unknown) => void, ownerCalls = 0
  const failure = new Error('合成目录关闭原因不能写入日志')
  const held = new Promise<void>((_, fail) => { reject = fail })
  const coordinator = tracedShutdown(f.recorder, [{ steps: [['close_artist_catalog', () => held]] },
    { requiresPreviousSuccess: true, steps: [['owner_shutdown', () => { ownerCalls++ }]] }])
  const flight = coordinator.request()!
  t.after(async () => { reject(failure); await Promise.allSettled([flight]) })
  await shutdownTick()
  assert.equal(coordinator.pending, true)
  assert.deepEqual(f.rows().at(-1)?.pending, ['close_artist_catalog'])
  assert.equal(ownerCalls, 0)
  f.advance(30); reject(failure)
  await assert.rejects(flight)
  const last = f.rows().at(-1)!
  assert.deepEqual(last.failed, ['close_artist_catalog'])
  assert.deepEqual(last.pending, [])
  assert.deepEqual(last.firstFailure, { phase: 'close_artist_catalog', code: 'INTERNAL_ERROR' })
  assert.equal(coordinator.confirmed, false)
  assert.equal(ownerCalls, 0)
  assert.doesNotMatch(f.lines.join(''), /合成目录关闭原因/u)
})

test('退出阶段私有旁注：媒体池原关闭在途可见pending，真实完成后才记成功', async t => {
  const f = shutdownTraceFixture(); let release!: () => void, mediaCalls = 0, ownerCalls = 0
  const held = new Promise<void>(resolve => { release = resolve })
  const coordinator = tracedShutdown(f.recorder, [{ steps: [['prepare_media_worker', () => { mediaCalls++; return held }]] },
    { steps: [['owner_shutdown', () => { ownerCalls++ }]] }])
  const flight = coordinator.request()!
  t.after(async () => { release(); await Promise.allSettled([flight]) })
  await shutdownTick()
  assert.equal(coordinator.pending, true); assert.equal(coordinator.confirmed, false)
  assert.equal(coordinator.request(), undefined); assert.equal(mediaCalls, 1); assert.equal(ownerCalls, 0)
  const pending = f.rows()
  assert.equal(pending.length, 1)
  assert.deepEqual(pending[0], {
    schema: 'musicbridge.shutdown-stage.v1', component: 'main', at: '2026-10-15T07:00:00.000Z',
    event: 'local_workbench_shutdown_phase_start', phase: 'prepare_media_worker', status: 'pending', elapsedMs: 0,
    code: null, failureKind: null, pending: ['prepare_media_worker'], completed: [], failed: [], firstFailure: null, cleanupFailures: [],
  })
  f.advance(19); release(); await flight
  assert.equal(coordinator.confirmed, true); assert.equal(mediaCalls, 1); assert.equal(ownerCalls, 1)
  const media = f.rows().filter(row => row.phase === 'prepare_media_worker')
  assert.deepEqual(media.map(row => [row.event, row.status, row.elapsedMs]), [
    ['local_workbench_shutdown_phase_start', 'pending', 0], ['local_workbench_shutdown_phase_settled', 'completed', 19],
  ])
  assert.deepEqual(media[1]?.pending, []); assert.deepEqual(media[1]?.completed, ['prepare_media_worker'])
  assert.deepEqual(f.rows().at(-1)?.completed, ['prepare_media_worker', 'owner_shutdown'])
})

test('退出阶段私有旁注：媒体池关闭首错保持原拒绝且进入首错收据', async () => {
  const f = shutdownTraceFixture(), first = new Error('合成媒体关闭秘密不得进入日志')
  let joins = 0, gated = 0
  const coordinator = tracedShutdown(f.recorder, [
    { steps: [['prepare_media_worker', () => { f.advance(7); throw first }]] },
    { steps: [['join_readers', () => { joins++ }]] },
    { requiresPreviousSuccess: true, steps: [['revoke_author', () => { gated++ }]] },
  ], new Map([[first, 'INTERNAL_ERROR']]))
  await assert.rejects(coordinator.request()!, error => error === first)
  assert.equal(coordinator.firstFailure?.reason, first); assert.equal(coordinator.confirmed, false)
  assert.equal(coordinator.pending, false); assert.equal(joins, 1); assert.equal(gated, 0)
  f.recorder.recordLifecycle('local_workbench_shutdown_not_verified', 'error', { code: 'INTERNAL_ERROR' })
  const media = f.rows().filter(row => row.phase === 'prepare_media_worker'), tail = f.rows().at(-1)!
  assert.deepEqual(media.map(row => [row.event, row.status, row.failureKind, row.code]), [
    ['local_workbench_shutdown_phase_start', 'pending', null, null],
    ['local_workbench_shutdown_failure', 'failed', 'first', 'INTERNAL_ERROR'],
  ])
  assert.deepEqual(tail.firstFailure, { phase: 'prepare_media_worker', code: 'INTERNAL_ERROR' })
  assert.deepEqual(tail.failed, ['prepare_media_worker']); assert.deepEqual(tail.cleanupFailures, [])
  assert.deepEqual(tail.pending, []); assert.deepEqual(tail.completed, ['join_readers'])
  assert.doesNotMatch(f.lines.join(''), /合成媒体关闭秘密/u)
})

test('退出阶段私有旁注：媒体池后续清理拒绝单独保留，不覆盖原准备首错', async t => {
  const f = shutdownTraceFixture(), first = new Error('合成准备秘密不得进入日志'), cleanup = new Error('合成媒体清理秘密不得进入日志')
  let release!: () => void, ownerCalls = 0, gated = 0
  const held = new Promise<void>(resolve => { release = resolve })
  const coordinator = tracedShutdown(f.recorder, [{ steps: [
    ['prepare_reads', () => { f.advance(1); throw first }],
    ['prepare_media_worker', async () => { await held; f.advance(9); throw cleanup }],
  ] }, { steps: [['owner_shutdown', () => { ownerCalls++ }]] },
  { requiresPreviousSuccess: true, steps: [['revoke_author', () => { gated++ }]] }], new Map([[first, 'CHANGED'], [cleanup, 'TIMEOUT']]))
  const flight = coordinator.request()!, rejected = assert.rejects(flight, error => error === first)
  t.after(async () => { release(); await Promise.allSettled([flight, rejected]) })
  await shutdownTick()
  assert.equal(coordinator.firstFailure?.reason, first); assert.equal(ownerCalls, 0)
  assert.deepEqual(f.rows().at(-1)?.pending, ['prepare_media_worker'])
  release(); await rejected
  assert.equal(coordinator.confirmed, false); assert.equal(ownerCalls, 1); assert.equal(gated, 0)
  f.recorder.recordLifecycle('local_workbench_shutdown_not_verified', 'error', { code: 'CHANGED' })
  const media = f.rows().filter(row => row.phase === 'prepare_media_worker'), tail = f.rows().at(-1)!
  assert.equal(media.length, 2); assert.equal(media[1]?.event, 'local_workbench_shutdown_cleanup_failure')
  assert.equal(media[1]?.failureKind, 'cleanup'); assert.equal(media[1]?.code, 'TIMEOUT'); assert.equal(media[1]?.elapsedMs, 9)
  assert.deepEqual(tail.firstFailure, { phase: 'prepare_reads', code: 'CHANGED' })
  assert.deepEqual(tail.cleanupFailures, [{ phase: 'prepare_media_worker', code: 'TIMEOUT' }])
  assert.deepEqual(tail.failed, ['prepare_reads', 'prepare_media_worker']); assert.deepEqual(tail.completed, ['owner_shutdown'])
  assert.deepEqual(tail.pending, []); assert.doesNotMatch(f.lines.join(''), /合成准备秘密|合成媒体清理秘密/u)
})

test('退出阶段私有旁注：Core缺席时仍记录原coordinator成功与UTC耗时，公开报告字段保持', async () => {
  const f = shutdownTraceFixture(), calls: string[] = []
  const coordinator = tracedShutdown(f.recorder, [{ steps: [
    ['prepare_reads', () => { calls.push('prepare_reads'); f.advance(12) }],
  ] }, { steps: [['owner_shutdown', () => { calls.push('owner_shutdown'); f.advance(8) }]] },
  { steps: [['close_outbox', () => { calls.push('close_outbox'); f.advance(5) }]] }])
  assert.equal(f.recorder.snapshot().health.runtime, 'starting', 'fixture没有Core实例或诊断RPC。')
  await coordinator.request(); assert.equal(coordinator.confirmed, true)
  assert.deepEqual(calls, ['prepare_reads', 'owner_shutdown', 'close_outbox'])
  const rows = f.rows(); assert.equal(rows.length, 6)
  assert.deepEqual(rows.filter(row => row.status === 'completed').map(row => [row.phase, row.elapsedMs]), [['prepare_reads', 12], ['owner_shutdown', 8], ['close_outbox', 5]])
  assert.equal(rows[0]?.at, '2026-10-15T07:00:00.000Z'); assert.equal(rows.at(-1)?.at, '2026-10-15T07:00:00.025Z')
  assert.deepEqual(rows.at(-1)?.pending, []); assert.deepEqual(rows.at(-1)?.completed, ['prepare_reads', 'owner_shutdown', 'close_outbox'])
  assert.deepEqual(rows.at(-1)?.failed, []); assert.equal(rows.at(-1)?.firstFailure, null)
  const snapshot = f.recorder.snapshot()
  assert.equal(snapshot.timeline.length, 6); assert.equal(snapshot.timeline[0]?.state, 'prepare_reads')
  assert.equal(Object.hasOwn(snapshot, 'shutdown'), false); assert.doesNotMatch(JSON.stringify(snapshot), /musicbridge.shutdown-stage|cleanupFailures|firstFailure/u)
})

test('退出阶段私有旁注：held原Promise保pending且重复Quit不重入，真实settle后才记completed', async t => {
  const f = shutdownTraceFixture(); let release!: () => void, ownerCalls = 0, readCalls = 0
  const held = new Promise<void>(resolve => { release = resolve })
  const coordinator = tracedShutdown(f.recorder, [{ steps: [
    ['prepare_reads', () => { readCalls++; return held }], ['prepare_normalizer', () => { f.advance(25) }],
  ] }, { steps: [['owner_shutdown', () => { ownerCalls++ }]] }])
  const flight = coordinator.request()!
  t.after(async () => { release(); await Promise.allSettled([flight]) })
  await shutdownTick()
  assert.equal(coordinator.pending, true); assert.equal(coordinator.confirmed, false); assert.equal(coordinator.request(), undefined)
  assert.equal(readCalls, 1); assert.equal(ownerCalls, 0)
  const waiting = f.rows().at(-1)!
  assert.deepEqual(waiting.pending, ['prepare_reads']); assert.deepEqual(waiting.completed, ['prepare_normalizer']); assert.deepEqual(waiting.failed, [])
  assert.equal(f.rows().some(row => row.phase === 'prepare_reads' && row.status === 'completed'), false)
  f.advance(75); release(); await flight
  assert.equal(coordinator.confirmed, true); assert.equal(ownerCalls, 1); assert.equal(readCalls, 1)
  assert.equal(f.rows().find(row => row.phase === 'prepare_reads' && row.status === 'completed')?.elapsedMs, 100)
  assert.deepEqual(f.rows().at(-1)?.pending, [])
})

test('退出阶段私有旁注：准备首错与后续cleanup分别保留，Core关闭拒绝仍可取证且不假成功', async t => {
  const f = shutdownTraceFixture(), first = new Error('禁止进入日志的原原因'), cleanup = new Error('禁止进入日志的清理原因'), unavailable = new Error('禁止进入日志的Core原因')
  let getters = 0, release!: () => void, joins = 0, gated = 0, retry = false
  Object.defineProperty(first, 'code', { get() { getters++; throw new Error('不能读业务错误getter') } })
  const held = new Promise<void>(resolve => { release = resolve }), codes = new Map<unknown, string>([[first, 'CHANGED'], [cleanup, 'TIMEOUT'], [unavailable, 'NOT_READY']])
  const coordinator = tracedShutdown(f.recorder, [{ steps: [
    ['prepare_reads', () => { f.advance(3); if (!retry) throw first }], ['prepare_normalizer', async () => { await held; f.advance(7); if (!retry) throw cleanup }],
  ] }, { steps: [['owner_shutdown', () => { f.advance(5); throw unavailable }]] },
  { steps: [['join_readers', () => { joins++ }]] }, { requiresPreviousSuccess: true, steps: [['close_management', () => { gated++ }]] }], codes)
  const flight = coordinator.request()!, rejected = assert.rejects(flight, error => error === first)
  t.after(async () => { release(); await Promise.allSettled([flight, rejected]) })
  await shutdownTick(); release(); await rejected
  assert.equal(coordinator.confirmed, false); assert.equal(coordinator.firstFailure?.reason, first); assert.equal(joins, 1); assert.equal(gated, 0); assert.equal(getters, 0)
  // 对应原Main catch再次保留首错、再记录总未确认；不能用cleanup覆盖首因。
  f.recorder.recordLifecycle('local_workbench_shutdown_failure', 'error', { state: 'prepare_reads', code: 'CHANGED' })
  f.recorder.recordLifecycle('local_workbench_shutdown_not_verified', 'error', { code: 'CHANGED' })
  const rows = f.rows(), tail = rows.at(-1)!
  assert.equal(tail.phase, null); assert.equal(tail.status, 'failed'); assert.equal(tail.elapsedMs, 15)
  assert.deepEqual(tail.firstFailure, { phase: 'prepare_reads', code: 'CHANGED' })
  assert.deepEqual(tail.cleanupFailures, [{ phase: 'prepare_normalizer', code: 'TIMEOUT' }, { phase: 'owner_shutdown', code: 'NOT_READY' }])
  assert.deepEqual(tail.failed, ['prepare_reads', 'prepare_normalizer', 'owner_shutdown']); assert.deepEqual(tail.completed, ['join_readers']); assert.deepEqual(tail.pending, [])
  assert.equal(rows.filter(row => row.failureKind === 'first').every(row => row.phase === 'prepare_reads' && row.code === 'CHANGED'), true)
  assert.equal(rows.filter(row => row.failureKind === 'cleanup').length, 2)
  assert.doesNotMatch(f.lines.join(''), /禁止进入日志|原原因|清理原因|Core原因/u)
  retry = true
  await assert.rejects(coordinator.request()!, error => error === first)
  f.recorder.recordLifecycle('local_workbench_shutdown_failure', 'error', { state: 'prepare_reads', code: 'CHANGED' })
  f.recorder.recordLifecycle('local_workbench_shutdown_not_verified', 'error', { code: 'CHANGED' })
  const retried = f.rows().at(-1)!
  assert.deepEqual(retried.completed, ['prepare_reads', 'prepare_normalizer', 'join_readers'])
  assert.deepEqual(retried.failed, ['owner_shutdown']); assert.deepEqual(retried.firstFailure, tail.firstFailure)
  assert.deepEqual(retried.cleanupFailures, tail.cleanupFailures); assert.equal(joins, 1); assert.equal(gated, 0)
})

test('退出阶段私有旁注：未知phase/code/event与敏感额外字段整条拒绝，getter和Proxy不执行', () => {
  const f = shutdownTraceFixture(); let getters = 0, traps = 0
  const send = (event: string, level: 'info' | 'warn' | 'error', value: unknown) => f.recorder.recordLifecycle(event, level, value as { state?: string; code?: string })
  const accessor = Object.defineProperty({}, 'state', { enumerable: true, get() { getters++; return 'prepare_reads' } })
  const hidden = Object.defineProperty({}, 'state', { value: 'prepare_reads', enumerable: false })
  const proxy = new Proxy({}, { ownKeys() { traps++; return [] }, getPrototypeOf() { traps++; return Object.prototype } })
  const revoked = Proxy.revocable({}, {}); revoked.revoke()
  for (const value of [null, [], accessor, hidden, proxy, revoked.proxy, Object.create({ state: 'prepare_reads' }),
    { state: 'unknown' }, { state: 'prepare_reads', message: 'https://example.invalid/private' }, { state: 'prepare_reads', [Symbol('secret')]: true },
    { state: 'prepare_reads', code: 'CHANGED' }]) send('local_workbench_shutdown_phase_start', 'info', value)
  send('local_workbench_shutdown_failure', 'error', { state: 'owner_shutdown', code: 'SQLITE_UNKNOWN', path: '/合成私密位置' })
  send('local_workbench_shutdown_failure', 'error', { state: 'owner_shutdown', code: 'UNKNOWN_CODE' })
  send('local_workbench_shutdown_failure', 'error', Object.defineProperty({ state: 'owner_shutdown' }, 'code', { enumerable: true, get() { getters++; return 'NOT_READY' } }))
  send('local_workbench_shutdown_not_verified', 'error', { state: 'owner_shutdown', code: 'NOT_READY' })
  send('local_workbench_shutdown_phase_start', 'error', { state: 'owner_shutdown' })
  send('local_workbench_shutdown_unknown', 'info', { state: 'owner_shutdown' })
  assert.equal(getters, 0); assert.equal(traps, 0); assert.deepEqual(f.lines, []); assert.deepEqual(f.recorder.snapshot().timeline, [])
  send('local_workbench_shutdown_phase_start', 'info', Object.assign(Object.create(null), { state: 'owner_shutdown' }))
  send('local_workbench_shutdown_failure', 'error', { state: 'owner_shutdown', code: 'NOT_READY' })
  assert.equal(f.rows().length, 2); assert.equal(f.rows().at(-1)?.code, 'NOT_READY')
})

test('退出阶段私有旁注：sink或clock拒绝不改变原关闭结果与公开诊断', async () => {
  for (const fault of ['sink', 'clock'] as const) {
    let calls = 0
    const recorder = new MainDiagnosticRecorder(200, {
      sink() { throw new Error('受控日志sink不可用') }, now() { if (fault === 'clock') throw new Error('受控clock不可用'); return 0 },
      utcNow: () => Date.parse('2026-10-15T07:00:00.000Z'),
    })
    const coordinator = tracedShutdown(recorder, [{ steps: [['owner_shutdown', () => { calls++ }]] }])
    await coordinator.request(); assert.equal(coordinator.confirmed, true); assert.equal(calls, 1)
    assert.deepEqual(recorder.snapshot().timeline.map(row => row.event), ['local_workbench_shutdown_phase_start', 'local_workbench_shutdown_phase_settled'])
  }
})

test('退出阶段私有旁注：默认同步写真实EBADF仍保原coordinator确认与公开记录', async () => {
  const stdout = await open('/dev/null', 'r')
  try {
    assert.throws(() => writeSync(stdout.fd, '受控只读FD探针\n'), { code: 'EBADF' })
    let calls = 0
    // 不注入sink，实际默认writeSync必须在同一只读FD上失败并被旁注边界隔离。
    const recorder = new MainDiagnosticRecorder(200, { stdoutFd: stdout.fd, now: () => 0,
      utcNow: () => Date.parse('2026-10-15T07:00:00.000Z') })
    const coordinator = tracedShutdown(recorder, [{ steps: [['owner_shutdown', () => { calls++ }]] }])
    assert.equal(await coordinator.request(), undefined)
    assert.equal(coordinator.confirmed, true); assert.equal(coordinator.pending, false); assert.equal(coordinator.firstFailure, undefined); assert.equal(calls, 1)
    assert.deepEqual(recorder.snapshot().timeline.map(row => ({ event: row.event, state: row.state })), [
      { event: 'local_workbench_shutdown_phase_start', state: 'owner_shutdown' },
      { event: 'local_workbench_shutdown_phase_settled', state: 'owner_shutdown' },
    ])
  } finally { await stdout.close() }
})
