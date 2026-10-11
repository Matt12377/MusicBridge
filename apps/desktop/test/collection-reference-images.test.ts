import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import type { CanonicalReference, CollectionDescriptor, ReferenceCatalogPublicApi } from '@music-bridge/contracts'
import { loadPublishedReferenceImages, loadHistoricalCassetteCatalog, loadHistoricalCassetteCatalogs, referenceImagesForModel, type PublishedCassetteReference } from '../src/renderer/src/components/collection/reference-images.js'

const model: CollectionDescriptor = { brand: 'TDK', name: 'SA-X', edition: '', year: null, format: 'cassette', tapeType: 'II', identification: 'partial' }
const reference = (edition: string, name = 'SA-X'): CanonicalReference => ({
  referenceId: `tdk-${name}-${edition}`, bookId: 'test-book', brand: 'TDK', model: name, series: '',
  edition, era: edition, iec: 'II', lengths: [60], pages: ['TDK p.020'], notes: '', confidence: 'high',
  image: { kind: 'reference', image: { dataUrl: 'data:image/jpeg;base64,/9j/2Q==', width: 1, height: 1 }, caption: '书籍参考' },
})

test('同型号参考候选保留多个版次，不把 SA 当 SA-X，也不改变库存', () => {
  const before = structuredClone(model)
  const result = referenceImagesForModel(model, [reference('1990'), reference('1988'), reference('1988', 'SA')])
  assert.deepEqual(result.map(x => x.edition), ['1988', '1990'])
  assert.deepEqual(model, before)
})

test('明确年份或版次不匹配时不拿相似图片补位', () => {
  const rows = [reference('1988'), reference('1990')]
  assert.deepEqual(referenceImagesForModel({ ...model, year: 1991 }, rows), [])
  assert.equal(referenceImagesForModel({ ...model, edition: '1990' }, rows)[0]?.edition, '1990')
  assert.deepEqual(referenceImagesForModel({ ...model, tapeType: 'IV' }, rows), [])
  assert.deepEqual(referenceImagesForModel(model, [{ ...rows[0]!, image: { kind: 'none' } }]), [])
})

test('书中图名允许空格大小写差异，不接受缺品牌的泛匹配', () => {
  assert.equal(referenceImagesForModel({ ...model, brand: 'tdk', name: 'sa x' }, [reference('1988')]).length, 1)
  assert.deepEqual(referenceImagesForModel({ ...model, brand: '' }, [reference('1988')]), [])
})

test('只使用资料中明确登记的参考图别名，长度和颜色后缀不自动删除', () => {
  const original = reference('1988')
  const aliased = { ...original, imageAliases: [{ brand: 'TDK', model: 'SA-X60', reason: '核对型号与长度后登记' }] }
  const inventory = { ...model, name: 'SA-X60' }
  assert.equal(referenceImagesForModel(inventory, [aliased]).length, 1)
  assert.equal(referenceImagesForModel(inventory, [original]).length, 0)
  assert.equal(referenceImagesForModel({ ...inventory, brand: '其他品牌' }, [aliased]).length, 0)
  assert.equal(referenceImagesForModel({ ...model, name: 'SA-X(red)' }, [aliased]).length, 0)
  assert.equal(referenceImagesForModel({ ...inventory, tapeType: 'IV' }, [aliased]).length, 0)
  assert.equal(referenceImagesForModel({ ...inventory, year: 1990 }, [aliased]).length, 0)
  assert.equal(inventory.name, 'SA-X60')
})

test('收藏墙在实物照片缺席时显示带来源的参考候选，详情保留全部版次', async () => {
  const wall = await readFile(new URL('../src/renderer/src/components/collection/CollectionView.vue', import.meta.url), 'utf8')
  const detail = await readFile(new URL('../src/renderer/src/components/collection/CollectionModelDetail.vue', import.meta.url), 'utf8')
  assert.ok(wall.indexOf('v-if="model.featuredPhoto"') < wall.indexOf('v-else-if="referenceCandidates(model).length"'))
  assert.match(wall, /书籍参考 · 版次未核/)
  assert.match(detail, /v-for="reference in referenceCandidates"/)
  assert.match(detail, /不代表实物版次已确认/)
})

test('参考图只读取每本书的当前发布版本，同书多个来源不重复读取', async () => {
  const calls: string[] = []
  const api = {
    listReferenceSources: async () => ({ total: 2, items: [{ bookId: 'book' }, { bookId: 'book' }] }),
    getCatalogHistory: async () => { calls.push('history'); return { currentRevisionId: 'current' } },
    getCatalogRevision: async ({ id }: { id: string }) => { calls.push(id); return { revision: { items: [reference('1990'), { ...reference('1988'), image: { kind: 'none' } }] } } },
  } as unknown as ReferenceCatalogPublicApi
  assert.deepEqual((await loadPublishedReferenceImages(api)).map(item => item.edition), ['1990'])
  assert.deepEqual(calls, ['history', 'current'])
})

test('参考来源超出加载预算或读取失败时不伪装为空目录', async () => {
  const api = { listReferenceSources: async () => ({ total: 26, items: [] }) } as unknown as ReferenceCatalogPublicApi
  await assert.rejects(loadPublishedReferenceImages(api), /参考来源较多/)
  api.listReferenceSources = async () => { throw new Error('读取失败') }
  await assert.rejects(loadPublishedReferenceImages(api), /读取失败/)
})

test('历史目录严格按原revision和来源身份读取，旧关联不从当前目录回填', async () => {
  const old = reference('1988'), calls: string[] = []
  const source = { id: 'old-source', bookId: old.bookId, packHash: 'a'.repeat(64) }
  const detail = { revision: { id: 'old-revision', bookId: old.bookId, sourceId: source.id, packHash: source.packHash,
    sequence: 1, previousRevisionId: null, items: [old] }, currentEntries: [{ referenceId: old.referenceId, state: 'owned', stockCount: 3, matches: [] }] }
  const api = { getCatalogRevision: async ({ id }: { id: string }) => { calls.push(id); return detail },
    getReferenceSource: async ({ id }: { id: string }) => { calls.push(id); return { source } } } as unknown as ReferenceCatalogPublicApi
  const rows = await loadHistoricalCassetteCatalog(api, { bookId: old.bookId, revisionId: detail.revision.id })
  assert.deepEqual(calls, ['old-revision', 'old-source']); assert.equal(rows[0]?.historical, true)
  assert.equal(rows[0]?.current?.stockCount, 3); assert.equal(rows[0]?.reference.referenceId, old.referenceId)
  for (const wrong of [{ id: 'wrong' }, { bookId: 'wrong' }]) {
    api.getCatalogRevision = async () => ({ ...detail, revision: { ...detail.revision, ...wrong } }) as never
    await assert.rejects(loadHistoricalCassetteCatalog(api, { bookId: old.bookId, revisionId: detail.revision.id }), /修订身份/u)
  }
  api.getCatalogRevision = async () => detail as never
  for (const wrong of [{ id: 'wrong' }, { bookId: 'wrong' }, { packHash: 'b'.repeat(64) }]) {
    api.getReferenceSource = async () => ({ source: { ...source, ...wrong } }) as never
    await assert.rejects(loadHistoricalCassetteCatalog(api, { bookId: old.bookId, revisionId: detail.revision.id }), /来源身份/u)
  }
})

test('历史链循环、错序或缺根明确拒绝，合法链按最近版次顺序保留旧编号', async () => {
  const old = reference('1988'), current: PublishedCassetteReference[] = [{ reference: reference('1990'), source: {} as never,
    revisionId: 'current', revisionSequence: 3, previousRevisionId: 'old-2' }]
  let previous: string | null = 'old-1', sequence = 2
  const api = { getCatalogRevision: async ({ id }: { id: string }) => ({ revision: { id, bookId: old.bookId,
    sourceId: 'source', packHash: 'a'.repeat(64), sequence: id === 'old-2' ? sequence : 1,
    previousRevisionId: id === 'old-2' ? previous : null, items: [old] }, currentEntries: [] }),
    getReferenceSource: async () => ({ source: { id: 'source', bookId: old.bookId, packHash: 'a'.repeat(64) } }) } as unknown as ReferenceCatalogPublicApi
  assert.deepEqual((await loadHistoricalCassetteCatalogs(api, current)).map(value => value.revisionId), ['old-2', 'old-1'])
  previous = 'current'; await assert.rejects(loadHistoricalCassetteCatalogs(api, current), /循环/u)
  previous = null; await assert.rejects(loadHistoricalCassetteCatalogs(api, current), /原始版次/u)
  previous = 'old-1'; sequence = 8; await assert.rejects(loadHistoricalCassetteCatalogs(api, current), /版次链/u)
  await assert.rejects(loadHistoricalCassetteCatalogs(api, [{ ...current[0]!, previousRevisionId: null }]), /原始版次/u)
  assert.deepEqual(await loadHistoricalCassetteCatalogs(api, [{ ...current[0]!, revisionSequence: 1, previousRevisionId: null }]), [])
})
