import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createCollectionRepository } from '../../src/collection/repository.js';
import { createLocalScanCoordinator } from '../../src/collection/local-scan-coordinator.js';
import { createScanReaderTurn, scheduleScanAlbums } from '../../src/collection/local-scan-settings.js';
import { authorizeSourceDirectory } from '../../src/recording/source-files.js';
import { createScanReadAdmission } from '../../src/library/scan-read-admission.js';
import { RUST_MEDIA_METADATA_PARSER_VERSION, type MetadataReaderPort, type MetadataReadResult } from '../../src/library/metadata-reader-types.js';
import type { DatasetProjectionPort, DatasetProjectionCommand, DatasetProjectionCommandPayloads, DatasetProjectionCommandResults } from '../../src/collection/dataset-owner-protocol.js';

const nextTurn = () => new Promise<void>(resolve => setImmediate(resolve));
const metadata = (): MetadataReadResult => ({ status: 'ok', parserVersion: RUST_MEDIA_METADATA_PARSER_VERSION, fields: { album: '合成专辑' },
  technical: { container: 'WAVE', codec: 'PCM', lossless: true, sampleRateHz: 48000, channels: 2, bitsPerSample: 16, durationSeconds: 1, evidence: 'bounded-parser-reported' },
  coverEvidence: [], readEvidence: { bytesRead: 0, readCalls: 0, maxReadBytes: 0, allocationBytes: 0, elapsedMs: 0, wholeAudioHash: false, wholeAudioDecode: false } });

function admission(datasetId: string) {
  const gate = createScanReadAdmission({ isBusy: () => false }), context = { datasetId, epoch: randomUUID() };
  const port: DatasetProjectionPort = {
    async call<K extends DatasetProjectionCommand>(command: K, payload: DatasetProjectionCommandPayloads[K]): Promise<DatasetProjectionCommandResults[K]> {
      let result: unknown;
      if (command === 'scanReadAcquire') result = gate.acquire(context);
      else if (command === 'scanReadWatchRevocation') result = await gate.watchRevocation(context, (payload as { permitId: string }).permitId);
      else if (command === 'scanReadRelease') result = gate.release(context, (payload as { permitId: string }).permitId);
      else throw new Error('合成扫描夹具不调用真实服务。');
      return result as DatasetProjectionCommandResults[K];
    },
  };
  return { gate, port };
}

async function fixture(t: TestContext, options: { covers?: boolean; blockAfter?: number } = {}) {
  const temporary = process.env.TMPDIR; assert.ok(temporary && path.isAbsolute(temporary));
  if(process.platform==='darwin')assert.ok(temporary==='/Volumes/LifeWeave/Developer/CommandLine/tmp/' || temporary==='/Volumes/LifeWeave/Developer/CommandLine/tmp'
    || temporary.startsWith('/Volumes/LifeWeave/Developer/CommandLine/tmp/'));
  assert.ok((await lstat(temporary)).isDirectory());
  const directory = await mkdtemp(path.join(temporary, 'musicbridge-scan-pipeline-')), media = path.join(directory, 'media');
  await mkdir(media); await mkdir(path.join(media, 'album'));
  for (let index = 0; index < 40; index++) await writeFile(path.join(media, 'album', `${index}.wav`), Buffer.from('合成扫描占位文件'), { flag: 'wx' });
  const file = path.join(directory, 'collection.sqlite'), datasetId = randomUUID();
  let repository = createCollectionRepository({ filePath: file }); repository.localCatalog.roots();
  const source = repository.sources.authorize(randomUUID(), await authorizeSourceDirectory(media));
  const root = repository.localCatalog.registerRoot({ commandId: randomUUID(), sourceRootId: source.id, role: 'library' });
  let admitted = admission(datasetId), blocked = true, calls = 0;
  const artworkReads: boolean[] = [], readRelatives: string[] = [];
  const reader: MetadataReaderPort = { async read(input, signal) {
    calls++;
    readRelatives.push(input.relative);
    artworkReads.push(input.includeEmbeddedArtwork !== false);
    if (blocked && calls > (options.blockAfter ?? 18) && !signal?.aborted) await new Promise<void>(resolve => signal?.addEventListener('abort', () => resolve(), { once: true }));
    if (signal?.aborted) return { status: 'failure', code: 'CANCELLED', readEvidence: null };
    const value = metadata();
    if (value.status === 'ok' && options.covers && input.includeEmbeddedArtwork !== false)
      value.coverEvidence = [{ mime: 'image/png', bytes: 32, sha256: 'a'.repeat(64), evidence: 'encoded-bytes-magic-and-digest' }];
    return value;
  }, async close() {} };
  let coordinator = createLocalScanCoordinator({ repository, datasetId, assertCurrent() {}, reader, projection: admitted.port });
  t.after(async () => { await coordinator.close(); admitted.gate.close(); repository.close(); });
  async function reopen() {
    await coordinator.close(); admitted.gate.close(); repository.close();
    repository = createCollectionRepository({ filePath: file }); repository.localCatalog.roots(); admitted = admission(datasetId); blocked = false;
    coordinator = createLocalScanCoordinator({ repository, datasetId, assertCurrent() {}, reader, projection: admitted.port });
  }
  async function partial() {
    const pending = coordinator.start({ commandId: randomUUID(), libraryRootId: root.id, expectedRootRevision: root.revision });
    const deadline = performance.now() + 10_000;
    while (performance.now() < deadline) {
      if (BigInt(coordinator.get(pending.jobId).progress.visited) >= 16n) return coordinator.get(pending.jobId);
      await new Promise<void>(resolve => setTimeout(resolve, 5));
    }
    assert.fail('合成扫描没有提交首个有界前缀。');
  }
  return { media, directory, root, partial, reopen, artworkReads, readRelatives, coordinator: () => coordinator, repository: () => repository, calls: () => calls };
}

test('V4：单张大专辑可使用两个真实读取槽，完成顺序仍按发现顺序返回', async () => {
  const turn = createScanReaderTurn(2), relatives = Array.from({ length: 16 }, (_, index) => `album/${index}.wav`);
  let active = 0, peak = 0;
  const values = await scheduleScanAlbums(relatives, 12, new AbortController().signal, (relative, signal) => turn.consume(signal, async () => {
    active++; peak = Math.max(peak, active); await nextTurn(); active--; return relative;
  }));
  assert.deepEqual(values, relatives); assert.equal(peak, 2); assert.equal(turn.inspect().active, 0); turn.close();
});

test('V4：取消后真实读取未quiet前仍占槽，排队任务不取得读取许可', async () => {
  const turn = createScanReaderTurn(1), controller = new AbortController(); let release!: () => void, done = false;
  const running = turn.consume(controller.signal, () => new Promise<void>(resolve => { release = resolve; })).finally(() => { done = true; });
  const queued = turn.consume(controller.signal, async () => assert.fail('取消的排队读取不应进入消费。'));
  const rejected = assert.rejects(queued, { name: 'AbortError' }); controller.abort(); await nextTurn();
  assert.equal(done, false); assert.equal(turn.inspect().active, 1); release(); await running; await rejected;
  assert.equal(turn.inspect().active, 0); turn.close();
});

test('V4：同目录已有本轮封面证据后跳过重复提取；没有证据时保留每首候选读取', { timeout: 30_000 }, async t => {
  for (const covers of [false, true]) {
    const f = await fixture(t, { covers, blockAfter: Infinity }), started = await f.partial();
    await f.coordinator().privateWait(started.jobId); assert.equal(f.coordinator().get(started.jobId).progress.accepted, '40');
    assert.equal(f.artworkReads.length, 40);
    if (covers) { assert.ok(f.artworkReads.filter(Boolean).length <= 2); assert.ok(f.artworkReads.includes(false)); }
    else assert.ok(f.artworkReads.every(Boolean));
  }
});

test('V4：部分结果已入原目录；系统让路重开后复用发现清单及已提交或已准备事实', { timeout: 30_000 }, async t => {
  const f = await fixture(t), partial = await f.partial(), before = f.repository().localScan.privatePendingDiscovery(partial.jobId);
  assert.ok(before && before.consumed >= 16); assert.ok(BigInt(partial.progress.visited) < 40n);
  const committed = before.discovery.entries.slice(0, before.consumed);
  assert.ok(committed.every(entry => f.repository().localScan.privateCurrentFileState(f.root.id, entry.relative)?.value.outcome === 'accepted'));
  await f.coordinator().yieldForMedia(); await f.reopen();
  const restored = f.repository().localScan.privatePendingDiscovery(partial.jobId); assert.deepEqual(restored, before);
  // quiet 可留下原 prepare 收据；恢复先重核并提交该批，不应为它重新调用 Reader。
  const retained = new Set([...committed.map(entry => entry.relative), ...f.repository().localScan.privatePreparedBatches(partial.jobId).flatMap(batch => batch.items.map(item => item.relative))]);
  const expectedReads = before.discovery.entries.filter(entry => !retained.has(entry.relative)).map(entry => entry.relative);
  const calls = f.calls(); await f.coordinator().privateRecoverAvailable(); await f.coordinator().privateWait(partial.jobId);
  assert.equal(f.coordinator().get(partial.jobId).phase, 'completed');
  assert.equal(f.coordinator().get(partial.jobId).progress.accepted, '40');
  assert.equal(f.calls() - calls, expectedReads.length);
  assert.deepEqual(f.readRelatives.slice(calls).sort(), expectedReads.sort());
});

test('V4：手动pause跨重启持续保留，ONLINE恢复不会读取；显式resume继续原任务', { timeout: 30_000 }, async t => {
  const f = await fixture(t), partial = await f.partial();
  await f.coordinator().pause({ commandId: randomUUID(), jobId: partial.jobId, expectedRevision: partial.jobRevision });
  await f.reopen(); const calls = f.calls(); await f.coordinator().privateRecoverAvailable();
  assert.equal(f.calls(), calls); const paused = f.coordinator().get(partial.jobId); assert.equal(paused.phase, 'paused');
  f.coordinator().resume({ commandId: randomUUID(), jobId: paused.jobId, expectedRevision: paused.jobRevision });
  await f.coordinator().privateWait(paused.jobId); assert.equal(f.coordinator().get(paused.jobId).phase, 'completed');
});

test('V4：系统中断遇离线保留已提交事实，来源恢复ONLINE后自动继续', { timeout: 30_000 }, async t => {
  const f = await fixture(t), partial = await f.partial(); await f.coordinator().close(); await f.reopen();
  const offline = path.join(f.directory, 'media-offline'); await rename(f.media, offline);
  try { const calls = f.calls(); await f.coordinator().privateRecoverAvailable(); assert.equal(f.calls(), calls); assert.equal(f.coordinator().get(partial.jobId).phase, 'paused'); }
  finally { await rename(offline, f.media); }
  await f.coordinator().privateRecoverAvailable(); await f.coordinator().privateWait(partial.jobId);
  assert.equal(f.coordinator().get(partial.jobId).progress.accepted, '40'); assert.equal(f.coordinator().get(partial.jobId).phase, 'completed');
});
