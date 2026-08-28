import type { DatabaseSync } from 'node:sqlite';
import * as dto from '@music-bridge/contracts';
import { mediaFingerprint } from './media-store.js';
import { resolveMediaLayout } from './media-planner.js';
import { executionPublicationComplete, executionAssetFromJob, type StoredExecutionJob } from './execution-store.js';
import { archiveDigest, archiveManifest, type OwnedArchiveOperation } from './archive-files.js';
import type { StoredArchiveOperation } from './archive-store.js';
import type { RootCapability } from './source-files.js';
import type { StoredBinding } from './source-store.js';

export const recordingPlanSchema = [
  'CREATE TABLE recording_plan_versions(id TEXT PRIMARY KEY,draft_id TEXT NOT NULL REFERENCES master_drafts(id),sequence INTEGER NOT NULL,parent_id TEXT REFERENCES recording_plan_versions(id),asset_id TEXT NOT NULL REFERENCES execution_assets(id),archive_id TEXT NOT NULL REFERENCES archive_operations(id),physical_id TEXT NOT NULL REFERENCES physical_copies(physical_id),data TEXT NOT NULL,UNIQUE(draft_id,sequence)) STRICT',
  'CREATE TABLE recording_plan_ledger(command_id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,request TEXT NOT NULL,plan_id TEXT NOT NULL UNIQUE REFERENCES recording_plan_versions(id)) STRICT',
  "CREATE TRIGGER recording_plan_versions_no_update BEFORE UPDATE ON recording_plan_versions BEGIN SELECT RAISE(ABORT,'录音计划版本不可改写'); END",
  "CREATE TRIGGER recording_plan_versions_no_delete BEFORE DELETE ON recording_plan_versions BEGIN SELECT RAISE(ABORT,'录音计划版本不可删除'); END",
  "CREATE TRIGGER recording_plan_ledger_no_update BEFORE UPDATE ON recording_plan_ledger BEGIN SELECT RAISE(ABORT,'录音计划账本不可改写'); END",
  "CREATE TRIGGER recording_plan_ledger_no_delete BEFORE DELETE ON recording_plan_ledger BEGIN SELECT RAISE(ABORT,'录音计划账本不可删除'); END",
] as const;
export const MAX_PLAN_BYTES = 8 * 1024 * 1024;
export const MAX_PLAN_DATABASE_BYTES = 128 * 1024 * 1024;
/** 历史不分页，留出 IPC 信封余量；不能冻结一个随后无法完整读取的版本。 */
export const MAX_PLAN_HISTORY_BYTES = MAX_PLAN_BYTES - 64 * 1024;
export function recordingPlanHistoryBytes(draftId: string, count: number, dataBytes: number): number {
  return Buffer.byteLength(JSON.stringify({ draftId, versions: [] })) + dataBytes + Math.max(0, count - 1);
}
export class RecordingPlanError extends Error {
  constructor(readonly category: dto.RecordingPreflightCheck['category'], readonly issue: dto.RecordingPreflightIssue) {
    super(`录音计划条件不满足，请重新检查。 [${issue}]`);
  }
}
export const planFail = (category: dto.RecordingPreflightCheck['category'] = 'versions', issue: dto.RecordingPreflightIssue = 'VERSION_MISMATCH'): never => { throw new RecordingPlanError(category, issue); };
export const planSame = (a: unknown, b: unknown): boolean => mediaFingerprint(a) === mediaFingerprint(b);
function json<T>(db: DatabaseSync, table: string, id: string, column = 'id'): T {
  const row = db.prepare(`SELECT data FROM ${table} WHERE ${column}=?`).get(id);
  if (!row) return planFail(); return JSON.parse(String(row.data)) as T;
}
export interface RecordingPlanInput {
  draftId: string; selection: dto.RecordingPlanSelection; material: dto.RecordingPlanMaterial; identity: string;
  job: StoredExecutionJob; archive: OwnedArchiveOperation;
  sources: readonly { root: RootCapability; binding: StoredBinding }[];
}
function settings(db: DatabaseSync, draftId: string, frozen?: dto.RecordingProfileSnapshot): { snapshot: dto.RecordingProfileSnapshot; session: unknown } {
  if (!frozen && !db.prepare('SELECT 1 FROM recording_sessions WHERE draft_id=?').get(draftId)) return planFail('profile', 'PROFILE_MISMATCH');
  const current = frozen ? undefined : json<dto.RecordingSessionSettings>(db, 'recording_sessions', draftId, 'draft_id');
  if (current && (!dto.isRecordingSessionSettings(current) || current.draftId !== draftId)) return planFail('profile', 'PROFILE_MISMATCH');
  const versionId = frozen?.settings.profile.id ?? current!.profileVersionId;
  const profile = json<dto.RecordingProfileVersion>(db, 'recording_profile_versions', versionId);
  if (!dto.isRecordingProfileVersion(profile) || mediaFingerprint(profile.content) !== profile.contentHash) return planFail('profile', 'PROFILE_MISMATCH');
  const overrides = frozen?.settings.overrides ?? current!.overrides, effective = dto.effectiveRecordingSettings(profile, overrides);
  const format = { ...profile.content.executionFormat, outputProfileVersion: profile.id };
  const resolved: dto.ResolvedRecordingSettings = { profile, overrides, effective, format, fingerprint: mediaFingerprint({ profile, overrides, effective, format }) };
  if (frozen && !planSame(frozen.settings, resolved)) return planFail('profile', 'PROFILE_MISMATCH');
  return { snapshot: { sessionRevision: frozen?.sessionRevision ?? current!.revision, settings: resolved }, session: current ?? frozen };
}
function archived(db: DatabaseSync, selection: dto.RecordingPlanSelection, asset: dto.ExecutionAsset) {
  const row = db.prepare('SELECT * FROM archive_operations WHERE id=?').get(selection.archiveOperationId);
  if (!row || row.phase !== 'FINALIZED' || row.issue !== null || row.asset_id !== asset.id) return planFail('archive', 'ARCHIVE_INVALID');
  const op = JSON.parse(String(row.data)) as StoredArchiveOperation;
  const root = db.prepare('SELECT * FROM archive_roots WHERE id=?').get(row.root_id!);
  const candidate = db.prepare('SELECT * FROM archive_candidates WHERE id=?').get(row.root_id!);
  if (!root || root.authorized !== 1 || !candidate || candidate.authorized !== 1 || !op.owned || !op.request.workflow
    || op.request.id !== selection.archiveOperationId || op.request.rootId !== row.root_id
    || op.request.workflow.request.assetId !== asset.id || op.request.workflow.request.rootId !== row.root_id
    || !planSame(JSON.parse(String(root.data)), op.owned.archive)
    || op.request.lineage.executionAssetId !== asset.id || op.request.lineage.masterVersionId !== asset.masterVersionId || op.request.lineage.layoutVersionId !== asset.layoutVersionId
    || op.owned.id !== op.request.id || !planSame(op.owned.files, op.request.files) || !planSame(op.owned.lineage, op.request.lineage)
    || op.owned.manifest !== archiveManifest(op.request.id, op.request.files, op.request.lineage)) return planFail('archive', 'ARCHIVE_INVALID');
  const references = db.prepare('SELECT * FROM archive_references WHERE operation_id=? ORDER BY role,name').all(op.request.id);
  if (references.length !== op.request.files.length) return planFail('archive', 'ARCHIVE_INVALID');
  for (const file of op.request.files) {
    const ref = references.find(r => r.role === file.role && r.name === file.name);
    if (!ref || ref.root_id !== row.root_id || ref.sha256 !== file.sha256 || db.prepare('SELECT size FROM archive_objects WHERE root_id=? AND sha256=?').get(row.root_id!, file.sha256)?.size !== file.size) return planFail('archive', 'ARCHIVE_INVALID');
  }
  for (const audio of asset.audio) if (!op.request.files.some(f => f.role === 'execution-audio' && f.sha256 === audio.audio.sha256 && f.size === audio.audio.size)) return planFail('archive', 'ARCHIVE_INVALID');
  const totals = dto.archiveObjectTotals(op.request.files.map(({ role, name, sha256, size, media }) => ({ role, name, sha256, size, media }))); if (!totals) return planFail('archive', 'ARCHIVE_INVALID');
  return { op, root, candidate, references, summary: { operationId: op.request.id, rootId: op.request.rootId, sourcePolicy: op.request.workflow.request.sourcePolicy, manifestHash: archiveDigest(op.owned.manifest), phase: 'FINALIZED' as const, ...totals } };
}

/** 同步捕获真实数据库事实；不写数据库、不探测设备，不复用含恢复副作用的服务读取。 */
export function captureRecordingPlan(db: DatabaseSync, selection: dto.RecordingPlanSelection, frozen?: dto.RecordingProfileSnapshot): RecordingPlanInput {
  if (!dto.isRecordingPlanSelection(selection)) return planFail();
  const asset = json<dto.ExecutionAsset>(db, 'execution_assets', selection.assetId), job = json<StoredExecutionJob>(db, 'execution_jobs', selection.assetId);
  if (!dto.isExecutionAsset(asset) || !dto.isExecutionJob(job.public) || job.public.state !== 'completed' || job.public.assetId !== asset.id || !executionPublicationComplete(job) || !planSame(asset, executionAssetFromJob(job))) return planFail('execution', 'EXECUTION_INVALID');
  const master = json<dto.MasterVersion>(db, 'master_versions', asset.masterVersionId), layout = json<dto.LayoutVersion>(db, 'layout_versions', asset.layoutVersionId);
  if (!planSame(master, job.input.master) || !planSame(layout, job.input.layout) || mediaFingerprint(master.content) !== master.contentHash || mediaFingerprint(layout.timeline) !== layout.timelineHash) return planFail();
  const prepared = asset.preparedVersionId ? json<dto.FrozenPrepared>(db, 'prepared_versions', asset.preparedVersionId) : undefined;
  if (prepared && !planSame(prepared, job.input.retained?.prepared)) return planFail();
  const planRow = db.prepare('SELECT * FROM media_plans WHERE id=?').get(layout.planId), reservation = db.prepare('SELECT * FROM media_reservations WHERE plan_id=?').get(layout.planId);
  if (!planRow || !reservation || reservation.physical_id !== layout.reservation.physicalId || !planSame(JSON.parse(String(reservation.data)), layout.reservation)) return planFail('physical-copy', 'COPY_UNAVAILABLE');
  const media = JSON.parse(String(planRow.data)) as dto.MediaPlan, draft = db.prepare('SELECT * FROM master_drafts WHERE id=?').get(asset.draftId);
  if (!draft || media.draftId !== asset.draftId || media.draftRevision !== draft.revision || !planSame(media.spec, layout.spec)) return planFail();
  const currentDraft = JSON.parse(String(draft.data)) as Pick<dto.MasterDraft, 'programType' | 'tracks'>;
  // 草稿标题只是工作区显示标签，不属于Master内容身份；也不要求所选M/L为最新ID。
  if (currentDraft.programType !== master.content.programType || !Array.isArray(currentDraft.tracks)
    || currentDraft.tracks.length !== master.content.tracks.length || currentDraft.tracks.some((track, index) => {
      const frozenTrack = master.content.tracks[index]!;
      return track.id !== frozenTrack.trackId || !planSame(track.metadata, frozenTrack.metadata);
    })) return planFail();
  const expectedMediaLayout = resolveMediaLayout(master.content.tracks.map(track => ({ trackId: track.trackId, durationMs: track.source.technical.durationMs, basis: 'verified-sources' })), layout.spec);
  if (media.sourceBasis !== 'verified-sources' || !planSame(media.layout, expectedMediaLayout)) return planFail();
  const copy = db.prepare('SELECT c.*,l.sku_id,s.model_id,s.minutes,m.descriptor,m.policy,m.minimum_sealed,m.revision model_revision FROM physical_copies c JOIN inventory_lots l ON l.id=c.lot_id JOIN collection_skus s ON s.id=l.sku_id JOIN collection_models m ON m.id=s.model_id WHERE c.physical_id=?').get(reservation.physical_id!);
  if (!copy || copy.usage !== 'reserved' || copy.available !== 1 || copy.sku_id !== layout.reservation.skuId || copy.model_id !== layout.reservation.modelId || copy.packaging !== layout.reservation.packaging || !['blank','erased'].includes(String(copy.reserved_from))) return planFail('physical-copy', 'COPY_UNAVAILABLE');
  const descriptor = JSON.parse(String(copy.descriptor)) as dto.CollectionDescriptor;
  if (copy.minutes !== layout.lengthMinutes || descriptor.format !== layout.spec.format || !Number.isSafeInteger(copy.minutes) || Number(copy.minutes) <= 0) return planFail('capacity', 'CAPACITY_EXCEEDED');
  const physicalCopy: dto.CollectionCopy = { physicalId: String(copy.physical_id), lotId: String(copy.lot_id), skuId: String(copy.sku_id), lengthMinutes: Number(copy.minutes), packaging: copy.packaging as dto.CollectionCopy['packaging'], usage: 'reserved', available: true, origin: copy.origin as dto.CollectionCopy['origin'], revision: Number(copy.revision) };
  const resolved = settings(db, asset.draftId, frozen), compatibility = resolved.snapshot.settings.profile.content.compatibility;
  if (!planSame(resolved.snapshot.settings.format, asset.settings.format)) return planFail('profile', 'PROFILE_MISMATCH');
  if (!compatibility.confirmed || (descriptor.format === 'dat' ? !compatibility.dat : !compatibility.cassetteTypes.some(t => t === descriptor.tapeType)) || copy.policy === 'collector') return planFail('profile', 'COMPATIBILITY_UNCONFIRMED');
  for (const receipt of asset.audio) {
    const capacity = BigInt(Number(copy.minutes)) * 60n * BigInt(receipt.recipe.format.sampleRate) / (descriptor.format === 'dat' ? 1n : 2n);
    if (BigInt(receipt.audio.frameCount) > capacity || receipt.audio.frameCount > receipt.recipe.capacityFrames) return planFail('capacity', 'CAPACITY_EXCEEDED');
  }
  const archive = archived(db, selection, asset), destinations = [job.input.destination, ...(job.input.retained ? [job.input.retained.owned.destination] : [])].map(destination => {
    const current = json<RootCapability>(db, 'preparation_destinations', destination.id);
    if (!current.authorized || !planSame(current, destination)) return planFail('execution', 'EXECUTION_INVALID'); return current;
  });
  const sources = asset.mode.startsWith('direct') ? master.sourceEvidence.map(source => {
    const binding = json<StoredBinding>(db, 'source_bindings', source.binding.id), root = json<RootCapability>(db, 'source_roots', binding.rootId);
    const track = master.content.tracks.find(t => t.trackId === source.trackId);
    const linked = db.prepare('SELECT binding_id FROM draft_source_links WHERE draft_id=? AND track_id=?').get(master.draftId, source.trackId);
    if (!track || linked?.binding_id !== binding.id || !root.authorized || !binding.userConfirmed || binding.invalidated || binding.evidence.sha256 !== track.source.sha256 || binding.evidence.size !== track.source.size || !planSame(binding.evidence.technical, track.source.technical)) return planFail('sources', 'SOURCE_INVALID');
    return { root, binding };
  }) : [];
  const material: dto.RecordingPlanMaterial = { master, layout, ...(prepared ? { prepared } : {}), execution: { assetId: asset.id, manifestHash: asset.manifestHash, mode: asset.mode, compiledSettings: asset.settings, recipes: asset.recipes, audio: asset.audio }, physicalCopy, mediaPlanRevision: Number(planRow.revision), profileSnapshot: resolved.snapshot, archive: archive.summary, retentionPolicy: dto.RECORDING_RETENTION_POLICY, onlineFallback: false, formalReady: false };
  if (!dto.isRecordingPlanMaterial(material)) return planFail();
  return { draftId: asset.draftId, selection: structuredClone(selection), material, job, archive: archive.op.owned!, sources,
    identity: mediaFingerprint({ material, job, planRow, reservation, copy, draft, session: resolved.session, archive, destinations, sources }) };
}

export function recordingPlanContent(plan: dto.RecordingPlanVersion): dto.RecordingPlanMaterial {
  const { id: _id, draftId: _draftId, sequence: _sequence, parentId: _parent, createdAt: _created, contentHash: _hash, status: _status, ...material } = plan;
  return material;
}
export function parseRecordingPlan(data: unknown): dto.RecordingPlanVersion {
  const value: unknown = JSON.parse(String(data));
  if (!dto.isRecordingPlanVersion(value) || mediaFingerprint(recordingPlanContent(value)) !== value.contentHash || Buffer.byteLength(String(data)) > MAX_PLAN_BYTES) return planFail();
  for (const resolved of [value.profileSnapshot.settings, value.execution.compiledSettings]) {
    const { fingerprint, ...material } = resolved;
    if (mediaFingerprint(material) !== fingerprint || mediaFingerprint(resolved.profile.content) !== resolved.profile.contentHash) return planFail('profile', 'PROFILE_MISMATCH');
  }
  if (mediaFingerprint(value.master.content) !== value.master.contentHash || mediaFingerprint(value.layout.timeline) !== value.layout.timelineHash) return planFail();
  return value;
}

/** 备份/恢复只读完整性检查：不打开文件、不恢复任务、不访问设备或修改授权。 */
export function verifyRecordingPlanDatabase(db: DatabaseSync): void {
  const objects = db.prepare("SELECT sql FROM sqlite_schema WHERE name GLOB 'recording_plan_*'").all();
  if (objects.length !== recordingPlanSchema.length || objects.some(row => !recordingPlanSchema.includes(String(row.sql) as typeof recordingPlanSchema[number]))) return planFail();
  const budget = db.prepare('SELECT count(*) n,COALESCE(sum(length(CAST(data AS BLOB))),0) bytes FROM recording_plan_versions').get()!;
  const ledgerBudget = db.prepare('SELECT count(*) n,COALESCE(sum(length(CAST(request AS BLOB))),0) bytes FROM recording_plan_ledger').get()!;
  if (Number(budget.n) > 10000 || budget.n !== ledgerBudget.n || Number(budget.bytes) + Number(ledgerBudget.bytes) > MAX_PLAN_DATABASE_BYTES) return planFail();
  for (const group of db.prepare('SELECT draft_id,count(*) n,sum(length(CAST(data AS BLOB))) bytes FROM recording_plan_versions GROUP BY draft_id').iterate()) {
    if (recordingPlanHistoryBytes(String(group.draft_id), Number(group.n), Number(group.bytes)) > MAX_PLAN_HISTORY_BYTES) return planFail();
  }
  const heads = new Map<string, dto.RecordingPlanVersion>();
  for (const row of db.prepare('SELECT * FROM recording_plan_versions ORDER BY draft_id,sequence').iterate()) {
    const plan = parseRecordingPlan(row.data), previous = heads.get(plan.draftId);
    if (plan.id !== row.id || plan.draftId !== row.draft_id || plan.sequence !== row.sequence || plan.parentId !== (row.parent_id ?? undefined)
      || plan.sequence !== (previous?.sequence ?? 0) + 1 || plan.parentId !== previous?.id || plan.sequence > dto.MAX_RECORDING_PLAN_VERSIONS
      || plan.execution.assetId !== row.asset_id || plan.archive.operationId !== row.archive_id || plan.physicalCopy.physicalId !== row.physical_id) return planFail();
    const asset = json<dto.ExecutionAsset>(db, 'execution_assets', plan.execution.assetId);
    if (!dto.isExecutionAsset(asset) || !planSame(plan.master, json(db, 'master_versions', plan.master.id)) || !planSame(plan.layout, json(db, 'layout_versions', plan.layout.id))
      || !planSame(plan.profileSnapshot.settings.profile, json(db, 'recording_profile_versions', plan.profileSnapshot.settings.profile.id))
      || !planSame(plan.execution, { assetId: asset.id, manifestHash: asset.manifestHash, mode: asset.mode, compiledSettings: asset.settings, recipes: asset.recipes, audio: asset.audio })
      || plan.prepared && !planSame(plan.prepared, json(db, 'prepared_versions', plan.prepared.id))) return planFail();
    const copy = db.prepare('SELECT c.lot_id,c.revision,l.sku_id FROM physical_copies c JOIN inventory_lots l ON l.id=c.lot_id WHERE c.physical_id=?').get(plan.physicalCopy.physicalId);
    const media = db.prepare('SELECT revision FROM media_plans WHERE id=?').get(plan.layout.planId);
    if (!copy || copy.lot_id !== plan.physicalCopy.lotId || copy.sku_id !== plan.physicalCopy.skuId || Number(copy.revision) < plan.physicalCopy.revision || !media || Number(media.revision) < plan.mediaPlanRevision) return planFail();
    const op = db.prepare('SELECT data,asset_id,root_id,phase,issue FROM archive_operations WHERE id=?').get(plan.archive.operationId);
    if (!op || op.asset_id !== asset.id || op.root_id !== plan.archive.rootId || op.phase !== 'FINALIZED' || op.issue !== null) return planFail();
    const operation = JSON.parse(String(op.data)) as StoredArchiveOperation, owned = operation.owned;
    const totals = dto.archiveObjectTotals(operation.request.files.map(({ role, name, sha256, size, media }) => ({ role, name, sha256, size, media })));
    if (!owned || !totals || operation.request.workflow?.request.sourcePolicy !== plan.archive.sourcePolicy
      || totals.objectCount !== plan.archive.objectCount || totals.copyBytes !== plan.archive.copyBytes
      || owned.manifest !== archiveManifest(plan.archive.operationId, operation.request.files, operation.request.lineage)
      || archiveDigest(owned.manifest) !== plan.archive.manifestHash || operation.request.lineage.executionAssetId !== asset.id
      || operation.request.lineage.masterVersionId !== plan.master.id || operation.request.lineage.layoutVersionId !== plan.layout.id) return planFail();
    const references = db.prepare('SELECT role,name,sha256 FROM archive_references WHERE operation_id=?').all(plan.archive.operationId);
    if (references.length !== operation.request.files.length || operation.request.files.some(file => !references.some(ref => ref.role === file.role && ref.name === file.name && ref.sha256 === file.sha256)
      || db.prepare('SELECT size FROM archive_objects WHERE root_id=? AND sha256=?').get(plan.archive.rootId, file.sha256)?.size !== file.size)) return planFail();
    const ledger = db.prepare('SELECT * FROM recording_plan_ledger WHERE plan_id=?').get(plan.id);
    if (!ledger) return planFail(); const request: unknown = JSON.parse(String(ledger.request));
    if (!dto.isFreezeRecordingPlanRequest(request) || request.commandId !== ledger.command_id || request.selection.assetId !== plan.execution.assetId || request.selection.archiveOperationId !== plan.archive.operationId || mediaFingerprint(request) !== ledger.fingerprint) return planFail();
    heads.set(plan.draftId, plan);
  }
}
