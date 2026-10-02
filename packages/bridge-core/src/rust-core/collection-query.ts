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

export interface CollectionSnapshotQueryIndex {
  readonly filter: (filter?: CollectionFilter, projection?: CollectionFilterProjection) => readonly CollectionModel[];
}

/** 仅绑定已经冻结的本代完整快照；不保存请求、不向调用方暴露 posting。 */
export function createCollectionSnapshotQueryIndex(models: readonly CollectionModel[]): CollectionSnapshotQueryIndex {
  const lower = (text: string) => text.replace(/[A-Z]/g, letter => letter.toLowerCase());
  type StockState = NonNullable<CollectionFilter['stockState']>;
  const brands = new Map<string, number[]>(), decades = new Map<number | 'unknown', number[]>();
  const stocks: Record<StockState, number[]> = { identified: [], 'needs-review': [], blank: [], recorded: [] };
  const all: number[] = [];
  const append = <K>(postings: Map<K, number[]>, key: K, ordinal: number) => {
    const posting = postings.get(key);
    if (posting) posting.push(ordinal); else postings.set(key, [ordinal]);
  };
  // 每行只折叠一次 ASCII；查询端仍独立沿用 NFKC 和 Unicode lower。
  const rows = models.map((model, ordinal) => {
    const brand = lower(model.brand), year = model.year;
    const identified = model.identification === 'verified';
    const needsReview = !identified || model.counts.unknown > 0;
    const blank = model.counts.sealedBlank + model.counts.openedBlank > 0;
    const recorded = model.counts.legacyUsed + model.counts.recorded > 0;
    all.push(ordinal);
    append(brands, brand, ordinal);
    append(decades, year === null ? 'unknown' : Math.floor(year / 10) * 10, ordinal);
    if (identified) stocks.identified.push(ordinal);
    if (needsReview) stocks['needs-review'].push(ordinal);
    if (blank) stocks.blank.push(ordinal);
    if (recorded) stocks.recorded.push(ordinal);
    return Object.freeze({ brand, year, search: lower(model.brand + ' ' + model.name + ' ' + model.edition),
      identified, needsReview, blank, recorded });
  });
  // 品牌、年代各 N 项，四种可重叠状态最多 4N 项，均保持导出 ordinal 次序。
  const empty: readonly number[] = Object.freeze([]);
  for (const posting of [...brands.values(), ...decades.values(), ...Object.values(stocks)]) Object.freeze(posting);
  Object.freeze(rows); Object.freeze(all); Object.freeze(stocks);
  return Object.freeze({
    filter(filter: CollectionFilter = {}, projection = projectCollectionFilter(filter)): readonly CollectionModel[] {
      let candidates: readonly number[] = all;
      const choose = (posting: readonly number[]) => { if (posting.length < candidates.length) candidates = posting; };
      if (projection.brand !== undefined) choose(brands.get(projection.brand) ?? empty);
      if (filter.decade === 'unknown') choose(decades.get('unknown') ?? empty);
      // 公开合同只接受整十年代；非整十输入仍沿用线性参照的区间语义。
      if (typeof filter.decade === 'number' && filter.decade % 10 === 0) choose(decades.get(filter.decade) ?? empty);
      if (filter.stockState !== undefined && Object.hasOwn(stocks, filter.stockState)) choose(stocks[filter.stockState]);
      const result: CollectionModel[] = [];
      for (const ordinal of candidates) {
        const row = rows[ordinal]!;
        if (projection.query !== undefined && !row.search.includes(projection.query)) continue;
        if (projection.brand !== undefined && row.brand !== projection.brand) continue;
        if (filter.decade === 'unknown' && row.year !== null) continue;
        if (typeof filter.decade === 'number' && (row.year === null || row.year < filter.decade || row.year > filter.decade + 9)) continue;
        switch (filter.stockState) {
          case 'identified': if (!row.identified) continue; break;
          case 'needs-review': if (!row.needsReview) continue; break;
          case 'blank': if (!row.blank) continue; break;
          case 'recorded': if (!row.recorded) continue; break;
        }
        result.push(models[ordinal]!);
      }
      return result;
    },
  });
}
