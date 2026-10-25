import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { parentPort, workerData, Worker, MessageChannel, type MessagePort, type WorkerOptions } from 'node:worker_threads';
import { attachDatasetOwnerWorkerPort } from '../../src/collection/dataset-owner-worker.js';
import { prepareOwnedDatasetDomain, type OwnedDatasetDomainOptions } from '../../src/collection/dataset-domain.js';
import { authorizeSourceDirectory } from '../../src/recording/source-files.js';
import { installMobileSqlQueryGate } from './mobile-sql-query-gate.js';
import { seedMobileSqlWaveLibrary } from './mobile-sql-owned-wave-library.js';
import { readLibraryOperationLine } from '../../src/shared/library-operation-log.js';
import { createDatasetOwnerReadRevocation } from '../../src/collection/dataset-owner-read-revocation.js';

if (!parentPort) throw new Error('合成 Owner 缺少父端口。');
const control = workerData.control as MessagePort;
const gate = workerData.gate as SharedArrayBuffer;
installMobileSqlQueryGate(gate, control, 5);
let sourceTargetTrack: string | null = null;
if (workerData.ownerSourceGate) installMobileSqlQueryGate(workerData.ownerSourceGate,
  { postMessage: value => control.postMessage({ ...value, type: 'owner.sql.entered' }) }, 5,
  (name, values) => name === 'mb_album_source_ordinal' && sourceTargetTrack !== null && values[0] !== sourceTargetTrack);
let fallbackCalls = 0, logTail = '';
const originalWrite = process.stdout.write;
process.stdout.write = ((chunk: unknown, ...args: unknown[]) => {
  logTail += typeof chunk === 'string' ? chunk : Buffer.isBuffer(chunk) ? chunk.toString('utf8') : '';
  const lines = logTail.split('\n'); logTail = lines.pop() ?? '';
  if (logTail.length > 4096) logTail = '';
  for (const line of lines) {
    const record = readLibraryOperationLine(line);
    if (record?.action === 'startup.mobile-prepare') control.postMessage({ type: `warm.${record.state}` });
    if (record?.state === 'complete' && record.code === 'FULL_FALLBACK' && ['albums.mobile-groups', 'albums.mobile-members'].includes(record.action)) fallbackCalls++;
  }
  return Reflect.apply(originalWrite, process.stdout, [chunk, ...args]);
}) as typeof process.stdout.write;

attachDatasetOwnerWorkerPort(parentPort, {
  async prepare(epoch, projection, _sourceActor, reportFatal) {
    // 此私有工厂接缝仅用于让未来隔离 SQL Worker 运行同一闸门；父版本忽略新增选项。
    let liveSqlWorkers = 0, activeSqlJobs = 0, liveCatalogs = 0, oracleBusy = false;
    const options: OwnedDatasetDomainOptions & { mobileSqlWorkerFactory: (options: WorkerOptions) => Worker } = {
      dataDirectory: workerData.dataDirectory, epoch, testMode: true, projection,
      ...(workerData.backgroundWarm ? { onBackgroundFatal() { control.postMessage({ type: 'owner.background.fatal' }); reportFatal(); } } : {}),
      assertAlbumReadActive: createDatasetOwnerReadRevocation(workerData.readRevocation).assertActive,
      mobileSqlWorkerFactory(options) {
        const channel = new MessageChannel();
        channel.port1.on('message', value => control.postMessage(value));
        const worker = new Worker(new URL('./mobile-sql-compute-gated-fixture.ts', import.meta.url), {
          ...options,
          stdout: true,
          workerData: { ...options.workerData, testSqlGate: gate, testSqlGatePort: channel.port2,
            ...(workerData.auditPause ? { testAuditPause: workerData.auditPause } : {}),
            ...(workerData.startupSqlFault ? { testStartupSqlFault: workerData.startupSqlFault } : {}) },
          transferList: [...options.transferList ?? [], channel.port2],
        });
        // 子Worker的原始指标仍完整转发，但不混入Owner自身的完整回退计数。
        worker.stdout!.on('data', chunk => Reflect.apply(originalWrite, process.stdout, [chunk]));
        liveSqlWorkers++; control.postMessage({ type: 'sql.worker.created' });
        worker.on('message', value => { if (value?.type === 'stage') {
          if (value.stage === 'begun') activeSqlJobs++;
          if (value.stage === 'rollback') activeSqlJobs--;
          control.postMessage({ type: `sql.stage.${value.stage}`, atMs: performance.now() });
        } });
        worker.on('exit', code => { liveSqlWorkers--; channel.port1.close(); control.postMessage({ type: 'sql.worker.exit', code }); });
        return worker;
      },
    };
    const domain = await prepareOwnedDatasetDomain(options);
    assert.ok(domain.localAlbums, '真实域必须提供目录作者。');
    assert.ok(domain.mobileMain, '真实域必须提供移动入口。');
    const localAlbums = domain.localAlbums, mobileMain = domain.mobileMain.bind(domain);
    const media = path.join(workerData.dataDirectory, '合成来源');
    await mkdir(media, { mode: 0o700 });
    const complete = workerData.completeLibrary === true ? await seedMobileSqlWaveLibrary(domain.collection, domain.datasetId, media) : null;
    if (workerData.seedContentEdition) {
      assert.ok(complete);
      const edition = domain.collection.localCatalog.createEdition({ commandId: randomUUID(), title: '合成最近添加专辑', edition: '受控发行' });
      for (const [index, trackId] of complete.trackIds.entries()) domain.collection.localCatalog.linkEditionTrack({
        commandId: randomUUID(), editionId: edition.id, trackId, disc: 1, trackNumber: index + 1, sequence: index + 1 });
    }
    let trackId: string;
    if (complete) trackId = complete.trackIds[0]!;
    else {
    const source = domain.collection.sources.authorize(randomUUID(), await authorizeSourceDirectory(media));
    const root = domain.collection.localCatalog.registerRoot({ commandId: randomUUID(), sourceRootId: source.id, role: 'library' });
    const asset = domain.collection.localCatalog.registerAsset({ commandId: randomUUID(), libraryRootId: root.id,
      expectedRootRevision: root.revision, relative: '合成专辑/01.flac', sha256: null, sampleFrames: null, timebaseHz: null });
    const track = domain.collection.localCatalog.createTrack({ commandId: randomUUID(), assetId: asset.id, segment: null });
    domain.collection.localCatalog.observeMetadata({ commandId: randomUUID(), trackId: track.id, source: 'synthetic',
      parserVersion: 'mobile-sql-isolation-v1', fields: { title: '合成曲目', artist: '合成艺人', album: '合成专辑' } });
    trackId = track.id;
    }
    const originalCurrent = localAlbums.privateMobile.current;
    let currentCalls = 0;
    const queueId = randomUUID(); let queueRevision = 0;
    localAlbums.privateMobile.current = (...args) => { currentCalls++; return originalCurrent(...args); };
    control.on('message', async value => {
      if (value?.type === 'queue.change') {
        domain.saveMBQueue!({ expectedRevision: String(queueRevision), queue: { schemaVersion: '1.2', datasetId: domain.datasetId,
          queueId, revision: String(++queueRevision), currentEntryId: null, restartPolicy: { reResolve: true, autoplay: false }, entries: [] } });
        control.postMessage({ type: `control.reply.${value.sequence}`, changed: true }); return;
      }
      if (value?.type === 'source.target') {
        sourceTargetTrack = value.trackId;
        control.postMessage({ type: `control.reply.${value.sequence}`, configured: true }); return;
      }
      if (value?.type === 'catalog.parent') {
        const original = Object.getOwnPropertyDescriptor(localAlbums.privateMobile, 'structure');
        let result: unknown;
        try {
          assert.ok(liveSqlWorkers <= 1); assert.equal(activeSqlJobs, 0); assert.equal(liveCatalogs, 0); assert.equal(oracleBusy, false);
          assert.equal(Atomics.load(new Int32Array(gate), 0), 0, '父行为基线禁止在闸门已arm时改接缝。');
          oracleBusy = true;
          delete localAlbums.privateMobile.structure;
          result = await mobileMain({ kind: 'catalog', datasetId: domain.datasetId, request: value.request });
        } catch (error) {
          result = { fixtureFailure: true, name: error instanceof Error ? error.name : 'Unknown' };
        } finally {
          if (original) Object.defineProperty(localAlbums.privateMobile, 'structure', original);
          else delete localAlbums.privateMobile.structure;
          oracleBusy = false;
        }
        control.postMessage({ type: `control.reply.${value.sequence}`, result }); return;
      }
      if (value?.type === 'source.revoke' && complete) {
        domain.collection.sources.revoke({ commandId: randomUUID(), id: complete.sourceId });
        control.postMessage({ type: `control.reply.${value.sequence}`, revoked: true }); return;
      }
      if (value?.type === 'current.count') {
        control.postMessage({ type: `control.reply.${value.sequence}`, count: currentCalls, udfCalls: Atomics.load(new Int32Array(gate), 5), fallbackCalls });
        currentCalls = 0; fallbackCalls = 0; Atomics.store(new Int32Array(gate), 5, 0); return;
      }
      if (value?.type !== 'metadata.change') return;
      domain.collection.localCatalog.observeMetadata({ commandId: randomUUID(), trackId, source: 'synthetic',
        parserVersion: 'mobile-sql-isolation-v2', fields: { title: '已改变曲目', artist: '已改变艺人', album: '已改变专辑' } });
      control.postMessage({ type: 'metadata.changed' });
      if (value.sequence) control.postMessage({ type: `control.reply.${value.sequence}`, changed: true });
    });
    return {
      ...domain,
      async mobileMain(input: Parameters<typeof mobileMain>[0]) {
        if (input.kind === 'catalog') { assert.equal(oracleBusy, false); liveCatalogs++; }
        try { return await mobileMain(input); }
        finally { if (input.kind === 'catalog') liveCatalogs--; }
      },
      async close(beforeConnectionClose) {
        control.postMessage({ type: 'owner.close.entered' });
        await domain.close(beforeConnectionClose);
        assert.equal(Atomics.load(new Int32Array(gate), 4), 0, '真实关闭不能借闸门自身超时完成。');
        control.postMessage({ type: 'owner.close.completed' });
        control.close();
      },
    };
  },
});
