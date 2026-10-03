import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type test from 'node:test';
import { Worker } from 'node:worker_threads';
import type { CollectionModel, IpcRequest, Page, CollectionFilter } from '@music-bridge/contracts';
import { isCollectionModel } from '@music-bridge/contracts';
import type { RustReadonlySnapshot, RustSidecarObservation, RustReadonlyCostObservation } from '../../src/rust-core/readonly-sidecar.js';
import { createDatasetOwnerClient } from '../../src/collection/dataset-owner-client.js';
import { createOptionalRustReadonlyManager } from '../../src/rust-core/optional-readonly-manager.js';
import type { RustReadonlyCollectionRouterOptions } from '../../src/rust-core/readonly-router.js';
import { seedRustCollection } from './rust-core-collection-fixture.js';

const uuid = (index: number) => `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`;
/** 合法最大字段作为字节载体；不靠超长字段或损坏 UTF8 凑预算。 */
export function exactScaleSnapshot(bytes: number, count = 2_000): RustReadonlySnapshot {
  const models: CollectionModel[] = Array.from({ length: count }, (_, index) => ({
    id: uuid(index + 1), brand: '界'.repeat(120), name: '界'.repeat(120), edition: '界'.repeat(120),
    year: 2200, format: 'cassette', tapeType: 'unknown', identification: 'unidentified',
    collectorPolicy: 'preserve-sealed', minimumSealedReserve: 1_000_000, revision: 1_000_000,
    lengths: Array<number>(100).fill(360),
    counts: { total: 1_000_000, sealedBlank: 100_000, openedBlank: 100_000, legacyUsed: 100_000,
      recorded: 100_000, reserved: 100_000, unavailable: 100_000, unknown: 400_000 },
    photoCount: 24, featuredPhoto: { id: uuid(index + count + 1), modelId: uuid(index + 1),
      physicalId: 'MB-C-999999999', width: 1200, height: 1200, source: 'user-photo' },
  }));
  const snapshot: RustReadonlySnapshot = { epoch: randomUUID(), datasetId: randomUUID(), snapshotId: randomUUID(), models };
  let reduce = Buffer.byteLength(JSON.stringify(snapshot), 'utf8') - bytes;
  assert.ok(reduce >= 0, '指定字节数超出合法 DTO 载体。');
  for (const field of ['edition', 'name', 'brand'] as const) for (const model of models) {
    if (!reduce) break;
    const removed = Math.min(reduce, 360), remaining = 360 - removed;
    model[field] = remaining >= 358 ? '界'.repeat(119) + (remaining === 359 ? 'é' : remaining === 358 ? 'x' : '界')
      : '界'.repeat(Math.floor(remaining / 3)) + 'x'.repeat(remaining % 3);
    reduce -= removed;
  }
  assert.equal(reduce, 0);
  assert.equal(Buffer.byteLength(JSON.stringify(snapshot), 'utf8'), bytes);
  assert.ok(models.every(isCollectionModel));
  return snapshot;
}

export function scalePrepareFrame(snapshot: RustReadonlySnapshot, protocolVersion = 2): Buffer {
  return Buffer.from(JSON.stringify({ protocolVersion, requestId: uuid(0), epoch: snapshot.epoch,
    datasetId: snapshot.datasetId, snapshotId: snapshot.snapshotId, sequence: 1, operation: 'prepare',
    payload: protocolVersion === 3 ? { modelCount: snapshot.models.length } : { models: snapshot.models } }) + '\n');
}

export function exactScalePrepareFrame(bytesWithoutLF: number): RustReadonlySnapshot {
  const probe = exactScaleSnapshot(4_194_304);
  const overhead = scalePrepareFrame(probe).length - 1 - Buffer.byteLength(JSON.stringify(probe));
  const snapshot = exactScaleSnapshot(bytesWithoutLF - overhead);
  assert.equal(scalePrepareFrame(snapshot).length - 1, bytesWithoutLF);
  return snapshot;
}

export const scaleRequest = (command: IpcRequest['command'], payload: unknown, datasetId: string): IpcRequest =>
  ({ version: 1, id: randomUUID(), command, payload, expectedDatasetId: datasetId });
export const scaleList = (datasetId: string, offset = 0, filter: CollectionFilter = {}) =>
  scaleRequest('collection.list', { page: { offset, limit: 100 }, filter }, datasetId);
export async function scaleUntil(check: () => boolean): Promise<void> {
  const deadline = performance.now() + 5_000;
  while (!check()) { if (performance.now() >= deadline) throw new Error('实际规模生命周期未收口。'); await new Promise<void>(resolve => setImmediate(resolve)); }
}

/** 原 Node Worker/原库作者；只有普通 ON 才调用实际固定包资源 factory。 */
export async function createScaleOwner(t: test.TestContext, amount: number, options: {
  directory?: string; trustedLarge?: boolean; killDispatch?: boolean;
  onCostObservation?: (value: RustReadonlyCostObservation) => void;
} = {}) {
  const external = '/Volumes/LifeWeave/Developer/CommandLine/tmp';
  assert.ok(os.tmpdir() === external || os.tmpdir().startsWith(external + path.sep));
  assert.notEqual((await stat('/Volumes/LifeWeave')).dev, (await stat('/')).dev);
  const directory = options.directory ?? await mkdtemp(path.join(os.tmpdir(), 'rust015-scale-'));
  const worker = new Worker(new URL('./dataset-owner-version-fixture.ts', import.meta.url), {
    execArgv: ['--import', new URL('../../node_modules/tsx/dist/loader.mjs', import.meta.url).pathname], workerData: { dataDirectory: directory },
  });
  let nodeExit: number | undefined;
  worker.once('exit', code => { nodeExit = code; });
  const fatals: string[] = [], source = createDatasetOwnerClient({ worker, onFatal: code => fatals.push(code) });
  const observations: RustSidecarObservation[] = [], costs: RustReadonlyCostObservation[] = [];
  const calls = { prepare: 0, boot: 0, close: 0, probe: 0, export: 0, dispatch: 0, factory: 0, resource: 0 };
  let held: Promise<void> | undefined, release: (() => void) | undefined, exportEntered = false, killed = false;
  const observed = { ...source,
    prepare() { calls.prepare++; return source.prepare(); },
    commitBoot() { calls.boot++; return source.commitBoot(); },
    close() { calls.close++; return source.close(); },
    getCollectionSnapshotVersion() { calls.probe++; return source.getCollectionSnapshotVersion(); },
    async exportVersionedCollectionSnapshot() { calls.export++; if (held) { const waiting = held; held = undefined; exportEntered = true; await waiting; } return source.exportVersionedCollectionSnapshot(); },
    exportLargeVersionedCollectionSnapshot() { calls.export++; return source.exportLargeVersionedCollectionSnapshot(); },
    dispatch(input: IpcRequest) { calls.dispatch++; return source.dispatch(input); },
  };
  const onObservation = (value: RustSidecarObservation) => {
    observations.push(value);
    if (options.killDispatch && !killed && value.event === 'request' && value.frame.operation === 'dispatch' && value.pid) { killed = true; process.kill(value.pid, 'SIGKILL'); }
  };
  const manager = createOptionalRustReadonlyManager({
    onCostObservation: value => { costs.push(value); options.onCostObservation?.(value); },
    createOptions: async () => {
      calls.factory++;
      if (options.trustedLarge) return { binary: { path: process.env.MUSIC_BRIDGE_RUST_BINARY ?? '', sha256: process.env.MUSIC_BRIDGE_RUST_SHA256 ?? '' }, snapshotProfile: 'v3-5000' as const, onObservation };
      // 运行原 factory，不复制其资源准入实现；进程资源路径只是本测试可信 fixture 的输入。
      const moduleUrl = new URL('../../../../apps/desktop/src/main/packaged-rust-core-bootstrap.ts', import.meta.url);
      const module = await import(moduleUrl.href) as { createPackagedRustReadonlyFactory(pin: string, hooks: { onObservation: typeof onObservation; onResourceValidated(): void }): () => Promise<Omit<RustReadonlyCollectionRouterOptions, 'owner'>> };
      const previous = Object.getOwnPropertyDescriptor(process, 'resourcesPath');
      Object.defineProperty(process, 'resourcesPath', { value: new URL('../../../../apps/desktop/native', import.meta.url).pathname, configurable: true });
      try {
        const configuration = await module.createPackagedRustReadonlyFactory('6e5b637343482ca91a6ab47aa7cc2666243475c27f2da6ef98cbe330ac1de61f', { onObservation, onResourceValidated() { calls.resource++; } })();
        assert.equal(configuration.snapshotProfile, 'v2-2000'); return configuration;
      } finally { if (previous) Object.defineProperty(process, 'resourcesPath', previous); else Reflect.deleteProperty(process, 'resourcesPath'); }
    },
  });
  const endpoint = manager.decorate(observed), identity = await endpoint.prepare(); await endpoint.commitBoot();
  const database = path.join(directory, 'collection.v1.sqlite');
  if (!options.directory && amount) seedRustCollection(database, amount);
  async function close() { const work = endpoint.close(); await work; await scaleUntil(() => nodeExit !== undefined); assert.equal(nodeExit, 0); assert.deepEqual(fatals, []); }
  t.after(async () => { await endpoint.close().catch(() => {}); await scaleUntil(() => nodeExit !== undefined); });
  return { manager, endpoint, source, calls, costs, observations, identity, database, directory, close,
    get nodeExit() { return nodeExit; },
    holdNextExport() { held = new Promise<void>(resolve => { release = resolve; }); exportEntered = false; },
    releaseExport() { release?.(); }, get exportEntered() { return exportEntered; },
    async complete() { const items: CollectionModel[] = []; for (let offset = 0;; offset += 100) { const page = await endpoint.dispatch(scaleList(identity.datasetId, offset)) as Page<CollectionModel>; items.push(...page.items); if (!page.hasMore) return { items, total: page.total }; } },
  };
}
