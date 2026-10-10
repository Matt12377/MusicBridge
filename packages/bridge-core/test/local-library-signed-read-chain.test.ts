import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import fs, { type BigIntStats } from 'node:fs';
import fsPromises, { chmod, lstat, mkdir, mkdtemp, readFile, realpath, writeFile, type FileHandle } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { loadFreshMetadataReader, type AudioFixtureEntry } from './helpers/mbrs003-audio-fixtures.js';
import type { DatasetProjectionCommand, DatasetProjectionCommandPayloads, DatasetProjectionCommandResults, DatasetProjectionPort } from '../src/collection/dataset-owner-protocol.js';
import type { MetadataReaderLifecycle, MetadataReaderPort, MetadataReadResult } from '../src/library/metadata-reader-types.js';
import type { AssetLease } from '../src/stream/local-file-source.js';

const hash = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const signature = (info: BigIntStats): string => [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(':');
const sealedAudio = new URL('./fixtures/mbrs003/audio/', import.meta.url);

/** 同一 fresh dist 的真实 Reader、Scanner、票据和 FD 池共享一套保护表。 */
async function modules() {
  const reader = await loadFreshMetadataReader();
  const repository = await import(new URL('../dist/collection/repository.js', import.meta.url).href) as typeof import('../src/collection/repository.js');
  const relocation = await import(new URL('../dist/collection/local-relocation-coordinator.js', import.meta.url).href) as typeof import('../src/collection/local-relocation-coordinator.js');
  const scanner = await import(new URL('../dist/collection/local-scan-coordinator.js', import.meta.url).href) as typeof import('../src/collection/local-scan-coordinator.js');
  const admission = await import(new URL('../dist/library/scan-read-admission.js', import.meta.url).href) as typeof import('../src/library/scan-read-admission.js');
  const files = await import(new URL('../dist/recording/source-files.js', import.meta.url).href) as typeof import('../src/recording/source-files.js');
  const tickets = await import(new URL('../dist/collection/local-source-tickets.js', import.meta.url).href) as typeof import('../src/collection/local-source-tickets.js');
  const ticketTypes = await import(new URL('../dist/collection/local-source-ticket-types.js', import.meta.url).href) as typeof import('../src/collection/local-source-ticket-types.js');
  const resolver = await import(new URL('../dist/application/local-source-resolver.js', import.meta.url).href) as typeof import('../src/application/local-source-resolver.js');
  const pool = await import(new URL('../dist/stream/local-file-source.js', import.meta.url).href) as typeof import('../src/stream/local-file-source.js');
  const fence = await import(new URL('../dist/stream/local-source-fence.js', import.meta.url).href) as typeof import('../src/stream/local-source-fence.js');
  const locks = await import(new URL('../dist/stream/physical-resource-locks.js', import.meta.url).href) as typeof import('../src/stream/physical-resource-locks.js');
  return { reader, repository, relocation, scanner, admission, files, tickets, ticketTypes, resolver, pool, fence, locks };
}

async function fixture(t: TestContext, identity: { dev: bigint; rootIno: bigint; fileIno: bigint }) {
  const m = await modules(), temporary = process.env.TMPDIR;
  assert.ok(temporary && path.isAbsolute(temporary), 'Root 必须提供 FIX/tmp 内的独立 TMPDIR');
  assert.equal(await realpath(temporary), temporary);
  const parent = await lstat(temporary);
  assert.equal(parent.isDirectory() && !parent.isSymbolicLink(), true);
  assert.equal(parent.mode & 0o777, 0o700);
  assert.equal(parent.uid, process.getuid!());
  const directory = await mkdtemp(path.join(temporary, 'local-library-signed-read-'));
  await chmod(directory, 0o700);
  const cleanups: (() => void | Promise<void>)[] = [];
  t.after(async () => {
    const errors: unknown[] = [];
    for (const cleanup of [...cleanups].reverse()) try { await cleanup(); } catch (error) { errors.push(error); }
    t.diagnostic(`自有读链媒体与工作库保留：${directory}`);
    if (errors.length) throw new AggregateError(errors, '有符号身份读链的真实资源收口未全部成功。');
  });
  const rawManifest = await readFile(new URL('manifest.json', sealedAudio));
  assert.equal(hash(rawManifest), '5e4157b8fa3428a82def6c128e5e60dce3cc90186b804d835c9be8e957c8feb1');
  const manifest = JSON.parse(rawManifest.toString('utf8')) as { synthetic: boolean; files: AudioFixtureEntry[] };
  assert.equal(manifest.synthetic, true);
  const entry = manifest.files.find(value => value.id === 'core-wav'); assert.ok(entry);
  const verifiedEntry = entry;
  assert.ok(entry.expectedTags); assert.ok(entry.observedAudio);
  const original = new URL(entry.file, sealedAudio), bytes = await readFile(original);
  assert.equal(bytes.length, entry.bytes); assert.equal(hash(bytes), entry.sha256);
  const media = path.join(directory, 'media'), album = path.join(media, 'album'), relative = 'album/signed.wav', file = path.join(media, relative);
  await mkdir(media, { mode: 0o700 }); await mkdir(album, { mode: 0o700 });
  await writeFile(file, bytes, { flag: 'wx', mode: 0o600 });

  const originalLstat = fsPromises.lstat, originalOpen = fsPromises.open;
  const originalLstatSync = fs.lstatSync, originalOpenSync = fs.openSync, originalFstatSync = fs.fstatSync, originalCloseSync = fs.closeSync;
  const physicalBefore = await originalLstat(file, { bigint: true }), opened: { handle: FileHandle; fd: number }[] = [], syncFiles = new Set<number>();
  let rootIno = identity.rootIno, fileIno = identity.fileIno;
  const underMedia = (value: string): boolean => value === media || value.startsWith(media + path.sep);
  function observed<T extends { dev: number | bigint; ino: number | bigint }>(info: T, name: string): T {
    // 只替换自有复制文件的真实 BigInt stat 身份，不伪造 FD、内容、大小、权限、时间或 nlink。
    if (typeof info.ino === 'bigint' && underMedia(name)) {
      Object.defineProperty(info, 'dev', { value: identity.dev, enumerable: true, configurable: true });
      if (name === media || name === file) Object.defineProperty(info, 'ino', {
        value: name === media ? rootIno : fileIno, enumerable: true, configurable: true,
      });
    }
    return info;
  }
  const mocks: { mock: { restore(): void } }[] = [];
  cleanups.push(() => { for (const mock of [...mocks].reverse()) mock.mock.restore(); syncBuiltinESMExports(); });
  mocks.push(t.mock.method(fsPromises, 'lstat', async (...args: Parameters<typeof originalLstat>) => observed(await originalLstat(...args), String(args[0]))));
  mocks.push(t.mock.method(fsPromises, 'open', async (...args: Parameters<typeof originalOpen>) => {
    const handle = await originalOpen(...args);
    if (String(args[0]) === file) {
      opened.push({ handle, fd: handle.fd });
      const actualStat = handle.stat.bind(handle);
      mocks.push(t.mock.method(handle, 'stat', async (...statArgs: Parameters<typeof handle.stat>) => observed(await actualStat(...statArgs), file)));
    }
    return handle;
  }));
  // 目录即时资格也使用生产的同步只读 FD；同一受控身份必须覆盖 named 与 opened 两端。
  mocks.push(t.mock.method(fs, 'lstatSync', (...args: Parameters<typeof originalLstatSync>) => {
    const info = originalLstatSync(...args); return info === undefined ? undefined : observed(info, String(args[0]));
  }));
  mocks.push(t.mock.method(fs, 'openSync', (...args: Parameters<typeof originalOpenSync>) => {
    const fd = originalOpenSync(...args); if (String(args[0]) === file) syncFiles.add(fd); return fd;
  }));
  mocks.push(t.mock.method(fs, 'fstatSync', (...args: Parameters<typeof originalFstatSync>) => {
    const info = originalFstatSync(...args); return syncFiles.has(args[0]) ? observed(info, file) : info;
  }));
  mocks.push(t.mock.method(fs, 'closeSync', (...args: Parameters<typeof originalCloseSync>) => {
    originalCloseSync(...args); syncFiles.delete(args[0]);
  }));
  syncBuiltinESMExports();

  const beforeClaims = m.locks.physicalResourceLocks.combinedSnapshot();
  const repository = m.repository.createCollectionRepository({ filePath: path.join(directory, 'collection.sqlite') });
  cleanups.push(() => repository.close());
  const relocation = m.relocation.createLocalRelocationCoordinator({ repository, assertCurrent() { repository.readonlySnapshotStamp(); } });
  cleanups.push(() => relocation.close());
  const source = repository.sources.authorize(randomUUID(), await m.files.authorizeSourceDirectory(media));
  assert.equal(source.dev, String(identity.dev)); assert.equal(source.ino, String(identity.rootIno));
  const root = await relocation.registerRoot({ commandId: randomUUID(), sourceRootId: source.id });
  const datasetId = randomUUID(), epoch = randomUUID(), context = { datasetId, epoch };
  const admission = m.admission.createScanReadAdmission({ isBusy: () => false }); cleanups.push(() => admission.close());
  const projection: DatasetProjectionPort = {
    async call<K extends DatasetProjectionCommand>(command: K, payload: DatasetProjectionCommandPayloads[K]): Promise<DatasetProjectionCommandResults[K]> {
      let result: unknown;
      if (command === 'scanReadAcquire') result = admission.acquire(context);
      else if (command === 'scanReadWatchRevocation') result = await admission.watchRevocation(context, (payload as { permitId: string }).permitId);
      else if (command === 'scanReadRelease') result = admission.release(context, (payload as { permitId: string }).permitId);
      else throw new Error('自有读链只提供原生产扫描准入，不构造 Roon 或其他投影事实。');
      return result as DatasetProjectionCommandResults[K];
    },
  };
  const events: MetadataReaderLifecycle[] = [], releasedCodes: string[] = [], results: MetadataReadResult[] = [];
  const actualReader = m.reader.createMetadataReader({ onLifecycle(event) {
    events.push(event);
    if (event.type === 'lease-released') {
      try { originalFstatSync(event.fd); releasedCodes.push('STILL_OPEN'); }
      catch (error) { releasedCodes.push((error as NodeJS.ErrnoException).code ?? 'UNKNOWN'); }
    }
  } }); cleanups.push(() => actualReader.close());
  const reader: MetadataReaderPort = {
    async read(input, signal) { const result = await actualReader.read(input, signal); results.push(structuredClone(result)); return result; },
    close: () => actualReader.close(),
  };
  const scanner = m.scanner.createLocalScanCoordinator({ repository, datasetId, reader, projection,
    assertCurrent() { repository.readonlySnapshotStamp(); } }); cleanups.push(() => scanner.close());
  const tickets = m.tickets.createLocalSourceTickets(repository, epoch, datasetId, () => { repository.readonlySnapshotStamp(); });
  const captures: string[] = [];
  cleanups.push(() => { tickets.seal(); for (const id of captures) tickets.release(id); assert.equal(tickets.size, 0); });
  const pool = new m.pool.LocalFileSourcePool(), holds = new Map<AssetLease, () => void>();
  cleanups.push(async () => { await pool.close(); for (const release of holds.values()) release(); holds.clear(); });
  async function unchanged(): Promise<void> {
    assert.deepEqual(await readFile(original), bytes, '封存合成原件不得改写');
    assert.deepEqual(await readFile(file), bytes, 'Scanner、票据和 FD 池均只读完整自有副本');
    assert.equal(hash(await readFile(file)), verifiedEntry.sha256);
    assert.equal(signature(await originalLstat(file, { bigint: true })), signature(physicalBefore));
    assert.equal((await originalLstat(file, { bigint: true })).birthtimeNs, physicalBefore.birthtimeNs);
  }
  cleanups.push(unchanged);
  return { m, repository, relocation, source, root, datasetId, epoch, scanner, admission, events, releasedCodes, results,
    pool, holds, tickets, captures, bytes, entry, relative, file, physicalBefore, opened, beforeClaims, unchanged, originalFstatSync,
    changeFile(value: bigint) { fileIno = value; }, changeRoot(value: bigint) { rootIno = value; }, identity };
}

async function fullBytes(lease: AssetLease): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const part of lease.readSlice(0, lease.size - 1, new AbortController().signal)) parts.push(part);
  return Buffer.concat(parts);
}

async function runReadChain(t: TestContext, identity: { dev: bigint; rootIno: bigint; fileIno: bigint }) {
  const f = await fixture(t, identity), { m } = f;
  const expectedSignature = [identity.dev, identity.fileIno, f.physicalBefore.size, f.physicalBefore.mtimeNs, f.physicalBefore.ctimeNs].join(':');
  assert.equal((await m.files.readonlySourceCandidateMetadata(f.source, f.relative)).signature, expectedSignature);
  const initial = f.scanner.start({ commandId: randomUUID(), libraryRootId: f.root.id, expectedRootRevision: f.root.revision });
  assert.equal(initial.phase, 'pending'); await f.scanner.privateWait(initial.jobId);
  assert.equal(f.scanner.get(initial.jobId).phase, 'completed');
  assert.deepEqual(f.scanner.get(initial.jobId).progress, { visited: '1', accepted: '1', rejected: '0' });
  assert.equal(f.results.length, 1); const parsed = f.results[0]!;
  assert.equal(parsed.status, 'ok'); if (parsed.status !== 'ok') throw new Error('必须使用实际 Worker 成功结果。');
  assert.deepEqual(parsed.fields, f.entry.expectedTags);
  assert.equal(parsed.technical.container, 'WAVE'); assert.equal(parsed.technical.sampleRateHz, 44100);
  assert.equal(parsed.technical.channels, 2); assert.equal(parsed.technical.bitsPerSample, 16); assert.equal(parsed.technical.lossless, true);
  assert.equal(parsed.readEvidence.bytesRead > 0, true); assert.equal(parsed.readEvidence.wholeAudioHash, false);
  const saved = f.repository.localScan.privateCurrentFileState(f.root.id, f.relative); assert.ok(saved);
  assert.equal(saved.jobId, initial.jobId); assert.equal(saved.value.signature, expectedSignature); assert.equal(saved.value.outcome, 'accepted');
  assert.deepEqual(saved.value.readFacts, { technical: parsed.technical, coverEvidence: parsed.coverEvidence, readEvidence: parsed.readEvidence });
  assert.ok(saved.value.trackId); assert.ok(saved.value.assetId);
  assert.equal(f.repository.localCatalog.metadata(saved.value.trackId).effective.title, f.entry.expectedTags!.title);
  const asset = f.repository.localCatalog.asset(saved.value.assetId), track = f.repository.localCatalog.track(saved.value.trackId);
  assert.equal(asset.sourceRootId, f.source.id); assert.equal(track.assetId, asset.id);
  assert.deepEqual(f.releasedCodes, ['EBADF']);
  const start = f.events.findIndex(event => event.type === 'worker-start');
  const exit = f.events.findIndex(event => event.type === 'worker-exit');
  const quiet = f.events.findIndex(event => event.type === 'lease-released');
  const done = f.events.findIndex(event => event.type === 'read-complete');
  assert.equal(start >= 0 && exit > start && quiet > exit && done > quiet, true, '原 Worker exit 和真实 FD quiet 先于完成');
  assert.deepEqual(f.admission.resourceCounts(), { permits: 0, revoked: 0, watches: 0, timers: 0, closed: false });
  assert.deepEqual(m.locks.physicalResourceLocks.combinedSnapshot(), f.beforeClaims);

  const selection = { local_track_id: track.id, asset_id: asset.id, expected_asset_revision: asset.fileRevision };
  const captured = f.tickets.captureMobile(selection); f.captures.push(captured.ticketId);
  assert.equal(m.ticketTypes.isLocalSourceCaptureResult(captured), true);
  assert.equal(captured.datasetId, f.datasetId); assert.equal(captured.epoch, f.epoch);
  assert.equal(captured.facts.sourceRoot.dev, String(identity.dev)); assert.equal(captured.facts.sourceRoot.ino, String(identity.rootIno));
  assert.equal(captured.facts.observation!.signature, expectedSignature);
  assert.equal(captured.fileParameters!.sampleRateHz, 44100); assert.equal(captured.fileParameters!.bitsPerSample, 16);
  const fence = new m.fence.LocalSourceFence(captured.buffer), ownerId = randomUUID();
  const descriptor = { source_kind: 'local_file', status: 'prepared_descriptor', facts: captured.facts } as const;
  const authority = (attempt: number) => ({ ownerId, attempt, isCurrent: () => fence.current && f.tickets.revalidate(captured.ticketId) });
  async function prepare(attempt: number): Promise<AssetLease> {
    const release = fence.retain();
    try { const lease = await f.pool.prepare(descriptor, authority(attempt)); f.holds.set(lease, release); return lease; }
    catch (error) { release(); throw error; }
  }
  async function close(lease: AssetLease): Promise<void> {
    await lease.close(); f.holds.get(lease)!(); f.holds.delete(lease);
    assert.deepEqual(lease.resourceSnapshot(), { activeRequests: 0, activeIo: 0, timer: 0 });
  }
  const first = await prepare(1);
  assert.deepEqual(await fullBytes(first), f.bytes); assert.equal(first.state, 'PREPARED', '不构造 Roon 确认也可验证原受保护 FD');
  assert.equal(first.size, f.entry.bytes); assert.equal(fence.references, 1);
  const peer = new m.locks.PhysicalResourceCoordinator(m.locks.physicalResourceLocks.buffer);
  assert.deepEqual(peer.inspect([{ dev: String(identity.dev), ino: String(identity.fileIno) }]), { readers: 1, writers: 0, resources: 1 });
  assert.throws(() => peer.acquireWrite([{ dev: String(identity.dev), ino: String(identity.fileIno) }]), m.locks.PhysicalResourceBusy);
  await f.unchanged();

  f.changeFile(-identity.fileIno);
  assert.equal(await m.files.sourceFileAvailability(f.source, f.relative, expectedSignature), 'CONTENT_CHANGED');
  await assert.rejects(first.verify(), error => error instanceof m.pool.LocalFileLeaseError && error.code === 'SOURCE_CHANGED');
  await close(first);
  const openedBefore = f.opened.length;
  await assert.rejects(prepare(2), error => error instanceof m.files.SourceFileError && error.code === 'CONTENT_CHANGED');
  assert.equal(f.opened.length, openedBefore, '新 attempt 也不能把改变符号后的同名文件当作旧观察');
  f.changeFile(identity.fileIno);

  f.changeRoot(-identity.rootIno);
  assert.equal(await m.files.sourceRootAvailability(f.source), 'SOURCE_ROOT_OFFLINE');
  assert.equal(m.files.readonlySourceCatalogFileAvailable(f.source, f.relative, expectedSignature, 'WAVE'), false);
  await assert.rejects(prepare(3), error => error instanceof m.files.SourceFileError && error.code === 'SOURCE_ROOT_OFFLINE');
  f.changeRoot(identity.rootIno);
  assert.equal(m.files.readonlySourceCatalogFileAvailable(f.source, f.relative, expectedSignature, 'WAVE'), true);
  const again = await prepare(4); assert.deepEqual(await fullBytes(again), f.bytes); await close(again);
  assert.equal(fence.references, 0);

  const revoked = f.repository.sources.revoke({ commandId: randomUUID(), id: f.source.id });
  assert.equal(revoked.authorized, false); assert.equal(await m.files.sourceRootAvailability(revoked), 'REVOKED');
  assert.equal(f.tickets.revalidate(captured.ticketId), false); assert.equal(fence.current, false);
  assert.throws(() => f.tickets.captureMobile(selection), error => error instanceof m.resolver.LocalSourcePreparationError && error.code === 'UNAUTHORIZED_ROOT');
  await assert.rejects(f.pool.prepare(descriptor, authority(5)), error => error instanceof m.pool.LocalFileLeaseError && error.code === 'STALE_ATTEMPT');
  assert.equal(m.files.readonlySourceCatalogFileAvailable(revoked, f.relative, expectedSignature, 'WAVE'), false);
  assert.equal((await f.relocation.roots())[0]!.availability, 'REVOKED');
  assert.equal(f.repository.localCatalog.root(f.root.id).id, f.root.id);
  assert.deepEqual(f.repository.localCatalog.asset(asset.id), asset, '变身份/撤权不重写原逻辑资产');
  assert.deepEqual(f.repository.localCatalog.track(track.id), track);
  f.tickets.release(captured.ticketId); assert.equal(f.tickets.size, 0);
  await f.pool.close(); await f.scanner.close();
  assert.deepEqual(f.pool.resourceSnapshot(), { openLeases: 0, reservations: 0 });
  assert.deepEqual(m.locks.physicalResourceLocks.combinedSnapshot(), f.beforeClaims);
  for (const opened of f.opened) assert.throws(() => f.originalFstatSync(opened.fd), { code: 'EBADF' }, '所有真实媒体 FD 已关闭');
  await f.unchanged();
}

test('本地库有符号根与文件：真实扫描 facts→原票据→完整 FD 读取，变身份与撤权拒绝且原字节不变', { timeout: 30_000 }, async t => {
  await runReadChain(t, { dev: -9_007_199_254_741_009n, rootIno: -9_007_199_254_741_007n, fileIno: -9_007_199_254_741_011n });
});

test('本地库高位正身份：真实扫描与 FD 票据保持完整 BigInt 字符串，保护与拒绝路径不丢精度', { timeout: 30_000 }, async t => {
  await runReadChain(t, { dev: 18_446_744_073_709_551_613n, rootIno: 18_446_744_073_709_551_614n, fileIno: 18_446_744_073_709_551_615n });
});
