import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { MessageChannel, Worker, type MessagePort } from 'node:worker_threads';
import type { CollectionReceiveRequest } from '@music-bridge/contracts';
import { CollectionError, createCollectionRepository } from '../src/collection/repository.js';
import { createTestDatasetDomain } from '../src/collection/dataset-domain.js';
import { createDatasetOwnerClient } from '../src/collection/dataset-owner-client.js';
import { attachDatasetOwnerWorkerPort } from '../src/collection/dataset-owner-worker.js';
import { DatasetOwnerTransportError, isDatasetCollectionSnapshotVersion, isDatasetVersionedCollectionSnapshot, isDatasetOwnerRequest,
  type DatasetCollectionSnapshotVersion, type DatasetOwnerRequest, type DatasetOwnerResponse, type OwnedDatasetDomain } from '../src/collection/dataset-owner-protocol.js';
import { responseFailure } from '../src/shared/ipc-failure.js';

const page = { offset: 0, limit: 100 };
const receipt = (): CollectionReceiveRequest => ({ commandId: randomUUID(), model: { brand: '合成品牌', name: '版本测试型号', edition: '测试版', year: 1990,
  format: 'cassette', tapeType: 'II', identification: 'verified' }, lengthMinutes: 90, quantities: { sealedBlank: 1, openedBlank: 0, legacyUsed: 0, unclassified: 0 } });
const unavailable = (error: unknown) => error instanceof CollectionError && error.code === 'INVENTORY_UNAVAILABLE';
const notSent = (error: unknown) => error instanceof DatasetOwnerTransportError && error.outcome === 'not-sent';
async function directory(t: test.TestContext): Promise<string> {
  const root = path.resolve(os.tmpdir()), external = '/Volumes/LifeWeave/Developer/CommandLine/tmp';
  if (process.platform === 'darwin' && process.env.GITHUB_ACTIONS !== 'true' && root !== external && !root.startsWith(`${external}/`)) throw new Error('本机版本测试必须使用外置 TMPDIR。');
  const result = await mkdtemp(path.join(root, 'mb-snapshot-version-')); t.diagnostic(`合成证据目录：${result}`); return result;
}

test('同一连接戳稳定只读，同连接提交改变totalChanges，另一连接提交改变dataVersion', async t => {
  const filePath = path.join(await directory(t), 'collection.sqlite'), repository = createCollectionRepository({ filePath });
  t.after(() => repository.close());
  const before = repository.readonlySnapshotStamp();
  repository.list(page); repository.exportReadonlyModels();
  assert.deepEqual(repository.readonlySnapshotStamp(), before);
  const received = repository.receive(receipt()), own = repository.readonlySnapshotStamp();
  assert.equal(own.dataVersion, before.dataVersion); assert.ok(own.totalChanges > before.totalChanges);
  const writer = new DatabaseSync(filePath);
  try { writer.prepare('UPDATE collection_models SET revision=revision+1 WHERE id=?').run(received.modelId); } finally { writer.close(); }
  const other = repository.readonlySnapshotStamp();
  assert.notEqual(other.dataVersion, own.dataVersion); assert.equal(other.totalChanges, own.totalChanges);
  assert.deepEqual(repository.readonlySnapshotStamp(), other);
  repository.close(); assert.throws(() => repository.readonlySnapshotStamp(), unavailable);
});

test('回滚不增加库存但totalChanges保守失效，不把失败写当稳定只读', async t => {
  let rejectWrite = false;
  const repository = createCollectionRepository({ filePath: path.join(await directory(t), 'rollback.sqlite'), beforeCommit(action) {
    if (rejectWrite && action === 'receive') throw new Error('合成提交前失败。');
  } });
  t.after(() => repository.close());
  const f = harness(t, { readonlySnapshotStamp: () => repository.readonlySnapshotStamp(), exportCollectionModels: () => repository.exportReadonlyModels() });
  await f.rpc('prepare'); await f.rpc('commitBoot');
  const version = result<DatasetCollectionSnapshotVersion>(await f.rpc('getCollectionSnapshotVersion', f.datasetId));
  const before = repository.readonlySnapshotStamp(); rejectWrite = true;
  assert.throws(() => repository.receive(receipt()), unavailable);
  assert.equal(repository.list(page).total, 0);
  const after = repository.readonlySnapshotStamp();
  assert.equal(after.dataVersion, before.dataVersion); assert.ok(after.totalChanges > before.totalChanges);
  const next = result<DatasetCollectionSnapshotVersion>(await f.rpc('getCollectionSnapshotVersion', f.datasetId));
  assert.notEqual(next.revision, version.revision);
  assert.deepEqual(result(await f.rpc('getCollectionSnapshotVersion', f.datasetId)), next);
  await f.rpc('close');
});

test('domain读取戳前后校验身份，关闭后封锁读取', async () => {
  let changed = false, checks = 0;
  const domain = createTestDatasetDomain({ collectionDatasetIdentity: { datasetId: randomUUID(), assertCurrent() { checks++; if (changed) throw new CollectionError('INVENTORY_UNAVAILABLE', '合成身份失效。'); } } });
  const original = domain.collection.readonlySnapshotStamp;
  domain.collection.readonlySnapshotStamp = () => { changed = true; return original(); };
  const before = checks;
  assert.throws(() => domain.readonlySnapshotStamp!(), unavailable); assert.equal(checks - before, 2);
  changed = false; domain.collection.readonlySnapshotStamp = original;
  assert.deepEqual(domain.readonlySnapshotStamp!(), domain.readonlySnapshotStamp!());
  await domain.close(); assert.throws(() => domain.readonlySnapshotStamp!(), unavailable);
});

function harness(t: test.TestContext, overrides: Partial<OwnedDatasetDomain> = {}) {
  const ports = new MessageChannel(), epoch = randomUUID(), datasetId = randomUUID();
  let sequence = 0;
  const domain: OwnedDatasetDomain = { datasetId, async dispatch() { return {}; }, commitBoot() {}, exportCollectionModels() { return []; },
    readonlySnapshotStamp() { return { dataVersion: 1, totalChanges: 0 }; }, async close(before) { await before?.(); },
    failureForError: id => responseFailure(id, 'INVENTORY_UNAVAILABLE', '合成领域失败。'), ...overrides };
  attachDatasetOwnerWorkerPort(ports.port1, { async prepare() { return domain; } });
  t.after(() => { ports.port1.close(); ports.port2.close(); });
  const rpc = (operation: DatasetOwnerRequest['operation'], expectedDatasetId?: string): Promise<DatasetOwnerResponse> => {
    const request: DatasetOwnerRequest = { version: 1, type: 'request', epoch, requestId: randomUUID(), sequence: ++sequence, operation,
      ...(expectedDatasetId === undefined ? {} : { expectedDatasetId }) };
    return new Promise(resolve => { const listener = (response: DatasetOwnerResponse) => { if (response.requestId !== request.requestId) return; ports.port2.off('message', listener); resolve(response); };
      ports.port2.on('message', listener); ports.port2.postMessage(request); });
  };
  return { domain, epoch, datasetId, rpc };
}
function result<T>(response: DatasetOwnerResponse): T { assert.equal(response.ok, true); if (!response.ok) throw new Error('缺少合成成功回执。'); return response.result as T; }

test('worker稳定令牌、戳变化更换opaque revision，旧导出保持兼容且snapshotId唯一', async t => {
  let changes = 0;
  const f = harness(t, { readonlySnapshotStamp: () => ({ dataVersion: 1, totalChanges: changes }) });
  await f.rpc('prepare'); await f.rpc('commitBoot');
  const first = result<DatasetCollectionSnapshotVersion>(await f.rpc('getCollectionSnapshotVersion', f.datasetId));
  assert.ok(isDatasetCollectionSnapshotVersion(first));
  assert.deepEqual(result(await f.rpc('getCollectionSnapshotVersion', f.datasetId)), first);
  const versioned = result(await f.rpc('exportVersionedCollectionSnapshot', f.datasetId)); assert.ok(isDatasetVersionedCollectionSnapshot(versioned));
  assert.deepEqual(versioned.version, first);
  changes++;
  const second = result<DatasetCollectionSnapshotVersion>(await f.rpc('getCollectionSnapshotVersion', f.datasetId)); assert.notEqual(second.revision, first.revision);
  const old = result<{ snapshotId: string }>(await f.rpc('exportCollectionSnapshot', f.datasetId)); assert.notEqual(old.snapshotId, versioned.snapshot.snapshotId);
  await f.rpc('close');
});

test('worker版本操作遵守boot、缺方法、失败boot、期望身份门禁', async t => {
  for (const mode of ['before-boot', 'failed-boot', 'legacy', 'wrong-scope', 'bad-stamp']) {
    const f = harness(t, { ...(mode === 'bad-stamp' ? { readonlySnapshotStamp: () => ({ dataVersion: NaN, totalChanges: 0 }) } : {}),
      ...(mode === 'failed-boot' ? { commitBoot() { throw new Error('合成boot失败。'); } } : {}) });
    if (mode === 'legacy') delete f.domain.readonlySnapshotStamp;
    await f.rpc('prepare');
    if (mode !== 'before-boot') await f.rpc('commitBoot');
    for (const operation of ['getCollectionSnapshotVersion', 'exportVersionedCollectionSnapshot'] as const) {
      const response = await f.rpc(operation, mode === 'wrong-scope' ? randomUUID() : f.datasetId);
      assert.equal(response.ok, false);
      if (!response.ok) assert.equal(response.failure.error.code, mode === 'wrong-scope' ? 'OUTBOX_SCOPE_MISMATCH' : 'NOT_READY');
    }
    await f.rpc('close');
  }
});

test('worker导出中戳改变或身份变化整体拒绝，后续正常版本可观察', async t => {
  for (const identityChange of [false, true]) {
    let mutate = true;
    const stamp = { dataVersion: 1, totalChanges: 0 };
    const f = harness(t, { readonlySnapshotStamp: () => stamp, exportCollectionModels() {
      if (mutate) { if (identityChange) Object.defineProperty(f.domain, 'datasetId', { value: randomUUID(), configurable: true }); else stamp.totalChanges++; }
      return [];
    } });
    await f.rpc('prepare'); await f.rpc('commitBoot');
    const before = result<DatasetCollectionSnapshotVersion>(await f.rpc('getCollectionSnapshotVersion', f.datasetId));
    const rejected = await f.rpc('exportVersionedCollectionSnapshot', f.datasetId); assert.equal(rejected.ok, false);
    if (!rejected.ok) assert.equal(rejected.failure.error.code, identityChange ? 'OUTBOX_SCOPE_MISMATCH' : 'INVENTORY_UNAVAILABLE');
    mutate = false;
    if (identityChange) Object.defineProperty(f.domain, 'datasetId', { value: f.datasetId, configurable: true });
    const after = result<DatasetCollectionSnapshotVersion>(await f.rpc('getCollectionSnapshotVersion', f.datasetId));
    if (!identityChange) assert.notEqual(before.revision, after.revision);
    assert.ok(isDatasetVersionedCollectionSnapshot(result(await f.rpc('exportVersionedCollectionSnapshot', f.datasetId))));
    await f.rpc('close');
  }
});

test('完整同步原子导出期间真实外部提交使版本配对拒绝，下一导出读取新事实', async t => {
  const filePath = path.join(await directory(t), 'race.sqlite'), repository = createCollectionRepository({ filePath });
  t.after(() => repository.close()); repository.receive(receipt());
  const writer = new DatabaseSync(filePath); t.after(() => writer.close());
  let changed = false;
  const f = harness(t, { readonlySnapshotStamp: () => repository.readonlySnapshotStamp(), exportCollectionModels() {
    const original = DatabaseSync.prototype.prepare;
    DatabaseSync.prototype.prepare = function(sql) {
      const statement = original.call(this, sql);
      if (this !== writer && sql.startsWith('SELECT p.id,p.model_id,p.physical_id,p.width,p.height')) {
        const all = statement.all.bind(statement);
        statement.all = (...values) => {
          const rows = Reflect.apply(all, statement, values) as ReturnType<typeof statement.all>;
          if (!changed) { changed = true; writer.exec('UPDATE collection_models SET revision=revision+1'); }
          return rows;
        };
      }
      return statement;
    };
    try { return repository.exportReadonlyModels(); } finally { DatabaseSync.prototype.prepare = original; }
  } });
  await f.rpc('prepare'); await f.rpc('commitBoot');
  const response = await f.rpc('exportVersionedCollectionSnapshot', f.datasetId); assert.equal(changed, true); assert.equal(response.ok, false);
  if (!response.ok) assert.equal(response.failure.error.code, 'INVENTORY_UNAVAILABLE');
  const next = result(await f.rpc('exportVersionedCollectionSnapshot', f.datasetId)); assert.ok(isDatasetVersionedCollectionSnapshot(next)); assert.equal(next.snapshot.models[0]!.revision, 2);
  await f.rpc('close');
});

class SyntheticWorker extends EventEmitter {
  requests: DatasetOwnerRequest[] = [];
  postMessage(request: DatasetOwnerRequest) { assert.ok(isDatasetOwnerRequest(request)); this.requests.push(request); }
  take(operation: string) { const request = this.requests.shift()!; assert.equal(request.operation, operation); return request; }
  reply(request: DatasetOwnerRequest, value: unknown) { this.emit('message', { version: 1, type: 'response', epoch: request.epoch, requestId: request.requestId, operation: request.operation, ok: true, result: value }); }
}
async function synthetic() {
  const worker = new SyntheticWorker(), reasons: string[] = [], endpoint = createDatasetOwnerClient({ worker: worker as unknown as Worker, onFatal: reason => reasons.push(reason) });
  const preparing = endpoint.prepare(), request = worker.take('prepare'), identity = { epoch: request.epoch, datasetId: randomUUID() };
  worker.reply(request, identity); await preparing;
  const committing = endpoint.commitBoot(); worker.reply(worker.take('commitBoot'), undefined); await committing;
  return { worker, endpoint, identity, reasons };
}

test('私有版本信封只接受expectedDatasetId，无路径SQL或公开payload扩展', () => {
  for (const operation of ['getCollectionSnapshotVersion', 'exportVersionedCollectionSnapshot'] as const) {
    const valid = { version: 1, type: 'request', epoch: randomUUID(), requestId: randomUUID(), sequence: 1, operation, expectedDatasetId: randomUUID() };
    assert.equal(isDatasetOwnerRequest(valid), true);
    for (const bad of [{ ...valid, expectedDatasetId: undefined }, { ...valid, path: '/合成路径' }, { ...valid, sql: '合成SQL' }, { ...valid, request: {} }, { ...valid, revision: randomUUID() }]) assert.equal(isDatasetOwnerRequest(bad), false);
  }
});

test('client严查版本shape、UUID v4、身份、snapshot配对和跨API重复snapshotId', async () => {
  for (const operation of ['getCollectionSnapshotVersion', 'exportVersionedCollectionSnapshot'] as const) {
    for (const mode of ['revision', 'epoch', 'dataset', 'extra', 'pair', 'bad-model']) {
      const f = await synthetic(), pending = f.endpoint[operation](), request = f.worker.take(operation);
      assert.equal(request.expectedDatasetId, f.identity.datasetId);
      const version = { ...f.identity, revision: mode === 'revision' ? '00000000-0000-1000-8000-000000000000' : randomUUID(),
        ...(mode === 'epoch' ? { epoch: randomUUID() } : {}), ...(mode === 'dataset' ? { datasetId: randomUUID() } : {}),
        ...(mode === 'extra' || (operation === 'getCollectionSnapshotVersion' && ['pair', 'bad-model'].includes(mode)) ? { extra: true } : {}) };
      const value = operation === 'getCollectionSnapshotVersion' ? version : { version, snapshot: { ...f.identity,
        ...(mode === 'pair' ? { datasetId: randomUUID() } : {}), snapshotId: randomUUID(), models: mode === 'bad-model' ? [{}] : [] } };
      f.worker.reply(request, value);
      await assert.rejects(pending, error => error instanceof DatasetOwnerTransportError && error.outcome === 'unknown');
      assert.deepEqual(f.reasons, ['protocol-failure']); assert.equal(f.worker.requests.length, 0);
    }
  }
  const f = await synthetic(), snapshot = { ...f.identity, snapshotId: randomUUID(), models: [] };
  const old = f.endpoint.exportCollectionSnapshot(); f.worker.reply(f.worker.take('exportCollectionSnapshot'), snapshot); await old;
  const next = f.endpoint.exportVersionedCollectionSnapshot(); f.worker.reply(f.worker.take('exportVersionedCollectionSnapshot'), { snapshot, version: { ...f.identity, revision: randomUUID() } });
  await assert.rejects(next, error => error instanceof DatasetOwnerTransportError && error.outcome === 'unknown');
});

test('client版本boot与close门禁，两个导出API共享单次预算，探测保留独立RPC', async () => {
  const early = createDatasetOwnerClient({ worker: new SyntheticWorker() as unknown as Worker });
  await assert.rejects(early.getCollectionSnapshotVersion(), notSent); await assert.rejects(early.exportVersionedCollectionSnapshot(), notSent);
  const f = await synthetic(), exporting = f.endpoint.exportVersionedCollectionSnapshot(), exportRequest = f.worker.take('exportVersionedCollectionSnapshot');
  await assert.rejects(f.endpoint.exportCollectionSnapshot(), notSent); await assert.rejects(f.endpoint.exportVersionedCollectionSnapshot(), notSent);
  const probing = f.endpoint.getCollectionSnapshotVersion(), probe = f.worker.take('getCollectionSnapshotVersion');
  const version = { ...f.identity, revision: randomUUID() }; f.worker.reply(probe, version); await probing;
  const closing = f.endpoint.close(), close = f.worker.take('close');
  await assert.rejects(f.endpoint.getCollectionSnapshotVersion(), notSent); await assert.rejects(f.endpoint.exportVersionedCollectionSnapshot(), notSent);
  f.worker.reply(exportRequest, { snapshot: { ...f.identity, snapshotId: randomUUID(), models: [] }, version }); await exporting;
  f.worker.reply(close, undefined); f.worker.emit('exit', 0); await closing; assert.deepEqual(f.reasons, []);
});

test('实际两库Owner成功boot后版本与快照匹配，公开写入改变令牌且close自然退出', { timeout: 20_000 }, async t => {
  const dataDirectory = await directory(t);
  const worker = new Worker(new URL('./helpers/dataset-owner-version-fixture.ts', import.meta.url), { execArgv: ['--import', 'tsx'], workerData: { dataDirectory } });
  const endpoint = createDatasetOwnerClient({ worker }); t.after(() => endpoint.close());
  await assert.rejects(endpoint.getCollectionSnapshotVersion(), notSent);
  const identity = await endpoint.prepare(); await assert.rejects(endpoint.exportVersionedCollectionSnapshot(), notSent); await endpoint.commitBoot();
  const before = await endpoint.getCollectionSnapshotVersion(); assert.deepEqual(await endpoint.getCollectionSnapshotVersion(), before);
  await endpoint.dispatch({ version: 1, id: randomUUID(), command: 'collection.receive', payload: receipt(), expectedDatasetId: identity.datasetId });
  const after = await endpoint.getCollectionSnapshotVersion(); assert.notEqual(before.revision, after.revision);
  const paired = await endpoint.exportVersionedCollectionSnapshot(); assert.deepEqual(paired.version, after); assert.equal(paired.snapshot.models.length, 1);
  assert.deepEqual((await endpoint.exportCollectionSnapshot()).models, paired.snapshot.models);
  assert.deepEqual(await endpoint.getCollectionSnapshotVersion(), after);
  // 父测试仅写合成库，作者仍用原连接观察其他连接提交。
  const writer = new DatabaseSync(path.join(dataDirectory, 'collection.v1.sqlite'));
  try { writer.exec('UPDATE collection_models SET revision=revision+1'); } finally { writer.close(); }
  const external = await endpoint.getCollectionSnapshotVersion(); assert.notEqual(external.revision, after.revision);
  const changed = await endpoint.exportVersionedCollectionSnapshot(); assert.deepEqual(changed.version, external); assert.equal(changed.snapshot.models[0]!.revision, 2);
  assert.deepEqual(await endpoint.getCollectionSnapshotVersion(), external);
  const exit = once(worker, 'exit'); await endpoint.close(); assert.deepEqual(await exit, [0]);
});
