import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { fstatSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { MessageChannel, Worker } from 'node:worker_threads';
import type { IpcRequest, ScanJobRecord } from '@music-bridge/contracts';
import { createDatasetOwnerClient } from '../../src/collection/dataset-owner-client.js';
import type { DatasetOwnerProjectionHandler } from '../../src/collection/dataset-owner-protocol.js';
import { openCollectionDataset } from '../../src/recording/restore-dataset-runtime.js';
import { authorizeSourceDirectory } from '../../src/recording/source-files.js';
import { DEFAULT_METADATA_READ_BUDGET } from '../../src/library/metadata-reader-types.js';
import { configureSharedRustMediaWorkerPool, getRustMediaWorkerPool, closeRustMediaWorkerPool } from '../../src/library/rust-media-worker.js';
import { createTestBridgeRuntime } from '../../src/runtime.js';

const nextTurn = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
function wav(): Buffer {
  const value = Buffer.alloc(44 + 800); value.write('RIFF'); value.writeUInt32LE(value.length - 8, 4); value.write('WAVEfmt ', 8);
  value.writeUInt32LE(16, 16); value.writeUInt16LE(1, 20); value.writeUInt16LE(2, 22); value.writeUInt32LE(48000, 24);
  value.writeUInt32LE(192000, 28); value.writeUInt16LE(4, 32); value.writeUInt16LE(16, 34); value.write('data', 36); value.writeUInt32LE(800, 40); return value;
}

test('bulk-v2 共享池：父环境默认仍两路，已有/关闭中的池不可热扩，close 必须 join 原只读回调', { timeout: 15_000 }, async t => {
  const pool = getRustMediaWorkerPool(), held = deferred(), two = deferred(), bytes = wav();
  let active = 0, entered = 0, peak = 0, closed = false;
  t.after(async () => { held.resolve(); await closeRustMediaWorkerPool(); });
  assert.throws(() => configureSharedRustMediaWorkerPool(8));
  const jobs = Array.from({ length: 8 }, () => pool.readMetadata({ size: bytes.length, budget: { ...DEFAULT_METADATA_READ_BUDGET },
    async read(offset, length) {
      active++; peak = Math.max(peak, active); if (++entered === 2) two.resolve();
      try { await held.promise; return bytes.subarray(offset, offset + length); } finally { active--; }
    },
  }));
  await two.promise; await nextTurn(); assert.equal(entered, 2); assert.equal(peak, 2);
  const closing = closeRustMediaWorkerPool().then(() => { closed = true; });
  assert.throws(() => configureSharedRustMediaWorkerPool(2), '关闭中的同容量配置也不能穿越原 flight');
  await nextTurn(); assert.equal(closed, false); assert.equal(active, 2);
  held.resolve(); const results = await Promise.all(jobs); await closing;
  assert.ok(results.every(result => result.status === 'failure' && ['CANCELLED', 'CLOSED'].includes(result.code)));
  assert.equal(active, 0); assert.equal(closed, true); assert.throws(() => configureSharedRustMediaWorkerPool(8));
});

test('bulk-v2 真实 Owner：八路 Reader/Rust/FD 同时进入，关闭等实际 quiet 与自然退出，冷恢复仍原 v2 八路', { timeout: 45_000 }, async t => {
  const temporary = process.env.TMPDIR; assert.ok(temporary && path.isAbsolute(temporary));
  if (process.platform === 'darwin') assert.ok(temporary.startsWith('/Volumes/LifeWeave/Developer/CommandLine/tmp/'));
  assert.ok((await lstat(temporary)).isDirectory());
  const directory = await mkdtemp(path.join(temporary, 'musicbridge-bulk-v2-')), media = path.join(directory, 'media'), dataDirectory = path.join(directory, 'data');
  await mkdir(media, { mode: 0o700 }); await mkdir(dataDirectory, { mode: 0o700 });
  const bytes = wav(), files = Array.from({ length: 16 }, (_value, index) => path.join(media, `${index}.wav`));
  for (const file of files) await writeFile(file, bytes, { flag: 'wx', mode: 0o600 });
  const seed = await openCollectionDataset(dataDirectory), source = seed.repository.sources.authorize(randomUUID(), await authorizeSourceDirectory(media));
  const root = seed.repository.localCatalog.registerRoot({ commandId: randomUUID(), sourceRootId: source.id, role: 'library' });
  const datasetId = seed.datasetId; await seed.commit(); seed.close();
  let originalJobId: string | undefined;
  for (let generation = 0; generation < 2; generation++) {
    const channels = new MessageChannel(), signals = new Int32Array(new SharedArrayBuffer(20)), fatal: unknown[] = [];
    const holding = new Promise<{ event: 'holding'; fds: number[] }>(resolve => channels.port1.on('message', value => { if (value?.event === 'holding') resolve(value); }));
    channels.port1.start();
    const worker = new Worker(new URL('../helpers/local-scan-bulk-v2-owner.ts', import.meta.url), { execArgv: ['--import', 'tsx'],
      workerData: { dataDirectory, sample: files[0], signals: signals.buffer, control: channels.port2 }, transferList: [channels.port2] });
    let runtime: ReturnType<typeof createTestBridgeRuntime> | undefined, releases = 0, peak = 0, finished = false;
    const projection: DatasetOwnerProjectionHandler = async (command, payload, context) => {
      const gate = runtime?.getDatasetScanReadAdmission?.(); assert.ok(gate); assert.ok(context.datasetId);
      const scope = { epoch: context.epoch, datasetId: context.datasetId };
      if (command === 'scanReadAcquire') {
        const result = gate.acquire(scope, Object.hasOwn(payload, 'purpose') ? 'local-album-display' : 'scan');
        peak = Math.max(peak, gate.resourceCounts().permits); return result as never;
      }
      if (command === 'scanReadWatchRevocation') return await gate.watchRevocation(scope, (payload as { permitId: string }).permitId) as never;
      if (command === 'scanReadRelease') {
        assert.ok(Atomics.load(signals, 1) > releases, '真实 Source FD 关闭先于本次 Core release'); releases++;
        return gate.release(scope, (payload as { permitId: string }).permitId) as never;
      }
      throw new Error('八路合成 Owner 仅准原源读取投影。');
    };
    const endpoint = createDatasetOwnerClient({ worker, projection, onFatal: reason => fatal.push(reason) });
    t.after(async () => {
      try { if (!finished) { channels.port1.postMessage('release'); if (runtime) await runtime.shutdown(); else await endpoint.close(); } }
      finally { channels.port1.close(); worker.unref(); }
    });
    const identity = await endpoint.prepare(); assert.equal(identity.datasetId, datasetId);
    runtime = createTestBridgeRuntime({ datasetOwnerEndpoint: endpoint, localScanReadProfile: 'bulk-v2' }); await runtime.start(); await endpoint.commitBoot();
    if (generation === 0) {
      const request: IpcRequest = { version: 1, id: randomUUID(), command: 'localScan.start', expectedDatasetId: datasetId,
        payload: { commandId: randomUUID(), libraryRootId: root.id, expectedRootRevision: root.revision } };
      const result = await endpoint.dispatch(request) as ScanJobRecord; originalJobId = result.jobId;
    }
    const observed = await holding; assert.equal(observed.fds.length, 8); assert.equal(peak, 8);
    assert.equal(Atomics.load(signals, 0), 8); assert.equal(Atomics.load(signals, 1), 0); assert.equal(Atomics.load(signals, 2), 8);
    for (const fd of observed.fds) assert.doesNotThrow(() => fstatSync(fd));
    const gate = runtime.getDatasetScanReadAdmission!(); gate.close();
    let closed = false; const exit = once(worker, 'exit'), closing = endpoint.close().then(() => { closed = true; });
    await nextTurn(); assert.equal(closed, false); assert.equal(gate.resourceCounts().permits, 8); assert.equal(Atomics.load(signals, 1), 0);
    channels.port1.postMessage('release'); await closing; assert.deepEqual(await exit, [0]);
    assert.equal(Atomics.load(signals, 0), Atomics.load(signals, 1)); assert.equal(Atomics.load(signals, 3), 1); assert.equal(Atomics.load(signals, 4), 0);
    assert.equal(releases, 8); assert.deepEqual(fatal, []); assert.deepEqual(gate.resourceCounts(), { permits: 0, revoked: 0, watches: 0, timers: 0, closed: true });
    await runtime.shutdown(); channels.port1.close(); finished = true;
  }
  const final = await openCollectionDataset(dataDirectory);
  try {
    assert.ok(originalJobId); assert.equal(final.repository.localScan.page(datasetId, { offset: 0, limit: 20 }).items.length, 1);
    assert.equal(final.repository.localScan.get(originalJobId).progress.visited, '0');
    const launches = final.repository.localCatalog.privateRead(db => db.prepare("SELECT request FROM local_catalog_ledger WHERE operation='local-scan-settings-v1' AND json_extract(request,'$.kind')='launch'").all());
    assert.equal(launches.length, 1); const original = JSON.parse(String(launches[0]!.request));
    assert.equal(original.schema, 2); assert.equal(original.frozen.jobId, originalJobId); assert.equal(original.frozen.readerConcurrency, 8);
  } finally { final.fail(); final.close(); }
  for (const file of files) assert.deepEqual(await readFile(file), bytes);
});
