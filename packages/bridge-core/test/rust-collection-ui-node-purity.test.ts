import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Worker } from 'node:worker_threads';
import yazl from 'yazl';
import { validateIpcRequest } from '@music-bridge/contracts';
import type { CanonicalReference, CatalogRevisionDetail, CollectionMutationResult, CollectionProgress, CollectionProgressSnapshotSummary, IpcRequest, ReferenceSourceVersion, WantEntry } from '@music-bridge/contracts';
import { DatasetOwnerDispatchError } from '../src/collection/dataset-owner-protocol.js';
import { createDatasetOwnerClient } from '../src/collection/dataset-owner-client.js';
const page = { offset: 0, limit: 25 };
const hash = (raw: string) => createHash('sha256').update(raw).digest('hex');
const item = (id: string): CanonicalReference => ({ referenceId: id, bookId: 'rust009-book', brand: '合成品牌', series: '系列', model: id, edition: '1990', lengths: [46, 90], iec: 'II', era: '1990', image: { kind: 'none' }, pages: ['1'], notes: '', confidence: 'high' });
function tables(file: string) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const names = db.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
    return names.map(row => ({ name: row.name, sql: row.sql, rows: db.prepare(`SELECT * FROM "${String(row.name).replaceAll('"', '""')}" ORDER BY rowid`).all() }));
  } finally { db.close(); }
}
async function fixture(t: test.TestContext) {
  const external = '/Volumes/LifeWeave/Developer/CommandLine/tmp', temporary = path.resolve(tmpdir());
  if (process.platform === 'darwin') assert.ok(temporary === external || temporary.startsWith(external + path.sep), '纯度夹具必须使用外置TMPDIR。');
  const directory = await mkdtemp(path.join(temporary, 'rust009-purity-'));
  const worker = new Worker(new URL('./helpers/dataset-owner-domain-fixture.ts', import.meta.url), { execArgv: ['--import', 'tsx'], workerData: { dataDirectory: directory } });
  const owner = createDatasetOwnerClient({ worker }); const identity = await owner.prepare(); await owner.commitBoot();
  t.after(async () => { await owner.close(); await rm(directory, { recursive: true, force: true }); });
  const dispatch = (command: IpcRequest['command'], payload: unknown) => { const request: IpcRequest = { version: 1, id: randomUUID(), command, payload, expectedDatasetId: identity.datasetId }; assert.ok(validateIpcRequest(request).ok, '合成请求必须合法：' + command); return owner.dispatch(request); };
  const receive = await dispatch('collection.receive', { commandId: randomUUID(), model: { brand: '合成品牌', name: '磁带', edition: '1990', year: 1990, format: 'cassette', tapeType: 'II', identification: 'verified' }, lengthMinutes: 90, quantities: { sealedBlank: 2, openedBlank: 0, legacyUsed: 0, unclassified: 0 } }) as CollectionMutationResult;
  const refs = Array.from({ length: 28 }, (_, i) => item('ref-' + i));
  async function publish(previous: string | null) {
    const rawPack = '\uFEFF' + JSON.stringify({ schemaVersion: 1, bookId: refs[0]!.bookId, title: '009合成目录', sourceVersion: previous ? '第二版' : '第一版', items: refs });
    const source = await dispatch('referenceCatalog.registerSource', { commandId: randomUUID(), rawPack, packHash: hash(rawPack), userConfirmed: true }) as ReferenceSourceVersion;
    const request = { sourceId: source.id, expectedCurrentRevisionId: previous, items: refs, mappings: [] };
    const preview = await dispatch('referenceCatalog.previewRevision', request) as { baselineFingerprint: string };
    const detail = await dispatch('referenceCatalog.publishRevision', { ...request, commandId: randomUUID(), baselineFingerprint: preview.baselineFingerprint, userConfirmed: true }) as CatalogRevisionDetail;
    return { rawPack, source, detail };
  }
  const first = await publish(null);
  const wantRequest = { commandId: randomUUID(), id: null, expectedVersion: 0, revisionId: first.detail.revision.id, referenceId: refs[0]!.referenceId, priority: 'normal', preferredCondition: '', notes: '原目标', targetLengthMinutes: 46, packagingTarget: '', priceTarget: null, userConfirmed: true };
  const wanted = await dispatch('collectionProgress.saveWant', wantRequest) as WantEntry;
  const matched = await dispatch('referenceCatalog.setMatch', { commandId: randomUUID(), revisionId: first.detail.revision.id, expectedMatchVersion: first.detail.matchVersion, match: { referenceId: refs[0]!.referenceId, modelId: receive.modelId, status: 'confirmed', availability: 'unknown' }, userConfirmed: true }) as CatalogRevisionDetail;
  const progress = await dispatch('collectionProgress.current', { revisionId: first.detail.revision.id, page }) as CollectionProgress;
  const captured = await dispatch('collectionProgress.capture', { commandId: randomUUID(), revisionId: first.detail.revision.id, expectedFingerprint: progress.fingerprint, userConfirmed: true }) as CollectionProgressSnapshotSummary;
  await dispatch('collectionProgress.saveWant', { ...wantRequest, commandId: randomUUID(), id: wanted.id, expectedVersion: 1, notes: '真实第二版本' });
  const second = await publish(first.detail.revision.id);
  const zip = new yazl.ZipFile(); zip.addBuffer(Buffer.from(first.rawPack), 'catalog.json', { compress: false }); zip.end(); const chunks: Buffer[] = [];
  for await (const chunk of zip.outputStream) chunks.push(Buffer.from(chunk));
  const zipBase64 = Buffer.concat(chunks).toString('base64');
  const zipPreview = await dispatch('referenceCatalog.previewSourceZip', { zipBase64 }) as { zipSha256: string; rawPackHash: string };
  await dispatch('referenceCatalog.registerSourceZip', { commandId: randomUUID(), zipBase64, expectedZipSha256: zipPreview.zipSha256, expectedRawPackHash: zipPreview.rawPackHash, userConfirmed: true });
  const file = path.join(directory, 'collection.v1.sqlite');
  return { owner, dispatch, file, first, second, wanted, captured, matched, receive, wantRequest };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const cases: { command: IpcRequest['command']; payload(s: Fixture): unknown; verify(value: unknown, s: Fixture): void; bad(s: Fixture): unknown; corrupt?: string }[] = [
  { command: 'collectionProgress.current', payload: s => ({ revisionId: s.first.detail.revision.id, page }), verify: v => { const p = v as CollectionProgress; assert.equal(p.isCurrentRevision, false); assert.equal(p.overall.owned, 1); assert.equal(p.entries.total, 28); assert.equal(p.entries.items[0]?.stockCount, 2); }, bad: () => ({ revisionId: randomUUID(), page }) },
  { command: 'collectionProgress.wants', payload: () => ({ page }), verify: v => { const p = v as { total: number; items: { entry: WantEntry; needsReview: boolean }[] }; assert.equal(p.total, 1); assert.equal(p.items[0]?.entry.version, 2); assert.equal(p.items[0]?.needsReview, true); }, bad: () => ({ page }), corrupt: 'collection_wants' },
  { command: 'collectionProgress.wantHistory', payload: s => ({ id: s.wanted.id, page }), verify: v => { const p = v as { items: WantEntry[]; total: number }; assert.equal(p.total, 2); assert.deepEqual(p.items.map(i => i.version), [1, 2]); }, bad: () => ({ id: randomUUID(), page }) },
  { command: 'collectionProgress.snapshots', payload: () => ({ page }), verify: (v, s) => { const p = v as { items: CollectionProgressSnapshotSummary[] }; assert.deepEqual(p.items, [s.captured]); }, bad: () => ({ page }), corrupt: 'collection_progress_snapshots' },
  { command: 'collectionProgress.snapshot', payload: s => ({ id: s.captured.id, page }), verify: v => { const p = v as { entries: { items: { wantedTargets: { version: number }[] }[] } }; assert.equal(p.entries.items[0]?.wantedTargets[0]?.version, 1); }, bad: () => ({ id: randomUUID(), page }) },
  { command: 'referenceCatalog.snapshot', payload: s => ({ id: s.matched.snapshot.id }), verify: (v, s) => assert.deepEqual(v, s.matched.snapshot), bad: () => ({ id: randomUUID() }) },
  { command: 'referenceCatalog.source', payload: s => ({ id: s.first.source.id }), verify: (v, s) => assert.deepEqual(v, { source: s.first.source, rawPack: s.first.rawPack }), bad: () => ({ id: randomUUID() }) },
  { command: 'referenceCatalog.sourceZipReceipts', payload: s => ({ sourceId: s.first.source.id, ...page }), verify: (v, s) => { const p = v as { total: number; items: { rawPackHash: string }[] }; assert.equal(p.total, 1); assert.equal(p.items[0]?.rawPackHash, s.first.source.packHash); }, bad: () => ({ sourceId: randomUUID(), ...page }) },
];
for (const entry of cases) for (const fails of [false, true]) test(`${entry.command}已boot固定Owner${fails ? '辅助链原错误' : '完整成功DTO'}全表和同连接版本均不变`, async t => {
  const s = await fixture(t);
  if (fails && entry.corrupt) {
    // 只在新合成库注入持久损坏；读取窗口开始前完成，保留原触发器定义。
    const db = new DatabaseSync(s.file);
    try {
      const trigger = entry.corrupt === 'collection_progress_snapshots' ? db.prepare("SELECT sql,name FROM sqlite_master WHERE type='trigger' AND name='collection_progress_snapshots_no_update'").get() : undefined;
      db.exec('BEGIN IMMEDIATE'); if (trigger) db.exec(`DROP TRIGGER "${String(trigger.name)}"`);
      db.prepare(`UPDATE ${entry.corrupt} SET data=?`).run('{}'); if (trigger) db.exec(String(trigger.sql)); db.exec('COMMIT');
    } finally { db.close(); }
  }
  const version = await s.owner.getCollectionSnapshotVersion(), before = tables(s.file);
  if (fails) await assert.rejects(s.dispatch(entry.command, entry.bad(s)), error => error instanceof DatasetOwnerDispatchError && error.failure.error.code === 'INVENTORY_UNAVAILABLE');
  else entry.verify(await s.dispatch(entry.command, entry.payload(s)), s);
  assert.deepEqual(await s.owner.getCollectionSnapshotVersion(), version); assert.deepEqual(tables(s.file), before);
});
test('两次热读取之间真实Node作者修改必须改变结果与指纹，历史快照不复用当前cache', async t => {
  const s = await fixture(t), payload = { revisionId: s.first.detail.revision.id, page };
  const before = await s.dispatch('collectionProgress.current', payload) as CollectionProgress;
  const last = await s.dispatch('collectionProgress.current', { ...payload, page: { offset: 25, limit: 25 } }) as CollectionProgress;
  assert.equal(before.fingerprint, last.fingerprint); assert.equal(last.entries.items.length, 3);
  const historical = await s.dispatch('collectionProgress.snapshot', { id: s.captured.id, page });
  await s.dispatch('collectionProgress.cancelWant', { commandId: randomUUID(), id: s.wanted.id, expectedVersion: 2, userConfirmed: true });
  const after = await s.dispatch('collectionProgress.current', payload) as CollectionProgress;
  assert.notEqual(after.fingerprint, before.fingerprint); assert.equal(after.overall.wantTargetCount, 0);
  assert.deepEqual(await s.dispatch('collectionProgress.snapshot', { id: s.captured.id, page }), historical);
  assert.equal((await s.dispatch('collectionProgress.wantHistory', { id: s.wanted.id, page }) as { total: number }).total, 3);
});

test('热Owner容量检查读取超8MiB原JSON时失败，不删除或修复表且stamp不变', async t => {
  const s = await fixture(t), db = new DatabaseSync(s.file);
  try { db.prepare('UPDATE collection_wants SET data=?').run('x'.repeat(8 * 1024 * 1024 + 1)); } finally { db.close(); }
  const stamp = await s.owner.getCollectionSnapshotVersion(), before = tables(s.file);
  await assert.rejects(s.dispatch('collectionProgress.current', { revisionId: s.first.detail.revision.id, page }), error => error instanceof DatasetOwnerDispatchError && error.failure.error.code === 'INVENTORY_CONFLICT');
  assert.deepEqual(await s.owner.getCollectionSnapshotVersion(), stamp); assert.deepEqual(tables(s.file), before);
});
