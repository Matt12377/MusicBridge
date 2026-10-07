import assert from 'node:assert/strict'
import test from 'node:test'
import * as dto from '@music-bridge/contracts'
import { installLocalLegacyLinksHandlers } from '../../src/main/local-legacy-links-ipc.js'
import { createLocalLegacyLinksClient } from '../../src/preload/local-legacy-links-client.js'
import { createCommandOutboxExecutor } from '../../src/main/command-outbox-executor.js'
import { dataset, fixture, id, physical } from './fixture.js'
const read = (): dto.ReadLocalLegacyLinks => ({ datasetId: dataset, selector: { by: 'legacy', key: physical().key }, state: 'all', cursor: null, limit: 20 })
test('014Main三只读/预览闭集，描述符快照零raw读取，未知保存命令不穿普通channel', async () => {
  const f = fixture(), handlers = new Map<string, (event: { trusted: boolean }, input: unknown) => unknown>(); let calls = 0, rawGets = 0
  installLocalLegacyLinksHandlers({ handle: (name, handler) => handlers.set(name, handler), requireTrusted: (event: { trusted: boolean }) => { if (!event.trusted) throw new Error('不可信窗口') }, supervisor: { request: async (_command: string, request: dto.ReadLocalLegacyLinks) => { calls++; return f.api.readLocalLegacyLinks(request) } } as any })
  const handler = handlers.get('localLegacyLinks:request')!, input = { datasetId: dataset, command: 'localLegacyLinks.read', payload: read() }, proxy = new Proxy(input, { get() { rawGets++; throw new Error('不得读取raw') } })
  assert.deepEqual(await handler({ trusted: true }, proxy), await f.api.readLocalLegacyLinks(read())); assert.equal(rawGets, 0); assert.equal(calls, 1)
  for (const command of ['localLegacyLinks.confirm', 'localLegacyLinks.revoke', 'localLegacyLinks.undo', 'localCatalog.overrideMetadata']) await assert.rejects(async () => handler({ trusted: true }, { ...input, command }))
  const getter = { ...input }; Object.defineProperty(getter, 'payload', { enumerable: true, get() { rawGets++; return read() } }); await assert.rejects(async () => handler({ trusted: true }, getter)); await assert.rejects(async () => handler({ trusted: false }, input)); assert.equal(rawGets, 0); assert.equal(calls, 1)
})
test('014preload公开六facade并捕获原请求，scope错配和错scope回执拒绝', async () => {
  const f = fixture(), invokes: unknown[] = [], client = createLocalLegacyLinksClient({ scope: async () => dataset, invoke: async (_channel, input) => { invokes.push(input); return f.api.readLocalLegacyLinks((input as { payload: dto.ReadLocalLegacyLinks }).payload) }, confirm: f.api.confirmLocalLegacyLink, revoke: f.api.revokeLocalLegacyLink, undo: f.api.undoLocalLegacyLink })
  assert.deepEqual(Object.keys(client), ['readLocalLegacyLinks', 'historyLocalLegacyLinks', 'previewLocalLegacyLink', 'confirmLocalLegacyLink', 'revokeLocalLegacyLink', 'undoLocalLegacyLink']); await client.readLocalLegacyLinks(read()); assert.equal(invokes.length, 1); await assert.rejects(client.readLocalLegacyLinks({ ...read(), datasetId: id(99) })); assert.equal(invokes.length, 1)
  const bad = createLocalLegacyLinksClient({ scope: async () => dataset, invoke: async () => ({ ...await f.api.readLocalLegacyLinks(read()), datasetId: id(99) }), confirm: f.api.confirmLocalLegacyLink, revoke: f.api.revokeLocalLegacyLink, undo: f.api.undoLocalLegacyLink }); await assert.rejects(bad.readLocalLegacyLinks(read()))
})
test('014原outbox保存内层dataset必须在supervisor派发前匹配', async () => {
  let calls = 0; const executor = createCommandOutboxExecutor({ supervisor: { request: async () => { calls++; throw new Error('不应派发') } } as any, pick: async () => { throw new Error('不应打开文件选择') } })
  const commandId = id(50), payload: dto.ExecuteLocalLegacyLink = { datasetId: id(99), commandId, previewId: id(51), expectedPreviewRevision: '1', previewHash: 'a'.repeat(64), contextFingerprint: 'b'.repeat(64), userConfirmed: true }
  await assert.rejects(executor.execute({ datasetId: dataset, commandId, command: 'localLegacyLinks.confirm', payload } as any)); assert.equal(calls, 0)
})
