import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createCollectionRepository } from '../src/collection/repository.js';
import type { ScanPreparedBatch, ScanPreparedItem } from '../src/collection/local-scan-store.js';
import { authorizeSourceDirectory } from '../src/recording/source-files.js';
import { MobileServiceError } from '../src/mobile/types.js';
import { MOBILE_CATALOG_TRACE_PREFIX, catalogTraceEvent, catalogTraceStep, copyCatalogTraceRecord,
  withCatalogTrace, type CatalogTraceRecord } from '../src/mobile/catalog-private-trace.js';

const seed = { schema: 1 as const, requestSha256: 'a'.repeat(64), nonceSha256: 'b'.repeat(64), offset: 1800, limit: 100 };
const expected = { container: 'WAVE', codec: 'PCM', lossless: true, sampleRateHz: 48000, channels: 2,
  bitsPerSample: 16, durationMs: 1000, evidence: 'bounded-parser-reported' };
async function fixture(t: TestContext) {
  assert.ok(process.env.TMPDIR?.startsWith('/Volumes/LifeWeave/Developer/CommandLine/tmp/'));
  const directory = await mkdtemp(path.join(process.env.TMPDIR!, 'file-parameter-branch-'));
  const media = path.join(directory, '禁止输出的合成空来源'); await mkdir(media);
  const repository = createCollectionRepository({ filePath: path.join(directory, 'collection.sqlite') });
  t.after(async () => { repository.close(); await rm(directory, { recursive: true, force: true }); });
  const source = repository.sources.authorize(randomUUID(), await authorizeSourceDirectory(media));
  const root = repository.localCatalog.registerRoot({ commandId: randomUUID(), sourceRootId: source.id, role: 'library' });
  const parserVersion = 'music-metadata-11.15.0/mbrs003-v1';
  const pending = repository.localScan.start({ commandId: randomUUID(), datasetId: randomUUID(), libraryRootId: root.id,
    expectedRootRevision: root.revision, parserVersion }).job;
  const job = repository.localScan.resume({ commandId: randomUUID(), jobId: pending.jobId, expectedRevision: pending.jobRevision });
  const input: ScanPreparedItem = { relative: '禁止输出的目录/合成.wav', signature: '禁止输出的合成签名', parserVersion,
    outcome: 'accepted', fields: { title: '禁止输出的标题', artist: '合成作者', album: '合成专辑' }, failureCode: null, reused: false,
    readFacts: { technical: { container: 'WAVE', codec: 'PCM', lossless: true, sampleRateHz: 48000, channels: 2, bitsPerSample: 16,
      durationSeconds: 1, evidence: 'bounded-parser-reported' }, coverEvidence: [], readEvidence: { bytesRead: 44, readCalls: 1,
      maxReadBytes: 44, allocationBytes: 44, elapsedMs: 1, wholeAudioHash: false, wholeAudioDecode: false } } };
  const batch: ScanPreparedBatch = { batchId: randomUUID(), jobId: job.jobId, expectedJobRevision: job.jobRevision,
    checkpointBefore: job.checkpointRef, items: [input], frontier: [], completed: true };
  repository.localScan.privatePrepareBatch({ commandId: randomUUID(), jobId: job.jobId, batch });
  repository.localScan.privateCommitBatch({ commandId: randomUUID(), jobId: job.jobId, batchId: batch.batchId, expectedRevision: job.jobRevision });
  const state = repository.localScan.privateCurrentFileState(root.id, input.relative)!;
  assert.ok(state.value.assetId && state.value.trackId);
  const asset = repository.localCatalog.asset(state.value.assetId), track = repository.localCatalog.track(state.value.trackId);
  let db!: DatabaseSync; repository.localCatalog.privateRead(value => { db = value; });
  const read = () => repository.localScan.privateDisplayFileParameters(track.id, asset, 'mobile-catalog');
  assert.deepEqual(read(), expected);
  const editState = (edit: (value: any) => void) => {
    const value = JSON.parse(String(db.prepare('SELECT data FROM local_scan_file_state WHERE library_root_id=? AND relative=?').get(root.id, input.relative)!.data));
    edit(value); db.prepare('UPDATE local_scan_file_state SET data=? WHERE library_root_id=? AND relative=?').run(JSON.stringify(value), root.id, input.relative);
  };
  return { directory, repository, source, root, input, batch, asset, track, db, read, editState };
}
function observe<T>(work: () => T) {
  const rows: CatalogTraceRecord[] = [], lines: string[] = [];
  let result: T | undefined, error: unknown;
  withCatalogTrace(seed, 'owner', () => {
    try { result = catalogTraceStep('owner.item.file-parameters', work, 80); } catch (value) { error = value; }
  }, line => {
    lines.push(line); const record = copyCatalogTraceRecord(JSON.parse(line.slice(MOBILE_CATALOG_TRACE_PREFIX.length)));
    assert.ok(record); rows.push(record);
  });
  return { result, error, rows, lines };
}
function branch(rows: CatalogTraceRecord[], suffix: string) {
  const matching = rows.filter(row => row.stage.startsWith('owner.item.file-parameters.null.') || row.stage.startsWith('owner.item.file-parameters.throw.'));
  assert.equal(matching.length, 1, '一次原调用只记录一个最终固定分支，不遍历或输出候选事实。');
  const row = matching[0]!; assert.equal(row.stage, 'owner.item.file-parameters.' + suffix);
  assert.equal(row.phase, 'ok'); assert.equal(row.matched, false); assert.equal(row.rowOrdinal, 80);
}
for (const failure of ['binding', 'state-missing', 'batch-signature', 'batch-read-facts', 'origin-none', 'origin-ledger-asset', 'corrupt-state'] as const) {
  test(`文件参数闭集旁注：真实合成SQLite的${failure}保留原返回及首BUSY`, async t => {
    const f = await fixture(t);
    if (failure === 'binding') f.repository.sources.revoke({ commandId: randomUUID(), id: f.source.id });
    else if (failure === 'state-missing') {
      // 只破坏本测试自有临时数据库；正式不可删扫描历史的触发器保持原样。
      f.db.exec('DROP TRIGGER local_scan_file_state_no_delete');
      f.db.prepare('DELETE FROM local_scan_file_state WHERE library_root_id=? AND relative=?').run(f.root.id, f.input.relative);
    } else if (failure === 'batch-signature') f.editState(value => { value.signature += '-变化'; });
    else if (failure === 'batch-read-facts') f.editState(value => { value.readFacts.technical.durationSeconds = 99; });
    else if (failure === 'origin-none') {
      f.db.exec('DROP TRIGGER local_scan_batches_immutable');
      const raw = f.db.prepare('SELECT result FROM local_scan_batches WHERE id=?').get(f.batch.batchId)!;
      const value = JSON.parse(String(raw.result)); value.files[0].assetId = randomUUID();
      f.db.prepare('UPDATE local_scan_batches SET result=? WHERE id=?').run(JSON.stringify(value), f.batch.batchId);
    } else if (failure === 'origin-ledger-asset') {
      f.db.exec('DROP TRIGGER local_catalog_ledger_no_update');
      const raw = f.db.prepare("SELECT command_id,result FROM local_catalog_ledger WHERE operation='register-asset' AND json_extract(result,'$.id')=?").get(f.asset.id)!;
      const value = JSON.parse(String(raw.result)); value.fileRevision = '2';
      f.db.prepare('UPDATE local_catalog_ledger SET result=? WHERE command_id=?').run(JSON.stringify(value), String(raw.command_id));
    }
    else f.editState(value => { value.readFacts = null; });
    const original = new MobileServiceError(503, 'BUSY');
    const seen = observe(() => { const value = f.read(); if (value === null) throw original; return value; });
    assert.equal(seen.result, undefined); assert.ok(seen.error);
    if (failure !== 'corrupt-state') assert.equal(seen.error, original);
    branch(seen.rows, failure === 'corrupt-state' ? 'throw.scan-state' : 'null.' + failure);
    const business = seen.rows.filter(row => row.phase === 'reject' && row.role === 'business');
    assert.equal(business.length, 1); assert.equal(business[0]!.stage, 'owner.item.file-parameters');
    const serialized = seen.lines.join('');
    for (const forbidden of [f.directory, f.input.relative, f.input.signature, f.asset.id, f.track.id, '禁止输出的标题']) {
      assert.equal(serialized.includes(forbidden), false);
    }
  });
}
test('文件参数闭集旁注：成功零分支，无scope或非Owner行作用域不输出', async t => {
  const f = await fixture(t); const good = observe(f.read);
  assert.deepEqual(good.result, expected); assert.deepEqual(good.rows, []);
  f.repository.sources.revoke({ commandId: randomUUID(), id: f.source.id });
  assert.equal(f.read(), null);
  const lines: string[] = [];
  assert.equal(withCatalogTrace(seed, 'owner', f.read, line => { lines.push(line); }), null);
  assert.equal(withCatalogTrace({ ...seed, secret: '不得输出' }, 'owner', () => catalogTraceStep('owner.item.file-parameters', f.read, 80), line => { lines.push(line); }), null);
  assert.equal(withCatalogTrace(seed, 'main', () => catalogTraceStep('owner.item.file-parameters', f.read, 80), line => { lines.push(line); }), null);
  assert.deepEqual(lines, []);
});
test('文件参数闭集旁注：异常保持同一对象，坏sink不能替换原首因', async t => {
  const f = await fixture(t), failure = new Error('不得输出的异常文本');
  t.mock.method(f.repository.localCatalog, 'track', () => { throw failure; });
  const seen = observe(f.read); assert.equal(seen.error, failure); branch(seen.rows, 'throw.binding');
  assert.equal(seen.lines.join('').includes(failure.message), false);
  withCatalogTrace(seed, 'owner', () => {
    assert.throws(() => catalogTraceStep('owner.item.file-parameters', f.read, 80), error => error === failure);
  }, () => { throw new Error('不得替换原错误'); });
});
test('文件参数闭集旁注：满normal预算仍为原首BUSY保留槽，未知stage/附加字段不准入', async t => {
  const f = await fixture(t); f.repository.sources.revoke({ commandId: randomUUID(), id: f.source.id });
  const rows: CatalogTraceRecord[] = [], failure = new MobileServiceError(503, 'BUSY');
  withCatalogTrace(seed, 'owner', () => {
    for (let n = 0; n < 100; n++) catalogTraceEvent('owner.sql-page', 'ok');
    assert.throws(() => catalogTraceStep('owner.item.file-parameters', () => { f.read(); throw failure; }, 80), error => error === failure);
  }, line => { const value = copyCatalogTraceRecord(JSON.parse(line.slice(MOBILE_CATALOG_TRACE_PREFIX.length))); assert.ok(value); rows.push(value); });
  assert.equal(rows.length, 59); assert.equal(rows.filter(row => row.phase === 'reject').length, 1);
  assert.equal(rows.at(-1)!.stage, 'owner.item.file-parameters'); assert.equal(rows.at(-1)!.code, 'BUSY');
  const raw = rows.at(-1)!;
  assert.equal(copyCatalogTraceRecord({ ...raw, stage: 'owner.item.file-parameters.null.unregistered' }), null);
  assert.equal(copyCatalogTraceRecord({ ...raw, fileParameters: { sampleRateHz: 48000 } }), null);
});
