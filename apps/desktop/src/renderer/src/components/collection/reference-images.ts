import type { CanonicalReference, CatalogSnapshotEntry, CollectionDescriptor, ReferenceCatalogPublicApi, ReferenceSourceVersion } from '@music-bridge/contracts'
import { cassetteAssetUrl } from '../../../../shared/cassette-catalog'

export type IllustratedReference = CanonicalReference & (
  { image: Extract<CanonicalReference['image'], { kind: 'reference' }> }
  | { archive: { sha256: string; primaryAssetId: string } }
)
export interface PublishedCassetteReference {
  reference: CanonicalReference
  source: ReferenceSourceVersion
  revisionId: string
  revisionSequence: number
  current?: CatalogSnapshotEntry
}
export interface ReferenceCatalogSelection { sourceId: string; referenceId: string; step: 'review' }
export interface CassetteCatalogModelGroup {
  key: string; brand: string; model: string; series: string; iec: CanonicalReference['iec']; items: PublishedCassetteReference[]
}
export interface CassetteCatalogBrandGroup { brand: string; referenceCount: number; models: CassetteCatalogModelGroup[] }
export type CollectionReferencePrefill = Pick<CollectionDescriptor, 'brand' | 'name' | 'format' | 'tapeType'>
/** 来源摘要分页总预算；达到预算前必须读全，不能把部分来源当完整目录。 */
export const MAX_PUBLISHED_CASSETTE_SOURCES = 1_000
const normalize = (value: string): string => value.normalize('NFKC').toUpperCase().replace(/[\s\-.'’]/gu, '')

export function referenceImageUrl(reference: CanonicalReference): string | null {
  if (reference.archive?.primaryAssetId) {
    try { return cassetteAssetUrl(reference.archive.sha256, reference.archive.primaryAssetId) }
    catch { return null }
  }
  return reference.image.kind === 'reference' ? reference.image.image.dataUrl : null
}

export function referenceImageCaption(reference: CanonicalReference): string {
  return reference.archive?.primaryAssetId ? '原书资料参考图' : reference.image.kind === 'reference' ? reference.image.caption : '主图尚缺'
}

export function hasReferenceImage(reference: CanonicalReference): reference is IllustratedReference {
  return referenceImageUrl(reference) !== null
}

export function collectionPrefillForReference(reference: CanonicalReference): CollectionReferencePrefill {
  return { brand: reference.brand, name: reference.model, format: reference.iec === 'dat' ? 'dat' : 'cassette', tapeType: reference.iec }
}

/** 仅提供同型号图像候选，不写目录匹配、实物照片或库存认定。 */
export function referenceImagesForModel(model: CollectionDescriptor, references: readonly CanonicalReference[]): IllustratedReference[] {
  if (!model.brand.trim() || !model.name.trim()) return []
  return references.filter((entry): entry is IllustratedReference =>
    hasReferenceImage(entry)
    && [{ brand: entry.brand, model: entry.model }, ...(entry.imageAliases ?? [])].some(name =>
      normalize(name.brand) === normalize(model.brand) && normalize(name.model) === normalize(model.name))
    && (model.tapeType === 'unknown' || entry.iec === model.tapeType)
    && (model.format === 'dat' ? entry.iec === 'dat' : entry.iec !== 'dat')
    && (!model.edition || normalize(entry.edition) === normalize(model.edition))
    && (model.year === null || entry.edition === String(model.year) || entry.era === String(model.year)),
  ).sort((a, b) => a.edition.localeCompare(b.edition) || a.referenceId.localeCompare(b.referenceId))
}

export async function loadPublishedReferenceImages(api: ReferenceCatalogPublicApi): Promise<readonly CanonicalReference[]> {
  const sources = await api.listReferenceSources({ offset: 0, limit: 25 })
  if (sources.total > 25) throw new Error('参考来源较多，请先在参考目录核对当前版本。')
  const result: CanonicalReference[] = []
  for (const bookId of new Set(sources.items.map(source => source.bookId))) {
    const history = await api.getCatalogHistory({ bookId, offset: 0, limit: 1 })
    if (!history.currentRevisionId) continue
    const current = await api.getCatalogRevision({ id: history.currentRevisionId })
    result.push(...current.revision.items.filter(hasReferenceImage))
  }
  return result
}

/** 完整参考目录包括缺图条目；拥有事实仅来自当前版次明确记录的库存关联。 */
export async function loadPublishedCassetteCatalog(api: ReferenceCatalogPublicApi): Promise<readonly PublishedCassetteReference[]> {
  const sources: ReferenceSourceVersion[] = [], seenSourceIds = new Set<string>()
  const limit = 25
  let total: number | undefined
  do {
    const offset = sources.length, page = await api.listReferenceSources({ offset, limit })
    if (page.total > MAX_PUBLISHED_CASSETTE_SOURCES) throw new Error(`参考来源超过读取总预算（最多 ${MAX_PUBLISHED_CASSETTE_SOURCES} 个），本次未返回部分目录。`)
    if (!Number.isSafeInteger(page.total) || page.total < 0 || page.offset !== offset || page.limit !== limit
      || total !== undefined && page.total !== total) throw new Error('参考来源分页或总数已变化，请重新读取完整目录。')
    total = page.total
    if (page.items.length !== Math.min(limit, total - offset)
      || page.items.some(source => seenSourceIds.has(source.id))
      || new Set(page.items.map(source => source.id)).size !== page.items.length) throw new Error('参考来源分页不完整或重复，本次未返回部分目录。')
    sources.push(...page.items)
    page.items.forEach(source => seenSourceIds.add(source.id))
  } while (sources.length < total)
  const result: PublishedCassetteReference[] = []
  for (const bookId of new Set(sources.map(source => source.bookId))) {
    const history = await api.getCatalogHistory({ bookId, offset: 0, limit: 1 })
    if (!history.currentRevisionId) continue
    const current = await api.getCatalogRevision({ id: history.currentRevisionId })
    if (current.revision.id !== history.currentRevisionId || current.revision.bookId !== bookId) throw new Error('参考目录版次身份已变化，请重新读取。')
    const source = sources.find(item => item.id === current.revision.sourceId)
      ?? (await api.getReferenceSource({ id: current.revision.sourceId })).source
    if (source.id !== current.revision.sourceId || source.bookId !== bookId) throw new Error('参考资料来源身份不一致，请重新读取。')
    const entries = new Map(current.currentEntries.map(entry => [entry.referenceId, entry]))
    result.push(...current.revision.items.map(reference => ({ reference, source, revisionId: current.revision.id,
      revisionSequence: current.revision.sequence, current: entries.get(reference.referenceId) })))
  }
  return result.sort((a, b) => a.reference.brand.localeCompare(b.reference.brand, 'zh-CN')
    || a.reference.model.localeCompare(b.reference.model, 'zh-CN', { numeric: true })
    || a.reference.edition.localeCompare(b.reference.edition, 'zh-CN', { numeric: true })
    || a.reference.referenceId.localeCompare(b.reference.referenceId))
}

export function filterCassetteCatalog(items: readonly PublishedCassetteReference[], filter: { query: string; brand: string; iec: string }): PublishedCassetteReference[] {
  const terms = filter.query.normalize('NFKC').trim().toLocaleLowerCase().split(/\s+/u).filter(Boolean)
  return items.filter(({ reference: item }) => (!filter.brand || item.brand === filter.brand)
    && (!filter.iec || item.iec === filter.iec)
    && terms.every(term => [item.referenceId, item.brand, item.model, item.series, item.edition, item.era ?? '', item.notes, ...item.pages]
      .join(' ').normalize('NFKC').toLocaleLowerCase().includes(term)))
}

export const cassetteModelGroupKey = (reference: CanonicalReference): string => JSON.stringify([reference.brand, reference.model, reference.series, reference.iec])

/** 仅为品牌→型号→原书年份/版次导航分组，不合并条目或推断实体身份。 */
export function groupCassetteCatalog(items: readonly PublishedCassetteReference[]): CassetteCatalogBrandGroup[] {
  const brands = new Map<string, Map<string, CassetteCatalogModelGroup>>()
  for (const item of items) {
    const reference = item.reference, key = cassetteModelGroupKey(reference)
    let models = brands.get(reference.brand)
    if (!models) { models = new Map(); brands.set(reference.brand, models) }
    let model = models.get(key)
    if (!model) {
      model = { key, brand: reference.brand, model: reference.model, series: reference.series, iec: reference.iec, items: [] }
      models.set(key, model)
    }
    model.items.push(item)
  }
  return [...brands.entries()].map(([brand, groups]) => {
    const models = [...groups.values()].sort((a, b) => a.model.localeCompare(b.model, 'zh-CN', { numeric: true })
      || a.series.localeCompare(b.series, 'zh-CN') || a.iec.localeCompare(b.iec))
    for (const model of models) model.items.sort((a, b) => Number(!a.reference.era && !a.reference.edition) - Number(!b.reference.era && !b.reference.edition)
      || (a.reference.era ?? '').localeCompare(b.reference.era ?? '', 'zh-CN', { numeric: true })
      || a.reference.edition.localeCompare(b.reference.edition, 'zh-CN', { numeric: true })
      || a.reference.referenceId.localeCompare(b.reference.referenceId))
    return { brand, referenceCount: models.reduce((count, model) => count + model.items.length, 0), models }
  }).sort((a, b) => a.brand.localeCompare(b.brand, 'zh-CN'))
}
