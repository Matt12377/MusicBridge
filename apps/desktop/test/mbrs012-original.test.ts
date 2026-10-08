import assert from 'node:assert/strict'
import test from 'node:test'
import { captureSourceWriteOriginal, SourceWriteOriginalError } from '../src/main/source-write-original.js'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import type { LocalArtworkContext, LocalArtworkTarget, LocalArtworkCandidate, AttachLocalSourceWritesOriginal } from '@music-bridge/contracts'
import { installLocalArtworkHandlers } from '../src/main/local-artwork-ipc.js'
import { datasetId, id } from './mbrs012-fixture.js'

test('012原选图捕获实际PNG bytes并绑定唯一候选；留存失败仍返回MB候选', async () => {
  const bytes = await readFile(new URL('../../../packages/bridge-core/test/fixtures/mbrs012-source/owned-cover-16.png', import.meta.url)), display = await readFile(new URL('../../../packages/bridge-core/test/fixtures/mbrs012-source/owned-cover-16.jpg', import.meta.url))
  const target: LocalArtworkTarget = { trackId: id(2), editionId: id(3), expectedTrackRevision: '1', expectedEditionRevision: '1', expectedSourceRevision: 'a'.repeat(64) }
  const handlers = new Map<string, (event: object, value?: unknown) => unknown>(), attached: AttachLocalSourceWritesOriginal[] = []
  const view: LocalArtworkContext = { trackId: target.trackId, trackRevision: '1', target, editions: [{ id: target.editionId, title: '自制发行', edition: '', revision: '1' }], selection: null, candidates: [], remoteProvider: 'off-pending-license', sourceFilesWrite: 'OFF', status: 'ready' }
  const control = installLocalArtworkHandlers<object>({ handle: (channel, handler) => { handlers.set(channel, handler) }, requireTrusted: () => {}, eventKey: () => '合成可信窗口', pick: async () => ({ canceled: true, filePaths: [] }),
    decode: () => ({ isEmpty: () => false, getSize: () => ({ width: 16, height: 16 }), resize() { throw new Error('无需缩放') }, toJPEG: () => display }),
    supervisor: { request: async () => ({ datasetId }), requestInternal: async (_command: string, payload: { image: { original: LocalArtworkCandidate['original']; display: LocalArtworkCandidate['display'] }; sourceIdentity: string; sourceLabel: string }) => ({ ...view, candidates: [{ id: id(30), editionId: target.editionId, origin: 'manual', sourceIdentity: payload.sourceIdentity, sourceLabel: payload.sourceLabel, provider: 'local-readonly-v1', license: 'user-supplied', expiresAt: new Date(Date.now() + 600000).toISOString(), original: payload.image.original, display: payload.image.display }] }) } as never,
    attachOriginal: async request => { attached.push(request); throw new Error('合成原图预算不足') },
  })
  try {
    const original = new Uint8Array(bytes), result = await handlers.get('localArtwork:import')!({}, { datasetId, target, bytes: original }) as LocalArtworkContext
    assert.equal(result.candidates.length, 1); assert.equal(attached.length, 1); assert.equal(attached[0]!.candidateId, id(30)); assert.deepEqual(attached[0]!.bytes, original)
    assert.notEqual(attached[0]!.bytes.buffer, original.buffer); assert.equal(attached[0]!.original.sha256, createHash('sha256').update(original).digest('hex')); assert.equal(attached[0]!.original.mime, 'image/png'); assert.equal(result.candidates[0]!.display.mime, 'image/jpeg'); assert.equal(result.sourceFilesWrite, 'OFF')
  } finally { control.close() }
})

test('原图捕获只携带实际视图，后续输入变化不改待留存字节', () => {
  const slab = new Uint8Array(8 * 1024 * 1024), input = slab.subarray(8192, 8200)
  input.set([137, 80, 78, 71, 13, 10, 26, 10])
  const captured = captureSourceWriteOriginal(input)
  assert.equal(captured.byteOffset, 0)
  assert.equal(captured.buffer.byteLength, input.byteLength)
  assert.deepEqual([...captured], [137, 80, 78, 71, 13, 10, 26, 10])
  input.fill(0)
  assert.equal(captured[0], 137)
})

test('原图上限保持四MiB，超限与共享内存不能进入新传输', () => {
  assert.equal(captureSourceWriteOriginal(new Uint8Array(4 * 1024 * 1024)).byteLength, 4 * 1024 * 1024)
  for (const value of [new Uint8Array(4 * 1024 * 1024 + 1), new Uint8Array(3), new Uint8Array(new SharedArrayBuffer(8)), [], new Proxy(new Uint8Array(8), {})]) {
    assert.throws(() => captureSourceWriteOriginal(value), SourceWriteOriginalError)
  }
})

test('输入自定义访问器不被读取，捕获依据原生视图品牌', () => {
  const input = new Uint8Array([1, 2, 3, 4])
  Object.defineProperty(input, 'buffer', { get() { throw new Error('不应访问用户访问器') } })
  Object.defineProperty(input, 'byteLength', { get() { throw new Error('不应访问用户访问器') } })
  assert.deepEqual([...captureSourceWriteOriginal(input)], [1, 2, 3, 4])
})
