import assert from 'node:assert/strict';
import test from 'node:test';
import { MOBILE_CATALOG_TRACE_PREFIX, catalogTraceEvent, catalogTraceStep, copyCatalogTraceRecord, withCatalogTrace } from '../src/mobile/catalog-private-trace.js';

const seed = { schema: 1 as const, requestSha256: 'a'.repeat(64), nonceSha256: 'b'.repeat(64), offset: 18000, limit: 100 };
const records = (lines: string[]) => lines.map(line => JSON.parse(line.slice(MOBILE_CATALOG_TRACE_PREFIX.length)));

test('正常百行映射按阶段聚合，DTO两次调用仍保留，业务只执行一次', () => {
  const lines: string[] = []; let executions = 0;
  withCatalogTrace(seed, 'owner', () => {
    for (let ordinal = 1; ordinal <= 100; ordinal++) {
      const result = catalogTraceStep('owner.item.detail', () => { executions++; return ordinal; }, ordinal);
      assert.equal(result, ordinal);
      catalogTraceStep('owner.item.dto', () => undefined, ordinal);
      catalogTraceStep('owner.item.dto', () => undefined, ordinal);
    }
    catalogTraceStep('owner.page-seal', () => undefined);
  }, line => lines.push(line));
  const rows = records(lines);
  assert.equal(executions, 100);
  assert.equal(rows.find(row => row.stage === 'owner.item.detail.calls')?.count, 100);
  assert.equal(rows.find(row => row.stage === 'owner.item.dto.calls')?.count, 200);
  const total = rows.find(row => row.stage === 'owner.item.detail.total-ms');
  assert.ok(total && total.count >= 0 && total.matched === true && total.rowOrdinal === null);
  assert.ok(rows.every(row => copyCatalogTraceRecord(row)));
  assert.ok(rows.length <= 64 && Buffer.byteLength(lines.join('')) <= 65536);
  assert.equal(rows.filter(row => row.stage === 'owner.item.detail.total-ms').length, 1);
  assert.equal(copyCatalogTraceRecord({...total,count:null}),null);
  assert.equal(copyCatalogTraceRecord({...total,rowOrdinal:1}),null);
  assert.equal(copyCatalogTraceRecord({...total,matched:null}),null);
  assert.equal(copyCatalogTraceRecord({...total,stage:'owner.item.unknown.total-ms'}),null);
});

test('嵌套请求各自累计，未注册作用域不输出，sink故障不重复执行业务', () => {
  const outer: string[] = [], inner: string[] = []; let called = 0;
  withCatalogTrace(seed, 'owner', () => {
    catalogTraceStep('owner.item.detail', () => undefined, 1);
    withCatalogTrace({ ...seed, nonceSha256: 'c'.repeat(64) }, 'owner', () => {
      catalogTraceStep('owner.item.detail', () => undefined, 1);
      catalogTraceStep('owner.item.detail', () => undefined, 2);
      catalogTraceStep('owner.page-seal', () => undefined);
    }, line => inner.push(line));
    catalogTraceStep('owner.page-seal', () => undefined);
  }, line => outer.push(line));
  assert.equal(records(outer).find(row => row.stage === 'owner.item.detail.calls')?.count, 1);
  assert.equal(records(inner).find(row => row.stage === 'owner.item.detail.calls')?.count, 2);
  withCatalogTrace(seed, 'owner', () => {
    catalogTraceStep('owner.item.detail', () => { called++; }, 1);
    catalogTraceStep('owner.page-seal', () => { called++; });
  }, () => { throw new Error('合成输出故障'); });
  assert.equal(called, 2);
  catalogTraceStep('owner.item.detail', () => { called++; }, 1);
  assert.equal(called, 3);
});

test('聚合保留原记录和首错预算，不把指标当成业务成功', () => {
  const lines: string[] = [], failure = Object.assign(new Error('不得输出的合成正文'), { code: 'BUSY' });
  withCatalogTrace(seed, 'owner', () => {
    for (let ordinal = 1; ordinal <= 100; ordinal++) catalogTraceStep('owner.item.detail', () => undefined, ordinal);
    catalogTraceStep('owner.page-seal', () => undefined);
    for (let i = 0; i < 100; i++) catalogTraceEvent('owner.reply', 'ok');
    assert.throws(() => catalogTraceStep('owner.item.file-parameters', () => { throw failure; }, 80), error => error === failure);
  }, line => lines.push(line));
  const rows = records(lines), first = rows.find(row => row.phase === 'reject');
  assert.equal(first?.stage, 'owner.item.file-parameters'); assert.equal(first?.code, 'BUSY');
  assert.equal(first?.rowOrdinal, 80); assert.ok(rows.length <= 64);
  assert.ok(!lines.join('').includes(failure.message));
});

test('超过原count上限时明确截限，不扩大闭集预算', () => {
  const lines: string[] = [];
  withCatalogTrace(seed, 'owner', () => {
    for (let i = 0; i < 300001; i++) catalogTraceStep('owner.item.dto', () => undefined, 1);
    catalogTraceStep('owner.page-seal', () => undefined);
  }, line => lines.push(line));
  const row = records(lines).find(row => row.stage === 'owner.item.dto.calls');
  assert.equal(row?.count, 300000); assert.equal(row?.matched, false);
  assert.ok(records(lines).every(row => copyCatalogTraceRecord(row)));
});
