import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, stat, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { CollectionRepository } from '../../src/collection/repository.js';
import type { ScanPreparedBatch, ScanPreparedItem } from '../../src/collection/local-scan-store.js';
import { authorizeSourceDirectory } from '../../src/recording/source-files.js';

/** 自有标准 PCM 文件＋真实扫描批次；不调用解析器，不代表音频听感或 Native codec 验收。 */
export async function seedMobileSqlWaveLibrary(collection: CollectionRepository, datasetId: string, media: string, embedded = false,
  relatives: readonly string[] = ['合成专辑/1.wav', '合成专辑/2.wav']) {
  await mkdir(media, { recursive: true, mode: 0o700 });
  const source = collection.sources.authorize(randomUUID(), await authorizeSourceDirectory(media));
  const root = collection.localCatalog.registerRoot({ commandId: randomUUID(), sourceRootId: source.id, role: 'library' });
  const samples = 480, data = Buffer.alloc(44 + samples * 4);
  data.write('RIFF', 0); data.writeUInt32LE(data.length - 8, 4); data.write('WAVEfmt ', 8);
  data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(2, 22);
  data.writeUInt32LE(48000, 24); data.writeUInt32LE(192000, 28); data.writeUInt16LE(4, 32);
  data.writeUInt16LE(16, 34); data.write('data', 36); data.writeUInt32LE(samples * 4, 40);
  const cover = embedded ? await readFile(new URL('../fixtures/mbrs012-source/owned-cover-16.jpg', import.meta.url)) : null;
  const items: ScanPreparedItem[] = [];
  for (let i = 0; i < relatives.length; i++) {
    const relative = relatives[i]!, file = path.join(media, relative);
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await writeFile(file, data, { mode: 0o600, flag: 'wx' });
    const info = await stat(file, { bigint: true });
    items.push({ relative, signature: [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(':'),
      parserVersion: 'mobile-sql-isolation-wave-v1', outcome: 'accepted', fields: { title: `合成曲目${i + 1}`, artist: '合成艺人', album: '合成专辑' },
      failureCode: null, reused: false, readFacts: {
        technical: { container: 'WAVE', codec: 'PCM', lossless: true, sampleRateHz: 48000, channels: 2, bitsPerSample: 16,
          durationSeconds: samples / 48000, evidence: 'bounded-parser-reported' }, coverEvidence: cover ? [{ mime: 'image/jpeg', bytes: cover.length, sha256: createHash('sha256').update(cover).digest('hex'), evidence: 'encoded-bytes-magic-and-digest' }] : [],
        readEvidence: { bytesRead: 44, readCalls: 1, maxReadBytes: 44, allocationBytes: 44, elapsedMs: 1, wholeAudioHash: false, wholeAudioDecode: false },
      } });
  }
  const started = collection.localScan.start({ commandId: randomUUID(), datasetId, libraryRootId: root.id,
    expectedRootRevision: root.revision, parserVersion: items[0]!.parserVersion }).job;
  const running = collection.localScan.resume({ commandId: randomUUID(), jobId: started.jobId, expectedRevision: started.jobRevision });
  const batch: ScanPreparedBatch = { batchId: randomUUID(), jobId: running.jobId, expectedJobRevision: running.jobRevision,
    checkpointBefore: running.checkpointRef, items, frontier: [], completed: true };
  collection.localScan.privatePrepareBatch({ commandId: randomUUID(), jobId: running.jobId, batch });
  const completed = collection.localScan.privateCommitBatch({ commandId: randomUUID(), jobId: running.jobId,
    batchId: batch.batchId, expectedRevision: running.jobRevision });
  assert.equal(completed.phase, 'completed');
  const trackIds = items.map(item => {
    const file = collection.localScan.privateFileState(root.id, item.relative);
    assert.ok(file?.value.trackId); return file.value.trackId;
  });
  return { trackIds, rootId: root.id, sourceId: source.id, header: new Uint8Array(data.subarray(0, 64)) };
}
