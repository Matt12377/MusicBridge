import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import type { TypedIpcEvent } from '@music-bridge/contracts'
import { shouldRefreshTrayForCoreEvent } from '../src/main/core-supervisor.js'

test('006：实际Main factory进度广播不读取托盘，rollback只影响启动packet请求', async () => {
  const source = await readFile('src/main/index.ts', 'utf8')
  const start = source.indexOf('function createCoreSupervisor('), end = source.indexOf('async function prepareCoreDataDirectory', start)
  assert.ok(start > 0 && end > start)
  for (const rollback of [false, true]) {
    let captured!: { playbackEventProtocol: string | null; onEvent: (event: TypedIpcEvent) => void }
    let trayReads = 0, sent = 0, diagnostics = 0
    const context = {
      CoreSupervisor: class { constructor(options: typeof captured) { captured = options } },
      path: { join: (...parts: string[]) => parts.join('/') }, currentDirectory: '/synthetic',
      process: { env: rollback ? { MUSIC_BRIDGE_COMPACT_PLAYBACK_EVENTS: '0' } : {} },
      coreDataDirectory: '', buildCoreEnvironment: () => ({}), shouldRefreshTrayForCoreEvent,
      mainDiagnostics: { performance: undefined, recordCoreEvent: () => diagnostics++ },
      performanceIpc: { context: () => undefined }, requestTrayRefresh: () => trayReads++,
      mainWindow: { isDestroyed: () => false, webContents: { send: (channel: string) => { assert.equal(channel, 'core:event'); sent++ } } },
    }
    runInNewContext(ts.transpileModule(source.slice(start, end) + '\ncreateCoreSupervisor("/synthetic");', { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context)
    assert.equal(captured.playbackEventProtocol, rollback ? null : 'compact-v1')
    for (let sequence = 1; sequence <= 100; sequence++) captured.onEvent({ version: 1, event: 'playback.progress', payload: { stamp: { coreInstanceId: '00000000-0000-4000-8000-000000000006', generation: 1, sequence, queueRevision: 1, selectedZoneId: null, trackId: null, source: null }, positionMs: sequence } })
    assert.equal(trayReads, 0); assert.equal(sent, 100); assert.equal(diagnostics, 100)
    captured.onEvent({ version: 1, event: 'core.health', payload: { state: { runtime: 'ready', roon: 'disconnected', provider: 'missing', activeStreamCount: 0, activePlaybackPresent: false } } })
    assert.equal(trayReads, 1); assert.equal(sent, 101)
  }
})

test('006：实际Main stream IPC走trusted wrapper与Supervisor专用readonly，不暴露mode setter', async () => {
  const source = await readFile('src/main/index.ts', 'utf8')
  const start = source.indexOf("  registerPerformanceHandler('playback:get-stream-snapshot'"), end = source.indexOf("  registerPerformanceHandler('playback:play'", start)
  assert.ok(start > 0 && end > start)
  let handler!: (event: { trusted: boolean }) => Promise<unknown>, reads = 0
  runInNewContext(ts.transpileModule(source.slice(start, end), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, {
    registerPerformanceHandler: (channel: string, callback: typeof handler) => { assert.equal(channel, 'playback:get-stream-snapshot'); handler = callback },
    invokeCore: async (event: { trusted: boolean }, operation: () => Promise<unknown>) => { if (!event.trusted) throw Error('拒绝来源'); return operation() },
    supervisor: { getPlaybackStreamSnapshot: async () => { reads++; return null } },
  })
  await assert.rejects(handler({ trusted: false }), /拒绝来源/); assert.equal(reads, 0)
  assert.equal(await handler({ trusted: true }), null); assert.equal(reads, 1)
})
