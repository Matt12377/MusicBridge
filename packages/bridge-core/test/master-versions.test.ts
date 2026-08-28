import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { createCollectionRepository } from '../src/collection/repository.js';

test('冻结版本初始为空；读取历史不会把草稿或预留自动升级为母版', t => {
  const repository = createCollectionRepository({ filePath: ':memory:' });
  t.after(() => repository.close());
  const draft = repository.drafts.append({ commandId: randomUUID(), fingerprint: 'a'.repeat(64), title: '版本合成草稿', programType: 'compilation', metadata: [{ title: '曲目', durationMs: 1000 }] });
  assert.ok('versions' in repository, '不可变版本需要进入正式数据库');
  const versions = (repository as unknown as { versions: { list(draftId: string): unknown } }).versions;
  assert.deepEqual(versions.list(draft.draftId), { draftId: draft.draftId, masters: [], layouts: [], jobs: [] });
  assert.equal(repository.drafts.detail(draft.draftId).status, 'draft');
});

import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createSourceEvidenceService } from '../src/recording/source-evidence.js';
import { createMediaPlanningCoordinator } from '../src/recording/media-coordinator.js';
import { probeReadonlySource } from '../src/recording/source-files.js';
import { mediaFingerprint } from '../src/recording/media-store.js';
import { isVersionProposal, isVersionHistory, type MediaLayoutSpec } from '@music-bridge/contracts';
const page = { offset: 0, limit: 20 };
const spec: MediaLayoutSpec = { format: 'cassette', splitAfter: 2, leadInMs: 1000, tailMs: 1000, defaultGapMs: 5000, rules: [], compatibility: { confirmed: true, cassetteTypes: ['II'], dat: true } };
function audio() {
  const b = Buffer.alloc(44 + 44101 * 4); b.write('RIFF'); b.writeUInt32LE(b.length - 8, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(2, 22); b.writeUInt32LE(44100, 24); b.writeUInt32LE(176400, 28); b.writeUInt16LE(4, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(b.length - 44, 40); return b;
}
async function fixture(t: test.TestContext, options: { probe?: typeof probeReadonlySource; beforeCommit?: (action: string) => void } = {}) {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'musicbridge-version-'))), sourcePath = path.join(directory, 'private-source');
  await mkdir(sourcePath); const file = path.join(sourcePath, 'fixture.wav'); await writeFile(file, audio());
  const filePath = path.join(directory, 'collection.sqlite');
  const repository = createCollectionRepository({ filePath, ...(options.beforeCommit ? { beforeCommit: options.beforeCommit } : {}) });
  const sources = createSourceEvidenceService({ store: repository.sources, drafts: repository.drafts });
  const draft = repository.drafts.append({ commandId: randomUUID(), fingerprint: 'b'.repeat(64), title: '版本合成草稿', programType: 'compilation', metadata: [1,2,3].map(i => ({ title: `合成曲目 ${i}` })) });
  const root = await sources.authorize(randomUUID(), sourcePath);
  for (const trackId of draft.trackIds) {
    const job = sources.start({ commandId: randomUUID(), draftId: draft.draftId, trackId, rootId: root.id, acquisition: 'userFileBind' }, file);
    await sources.idle(); assert.equal(sources.job(job.id).job?.state, 'completed');
    const binding = repository.sources.linked(draft.draftId, trackId)!;
    await sources.confirm({ commandId: randomUUID(), id: binding.id, draftId: draft.draftId, trackId, userConfirmed: true });
  }
  repository.receive({ commandId: randomUUID(), model: { brand: 'TDK', name: 'SA', edition: '合成', year: 1990, format: 'cassette', tapeType: 'II', identification: 'verified' }, lengthMinutes: 60, quantities: { openedBlank: 3, sealedBlank: 0, legacyUsed: 0, unclassified: 0 } });
  const media = createMediaPlanningCoordinator({ store: repository.media, drafts: repository.drafts, sources });
  const preview = await media.preview({ draftId: draft.draftId, spec, page });
  const saved = await media.save({ commandId: randomUUID(), draftId: draft.draftId, expectedDraftRevision: preview.draftRevision, inputFingerprint: preview.inputFingerprint, spec });
  const plan = await media.reserve({ commandId: randomUUID(), planId: saved.id, expectedRevision: saved.revision, skuId: preview.candidates.items[0]!.skuId, packaging: 'opened', userConfirmed: true });
  const { createMasterVersionsCoordinator } = await import('../src/recording/versions-coordinator.js');
  const versions = createMasterVersionsCoordinator({ store: repository.versions, mediaStore: repository.media, media, drafts: repository.drafts, sourceStore: repository.sources, sources, ...(options.probe ? { probe: options.probe } : {}) });
  t.after(async () => { await versions.close(); await sources.close(); repository.close(); await rm(directory, { recursive: true, force: true }); });
  const proposal = () => versions.preview({ planId: plan.id, sampleRate: 96000 });
  const freeze = async () => { const p = await proposal(); return versions.freeze({ commandId: randomUUID(), planId: plan.id, sampleRate: 96000, proposalFingerprint: p.proposalFingerprint, userConfirmed: true }); };
  return { repository, sources, media, versions, draft, plan, proposal, freeze, directory, sourcePath, file, filePath, root };
}
test('完整复核实际合成源后原子冻结；重试幂等，历史不随草稿改变且不可 SQL 覆写或删除', async t => {
  let probes = 0; const f = await fixture(t, { probe: async (...args) => { probes++; return probeReadonlySource(...args); } });
  const proposal = await f.proposal(); assert.equal(proposal.masterAction, 'create'); assert.equal(isVersionProposal(proposal), true);
  assert.equal(f.versions.list(f.draft.draftId).masters.length, 0);
  const request = { commandId: randomUUID(), planId: f.plan.id, sampleRate: 96000, proposalFingerprint: proposal.proposalFingerprint, userConfirmed: true as const };
  assert.equal((await f.versions.freeze(request)).state, 'running'); await f.versions.idle();
  const completed = f.versions.job(request.commandId).job!; assert.equal(completed.state, 'completed'); assert.equal(probes, 3);
  assert.deepEqual(await f.versions.freeze(request), completed); assert.equal(probes, 3);
  await assert.rejects(f.versions.freeze({ ...request, sampleRate: 48000 }));
  const history = f.versions.list(f.draft.draftId); assert.equal(isVersionHistory(history), true); assert.equal(history.masters.length, 1); assert.equal(history.layouts.length, 1);
  assert.equal(history.layouts[0]!.masterVersionId, history.masters[0]!.id); assert.equal(history.layouts[0]!.executionReady, false);
  assert.ok(!JSON.stringify(history).includes(f.sourcePath));
  f.repository.drafts.update({ commandId: randomUUID(), draftId: f.draft.draftId, expectedRevision: 1, title: '改名并反转', programType: 'compilation', trackIds: [...f.draft.trackIds].reverse() }, 'c'.repeat(64));
  assert.deepEqual(f.versions.list(f.draft.draftId).masters, history.masters);
  const db = new DatabaseSync(f.filePath); try {
    for (const table of ['master_versions', 'layout_versions', 'version_ledger']) { assert.throws(() => db.exec(`UPDATE ${table} SET ${table === 'version_ledger' ? 'result' : 'data'}='{}'`), /immutable/u); assert.throws(() => db.exec(`DELETE FROM ${table}`), /immutable/u); }
  } finally { db.close(); }
  assert.deepEqual(await readFile(f.file), audio());
});
test('D-02 分面变化新建 Layout 并复用 Master；D-03 改曲序提出新母版并保留谱系', async t => {
  const f = await fixture(t); await f.freeze(); await f.versions.idle(); const first = f.versions.list(f.draft.draftId);
  async function save(nextSpec: MediaLayoutSpec) { const current = await f.media.detail(f.plan.id), preview = await f.media.preview({ draftId: f.draft.draftId, spec: nextSpec, page }); return f.media.save({ commandId: randomUUID(), draftId: f.draft.draftId, expectedDraftRevision: preview.draftRevision, inputFingerprint: preview.inputFingerprint, spec: nextSpec, planId: f.plan.id, expectedRevision: current.revision }); }
  await save({ ...spec, splitAfter: 1 }); const reused = await f.proposal(); assert.equal(reused.masterAction, 'reuse'); assert.equal(reused.existingMasterId, first.masters[0]!.id);
  await f.freeze(); await f.versions.idle(); const second = f.versions.list(f.draft.draftId); assert.equal(second.masters.length, 1); assert.equal(second.layouts.length, 2); assert.equal(second.layouts[0]!.parentId, first.layouts[0]!.id);
  f.repository.drafts.update({ commandId: randomUUID(), draftId: f.draft.draftId, expectedRevision: 1, title: '新曲序', programType: 'compilation', trackIds: [...f.draft.trackIds].reverse() }, 'c'.repeat(64));
  await assert.rejects(f.proposal()); await save({ ...spec, splitAfter: 1 }); const changed = await f.proposal(); assert.equal(changed.masterAction, 'create');
  await f.freeze(); await f.versions.idle(); const third = f.versions.list(f.draft.draftId); assert.equal(third.masters.length, 2); assert.equal(third.masters[0]!.parentId, first.masters[0]!.id);
  assert.deepEqual(third.masters[1], first.masters[0]);
});
test('冻结复核期间撤权、内容变化、草稿变化、取消预留和取消任务都不能留下半个版本', async t => {
  for (const reason of ['revoke', 'file', 'draft', 'release', 'cancel'] as const) await t.test(reason, async t => {
    let observedSignal: AbortSignal | undefined;
    let release!: () => void, entered!: () => void; const gate = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
    const f = await fixture(t, { probe: async (...args) => { observedSignal = args[2]; const evidence = await probeReadonlySource(...args); entered(); await gate; return evidence; } });
    const job = await f.freeze(); await started;
    try {
    if (reason === 'revoke') { await f.sources.revoke({ commandId: randomUUID(), id: f.root.id }); assert.equal(observedSignal?.aborted, true, '撤权必须通知仍在读取的冻结任务停止'); }
    if (reason === 'file') { const changed = audio(); changed[44] = 1; await writeFile(f.file, changed); }
    if (reason === 'draft') f.repository.drafts.update({ commandId: randomUUID(), draftId: f.draft.draftId, expectedRevision: 1, title: '变化', programType: 'compilation', trackIds: [...f.draft.trackIds].reverse() }, 'c'.repeat(64));
    if (reason === 'release') await f.media.release({ commandId: randomUUID(), planId: f.plan.id, expectedRevision: f.plan.revision, userConfirmed: true });
    if (reason === 'cancel') f.versions.cancel({ commandId: randomUUID(), id: job.id });
    } finally { release(); }
    await f.versions.idle(); assert.equal(f.versions.list(f.draft.draftId).masters.length, 0); assert.equal(f.versions.list(f.draft.draftId).layouts.length, 0);
    assert.equal(f.versions.job(job.id).job?.state, reason === 'cancel' ? 'cancelled' : 'failed');
    assert.equal(f.versions.job(job.id).job?.failure, reason === 'cancel' ? 'CANCELLED' : ['revoke','file'].includes(reason) ? 'SOURCE_INVALID' : 'INPUT_CHANGED');
  });
});
test('提交失败整体回滚，后台任务记失败；重启将未完成任务中断而不重放', async t => {
  let fail = true; const f = await fixture(t, { beforeCommit: action => { if (fail && action === 'freeze-master-versions') throw new Error('合成提交失败'); } });
  const job = await f.freeze(); await f.versions.idle(); assert.equal(f.versions.job(job.id).job?.state, 'failed'); assert.equal(f.versions.list(f.draft.draftId).masters.length, 0);
  fail = false; await f.freeze(); await f.versions.idle(); assert.equal(f.versions.list(f.draft.draftId).masters.length, 1);
  await f.versions.close();
  const db = new DatabaseSync(f.filePath); const unfinished = randomUUID(); try { const stored = JSON.parse(String(db.prepare('SELECT data FROM version_jobs LIMIT 1').get()!.data)); stored.public = { id: unfinished, draftId: f.draft.draftId, planId: f.plan.id, state: 'running' }; stored.request.commandId = unfinished; db.prepare('INSERT INTO version_jobs VALUES (?,?,?)').run(unfinished, f.draft.draftId, JSON.stringify(stored)); db.prepare('INSERT INTO version_ledger VALUES (?,?,?,?)').run(unfinished, mediaFingerprint(['freeze', stored.request]), unfinished, new Date().toISOString()); } finally { db.close(); }
  await f.sources.close(); f.repository.close();
  const reopened = createCollectionRepository({ filePath: f.filePath }), sources = createSourceEvidenceService({ store: reopened.sources, drafts: reopened.drafts });
  const media = createMediaPlanningCoordinator({ store: reopened.media, drafts: reopened.drafts, sources });
  const { createMasterVersionsCoordinator } = await import('../src/recording/versions-coordinator.js');
  let probes = 0;
  const resumed = createMasterVersionsCoordinator({ store: reopened.versions, mediaStore: reopened.media, media, drafts: reopened.drafts, sourceStore: reopened.sources, sources, probe: async (...args) => { probes++; return probeReadonlySource(...args); } });
  try {
    assert.equal(resumed.job(unfinished).job?.state, 'interrupted');
    assert.equal((await resumed.freeze(reopened.versions.job(unfinished)!.request)).state, 'interrupted');
    await resumed.idle(); assert.equal(probes, 0); assert.equal(resumed.list(f.draft.draftId).masters.length, 1);
  } finally { await resumed.close(); await sources.close(); reopened.close(); }
});

test('版本迁移失败回滚既有 schema 与数据，重试成功；新连接读到完全相同的冻结历史', async t => {
  const f = await fixture(t); await f.freeze(); await f.versions.idle(); const history = f.versions.list(f.draft.draftId);
  const reopened = createCollectionRepository({ filePath: f.filePath });
  try { assert.deepEqual(reopened.versions.list(f.draft.draftId), history); } finally { reopened.close(); }
  const legacyPath = path.join(f.directory, 'legacy.sqlite'), db = new DatabaseSync(legacyPath);
  try {
    const current = new DatabaseSync(f.filePath); try { const schema = current.prepare("SELECT sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE '%version%' AND name NOT LIKE 'preparation_%' AND name NOT LIKE 'prepared_%' AND name NOT LIKE 'recording_%' AND name NOT LIKE 'execution_%' AND name NOT LIKE 'archive_%' AND name NOT LIKE 'sqlite_%' ORDER BY rowid").all(); for (const row of schema) db.exec(String(row.sql)); } finally { current.close(); }
    db.exec('PRAGMA user_version=7');
  } finally { db.close(); }
  const failed = createCollectionRepository({ filePath: legacyPath, beforeCommit: action => { if (action === 'migrate-master-versions') throw new Error('合成迁移失败'); } });
  assert.throws(() => failed.list(page)); failed.close();
  const inspected = new DatabaseSync(legacyPath); try { assert.equal(inspected.prepare('PRAGMA user_version').get()!.user_version, 7); assert.equal(inspected.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name='master_versions'").get()!.n, 0); } finally { inspected.close(); }
  const retried = createCollectionRepository({ filePath: legacyPath }); try { assert.equal(retried.list(page).total, 0); } finally { retried.close(); }
});
test('公开提案与历史拒绝执行就绪伪造、私有路径、帧位置漂移及失联母版', async t => {
  const f = await fixture(t), proposal = await f.proposal(); assert.equal(isVersionProposal(proposal), true);
  assert.equal(isVersionProposal({ ...proposal, executionReady: true }), false);
  assert.equal(isVersionProposal({ ...proposal, path: '/private/audio' }), false);
  const invalid = structuredClone(proposal); invalid.timeline.sides[0]!.tracks[0]!.endFrame++;
  assert.equal(isVersionProposal(invalid), false);
  await f.freeze(); await f.versions.idle(); const history = f.versions.list(f.draft.draftId);
  assert.equal(isVersionHistory({ ...history, masters: [] }), false);
  const tampered = structuredClone(history); tampered.layouts[0]!.reservation.physicalId = 'private/path'; assert.equal(isVersionHistory(tampered), false);
});
