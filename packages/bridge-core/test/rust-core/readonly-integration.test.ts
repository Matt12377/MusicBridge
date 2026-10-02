import assert from 'node:assert/strict';
import test from 'node:test';
import childProcess from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { validateIpcResponseForCommand, type CollectionModel, type IpcRequest, type Page } from '@music-bridge/contracts';
import { createDatasetOwnerClient } from '../../src/collection/dataset-owner-client.js';
import { createRustReadonlyDatasetEndpoint, freezeCollectionSnapshot, RustSidecarError } from '../../src/rust-core/readonly-sidecar.js';

const binary = { path: process.env.MUSIC_BRIDGE_RUST_BINARY ?? '', sha256: process.env.MUSIC_BRIDGE_RUST_SHA256 ?? '' };
assert.ok(path.isAbsolute(binary.path) && /^[a-f0-9]{64}$/.test(binary.sha256), '实际差分 Gate 必须提供刚构建的固定 Rust 二进制，不能条件跳过。');
function request(command: IpcRequest['command'], payload: unknown, datasetId: string): IpcRequest {
  return { version: 1, id: randomUUID(), command, payload, expectedDatasetId: datasetId };
}
function model(index: number): CollectionModel {
  return { id: randomUUID(), brand: '中文品牌 🎵', name: '型号' + index, edition: '全角Ｆ・旧版', year: null,
    format: 'cassette', tapeType: 'unknown', identification: 'partial', collectorPolicy: 'collector',
    minimumSealedReserve: 1, revision: 1, lengths: [null, 60, 90], photoCount: 0,
    counts: { total: 0, sealedBlank: 0, openedBlank: 0, legacyUsed: 0, recorded: 0, reserved: 0, unavailable: 0, unknown: 0 } };
}
test('真实Rust接收负零库存快照，JSON归一化后仍可读取并正常关闭', async () => {
  const item = model(0);
  item.minimumSealedReserve = -0;
  item.counts.total = -0;
  const snapshot = { epoch: randomUUID(), datasetId: randomUUID(), snapshotId: randomUUID(), models: [item] };
  const endpoint = createRustReadonlyDatasetEndpoint({ binary, snapshot });
  await endpoint.prepare(); await endpoint.commitBoot();
  try {
    const result = await endpoint.dispatch(request('collection.list', { page: { offset: -0, limit: 25 } }, snapshot.datasetId)) as Page<CollectionModel>;
    assert.equal(Object.is(result.items[0]!.minimumSealedReserve, 0), true);
    assert.equal(Object.is(result.items[0]!.counts.total, 0), true);
    assert.equal(Object.is(result.offset, 0), true);
  } finally { await endpoint.close(); }
});
test('实际Node两库Owner输出→Rust只读端点，公开DTO分页一致且后续库存写入不污染快照', { timeout: 30_000 }, async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'rust-core-owner-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const worker = new Worker(new URL('../helpers/dataset-owner-domain-fixture.ts', import.meta.url), {
    execArgv: ['--import', 'tsx'], workerData: { dataDirectory: directory, signals: new SharedArrayBuffer(12) },
  });
  const reasons: string[] = [], owner = createDatasetOwnerClient({ worker, onFatal: reason => reasons.push(reason) });
  t.after(() => owner.close());
  const identity = await owner.prepare(); await owner.commitBoot();
  const receive = (name: string) => owner.dispatch(request('collection.receive', {
    commandId: randomUUID(), model: { brand: '合成品牌', name, edition: '一版', year: 1990,
      format: 'cassette', tapeType: 'II', identification: 'verified' },
    lengthMinutes: 60, quantities: { sealedBlank: 1, openedBlank: 2, legacyUsed: 0, unclassified: 0 },
  }, identity.datasetId));
  await receive('甲'); await receive('乙'); await receive('丙');
  const complete = await owner.dispatch(request('collection.list', { page: { offset: 0, limit: 100 } }, identity.datasetId)) as Page<CollectionModel>;
  const snapshot = freezeCollectionSnapshot({ epoch: randomUUID(), datasetId: identity.datasetId }, complete);
  const rust = createRustReadonlyDatasetEndpoint({ binary, snapshot }); t.after(() => rust.close());
  assert.deepEqual(await rust.prepare(), { epoch: snapshot.epoch, datasetId: identity.datasetId });
  assert.equal(await rust.commitBoot(), undefined);
  for (const page of [{ offset: 0, limit: 2 }, { offset: 2, limit: 2 }, { offset: 100, limit: 1 }]) {
    const ipc = request('collection.list', { page }, identity.datasetId);
    const expected = await owner.dispatch(ipc), result = await rust.dispatch(ipc);
    assert.deepEqual(result, expected);
    assert.equal(validateIpcResponseForCommand({ version: 1, id: ipc.id, ok: true, result }, 'collection.list').ok, true);
  }
  await receive('新库存');
  const live = await owner.dispatch(request('collection.list', { page: { offset: 0, limit: 100 } }, identity.datasetId)) as Page<CollectionModel>;
  assert.equal(live.total, 4);
  const old = await rust.dispatch(request('collection.list', { page: { offset: 0, limit: 100 } }, identity.datasetId));
  assert.deepEqual(old, complete);
  await assert.rejects(rust.dispatch(request('collection.receive', {
    commandId: randomUUID(), model: { brand: '合成', name: '不能写入', edition: '一版', year: null, format: 'cassette', tapeType: 'I', identification: 'verified' },
    lengthMinutes: null, quantities: { sealedBlank: 1, openedBlank: 0, legacyUsed: 0, unclassified: 0 },
  }, identity.datasetId)), error => error instanceof RustSidecarError && error.code === 'UNSUPPORTED_COMMAND');
  assert.deepEqual(await owner.dispatch(request('collection.list', { page: { offset: 0, limit: 100 } }, identity.datasetId)), live);
  await rust.close();
  const exited = once(worker, 'exit'); await owner.close(); assert.deepEqual(await exited, [0]);
  assert.deepEqual(reasons, []);
});
test('实际Rust保持中文、非BMP、null、缺省字段和2000型号分页顺序', { timeout: 15_000 }, async t => {
  const models = Array.from({ length: 2000 }, (_value, index) => model(index));
  models[0]!.featuredPhoto = { id: randomUUID(), modelId: models[0]!.id, width: 1, height: 1, source: 'user-photo' };
  models[0]!.photoCount = 1;
  const snapshot = { epoch: randomUUID(), datasetId: randomUUID(), snapshotId: randomUUID(), models };
  const endpoint = createRustReadonlyDatasetEndpoint({ binary, snapshot }); t.after(() => endpoint.close());
  await endpoint.prepare(); await endpoint.commitBoot();
  const pages = [{ offset: 0, limit: 100 }, { offset: 99, limit: 3 }, { offset: 1999, limit: 100 }, { offset: 2000, limit: 1 }];
  await Promise.all(pages.map(async page => {
    const result = await endpoint.dispatch(request('collection.list', { page, filter: {} }, snapshot.datasetId));
    const items = models.slice(page.offset, page.offset + page.limit);
    assert.deepEqual(result, { ...page, items, total: models.length, hasMore: page.offset + items.length < models.length });
  }));
  await endpoint.close();
});
test('实际空快照成功关闭且重复生命周期调用不产生第二进程', async t => {
  const snapshot = { epoch: randomUUID(), datasetId: randomUUID(), snapshotId: randomUUID(), models: [] };
  const endpoint = createRustReadonlyDatasetEndpoint({ binary, snapshot }); t.after(() => endpoint.close());
  await Promise.all([endpoint.prepare(), endpoint.prepare()]);
  await Promise.all([endpoint.commitBoot(), endpoint.commitBoot()]);
  assert.deepEqual(await endpoint.dispatch(request('collection.list', { page: { offset: 0, limit: 1 } }, snapshot.datasetId)),
    { items: [], offset: 0, limit: 1, total: 0, hasMore: false });
  await Promise.all([endpoint.close(), endpoint.close()]);
});
test('实际Rust进程崩溃撤销端点，不能把进程消失当作正常close', async t => {
  const spawn = childProcess.spawn;
  let child: ReturnType<typeof spawn> | undefined;
  t.mock.method(childProcess, 'spawn', (...args: Parameters<typeof spawn>) => { child = spawn(...args); return child; });
  const snapshot = { epoch: randomUUID(), datasetId: randomUUID(), snapshotId: randomUUID(), models: [model(1)] };
  const reasons: string[] = [], endpoint = createRustReadonlyDatasetEndpoint({ binary, snapshot, onFatal: reason => reasons.push(reason) });
  await endpoint.prepare(); await endpoint.commitBoot();
  assert.ok(child); const exited = once(child, 'close'); child.kill('SIGKILL'); await exited;
  await assert.rejects(endpoint.dispatch(request('collection.list', { page: { offset: 0, limit: 1 } }, snapshot.datasetId)),
    error => error instanceof RustSidecarError && error.code === 'PROCESS_EXIT');
  await assert.rejects(endpoint.close(), error => error instanceof RustSidecarError && error.code === 'PROCESS_EXIT');
  assert.deepEqual(reasons, ['PROCESS_EXIT']);
});
