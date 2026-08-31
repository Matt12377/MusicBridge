import path from 'node:path';
import { statfs } from 'node:fs/promises';
import { ARCHIVE_SPACE_RESERVE, archiveObjectTotals, isArchiveProposal, type ArchiveSelection, type ArchiveProposal, type ArchiveObjectDescriptor } from '@music-bridge/contracts';
import { ArchiveFileError, archiveDigest, checkArchiveRoot, type ArchiveInput, type OwnedArchive } from './archive-files.js';
import { executionManifest, executionPublicationComplete, type ExecutionStore, type StoredExecutionJob } from './execution-store.js';
import type { PreparationStore } from './preparation-store.js';
import type { SourceStore } from './source-store.js';
import { assertPreparationOutsideSources, verifyPublishedPreparation } from './preparation-files.js';
import { withVerifiedReadonlySource, type RootCapability } from './source-files.js';
import { mediaFingerprint } from './media-store.js';
import { retainedRenderManifest } from './prepared-store.js';
import type { ArchiveStore } from './archive-store.js';

export function assertSourceOutsideArchives(absolutePath: string, store: ArchiveStore): void {
  const inside = (parent: string, child: string): boolean => { const relative = path.relative(parent, child); return !relative || !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`); };
  for (const candidate of store.candidates()) {
    if (!candidate.authorized || !candidate.initialized && !candidate.initialization) continue;
    const rootPath = candidate.initialized ? store.root(candidate.id).root.path : path.join(candidate.parent.path, `MusicBridge-Archive-${candidate.id}`);
    if (inside(absolutePath, rootPath) || inside(rootPath, absolutePath)) throw new ArchiveFileError('ARCHIVE_INPUT_INVALID');
  }
}

export const archiveDescriptors = (files: readonly ArchiveInput[]): ArchiveObjectDescriptor[] => files.map(({ role, name, sha256, size, media }) => ({ role, name, sha256, size, media }));
const invalid = (): never => { throw new ArchiveFileError('ARCHIVE_INPUT_INVALID'); };
export interface ArchiveInputContext { job: StoredExecutionJob; archive: OwnedArchive; files: readonly ArchiveInput[]; sourceIds: readonly string[]; destinationIds: readonly string[] }
export function captureArchiveInput(selection: ArchiveSelection, archive: OwnedArchive, execution: ExecutionStore, sources: SourceStore): ArchiveInputContext {
  const asset = execution.asset(selection.assetId), job = execution.job(selection.assetId);
  if (!asset || !job || job.public.state !== 'completed' || !executionPublicationComplete(job)) return invalid();
  const files: ArchiveInput[] = job.files.map(file => ({ ...file, source: job.owned!.root, role: file.relative.endsWith('.converted.wav') ? 'conversion-intermediate' : 'execution-audio', name: path.basename(file.relative), media: 'audio' }));
  const manifest = executionManifest(job);
  files.push({ role: 'manifest', name: 'ExecutionManifest.json', source: job.owned!.root, relative: 'Manifest.json', sha256: job.manifestHash!, size: manifest.length, media: 'json' });
  const retained = job.input.retained;
  if (retained) {
    const prep = retained.prepared;
    const rawManifest = retainedRenderManifest({ operationId: prep.importJobId, preparationId: prep.preparationId, masterVersionId: prep.masterVersionId, layoutVersionId: prep.layoutVersionId, contentHash: prep.contentHash, plannedTimelineHash: prep.plannedTimelineHash, assets: prep.assets, files: retained.files });
    if (archiveDigest(rawManifest) !== retained.manifestHash) return invalid();
    files.push({ role: 'manifest', name: 'RawRenderManifest.json', source: retained.owned.root, relative: 'Manifest.json', sha256: retained.manifestHash, size: rawManifest.length, media: 'json' });
    for (const raw of retained.files) files.push({ ...raw, role: 'raw-render', name: path.basename(raw.relative), source: retained.owned.root, media: 'audio' });
    if (asset.mode === 'prepared-reference') for (const audio of job.audio) {
      const raw = retained.files.find(f => f.relative === `Originals/${audio.recipe.side}.wav`);
      if (!raw || raw.sha256 !== audio.audio.sha256 || raw.size !== audio.audio.size) return invalid();
      files.push({ ...raw, role: 'execution-audio', name: `${audio.recipe.side}.reference.wav`, source: retained.owned.root, media: 'audio' });
    }
  }
  // 只保存冻结的公开事实；不序列化私有路径、目录 capability 或当前可变 Session。
  const content = JSON.stringify({ schemaVersion: 1, kind: 'execution-archive-facts', master: job.input.master, layout: job.input.layout, execution: asset, ...(retained ? { prepared: retained.prepared } : {}), sourcePolicy: selection.sourcePolicy, retentionPolicy: 'unresolved-no-automatic-deletion', formalReady: false }, null, 2) + '\n';
  files.push({ role: 'metadata', name: 'FrozenFacts.json', content, sha256: archiveDigest(content), size: Buffer.byteLength(content), media: 'json' });
  const sourceIds: string[] = [];
  if (selection.sourcePolicy === 'preserve-exact-sources') {
    for (const source of job.input.master.sourceEvidence) {
      const binding = sources.binding(source.binding.id), frozen = job.input.master.content.tracks.find(t => t.trackId === source.trackId)!.source;
      if (!binding.userConfirmed || binding.invalidated || binding.evidence.sha256 !== frozen.sha256 || binding.evidence.size !== frozen.size || mediaFingerprint(binding.evidence.technical) !== mediaFingerprint(frozen.technical)) return invalid();
      const root = sources.root(binding.rootId); if (!root.authorized) return invalid();
      sourceIds.push(root.id);
      files.push({ role: 'exact-source', name: `${source.trackId}${path.extname(binding.relative).toLowerCase()}`, source: root, relative: binding.relative, sha256: frozen.sha256, size: frozen.size, media: 'audio' });
    }
  }
  return { job, archive, files, sourceIds, destinationIds: [job.input.destination.id, ...(retained ? [retained.owned.destination.id] : [])] };
}
export function checkArchiveInputPermissions(value: ArchiveInputContext, preparation: PreparationStore, sources: SourceStore, signal: AbortSignal, includeInputs = true): void {
  signal.throwIfAborted();
  assertPreparationOutsideSources([value.archive.root.path], sources.roots());
  if (includeInputs && (value.destinationIds.some(id => !preparation.destination(id).authorized) || value.sourceIds.some(id => !sources.root(id).authorized))) return invalid();
}
export async function previewArchiveInput(selection: ArchiveSelection, value: ArchiveInputContext, signal: AbortSignal, check: () => void, availableBytes?: (root: RootCapability) => Promise<bigint>): Promise<ArchiveProposal> {
  check(); await checkArchiveRoot(value.archive);
  if (!await verifyPublishedPreparation(value.job.owned!, value.job.files, value.job.manifestHash!, signal)) return invalid();
  const retained = value.job.input.retained;
  if (retained && !await verifyPublishedPreparation(retained.owned, retained.files, retained.manifestHash, signal)) return invalid();
  for (const f of value.files) { check(); if (!('content' in f)) await withVerifiedReadonlySource(f.source, f.relative, f, signal, async () => undefined); }
  const files = archiveDescriptors(value.files), totals = archiveObjectTotals(files); if (!totals) return invalid();
  const space = availableBytes ? await availableBytes(value.archive.root) : await statfs(value.archive.root.path, { bigint: true }).then(s => s.bavail * s.bsize);
  check(); const asset = value.job.input.proposal;
  const proposal: ArchiveProposal = { ...selection, draftId: asset.draftId, masterVersionId: asset.masterVersionId, layoutVersionId: asset.layoutVersionId, mode: asset.mode, ...(asset.preparedVersionId ? { preparedVersionId: asset.preparedVersionId } : {}), files, ...totals, requiredBytes: totals.copyBytes + ARCHIVE_SPACE_RESERVE, availableBytes: Number(space > BigInt(Number.MAX_SAFE_INTEGER) ? BigInt(Number.MAX_SAFE_INTEGER) : space), proposalFingerprint: mediaFingerprint({ selection, archive: value.archive, files: value.files }), retentionPolicy: 'unresolved-no-automatic-deletion', formalReady: false };
  if (!isArchiveProposal(proposal)) return invalid(); return proposal;
}
