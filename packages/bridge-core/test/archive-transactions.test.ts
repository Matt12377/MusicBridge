import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, rm, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { executionFixture } from './helpers/execution-fixture.js';
import { createCollectionRepository } from '../src/collection/repository.js';
import { previewArchiveRoot, initializeArchiveRoot, archiveObjectPath, type ArchiveInput } from '../src/recording/archive-files.js';
import { createArchiveTransactionRunner } from '../src/recording/archive-transactions.js';

async function setup(t: test.TestContext, beforeCommit?: (action: string) => void) {
  const f = await executionFixture(t, { ...(beforeCommit ? { beforeCommit } : {}) });
  const execution = await f.execution.start(await f.request()); await f.execution.idle();
  const job = f.repository.execution.job(execution.id)!, owned = job.owned!;
  const destination = path.join(f.directory, '归档目标'); await mkdir(destination);
  const archive = await initializeArchiveRoot(await previewArchiveRoot(destination, f.repository.sources.roots()), randomUUID(), f.repository.sources.roots(), true);
  f.repository.archive.registerRoot(archive);
  const inputs: ArchiveInput[] = job.files.map(file => ({ ...file, source: owned.root, role: 'execution-audio', name: path.basename(file.relative), media: 'audio' }));
  const request = { id: randomUUID(), rootId: archive.id, files: inputs, lineage: { masterVersionId: f.master.id, layoutVersionId: f.layout.id, executionAssetId: execution.id }, confirmed: true as const };
  return { ...f, archive, inputs, archiveRequest: request };
}

test('归档明确请求且谱系必须存在；原操作幂等，不改库存或录音历史', async t => {
  const f = await setup(t), store = f.repository.archive, request = f.archiveRequest;
  const db = new DatabaseSync(f.filePath), before = db.prepare('SELECT * FROM physical_copies').all();
  try {
    assert.throws(() => store.request({ ...request, confirmed: false })); assert.throws(() => store.request({ ...request, lineage: { ...request.lineage, executionAssetId: randomUUID() } }));
    store.request(request); assert.deepEqual(store.request(request), store.operation(request.id));
    assert.throws(() => store.request({ ...request, files: [{ ...f.inputs[0]!, name: 'different.wav' }] }));
    assert.equal(store.references(request.id).length, 0); assert.deepEqual(await readdir(f.archive.objects.path), []);
    await createArchiveTransactionRunner({ store }).run(request.id);
    assert.equal(store.operation(request.id)!.phase, 'FINALIZED'); assert.equal(store.references(request.id).length, f.inputs.length);
    assert.deepEqual(db.prepare('SELECT * FROM physical_copies').all(), before); assert.equal(f.execution.list(f.draft.draftId).assets[0]!.formalReady, false);
    for (const table of ['archive_objects','archive_references']) assert.throws(() => db.exec(`UPDATE ${table} SET root_id=root_id`));
  } finally { db.close(); }
});

for (const cut of ['INTENT_WRITTEN','STAGED','VERIFIED','PROMOTED','DB_COMMITTED'] as const) {
  test(`${cut} 中断后冷连接重复恢复 1/2/10 次无重复对象或引用`, async t => {
    const f = await setup(t), store = f.repository.archive, request = f.archiveRequest; store.request(request);
    const runner = createArchiveTransactionRunner({ store, afterPhase: async phase => { if (phase === cut) throw new Error('合成进程中断'); } });
    await assert.rejects(runner.run(request.id));
    assert.equal(store.references(request.id).length, cut === 'DB_COMMITTED' ? f.inputs.length : 0);
    if (['STAGED','VERIFIED','PROMOTED','DB_COMMITTED'].includes(cut)) await rm(f.target, { recursive: true });
    const reopened = createCollectionRepository({ filePath: f.filePath });
    try {
      const resumed = createArchiveTransactionRunner({ store: reopened.archive });
      for (let i = 0; i < 10; i++) await resumed.recover();
      assert.equal(reopened.archive.operation(request.id)!.phase, 'FINALIZED'); assert.equal(reopened.archive.references(request.id).length, f.inputs.length);
      assert.equal((await readdir(f.archive.objects.path)).length, new Set(f.inputs.map(f => f.sha256)).size);
    } finally { reopened.close(); }
  });
}

test('文件发布后 SQLite 提交回滚，不提前引用；下次只补交不复制', async t => {
  let fail = false; const f = await setup(t, action => { if (fail && action === 'commit-archive') throw new Error('合成 DB 回滚'); });
  const store = f.repository.archive; store.request(f.archiveRequest); fail = true;
  await assert.rejects(createArchiveTransactionRunner({ store }).run(f.archiveRequest.id)); assert.equal(store.references(f.archiveRequest.id).length, 0);
  assert.equal(store.operation(f.archiveRequest.id)!.phase, 'PROMOTED'); fail = false;
  await createArchiveTransactionRunner({ store, copy: async () => { assert.fail('已发布文件不能重复制'); } }).run(f.archiveRequest.id);
  assert.equal(store.references(f.archiveRequest.id).length, f.inputs.length);
});

test('已提交对象丢失或损坏必须记录恢复要求，反复恢复不删引用或伪成功', async t => {
  for (const damage of ['missing','hash'] as const) {
    const f = await setup(t), store = f.repository.archive, request = f.archiveRequest; store.request(request);
    const runner = createArchiveTransactionRunner({ store }); await runner.run(request.id);
    const object = archiveObjectPath(f.archive, f.inputs[0]!.sha256);
    if (damage === 'missing') await rm(object); else { const bytes = await readFile(object); bytes[44] = 13; await writeFile(object, bytes); }
    for (let i = 0; i < 2; i++) { const results = await runner.recover(); assert.equal(results[0]!.available, false); }
    assert.equal(store.operation(request.id)!.issue, 'ARCHIVE_RECOVERY_REQUIRED'); assert.equal(store.references(request.id).length, f.inputs.length);
  }
});

test('并发重复请求与不同操作按 Root 串行，内容复用不重复建对象', async t => {
  const f = await setup(t), store = f.repository.archive, a = f.archiveRequest, b = { ...a, id: randomUUID() }; store.request(a); store.request(b);
  const one = createArchiveTransactionRunner({ store }), two = createArchiveTransactionRunner({ store });
  await Promise.all([one.run(a.id), two.run(a.id), two.run(b.id)]);
  assert.equal(store.references(a.id).length, f.inputs.length); assert.equal(store.references(b.id).length, f.inputs.length);
  assert.equal((await readdir(f.archive.objects.path)).length, new Set(f.inputs.map(f => f.sha256)).size);
});

test('归档 schema 迁移可回滚；旧账本与执行资产不改写', async t => {
  const f = await executionFixture(t), job = await f.execution.start(await f.request()); await f.execution.idle();
  const before = f.repository.execution.asset(job.id); await f.execution.close(); f.repository.close();
  const old = new DatabaseSync(f.filePath); old.exec('DROP TRIGGER recording_attempt_copy_no_blank; DROP TRIGGER recording_attempt_reservation_no_delete; DROP TRIGGER recording_attempt_reservation_no_rebind; DROP TRIGGER recording_attempt_active_media_no_update; DROP TABLE recording_attempt_receipts; DROP TABLE recording_attempt_events; DROP TABLE recording_attempts; DROP TABLE recording_plan_ledger; DROP TABLE recording_plan_versions; DROP TABLE collection_want_events; DROP TABLE collection_progress_snapshots; DROP TABLE collection_progress_ledger; DROP TABLE collection_wants; DROP TABLE spreadsheet_adjustments; DROP TABLE spreadsheet_rows; DROP TABLE spreadsheet_effects; DROP TABLE spreadsheet_heads; DROP TABLE spreadsheet_revisions; DROP TABLE spreadsheet_source_rows; DROP TABLE spreadsheet_sources; DROP TABLE spreadsheet_ledger; DROP TABLE reference_catalog_ledger; DROP TABLE reference_catalog_snapshots; DROP TABLE reference_catalog_matches; DROP TABLE reference_catalog_heads; DROP TABLE reference_catalog_revisions; DROP TABLE reference_sources; DROP TABLE archive_workflow_ledger; DROP TABLE archive_candidates; DROP TABLE archive_references; DROP TABLE archive_objects; DROP TABLE archive_operations; DROP TABLE archive_roots; PRAGMA user_version=12');
  const ledger = old.prepare('SELECT * FROM inventory_ledger ORDER BY rowid').all(); old.close();
  const failed = createCollectionRepository({ filePath: f.filePath, beforeCommit: action => { if (action === 'migrate-archive') throw new Error('合成迁移回滚'); } });
  assert.throws(() => failed.archive.operations()); failed.close();
  const check = new DatabaseSync(f.filePath); assert.equal(check.prepare('PRAGMA user_version').get()!.user_version, 12); assert.equal(check.prepare("SELECT count(*) n FROM sqlite_master WHERE name='archive_roots'").get()!.n, 0); check.close();
  const next = createCollectionRepository({ filePath: f.filePath }); try { assert.deepEqual(next.execution.asset(job.id), before); assert.deepEqual(next.archive.operations(), []); } finally { next.close(); }
  const after = new DatabaseSync(f.filePath); try { assert.equal(after.prepare('PRAGMA user_version').get()!.user_version, 19); assert.deepEqual(after.prepare('SELECT * FROM inventory_ledger ORDER BY rowid').all(), ledger); } finally { after.close(); }
});

test('撤销 Root 后恢复仍记录不可用；取消任务不在恢复中自动重放', async t => {
  const f = await setup(t), store = f.repository.archive; store.request(f.archiveRequest);
  const runner = createArchiveTransactionRunner({ store }); await assert.rejects(runner.run(f.archiveRequest.id, AbortSignal.abort()));
  assert.equal(store.operation(f.archiveRequest.id)!.issue, 'CANCELLED'); assert.deepEqual(await runner.recover(), [{ id: f.archiveRequest.id, available: false }]);
  const next = { ...f.archiveRequest, id: randomUUID() }; store.request(next); store.revokeRoot(f.archive.id);
  assert.deepEqual(await runner.recover(), [{ id: f.archiveRequest.id, available: false }, { id: next.id, available: false }]);
  assert.equal(store.operation(next.id)!.issue, 'ARCHIVE_ROOT_INVALID');
});

for (const cut of ['PROMOTED', 'DB_COMMITTED'] as const) {
  test(`真实子进程 ${cut} 后 SIGKILL，SQLite/WAL 冷恢复与对象 Hash 保持一致`, { timeout: 20_000 }, async t => {
    const f = await setup(t); f.repository.archive.request(f.archiveRequest);
    const { fork } = await import('node:child_process');
    const child = fork(new URL('./helpers/archive-crash-child.ts', import.meta.url), [f.filePath, f.archiveRequest.id, cut], { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
    await Promise.race([once(child, 'message'), once(child, 'exit').then(() => { throw new Error('合成子进程在归档检查点之前退出'); })]);
    const closed = once(child, 'close'); child.kill('SIGKILL'); const [code, signal] = await closed; assert.equal(code, null); assert.equal(signal, 'SIGKILL');
    const resumed = createCollectionRepository({ filePath: f.filePath });
    try {
      await rm(f.target, { recursive: true }); const runner = createArchiveTransactionRunner({ store: resumed.archive, copy: async () => { assert.fail('已发布阶段不得重读原件'); } });
      for (let i = 0; i < 2; i++) assert.deepEqual(await runner.recover(), [{ id: f.archiveRequest.id, available: true }]);
      assert.equal(resumed.archive.operation(f.archiveRequest.id)!.phase, 'FINALIZED'); assert.equal(resumed.archive.references(f.archiveRequest.id).length, f.inputs.length);
    } finally { resumed.close(); }
  });
}

test('DB 已提交后的取消只中断本次运行，恢复仍完成收尾且不重读源', async t => {
  const f = await setup(t), store = f.repository.archive, controller = new AbortController(); store.request(f.archiveRequest);
  const runner = createArchiveTransactionRunner({ store, afterPhase: async phase => { if (phase === 'DB_COMMITTED') controller.abort(); } });
  await assert.rejects(runner.run(f.archiveRequest.id, controller.signal)); assert.equal(store.operation(f.archiveRequest.id)!.phase, 'DB_COMMITTED');
  const resumed = createArchiveTransactionRunner({ store, copy: async () => { assert.fail('提交后取消不能重读源'); } });
  assert.deepEqual(await resumed.recover(), [{ id: f.archiveRequest.id, available: true }]); assert.equal(store.operation(f.archiveRequest.id)!.phase, 'FINALIZED');
});
