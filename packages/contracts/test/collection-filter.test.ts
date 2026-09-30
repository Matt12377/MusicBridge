import assert from 'node:assert/strict';
import test from 'node:test';
import { isCollectionFilter, validateIpcRequest } from '../src/index.js';

test('库存状态筛选合同兼容旧请求且允许与文字、品牌、年代组合', () => {
  for (const filter of [{}, { query: 'SA', brand: 'TDK', decade: 1990 }, { decade: 'unknown' }]) {
    assert.equal(isCollectionFilter(filter), true);
  }
  for (const stockState of ['identified', 'needs-review', 'blank', 'recorded']) {
    const filter = { stockState, query: 'SA', brand: 'TDK', decade: 1990 };
    assert.equal(isCollectionFilter(filter), true);
    assert.equal(validateIpcRequest({ version: 1, id: 'filter', command: 'collection.list', payload: { page: { offset: 24, limit: 24 }, filter } }).ok, true);
  }
});

test('库存筛选拒绝非法状态、错误类型以及额外字段', () => {
  for (const filter of [{ stockState: 'all' }, { stockState: null }, { stockState: 1 }, { stockState: '' }, { stockState: 'blank', extra: true }, { stockState: 'blank', decade: 1995 }]) {
    assert.equal(isCollectionFilter(filter), false);
    assert.equal(validateIpcRequest({ version: 1, id: 'filter', command: 'collection.list', payload: { page: { offset: 0, limit: 24 }, filter } }).ok, false);
  }
});
