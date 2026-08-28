import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, stat, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { executionFixture } from './helpers/execution-fixture.js';
import { previewArchiveRoot, initializePlannedArchiveRoot, type ArchiveInput } from '../src/recording/archive-files.js';
import { createCollectionRepository } from '../src/collection/repository.js';
import { isArchiveProposal, isArchiveHistory, isArchiveOperationView } from '@music-bridge/contracts';
import { preparedExecutionFixture } from './helpers/prepared-execution-fixture.js';
import { conversionFixture } from './helpers/conversion-fixture.js';
import { recordingProfileContent } from './helpers/recording-profile-fixture.js';
import { copyReadonlySource } from '../src/recording/source-files.js';
import { createSourceEvidenceService } from '../src/recording/source-evidence.js';

async function fixture(t: test.TestContext, beforeCommit?: (action: string) => void) {
  const f = await executionFixture(t, { ...(beforeCommit ? { beforeCommit } : {}) });
  const parentPath = path.join(f.directory, '选择后未初始化的归档'); await mkdir(parentPath);
  const parent = await previewArchiveRoot(parentPath, f.repository.sources.roots());
  return { ...f, parent, parentPath };
}

test('原生目录候选持久幂等，选择不写文件；未确认不能创建初始化意图', async t => {
  const f = await fixture(t), store = f.repository.archive;
  assert.equal(typeof store.authorizeCandidate, 'function', '归档选择尚未持久化');
  const commandId = randomUUID(), candidate = store.authorizeCandidate(commandId, f.parent);
  assert.equal(candidate.initialized, false); assert.equal(candidate.authorized, true); assert.deepEqual(await readdir(f.parentPath), []);
  assert.deepEqual(store.authorizationReceipt(commandId), candidate); assert.deepEqual(store.authorizeCandidate(commandId, f.parent), candidate);
  assert.equal(store.candidates().length, 1);
  assert.throws(() => store.authorizeCandidate(commandId, { ...f.parent, path: f.sourcePath }));
  assert.throws(() => store.beginInitialization({ commandId: randomUUID(), id: candidate.id, userConfirmed: false }));
  assert.equal(store.candidate(candidate.id).initialization, undefined); assert.deepEqual(await readdir(f.parentPath), []);
});

async function workflow(t: test.TestContext) {
  const f = await fixture(t);
  const { createArchiveCoordinator } = await import('../src/recording/archive-coordinator.js');
  const make = (repository = f.repository, hooks: Partial<Parameters<typeof createArchiveCoordinator>[0]> = {}) => createArchiveCoordinator({ store: repository.archive, executionStore: repository.execution, preparationStore: repository.preparations, sourceStore: repository.sources, sources: f.sources, preparation: f.preparation, ...hooks });
  const archive = make(); t.after(() => archive.close());
  const candidate = await archive.authorize(randomUUID(), f.parentPath);
  const initialize = () => archive.initialize({ commandId: randomUUID(), id: candidate.id, userConfirmed: true });
  const execution = await f.execution.start(await f.request()); await f.execution.idle();
  const selection = { rootId: candidate.id, assetId: execution.id, sourcePolicy: 'reference-dependent' as const };
  const preview = () => archive.preview({ ...selection, readId: randomUUID() });
  const request = async () => ({ ...selection, commandId: randomUUID(), proposalFingerprint: (await preview()).proposalFingerprint, userConfirmed: true as const });
  return { ...f, archive, makeArchive: make, candidate, initialize, executionJob: execution, selection, archivePreview: preview, archiveRequest: request };
}

test('目录选择与内容预览不写归档文件；显式确认才启动完整执行谱系后台归档', async t => {
  const f = await workflow(t);
  assert.equal(f.candidate.state, 'selected'); assert.deepEqual(await readdir(f.parentPath), []);
  await assert.rejects(f.archive.preview({ ...f.selection, readId: randomUUID() }));
  assert.equal((await f.initialize()).state, 'ready');
  const root = f.repository.archive.root(f.candidate.id), p = await f.archivePreview();
  assert.equal(isArchiveProposal(p), true); assert.equal(p.mode, 'direct');
  assert.deepEqual(new Set(p.files.map(x => x.role)), new Set(['execution-audio','manifest','metadata']));
  assert.deepEqual(await readdir(root.objects.path), []); assert.deepEqual(await readdir(root.operations.path), []);
  assert.equal(f.repository.archive.operations().length, 0);
  const request = await f.archiveRequest();
  await assert.rejects(f.archive.start({ ...request, userConfirmed: false } as never));
  await assert.rejects(f.archive.start({ ...request, proposalFingerprint: '0'.repeat(64) }));
  const op = await f.archive.start(request); assert.equal(isArchiveOperationView(op), true); assert.equal(op.active, true);
  await f.archive.idle(); const history = f.archive.list(f.draft.draftId);
  assert.equal(isArchiveHistory(history), true); assert.equal(history.operations.length, 1);
  assert.equal(history.operations[0]!.phase, 'FINALIZED'); assert.equal(history.operations[0]!.formalReady, false);
  assert.deepEqual(await f.archive.start(request), history.operations[0]);
  assert.equal((await readdir(root.objects.path)).length, p.objectCount);
  const metadata = p.files.find(x => x.role === 'metadata')!;
  const snapshot = JSON.parse(await readFile(path.join(root.objects.path, metadata.sha256), 'utf8'));
  assert.equal(snapshot.master.id, f.master.id); assert.equal(snapshot.layout.id, f.layout.id);
  assert.equal(snapshot.execution.settings.effective.recordLevel, '本次人工电平');
  assert.equal(snapshot.formalReady, false); assert.ok(!JSON.stringify(snapshot).includes(f.sourcePath));
  assert.ok(!JSON.stringify({ p, history }).includes(f.target));
});

test('源复制必须明确选择；逐字节归档后源和执行目录离线仍可核验与幂等重试', async t => {
  const f = await workflow(t); await f.initialize();
  const before = await stat(f.file, { bigint: true }), bytes = await readFile(f.file);
  const selection = { ...f.selection, sourcePolicy: 'preserve-exact-sources' as const };
  const p = await f.archive.preview({ ...selection, readId: randomUUID() });
  assert.equal(p.files.filter(x => x.role === 'exact-source').length, 3);
  const request = { ...selection, commandId: randomUUID(), proposalFingerprint: p.proposalFingerprint, userConfirmed: true as const };
  const op = await f.archive.start(request); await f.archive.idle();
  assert.equal(f.archive.operation(op.id).operation!.phase, 'FINALIZED');
  const after = await stat(f.file, { bigint: true });
  assert.deepEqual([after.ino, after.mtimeNs, after.ctimeNs], [before.ino, before.mtimeNs, before.ctimeNs]); assert.deepEqual(await readFile(f.file), bytes);
  await rm(f.sourcePath, { recursive: true }); await rm(f.target, { recursive: true });
  assert.equal((await f.archive.verify({ id: op.id, readId: randomUUID() })).state, 'verified');
  assert.equal((await f.archive.start(request)).id, op.id);
  await f.archive.close(); const reopened = createCollectionRepository({ filePath: f.filePath }), resumed = f.makeArchive(reopened);
  try { await resumed.idle(); assert.equal((await resumed.start(request)).id, op.id); assert.equal((await resumed.verify({ id: op.id, readId: randomUUID() })).state, 'verified'); }
  finally { await resumed.close(); reopened.close(); }
});

test('历史 FINALIZED 不能代替当前完整性核验，损坏对象不修复复写', async t => {
  const f = await workflow(t); await f.initialize(); const p = await f.archivePreview();
  const op = await f.archive.start(await f.archiveRequest()); await f.archive.idle();
  const root = f.repository.archive.root(f.candidate.id), file = path.join(root.objects.path, p.files[0]!.sha256);
  const broken = Buffer.from('合成损坏对象'); await writeFile(file, broken);
  const check = await f.archive.verify({ id: op.id, readId: randomUUID() });
  assert.equal(check.state, 'unavailable'); assert.equal(check.reason, 'ARCHIVE_RECOVERY_REQUIRED');
  assert.equal(f.archive.list(f.draft.draftId).operations[0]!.phase, 'FINALIZED');
  assert.deepEqual(await readFile(file), broken);
});

for (const mode of ['direct-converted', 'prepared-reference', 'prepared-derivative'] as const) {
  test(`${mode} 完整归档实际音频及原件/中间转换谱系，不遗漏或二次添加 Gap`, async t => {
    const f = mode === 'direct-converted' ? await executionFixture(t, { converter: conversionFixture(), emptyB: true }) : await preparedExecutionFixture(t, { converter: conversionFixture(), emptyB: true });
    let revision = f.selection.sessionRevision;
    if (mode === 'prepared-derivative') {
      const content = recordingProfileContent(48000); content.executionFormat = { ...content.executionFormat, internalProcessingPrecision: 'float64', outputSampleFormat: 'pcm-s24le', resamplerImplementation: 'ffmpeg-swr', resamplerVersion: '6.3.102' };
      const profile = f.repository.recordingProfiles.save({ commandId: randomUUID(), content, userConfirmed: true });
      revision = f.repository.recordingProfiles.saveSession({ commandId: randomUUID(), draftId: f.draft.draftId, expectedRevision: revision, profileVersionId: profile.id, overrides: {}, userConfirmed: true }).revision;
    }
    const selection = { ...f.selection, mode, sessionRevision: revision }, proposal = await f.execution.preview({ ...selection, readId: randomUUID() });
    const job = await f.execution.start({ ...selection, commandId: randomUUID(), proposalFingerprint: proposal.proposalFingerprint, userConfirmed: true }); await f.execution.idle();
    assert.equal(f.execution.job(job.id).job!.state, 'completed');
    const parent = path.join(f.directory, '完整谱系归档'); await mkdir(parent);
    const { createArchiveCoordinator } = await import('../src/recording/archive-coordinator.js');
    const archive = createArchiveCoordinator({ store: f.repository.archive, executionStore: f.repository.execution, preparationStore: f.repository.preparations, sourceStore: f.repository.sources, sources: f.sources, preparation: f.preparation }); t.after(() => archive.close());
    const root = await archive.authorize(randomUUID(), parent); await archive.initialize({ commandId: randomUUID(), id: root.id, userConfirmed: true });
    const picked = { rootId: root.id, assetId: job.id, sourcePolicy: 'reference-dependent' as const }, p = await archive.preview({ ...picked, readId: randomUUID() });
    assert.equal(isArchiveProposal(p), true); assert.equal(p.mode, mode);
    const stored = f.repository.execution.job(job.id)!;
    assert.equal(p.files.filter(x => x.role === 'execution-audio').length, stored.audio.length);
    if (mode === 'direct-converted') assert.equal(p.files.filter(x => x.role === 'conversion-intermediate').length, 3);
    else {
      const raw = p.files.filter(x => x.role === 'raw-render'); assert.equal(raw.length, 1);
      assert.equal(raw[0]!.sha256, stored.input.retained!.prepared.assets[0]!.sha256);
      assert.equal(p.files.filter(x => x.role === 'manifest').length, 2);
      if (mode === 'prepared-reference') assert.equal(p.files.find(x => x.role === 'execution-audio')!.sha256, raw[0]!.sha256);
      else assert.notEqual(p.files.find(x => x.role === 'execution-audio')!.sha256, raw[0]!.sha256);
    }
    const op = await archive.start({ ...picked, commandId: randomUUID(), proposalFingerprint: p.proposalFingerprint, userConfirmed: true }); await archive.idle();
    assert.equal(archive.operation(op.id).operation!.phase, 'FINALIZED');
    assert.equal((await readdir(f.repository.archive.root(root.id).objects.path)).length, p.objectCount);
    assert.equal((await archive.verify({ id: op.id, readId: randomUUID() })).state, 'verified');
  });
}

for (const action of ['cancel', 'source', 'destination', 'archive', 'close'] as const) {
  test(`复制中 ${action} 立即中断，不提交引用、不删除部分文件，冷启动不自动重放取消`, async t => {
    const f = await workflow(t); await f.initialize(); await f.archive.close();
    let entered!: () => void, release!: () => void;
    const seen = new Promise<void>(r => { entered = r; }), wait = new Promise<void>(r => { release = r; });
    const archive = f.makeArchive(f.repository, { copy: async (...args) => { entered(); await wait; return copyReadonlySource(...args); } }); t.after(() => archive.close());
    const selection = { ...f.selection, sourcePolicy: 'preserve-exact-sources' as const }, p = await archive.preview({ ...selection, readId: randomUUID() });
    const op = await archive.start({ ...selection, commandId: randomUUID(), proposalFingerprint: p.proposalFingerprint, userConfirmed: true }); await seen;
    let closing: Promise<void> | undefined;
    if (action === 'cancel') archive.cancel({ commandId: randomUUID(), id: op.id });
    else if (action === 'source') await f.sources.revoke({ commandId: randomUUID(), id: f.root.id });
    else if (action === 'destination') f.preparation.revoke({ commandId: randomUUID(), id: f.destination.id });
    else if (action === 'archive') await archive.revoke({ commandId: randomUUID(), id: f.candidate.id });
    else closing = archive.close();
    release(); if (closing) await closing; else await archive.idle();
    assert.equal(f.repository.archive.references(op.id).length, 0);
    const stored = f.repository.archive.operation(op.id)!; assert.equal(stored.issue, 'CANCELLED');
    assert.ok((await readdir(stored.owned!.staging.path)).length > 0);
    await archive.close(); const resumed = f.makeArchive(f.repository, { copy: async () => { assert.fail('取消后不能自动重放复制'); } });
    try { await resumed.idle(); assert.equal(resumed.operation(op.id).operation!.active, false); assert.equal(f.repository.archive.references(op.id).length, 0); }
    finally { await resumed.close(); }
    if (action === 'cancel') {
      const resumed = f.makeArchive(); try {
        const request = { commandId: randomUUID(), id: op.id }; await resumed.resume(request); await resumed.idle();
        assert.equal(resumed.operation(op.id).operation!.phase, 'FINALIZED'); assert.equal((await resumed.resume(request)).active, false);
      } finally { await resumed.close(); }
    }
  });
}

test('STAGED 后中断，原输入离线时冷启动只完成归档已有字节，不重新复制源', async t => {
  const f = await workflow(t); await f.initialize(); await f.archive.close();
  const archive = f.makeArchive(f.repository, { afterPhase: async phase => { if (phase === 'STAGED') throw new Error('合成中断'); } });
  const request = { ...f.selection, commandId: randomUUID(), proposalFingerprint: (await archive.preview({ ...f.selection, readId: randomUUID() })).proposalFingerprint, userConfirmed: true as const };
  const op = await archive.start(request); await archive.idle(); assert.equal(archive.operation(op.id).operation!.phase, 'STAGED'); await archive.close();
  await rm(f.target, { recursive: true }); await rm(f.sourcePath, { recursive: true });
  const repository = createCollectionRepository({ filePath: f.filePath }), resumed = f.makeArchive(repository, { copy: async () => { assert.fail('已暂存字节不得重新复制'); } });
  try { await resumed.idle(); assert.equal(resumed.operation(op.id).operation!.phase, 'FINALIZED'); assert.equal((await resumed.start(request)).id, op.id); }
  finally { await resumed.close(); repository.close(); }
});

test('容量不足、预取消读取和超时都不报告完成；异步错误不泄漏私有路径', async t => {
  const f = await workflow(t); await f.initialize(); await f.archive.close();
  const archive = f.makeArchive(f.repository, { availableBytes: async () => 1n }); t.after(() => archive.close());
  const readId = randomUUID(); archive.cancelRead(readId); await assert.rejects(archive.preview({ ...f.selection, readId }));
  const p = await archive.preview({ ...f.selection, readId: randomUUID() }); assert.equal(p.availableBytes, 1);
  await assert.rejects(archive.start({ ...f.selection, commandId: randomUUID(), proposalFingerprint: p.proposalFingerprint, userConfirmed: true }));
  assert.equal(f.repository.archive.operations().length, 0); await archive.close();
  const slow = f.makeArchive(f.repository, { operationTimeoutMs: 500, copy: async (_root, _relative, _expected, _handle, signal) => { await new Promise<void>((_resolve, reject) => { if (signal.aborted) reject(signal.reason); else signal.addEventListener('abort', () => reject(signal.reason), { once: true }); }); throw new Error('不应继续'); } });
  try {
    const p = await slow.preview({ ...f.selection, readId: randomUUID() }), op = await slow.start({ ...f.selection, commandId: randomUUID(), proposalFingerprint: p.proposalFingerprint, userConfirmed: true });
    await slow.idle(); assert.equal(slow.operation(op.id).operation!.issue, 'CANCELLED'); assert.equal(f.repository.archive.references(op.id).length, 0);
    const bytes = await readFile(f.file); bytes[44] = 1; await writeFile(f.file, bytes);
    await assert.rejects(slow.preview({ ...f.selection, sourcePolicy: 'preserve-exact-sources', readId: randomUUID() }), error => error instanceof Error && !error.message.includes(f.directory));
  } finally { await slow.close(); }
});

test('源授权不能覆盖已初始化或初始化中的归档目录，选择候选本身不封锁父目录', async t => {
  const f = await workflow(t), { assertSourceOutsideArchives } = await import('../src/recording/archive-input.js');
  const sources = createSourceEvidenceService({ store: f.repository.sources, drafts: f.repository.drafts, validateAuthorization: root => assertSourceOutsideArchives(root.path, f.repository.archive) }); t.after(() => sources.close());
  assert.doesNotThrow(() => assertSourceOutsideArchives(f.parentPath, f.repository.archive));
  f.repository.archive.beginInitialization({ commandId: randomUUID(), id: f.candidate.id, userConfirmed: true });
  await assert.rejects(sources.authorize(randomUUID(), f.parentPath));
  await f.initialize(); const root = f.repository.archive.root(f.candidate.id);
  for (const target of [f.parentPath, root.root.path, root.objects.path]) await assert.rejects(sources.authorize(randomUUID(), target));
  assert.equal(f.repository.sources.roots().length, 1);
  const unrelated = path.join(f.directory, '独立源目录'); await mkdir(unrelated);
  assert.equal((await sources.authorize(randomUUID(), unrelated)).authorized, true);
});

test('初始化并发重试共享一份意图；撤权或关闭后不继续创建 Root', async t => {
  for (const action of ['revoke','close','retry'] as const) {
    const f = await workflow(t); await f.archive.close();
    let entered!: () => void, release!: () => void, calls = 0;
    const seen = new Promise<void>(r => { entered = r; }), wait = new Promise<void>(r => { release = r; });
    const archive = f.makeArchive(f.repository, { initialize: async (...args) => { calls++; entered(); await wait; return initializePlannedArchiveRoot(...args); } }); t.after(() => archive.close());
    const request = { commandId: randomUUID(), id: f.candidate.id, userConfirmed: true as const };
    const running = archive.initialize(request), outcome = running.then(value => value, () => null);
    assert.equal(await Promise.race([outcome.then(() => false), seen.then(() => true)]), true, '初始化必须经过受生命周期管理的文件入口');
    let closing: Promise<void> | undefined;
    const retried = action === 'retry' ? archive.initialize(request) : undefined;
    if (action === 'revoke') await archive.revoke({ commandId: randomUUID(), id: f.candidate.id });
    if (action === 'close') closing = archive.close();
    release(); const result = await outcome; await closing;
    if (action === 'retry') { assert.equal(result?.state, 'ready'); assert.deepEqual(await retried, result); assert.equal(calls, 1); }
    else { assert.equal(result, null); assert.deepEqual(await readdir(f.parentPath), []); }
  }
});

test('非法执行资产也返回安全公开错误，不泄漏内核错误码', async t => {
  const f = await workflow(t); await f.initialize();
  await assert.rejects(f.archive.preview({ ...f.selection, assetId: randomUUID(), readId: randomUUID() }), error => !!error && typeof error === 'object' && 'code' in error && error.code === 'BAD_REQUEST');
});

test('正常与合成 runtime 都接入归档及 Source Root 防重叠；关闭后服务不可再写', async t => {
  const { createBridgeRuntime, createTestBridgeRuntime } = await import('../src/runtime.js');
  const { createLocalFavoriteRepository } = await import('../src/favorites/repository.js');
  for (const normal of [false,true]) {
    const f = await fixture(t); await f.execution.close(); await f.preparation.close(); await f.versions.close(); await f.sources.close();
    const runtime = normal ? createBridgeRuntime({ collectionRepository: f.repository, env: {}, favoriteRepository: createLocalFavoriteRepository(), roonSdk: { createApi: () => assert.fail('此测试不能连接真实 Roon') } as never }) : createTestBridgeRuntime({ collectionRepository: f.repository });
    try {
      assert.ok(runtime.archive, 'runtime 尚未接入归档');
      const root = await runtime.archive.authorize(randomUUID(), f.parentPath);
      assert.equal((await runtime.archive.initialize({ commandId: randomUUID(), id: root.id, userConfirmed: true })).state, 'ready');
      await assert.rejects(runtime.sources!.authorize(randomUUID(), f.parentPath));
    } finally { await runtime.shutdown(); }
    await assert.rejects(runtime.archive!.authorize(randomUUID(), f.parentPath));
  }
});

test('后台恢复不能阻塞另一读取的取消；界面不必等所有旧归档恢复完', async t => {
  const f = await workflow(t); await f.initialize(); await f.archive.close();
  const interrupted = f.makeArchive(f.repository, { afterPhase: async phase => { if (phase === 'STAGED') throw new Error('合成中断'); } });
  const p = await interrupted.preview({ ...f.selection, readId: randomUUID() });
  await interrupted.start({ ...f.selection, commandId: randomUUID(), proposalFingerprint: p.proposalFingerprint, userConfirmed: true }); await interrupted.idle(); await interrupted.close();
  let entered!: () => void, release!: () => void;
  const seen = new Promise<void>(r => { entered = r; }), wait = new Promise<void>(r => { release = r; });
  const resumed = f.makeArchive(f.repository, { afterPhase: async () => { entered(); await wait; } });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await seen; const readId = randomUUID(); resumed.cancelRead(readId);
    const outcome = resumed.preview({ ...f.selection, readId }).then(() => 'unexpected-success', () => 'cancelled');
    const result = await Promise.race([outcome, new Promise<string>(resolve => { timer = setTimeout(() => resolve('blocked-by-recovery'), 300); })]);
    assert.equal(result, 'cancelled');
  } finally { if (timer) clearTimeout(timer); release(); await resumed.close(); }
});

test('Root 文件创建后 DB 回滚，冷连接以同一 owner 意图恢复，不重复初始化', async t => {
  let fail = false;
  const f = await fixture(t, action => { if (fail && action === 'finish-archive-initialization') throw new Error('合成 Root 提交失败'); });
  const store = f.repository.archive, candidate = store.authorizeCandidate(randomUUID(), f.parent), request = { commandId: randomUUID(), id: candidate.id, userConfirmed: true };
  const plan = store.beginInitialization(request).initialization!;
  const owned = await initializePlannedArchiveRoot(plan, f.repository.sources.roots(), true);
  fail = true; assert.throws(() => store.finishInitialization(candidate.id, owned)); assert.equal(store.candidate(candidate.id).initialized, false);
  fail = false; const reopened = createCollectionRepository({ filePath: f.filePath });
  try {
    const same = reopened.archive.beginInitialization(request).initialization!; assert.deepEqual(same, plan);
    const restored = await initializePlannedArchiveRoot(same, f.repository.sources.roots(), true);
    const complete = reopened.archive.finishInitialization(candidate.id, restored); assert.equal(complete.initialized, true);
    assert.deepEqual(reopened.archive.finishInitialization(candidate.id, restored), complete); assert.equal((await readdir(f.parentPath)).length, 1);
  } finally { reopened.close(); }
});

test('Root 选择撤权与已初始化撤权都幂等，不能借重试原确认重新获得授权', async t => {
  for (const initialize of [false, true]) {
    const f = await fixture(t), store = f.repository.archive, candidate = store.authorizeCandidate(randomUUID(), f.parent);
    const request = { commandId: randomUUID(), id: candidate.id, userConfirmed: true };
    if (initialize) { const plan = store.beginInitialization(request).initialization!; store.finishInitialization(candidate.id, await initializePlannedArchiveRoot(plan, f.repository.sources.roots(), true)); }
    const revoke = { commandId: randomUUID(), id: candidate.id }, result = store.revokeCandidate(revoke);
    assert.equal(result.authorized, false); assert.deepEqual(store.revokeCandidate(revoke), result); assert.throws(() => store.beginInitialization(request));
    if (initialize) assert.throws(() => store.root(candidate.id));
  }
});

test('工作流迁移失败回滚；已有内核 Root 保留身份并可作为已初始化候选读取', async t => {
  const f = await fixture(t), store = f.repository.archive, candidate = store.authorizeCandidate(randomUUID(), f.parent);
  const plan = store.beginInitialization({ commandId: randomUUID(), id: candidate.id, userConfirmed: true }).initialization!;
  const owned = await initializePlannedArchiveRoot(plan, f.repository.sources.roots(), true); store.finishInitialization(candidate.id, owned);
  await f.execution.close(); f.repository.close();
  const old = new DatabaseSync(f.filePath); old.exec('DROP TABLE archive_workflow_ledger; DROP TABLE archive_candidates; PRAGMA user_version=13'); old.close();
  const failed = createCollectionRepository({ filePath: f.filePath, beforeCommit: action => { if (action === 'migrate-archive-workflow') throw new Error('合成归档工作流迁移失败'); } });
  assert.throws(() => failed.archive.candidates()); failed.close();
  const check = new DatabaseSync(f.filePath); assert.equal(check.prepare('PRAGMA user_version').get()!.user_version, 13); assert.equal(check.prepare("SELECT count(*) n FROM sqlite_master WHERE name='archive_candidates'").get()!.n, 0); check.close();
  const restored = createCollectionRepository({ filePath: f.filePath });
  try { assert.deepEqual(restored.archive.root(candidate.id), owned); const next = restored.archive.candidate(candidate.id); assert.equal(next.initialized, true); assert.equal(next.authorized, true); assert.deepEqual(next.parent, f.parent); } finally { restored.close(); }
});

test('确认内容和时间不可改写；冷连接重复 start 命中原操作，cancel/resume 命令不重放', async t => {
  const f = await fixture(t), store = f.repository.archive;
  const candidate = store.authorizeCandidate(randomUUID(), f.parent);
  const plan = store.beginInitialization({ commandId: randomUUID(), id: candidate.id, userConfirmed: true }).initialization!;
  store.finishInitialization(candidate.id, await initializePlannedArchiveRoot(plan, f.repository.sources.roots(), true));
  const started = await f.execution.start(await f.request()); await f.execution.idle();
  const job = f.repository.execution.job(started.id)!;
  const confirmed = { commandId: randomUUID(), assetId: started.id, rootId: candidate.id, sourcePolicy: 'reference-dependent' as const, proposalFingerprint: 'a'.repeat(64), userConfirmed: true as const };
  const files: ArchiveInput[] = job.files.map(file => ({ ...file, source: job.owned!.root, role: 'execution-audio', name: path.basename(file.relative), media: 'audio' }));
  const request = { id: confirmed.commandId, rootId: candidate.id, files, lineage: { masterVersionId: f.master.id, layoutVersionId: f.layout.id, executionAssetId: started.id }, confirmed: true, workflow: { request: confirmed, createdAt: new Date().toISOString() } };
  const op = store.request(request); assert.deepEqual(op.request.workflow, request.workflow);
  assert.throws(() => store.request({ ...request, id: randomUUID() }));
  assert.throws(() => store.request({ ...request, workflow: { ...request.workflow, createdAt: 'yesterday' } }));
  assert.throws(() => store.request({ ...request, workflow: { ...request.workflow, request: { ...confirmed, sourcePolicy: 'preserve-exact-sources' } } }));
  const reopened = createCollectionRepository({ filePath: f.filePath });
  try {
    assert.deepEqual(reopened.archive.cached(confirmed), op);
    assert.throws(() => reopened.archive.cached({ ...confirmed, assetId: randomUUID() }));
    const cancel = { commandId: randomUUID(), id: op.request.id };
    assert.equal(reopened.archive.control('cancel', cancel).operation.issue, 'CANCELLED');
    const resume = { commandId: randomUUID(), id: op.request.id };
    assert.equal(reopened.archive.control('resume', resume).replayed, false);
    assert.equal(reopened.archive.control('resume', resume).replayed, true);
    assert.equal(reopened.archive.control('cancel', cancel).operation.issue, undefined, '已消费的取消不应取消后来的恢复');
    assert.throws(() => reopened.archive.control('cancel', resume));
    assert.throws(() => reopened.archive.authorizeCandidate(resume.commandId, f.parent));
  } finally { reopened.close(); }
});
