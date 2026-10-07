import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { installLocalLibraryHandlers } from '../src/main/local-library-ipc.js'
import { createLocalLibraryClient } from '../src/preload/local-library-client.js'
import { CoreIpcError } from '../src/main/core-supervisor.js'

test('009Main/preload有界查询与目标只经固定dataset闭集，写与内部参数零发送', async () => {
  const datasetId = randomUUID(), handlers = new Map<string, (event: { trusted: boolean }, value: any) => unknown>(), calls: any[] = []
  installLocalLibraryHandlers({ handle: (channel, fn) => handlers.set(channel, fn), requireTrusted: (event: { trusted: boolean }) => { if (!event.trusted) throw new Error('不可信窗口') }, supervisor: { request: async (command: string, payload: any, scope: string) => { calls.push({ command, payload, scope }); return command === 'playback.localTarget' ? null : { ...payload, total: 0, hasMore: false, items: [] } }, requestInternal: async () => { throw new Error('不得进入内部观察') } } as any, pick: async () => { throw new Error('查询不得弹picker') } })
  const client = createLocalLibraryClient(async (channel, value) => handlers.get(channel)!({ trusted: true }, value), async () => datasetId, { chooseRoot: async () => null, confirm: async () => { throw 0 }, relink: async () => { throw 0 } })
  await client.queryLocalLibraryTracks({ query: '合成', rootId: null, offset: 0, limit: 100 }); assert.equal(await client.getLocalLibraryPlaybackTarget(), null); assert.equal(calls.length, 2); assert.ok(calls.every(call => call.scope === datasetId))
  const handler = handlers.get('localLibrary:request')!
  for (const command of ['localCatalog.overrideMetadata', 'localCatalog.createEdition', 'localScan.prepareBatch', 'playback.play']) await assert.rejects(async () => handler({ trusted: true }, { datasetId, command, payload: {} }))
  await assert.rejects(async () => handler({ trusted: false }, { datasetId, command: 'playback.localTarget', payload: {} })); await assert.rejects(async () => handler({ trusted: true }, { datasetId, command: 'localCatalog.trackDetail', payload: { trackId: randomUUID(), absolutePath: '/合成禁止路径' } })); assert.equal(calls.length, 2)
})
test('009Main投影Core失败不泄漏私有路径/SDK细节，失败保留音乐库', async () => {
  const handlers = new Map<string, (event: object, value: any) => unknown>()
  installLocalLibraryHandlers({ handle: (channel, fn) => handlers.set(channel, fn), requireTrusted() {}, supervisor: { request: async () => { throw new CoreIpcError('INVENTORY_UNAVAILABLE', '/合成私有/路径 SDK内部session-secret') }, requestInternal: async () => null } as any, pick: async () => ({ canceled: true, filePaths: [] }) })
  await assert.rejects(async () => handlers.get('localLibrary:request')!({}, { datasetId: randomUUID(), command: 'playback.localTarget', payload: {} }), error => error instanceof Error && error.message.includes('现有音乐库保留') && !error.message.includes('session-secret') && !error.message.includes('/合成私有'))
})
