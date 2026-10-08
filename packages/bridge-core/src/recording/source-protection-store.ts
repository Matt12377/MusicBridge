import { createHash } from 'node:crypto';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import * as dto from '@music-bridge/contracts';
import { sourceFingerprint, type StoredBinding } from './source-store.js';
import { mediaFingerprint } from './media-store.js';
import { verifyFrozenDistribution } from './version-distribution.js';
import { retainedRenderManifest } from './prepared-store.js';
import { parseRecordingPlan } from './plan-integrity.js';
import { executionPublicationComplete, type StoredExecutionJob } from './execution-store.js';
import { verifyOutputRunBarrierDatabase } from './output-run-barrier.js';
import type { RootCapability } from './source-files.js';
import type { PhysicalResource } from '../stream/physical-resource-locks.js';

/** 仅限制新增源写审计；超限不截断历史，不改变旧浏览、录音或200曲容量。 */
interface SourceProtectionBudget { rows: number; bytes: number; rowBytes: number; locations: number }
export const SOURCE_PROTECTION_BUDGET: Readonly<SourceProtectionBudget> = Object.freeze({ rows: 50_000, bytes: 64 * 1024 * 1024, rowBytes: 8 * 1024 * 1024, locations: 100_000 });
export type SourceProtectionKind = 'MASTER' | 'LAYOUT' | 'PREPARATION' | 'PREPARED' | 'EXECUTION' | 'ARCHIVE' | 'RECORDING_PLAN' | 'RECORDING';
export interface ProtectedSourceLocation {
  root: RootCapability; relative: string; signature: string | null; physical: PhysicalResource | null;
  authorization: 'AUTHORIZED' | 'REVOKED' | 'UNKNOWN';
}
export interface SourceProtectionReference {
  kind: SourceProtectionKind; id: string; bindingId: string | null; sha256: string; size: number | null;
  locations: readonly ProtectedSourceLocation[];
}
export interface SourceProtectionProjection {
  version: 1; storageFingerprint: string; complete: boolean; issues: readonly string[];
  references: readonly SourceProtectionReference[]; rows: number; bytes: number;
}
type Row = Record<string, unknown>;
interface Access { read<T>(fn: (db: DatabaseSync) => T): T; /** 私有测试只能收紧预算。 */ budget?: Partial<typeof SOURCE_PROTECTION_BUDGET> }
const object = (value: unknown): value is Row => !!value && typeof value === 'object' && !Array.isArray(value);
const closed = (value: Row, required: readonly string[], optional: readonly string[] = []): boolean => required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => required.includes(key) || optional.includes(key));
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const decimal = (value: unknown): value is string => typeof value === 'string' && /^\d{1,32}$/u.test(value);
const size = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= 68_719_476_736;
const date = (value: unknown): boolean => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const relative = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 4096 && !value.includes('\0') && !value.includes('\\') && !path.isAbsolute(value) && value.split('/').every(part => !!part && part !== '.' && part !== '..');
function root(value: unknown): value is RootCapability {
  return object(value) && closed(value, ['id','path','dev','ino','authorized','label']) && dto.isCollectionId(value.id)
    && typeof value.path === 'string' && value.path.length <= 4096 && path.isAbsolute(value.path) && !value.path.includes('\0')
    && value.path.split('/').every(part => part !== '.' && part !== '..') && decimal(value.dev) && decimal(value.ino)
    && typeof value.authorized === 'boolean' && typeof value.label === 'string' && value.label.length <= 240;
}
function physical(signature: unknown, expectedSize?: number): PhysicalResource | null {
  if (typeof signature !== 'string' || signature.length > 256) return null;
  const parts = signature.split(':');
  if (parts.length !== 5 || !decimal(parts[0]) || !decimal(parts[1]) || !decimal(parts[2]) || !parts.slice(3).every(part => /^-?\d{1,32}$/u.test(part))
    || expectedSize !== undefined && BigInt(parts[2]!) !== BigInt(expectedSize)) return null;
  return { dev: String(BigInt(parts[0]!)), ino: String(BigInt(parts[1]!)) };
}
function binding(value: unknown): value is StoredBinding {
  if (!object(value) || !closed(value, ['id','rootId','relative','acquisition','evidence','userConfirmed','invalidated'])
    || !dto.isCollectionId(value.id) || !dto.isCollectionId(value.rootId) || !relative(value.relative) || !dto.isSourceAcquisition(value.acquisition)
    || typeof value.userConfirmed !== 'boolean' || typeof value.invalidated !== 'boolean' || !object(value.evidence)) return false;
  const evidence = value.evidence;
  return closed(evidence, ['sha256','size','signature','modifiedAt','verifiedAt','technical']) && hash(evidence.sha256) && size(evidence.size)
    && physical(evidence.signature, evidence.size) !== null && date(evidence.modifiedAt) && date(evidence.verifiedAt) && dto.isSourceTechnical(evidence.technical);
}
const tables = [
  'source_roots','source_bindings','source_ledger','master_versions','layout_versions','preparation_destinations','preparation_jobs','preparation_workspaces',
  'prepared_selections','prepared_jobs','prepared_versions','execution_jobs','execution_assets','archive_roots','archive_operations','archive_objects','archive_references',
  'recording_plan_versions','recording_plan_ledger','recording_attempts','recording_attempt_events','recording_attempt_receipts','output_run_legacy_attempts','output_run_barrier_events',
] as const;

/** 原表派生的持久引用投影；不写回冻结JSON，不按AssetID或单一当前路径作保护身份。 */
export function createSourceProtectionStore(access: Access) {
  const budget = { ...SOURCE_PROTECTION_BUDGET, ...access.budget };
  for (const key of Object.keys(SOURCE_PROTECTION_BUDGET) as (keyof typeof budget)[]) if (!Number.isSafeInteger(budget[key]) || budget[key] < 1 || budget[key] > SOURCE_PROTECTION_BUDGET[key]) throw new Error('来源保护审计预算只能收紧。');
  function snapshot(sourceWrites=false):SourceProtectionProjection { return access.read(db => {
    const issues = new Set<string>(), digest = createHash('sha256'), rowsByTable = new Map<string, Row[]>();
    const references: SourceProtectionReference[] = [];
    let rows = 0, bytes = 0, locations = 0, started = false;
    const unknown = (issue = 'HISTORY_CORRUPT'): void => { issues.add(issue); };
    const json = (text: unknown): unknown => {
      if (typeof text !== 'string') throw new Error('历史JSON类型无效。');
      const value: unknown = JSON.parse(text);
      // 旧唯一作者写JSONStringify；严格回比拒重复键但不改原Hash序列化协议。
      if (JSON.stringify(value) !== text) throw new Error('历史JSON原文不规范。');
      return value;
    };
    const data = (row: Row): unknown => json(row.data);
    const scan = (table: string): Row[] => rowsByTable.get(table) ?? [];
    const add = (kind: SourceProtectionKind, id: string, sha256: string, byteSize: number | null, value: readonly ProtectedSourceLocation[], bindingId: string | null = null): void => {
      locations += value.length; if (locations > budget.locations) throw new Error('SOURCE_PROTECTION_BUDGET_EXCEEDED');
      if (!value.length) unknown('PHYSICAL_HISTORY_UNKNOWN');
      references.push({ kind, id, bindingId, sha256, size: byteSize, locations: value });
    };
    try {
      if (!db.isTransaction) { db.exec('BEGIN'); started = true; }
      if(sourceWrites)digest.update(JSON.stringify(['source-writes-protection-content-v1',db.prepare('PRAGMA user_version').get()]));
      else digest.update(JSON.stringify(['source-protection-v1', db.prepare('PRAGMA user_version').get(), db.prepare('PRAGMA data_version').get(), db.prepare('SELECT total_changes() changes').get()]));
      for (const table of tables) {
        const found: Row[] = [];
        const columns=db.prepare(`PRAGMA table_info(${table})`).all().map(column=>String(column.name));
        if(!columns.length||columns.length>32||columns.some(column=>!/^[a-z][a-z0-9_]*$/u.test(column)))throw new Error('保护表结构无效。');
        const lengths=columns.map(column=>`COALESCE(length(CAST("${column}" AS BLOB)),0)`).join('+');
        const load=db.prepare(`SELECT * FROM ${table} WHERE rowid=?`);
        // 先只取SQLite字节长度，超限不把巨型JSON/BLOB搬入Node堆；原字段与Hash不变。
        for(const metadata of db.prepare(`SELECT rowid AS protection_rowid,${lengths} AS protection_bytes FROM ${table} ORDER BY rowid LIMIT ?`).iterate(budget.rows-rows+1)) {
          if(rows>=budget.rows||Number(metadata.protection_bytes)>budget.rowBytes||bytes+Number(metadata.protection_bytes)>budget.bytes)throw new Error('SOURCE_PROTECTION_BUDGET_EXCEEDED');
          const row=load.get(metadata.protection_rowid as number)!;
          const raw = JSON.stringify(row), count = Buffer.byteLength(raw); rows++; bytes += count;
          if (rows > budget.rows || bytes > budget.bytes || count > budget.rowBytes) throw new Error('SOURCE_PROTECTION_BUDGET_EXCEEDED');
          digest.update(JSON.stringify([table, row])); found.push(row);
        }
        rowsByTable.set(table, found);
      }
      const roots = new Map<string, RootCapability>();
      for (const row of [...scan('source_roots'), ...scan('preparation_destinations')]) {
        const value = data(row); if (!root(value) || value.id !== row.id) { unknown(); continue; } roots.set(value.id, value);
      }
      const currentBindings = new Map<string, StoredBinding>(), snapshots = new Map<string, StoredBinding[]>();
      for (const row of scan('source_bindings')) { const value = data(row); if (!binding(value) || value.id !== row.id) { unknown(); continue; } currentBindings.set(value.id, value); }
      for (const row of scan('source_ledger')) {
        if (!dto.isCollectionId(row.command_id) || !hash(row.fingerprint) || typeof row.result !== 'string') { unknown(); continue; }
        if (!row.result.startsWith('{')) { if (!dto.isCollectionId(row.result)) unknown(); continue; }
        const value = json(row.result);
        if (!binding(value) || sourceFingerprint(['binding-snapshot', value]) !== row.fingerprint) { unknown(); continue; }
        const entries = snapshots.get(value.id) ?? []; entries.push(value); snapshots.set(value.id, entries);
      }
      const location = (capability: RootCapability, name: string, signature: string | null, authorization: ProtectedSourceLocation['authorization'] = capability.authorized ? 'AUTHORIZED' : 'REVOKED'): ProtectedSourceLocation => {
        const known = signature === null ? null : physical(signature);
        if (!known) unknown('PHYSICAL_HISTORY_UNKNOWN');
        if (authorization !== 'AUTHORIZED') unknown(authorization === 'REVOKED' ? 'SOURCE_ROOT_REVOKED' : 'SOURCE_AUTHORIZATION_UNKNOWN');
        return { root: capability, relative: name, signature, physical: known, authorization };
      };
      const bindingLocations = (frozen: dto.SourceBinding): ProtectedSourceLocation[] => {
        const history = snapshots.get(frozen.id) ?? [];
        const current = currentBindings.get(frozen.id);
        const matches = [...history, ...(current ? [current] : [])].filter(value => value.evidence.sha256 === frozen.sha256 && value.evidence.size === frozen.size && mediaFingerprint(value.evidence.technical) === mediaFingerprint(frozen.technical));
        if (!history.some(value => value.evidence.sha256 === frozen.sha256 && value.evidence.size === frozen.size && mediaFingerprint(value.evidence.technical) === mediaFingerprint(frozen.technical))) unknown('BINDING_HISTORY_UNKNOWN');
        const result = new Map<string, ProtectedSourceLocation>();
        for (const value of matches) {
          const capability = roots.get(value.rootId); if (!capability) { unknown('SOURCE_AUTHORIZATION_UNKNOWN'); continue; }
          result.set(mediaFingerprint([value.rootId,value.relative,value.evidence.signature]), location(capability,value.relative,value.evidence.signature));
        }
        return [...result.values()];
      };
      const masters = new Map<string, dto.MasterVersion>();
      for (const row of scan('master_versions')) {
        const value = data(row);
        if (!dto.isMasterVersion(value) || value.id !== row.id || value.draftId !== row.draft_id || mediaFingerprint(value.content) !== value.contentHash
          || value.sourceEvidence.some((entry, index) => entry.binding.size !== value.content.tracks[index]!.source.size || mediaFingerprint(entry.binding.technical) !== mediaFingerprint(value.content.tracks[index]!.source.technical))) { unknown(); continue; }
        masters.set(value.id, value);
        for (const entry of value.sourceEvidence) add('MASTER',value.id,entry.binding.sha256,entry.binding.size,bindingLocations(entry.binding),entry.binding.id);
      }
      const addMaster = (kind: SourceProtectionKind, id: string, masterId: unknown): void => {
        const master = typeof masterId === 'string' ? masters.get(masterId) : undefined; if (!master) { unknown('FROZEN_LINEAGE_UNKNOWN'); return; }
        for (const entry of master.sourceEvidence) add(kind,id,entry.binding.sha256,entry.binding.size,bindingLocations(entry.binding),entry.binding.id);
      };
      const layouts = new Map<string, dto.LayoutVersion>();
      for (const row of scan('layout_versions')) {
        const value = data(row);
        if (!dto.isLayoutVersion(value) || value.id !== row.id || value.draftId !== row.draft_id || value.masterVersionId !== row.master_id || !masters.has(value.masterVersionId) || mediaFingerprint(value.timeline) !== value.timelineHash) { unknown(); continue; }
        layouts.set(value.id,value); addMaster('LAYOUT',value.id,value.masterVersionId);
      }
      const ownedFiles = (kind: SourceProtectionKind, id: string, job: Row): void => {
        const completed = object(job.public) && job.public.state === 'completed';
        if (job.owned === undefined) { if (completed) unknown('FROZEN_LINEAGE_UNKNOWN'); return; }
        if (!object(job.owned) || !root(job.owned.root) || !root(job.owned.destination) || !Array.isArray(job.files) || job.files.length > 2048) { unknown('FROZEN_LINEAGE_UNKNOWN'); return; }
        if (completed && (!job.files.length || !hash(job.manifestHash))) unknown('FROZEN_LINEAGE_UNKNOWN');
        const names = new Set<string>();
        const owner = roots.get(job.owned.destination.id);
        const authorized = owner ? owner.authorized ? 'AUTHORIZED' : 'REVOKED' : 'UNKNOWN';
        for (const file of job.files) {
          if (!object(file) || !closed(file,['relative','sha256','size']) || !relative(file.relative) || !hash(file.sha256) || !size(file.size) || names.has(file.relative)) { unknown('FROZEN_LINEAGE_UNKNOWN'); continue; }
          names.add(file.relative);
          add(kind,id,file.sha256,file.size,[location(job.owned.root,file.relative,null,authorized)]);
        }
        if (hash(job.manifestHash)) add(kind,id,job.manifestHash,null,[location(job.owned.root,'Manifest.json',null,authorized)]);
        else if (job.files.length) unknown('FROZEN_LINEAGE_UNKNOWN');
      };
      const preparationJobs = new Map<string, Row>();
      for (const row of scan('preparation_jobs')) {
        const value = data(row);
        if (!object(value) || !dto.isPreparationJob(value.public) || value.public.id !== row.id || !object(value.input) || !dto.isMasterVersion(value.input.master) || !dto.isLayoutVersion(value.input.layout)) { unknown(); continue; }
        preparationJobs.set(String(row.id), value);
        addMaster('PREPARATION',String(row.id),value.input.master.id); ownedFiles('PREPARATION',String(row.id),value);
        if (value.public.state === 'completed') {
          const distribution = verifyFrozenDistribution(value.input.master, value.input.layout);
          const tracks = distribution ? distribution.trackIds.map(id => value.input && object(value.input) && dto.isMasterVersion(value.input.master) ? value.input.master.content.tracks.find(track => track.trackId === id) : undefined) : [];
          if (!distribution || !Array.isArray(value.files) || value.files.length !== tracks.length + 3 || tracks.length !== value.public.totalTracks
            || !['SourceLineage.json','Tracklist.tsv','README.txt'].every(name => (value.files as unknown[]).some(file => object(file) && file.relative === name))) unknown('FROZEN_LINEAGE_UNKNOWN');
          else {
            for (const [index, track] of tracks.entries()) {
              const file = value.files[index], container = track?.source.technical.container.toLowerCase();
              const extension = container && /wav|wave/u.test(container) ? 'wav' : container && /aiff/u.test(container) ? 'aiff' : container && /flac/u.test(container) ? 'flac' : null;
              if (!track || !extension || !object(file) || file.relative !== `Sources/${String(index + 1).padStart(3,'0')}.${extension}` || file.sha256 !== track.source.sha256 || file.size !== track.source.size) unknown('FROZEN_LINEAGE_UNKNOWN');
            }
            const manifest = Buffer.from(JSON.stringify({schemaVersion:1,kind:'logic-working-copy',operationId:row.id,masterVersionId:value.input.master.id,layoutVersionId:value.input.layout.id,contentHash:value.input.master.contentHash,timelineHash:value.input.layout.timelineHash,plannedTimeline:value.input.layout.timeline,files:value.files,executionReady:false},null,2)+'\n');
            if (createHash('sha256').update(manifest).digest('hex') !== value.manifestHash) unknown('FROZEN_LINEAGE_UNKNOWN');
          }
        }
      }
      for (const row of scan('preparation_workspaces')) {
        const value = data(row), job = preparationJobs.get(String(row.id));
        if (!dto.isPreparationWorkspace(value) || value.id !== row.id || !job || !object(job.public) || job.public.state !== 'completed' || job.manifestHash !== value.manifestHash) unknown('FROZEN_LINEAGE_UNKNOWN');
      }
      const selectionRows = new Map<string, Row>();
      for (const row of scan('prepared_selections')) {
        const value = data(row);
        if (!object(value) || !object(value.public) || value.public.id !== row.id || !root(value.root) || !relative(value.relative) || !physical(value.signature)) { unknown(); continue; }
        selectionRows.set(String(row.id),value);
      }
      const preparedJobs = new Map<string, Row>();
      for (const row of scan('prepared_jobs')) {
        const value = data(row);
        if (!object(value) || !dto.isPreparedImportJob(value.public) || value.public.id !== row.id || !object(value.input) || !dto.isMasterVersion(value.input.master) || !dto.isLayoutVersion(value.input.layout) || !Array.isArray(value.input.selections) || value.input.selections.length > 2) { unknown(); continue; }
        preparedJobs.set(String(row.id),value); addMaster('PREPARED',String(row.id),value.input.master.id);
        for (const selected of value.input.selections) {
          if (!object(selected) || !object(selected.public) || !root(selected.root) || !relative(selected.relative) || !object(selected.evidence) || !hash(selected.evidence.sha256) || !size(selected.evidence.size) || !physical(selected.signature,selected.evidence.size)) { unknown(); continue; }
          const live = selectionRows.get(String(selected.public.id));
          const authorized = live ? object(live.public) && live.public.authorized === true ? 'AUTHORIZED' : 'REVOKED' : 'UNKNOWN';
          add('PREPARED',String(row.id),selected.evidence.sha256,selected.evidence.size,[location(selected.root,selected.relative,String(selected.signature),authorized)]);
        }
        ownedFiles('PREPARED',String(row.id),value);
        if (value.public.state === 'completed') {
          const assets = value.public.assets!;
          if (!Array.isArray(value.files) || value.files.length !== assets.length || value.manifestHash !== value.public.manifestHash
            || !value.files.every((file,index) => object(file) && file.relative === `Originals/${assets[index]!.side}.wav` && file.sha256 === assets[index]!.sha256 && file.size === assets[index]!.size)) unknown('FROZEN_LINEAGE_UNKNOWN');
          else if (createHash('sha256').update(retainedRenderManifest({operationId:String(row.id),preparationId:value.public.preparationId,masterVersionId:value.input.master.id,layoutVersionId:value.input.layout.id,contentHash:value.input.master.contentHash,plannedTimelineHash:value.input.layout.timelineHash,assets,files:value.files as {relative:string;sha256:string;size:number}[]})).digest('hex') !== value.manifestHash) unknown('FROZEN_LINEAGE_UNKNOWN');
        }
      }
      for (const row of scan('prepared_versions')) {
        const value = data(row);
        if (!dto.isFrozenPrepared(value) || value.id !== row.id || !preparedJobs.has(value.importJobId) || mediaFingerprint(value.renderTimeline) !== value.renderTimelineHash || mediaFingerprint(value.plannedTimeline) !== value.plannedTimelineHash) { unknown(); continue; }
        addMaster('PREPARED',value.id,value.masterVersionId);
      }
      const executionJobs = new Map<string, StoredExecutionJob>();
      for (const row of scan('execution_jobs')) {
        const value = data(row);
        if (!object(value) || !dto.isExecutionJob(value.public) || value.public.id !== row.id || !object(value.input) || !dto.isMasterVersion(value.input.master) || !dto.isLayoutVersion(value.input.layout) || !Array.isArray(value.input.sources) || value.input.sources.length > 200) { unknown(); continue; }
        addMaster('EXECUTION',String(row.id),value.input.master.id);
        for (const source of value.input.sources) {
          if (!object(source) || !dto.isCollectionId(source.trackId) || !root(source.root) || !relative(source.relative)) { unknown(); continue; }
          const evidence = value.input.master.sourceEvidence.find(entry => entry.trackId === source.trackId)?.binding;
          if (!evidence) { unknown('FROZEN_LINEAGE_UNKNOWN'); continue; }
          const sourceRoot = source.root;
          const historic = bindingLocations(evidence).find(entry => entry.root.id === sourceRoot.id && entry.relative === source.relative);
          add('EXECUTION',String(row.id),evidence.sha256,evidence.size,[location(source.root,source.relative,historic?.signature ?? null)]);
        }
        ownedFiles('EXECUTION',String(row.id),value);
        if (object(value.input.retained)) ownedFiles('PREPARED',String(row.id),value.input.retained);
        // 使用原执行发布校验器；shape缺失由本轮保守拒绝，绝不回写补证。
        const job = value as unknown as StoredExecutionJob;
        if (value.public.state === 'completed' && !executionPublicationComplete(job)) unknown();
        executionJobs.set(String(row.id),job);
      }
      for (const row of scan('execution_assets')) {
        const value = data(row); if (!dto.isExecutionAsset(value) || value.id !== row.id || !executionJobs.has(value.id)) { unknown(); continue; }
        addMaster('EXECUTION',value.id,value.masterVersionId);
      }
      const archives = new Map<string, { value: Row; authorized: boolean }>();
      for (const row of scan('archive_roots')) {
        const value = data(row);
        if (!object(value) || value.id !== row.id || !root(value.parent) || !root(value.root) || !root(value.objects) || !root(value.operations) || ![0,1].includes(Number(row.authorized))) { unknown(); continue; }
        archives.set(String(row.id),{value,authorized:row.authorized === 1});
      }
      const archiveOps = new Set<string>();
      for (const row of scan('archive_operations')) {
        const value = data(row);
        if (!object(value) || !object(value.request) || value.request.id !== row.id || value.request.rootId !== row.root_id || !object(value.request.lineage) || !Array.isArray(value.request.files) || value.request.files.length > 2048 || mediaFingerprint(value.request) !== row.fingerprint) { unknown(); continue; }
        archiveOps.add(String(row.id)); addMaster('ARCHIVE',String(row.id),value.request.lineage.masterVersionId);
        for (const file of value.request.files) {
          if (!object(file) || !hash(file.sha256) || !size(file.size)) { unknown(); continue; }
          if (typeof file.content === 'string') {
            if (createHash('sha256').update(file.content).digest('hex') !== file.sha256 || Buffer.byteLength(file.content) !== file.size) unknown();
          } else if (root(file.source) && relative(file.relative)) add('ARCHIVE',String(row.id),file.sha256,file.size,[location(file.source,file.relative,null)]);
          else unknown();
        }
      }
      const objectKeys = new Set<string>();
      for (const row of scan('archive_objects')) {
        const archive = archives.get(String(row.root_id));
        if (!archive || !root(archive.value.objects) || !hash(row.sha256) || !size(row.size)) { unknown(); continue; }
        objectKeys.add(`${String(row.root_id)}:${row.sha256}`);
        add('ARCHIVE',`${String(row.root_id)}:${row.sha256}`,row.sha256,row.size,[location(archive.value.objects,row.sha256,null,archive.authorized ? 'AUTHORIZED' : 'REVOKED')]);
      }
      for (const row of scan('archive_references')) if (!archiveOps.has(String(row.operation_id)) || !objectKeys.has(`${String(row.root_id)}:${String(row.sha256)}`)) unknown('FROZEN_LINEAGE_UNKNOWN');
      const plans = new Map<string,dto.RecordingPlanVersion>();
      for (const row of scan('recording_plan_versions')) {
        json(row.data);
        const value = parseRecordingPlan(row.data);
        if (value.id !== row.id || !executionJobs.has(value.execution.assetId) || !archiveOps.has(value.archive.operationId)) { unknown('FROZEN_LINEAGE_UNKNOWN'); continue; }
        plans.set(value.id,value); addMaster('RECORDING_PLAN',value.id,value.master.id);
      }
      const attempts = new Map<string,dto.RecordingAttempt>();
      for (const row of scan('recording_attempts')) {
        const value = data(row);
        if (!dto.isRecordingAttempt(value) || value.id !== row.id || value.planVersionId !== row.plan_id || value.status !== row.status || !plans.has(value.planVersionId)) { unknown(); continue; }
        attempts.set(value.id,value);
        if (value.status === 'in-progress') { unknown('ACTIVE_RECORDING'); addMaster('RECORDING',value.id,plans.get(value.planVersionId)!.master.id); }
      }
      const barriers = scan('output_run_barrier_events');
      if (attempts.size || barriers.length) verifyOutputRunBarrierDatabase(db);
      for (const row of barriers) {
        const attempt = attempts.get(String(row.attempt_id));
        if (!attempt || !['pending','verified','failed'].includes(String(row.phase)) || !dto.isCollectionId(row.run_id) || !hash(row.plan_content_hash) || !hash(row.audio_sha256)) { unknown(); continue; }
        if (row.phase !== 'pending') continue;
        // 软件quiet持久证明不能代替当前sidecar/helper撤销；只有原Owner恢复流程能核实际lease。
        unknown('OUTPUT_RUN_LEASE_STATE_UNKNOWN');
        const side = attempt.sides.find(value => value.side === row.side && value.runId === row.run_id);
        const verified = barriers.some(value => value.attempt_id === row.attempt_id && value.side === row.side && value.run_id === row.run_id && value.phase === 'verified');
        if (!side || !verified && !(side.engineStoppedSubmitting && side.cleanupQuiescent)) unknown('OUTPUT_QUIET_UNVERIFIED');
      }
    } catch (error) { unknown(error instanceof Error && error.message === 'SOURCE_PROTECTION_BUDGET_EXCEEDED' ? error.message : 'HISTORY_CORRUPT'); }
    finally { if (started) { try { db.exec('COMMIT'); } catch { unknown('PROTECTION_SNAPSHOT_UNVERIFIED'); try { db.exec('ROLLBACK'); } catch { /* 原读事务结果未知，证据明确不完整。 */ } } } }
    return { version:1, storageFingerprint:digest.digest('hex'), complete:issues.size === 0, issues:[...issues].sort(), references, rows, bytes };
  }); }
  return {snapshot():SourceProtectionProjection{return snapshot();},
    /** 新域只忽略无关连接计数；原24表的字节、历史Hash与未知分类仍由同一冷核证明。 */
    sourceWritesSnapshot():SourceProtectionProjection{return snapshot(true);}};
}
export type SourceProtectionStore = ReturnType<typeof createSourceProtectionStore>;
