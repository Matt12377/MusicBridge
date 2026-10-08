import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { copyFile, open, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import * as dto from '@music-bridge/contracts';
import { catalogFixture } from '../mbrs006/catalog-fixture.js';
import { createCollectionRepository } from '../../src/collection/repository.js';
import { createLocalSourceWritesStore } from '../../src/collection/local-source-writes-store.js';
import { observeSourceWriteFile, type SourceWriteFileObservation } from '../../src/collection/source-write-verify.js';
import { sourceWriteFieldValues } from '../../src/collection/source-write-metadata.js';
import {
  SOURCE_WRITES_OPERATION, sourceWritesEvent, sourceWritesHash,
  sourceWritesLedgerRow, sourceWritesPlanContext, sourceWritesRequestFingerprint,
  readSourceWritesEvent, type SourceWritesEvent, type SourceWritePrivateItem,
  type SourceWriteCapture, type SourceWritesReadyBody,
} from '../../src/collection/local-source-writes-journal.js';

const at = '2026-10-08T00:00:01.000Z';
const expiresAt = '2026-10-08T00:10:01.000Z';
const fixtures = new URL('../fixtures/mbrs012-source/', import.meta.url);
const manifestSha256 = '5a3621481eb22801c020589b393c3a1ffa32e3d132766ea6e8db6e33fa47714b';
async function ownedFlac(): Promise<Buffer> {
  const raw = await readFile(new URL('manifest.json', fixtures));
  assert.equal(createHash('sha256').update(raw).digest('hex'), manifestSha256);
  const manifest = JSON.parse(raw.toString('utf8')) as { synthetic: boolean; allContentOwned: boolean; realLibraryUsed: boolean; files: { file: string; bytes: number; sha256: string }[] };
  assert.equal(manifest.synthetic, true); assert.equal(manifest.allContentOwned, true); assert.equal(manifest.realLibraryUsed, false);
  const entry = manifest.files.find(v => v.file === 'owned-stereo-fixed-tags.flac'); assert.ok(entry);
  const bytes = await readFile(new URL(entry.file, fixtures));
  assert.equal(bytes.length, entry.bytes); assert.equal(createHash('sha256').update(bytes).digest('hex'), entry.sha256);
  return bytes;
}
function reseal(event: SourceWritesEvent): SourceWritesEvent {
  const { eventHash: _old, ...body } = event;
  return { ...body, eventHash: sourceWritesHash(body) } as SourceWritesEvent;
}
function readyEvent(header: dto.LocalSourceWritesPlan, items: SourceWritePrivateItem[], ready: SourceWritesReadyBody): Extract<SourceWritesEvent, { kind: 'ready' }> {
  ready.itemContextHashes = items.map(v => sourceWritesHash(v.capture));
  const body = { ...ready.frozenHeader, operations: items.map(v => v.operation) };
  const context = sourceWritesPlanContext({ plan: header, items }, ready, expiresAt);
  return sourceWritesEvent({ version: 1 as const, kind: 'ready' as const, eventId: randomUUID(), datasetId: header.datasetId, planId: header.planId, occurredAt: at, ready,
    planHash: sourceWritesHash(body), contextFingerprint: sourceWritesHash(context), readyAt: at, expiresAt, resources: items.length + 3, backupBytes: '1048576' });
}
function projection(header: dto.LocalSourceWritesPlan, items: SourceWritePrivateItem[], event: Extract<SourceWritesEvent, { kind: 'ready' }>): dto.LocalSourceWritesPlan {
  return { ...header, readyAt: at, expiresAt, planHash: event.planHash, contextFingerprint: event.contextFingerprint, state: 'READY', items: items.map(v => v.item),
    resourceSummary: { resources: event.resources, sharedTargets: items.length, backupBytes: event.backupBytes, spaceVerified: true, protection: 'verified' } };
}

async function journalFixture(t: TestContext, options: { count?: number; restored?: boolean; heavy?: boolean } = {}) {
  const f = await catalogFixture(t), count = options.count ?? 1, bytes = await ownedFlac();
  const relative = 'owned-cold.flac', absolute = path.join(f.media, relative); await writeFile(absolute, bytes, { flag: 'wx', mode: 0o600 });
  const fd = await open(absolute, 'r'); let observation: SourceWriteFileObservation;
  try { observation = await observeSourceWriteFile(fd); } finally { await fd.close(); }
  const { prefix: _prefix, ...storedObservation } = observation, fileStat = await stat(absolute, { bigint: true }), parent = await stat(f.media, { bigint: true });
  const store = createLocalSourceWritesStore(f.repository.localCatalog), ownerEpoch = randomUUID(), planId = randomUUID(), originPlanId = randomUUID(), originOperationId = randomUUID();
  const originalArtists = ['原艺人乙 / 别名', '原艺人甲 e\u0301'];
  const backupPath = path.join(f.directory, 'verified-backup.flac'); await copyFile(absolute, backupPath); const backupStat = await stat(backupPath, { bigint: true });
  const items: SourceWritePrivateItem[] = [];
  for (let i = 0; i < count; i++) {
    const itemRelative = count === 1 ? relative : `budget-${i}.flac`;
    const asset = f.repository.localCatalog.registerAsset({ commandId: randomUUID(), libraryRootId: f.root.id, expectedRootRevision: f.root.revision, relative: itemRelative, sha256: observation.sha256, sampleFrames: '48000', timebaseHz: 48000 });
    const track = f.repository.localCatalog.createTrack({ commandId: randomUUID(), assetId: asset.id, segment: null });
    const before = options.heavy ? ['旧'.repeat(512)] : [sourceWriteFieldValues(observation).title![0]!], after = options.heavy ? ['新'.repeat(512)] : ['冷读验证标题'];
    const item: dto.LocalSourceWritesItem = { operationId: randomUUID(), resourceRef: randomUUID(), trackId: track.id, assetId: asset.id, label: `自有合成曲目 ${i + 1}`,
      profile: observation.profile, expectedFileRevision: asset.fileRevision, currentFileRevision: asset.fileRevision, expectedRootRevision: f.root.revision, expectedLocationRevision: asset.locationRevision, expectedSelectionRevision: '1',
      changes: [{ field: 'title', action: 'set', before, after }], artwork: null, state: 'planned', phase: 'PLANNED', backup: { state: 'not-created', bytes: null },
      verification: { audio: 'pending', unselectedMetadata: 'pending', content: 'pending', reread: 'pending' }, issue: null };
    const inverse: SourceWriteCapture['inverse'] = options.restored ? { originPlanId, originOperationId, backup: { path: backupPath, sha256: observation.sha256, bytes: observation.bytes, physical: { dev: String(backupStat.dev), ino: String(backupStat.ino) } }, expectedAfterSha256: observation.sha256, removeTarget: false } : null;
    if (options.restored) {
      item.restoration = { originPlanId, originOperationId, kind: 'restore-audio-file', material: 'verified-backup', expectedOutputSha256: observation.sha256 };
      item.changes = [{ field: 'artist', action: 'set', before: ['单值写后艺人'], after: originalArtists }];
    }
    // 冷核只测试持久协议；真实 FD/完整 Hash 来自自有音频，保护指纹和预算膨胀材料为受控数据，不授 writer 资格。
    const capture: SourceWriteCapture = { root: f.repository.sources.root(f.source.id), asset, track, libraryRoot: f.root, relative: itemRelative, observation: storedObservation,
      attributes: { mode: String(fileStat.mode & 0o7777n), uid: String(fileStat.uid), gid: String(fileStat.gid), proof: process.platform === 'darwin' ? 'MACOS_EMPTY_XATTR_ACL_FLAGS_V1' : 'LINUX_EMPTY_XATTR_ACL_FLAGS_V1' },
      fieldsBefore: { ...sourceWriteFieldValues(observation), ...(options.heavy ? { title: before } : {}), ...(options.restored ? { artist: originalArtists } : {}) }, scan: { jobId: randomUUID(), batchId: randomUUID(), data: '{}' },
      protectionFingerprint: sourceWritesHash({ controlledProtection: i }), storageFingerprint: sourceWritesHash({ controlledStorage: i }), affectedTracks: [track], parentPhysical: { dev: String(parent.dev), ino: String(parent.ino) }, rootObservationFingerprint: sourceWritesHash({ parent: String(parent.ino) }),
      directoryTarget: null, directoryBefore: null, directoryAttributes: null, inverse, sharedSources: [], sourceAbsent: false, recoverySource: null };
    const operation: dto.OrganizerFrozenOperation = { operation_id: item.operationId, kind: 'WRITE_TAGS', root_id: f.root.id, target_asset_id: asset.id, expected_asset_revision: asset.fileRevision, source_relative_path: itemRelative, target_relative_path: itemRelative,
      field_patch: options.restored ? { artists: originalArtists } : { title: after[0]! }, backup_required: true };
    items.push({ item, operation, capture });
  }
  const header: dto.LocalSourceWritesPlan = { version: 1, datasetId: f.datasetId, planId, jobId: randomUUID(), viewRevision: '1', journalSequence: '1', scope: 'SOURCE_FILES', range: 'TAGS', state: 'PREVIEWING', createdAt: '2026-10-08T00:00:00.000Z', readyAt: null, expiresAt: null, policyRevision: '1', planHash: null, contextFingerprint: null,
    journalFingerprint: sourceWritesHash({ planId, empty: true }), summary: '自有来源冷核协议计划', items: [], issues: [], resourceSummary: { resources: 0, sharedTargets: count, backupBytes: null, spaceVerified: false, protection: 'unknown' }, undoOf: options.restored ? originPlanId : null, recoveryOf: null, recoveryChoices: [] };
  const intent: dto.LocalSourceWritesIntent = { kind: 'tags', target: count === 1 ? { mode: 'single', trackId: items[0]!.item.trackId } : { mode: 'batch', trackIds: items.map(v => v.item.trackId) }, fields: { title: { action: 'set', value: options.heavy ? '新'.repeat(512) : '冷读验证标题' } } };
  const command = options.restored ? 'localSourceWrites.undo' as const : 'localSourceWrites.preview' as const;
  const request: dto.PreviewLocalSourceWrites | dto.UndoLocalSourceWrites = options.restored ? { datasetId: f.datasetId, commandId: randomUUID(), planId: originPlanId, expectedViewRevision: '1', operationIds: [originOperationId], journalFingerprint: sourceWritesHash({ originPlanId }) } : { datasetId: f.datasetId, commandId: randomUUID(), intent };
  const receipt: dto.LocalSourceWritesReceipt = { datasetId: f.datasetId, commandId: request.commandId, command, requestFingerprint: sourceWritesRequestFingerprint(command, request), planId, jobId: header.jobId, outcome: 'accepted', policy: null, issue: null };
  const first = sourceWritesEvent({ version: 1 as const, eventId: randomUUID(), datasetId: f.datasetId, planId, occurredAt: at, kind: 'receipt' as const, command, request, requestFingerprint: receipt.requestFingerprint, receipt, header, intent, ownerEpoch, policy: null });
  const ready: SourceWritesReadyBody = { frozenHeader: { created_at: at, scope: 'SOURCE_FILES', root_mapping_revisions: { [f.root.id]: f.root.revision }, conflicts: [], resource_guards: { require_exclusive_asset_lock: true, defer_if_read_lease: true, protect_frozen_sources: true, recheck_at_execution: true } }, ownerEpoch, contextNonce: sourceWritesHash({ nonce: planId }), selectionFingerprint: sourceWritesHash(intent), itemContextHashes: [] };
  if (options.heavy) {
    let padding = 0;
    for (;;) {
      for (const item of items) item.capture.scan.data = JSON.stringify({ controlledBudget: '合'.repeat(padding) });
      const provisional = readyEvent(header, items, ready), context = sourceWritesPlanContext({ plan: header, items }, ready, expiresAt), body = { ...ready.frozenHeader, operations: items.map(v => v.operation) };
      const combined = Buffer.byteLength(JSON.stringify({ body, context, projection: projection(header, items, provisional) }));
      if (combined > dto.LOCAL_SOURCE_WRITES_BUDGET.planBytes) { assert.ok(Buffer.byteLength(JSON.stringify(context)) < dto.LOCAL_SOURCE_WRITES_BUDGET.planBytes); break; }
      padding += 128; assert.ok(padding <= 4096, '预算夹具应在合法单行范围内达到联合上限');
    }
  }
  const prepared = readyEvent(header, items, ready);
  const itemEvents = items.map((value, index) => sourceWritesEvent({ version: 1 as const, eventId: randomUUID(), datasetId: f.datasetId, planId, occurredAt: at, kind: 'item' as const, index, value }));
  for (const event of [first, ...itemEvents, prepared]) assert.ok(dto.localSourceWritesJournalTextWithinBudget(sourceWritesLedgerRow(event), event.kind === 'item' ? 'item' : 'header'));
  assert.ok(dto.isOrganizerFrozenBody({ ...ready.frozenHeader, operations: items.map(v => v.operation) })); assert.ok(dto.isLocalSourceWritesPlan(projection(header, items, prepared)));
  store.transaction(view => { view.append(first); for (const event of itemEvents) view.append(event); if (!options.heavy) view.append(prepared); });
  return { ...f, store, header, items, prepared, originalArtists };
}
type Fixture = Awaited<ReturnType<typeof journalFixture>>;
async function coldCopy(f: Fixture, mutate: (db: DatabaseSync) => void, reject: boolean): Promise<void> {
  const expected = f.store.plan(f.datasetId, f.header.planId).plan.state; f.store.close(); f.repository.close();
  const original = path.join(f.directory, 'collection.sqlite'), copied = path.join(f.directory, `source-cold-${randomUUID()}.sqlite`); await copyFile(original, copied);
  const pristine = createCollectionRepository({ filePath: copied });
  try { assert.equal(createLocalSourceWritesStore(pristine.localCatalog).plan(f.datasetId, f.header.planId).plan.state, expected); } finally { pristine.close(); }
  const db = new DatabaseSync(copied); try { mutate(db); } finally { db.close(); }
  const before = await readFile(copied), reopen = () => { const repository = createCollectionRepository({ filePath: copied }); try { return createLocalSourceWritesStore(repository.localCatalog).plan(f.datasetId, f.header.planId).plan; } finally { repository.close(); } };
  if (reject) assert.throws(reopen); else assert.equal(reopen().state, expected);
  assert.deepEqual(await readFile(copied), before, '冷核不能修写或丢弃失败证据');
}
function rewriteEvents(db: DatabaseSync, mutate: (events: SourceWritesEvent[]) => void): void {
  const rows = db.prepare('SELECT * FROM local_catalog_ledger WHERE operation=? ORDER BY rowid').all(SOURCE_WRITES_OPERATION), events = rows.map(row => readSourceWritesEvent(row));
  mutate(events);
  const trigger = String(db.prepare("SELECT sql FROM sqlite_master WHERE name='local_catalog_ledger_no_update'").get()!.sql); db.exec('DROP TRIGGER local_catalog_ledger_no_update');
  try {
    for (const event of events) {
      const row = sourceWritesLedgerRow(reseal(event));
      db.prepare('UPDATE local_catalog_ledger SET fingerprint=?,request=?,result=?,created_at=? WHERE command_id=?').run(row.fingerprint!, row.request!, row.result!, row.created_at!, row.command_id!);
    }
  } finally { db.exec(trigger); }
}
function rebindReady(events: SourceWritesEvent[]): void {
  const first = events.find((v): v is Extract<SourceWritesEvent, { kind: 'receipt' }> => v.kind === 'receipt'), ready = events.find((v): v is Extract<SourceWritesEvent, { kind: 'ready' }> => v.kind === 'ready'); assert.ok(first?.header); assert.ok(ready);
  const items = events.filter((v): v is Extract<SourceWritesEvent, { kind: 'item' }> => v.kind === 'item').map(v => v.value), recomputed = readyEvent(first.header, items, ready.ready);
  ready.planHash = recomputed.planHash; ready.contextFingerprint = recomputed.contextFingerprint; ready.ready = recomputed.ready;
  assert.ok(dto.isOrganizerFrozenBody({ ...ready.ready.frozenHeader, operations: items.map(v => v.operation) })); assert.ok(dto.isLocalSourceWritesPlan(projection(first.header, items, ready)));
}

test('012 journal 正例：真实自有 FD 捕获经 SQLite 持久与冷核保持 READY 六键正文', async t => {
  const f = await journalFixture(t); assert.equal(f.store.plan(f.datasetId, f.header.planId).plan.state, 'READY');
  assert.equal(Object.keys(f.prepared.ready.frozenHeader).length, 5); assert.equal(Object.keys(f.items[0]!.operation).length, 9);
  await coldCopy(f, () => {}, false);
});
for (const axis of ['operation', 'asset', 'patch', 'root', 'asset-revision'] as const) test(`012 journal 冷 READY 拒绝 ${axis} 正文与公开 item 不符，合法形状和全部 Hash 重算不能绕过映射`, async t => {
  const f = await journalFixture(t);
  await coldCopy(f, db => rewriteEvents(db, events => {
    const item = events.find((v): v is Extract<SourceWritesEvent, { kind: 'item' }> => v.kind === 'item')!, ready = events.find((v): v is Extract<SourceWritesEvent, { kind: 'ready' }> => v.kind === 'ready')!;
    if (axis === 'operation') item.value.operation.operation_id = randomUUID();
    if (axis === 'asset') item.value.operation.target_asset_id = randomUUID();
    if (axis === 'patch') item.value.operation.field_patch.title = '形状合法但未预览的正文标题';
    if (axis === 'root') ready.ready.frozenHeader.root_mapping_revisions[item.value.operation.root_id] = '2';
    if (axis === 'asset-revision') item.value.operation.expected_asset_revision = '2';
    rebindReady(events);
  }), true);
});
test('012 journal 冷 READY 对每行小于64KiB且context单独小于2MiB的100项，仍拒联合2MiB溢出', async t => {
  const f = await journalFixture(t, { count: 100, heavy: true }), body = { ...f.prepared.ready.frozenHeader, operations: f.items.map(v => v.operation) }, context = sourceWritesPlanContext({ plan: f.header, items: f.items }, f.prepared.ready, expiresAt);
  assert.ok(Buffer.byteLength(JSON.stringify({ body, context, projection: projection(f.header, f.items, f.prepared) })) > 2097152);
  assert.ok(Buffer.byteLength(JSON.stringify(context)) < 2097152);
  await coldCopy(f, db => { const row = sourceWritesLedgerRow(f.prepared); db.prepare('INSERT INTO local_catalog_ledger VALUES(?,?,?,?,?,?)').run(row.command_id!, row.fingerprint!, row.operation!, row.request!, row.result!, row.created_at!); }, true);
});
test('012 journal 原artist数组逆向冷读保持原顺序与分解字符；允许阶段进展但不改计划身份', async t => {
  const f = await journalFixture(t, { restored: true });
  assert.deepEqual(f.store.plan(f.datasetId, f.header.planId).plan.items[0]!.changes[0]!.after, f.originalArtists);
  f.store.state(f.datasetId, f.header.planId, 'RUNNING', []);
  const item = structuredClone(f.items[0]!.item); item.phase = 'BACKUP'; item.backup = { state: 'verified', bytes: String(f.items[0]!.capture.observation.bytes) };
  f.store.append(sourceWritesEvent({ version: 1 as const, eventId: randomUUID(), datasetId: f.datasetId, planId: f.header.planId, occurredAt: at, kind: 'phase' as const,
    fact: { operationId: item.operationId, phase: 'BACKUP' as const, backup: path.join(f.directory, 'verified-backup.flac'), quarantine: path.join(f.directory, 'quarantine'), stage: path.join(f.directory, 'stage'), beforeSha256: f.items[0]!.capture.observation.sha256, afterSha256: null }, item }));
  assert.equal(f.store.plan(f.datasetId, f.header.planId).plan.items[0]!.phase, 'BACKUP');
  await coldCopy(f, () => {}, false);
});
for (const axis of ['resource', 'changes', 'origin-operation', 'restoration-output'] as const) test(`012 journal phase 冷核拒绝 ${axis} 不可变身份漂移，旧合法阶段和数据库字节保留`, async t => {
  const restored = axis === 'origin-operation' || axis === 'restoration-output', f = await journalFixture(t, { restored }); f.store.state(f.datasetId, f.header.planId, 'RUNNING', []);
  const item = structuredClone(f.items[0]!.item); item.phase = 'BACKUP'; item.backup = { state: 'verified', bytes: '95996' };
  f.store.append(sourceWritesEvent({ version: 1 as const, eventId: randomUUID(), datasetId: f.datasetId, planId: f.header.planId, occurredAt: at, kind: 'phase' as const,
    fact: { operationId: item.operationId, phase: 'BACKUP' as const, backup: path.join(f.directory, 'verified-backup.flac'), quarantine: path.join(f.directory, 'quarantine'), stage: path.join(f.directory, 'stage'), beforeSha256: f.items[0]!.capture.observation.sha256, afterSha256: null }, item }));
  const validPlan = f.store.plan(f.datasetId, f.header.planId).plan;
  await coldCopy(f, db => rewriteEvents(db, events => {
    const phase = events.find((v): v is Extract<SourceWritesEvent, { kind: 'phase' }> => v.kind === 'phase')!;
    if (axis === 'resource') phase.item.resourceRef = randomUUID();
    if (axis === 'changes') phase.item.changes[0]!.after = ['未确认的新标题'];
    if (axis === 'origin-operation') phase.item.restoration!.originOperationId = randomUUID();
    if (axis === 'restoration-output') phase.item.restoration!.expectedOutputSha256 = sourceWritesHash({ unapprovedBackup: true });
    const proposed = { ...validPlan, items: [phase.item] }; assert.ok(dto.isLocalSourceWritesPlan(proposed), '负例先保持公开形状合法，捕获的是phase身份变化');
  }), true);
});
