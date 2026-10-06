import { rebuildLegacySchema } from './helpers/rebuild-legacy-schema.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createCollectionRepository } from '../src/collection/repository.js';
import { authorizeSourceDirectory } from '../src/recording/source-files.js';
import { readBackupIndex } from '../src/recording/backup-index.js';
import { isolateRestoredDatabase, verifyRestoredDatabaseIsolation } from '../src/recording/restore-database.js';

async function fixture(t: test.TestContext, beforeCommit?: (action: string) => void) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'musicbridge-workspace-'));
  const filePath = path.join(directory, 'collection.sqlite');
  const repository = createCollectionRepository({ filePath, ...(beforeCommit ? { beforeCommit } : {}) });
  t.after(async () => { repository.close(); await rm(directory, { recursive: true, force: true }); });
  return { directory, filePath, repository };
}
function draft(repository: ReturnType<typeof createCollectionRepository>) {
  const created = repository.drafts.append({ commandId: randomUUID(), fingerprint: 'a'.repeat(64), title: '工作台合成草稿', programType: 'compilation', metadata: [{ title: '合成曲目', durationMs: 180000 }] });
  return repository.drafts.detail(created.draftId);
}
function mediaPlan(repository: ReturnType<typeof createCollectionRepository>, draftId: string) {
  const current = repository.drafts.detail(draftId);
  const input = { draftId, revision: current.revision, identity: repository.media.inputIdentity(draftId), fingerprint: 'b'.repeat(64), tracks: current.tracks.map(track => ({ trackId: track.id, durationMs: track.metadata.durationMs!, basis: 'roon-estimate' as const })), basis: 'roon-estimate' as const };
  const spec = { format: 'cassette' as const, splitAfter: 1, leadInMs: 0, tailMs: 0, defaultGapMs: 5000, rules: [], compatibility: { confirmed: true, cassetteTypes: ['II' as const], dat: false } };
  return repository.media.save({ commandId: randomUUID(), draftId, expectedDraftRevision: current.revision, inputFingerprint: input.fingerprint, spec }, input);
}

test('工作台冷启保留同一草稿的选择与位置，CAS、命令回执及旧规划失效不改选', async t => {
  const { filePath, repository } = await fixture(t);
  const current = draft(repository), plan = mediaPlan(repository, current.id);
  assert.equal(repository.workspace.get(current.id), null);
  const firstRequest = { commandId: randomUUID(), draftId: current.id, expectedDraftRevision: 1, expectedContextRevision: 0, selection: { planId: plan.id }, pagePosition: 'media' as const };
  const first = repository.workspace.put(firstRequest);
  assert.equal(first.contextRevision, 1);
  assert.deepEqual(repository.workspace.put(firstRequest), first);
  assert.throws(() => repository.workspace.put({ ...firstRequest, pagePosition: 'source' }), /同一操作编号/u);
  assert.throws(() => repository.workspace.put({ ...firstRequest, commandId: randomUUID() }), /工作台已在其他窗口改变/u);
  repository.close();
  const reopened = createCollectionRepository({ filePath });
  try {
    assert.deepEqual(reopened.workspace.get(current.id), first);
    reopened.drafts.update({ commandId: randomUUID(), draftId: current.id, expectedRevision: 1, title: '更新标题', programType: 'compilation', trackIds: current.tracks.map(track => track.id) }, 'c'.repeat(64));
    const second = reopened.workspace.put({ commandId: randomUUID(), draftId: current.id, expectedDraftRevision: reopened.drafts.detail(current.id).revision, expectedContextRevision: 1, selection: { planId: plan.id }, pagePosition: 'source' });
    assert.equal(second.selection.planId, plan.id);
    assert.ok(second.staleReasons.some(item => item.field === 'planId' && item.reason === 'plan-changed'));
    assert.equal(second.pagePosition, 'source');
  } finally { reopened.close(); }
});

test('工作台提交前故障回滚上下文与回执，原命令可安全重试', async t => {
  let fail = false;
  const { filePath, repository } = await fixture(t, action => { if (fail && action === 'put-recording-workspace-context') throw new Error('合成提交故障'); });
  const current = draft(repository), request = { commandId: randomUUID(), draftId: current.id, expectedDraftRevision: 1, expectedContextRevision: 0, selection: {}, pagePosition: 'workbench' as const };
  fail = true;
  assert.throws(() => repository.workspace.put(request));
  assert.equal(repository.workspace.get(current.id), null);
  const db = new DatabaseSync(filePath, { readOnly: true });
  try { assert.equal(db.prepare('SELECT COUNT(*) n FROM recording_workspace_ledger').get()?.n, 0); } finally { db.close(); }
  fail = false;
  assert.equal(repository.workspace.put(request).contextRevision, 1);
});

test('不存在的实体 ID 不能写入工作台；失效但仍存在的 ID 可保留并安全冷启', async t => {
  const { filePath, repository } = await fixture(t);
  const current = draft(repository);
  const initial = repository.workspace.put({ commandId: randomUUID(), draftId: current.id, expectedDraftRevision: 1,
    expectedContextRevision: 0, selection: {}, pagePosition: 'workbench' });
  const missing = { commandId: randomUUID(), draftId: current.id, expectedDraftRevision: 1,
    expectedContextRevision: 1, selection: { selectedPhysicalId: 'MB-C-99999' }, pagePosition: 'media' as const };
  assert.throws(() => repository.workspace.put(missing), /实体副本不存在/u);
  assert.deepEqual(repository.workspace.get(current.id), initial);
  const db = new DatabaseSync(filePath, { readOnly: true });
  try { assert.equal(db.prepare('SELECT COUNT(*) n FROM recording_workspace_ledger').get()?.n, 1); }
  finally { db.close(); }
  const stock = repository.receive({ commandId: randomUUID(), model: { brand: 'TDK', name: 'SA', edition: '1990', year: 1990,
    format: 'cassette', tapeType: 'II', identification: 'verified' }, lengthMinutes: 90,
    quantities: { sealedBlank: 1, openedBlank: 0, legacyUsed: 0, unclassified: 0 } });
  const copy = repository.materialize({ commandId: randomUUID(), lotId: stock.lotId!, bucket: 'sealedBlank', action: 'open' });
  repository.updateCopy({ commandId: randomUUID(), physicalId: copy.physicalId!, expectedRevision: 1, action: 'mark-unavailable' });
  const saved = repository.workspace.put({ ...missing, commandId: randomUUID(), selection: { selectedPhysicalId: copy.physicalId! } });
  assert.equal(saved.contextRevision, 2);
  assert.ok(saved.staleReasons.some(item => item.field === 'selectedPhysicalId' && item.reason === 'copy-unavailable'));
  repository.close();
  const reopened = createCollectionRepository({ filePath });
  try { assert.deepEqual(reopened.workspace.get(current.id), saved); }
  finally { reopened.close(); }
});

test('schema21隔离恢复后正式迁移到30；schema30备份回读上下文并拒绝损坏选择', async t => {
  const { directory, filePath, repository } = await fixture(t);
  const current = draft(repository);
  repository.close();
  const old = new DatabaseSync(filePath);
  try { rebuildLegacySchema(old, 21); }
  finally { old.close(); }
  const oldBytes = await readFile(filePath);
  readBackupIndex(filePath);
  assert.deepEqual(await readFile(filePath), oldBytes, '旧备份只读检查不可迁移原件');
  isolateRestoredDatabase(filePath); verifyRestoredDatabaseIsolation(filePath);
  const migrated = createCollectionRepository({ filePath });
  try {
    assert.equal(migrated.workspace.get(current.id), null);
    const context = migrated.workspace.put({ commandId: randomUUID(), draftId: current.id, expectedDraftRevision: 1, expectedContextRevision: 0, selection: {}, pagePosition: 'workbench' });
    assert.equal(context.contextRevision, 1);
    const destination = path.join(directory, 'backup'); await mkdir(destination);
    const snapshot = await migrated.backupSnapshot({ ...await authorizeSourceDirectory(destination), id: randomUUID() });
    assert.equal(snapshot.schemaVersion, 32);
    const copy = path.join(destination, 'collection.sqlite');
    readBackupIndex(copy); isolateRestoredDatabase(copy); verifyRestoredDatabaseIsolation(copy);
    const restored = createCollectionRepository({ filePath: copy });
    try { assert.deepEqual(restored.workspace.get(current.id), context); } finally { restored.close(); }
    const damaged = new DatabaseSync(copy);
    try { damaged.prepare('UPDATE recording_workspace_contexts SET selection=? WHERE draft_id=?').run('{', current.id); }
    finally { damaged.close(); }
    const bytes = await readFile(copy);
    assert.throws(() => readBackupIndex(copy));
    assert.deepEqual(await readFile(copy), bytes, '损坏备份的只读拒绝不修改证据');
  } finally { migrated.close(); }
});

test('跨草稿选择和回执损坏在冷启时拒绝，不把错误读取当空上下文', async t => {
  const { filePath, repository } = await fixture(t);
  const first = draft(repository), second = repository.drafts.append({ commandId: randomUUID(), fingerprint: 'd'.repeat(64), title: '另一个草稿', programType: 'compilation', metadata: [{ title: '另一曲目', durationMs: 180000 }] });
  const otherPlan = mediaPlan(repository, second.draftId);
  const request = { commandId: randomUUID(), draftId: first.id, expectedDraftRevision: 1, expectedContextRevision: 0, selection: {}, pagePosition: 'workbench' as const };
  repository.workspace.put(request);
  assert.throws(() => repository.workspace.put({ ...request, commandId: randomUUID(), expectedContextRevision: 1, selection: { planId: otherPlan.id } }), /不属于当前草稿/u);
  repository.close();
  const db = new DatabaseSync(filePath);
  try { db.prepare('UPDATE recording_workspace_contexts SET selection=? WHERE draft_id=?').run(JSON.stringify({ planId: otherPlan.id }), first.id); }
  finally { db.close(); }
  const reopened = createCollectionRepository({ filePath });
  try { assert.throws(() => reopened.workspace.get(first.id), /库存暂时不可用/u); }
  finally { reopened.close(); }
});
