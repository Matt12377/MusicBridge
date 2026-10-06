import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { audioFixture, loadFreshMetadataReader, sha256 } from '../helpers/mbrs003-audio-fixtures.js';
import { authorizeSourceDirectory, readonlySourceCandidateMetadata } from '../../src/recording/source-files.js';
import { createCollectionRepository } from '../../src/collection/repository.js';
import type { ScanPreparedBatch, ScanPreparedItem } from '../../src/collection/local-scan-store.js';

// 独立supplemental文件；不进入原33叶/124项映射。缺4源/8JS-map绑定是准备失败。
const { createMetadataReader } = await loadFreshMetadataReader();
const parserVersion = 'music-metadata-11.15.0/mbrs003-v1';
type QueryKind = 'locator' | 'direct' | 'fallback';
interface QueryEvent { kind: QueryKind; method: 'all' | 'get'; returnedRows: number }

function transparentPrepareObserver(t: TestContext) {
  const descriptor = Object.getOwnPropertyDescriptor(DatabaseSync.prototype, 'prepare');
  assert.ok(descriptor && typeof descriptor.value === 'function');
  const original = DatabaseSync.prototype.prepare;
  let observing = false, events: QueryEvent[] = [];
  const observed = new Proxy(original, {
    apply(target, receiver, args) {
      // 所有真实prepare和statement执行都保留原receiver/参数/返回/异常，绝不SQL seed或Fake rows。
      const statement: ReturnType<DatabaseSync['prepare']> = Reflect.apply(target, receiver, args);
      const sql = String(args[0]).trim().replace(/\s+/gu, ' ').toLowerCase();
      const kind: QueryKind | undefined = sql === 'select id from local_catalog_assets where root_id=? and relative=? limit 2' ? 'locator'
        : sql === 'select * from local_scan_file_state where library_root_id=? and relative=?' ? 'direct'
        : sql.startsWith('select s.* from local_catalog_assets a join local_scan_file_state s ') ? 'fallback' : undefined;
      if (!kind) return statement;
      return new Proxy(statement, {
        get(actual, key) {
          const value: unknown = Reflect.get(actual, key, actual);
          if (typeof value !== 'function') return value;
          return (...parameters: unknown[]) => {
            const result: unknown = Reflect.apply(value, actual, parameters);
            if (observing && (key === 'all' || key === 'get'))
              events.push({ kind, method: key, returnedRows: Array.isArray(result) ? result.length : result === undefined ? 0 : 1 });
            return result;
          };
        },
      });
    },
  });
  Object.defineProperty(DatabaseSync.prototype, 'prepare', { ...descriptor, value: observed });
  let restored = false;
  const restore = () => {
    if (restored) return;
    assert.equal(DatabaseSync.prototype.prepare, observed, '只恢复本测试持有的prototype代理');
    Object.defineProperty(DatabaseSync.prototype, 'prepare', descriptor); restored = true;
  };
  t.after(restore);
  return {
    focused<T>(read: () => T): { result: T; events: QueryEvent[] } {
      assert.equal(observing, false); observing = true; events = [];
      try { return { result: read(), events: [...events] }; } finally { observing = false; }
    }, restore,
  };
}

async function owned(t: TestContext, id: 'core-flac' | 'invalid-magic', relative: string) {
  const fixture = await audioFixture(t), media = path.join(fixture.directory, 'single-owned-media');
  await mkdir(media, { mode: 0o700 });
  const original = await fixture.bytes(id), sourceFile = path.join(media, relative);
  await writeFile(sourceFile, original, { flag: 'wx', mode: 0o600 });
  const file = path.join(fixture.directory, 'zero-locator.sqlite');
  const repository = createCollectionRepository({ filePath: file });
  t.after(() => repository.close());
  const source = repository.sources.authorize(randomUUID(), await authorizeSourceDirectory(media));
  const root = repository.localCatalog.registerRoot({ commandId: randomUUID(), sourceRootId: source.id, role: 'library' });
  const capability = repository.sources.root(source.id);
  const signature = (await readonlySourceCandidateMetadata(capability, relative)).signature;
  const reader = createMetadataReader();
  t.after(() => reader.close());
  const result = await reader.read({ root: capability, relative, expectedSignature: signature }, new AbortController().signal);
  await reader.close();
  const unchanged = async () => {
    assert.equal(sha256(await readFile(sourceFile)), sha256(original)); await fixture.assertUnchanged();
  };
  const start = repository.localScan.start({ commandId: randomUUID(), datasetId: randomUUID(), libraryRootId: root.id,
    expectedRootRevision: root.revision, parserVersion }).job;
  const job = repository.localScan.resume({ commandId: randomUUID(), jobId: start.jobId, expectedRevision: start.jobRevision });
  return { repository, file, root, signature, relative, result, job, unchanged };
}
function commit(f: Awaited<ReturnType<typeof owned>>, item: ScanPreparedItem) {
  const batch: ScanPreparedBatch = { batchId: randomUUID(), jobId: f.job.jobId, expectedJobRevision: f.job.jobRevision,
    checkpointBefore: f.job.checkpointRef, items: [item], frontier: [], completed: true };
  f.repository.localScan.privatePrepareBatch({ commandId: randomUUID(), jobId: f.job.jobId, batch });
  const request = { commandId: randomUUID(), jobId: f.job.jobId, batchId: batch.batchId, expectedRevision: f.job.jobRevision };
  return { request, job: f.repository.localScan.privateCommitBatch(request) };
}
function persistedFacts(file: string) {
  // 只读实际已提交事实；数据创建仅通过真实Repository，不向SQL写入任何seed。
  const db = new DatabaseSync(file, { readOnly: true, allowExtension: false });
  try {
    return ['local_scan_jobs', 'local_scan_file_state', 'local_scan_batches', 'local_scan_checkpoints', 'local_scan_receipts',
      'local_catalog_assets', 'local_catalog_tracks', 'local_catalog_observations', 'local_catalog_ledger']
      .map(name => ({ name, rows: db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all() }));
  } finally { db.close(); }
}
function count(events: QueryEvent[], kind: QueryKind): number { return events.filter(e => e.kind === kind).length; }

const newPathName = 'MBRS003 supplemental零locator：真实新路径查询无history fallback，合法提交与冷开保持IDs和raw';
test(newPathName, { timeout: 30_000, concurrency: false }, async t => {
  const f = await owned(t, 'core-flac', 'new-item.flac');
  assert.equal(f.result.status, 'ok'); if (f.result.status !== 'ok') throw new Error('真实完整FLAC控制未通过，不能作为查询行为RED');
  const observer = transparentPrepareObserver(t);
  const observed = observer.focused(() => f.repository.localScan.privateCurrentFileState(f.root.id, f.relative));
  assert.equal(observed.result, null);
  assert.deepEqual(observed.events.filter(e => e.kind === 'locator'), [{ kind: 'locator', method: 'all', returnedRows: 0 }]);
  assert.deepEqual(observed.events.filter(e => e.kind === 'direct'), [{ kind: 'direct', method: 'get', returnedRows: 0 }]);
  // 旧a426实际查过fallback会在这里失败；这是statement调用次数，不是VM访问数/延时。
  assert.equal(count(observed.events, 'fallback'), 0, '已由真实locator0/direct0确定无候选时，昂贵history fallback不应执行');
  const accepted: ScanPreparedItem = { relative: f.relative, signature: f.signature, parserVersion, outcome: 'accepted',
    fields: f.result.fields, failureCode: null, reused: false, readFacts: { technical: f.result.technical,
      coverEvidence: f.result.coverEvidence, readEvidence: f.result.readEvidence } };
  const committed = commit(f, accepted); assert.equal(committed.job.phase, 'completed');
  assert.deepEqual(committed.job.progress, { visited: '1', accepted: '1', rejected: '0' });
  const state = f.repository.localScan.privateCurrentFileState(f.root.id, f.relative);
  assert.ok(state && state.value.assetId && state.value.trackId);
  const raw = f.repository.localCatalog.metadata(state.value.trackId).raw;
  assert.deepEqual(raw, f.result.fields); assert.ok(typeof raw.title === 'string' && raw.title.length > 0);
  const asset = f.repository.localCatalog.asset(state.value.assetId), track = f.repository.localCatalog.track(state.value.trackId);
  const receipt = f.repository.localScan.receipt(committed.request.commandId), facts = persistedFacts(f.file);
  observer.restore(); f.repository.close(); const beforeBytes = sha256(await readFile(f.file));
  const cold = createCollectionRepository({ filePath: f.file });
  try {
    assert.deepEqual(cold.localScan.privateCurrentFileState(f.root.id, f.relative), state);
    assert.deepEqual(cold.localCatalog.asset(state.value.assetId), asset); assert.deepEqual(cold.localCatalog.track(state.value.trackId), track);
    assert.deepEqual(cold.localCatalog.metadata(state.value.trackId).raw, raw);
    assert.deepEqual(cold.localScan.receipt(committed.request.commandId), receipt); assert.deepEqual(persistedFacts(f.file), facts);
  } finally { cold.close(); }
  assert.equal(sha256(await readFile(f.file)), beforeBytes, '冷核与只读API不能改已提交数据库字节');
  await f.unchanged();
});

const rejectedName = 'MBRS003 supplemental零locator：真实assetId=null拒绝旧state直接返回，查询与冷开保留ledger字节';
test(rejectedName, { timeout: 30_000, concurrency: false }, async t => {
  const f = await owned(t, 'invalid-magic', 'rejected-item.flac');
  assert.equal(f.result.status, 'failure'); if (f.result.status !== 'failure') throw new Error('固定坏魔数需真实Reader拒绝');
  assert.equal(['UNSUPPORTED', 'PARSE_FAILED'].includes(f.result.code), true);
  const rejected: ScanPreparedItem = { relative: f.relative, signature: f.signature, parserVersion, outcome: 'rejected',
    fields: null, failureCode: f.result.code, reused: false, readFacts: null };
  const committed = commit(f, rejected); assert.deepEqual(committed.job.progress, { visited: '1', accepted: '0', rejected: '1' });
  const state = f.repository.localScan.privateFileState(f.root.id, f.relative); assert.ok(state);
  assert.equal(state.value.outcome, 'rejected'); assert.equal(state.value.assetId, null); assert.equal(state.value.trackId, null);
  const facts = persistedFacts(f.file), beforeBytes = sha256(await readFile(f.file));
  const observer = transparentPrepareObserver(t);
  const observed = observer.focused(() => f.repository.localScan.privateCurrentFileState(f.root.id, f.relative));
  assert.deepEqual(observed.result, state, '零locator guard前移到direct之前会丢真实拒绝事实');
  assert.deepEqual(observed.events.filter(e => e.kind === 'locator'), [{ kind: 'locator', method: 'all', returnedRows: 0 }]);
  assert.deepEqual(observed.events.filter(e => e.kind === 'direct'), [{ kind: 'direct', method: 'get', returnedRows: 1 }]);
  assert.equal(count(observed.events, 'fallback'), 0);
  observer.restore(); assert.deepEqual(persistedFacts(f.file), facts); assert.equal(sha256(await readFile(f.file)), beforeBytes);
  f.repository.close(); const coldBeforeBytes = sha256(await readFile(f.file));
  const cold = createCollectionRepository({ filePath: f.file });
  try { assert.deepEqual(cold.localScan.privateCurrentFileState(f.root.id, f.relative), state); assert.deepEqual(persistedFacts(f.file), facts); }
  finally { cold.close(); }
  assert.equal(sha256(await readFile(f.file)), coldBeforeBytes); await f.unchanged();
});
