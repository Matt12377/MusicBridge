import type { CollectionFilter, CollectionModel } from '@music-bridge/contracts';

/** NFKC 和 Unicode 大小写沿用 Node 查询参数；原生层不重新解释 Unicode。 */
export interface CollectionFilterProjection { query?: string; brand?: string }
export function projectCollectionFilter(filter: CollectionFilter = {}): CollectionFilterProjection {
  const projection: CollectionFilterProjection = {};
  const normalized = (text: string) => text.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase();
  if (filter.query?.trim()) projection.query = normalized(filter.query);
  if (filter.brand?.trim()) projection.brand = normalized(filter.brand);
  return projection;
}

/** SQLite 默认 lower 仅折叠 ASCII；保持现有查询行为和 Node 导出的 rowid 次序。 */
export function filterCollectionSnapshot(models: readonly CollectionModel[], filter: CollectionFilter = {},
  projection = projectCollectionFilter(filter)): readonly CollectionModel[] {
  const lower = (text: string) => text.replace(/[A-Z]/g, letter => letter.toLowerCase());
  return models.filter(model => {
    if (projection.query !== undefined && !lower(model.brand + ' ' + model.name + ' ' + model.edition).includes(projection.query)) return false;
    if (projection.brand !== undefined && lower(model.brand) !== projection.brand) return false;
    if (filter.decade === 'unknown' && model.year !== null) return false;
    if (typeof filter.decade === 'number' && (model.year === null || model.year < filter.decade || model.year > filter.decade + 9)) return false;
    switch (filter.stockState) {
      case 'identified': return model.identification === 'verified';
      case 'needs-review': return model.identification !== 'verified' || model.counts.unknown > 0;
      case 'blank': return model.counts.sealedBlank + model.counts.openedBlank > 0;
      case 'recorded': return model.counts.legacyUsed + model.counts.recorded > 0;
      default: return true;
    }
  });
}
