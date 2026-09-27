import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { createCollectionRepository } from '../src/collection/repository.js';
import { preparationFixture } from './helpers/preparation-fixture.js';
import * as preparationCoordinator from '../src/recording/preparation-coordinator.js';
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { isPreparationHistory, type MediaLayoutSpec } from '@music-bridge/contracts';
import { copyPreparationFile } from '../src/recording/preparation-files.js';
import { planPreparationZip } from '../src/recording/preparation-export-files.js';
import { createSourceEvidenceService } from '../src/recording/source-evidence.js';
import { DatabaseSync } from 'node:sqlite';
import { createLegacyDatabase, snapshotLegacyDatabase } from './helpers/legacy-schema.js';

test('Preparation 历史初始为空，不把草稿当已导出工作区或自动授权目标目录', t => {
  const repository = createCollectionRepository({ filePath: ':memory:' }); t.after(() => repository.close());
  const draft = repository.drafts.append({ commandId: randomUUID(), fingerprint: 'a'.repeat(64), title: 'Logic 合成草稿', programType: 'compilation', metadata: [{ title: '合成曲目' }] });
  assert.ok('preparations' in repository, 'Preparation 必须进入持久化仓库');
  const store = (repository as unknown as { preparations: { list(draftId: string): unknown; destinations(): unknown } }).preparations;
  assert.deepEqual(store.list(draft.draftId), { draftId: draft.draftId, workspaces: [], jobs: [] });
  assert.deepEqual(store.destinations(), []);
});

// 此断言先证明正式协调器尚未存在，后续测试不以模拟输出替代文件落地。
function factory() { const candidate = preparationCoordinator; assert.equal(typeof candidate.createPreparationCoordinator, 'function', '需要正式 Preparation 协调器'); return candidate.createPreparationCoordinator; }
async function setup(t: test.TestContext, options: { copy?: typeof copyPreparationFile; afterPublish?: () => Promise<void>; beforeCommit?: (action: string) => void } = {}) {
  const create = factory(), f = await preparationFixture(t, options); await f.freeze(); await f.versions.idle();
  const layout = f.versions.list(f.draft.draftId).layouts[0]!;
  const target = path.join(f.directory, 'logic-output'); await mkdir(target);
  const coordinator = create({ store: f.repository.preparations, sourceStore: f.repository.sources, sources: f.sources, ...options });
  t.after(() => coordinator.close());
  const destination = await coordinator.authorize(randomUUID(), target);
  const preview = () => coordinator.preview({ layoutVersionId: layout.id, destinationId: destination.id });
  const start = async () => { const p = await preview(); const request = { commandId: randomUUID(), layoutVersionId: layout.id, destinationId: destination.id, proposalFingerprint: p.proposalFingerprint, userConfirmed: true as const }; return { request, job: await coordinator.start(request) }; };
  return { ...f, coordinator, layout, target, destination, preview, start };
}
test('Preparation 正式协调器从冻结版本生成实际工作副本与谱系，草稿变化不重写历史，回执不重复导出', async t => {
  const f = await setup(t);
  f.repository.drafts.update({ commandId: randomUUID(), draftId: f.draft.draftId, expectedRevision: 1, title: '更改草稿', programType: 'compilation', trackIds: [...f.draft.trackIds].reverse() }, 'c'.repeat(64));
  const proposal = await f.preview(); assert.equal(proposal.trackCount, 3);
  const { request, job } = await f.start(); assert.equal(job.state, 'running'); await f.coordinator.idle();
  const completed = f.coordinator.job(job.id).job!; assert.equal(completed.state, 'completed');
  assert.deepEqual(await f.coordinator.start(request), completed);
  assert.equal((await readdir(f.target)).length, 1);
  const history = f.coordinator.list(f.draft.draftId); assert.equal(isPreparationHistory(history), true); assert.equal(history.workspaces.length, 1); assert.equal(history.workspaces[0]!.executionReady, false);
  assert.ok(!JSON.stringify(history).includes(f.target)); assert.ok(!JSON.stringify(history).includes(f.sourcePath));
  const directory = path.join(f.target, (await readdir(f.target))[0]!);
  const manifestText = await readFile(path.join(directory, 'Manifest.json'), 'utf8'), manifest = JSON.parse(manifestText);
  assert.equal(manifest.layoutVersionId, f.layout.id); assert.equal(manifest.timelineHash, f.layout.timelineHash);
  assert.deepEqual(manifest.plannedTimeline, f.layout.timeline);
  assert.ok(!manifestText.includes(f.sourcePath));
  assert.deepEqual(await readFile(path.join(directory, 'Sources', '001.wav')), await readFile(f.file));
  assert.ok((await readFile(path.join(directory, 'SourceLineage.json'), 'utf8')).includes(f.layout.timeline.sides[0]!.tracks[0]!.sourceBindingId));
  assert.equal((await readFile(path.join(directory, 'README.txt'), 'utf8')).startsWith('Logic 工作副本\n请手动导入 Sources'), true);
  await assert.rejects(f.coordinator.start({ ...request, destinationId: randomUUID() }));
  const db = new DatabaseSync(f.filePath);
  try {
    for (const table of ['preparation_workspaces', 'preparation_ledger']) {
      assert.throws(() => db.exec(`UPDATE ${table} SET ${table === 'preparation_ledger' ? 'result' : 'data'}='{}'`), /immutable/u);
      assert.throws(() => db.exec(`DELETE FROM ${table}`), /immutable/u);
    }
  } finally { db.close(); }
});

test('两盘 Preparation 只复制本盘源与曲单，进度/字节/ZIP 一致且保留完整母版身份', async t => {
  const f = await preparationFixture(t), groupId = randomUUID(), segmentSpecs = [
    { trackIds: f.draft.trackIds.slice(0, 2) }, { trackIds: f.draft.trackIds.slice(2) },
  ];
  const plans = [];
  for (const segmentIndex of [0, 1]) {
    const spec: MediaLayoutSpec = { format: 'cassette', splitAfter: 1, leadInMs: 1000, tailMs: 1000,
      defaultGapMs: 5000, rules: [], compatibility: { confirmed: true, cassetteTypes: ['II'], dat: true },
      distribution: { schemaVersion: 1, groupId, segmentIndex, segmentSpecs } };
    const preview = await f.media.preview({ draftId: f.draft.draftId, spec, page: { offset: 0, limit: 20 } });
    const saved = await f.media.save({ commandId: randomUUID(), draftId: f.draft.draftId,
      expectedDraftRevision: preview.draftRevision, inputFingerprint: preview.inputFingerprint, spec });
    plans.push(await f.media.reserve({ commandId: randomUUID(), planId: saved.id, expectedRevision: saved.revision,
      skuId: preview.candidates.items[0]!.skuId, packaging: 'opened', userConfirmed: true }));
  }
  for (const plan of plans) {
    const proposal = await f.versions.preview({ planId: plan.id, sampleRate: 96000 });
    await f.versions.freeze({ commandId: randomUUID(), planId: plan.id, sampleRate: 96000,
      proposalFingerprint: proposal.proposalFingerprint, userConfirmed: true });
    await f.versions.idle();
  }
  const versions = f.versions.list(f.draft.draftId), layouts = [...versions.layouts].reverse();
  assert.equal(versions.masters.length, 1);
  const target = path.join(f.directory, 'multi-disk-workspaces'); await mkdir(target);
  let copies = 0;
  const coordinator = factory()({ store: f.repository.preparations, sourceStore: f.repository.sources,
    sources: f.sources, copy: async (...args) => { copies++; return copyPreparationFile(...args); } });
  f.registerDependentCleanup(() => coordinator.close());
  const destination = await coordinator.authorize(randomUUID(), target);
  const sourceBytes = versions.masters[0]!.content.tracks[0]!.source.size;
  for (const [index, layout] of layouts.entries()) {
    const proposal = await coordinator.preview({ layoutVersionId: layout.id, destinationId: destination.id });
    const assigned = segmentSpecs[index]!.trackIds;
    assert.equal(proposal.trackCount, assigned.length);
    assert.equal(proposal.bytes, assigned.length * sourceBytes);
    assert.equal(proposal.contentHash, versions.masters[0]!.contentHash);
    const job = await coordinator.start({ commandId: randomUUID(), layoutVersionId: layout.id,
      destinationId: destination.id, proposalFingerprint: proposal.proposalFingerprint, userConfirmed: true });
    await coordinator.idle();
    const completed = coordinator.job(job.id).job!;
    assert.equal(completed.state, 'completed');
    assert.equal(completed.totalTracks, assigned.length);
    assert.equal(completed.completedTracks, assigned.length);
    const privateJob = f.repository.preparations.job(job.id)!, directory = privateJob.owned!.root.path;
    assert.equal((await readdir(path.join(directory, 'Sources'))).length, assigned.length);
    const lineage = JSON.parse(await readFile(path.join(directory, 'SourceLineage.json'), 'utf8')) as { trackId: string }[];
    assert.deepEqual(lineage.map(item => item.trackId), assigned);
    const tracklist = await readFile(path.join(directory, 'Tracklist.tsv'), 'utf8');
    assert.equal(tracklist.trimEnd().split('\n').length, assigned.length + 1);
    for (const title of versions.masters[0]!.content.tracks.filter(track => assigned.includes(track.trackId)).map(track => track.metadata.title))
      assert.ok(tracklist.includes(title));
    const manifest = JSON.parse(await readFile(path.join(directory, 'Manifest.json'), 'utf8'));
    assert.equal(manifest.masterVersionId, versions.masters[0]!.id);
    assert.equal(manifest.contentHash, versions.masters[0]!.contentHash);
    assert.deepEqual(manifest.plannedTimeline, layout.timeline);
    assert.equal((await readFile(path.join(directory, 'README.txt'), 'utf8')).startsWith('Logic 本盘工作副本\n'), true);
    const zip = await planPreparationZip(privateJob, new AbortController().signal);
    assert.equal(zip.entries.filter(entry => entry.name.startsWith('Sources/') && entry.kind === 'file').length, assigned.length);
  }
  assert.equal(copies, f.draft.trackIds.length, '仅复制两盘合计曲目，不重复复制完整母版');
});
test('Preparation 源撤权、取消和磁盘已满不产生已发布工作区', async t => {
  for (const reason of ['revoke', 'cancel', 'disk'] as const) await t.test(reason, async t => {
    let enter!: () => void, release!: () => void, observed: AbortSignal | undefined;
    const entered = new Promise<void>(resolve => { enter = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
    const f = await setup(t, { copy: async (...args) => { observed = args[5]; enter(); await gate; if (reason === 'disk') throw Object.assign(new Error('合成磁盘已满'), { code: 'ENOSPC' }); return copyPreparationFile(...args); } });
    const { job } = await f.start(); await entered;
    try { if (reason === 'revoke') await f.sources.revoke({ commandId: randomUUID(), id: f.root.id }); if (reason === 'cancel') f.coordinator.cancel({ commandId: randomUUID(), id: job.id }); if (reason !== 'disk') assert.equal(observed?.aborted, true); } finally { release(); }
    await f.coordinator.idle(); assert.equal(f.coordinator.list(f.draft.draftId).workspaces.length, 0);
    assert.equal(f.coordinator.job(job.id).job!.failure, reason === 'disk' ? 'DISK_FULL' : reason === 'cancel' ? 'CANCELLED' : 'SOURCE_INVALID');
  });
});

test('Preparation 发布后数据库失败，真正冷启动核验归属及全部 Hash 后补回执，不重新读取源或复制', async t => {
  for (const change of ['intact', 'edited', 'owner', 'revoked'] as const) await t.test(change, async t => {
    let fail = true;
    const f = await setup(t, { beforeCommit: action => { if (fail && action === 'finish-preparation') throw new Error('合成发布后数据库失败'); } });
    const { job, request } = await f.start(); await f.coordinator.idle();
    assert.equal(f.coordinator.job(job.id).job!.state, 'interrupted'); assert.equal(f.coordinator.list(f.draft.draftId).workspaces.length, 0);
    const directory = path.join(f.target, (await readdir(f.target))[0]!);
    if (change === 'edited') await writeFile(path.join(directory, 'Sources', '001.wav'), '编辑后的工作副本');
    if (change === 'owner') await writeFile(path.join(directory, '.musicbridge-owner.json'), '{}');
    fail = false; await f.coordinator.close(); await f.versions.close(); await f.sources.close(); f.repository.close();
    const repository = createCollectionRepository({ filePath: f.filePath }), sources = createSourceEvidenceService({ store: repository.sources, drafts: repository.drafts });
    let copies = 0;
    const coordinator = factory()({ store: repository.preparations, sourceStore: repository.sources, sources, copy: async (...args) => { copies++; return copyPreparationFile(...args); } });
    try {
      if (change === 'revoked') coordinator.revoke({ commandId: randomUUID(), id: f.destination.id });
      await coordinator.idle();
      assert.equal(coordinator.job(job.id).job!.state, change === 'intact' ? 'completed' : 'interrupted');
      assert.equal(coordinator.list(f.draft.draftId).workspaces.length, change === 'intact' ? 1 : 0);
      assert.equal((await coordinator.start(request)).state, change === 'intact' ? 'completed' : 'interrupted');
      assert.equal(copies, 0); assert.equal((await readdir(f.target)).length, 1);
    } finally { await coordinator.close(); await sources.close(); repository.close(); }
  });
});
test('Preparation 复制中退出，冷启动明确中断，原 commandId 不重放写盘', async t => {
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const f = await setup(t, { copy: async (...args) => { enter(); await gate; return copyPreparationFile(...args); } });
  const { job, request } = await f.start(); await entered;
  const close = f.coordinator.close(); release(); await close;
  await f.versions.close(); await f.sources.close(); f.repository.close();
  const repository = createCollectionRepository({ filePath: f.filePath }), sources = createSourceEvidenceService({ store: repository.sources, drafts: repository.drafts });
  let copies = 0; const coordinator = factory()({ store: repository.preparations, sourceStore: repository.sources, sources, copy: async (...args) => { copies++; return copyPreparationFile(...args); } });
  try { await coordinator.idle(); assert.equal(coordinator.job(job.id).job!.state, 'interrupted'); assert.equal((await coordinator.start(request)).state, 'interrupted'); assert.equal(copies, 0); } finally { await coordinator.close(); await sources.close(); repository.close(); }
});

test('Preparation 目标撤权立即停止复制，旧提案不可继续；撤权回执保持幂等', async t => {
  let enter!: () => void, release!: () => void, signal: AbortSignal | undefined;
  const entered = new Promise<void>(resolve => { enter = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const f = await setup(t, { copy: async (...args) => { signal = args[5]; enter(); await gate; return copyPreparationFile(...args); } });
  const { job } = await f.start(); await entered;
  try {
    const coordinator = f.coordinator as typeof f.coordinator & { revoke(request: { commandId: string; id: string }): unknown };
    assert.equal(typeof coordinator.revoke, 'function', '目标目录也必须可撤权');
    const request = { commandId: randomUUID(), id: f.destination.id }, result = coordinator.revoke(request);
    assert.deepEqual(coordinator.revoke(request), result); assert.equal(signal?.aborted, true);
    await assert.rejects(f.preview());
  } finally { release(); await f.coordinator.idle(); }
  assert.equal(f.coordinator.job(job.id).job!.failure, 'DESTINATION_INVALID'); assert.equal(f.coordinator.list(f.draft.draftId).workspaces.length, 0);
});
test('Preparation 发布前后来回置换源或输出不能产生完成回执', async t => {
  for (const reason of ['source', 'output'] as const) await t.test(reason, async t => {
    let f: Awaited<ReturnType<typeof setup>>;
    f = await setup(t, { afterPublish: async () => { const directory = path.join(f.target, (await readdir(f.target))[0]!); await writeFile(reason === 'source' ? f.file : path.join(directory, 'Sources', '001.wav'), '合成身份漂移'); } });
    const { job } = await f.start(); await f.coordinator.idle();
    assert.notEqual(f.coordinator.job(job.id).job!.state, 'completed'); assert.equal(f.coordinator.list(f.draft.draftId).workspaces.length, 0);
  });
});
test('Preparation 目标在导出中被授权为 Source Root 后停止后续写盘', async t => {
  let copies = 0, f: Awaited<ReturnType<typeof setup>>;
  f = await setup(t, { copy: async (...args) => { const result = await copyPreparationFile(...args); if (++copies === 1) await f.sources.authorize(randomUUID(), args[0].root.path); return result; } });
  const { job } = await f.start(); await f.coordinator.idle();
  assert.equal(copies, 1); assert.equal(f.coordinator.list(f.draft.draftId).workspaces.length, 0); assert.equal(f.coordinator.job(job.id).job!.failure, 'DESTINATION_INVALID');
});
test('Preparation schema 8 迁移失败完整回滚，重开后母版历史不变', async t => {
  const f = await preparationFixture(t); await f.freeze(); await f.versions.idle(); const history = f.repository.versions.list(f.draft.draftId);
  const page = { offset: 0, limit: 20 }, stock = f.repository.list(page), draft = f.repository.drafts.detail(f.draft.draftId);
  await f.versions.close(); await f.sources.close(); f.repository.close();
  const legacyPath = path.join(f.directory, 'legacy-v8.sqlite');
  createLegacyDatabase(legacyPath, 8, f.filePath);
  const before = snapshotLegacyDatabase(legacyPath, 8);
  assert.equal(before.version, 8);
  assert.equal(before.schema.some(row => row.name === 'preparation_workspaces'), false);
  for (const table of ['master_versions', 'layout_versions', 'inventory_lots', 'physical_copies'])
    assert.ok(before.rows.find(([name]) => name === table)![1].length > 0, `${table} 必须含合成旧数据`);
  let reached = 0;
  const failing = createCollectionRepository({ filePath: legacyPath, beforeCommit: action => { if (action === 'migrate-preparation') { reached++; throw new Error('合成迁移失败'); } } });
  assert.throws(() => failing.preparations.list(f.draft.draftId)); failing.close();
  assert.equal(reached, 1, '必须抵达目标迁移 hook');
  assert.deepEqual(snapshotLegacyDatabase(legacyPath, 8), before, '失败后旧 schema、逐表数据和版本必须完整回滚');
  const reopened = createCollectionRepository({ filePath: legacyPath });
  try {
    assert.deepEqual(reopened.versions.list(f.draft.draftId), history);
    assert.deepEqual(reopened.preparations.list(f.draft.draftId).workspaces, []);
    assert.deepEqual(reopened.list(page), stock);
    assert.deepEqual(reopened.drafts.detail(f.draft.draftId), draft);
  } finally { reopened.close(); }
});
test('Preparation 后台失败写回也遇到短暂数据库失败时保留回执，不产生未处理拒绝', async t => {
  let fail = true;
  const f = await setup(t, { beforeCommit: action => { if (fail && ['progress-preparation','fail-preparation'].includes(action)) throw new Error('合成数据库暂时不可写'); } });
  const { job } = await f.start(); await f.coordinator.idle();
  fail = false;
  assert.equal(f.coordinator.job(job.id).job!.state, 'failed'); assert.equal(f.coordinator.list(f.draft.draftId).workspaces.length, 0);
});
test('Preparation Finder 上下文只允许已完成且仍获授权的工作区，副本编辑不修改冻结历史', async t => {
  const f = await setup(t), { job } = await f.start(); await f.coordinator.idle();
  const coordinator = f.coordinator as typeof f.coordinator & { context(id: string): Promise<{ absolutePath: string }> };
  assert.equal(typeof coordinator.context, 'function', 'Main 需要按工作区 ID 获取受限上下文');
  const context = await coordinator.context(job.id);
  assert.equal(context.absolutePath, path.join(f.target, (await readdir(f.target))[0]!));
  const history = coordinator.list(f.draft.draftId);
  await writeFile(path.join(context.absolutePath, 'Sources', '001.wav'), '用户编辑');
  assert.deepEqual(await coordinator.context(job.id), context);
  assert.deepEqual(coordinator.list(f.draft.draftId), history);
  await assert.rejects(coordinator.context(randomUUID()));
  coordinator.revoke({ commandId: randomUUID(), id: f.destination.id });
  await assert.rejects(coordinator.context(job.id));
});
test('Preparation 未接受的原生目录和过期源请求明确拒绝，不留下可重放任务或模糊回执', async t => {
  const f = await setup(t);
  await assert.rejects(f.coordinator.authorize(randomUUID(), f.sourcePath), { code: 'BAD_REQUEST' });
  const proposal = await f.preview(), request = { commandId: randomUUID(), layoutVersionId: f.layout.id, destinationId: f.destination.id, proposalFingerprint: proposal.proposalFingerprint, userConfirmed: true as const };
  await writeFile(f.file, '合成过期源');
  await assert.rejects(f.coordinator.start(request), { code: 'BAD_REQUEST' });
  assert.equal(f.coordinator.job(request.commandId).job, null);
});
