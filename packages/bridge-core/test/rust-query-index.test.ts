import assert from 'node:assert/strict';
import test from 'node:test';
import { isCollectionModel, type CollectionFilter, type CollectionModel } from '@music-bridge/contracts';
import { createCollectionSnapshotQueryIndex, filterCollectionSnapshot, projectCollectionFilter } from '../src/rust-core/collection-query.js';

const id = (ordinal: number) => `00000000-0000-4000-8000-${ordinal.toString(16).padStart(12, '0')}`;
function model(ordinal: number, overrides: Partial<CollectionModel> = {}): CollectionModel {
  const sealedBlank = ordinal % 3, openedBlank = ordinal % 2, legacyUsed = ordinal % 5 === 0 ? 1 : 0;
  const recorded = ordinal % 7 === 0 ? 1 : 0, unknown = ordinal % 11 === 0 ? 1 : 0;
  return { id: id(ordinal), brand: ['TDK', 'Sony', '合成牌', 'ÉCO', 'éco', 'ＡＢＣ', 'ABC'][ordinal % 7]!,
    name: ['SA', 'Literal%_Mix', '百分_号%', 'K', 'K', 'A  B'][ordinal % 6]!, edition: `初版 ${ordinal % 13}`,
    year: ordinal % 9 === 0 ? null : ordinal % 17 === 0 ? 2200 : 1900 + ordinal % 300,
    format: 'cassette', tapeType: 'II', identification: ordinal % 4 === 0 ? 'unidentified' : 'verified',
    collectorPolicy: 'normal', minimumSealedReserve: ordinal % 3, revision: ordinal + 1, lengths: [60, 90, null],
    counts: { total: sealedBlank + openedBlank + legacyUsed + recorded + unknown,
      sealedBlank, openedBlank, legacyUsed, recorded, unknown, reserved: 0, unavailable: 0 },
    photoCount: 1, featuredPhoto: { id: id(ordinal + 10_000), modelId: id(ordinal), width: 800, height: 600, source: 'user-photo' },
    ...overrides };
}
function frozen(models: CollectionModel[]): readonly CollectionModel[] {
  function freeze(value: unknown): void {
    if (value !== null && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  }
  freeze(models);
  return models;
}

test('5000 型号的确定性差分覆盖组合筛选、完整 DTO、分页与导出次序', () => {
  const models = frozen(Array.from({ length: 5_000 }, (_v, ordinal) => model(ordinal)));
  assert.ok(models.every(isCollectionModel));
  const index = createCollectionSnapshotQueryIndex(models);
  const brands = [undefined, 'tdk', ' ＳＯＮＹ ', '合成牌', 'ÉCO', 'ＡＢＣ', 'missing'];
  const queries = [undefined, 'ＳＡ', '%', '_', 'Literal%_', '  初版\t 1  ', 'éco', 'K', 'A  B', 'missing'];
  const decades = [undefined, 'unknown', 1900, 1990, 2190, 2200] as const;
  const states = [undefined, 'identified', 'needs-review', 'blank', 'recorded'] as const;
  const filters: CollectionFilter[] = [{}, { query: ' ' }, { brand: ' ' }];
  for (let i = 0; i < 210; i++) {
    const brand = brands[i % brands.length], query = queries[(i * 3) % queries.length];
    const decade = decades[(i * 5) % decades.length], stockState = states[(i * 7) % states.length];
    filters.push({ ...(brand === undefined ? {} : { brand }), ...(query === undefined ? {} : { query }),
      ...(decade === undefined ? {} : { decade }), ...(stockState === undefined ? {} : { stockState }) });
  }
  for (const filter of filters) {
    const expected = filterCollectionSnapshot(models, filter), actual = index.filter(filter);
    assert.deepEqual(actual, expected, JSON.stringify(filter));
    assert.deepEqual(actual.map(row => row.id), [...actual].sort((a, b) => models.indexOf(a) - models.indexOf(b)).map(row => row.id));
    for (const offset of [0, 25, actual.length, actual.length + 10]) {
      assert.deepEqual(actual.slice(offset, offset + 25), expected.slice(offset, offset + 25));
    }
  }
});

test('查询 NFKC 与 Unicode lower 不反向归一化行端，行端仅 ASCII lower', () => {
  const models = frozen([
    model(1, { brand: 'ÉCO', name: 'ＡＢＣ', edition: 'K' }),
    model(2, { brand: 'éco', name: 'ABC', edition: 'K' }),
    model(3, { brand: 'ＡＢＣ', name: 'A  B', edition: '初版' }),
    model(4, { brand: 'ABC', name: 'A B', edition: '初版' }),
  ]);
  const index = createCollectionSnapshotQueryIndex(models);
  const ids = (filter: CollectionFilter) => index.filter(filter).map(row => row.id);
  assert.deepEqual(ids({ brand: 'ÉCO' }), [id(2)]);
  assert.deepEqual(ids({ brand: 'ＡＢＣ' }), [id(4)]);
  assert.deepEqual(ids({ query: 'ＡＢＣ' }), [id(2), id(4)]);
  assert.deepEqual(ids({ query: 'K' }), [id(2)]);
  assert.deepEqual(ids({ query: ' A\t\t B ' }), [id(4)]);
  for (const filter of [{ brand: 'ÉCO' }, { brand: 'ＡＢＣ' }, { query: 'ＡＢＣ' }, { query: 'K' }, { query: ' A\t\t B ' }]) {
    assert.deepEqual(index.filter(filter), filterCollectionSnapshot(models, filter));
  }
});

test('百分号和下划线按字面子串，搜索不匹配库存或照片字段', () => {
  const models = frozen([model(1, { brand: 'TDK', name: 'A%_B', edition: '首版' }),
    model(2, { brand: 'TDK', name: 'AXYB', edition: '首版' }), model(3, { brand: 'TDK', name: 'A_B', edition: '首版' })]);
  const index = createCollectionSnapshotQueryIndex(models);
  assert.deepEqual(index.filter({ query: '%_' }).map(row => row.id), [id(1)]);
  assert.deepEqual(index.filter({ query: '_' }).map(row => row.id), [id(1), id(3)]);
  assert.deepEqual(index.filter({ query: 'user-photo' }), []);
  assert.deepEqual(index.filter({ query: id(1) }), []);
});

test('库存 posting 可重叠，unknown 和 2200 年代保持 AND 与稳定顺序', () => {
  const overlapping = { total: 4, sealedBlank: 1, openedBlank: 0, legacyUsed: 1, recorded: 1,
    unknown: 1, reserved: 0, unavailable: 0 };
  const models = frozen([model(9, { brand: 'TDK', year: null, identification: 'verified', counts: overlapping }),
    model(8, { brand: 'Sony', year: 2200, identification: 'verified', counts: overlapping }),
    model(7, { brand: 'TDK', year: 2199, identification: 'unidentified', counts: overlapping }),
    model(6, { brand: 'TDK', year: 2200, identification: 'verified', counts: overlapping })]);
  const index = createCollectionSnapshotQueryIndex(models);
  for (const stockState of ['identified', 'needs-review', 'blank', 'recorded'] as const) {
    for (const decade of [undefined, 'unknown', 2190, 2200] as const) {
      for (const brand of [undefined, 'TDK', 'Sony', 'missing']) {
        const filter = { stockState, ...(decade === undefined ? {} : { decade }), ...(brand === undefined ? {} : { brand }) };
        assert.deepEqual(index.filter(filter), filterCollectionSnapshot(models, filter));
      }
    }
  }
  assert.deepEqual(index.filter({ decade: 2200 }).map(row => row.id), [id(8), id(6)]);
  assert.deepEqual(index.filter({ decade: 'unknown', stockState: 'identified' }).map(row => row.id), [id(9)]);
  assert.deepEqual(index.filter({ brand: 'TDK', decade: 2200, stockState: 'recorded' }).map(row => row.id), [id(6)]);
  // 内部 helper 保持旧参照的任意区间语义，公开合同仍拒绝非整十年代。
  assert.deepEqual(index.filter({ decade: 2199 }), filterCollectionSnapshot(models, { decade: 2199 }));
});

test('显式投影兼容旧参照，空快照和不存在的 posting 返回独立数组', () => {
  const models = frozen([model(1, { brand: 'TDK', name: 'SA', year: null }), model(2, { brand: 'Sony', name: 'MA' })]);
  const index = createCollectionSnapshotQueryIndex(models);
  const filter = { query: '忽略原文', brand: '忽略原文', decade: 'unknown' } as const;
  const projection = { query: 'sa', brand: 'tdk' };
  assert.deepEqual(index.filter(filter, projection), filterCollectionSnapshot(models, filter, projection));
  assert.deepEqual(index.filter({ brand: 'missing' }), []);
  const emptyIndex = createCollectionSnapshotQueryIndex(frozen([]));
  assert.deepEqual(emptyIndex.filter({ decade: 'unknown', stockState: 'blank' }), []);
  assert.notEqual(emptyIndex.filter(), emptyIndex.filter());
  assert.deepEqual(projectCollectionFilter({ query: ' \tＳＡ  初版\n ', brand: ' ＴＤＫ ' }), { query: 'sa 初版', brand: 'tdk' });
});

test('返回数组不能修改内部 posting，无请求缓存或跨快照复用', () => {
  const models = frozen([model(4, { brand: 'TDK' }), model(3, { brand: 'Sony' }), model(2, { brand: 'TDK' })]);
  const index = createCollectionSnapshotQueryIndex(models);
  assert.equal(Object.isFrozen(index), true);
  assert.deepEqual(Object.keys(index), ['filter']);
  const first = index.filter({ brand: 'TDK' }) as CollectionModel[];
  first.reverse(); first.push(models[1]!); first.splice(0, first.length);
  assert.deepEqual(index.filter({ brand: 'TDK' }).map(row => row.id), [id(4), id(2)]);
  const all = index.filter() as CollectionModel[];
  all.splice(0, all.length);
  assert.deepEqual(index.filter(), models);
  const changed = frozen([{ ...models[0]!, brand: 'Sony' }, models[1]!, models[2]!]);
  const nextIndex = createCollectionSnapshotQueryIndex(changed);
  assert.deepEqual(nextIndex.filter({ brand: 'TDK' }).map(row => row.id), [id(2)]);
  assert.deepEqual(index.filter({ brand: 'TDK' }).map(row => row.id), [id(4), id(2)]);
  assert.equal(Object.isFrozen(index.filter()[0]!.counts), true);
});
