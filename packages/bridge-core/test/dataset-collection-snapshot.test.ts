import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { MessageChannel, Worker, type MessagePort } from 'node:worker_threads';
import { isCollectionModel, type CollectionModel, type CollectionReceiveRequest, type IpcRequest } from '@music-bridge/contracts';
import { CollectionError, createCollectionRepository } from '../src/collection/repository.js';
import { createTestDatasetDomain } from '../src/collection/dataset-domain.js';
import { createDatasetOwnerClient } from '../src/collection/dataset-owner-client.js';
import { attachDatasetOwnerWorkerPort } from '../src/collection/dataset-owner-worker.js';
import { DatasetOwnerDispatchError, DatasetOwnerTransportError, isDatasetCollectionSnapshot, isDatasetOwnerRequest,
  MAX_DATASET_COLLECTION_SNAPSHOT_BYTES, type DatasetOwnerRequest, type DatasetOwnerResponse, type OwnedDatasetDomain } from '../src/collection/dataset-owner-protocol.js';
import { responseFailure } from '../src/shared/ipc-failure.js';

const page = { offset: 0, limit: 100 };
const descriptor: CollectionReceiveRequest['model'] = { brand: '合成品牌', name: '合成型号', edition: '测试版', year: 1990, format: 'cassette', tapeType: 'II', identification: 'verified' };
const receipt = (overrides: Partial<CollectionReceiveRequest> = {}): CollectionReceiveRequest => ({ commandId: randomUUID(), model: descriptor,
  lengthMinutes: 90, quantities: { sealedBlank: 3, openedBlank: 2, legacyUsed: 1, unclassified: 1 }, ...overrides });
const unavailable = (error: unknown) => error instanceof CollectionError && error.code === 'INVENTORY_UNAVAILABLE';
const notSent = (error: unknown) => error instanceof DatasetOwnerTransportError && error.outcome === 'not-sent';

async function directory(t: test.TestContext) {
  const root = path.resolve(os.tmpdir());
  const externalRoot = '/Volumes/LifeWeave/Developer/CommandLine/tmp';
  const hosted = process.env.GITHUB_ACTIONS === 'true' && Boolean(process.env.RUNNER_TEMP);
  if (process.platform === 'darwin' && !hosted && root !== externalRoot && !root.startsWith(`${externalRoot}/`)) throw new Error('本机快照测试必须使用 LifeWeave 外置 TMPDIR。');
  const result = await mkdtemp(path.join(root, 'musicbridge-collection-snapshot-'));
  t.diagnostic(`合成证据目录：${result}`);
  return result;
}
async function fixture(t: test.TestContext) {
  const filePath = path.join(await directory(t), 'collection.sqlite');
  const repository = createCollectionRepository({ filePath });
  t.after(() => repository.close());
  repository.list(page);
  return { repository, filePath };
}
// 只给合成库一次性写入规模数据；生产连接与正式 writer 没有这些入口。
function seed(filePath: string, amount: number, wide = false): string[] {
  const db = new DatabaseSync(filePath);
  const ids: string[] = [];
  try {
    db.exec('BEGIN IMMEDIATE');
    const model = db.prepare('INSERT INTO collection_models(id,identity_key,descriptor) VALUES (?,?,?)');
    const sku = db.prepare('INSERT INTO collection_skus(id,model_id,minutes) VALUES (?,?,?)');
    const lot = db.prepare('INSERT INTO inventory_lots(id,sku_id,acquired,sealed,opened,legacy,unknown,quantity_adjustment) VALUES (?,?,7,3,2,1,1,0)');
    for (let index = 0; index < amount; index++) {
      const id = randomUUID(), skuId = randomUUID(); ids.push(id);
      // 契约允许的单独代理项会在 JSON 编码时变成六字节转义，明确覆盖编码预算。
      const text = wide ? '\ud800'.repeat(120) : `合成型号-${index}`;
      model.run(id, randomUUID(), JSON.stringify({ ...descriptor, brand: wide ? text : descriptor.brand, name: text, edition: wide ? text : `测试-${index}` }));
      sku.run(skuId, id, 90); lot.run(randomUUID(), skuId);
    }
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  finally { db.close(); }
  return ids.toReversed();
}
function publicModels(repository: ReturnType<typeof createCollectionRepository>): CollectionModel[] {
  const result: CollectionModel[] = [];
  for (let offset = 0; ; offset += 100) {
    const current = repository.list({ offset, limit: 100 }); result.push(...current.items);
    if (!current.hasMore) return result;
  }
}

test('完整101型号快照保持rowid、库存多SKU、照片归属与零照片缺省，正常分页合同保持', async t => {
  const { repository, filePath } = await fixture(t);
  seed(filePath, 100);
  const stock = repository.receive(receipt());
  repository.receive(receipt({ lengthMinutes: null }));
  const physical = repository.materialize({ commandId: randomUUID(), lotId: stock.lotId!, bucket: 'sealedBlank', action: 'identify' });
  repository.updateCopy({ commandId: randomUUID(), physicalId: physical.physicalId!, expectedRevision: 1, action: 'reserve' });
  const first = repository.addPhoto({ commandId: randomUUID(), modelId: stock.modelId, image: { dataUrl: 'data:image/jpeg;base64,/9j/2Q==', width: 1, height: 1 } });
  const second = repository.addPhoto({ commandId: randomUUID(), modelId: stock.modelId, physicalId: physical.physicalId!, image: { dataUrl: 'data:image/jpeg;base64,/9j/2Q==', width: 1, height: 1 } });
  repository.changePhoto({ commandId: randomUUID(), modelId: stock.modelId, photoId: second.photoId!, expectedRevision: repository.detail(stock.modelId, page).model.revision, action: 'feature' });
  const expected = publicModels(repository), snapshot = repository.exportReadonlyModels();
  assert.equal(snapshot.length, 101); assert.deepEqual(snapshot, expected);
  assert.deepEqual(snapshot[0]!.lengths, [null, 90]); assert.equal(snapshot[0]!.counts.total, 14); assert.equal(snapshot[0]!.counts.reserved, 1);
  assert.equal(snapshot[0]!.photoCount, 2); assert.equal(snapshot[0]!.featuredPhoto?.id, second.photoId); assert.equal(snapshot[0]!.featuredPhoto?.physicalId, physical.physicalId);
  assert.equal(snapshot[1]!.photoCount, 0); assert.equal(Object.hasOwn(snapshot[1]!, 'featuredPhoto'), false);
  repository.changePhoto({ commandId: randomUUID(), modelId: stock.modelId, photoId: second.photoId!, expectedRevision: snapshot[0]!.revision, action: 'remove' });
  assert.equal(repository.exportReadonlyModels()[0]!.featuredPhoto?.id, first.photoId);
  assert.equal(repository.list(page).items.length, 100);
});

test('2000型号完整导出与公开DTO一致，2001型号拒绝且不截断，读失败回滚后正常入口仍可用', async t => {
  const { repository, filePath } = await fixture(t);
  const ids = seed(filePath, 2_000);
  const snapshot = repository.exportReadonlyModels();
  assert.equal(snapshot.length, 2_000); assert.deepEqual(snapshot.map(model => model.id), ids); assert.deepEqual(snapshot, publicModels(repository));
  seed(filePath, 1);
  assert.throws(() => repository.exportReadonlyModels(), unavailable);
  assert.equal(repository.list(page).total, 2_001);
  const db = new DatabaseSync(filePath);
  try { db.prepare('DELETE FROM inventory_lots WHERE sku_id IN (SELECT id FROM collection_skus WHERE model_id=?)').run(ids[0]!);
    db.prepare('DELETE FROM collection_skus WHERE model_id=?').run(ids[0]!); db.prepare('DELETE FROM collection_models WHERE id=?').run(ids[0]!); }
  finally { db.close(); }
  assert.equal(repository.exportReadonlyModels().length, 2_000);
});

test('一次SQLite读事务覆盖多个水合块，首块后合成外部写入不能产生混合快照', async t => {
  const { repository, filePath } = await fixture(t);
  const ids = seed(filePath, 101), expected = publicModels(repository);
  const writer = new DatabaseSync(filePath);
  t.after(() => writer.close());
  const original = DatabaseSync.prototype.prepare;
  let triggered = false;
  DatabaseSync.prototype.prepare = function(sql: string) {
    const statement = original.call(this, sql);
    if (this !== writer && sql.startsWith('SELECT p.id,p.model_id,p.physical_id,p.width,p.height')) {
      const all = statement.all.bind(statement);
      statement.all = (...parameters) => {
        const rows = Reflect.apply(all, statement, parameters) as ReturnType<typeof statement.all>;
        if (!triggered) {
          triggered = true;
          writer.exec('BEGIN IMMEDIATE');
          writer.exec('UPDATE inventory_lots SET quantity_adjustment=1,sealed=4; UPDATE collection_models SET revision=2;');
          writer.exec('COMMIT');
        }
        return rows;
      };
    }
    return statement;
  };
  try {
    const snapshot = repository.exportReadonlyModels();
    assert.equal(triggered, true); assert.deepEqual(snapshot, expected);
    assert.deepEqual(snapshot.map(model => model.id), ids);
  } finally { DatabaseSync.prototype.prepare = original; }
  const changed = repository.exportReadonlyModels();
  assert.ok(changed.every(model => model.counts.sealedBlank === 4 && model.revision === 2));
});

test('合法DTO的JSON编码超过4MiB拒绝、不截断，损坏拒绝后回滚且close后拒绝', async t => {
  const { repository, filePath } = await fixture(t);
  const ids = seed(filePath, 2_000, true);
  const publicResult = publicModels(repository);
  assert.ok(publicResult.every(isCollectionModel)); assert.ok(Buffer.byteLength(JSON.stringify(publicResult)) > MAX_DATASET_COLLECTION_SNAPSHOT_BYTES);
  assert.throws(() => repository.exportReadonlyModels(), unavailable);
  assert.equal(repository.list(page).total, 2_000);
  const db = new DatabaseSync(filePath);
  try { db.prepare('UPDATE collection_models SET descriptor=?').run(JSON.stringify(descriptor));
    db.prepare('UPDATE collection_models SET descriptor=? WHERE id=?').run('{合成损坏', ids[0]!); }
  finally { db.close(); }
  assert.throws(() => repository.exportReadonlyModels(), unavailable);
  const repair = new DatabaseSync(filePath);
  try { repair.prepare('UPDATE collection_models SET descriptor=? WHERE id=?').run(JSON.stringify(descriptor), ids[0]!);
    assert.equal(repair.prepare('SELECT COUNT(*) n FROM collection_models').get()?.n, 2_000);
    assert.equal(repair.prepare('SELECT SUM(sealed) n FROM inventory_lots').get()?.n, 6_000); }
  finally { repair.close(); }
  assert.equal(repository.exportReadonlyModels().length, 2_000);
  repository.close(); assert.throws(() => repository.exportReadonlyModels(), unavailable);
});

test('domain导出前后断言当前工作库身份，关闭后拒绝同步导出', async () => {
  let checks = 0, changed = false;
  const domain = createTestDatasetDomain({ collectionDatasetIdentity: { datasetId: randomUUID(), assertCurrent() { checks++; if (changed) throw new CollectionError('INVENTORY_UNAVAILABLE', '合成库身份已经改变。'); } } });
  try {
    const original = domain.collection.exportReadonlyModels;
    domain.collection.exportReadonlyModels = () => { changed = true; return original(); };
    const before = checks;
    assert.throws(() => domain.exportCollectionModels!(), unavailable);
    assert.equal(checks - before, 2);
    changed = false; domain.collection.exportReadonlyModels = original;
    assert.deepEqual(domain.exportCollectionModels!(), []);
  } finally { await domain.close(); }
  assert.throws(() => domain.exportCollectionModels!(), unavailable);
});

class SyntheticWorker extends EventEmitter {
  requests: DatasetOwnerRequest[] = [];
  postMessage(request: DatasetOwnerRequest) { this.requests.push(request); }
  take(operation: string) { const result = this.requests.shift()!; assert.equal(result.operation, operation); return result; }
  reply(request: DatasetOwnerRequest, result: unknown) { this.emit('message', { version: 1, type: 'response', epoch: request.epoch, requestId: request.requestId, operation: request.operation, ok: true, result }); }
}
async function readySynthetic() {
  const worker = new SyntheticWorker(), reasons: string[] = [];
  const endpoint = createDatasetOwnerClient({ worker: worker as unknown as Worker, onFatal: reason => reasons.push(reason) });
  const preparing = endpoint.prepare(), request = worker.take('prepare');
  const identity = { epoch: request.epoch, datasetId: randomUUID() }; worker.reply(request, identity); await preparing;
  const committing = endpoint.commitBoot(); worker.reply(worker.take('commitBoot'), undefined); await committing;
  return { worker, endpoint, identity, reasons };
}

test('client导出预算一次一个，close封入口并等待导出收口与自然退出', async () => {
  const { worker, endpoint, identity, reasons } = await readySynthetic();
  const first = endpoint.exportCollectionSnapshot(), request = worker.take('exportCollectionSnapshot');
  assert.equal(request.expectedDatasetId, identity.datasetId); assert.equal(request.request, undefined);
  await assert.rejects(endpoint.exportCollectionSnapshot(), notSent); assert.equal(worker.requests.length, 0);
  const closing = endpoint.close(), closeRequest = worker.take('close');
  await assert.rejects(endpoint.exportCollectionSnapshot(), notSent);
  const snapshot = { ...identity, snapshotId: randomUUID(), models: [] }; worker.reply(request, snapshot);
  assert.deepEqual(await first, snapshot); worker.reply(closeRequest, undefined); worker.emit('exit', 0); await closing;
  assert.deepEqual(reasons, []);
});

test('client拒绝错dataset/epoch/重复ID/重复snapshotId/损坏DTO与超限回执，不重放', async () => {
  const id = randomUUID();
  const model: CollectionModel = { ...descriptor, id, collectorPolicy: 'normal', minimumSealedReserve: 0, revision: 1, lengths: [], counts: { total: 0, sealedBlank: 0, openedBlank: 0, legacyUsed: 0, unknown: 0, recorded: 0, reserved: 0, unavailable: 0 } };
  const wide = '\ud800'.repeat(120);
  const oversized = Array.from({ length: 2000 }, () => ({ ...model, id: randomUUID(), brand: wide, name: wide, edition: wide }));
  assert.ok(oversized.every(isCollectionModel)); assert.ok(Buffer.byteLength(JSON.stringify(oversized)) > MAX_DATASET_COLLECTION_SNAPSHOT_BYTES);
  for (const mutate of [
    (value: Record<string, unknown>) => ({ ...value, datasetId: randomUUID() }),
    (value: Record<string, unknown>) => ({ ...value, epoch: randomUUID() }),
    (value: Record<string, unknown>) => ({ ...value, models: [model, model] }),
    (value: Record<string, unknown>) => ({ ...value, models: [{ ...model, revision: 0 }] }),
    (value: Record<string, unknown>) => ({ ...value, models: Array.from({ length: 2001 }, () => model) }),
    (value: Record<string, unknown>) => ({ ...value, models: oversized }),
    (value: Record<string, unknown>) => ({ ...value, extra: true }),
  ]) {
    const { worker, endpoint, identity, reasons } = await readySynthetic();
    const pending = endpoint.exportCollectionSnapshot(), request = worker.take('exportCollectionSnapshot');
    worker.reply(request, mutate({ ...identity, snapshotId: randomUUID(), models: [] }));
    await assert.rejects(pending, error => error instanceof DatasetOwnerTransportError && error.outcome === 'unknown');
    assert.deepEqual(reasons, ['protocol-failure']); await assert.rejects(endpoint.exportCollectionSnapshot(), notSent); assert.equal(worker.requests.length, 0);
  }
  const { worker, endpoint, identity } = await readySynthetic();
  const first = endpoint.exportCollectionSnapshot(), snapshot = { ...identity, snapshotId: randomUUID(), models: [] };
  worker.reply(worker.take('exportCollectionSnapshot'), snapshot); await first;
  const second = endpoint.exportCollectionSnapshot(); worker.reply(worker.take('exportCollectionSnapshot'), snapshot);
  await assert.rejects(second, error => error instanceof DatasetOwnerTransportError && error.outcome === 'unknown');
  assert.equal(isDatasetCollectionSnapshot({ ...snapshot, models: [model, model] }), false);
  assert.equal(isDatasetCollectionSnapshot({ ...snapshot, models: new Array(1) }), false);
});

function rawRpc(port: MessagePort, epoch: string, sequence: number, operation: DatasetOwnerRequest['operation'], expectedDatasetId?: string): Promise<DatasetOwnerResponse> {
  const request: DatasetOwnerRequest = { version: 1, type: 'request', epoch, requestId: randomUUID(), sequence, operation, ...(expectedDatasetId === undefined ? {} : { expectedDatasetId }) };
  return new Promise(resolve => { const listener = (message: DatasetOwnerResponse) => { if (message.requestId !== request.requestId) return; port.off('message', listener); resolve(message); }; port.on('message', listener); port.postMessage(request); });
}
function mockDomain(datasetId: string, overrides: Partial<OwnedDatasetDomain> = {}): OwnedDatasetDomain {
  return { datasetId, async dispatch() { return {}; }, commitBoot() {}, async close(before) { await before?.(); }, failureForError: (id, error) => responseFailure(id, 'INTERNAL_ERROR', '合成领域失败。'), ...overrides };
}

test('封闭export信封只接受期望身份，worker在boot前、失败boot和旧mock缺方法时拒绝', async t => {
  const epoch = randomUUID(), datasetId = randomUUID();
  const envelope = { version: 1, type: 'request', epoch, requestId: randomUUID(), sequence: 1, operation: 'exportCollectionSnapshot', expectedDatasetId: datasetId };
  assert.equal(isDatasetOwnerRequest(envelope), true);
  for (const bad of [{ ...envelope, expectedDatasetId: undefined }, { ...envelope, path: '/合成路径' }, { ...envelope, request: {} }, { ...envelope, operation: 'close' }, { ...envelope, sql: '合成任意SQL' }]) assert.equal(isDatasetOwnerRequest(bad), false);
  for (const mode of ['before-boot', 'failed-boot', 'legacy', 'wrong-identity', 'changed-identity', 'bad-models']) {
    const ports = new MessageChannel(); t.after(() => { ports.port1.close(); ports.port2.close(); });
    let reads = 0;
    const domain = mockDomain(datasetId, { ...(mode === 'legacy' ? {} : { exportCollectionModels() { reads++; if (mode === 'changed-identity') Object.defineProperty(domain, 'datasetId', { value: randomUUID() }); return mode === 'bad-models' ? [{}] as CollectionModel[] : []; } }),
      ...(mode === 'failed-boot' ? { commitBoot() { throw new Error('合成boot失败。'); } } : {}) });
    attachDatasetOwnerWorkerPort(ports.port1, { async prepare() { return domain; } });
    assert.equal((await rawRpc(ports.port2, epoch, 1, 'prepare')).ok, true);
    let sequence = 2;
    if (mode !== 'before-boot') await rawRpc(ports.port2, epoch, sequence++, 'commitBoot');
    const rejected = await rawRpc(ports.port2, epoch, sequence++, 'exportCollectionSnapshot', mode === 'wrong-identity' ? randomUUID() : datasetId);
    assert.equal(rejected.ok, false);
    if (!rejected.ok) assert.equal(rejected.failure.error.code, mode === 'wrong-identity' ? 'OUTBOX_SCOPE_MISMATCH' : ['changed-identity', 'bad-models'].includes(mode) ? 'INVENTORY_UNAVAILABLE' : 'NOT_READY');
    assert.equal(reads, ['changed-identity', 'bad-models'].includes(mode) ? 1 : 0);
    assert.equal((await rawRpc(ports.port2, epoch, sequence, 'close')).ok, true);
  }
});

test('实际两库worker仅成功boot后导出完整快照，身份与snapshotId绑定，close自然退出', { timeout: 20_000 }, async t => {
  const dataDirectory = await directory(t), reasons: string[] = [];
  const signals = new Int32Array(new SharedArrayBuffer(12));
  const worker = new Worker(new URL('./helpers/dataset-owner-domain-fixture.ts', import.meta.url), { execArgv: ['--import', 'tsx'], workerData: { dataDirectory, signals: signals.buffer } });
  const endpoint = createDatasetOwnerClient({ worker, onFatal: reason => reasons.push(reason) });
  t.after(() => endpoint.close());
  await assert.rejects(endpoint.exportCollectionSnapshot(), notSent);
  const identity = await endpoint.prepare(); await assert.rejects(endpoint.exportCollectionSnapshot(), notSent);
  await endpoint.commitBoot();
  const command: IpcRequest = { version: 1, id: randomUUID(), command: 'collection.receive', payload: receipt(), expectedDatasetId: identity.datasetId };
  await endpoint.dispatch(command);
  const first = await endpoint.exportCollectionSnapshot(), second = await endpoint.exportCollectionSnapshot();
  assert.equal(isDatasetCollectionSnapshot(first), true); assert.equal(first.epoch, identity.epoch); assert.equal(first.datasetId, identity.datasetId);
  assert.equal(first.models.length, 1); assert.notEqual(first.snapshotId, second.snapshotId); assert.deepEqual(first.models, second.models);
  const listed = await endpoint.dispatch({ version: 1, id: randomUUID(), command: 'collection.list', payload: { page }, expectedDatasetId: identity.datasetId }) as { items: CollectionModel[] };
  assert.deepEqual(first.models, listed.items);
  const exit = once(worker, 'exit'); await endpoint.close(); assert.deepEqual(await exit, [0]);
  assert.equal(Atomics.load(signals, 2), 2); await assert.rejects(endpoint.exportCollectionSnapshot(), notSent); assert.deepEqual(reasons, []);
});
