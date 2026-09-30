import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'

test('参考目录Main只注册有限读取接口，可信检查与严格DTO先于Core调用', async () => {
  const module = await import('../src/main/reference-catalog-ipc.js').catch(() => ({}))
  assert.ok('installReferenceCatalogReads' in module, '缺少参考目录受限读取入口')
  const install = (module as typeof import('../src/main/reference-catalog-ipc.js')).installReferenceCatalogReads
  const handlers = new Map<string, (event: boolean, value?: unknown) => unknown>(), calls: Array<[string, unknown]> = []
  install({ handle: (channel, handler) => handlers.set(channel, handler), requireTrusted: (trusted: boolean) => { if (!trusted) throw new Error('不可信Renderer') },
    supervisor: { request: (async (command: string, payload: unknown) => { calls.push([command, payload]); return { synthetic: true } }) as never } })
  const invoke = (channel: string, value?: unknown, trusted = true) => Promise.resolve().then(() => handlers.get(channel)!(trusted, value))
  assert.deepEqual([...handlers.keys()].sort(), ['referenceCatalog:sources', 'referenceCatalog:source', 'referenceCatalog:previewSourceZip', 'referenceCatalog:sourceZipReceipts', 'referenceCatalog:history', 'referenceCatalog:revision', 'referenceCatalog:previewRevision', 'referenceCatalog:snapshot'].sort())
  await assert.rejects(invoke('referenceCatalog:sources', { offset: 0, limit: 20 }, false))
  await assert.rejects(invoke('referenceCatalog:sources', { offset: 0, limit: 20, credential: '合成禁止字段' }))
  await assert.rejects(invoke('referenceCatalog:source', { id: '/private/合成' }))
  const id = randomUUID(), zip = { zipBase64: 'UEsDBA==' }, receipts = { sourceId: id, offset: 0, limit: 20 }
  for (const channel of ['referenceCatalog:previewSourceZip', 'referenceCatalog:sourceZipReceipts']) {
    const request = channel.endsWith('previewSourceZip') ? zip : receipts
    await assert.rejects(invoke(channel, request, false))
    for (const extra of [{ absolutePath: '/private/合成' }, { credential: '合成禁止字段' }, { commandId: randomUUID() }])
      await assert.rejects(invoke(channel, { ...request, ...extra }), /INVALID_IPC_REQUEST/u)
  }
  await assert.rejects(invoke('referenceCatalog:previewSourceZip', { zipBase64: '不是Base64' }), /INVALID_IPC_REQUEST/u)
  await assert.rejects(invoke('referenceCatalog:sourceZipReceipts', { ...receipts, limit: 26 }), /INVALID_IPC_REQUEST/u)
  assert.equal(calls.length, 0)
  assert.deepEqual(await invoke('referenceCatalog:sources', { offset: 0, limit: 20 }), { synthetic: true })
  await invoke('referenceCatalog:source', { id })
  await invoke('referenceCatalog:previewSourceZip', zip)
  await invoke('referenceCatalog:sourceZipReceipts', receipts)
  assert.deepEqual(calls, [['referenceCatalog.sources', { offset: 0, limit: 20 }], ['referenceCatalog.source', { id }], ['referenceCatalog.previewSourceZip', zip], ['referenceCatalog.sourceZipReceipts', receipts]])
})
