import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { fstatSync, type Stats } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { MetadataReaderLifecycle, MetadataReaderPort, MetadataReadResult } from '../src/library/metadata-reader-types.js';
import type { ScanPreparedBatch } from '../src/collection/local-scan-store.js';
import type { DatasetProjectionPort, DatasetProjectionCommand, DatasetProjectionCommandPayloads,
  DatasetProjectionCommandResults } from '../src/collection/dataset-owner-protocol.js';
import { loadFreshMetadataReader } from './helpers/mbrs003-audio-fixtures.js';

// 只生成自有合成媒体；不读取普通 App 曲库、不改标签、不把有限兼容证明当作整曲可播放验收。
const OLD_PARSER = 'music-metadata-11.15.0/mbrs003-v1';
const NEW_PARSER = 'music-metadata-11.15.0/mbrs003-v2';
const frames = 4800, sampleRate = 48000, channels = 2, bits = 24, blockAlign = channels * bits / 8;
const expectedTags = Object.freeze({ title: '合成 ID3 标题', artist: '合成 ID3 艺人', album: '合成 INFO 专辑' });
const ordinaryTags = Object.freeze({ title: '合成普通 INFO 标题', artist: '合成普通 INFO 艺人', album: '合成普通 INFO 专辑' });
const hash = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

function chunk(id: string, payload: Buffer, declaredBytes = payload.length): Buffer {
  assert.equal(Buffer.byteLength(id, 'ascii'), 4);
  const header = Buffer.alloc(8); header.write(id, 0, 'ascii'); header.writeUInt32LE(declaredBytes, 4);
  return Buffer.concat([header, payload, ...(payload.length % 2 ? [Buffer.alloc(1)] : [])]);
}
function riff(chunks: readonly Buffer[]): Buffer {
  const body = Buffer.concat([Buffer.from('WAVE', 'ascii'), ...chunks]), header = Buffer.alloc(8);
  header.write('RIFF', 0, 'ascii'); header.writeUInt32LE(body.length, 4); return Buffer.concat([header, body]);
}
function format(extensible: boolean): Buffer {
  const bytes = Buffer.alloc(extensible ? 40 : 16);
  bytes.writeUInt16LE(extensible ? 0xfffe : 1, 0); bytes.writeUInt16LE(channels, 2);
  bytes.writeUInt32LE(sampleRate, 4); bytes.writeUInt32LE(sampleRate * blockAlign, 8);
  bytes.writeUInt16LE(blockAlign, 12); bytes.writeUInt16LE(bits, 14);
  if (extensible) {
    bytes.writeUInt16LE(22, 16); bytes.writeUInt16LE(bits, 18); bytes.writeUInt32LE(3, 20);
    Buffer.from('0100000000001000800000aa00389b71', 'hex').copy(bytes, 24);
  }
  return chunk('fmt ', bytes);
}
function syncsafe(value: number): Buffer {
  assert.equal(Number.isSafeInteger(value) && value >= 0 && value < 0x10000000, true);
  return Buffer.from([(value >>> 21) & 0x7f, (value >>> 14) & 0x7f, (value >>> 7) & 0x7f, value & 0x7f]);
}
function id3Frame(id: string, text: string): Buffer {
  const payload = Buffer.concat([Buffer.from([3]), Buffer.from(text, 'utf8')]);
  return Buffer.concat([Buffer.from(id, 'ascii'), syncsafe(payload.length), Buffer.alloc(2), payload]);
}
function id3(): Buffer {
  const body = Buffer.concat([id3Frame('TIT2', expectedTags.title), id3Frame('TPE1', expectedTags.artist)]);
  const tag = Buffer.concat([Buffer.from('ID3', 'ascii'), Buffer.from([4, 0, 0]), syncsafe(body.length), body]);
  return chunk('ID3 ', tag);
}
function info(tags: Readonly<Record<string, string>>): Buffer {
  return chunk('LIST', Buffer.concat([Buffer.from('INFO', 'ascii'), ...Object.entries(tags).map(([id, value]) =>
    chunk(id, Buffer.concat([Buffer.from(value, 'utf8'), Buffer.from([0])])))]));
}
const pcm = Buffer.alloc(frames * blockAlign);
function taggedWave(emptyLists: number): Buffer {
  const fact = Buffer.alloc(4); fact.writeUInt32LE(frames);
  // 真实拒绝样本的形状：extensible fmt/data/fact/空 LIST/ID3/普通 INFO。
  // 保留现有 Parser 报告的 codec/lossless，不顺便扩大 PCM 或播放资格。
  return riff([format(true), chunk('data', pcm), chunk('fact', fact),
    ...(emptyLists > 0 ? [chunk('LIST', Buffer.alloc(0))] : []), id3(),
    ...(emptyLists > 1 ? [chunk('LIST', Buffer.alloc(0))] : []), info({ IPRD: expectedTags.album })]);
}
function ordinaryWave(): Buffer {
  return riff([format(false), chunk('data', pcm), info({ INAM: ordinaryTags.title, IART: ordinaryTags.artist, IPRD: ordinaryTags.album })]);
}

async function modules() {
  const reader = await loadFreshMetadataReader();
  // 能力品牌与物理锁只使用同一次 fresh dist；不把 src/dist 两个实例拼成真资源闭环。
  const files = await import(new URL('../dist/recording/source-files.js', import.meta.url).href) as typeof import('../src/recording/source-files.js');
  const repository = await import(new URL('../dist/collection/repository.js', import.meta.url).href) as typeof import('../src/collection/repository.js');
  const scanner = await import(new URL('../dist/collection/local-scan-coordinator.js', import.meta.url).href) as typeof import('../src/collection/local-scan-coordinator.js');
  const admission = await import(new URL('../dist/library/scan-read-admission.js', import.meta.url).href) as typeof import('../src/library/scan-read-admission.js');
  const locks = await import(new URL('../dist/stream/physical-resource-locks.js', import.meta.url).href) as typeof import('../src/stream/physical-resource-locks.js');
  return { reader, files, repository, scanner, admission, locks };
}
function metadataIdentity(stat: Stats): Readonly<Record<string, string>> {
  return Object.fromEntries(['dev', 'ino', 'size', 'mode', 'uid', 'gid', 'nlink', 'mtimeMs', 'ctimeMs', 'birthtimeMs'].map(key =>
    [key, String(stat[key as keyof typeof stat])]));
}
function closedFd(fd: number): boolean {
  try { fstatSync(fd); return false; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EBADF'; }
}
function actualQuiet(events: readonly MetadataReaderLifecycle[], result: MetadataReadResult): void {
  const starts = events.filter((event): event is Extract<MetadataReaderLifecycle, { type: 'worker-start' | 'worker-online' }> => event.type === 'worker-start');
  assert.equal(starts.length, 1, '每次读取必须真正启动固定 Worker');
  const start = starts[0]!;
  const acquired = events.findIndex(event => event.type === 'lease-acquired' && event.fd === start.fd);
  const exited = events.findIndex(event => event.type === 'worker-exit' && event.threadId === start.threadId);
  const released = events.findIndex(event => event.type === 'lease-released' && event.fd === start.fd);
  const completed = events.findIndex(event => event.type === 'read-complete');
  assert.equal(acquired >= 0 && exited > acquired && released > exited && completed > released, true,
    '实际 Worker exit→原 FD release→完成；失败也不能先放掉真实保护');
  assert.equal(closedFd(start.fd), true);
  const completion = events[completed]!;
  assert.equal(completion.type === 'read-complete' && completion.status === result.status, true);
  const exit = events[exited]!; assert.equal(exit.type === 'worker-exit' && exit.exitCode === 0, true);
}
function success(result: MetadataReadResult): Extract<MetadataReadResult, { status: 'ok' }> {
  assert.equal(result.status, 'ok', '有限空 LIST 兼容必须真正完成解析');
  return result;
}
function bounded(result: MetadataReadResult): void {
  assert.ok(result.readEvidence);
  assert.equal(result.readEvidence.bytesRead > 0 && result.readEvidence.bytesRead <= 32 * 1024 * 1024, true);
  assert.equal(result.readEvidence.maxReadBytes <= 8 * 1024 * 1024, true);
  assert.equal(result.readEvidence.allocationBytes <= 64 * 1024 * 1024, true);
  assert.equal(result.readEvidence.wholeAudioHash, false); assert.equal(result.readEvidence.wholeAudioDecode, false);
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function fixture(t: TestContext, sourceFiles: Readonly<Record<string, Buffer>>) {
  const m = await modules(), temporary = process.env.TMPDIR;
  assert.ok(temporary && path.isAbsolute(temporary), 'Root 必须提供外置 FIX/tmp');
  assert.equal(await realpath(temporary), temporary);
  const parent = await lstat(temporary);
  assert.equal(parent.isDirectory() && !parent.isSymbolicLink(), true);
  assert.equal(parent.mode & 0o777, 0o700); assert.equal(parent.uid, process.getuid!());
  const directory = await mkdtemp(path.join(temporary, 'local-library-wave-empty-list-'));
  await chmod(directory, 0o700);
  const media = path.join(directory, 'media'); await mkdir(media, { mode: 0o700 });
  const originals = new Map<string, { bytes: Buffer; sha256: string; identity: Readonly<Record<string, string>>; signature: string }>();
  const cleanups: (() => void | Promise<void>)[] = [], beforeClaims = m.locks.physicalResourceLocks.combinedSnapshot();
  let root: Awaited<ReturnType<typeof m.files.authorizeSourceDirectory>> & { id: string } | undefined;
  const unchanged = async () => {
    for (const [relative, before] of originals) {
      const file = path.join(media, relative), after = await lstat(file), bytes = await readFile(file);
      assert.deepEqual(metadataIdentity(after), before.identity, '只读解析不能改变真实源身份或元数据');
      assert.deepEqual(bytes, before.bytes); assert.equal(hash(bytes), before.sha256);
      assert.ok(root);
      assert.equal((await m.files.readonlySourceCandidateMetadata(root, relative)).signature, before.signature);
    }
  };
  t.after(async () => {
    const errors: unknown[] = [];
    for (const cleanup of [...cleanups].reverse()) try { await cleanup(); } catch (error) { errors.push(error); }
    try { await unchanged(); assert.deepEqual(m.locks.physicalResourceLocks.combinedSnapshot(), beforeClaims); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, '合成 WAV 的 FD、资源保护或原字节未完成真实收口。');
  });
  for (const [relative, bytes] of Object.entries(sourceFiles)) {
    assert.equal(/^[a-z0-9-]+\.wav$/u.test(relative), true);
    const file = path.join(media, relative); await writeFile(file, bytes, { flag: 'wx', mode: 0o600 });
    const stat = await lstat(file); assert.equal(stat.isFile() && !stat.isSymbolicLink(), true);
    assert.equal(stat.nlink, 1); assert.equal(stat.mode & 0o777, 0o600);
    originals.set(relative, { bytes: Buffer.from(bytes), sha256: hash(bytes), identity: metadataIdentity(stat), signature: '' });
  }
  root = { ...await m.files.authorizeSourceDirectory(media), id: randomUUID() };
  for (const [relative, before] of originals) before.signature = (await m.files.readonlySourceCandidateMetadata(root, relative)).signature;
  const input = (relative: string) => {
    const original = originals.get(relative); assert.ok(original); assert.ok(root);
    return { root, relative, expectedSignature: original.signature };
  };
  return { m, directory, media, root, originals, input, unchanged, addCleanup: (cleanup: () => void | Promise<void>) => cleanups.push(cleanup) };
}
function openedReader(f: Fixture) {
  const events: MetadataReaderLifecycle[] = [], reader = f.m.reader.createMetadataReader({ onLifecycle: event => events.push(event) });
  f.addCleanup(() => reader.close());
  return { reader, events, async read(relative: string) {
    const first = events.length, result = await reader.read(f.input(relative));
    actualQuiet(events.slice(first), result); bounded(result); return result;
  } };
}

test('本地 WAV 空 LIST：固定 Worker 保留后续 ID3/INFO 与原报告音频参数、原字节', { timeout: 30_000 }, async t => {
  const f = await fixture(t, { 'control.wav': taggedWave(0), 'empty.wav': taggedWave(1), 'two-empty.wav': taggedWave(2) });
  const actual = openedReader(f), control = success(await actual.read('control.wav'));
  assert.deepEqual(control.fields, expectedTags);
  assert.deepEqual(control.technical, { container: 'WAVE', codec: 'non-PCM (65534)', lossless: false,
    sampleRateHz: sampleRate, channels, bitsPerSample: bits, durationSeconds: frames / sampleRate, evidence: 'bounded-parser-reported' });
  for (const relative of ['empty.wav', 'two-empty.wav']) {
    const value = success(await actual.read(relative));
    assert.deepEqual(value.fields, expectedTags, 'ID3 的 title/artist 和之后 INFO 的 album 必须完整保留');
    assert.deepEqual(value.technical, control.technical, 'metadata-only 兼容不能顺便重写原 technical 事实');
    assert.deepEqual(value.coverEvidence, control.coverEvidence); assert.deepEqual(value.coverEvidence, []);
    assert.equal(value.parserVersion, NEW_PARSER);
  }
  await f.unchanged();
});

test('本地 WAV 普通 LIST：真实 INFO 标签及 PCM 参数保持原语义', { timeout: 30_000 }, async t => {
  const f = await fixture(t, { 'ordinary.wav': ordinaryWave() }), actual = openedReader(f);
  const value = success(await actual.read('ordinary.wav'));
  assert.deepEqual(value.fields, ordinaryTags); assert.deepEqual(value.coverEvidence, []);
  assert.deepEqual(value.technical, { container: 'WAVE', codec: 'PCM', lossless: true, sampleRateHz: sampleRate, channels,
    bitsPerSample: bits, durationSeconds: frames / sampleRate, evidence: 'bounded-parser-reported' });
  await f.unchanged();
});

test('本地 WAV 空 LIST 兼容不能放过越界、截断或非零短 LIST', { timeout: 30_000 }, async t => {
  const valid = ordinaryWave();
  const invalid: Record<string, Buffer> = {
    'truncated.wav': valid.subarray(0, valid.length - 12),
    'list-overrun.wav': riff([format(false), chunk('data', pcm), chunk('LIST', Buffer.from('INFO'), 1_000_000)]),
    'audio-overrun.wav': riff([format(false), chunk('data', pcm, pcm.length + 1_000_000)]),
    'empty-list-followed-overrun.wav': riff([format(true), chunk('data', pcm), chunk('LIST', Buffer.alloc(0)), chunk('LIST', Buffer.from('INFO'), 1_000_000)]),
  };
  for (const length of [1, 2, 3]) invalid[`short-list-${length}.wav`] = riff([
    format(false), chunk('data', pcm), chunk('LIST', Buffer.alloc(length)), id3(), info({ IPRD: expectedTags.album }),
  ]);
  const f = await fixture(t, { ...invalid, 'valid-after.wav': ordinaryWave() }), actual = openedReader(f);
  for (const relative of Object.keys(invalid)) {
    const value = await actual.read(relative); assert.equal(value.status, 'failure');
    if (value.status === 'failure') assert.equal(value.code, 'PARSE_FAILED', '只容忍已验界的零长可选块，不弱化负 ignore 或 RIFF 边界');
  }
  assert.deepEqual(success(await actual.read('valid-after.wav')).fields, ordinaryTags, '坏容器不能污染下一真实 Worker');
  await f.unchanged();
});

function scanSession(f: Fixture, repo: ReturnType<Fixture['m']['repository']['createCollectionRepository']>, datasetId: string) {
  const context = { datasetId, epoch: randomUUID() }, admission = f.m.admission.createScanReadAdmission({ isBusy: () => false });
  const projection: DatasetProjectionPort = {
    async call<K extends DatasetProjectionCommand>(command: K, payload: DatasetProjectionCommandPayloads[K]): Promise<DatasetProjectionCommandResults[K]> {
      let result: unknown;
      if (command === 'scanReadAcquire') result = admission.acquire(context);
      else if (command === 'scanReadWatchRevocation') result = await admission.watchRevocation(context, (payload as { permitId: string }).permitId);
      else if (command === 'scanReadRelease') result = admission.release(context, (payload as { permitId: string }).permitId);
      else throw new Error('合成扫描只接原真实准入，不构造媒体、Roon 或其他投影事实。');
      return result as DatasetProjectionCommandResults[K];
    },
  };
  const events: MetadataReaderLifecycle[] = [], observations: { relative: string; result: MetadataReadResult }[] = [];
  const actual = f.m.reader.createMetadataReader({ onLifecycle: event => events.push(event) });
  const reader: MetadataReaderPort = {
    async read(input, signal) {
      const first = events.length, result = await actual.read(input, signal);
      actualQuiet(events.slice(first), result); bounded(result); observations.push({ relative: input.relative, result }); return result;
    }, close: () => actual.close(),
  };
  const coordinator = f.m.scanner.createLocalScanCoordinator({ repository: repo, datasetId,
    assertCurrent() { repo.readonlySnapshotStamp(); }, projection, reader });
  return { coordinator, admission, events, observations, async close() {
    try { await coordinator.close(); } finally { admission.close(); repo.close(); }
  } };
}

test('本地 WAV 旧 v1 失败记录：新版本真实增量读入标签和技术事实、单作者持久与冷恢复', { timeout: 60_000 }, async t => {
  const relative = 'legacy-empty.wav', f = await fixture(t, { [relative]: taggedWave(1) });
  const database = path.join(f.directory, 'collection.sqlite'), datasetId = randomUUID();
  let activeRepo: ReturnType<Fixture['m']['repository']['createCollectionRepository']> | undefined;
  let activeSession: ReturnType<typeof scanSession> | undefined;
  f.addCleanup(async () => {
    if (activeSession) { const current = activeSession; activeSession = undefined; activeRepo = undefined; await current.close(); }
    else if (activeRepo) { const current = activeRepo; activeRepo = undefined; current.close(); }
  });
  const seed = f.m.repository.createCollectionRepository({ filePath: database }); activeRepo = seed;
  const source = seed.sources.authorize(randomUUID(), await f.m.files.authorizeSourceDirectory(f.media));
  const root = seed.localCatalog.registerRoot({ commandId: randomUUID(), sourceRootId: source.id, role: 'library' });
  const historicalStart = { commandId: randomUUID(), datasetId, libraryRootId: root.id, expectedRootRevision: root.revision, parserVersion: OLD_PARSER };
  const started = seed.localScan.start(historicalStart).job;
  const running = seed.localScan.resume({ commandId: randomUUID(), jobId: started.jobId, expectedRevision: started.jobRevision });
  const signature = f.originals.get(relative)!.signature;
  // 经原唯一 store/journal 四回执闭链写入合成旧失败；不直接写 SQL，不伪称此处执行了历史 Worker。
  const historicalBatch: ScanPreparedBatch = { batchId: randomUUID(), jobId: running.jobId, expectedJobRevision: running.jobRevision,
    checkpointBefore: running.checkpointRef, items: [{ relative, signature, parserVersion: OLD_PARSER, outcome: 'rejected',
      fields: null, failureCode: 'PARSE_FAILED', reused: false, readFacts: null }], frontier: [], completed: true };
  seed.localScan.privatePrepareBatch({ commandId: randomUUID(), jobId: running.jobId, batch: historicalBatch });
  const historicalCommit = { commandId: randomUUID(), jobId: running.jobId, batchId: historicalBatch.batchId, expectedRevision: running.jobRevision };
  const failed = seed.localScan.privateCommitBatch(historicalCommit);
  assert.equal(failed.phase, 'completed'); assert.deepEqual(failed.progress, { visited: '1', accepted: '0', rejected: '1' });
  const historicalReceipt = seed.localScan.receipt(historicalCommit.commandId); assert.ok(historicalReceipt);
  const historicalState = seed.localScan.privateFileState(root.id, relative); assert.ok(historicalState);
  assert.equal(historicalState.value.outcome, 'rejected'); assert.equal(historicalState.value.parserVersion, OLD_PARSER);
  assert.equal(historicalState.value.signature, signature); assert.equal(historicalState.value.assetId, null);
  assert.equal(historicalState.value.trackId, null); assert.equal(historicalState.value.readFacts, null);
  assert.equal(seed.localCatalog.pageTracks({ offset: 0, limit: 200 }).total, 0);
  seed.close(); activeRepo = undefined;

  // 冷开原记录后创建新增量 job，绝不重播旧 completed 命令或直接提升其失败状态。
  const repo = f.m.repository.createCollectionRepository({ filePath: database }); activeRepo = repo;
  assert.deepEqual(repo.localScan.privateFileState(root.id, relative), historicalState);
  activeSession = scanSession(f, repo, datasetId); const next = activeSession;
  assert.equal(next.observations.length, 0, '冷打开不自动解析或执行历史命令');
  const newJob = next.coordinator.start({ commandId: randomUUID(), libraryRootId: root.id, expectedRootRevision: root.revision });
  assert.notEqual(newJob.jobId, failed.jobId); await next.coordinator.privateWait(newJob.jobId);
  const completed = next.coordinator.get(newJob.jobId);
  assert.equal(completed.phase, 'completed'); assert.deepEqual(completed.progress, { visited: '1', accepted: '1', rejected: '0' });
  assert.equal(next.observations.length, 1, '未改源签名的旧失败必须真实重读，不能拼造或复用 readFacts');
  assert.equal(next.observations[0]!.relative, relative);
  const parsed = success(next.observations[0]!.result); assert.equal(parsed.parserVersion, NEW_PARSER);
  assert.deepEqual(parsed.fields, expectedTags);
  const state = repo.localScan.privateFileState(root.id, relative); assert.ok(state);
  assert.equal(state.value.outcome, 'accepted'); assert.equal(state.value.failureCode, null);
  assert.equal(state.value.signature, signature); assert.equal(state.value.parserVersion, NEW_PARSER);
  assert.ok(state.value.assetId); assert.ok(state.value.trackId);
  assert.deepEqual(state.value.readFacts, { technical: parsed.technical, coverEvidence: parsed.coverEvidence, readEvidence: parsed.readEvidence });
  const asset = repo.localCatalog.asset(state.value.assetId), track = repo.localCatalog.track(state.value.trackId);
  const metadata = repo.localCatalog.metadata(track.id), tags = repo.localCatalog.observations(track.id);
  assert.equal(repo.localCatalog.privateAssetLocator(asset.id).relative, relative);
  assert.equal(asset.sourceRootId, source.id); assert.equal(track.assetId, asset.id);
  assert.equal(repo.localCatalog.pageTracks({ offset: 0, limit: 200 }).total, 1);
  assert.deepEqual(metadata, { raw: expectedTags, override: null, effective: expectedTags });
  assert.equal(tags.length, 1); assert.equal(tags[0]!.source, 'tag'); assert.equal(tags[0]!.parserVersion, NEW_PARSER);
  assert.deepEqual(tags[0]!.fields, expectedTags);
  assert.deepEqual(repo.localScan.get(failed.jobId), failed, '原失败 job/receipt 不被新事实改写');
  assert.deepEqual(repo.localScan.receipt(historicalCommit.commandId), historicalReceipt);
  assert.deepEqual(next.admission.resourceCounts(), { permits: 0, revoked: 0, watches: 0, timers: 0, closed: false });
  await next.close(); activeSession = undefined; activeRepo = undefined;

  const cold = f.m.repository.createCollectionRepository({ filePath: database }); activeRepo = cold;
  assert.deepEqual(cold.localScan.privateFileState(root.id, relative), state);
  assert.deepEqual(cold.localCatalog.asset(asset.id), asset); assert.deepEqual(cold.localCatalog.track(track.id), track);
  assert.deepEqual(cold.localCatalog.metadata(track.id), metadata); assert.deepEqual(cold.localCatalog.observations(track.id), tags);
  assert.deepEqual(cold.localScan.get(failed.jobId), failed); assert.deepEqual(cold.localScan.receipt(historicalCommit.commandId), historicalReceipt);
  activeSession = scanSession(f, cold, datasetId); const again = activeSession;
  const last = again.coordinator.start({ commandId: randomUUID(), libraryRootId: root.id, expectedRootRevision: root.revision });
  await again.coordinator.privateWait(last.jobId);
  assert.equal(again.coordinator.get(last.jobId).phase, 'completed'); assert.equal(again.observations.length, 0);
  assert.equal(again.events.filter(event => event.type === 'worker-start').length, 0, '新版本已认证同签名 accepted 仍复用原事实');
  assert.deepEqual(cold.localScan.privateFileState(root.id, relative)!.value, state.value);
  assert.deepEqual(cold.localCatalog.asset(asset.id), asset); assert.deepEqual(cold.localCatalog.track(track.id), track);
  assert.deepEqual(cold.localCatalog.metadata(track.id), metadata); assert.deepEqual(cold.localCatalog.observations(track.id), tags);
  assert.deepEqual(again.admission.resourceCounts(), { permits: 0, revoked: 0, watches: 0, timers: 0, closed: false });
  await again.close(); activeSession = undefined; activeRepo = undefined;
  await f.unchanged();
});
