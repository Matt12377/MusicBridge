import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { copyFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { catalogFixture } from '../mbrs006/catalog-fixture.js';
import { createCollectionRepository } from '../../src/collection/repository.js';
import { createLocalOrganizerService, createTestLocalOrganizerService } from '../../src/collection/local-organizer-service.js';
import { createLocalOrganizerStore } from '../../src/collection/local-organizer-store.js';
import { ORGANIZER_JOURNAL, organizerId } from '../../src/collection/local-organizer-journal.js';
import type { LocalOrganizerItem, ConfirmLocalOrganizer, LocalOrganizerPlan } from '@music-bridge/contracts';

const confirmation = (p: LocalOrganizerPlan): ConfirmLocalOrganizer => ({ commandId: randomUUID(), planId: p.planId, expectedRevision: p.revision, scope: p.scope, planHash: p.planHash, contextFingerprint: p.contextFingerprint });
test('011真实SQLite私有副本重复JSON键冷开拒绝，损坏记录和数据库字节保留', async t => {
  const f = await catalogFixture(t), service = createLocalOrganizerService({ repository: f.repository, datasetId: f.datasetId, assertCurrent() {} });
  const plan = await service.preview({ commandId: randomUUID(), scope: 'MB_ONLY', target: { mode: 'single', trackId: f.tracks[0]!.id }, patch: { fields: { title: { action: 'set', value: '合成预览' } } } });
  await service.close(); f.repository.close(); const file = path.join(f.directory, 'tampered.sqlite'); await copyFile(path.join(f.directory, 'collection.sqlite'), file);
  const db = new DatabaseSync(file), trigger = String(db.prepare("SELECT sql FROM sqlite_master WHERE name='local_catalog_ledger_no_update'").get()!.sql);
  const original = String(db.prepare('SELECT request FROM local_catalog_ledger WHERE command_id=?').get(plan.planId)!.request), damaged = '{"version":0,' + original.slice(1);
  db.exec('DROP TRIGGER local_catalog_ledger_no_update'); db.prepare('UPDATE local_catalog_ledger SET request=? WHERE command_id=?').run(damaged, plan.planId); db.exec(trigger); db.close();
  const before = await readFile(file); assert.throws(() => { const invalid = createCollectionRepository({ filePath: file }); try { invalid.list({ offset: 0, limit: 1 }); } finally { invalid.close(); } }); assert.deepEqual(await readFile(file), before);
  const preserved = new DatabaseSync(file, { readOnly: true }); assert.equal(preserved.prepare('SELECT request FROM local_catalog_ledger WHERE command_id=?').get(plan.planId)!.request, damaged); preserved.close();
});
test('011逐项64KiB预算超限整批回滚，不污染audit证书', async t => {
  const f = await catalogFixture(t), catalog = f.repository.localCatalog, service = createLocalOrganizerService({ repository: f.repository, datasetId: f.datasetId, assertCurrent() {} });
  const editionIds = Array.from({ length: 8 }, () => catalog.createEdition({ commandId: randomUUID(), title: '合成建议', edition: '' }).id);
  const groups = editionIds.map(editionId => ({ editionId, expectedRevision: '1', reason: '理'.repeat(512) }));
  for (const track of f.tracks) { catalog.observeMetadata({ commandId: randomUUID(), trackId: track.id, source: 'synthetic', parserVersion: '011预算', fields: Object.fromEntries(['title', 'artist', 'album', 'year', 'disc', 'track'].map(k => [k, '原'.repeat(512)])) }); catalog.overrideMetadata({ commandId: randomUUID(), trackId: track.id, expectedRevision: null, fields: Object.fromEntries(['title', 'artist', 'album', 'year', 'disc', 'track'].map(k => [k, '旧'.repeat(512)])), annotations: { versionDescription: '旧'.repeat(512), groupingSuggestions: groups } }); }
  const commandId = randomUUID();
  await assert.rejects(() => service.preview({ commandId, scope: 'MB_ONLY', target: { mode: 'batch', trackIds: f.tracks.map(track => track.id) }, patch: { fields: Object.fromEntries(['title', 'artist', 'album', 'year', 'disc', 'track'].map(k => [k, { action: 'set', value: '新'.repeat(512) }])), annotations: { versionDescription: { action: 'set', value: '新'.repeat(512) }, groupingSuggestions: { action: 'set', value: groups } } } }));
  assert.equal(catalog.privateRead(db => db.prepare('SELECT 1 FROM local_catalog_ledger WHERE command_id=?').get(commandId)), undefined);
  // 被拒事务之后正常原作者变更仍可用，certificate没有发布失败事务的计数。
  const safe = await service.preview({ commandId: randomUUID(), scope: 'MB_ONLY', target: { mode: 'single', trackId: f.tracks[0]!.id }, patch: { fields: Object.fromEntries(['title', 'artist', 'album', 'year', 'disc', 'track'].map(k => [k, { action: 'clear' }])), annotations: { versionDescription: { action: 'clear' }, groupingSuggestions: { action: 'clear' } } } });
  assert.equal(safe.state, 'DRAFT'); assert.equal(catalog.privateRead(db => db.prepare('SELECT count(*) n FROM local_catalog_ledger WHERE operation=?').get(ORGANIZER_JOURNAL)!.n), 2);
  await service.close();
});
test('011100项真实目录计划2MiB预算在插入前拒绝，所有逐项历史保持空', async t => {
  const f = await catalogFixture(t), catalog = f.repository.localCatalog, ids: string[] = [];
  const fields = Object.fromEntries(['title', 'artist', 'album', 'year', 'disc', 'track'].map(k => [k, '合'.repeat(512)]));
  for (let i = 0; i < 100; i++) {
    const asset = catalog.registerAsset({ commandId: randomUUID(), libraryRootId: f.root.id, expectedRootRevision: '1', relative: `合成预算${i}.wav`, sha256: null, sampleFrames: null, timebaseHz: null });
    const track = catalog.createTrack({ commandId: randomUUID(), assetId: asset.id, segment: null }); ids.push(track.id);
    catalog.observeMetadata({ commandId: randomUUID(), trackId: track.id, source: 'synthetic', parserVersion: '011总预算', fields }); catalog.overrideMetadata({ commandId: randomUUID(), trackId: track.id, expectedRevision: null, fields });
  }
  const store = createLocalOrganizerStore({ catalog, sources: f.repository.sources, datasetId: f.datasetId, assertCurrent() {} }), request = { commandId: randomUUID(), scope: 'MB_ONLY' as const, target: { mode: 'batch' as const, trackIds: ids }, patch: { fields: { title: { action: 'set' as const, value: '新'.repeat(512) } } } };
  assert.throws(() => store.persistPreview(request, store.capturePreview(request), '2026-10-07T00:00:00.000Z', '2026-10-07T00:15:00.000Z'));
  assert.equal(catalog.privateRead(db => db.prepare('SELECT count(*) n FROM local_catalog_ledger WHERE operation=?').get(ORGANIZER_JOURNAL)!.n), 0);
});
test('011held观察到界返回，迟到结果和关闭不落计划、不自动重发，物理挂起另有容量上限', async t => {
  const f = await catalogFixture(t); let release!: (value: LocalOrganizerItem['sourceObservation']) => void, calls = 0;
  const held = new Promise<LocalOrganizerItem['sourceObservation']>(resolve => { release = resolve; });
  const service = createTestLocalOrganizerService({ repository: f.repository, datasetId: f.datasetId, assertCurrent() {} }, { timeoutMs: 20, observe: async () => { calls++; return held; } });
  const commandId = randomUUID(), began = Date.now(); await assert.rejects(() => service.preview({ commandId, scope: 'MB_ONLY', target: { mode: 'single', trackId: f.tracks[0]!.id }, patch: { fields: { title: { action: 'set', value: '迟到禁止写' } } } }), /SOURCE_OBSERVATION_TIMEOUT/u);
  assert.ok(Date.now() - began < 1000); assert.equal(f.repository.localCatalog.privateRead(db => db.prepare('SELECT 1 FROM local_catalog_ledger WHERE command_id=?').get(commandId)), undefined);
  await service.close(); release({ status: 'unknown', fileSignature: null, permissionMode: null, rootPermissionMode: null, directoryIds: [] }); await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(calls, 1); assert.equal(f.repository.localCatalog.metadata(f.tracks[0]!.id).override, null); assert.equal(f.repository.localCatalog.privateRead(db => db.prepare('SELECT count(*) n FROM local_catalog_ledger WHERE operation=?').get(ORGANIZER_JOURNAL)!.n), 0);
});
test('011确认后的held观察超时只落失败journal，迟到不执行MB override', async t => {
  const f = await catalogFixture(t), options = { repository: f.repository, datasetId: f.datasetId, assertCurrent() {} }, initial = createLocalOrganizerService(options);
  const plan = await initial.preview({ commandId: randomUUID(), scope: 'MB_ONLY', target: { mode: 'single', trackId: f.tracks[0]!.id }, patch: { fields: { title: { action: 'set', value: '迟到确认禁止写' } } } }); await initial.close();
  let calls = 0, release!: (value: LocalOrganizerItem['sourceObservation']) => void;
  const held = new Promise<LocalOrganizerItem['sourceObservation']>(resolve => { release = resolve; });
  const service = createTestLocalOrganizerService(options, { timeoutMs: 20, observe: async () => ++calls === 1 ? plan.items[0]!.sourceObservation : held });
  const result = await service.confirm(confirmation(plan)); assert.equal(result.state, 'FAILED'); assert.equal(result.issue, 'SOURCE_OBSERVATION_TIMEOUT'); assert.equal(f.repository.localCatalog.metadata(f.tracks[0]!.id).override, null);
  await service.close(); release(plan.items[0]!.sourceObservation); await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(f.repository.localCatalog.metadata(f.tracks[0]!.id).override, null); assert.equal(calls, 2);
});
test('011确认后的取消窗口使用当前revision，提交之前取消不写任何override', async t => {
  let phase = false, notifyConfirmed!: () => void;
  const confirmed = new Promise<void>(resolve => { notifyConfirmed = resolve; });
  const f = await catalogFixture(t, action => { if (action === 'local-organizer:confirm') { phase = true; notifyConfirmed(); } });
  const service = createLocalOrganizerService({ repository: f.repository, datasetId: f.datasetId, assertCurrent() {} });
  const plan = await service.preview({ commandId: randomUUID(), scope: 'MB_ONLY', target: { mode: 'single', trackId: f.tracks[0]!.id }, patch: { fields: { title: { action: 'set', value: '取消窗口' } } } });
  const task = service.confirm(confirmation(plan));
  try {
    // 等实际同步确认事件；微任务续行先于下一轮文件观察，不靠轮询次数猜取消窗口。
    await Promise.race([confirmed, task.then(() => undefined)]); assert.equal(phase, true);
    const current = service.get({ planId: plan.planId }); assert.equal(current.state, 'CONFIRMED'); assert.equal(current.revision, '2');
    assert.equal(service.cancel({ commandId: randomUUID(), planId: plan.planId, expectedRevision: current.revision }).state, 'CANCELLED');
    assert.equal((await task).state, 'CANCELLED'); assert.equal(f.repository.localCatalog.metadata(f.tracks[0]!.id).override, null);
  } finally { await service.close(); }
});
test('011过期计划拒执行且确认失败持久，runtime完整patch不受冻结数值映射影响', async t => {
  const f = await catalogFixture(t), store = createLocalOrganizerStore({ catalog: f.repository.localCatalog, sources: f.repository.sources, datasetId: f.datasetId, assertCurrent() {} });
  const request = { commandId: randomUUID(), scope: 'MB_ONLY' as const, target: { mode: 'single' as const, trackId: f.tracks[0]!.id }, patch: { fields: { disc: { action: 'set' as const, value: '侧 A' } } } };
  const plan = store.persistPreview(request, store.capturePreview(request), '2020-01-01T00:00:00.000Z', '2020-01-01T00:15:00.000Z');
  const expired = store.confirm(confirmation(plan), plan.items.map(i => i.sourceObservation), Date.now()); assert.equal(expired.state, 'FAILED'); assert.equal(expired.issue, 'PLAN_EXPIRED'); assert.equal(f.repository.localCatalog.metadata(f.tracks[0]!.id).override, null);
  assert.equal(plan.items[0]!.after.fields.disc, '侧 A'); assert.equal(Object.hasOwn(plan.body.operations[0]!.field_patch, 'disc_number'), false);
  assert.equal(f.repository.localCatalog.privateRead(db => db.prepare('SELECT 1 FROM local_catalog_ledger WHERE command_id=?').get(organizerId(plan.planId, 'operation/0'))), undefined);
});
