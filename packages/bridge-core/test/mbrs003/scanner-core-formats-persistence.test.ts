import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { fstatSync } from 'node:fs';
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { audioFixture, coreAudioIds, loadFreshMetadataReader, sha256 } from '../helpers/mbrs003-audio-fixtures.js';
import { authorizeSourceDirectory, readonlySourceCandidateMetadata } from '../../src/recording/source-files.js';
import { createCollectionRepository } from '../../src/collection/repository.js';
import { createLocalScanCoordinator } from '../../src/collection/local-scan-coordinator.js';
import { createScanReadAdmission } from '../../src/library/scan-read-admission.js';
import type { DatasetProjectionPort, DatasetProjectionCommand, DatasetProjectionCommandPayloads, DatasetProjectionCommandResults } from '../../src/collection/dataset-owner-protocol.js';
import type { MetadataReaderLifecycle, MetadataReaderPort, MetadataReadResult } from '../../src/library/metadata-reader-types.js';

// 缺动态4源/8JS-map声明是准备失败，不改固定workerURL，不复用旧dist。
const { createMetadataReader } = await loadFreshMetadataReader();
type Success = Extract<MetadataReadResult, { status: 'ok' }>;
type Repository = ReturnType<typeof createCollectionRepository>;
interface Session {
  repo: Repository; coordinator: ReturnType<typeof createLocalScanCoordinator>;
  admission: ReturnType<typeof createScanReadAdmission>; results: Map<string, Success>;
  events: MetadataReaderLifecycle[]; fdCloseCodes: string[]; readCalls(): number;
}
function opened(repo: Repository, datasetId: string): Session {
  const context = { datasetId, epoch: randomUUID() };
  // 外部上下文合成idle，票据/watch/release均真实生产本体，无Fake grant。
  const admission = createScanReadAdmission({ isBusy: () => false });
  const projection: DatasetProjectionPort = {
    async call<K extends DatasetProjectionCommand>(command: K, payload: DatasetProjectionCommandPayloads[K]): Promise<DatasetProjectionCommandResults[K]> {
      let result: unknown;
      if (command === 'scanReadAcquire') result = admission.acquire(context);
      else if (command === 'scanReadWatchRevocation') result = await admission.watchRevocation(context, (payload as { permitId: string }).permitId);
      else if (command === 'scanReadRelease') result = admission.release(context, (payload as { permitId: string }).permitId);
      else throw new Error('有限格式持久链不提供Roon metadata或其他projection。');
      return result as DatasetProjectionCommandResults[K];
    },
  };
  const events: MetadataReaderLifecycle[] = [], fdCloseCodes: string[] = [], results = new Map<string, Success>();
  const actual = createMetadataReader({ onLifecycle(event) {
    events.push(event);
    if (event.type === 'lease-released') {
      try { fstatSync(event.fd); fdCloseCodes.push('STILL_OPEN'); }
      catch (error) { fdCloseCodes.push((error as NodeJS.ErrnoException).code ?? 'UNKNOWN'); }
    }
  } });
  let calls = 0;
  // spy只保存真实返回；输入/signal/默认预算/异常不改，不产生伪readFacts。
  const reader: MetadataReaderPort = {
    async read(input, signal) {
      calls++; const result = await actual.read(input, signal);
      if (result.status === 'ok') {
        assert.equal(results.has(input.relative), false, '一轮不能暗中重复解析同文件');
        results.set(input.relative, structuredClone(result));
      }
      return result;
    }, close: () => actual.close(),
  };
  const coordinator = createLocalScanCoordinator({ repository: repo, datasetId,
    assertCurrent() { repo.list({ offset: 0, limit: 1 }); }, projection, reader });
  return { repo, coordinator, admission, results, events, fdCloseCodes, readCalls: () => calls };
}
async function close(s: Session): Promise<void> {
  try { await s.coordinator.close(); } finally { s.admission.close(); s.repo.close(); }
}
function quiet(s: Session, expected: number): void {
  assert.equal(s.readCalls(), expected); assert.equal(s.results.size, expected);
  for (const type of ['worker-start', 'worker-exit', 'lease-released', 'read-complete'] as const)
    assert.equal(s.events.filter(e => e.type === type).length, expected);
  assert.deepEqual(s.fdCloseCodes, Array.from({ length: expected }, () => 'EBADF'));
  for (let i = 0; i < s.events.length; i++) {
    const event = s.events[i]!; if (event.type !== 'worker-start') continue;
    const exit = s.events.findIndex((v, j) => j > i && v.type === 'worker-exit' && v.threadId === event.threadId);
    const released = s.events.findIndex((v, j) => j > exit && v.type === 'lease-released' && v.fd === event.fd);
    const done = s.events.findIndex((v, j) => j > released && v.type === 'read-complete');
    assert.equal(exit > i && released > exit && done > released, true, '实际exit→原FD EBADF→read完成');
  }
  assert.deepEqual(s.admission.resourceCounts(), { permits: 0, revoked: 0, watches: 0, timers: 0, closed: false });
}

test('MBRS003 Scanner七项完整格式矩阵：真实Reader→持久raw/technical/cover冷恢复，错扩展不合并，未变重扫零read且源SHA不变', { timeout: 60_000 }, async t => {
  const f = await audioFixture(t), ids = [...coreAudioIds, 'wrong-extension'] as const;
  assert.equal(ids.length, 7); assert.equal(f.manifest.files.length, 19);
  assert.equal(f.entry('wrong-extension').sha256, f.entry('core-flac').sha256);
  assert.equal(f.entry('wrong-extension').bytes, f.entry('core-flac').bytes);
  const media = path.join(f.directory, 'scanner-full-format-media'); await mkdir(media, { mode: 0o700 });
  const inodes = new Set<string>(), signatures = new Map<string, string>();
  for (const id of ids) {
    const entry = f.entry(id), original = await lstat(f.file(id), { bigint: true }), bytes = await f.bytes(id);
    assert.equal(bytes.length, entry.bytes); assert.equal(sha256(bytes), entry.sha256);
    assert.equal(bytes.length > 5000, true, '完整封存音频，不能用header-only或空夹具');
    const copy = path.join(media, path.basename(entry.file)); await writeFile(copy, bytes, { flag: 'wx', mode: 0o600 });
    const info = await lstat(copy, { bigint: true }), inode = `${info.dev}:${info.ino}`;
    assert.equal(info.isFile() && !info.isSymbolicLink(), true); assert.equal(info.nlink, 1n);
    assert.equal(Number(info.mode & 0o777n), 0o600); assert.notEqual(inode, `${original.dev}:${original.ino}`);
    assert.equal(inodes.has(inode), false); inodes.add(inode);
  }
  const file = path.join(f.directory, 'scanner-seven-formats.sqlite'), datasetId = randomUUID();
  let active: Session | undefined;
  t.after(async () => { if (active) { const s = active; active = undefined; await close(s); } });
  const repo = createCollectionRepository({ filePath: file });
  active = opened(repo, datasetId); const first = active;
  const source = repo.sources.authorize(randomUUID(), await authorizeSourceDirectory(media));
  const root = repo.localCatalog.registerRoot({ commandId: randomUUID(), sourceRootId: source.id, role: 'library' });
  const currentSource = () => {
    assert.ok(active); const capability = active.repo.sources.root(source.id);
    assert.ok(capability); assert.equal(capability.authorized, true); return capability;
  };
  for (const id of ids) {
    const relative = path.basename(f.entry(id).file);
    signatures.set(relative, (await readonlySourceCandidateMetadata(currentSource(), relative)).signature);
  }
  const unchanged = async () => {
    for (const id of ids) {
      const entry = f.entry(id), relative = path.basename(entry.file), bytes = await readFile(path.join(media, relative));
      assert.equal(bytes.length, entry.bytes); assert.equal(sha256(bytes), entry.sha256);
      assert.equal((await readonlySourceCandidateMetadata(currentSource(), relative)).signature, signatures.get(relative));
    }
    await f.assertUnchanged();
  };
  const original = first.coordinator.start({ commandId: randomUUID(), libraryRootId: root.id, expectedRootRevision: root.revision });
  assert.equal(original.phase, 'pending'); await first.coordinator.privateWait(original.jobId);
  const completed = first.coordinator.get(original.jobId);
  assert.equal(completed.phase, 'completed'); assert.deepEqual(completed.progress, { visited: '7', accepted: '7', rejected: '0' });
  quiet(first, 7);
  const containers = ['FLAC', 'MPEG', 'MP4', 'MP4', 'WAVE', 'AIFF', 'FLAC'] as const;
  const saved = new Map<string, {
    state: NonNullable<ReturnType<Repository['localScan']['privateFileState']>>['value'];
    metadata: ReturnType<Repository['localCatalog']['metadata']>;
    asset: ReturnType<Repository['localCatalog']['asset']>; track: ReturnType<Repository['localCatalog']['track']>;
    observations: ReturnType<Repository['localCatalog']['observations']>;
  }>();
  for (const [index, id] of ids.entries()) {
    const entry = f.entry(id), relative = path.basename(entry.file), result = first.results.get(relative);
    assert.ok(result); assert.ok(entry.expectedTags); assert.ok(entry.observedAudio);
    assert.deepEqual(result.fields, entry.expectedTags); assert.equal(result.technical.container, containers[index]);
    // 不把ffprobe manifest词汇猜成music-metadata codec；真实返回值下方完整持久比较。
    assert.equal(typeof result.technical.codec, 'string'); assert.equal(result.technical.codec.length > 0, true);
    assert.equal(result.technical.sampleRateHz, entry.observedAudio.sampleRate); assert.equal(result.technical.channels, entry.observedAudio.channels);
    assert.equal(result.technical.lossless, !['core-mp3', 'core-m4a-aac'].includes(id));
    assert.equal(result.technical.evidence, 'bounded-parser-reported');
    assert.equal(result.technical.durationSeconds !== null && result.technical.durationSeconds >= 0.3 && result.technical.durationSeconds <= 0.55, true);
    assert.equal(result.readEvidence.bytesRead > 0 && result.readEvidence.bytesRead <= 32 * 1024 * 1024 && result.readEvidence.readCalls > 0, true);
    assert.equal(result.readEvidence.wholeAudioHash, false); assert.equal(result.readEvidence.wholeAudioDecode, false);
    const cover = id === 'wrong-extension' ? f.entry('core-flac').expectedCover : entry.expectedCover;
    assert.deepEqual(result.coverEvidence, cover ? [{ mime: cover.mime, bytes: cover.bytes, sha256: cover.sha256, evidence: 'encoded-bytes-magic-and-digest' }] : []);
    const state = repo.localScan.privateFileState(root.id, relative); assert.ok(state);
    assert.equal(state.value.outcome, 'accepted'); assert.equal(state.value.failureCode, null); assert.equal(state.value.relative, relative);
    assert.equal(state.value.signature, signatures.get(relative)); assert.equal(state.value.parserVersion, result.parserVersion);
    assert.ok(state.value.trackId); assert.ok(state.value.assetId);
    assert.deepEqual(state.value.readFacts, { technical: result.technical, coverEvidence: result.coverEvidence, readEvidence: result.readEvidence });
    const metadata = repo.localCatalog.metadata(state.value.trackId);
    assert.deepEqual(metadata, { raw: entry.expectedTags, override: null, effective: entry.expectedTags });
    const observations = repo.localCatalog.observations(state.value.trackId);
    assert.equal(observations.length, 1); assert.equal(observations[0]!.source, 'tag'); assert.deepEqual(observations[0]!.fields, entry.expectedTags);
    const asset = repo.localCatalog.asset(state.value.assetId), track = repo.localCatalog.track(state.value.trackId);
    assert.equal(asset.sourceRootId, source.id); assert.equal(asset.libraryRootId, root.id);
    assert.equal(asset.sampleFrames, null); assert.equal(asset.timebaseHz, null); assert.equal(track.segment, null);
    saved.set(id, { state: structuredClone(state.value), metadata, asset, track, observations });
  }
  assert.equal(new Set([...saved.values()].map(v => v.asset.id)).size, 7);
  assert.equal(new Set([...saved.values()].map(v => v.track.id)).size, 7, '同字节FLAC不同locator不能自动合并');
  const tracks = repo.localCatalog.pageTracks({ offset: 0, limit: 200 }); assert.equal(tracks.total, 7); assert.equal(tracks.items.length, 7);
  await unchanged(); await close(first); active = undefined;
  assert.equal(first.admission.resourceCounts().closed, true);
  const coldRepo = createCollectionRepository({ filePath: file }); active = opened(coldRepo, datasetId); const cold = active;
  assert.deepEqual(cold.repo.localCatalog.root(root.id), root); assert.deepEqual(cold.coordinator.get(original.jobId), completed);
  assert.deepEqual(cold.repo.localCatalog.pageTracks({ offset: 0, limit: 200 }), tracks);
  const assertSaved = () => {
    for (const id of ids) {
      const before = saved.get(id)!; assert.ok(before);
      const state = cold.repo.localScan.privateFileState(root.id, path.basename(f.entry(id).file)); assert.ok(state);
      assert.deepEqual(state.value, before.state, '持久技术/封面/read统计与ID完整冷恢复、增量复用');
      assert.deepEqual(cold.repo.localCatalog.asset(before.asset.id), before.asset); assert.deepEqual(cold.repo.localCatalog.track(before.track.id), before.track);
      assert.deepEqual(cold.repo.localCatalog.metadata(before.track.id), before.metadata);
      assert.deepEqual(cold.repo.localCatalog.observations(before.track.id), before.observations, '未变重扫不追加raw observation');
    }
  };
  assertSaved(); quiet(cold, 0); await unchanged();
  const again = cold.coordinator.start({ commandId: randomUUID(), libraryRootId: root.id, expectedRootRevision: root.revision });
  await cold.coordinator.privateWait(again.jobId); assert.equal(cold.coordinator.get(again.jobId).phase, 'completed');
  assert.deepEqual(cold.coordinator.get(again.jobId).progress, { visited: '7', accepted: '7', rejected: '0' });
  quiet(cold, 0); assertSaved(); assert.deepEqual(cold.repo.localCatalog.pageTracks({ offset: 0, limit: 200 }), tracks);
  await unchanged(); await close(cold); active = undefined;
});
