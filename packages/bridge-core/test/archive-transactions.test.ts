import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, readdir, rm, readFile, writeFile, lstat } from 'node:fs/promises';
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
      let firstSnapshot: unknown;
      for (let i = 1; i <= 10; i++) {
        await resumed.recover();
        if (![1, 2, 10].includes(i)) continue;
        const snapshot = {
          phase: reopened.archive.operation(request.id)!.phase,
          references: reopened.archive.references(request.id),
          objects: (await readdir(f.archive.objects.path)).sort(),
          inventory: reopened.detail(f.layout.reservation.modelId, { offset: 0, limit: 25 }),
        };
        assert.equal(snapshot.phase, 'FINALIZED');
        assert.equal(snapshot.references.length, f.inputs.length);
        if (i === 1) firstSnapshot = snapshot;
        else assert.deepEqual(snapshot, firstSnapshot, `第${i}次恢复必须与第一次相同`);
      }
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
  const old = new DatabaseSync(f.filePath); old.exec('DROP TABLE recording_print_receipts; DROP TABLE recording_print_events; DROP TABLE recording_print_artifacts; DROP TABLE recording_print_jobs; DROP TABLE recording_print_requests; DROP TABLE master_artwork_current; DROP TABLE master_artwork_versions; DROP TABLE recording_print_objects; DROP TRIGGER recording_record_permit_copy_guard; DROP TRIGGER recording_record_content_copy_guard; DROP TRIGGER recording_record_permit_media_guard; DROP TABLE recording_record_receipts; DROP TABLE recording_record_permits; DROP TABLE recording_record_events; DROP TABLE recording_record_current; DROP TABLE recording_record_visuals; DROP TABLE recording_records; DROP TABLE recording_record_write_guard; DROP TRIGGER recording_attempt_copy_no_blank; DROP TRIGGER recording_attempt_reservation_no_delete; DROP TRIGGER recording_attempt_reservation_no_rebind; DROP TRIGGER recording_attempt_active_media_no_update; DROP TABLE recording_attempt_receipts; DROP TABLE recording_attempt_events; DROP TABLE recording_attempts; DROP TABLE recording_plan_ledger; DROP TABLE recording_plan_versions; DROP TABLE collection_want_events; DROP TABLE collection_progress_snapshots; DROP TABLE collection_progress_ledger; DROP TABLE collection_wants; DROP TABLE spreadsheet_adjustments; DROP TABLE spreadsheet_rows; DROP TABLE spreadsheet_effects; DROP TABLE spreadsheet_heads; DROP TABLE spreadsheet_revisions; DROP TABLE spreadsheet_source_rows; DROP TABLE spreadsheet_sources; DROP TABLE spreadsheet_ledger; DROP TABLE reference_catalog_ledger; DROP TABLE reference_catalog_snapshots; DROP TABLE reference_catalog_matches; DROP TABLE reference_catalog_heads; DROP TABLE reference_catalog_revisions; DROP TABLE reference_sources; DROP TABLE archive_workflow_ledger; DROP TABLE archive_candidates; DROP TABLE archive_references; DROP TABLE archive_objects; DROP TABLE archive_operations; DROP TABLE archive_roots; PRAGMA user_version=12');
  const ledger = old.prepare('SELECT * FROM inventory_ledger ORDER BY rowid').all(); old.close();
  const failed = createCollectionRepository({ filePath: f.filePath, beforeCommit: action => { if (action === 'migrate-archive') throw new Error('合成迁移回滚'); } });
  assert.throws(() => failed.archive.operations()); failed.close();
  const check = new DatabaseSync(f.filePath); assert.equal(check.prepare('PRAGMA user_version').get()!.user_version, 12); assert.equal(check.prepare("SELECT count(*) n FROM sqlite_master WHERE name='archive_roots'").get()!.n, 0); check.close();
  const next = createCollectionRepository({ filePath: f.filePath }); try { assert.deepEqual(next.execution.asset(job.id), before); assert.deepEqual(next.archive.operations(), []); } finally { next.close(); }
  const after = new DatabaseSync(f.filePath); try { assert.equal(after.prepare('PRAGMA user_version').get()!.user_version, 21); assert.deepEqual(after.prepare('SELECT * FROM inventory_ledger ORDER BY rowid').all(), ledger); } finally { after.close(); }
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

test('真实复制首块落盘后SIGKILL，保留partial且冷恢复1/2/10次不改源、库存或重复引用', { timeout: 20_000 }, async t => {
  const f = await setup(t), request = f.archiveRequest;
  const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
  const sourceFiles = [f.file, ...f.inputs.map(input => {
    assert.ok('source' in input);
    return path.join(input.source.path, input.relative);
  })];
  const sources = await Promise.all(sourceFiles.map(async file => ({ file, sha256: digest(await readFile(file)), stat: await lstat(file, { bigint: true }) })));
  const beforeInventory = f.repository.detail(f.layout.reservation.modelId, { offset: 0, limit: 25 });
  const business = (repository: typeof f.repository) => repository.recordingRecords.read(db =>
    ['prepared_versions', 'recording_plan_versions', 'recording_records', 'physical_copies', 'inventory_ledger'].map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
  const beforeBusiness = business(f.repository);
  f.repository.archive.request(request);
  const { fork } = await import('node:child_process');
  const child = fork(new URL('./helpers/archive-crash-child.ts', import.meta.url), [f.filePath, request.id, 'COPY_PARTIAL'], { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  t.after(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const closed = once(child, 'close'); child.kill('SIGKILL'); await closed;
  });
  const [checkpoint] = await Promise.race([
    once(child, 'message', { signal: AbortSignal.timeout(5_000) }),
    once(child, 'exit').then(() => { throw new Error('合成子进程未到复制中检查点'); }),
  ]);
  assert.equal(checkpoint.phase, 'COPY_PARTIAL');
  assert.ok(checkpoint.size > 0 && checkpoint.size < checkpoint.expectedSize);
  const closed = once(child, 'close'); child.kill('SIGKILL');
  assert.deepEqual(await closed, [null, 'SIGKILL']);
  const resumed = createCollectionRepository({ filePath: f.filePath });
  try {
    const operation = resumed.archive.operation(request.id)!;
    assert.equal(operation.phase, 'INTENT_WRITTEN');
    assert.equal(resumed.archive.references(request.id).length, 0);
    assert.deepEqual(business(resumed), beforeBusiness, '复制中断不新增Frozen PREP、正式Plan或完成档案');
    assert.deepEqual(await readdir(f.archive.objects.path), []);
    const partials = (await readdir(operation.owned!.staging.path)).filter(name => name.includes('.partial-'));
    assert.equal(partials.length, 1);
    const partialPath = path.join(operation.owned!.staging.path, partials[0]!);
    const partial = await readFile(partialPath);
    assert.equal(partial.length, checkpoint.size);
    const runner = createArchiveTransactionRunner({ store: resumed.archive });
    let firstReferences: unknown;
    for (let i = 1; i <= 10; ++i) {
      assert.deepEqual(await runner.recover(), [{ id: request.id, available: true }]);
      if (![1, 2, 10].includes(i)) continue;
      assert.equal(resumed.archive.operation(request.id)!.phase, 'FINALIZED');
      const references = resumed.archive.references(request.id);
      assert.equal(references.length, f.inputs.length);
      if (i === 1) firstReferences = references; else assert.deepEqual(references, firstReferences);
      assert.equal((await readdir(f.archive.objects.path)).length, new Set(f.inputs.map(file => file.sha256)).size);
      for (const input of f.inputs) assert.equal(digest(await readFile(archiveObjectPath(f.archive, input.sha256))), input.sha256);
      assert.deepEqual(await readFile(partialPath), partial, '未完成的partial不覆盖、不自动清理');
      assert.deepEqual(resumed.detail(f.layout.reservation.modelId, { offset: 0, limit: 25 }), beforeInventory);
      assert.deepEqual(business(resumed), beforeBusiness);
    }
    for (const source of sources) {
      assert.equal(digest(await readFile(source.file)), source.sha256);
      const after = await lstat(source.file, { bigint: true });
      assert.equal(after.ino, source.stat.ino); assert.equal(after.mtimeNs, source.stat.mtimeNs); assert.equal(after.ctimeNs, source.stat.ctimeNs);
    }
  } finally { resumed.close(); }
});

test('DB 已提交后的取消只中断本次运行，恢复仍完成收尾且不重读源', async t => {
  const f = await setup(t), store = f.repository.archive, controller = new AbortController(); store.request(f.archiveRequest);
  const runner = createArchiveTransactionRunner({ store, afterPhase: async phase => { if (phase === 'DB_COMMITTED') controller.abort(); } });
  await assert.rejects(runner.run(f.archiveRequest.id, controller.signal)); assert.equal(store.operation(f.archiveRequest.id)!.phase, 'DB_COMMITTED');
  const resumed = createArchiveTransactionRunner({ store, copy: async () => { assert.fail('提交后取消不能重读源'); } });
  assert.deepEqual(await resumed.recover(), [{ id: f.archiveRequest.id, available: true }]); assert.equal(store.operation(f.archiveRequest.id)!.phase, 'FINALIZED');
});
