import assert from 'node:assert/strict'
import test from 'node:test'
import * as dto from '@music-bridge/contracts'
import { isLocalAlbumOwnerReadRequest, isLocalAlbumOwnerReadResult } from '../src/collection/local-album-browser/owner-protocol.js'
import { isLocalAlbumMainRequest, isLocalAlbumMainResponse } from '../src/collection/local-album-browser/main-protocol.js'

// 新读取明确opt-in；旧专辑DTO和iOS读链不能被顺手增加字段或放松闭集。
const id = (n: number) => `55555555-5555-4555-8555-${String(n).padStart(12, '0')}`
const command = 'localAlbum.queryVersioned' as dto.LocalAlbumCommand
const query: dto.LocalAlbumQuery = { query: '', rootId: id(1), filter: 'all', offset: 0, limit: 100 }
const revision = 'a'.repeat(64)
function page(request = query): dto.LocalAlbumPage {
  const total = 101, items: dto.LocalAlbumSummary[] = Array.from({ length: Math.min(request.limit, Math.max(0, total - request.offset)) }, (_, index) => ({
    id: `synthetic-progressive-album-${request.offset + index}`, rootId: id(1), kind: 'source-directory', editionId: null,
    title: '合成专辑', artists: ['合成作者'], year: null, versionLabel: null, trackCount: 10, representativeTrackId: id(100 + request.offset + index),
    revision: '1', artworkAvailable: false, artworkState: 'unknown', statuses: [],
  }))
  const counts = Object.fromEntries(['all', ...dto.LOCAL_ALBUM_STATUSES].map(filter => [filter, filter === 'all' ? total : 0])) as dto.LocalAlbumFilterCounts
  return { ...request, items, counts, total, hasMore: request.offset + items.length < total }
}
const request = (payload = query) => ({ command, payload }) as Parameters<typeof isLocalAlbumOwnerReadResult>[1]
const versioned = () => ({ revision, page: page() })

test('版本化专辑页是显式只读命令，旧普通分页合同保持原样', () => {
  assert.ok(dto.isLocalAlbumCommand(command))
  assert.ok(dto.isLocalAlbumCommandPayload(command, query))
  assert.ok(isLocalAlbumOwnerReadRequest(request()))
  assert.ok(dto.isLocalAlbumPage(page(), query))
  assert.equal(dto.isLocalAlbumPage({ ...page(), revision }, query), false, '旧页保持闭集，不把修订塞进旧响应')
  assert.equal(dto.isLocalAlbumCommandResult('localAlbum.query', versioned()), false)
})

test('版本化查询只允许1到100，旧只读查询的200上限不因桌面新功能改变', () => {
  for (const limit of [1, 50, 100]) assert.ok(dto.isLocalAlbumCommandPayload(command, { ...query, limit }))
  for (const limit of [0, 101, 200, 201, -1, 1.5, NaN, Infinity]) assert.equal(dto.isLocalAlbumCommandPayload(command, { ...query, limit }), false)
  assert.ok(dto.isLocalAlbumCommandPayload('localAlbum.query', { ...query, limit: 200 }))
  for (const field of ['path', 'sourceGrant', 'purpose', 'cursor', 'execute', 'datasetId']) assert.equal(dto.isLocalAlbumCommandPayload(command, { ...query, [field]: 'synthetic-only' }), false)
})

test('版本化响应由同一原请求重新验证页身份，不只验证自洽响应', () => {
  assert.ok(dto.isLocalAlbumCommandResult(command, versioned()))
  assert.ok(isLocalAlbumOwnerReadResult(versioned(), request()))
  for (const change of [{ query: '另一个查询' }, { rootId: id(2) }, { filter: 'missing-artwork' as const }, { offset: 100 }, { limit: 50 }]) {
    assert.equal(isLocalAlbumOwnerReadResult(versioned(), request({ ...query, ...change })), false)
  }
  const invalid = versioned(); invalid.page.items = [...invalid.page.items.slice(0, -1), invalid.page.items[0]!]
  assert.equal(isLocalAlbumOwnerReadResult(invalid, request()), false)
})

test('版本化Main信封仍绑定原UUID、dataset、command、页范围与成功退出分支', () => {
  const original = { version: 1, type: 'local-album-main-request', id: id(3), datasetId: id(4), request: request() }
  const result = { version: 1, type: 'local-album-main-response', id: id(3), datasetId: id(4), command, ok: true, result: versioned() }
  assert.ok(isLocalAlbumMainRequest(original))
  assert.ok(isLocalAlbumMainResponse(result, original as Parameters<typeof isLocalAlbumMainResponse>[1]))
  for (const change of [{ id: id(5) }, { datasetId: id(6) }, { command: 'localAlbum.query' }, { result: page() }]) {
    assert.equal(isLocalAlbumMainResponse({ ...result, ...change }, original as Parameters<typeof isLocalAlbumMainResponse>[1]), false)
  }
  for (const unknown of ['localAlbum.queryVersioned.write', 'localAlbum.execute', 'localAlbum.materializeQueue']) {
    assert.equal(isLocalAlbumMainRequest({ ...original, request: { ...request(), command: unknown } }), false)
  }
})

test('新修订只接收固定摘要，不接收路径、任意体或无界标签', () => {
  for (const invalid of ['', 'a', 'a'.repeat(63), 'a'.repeat(65), 'A'.repeat(64), '/synthetic/private', null, 1, {}, []]) {
    assert.equal(dto.isLocalAlbumCommandResult(command, { revision: invalid, page: page() }), false)
  }
  for (const extra of ['path', 'grant', 'ticket', 'queue', 'author', 'execute']) assert.equal(dto.isLocalAlbumCommandResult(command, { ...versioned(), [extra]: 'synthetic-only' }), false)
})

test('新请求/响应的getter、隐藏字段和稀疏页一律拒绝且不求值getter', () => {
  let reads = 0
  const payload = Object.defineProperty({ ...query }, 'limit', { enumerable: true, get() { reads++; return 100 } })
  assert.equal(dto.isLocalAlbumCommandPayload(command, payload), false)
  const rootAccessor = Object.defineProperty({ revision }, 'page', { enumerable: true, get() { reads++; return page() } })
  const nestedAccessor = { revision, page: Object.defineProperty(page(), 'query', { enumerable: true, get() { reads++; return '' } }) }
  for (const value of [rootAccessor, nestedAccessor, Object.defineProperty(versioned(), 'hidden', { value: 'synthetic-only' })]) {
    assert.equal(dto.isLocalAlbumCommandResult(command, value), false)
  }
  const sparse = versioned(); delete (sparse.page.items as dto.LocalAlbumSummary[])[0]
  assert.equal(dto.isLocalAlbumCommandResult(command, sparse), false)
  assert.equal(reads, 0)
})
