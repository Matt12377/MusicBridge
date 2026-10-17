import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile, lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createCollectionRepository } from '../../src/collection/repository.js';
import { createBackupWorkflowStore } from '../../src/recording/backup-workflow-store.js';
import { authorizeSourceDirectory } from '../../src/recording/source-files.js';
import { createLocalScanCoordinator } from '../../src/collection/local-scan-coordinator.js';
import { createScanReadAdmission } from '../../src/library/scan-read-admission.js';
import type { DatasetProjectionPort, DatasetProjectionCommand, DatasetProjectionCommandResults, DatasetProjectionCommandPayloads } from '../../src/collection/dataset-owner-protocol.js';
import type { MetadataReaderPort, MetadataReaderLifecycle } from '../../src/library/metadata-reader-types.js';
import { loadFreshMetadataReader } from '../helpers/mbrs003-audio-fixtures.js';
import { createCompletedScanSnapshotView, verifyCompletedScanSnapshotDatabase, LOCAL_SCAN_SNAPSHOT_LIMITS } from '../../src/collection/local-scan-snapshot-view.js';
import { scheduleScanAlbums, LOCAL_SCAN_DEFAULT_SETTINGS } from '../../src/collection/local-scan-settings.js';

const digest = (value: Buffer) => createHash('sha256').update(value).digest('hex');
function wav(): Buffer {
  const value = Buffer.alloc(44 + 800); value.write('RIFF'); value.writeUInt32LE(value.length - 8, 4); value.write('WAVEfmt ', 8);
  value.writeUInt32LE(16, 16); value.writeUInt16LE(1, 20); value.writeUInt16LE(2, 22); value.writeUInt32LE(48000, 24);
  value.writeUInt32LE(192000, 28); value.writeUInt16LE(4, 32); value.writeUInt16LE(16, 34); value.write('data', 36); value.writeUInt32LE(800, 40); return value;
}
async function ownedRoot(): Promise<string> {
  const root = process.env.TMPDIR; assert.ok(root && path.isAbsolute(root)); const info = await lstat(root);
  assert.ok(info.isDirectory() && !info.isSymbolicLink() && info.mode % 512 === 0o700 && await realpath(root) === root);
  const value = await mkdtemp(path.join(root, 'musicbridge-scan-view-')); await mkdir(path.join(value, 'audio'), { mode: 0o700 }); return value;
}
function projection(datasetId: string) {
  const admission = createScanReadAdmission({ isBusy: () => false }), context = { datasetId, epoch: randomUUID() };
  const port: DatasetProjectionPort = { async call<K extends DatasetProjectionCommand>(command: K, payload: DatasetProjectionCommandPayloads[K]): Promise<DatasetProjectionCommandResults[K]> {
    let result: unknown;
    if (command === 'scanReadAcquire') result = admission.acquire(context);
    else if (command === 'scanReadWatchRevocation') result = await admission.watchRevocation(context, (payload as { permitId: string }).permitId);
    else if (command === 'scanReadRelease') result = admission.release(context, (payload as { permitId: string }).permitId);
    else throw new Error('本夹具不允许Provider或其它投影读取。');
    return result as DatasetProjectionCommandResults[K];
  } };
  return { admission, port };
}
async function fixture(t: TestContext, albums = 3, options: { fault?: () => void; limits?: { facts?: number; bytes?: number }; reader?: (actual: MetadataReaderPort) => MetadataReaderPort } = {}) {
  const directory = await ownedRoot(), media = path.join(directory, 'audio'), file = path.join(directory, 'collection.sqlite'), stateFile = path.join(directory, 'identity.sqlite');
  const sourceFiles: { file: string; bytes: number; sha256: string }[] = [];
  for (let index = 0; index < albums; index++) {
    const album = path.join(media, '专辑-' + index); await mkdir(album, { mode: 0o700 });
    for (let track = 0; track < 2; track++) { const target = path.join(album, track + '.wav'), bytes = wav(); await writeFile(target, bytes, { flag: 'wx', mode: 0o600 }); sourceFiles.push({ file: target, bytes: bytes.length, sha256: digest(bytes) }); }
  }
  const repository = createCollectionRepository({ filePath: file }), state = createBackupWorkflowStore({ filePath: stateFile });
  repository.localCatalog.roots(); const identity = state.datasetIdentities.bind('default', file, false);
  repository.localCatalog.privateBindWorkbenchDataset(identity); const settings = repository.localCatalog.privateScanSettingsStore(identity);
  const source = repository.sources.authorize(randomUUID(), await authorizeSourceDirectory(media));
  const library = repository.localCatalog.registerRoot({ commandId: randomUUID(), sourceRootId: source.id, role: 'library' });
  const admitted = projection(identity.datasetId), events: MetadataReaderLifecycle[] = [];
  const actual = (await loadFreshMetadataReader()).createMetadataReader({ concurrency: 1, maxPending: 1, onLifecycle: event => events.push(event) });
  const reader = options.reader ? options.reader(actual) : actual;
  const view = createCompletedScanSnapshotView({ repository, identity, ...(options.fault ? { beforeCapture: options.fault } : {}), ...(options.limits ? { limits: options.limits } : {}) });
  let completionCalls = 0;
  const coordinator = createLocalScanCoordinator({ repository, identity, settings, datasetId: identity.datasetId, assertCurrent: () => identity.assertCurrent(), projection: admitted.port, reader,
    async onCompleted(job, context) {
      completionCalls++; assert.equal(coordinator.privateReaderTurn().occupied, false);
      assert.equal(events.filter(event => event.type === 'lease-acquired').length, events.filter(event => event.type === 'lease-released').length);
      if (context?.retry) view.retry(job.jobId); else view.captureCompleted(job.jobId);
    } });
  let closed = false;
  async function close() {
    if (closed) return; await coordinator.close(); view.close(); admitted.admission.close(); repository.close(); state.close(); closed = true;
    assert.throws(() => repository.localCatalog.roots()); assert.throws(() => state.overview());
    const starts = events.filter(event => event.type === 'worker-start'), exits = events.filter(event => event.type === 'worker-exit');
    assert.equal(starts.length, exits.length); assert.ok(exits.every(event => event.type === 'worker-exit' && event.exitCode === 0));
    assert.equal(events.filter(event => event.type === 'lease-acquired').length, events.filter(event => event.type === 'lease-released').length);
    for (const source of sourceFiles) { const bytes = await readFile(source.file), info = await lstat(source.file); assert.equal(bytes.length, source.bytes); assert.equal(digest(bytes), source.sha256); assert.equal(info.nlink, 1); }
  }
  t.after(close);
  return { directory, media, file, stateFile, source, sourceFiles, repository, state, identity, settings, library, admitted, events, view, coordinator, close,
    completionCalls: () => completionCalls,
    async scan() { const value = coordinator.start({ commandId: randomUUID(), libraryRootId: library.id, expectedRootRevision: library.revision }); await coordinator.privateWait(value.jobId); const completed = coordinator.get(value.jobId); assert.equal(completed.phase, 'completed'); return completed; } };
}
function settingsSave(f: Awaited<ReturnType<typeof fixture>>, concurrency: number) {
  const current = f.settings.read(f.identity);
  return f.settings.save(f.identity, { schema: 1, datasetId: f.identity.datasetId, eventId: randomUUID(), commandId: randomUUID(), kind: 'settings', expectedRevision: current.revision,
    settings: { revision: (BigInt(current.revision) + 1n).toString(), albumConcurrency: concurrency } });
}
function originalScanRows(file: string) {
  const db = new DatabaseSync(file, { readOnly: true, allowExtension: false });
  try { return Object.fromEntries(['local_scan_jobs', 'local_scan_batches', 'local_scan_checkpoints', 'local_scan_receipts', 'local_catalog_ledger'].map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()])); }
  finally { db.close(); }
}

test('002完成快照：实际Scanner同库全批全文及完整目录字段落盘，冷开同身份回读无Reader/Provider', { timeout: 60_000 }, async t => {
  const f = await fixture(t); const done = await f.scan(), view = f.view.load(f.library.id), before = originalScanRows(f.file);
  assert.equal(view.status, 'ready'); assert.equal(view.lastSuccess?.snapshot.members.length, 6); assert.deepEqual(view.lastSuccess?.snapshot.job, done);
  const batches = before.local_scan_batches!;
  assert.deepEqual(view.lastSuccess?.snapshot.batches, batches.map(row => ({ batchId: row.id, request: row.request, result: row.result })));
  assert.equal(view.lastSuccess?.snapshot.frozen.readerConcurrency, 1); assert.equal(f.view.captureCompleted(done.jobId).lastSuccess?.attempt.attemptId, view.lastSuccess?.attempt.attemptId);
  await f.close(); const repository = createCollectionRepository({ filePath: f.file }), state = createBackupWorkflowStore({ filePath: f.stateFile });
  try { repository.localCatalog.roots(); const identity = state.datasetIdentities.bind('default', f.file, false); assert.equal(identity.datasetId, f.identity.datasetId);
    repository.localCatalog.privateBindWorkbenchDataset(identity); const cold = createCompletedScanSnapshotView({ repository, identity });
    assert.deepEqual(cold.load(f.library.id), view); assert.deepEqual(originalScanRows(f.file), before); cold.close();
  } finally { repository.close(); state.close(); }
});

test('002完成快照：捕获失败独立留attempt及旧成功原件，显式retry不重新扫描或解析', { timeout: 60_000 }, async t => {
  let failure = false; const f = await fixture(t, 2, { fault() { if (failure) throw new Error('受控派生快照故障'); } });
  const first = await f.scan(), success = f.view.load(f.library.id).lastSuccess!; const readerCount = f.events.filter(event => event.type === 'worker-start').length;
  failure = true; const next = await f.scan(), failed = f.view.load(f.library.id); assert.equal(next.phase, 'completed'); assert.equal(failed.status, 'failed');
  assert.deepEqual(failed.lastSuccess, success); assert.equal(failed.retryJobId, next.jobId); assert.equal(failed.latestAttempt?.failureCode, 'CAPTURE_FAILED');
  const immutableScan = originalScanRows(f.file); assert.equal(f.view.captureCompleted(next.jobId).latestAttempt?.attemptId, failed.latestAttempt?.attemptId);
  failure = false; await f.coordinator.retryCompletedSnapshot(next.jobId); const recovered = f.view.load(f.library.id);
  assert.equal(recovered.status, 'ready'); assert.equal(recovered.lastSuccess?.snapshot.job.jobId, next.jobId);
  assert.equal(recovered.latestAttempt?.attempt, 2); assert.equal(f.events.filter(event => event.type === 'worker-start').length, readerCount);
  assert.deepEqual(originalScanRows(f.file), immutableScan); assert.equal(f.coordinator.get(first.jobId).phase, 'completed');
  f.repository.privateMobileCatalogAccess!(db => { assert.equal(Number(db.prepare("SELECT count(*) n FROM local_scan_snapshot_commits WHERE json_extract(data,'$.status')='failed'").get()!.n), 1); verifyCompletedScanSnapshotDatabase(db); });
});

test('002完成快照：已撤销或重关联root明确不可用，load/retry不能复活来源授权', { timeout: 60_000 }, async t => {
  const f = await fixture(t, 1); const done = await f.scan(); f.repository.sources.revoke({ commandId: randomUUID(), id: f.source.id });
  assert.equal(f.view.load(f.library.id).status, 'unavailable'); assert.equal(f.view.load(f.library.id).lastSuccess, null);
  assert.throws(() => f.view.captureCompleted(done.jobId)); assert.equal(f.repository.sources.root(f.source.id).authorized, false);
  await assert.rejects(f.coordinator.retryCompletedSnapshot(done.jobId)); f.repository.privateMobileCatalogAccess!(verifyCompletedScanSnapshotDatabase);
  const g = await fixture(t, 1); const old = await g.scan(); const other = path.join(g.directory, 'other-root'); await mkdir(other, { mode: 0o700 });
  const source = g.repository.sources.authorize(randomUUID(), await authorizeSourceDirectory(other));
  g.repository.localCatalog.relinkRoot({ commandId: randomUUID(), rootId: g.library.id, expectedRevision: g.library.revision, sourceRootId: source.id, role: 'library' });
  assert.equal(g.view.load(g.library.id).status, 'unavailable'); assert.throws(() => g.view.captureCompleted(old.jobId));
  assert.equal(g.repository.localCatalog.root(g.library.id).sourceRootId, source.id); g.repository.privateMobileCatalogAccess!(verifyCompletedScanSnapshotDatabase);
});

test('002完成快照：实际同对象身份必需，未bind/跨库/同UUID伪对象/关闭都不能取得入口', { timeout: 30_000 }, async t => {
  const f = await fixture(t, 1); await f.scan(); const fake = { datasetId: f.identity.datasetId, assertCurrent() {} };
  assert.throws(() => createCompletedScanSnapshotView({ repository: f.repository, identity: fake }));
  const otherFile = path.join(f.directory, 'unbound.sqlite'), other = createCollectionRepository({ filePath: otherFile });
  try { other.localCatalog.roots(); assert.throws(() => createCompletedScanSnapshotView({ repository: other, identity: f.identity }));
    assert.throws(() => createCompletedScanSnapshotView({ repository: { ...f.repository, privateMobileCatalogAccess: other.privateMobileCatalogAccess! }, identity: f.identity }));
    const otherState = createBackupWorkflowStore({ filePath: path.join(f.directory, 'other-identity.sqlite') });
    try { const otherIdentity = otherState.datasetIdentities.bind('default', otherFile, false); other.localCatalog.privateBindWorkbenchDataset(otherIdentity);
      assert.throws(() => createCompletedScanSnapshotView({ repository: f.repository, identity: otherIdentity }));
    } finally { otherState.close(); }
  } finally { other.close(); }
  f.view.close(); assert.throws(() => f.view.load(f.library.id)); assert.throws(() => f.view.captureCompleted(f.coordinator.page({ offset: 0, limit: 1 }).items[0]!.jobId));
});

test('002完成快照：旧无表schema合法，partial/坏chunk/坏commit/漏尾/原批不符均冷开拒绝', { timeout: 60_000 }, async t => {
  const empty = await fixture(t, 1); empty.repository.privateMobileCatalogAccess!(db => { verifyCompletedScanSnapshotDatabase(db); assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name='local_scan_snapshot_commits'").get(), undefined); });
  for (const mutate of [
    (db: DatabaseSync) => { db.exec('DROP TRIGGER local_scan_snapshot_chunks_no_update'); },
    (db: DatabaseSync) => { db.exec('DROP TRIGGER local_scan_snapshot_chunks_no_update'); db.prepare('UPDATE local_scan_snapshot_chunks SET data=? WHERE ordinal=0').run('YWJj'); db.exec("CREATE TRIGGER local_scan_snapshot_chunks_no_update BEFORE UPDATE ON local_scan_snapshot_chunks BEGIN SELECT RAISE(ABORT,'完成扫描快照原件保留'); END"); },
    (db: DatabaseSync) => { db.exec('DROP TRIGGER local_scan_snapshot_commits_no_update'); db.prepare("UPDATE local_scan_snapshot_commits SET data=json_set(data,'$.sha256',?)").run('f'.repeat(64)); db.exec("CREATE TRIGGER local_scan_snapshot_commits_no_update BEFORE UPDATE ON local_scan_snapshot_commits BEGIN SELECT RAISE(ABORT,'完成扫描快照原件保留'); END"); },
    (db: DatabaseSync) => { db.exec('DROP TRIGGER local_scan_snapshot_chunks_no_delete'); db.exec('DELETE FROM local_scan_snapshot_chunks'); db.exec("CREATE TRIGGER local_scan_snapshot_chunks_no_delete BEFORE DELETE ON local_scan_snapshot_chunks BEGIN SELECT RAISE(ABORT,'完成扫描快照原件保留'); END"); },
    (db: DatabaseSync) => { db.exec('DROP TRIGGER local_scan_batches_immutable'); db.prepare("UPDATE local_scan_batches SET result=json_set(result,'$.job.progress.accepted','999')").run(); },
  ]) {
    const f = await fixture(t, 1); await f.scan(); await f.close(); const raw = new DatabaseSync(f.file, { allowExtension: false });
    try { mutate(raw); } finally { raw.close(); }
    const cold = createCollectionRepository({ filePath: f.file }); try { assert.throws(() => cold.localCatalog.roots()); } finally { cold.close(); }
  }
});

test('002完成快照：10000/32MiB上限固定，真实整组收紧预算失败不截尾并保留旧成功', { timeout: 60_000 }, async t => {
  assert.equal(LOCAL_SCAN_SNAPSHOT_LIMITS.facts, 10000); assert.equal(LOCAL_SCAN_SNAPSHOT_LIMITS.bytes, 33554432); assert.equal(LOCAL_SCAN_SNAPSHOT_LIMITS.ownerMs, 2000);
  const f = await fixture(t, 2); const first = await f.scan(), original = f.view.load(f.library.id).lastSuccess!;
  assert.throws(() => createCompletedScanSnapshotView({ repository: f.repository, identity: f.identity, limits: { facts: 10001 } }));
  assert.throws(() => createCompletedScanSnapshotView({ repository: f.repository, identity: f.identity, limits: { bytes: 33554433 } }));
  f.view.close(); const limited = createCompletedScanSnapshotView({ repository: f.repository, identity: f.identity, limits: { facts: 1 } });
  const second = await f.scan(); const failed = limited.captureCompleted(second.jobId); assert.equal(failed.status, 'failed'); assert.equal(failed.latestAttempt?.failureCode, 'LIMIT_EXCEEDED');
  assert.deepEqual(failed.lastSuccess, original); assert.equal(failed.lastSuccess?.snapshot.members.length, 4); assert.equal(failed.lastSuccess?.snapshot.job.jobId, first.jobId);
  limited.close(); const bytesLimited = createCompletedScanSnapshotView({ repository: f.repository, identity: f.identity, limits: { bytes: 512 } });
  const failedBytes = bytesLimited.retry(second.jobId); assert.equal(failedBytes.latestAttempt?.failureCode, 'LIMIT_EXCEEDED'); assert.deepEqual(failedBytes.lastSuccess, original);
  bytesLimited.close(); f.repository.privateMobileCatalogAccess!(verifyCompletedScanSnapshotDatabase);
});

// 新入口全部使用同一次实际compiled Core图；五输入是纯合成字节，普通测试不执行Native/全音频解码。
import { fstatSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createCueSyntheticRareInputs } from '../../src/library/local-cue-format-qualification.js';
import type { CueSidecarLifecycle } from '../../src/library/cue-sidecar-reader.js';
let compiledGraph503:Promise<Awaited<ReturnType<typeof readCompiledGraph503>>>|undefined;
async function readCompiledGraph503(){
  const core=fileURLToPath(new URL('../../',import.meta.url)),declaration=process.env.MBRS003_READER_BUILD_BINDING;
  assert.ok(declaration&&path.isAbsolute(declaration));const binding=JSON.parse(await readFile(declaration,'utf8'));
  const receiptPath=binding.originalPreparationReceipt?.path??path.join(path.dirname(declaration),'preparation-receipt.json');
  const raw=await readFile(receiptPath);if(binding.originalPreparationReceipt){assert.equal(raw.length,binding.originalPreparationReceipt.bytes);assert.equal(digest(raw),binding.originalPreparationReceipt.sha256);}
  const receipt=JSON.parse(raw.toString('utf8'));
  assert.equal(receipt.schema,'core-test.reader-preparation.v1');assert.equal(receipt.status,'FRESH_READER_PREPARED');assert.equal(receipt.inputsUnchanged,true);assert.equal(receipt.outputsUnchanged,true);
  assert.deepEqual(receipt.stages.map((row:{name:string})=>row.name),['fresh-contracts-compiler','fresh-core-compiler','fresh-fixed-metadata-worker']);
  assert.ok(receipt.stages.every((row:{compilerExit:number;startedMs:number;finishedMs:number})=>row.compilerExit===0&&row.startedMs>0&&row.finishedMs>=row.startedMs));
  for(const row of receipt.sourceInputs as {path:string;bytes:number;sha256:string}[]){const bytes=await readFile(path.resolve(core,'../..',row.path));assert.equal(bytes.length,row.bytes);assert.equal(digest(bytes),row.sha256);}
  for(const row of receipt.outputs as {path:string;bytes:number;sha256:string}[]){
    if(row.path.endsWith('.bundle.build.json'))continue;
    const file=path.resolve(core,'../..',row.path),bytes=await readFile(file),info=await lstat(file);
    assert.ok(info.isFile()&&!info.isSymbolicLink());assert.equal(bytes.length,row.bytes);assert.equal(digest(bytes),row.sha256);
    const stageName=row.path.includes('/metadata-reader-worker.bundle.')?'fresh-fixed-metadata-worker':row.path.startsWith('packages/contracts/')?'fresh-contracts-compiler':'fresh-core-compiler';
    const stage=receipt.stages.find((item:{name:string})=>item.name===stageName);assert.ok(stage);
    const start=binding.timeBasis==='whole-source-standard-run'?binding.compilerStartedAtMs:stage.startedMs;
    const finish=binding.timeBasis==='whole-source-standard-run'?binding.compilerFinishedAtMs:stage.finishedMs;
    assert.ok(info.mtimeMs>=start&&info.mtimeMs<=finish,'完整产物必须属于其真实负责阶段或已证明的整体标准区间');
  }
  const reader=await loadFreshMetadataReader(),cueDeclaration=process.env.MBRS003_CUE_BUILD_BINDING;assert.ok(cueDeclaration&&path.isAbsolute(cueDeclaration));
  const cueBinding=JSON.parse(await readFile(cueDeclaration,'utf8'));assert.equal(cueBinding.schema,'mbrs003.cue.fresh-build.v1');assert.equal(cueBinding.compilerExit,0);
  assert.deepEqual(cueBinding.sourceInputs.map((row:{file:string})=>row.file).sort(),['src/library/cue-sidecar-reader.ts','src/library/cue-sidecar-worker.ts']);
  assert.equal(cueBinding.outputs.length,4);
  for(const row of [...cueBinding.sourceInputs,...cueBinding.outputs] as {file:string;bytes:number;sha256:string}[]){
    const file=path.join(core,row.file),bytes=await readFile(file);assert.equal(bytes.length,row.bytes);assert.equal(digest(bytes),row.sha256);
    if(row.file.startsWith('dist/')){const info=await lstat(file);assert.ok(info.mtimeMs>=cueBinding.compilerStartedAtMs&&info.mtimeMs<=cueBinding.compilerFinishedAtMs);}
  }
  for(const stem of ['reader','worker']){const js='dist/library/cue-sidecar-'+stem+'.js',map=JSON.parse(await readFile(path.join(core,js+'.map'),'utf8'));
    assert.equal(map.file,path.basename(js));assert.equal(map.sourceRoot,'');assert.equal(map.sources.length,1);assert.equal(path.resolve(path.dirname(path.join(core,js)),map.sources[0]),path.join(core,'src/library/cue-sidecar-'+stem+'.ts'));}
  const load=async(relative:string)=>import(pathToFileURL(path.join(core,'dist',relative+'.js')).href);
  return {reader,repository:await load('collection/repository') as typeof import('../../src/collection/repository.js'),
    state:await load('recording/backup-workflow-store') as typeof import('../../src/recording/backup-workflow-store.js'),
    sources:await load('recording/source-files') as typeof import('../../src/recording/source-files.js'),
    scanner:await load('collection/local-scan-coordinator') as typeof import('../../src/collection/local-scan-coordinator.js'),
    admission:await load('library/scan-read-admission') as typeof import('../../src/library/scan-read-admission.js'),
    cue:await load('library/cue-sidecar-reader') as typeof import('../../src/library/cue-sidecar-reader.js'),
    view:await load('collection/local-scan-snapshot-view') as typeof import('../../src/collection/local-scan-snapshot-view.js')};
}
async function normalScan503(t:TestContext,options:{badMagic?:boolean;readerBudget?:boolean;onMetadata?:(event:MetadataReaderLifecycle,coordinator:ReturnType<typeof createLocalScanCoordinator>)=>void;single?:boolean}={}){
  const graph=await(compiledGraph503??=readCompiledGraph503()),directory=await ownedRoot(),media=path.join(directory,'audio');
  const fixtures=options.single?createCueSyntheticRareInputs().filter(row=>row.id==='tta'):createCueSyntheticRareInputs();
  const originals:{file:string;sha256:string;bytes:number}[]=[];
  for(const fixture of fixtures){
    const album=path.join(media,fixture.id+'-合成专辑');await mkdir(album,{mode:0o700});const bytes=Buffer.from(fixture.data);if(options.badMagic)bytes.writeUInt8(bytes.readUInt8(0)^0xff,0);
    const file=path.join(album,fixture.file);await writeFile(file,bytes,{flag:'wx',mode:0o600});originals.push({file,sha256:digest(bytes),bytes:bytes.length});
    if(!options.single){const cue=Buffer.from('TITLE "合成 '+fixture.id+'"\nFILE "'+fixture.file+'" WAVE\nTRACK 01 AUDIO\nTITLE "甲轨"\nINDEX 01 00:00:00\nTRACK 02 AUDIO\nTITLE "乙轨"\nINDEX 01 00:00:15\n');
      const cueFile=path.join(album,'专辑.cue');await writeFile(cueFile,cue,{flag:'wx',mode:0o600});originals.push({file:cueFile,sha256:digest(cue),bytes:cue.length});}
  }
  const file=path.join(directory,'catalog.sqlite'),stateFile=path.join(directory,'identity.sqlite'),repository=graph.repository.createCollectionRepository({filePath:file}),state=graph.state.createBackupWorkflowStore({filePath:stateFile});
  repository.localCatalog.roots();const identity=state.datasetIdentities.bind('default',file,false);repository.localCatalog.privateBindWorkbenchDataset(identity);
  const settings=repository.localCatalog.privateScanSettingsStore(identity);
  const source=repository.sources.authorize(randomUUID(),await graph.sources.authorizeSourceDirectory(media)),library=repository.localCatalog.registerRoot({commandId:randomUUID(),sourceRootId:source.id,role:'library'});
  const admission=graph.admission.createScanReadAdmission({isBusy:()=>false}),scope={datasetId:identity.datasetId,epoch:randomUUID()},permits=new Set<string>();
  const port:DatasetProjectionPort={async call<K extends DatasetProjectionCommand>(command:K,payload:DatasetProjectionCommandPayloads[K]):Promise<DatasetProjectionCommandResults[K]>{let value:unknown;
    if(command==='scanReadAcquire'){value=admission.acquire(scope);permits.add((value as {permitId:string}).permitId);}
    else if(command==='scanReadWatchRevocation')value=await admission.watchRevocation(scope,(payload as {permitId:string}).permitId);
    else if(command==='scanReadRelease'){const id=(payload as {permitId:string}).permitId;value=admission.release(scope,id);assert.equal(permits.delete(id),true);}
    else throw Error('正常扫描组件没有Provider投影');return value as DatasetProjectionCommandResults[K];}};
  const metadata:MetadataReaderLifecycle[]=[],cues:CueSidecarLifecycle[]=[],fdErrors:unknown[]=[];let coordinator!:ReturnType<typeof createLocalScanCoordinator>;
  const observe=(event:MetadataReaderLifecycle|CueSidecarLifecycle)=>{if(event.type==='lease-released'){try{fstatSync(event.fd);fdErrors.push(new Error('原FD释放点仍可读取'));}catch(error){if((error as NodeJS.ErrnoException).code!=='EBADF')fdErrors.push(error);}}};
  const reader=graph.reader.createMetadataReader({concurrency:1,maxPending:1,cueInputMetadataEnabled:true,
    ...(options.readerBudget?{trustedBudget:{totalReadBytes:64,singleReadBytes:64,singleAllocationBytes:64}}:{}),
    onLifecycle(event){metadata.push(event);observe(event);if(coordinator)options.onMetadata?.(event,coordinator);}});
  const cueReader=graph.cue.createCueSidecarReader({onLifecycle(event){cues.push(event);observe(event);}}),view=graph.view.createCompletedScanSnapshotView({repository,identity});
  coordinator=graph.scanner.createLocalScanCoordinator({repository,identity,settings,datasetId:identity.datasetId,assertCurrent:()=>identity.assertCurrent(),projection:port,
    reader,cueReader,cueInputMetadataEnabled:true,async onCompleted(job){view.captureCompleted(job.jobId);}});
  let closed=false;async function close(){if(closed)return;await coordinator.close();view.close();admission.close();repository.close();state.close();closed=true;
    assert.equal(permits.size,0);assert.deepEqual(fdErrors,[]);
    for(const events of [metadata,cues]){assert.equal(events.filter(e=>e.type==='worker-start').length,events.filter(e=>e.type==='worker-exit').length);
      assert.equal(events.filter(e=>e.type==='lease-acquired').length,events.filter(e=>e.type==='lease-released').length);}
    for(const original of originals){const bytes=await readFile(original.file);assert.equal(bytes.length,original.bytes);assert.equal(digest(bytes),original.sha256);}}
  t.after(close);
  return {graph,directory,media,file,stateFile,repository,state,identity,source,library,coordinator,metadata,cues,fdErrors,view,permits,fixtures,close,
    async scan(){const start=coordinator.start({commandId:randomUUID(),libraryRootId:library.id,expectedRootRevision:library.revision});await coordinator.privateWait(start.jobId);return coordinator.get(start.jobId);}};
}
test('CD35正常Scan495：默认APE拒绝保持，显式冷门读取经真实Worker建立同SQL资产与CUE引用并冷读原事实',async t=>{
  const f=await normalScan503(t),probe=path.join(f.directory,'默认APE');await mkdir(probe,{mode:0o700});
  const ape=await readFile(new URL('../fixtures/mbrs003/ape-assessment/silence_mono8k.ape',import.meta.url));assert.equal(ape.length,174);assert.equal(digest(ape),'e49c9f3a28587d9f10644d64a72e047432249a8b3a8ff34f2c8f61fe4c07ba1c');
  await writeFile(path.join(probe,'默认.ape'),ape,{flag:'wx',mode:0o600});const capability=f.repository.sources.authorize(randomUUID(),await f.graph.sources.authorizeSourceDirectory(probe)),observed=await f.graph.sources.readonlySourceCandidateMetadata(capability,'默认.ape');
  const reader=f.graph.reader.createMetadataReader();try{const rejected=await reader.read({root:capability,relative:'默认.ape',expectedSignature:observed.signature});assert.equal(rejected.status,'failure');assert.ok(rejected.status==='failure');assert.equal(rejected.code,'UNSUPPORTED');assert.equal(rejected.readEvidence?.bytesRead,64);}finally{await reader.close();}
  const done=await f.scan();assert.equal(done.phase,'completed');assert.deepEqual(done.progress,{visited:'10',accepted:'10',rejected:'0'});
  assert.equal(f.repository.localScan.privateJobParserVersion(done.jobId),'cue-input-scan/v39-v1');assert.equal(f.repository.localCatalog.pageTracks({offset:0,limit:200}).items.length,5);
  const facts=[];
  for(const fixture of f.fixtures){const relative=fixture.id+'-合成专辑/'+fixture.file,entry=f.repository.localScan.privateCurrentFileState(f.library.id,relative)!;
    assert.equal(entry.value.outcome,'accepted');assert.ok(entry.value.assetId&&entry.value.trackId&&entry.value.readFacts);assert.equal(entry.value.readFacts.technical.sampleRateHz,44100);assert.equal(entry.value.readFacts.technical.channels,2);
    assert.equal(entry.value.parserVersion,['tta','tak'].includes(fixture.id)?'musicbridge-cue-header/mbrs003-v1':'music-metadata-11.15.0/mbrs003-v4');
    assert.equal(entry.value.readFacts.readEvidence.wholeAudioHash,false);assert.equal(entry.value.readFacts.readEvidence.wholeAudioDecode,false);
    const asset=f.repository.localCatalog.asset(entry.value.assetId);assert.equal(asset.sampleFrames,null);assert.equal(asset.timebaseHz,null);
    const cue=f.repository.localScan.privateCueSnapshot(f.library.id,fixture.id+'-合成专辑/专辑.cue')!;assert.equal(cue.item.outcome,'accepted');assert.equal(cue.item.result!.tracks.length,2);
    assert.ok(cue.item.result!.tracks.every(track=>track.assetReference.assetId===asset.id&&track.endFrames===null));facts.push({relative,entry,cue});
  }
  assert.equal(f.view.load(f.library.id).lastSuccess?.snapshot.members.length,5);const rows=originalScanRows(f.file);await f.close();
  const cold=f.graph.repository.createCollectionRepository({filePath:f.file}),state=f.graph.state.createBackupWorkflowStore({filePath:f.stateFile});try{
    cold.localCatalog.roots();const identity=state.datasetIdentities.bind('default',f.file,false);assert.equal(identity.datasetId,f.identity.datasetId);cold.localCatalog.privateBindWorkbenchDataset(identity);
    assert.deepEqual(originalScanRows(f.file),rows);for(const row of facts){assert.deepEqual(cold.localScan.privateCurrentFileState(f.library.id,row.relative),row.entry);assert.deepEqual(cold.localScan.privateCueSnapshot(f.library.id,row.cue.item.relative),row.cue);}
  }finally{cold.close();state.close();}
  t.diagnostic('同一次真实compiled Core/固定Worker、正常Walk/原lease/同SQL资产与CUE冷读；头声明不冒实际PCM/Native分轨或完整Main。');
  await relocationCold507(t, f.graph);
});
test('CD35正常Scan495：坏头与收紧预算不建资产，取消等实际Worker和FD闭口后不接纳迟到事实',async t=>{
  const bad=await normalScan503(t,{badMagic:true}),failed=await bad.scan();assert.equal(failed.phase,'completed');assert.deepEqual(failed.progress,{visited:'10',accepted:'0',rejected:'10'});
  assert.equal(bad.repository.localCatalog.pageTracks({offset:0,limit:200}).items.length,0);for(const fixture of bad.fixtures){const file=bad.repository.localScan.privateCurrentFileState(bad.library.id,fixture.id+'-合成专辑/'+fixture.file)!;assert.equal(file.value.outcome,'rejected');assert.equal(file.value.assetId,null);assert.equal(file.value.failureCode,'UNSUPPORTED');}
  await bad.close();const budget=await normalScan503(t,{single:true,readerBudget:true}),bounded=await budget.scan();assert.deepEqual(bounded.progress,{visited:'1',accepted:'0',rejected:'1'});
  const boundedFile=budget.repository.localScan.privateCurrentFileState(budget.library.id,'tta-合成专辑/'+budget.fixtures[0]!.file)!;assert.equal(boundedFile.value.failureCode,'BUDGET_EXCEEDED');assert.equal(boundedFile.value.assetId,null);await budget.close();
  let cancel:Promise<import('@music-bridge/contracts').ScanJobRecord>|undefined;
  const current=await normalScan503(t,{single:true,onMetadata(event,coordinator){if(event.type==='worker-start'&&!cancel){const job=coordinator.page({offset:0,limit:1}).items[0]!;cancel=coordinator.cancel({commandId:randomUUID(),jobId:job.jobId,expectedRevision:job.jobRevision});}}});
  const pending=current.scan();while(!cancel){await new Promise<void>(resolve=>setImmediate(resolve));}const cancelled=await cancel;assert.equal(cancelled.phase,'cancelled');await pending;assert.equal(current.coordinator.get(cancelled.jobId).phase,'cancelled');
  assert.equal(current.repository.localCatalog.pageTracks({offset:0,limit:200}).items.length,0);assert.equal(current.coordinator.privateReaderTurn().occupied,false);assert.equal(current.permits.size,0);
  const before=originalScanRows(current.file);await new Promise<void>(resolve=>setImmediate(resolve));await new Promise<void>(resolve=>setImmediate(resolve));assert.deepEqual(originalScanRows(current.file),before);await current.close();
});

type RelocationInput507 = { id: 'ape' | 'tta' | 'flac' | 'mpc7'; file: string; data: Buffer; parserVersion: string; container: string };
function relocationJobRows507(file: string, jobId: string) {
  const db = new DatabaseSync(file, { readOnly: true, allowExtension: false });
  try { return { jobs: db.prepare('SELECT * FROM local_scan_jobs WHERE id=? ORDER BY rowid').all(jobId),
    batches: db.prepare('SELECT * FROM local_scan_batches WHERE job_id=? ORDER BY rowid').all(jobId),
    checkpoints: db.prepare('SELECT * FROM local_scan_checkpoints WHERE job_id=? ORDER BY rowid').all(jobId),
    receipts: db.prepare('SELECT * FROM local_scan_receipts WHERE job_id=? ORDER BY rowid').all(jobId) }; }
  finally { db.close(); }
}
function relocationRows507(file: string) {
  const db = new DatabaseSync(file, { readOnly: true, allowExtension: false });
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
    const result: Record<string, unknown[]> = {};
    for (const row of tables) { assert.equal(typeof row.name, 'string'); const name = String(row.name); assert.match(name, /^[a-z][a-z0-9_]*$/u);
      result[name] = db.prepare('SELECT * FROM "' + name + '" ORDER BY rowid').all(); }
    assert.deepEqual(db.prepare('PRAGMA integrity_check').all().map(row => String(row.integrity_check)), ['ok']);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []); return result;
  } finally { db.close(); }
}
/** 只复用原自有 FLAC 字节变换；不导入旧 013 测试或其硬编码夹具/120 秒等待。 */
async function relocationOwnedFlac507(): Promise<Buffer> {
  const directory = new URL('../fixtures/mbrs012-source/', import.meta.url), raw = await readFile(new URL('manifest.json', directory));
  assert.equal(digest(raw), '5a3621481eb22801c020589b393c3a1ffa32e3d132766ea6e8db6e33fa47714b');
  const manifest = JSON.parse(raw.toString('utf8')) as { synthetic: boolean; allContentOwned: boolean; realLibraryUsed: boolean; files: { file: string; sha256: string; bytes: number; synthetic?: boolean; audioPayloadSha256?: string }[] };
  assert.equal(manifest.synthetic, true); assert.equal(manifest.allContentOwned, true); assert.equal(manifest.realLibraryUsed, false);
  const entry = manifest.files.find(row => row.file === 'owned-stereo-fixed-tags.flac'); assert.ok(entry); assert.equal(entry.synthetic, true);
  const original = await readFile(new URL(entry.file, directory)); assert.equal(original.length, entry.bytes); assert.equal(digest(original), entry.sha256);
  assert.equal(original.subarray(0, 4).toString('ascii'), 'fLaC'); const kept: Buffer[] = []; let at = 4, last = false;
  while (!last) {
    assert.ok(at + 4 <= original.length); const header = original.subarray(at, at + 4), length = header.readUIntBE(1, 3), end = at + 4 + length;
    assert.ok(end < original.length); last = Boolean(header[0]! & 0x80);
    if ((header[0]! & 0x7f) !== 1) { const block = Buffer.from(original.subarray(at, end)); block[0] = block[0]! & 0x7f; kept.push(block); }
    at = end;
  }
  assert.equal(digest(original.subarray(at)), entry.audioPayloadSha256);
  const application = Buffer.from([0x82, 0, 0, 8, ...Buffer.from('MB13data')]); assert.equal(application.length, 12);
  const result = Buffer.concat([original.subarray(0, 4), ...kept, application, original.subarray(at)]);
  assert.deepEqual(result.subarray(result.length - (original.length - at)), original.subarray(at)); return result;
}
/** 正常 Scanner 作者→原 013 工厂→同端口 grant/ticket→物理发布→同 SQL 冷审；不签 Native 或 Electron Main。 */
// 原严格wire快照用null prototype，SQL只读视图是普通对象；逐字段完整数据比较保留两者原形。
function sameClosedData507(actual: unknown, expected: unknown): void {
  assert.ok(actual && typeof actual === 'object' && expected && typeof expected === 'object');
  assert.deepEqual(Object.keys(actual).sort(), Object.keys(expected).sort());
  assert.deepEqual(JSON.parse(JSON.stringify(actual)), JSON.parse(JSON.stringify(expected)));
}
async function relocationCold507(t: TestContext, graph: Awaited<ReturnType<typeof readCompiledGraph503>>): Promise<void> {
  assert.equal(graph, await compiledGraph503);
  // 原测试子进程的统一较小上限；两个场景和全部等待只消费剩余期限，绝不每场景重起 90/120 秒。
  const deadlineAt = performance.timeOrigin + 60_000;
  const remaining = (): number => { const value = Math.floor(deadlineAt - Date.now()); assert.ok(value > 0, '507 原测试进程剩余期限已耗尽，保留原计划与材料'); return value; };
  remaining(); const core = fileURLToPath(new URL('../../', import.meta.url));
  const declaration = process.env.MBRS003_READER_BUILD_BINDING; assert.ok(declaration && path.isAbsolute(declaration));
  const binding = JSON.parse(await readFile(declaration, 'utf8')), receiptPath = binding.originalPreparationReceipt?.path ?? path.join(path.dirname(declaration), 'preparation-receipt.json');
  const rawReceipt = await readFile(receiptPath); if (binding.originalPreparationReceipt) { assert.equal(rawReceipt.length, binding.originalPreparationReceipt.bytes); assert.equal(digest(rawReceipt), binding.originalPreparationReceipt.sha256); }
  const receipt = JSON.parse(rawReceipt.toString('utf8')); assert.equal(receipt.schema, 'core-test.reader-preparation.v1'); assert.equal(receipt.status, 'FRESH_READER_PREPARED');
  assert.equal(receipt.inputsUnchanged, true); assert.equal(receipt.outputsUnchanged, true);
  const stems = ['collection/local-relocation-service', 'collection/source-relocation-authority', 'collection/local-relocation-journal',
    'stream/physical-resource-locks', 'collection/local-scan-store', 'library/local-cue-format-qualification'];
  for (const stem of stems) {
    const sourceName = 'packages/bridge-core/src/' + stem + '.ts', source = receipt.sourceInputs.find((row: { path: string }) => row.path === sourceName);
    assert.ok(source, '507 新使用的原工厂必须位于同一次完整 Core 输入收据');
    const sourceBytes = await readFile(path.join(core, 'src', stem + '.ts')); assert.equal(sourceBytes.length, source.bytes); assert.equal(digest(sourceBytes), source.sha256);
    for (const suffix of ['.js', '.js.map']) {
      const relative = 'packages/bridge-core/dist/' + stem + suffix, output = receipt.outputs.find((row: { path: string }) => row.path === relative);
      assert.ok(output, '507 原工厂 JS/map 缺完整 fresh 收据不得借旧 dist'); const file = path.join(core, 'dist', stem + suffix), bytes = await readFile(file), info = await lstat(file);
      assert.ok(info.isFile() && !info.isSymbolicLink()); assert.equal(bytes.length, output.bytes); assert.equal(digest(bytes), output.sha256);
      const stage = receipt.stages.find((row: { name: string }) => row.name === 'fresh-core-compiler'); assert.ok(stage && stage.compilerExit === 0);
      const start = binding.timeBasis === 'whole-source-standard-run' ? binding.compilerStartedAtMs : stage.startedMs;
      const finish = binding.timeBasis === 'whole-source-standard-run' ? binding.compilerFinishedAtMs : stage.finishedMs;
      assert.ok(info.mtimeMs >= start && info.mtimeMs <= finish);
      if (suffix === '.js.map') { const map = JSON.parse(bytes.toString('utf8')); assert.equal(map.file, path.basename(stem) + '.js'); assert.equal(map.sourceRoot, '');
        assert.equal(map.sources.length, 1); assert.equal(path.resolve(path.dirname(file), map.sources[0]), path.join(core, 'src', stem + '.ts')); }
    }
  }
  const load = (relative: string): Promise<unknown> => import(pathToFileURL(path.join(core, 'dist', relative + '.js')).href);
  const service = await load('collection/local-relocation-service') as typeof import('../../src/collection/local-relocation-service.js');
  const authority = await load('collection/source-relocation-authority') as typeof import('../../src/collection/source-relocation-authority.js');
  const journal = await load('collection/local-relocation-journal') as typeof import('../../src/collection/local-relocation-journal.js');
  const locks = await load('stream/physical-resource-locks') as typeof import('../../src/stream/physical-resource-locks.js');
  const qualification = await load('library/local-cue-format-qualification') as typeof import('../../src/library/local-cue-format-qualification.js');
  const dto = await import(pathToFileURL(path.join(core, '../contracts/dist/index.js')).href) as typeof import('@music-bridge/contracts');
  const rare = qualification.createCueSyntheticRareInputs(), mm = 'music-metadata-11.15.0/mbrs003-v4', header = 'musicbridge-cue-header/mbrs003-v1', jobVersion = 'cue-input-scan/v39-v1';
  const input = (id: 'ape' | 'tta' | 'mpc7', container: string): RelocationInput507 => { const row = rare.find(value => value.id === id); assert.ok(row);
    assert.equal(row.data.length, row.bytes); assert.equal(digest(row.data), row.sha256); return { id, file: row.file, data: Buffer.from(row.data), parserVersion: id === 'tta' ? header : mm, container }; };
  const scenarios = [{ id: 'single-ape', files: [input('ape', 'APE')] },
    { id: 'mixed-tta-flac-mpc7', files: [input('tta', 'TTA'), { id: 'flac', file: '原自有.flac', data: await relocationOwnedFlac507(), parserVersion: mm, container: 'FLAC' } as RelocationInput507, input('mpc7', 'MPC')] }];
  for (const scenario of scenarios) {
    remaining(); const directory = await ownedRoot(), media = path.join(directory, 'audio'), destination = path.join(directory, '目的音乐'); await mkdir(destination, { mode: 0o700 });
    const file = path.join(directory, 'collection.sqlite'), stateFile = path.join(directory, 'identity.sqlite');
    let repository: ReturnType<typeof createCollectionRepository> | undefined, state: ReturnType<typeof createBackupWorkflowStore> | undefined;
    let scanner: ReturnType<typeof createLocalScanCoordinator> | undefined, reader: MetadataReaderPort | undefined;
    let view: ReturnType<typeof createCompletedScanSnapshotView> | undefined, admission: ReturnType<typeof createScanReadAdmission> | undefined;
    let api: ReturnType<typeof service.createLocalRelocationService> | undefined, channel: import('node:worker_threads').MessageChannel | undefined;
    let actor: import('../../src/collection/source-relocation-authority.js').RelocationMainActor | undefined;
    let closing = false, closePromise: Promise<void> | undefined, sequence = 0, portCloses = 0;
    const pending = new Map<string, { request: import('@music-bridge/contracts').LocalRelocationMainRequest; resolve(value: unknown): void; reject(error: unknown): void; timer: ReturnType<typeof setTimeout> }>();
    const mainWork = new Set<Promise<void>>(), mainErrors: unknown[] = [], lifecycleErrors: unknown[] = [], events: MetadataReaderLifecycle[] = [];
    const permits = new Set<string>(), requests: import('@music-bridge/contracts').LocalRelocationMainRequest[] = [];
    let flight: { fd: number; started: boolean; exited: boolean; released: boolean; completed: boolean } | undefined, completedReads = 0;
    const countResources = (closed: boolean) => { assert.ok(admission); assert.deepEqual(admission.resourceCounts(), { permits: 0, revoked: 0, watches: 0, timers: 0, closed });
      assert.equal(permits.size, 0); assert.deepEqual(locks.physicalResourceLocks.combinedSnapshot(), { readers: 0, writers: 0, resources: 0 }); };
    async function close(): Promise<void> {
      if (closePromise) return closePromise; closing = true;
      closePromise = (async () => {
        for (const waiting of pending.values()) { clearTimeout(waiting.timer); waiting.reject(new Error('507 原 Main 通道收口')); } pending.clear();
        await Promise.all([...mainWork]);
        // 原作者/端口保持到实际工厂和 Reader join；失败不关闭原数据库或释放未知 claims。
        await api?.close(); await scanner?.close(); await reader?.close(); view?.close(); admission?.close();
        if (admission) countResources(true);
        if (channel) {
          const ports = [channel.port1, channel.port2]; const closed = ports.map(port => new Promise<void>(resolve => port.once('close', () => { ++portCloses; resolve(); })));
          for (const port of ports) port.close(); await Promise.all(closed); assert.equal(portCloses, 2); assert.equal(actor?.active, false);
        }
        assert.equal(pending.size, 0); assert.equal(mainWork.size, 0); assert.deepEqual(mainErrors, []); assert.deepEqual(lifecycleErrors, []);
        repository?.close(); state?.close();
      })(); return closePromise;
    }
    t.after(close); t.diagnostic('507 自有移动材料保留：' + directory);
    for (const row of scenario.files) await writeFile(path.join(media, row.file), row.data, { flag: 'wx', mode: 0o600 });
    repository = graph.repository.createCollectionRepository({ filePath: file }); state = graph.state.createBackupWorkflowStore({ filePath: stateFile }); repository.localCatalog.roots();
    const identity = state.datasetIdentities.bind('default', file, false); repository.localCatalog.privateBindWorkbenchDataset(identity);
    const settings = repository.localCatalog.privateScanSettingsStore(identity), source = repository.sources.authorize(randomUUID(), await graph.sources.authorizeSourceDirectory(media));
    const library = repository.localCatalog.registerRoot({ commandId: randomUUID(), sourceRootId: source.id, role: 'library' });
    admission = graph.admission.createScanReadAdmission({ isBusy: () => false }); const scope = { datasetId: identity.datasetId, epoch: randomUUID() };
    const projection: DatasetProjectionPort = { async call<K extends DatasetProjectionCommand>(command: K, payload: DatasetProjectionCommandPayloads[K]): Promise<DatasetProjectionCommandResults[K]> {
      let result: unknown; assert.ok(admission);
      if (command === 'scanReadAcquire') { const value = admission.acquire(scope); assert.equal(value.status, 'granted'); assert.ok(value.status === 'granted'); permits.add(value.permitId); result = value; }
      else if (command === 'scanReadWatchRevocation') result = await admission.watchRevocation(scope, (payload as { permitId: string }).permitId);
      else if (command === 'scanReadRelease') { assert.ok(flight?.completed && flight.released && flight.exited); const id = (payload as { permitId: string }).permitId;
        result = admission.release(scope, id); assert.equal(permits.delete(id), true); }
      else throw new Error('507 无 Provider 或其它媒体投影'); return result as DatasetProjectionCommandResults[K];
    } };
    reader = graph.reader.createMetadataReader({ concurrency: 1, maxPending: 1, cueInputMetadataEnabled: true, onLifecycle(event) {
      events.push(event);
      // Reader 吞掉诊断观察者异常，因此错误另存并在真实 read/close 完成后断言。
      try {
        if (event.type === 'lease-acquired') { assert.ok(!flight || flight.completed); flight = { fd: event.fd, started: false, exited: false, released: false, completed: false }; }
        else if (event.type === 'worker-start') { assert.ok(flight && flight.fd === event.fd && !flight.started); flight.started = true; }
        else if (event.type === 'worker-exit') { assert.ok(flight && flight.fd === event.fd && flight.started && !flight.released); assert.equal(event.exitCode, 0); flight.exited = true; }
        else if (event.type === 'lease-released') { assert.ok(flight && flight.fd === event.fd && flight.exited); assert.throws(() => fstatSync(event.fd), { code: 'EBADF' }); flight.released = true; }
        else if (event.type === 'read-complete') { assert.ok(flight?.released && flight.exited); assert.equal(event.status, 'ok'); flight.completed = true; ++completedReads; }
      } catch (error) { lifecycleErrors.push(error); }
    } });
    view = graph.view.createCompletedScanSnapshotView({ repository, identity });
    scanner = graph.scanner.createLocalScanCoordinator({ repository, identity, settings, datasetId: identity.datasetId, assertCurrent: () => identity.assertCurrent(), projection,
      reader, cueInputMetadataEnabled: true, async onCompleted(job) { assert.ok(view); view.captureCompleted(job.jobId); } });
    const started = scanner.start({ commandId: randomUUID(), libraryRootId: library.id, expectedRootRevision: library.revision }); await scanner.privateWait(started.jobId); remaining();
    const initial = scanner.get(started.jobId); assert.equal(initial.phase, 'completed'); assert.deepEqual(initial.progress, { visited: String(scenario.files.length), accepted: String(scenario.files.length), rejected: '0' });
    assert.equal(repository.localScan.privateJobParserVersion(initial.jobId), jobVersion); assert.equal(completedReads, scenario.files.length); assert.deepEqual(lifecycleErrors, []); countResources(false);
    const before = scenario.files.map(row => { const state = repository!.localScan.privateCurrentFileState(library.id, row.file); assert.ok(state && state.value.assetId && state.value.trackId && state.value.readFacts);
      assert.equal(state.jobId, initial.jobId); assert.equal(state.value.outcome, 'accepted'); assert.equal(state.value.parserVersion, row.parserVersion); assert.equal(state.value.readFacts.technical.container, row.container);
      assert.equal(state.value.readFacts.readEvidence.wholeAudioHash, false); assert.equal(state.value.readFacts.readEvidence.wholeAudioDecode, false);
      return { input: row, state, snapshot: repository!.localCatalog.privateRelocationSnapshot(state.value.assetId) }; });
    const initialRows = relocationJobRows507(file, initial.jobId), initialSnapshot = view.load(library.id).lastSuccess; assert.ok(initialSnapshot);
    api = service.createLocalRelocationService({ repository, datasetId: identity.datasetId, ownerEpoch: scope.epoch, assertCurrent: () => identity.assertCurrent(), beforeMedia: () => scanner!.yieldForMedia() });
    await api.prepareRecoveryProtection(); remaining(); const context = await api.get({ datasetId: identity.datasetId, selector: { kind: 'context' } }); assert.ok(context.kind === 'context');
    assert.equal(context.qualification.state, 'qualified'); assert.equal((await api.setPolicy({ datasetId: identity.datasetId, commandId: randomUUID(), expectedPolicyRevision: context.policy.revision, enabled: true })).outcome, 'accepted');
    const { MessageChannel } = await import('node:worker_threads'); channel = new MessageChannel(); actor = authority.createRelocationMainActor(channel.port1);
    const actualApi = api, actualChannel = channel, actualActor = actor;
    channel.port1.on('message', (raw: unknown) => {
      const work = (async () => {
        const request = dto.localRelocationMainRequestSnapshot(raw); assert.equal(request.payload.datasetId, identity.datasetId);
        let response: import('@music-bridge/contracts').LocalRelocationMainResponse;
        try { const result = await actualApi.dispatchMain(request, actualActor); response = dto.localRelocationMainResponseSnapshot({ version: 1, type: 'relocation-main-response',
          requestId: request.requestId, sequence: request.sequence, ok: true, result }, request.command); }
        catch (error) { mainErrors.push(error); response = dto.localRelocationMainResponseSnapshot({ version: 1, type: 'relocation-main-response', requestId: request.requestId,
          sequence: request.sequence, ok: false, failure: { version: 1, id: request.requestId, ok: false, error: { code: 'INTERNAL_ERROR', message: '507 原位置工厂明确失败' } } }, request.command); }
        actualChannel.port1.postMessage(response);
      })(); mainWork.add(work); void work.then(() => mainWork.delete(work), error => { mainWork.delete(work); mainErrors.push(error);
        for (const row of pending.values()) { clearTimeout(row.timer); row.reject(error); } pending.clear(); });
    });
    channel.port2.on('message', (raw: unknown) => {
      try {
        assert.ok(raw && typeof raw === 'object' && 'requestId' in raw && typeof raw.requestId === 'string'); const waiting = pending.get(raw.requestId); assert.ok(waiting);
        const response = dto.localRelocationMainResponseSnapshot(raw, waiting.request.command); assert.equal(response.requestId, waiting.request.requestId); assert.equal(response.sequence, waiting.request.sequence); remaining();
        pending.delete(response.requestId); clearTimeout(waiting.timer); if (response.ok) waiting.resolve(response.result); else waiting.reject(new Error(response.failure.error.message));
      } catch (error) { mainErrors.push(error); for (const row of pending.values()) { clearTimeout(row.timer); row.reject(error); } pending.clear(); }
    }); channel.port1.start(); channel.port2.start();
    const main = <K extends import('@music-bridge/contracts').LocalRelocationMainCommand>(command: K, payload: import('@music-bridge/contracts').LocalRelocationMainCommandPayloads[K]): Promise<import('@music-bridge/contracts').LocalRelocationMainCommandResults[K]> => {
      assert.equal(closing, false); const request = dto.localRelocationMainRequestSnapshot({ version: 1, type: 'relocation-main-request', requestId: randomUUID(), sequence: ++sequence, command, payload });
      requests.push(request); const timeout = Math.min(30_000, remaining());
      return new Promise((resolve, reject) => { const timer = setTimeout(() => { pending.delete(request.requestId); reject(new Error('507 原 Main 请求期限届满，只查询原命令')); }, timeout);
        pending.set(request.requestId, { request, resolve: value => resolve(value as import('@music-bridge/contracts').LocalRelocationMainCommandResults[K]), reject, timer }); actualChannel.port2.postMessage(request); });
    };
    const choice = await main('localRelocationMain.captureTarget', { datasetId: identity.datasetId, commandId: randomUUID(), kind: 'directory', absolutePath: destination });
    const intent: import('@music-bridge/contracts').LocalRelocationPlanIntent = { kind: 'move', sourceDisposition: 'RETAIN', targetChoiceId: choice.choiceId,
      targets: before.map(row => ({ assetId: row.snapshot.asset.id, expectedFileRevision: row.snapshot.asset.fileRevision, expectedLocationRevision: row.snapshot.asset.locationRevision, expectedRootRevision: row.snapshot.libraryRoot.revision })) };
    const preview = await api.preview({ datasetId: identity.datasetId, commandId: randomUUID(), intent }); assert.equal(preview.outcome, 'accepted'); assert.ok(preview.planId);
    const plan = async (): Promise<import('@music-bridge/contracts').LocalRelocationPlan> => { remaining(); const value = await actualApi.get({ datasetId: identity.datasetId, selector: { kind: 'plan', planId: preview.planId! } });
      assert.ok(value.kind === 'plan' && value.plan); return value.plan; };
    const wait = async (accept: (value: import('@music-bridge/contracts').LocalRelocationPlan) => boolean) => { for (;;) { const value = await plan(); if (accept(value)) return value;
      await new Promise<void>(resolve => setTimeout(resolve, Math.min(10, remaining()))); } };
    const ready = await wait(value => value.state !== 'PREVIEWING'); assert.equal(ready.state, 'READY', JSON.stringify(ready.issues)); assert.equal(ready.closure.operationCount, scenario.files.length);
    const confirm: import('@music-bridge/contracts').LocalRelocationPlanConfirm = { datasetId: identity.datasetId, commandId: randomUUID(), planId: ready.planId,
      expectedViewRevision: ready.viewRevision, domain: dto.LOCAL_RELOCATION_PLAN_DOMAIN, planHash: ready.planHash, contextFingerprint: ready.contextFingerprint };
    const challenge = await main('localRelocationMain.challenge', { datasetId: identity.datasetId, confirm }); assert.equal(challenge.grant.authorityId, actor.authorityId); assert.equal(challenge.grant.ownerEpoch, scope.epoch);
    assert.equal(challenge.commandId, confirm.commandId); assert.equal(challenge.planId, ready.planId); assert.equal(challenge.planHash, ready.planHash); assert.equal(challenge.contextFingerprint, ready.contextFingerprint);
    let accepted: import('@music-bridge/contracts').LocalRelocationPlanReceipt;
    try { accepted = await main('localRelocationMain.executeGranted', { datasetId: identity.datasetId, confirm, grant: challenge.grant }); }
    catch (error) {
      // UNKNOWN 或迟到不能新 mint grant/plan/UUID；只保同原 confirm 的精确查询结果后让本例失败。
      const original = await actualApi.get({ datasetId: identity.datasetId, selector: { kind: 'command', commandId: confirm.commandId,
        expectedCommand: 'localRelocationPlan.confirm', requestFingerprint: journal.relocationRequestFingerprint('localRelocationPlan.confirm', confirm) } });
      t.diagnostic('507 原执行命令查询：' + JSON.stringify(original)); throw error;
    }
    assert.equal(accepted.outcome, 'accepted'); assert.equal(accepted.commandId, confirm.commandId); assert.equal(accepted.planId, ready.planId);
    const done = await wait(value => ['SOURCE_RETAINED', 'COMPLETED', 'FAILED', 'RECOVERY_REQUIRED', 'DEFERRED', 'BLOCKED', 'CANCELLED'].includes(value.state));
    assert.equal(done.state, 'SOURCE_RETAINED', JSON.stringify(done.issues)); assert.equal(done.sourceDisposition, 'RETAIN');
    const moved = before.map(row => { const snapshot = repository!.localCatalog.privateRelocationSnapshot(row.snapshot.asset.id), fileState = repository!.localScan.privateCurrentFileState(snapshot.libraryRoot.id, snapshot.relative);
      assert.ok(fileState && fileState.value.readFacts); assert.equal(snapshot.asset.id, row.snapshot.asset.id); assert.deepEqual(snapshot.tracks, row.snapshot.tracks);
      assert.equal(snapshot.asset.fileRevision, row.snapshot.asset.fileRevision); assert.equal(BigInt(snapshot.asset.locationRevision), BigInt(row.snapshot.asset.locationRevision) + 1n);
      assert.equal(snapshot.asset.sampleFrames, row.snapshot.asset.sampleFrames); assert.equal(snapshot.asset.timebaseHz, row.snapshot.asset.timebaseHz); assert.equal(snapshot.catalogSha256, row.snapshot.catalogSha256);
      assert.equal(repository!.sources.root(snapshot.libraryRoot.sourceRootId).path, destination); assert.equal(snapshot.relative, row.input.file);
      assert.equal(snapshot.asset.sourceRootId, snapshot.libraryRoot.sourceRootId); assert.equal(snapshot.asset.rootRevision, snapshot.libraryRoot.revision);
      assert.equal(fileState.value.assetId, snapshot.asset.id); assert.equal(fileState.value.parserVersion, row.input.parserVersion); assert.equal(fileState.value.outcome, 'accepted');
      assert.equal(fileState.value.readFacts.technical.container, row.input.container); assert.equal(fileState.value.readFacts.readEvidence.wholeAudioHash, false); assert.equal(fileState.value.readFacts.readEvidence.wholeAudioDecode, false);
      return { ...row, beforeSnapshot: row.snapshot, snapshot, fileState }; });
    assert.equal(new Set(moved.map(row => row.snapshot.libraryRoot.id)).size, 1); assert.equal(new Set(moved.map(row => row.fileState.jobId)).size, 1);
    const newJobId = moved[0]!.fileState.jobId, destinationRoot = moved[0]!.snapshot.libraryRoot;
    assert.equal(repository.localScan.privateJobParserVersion(newJobId), jobVersion); const newJob = repository.localScan.get(newJobId);
    assert.equal(newJob.phase, 'completed'); assert.deepEqual(newJob.progress, { visited: String(scenario.files.length), accepted: String(scenario.files.length), rejected: '0' }); assert.equal(newJob.libraryRootId, destinationRoot.id);
    const newRows = relocationJobRows507(file, newJobId); assert.equal(newRows.jobs.length, 1); assert.equal(newRows.batches.length, 1); assert.equal(newRows.checkpoints.length, 1);
    assert.deepEqual(newRows.receipts.map(row => row.operation), ['start', 'resume', 'prepare-batch', 'commit-batch']);
    assert.equal(JSON.parse(String(newRows.receipts[0]!.request)).parserVersion, jobVersion); assert.equal(String(newRows.jobs[0]!.parser_version), jobVersion);
    const batch = JSON.parse(String(newRows.batches[0]!.request)) as import('../../src/collection/local-scan-store.js').ScanPreparedBatch;
    const committed = JSON.parse(String(newRows.batches[0]!.result)) as import('../../src/collection/local-scan-store.js').ScanCommittedBatch;
    assert.equal(batch.completed, true); assert.deepEqual(batch.frontier, []); assert.equal(batch.items.length, scenario.files.length); assert.deepEqual(committed.job, newJob);
    const locationFacts = repository.localCatalog.privateRelocationRead(value => value.projection.events.filter(event => event.kind === 'location-facts').filter(event => event.planId === done.planId));
    assert.equal(locationFacts.length, scenario.files.length);
    for (const row of moved) {
      const index = batch.items.findIndex(item => item.relative === row.snapshot.relative); assert.ok(index >= 0); assert.equal(batch.items[index]!.parserVersion, row.input.parserVersion);
      assert.deepEqual(committed.files[index], row.fileState.value);
      const location = locationFacts.find(event => event.fact.afterAsset.id === row.snapshot.asset.id); assert.ok(location); const fact = location.fact;
      assert.equal(fact.planHash, ready.planHash); assert.equal(fact.resourceClosureHash, ready.closure.fingerprint); assert.equal(Object.getPrototypeOf(fact.beforeAsset), null); sameClosedData507(fact.beforeAsset, row.beforeSnapshot.asset);
      assert.equal(Object.getPrototypeOf(fact.afterAsset), null); sameClosedData507(fact.afterAsset, row.snapshot.asset); assert.equal(fact.source.libraryRootId, library.id); assert.equal(fact.target.libraryRootId, destinationRoot.id);
      assert.equal(fact.sourceObservation.sha256, digest(row.input.data)); assert.equal(fact.targetObservation.sha256, digest(row.input.data)); assert.equal(fact.targetObservation.bytes, row.input.data.length);
      assert.equal(fact.scan.operationId, fact.operationId); assert.equal(fact.scan.resourceId, fact.resourceId); assert.equal(fact.scan.origin.itemIndex, index); sameClosedData507(fact.scan.origin.job, newJob);
      assert.equal(fact.scan.origin.batchId, batch.batchId); assert.equal(fact.scan.origin.checkpointId, newJob.checkpointRef); sameClosedData507(fact.scan.state, row.fileState.value);
      for (const [operation, commandId, fingerprint] of [['start', fact.scan.origin.startCommandId, fact.scan.origin.startFingerprint], ['resume', fact.scan.origin.resumeCommandId, fact.scan.origin.resumeFingerprint],
        ['prepare-batch', fact.scan.origin.prepareCommandId, fact.scan.origin.prepareFingerprint], ['commit-batch', fact.scan.origin.commitCommandId, fact.scan.origin.commitFingerprint]]) {
        const receipt = newRows.receipts.find(value => value.operation === operation); assert.ok(receipt); assert.equal(receipt.command_id, commandId); assert.equal(receipt.fingerprint, fingerprint);
      }
      for (const target of [path.join(media, row.input.file), path.join(destination, row.snapshot.relative)]) { const bytes = await readFile(target), info = await lstat(target);
        assert.equal(bytes.length, row.input.data.length); assert.equal(digest(bytes), digest(row.input.data)); assert.ok(info.isFile() && !info.isSymbolicLink()); assert.equal(info.nlink, 1); }
    }
    assert.deepEqual(relocationJobRows507(file, initial.jobId), initialRows); assert.deepEqual(view.load(library.id).lastSuccess, initialSnapshot);
    assert.equal(completedReads, scenario.files.length * 2); assert.deepEqual(lifecycleErrors, []); countResources(false);
    assert.deepEqual(requests.map(request => request.command), ['localRelocationMain.captureTarget', 'localRelocationMain.challenge', 'localRelocationMain.executeGranted']);
    assert.equal(new Set(requests.map(request => request.requestId)).size, 3); assert.deepEqual(requests.map(request => request.sequence), [1, 2, 3]); assert.equal(pending.size, 0);
    const warmRows = relocationRows507(file), warmEvents = repository.localCatalog.privateRelocationRead(value => structuredClone(value.projection.events)), warmRoot = repository.localCatalog.root(library.id);
    await close(); remaining(); const cold = graph.repository.createCollectionRepository({ filePath: file }), coldState = graph.state.createBackupWorkflowStore({ filePath: stateFile });
    try {
      cold.localCatalog.roots(); const sameIdentity = coldState.datasetIdentities.bind('default', file, false); assert.equal(sameIdentity.datasetId, identity.datasetId); cold.localCatalog.privateBindWorkbenchDataset(sameIdentity);
      assert.deepEqual(cold.localCatalog.root(library.id), warmRoot); assert.deepEqual(cold.localCatalog.root(destinationRoot.id), destinationRoot);
      assert.deepEqual(relocationRows507(file), warmRows); const coldEvents = cold.localCatalog.privateRelocationRead(value => value.projection.events); assert.ok(coldEvents.length > 0 && coldEvents.every(event => Object.getPrototypeOf(event) === null)); sameClosedData507(coldEvents, warmEvents);
      assert.deepEqual(cold.localScan.get(newJobId), newJob); assert.equal(cold.localScan.privateJobParserVersion(newJobId), jobVersion);
      for (const row of moved) { assert.deepEqual(cold.localCatalog.privateRelocationSnapshot(row.snapshot.asset.id), row.snapshot); assert.deepEqual(cold.localScan.privateCurrentFileState(destinationRoot.id, row.snapshot.relative), row.fileState); }
      assert.deepEqual(relocationJobRows507(file, initial.jobId), initialRows);
    } finally { cold.close(); coldState.close(); }
    countResources(true); assert.equal(portCloses, 2); remaining();
    t.diagnostic('507 ' + scenario.id + '：正常 Scanner 真资产→原工厂/grant/完整 FD 发布→mixed parser 原 SQL job 冷审；SourceRetain 与实际 Worker/FD/port/claims quiet 单独核。');
  }
}

// 私有header只复用同view全核语义证明；以下均为自有SQLite/原Scanner组件，非Main或Owner准入。
function snapshotHeaderSql578(f: Awaited<ReturnType<typeof fixture>>): DatabaseSync { return f.repository.privateMobileCatalogAccess!(db => db); }
function wholeSnapshotRaw578(f: Awaited<ReturnType<typeof fixture>>, id: string): string {
  return Buffer.concat(snapshotHeaderSql578(f).prepare('SELECT data FROM local_scan_snapshot_chunks WHERE snapshot_id=? ORDER BY ordinal').all(id).map(row => Buffer.from(String(row.data), 'base64'))).toString('utf8');
}
function withSnapshotParseCount578(raw: string, action: (count: () => number) => void): void {
  const parse = JSON.parse; let count = 0;
  JSON.parse = ((...args: Parameters<typeof JSON.parse>) => { if (args[0] === raw) count++; return parse(...args); }) as typeof JSON.parse;
  try { action(() => count); } finally { JSON.parse = parse; }
}
function snapshotFailure578(read: () => unknown): { name: string; message: string; code: unknown } {
  let failure: unknown; try { read(); } catch (error) { failure = error; }
  assert.ok(failure instanceof Error, '污染原件必须实际拒绝，不能把两次成功当等价失败。');
  return { name: failure.name, message: failure.message, code: (failure as Error & { code?: unknown }).code };
}
function faultUpdate578(db: DatabaseSync, trigger: string, mutate: () => void): void {
  const sql = db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?").get(trigger)?.sql;
  assert.equal(typeof sql, 'string'); db.exec('DROP TRIGGER ' + trigger);
  try { mutate(); } finally { db.exec(String(sql)); }
}

test('002完成快照私有header：实际多chunk与原load同ID，warm全raw真读且不重解全文，合法当前更新只失效证明', { timeout: 60_000 }, async t => {
  const f = await fixture(t, 24); await f.scan();
  const full = f.view.load(f.library.id).lastSuccess!; assert.ok(full); assert.equal(full.snapshot.members.length, 48);
  const db = snapshotHeaderSql578(f), id = full.attempt.attemptId, raw = wholeSnapshotRaw578(f, id);
  assert.ok(Number(db.prepare('SELECT count(*) n FROM local_scan_snapshot_chunks WHERE snapshot_id=?').get(id)?.n) > 1);
  const prepare = db.prepare; let rawReads = 0;
  db.prepare = ((text: string) => { if (text === 'SELECT ordinal,data FROM local_scan_snapshot_chunks WHERE snapshot_id=? ORDER BY ordinal') rawReads++; return prepare.call(db, text); }) as typeof db.prepare;
  try { withSnapshotParseCount578(raw, count => {
    assert.equal(f.view.privateLastSuccessId(f.library.id), id); assert.equal(count(), 1, '首次必须原readWhole完整验证。');
    assert.equal(f.view.privateLastSuccessId(f.library.id), id); assert.equal(f.view.privateLastSuccessId(f.library.id), id);
    assert.equal(count(), 1, '只省相同全文的JSON语义重解，普通原load仍全核。');
    assert.equal(rawReads, 4, '首次全核加本次raw复核各一次，两个warm命中各自仍完整读SQL chunks。');
    assert.equal(f.view.load(f.library.id).lastSuccess?.attempt.attemptId, id); assert.equal(count(), 2);
    settingsSave(f, 2); assert.equal(f.view.privateLastSuccessId(f.library.id), id); assert.equal(count(), 3, '任何同连接写都须完整重核，不把旧设置当当前权限。');
    const item = f.repository.localCatalog.queryTracks({ rootId: f.library.id, query: '', offset: 0, limit: 1 }).items[0]!;
    f.repository.localCatalog.overrideMetadata({ commandId: randomUUID(), trackId: item.track.id, expectedRevision: null, fields: { title: '当前同Owner合法后继字段578' } });
    assert.equal(f.view.privateLastSuccessId(f.library.id), id); assert.equal(count(), 4);
    assert.equal(f.repository.localCatalog.queryTracks({ rootId: f.library.id, query: '', offset: 0, limit: 1 }).items[0]!.metadata.title, '当前同Owner合法后继字段578');
  }); } finally { db.prepare = prepare; }
  // 原load返回的可变DTO不能污染私有证明。
  full.snapshot.members[0]!.effectiveMetadata.title = '外部副本变化';
  assert.equal(f.view.privateLastSuccessId(f.library.id), f.view.load(f.library.id).lastSuccess?.attempt.attemptId);
  assert.notEqual(f.view.load(f.library.id).lastSuccess!.snapshot.members[0]!.effectiveMetadata.title, '外部副本变化');
  let accessed = 0;
  const getter = Object.defineProperty({}, 'certificate', { get() { accessed++; throw new Error('不能访问外传证书'); } });
  const proxy = new Proxy({}, { get() { accessed++; throw new Error('不能访问代理'); }, ownKeys() { accessed++; throw new Error('不能枚举代理'); } });
  for (const value of [getter, proxy, { rootId: f.library.id, certificate: { attemptId: id, sha256: full.attempt.sha256 } }])
    assert.throws(() => f.view.privateLastSuccessId(value as unknown as string), { code: 'INVALID' });
  assert.equal(accessed, 0);
  const clone = { ...f.identity, assertCurrent() {} };
  assert.throws(() => createCompletedScanSnapshotView({ repository: f.repository, identity: clone }));
  const replacement = path.join(f.directory, '合法后继源目录578'); await mkdir(replacement, { mode: 0o700 });
  const replacementSource = f.repository.sources.authorize(randomUUID(), await authorizeSourceDirectory(replacement));
  f.repository.localCatalog.relinkRoot({ commandId: randomUUID(), rootId: f.library.id, expectedRevision: f.library.revision, sourceRootId: replacementSource.id, role: 'library' });
  assert.equal(f.view.privateLastSuccessId(f.library.id), null); assert.equal(f.view.load(f.library.id).lastSuccess, null);
  f.view.close(); assert.throws(() => f.view.privateLastSuccessId(f.library.id), { code: 'UNAVAILABLE' });
});

test('002完成快照私有header：同连接chunk/header/job/batch/frozen/成员污染失效且保原load拒绝语义', { timeout: 60_000 }, async t => {
  const cases: { name: string; mutate(db: DatabaseSync, id: string, jobId: string): void }[] = [
    { name: 'chunk', mutate(db, id) { faultUpdate578(db, 'local_scan_snapshot_chunks_no_update', () => db.prepare('UPDATE local_scan_snapshot_chunks SET data=? WHERE snapshot_id=? AND ordinal=0').run('YWJj', id)); } },
    { name: 'header', mutate(db, id) { faultUpdate578(db, 'local_scan_snapshot_commits_no_update', () => db.prepare("UPDATE local_scan_snapshot_commits SET data=json_set(data,'$.sha256',?) WHERE id=?").run('f'.repeat(64), id)); } },
    { name: 'job', mutate(db, _id, jobId) { db.prepare("UPDATE local_scan_jobs SET data=json_set(data,'$.jobRevision','999') WHERE id=?").run(jobId); } },
    { name: 'batch', mutate(db, _id, jobId) { faultUpdate578(db, 'local_scan_batches_immutable', () => db.prepare("UPDATE local_scan_batches SET result=json_set(result,'$.job.progress.accepted',999) WHERE job_id=?").run(jobId)); } },
    { name: 'frozen', mutate(db, _id, jobId) { faultUpdate578(db, 'local_catalog_ledger_no_update', () => db.prepare("UPDATE local_catalog_ledger SET request=json_set(request,'$.frozen.albumConcurrency',24) WHERE operation='local-scan-settings-v1' AND json_extract(request,'$.kind')='launch' AND json_extract(request,'$.frozen.jobId')=?").run(jobId)); } },
    { name: 'member-metadata', mutate(db, id) {
      const row = db.prepare('SELECT data FROM local_scan_snapshot_chunks WHERE snapshot_id=? AND ordinal=0').get(id)!;
      const raw = Buffer.from(String(row.data), 'base64').toString('utf8');
      assert.equal(Number(db.prepare('SELECT count(*) n FROM local_scan_snapshot_chunks WHERE snapshot_id=?').get(id)?.n), 1);
      const value = JSON.parse(raw); value.members[0].effectiveMetadata.title = '污染原snapshot正文578';
      const changed = Buffer.from(JSON.stringify(value)).toString('base64');
      faultUpdate578(db, 'local_scan_snapshot_chunks_no_update', () => db.prepare('UPDATE local_scan_snapshot_chunks SET data=? WHERE snapshot_id=? AND ordinal=0').run(changed, id));
    } },
  ];
  for (const item of cases) await t.test(item.name, async sub => {
    const f = await fixture(sub, 1); const done = await f.scan(), full = f.view.load(f.library.id).lastSuccess!;
    assert.equal(f.view.privateLastSuccessId(f.library.id), full.attempt.attemptId);
    item.mutate(snapshotHeaderSql578(f), full.attempt.attemptId, done.jobId);
    const old = snapshotFailure578(() => f.view.load(f.library.id));
    assert.deepEqual(snapshotFailure578(() => f.view.privateLastSuccessId(f.library.id)), old);
  });
});

test('002完成快照私有header：外连接合法设置变动保ordinary拒绝，冷开同身份重全核且不恢复旧证明', { timeout: 60_000 }, async t => {
  const f = await fixture(t, 1); await f.scan(); const id = f.view.privateLastSuccessId(f.library.id); assert.ok(id);
  const other = createCollectionRepository({ filePath: f.file });
  try {
    other.localCatalog.roots(); other.localCatalog.privateBindWorkbenchDataset(f.identity);
    const settings = other.localCatalog.privateScanSettingsStore(f.identity), current = settings.read(f.identity);
    settings.save(f.identity, { schema: 1, datasetId: f.identity.datasetId, eventId: randomUUID(), commandId: randomUUID(), kind: 'settings', expectedRevision: current.revision,
      settings: { revision: (BigInt(current.revision) + 1n).toString(), albumConcurrency: 2 } });
  } finally { other.close(); }
  const old = snapshotFailure578(() => f.view.load(f.library.id));
  assert.deepEqual(snapshotFailure578(() => f.view.privateLastSuccessId(f.library.id)), old);
  await f.close();
  const cold = createCollectionRepository({ filePath: f.file }), state = createBackupWorkflowStore({ filePath: f.stateFile });
  try {
    cold.localCatalog.roots(); const identity = state.datasetIdentities.bind('default', f.file, false); assert.equal(identity.datasetId, f.identity.datasetId);
    cold.localCatalog.privateBindWorkbenchDataset(identity); const view = createCompletedScanSnapshotView({ repository: cold, identity });
    try { assert.equal(view.privateLastSuccessId(f.library.id), id); assert.equal(view.load(f.library.id).lastSuccess?.attempt.attemptId, id); }
    finally { view.close(); }
  } finally { cold.close(); state.close(); }
});
