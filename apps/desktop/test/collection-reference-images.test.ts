import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import type { CanonicalReference, CollectionDescriptor, ReferenceCatalogPublicApi } from '@music-bridge/contracts'
import { loadPublishedReferenceImages, referenceImagesForModel } from '../src/renderer/src/components/collection/reference-images.js'

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
