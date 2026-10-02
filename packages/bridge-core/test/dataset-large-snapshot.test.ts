import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { MessageChannel, Worker } from 'node:worker_threads';
import { isCollectionModel, type CollectionModel } from '@music-bridge/contracts';
import { CollectionError, createCollectionRepository } from '../src/collection/repository.js';
import { createTestDatasetDomain } from '../src/collection/dataset-domain.js';
import { createDatasetOwnerClient } from '../src/collection/dataset-owner-client.js';
import { attachDatasetOwnerWorkerPort } from '../src/collection/dataset-owner-worker.js';
import * as protocol from '../src/collection/dataset-owner-protocol.js';
import type { DatasetCollectionSnapshotVersion, DatasetOwnerRequest, DatasetOwnerResponse, OwnedDatasetDomain } from '../src/collection/dataset-owner-protocol.js';
import { responseFailure } from '../src/shared/ipc-failure.js';
import { seedRustCollection } from './helpers/rust-core-collection-fixture.js';
import { widenLargeSnapshotModels } from './helpers/dataset-owner-large-snapshot-fixture.js';

const page = { offset: 0, limit: 100 };
const unavailable = (error: unknown) => error instanceof CollectionError && error.code === 'INVENTORY_UNAVAILABLE';
const notSent = (error: unknown) => error instanceof protocol.DatasetOwnerTransportError && error.outcome === 'not-sent';
const sampleModel = (): CollectionModel => ({ id: randomUUID(), brand: 'a', name: 'a', edition: 'a', year: 1990, format: 'cassette', tapeType: 'II', identification: 'verified',
  collectorPolicy: 'normal', minimumSealedReserve: 0, revision: 1, lengths: [90], photoCount: 0,
  counts: { total: 1, sealedBlank: 1, openedBlank: 0, legacyUsed: 0, unknown: 0, recorded: 0, reserved: 0, unavailable: 0 } });
async function directory(t: test.TestContext): Promise<string> {
  const root = path.resolve(os.tmpdir()), external = '/Volumes/LifeWeave/Developer/CommandLine/tmp';
  if (process.platform === 'darwin' && process.env.GITHUB_ACTIONS !== 'true' && root !== external && !root.startsWith(`${external}/`)) throw new Error('本机大快照测试必须使用外置 TMPDIR。');
  const result = await mkdtemp(path.join(root, 'mb-large-snapshot-')); t.diagnostic(`合成证据目录：${result}`); return result;
}
async function fixture(t: test.TestContext) {
  const filePath = path.join(await directory(t), 'collection.sqlite'), repository = createCollectionRepository({ filePath });
  t.after(() => repository.close()); repository.list(page); return { repository, filePath };
}
function publicModels(repository: ReturnType<typeof createCollectionRepository>): CollectionModel[] {
  const models: CollectionModel[] = [];
  for (let offset = 0; ; offset += 100) { const result = repository.list({ offset, limit: 100 }); models.push(...result.items); if (!result.hasMore) return models; }
}
test('新大快照完整导出5000型号和全部库存照片，5001拒绝且旧2000预算保留', async t => {
  const { repository, filePath } = await fixture(t), ids = seedRustCollection(filePath, 5_000);
  const snapshot = repository.exportLargeReadonlyModels();
  assert.equal(snapshot.length, 5_000); assert.deepEqual(snapshot.map(model => model.id), ids); assert.deepEqual(snapshot, publicModels(repository));
  assert.ok(snapshot.some(model => (model.photoCount ?? 0) > 0)); assert.ok(snapshot.some(model => model.counts.total > 0));
  assert.throws(() => repository.exportReadonlyModels(), unavailable);
  seedRustCollection(filePath, 1, 5_000); assert.throws(() => repository.exportLargeReadonlyModels(), unavailable);
  assert.equal(repository.list(page).total, 5_001);
});

test('大快照guard独立计数、重复ID、封闭字段并计算完整信封的8MiB精确边界', () => {
  const models = Array.from({ length: 5_000 }, sampleModel), identity = { epoch: randomUUID(), datasetId: randomUUID(), snapshotId: randomUUID() };
  assert.ok(protocol.isDatasetLargeCollectionModels(models)); assert.equal(protocol.isDatasetCollectionModels(models), false);
  assert.equal(protocol.isDatasetLargeCollectionModels([...models, sampleModel()]), false);
  assert.equal(protocol.isDatasetLargeCollectionModels([models[0], models[0]]), false);
  assert.equal(protocol.isDatasetLargeCollectionModels([{ ...models[0], revision: 0 }]), false);
  assert.equal(protocol.isDatasetLargeCollectionSnapshot({ ...identity, models, path: '/合成路径' }), false);
  const target = protocol.MAX_DATASET_LARGE_COLLECTION_SNAPSHOT_BYTES;
  let remaining = target - Buffer.byteLength(JSON.stringify(models));
  for (const model of models) {
    for (const field of ['brand', 'name', 'edition'] as const) {
      if (remaining === 0) break;
      let delta = Math.min(719, remaining);
      // 716～719编码字节无法在120字符内表示，分到下一个字段补齐。
      if (delta >= 715 && delta <= 718) delta = 710;
      const encoded = delta + 1, surrogates = Math.floor(encoded / 6), ascii = encoded % 6;
      model[field] = '\ud800'.repeat(surrogates) + 'a'.repeat(ascii); remaining -= delta;
    }
    if (remaining === 0) break;
  }
  assert.equal(remaining, 0); assert.equal(Buffer.byteLength(JSON.stringify(models)), target); assert.ok(models.every(isCollectionModel));
  assert.ok(protocol.isDatasetLargeCollectionModels(models));
  assert.equal(protocol.isDatasetLargeCollectionSnapshot({ ...identity, models }), false);
  const outerBytes = Buffer.byteLength(JSON.stringify({ ...identity, models: [] })) - 2;
  const last = models.at(-1)!;
  // 一个满字段释放719字节，再用未填充字段补足精确信封边界。
  const filled = models.find(model => model.brand === '\ud800'.repeat(120))!;
  filled.brand = 'a'; last.edition = 'a'.repeat(1 + (719 - outerBytes) % 120);
  let gap = target - Buffer.byteLength(JSON.stringify({ ...identity, models }));
  for (const model of models.toReversed()) {
    if (gap === 0) break;
    if (model.name !== 'a') continue;
    const delta = Math.min(119, gap); model.name = 'a'.repeat(1 + delta); gap -= delta;
  }
  assert.equal(gap, 0); assert.equal(Buffer.byteLength(JSON.stringify({ ...identity, models })), target);
  assert.ok(protocol.isDatasetLargeCollectionSnapshot({ ...identity, models }));
  const expandable = models.find(model => model.name.length < 120)!; expandable.name += 'a';
  assert.equal(Buffer.byteLength(JSON.stringify({ ...identity, models })), target + 1);
  assert.equal(protocol.isDatasetLargeCollectionSnapshot({ ...identity, models }), false);
});

test('独立8MiB预算允许旧4MiB拒绝的合法快照，超预算和损坏失败均回滚', async t => {
  const { repository, filePath } = await fixture(t), ids = seedRustCollection(filePath, 2_000);
  widenLargeSnapshotModels(filePath, 120);
  const models = publicModels(repository), bytes = Buffer.byteLength(JSON.stringify(models));
  assert.ok(bytes > protocol.MAX_DATASET_COLLECTION_SNAPSHOT_BYTES); assert.ok(bytes < protocol.MAX_DATASET_LARGE_COLLECTION_SNAPSHOT_BYTES);
  assert.ok(models.every(isCollectionModel)); assert.deepEqual(repository.exportLargeReadonlyModels(), models);
  assert.throws(() => repository.exportReadonlyModels(), unavailable);
  seedRustCollection(filePath, 3_000, 2_000); widenLargeSnapshotModels(filePath, 120);
  const huge = publicModels(repository); assert.ok(huge.every(isCollectionModel));
  assert.ok(Buffer.byteLength(JSON.stringify(huge)) > protocol.MAX_DATASET_LARGE_COLLECTION_SNAPSHOT_BYTES);
  assert.throws(() => repository.exportLargeReadonlyModels(), unavailable); assert.equal(repository.list(page).total, 5_000);
  widenLargeSnapshotModels(filePath, 1);
  const writer = new DatabaseSync(filePath); t.after(() => writer.close());
  const original = writer.prepare('SELECT descriptor FROM collection_models WHERE id=?').get(ids[0]!)!.descriptor as string;
  writer.prepare('UPDATE collection_models SET descriptor=? WHERE id=?').run('{合成损坏', ids[0]!);
  assert.throws(() => repository.exportLargeReadonlyModels(), unavailable);
  writer.prepare('UPDATE collection_models SET descriptor=? WHERE id=?').run(original, ids[0]!);
  assert.equal(repository.exportLargeReadonlyModels().length, 5_000);
  repository.close(); assert.throws(() => repository.exportLargeReadonlyModels(), unavailable);
});

test('大快照一次同步读事务覆盖全部水合批次，外部提交不会拼出混合库存照片', async t => {
  const { repository, filePath } = await fixture(t); seedRustCollection(filePath, 151);
  const expected = publicModels(repository), writer = new DatabaseSync(filePath); t.after(() => writer.close());
  const original = DatabaseSync.prototype.prepare; let changed = false;
  DatabaseSync.prototype.prepare = function(sql) {
    const statement = original.call(this, sql);
    if (this !== writer && sql.startsWith('SELECT p.id,p.model_id,p.physical_id,p.width,p.height')) {
      const all = statement.all.bind(statement);
      statement.all = (...values) => {
        const rows = Reflect.apply(all, statement, values) as ReturnType<typeof statement.all>;
        if (!changed) { changed = true; writer.exec('BEGIN IMMEDIATE; UPDATE collection_models SET revision=2; UPDATE inventory_lots SET sealed=sealed+1,quantity_adjustment=quantity_adjustment+1; DELETE FROM collection_photos; COMMIT'); }
        return rows;
      };
    }
    return statement;
  };
  try { assert.deepEqual(repository.exportLargeReadonlyModels(), expected); assert.equal(changed, true); }
  finally { DatabaseSync.prototype.prepare = original; }
  const next = repository.exportLargeReadonlyModels(); assert.ok(next.every(model => model.revision === 2 && model.photoCount === 0));
  assert.ok(next.every((model, index) => model.counts.sealedBlank === expected[index]!.counts.sealedBlank + 1));
});

test('大快照domain导出前后验证工作库身份，关闭后不再开放', async () => {
  let changed = false, checks = 0;
  const domain = createTestDatasetDomain({ collectionDatasetIdentity: { datasetId: randomUUID(), assertCurrent() { checks++; if (changed) throw new CollectionError('INVENTORY_UNAVAILABLE', '合成身份失效。'); } } });
  try {
    const original = domain.collection.exportLargeReadonlyModels;
    domain.collection.exportLargeReadonlyModels = () => { const models = original(); changed = true; return models; };
    const before = checks; assert.throws(() => domain.exportLargeCollectionModels!(), unavailable); assert.equal(checks - before, 2);
    changed = false; domain.collection.exportLargeReadonlyModels = original; assert.deepEqual(domain.exportLargeCollectionModels!(), []);
  } finally { changed = false; await domain.close(); }
  assert.throws(() => domain.exportLargeCollectionModels!(), unavailable);
});

function harness(t: test.TestContext, overrides: Partial<OwnedDatasetDomain> = {}) {
  const ports = new MessageChannel(), epoch = randomUUID(), datasetId = randomUUID(); let sequence = 0;
  const domain: OwnedDatasetDomain = { datasetId, async dispatch() { return {}; }, commitBoot() {},
    exportCollectionModels() { return []; }, exportLargeCollectionModels() { return []; }, readonlySnapshotStamp() { return { dataVersion: 1, totalChanges: 0 }; },
    async close(before) { await before?.(); }, failureForError: id => responseFailure(id, 'INVENTORY_UNAVAILABLE', '合成领域失败。'), ...overrides };
  attachDatasetOwnerWorkerPort(ports.port1, { async prepare() { return domain; } }); t.after(() => { ports.port1.close(); ports.port2.close(); });
  const rpc = (operation: DatasetOwnerRequest['operation'], expectedDatasetId?: string): Promise<DatasetOwnerResponse> => {
    const request: DatasetOwnerRequest = { version: 1, type: 'request', epoch, requestId: randomUUID(), sequence: ++sequence, operation, ...(expectedDatasetId === undefined ? {} : { expectedDatasetId }) };
    return new Promise(resolve => { const listener = (response: DatasetOwnerResponse) => { if (response.requestId !== request.requestId) return; ports.port2.off('message', listener); resolve(response); };
      ports.port2.on('message', listener); ports.port2.postMessage(request); });
  };
  return { domain, epoch, datasetId, rpc };
}
function result<T>(response: DatasetOwnerResponse): T { assert.equal(response.ok, true); if (!response.ok) throw new Error('缺少合成成功回执。'); return response.result as T; }

test('大版本导出私有信封封闭，boot、缺方法、失败boot、scope和非法stamp均拒绝', async t => {
  const valid = { version: 1, type: 'request', epoch: randomUUID(), requestId: randomUUID(), sequence: 1, operation: 'exportLargeVersionedCollectionSnapshot', expectedDatasetId: randomUUID() };
  assert.equal(protocol.isDatasetOwnerRequest(valid), true);
  for (const bad of [{ ...valid, expectedDatasetId: undefined }, { ...valid, path: '/合成路径' }, { ...valid, sql: '合成SQL' }, { ...valid, request: {} }, { ...valid, revision: randomUUID() }]) assert.equal(protocol.isDatasetOwnerRequest(bad), false);
  for (const mode of ['before-boot', 'failed-boot', 'missing-large', 'missing-stamp', 'wrong-scope', 'bad-stamp']) {
    let reads = 0;
    const f = harness(t, { exportLargeCollectionModels() { reads++; return []; },
      ...(mode === 'bad-stamp' ? { readonlySnapshotStamp: () => ({ dataVersion: NaN, totalChanges: 0 }) } : {}),
      ...(mode === 'failed-boot' ? { commitBoot() { throw new Error('合成boot失败。'); } } : {}) });
    if (mode === 'missing-large') delete f.domain.exportLargeCollectionModels;
    if (mode === 'missing-stamp') delete f.domain.readonlySnapshotStamp;
    await f.rpc('prepare'); if (mode !== 'before-boot') await f.rpc('commitBoot');
    const rejected = await f.rpc('exportLargeVersionedCollectionSnapshot', mode === 'wrong-scope' ? randomUUID() : f.datasetId);
    assert.equal(rejected.ok, false); if (!rejected.ok) assert.equal(rejected.failure.error.code, mode === 'wrong-scope' ? 'OUTBOX_SCOPE_MISMATCH' : 'NOT_READY');
    assert.equal(reads, 0);
    if (mode === 'missing-large') assert.ok(protocol.isDatasetVersionedCollectionSnapshot(result(await f.rpc('exportVersionedCollectionSnapshot', f.datasetId))));
    await f.rpc('close');
  }
});

test('worker拒绝合法但重复ID的大导出DTO，不把部分集合当成功', async t => {
  const model = sampleModel(), f = harness(t, { exportLargeCollectionModels: () => [model, model] });
  await f.rpc('prepare'); await f.rpc('commitBoot');
  const rejected = await f.rpc('exportLargeVersionedCollectionSnapshot', f.datasetId); assert.equal(rejected.ok, false);
  if (!rejected.ok) assert.equal(rejected.failure.error.code, 'INVENTORY_UNAVAILABLE');
  f.domain.exportLargeCollectionModels = () => [model];
  assert.ok(protocol.isDatasetLargeVersionedCollectionSnapshot(result(await f.rpc('exportLargeVersionedCollectionSnapshot', f.datasetId)))); await f.rpc('close');
});

test('worker大导出戳变化和身份变化拒绝，稳定后与当前版本配对且三API快照身份唯一', async t => {
  for (const identityChange of [false, true]) {
    const stamp = { dataVersion: 1, totalChanges: 0 }; let mutate = true;
    const f = harness(t, { readonlySnapshotStamp: () => stamp, exportLargeCollectionModels() {
      if (mutate) { if (identityChange) Object.defineProperty(f.domain, 'datasetId', { value: randomUUID(), configurable: true }); else stamp.totalChanges++; } return [];
    } });
    await f.rpc('prepare'); await f.rpc('commitBoot');
    const before = result<DatasetCollectionSnapshotVersion>(await f.rpc('getCollectionSnapshotVersion', f.datasetId));
    const rejected = await f.rpc('exportLargeVersionedCollectionSnapshot', f.datasetId); assert.equal(rejected.ok, false);
    if (!rejected.ok) assert.equal(rejected.failure.error.code, identityChange ? 'OUTBOX_SCOPE_MISMATCH' : 'INVENTORY_UNAVAILABLE');
    mutate = false; if (identityChange) Object.defineProperty(f.domain, 'datasetId', { value: f.datasetId, configurable: true });
    const current = result<DatasetCollectionSnapshotVersion>(await f.rpc('getCollectionSnapshotVersion', f.datasetId)); if (!identityChange) assert.notEqual(before.revision, current.revision);
    const large = result(await f.rpc('exportLargeVersionedCollectionSnapshot', f.datasetId)); assert.ok(protocol.isDatasetLargeVersionedCollectionSnapshot(large)); assert.deepEqual(large.version, current);
    const small = result<{ snapshot: { snapshotId: string } }>(await f.rpc('exportVersionedCollectionSnapshot', f.datasetId)), old = result<{ snapshotId: string }>(await f.rpc('exportCollectionSnapshot', f.datasetId));
    assert.equal(new Set([large.snapshot.snapshotId, small.snapshot.snapshotId, old.snapshotId]).size, 3); await f.rpc('close');
  }
});

test('完整大原子导出期间真实外部提交使版本配对失败，下次导出读新事实', async t => {
  const { repository, filePath } = await fixture(t); seedRustCollection(filePath, 151);
  const writer = new DatabaseSync(filePath); t.after(() => writer.close()); let changed = false;
  const f = harness(t, { readonlySnapshotStamp: () => repository.readonlySnapshotStamp(), exportLargeCollectionModels() {
    const original = DatabaseSync.prototype.prepare;
    DatabaseSync.prototype.prepare = function(sql) {
      const statement = original.call(this, sql);
      if (this !== writer && sql.startsWith('SELECT p.id,p.model_id,p.physical_id,p.width,p.height')) {
        const all = statement.all.bind(statement);
        statement.all = (...values) => {
          const rows = Reflect.apply(all, statement, values) as ReturnType<typeof statement.all>;
          if (!changed) { changed = true; writer.exec('UPDATE collection_models SET revision=revision+1'); } return rows;
        };
      }
      return statement;
    };
    try { return repository.exportLargeReadonlyModels(); } finally { DatabaseSync.prototype.prepare = original; }
  } });
  await f.rpc('prepare'); await f.rpc('commitBoot');
  const before = result<DatasetCollectionSnapshotVersion>(await f.rpc('getCollectionSnapshotVersion', f.datasetId));
  const rejected = await f.rpc('exportLargeVersionedCollectionSnapshot', f.datasetId); assert.equal(changed, true); assert.equal(rejected.ok, false);
  if (!rejected.ok) assert.equal(rejected.failure.error.code, 'INVENTORY_UNAVAILABLE');
  const next = result(await f.rpc('exportLargeVersionedCollectionSnapshot', f.datasetId)); assert.ok(protocol.isDatasetLargeVersionedCollectionSnapshot(next));
  assert.notEqual(next.version.revision, before.revision); assert.ok(next.snapshot.models.every(model => model.revision === 2)); await f.rpc('close');
});

class SyntheticWorker extends EventEmitter {
  requests: DatasetOwnerRequest[] = [];
  postMessage(request: DatasetOwnerRequest) { assert.ok(protocol.isDatasetOwnerRequest(request)); this.requests.push(request); }
  take(operation: string) { const request = this.requests.shift()!; assert.equal(request.operation, operation); return request; }
  reply(request: DatasetOwnerRequest, value: unknown) { this.emit('message', { version: 1, type: 'response', epoch: request.epoch, requestId: request.requestId, operation: request.operation, ok: true, result: value }); }
}
async function synthetic() {
  const worker = new SyntheticWorker(), reasons: string[] = [], endpoint = createDatasetOwnerClient({ worker: worker as unknown as Worker, onFatal: reason => reasons.push(reason) });
  const preparation = endpoint.prepare(), request = worker.take('prepare'), identity = { epoch: request.epoch, datasetId: randomUUID() };
  worker.reply(request, identity); await preparation; const commitment = endpoint.commitBoot(); worker.reply(worker.take('commitBoot'), undefined); await commitment;
  return { worker, endpoint, identity, reasons };
}

test('client大快照验证版本UUID、scope和snapshot配对，跨三API重复snapshotId使协议失败', async () => {
  for (const mode of ['revision', 'epoch', 'dataset', 'extra', 'pair', 'bad-model', 'duplicate-model']) {
    const f = await synthetic(), pending = f.endpoint.exportLargeVersionedCollectionSnapshot(), request = f.worker.take('exportLargeVersionedCollectionSnapshot');
    assert.equal(request.expectedDatasetId, f.identity.datasetId);
    const version = { ...f.identity, revision: mode === 'revision' ? '00000000-0000-1000-8000-000000000000' : randomUUID(),
      ...(mode === 'epoch' ? { epoch: randomUUID() } : {}), ...(mode === 'dataset' ? { datasetId: randomUUID() } : {}), ...(mode === 'extra' ? { extra: true } : {}) };
    const model = sampleModel();
    f.worker.reply(request, { version, snapshot: { ...f.identity, ...(mode === 'pair' ? { datasetId: randomUUID() } : {}), snapshotId: randomUUID(), models: mode === 'bad-model' ? [{}] : mode === 'duplicate-model' ? [model, model] : [] } });
    await assert.rejects(pending, error => error instanceof protocol.DatasetOwnerTransportError && error.outcome === 'unknown'); assert.deepEqual(f.reasons, ['protocol-failure']);
  }
  for (const first of ['exportCollectionSnapshot', 'exportVersionedCollectionSnapshot', 'exportLargeVersionedCollectionSnapshot'] as const) {
    for (const next of ['exportCollectionSnapshot', 'exportVersionedCollectionSnapshot', 'exportLargeVersionedCollectionSnapshot'] as const) {
      const f = await synthetic(), snapshot = { ...f.identity, snapshotId: randomUUID(), models: [] }, version = { ...f.identity, revision: randomUUID() };
      const pending = f.endpoint[first](); f.worker.reply(f.worker.take(first), first === 'exportCollectionSnapshot' ? snapshot : { snapshot, version }); await pending;
      const repeated = f.endpoint[next](); f.worker.reply(f.worker.take(next), next === 'exportCollectionSnapshot' ? snapshot : { snapshot, version });
      await assert.rejects(repeated, error => error instanceof protocol.DatasetOwnerTransportError && error.outcome === 'unknown'); assert.deepEqual(f.reasons, ['protocol-failure']);
    }
  }
});

test('三导出共享单在途，独立探测与调用方超时均不能提前释放，失败结算后才开放', async () => {
  const early = createDatasetOwnerClient({ worker: new SyntheticWorker() as unknown as Worker }); await assert.rejects(early.exportLargeVersionedCollectionSnapshot(), notSent);
  const operations = ['exportCollectionSnapshot', 'exportVersionedCollectionSnapshot', 'exportLargeVersionedCollectionSnapshot'] as const;
  for (const first of operations) {
    const f = await synthetic(), pending = f.endpoint[first](), request = f.worker.take(first);
    for (const next of operations) await assert.rejects(f.endpoint[next](), notSent);
    const probe = f.endpoint.getCollectionSnapshotVersion(), probeRequest = f.worker.take('getCollectionSnapshotVersion'), version = { ...f.identity, revision: randomUUID() };
    f.worker.reply(probeRequest, version); await probe;
    assert.equal(await Promise.race([pending.then(() => 'exported'), Promise.resolve('caller-timeout')]), 'caller-timeout');
    for (const next of operations) await assert.rejects(f.endpoint[next](), notSent);
    f.worker.emit('message', { version: 1, type: 'response', epoch: request.epoch, requestId: request.requestId, operation: request.operation, ok: false,
      failure: responseFailure(request.requestId, 'INVENTORY_UNAVAILABLE', '合成导出拒绝。') });
    await assert.rejects(pending, error => error instanceof protocol.DatasetOwnerDispatchError);
    const retried = f.endpoint.exportLargeVersionedCollectionSnapshot(); f.worker.reply(f.worker.take('exportLargeVersionedCollectionSnapshot'), { snapshot: { ...f.identity, snapshotId: randomUUID(), models: [] }, version }); await retried;
    const closure = f.endpoint.close(), closeRequest = f.worker.take('close'); await assert.rejects(f.endpoint.exportLargeVersionedCollectionSnapshot(), notSent);
    f.worker.reply(closeRequest, undefined); f.worker.emit('exit', 0); await closure; assert.deepEqual(f.reasons, []);
  }
});

test('大导出成功晚到才释放在途预算，close等待该RPC和自然退出并拒绝新导出', async () => {
  const f = await synthetic(), pending = f.endpoint.exportLargeVersionedCollectionSnapshot(), request = f.worker.take('exportLargeVersionedCollectionSnapshot');
  assert.equal(await Promise.race([pending.then(() => 'exported'), Promise.resolve('caller-timeout')]), 'caller-timeout');
  await assert.rejects(f.endpoint.exportCollectionSnapshot(), notSent);
  const value = { snapshot: { ...f.identity, snapshotId: randomUUID(), models: [] }, version: { ...f.identity, revision: randomUUID() } };
  f.worker.reply(request, value); assert.deepEqual(await pending, value);
  const next = f.endpoint.exportLargeVersionedCollectionSnapshot(), nextRequest = f.worker.take('exportLargeVersionedCollectionSnapshot');
  const closing = f.endpoint.close(), closeRequest = f.worker.take('close'); await assert.rejects(f.endpoint.exportLargeVersionedCollectionSnapshot(), notSent);
  f.worker.reply(nextRequest, { ...value, snapshot: { ...value.snapshot, snapshotId: randomUUID() } }); await next;
  f.worker.reply(closeRequest, undefined);
  assert.equal(await Promise.race([closing.then(() => 'closed'), Promise.resolve('still-running')]), 'still-running');
  f.worker.emit('exit', 0); await closing; assert.deepEqual(f.reasons, []);
});

test('实际两库Owner大快照5000完整，旧API与5001拒绝不影响版本探测和自然关闭', { timeout: 20_000 }, async t => {
  const dataDirectory = await directory(t), worker = new Worker(new URL('./helpers/dataset-owner-large-snapshot-fixture.ts', import.meta.url), { execArgv: ['--import', 'tsx'], workerData: { dataDirectory } });
  const endpoint = createDatasetOwnerClient({ worker }); t.after(() => endpoint.close());
  await assert.rejects(endpoint.exportLargeVersionedCollectionSnapshot(), notSent); const identity = await endpoint.prepare();
  await assert.rejects(endpoint.exportLargeVersionedCollectionSnapshot(), notSent); await endpoint.commitBoot();
  const filePath = path.join(dataDirectory, 'collection.v1.sqlite'), ids = seedRustCollection(filePath, 5_000), version = await endpoint.getCollectionSnapshotVersion();
  const large = await endpoint.exportLargeVersionedCollectionSnapshot(); assert.ok(protocol.isDatasetLargeVersionedCollectionSnapshot(large)); assert.deepEqual(large.version, version);
  assert.equal(large.snapshot.epoch, identity.epoch); assert.equal(large.snapshot.datasetId, identity.datasetId); assert.deepEqual(large.snapshot.models.map(model => model.id), ids);
  for (let offset = 0; offset < 5_000; offset += 100) {
    const listed = await endpoint.dispatch({ version: 1, id: randomUUID(), command: 'collection.list', payload: { page: { offset, limit: 100 } }, expectedDatasetId: identity.datasetId }) as { items: CollectionModel[] };
    assert.deepEqual(large.snapshot.models.slice(offset, offset + 100), listed.items);
  }
  for (const operation of ['exportCollectionSnapshot', 'exportVersionedCollectionSnapshot'] as const) await assert.rejects(endpoint[operation](), error => error instanceof protocol.DatasetOwnerDispatchError && error.failure.error.code === 'INVENTORY_UNAVAILABLE');
  seedRustCollection(filePath, 1, 5_000); await assert.rejects(endpoint.exportLargeVersionedCollectionSnapshot(), error => error instanceof protocol.DatasetOwnerDispatchError && error.failure.error.code === 'INVENTORY_UNAVAILABLE');
  assert.notEqual((await endpoint.getCollectionSnapshotVersion()).revision, version.revision);
  const exit = once(worker, 'exit'); await endpoint.close(); assert.deepEqual(await exit, [0]);
});
