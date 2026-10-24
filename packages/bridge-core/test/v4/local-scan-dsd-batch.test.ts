import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createCollectionRepository } from '../../src/collection/repository.js';
import { createLocalScanCoordinator } from '../../src/collection/local-scan-coordinator.js';
import { authorizeSourceDirectory } from '../../src/recording/source-files.js';
import { createScanReadAdmission } from '../../src/library/scan-read-admission.js';
import { RUST_MEDIA_METADATA_PARSER_VERSION, type MetadataReaderPort } from '../../src/library/metadata-reader-types.js';
import type { DatasetProjectionPort, DatasetProjectionCommand, DatasetProjectionCommandPayloads, DatasetProjectionCommandResults } from '../../src/collection/dataset-owner-protocol.js';

test('V4：含 CUE 的资料库可分批保存 DSF/DFF，冷重开保留原扫描与 DSD 事实', { timeout: 30_000 }, async t => {
  const temporary = process.env.TMPDIR;
  assert.ok(temporary);
  assert.ok(temporary.startsWith('/Volumes/LifeWeave/Developer/CommandLine/tmp/'));
  const directory = await mkdtemp(path.join(temporary, 'musicbridge-dsd-batch-')), media = path.join(directory, 'media');
  await mkdir(media);
  const original = Buffer.from('合成文件仅供扫描入库合同验证');
  for (const name of ['disc.dsf', 'disc.dff', 'disc.cue']) await writeFile(path.join(media, name), original, { flag: 'wx' });
  const file = path.join(directory, 'collection.sqlite'), datasetId = randomUUID();
  let repository = createCollectionRepository({ filePath: file });
  repository.localCatalog.roots();
  const source = repository.sources.authorize(randomUUID(), await authorizeSourceDirectory(media));
  const root = repository.localCatalog.registerRoot({ commandId: randomUUID(), sourceRootId: source.id, role: 'library' });
  const gate = createScanReadAdmission({ isBusy: () => false }), context = { datasetId, epoch: randomUUID() };
  const projection: DatasetProjectionPort = {
    async call<K extends DatasetProjectionCommand>(command: K, payload: DatasetProjectionCommandPayloads[K]): Promise<DatasetProjectionCommandResults[K]> {
      let result: unknown;
      if (command === 'scanReadAcquire') result = gate.acquire(context);
      else if (command === 'scanReadWatchRevocation') result = await gate.watchRevocation(context, (payload as { permitId: string }).permitId);
      else if (command === 'scanReadRelease') result = gate.release(context, (payload as { permitId: string }).permitId);
      else throw new Error('合成扫描不调用外部服务。');
      return result as DatasetProjectionCommandResults[K];
    },
  };
  const reader: MetadataReaderPort = {
    async read(input) {
      return { status: 'ok', parserVersion: RUST_MEDIA_METADATA_PARSER_VERSION, fields: { album: '合成 DSD 专辑' },
        technical: { container: input.relative.endsWith('.dsf') ? 'DSF' : 'DFF', codec: 'DSD', lossless: true,
          sampleRateHz: 2822400, channels: 2, bitsPerSample: 1, durationSeconds: 120, evidence: 'bounded-parser-reported' },
        coverEvidence: [], readEvidence: { bytesRead: 0, readCalls: 0, maxReadBytes: 0, allocationBytes: 0, elapsedMs: 0, wholeAudioHash: false, wholeAudioDecode: false } };
    },
    async close() {},
  };
  const coordinator = createLocalScanCoordinator({ repository, datasetId, assertCurrent() {}, projection, reader,
    dsdMetadataEnabled: true, cueInputMetadataEnabled: true,
    cueReader: { async read() { return { status: 'failure', code: 'UNSUPPORTED' }; }, async close() {} } });
  t.after(async () => { await coordinator.close(); gate.close(); repository.close(); });
  const pending = coordinator.start({ commandId: randomUUID(), libraryRootId: root.id, expectedRootRevision: root.revision });
  await coordinator.privateWait(pending.jobId);
  const completed = coordinator.get(pending.jobId);
  assert.equal(completed.phase, 'completed');
  assert.deepEqual(completed.progress, { visited: '3', accepted: '2', rejected: '1' });
  await coordinator.close(); repository.close();
  repository = createCollectionRepository({ filePath: file });
  assert.deepEqual(repository.localScan.get(pending.jobId), completed);
  for (const [relative, container] of [['disc.dsf', 'DSF'], ['disc.dff', 'DFF']]) {
    const state = repository.localScan.privateCurrentFileState(root.id, relative!);
    assert.equal(state?.value.outcome, 'accepted');
    assert.equal(state?.value.readFacts?.technical.container, container);
    assert.equal(state?.value.readFacts?.technical.codec, 'DSD');
    assert.deepEqual(await readFile(path.join(media, relative!)), original);
  }
});
