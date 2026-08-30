import { AudioConversionError, type FfmpegConverter } from './audio-converter.js';
import { isAudioConversionSource, executionFrameLimit, executionReferencedBytes, type AudioConversionSource, type ResolvedRecordingSettings } from '@music-bridge/contracts';
import type { ConvertedSourceLocation } from './converted-compiler.js';
import path from 'node:path';
import { statfs } from 'node:fs/promises';
import { isCollectionId, isSourceAction, isPreviewExecutionRequest, isStartExecutionRequest, isExecutionProposal, executionAudioSize, type ExecutionSelection, type PreviewExecutionRequest, type StartExecutionRequest, type ExecutionJob, type ExecutionProposal, type ExecutionAssetCheck, type ExecutionPcmInput } from '@music-bridge/contracts';
import { BridgeError } from '../shared/errors.js';
import type { RecordingProfilesStore } from './profile-store.js';
import { executionManifest, executionManifestHash, executionPublicationComplete, type ExecutionStore, type ExecutionInput, type StoredExecutionJob } from './execution-store.js';
import type { PreparationStore } from './preparation-store.js';
import type { PreparedStore } from './prepared-store.js';
import type { PreparationCoordinator } from './preparation-coordinator.js';
import type { MediaPlanningStore } from './media-store.js';
import type { SourceStore } from './source-store.js';
import type { SourceEvidenceService } from './source-evidence.js';
import { mediaFingerprint } from './media-store.js';
import { planDirectExecution, planPreparedExecution, planConvertedDirectExecution, planPreparedDerivative, requireCopyFormat, ExecutionCompileError } from './execution-plan.js';
import { verifyPreparedPcm } from './execution-compiler.js';
import { readPcmWave, assertPcmInput } from './execution-wave.js';
import { withVerifiedReadonlySource, probeReadonlySource, SourceFileError } from './source-files.js';
import { authorizePreparationDestination, assertPreparationOutsideSources, createPreparationDirectory, compileExecutionFile, convertExecutionSourceFile, compileConvertedExecutionFile, convertPreparedExecutionFile, publishPreparation, verifyPublishedPreparation, PreparationFileError } from './preparation-files.js';

const invalid = (message = '执行输入或参数已改变，请重新预览并确认。'): never => { throw new BridgeError('BAD_REQUEST', message, { httpStatus: 400 }); };
class ExecutionStateError extends Error { constructor(readonly failure: NonNullable<ExecutionJob['failure']>) { super(failure); } }
interface Dependencies { store: ExecutionStore; profiles: RecordingProfilesStore; preparationStore: PreparationStore; preparedStore: PreparedStore; mediaStore: MediaPlanningStore; sourceStore: SourceStore; sources: SourceEvidenceService; preparation: PreparationCoordinator; compile?: typeof compileExecutionFile; afterPublish?: () => Promise<void>; operationTimeoutMs?: number; converter?: FfmpegConverter }
type InputContext = Omit<ExecutionInput, 'proposal'> & { settings: ResolvedRecordingSettings };
type OperationContext = Pick<ExecutionInput, 'destination' | 'sources' | 'retained'>;
interface Operation { controller: AbortController; destinations: readonly string[]; roots: readonly string[]; finish(): void }
export function createExecutionCoordinator({ store, profiles, preparationStore, preparedStore, mediaStore, sourceStore, sources, preparation, compile = compileExecutionFile, afterPublish, converter, operationTimeoutMs = 30 * 60_000 }: Dependencies) {
  if (!Number.isSafeInteger(operationTimeoutMs) || operationTimeoutMs < 1 || operationTimeoutMs > 30 * 60_000) return invalid('执行期限无效。');
  let closed = false, recoveryError: unknown;
  const active = new Map<string, Operation & { promise: Promise<void> }>(), reads = new Map<string, Operation & { promise: Promise<unknown> }>(), recoveries = new Map<string, Operation>();
  const cancelledReads = new Set<string>(), pendingFailures = new Map<string, ExecutionJob['failure']>();
  function flushFailures(): void { for (const [id, failure] of pendingFailures) { store.fail(id, failure); pendingFailures.delete(id); } }
  const unroot = sources.onRootRevoked(id => { for (const operation of [...active.values(), ...reads.values()]) if (operation.roots.includes(id)) operation.controller.abort('SOURCE_REVOKED'); });
  const undestination = preparation.onDestinationRevoked(id => { for (const operation of [...active.values(), ...reads.values(), ...recoveries.values()]) if (operation.destinations.includes(id)) operation.controller.abort('DESTINATION_REVOKED'); });
  function operation(input: OperationContext): Operation { const controller = new AbortController(), timer = setTimeout(() => controller.abort('TIME_LIMIT'), operationTimeoutMs); return { controller, finish: () => clearTimeout(timer), roots: input.sources.map(s => s.root.id), destinations: [input.destination.id, ...(input.retained ? [input.retained.owned.destination.id] : [])] }; }
  function permissions(input: OperationContext, includeSources: boolean, signal: AbortSignal): void {
    signal.throwIfAborted(); if (closed) return invalid('执行服务已关闭。');
    for (const id of [input.destination.id, ...(input.retained ? [input.retained.owned.destination.id] : [])]) if (!preparationStore.destination(id).authorized) throw new ExecutionStateError('DESTINATION_INVALID');
    if (includeSources && input.sources.some(s => !sourceStore.root(s.root.id).authorized)) throw new ExecutionStateError('SOURCE_INVALID');
    assertPreparationOutsideSources([input.destination.path], sourceStore.roots());
  }
  async function destinationCheck(input: ExecutionInput, signal: AbortSignal): Promise<void> {
    permissions(input, true, signal);
    const actual = await authorizePreparationDestination(input.destination.path, sourceStore.roots());
    if (actual.dev !== input.destination.dev || actual.ino !== input.destination.ino) throw new ExecutionStateError('DESTINATION_INVALID');
    const info = await statfs(input.destination.path, { bigint: true });
    if (info.bavail * info.bsize < BigInt(input.proposal.audioBytesToWrite) + 4n * 1024n * 1024n) throw new ExecutionStateError('DISK_FULL');
    permissions(input, true, signal);
  }
  function backend(): FfmpegConverter { if (!converter) return invalid('尚未配置已核定的固定转换器；不会自动启用系统 FFmpeg。'); return converter; }
  function context(selection: ExecutionSelection): InputContext {
    if (selection.mode === 'direct-converted' || selection.mode === 'prepared-derivative') backend();
    const { master, layout } = preparationStore.frozen(selection.layoutVersionId), destination = preparationStore.destination(selection.destinationId), session = profiles.session(master.draftId).session;
    if (!session || session.revision !== selection.sessionRevision) return invalid('请先确认本次录音参数，参数修订改变后需要重新预览。');
    const settings = profiles.resolve(session), compatibility = settings.profile.content.compatibility, currentPlan = mediaStore.detail(layout.planId), stock = mediaStore.reservationStock(layout.reservation);
    if (!destination.authorized || !stock || !currentPlan.reservation || mediaFingerprint(currentPlan.reservation) !== mediaFingerprint(layout.reservation) || stock.lengthMinutes !== layout.lengthMinutes || !compatibility.confirmed || (layout.spec.format === 'dat' ? !compatibility.dat : !compatibility.cassetteTypes.some(t => t === stock.model.tapeType))) return invalid('介质预留或 Profile 兼容性需要重新确认。');
    let retained: ExecutionInput['retained']; const locations: ExecutionInput['sources'][number][] = [];
    if (selection.mode === 'direct' || selection.mode === 'direct-converted') {
      for (const source of master.sourceEvidence) {
        const binding = sourceStore.binding(source.binding.id), content = master.content.tracks.find(t => t.trackId === source.trackId)!;
        if (!binding.userConfirmed || binding.invalidated || binding.evidence.sha256 !== content.source.sha256 || binding.evidence.size !== content.source.size || mediaFingerprint(binding.evidence.technical) !== mediaFingerprint(content.source.technical)) throw new SourceFileError('CONTENT_CHANGED');
        locations.push({ trackId: source.trackId, root: sourceStore.root(binding.rootId), relative: binding.relative });
      }
    } else {
      const prepared = preparedStore.list(master.draftId).preps.find(p => p.id === selection.preparedVersionId), imported = prepared ? preparedStore.job(prepared.importJobId) : undefined;
      if (!prepared || !imported?.owned || imported.public.state !== 'completed' || !imported.manifestHash || imported.owned.purpose !== 'raw-render') return invalid('请先选择已冻结且有原始 Render 保留副本的 PREP。');
      retained = { prepared, owned: imported.owned, files: imported.files, manifestHash: imported.manifestHash, locations: prepared.assets.map(a => ({ renderAssetId: a.id, root: imported.owned!.root, relative: `Originals/${a.side}.wav` })) };
    }
    return { master, layout, destination, session, settings, sources: locations, ...(retained ? { retained } : {}) };
  }
  async function input(selection: ExecutionSelection, captured: InputContext, signal: AbortSignal): Promise<ExecutionInput> {
    const {master,layout,destination,session,settings,sources:locations,retained}=captured;
    permissions(captured,true,signal); let recipes: ExecutionProposal['recipes'];
    if (selection.mode === 'direct') recipes=planDirectExecution(master,layout,settings.format);
    else if (selection.mode === 'direct-converted') recipes=planConvertedDirectExecution(master,layout,settings.format,backend().plan);
    else if (selection.mode === 'prepared-reference') {
      const bits=requireCopyFormat(settings.format) as 16|24|32, prep=retained!.prepared;
      // V1 候选位深仍须由后续 readPcmWave 核对；V2 从原 Render 文件探测。
      const inputs=prep.assets.map(a=>({assetId:a.id,input:{sha256:a.sha256,size:a.size,sampleRate:a.sampleRate,channelCount:(a.channelLayout==='mono'?1:2) as 1|2,bitsPerSample:bits,totalFrames:a.totalFrames} satisfies ExecutionPcmInput}));
      recipes=planPreparedExecution(master,layout,prep,settings.format,inputs);
    } else {
      const original=retained!;
      if (!await verifyPublishedPreparation(original.owned,original.files,original.manifestHash,signal)) throw new ExecutionStateError('ASSET_INVALID');
      const inputs: {assetId:string;source:AudioConversionSource}[]=[];
      for (const location of original.locations) {
        permissions(captured,false,signal);
        const evidence=await probeReadonlySource(location.root,location.relative,signal);
        const source={sha256:evidence.sha256,size:evidence.size,technical:evidence.technical};
        if (!isAudioConversionSource(source)) throw new ExecutionStateError('ASSET_INVALID');
        inputs.push({assetId:location.renderAssetId,source});
      }
      recipes=planPreparedDerivative(master,layout,original.prepared,settings.format,inputs,backend().plan);
    }
    permissions(captured,true,signal);
    const proposal:ExecutionProposal={...selection,draftId:master.draftId,masterVersionId:master.id,settings,recipes,destinationLabel:destination.label,audioBytesToWrite:selection.mode==='prepared-reference'?0:recipes.reduce((n,r)=>n+executionAudioSize(r),0),referencedAudioBytes:recipes.reduce((n,r)=>n+executionReferencedBytes(r),0),proposalFingerprint:'',retentionPolicy:'unresolved-no-automatic-deletion',formalReady:false};
    const result:ExecutionInput={master,layout,destination,session,proposal,sources:locations,...(retained?{retained}:{})};
    proposal.proposalFingerprint=mediaFingerprint(result);
    if (!isExecutionProposal(proposal) || mediaFingerprint(context(selection))!==mediaFingerprint(captured)) return invalid();
    return result;
  }
  function publicError(error: unknown): never {
    if (error instanceof AudioConversionError) return invalid('固定转换器或输入转换校验未通过，请检查构建配置和源格式。');
    if (error instanceof ExecutionCompileError) return invalid(error.code === 'CONVERSION_REQUIRED' ? '此路径需要与输入一致的整数 PCM；需要转换时请明确选择转换执行。' : '音频规格或完整性核验未通过，请重新检查输入。');
    if (error instanceof SourceFileError) return invalid('源文件不可用或内容已改变，请重新核验。');
    if (error instanceof PreparationFileError || error instanceof ExecutionStateError) return invalid('目标授权、容量或保留文件已失效，请重新检查。');
    throw error;
  }
  function publicContext(selection: ExecutionSelection): InputContext { try { return context(selection); } catch (error) { return publicError(error); } }
  async function retainedCheck(value: ExecutionInput, signal: AbortSignal): Promise<void> {
    if (!value.retained) return;
    permissions(value, false, signal); const retained = value.retained;
    if (!await verifyPublishedPreparation(retained.owned, retained.files, retained.manifestHash, signal)) throw new ExecutionStateError('ASSET_INVALID');
    for (const recipe of value.proposal.recipes.filter(r => executionFrameLimit(r) > 0)) {
      const first = recipe.segments[0]; if (first?.kind !== 'render') throw new ExecutionStateError('ASSET_INVALID');
      const location = retained.locations.find(l => l.renderAssetId === first.renderAssetId); if (!location) throw new ExecutionStateError('ASSET_INVALID');
      if (recipe.schemaVersion === 1) await verifyPreparedPcm(recipe, location, signal);
      else { const segment=recipe.segments[0]; if(segment?.kind!=='render') throw new ExecutionStateError('ASSET_INVALID'); await withVerifiedReadonlySource(location.root,location.relative,segment.conversion.input,signal,async()=>undefined); }
      permissions(value, false, signal);
    }
  }
  async function previewCheck(value: ExecutionInput, signal: AbortSignal): Promise<void> {
    await destinationCheck(value, signal);
    if (value.retained) await retainedCheck(value, signal);
    else for (const recipe of value.proposal.recipes) {
      if (recipe.schemaVersion === 1) { for (const segment of recipe.segments) if (segment.kind === 'source') {
        const location=value.sources.find(s=>s.trackId===segment.trackId)!;
        await withVerifiedReadonlySource(location.root,location.relative,segment.input,signal,async(handle,check)=>{const wave=await readPcmWave(handle,segment.input.size,check);assertPcmInput(wave,segment.input);});
      } } else { for (const segment of recipe.segments) if (segment.kind === 'source') {
        const location=value.sources.find(s=>s.trackId===segment.trackId)!;
        await withVerifiedReadonlySource(location.root,location.relative,segment.conversion.input,signal,async()=>undefined);
      } }
      permissions(value,true,signal);
    }
  }

  async function verifyPublished(job: StoredExecutionJob, signal: AbortSignal): Promise<boolean> {
    permissions(job.input, false, signal);
    if (!executionPublicationComplete(job) || !await verifyPublishedPreparation(job.owned!, job.files, job.manifestHash!, signal)) return false;
    await retainedCheck(job.input, signal); permissions(job.input, false, signal); return true;
  }
  const recovered = (async () => {
    for (const pending of store.pending()) {
      if (closed) return; store.fail(pending.public.id);
      const op = operation(pending.input); recoveries.set(pending.public.id, op);
      try {
        // 不重读 Direct 的用户源文件，不重编译；仅补交完整且仍获授权的已发布资产。
        if (await verifyPublished(pending, op.controller.signal) && !closed && !op.controller.signal.aborted) store.finish(pending.public.id);
      } catch (error) { if (!(error instanceof ExecutionStateError || error instanceof PreparationFileError || error instanceof SourceFileError) && !op.controller.signal.aborted) throw error; }
      finally { op.finish(); recoveries.delete(pending.public.id); }
    }
  })().catch(error => { recoveryError = error; });
  async function ready(): Promise<void> { await recovered; if (recoveryError) throw recoveryError; if (closed) return invalid('执行服务已关闭。'); flushFailures(); }
  async function read<T>(id: string, value: OperationContext, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (!isCollectionId(id) || reads.has(id) || reads.size >= 2 || cancelledReads.delete(id)) return invalid('读取已取消或已有两项核验，请稍后重试。');
    const op = operation(value), promise = fn(op.controller.signal); reads.set(id, { ...op, promise });
    try { return await promise; } finally { op.finish(); reads.delete(id); }
  }
  function failure(error: unknown, op: Operation, published: boolean): ExecutionJob['failure'] {
    if (op.controller.signal.reason === 'TIME_LIMIT') return 'IO_ERROR';
    if (op.controller.signal.reason === 'DESTINATION_REVOKED') return 'DESTINATION_INVALID';
    if (op.controller.signal.reason === 'SOURCE_REVOKED') return 'SOURCE_INVALID';
    if (op.controller.signal.aborted) return 'CANCELLED';
    if (error instanceof ExecutionStateError) return error.failure;
    if (error instanceof PreparationFileError) return 'DESTINATION_INVALID';
    if (error instanceof SourceFileError) return 'SOURCE_INVALID';
    if (error instanceof AudioConversionError) return error.code === 'DISK_FULL' ? 'DISK_FULL' : error.code === 'CANCELLED' ? 'CANCELLED' : ['INPUT_CHANGED','HASH_MISMATCH'].includes(error.code) ? 'INPUT_CHANGED' : ['BACKEND_UNAVAILABLE','BACKEND_CHANGED','UNSUPPORTED_CONVERSION'].includes(error.code) ? 'CONVERSION_REQUIRED' : 'SOURCE_INVALID';
    if (error instanceof ExecutionCompileError) return error.code === 'DISK_FULL' ? 'DISK_FULL' : error.code === 'CONVERSION_REQUIRED' ? 'CONVERSION_REQUIRED' : ['INPUT_CHANGED','HASH_MISMATCH'].includes(error.code) ? 'INPUT_CHANGED' : error.code === 'IO_ERROR' ? 'IO_ERROR' : 'SOURCE_INVALID';
    if (error instanceof Error && 'code' in error && error.code === 'ENOSPC') return 'DISK_FULL';
    return published ? undefined : 'IO_ERROR';
  }
  function launch(job: StoredExecutionJob): ExecutionJob {
    const op = operation(job.input), signal = op.controller.signal;
    const promise = (async () => {
      let published = false;
      try {
        await previewCheck(job.input, signal); permissions(job.input, true, signal);
        const owned = await createPreparationDirectory(job.input.destination, job.public.id, job.input.layout.spec.format, 'execution');
        let progress = store.update(job.public.id, { owned });
        for (const recipe of job.input.proposal.recipes.filter(r => executionFrameLimit(r) > 0)) {
          permissions(job.input, true, signal);
          if (recipe.schemaVersion === 2) {
            const check=()=>permissions(job.input,true,signal);
            if (recipe.mode === 'direct') {
              const converted:ConvertedSourceLocation[]=[];
              for (const segment of recipe.segments) if (segment.kind === 'source') {
                const location=job.input.sources.find(s=>s.trackId===segment.trackId)!;
                const result=await convertExecutionSourceFile(owned,segment.trackId,segment.conversion,location,backend(),signal,check);
                check();progress=store.update(job.public.id,{files:[...progress.files,result.file]});
                converted.push({trackId:segment.trackId,root:owned.root,relative:result.file.relative,receipt:result.receipt});
              }
              const result=await compileConvertedExecutionFile(owned,recipe,converted,signal,check);
              check();progress=store.update(job.public.id,{files:[...progress.files,result.file],audio:[...progress.audio,result.receipt]});
            } else {
              const segment=recipe.segments[0];if(segment?.kind!=='render') throw new ExecutionStateError('ASSET_INVALID');
              const location=job.input.retained!.locations.find(l=>l.renderAssetId===segment.renderAssetId)!;
              const result=await convertPreparedExecutionFile(owned,recipe,location,backend(),signal,check);
              check();progress=store.update(job.public.id,{files:[...progress.files,result.file],audio:[...progress.audio,result.receipt]});
            }
          } else if (recipe.mode === 'direct') {
            const ids = recipe.segments.filter(s => s.kind === 'source').map(s => s.trackId);
            const result = await compile(owned, recipe, job.input.sources.filter(s => ids.includes(s.trackId)), signal);
            permissions(job.input, true, signal); progress = store.update(job.public.id, { files: [...progress.files, result.file], audio: [...progress.audio, result.receipt] });
          } else {
            const segment = recipe.segments[0]; if (segment?.kind !== 'render') throw new ExecutionStateError('ASSET_INVALID');
            const location = job.input.retained!.locations.find(l => l.renderAssetId === segment.renderAssetId)!;
            const receipt = await verifyPreparedPcm(recipe, location, signal); permissions(job.input, false, signal); progress = store.update(job.public.id, { audio: [...progress.audio, receipt] });
          }
        }
        permissions(job.input, true, signal);
        progress = store.update(job.public.id, { manifestHash: executionManifestHash(progress) });
        await publishPreparation(owned, progress.files, executionManifest(progress), signal); published = true;
        await afterPublish?.(); permissions(job.input, true, signal);
        if (!await verifyPublished(progress, signal)) throw new ExecutionStateError('ASSET_INVALID');
        permissions(job.input, true, signal); store.finish(job.public.id);
      } catch (error) { if (!closed) { const reason = failure(error, op, published); try { store.fail(job.public.id, reason); } catch { pendingFailures.set(job.public.id, reason); } } }
      finally { op.finish(); active.delete(job.public.id); }
    })();
    active.set(job.public.id, { ...op, promise }); return job.public;
  }
  return {
    list(draftId: string) { if (!isCollectionId(draftId)) return invalid(); flushFailures(); return store.list(draftId); },
    job(id: string) { if (!isCollectionId(id)) return invalid(); flushFailures(); return { job: store.job(id)?.public ?? null }; },
    async preview(request: PreviewExecutionRequest): Promise<ExecutionProposal> {
      await ready();if(!isPreviewExecutionRequest(request))return invalid();const {readId,...selection}=request,captured=publicContext(selection);
      try{return await read(readId,captured,async signal=>{const value=await input(selection,captured,signal);await previewCheck(value,signal);if(mediaFingerprint(context(selection))!==mediaFingerprint(captured))return invalid();return value.proposal;});}catch(error){return publicError(error);}
    },
    async start(request: StartExecutionRequest): Promise<ExecutionJob> {
      await ready();if(!isStartExecutionRequest(request))return invalid();const captured=structuredClone(request),prior=store.cached(captured);if(prior)return prior;
      const {commandId,proposalFingerprint,userConfirmed:_confirmed,...selection}=captured,initial=publicContext(selection);
      try{return await read(commandId,initial,async signal=>{
        const value=await input(selection,initial,signal);if(value.proposal.proposalFingerprint!==proposalFingerprint)return invalid();permissions(value,true,signal);
        const job=store.start(captured,value);return active.has(job.public.id)||job.public.state!=='running'?job.public:launch(job);
      });}catch(error){return publicError(error);}
    },
    cancel(request: { commandId: string; id: string }) { if (!isSourceAction(request)) return invalid(); flushFailures(); const result = store.cancel(request); active.get(request.id)?.controller.abort(); recoveries.get(request.id)?.controller.abort(); return result; },
    cancelRead(id: string): { cancelled: true } { if (!isCollectionId(id)) return invalid(); const op = reads.get(id); if (op) op.controller.abort(); else { if (cancelledReads.size >= 1000) cancelledReads.delete(cancelledReads.values().next().value!); cancelledReads.add(id); } return { cancelled: true }; },
    async verify(request: { assetId: string; readId: string }): Promise<ExecutionAssetCheck> { await ready(); if (!isCollectionId(request.assetId) || !isCollectionId(request.readId) || Object.keys(request).some(k => !['assetId','readId'].includes(k))) return invalid(); const asset = store.asset(request.assetId), job = store.job(request.assetId); if (!asset || !job || job.public.state !== 'completed') return invalid('执行资产不存在。');
      return read(request.readId, job.input, async signal => {
        let reason: ExecutionAssetCheck['reason'];
        try { if (!await verifyPublished(job, signal)) reason = 'ASSET_INVALID'; }
        catch (error) { if (signal.aborted || closed) return invalid('资产核验已取消。'); reason = error instanceof ExecutionStateError && error.failure === 'DESTINATION_INVALID' || error instanceof PreparationFileError ? 'DESTINATION_INVALID' : 'ASSET_INVALID'; }
        signal.throwIfAborted(); return { assetId: asset.id, state: reason ? 'unavailable' : 'verified', checkedAt: new Date().toISOString(), ...(reason ? { reason } : {}), formalReady: false };
      });
    },
    async idle() { await ready(); await Promise.all([...active.values()].map(o => o.promise)); flushFailures(); },
    async close() { closed = true; unroot(); undestination(); for (const op of [...active.values(), ...reads.values(), ...recoveries.values()]) op.controller.abort(); await recovered; await Promise.allSettled([...active.values(), ...reads.values()].map(o => o.promise)); },
  };
}
export type ExecutionCoordinator = ReturnType<typeof createExecutionCoordinator>;
