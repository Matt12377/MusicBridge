import { randomUUID } from 'node:crypto';
import type { FileHandle } from 'node:fs/promises';
import * as dto from '@music-bridge/contracts';
import type { CollectionRepository } from '../collection/repository.js';
import type { ArchiveContentBinding, ArchiveContentReadSession } from './backup-package.js';
import { checkBackupRoot } from './backup-files.js';
import { archiveDigest, archiveManifest, hasArchivePhase, type OwnedArchiveOperation } from './archive-files.js';
import type { StoredArchiveOperation } from './archive-store.js';
import { executionAssetFromJob, executionManifest, executionPublicationComplete, type StoredExecutionJob } from './execution-store.js';
import { retainedRenderManifest } from './prepared-store.js';
import { parseRecordingPlan } from './plan-integrity.js';
import { mediaFingerprint } from './media-store.js';
import { inspectReadonlyPcmWave } from './execution-wave.js';
import { ExecutionCompileError } from './execution-plan.js';
import { withVerifiedReadonlySource, withVerifiedReadonlyReplicaSource, SourceFileError, type RootCapability } from './source-files.js';
import { RecordingReplicaError, replicaFail } from './replica-error.js';

export interface ReplicaVerifiedInput {
  handle: FileHandle;
  audio: dto.ReplicaAudioIdentity;
  dataOffset: number;
  inspection: dto.RecordingReplicaInspection;
  /** 合并调用方取消与输入租期/文件身份失效；provider必须监听此signal。 */
  signal: AbortSignal;
  checkOperation: () => void;
}
export interface ReplicaInput {
  inspect(request: dto.InspectRecordingReplicaRequest, signal: AbortSignal, check: () => void): Promise<dto.RecordingReplicaInspection>;
  withInput<T>(request: dto.ReplicaSelection & { expectedFingerprint: string }, signal: AbortSignal, check: () => void, consume: (input: ReplicaVerifiedInput) => Promise<T>): Promise<T>;
}
export interface ReplicaInputOptions {
  repository: CollectionRepository;
  contentBinding?: ArchiveContentBinding;
  assertCurrent?: () => void;
  preparationTimeoutMs?: number;
  finalizationTimeoutMs?: number;
  watchIntervalMs?: number;
  now?: () => number;
}
interface Capture {
  record: dto.RecordingRecord; plan: dto.RecordingPlanVersion; operation?: StoredArchiveOperation; job?: StoredExecutionJob;
  identity: dto.ReplicaHistoricalIdentity; fingerprint: string;
}
interface Location { root: RootCapability; operation: OwnedArchiveOperation; binding?: ArchiveContentReadSession; check: () => void; finalize?: (signal: AbortSignal, check: () => void) => Promise<void> }
const same = (a: unknown, b: unknown) => mediaFingerprint({ value: a }) === mediaFingerprint({ value: b });
const bounded = (n: number | undefined, maximum: number) => { const value = n ?? maximum; if (!Number.isSafeInteger(value) || value < 1 || value > maximum) return replicaFail('INVALID_REQUEST'); return value; };
function safe(error: unknown): RecordingReplicaError {
  if (error instanceof RecordingReplicaError) return error;
  if (error instanceof SourceFileError) return new RecordingReplicaError(error.code === 'REVOKED' ? 'AUTHORIZATION_REVOKED' : error.code === 'CANCELLED' ? 'CANCELLED' : error.code === 'LIMIT_EXCEEDED' ? 'TIMEOUT' : ['CONTENT_CHANGED','HASH_MISMATCH'].includes(error.code) ? 'AUDIO_CHANGED' : 'AUDIO_UNAVAILABLE');
  if (error instanceof ExecutionCompileError) return new RecordingReplicaError(['UNSUPPORTED_WAVE','CONVERSION_REQUIRED','LIMIT_EXCEEDED'].includes(error.code) ? 'UNSUPPORTED_FORMAT' : error.code === 'CANCELLED' ? 'CANCELLED' : error.code === 'INPUT_CHANGED' ? 'AUDIO_CHANGED' : 'AUDIO_UNAVAILABLE');
  return new RecordingReplicaError('AUDIO_UNAVAILABLE');
}
function issue(error: unknown): dto.ReplicaIssue {
  const value = safe(error);
  if (['CANCELLED','CLOSED','SCOPE_CHANGED','TIMEOUT'].includes(value.code)) throw value;
  if (['ARCHIVE_UNAVAILABLE','ARCHIVE_CHANGED','RESTORE_UNAVAILABLE','AUTHORIZATION_REVOKED','AUDIO_UNAVAILABLE','AUDIO_CHANGED','UNSUPPORTED_FORMAT','IDENTITY_MISMATCH','DEPENDENCY_UNAVAILABLE','DURATION_LIMIT'].includes(value.code)) return value.code as dto.ReplicaIssue;
  return 'AUDIO_UNAVAILABLE';
}

/** 历史Record只读解析；不引用当前Session、预留或原工作目录，不创建任何业务记录。 */
export function createRecordingReplicaInput(options: ReplicaInputOptions): ReplicaInput {
  const { repository, contentBinding } = options, preparationMs = bounded(options.preparationTimeoutMs, 15 * 60_000), finalizationMs = bounded(options.finalizationTimeoutMs, 15 * 60_000), watchMs = bounded(options.watchIntervalMs, 1000), now = options.now ?? (() => performance.now());
  const scope = () => { try { options.assertCurrent?.(); } catch { return replicaFail('SCOPE_CHANGED'); } };
  function capture(recordingId: string): Capture {
    scope(); if (!dto.isCollectionId(recordingId)) return replicaFail('INVALID_REQUEST');
    return repository.recordingRecords.read(db => {
      const record = repository.recordingRecords.record(db, recordingId); if (!record) return replicaFail('NOT_FOUND');
      const row = db.prepare('SELECT data FROM recording_plan_versions WHERE id=?').get(record.completion.planVersionId);
      if (!row) return replicaFail('IDENTITY_MISMATCH');
      const plan = parseRecordingPlan(row.data);
      if (plan.contentHash !== record.completion.planContentHash || plan.execution.assetId !== record.completion.executionAssetId) return replicaFail('IDENTITY_MISMATCH');
      const operation = repository.archive.operation(plan.archive.operationId), job = repository.execution.job(plan.execution.assetId);
      const identity: dto.ReplicaHistoricalIdentity = { recordingId, recordingContentHash: record.contentHash, planVersionId: plan.id, planContentHash: plan.contentHash, archiveOperationId: plan.archive.operationId, archiveManifestHash: plan.archive.manifestHash };
      return { record, plan, ...(operation ? { operation } : {}), ...(job ? { job } : {}), identity, fingerprint: mediaFingerprint({ identity, operation, job }) };
    });
  }
  function expectedManifest(c: Capture): Array<{ name: string; bytes: Buffer }> {
    const job = c.job;
    if (!job || job.public.state !== 'completed' || !executionPublicationComplete(job)) return replicaFail('DEPENDENCY_UNAVAILABLE');
    const asset = executionAssetFromJob(job), p = c.plan;
    if (!same(job.input.master, p.master) || !same(job.input.layout, p.layout) || !same(job.input.retained?.prepared, p.prepared)
      || asset.id !== p.execution.assetId || asset.manifestHash !== p.execution.manifestHash || asset.mode !== p.execution.mode
      || !same(asset.settings, p.execution.compiledSettings) || !same(asset.recipes, p.execution.recipes) || !same(asset.audio, p.execution.audio)) return replicaFail('IDENTITY_MISMATCH');
    const result = [{ name: 'ExecutionManifest.json', bytes: executionManifest(job) }];
    const retained = job.input.retained;
    if (retained) {
      const prep = retained.prepared;
      const bytes = retainedRenderManifest({ operationId: prep.importJobId, preparationId: prep.preparationId, masterVersionId: prep.masterVersionId, layoutVersionId: prep.layoutVersionId, contentHash: prep.contentHash, plannedTimelineHash: prep.plannedTimelineHash, assets: prep.assets, files: retained.files });
      if (archiveDigest(bytes) !== retained.manifestHash) return replicaFail('IDENTITY_MISMATCH');
      result.push({ name: 'RawRenderManifest.json', bytes });
    }
    result.push({ name: 'FrozenFacts.json', bytes: Buffer.from(JSON.stringify({ schemaVersion: 1, kind: 'execution-archive-facts', master: job.input.master, layout: job.input.layout, execution: asset, ...(retained ? { prepared: retained.prepared } : {}), sourcePolicy: p.archive.sourcePolicy, retentionPolicy: 'unresolved-no-automatic-deletion', formalReady: false }, null, 2) + '\n') });
    return result;
  }
  async function locate(c: Capture, signal: AbortSignal, check: () => void): Promise<Location> {
    check(); const stored = c.operation, op = stored?.owned;
    if (!stored || stored.phase !== 'FINALIZED' || stored.issue || !op) return replicaFail('ARCHIVE_UNAVAILABLE');
    if (op.id !== c.plan.archive.operationId || op.archive.id !== c.plan.archive.rootId || archiveDigest(op.manifest) !== c.plan.archive.manifestHash
      || archiveManifest(op.id, op.files, op.lineage) !== op.manifest || !same(op.lineage, { masterVersionId: c.plan.master.id, layoutVersionId: c.plan.layout.id, executionAssetId: c.plan.execution.assetId })) return replicaFail('ARCHIVE_CHANGED');
    let binding: ArchiveContentReadSession | undefined, root: RootCapability;
    if (contentBinding) {
      try { binding = await contentBinding.open(signal); check(); const resolved = binding.resolve(op); if (!resolved) return replicaFail('RESTORE_UNAVAILABLE'); root = resolved; }
      catch (error) { check(); if (error instanceof RecordingReplicaError) throw error; return replicaFail('RESTORE_UNAVAILABLE'); }
    } else {
      try { const live = repository.archive.root(op.archive.id); if (!same(live, op.archive)) return replicaFail('ARCHIVE_CHANGED'); if (!await hasArchivePhase(op, 'FINALIZED')) return replicaFail('ARCHIVE_UNAVAILABLE'); root = live.objects; }
      catch (error) { check(); if (error instanceof RecordingReplicaError) throw error; return replicaFail('ARCHIVE_UNAVAILABLE'); }
    }
    const liveCheck = () => {
      check();
      if (capture(c.identity.recordingId).fingerprint !== c.fingerprint) return replicaFail('IDENTITY_MISMATCH');
      try { if (binding ? !same(binding.resolve(op), root) : !same(repository.archive.root(op.archive.id), op.archive)) return replicaFail('AUTHORIZATION_REVOKED'); }
      catch { return replicaFail('AUTHORIZATION_REVOKED'); }
    };
    liveCheck(); await checkBackupRoot(root); liveCheck();
    for (const manifest of expectedManifest(c)) {
      const role = manifest.name === 'FrozenFacts.json' ? 'metadata' : 'manifest', hash = archiveDigest(manifest.bytes);
      const matches = op.files.filter(f => f.role === role && f.name === manifest.name && f.sha256 === hash && f.size === manifest.bytes.length && f.media === 'json');
      if (matches.length !== 1 || manifest.bytes.length > 4 * 1024 * 1024) return replicaFail('ARCHIVE_CHANGED');
      await withVerifiedReadonlySource(root, hash, matches[0]!, signal, async (handle, fileCheck) => {
        const bytes = Buffer.alloc(manifest.bytes.length); let offset = 0;
        while (offset < bytes.length) { liveCheck(); fileCheck(); const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset); if (!bytesRead) return replicaFail('ARCHIVE_CHANGED'); offset += bytesRead; }
        if (!bytes.equals(manifest.bytes)) return replicaFail('ARCHIVE_CHANGED');
      }, liveCheck);
    }
    liveCheck(); return { root, operation: op, ...(binding ? { binding } : {}), check: liveCheck };
  }
  function selected(c: Capture, target: dto.ReplicaTarget, side: dto.RenderSide) {
    if (!c.plan.layout.timeline.sides.some(s => s.name === side)) return replicaFail('INVALID_REQUEST');
    if (target === 'actual-execution') {
      const audio = c.plan.execution.audio.filter(a => a.recipe.side === side);
      if (audio.length !== 1) return replicaFail('INPUT_UNAVAILABLE'); const receipt = audio[0]!;
      return { receipt, expected: receipt.audio, rate: receipt.recipe.format.sampleRate, channels: receipt.recipe.format.channelCount,
        name: `${side}.${receipt.origin === 'retained-render' ? 'reference' : receipt.origin === 'derived-render' ? 'derivative' : 'execution'}.wav`, role: 'execution-audio' as const };
    }
    const prepared = c.plan.prepared, audio = prepared?.assets.filter(a => a.side === side);
    if (!prepared || audio?.length !== 1) return replicaFail('INPUT_UNAVAILABLE'); const raw = audio[0]!;
    return { raw, prepared, expected: { sha256: raw.sha256, size: raw.size, frameCount: raw.totalFrames }, rate: raw.sampleRate, channels: raw.channelLayout === 'mono' ? 1 : 2, name: `${side}.wav`, role: 'raw-render' as const };
  }
  async function readSelected<T>(c: Capture, location: Location, target: dto.ReplicaTarget, side: dto.RenderSide, signal: AbortSignal, consume: (handle: FileHandle, audio: dto.ReplicaAudioIdentity, dataOffset: number, check: () => void, signal: AbortSignal) => Promise<T>): Promise<T> {
    const item = selected(c, target, side), duration = Number((BigInt(item.expected.frameCount) * 1000n + BigInt(item.rate) - 1n) / BigInt(item.rate));
    if (!Number.isSafeInteger(duration) || duration < 1 || duration > dto.MAX_RECORDING_REPLICA_DURATION_MS) return replicaFail('DURATION_LIMIT');
    const matches = location.operation.files.filter(f => f.role === item.role && f.name === item.name && f.media === 'audio' && f.sha256 === item.expected.sha256 && f.size === item.expected.size);
    if (matches.length !== 1) return replicaFail('ARCHIVE_CHANGED');
    let verifiedAudio: dto.ReplicaAudioIdentity | undefined, dataOffset = 0;
    const verify = async (handle: FileHandle, check: () => void, leaseSignal: AbortSignal) => {
      const actual = await inspectReadonlyPcmWave(handle, leaseSignal, check);
      if (actual.audio.sha256 !== item.expected.sha256 || actual.audio.size !== item.expected.size || actual.audio.frameCount !== item.expected.frameCount || actual.format.sampleRate !== item.rate || actual.format.channelCount !== item.channels) return replicaFail('AUDIO_CHANGED');
      const base = { fileSha256: actual.audio.sha256, size: actual.audio.size, frameCount: actual.audio.frameCount, pcmSha256: actual.audio.pcmSha256, format: { container: 'wav' as const, ...actual.format } };
      let audio: dto.ReplicaAudioIdentity;
      if (item.receipt) {
        if (!same(actual.audio, item.receipt.audio) || actual.format.sampleFormat !== item.receipt.recipe.format.outputSampleFormat) return replicaFail('AUDIO_CHANGED');
        audio = { ...base, target: 'actual-execution', executionAssetId: c.plan.execution.assetId, recipeHash: item.receipt.recipeHash, pcmHashEvidence: 'frozen-execution' };
      } else audio = { ...base, target: 'original-render', preparedVersionId: item.prepared.id, renderAssetId: item.raw.id, pcmHashEvidence: 'verified-render-bytes' };
      if (!dto.isReplicaAudioIdentity(audio)) return replicaFail('UNSUPPORTED_FORMAT'); check();
      verifiedAudio = audio; dataOffset = actual.audio.dataOffset;
    };
    return withVerifiedReadonlyReplicaSource(location.root, item.expected.sha256, item.expected, signal,
      (handle, check, leaseSignal) => consume(handle, verifiedAudio!, dataOffset, check, leaseSignal), location.check,
      { durationMs: duration, preparationTimeoutMs: preparationMs, finalizationTimeoutMs: finalizationMs, watchIntervalMs: watchMs, now, verify,
        finalize: async (_handle, check, leaseSignal) => { await location.finalize?.(leaseSignal, check); } });
  }
  async function inspectInternal(request: dto.InspectRecordingReplicaRequest, signal: AbortSignal, check: () => void) {
    check(); const c = capture(request.recordingId), targets: dto.ReplicaTargetView[] = [];
    let location: Location | undefined, unavailable: dto.ReplicaIssue | undefined;
    try { location = await locate(c, signal, check); } catch (error) { check(); unavailable = issue(error); }
    for (const target of ['actual-execution', ...(c.plan.prepared ? ['original-render'] : [])] as dto.ReplicaTarget[]) {
      for (const side of c.plan.layout.timeline.sides) {
        check();
        if (!side.totalFrames) { targets.push({ target, side: side.name, state: 'empty', frameCount: 0 }); continue; }
        if (!location) { targets.push({ target, side: side.name, state: 'unavailable', reason: unavailable! }); continue; }
        try { const audio = await readSelected(c, location, target, side.name, signal, async (_handle, audio) => audio); targets.push({ target, side: side.name, state: 'verified', audio }); }
        catch (error) { check(); targets.push({ target, side: side.name, state: 'unavailable', reason: issue(error) }); }
      }
    }
    if (location) {
      try {
        await location.binding?.verify(signal);
        // 纯核验也必须末读磁盘owner/FINALIZED/Manifest，不能以DB/root授权检查替代。
        const finalLocation = await locate(c, signal, check);
        if (!same(finalLocation.root, location.root)) return replicaFail('IDENTITY_MISMATCH');
        finalLocation.check();
      } catch (error) { check(); throw safe(error); }
    }
    check(); const fingerprint = mediaFingerprint({ capture: c.fingerprint, root: location?.root, restored: !!contentBinding, targets });
    const inspection: dto.RecordingReplicaInspection = { ...c.identity, ...request, checkedAt: new Date().toISOString(), fingerprint, targets, playback: 'blocked', deviceOpened: false, formalReady: false, gateB: 'NOT_RUN' };
    if (!dto.isRecordingReplicaInspection(inspection)) return replicaFail('IDENTITY_MISMATCH');
    return { inspection, capture: c, location };
  }
  async function phase<T>(signal: AbortSignal, check: () => void, ms: number, action: (signal: AbortSignal, check: () => void) => Promise<T>): Promise<T> {
    const controller = new AbortController(), deadline = now() + ms;
    const abort = () => controller.abort(signal.reason instanceof RecordingReplicaError ? signal.reason : new RecordingReplicaError('CANCELLED'));
    signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
    const checked = () => { if (controller.signal.aborted) throw controller.signal.reason; scope(); check(); if (now() > deadline) return replicaFail('TIMEOUT'); };
    const timer = setTimeout(() => controller.abort(new RecordingReplicaError('TIMEOUT')), ms);
    try { checked(); const result = await action(controller.signal, checked); checked(); return result; } catch (error) { checked(); throw safe(error); }
    finally { clearTimeout(timer); signal.removeEventListener('abort', abort); }
  }
  return {
    async inspect(request, signal, check) {
      if (!dto.isInspectRecordingReplicaRequest(request)) return replicaFail('INVALID_REQUEST');
      return phase(signal, check, preparationMs, async (signal, check) => (await inspectInternal(structuredClone(request), signal, check)).inspection);
    },
    async withInput(request, signal, check, consume) {
      if (!dto.isCollectionId(request.recordingId) || !['actual-execution','original-render'].includes(request.target) || !dto.isRenderSide(request.side) || !/^[a-f0-9]{64}$/u.test(request.expectedFingerprint)) return replicaFail('INVALID_REQUEST');
      const capturedRequest = structuredClone(request), preparationDeadline = now() + preparationMs;
      let consuming = false;
      const inspected = await phase(signal, check, preparationMs, async (signal, check) => inspectInternal({ readId: randomUUID(), recordingId: capturedRequest.recordingId }, signal, check));
      if (inspected.inspection.fingerprint !== capturedRequest.expectedFingerprint) return replicaFail('IDENTITY_MISMATCH');
      const target = inspected.inspection.targets.find(t => t.target === capturedRequest.target && t.side === capturedRequest.side);
      if (!target || target.state !== 'verified' || !inspected.location) return replicaFail('INPUT_UNAVAILABLE');
      // 准备阶段signal只用于准备，长期消费必须回到调用方信号；实时授权闭包仍持续重读。
      const location = inspected.location;
      const live = () => { scope(); check(); if (!consuming && now() > preparationDeadline) return replicaFail('TIMEOUT'); if (signal.aborted) throw signal.reason instanceof RecordingReplicaError ? signal.reason : new RecordingReplicaError('CANCELLED');
        if (capture(capturedRequest.recordingId).fingerprint !== inspected.capture.fingerprint) return replicaFail('IDENTITY_MISMATCH');
        try { if (location.binding ? !same(location.binding.resolve(location.operation), location.root) : !same(repository.archive.root(location.operation.archive.id), location.operation.archive)) return replicaFail('AUTHORIZATION_REVOKED'); } catch { return replicaFail('AUTHORIZATION_REVOKED'); }
      };
      const longLocation: Location = { ...location, check: live, finalize: async (signal, checked) => {
        // 音频FD尚未释放时重核归档owner/FINALIZED/清单或恢复绑定，不能只验音频字节。
        const finalLocation = await locate(inspected.capture, signal, checked);
        if (!same(finalLocation.root, location.root)) return replicaFail('IDENTITY_MISMATCH');
        live(); checked();
      } };
      try {
        const result = await readSelected(inspected.capture, longLocation, capturedRequest.target, capturedRequest.side, signal, async (handle, audio, dataOffset, checked, leaseSignal) => {
          if (!same(audio, target.audio)) return replicaFail('AUDIO_CHANGED');
          consuming = true;
          return consume({ handle, audio, dataOffset, inspection: inspected.inspection, signal: leaseSignal, checkOperation: checked });
        });
        live(); return result;
      } catch (error) { throw safe(error); }
    },
  };
}
