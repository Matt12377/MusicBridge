import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { isPreparationZipHistory, isPreparationZipJob, isPreparationZipProposal, isPreparationZipTarget } from '@music-bridge/contracts';
import { preparationFixture } from './helpers/preparation-fixture.js';
import { createPreparationCoordinator } from '../src/recording/preparation-coordinator.js';
import { createPreparationZipCoordinator, type AuthorizePreparationZipTarget } from '../src/recording/preparation-export-coordinator.js';
import { planPreparationZip, preparationZipTempPath, verifyPreparationZipPublication } from '../src/recording/preparation-export-files.js';
import { createPreparationZipStore, preparationZipMigration, preparationZipSessionMigration, revokePreparationZipForRestore, verifyPreparationZipDatabase, verifyPreparationZipSessionDatabase } from '../src/recording/preparation-export-store.js';
import { authorizeSourceDirectory, type RootCapability } from '../src/recording/source-files.js';

function checkpoint() {
  let entered!: () => void, release!: () => void;
  const reached = new Promise<void>(resolve => { entered = resolve; });
  const blocked = new Promise<void>(resolve => { release = resolve; });
  return { reached, release: () => release(), wait: async () => { entered(); await blocked; } };
}

type Hooks = Pick<Parameters<typeof createPreparationZipCoordinator>[0], 'assertDataset' | 'verifyPublication' | 'beforePlan' | 'afterTemp' | 'beforePublish' | 'afterPublish'>;
async function setup(t: TestContext, hooks: Hooks = {}) {
  const f = await preparationFixture(t);
  await f.freeze(); await f.versions.idle();
  const layout = f.versions.list(f.draft.draftId).layouts[0]!;
  const preparation = createPreparationCoordinator({ store: f.repository.preparations, sourceStore: f.repository.sources, sources: f.sources });
  const preparationPath = path.join(f.directory, 'Logic 工作区'); await mkdir(preparationPath);
  const destination = await preparation.authorize(randomUUID(), preparationPath);
  const p = await preparation.preview({ layoutVersionId: layout.id, destinationId: destination.id });
  const started = await preparation.start({ commandId: randomUUID(), layoutVersionId: layout.id, destinationId: destination.id, proposalFingerprint: p.proposalFingerprint, userConfirmed: true });
  await preparation.idle();
  const workspaceId = preparation.job(started.id).job?.workspaceId;
  assert.ok(workspaceId);
  const db = new DatabaseSync(f.filePath, { enableForeignKeyConstraints: true, allowExtension: false });
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='preparation_zip_jobs'").get()) db.exec(preparationZipMigration);
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='preparation_zip_session'").get()) db.exec(preparationZipSessionMigration);
  const store = createPreparationZipStore({ read: fn => fn(db), conflict: message => { throw new Error(message); } });
  const savePath = path.join(f.directory, '另存目标'); await mkdir(savePath);
  const parent: RootCapability = { ...await authorizeSourceDirectory(savePath), id: randomUUID() };
  const datasetId = randomUUID(), scopeId = randomUUID();
  const protectedRoots: RootCapability[] = [];
  const coordinator = createPreparationZipCoordinator({ store, preparations: f.repository.preparations, datasetId, protectedRoots: () => protectedRoots, ...hooks });
  f.registerDependentCleanup(async () => { await coordinator.close(); db.close(); await preparation.close(); });
  const authorize = async (name = '合成工作区.zip', generation = 0) => {
    const input: AuthorizePreparationZipTarget = { targetId: randomUUID(), absolute: path.join(savePath, name), parentPath: savePath, parentDev: parent.dev, parentIno: parent.ino, datasetId, scopeId, generation, expiresAt: new Date(Date.now() + 60_000).toISOString() };
    const target = await coordinator.authorizeTarget(input);
    return { input, target, absolute: input.absolute };
  };
  const begin = async (targetId: string) => {
    const proposal = await coordinator.preview({ workspaceId, targetId });
    const request = { workspaceId, targetId, commandId: randomUUID(), proposalFingerprint: proposal.proposalFingerprint, userConfirmed: true as const };
    const job = await coordinator.start(request);
    return { proposal, request, job };
  };
  return { ...f, preparation, workspaceId, db, store, coordinator, savePath, parent, datasetId, scopeId, protectedRoots, authorize, begin };
}

test('Preparation ZIP 并发与重复关闭共用一次持久撤销，不在已关闭工作库上再写', async t => {
  const f = await setup(t);
  let revocations = 0;
  const revoke = f.store.revokeSession.bind(f.store);
  f.store.revokeSession = epoch => { ++revocations; revoke(epoch); };
  await Promise.all([f.coordinator.close(), f.coordinator.close()]);
  await f.coordinator.close();
  assert.equal(revocations, 1);
});

test('Preparation ZIP 只从已完成工作区生成真实小包，长目标名不影响短私有临时名，历史不泄露路径', async t => {
  const f = await setup(t);
  const longName = `${'中文'.repeat(40)}.zip`;
  const { target, absolute } = await f.authorize(longName);
  assert.equal(target.label, longName);
  const { proposal, request, job } = await f.begin(target.id);
  assert.equal(isPreparationZipProposal(proposal), true);
  assert.equal(proposal.executionReady, false);
  const planned = await planPreparationZip(f.repository.preparations.job(f.workspaceId)!, new AbortController().signal);
  assert.equal(planned.budget.maxEntryBytes, planned.sourceBytes);
  assert.equal(job.state, 'running');
  await f.coordinator.idle();
  const done = (await f.coordinator.job(job.id)).job!;
  assert.equal(isPreparationZipJob(done), true);
  assert.equal(done.state, 'completed');
  assert.equal(done.completedFiles, done.fileCount);
  assert.equal((await f.coordinator.start(request)).state, 'completed');
  assert.deepEqual(await f.coordinator.receipt({ kind: 'start', request }), { status: 'accepted', job: done });
  assert.deepEqual(await f.coordinator.receipt({ kind: 'start', request: { ...request, commandId: randomUUID() } }), { status: 'unknown', job: null });
  await assert.rejects(f.coordinator.receipt({ kind: 'start', request: { ...request, proposalFingerprint: '0'.repeat(64) } }), /同一操作编号/u);
  const cancel = { commandId: randomUUID(), id: job.id };
  assert.deepEqual(await f.coordinator.receipt({ kind: 'cancel', request: cancel }), { status: 'unknown', job: null });
  assert.equal((await f.coordinator.cancel(cancel)).state, 'completed');
  assert.equal((await f.coordinator.receipt({ kind: 'cancel', request: cancel })).job?.id, job.id);
  await assert.rejects(f.coordinator.receipt({ kind: 'cancel', request: { ...cancel, id: randomUUID() } }), /同一操作编号/u);
  const bytes = await readFile(absolute);
  assert.equal(bytes.subarray(0, 4).toString('binary'), 'PK\u0003\u0004');
  assert.equal(bytes.length, done.zipBytes);
  const history = await f.coordinator.list(f.draft.draftId);
  assert.equal(isPreparationZipHistory(history), true);
  assert.equal(history.jobs.length, 1);
  assert.equal(JSON.stringify(history).includes(f.savePath), false);
  const privateJob = f.store.job(job.id)!;
  assert.equal(path.basename(preparationZipTempPath(privateJob.target, job.id)).length < 100, true);
  assert.equal((await readdir(f.savePath)).length, 1);
  verifyPreparationZipDatabase(f.db);
});

test('另存目标授权先符合公开标签长度和规范 ISO 到期时间，不占用失败的目标编号', async t => {
  const f = await setup(t);
  const targetId = randomUUID();
  const expiresAt = new Date(Date.now() + 60_000).toISOString();
  const validName = `${'a'.repeat(236)}.zip`;
  const input: AuthorizePreparationZipTarget = {
    targetId, absolute: path.join(f.savePath, validName), parentPath: f.savePath,
    parentDev: f.parent.dev, parentIno: f.parent.ino, datasetId: f.datasetId,
    scopeId: f.scopeId, generation: 0, expiresAt,
  };
  const overlongName = `${'a'.repeat(237)}.zip`;
  assert.equal(Buffer.byteLength(overlongName) <= 255, true);
  assert.equal(isPreparationZipTarget({ id: targetId, label: overlongName, expiresAt }), false);
  await assert.rejects(f.coordinator.authorizeTarget({ ...input, absolute: path.join(f.savePath, overlongName) }));
  const noncanonicalExpiry = expiresAt.replace('Z', '+00:00');
  assert.equal(isPreparationZipTarget({ id: targetId, label: validName, expiresAt: noncanonicalExpiry }), false);
  await assert.rejects(f.coordinator.authorizeTarget({ ...input, expiresAt: noncanonicalExpiry }));
  const target = await f.coordinator.authorizeTarget(input);
  assert.equal(target.label, validName);
  assert.equal(isPreparationZipTarget(target), true);
});

test('ZIP 已存在的用户目标和工作区内容漂移均阻断发布；授权后新增保护根即时生效', async t => {
  const f = await setup(t);
  const selected = await f.authorize('用户已有.zip');
  const preview = await f.coordinator.preview({ workspaceId: f.workspaceId, targetId: selected.target.id });
  const userBytes = Buffer.from('请勿覆盖'); await writeFile(selected.absolute, userBytes);
  await assert.rejects(f.coordinator.start({ workspaceId: f.workspaceId, targetId: selected.target.id, commandId: randomUUID(), proposalFingerprint: preview.proposalFingerprint, userConfirmed: true }));
  assert.deepEqual(await readFile(selected.absolute), userBytes);
  const drift = await f.authorize('内容漂移.zip');
  const driftProposal = await f.coordinator.preview({ workspaceId: f.workspaceId, targetId: drift.target.id });
  const preparation = f.preparation.job(f.workspaceId).job!;
  assert.equal(preparation.state, 'completed');
  const privatePreparation = f.repository.preparations.job(f.workspaceId)!;
  await writeFile(path.join(privatePreparation.owned!.root.path, privatePreparation.files[0]!.relative), Buffer.from('已改变'));
  await assert.rejects(f.coordinator.start({ workspaceId: f.workspaceId, targetId: drift.target.id, commandId: randomUUID(), proposalFingerprint: driftProposal.proposalFingerprint, userConfirmed: true }));
  await assert.rejects(lstat(drift.absolute), { code: 'ENOENT' });
  const guarded = await f.authorize('后加入保护根.zip');
  f.protectedRoots.push(f.parent);
  await assert.rejects(f.coordinator.preview({ workspaceId: f.workspaceId, targetId: guarded.target.id }));
});

test('预览和启动的长计划在 scope 失效或 close 时取消，且不留下持久任务', async t => {
  await t.test('预览被 scope 关闭', async t => {
    const gate = checkpoint();
    const f = await setup(t, { beforePlan: gate.wait });
    f.registerDependentCleanup(async () => gate.release());
    const selected = await f.authorize('预览取消.zip');
    const pending = f.coordinator.preview({ workspaceId: f.workspaceId, targetId: selected.target.id });
    await gate.reached;
    f.coordinator.invalidateScope(f.scopeId);
    gate.release(); await assert.rejects(pending);
    assert.equal(f.store.recoverable().length, 0);
  });
  await t.test('启动被 close 等待并取消', async t => {
    const gate = checkpoint(); let plans = 0;
    const f = await setup(t, { beforePlan: async () => { if (++plans === 2) await gate.wait(); } });
    f.registerDependentCleanup(async () => gate.release());
    const selected = await f.authorize('启动取消.zip');
    const preview = await f.coordinator.preview({ workspaceId: f.workspaceId, targetId: selected.target.id });
    const pending = f.coordinator.start({ workspaceId: f.workspaceId, targetId: selected.target.id, commandId: randomUUID(), proposalFingerprint: preview.proposalFingerprint, userConfirmed: true });
    await gate.reached;
    const closing = f.coordinator.close();
    gate.release(); await assert.rejects(pending); await closing;
    assert.equal(f.store.recoverable().length, 0);
  });
});

test('延迟启动期间精确账本空回执不代表拒绝；稍后可接受或被 scope 撤销', async t => {
  for (const revoke of [false, true]) await t.test(revoke ? '旧 scope 撤销后原号仍无回执' : '稍后接受原号', async t => {
    const gate = checkpoint(); let plans = 0;
    const f = await setup(t, { beforePlan: async () => { if (++plans === 2) await gate.wait(); } });
    f.registerDependentCleanup(async () => gate.release());
    const selected = await f.authorize(revoke ? '撤销中.zip' : '延迟中.zip');
    const proposal = await f.coordinator.preview({ workspaceId: f.workspaceId, targetId: selected.target.id });
    const request = { workspaceId: f.workspaceId, targetId: selected.target.id, commandId: randomUUID(), proposalFingerprint: proposal.proposalFingerprint, userConfirmed: true as const };
    const pending = f.coordinator.start(request);
    await gate.reached;
    assert.deepEqual(await f.coordinator.receipt({ kind: 'start', request }), { status: 'unknown', job: null });
    if (revoke) f.coordinator.invalidateScope(f.scopeId);
    gate.release();
    if (revoke) {
      await assert.rejects(pending);
      assert.deepEqual(await f.coordinator.receipt({ kind: 'start', request }), { status: 'not-accepted', job: null });
      await assert.rejects(lstat(selected.absolute), { code: 'ENOENT' });
    } else {
      await pending; await f.coordinator.idle();
      assert.equal((await f.coordinator.receipt({ kind: 'start', request })).job?.id, request.commandId);
    }
  });
});

test('双 Core 同库会话栅栏：新启动撤销旧目标，旧启动与迟到授权不能复活，账本先提交则仍接受', async t => {
  const gate = checkpoint(); let plans = 0;
  const f = await setup(t, { beforePlan: async () => { if (++plans === 2) await gate.wait(); } });
  f.registerDependentCleanup(async () => gate.release());
  const selected = await f.authorize('旧会话挂起.zip');
  const proposal = await f.coordinator.preview({ workspaceId: f.workspaceId, targetId: selected.target.id });
  const request = { workspaceId: f.workspaceId, targetId: selected.target.id, commandId: randomUUID(), proposalFingerprint: proposal.proposalFingerprint, userConfirmed: true as const };
  const pending = f.coordinator.start(request);
  await gate.reached;
  const secondDb = new DatabaseSync(f.filePath, { enableForeignKeyConstraints: true, allowExtension: false });
  secondDb.exec('PRAGMA busy_timeout=1000');
  f.registerDependentCleanup(async () => { secondDb.close(); });
  const secondStore = createPreparationZipStore({ read: fn => fn(secondDb), conflict: message => { throw new Error(message); } });
  const next = createPreparationZipCoordinator({ store: secondStore, preparations: f.repository.preparations, datasetId: f.datasetId });
  f.registerDependentCleanup(() => next.close());
  assert.deepEqual(await next.receipt({ kind: 'start', request }), { status: 'not-accepted', job: null });
  assert.equal(f.db.prepare('SELECT revoked_at IS NOT NULL AS revoked FROM preparation_zip_targets WHERE id=?').get(selected.target.id)?.revoked, 1);
  await assert.rejects(f.coordinator.authorizeTarget({ ...selected.input, targetId: randomUUID(), absolute: path.join(f.savePath, '迟到授权.zip') }), /撤销/u);
  gate.release(); await assert.rejects(pending);
  assert.equal(f.store.job(request.commandId), undefined);
  assert.deepEqual(await next.receipt({ kind: 'start', request }), { status: 'not-accepted', job: null });
  await assert.rejects(lstat(selected.absolute), { code: 'ENOENT' });

  const freshTarget = await next.authorizeTarget({ ...selected.input, targetId: randomUUID(), scopeId: randomUUID(), absolute: path.join(f.savePath, '新会话目标.zip') });
  const freshProposal = await next.preview({ workspaceId: f.workspaceId, targetId: freshTarget.id });
  const acceptedRequest = { workspaceId: f.workspaceId, targetId: freshTarget.id, commandId: randomUUID(), proposalFingerprint: freshProposal.proposalFingerprint, userConfirmed: true as const };
  await next.start(acceptedRequest);
  assert.equal((await next.receipt({ kind: 'start', request: acceptedRequest })).status, 'accepted');
  await next.idle();
  const newest = createPreparationZipCoordinator({ store: f.store, preparations: f.repository.preparations, datasetId: f.datasetId });
  f.registerDependentCleanup(() => newest.close());
  assert.equal((await newest.receipt({ kind: 'start', request: acceptedRequest })).status, 'accepted');
  verifyPreparationZipSessionDatabase(f.db);
});

test('ZIP 授权事务失败不留半授权，缺失目标行不能冒充明确拒绝', async t => {
  const f = await setup(t);
  const faultStore = createPreparationZipStore({ read: fn => fn(f.db), conflict: message => { throw new Error(message); }, beforeCommit: action => { if (action === 'authorize-preparation-zip-target') throw new Error('合成提交故障'); } });
  const epoch = faultStore.bootSession();
  const target = { id: randomUUID(), absolute: path.join(f.savePath, '事务失败.zip'), parent: f.parent, datasetId: f.datasetId, scopeId: randomUUID(), generation: 0, expiresAt: new Date(Date.now() + 60_000).toISOString() };
  assert.throws(() => faultStore.authorizeTarget(target, epoch), /合成提交故障/u);
  assert.equal(f.db.prepare('SELECT id FROM preparation_zip_targets WHERE id=?').get(target.id), undefined);
  const request = { workspaceId: f.workspaceId, targetId: target.id, commandId: randomUUID(), proposalFingerprint: '0'.repeat(64), userConfirmed: true as const };
  assert.deepEqual(faultStore.receipt({ kind: 'start', request }), { status: 'unknown', job: null });
  verifyPreparationZipSessionDatabase(f.db);
});

test('ZIP 回执是只读快照：wall-clock 越过期限但未固化撤销仍为未知且不写库', async t => {
  const f = await setup(t);
  const selected = await f.authorize('只读到期回执.zip');
  const request = { workspaceId: f.workspaceId, targetId: selected.target.id, commandId: randomUUID(), proposalFingerprint: '0'.repeat(64), userConfirmed: true as const };
  const before = f.db.prepare('SELECT total_changes() AS n').get()!.n;
  t.mock.method(Date, 'now', () => Date.parse(selected.input.expiresAt) + 1);
  assert.deepEqual(await f.coordinator.receipt({ kind: 'start', request }), { status: 'unknown', job: null });
  assert.equal(f.db.prepare('SELECT total_changes() AS n').get()!.n, before);
  assert.equal(f.db.prepare('SELECT revoked_at FROM preparation_zip_targets WHERE id=?').get(selected.target.id)?.revoked_at, null);
});

test('ZIP 回执单一 WAL 快照：ledger 读空后另一连接提交并撤销，不能拼成伪造未接受', async t => {
  const f = await setup(t);
  const selected = await f.authorize('快照先提交.zip');
  const { job } = await f.begin(selected.target.id); await f.coordinator.idle();
  const template = f.store.job(job.id)!;
  const request = { ...template.request, commandId: randomUUID() };
  const staged = { ...template, request,
    public: { id: request.commandId, workspaceId: template.public.workspaceId, draftId: template.public.draftId, state: 'running' as const,
      targetLabel: template.public.targetLabel, fileCount: template.public.fileCount, completedFiles: 0 } };
  delete staged.temp; delete staged.verified; delete staged.recoveryRevoked;
  const secondDb = new DatabaseSync(f.filePath, { enableForeignKeyConstraints: true, allowExtension: false });
  secondDb.exec('PRAGMA busy_timeout=1000');
  f.registerDependentCleanup(async () => { secondDb.close(); });
  const second = createPreparationZipStore({ read: fn => fn(secondDb), conflict: message => { throw new Error(message); } });
  const epoch = Number(f.db.prepare('SELECT epoch FROM preparation_zip_session').get()!.epoch);
  let interleaved = 0;
  const observer = createPreparationZipStore({ read: fn => fn(f.db), conflict: message => { throw new Error(message); }, afterReceiptLedgerRead: () => {
    if (interleaved++) return;
    second.start(staged, epoch);
    second.bootSession();
  } });
  const before = f.db.prepare('SELECT total_changes() AS n').get()!.n;
  assert.deepEqual(observer.receipt({ kind: 'start', request }), { status: 'unknown', job: null });
  assert.equal(interleaved, 1);
  assert.equal(f.db.prepare('SELECT total_changes() AS n').get()!.n, before);
  assert.equal(second.receipt({ kind: 'start', request }).status, 'accepted');
  verifyPreparationZipDatabase(f.db); verifyPreparationZipSessionDatabase(f.db);
});

test('目标进入保护根后即使 ZIP 已验证也不能执行 link', async t => {
  const gate = checkpoint();
  const f = await setup(t, { beforePublish: gate.wait });
  f.registerDependentCleanup(async () => gate.release());
  const selected = await f.authorize('保护根晚加入.zip');
  const { job } = await f.begin(selected.target.id);
  await gate.reached;
  f.protectedRoots.push(f.parent);
  gate.release(); await f.coordinator.idle();
  assert.equal((await f.coordinator.job(job.id)).job!.failure, 'TARGET_INVALID');
  await assert.rejects(lstat(selected.absolute), { code: 'ENOENT' });
  verifyPreparationZipDatabase(f.db);
});

test('取消在临时句柄和 link 前持久显示 cancelling，资源收口后终止；link 后只补完成回执', async t => {
  for (const stage of ['afterTemp', 'beforePublish', 'afterPublish'] as const) await t.test(stage, async t => {
    const gate = checkpoint();
    const f = await setup(t, { [stage]: gate.wait });
    f.registerDependentCleanup(async () => gate.release());
    const selected = await f.authorize(`${stage}.zip`);
    const { job } = await f.begin(selected.target.id);
    await gate.reached;
    const cancellation = await f.coordinator.cancel({ commandId: randomUUID(), id: job.id });
    assert.equal(cancellation.state, 'cancelling');
    assert.equal(f.store.job(job.id)!.public.state, 'cancelling');
    if (stage === 'afterPublish') assert.equal((await lstat(selected.absolute)).isFile(), true);
    gate.release(); await f.coordinator.idle();
    const final = (await f.coordinator.job(job.id)).job!;
    assert.equal(final.state, stage === 'afterPublish' ? 'completed' : 'cancelled');
    if (stage !== 'afterPublish') await assert.rejects(lstat(selected.absolute), { code: 'ENOENT' });
    verifyPreparationZipDatabase(f.db);
  });
});

test('冷恢复识别双链接和单链接同 inode；临时或最终 inode 漂移绝不被覆盖', async t => {
  for (const mode of ['dual', 'single', 'drift', 'final-drift'] as const) await t.test(mode, async t => {
    const gate = checkpoint();
    const f = await setup(t, { [mode === 'drift' ? 'beforePublish' : 'afterPublish']: gate.wait });
    f.registerDependentCleanup(async () => gate.release());
    const selected = await f.authorize(`${mode}.zip`);
    const { job } = await f.begin(selected.target.id);
    await gate.reached;
    const privateJob = f.store.job(job.id)!;
    const temp = preparationZipTempPath(privateJob.target, job.id);
    if (mode === 'single') await unlink(temp);
    if (mode === 'drift') {
      await unlink(temp);
      await writeFile(temp, Buffer.from('不是本任务的文件'));
      gate.release(); await f.coordinator.idle();
      assert.equal((await f.coordinator.job(job.id)).job!.state, 'failed');
      await assert.rejects(lstat(selected.absolute), { code: 'ENOENT' });
      assert.deepEqual(await readFile(temp), Buffer.from('不是本任务的文件'));
    } else if (mode === 'final-drift') {
      await unlink(selected.absolute);
      const userBytes = Buffer.from('用户新文件'); await writeFile(selected.absolute, userBytes);
      gate.release(); await f.coordinator.idle();
      assert.equal((await f.coordinator.job(job.id)).job!.state, 'failed');
      assert.deepEqual(await readFile(selected.absolute), userBytes);
    } else {
      const recovered = createPreparationZipCoordinator({ store: f.store, preparations: f.repository.preparations, datasetId: f.datasetId });
      try {
        assert.equal((await recovered.job(job.id)).job!.state, 'completed');
        assert.equal((await lstat(selected.absolute)).isFile(), true);
      } finally { await recovered.close(); }
      gate.release(); await f.coordinator.idle();
      assert.equal((await f.coordinator.job(job.id)).job!.state, 'completed');
      await assert.rejects(lstat(temp), { code: 'ENOENT' });
    }
    verifyPreparationZipDatabase(f.db);
  });
});

test('发布验证等待期间切库或关闭恢复服务，不补旧库完成回执、不清理旧路径', async t => {
  await t.test('已 link 后验证返回时数据集身份改变', async t => {
    const gate = checkpoint(); let datasetLive = true;
    const f = await setup(t, {
      assertDataset: () => { if (!datasetLive) throw new Error('数据集已切换'); },
      verifyPublication: async (job, signal) => {
        const valid = await verifyPreparationZipPublication(job, signal);
        await gate.wait(); return valid;
      },
    });
    f.registerDependentCleanup(async () => gate.release());
    const selected = await f.authorize('切库等待.zip');
    const { job } = await f.begin(selected.target.id);
    await gate.reached;
    const temp = preparationZipTempPath(f.store.job(job.id)!.target, job.id);
    datasetLive = false;
    const closing = f.coordinator.close();
    gate.release(); await closing;
    assert.equal(f.store.job(job.id)!.public.state, 'running');
    assert.equal((await lstat(selected.absolute)).isFile(), true);
    assert.equal((await lstat(temp)).isFile(), true);
  });
  await t.test('冷恢复的长校验被 close 中止', async t => {
    const linked = checkpoint(), checking = checkpoint();
    const f = await setup(t, { afterPublish: linked.wait });
    f.registerDependentCleanup(async () => { linked.release(); checking.release(); });
    const selected = await f.authorize('恢复关闭.zip');
    const { job } = await f.begin(selected.target.id);
    await linked.reached;
    const temp = preparationZipTempPath(f.store.job(job.id)!.target, job.id);
    const recovering = createPreparationZipCoordinator({
      store: f.store, preparations: f.repository.preparations, datasetId: f.datasetId,
      verifyPublication: async (record, signal) => { await checking.wait(); return verifyPreparationZipPublication(record, signal); },
    });
    const pending = recovering.job(job.id);
    const rejected = assert.rejects(pending);
    await checking.reached;
    const closingRecovery = recovering.close();
    checking.release(); await closingRecovery; await rejected;
    assert.equal(f.store.job(job.id)!.public.state, 'running');
    const closingLive = f.coordinator.close();
    linked.release(); await closingLive;
    assert.equal(f.store.job(job.id)!.public.state, 'running');
    assert.equal((await lstat(selected.absolute)).isFile(), true);
    assert.equal((await lstat(temp)).isFile(), true);
  });
});

test('隔离恢复只撤权未完成 ZIP 的私有目标，不触碰旧主机路径；私有记录与 ledger 预算可审计', async t => {
  const gate = checkpoint();
  const f = await setup(t, { afterTemp: gate.wait });
  f.registerDependentCleanup(async () => gate.release());
  const selected = await f.authorize('恢复前目标.zip');
  const { job } = await f.begin(selected.target.id);
  await gate.reached;
  const before = f.store.job(job.id)!;
  const temp = preparationZipTempPath(before.target, job.id);
  const listed = await readdir(f.savePath);
  f.coordinator.invalidateScope(f.scopeId);
  f.db.exec('BEGIN IMMEDIATE');
  try { revokePreparationZipForRestore(f.db); f.db.exec('COMMIT'); } catch (error) { f.db.exec('ROLLBACK'); throw error; }
  assert.deepEqual(await readdir(f.savePath), listed);
  assert.equal((await lstat(temp)).isFile(), true);
  assert.equal(f.store.job(job.id)!.recoveryRevoked, true);
  assert.equal(f.store.job(job.id)!.public.failure, 'TARGET_INVALID');
  gate.release(); await f.coordinator.idle();
  verifyPreparationZipDatabase(f.db);

  // SAVEPOINT 中的恶意/损坏行不污染其它测试，也不会绕过跨表引用审计。
  function corrupt(update: () => void): void {
    f.db.exec('SAVEPOINT zip_corruption');
    try { update(); assert.throws(() => verifyPreparationZipDatabase(f.db)); }
    finally { f.db.exec('ROLLBACK TO zip_corruption; RELEASE zip_corruption'); }
  }
  const recorded = f.store.job(job.id)!;
  corrupt(() => f.db.prepare('UPDATE preparation_zip_jobs SET data=? WHERE id=?').run(JSON.stringify({ ...recorded, target: { ...recorded.target, absolute: path.join(f.savePath, '篡改.zip') } }), job.id));
  corrupt(() => f.db.exec('DROP TRIGGER preparation_zip_ledger_no_update'));
  corrupt(() => f.db.prepare('INSERT INTO preparation_zip_ledger VALUES (?,?,?,?)').run(randomUUID(), '0'.repeat(64), randomUUID(), new Date().toISOString()));
  const preparation = f.repository.preparations.job(f.workspaceId)!;
  corrupt(() => f.db.prepare('UPDATE preparation_jobs SET data=? WHERE id=?').run(JSON.stringify({ ...preparation, files: [] }), f.workspaceId));
  corrupt(() => f.db.prepare('UPDATE preparation_zip_jobs SET data=? WHERE id=?').run(JSON.stringify({ ...recorded, packageManifest: 'x'.repeat(1024 * 1024) }), job.id));
  f.db.exec('SAVEPOINT zip_hot_corruption');
  try {
    f.db.prepare('UPDATE preparation_zip_jobs SET data=? WHERE id=?').run(JSON.stringify({ ...recorded, public: { ...recorded.public, targetLabel: '篡改.zip' } }), job.id);
    await assert.rejects(f.coordinator.job(job.id));
    await assert.rejects(f.coordinator.list(f.draft.draftId));
    assert.throws(() => f.store.recoverable());
  } finally { f.db.exec('ROLLBACK TO zip_hot_corruption; RELEASE zip_hot_corruption'); }
  assert.throws(() => f.store.start({ ...recorded, request: { ...recorded.request, commandId: randomUUID() } }, f.db.prepare('SELECT epoch FROM preparation_zip_session').get()!.epoch as number));
  // 以精确计数查询注入聚合超额，避免为 64 MiB 门槛制造大型无效档案文件。
  const withBudgetCount = (n: number, bytes: number) => new Proxy(f.db, { get(database, key) {
    if (key === 'prepare') return (sql: string) => sql.startsWith('SELECT count(*) AS n,coalesce(sum(length(CAST(data AS BLOB)))')
      ? { get: () => ({ n, bytes }) }
      : database.prepare(sql);
    return Reflect.get(database, key, database);
  } });
  assert.throws(() => verifyPreparationZipDatabase(withBudgetCount(1, 64 * 1024 * 1024 + 1)));
  assert.throws(() => verifyPreparationZipDatabase(withBudgetCount(10_001, 0)));
  const epoch = f.db.prepare('SELECT epoch FROM preparation_zip_session').get()!.epoch as number;
  for (let n = 0; n < 16; n++) f.store.cancel({ commandId: randomUUID(), id: job.id }, epoch);
  assert.throws(() => f.store.cancel({ commandId: randomUUID(), id: job.id }, epoch), /预算/u);
  verifyPreparationZipSessionDatabase(f.db);
  verifyPreparationZipDatabase(f.db);
});
