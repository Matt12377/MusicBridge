import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { MessageChannel } from 'node:worker_threads';
import path from 'node:path';
import type { TestContext } from 'node:test';
import * as dto from '@music-bridge/contracts';
import { buildStoragePolicy } from '../../../../apps/desktop/scripts/build-storage-root.mjs';
import { loadFreshMetadataReader } from '../helpers/mbrs003-audio-fixtures.js';
import type { DatasetProjectionPort, DatasetProjectionCommand, DatasetProjectionCommandPayloads, DatasetProjectionCommandResults } from '../../src/collection/dataset-owner-protocol.js';

export const wholeHash = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
/** 全链同一fresh dist实例，Reader/FD/Scanner ticket/actor的WeakMap不跨src/dist拼接。 */
export async function relocationModules() {
  const reader = await loadFreshMetadataReader();
  const repository = await import(new URL('../../dist/collection/repository.js', import.meta.url).href) as typeof import('../../src/collection/repository.js');
  const scanner = await import(new URL('../../dist/collection/local-scan-coordinator.js', import.meta.url).href) as typeof import('../../src/collection/local-scan-coordinator.js');
  const admission = await import(new URL('../../dist/library/scan-read-admission.js', import.meta.url).href) as typeof import('../../src/library/scan-read-admission.js');
  const files = await import(new URL('../../dist/recording/source-files.js', import.meta.url).href) as typeof import('../../src/recording/source-files.js');
  const service = await import(new URL('../../dist/collection/local-relocation-service.js', import.meta.url).href) as typeof import('../../src/collection/local-relocation-service.js');
  const authority = await import(new URL('../../dist/collection/source-relocation-authority.js', import.meta.url).href) as typeof import('../../src/collection/source-relocation-authority.js');
  const journal = await import(new URL('../../dist/collection/local-relocation-journal.js', import.meta.url).href) as typeof import('../../src/collection/local-relocation-journal.js');
  const locks = await import(new URL('../../dist/stream/physical-resource-locks.js', import.meta.url).href) as typeof import('../../src/stream/physical-resource-locks.js');
  const claims = await import(new URL('../../dist/stream/physical-resource-claims.js', import.meta.url).href) as typeof import('../../src/stream/physical-resource-claims.js');
  const scanStore = await import(new URL('../../dist/collection/local-scan-store.js', import.meta.url).href) as typeof import('../../src/collection/local-scan-store.js');
  return { reader, repository, scanner, admission, files, service, authority, journal, locks, claims, scanStore };
}
const ownedRoot = new URL('../fixtures/mbrs012-source/', import.meta.url);
export async function ownedFlacWithoutPadding(): Promise<Buffer> {
  const raw = await readFile(new URL('manifest.json', ownedRoot));
  assert.equal(wholeHash(raw), '5a3621481eb22801c020589b393c3a1ffa32e3d132766ea6e8db6e33fa47714b');
  const manifest = JSON.parse(raw.toString('utf8')) as { synthetic: boolean; allContentOwned: boolean; files: { file: string; sha256: string; bytes: number }[] };
  assert.equal(manifest.synthetic, true); assert.equal(manifest.allContentOwned, true);
  const entry = manifest.files.find(file => file.file === 'owned-stereo-fixed-tags.flac')!;
  const original = await readFile(new URL(entry.file, ownedRoot)); assert.equal(wholeHash(original), entry.sha256); assert.equal(original.length, entry.bytes);
  assert.equal(original.subarray(0, 4).toString('ascii'), 'fLaC');
  const kept: Buffer[] = []; let at = 4, last = false;
  while (!last) {
    const header = original.subarray(at, at + 4), length = header.readUIntBE(1, 3); last = (header[0]! & 0x80) !== 0;
    if ((header[0]! & 0x7f) !== 1) { const block = Buffer.from(original.subarray(at, at + 4 + length)); block[0] = block[0]! & 0x7f; kept.push(block); }
    at += 4 + length;
  }
  // 自有副本保留原压缩帧；添加合法APPLICATION块且完全无PADDING，不能借012writer白名单。
  const application = Buffer.from([0x82, 0, 0, 8, ...Buffer.from('MB13data')]);
  assert.equal(application.length, 12); return Buffer.concat([original.subarray(0, 4), ...kept, application, original.subarray(at)]);
}
export async function relocationFixture(t: TestContext, input: { cue?: boolean; source?: Buffer; trustedWholeHash?: boolean; now?: () => number } = {}) {
  const modules = await relocationModules(), base = buildStoragePolicy().check(process.env.TMPDIR!, { mustExist: true });
  const directory = await mkdtemp(path.join(base, 'mbrs013-real-files-'));
  const cleanups: (() => Promise<void> | void)[] = []; let closed = false, closePromise: Promise<void> | undefined;
  function close(): Promise<void> {
    if (closePromise) return closePromise; closed = true;
    closePromise = (async () => {
      const failures: unknown[] = [];
      for (const cleanup of [...cleanups].reverse()) try { await cleanup(); } catch (error) { failures.push(error); }
      if (failures.length) throw new AggregateError(failures, '自建搬迁夹具的逐阶段真实资源关闭未全部成功。');
    })(); return closePromise;
  }
  // 在第一个资源出现时就登记；准备/扫描/资格失败不能越过after留下真实worker或数据库。
  t.after(async () => { try { await close(); } finally { t.diagnostic(`自有搬迁输入、journal及保全材料保留：${directory}`); } });
  await chmod(directory, 0o700);
  const media = path.join(directory, 'original'), destination = path.join(directory, 'destination');
  await mkdir(media, { mode: 0o700 }); await mkdir(destination, { mode: 0o700 });
  const bytes = input.source ?? await ownedFlacWithoutPadding(), name = 'Original.flac', lyric = Buffer.from('[00:00.00]自有闭集歌词\n', 'utf8');
  await writeFile(path.join(media, name), bytes, { mode: 0o600, flag: 'wx' }); await writeFile(path.join(media, 'Original.lrc'), lyric, { mode: 0o600, flag: 'wx' });
  const cue = Buffer.from('FILE "Original.flac" WAVE\n  TRACK 01 AUDIO\n    INDEX 01 00:00:00\n', 'utf8');
  if (input.cue) await writeFile(path.join(media, 'Original.cue'), cue, { mode: 0o600, flag: 'wx' });
  const filePath = path.join(directory, 'collection.sqlite'), repository = modules.repository.createCollectionRepository({ filePath }), datasetId = randomUUID(), epoch = randomUUID();
  cleanups.push(() => repository.close());
  const source = repository.sources.authorize(randomUUID(), await modules.files.authorizeSourceDirectory(media));
  const root = repository.localCatalog.registerRoot({ commandId: randomUUID(), sourceRootId: source.id, role: 'library' });
  // 此自建工作库没有播放会话；准入仍走原真实permit/watch/release，FD保护使用同一真实SAB。
  const admission = modules.admission.createScanReadAdmission({ isBusy: () => false }), context = { datasetId, epoch };
  cleanups.push(() => admission.close());
  const projection: DatasetProjectionPort = { async call<C extends DatasetProjectionCommand>(command: C, payload: DatasetProjectionCommandPayloads[C]): Promise<DatasetProjectionCommandResults[C]> {
    let result: unknown;
    if (command === 'scanReadAcquire') result = admission.acquire(context);
    else if (command === 'scanReadWatchRevocation') result = await admission.watchRevocation(context, (payload as { permitId: string }).permitId);
    else if (command === 'scanReadRelease') result = admission.release(context, (payload as { permitId: string }).permitId);
    else throw new Error('自建搬迁夹具不提供Roon或媒体投影假事实。');
    return result as DatasetProjectionCommandResults[C];
  } };
  const reader = modules.reader.createMetadataReader(); cleanups.push(() => reader.close());
  const scanner = modules.scanner.createLocalScanCoordinator({ repository, datasetId, projection, reader,
    assertCurrent() { repository.readonlySnapshotStamp(); } });
  cleanups.push(() => scanner.close());
  const initial = scanner.start({ commandId: randomUUID(), libraryRootId: root.id, expectedRootRevision: root.revision });
  await scanner.privateWait(initial.jobId); assert.equal(scanner.get(initial.jobId).phase, 'completed');
  const track = repository.localCatalog.pageTracks({ offset: 0, limit: 200 }).items[0]!; assert.ok(track);
  let original = repository.localCatalog.privateRelocationSnapshot(track.assetId);
  if (input.trustedWholeHash) {
    const metadata = await modules.files.readonlySourceCandidateMetadata(source, name);
    await modules.files.withCheckedReadonlyMetadataSource(source, name, metadata.signature, new AbortController().signal, async handle => {
      const observation = await (await import(new URL('../../dist/collection/source-relocation-verify.js', import.meta.url).href) as typeof import('../../src/collection/source-relocation-verify.js')).observeRelocationFile(handle);
      assert.equal(observation.sha256, wholeHash(bytes));
      // 夹具在移动前通过原私有作者登记已经实际全FD校验的旧SHA；没有把普通Reader称为wholeHash。
      repository.localCatalog.replaceAsset({ commandId: randomUUID(), assetId: original.asset.id, expectedLocationRevision: original.asset.locationRevision,
        expectedRootRevision: root.revision, expectedFileRevision: original.asset.fileRevision, libraryRootId: root.id, relative: name,
        sha256: observation.sha256, sampleFrames: original.asset.sampleFrames, timebaseHz: original.asset.timebaseHz });
    }); original = repository.localCatalog.privateRelocationSnapshot(track.assetId);
  }
  const channel = new MessageChannel(); cleanups.push(() => { channel.port1.close(); channel.port2.close(); });
  const actor = modules.authority.createRelocationMainActor(channel.port1);
  const api = modules.service.createLocalRelocationService({ repository, datasetId, ownerEpoch: epoch, assertCurrent() { repository.readonlySnapshotStamp(); },
    beforeMedia: () => scanner.yieldForMedia(), ...(input.now ? { now: input.now } : {}) }); cleanups.push(() => api.close()); await api.prepareRecoveryProtection();
  let sequence = 0;
  const waiting = new Map<string, { command: dto.LocalRelocationMainCommand; sequence: number; resolve(value: unknown): void; reject(error: unknown): void; timer: ReturnType<typeof setTimeout> }>();
  cleanups.push(() => { for (const pending of waiting.values()) { clearTimeout(pending.timer); pending.reject(new Error('自建Main端口已关闭。')); } waiting.clear(); });
  channel.port1.on('message', (raw: unknown) => { void (async () => {
    const request = dto.localRelocationMainRequestSnapshot(raw);
    try { const result = await api.dispatchMain(request, actor); channel.port1.postMessage(dto.localRelocationMainResponseSnapshot({ version: 1, type: 'relocation-main-response',
      requestId: request.requestId, sequence: request.sequence, ok: true, result }, request.command)); }
    catch (error) { const code = error instanceof modules.journal.LocalRelocationError ? error.code : 'IO_FAILED';
      channel.port1.postMessage({ version: 1, type: 'fixture-main-error', requestId: request.requestId, sequence: request.sequence, code }); }
  })(); });
  channel.port2.on('message', (raw: unknown) => { assert.ok(raw && typeof raw === 'object' && 'requestId' in raw && typeof raw.requestId === 'string');
    const current = waiting.get(raw.requestId); assert.ok(current); assert.ok('sequence' in raw); assert.equal(raw.sequence, current.sequence);
    waiting.delete(raw.requestId); clearTimeout(current.timer);
    if ('type' in raw && raw.type === 'fixture-main-error') { assert.ok('code' in raw); current.reject(new modules.journal.LocalRelocationError(raw.code as dto.LocalRelocationPlanIssueCode)); }
    else { const result = dto.localRelocationMainResponseSnapshot(raw, current.command); assert.equal(result.ok, true); if (result.ok) current.resolve(result.result); }
  }); channel.port1.start(); channel.port2.start();
  const main = async <C extends dto.LocalRelocationMainCommand>(command: C, payload: dto.LocalRelocationMainCommandPayloads[C]): Promise<dto.LocalRelocationMainCommandResults[C]> => {
    if (closed) throw new Error('自建真实Node Main端口已关闭。');
    const request = dto.localRelocationMainRequestSnapshot({ version: 1, type: 'relocation-main-request', requestId: randomUUID(), sequence: ++sequence, command, payload });
    return new Promise((resolve, reject) => { const timer = setTimeout(() => { waiting.delete(request.requestId); reject(new Error('自建真实Node Main端口请求超时。')); }, 30_000);
      waiting.set(request.requestId, { command, sequence: request.sequence, resolve: result => resolve(result as dto.LocalRelocationMainCommandResults[C]), reject, timer }); channel.port2.postMessage(request); });
  };
  async function plan(planId: string): Promise<dto.LocalRelocationPlan> { const result = await api.get({ datasetId, selector: { kind: 'plan', planId } });
    assert.ok(result.kind === 'plan' && result.plan); assert.ok(dto.isLocalRelocationPlan(result.plan)); return result.plan; }
  async function waitPlan(planId: string, accept: (plan: dto.LocalRelocationPlan) => boolean): Promise<dto.LocalRelocationPlan> {
    const deadline = Date.now() + 120_000;
    for (;;) { const value = await plan(planId); if (accept(value)) return value;
      assert.ok(Date.now() < deadline, `真实搬迁状态未到界：${value.state}/${value.issues.map(issue => issue.code).join(',')}`); await new Promise<void>(resolve => setTimeout(resolve, 10)); }
  }
  async function ready(intent: dto.LocalRelocationPlanIntent): Promise<dto.LocalRelocationPlan> {
    const accepted = await api.preview({ datasetId, commandId: randomUUID(), intent }); assert.equal(accepted.outcome, 'accepted'); assert.ok(accepted.planId);
    const value = await waitPlan(accepted.planId, plan => plan.state !== 'PREVIEWING'); assert.equal(value.state, 'READY', value.issues.map(issue => issue.code).join(',')); return value;
  }
  const selection = (): dto.LocalRelocationPlanSelection => { const value = repository.localCatalog.privateRelocationSnapshot(track.assetId); return { assetId: value.asset.id,
    expectedFileRevision: value.asset.fileRevision, expectedLocationRevision: value.asset.locationRevision, expectedRootRevision: value.libraryRoot.revision }; };
  const confirm = (value: dto.LocalRelocationPlan): dto.LocalRelocationPlanConfirm => ({ datasetId, commandId: randomUUID(), planId: value.planId, expectedViewRevision: value.viewRevision, domain: dto.LOCAL_RELOCATION_PLAN_DOMAIN, planHash: value.planHash, contextFingerprint: value.contextFingerprint });
  async function enable(): Promise<void> { const value = await api.get({ datasetId, selector: { kind: 'context' } }); assert.ok(value.kind === 'context');
    assert.equal(value.qualification.state, 'qualified'); const accepted = await api.setPolicy({ datasetId, commandId: randomUUID(), expectedPolicyRevision: value.policy.revision, enabled: true }); assert.equal(accepted.outcome, 'accepted'); }
  async function complete(value: dto.LocalRelocationPlan): Promise<dto.LocalRelocationPlan> { const request = confirm(value), challenge = await main('localRelocationMain.challenge', { datasetId, confirm: request });
    const accepted = await main('localRelocationMain.executeGranted', { datasetId, confirm: request, grant: challenge.grant }); assert.equal(accepted.outcome, 'accepted');
    const done = await waitPlan(value.planId, plan => ['SOURCE_RETAINED', 'COMPLETED', 'FAILED', 'RECOVERY_REQUIRED', 'DEFERRED'].includes(plan.state));
    assert.ok(done.state === 'SOURCE_RETAINED' || done.state === 'COMPLETED', done.issues.map(issue => issue.code).join(',')); return done; }
  return { modules, directory, media, destination, filePath, datasetId, epoch, repository, source, root, bytes, lyric, cue, track, original, api, main, actor, channel,
    scanner, reader, admission, initialScanJobId: initial.jobId, selection, confirm, enable, plan, waitPlan, ready, complete, close };
}
export type RelocationFixture = Awaited<ReturnType<typeof relocationFixture>>;
