import type { CanonicalReference, CollectionDescriptor, ReferenceCatalogPublicApi } from '@music-bridge/contracts'

export type IllustratedReference = CanonicalReference & { image: Extract<CanonicalReference['image'], { kind: 'reference' }> }
const normalize = (value: string): string => value.normalize('NFKC').toUpperCase().replace(/[\s\-.'’]/gu, '')

/** 仅提供同型号图像候选，不写目录匹配、实物照片或库存认定。 */
export function referenceImagesForModel(model: CollectionDescriptor, references: readonly CanonicalReference[]): IllustratedReference[] {
  if (!model.brand.trim() || !model.name.trim()) return []
  return references.filter((entry): entry is IllustratedReference =>
    entry.image.kind === 'reference'
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
    result.push(...current.revision.items.filter(item => item.image.kind === 'reference'))
  }
  return result
}
