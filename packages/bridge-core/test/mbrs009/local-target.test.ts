import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { BridgeController } from '../../src/application/bridge-controller.js'
import { StreamGateway } from '../../src/stream/gateway.js'
import { StreamRegistry } from '../../src/stream/registry.js'
import { attachCoreRuntimePort } from '../../src/utility-main.js'
import { adapterFixture, silentLogger, tick } from '../mbrs006/adapter-fixture.js'

test('009只读目标来自原RoonAdapter权威，断连为null，不创建session或播放请求', async t => {
  const f = await adapterFixture(), registry = new StreamRegistry(), gateway = new StreamGateway({ host: '127.0.0.1', port: 0, publicBaseUrl: 'http://127.0.0.1:0', registry, logger: silentLogger })
  const controller = new BridgeController({ roon: f.adapter, registry, gateway, logger: silentLogger, netease: {} as any }); t.after(async () => { await controller.shutdown(); await f.adapter.shutdown() })
  assert.deepEqual(controller.getLocalPlaybackTarget(), { core_id: 'synthetic-core', zone_id: 'synthetic-zone' })
  const copy = controller.getLocalPlaybackTarget()!; copy.core_id = '篡改显示副本'; assert.equal(controller.getLocalPlaybackTarget()?.core_id, 'synthetic-core')
  f.unpair(); await tick(); assert.equal(controller.getLocalPlaybackTarget(), null); assert.equal(f.sessions.length, 0); assert.equal(f.sends.length, 0); assert.equal(f.controls(), 0)
})
test('009Core目标读取先核当前dataset，旧scope不采样权威目标', async () => {
  const datasetId = randomUUID(), responses: any[] = []; let listener!: (event: { data: unknown }) => void, reads = 0
  const port = { on(_event: string, fn: typeof listener) { listener = fn }, start() {}, postMessage(value: unknown) { responses.push(value) } }
  const runtime = { start: async () => {}, datasetOwnerEndpoint: { prepare: async () => ({ datasetId, epoch: randomUUID() }) }, getLocalLibraryPlaybackTarget: () => { reads++; return { core_id: '受控Core', zone_id: '受控Zone' } }, getState: () => ({}) } as any
  await attachCoreRuntimePort(port, runtime)
  const id = randomUUID(); listener({ data: { version: 1, id, command: 'playback.localTarget', payload: {}, expectedDatasetId: randomUUID() } }); await tick(); assert.equal(responses.find(value => value.id === id)?.ok, false); assert.equal(reads, 0)
  const next = randomUUID(); listener({ data: { version: 1, id: next, command: 'playback.localTarget', payload: {}, expectedDatasetId: datasetId } }); await tick(); assert.deepEqual(responses.find(value => value.id === next)?.result, { core_id: '受控Core', zone_id: '受控Zone' }); assert.equal(reads, 1)
})
