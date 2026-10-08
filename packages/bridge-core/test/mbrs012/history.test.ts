import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import * as dto from '@music-bridge/contracts';
import { catalogFixture } from '../mbrs006/catalog-fixture.js';
import { createCollectionRepository } from '../../src/collection/repository.js';
import { createLocalSourceWritesStore, type LocalSourceWritesStore } from '../../src/collection/local-source-writes-store.js';
import { SourceWritesError, sourceWritesEvent, sourceWritesHash, sourceWritesRequestFingerprint } from '../../src/collection/local-source-writes-journal.js';

const at = '2026-10-08T00:00:00.000Z';
const rejectsIssue = (code: dto.LocalSourceWritesIssue) => (error: unknown): boolean => error instanceof SourceWritesError && error.code === code;
async function historyFixture(t: TestContext) {
  const f = await catalogFixture(t); let clock = Date.parse(at);
  const store = createLocalSourceWritesStore(f.repository.localCatalog, () => clock);
  function header(index: number) {
    const planId = randomUUID(), commandId = randomUUID(), intent: dto.LocalSourceWritesIntent = { kind: 'tags', target: { mode: 'single', trackId: f.tracks[0]!.id }, fields: { title: { action: 'set', value: `合成持久预览 ${index}` } } };
    const request: dto.PreviewLocalSourceWrites = { datasetId: f.datasetId, commandId, intent }, plan: dto.LocalSourceWritesPlan = { version: 1, datasetId: f.datasetId, planId, jobId: randomUUID(), viewRevision: '1', journalSequence: '1', scope: 'SOURCE_FILES', range: 'TAGS', state: 'PREVIEWING', createdAt: at, readyAt: null, expiresAt: null, policyRevision: '1', planHash: null, contextFingerprint: null,
      journalFingerprint: sourceWritesHash({ planId, empty: true }), summary: `合成只读历史 ${index}`, items: [], issues: [], resourceSummary: { resources: 0, sharedTargets: 1, backupBytes: null, spaceVerified: false, protection: 'unknown' }, undoOf: null, recoveryOf: null, recoveryChoices: [] };
    assert.ok(dto.isLocalSourceWritesPlan(plan));
    const receipt: dto.LocalSourceWritesReceipt = { datasetId: f.datasetId, commandId, command: 'localSourceWrites.preview', requestFingerprint: sourceWritesRequestFingerprint('localSourceWrites.preview', request), planId, jobId: plan.jobId, outcome: 'accepted', policy: null, issue: null };
    return sourceWritesEvent({ version: 1 as const, eventId: randomUUID(), datasetId: f.datasetId, planId, occurredAt: at, kind: 'receipt' as const, command: 'localSourceWrites.preview' as const, request, requestFingerprint: receipt.requestFingerprint, receipt, header: plan, intent, ownerEpoch: f.epoch, policy: null });
  }
  function plans(count: number): string[] {
    const events = Array.from({ length: count }, (_, index) => header(index));
    for (let i = 0; i < events.length; i += 100) store.transaction(view => { for (const event of events.slice(i, i + 100)) view.append(event); });
    return events.map(v => v.planId!);
  }
  function progress(planId: string, count: number): void {
    // 正式私有SQLite/journal认证每条事件；不注入伪造projection或修改旧schema。此夹具不执行源写。
    for (let i = 0; i < count; i += 100) store.transaction(view => {
      for (let j = i; j < Math.min(i + 100, count); j++) view.append(sourceWritesEvent({ version: 1 as const, eventId: randomUUID(), datasetId: f.datasetId, planId, occurredAt: at, kind: 'state' as const, state: 'PREVIEWING' as const, issues: [] }));
    });
  }
  return { ...f, store, plans, progress, now: () => clock, advance: (milliseconds: number) => { clock += milliseconds; } };
}
function eventsPage(store: LocalSourceWritesStore, request: dto.HistoryLocalSourceWrites) {
  const page = store.history(request); assert.ok(page.kind === 'events'); assert.ok(dto.isLocalSourceWritesCommandResult('localSourceWrites.history', page)); return page;
}
function plansPage(store: LocalSourceWritesStore, request: dto.HistoryLocalSourceWrites) {
  const page = store.history(request); assert.ok(page.kind === 'plans'); assert.ok(dto.isLocalSourceWritesCommandResult('localSourceWrites.history', page)); return page;
}
function collectEvents(store: LocalSourceWritesStore, request: dto.HistoryLocalSourceWrites): { items: dto.LocalSourceWritesHistoryEvent[]; fingerprint: string } {
  const items: dto.LocalSourceWritesHistoryEvent[] = []; let cursor: string | null = null, fingerprint = '';
  do {
    const page = eventsPage(store, { ...request, cursor });
    if (!fingerprint) fingerprint = page.snapshotFingerprint; else assert.equal(page.snapshotFingerprint, fingerprint);
    assert.ok(page.items.length <= 100); items.push(...page.items); cursor = page.cursor;
    assert.equal(page.hasMore, cursor !== null);
  } while (cursor !== null);
  return { items, fingerprint };
}

test('012 history 真SQLite冷读2050条持久事件，100项分页期间新append不能混入旧快照', async t => {
  const f = await historyFixture(t), [planId] = f.plans(1); assert.ok(planId); f.progress(planId, 2049);
  const expected = f.store.read(view => view.projection.events.filter(e => e.planId === planId).map(e => e.eventId)); assert.equal(expected.length, 2050);
  f.store.close(); f.repository.close(); const repository = createCollectionRepository({ filePath: path.join(f.directory, 'collection.sqlite') }), store = createLocalSourceWritesStore(repository.localCatalog, f.now);
  try {
    const request: dto.HistoryLocalSourceWrites = { datasetId: f.datasetId, selector: { kind: 'events', planId }, cursor: null, limit: 100 }, first = eventsPage(store, request);
    assert.equal(first.items.length, 100); assert.ok(first.cursor); assert.equal(first.hasMore, true);
    store.state(f.datasetId, planId, 'BLOCKED', ['POLICY_DISABLED']);
    const all = [...first.items]; let cursor: string | null = first.cursor;
    while (cursor !== null) { const page = eventsPage(store, { ...request, cursor }); assert.equal(page.snapshotFingerprint, first.snapshotFingerprint); assert.ok(page.items.length <= 100); all.push(...page.items); cursor = page.cursor; assert.equal(page.hasMore, cursor !== null); }
    assert.deepEqual(all.map(v => v.eventId), expected); assert.equal(new Set(all.map(v => v.eventId)).size, 2050); assert.deepEqual(all.map(v => v.journalSequence), Array.from({ length: 2050 }, (_, i) => String(i + 1)));
    const latest = eventsPage(store, request); assert.notEqual(latest.snapshotFingerprint, first.snapshotFingerprint); assert.equal(store.plan(f.datasetId, planId).plan.state, 'BLOCKED');
    assert.equal(JSON.stringify(all).includes('source_relative_path'), false); assert.equal(JSON.stringify(all).includes('authorityId'), false); assert.equal(JSON.stringify(all).includes(f.directory), false);
  } finally { store.close(); repository.close(); }
});
test('012 history plans快照：页间改旧计划状态/插新计划，旧页保留原状态、revision和集合', async t => {
  const f = await historyFixture(t), ids = f.plans(110), request: dto.HistoryLocalSourceWrites = { datasetId: f.datasetId, selector: { kind: 'plans', range: 'all' }, cursor: null, limit: 100 };
  try {
    const first = plansPage(f.store, request); assert.equal(first.items.length, 100); assert.ok(first.cursor);
    // 与 plans/progress 一样直接追加正式 typed journal，仅验证历史快照；110活动头并未通过业务受理容量门禁。
    const changedId = ids[105]!; f.store.transaction(view => view.append(sourceWritesEvent({ version: 1 as const, eventId: randomUUID(), datasetId: f.datasetId, planId: changedId, occurredAt: at, kind: 'state' as const, state: 'BLOCKED' as const, issues: ['POLICY_DISABLED'] })));
    const [inserted] = f.plans(1); assert.ok(inserted);
    const second = plansPage(f.store, { ...request, cursor: first.cursor }), all = [...first.items, ...second.items]; assert.equal(second.snapshotFingerprint, first.snapshotFingerprint); assert.equal(second.hasMore, false); assert.equal(second.items.length, 10);
    assert.deepEqual(all.map(v => v.planId), ids); assert.equal(all.find(v => v.planId === changedId)!.state, 'PREVIEWING'); assert.equal(all.find(v => v.planId === changedId)!.viewRevision, '1'); assert.equal(all.some(v => v.planId === inserted), false);
    const current = plansPage(f.store, request); assert.notEqual(current.snapshotFingerprint, first.snapshotFingerprint); assert.equal(f.store.plan(f.datasetId, changedId).plan.state, 'BLOCKED');
  } finally { f.store.close(); }
});
test('012 history 原页对象不能改server快照；重读同cursor得到原值', async t => {
  const f = await historyFixture(t), [planId] = f.plans(1); assert.ok(planId); f.progress(planId, 4);
  try {
    const request: dto.HistoryLocalSourceWrites = { datasetId: f.datasetId, selector: { kind: 'events', planId }, cursor: null, limit: 1 }, first = eventsPage(f.store, request); assert.ok(first.cursor);
    const second = eventsPage(f.store, { ...request, cursor: first.cursor }), original = structuredClone(second.items); second.items[0]!.label = '客户端更改的显示副本';
    assert.deepEqual(eventsPage(f.store, { ...request, cursor: first.cursor }).items, original);
  } finally { f.store.close(); }
});
test('012 history 真128个cursor上限/作用域/600000ms过期/close：不返回静默空页', async t => {
  const f = await historyFixture(t); f.plans(2);
  try {
    const request: dto.HistoryLocalSourceWrites = { datasetId: f.datasetId, selector: { kind: 'plans', range: 'all' }, cursor: null, limit: 1 }, first = plansPage(f.store, request); assert.ok(first.cursor);
    assert.throws(() => f.store.history({ ...request, cursor: first.cursor, limit: 2 }), rejectsIssue('CURSOR_SCOPE_MISMATCH'));
    assert.throws(() => f.store.history({ ...request, cursor: first.cursor, datasetId: randomUUID() }), rejectsIssue('CURSOR_SCOPE_MISMATCH'));
    for (let i = 1; i < 128; i++) assert.ok(plansPage(f.store, request).cursor);
    assert.throws(() => f.store.history(request), rejectsIssue('BUDGET_EXCEEDED'));
    f.advance(600000); assert.throws(() => f.store.history({ ...request, cursor: first.cursor }), rejectsIssue('CURSOR_EXPIRED'));
    const next = plansPage(f.store, request); assert.ok(next.cursor); f.store.close();
    const fresh = createLocalSourceWritesStore(f.repository.localCatalog, f.now);
    try { assert.throws(() => fresh.history({ ...request, cursor: next.cursor }), rejectsIssue('CURSOR_EXPIRED')); assert.ok(plansPage(fresh, request).cursor); } finally { fresh.close(); }
  } finally { f.store.close(); }
});
test('012 history 真16MiB快照字节容量：用2050个持久事件实测完整JSON，在128槽之前准确拒绝并到期释放', async t => {
  const f = await historyFixture(t), [planId] = f.plans(1); assert.ok(planId); f.progress(planId, 2049);
  const request: dto.HistoryLocalSourceWrites = { datasetId: f.datasetId, selector: { kind: 'events', planId }, cursor: null, limit: 100 }, measurement = createLocalSourceWritesStore(f.repository.localCatalog, f.now);
  let snapshot: ReturnType<typeof collectEvents>;
  try { snapshot = collectEvents(measurement, request); assert.equal(snapshot.items.length, 2050); } finally { measurement.close(); }
  try {
    // 此处仅度量已验证公共纯DTO的完整JSON字节，不以JSON.stringify(raw)计算授权指纹，也不读取内部cursor计数。
    const actualBytes = Buffer.byteLength(JSON.stringify({ datasetId: f.datasetId, scope: sourceWritesHash({ datasetId: f.datasetId, selector: request.selector, limit: request.limit }), offset: 100,
      highWater: f.store.read(v => v.projection.highWater), fingerprint: snapshot.fingerprint, expires: f.now() + 600000, values: snapshot.items }));
    assert.ok(actualBytes > 131072); assert.ok(actualBytes < 2097152); const copies = Math.floor(16777216 / actualBytes); assert.ok(copies >= 2 && copies < 128);
    for (let i = 0; i < copies; i++) { const page = eventsPage(f.store, request); assert.ok(page.cursor); assert.equal(page.snapshotFingerprint, snapshot.fingerprint); }
    assert.throws(() => f.store.history(request), rejectsIssue('BUDGET_EXCEEDED'));
    f.advance(600000); assert.ok(eventsPage(f.store, request).cursor);
  } finally { f.store.close(); }
});
